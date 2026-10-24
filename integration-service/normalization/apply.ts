import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { canonicalVersion, sourceContentDigest, validateCanonicalIdentifier, validateCanonicalSourceId } from './canonical.js';
import {
  canonicalCustomerSchema,
  canonicalDeleteSchema,
  canonicalOrderSchema,
  canonicalOrderDeleteSchema,
  type CanonicalCustomer,
  type CanonicalDelete,
  type CanonicalOrder,
} from './models.js';

export type ApplyEntity = 'customer' | 'order';
export type ApplyVersionDomain = 'SOURCE_VERSION' | 'SNAPSHOT_OBSERVATION';
export type ApplyContext = Readonly<{
  tenantId: string;
  sourceId: string;
  credentialId: string;
  sourceEpochAtAdmission: string;
  credentialRevisionAtAdmission: string;
  credentialGenerationAtAdmission: string;
  entity: ApplyEntity;
  channelId: string;
  channelEpoch: string;
  versionDomain: ApplyVersionDomain;
  ownerApprovalId: string;
  ownerUserId: string;
  ownerRevision: string;
  configRevision: string;
  configDigest: string;
  mappingRevision: string;
  mappingDigest: string;
  identityMappingRevision: string;
  identityMappingDigest: string;
  endpointProfileDigest: string;
  testReportId: string;
  securityBarrierFenceAtAdmission: string;
}>;

export type ApplyResult =
  | { status: 'APPLIED'; objectId: string; hubRevision: string; digest: string }
  | { status: 'DUPLICATE' | 'IGNORED_STALE'; objectId: string; digest: string }
  | { status: 'QUARANTINED'; code: 'SOURCE_VERSION_CONFLICT' | 'AUTHORITY_MAPPING_SUPERSEDED' | 'SECURITY_BARRIER_ACTIVE' | 'IDENTITY_MAPPING_REQUIRED' | 'IDENTITY_MAPPING_TARGET_INVALID' }
  | { status: 'CHANNEL_EPOCH_RETIRED' };

type IdentityMapping = Readonly<{ kind: 'user' | 'department' | 'customer'; external_id: string; target_id: string | null }>;
type FrozenProof = {
  identity_mappings: IdentityMapping[];
  config: { allowed_entities?: unknown; connector?: unknown; mode?: unknown; version_domain?: unknown };
  data_contract_ref: string;
};
type Receipt = QueryResultRow & { source_version: string; source_content_digest: Buffer; canonical_object_id: string; deleted: boolean; projection_digest: Buffer };

function decimalProof(value: string, code: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(code);
  return value;
}

function digestBytes(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('CANONICAL_APPLY_PROOF_INVALID');
  return Buffer.from(hex, 'hex');
}

function mappingFor(mappings: readonly IdentityMapping[], kind: IdentityMapping['kind'], externalId: string): IdentityMapping | undefined {
  return mappings.find(item => item.kind === kind && item.external_id === externalId);
}

