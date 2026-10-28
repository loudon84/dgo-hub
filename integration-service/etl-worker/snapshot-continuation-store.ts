import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { SnapshotRunProof } from './snapshot-contract.js';
import type { SnapshotPage, SnapshotRelation, SnapshotStageRow } from './postgres-snapshot-connector.js';
import { snapshotRowsPageDigest } from './postgres-snapshot-connector.js';
import { expectedSnapshotRelations, snapshotManifestDigest } from './snapshot-stage-store.js';
import type { SemanticSnapshotFact } from './snapshot-validation.js';

export type SnapshotContinuationClaim = Readonly<{ tenant_key:string;source_id:string;run_id:string;attempt_id:string;claim_token:string;status:string;c_start_count:number }>;
export type SnapshotCProof = SnapshotRunProof & Readonly<{
  status: string;
  credential_revision: string;
  config: Record<string, unknown>;
  mappings: readonly Record<string, unknown>[];
  identity_mappings: readonly { kind: string; external_id: string; target_id: string | null }[];
  manifest: Record<string, unknown>;
  manifest_digest: string;
  recovery_mode?: 'FRESH_SCAN'|'SEALED_STAGE'|null;
  recovery_original_run_id?: string|null;
  recovery_original_attempt_id?: string|null;
}>;

type PageReceipt = Readonly<{ entity: 'customer'|'order'; relation: SnapshotRelation; page_no: number; row_count: number;
  first_key: string; last_key: string; page_digest: Buffer }>;
type StagePage = Readonly<{ receipt: PageReceipt; rows: readonly SnapshotStageRow[] }>;

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string,unknown>;
  return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}
function digest(value: unknown): string { return createHash('sha256').update(stable(value),'utf8').digest('hex'); }
function hex(value: Buffer | string): string { return Buffer.isBuffer(value) ? value.toString('hex') : value; }
function keyOf(row: Pick<SnapshotStageRow,'relation'|'parent_source_pk'|'source_pk'>): string {
  return row.relation==='order_line' ? `${row.parent_source_pk.length}:${row.parent_source_pk}${row.source_pk.length}:${row.source_pk}` : row.source_pk;
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT control.lock_security_barrier_fence()');
    const result=await work(client);
    await client.query('COMMIT');
    return result;
  } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
  finally { client.release(); }
}

