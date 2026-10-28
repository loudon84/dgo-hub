import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SourceConfig } from '../source-registry/service.js';
import type { EndpointProfile } from '../source-registry/capability-probe.js';
import { snapshotRowsPageDigest, type SnapshotPage, type SnapshotRelation } from './postgres-snapshot-connector.js';

export type SnapshotClaim = Readonly<{ run_id: string; claim_token: string }>;
export type SnapshotAttempt = Readonly<{ attempt_id: string; ordinal: number; operation_id: string }>;
export type FrozenSnapshotProof = Readonly<{
  tenant_key: string;
  source_id: string;
  run_id: string;
  expected_entities: readonly ('customer' | 'order')[];
  security_barrier_fence: string;
  config: SourceConfig;
  endpoint_profile: EndpointProfile;
  mappings: readonly { entity: 'customer' | 'order'; source_field: string; target_field: string; transform: 'identity' | 'trim' | 'decimal-string' | 'source-id' }[];
  config_digest: string;
  mapping_digest: string;
  identity_mapping_digest: string;
  endpoint_profile_digest: string;
  recovery_mode?: 'FRESH_SCAN'|'SEALED_STAGE'|null;
  recovery_original_run_id?: string|null;
  recovery_original_attempt_id?: string|null;
}>;

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record=value as Record<string,unknown>;
  return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}
function digest(value: unknown): string { return createHash('sha256').update(stable(value),'utf8').digest('hex'); }
function digestHex(value: Buffer | string): string { return Buffer.isBuffer(value) ? value.toString('hex') : value; }

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT control.lock_security_barrier_fence()');
    const value=await action(client);
    await client.query('COMMIT');
    return value;
  } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
  finally { client.release(); }
}