async function verifyFrozenApplyContext(client: PoolClient, context: ApplyContext): Promise<ApplyResult | FrozenProof> {
  if (!['customer','order'].includes(context.entity) || !['SOURCE_VERSION','SNAPSHOT_OBSERVATION'].includes(context.versionDomain)) {
    throw new Error('CANONICAL_APPLY_PROOF_INVALID');
  }
  const admittedFence = BigInt(decimalProof(context.securityBarrierFenceAtAdmission, 'CANONICAL_APPLY_PROOF_INVALID'));
  const fenceResult = await client.query<{ fence: string }>('SELECT control.lock_security_barrier_fence()::text AS fence');
  const currentFence = BigInt(fenceResult.rows[0]?.fence ?? '0');
  if (admittedFence > currentFence) throw new Error('CANONICAL_APPLY_PROOF_INVALID');

  // Acquires the source credential lock only after the common security guard.
  // Current generation and source epoch are intentionally not freshness gates.
  const credentialResult = await client.query<{ id: string }>(
    'SELECT id FROM control.lock_source_credential($1,$2)', [context.tenantId,context.sourceId],
  );
  if (credentialResult.rows[0]?.id !== context.credentialId) throw new Error('CANONICAL_APPLY_PROOF_INVALID');

  const channel = await client.query<{ state: string; connector: string; mode: string; version_domain: string; channel_epoch: string }>(`
    SELECT state,connector,mode,version_domain,channel_epoch::text FROM control.source_channel
     WHERE id=$1 AND tenant_key=$2 AND source_id=$3 AND entity=$4`,
  [context.channelId,context.tenantId,context.sourceId,context.entity]);
  if (!channel.rowCount || channel.rows[0].version_domain !== context.versionDomain ||
      channel.rows[0].channel_epoch !== decimalProof(context.channelEpoch,'CANONICAL_APPLY_PROOF_INVALID')) {
    throw new Error('CANONICAL_APPLY_PROOF_INVALID');
  }
  if (channel.rows[0].state === 'retired') return { status:'CHANNEL_EPOCH_RETIRED' };
  if (channel.rows[0].state !== 'active') throw new Error('CANONICAL_APPLY_PROOF_INVALID');

  const frozen = await client.query<FrozenProof>(`
    SELECT i.mappings AS identity_mappings,c.config,a.data_contract_ref
      FROM control.source_owner_approval a
      JOIN control.source_test_report t ON t.id=a.test_report_id
      JOIN control.source_config_revision c
        ON (c.tenant_key,c.source_id,c.revision)=(a.tenant_key,a.source_id,a.config_revision)
      JOIN control.source_mapping_revision m
        ON (m.tenant_key,m.source_id,m.revision)=(a.tenant_key,a.source_id,a.mapping_revision)
      JOIN control.source_identity_mapping_revision i
        ON (i.tenant_key,i.source_id,i.revision)=(a.tenant_key,a.source_id,a.identity_mapping_revision)
     WHERE a.id=$1 AND a.test_report_id=$2 AND a.tenant_key=$3 AND a.source_id=$4
       AND a.owner_user_id=$5 AND a.owner_revision=$6
       AND a.config_revision=$7 AND a.mapping_revision=$8 AND a.identity_mapping_revision=$9
       AND a.config_digest=$10 AND a.mapping_digest=$11 AND a.identity_mapping_digest=$12
       AND a.source_credential_revision=$13 AND a.credential_generation=$14 AND a.endpoint_profile_digest=$15
       AND t.status='PASS' AND t.tenant_key=a.tenant_key AND t.source_id=a.source_id
       AND t.config_revision=a.config_revision AND t.mapping_revision=a.mapping_revision
       AND t.identity_mapping_revision=a.identity_mapping_revision
       AND t.config_digest=a.config_digest AND t.mapping_digest=a.mapping_digest
       AND t.identity_mapping_digest=a.identity_mapping_digest
       AND t.source_credential_revision=a.source_credential_revision AND t.credential_generation=a.credential_generation
       AND t.endpoint_profile_digest=a.endpoint_profile_digest
       AND t.data_contract_ref=a.data_contract_ref
       AND c.config_digest=$10 AND m.mapping_digest=$11 AND i.mapping_digest=$12
       AND c.config->'allowed_entities' ? $16`,
  [context.ownerApprovalId,context.testReportId,context.tenantId,context.sourceId,context.ownerUserId,
    decimalProof(context.ownerRevision,'CANONICAL_APPLY_PROOF_INVALID'),decimalProof(context.configRevision,'CANONICAL_APPLY_PROOF_INVALID'),
    decimalProof(context.mappingRevision,'CANONICAL_APPLY_PROOF_INVALID'),decimalProof(context.identityMappingRevision,'CANONICAL_APPLY_PROOF_INVALID'),
    digestBytes(context.configDigest),digestBytes(context.mappingDigest),digestBytes(context.identityMappingDigest),
    decimalProof(context.credentialRevisionAtAdmission,'CANONICAL_APPLY_PROOF_INVALID'),
    decimalProof(context.credentialGenerationAtAdmission,'CANONICAL_APPLY_PROOF_INVALID'),digestBytes(context.endpointProfileDigest),context.entity]);
  if (!frozen.rowCount || !Array.isArray(frozen.rows[0].identity_mappings)) throw new Error('CANONICAL_APPLY_PROOF_INVALID');
  const config=frozen.rows[0].config;
  if (channel.rows[0].connector!==config.connector || channel.rows[0].mode!==config.mode ||
      channel.rows[0].version_domain!==config.version_domain || typeof frozen.rows[0].data_contract_ref!=='string') {
    throw new Error('CANONICAL_APPLY_PROOF_INVALID');
  }

  const barrier = await client.query<{ barrier_type: string }>(`
    SELECT barrier_type FROM control.source_security_barrier
     WHERE tenant_key=$1 AND effective_fence>$2::bigint
       AND (source_id IS NULL OR source_id=$3)
       AND (credential_id IS NULL OR credential_id=$4::uuid)
       AND (entity IS NULL OR entity=$5)
       AND (channel_id IS NULL OR channel_id=$6::uuid)
       AND barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')
     ORDER BY effective_fence LIMIT 1`,
  [context.tenantId,admittedFence.toString(),context.sourceId,context.credentialId,context.entity,context.channelId]);
  if (barrier.rows[0]?.barrier_type === 'CHANNEL_RETIRED') return { status:'CHANNEL_EPOCH_RETIRED' };
  if (barrier.rowCount) return { status:'QUARANTINED',code:'SECURITY_BARRIER_ACTIVE' };
  return frozen.rows[0];
}