export function createSnapshotContinuationStore(pool: Pool) {
  const call = <T extends QueryResultRow>(sql:string,values:unknown[]) => transaction(pool,async client=>client.query<T>(sql,values));
  return Object.freeze({
    async claim(tenant:string,source:string,leaseSeconds=60):Promise<SnapshotContinuationClaim|undefined> {
      const result=await call<SnapshotContinuationClaim>('SELECT * FROM control.claim_etl_snapshot_continuation($1,$2,$3)',[tenant,source,leaseSeconds]);
      return result.rows[0];
    },
    async begin(claim:SnapshotContinuationClaim):Promise<number> {
      const result=await call<{begin_etl_snapshot_c_start:number}>('SELECT control.begin_etl_snapshot_c_start($1,$2,$3,$4,$5)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token]);
      return Number(result.rows[0]?.begin_etl_snapshot_c_start ?? 0);
    },
    async heartbeat(claim:SnapshotContinuationClaim,leaseSeconds=60):Promise<boolean> {
      const result=await call<{heartbeat_etl_snapshot_continuation:boolean}>(
        'SELECT control.heartbeat_etl_snapshot_continuation($1,$2,$3,$4,$5,$6)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,leaseSeconds]);
      return result.rows[0]?.heartbeat_etl_snapshot_continuation===true;
    },
    async fail(claim:SnapshotContinuationClaim,errorCode:string,retryable:boolean):Promise<string> {
      const result=await call<{fail_etl_snapshot_continuation:string}>(
        'SELECT control.fail_etl_snapshot_continuation($1,$2,$3,$4,$5,$6,$7)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,errorCode,retryable]);
      return result.rows[0]?.fail_etl_snapshot_continuation ?? 'STALE';
    },
    async loadProof(claim:SnapshotContinuationClaim):Promise<SnapshotCProof> {
      return transaction(pool,async client=>{
        const result=await client.query<{proof:Record<string,any>}>(
          'SELECT control.read_etl_snapshot_c_proof($1,$2,$3,$4,$5) AS proof',
          [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token]);
        const proof=result.rows[0]?.proof;
        if(!proof || proof.status!==claim.status) throw new Error('SNAPSHOT_C_PROOF_INVALID');
        const recoveryResult=await client.query<{metadata:Record<string,any>}>('SELECT control.read_etl_snapshot_recovery_c_metadata($1,$2,$3,$4,$5) AS metadata',
          [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token]);
        const recovery=recoveryResult.rows[0]?.metadata;
        if(!recovery) throw new Error('SNAPSHOT_RECOVERY_LINK_INVALID');
        const {manifest, digest:manifestDigest}=proof.manifest ?? {};
        if(!manifest || snapshotManifestDigest(manifest)!==manifestDigest || manifest.attempt_id!==claim.attempt_id || manifest.state!=='EXTRACTED')
          throw new Error('SNAPSHOT_MANIFEST_INVALID');
        if(digest(proof.config)!==proof.config_digest || digest(proof.mappings)!==proof.mapping_digest ||
            digest(proof.identity_mappings)!==proof.identity_mapping_digest || digest(proof.config.endpoint_profile)!==proof.endpoint_profile_digest ||
            stable([...proof.expected_entities].sort())!==stable([...(proof.config.allowed_entities as string[])].sort()))
          throw new Error('SNAPSHOT_C_PROOF_INVALID');
        return Object.freeze({ ...proof, manifest, manifest_digest:manifestDigest,...recovery }) as SnapshotCProof;
      });
    },
    async *stagePages(claim:SnapshotContinuationClaim,proof:SnapshotCProof):AsyncGenerator<StagePage> {
      const relations=expectedSnapshotRelations(proof.expected_entities as readonly ('customer'|'order')[]);
      const manifestRelations=proof.manifest.relation_counts as Array<{relation:SnapshotRelation;row_count:number;page_count:number;page_digests:string[]}>;
      if(!Array.isArray(manifestRelations) || stable(proof.manifest.relations)!==stable(relations)) throw new Error('SNAPSHOT_MANIFEST_INVALID');
      let totalRows=0,totalPages=0;
      for(const relation of relations) {
        const expected=manifestRelations.find(value=>value.relation===relation);
        if(!expected || !Number.isSafeInteger(expected.row_count) || !Number.isSafeInteger(expected.page_count) ||
          !Array.isArray(expected.page_digests) || expected.page_digests.length!==expected.page_count) throw new Error('SNAPSHOT_MANIFEST_INVALID');
        let after=0,seenPages=0,seenRows=0;
        while(true) {
          const meta=await call<PageReceipt>(`SELECT * FROM control.list_etl_snapshot_c_pages($1,$2,$3,$4,$5,$6,$7,$8)`,
            [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,relation,after,100]);
          if(!meta.rows.length) break;
          for(const receipt of meta.rows) {
            if(receipt.page_no!==after+1 || receipt.row_count<1 || hex(receipt.page_digest)!==expected.page_digests[receipt.page_no-1])
              throw new Error('SNAPSHOT_PAGE_RECEIPT_INVALID');
            const contents=await call<{row_count:number;page_digest:Buffer;record:Record<string,any>}> (
              'SELECT * FROM control.read_etl_snapshot_stage_page($1,$2,$3,$4,$5,$6,$7,$8)',
              [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,receipt.entity,relation,receipt.page_no]);
            if(contents.rows.length!==receipt.row_count || contents.rows.some(row=>row.row_count!==receipt.row_count || !row.page_digest.equals(receipt.page_digest)))
              throw new Error('SNAPSHOT_PAGE_COVERAGE_INVALID');
            const rows=contents.rows.map(({record})=>({entity:record.entity,relation:record.relation,parent_source_pk:record.parent_source_pk,
              source_pk:record.source_pk,source_version:record.source_version,facts:record.facts} as SnapshotStageRow));
            if(rows.some(row=>row.entity!==receipt.entity || row.relation!==relation || keyOf(row)==='')) throw new Error('SNAPSHOT_STAGE_RECORD_INVALID');
            if(keyOf(rows[0]!)!==receipt.first_key || keyOf(rows.at(-1)!)!==receipt.last_key ||
                snapshotRowsPageDigest(rows)!==hex(receipt.page_digest)) throw new Error('SNAPSHOT_PAGE_DIGEST_INVALID');
            seenPages++;seenRows+=rows.length;after=receipt.page_no;totalPages++;totalRows+=rows.length;
            yield Object.freeze({receipt,rows:Object.freeze(rows)});
          }
        }
        if(seenPages!==expected.page_count || seenRows!==expected.row_count) throw new Error('SNAPSHOT_RELATION_COVERAGE_INVALID');
      }
      if(totalRows!==proof.manifest.row_count || totalPages!==proof.manifest.page_count) throw new Error('SNAPSHOT_MANIFEST_COVERAGE_INVALID');
    },
    async validateOrderReferences(claim:SnapshotContinuationClaim,proof:SnapshotCProof):Promise<string|undefined> {
      const profile=proof.config.endpoint_profile as Record<string,any>;
      const configured=profile.entities?.order?.customer_source_id;
      const customerSource=typeof configured==='string' && configured.length ? configured : proof.source_id;
      const result=await call<{valid:boolean;error_code:string|null}>(
        'SELECT * FROM control.validate_etl_snapshot_order_references($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,customerSource,
          proof.expected_entities.includes('customer'),JSON.stringify(proof.identity_mappings)]);
      return result.rows[0]?.valid ? undefined : (result.rows[0]?.error_code ?? 'SNAPSHOT_REFERENCE_INVALID');
    },
    async validateCustomerReferences(claim:SnapshotContinuationClaim,proof:SnapshotCProof):Promise<string|undefined> {
      if(!proof.expected_entities.includes('customer')) return undefined;
      const result=await call<{valid:boolean;error_code:string|null}>(
        'SELECT * FROM control.validate_etl_snapshot_customer_references($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,proof.identity_mapping_revision,
          JSON.stringify(proof.identity_mappings)]);
      return result.rows[0]?.valid ? undefined : (result.rows[0]?.error_code ?? 'SNAPSHOT_CUSTOMER_IDENTITY_INVALID');
    },
    async orderLines(claim:SnapshotContinuationClaim,orderSourcePk:string):Promise<readonly SnapshotStageRow[]> {
      const result=await call<Record<string,any>>('SELECT * FROM control.read_etl_snapshot_order_lines($1,$2,$3,$4,$5,$6)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,orderSourcePk]);
      if(result.rows.length>200) throw new Error('SNAPSHOT_ORDER_LINES_INVALID');
      return Object.freeze(result.rows.map(row=>({entity:row.entity,relation:row.relation,parent_source_pk:row.parent_source_pk,
        source_pk:row.source_pk,source_version:row.source_version,facts:row.facts} as SnapshotStageRow)));
    },
    async *semanticFacts(claim:SnapshotContinuationClaim,entity:'customer'|'order'):
      AsyncGenerator<readonly SemanticSnapshotFact[]> {
      let parent='',source='';
      for (;;) {
        const result=await call<Record<string,any>>(
          'SELECT * FROM control.read_etl_snapshot_semantic_chunk($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,entity,entity,parent,source,1]);
        if (!result.rows.length) break;
        const chunk=result.rows.map(row=>({entity:row.entity,relation:row.relation,parent_source_pk:row.parent_source_pk,
          source_pk:row.source_pk,source_version:row.source_version,facts:row.facts} as SemanticSnapshotFact));
        parent=chunk.at(-1)!.parent_source_pk;
        source=chunk.at(-1)!.source_pk;
        yield Object.freeze(chunk);
      }
    },
    async *semanticLines(claim:SnapshotContinuationClaim):AsyncGenerator<readonly SemanticSnapshotFact[]> {
      let parent='',source='';
      for (;;) {
        const result=await call<Record<string,any>>(
          'SELECT * FROM control.read_etl_snapshot_semantic_chunk($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,'order','order_line',parent,source,1]);
        if (!result.rows.length) break;
        const chunk=result.rows.map(row=>({entity:row.entity,relation:row.relation,parent_source_pk:row.parent_source_pk,
          source_pk:row.source_pk,source_version:row.source_version,facts:row.facts} as SemanticSnapshotFact));
        parent=chunk.at(-1)!.parent_source_pk;
        source=chunk.at(-1)!.source_pk;
        yield Object.freeze(chunk);
      }
    },
    async existingRange(claim:SnapshotContinuationClaim,entity:'customer'|'order',sourcePk:string):Promise<
      Readonly<{aggregate_digest:string;proof_scope_digest:string;status:string;error_code:string|null}>|undefined> {
      const result=await call<{aggregate_digest:Buffer;proof_scope_digest:Buffer;status:string;error_code:string|null}>(
        'SELECT * FROM control.get_etl_snapshot_apply_range($1,$2,$3,$4,$5,$6,$7)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,entity,sourcePk]);
      const row=result.rows[0];
      return row ? Object.freeze({...row,aggregate_digest:hex(row.aggregate_digest),proof_scope_digest:hex(row.proof_scope_digest)}) : undefined;
    },
    async recoveryPriorRange(claim:SnapshotContinuationClaim,entity:'customer'|'order',sourcePk:string):Promise<
      Readonly<{aggregate_digest:string;proof_scope_digest:string;status:string;error_code:string|null;outcome_id:string}>|undefined> {
      const result=await call<{aggregate_digest:Buffer;proof_scope_digest:Buffer;status:string;error_code:string|null;outcome_id:string}>(
        'SELECT * FROM control.get_etl_snapshot_recovery_prior_range($1,$2,$3,$4,$5,$6,$7)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,entity,sourcePk]);
      const row=result.rows[0];
      return row?Object.freeze({...row,aggregate_digest:hex(row.aggregate_digest),proof_scope_digest:hex(row.proof_scope_digest)}):undefined;
    },
    async recordRecoveryReuse(client:PoolClient,claim:SnapshotContinuationClaim,input:Readonly<{entity:'customer'|'order';source_pk:string;
      aggregate_digest:string;proof_scope_digest:string}>):Promise<boolean> {
      const result=await client.query<{record_etl_snapshot_recovery_reuse:boolean}>(
        'SELECT control.record_etl_snapshot_recovery_reuse($1,$2,$3,$4,$5,$6,$7,$8::bytea,$9::bytea)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,input.entity,input.source_pk,
          Buffer.from(input.aggregate_digest,'hex'),Buffer.from(input.proof_scope_digest,'hex')]);
      return result.rows[0]?.record_etl_snapshot_recovery_reuse===true;
    },
    async seal(claim:SnapshotContinuationClaim,proof:SnapshotCProof,proofScopeDigest:string,semanticDigest:string,coverage:Record<string,unknown>):Promise<boolean> {
      const result=await call<{seal_etl_snapshot_validation:boolean}>(
        'SELECT control.seal_etl_snapshot_validation($1,$2,$3,$4,$5,$6::bytea,$7::bytea,$8::bytea,$9::jsonb)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,Buffer.from(proof.manifest_digest,'hex'),
          Buffer.from(proofScopeDigest,'hex'),Buffer.from(semanticDigest,'hex'),JSON.stringify(coverage)]);
      return result.rows[0]?.seal_etl_snapshot_validation===true;
    },
    async observation(claim:SnapshotContinuationClaim,semanticDigest:string,scopeDigest:string):Promise<string|undefined> {
      const result=await call<{persist_etl_snapshot_observation:string}>(
        'SELECT control.persist_etl_snapshot_observation($1,$2,$3,$4,$5,$6::bytea,$7::bytea)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,Buffer.from(semanticDigest,'hex'),Buffer.from(scopeDigest,'hex')]);
      return result.rows[0]?.persist_etl_snapshot_observation ?? undefined;
    },
    async recordAggregate(client:PoolClient,claim:SnapshotContinuationClaim,input:Readonly<{entity:'customer'|'order';source_pk:string;
      aggregate_digest:string;proof_scope_digest:string;status:'APPLIED'|'DUPLICATE'|'IGNORED_STALE'|'QUARANTINED'|'CHANNEL_EPOCH_RETIRED'|'FAILED';
      error_code:string|null}>):Promise<boolean> {
      const result=await client.query<{record_etl_snapshot_aggregate:boolean}>(
        'SELECT control.record_etl_snapshot_aggregate($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bytea,$11::bytea,$12,$13)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,input.entity,input.entity,'',input.source_pk,
          Buffer.from(input.aggregate_digest,'hex'),Buffer.from(input.proof_scope_digest,'hex'),input.status,input.error_code]);
      return result.rows[0]?.record_etl_snapshot_aggregate===true;
    },
    async assertApplyClaim(client:PoolClient,claim:SnapshotContinuationClaim):Promise<boolean> {
      const result=await client.query<{assert_etl_snapshot_apply_claim:boolean}>(
        'SELECT control.assert_etl_snapshot_apply_claim($1,$2,$3,$4,$5)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token]);
      return result.rows[0]?.assert_etl_snapshot_apply_claim===true;
    },
    async lockOrderCustomerReference(client:PoolClient,claim:SnapshotContinuationClaim,proof:SnapshotCProof,row:SemanticSnapshotFact):Promise<boolean> {
      const profile=proof.config.endpoint_profile as Record<string,any>;
      const configured=profile.entities?.order?.customer_source_id;
      const customerSource=typeof configured==='string'&&configured.length?configured:proof.source_id;
      const customerPk=row.facts?.customer_id;
      if(typeof customerPk!=='string'||!customerPk) return false;
      const result=await client.query<{lock_etl_snapshot_order_customer_reference:boolean}>(
        'SELECT control.lock_etl_snapshot_order_customer_reference($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token,customerSource,customerPk,JSON.stringify(proof.identity_mappings)]);
      return result.rows[0]?.lock_etl_snapshot_order_customer_reference===true;
    },
    async finish(claim:SnapshotContinuationClaim):Promise<boolean> {
      const result=await call<{finish_etl_snapshot_run:boolean}>(
        'SELECT control.finish_etl_snapshot_run($1,$2,$3,$4,$5)',
        [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token]);
      return result.rows[0]?.finish_etl_snapshot_run===true;
    },
  });
}

export type { SemanticSnapshotFact };