export function createSnapshotStageStore(pool: Pool) {
  return Object.freeze({
    claim(tenantId: string, sourceId: string, leaseSeconds: number): Promise<SnapshotClaim | undefined> {
      return transaction(pool,async client=>{
        const result=await client.query<SnapshotClaim>(`SELECT run_id,claim_token FROM control.claim_etl_snapshot_run($1,$2,$3)`,
          [tenantId,sourceId,leaseSeconds]);
        return result.rows[0];
      });
    },
    async loadFrozenProof(tenantId: string, sourceId: string, runId: string): Promise<FrozenSnapshotProof> {
      return transaction(pool,async client=>{
        const run=await client.query<Record<string,any>>(`SELECT run_id,tenant_key,source_id,status,expected_entities,config_revision,config_digest,
          mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,security_barrier_fence,
          recovery_mode,recovery_original_run_id,recovery_original_attempt_id
          FROM control.etl_run WHERE tenant_key=$1 AND source_id=$2 AND run_id=$3`,[tenantId,sourceId,runId]);
        if(!run.rowCount || run.rows[0].status!=='SCANNING') throw new Error('SNAPSHOT_RUN_UNAVAILABLE');
        const row=run.rows[0];
        const configRow=await client.query<Record<string,any>>(`SELECT config,config_digest FROM control.source_config_revision
          WHERE tenant_key=$1 AND source_id=$2 AND revision=$3`,[tenantId,sourceId,row.config_revision]);
        const mappingRow=await client.query<Record<string,any>>(`SELECT mappings,mapping_digest FROM control.source_mapping_revision
          WHERE tenant_key=$1 AND source_id=$2 AND revision=$3`,[tenantId,sourceId,row.mapping_revision]);
        const identityRow=await client.query<{mapping_digest:Buffer}>(`SELECT mapping_digest FROM control.source_identity_mapping_revision
          WHERE tenant_key=$1 AND source_id=$2 AND revision=$3`,[tenantId,sourceId,row.identity_mapping_revision]);
        if(!configRow.rowCount || !mappingRow.rowCount || !identityRow.rowCount) throw new Error('SNAPSHOT_PROOF_INVALID');
        const config=configRow.rows[0].config as SourceConfig;
        const profile=config.endpoint_profile;
        const mappings=mappingRow.rows[0].mappings as FrozenSnapshotProof['mappings'];
        const configDigest=digestHex(configRow.rows[0].config_digest);
        const mappingDigest=digestHex(mappingRow.rows[0].mapping_digest);
        const identityDigest=digestHex(identityRow.rows[0].mapping_digest);
        if(digest(config)!==configDigest || digest(mappings)!==mappingDigest || identityDigest!==digestHex(row.identity_mapping_digest) ||
            !profile || digest(profile)!==digestHex(row.endpoint_profile_digest) ||
            digest(config)!==digestHex(row.config_digest) || digest(mappings)!==digestHex(row.mapping_digest) ||
            !Array.isArray(row.expected_entities) || stable([...row.expected_entities].sort())!==stable([...config.allowed_entities].sort()))
          throw new Error('SNAPSHOT_PROOF_INVALID');
        return Object.freeze({ tenant_key:tenantId,source_id:sourceId,run_id:runId,expected_entities:Object.freeze([...row.expected_entities]),
          security_barrier_fence:String(row.security_barrier_fence),config,endpoint_profile:profile,mappings,
          config_digest:configDigest,mapping_digest:mappingDigest,identity_mapping_digest:identityDigest,
          endpoint_profile_digest:digestHex(row.endpoint_profile_digest),recovery_mode:row.recovery_mode,
          recovery_original_run_id:row.recovery_original_run_id,recovery_original_attempt_id:row.recovery_original_attempt_id });
      });
    },
    async copySealedStage(tenantId:string,sourceId:string,runId:string,attemptId:string,token:string,operationId:string):Promise<number> {
      const source=await transaction(pool,async client=>{
        const result=await client.query<{proof:Record<string,any>}>(
          'SELECT control.read_etl_snapshot_recovery_manifest($1,$2,$3,$4,$5) AS proof',[tenantId,sourceId,runId,attemptId,token]);
        const proof=result.rows[0]?.proof;
        if(!proof||!proof.manifest||typeof proof.original_manifest_digest!=='string') throw new Error('SNAPSHOT_RECOVERY_PROOF_INVALID');
        return proof;
      });
      const manifest:Record<string,unknown>={...(source.manifest as Record<string,unknown>),attempt_id:attemptId,operation_id:operationId,
        recovery_source:{run_id:source.original_run_id,attempt_id:source.original_attempt_id,
          manifest_digest:source.original_manifest_digest,copy_kind:'EXACT_STAGE_FACTS'}};
      if(!Array.isArray(manifest.relation_counts)) throw new Error('SNAPSHOT_MANIFEST_INVALID');
      let copied=0;
      for(const item of manifest.relation_counts as Array<Record<string,any>>) {
        const relation=item.relation;
        if(!['customer','order','order_line'].includes(relation)||!Number.isSafeInteger(item.page_count)||item.page_count<0)
          throw new Error('SNAPSHOT_MANIFEST_INVALID');
        for(let pageNo=1;pageNo<=item.page_count;pageNo++) {
          const page=await transaction(pool,async client=>{
            const result=await client.query<Record<string,any>>(
              'SELECT * FROM control.read_etl_snapshot_recovery_stage_page($1,$2,$3,$4,$5,$6,$7)',
              [tenantId,sourceId,runId,attemptId,token,relation,pageNo]);
            return result.rows[0];
          });
          if(!page||!Array.isArray(page.rows)||page.rows.length!==page.row_count) throw new Error('SNAPSHOT_RECOVERY_STAGE_INVALID');
          const pageDigest=digestHex(page.page_digest);
          if(snapshotRowsPageDigest(page.rows)!==pageDigest) throw new Error('SNAPSHOT_RECOVERY_STAGE_DIGEST_MISMATCH');
          await transaction(pool,async client=>{
            const result=await client.query<{write_etl_snapshot_page:number}>(
              'SELECT control.write_etl_snapshot_page($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bytea,$12::jsonb)',
              [tenantId,sourceId,runId,attemptId,token,page.entity,page.relation,page.page_no,page.first_key,page.last_key,
                Buffer.from(pageDigest,'hex'),JSON.stringify(page.rows)]);
            if(Number(result.rows[0]?.write_etl_snapshot_page)!==page.rows.length) throw new Error('SNAPSHOT_RECOVERY_STAGE_COPY_REJECTED');
          });
          copied+=page.rows.length;
        }
      }
      await transaction(pool,async client=>{
        const result=await client.query<{complete_etl_snapshot_manifest:string}>(
          'SELECT control.complete_etl_snapshot_manifest($1,$2,$3,$4,$5,$6::jsonb,$7::bytea)',
          [tenantId,sourceId,runId,attemptId,token,JSON.stringify(manifest),Buffer.from(snapshotManifestDigest(manifest),'hex')]);
        if(Number(result.rows[0]?.complete_etl_snapshot_manifest)!==Number(manifest.row_count)) throw new Error('SNAPSHOT_RECOVERY_MANIFEST_REJECTED');
      });
      return copied;
    },
    beginAttempt(tenantId: string, sourceId: string, runId: string, token: string, leaseSeconds: number): Promise<SnapshotAttempt> {
      return transaction(pool,async client=>{
        const result=await client.query<SnapshotAttempt>(`SELECT attempt_id,ordinal,operation_id FROM control.begin_etl_snapshot_attempt($1,$2,$3,$4,$5)`,
          [tenantId,sourceId,runId,token,leaseSeconds]);
        if(!result.rowCount) throw new Error('SNAPSHOT_ATTEMPT_UNAVAILABLE');
        return result.rows[0];
      });
    },
    heartbeat(tenantId: string, sourceId: string, runId: string, attemptId: string, token: string, leaseSeconds: number): Promise<boolean> {
      return transaction(pool,async client=>{
        const result=await client.query<{heartbeat_etl_snapshot_run:boolean}>(`SELECT control.heartbeat_etl_snapshot_run($1,$2,$3,$4,$5,$6)`,
          [tenantId,sourceId,runId,attemptId,token,leaseSeconds]);
        return result.rows[0]?.heartbeat_etl_snapshot_run===true;
      });
    },
    writePage(tenantId: string, sourceId: string, runId: string, attemptId: string, token: string, page: SnapshotPage): Promise<number> {
      return transaction(pool,async client=>{
        const result=await client.query<{write_etl_snapshot_page:number}>(`SELECT control.write_etl_snapshot_page($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bytea,$12::jsonb)`,
          [tenantId,sourceId,runId,attemptId,token,page.entity,page.relation,page.page_no,page.first_key,page.last_key,
            Buffer.from(page.page_digest,'hex'),JSON.stringify(page.rows)]);
        return Number(result.rows[0]?.write_etl_snapshot_page ?? 0);
      });
    },
    complete(tenantId: string, sourceId: string, runId: string, attemptId: string, token: string, manifest: Record<string,unknown>, manifestDigest: string): Promise<number> {
      return transaction(pool,async client=>{
        const result=await client.query<{complete_etl_snapshot_manifest:string}>(`SELECT control.complete_etl_snapshot_manifest($1,$2,$3,$4,$5,$6::jsonb,$7::bytea)`,
          [tenantId,sourceId,runId,attemptId,token,JSON.stringify(manifest),Buffer.from(manifestDigest,'hex')]);
        return Number(result.rows[0]?.complete_etl_snapshot_manifest ?? 0);
      });
    },
    fail(tenantId: string, sourceId: string, runId: string, attemptId: string, token: string, errorCode: string, retryable: boolean): Promise<string> {
      return transaction(pool,async client=>{
        const result=await client.query<{fail_etl_snapshot_attempt:string}>(`SELECT control.fail_etl_snapshot_attempt($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId,sourceId,runId,attemptId,token,errorCode,retryable]);
        return result.rows[0]?.fail_etl_snapshot_attempt ?? 'STALE';
      });
    },
  });
}

export function expectedSnapshotRelations(entities: readonly ('customer'|'order')[]): readonly SnapshotRelation[] {
  return Object.freeze([...entities].sort().flatMap(entity=>entity==='customer'?['customer' as const]:['order' as const,'order_line' as const]));
}

export function snapshotManifestDigest(manifest: Record<string,unknown>): string { return digest(manifest); }