async function receiptFor(client: PoolClient, context: ApplyContext, sourcePk: string): Promise<Receipt | undefined> {
  const result = await client.query<Receipt>(`
    SELECT source_version::text,source_content_digest,canonical_object_id,deleted,projection_digest
      FROM control.source_version_receipt
     WHERE tenant_key=$1 AND source_id=$2 AND channel_id=$3 AND entity=$4 AND source_pk=$5 FOR UPDATE`,
  [context.tenantId,context.sourceId,context.channelId,context.entity,sourcePk]);
  return result.rows[0];
}

async function identityFenceIsNewer(client: PoolClient, context: ApplyContext, key: { kind:string; externalId:string }): Promise<boolean> {
  const result = await client.query<{ identity_mapping_revision: string }>(`
    SELECT identity_mapping_revision::text FROM control.source_identity_remap_fence
     WHERE tenant_key=$1 AND source_id=$2 AND kind=$3 AND external_id=$4`,
  [context.tenantId,context.sourceId,key.kind,key.externalId]);
  return result.rows.length > 0 && BigInt(result.rows[0].identity_mapping_revision) > BigInt(context.identityMappingRevision);
}

async function resolveCustomerOwner(client: PoolClient, context: ApplyContext, mappings: readonly IdentityMapping[], input: CanonicalCustomer) {
  const owner = mappingFor(mappings,'user',input.owner_external_id);
  const dept = mappingFor(mappings,'department',input.dept_external_id);
  if (!owner || !dept || !owner.target_id || !dept.target_id) return { result:{ status:'QUARANTINED',code:'IDENTITY_MAPPING_REQUIRED' } as const };
  const subject = await client.query<{ enabled:boolean;department_id:string|null; business_role:string|null }>(
    'SELECT enabled,business_role,department_id FROM control.lock_canonical_owner($1,$2)',[context.tenantId,owner.target_id]);
  if (!subject.rowCount || !subject.rows[0].enabled || subject.rows[0].business_role !== 'sales' || !subject.rows[0].department_id ||
      subject.rows[0].department_id !== dept.target_id) {
    return { result:{ status:'QUARANTINED',code:'IDENTITY_MAPPING_TARGET_INVALID' } as const };
  }
  return { ownerUserId:owner.target_id,departmentId:subject.rows[0].department_id };
}

async function projectionDigest(client:PoolClient,sourceDigest:Buffer,objectId:string,identity:Record<string,string|boolean|null>):Promise<Buffer> {
  const result=await client.query<{digest:Buffer}>(`SELECT control.canonical_projection_digest($1,$2::uuid,$3::jsonb) AS digest`,
    [sourceDigest,objectId,JSON.stringify(identity)]);
  return result.rows[0].digest;
}

async function allocateRevision(client: PoolClient): Promise<string> {
  const result = await client.query<{ revision:string }>(`SELECT nextval('control.canonical_hub_revision_seq')::text AS revision`);
  return result.rows[0].revision;
}

async function writeReceipt(client: PoolClient, context: ApplyContext, input: {
  sourcePk:string; objectId:string; version:string; digest:Buffer; projection:Buffer; deleted:boolean;
}): Promise<void> {
  await client.query(`INSERT INTO control.source_version_receipt
    (tenant_key,source_id,channel_id,channel_epoch,entity,source_pk,version_domain,source_version,
     source_content_digest,projection_digest,canonical_object_id,deleted)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(tenant_key,source_id,channel_id,entity,source_pk) DO UPDATE SET
      source_version=EXCLUDED.source_version,source_content_digest=EXCLUDED.source_content_digest,
      projection_digest=EXCLUDED.projection_digest,canonical_object_id=EXCLUDED.canonical_object_id,
      deleted=EXCLUDED.deleted,committed_at=clock_timestamp()`,
  [context.tenantId,context.sourceId,context.channelId,context.channelEpoch,context.entity,input.sourcePk,
    context.versionDomain,input.version,input.digest,input.projection,input.objectId,input.deleted]);
}

async function writeOutbox(client: PoolClient, context: ApplyContext, input: {
  objectId:string; revision:string; operation:'UPSERT'|'DELETE'; projection:Buffer; digest:Buffer;
}): Promise<void> {
  await client.query(`INSERT INTO control.canonical_apply_outbox
    (tenant_key,source_id,channel_id,channel_epoch,version_domain,entity,canonical_object_id,hub_revision,operation,projection_digest,source_content_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [context.tenantId,context.sourceId,context.channelId,context.channelEpoch,context.versionDomain,context.entity,
    input.objectId,input.revision,input.operation,input.projection,input.digest]);
}

async function lockSourceIdentity(client: PoolClient, context: ApplyContext, sourcePk: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
    [context.tenantId,JSON.stringify([context.sourceId,context.entity,sourcePk])]);
  return client.query<{ canonical_object_id:string; customer_id:string|null; order_id:string|null }>(`
    SELECT canonical_object_id::text,customer_id::text,order_id::text FROM control.canonical_source_identity
     WHERE tenant_key=$1 AND source_id=$2 AND entity=$3 AND source_pk=$4 FOR UPDATE`,
  [context.tenantId,context.sourceId,context.entity,sourcePk]);
}

export async function applyCustomer(client: PoolClient, context: ApplyContext, inputValue: CanonicalCustomer | CanonicalDelete): Promise<ApplyResult> {
  if (context.entity !== 'customer') throw new Error('CANONICAL_APPLY_PROOF_INVALID');
  const fullInput = canonicalCustomerSchema.safeParse(inputValue);
  const input = fullInput.success ? fullInput.data : canonicalDeleteSchema.parse(inputValue);
  validateCanonicalIdentifier(context.tenantId);
  validateCanonicalSourceId(context.sourceId);
  const version = canonicalVersion(input.source_version);
  const sourceDigest = Buffer.from(sourceContentDigest(input),'hex');
  const proof = await verifyFrozenApplyContext(client,context);
  if ('status' in proof) return proof;

  const prior = await receiptFor(client,context,input.source_pk);
  if (prior) {
    const priorVersion = BigInt(prior.source_version);
    const currentVersion = BigInt(version);
    if (currentVersion < priorVersion) return { status:'IGNORED_STALE',objectId:prior.canonical_object_id,digest:prior.source_content_digest.toString('hex') };
    if (currentVersion === priorVersion) {
      if (prior.source_content_digest.equals(sourceDigest)) return { status:'DUPLICATE',objectId:prior.canonical_object_id,digest:prior.source_content_digest.toString('hex') };
      return { status:'QUARANTINED',code:'SOURCE_VERSION_CONFLICT' };
    }
  }
  if (context.versionDomain==='SNAPSHOT_OBSERVATION' && prior?.deleted && input.deleted_at!=null && prior.source_content_digest.equals(sourceDigest)) {
    await writeReceipt(client,context,{sourcePk:input.source_pk,objectId:prior.canonical_object_id,version,digest:sourceDigest,
      projection:prior.projection_digest,deleted:true});
    return {status:'DUPLICATE',objectId:prior.canonical_object_id,digest:sourceDigest.toString('hex')};
  }
  if (input.deleted_at != null) {
    const identity = await lockSourceIdentity(client,context,input.source_pk);
    const objectId = identity.rows[0]?.canonical_object_id ?? randomUUID();
    const revision = await allocateRevision(client);
    const projection=await projectionDigest(client,sourceDigest,objectId,{deleted:true,deleted_at:input.deleted_at});
    if (identity.rows[0]?.customer_id) {
      await client.query(`UPDATE hub.canonical_customer SET deleted_at=$3,source_version=$4,version_domain=$5,
        channel_epoch=$6,hub_revision=$7 WHERE tenant_id=$1 AND id=$2`,
      [context.tenantId,identity.rows[0].customer_id,input.deleted_at,version,context.versionDomain,context.channelEpoch,revision]);
    }
    await client.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id,customer_id)
      VALUES($1,$2,'customer',$3,$4,$5) ON CONFLICT(tenant_key,source_id,entity,source_pk) DO UPDATE
      SET canonical_object_id=EXCLUDED.canonical_object_id,customer_id=EXCLUDED.customer_id`,
    [context.tenantId,context.sourceId,input.source_pk,objectId,identity.rows[0]?.customer_id ?? null]);
    await writeReceipt(client,context,{sourcePk:input.source_pk,objectId,version,digest:sourceDigest,projection,deleted:true});
    await writeOutbox(client,context,{objectId,revision,operation:'DELETE',projection,digest:sourceDigest});
    return {status:'APPLIED',objectId,hubRevision:revision,digest:sourceDigest.toString('hex')};
  }
  const customerInput=canonicalCustomerSchema.parse(inputValue);
  const keys = [
    {kind:'user',externalId:customerInput.owner_external_id},
    {kind:'department',externalId:customerInput.dept_external_id},
  ];
  for (const key of keys) {
    if (await identityFenceIsNewer(client,context,key)) return { status:'QUARANTINED',code:'AUTHORITY_MAPPING_SUPERSEDED' };
  }
  const resolved = await resolveCustomerOwner(client,context,proof.identity_mappings,customerInput);
  if ('result' in resolved && resolved.result) return resolved.result;
  if (context.versionDomain==='SNAPSHOT_OBSERVATION' && prior && prior.source_content_digest.equals(sourceDigest) && !prior.deleted) {
    const current=await client.query<{owner_user_id:string;dept_id:string;deleted_at:Date|null}>(`SELECT owner_user_id,dept_id,deleted_at
      FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2`,[context.tenantId,prior.canonical_object_id]);
    if(current.rowCount && current.rows[0].deleted_at===null && current.rows[0].owner_user_id===resolved.ownerUserId &&
       current.rows[0].dept_id===resolved.departmentId) {
      const projection=await projectionDigest(client,sourceDigest,prior.canonical_object_id,
        {owner_user_id:resolved.ownerUserId,department_id:resolved.departmentId});
      await writeReceipt(client,context,{sourcePk:customerInput.source_pk,objectId:prior.canonical_object_id,version,digest:sourceDigest,projection,deleted:false});
      return {status:'DUPLICATE',objectId:prior.canonical_object_id,digest:sourceDigest.toString('hex')};
    }
  }
  const identity = await lockSourceIdentity(client,context,input.source_pk);
  const objectId = identity.rows[0]?.canonical_object_id ?? randomUUID();
  const existingAuthority=identity.rows[0]?.customer_id ? await client.query<{owner_user_id:string;dept_id:string}>(
    'SELECT owner_user_id,dept_id FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2',
    [context.tenantId,identity.rows[0].customer_id]) : undefined;
  const ownershipChanges: {kind:'user'|'department';external_id:string}[]=[];
  if(existingAuthority?.rowCount) {
    if(existingAuthority.rows[0].owner_user_id!==resolved.ownerUserId) {
      ownershipChanges.push({kind:'user',external_id:customerInput.owner_external_id});
    }
    if(existingAuthority.rows[0].dept_id!==resolved.departmentId) {
      ownershipChanges.push({kind:'department',external_id:customerInput.dept_external_id});
    }
  }
  const projection=await projectionDigest(client,sourceDigest,objectId,{owner_user_id:resolved.ownerUserId,department_id:resolved.departmentId});
  const revision = await allocateRevision(client);
  await client.query(`INSERT INTO hub.canonical_customer
    (tenant_id,id,customer_name,owner_user_id,dept_id,status,phone,source_updated_at,source_version,version_domain,channel_epoch,deleted_at,hub_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(tenant_id,id) DO UPDATE SET customer_name=EXCLUDED.customer_name,owner_user_id=EXCLUDED.owner_user_id,
      dept_id=EXCLUDED.dept_id,status=EXCLUDED.status,phone=EXCLUDED.phone,source_updated_at=EXCLUDED.source_updated_at,
      source_version=EXCLUDED.source_version,version_domain=EXCLUDED.version_domain,channel_epoch=EXCLUDED.channel_epoch,
      deleted_at=EXCLUDED.deleted_at,hub_revision=EXCLUDED.hub_revision`,
  [context.tenantId,objectId,customerInput.customer_name,resolved.ownerUserId,resolved.departmentId,customerInput.status,customerInput.phone ?? null,
    customerInput.source_updated_at,version,context.versionDomain,context.channelEpoch,customerInput.deleted_at ?? null,revision]);
  await client.query(`INSERT INTO control.canonical_source_identity
    (tenant_key,source_id,entity,source_pk,canonical_object_id,customer_id) VALUES($1,$2,'customer',$3,$4,$4)
    ON CONFLICT(tenant_key,source_id,entity,source_pk) DO UPDATE SET canonical_object_id=EXCLUDED.canonical_object_id,customer_id=EXCLUDED.customer_id`,
  [context.tenantId,context.sourceId,customerInput.source_pk,objectId]);
  await writeReceipt(client,context,{sourcePk:customerInput.source_pk,objectId,version,digest:sourceDigest,projection,deleted:customerInput.deleted_at != null});
  await writeOutbox(client,context,{objectId,revision,operation:customerInput.deleted_at?'DELETE':'UPSERT',projection,digest:sourceDigest});
  if(ownershipChanges.length) {
    await client.query(`SELECT control.record_canonical_customer_owner_change($1,$2,$3,$4,$5,$6::bigint,$7,$8::bigint,$9,$10,$11::bigint,$12::jsonb)`,[
      context.tenantId,context.sourceId,customerInput.source_pk,context.credentialId,context.channelId,context.channelEpoch,
      context.versionDomain,context.securityBarrierFenceAtAdmission,context.ownerApprovalId,context.testReportId,
      context.identityMappingRevision,JSON.stringify(ownershipChanges),
    ]);
  }
  await client.query(`INSERT INTO control.canonical_identity_reference(tenant_key,source_id,entity,source_pk,kind,external_id,target_id)
    VALUES($1,$2,'customer',$3,'user',$4,$5),($1,$2,'customer',$3,'department',$6,$7)
    ON CONFLICT(tenant_key,source_id,entity,source_pk,kind) DO UPDATE SET external_id=EXCLUDED.external_id,target_id=EXCLUDED.target_id`,
  [context.tenantId,context.sourceId,customerInput.source_pk,customerInput.owner_external_id,resolved.ownerUserId,customerInput.dept_external_id,resolved.departmentId]);
  return { status:'APPLIED',objectId,hubRevision:revision,digest:sourceDigest.toString('hex') };
}

export async function applyOrderAggregate(client: PoolClient, context: ApplyContext, inputValue: CanonicalOrder | CanonicalDelete): Promise<ApplyResult> {
  const fullInput = canonicalOrderSchema.safeParse(inputValue);
  const input = fullInput.success ? fullInput.data : canonicalOrderDeleteSchema.parse(inputValue);
  if (context.entity !== 'order') throw new Error('CANONICAL_APPLY_PROOF_INVALID');
  validateCanonicalIdentifier(context.tenantId);
  validateCanonicalSourceId(context.sourceId);
  const version = canonicalVersion(input.source_version);
  const sourceDigest = Buffer.from(sourceContentDigest(input),'hex');
  const proof = await verifyFrozenApplyContext(client,context);
  if ('status' in proof) return proof;
  const prior = await receiptFor(client,context,input.source_pk);
  if (prior) {
    const priorVersion = BigInt(prior.source_version);
    const currentVersion = BigInt(version);
    if (currentVersion < priorVersion) return { status:'IGNORED_STALE',objectId:prior.canonical_object_id,digest:prior.source_content_digest.toString('hex') };
    if (currentVersion === priorVersion) {
      if (prior.source_content_digest.equals(sourceDigest)) return { status:'DUPLICATE',objectId:prior.canonical_object_id,digest:prior.source_content_digest.toString('hex') };
      return { status:'QUARANTINED',code:'SOURCE_VERSION_CONFLICT' };
    }
  }
  if (context.versionDomain==='SNAPSHOT_OBSERVATION' && prior?.deleted && input.deleted_at!=null && prior.source_content_digest.equals(sourceDigest)) {
    await writeReceipt(client,context,{sourcePk:input.source_pk,objectId:prior.canonical_object_id,version,digest:sourceDigest,
      projection:prior.projection_digest,deleted:true});
    return {status:'DUPLICATE',objectId:prior.canonical_object_id,digest:sourceDigest.toString('hex')};
  }
  if (input.deleted_at != null) {
    const identity=await lockSourceIdentity(client,context,input.source_pk);
    const objectId=identity.rows[0]?.canonical_object_id ?? randomUUID();
    const revision=await allocateRevision(client);
    const projection=await projectionDigest(client,sourceDigest,objectId,{deleted:true,deleted_at:input.deleted_at});
    if (identity.rows[0]?.order_id) {
      await client.query(`UPDATE hub.canonical_order SET deleted_at=$3,source_version=$4,version_domain=$5,
        channel_epoch=$6,hub_revision=$7 WHERE tenant_id=$1 AND id=$2`,
      [context.tenantId,identity.rows[0].order_id,input.deleted_at,version,context.versionDomain,context.channelEpoch,revision]);
      await client.query(`UPDATE hub.canonical_order_line SET deleted_at=$3,hub_revision=nextval('control.canonical_hub_revision_seq')
        WHERE tenant_id=$1 AND order_id=$2 AND deleted_at IS NULL`,[context.tenantId,identity.rows[0].order_id,input.deleted_at]);
    }
    await client.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id,order_id)
      VALUES($1,$2,'order',$3,$4,$5) ON CONFLICT(tenant_key,source_id,entity,source_pk) DO UPDATE
      SET canonical_object_id=EXCLUDED.canonical_object_id,order_id=EXCLUDED.order_id`,
    [context.tenantId,context.sourceId,input.source_pk,objectId,identity.rows[0]?.order_id ?? null]);
    await writeReceipt(client,context,{sourcePk:input.source_pk,objectId,version,digest:sourceDigest,projection,deleted:true});
    await writeOutbox(client,context,{objectId,revision,operation:'DELETE',projection,digest:sourceDigest});
    return {status:'APPLIED',objectId,hubRevision:revision,digest:sourceDigest.toString('hex')};
  }
  const orderInput=canonicalOrderSchema.parse(inputValue);
  const fenceSuperseded = await identityFenceIsNewer(client,context,{kind:'customer',externalId:orderInput.customer_external_id});
  if (fenceSuperseded) return { status:'QUARANTINED',code:'AUTHORITY_MAPPING_SUPERSEDED' };
  const customerMapping = mappingFor(proof.identity_mappings,'customer',orderInput.customer_external_id);
  if (!customerMapping || !customerMapping.target_id) return { status:'QUARANTINED',code:'IDENTITY_MAPPING_REQUIRED' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(customerMapping.target_id)) {
    return { status:'QUARANTINED',code:'IDENTITY_MAPPING_TARGET_INVALID' };
  }
  const customer = await client.query<{ id:string }>(`SELECT id FROM hub.canonical_customer
    WHERE tenant_id=$1 AND id=$2::uuid AND deleted_at IS NULL`,[context.tenantId,customerMapping.target_id]);
  if (!customer.rowCount) return { status:'QUARANTINED',code:'IDENTITY_MAPPING_TARGET_INVALID' };
  if (context.versionDomain==='SNAPSHOT_OBSERVATION' && prior && prior.source_content_digest.equals(sourceDigest) && !prior.deleted) {
    const current=await client.query<{customer_id:string;deleted_at:Date|null}>(`SELECT customer_id,deleted_at
      FROM hub.canonical_order WHERE tenant_id=$1 AND id=$2`,[context.tenantId,prior.canonical_object_id]);
    if(current.rowCount && current.rows[0].deleted_at===null && current.rows[0].customer_id===customer.rows[0].id) {
      const projection=await projectionDigest(client,sourceDigest,prior.canonical_object_id,{customer_id:customer.rows[0].id});
      await writeReceipt(client,context,{sourcePk:orderInput.source_pk,objectId:prior.canonical_object_id,version,digest:sourceDigest,projection,deleted:false});
      return {status:'DUPLICATE',objectId:prior.canonical_object_id,digest:sourceDigest.toString('hex')};
    }
  }
  const identity = await lockSourceIdentity(client,context,orderInput.source_pk);
  const objectId = identity.rows[0]?.canonical_object_id ?? randomUUID();
  const projection=await projectionDigest(client,sourceDigest,objectId,{customer_id:customer.rows[0].id});
  const revision = await allocateRevision(client);
  await client.query(`INSERT INTO hub.canonical_order
    (tenant_id,id,customer_id,order_no,status,order_at,amount,currency,source_updated_at,source_version,version_domain,channel_epoch,deleted_at,hub_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(tenant_id,id) DO UPDATE SET customer_id=EXCLUDED.customer_id,order_no=EXCLUDED.order_no,status=EXCLUDED.status,
      order_at=EXCLUDED.order_at,amount=EXCLUDED.amount,currency=EXCLUDED.currency,source_updated_at=EXCLUDED.source_updated_at,
      source_version=EXCLUDED.source_version,version_domain=EXCLUDED.version_domain,channel_epoch=EXCLUDED.channel_epoch,
      deleted_at=EXCLUDED.deleted_at,hub_revision=EXCLUDED.hub_revision`,
  [context.tenantId,objectId,customer.rows[0].id,orderInput.order_no,orderInput.status,orderInput.order_at,orderInput.amount,orderInput.currency,
    orderInput.source_updated_at,version,context.versionDomain,context.channelEpoch,orderInput.deleted_at ?? null,revision]);
  await client.query(`INSERT INTO control.canonical_source_identity
    (tenant_key,source_id,entity,source_pk,canonical_object_id,order_id) VALUES($1,$2,'order',$3,$4,$4)
    ON CONFLICT(tenant_key,source_id,entity,source_pk) DO UPDATE SET canonical_object_id=EXCLUDED.canonical_object_id,order_id=EXCLUDED.order_id`,
  [context.tenantId,context.sourceId,orderInput.source_pk,objectId]);
  await client.query(`INSERT INTO control.canonical_identity_reference(tenant_key,source_id,entity,source_pk,kind,external_id,target_id)
    VALUES($1,$2,'order',$3,'customer',$4,$5)
    ON CONFLICT(tenant_key,source_id,entity,source_pk,kind) DO UPDATE SET external_id=EXCLUDED.external_id,target_id=EXCLUDED.target_id`,
  [context.tenantId,context.sourceId,orderInput.source_pk,orderInput.customer_external_id,customer.rows[0].id]);
  if (orderInput.deleted_at != null) {
    await client.query(`UPDATE hub.canonical_order_line SET deleted_at=$3,hub_revision=nextval('control.canonical_hub_revision_seq')
      WHERE tenant_id=$1 AND order_id=$2 AND deleted_at IS NULL`,[context.tenantId,objectId,orderInput.deleted_at]);
  } else {
    const incomingLineIds=orderInput.lines.map(line=>line.source_line_id);
    await client.query(`UPDATE hub.canonical_order_line SET deleted_at=$3,source_version=$4,version_domain=$5,channel_epoch=$6,
      hub_revision=nextval('control.canonical_hub_revision_seq')
      WHERE tenant_id=$1 AND order_id=$2 AND deleted_at IS NULL AND NOT(source_line_id=ANY($7::text[]))`,
    [context.tenantId,objectId,orderInput.source_updated_at,version,context.versionDomain,context.channelEpoch,incomingLineIds]);
    for (const line of orderInput.lines) {
      const lineRevision = await allocateRevision(client);
      await client.query(`INSERT INTO hub.canonical_order_line
        (tenant_id,order_id,source_line_id,product_code,product_name,quantity,unit_price,line_amount,source_updated_at,
         source_version,version_domain,channel_epoch,deleted_at,hub_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13)
        ON CONFLICT(tenant_id,order_id,source_line_id) DO UPDATE SET product_code=EXCLUDED.product_code,
          product_name=EXCLUDED.product_name,quantity=EXCLUDED.quantity,unit_price=EXCLUDED.unit_price,
          line_amount=EXCLUDED.line_amount,source_updated_at=EXCLUDED.source_updated_at,source_version=EXCLUDED.source_version,
          version_domain=EXCLUDED.version_domain,channel_epoch=EXCLUDED.channel_epoch,deleted_at=NULL,hub_revision=EXCLUDED.hub_revision`,
      [context.tenantId,objectId,line.source_line_id,line.product_code,line.product_name,line.quantity,line.unit_price,
        line.line_amount,orderInput.source_updated_at,version,context.versionDomain,context.channelEpoch,lineRevision]);
    }
  }
  await writeReceipt(client,context,{sourcePk:orderInput.source_pk,objectId,version,digest:sourceDigest,projection,deleted:orderInput.deleted_at != null});
  await writeOutbox(client,context,{objectId,revision,operation:orderInput.deleted_at?'DELETE':'UPSERT',projection,digest:sourceDigest});
  return { status:'APPLIED',objectId,hubRevision:revision,digest:sourceDigest.toString('hex') };
}
