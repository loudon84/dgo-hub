import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createAuthService } from '../auth/service.js';
import { createCredential, digestCredential } from '../auth/credentials.js';
import { buildApp } from '../app.js';
import { createBoundedCapabilityProbe } from '../source-registry/capability-probe.js';
import { createSourceRegistryService, type EndpointAllowlist, type SecretResolver, type SourceConfig, type CapabilityProbe, type SourceRegistryService } from '../source-registry/service.js';
import { runMigrations } from '../migrations/runner.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

const evidenceDirectory = fileURLToPath(new URL('../../docs/execution/alpha1/m1-task-1-evidence/', import.meta.url));
const evidenceFile = join(evidenceDirectory, 'postgres-lifecycle.jsonl');
const controlledEvidenceRoot = fixtureEvidenceRootFromEnvironment();
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
let fixture: OwnedPostgres;
let auth: ReturnType<typeof createAuthService>;
let initialMigrationResult:{applied:string[];skipped:string[]};
let capabilityServer: ReturnType<typeof createServer>;
let capabilityPort = 0;
const capabilityFixtureId = randomUUID();

beforeEach(async () => {
  await fixture.pool.query(`TRUNCATE control.source_security_barrier, control.source_lifecycle_event,
    control.source_owner_approval, control.source_test_report, control.source_channel,
    control.source_identity_mapping_revision, control.source_mapping_revision, control.source_config_revision,
    control.source_registry, control.source_credential, control.identity_binding, control.auth_subject,
    control.tenant, control.credential_digest_registry CASCADE`);
});

beforeAll(async () => {
  if (!controlledEvidenceRoot) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(evidenceFile, '', 'utf8');
  }
  fixture = await startOwnedPostgres({ evidenceFile, evidenceRoot: controlledEvidenceRoot, taskLabel: 'm1task1' });
  initialMigrationResult=await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });
  auth = createAuthService({ pool: fixture.pool });
  capabilityServer = createServer((request,response) => {
    if (request.headers.authorization!=='Bearer fixture-secret') {
      response.writeHead(401,{ 'content-type':'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(200,{ 'content-type':'application/json' });
    response.end(JSON.stringify({protocol:'hub.source-capability.v1',schema_version:'customer-v1',source_identity:'fixture-crm',version_domain:'SOURCE_VERSION',entities:{
      customer:{fields:['customer_id','customer_name','owner_user_id','dept_id','status','source_version','deleted_at'],field_types:{source_version:'integer',deleted_at:'timestamp'},version_field:'source_version',delete_field:'deleted_at',delete_contract:'tombstone'},
    }}));
  });
  await new Promise<void>(resolve => capabilityServer.listen(0,'127.0.0.1',resolve));
  const capabilityAddress=capabilityServer.address();
  if (!capabilityAddress || typeof capabilityAddress==='string') throw new Error('fixture listen failed');
  capabilityPort=capabilityAddress.port;
}, 90_000);

afterAll(async () => {
  if (!fixture) return;
  await new Promise<void>((resolve,reject)=>capabilityServer.close(error=>error?reject(error):resolve()));
  await writeFile(join(dirname(fixture.evidenceFile), 'capability-http-resource-summary.json'), `${JSON.stringify({
    fixtureId:capabilityFixtureId,host:'127.0.0.1',port:capabilityPort,protocol:'http',cleanup:'server closed and port released',
  }, null, 2)}\n`);
  const resource = {
    taskLabel: fixture.taskLabel,
    runLabel: fixture.runLabel,
    containerId: fixture.containerId,
    imageReference: fixture.imageReference,
    repoDigest: fixture.repoDigest,
    runtimeImageId: fixture.runtimeImageId,
    hostPort: fixture.hostPort,
  };
  await fixture.close();
  await writeFile(join(dirname(fixture.evidenceFile), 'postgres-resource-summary.json'), `${JSON.stringify({ ...resource, cleanup: 'confirmed removed by exact owned container ID' }, null, 2)}\n`);
});

describe('M1 source admission authorization', () => {
  it('exposes a transaction-scoped current-source assertion', () => {
    expect((auth as unknown as { assertCurrentSource?: unknown }).assertCurrentSource).toBeTypeOf('function');
  });

  it('applies migration 005 from the clean M0 chain and skips it with the same checksum on repeat', async () => {
    expect(initialMigrationResult).toEqual({applied:['001_init','002_identity_auth','003_mcp_audit_boundary','004_alpha1_runtime_security','005_source_registry'],skipped:[]});
    const first = await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });
    expect(first).toEqual({ applied: [], skipped: ['001_init','002_identity_auth','003_mcp_audit_boundary','004_alpha1_runtime_security','005_source_registry'] });
    const row = await fixture.pool.query<{ version: number; name: string; checksum: string }>(
      'SELECT version,name,checksum FROM control.schema_migration WHERE version=5',
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ version: 5, name: 'source_registry' });
    expect(row.rows[0].checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not grant API access to source digest or secret reference and keeps the lock function private', async () => {
    const grants = await fixture.pool.query<{ source_digest: boolean; source_secret: boolean; source_table: boolean;
      api_lock: boolean; public_lock: boolean; mcp_lock: boolean; mcp_source_table: boolean }>(
      `SELECT has_column_privilege('hub_api','control.source_credential','digest','SELECT') AS source_digest,
        has_column_privilege('hub_api','control.source_credential','secret_ref','SELECT') AS source_secret,
        has_table_privilege('hub_api','control.source_credential','SELECT') AS source_table,
        has_function_privilege('hub_api','control.lock_current_source(uuid,text,text,text)','EXECUTE') AS api_lock,
        EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE p.oid='control.lock_current_source(uuid,text,text,text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_lock,
        has_function_privilege('hub_mcp','control.lock_current_source(uuid,text,text,text)','EXECUTE') AS mcp_lock,
        has_table_privilege('hub_mcp','control.source_registry','SELECT') AS mcp_source_table`,
    );
    expect(grants.rows[0]).toEqual({ source_digest: false, source_secret: false, source_table: false,
      api_lock: true, public_lock: false, mcp_lock: false, mcp_source_table: false });
  });

  it('completes the source manager workflow through the real hub_api role', async () => {
    const owner=await prepareOwner();
    const rolePool=roleScopedPool();
    const {service}=managerService(rolePool);
    const config:SourceConfig={name:'CRM',connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',
      endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'};
    const created=await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config});
    const mapping=await service.writeMappings(owner,'crm-new',created.revision,[
      ...customerMappings(),
    ]);
    await expect(service.validateMappings(owner,'crm-new',mapping.revision)).resolves.toMatchObject({valid:true});
    const tested=await service.test(owner,'crm-new',created.revision);
    const approval=await service.approve(owner,'crm-new',created.revision,tested.test_report_id,tested.data_contract_ref);
    await expect(service.activate(owner,'crm-new',created.revision,approval.approval_id)).resolves.toMatchObject({lifecycle:'ACTIVE'});
    await expect(service.pause(owner,'crm-new',created.revision,'role workflow')).resolves.toMatchObject({lifecycle:'PAUSED'});
  });

  it('locks and accepts only an unchanged ACTIVE source snapshot inside the caller transaction', async () => {
    const token = await activeSource();
    const client = await fixture.pool.connect();
    const originalQuery = client.query.bind(client);
    const commands: string[] = [];
    client.query = ((query: unknown, ...args: unknown[]) => {
      if (typeof query === 'string') commands.push(query.trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase());
      return (originalQuery as (...values: unknown[]) => unknown)(query, ...args);
    }) as typeof client.query;
    const release = vi.spyOn(client, 'release');
    try {
      await client.query('BEGIN');
      const snapshot = await auth.authenticateSource(token, 'customer');
      await auth.assertCurrentSource(snapshot, 'customer', client);
      expect(commands.filter(value => ['BEGIN','COMMIT','ROLLBACK'].includes(value))).toEqual(['BEGIN']);
      expect(release).not.toHaveBeenCalled();
      await client.query('ROLLBACK');
    } finally {
      release.mockRestore();
      client.release();
    }
  });

  it('rejects epoch, revision, pause, entity, and tenant changes after source authentication', async () => {
    const token = await activeSource();
    const snapshot = await auth.authenticateSource(token, 'customer');
    await auth.repository.updateSourceCredential('crm-main','m1_tenant',true,'2',['customer']);
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(auth.assertCurrentSource(snapshot,'customer',client)).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('serializes an admission check before pause using compatible row locks', async () => {
    const token=await activeSource();
    await auth.repository.provisionSubject({tenantId:'m1_tenant',userId:'owner',managementScopes:['source:write']});
    await auth.repository.bindIdentity({issuer:'https://idp.example.test',subject:'owner',tenantId:'m1_tenant',userId:'owner'});
    const actor=await auth.resolveOidc('https://idp.example.test','owner');
    const snapshot=await auth.authenticateSource(token,'customer');
    const client=await fixture.pool.connect();
    const {service}=managerService();
    let pause:Promise<unknown>|undefined;
    try {
      await client.query('BEGIN');
      await auth.assertCurrentSource(snapshot,'customer',client);
      pause=service.pause(actor,'crm-main','1','concurrency check');
      const deadline=Date.now()+2_000;
      let blocked=false;
      while(Date.now()<deadline) {
        const waiting=await fixture.pool.query<{waiting:boolean}>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM control.lock_source_credential%') AS waiting`,
        );
        if(waiting.rows[0].waiting) { blocked=true; break; }
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      await client.query('COMMIT');
      await pause;
      const next=await fixture.pool.connect();
      try {
        await next.query('BEGIN');
        await expect(auth.assertCurrentSource(snapshot,'customer',next)).rejects.toMatchObject({code:'AUTH_CONTEXT_CHANGED'});
        await next.query('ROLLBACK');
      } finally { next.release(); }
    } finally {
      if(pause) await pause.catch(()=>undefined);
      await client.query('ROLLBACK').catch(()=>undefined);
      client.release();
    }
  });

  it('rejects current-source snapshots for wrong entity, disabled credential, disabled tenant, and pause', async () => {
    const token=await activeSource();
    const snapshot=await auth.authenticateSource(token,'customer');
    const client=await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(auth.assertCurrentSource(snapshot,'order',client)).rejects.toMatchObject({code:'AUTH_CONTEXT_CHANGED'});
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await auth.repository.updateSourceCredential('crm-main','m1_tenant',false,'1',['customer']);
    const disabled=await fixture.pool.connect();
    try { await disabled.query('BEGIN'); await expect(auth.assertCurrentSource(snapshot,'customer',disabled)).rejects.toMatchObject({code:'AUTH_CONTEXT_CHANGED'}); await disabled.query('ROLLBACK'); }
    finally { disabled.release(); }
    await auth.repository.updateSourceCredential('crm-main','m1_tenant',true,'1',['customer']);
    const tenantSnapshot=await auth.authenticateSource(token,'customer');
    await auth.repository.setTenantEnabled('m1_tenant',false);
    const tenantClient=await fixture.pool.connect();
    try { await tenantClient.query('BEGIN'); await expect(auth.assertCurrentSource(tenantSnapshot,'customer',tenantClient)).rejects.toMatchObject({code:'AUTH_CONTEXT_CHANGED'}); await tenantClient.query('ROLLBACK'); }
    finally { tenantClient.release(); }
    await auth.repository.setTenantEnabled('m1_tenant',true);
    const pauseSnapshot=await auth.authenticateSource(token,'customer');
    await auth.repository.provisionSubject({tenantId:'m1_tenant',userId:'owner',managementScopes:['source:write']});
    await auth.repository.bindIdentity({issuer:'https://idp.example.test',subject:'owner',tenantId:'m1_tenant',userId:'owner'});
    const actor=await auth.resolveOidc('https://idp.example.test','owner');
    await managerService().service.pause(actor,'crm-main','1','current source test');
    const pausedClient=await fixture.pool.connect();
    try { await pausedClient.query('BEGIN'); await expect(auth.assertCurrentSource(pauseSnapshot,'customer',pausedClient)).rejects.toMatchObject({code:'AUTH_CONTEXT_CHANGED'}); await pausedClient.query('ROLLBACK'); }
    finally { pausedClient.release(); }
  });

  it('runs first activation through tested config, exact Owner approval, and an immutable single channel', async () => {
    const owner=await prepareOwner();
    const { service, seenSecrets }=managerService();
    const config:SourceConfig={ name:'CRM',connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',
      endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone' };
    const created=await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config});
    expect(created).toMatchObject({source_id:'crm-new',revision:'1',lifecycle:'DRAFT'});
    const mapping=await service.writeMappings(owner,'crm-new','1',customerMappings());
    expect(mapping.revision).toBe('2');
    await expect(service.validateMappings(owner,'crm-new','2')).resolves.toMatchObject({valid:true,errors:[]});
    const tested=await service.test(owner,'crm-new','1');
    expect(tested.status).toBe('PASS');
    const approval=await service.approve(owner,'crm-new','1',tested.test_report_id,tested.data_contract_ref);
    expect(approval.status).toBe('APPROVED');
    const activationRace=await Promise.allSettled([
      service.activate(owner,'crm-new','1',approval.approval_id),
      service.activate(owner,'crm-new','1',approval.approval_id),
    ]);
    expect(activationRace.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    expect(activationRace.filter(item=>item.status==='rejected')).toHaveLength(1);
    const activated=activationRace.find(item=>item.status==='fulfilled')?.value;
    expect(activated).toMatchObject({source_id:'crm-new',lifecycle:'ACTIVE',channels:['customer']});
    expect(seenSecrets).toEqual(['fixture-secret']);
    const channels=await fixture.pool.query<{connector:string;mode:string;version_domain:string;channel_epoch:string|number;state:string}>(
      `SELECT connector,mode,version_domain,channel_epoch,state FROM control.source_channel WHERE tenant_key='m1_tenant' AND source_id='crm-new'`);
    expect(channels.rows).toEqual([{connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',channel_epoch:'1',state:'active'}]);
    const snapshot=await auth.authenticateSource(credentialToken,'customer');
    const client=await fixture.pool.connect();
    try { await client.query('BEGIN'); await auth.assertCurrentSource(snapshot,'customer',client); await client.query('ROLLBACK'); }
    finally { client.release(); }
    const serialized=JSON.stringify({created,mapping,tested,approval,activated,listed:await service.list(owner)});
    expect(serialized).not.toContain('fixture-secret');
    expect(serialized).not.toContain('vault:/crm/credential-v1');
  });

  it('serializes mapping revision races and rejects a channel switch before changing config', async () => {
    const owner=await prepareOwner();
    const {service}=managerService();
    const config:SourceConfig={name:'CRM',connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',
      endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'};
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config});
    const outcomes=await Promise.allSettled([
      service.writeMappings(owner,'crm-new','1',customerMappings()),
      service.writeMappings(owner,'crm-new','1',customerMappings('name')),
    ]);
    expect(outcomes.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.filter(item=>item.status==='rejected')).toHaveLength(1);
    const mappings=await service.mappings(owner,'crm-new');
    await expect(service.validateMappings(owner,'crm-new',mappings.revision)).resolves.toMatchObject({valid:true});
    const tested=await service.test(owner,'crm-new','1');
    const approval=await service.approve(owner,'crm-new','1',tested.test_report_id,tested.data_contract_ref);
    await expect(service.activate({...owner,managementScopes:['source:approve']},'crm-new','1',approval.approval_id))
      .rejects.toMatchObject({code:'AUTH_FORBIDDEN'});
    await service.activate(owner,'crm-new','1',approval.approval_id);
    await expect(service.update(owner,'crm-new',{expected_revision:'1',config:{...config,connector:'postgresql',mode:'FULL_SNAPSHOT',version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'pg-prod'}}))
      .rejects.toMatchObject({code:'SOURCE_SWITCH_UNAVAILABLE'});
    await expect(service.get(owner,'crm-new')).resolves.toMatchObject({revision:'1',lifecycle:'ACTIVE',connector:'rest'});
  });

  it('invalidates current approval and pauses on Owner reassignment while preserving the old channel identity', async () => {
    const owner=await prepareOwner();
    const newOwner=await auth.resolveOidc('https://idp.example.test','new-owner');
    const {service}=managerService();
    const config:SourceConfig={name:'CRM',connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',
      endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'};
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config});
    await service.writeMappings(owner,'crm-new','1',customerMappings());
    const tested=await service.test(owner,'crm-new','1');
    const approval=await service.approve(owner,'crm-new','1',tested.test_report_id,tested.data_contract_ref);
    await service.activate(owner,'crm-new','1',approval.approval_id);
    const before=await fixture.pool.query<{source_epoch:string|number}>("SELECT source_epoch FROM control.source_credential WHERE source_id='crm-new'");
    const updated=await service.update(owner,'crm-new',{expected_revision:'1',config,data_owner_user_id:newOwner.userId});
    expect(updated).toMatchObject({revision:'2',lifecycle:'PAUSED',data_owner_user_id:newOwner.userId,owner_revision:'2'});
    const after=await fixture.pool.query<{source_epoch:string|number}>("SELECT source_epoch FROM control.source_credential WHERE source_id='crm-new'");
    expect(BigInt(after.rows[0].source_epoch)-BigInt(before.rows[0].source_epoch)).toBe(1n);
    const state=await fixture.pool.query<{lifecycle:string;connector:string;channel_epoch:string|number;state:string}>(
      `SELECT r.lifecycle,c.connector,c.channel_epoch,c.state FROM control.source_registry r JOIN control.source_channel c USING(tenant_key,source_id) WHERE r.source_id='crm-new'`);
    expect(state.rows).toEqual([{lifecycle:'PAUSED',connector:'rest',channel_epoch:'1',state:'active'}]);
    await expect(service.activate(newOwner,'crm-new','1',approval.approval_id)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  });

  it('keeps source_epoch stable for no-op credential updates and advances it once for effective changes', async () => {
    await activeSource();
    const before = await fixture.pool.query<{source_epoch:string|number}>("SELECT source_epoch FROM control.source_credential WHERE source_id='crm-main'");
    await auth.repository.updateSourceCredential('crm-main','m1_tenant',true,'1',['customer']);
    const noop = await fixture.pool.query<{source_epoch:string|number}>("SELECT source_epoch FROM control.source_credential WHERE source_id='crm-main'");
    expect(BigInt(noop.rows[0].source_epoch)).toBe(BigInt(before.rows[0].source_epoch));
    await auth.repository.updateSourceCredential('crm-main','m1_tenant',true,'2',['customer']);
    const changed = await fixture.pool.query<{source_epoch:string|number}>("SELECT source_epoch FROM control.source_credential WHERE source_id='crm-main'");
    expect(BigInt(changed.rows[0].source_epoch)-BigInt(noop.rows[0].source_epoch)).toBe(1n);
  });

  it('pauses an active source when its credential material rotates', async () => {
    const owner=await prepareOwner();
    const {service}=managerService();
    const config:SourceConfig={name:'CRM',connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',
      endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'};
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config});
    await service.writeMappings(owner,'crm-new','1',customerMappings());
    const tested=await service.test(owner,'crm-new','1');
    const approval=await service.approve(owner,'crm-new','1',tested.test_report_id,tested.data_contract_ref);
    await service.activate(owner,'crm-new','1',approval.approval_id);
    const replacement=createCredential();
    await auth.repository.provisionSourceCredential({sourceId:'crm-new',tenantId:'m1_tenant',token:replacement.secret,
      secretRef:'vault:/crm/credential-v1',allowedEntities:['customer'],revision:'1'});
    await expect(service.get(owner,'crm-new')).resolves.toMatchObject({lifecycle:'PAUSED'});
  });

  it('invalidates credential scope changes and admits only the approved config channels after reapproval', async () => {
    const owner=await prepareOwner();
    const {service}=managerService();
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config:{name:'CRM',connector:'rest',mode:'INCREMENTAL',
      version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'}});
    await service.writeMappings(owner,'crm-new','1',customerMappings());
    const tested=await service.test(owner,'crm-new','1');
    const firstApproval=await service.approve(owner,'crm-new','1',tested.test_report_id,tested.data_contract_ref);
    await service.activate(owner,'crm-new','1',firstApproval.approval_id);

    const before=await fixture.pool.query<{credential_generation:string|number}>("SELECT credential_generation FROM control.source_credential WHERE source_id='crm-new'");
    await auth.repository.updateSourceCredential('crm-new','m1_tenant',true,'1',['customer','order']);
    const extended=await fixture.pool.query<{lifecycle:string;allowed_entities:string[];credential_generation:string|number}>(
      `SELECT r.lifecycle,c.allowed_entities,c.credential_generation FROM control.source_registry r JOIN control.source_credential c USING(tenant_key,source_id) WHERE r.source_id='crm-new'`);
    expect(extended.rows[0]).toMatchObject({lifecycle:'PAUSED',allowed_entities:['customer','order']});
    expect(BigInt(extended.rows[0].credential_generation)-BigInt(before.rows[0].credential_generation)).toBe(1n);
    await expect(service.activate(owner,'crm-new','1',firstApproval.approval_id)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});

    const admittedOrder=await auth.authenticateSource(credentialToken,'order');
    const orderClient=await fixture.pool.connect();
    try {
      await orderClient.query('BEGIN');
      await expect(auth.assertCurrentSource(admittedOrder,'order',orderClient)).rejects.toMatchObject({code:'AUTH_CONTEXT_CHANGED'});
      await orderClient.query('ROLLBACK');
    } finally { orderClient.release(); }

    const secondTest=await service.test(owner,'crm-new','1');
    const secondApproval=await service.approve(owner,'crm-new','1',secondTest.test_report_id,secondTest.data_contract_ref);
    await service.activate(owner,'crm-new','1',secondApproval.approval_id);
    const approvedOrder=await auth.authenticateSource(credentialToken,'order');
    const approvedClient=await fixture.pool.connect();
    try {
      await approvedClient.query('BEGIN');
      await expect(auth.assertCurrentSource(approvedOrder,'order',approvedClient)).rejects.toMatchObject({code:'AUTH_CONTEXT_CHANGED'});
      await approvedClient.query('ROLLBACK');
    } finally { approvedClient.release(); }
    const allowedCustomer=await auth.authenticateSource(credentialToken,'customer');
    const customerClient=await fixture.pool.connect();
    try { await customerClient.query('BEGIN'); await auth.assertCurrentSource(allowedCustomer,'customer',customerClient); await customerClient.query('ROLLBACK'); }
    finally { customerClient.release(); }

    const stable=await fixture.pool.query<{credential_generation:string|number}>("SELECT credential_generation FROM control.source_credential WHERE source_id='crm-new'");
    await auth.repository.updateSourceCredential('crm-new','m1_tenant',true,'1',['customer','order']);
    const noop=await fixture.pool.query<{credential_generation:string|number;lifecycle:string}>(
      `SELECT c.credential_generation,r.lifecycle FROM control.source_credential c JOIN control.source_registry r USING(tenant_key,source_id) WHERE c.source_id='crm-new'`);
    expect(BigInt(noop.rows[0].credential_generation)).toBe(BigInt(stable.rows[0].credential_generation));
    expect(noop.rows[0].lifecycle).toBe('ACTIVE');

    await auth.repository.updateSourceCredential('crm-new','m1_tenant',true,'1',['customer']);
    const removed=await fixture.pool.query<{lifecycle:string;credential_generation:string|number}>(
      `SELECT r.lifecycle,c.credential_generation FROM control.source_registry r JOIN control.source_credential c USING(tenant_key,source_id) WHERE r.source_id='crm-new'`);
    expect(removed.rows[0].lifecycle).toBe('PAUSED');
    expect(BigInt(removed.rows[0].credential_generation)-BigInt(stable.rows[0].credential_generation)).toBe(1n);
    await expect(auth.authenticateSource(credentialToken,'order')).rejects.toMatchObject({code:'AUTH_FORBIDDEN'});
  });

  it('rotates a provisioned source credential before registry onboarding', async () => {
    await auth.repository.provisionTenant({tenantId:'m1_tenant',businessTimezone:'UTC'});
    const first=createCredential();
    await auth.repository.provisionSourceCredential({sourceId:'crm-pre-registry',tenantId:'m1_tenant',token:first.secret,
      secretRef:'vault:/crm/credential-v1',allowedEntities:['customer'],revision:'1'});
    const initial=await fixture.pool.query<{credential_generation:string|number;source_epoch:string|number}>(
      "SELECT credential_generation,source_epoch FROM control.source_credential WHERE source_id='crm-pre-registry'");
    const next=createCredential();
    await expect(auth.repository.provisionSourceCredential({sourceId:'crm-pre-registry',tenantId:'m1_tenant',token:next.secret,
      secretRef:'vault:/crm/credential-v1',allowedEntities:['customer'],revision:'1'})).resolves.toBeUndefined();
    const rotated=await fixture.pool.query<{credential_generation:string|number;source_epoch:string|number}>(
      "SELECT credential_generation,source_epoch FROM control.source_credential WHERE source_id='crm-pre-registry'");
    expect(BigInt(rotated.rows[0].credential_generation)-BigInt(initial.rows[0].credential_generation)).toBe(1n);
    expect(BigInt(rotated.rows[0].source_epoch)-BigInt(initial.rows[0].source_epoch)).toBe(1n);
    const registry=await fixture.pool.query("SELECT 1 FROM control.source_registry WHERE source_id='crm-pre-registry'");
    expect(registry.rowCount).toBe(0);
  });

  it('rejects a previously approved test after a newer test fails', async () => {
    const owner=await prepareOwner();
    const base=managerService();
    let probePass=true;
    const service=createSourceRegistryService({pool:fixture.pool,auth,secretResolver:base.secretResolver,endpointAllowlist:base.endpointAllowlist,
      capabilityProbe:{run:async()=>({passed:probePass,checks:[probePass?'PROFILE_VALID':'ENDPOINT_REJECTED']})},environmentKind:'local_lab'});
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config:{name:'CRM',connector:'rest',mode:'INCREMENTAL',
      version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'}});
    await service.writeMappings(owner,'crm-new','1',customerMappings());
    const passed=await service.test(owner,'crm-new','1');
    const approval=await service.approve(owner,'crm-new','1',passed.test_report_id,passed.data_contract_ref);
    probePass=false;
    const failed=await service.test(owner,'crm-new','1');
    expect(failed.status).toBe('FAIL');
    await expect(service.activate(owner,'crm-new','1',approval.approval_id)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  });

  it('allows pause and resume with the same currently valid approval', async () => {
    const owner=await prepareOwner();
    const {service}=managerService();
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config:{name:'CRM',connector:'rest',mode:'INCREMENTAL',
      version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'}});
    await service.writeMappings(owner,'crm-new','1',customerMappings());
    const tested=await service.test(owner,'crm-new','1');
    const approval=await service.approve(owner,'crm-new','1',tested.test_report_id,tested.data_contract_ref);
    await service.activate(owner,'crm-new','1',approval.approval_id);
    await service.pause(owner,'crm-new','1','temporary maintenance');
    await expect(service.activate(owner,'crm-new','1',approval.approval_id)).resolves.toMatchObject({lifecycle:'ACTIVE'});
  });

  it('authenticates as hub_api while denying direct credential material reads', async () => {
    const token = await activeSource();
    const client = await fixture.pool.connect();
    try {
      await client.query('SET ROLE hub_api');
      const authenticated = await client.query<{source_id:string;tenant_key:string;source_epoch:string|number}>(
        'SELECT source_id,tenant_key,source_epoch FROM control.authenticate_source($1)',
        [digestCredential(token)],
      );
      expect(authenticated.rows).toEqual([{source_id:'crm-main',tenant_key:'m1_tenant',source_epoch:'0'}]);
      await expect(client.query('SELECT digest FROM control.source_credential')).rejects.toThrow();
      await expect(client.query('SELECT secret_ref FROM control.source_credential')).rejects.toThrow();
      await client.query('RESET ROLE');
    } finally { client.release(); }
  });

  it('exposes the source registry through the OIDC principal tenant and redacts internal references', async () => {
    const owner=await prepareOwner();
    await auth.repository.provisionSubject({tenantId:owner.tenantId,userId:'new-owner',departmentId:'dept-sales',managementScopes:['source:read','source:write','source:approve','mapping:write']});
    const {service}=managerService();
    const app=await buildApp({logger:false,sourceRegistry:{
      authenticator:async token=>token==='owner-token'?owner:token==='approve-token'?{...owner,managementScopes:['source:approve']}
        :token==='write-token'?{...owner,managementScopes:['source:write']}:Promise.reject(new Error('invalid')),
      authService:auth,
      sourceService:service,
    }});
    try {
      const forged=await app.inject({method:'POST',url:'/hub/v1/admin/sources',headers:{authorization:'Bearer owner-token'},payload:{
        tenant_id:'other-tenant',source_id:'crm-new',data_owner_user_id:owner.userId,
        config:{name:'CRM',connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'crm-prod',
          secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'},
      }});
      expect(forged.statusCode).toBe(400);
      const created=await app.inject({method:'POST',url:'/hub/v1/admin/sources',headers:{authorization:'Bearer owner-token'},payload:{
        source_id:'crm-new',data_owner_user_id:owner.userId,
        config:{name:'CRM',connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'crm-prod',
          secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'},
      }});
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({data:{source_id:'crm-new',lifecycle:'DRAFT',revision:'1'}});
      expect(created.body).not.toContain('vault:/crm/credential-v1');
      const userCandidate=await app.inject({method:'GET',url:'/hub/v1/admin/identity-mappings?source_id=crm-new&kind=user&external_id=owner-ext',headers:{authorization:'Bearer approve-token'}});
      expect(userCandidate.statusCode).toBe(200);
      expect(userCandidate.json().data).toMatchObject({resolved:true,candidates:expect.arrayContaining([expect.objectContaining({target_id:owner.userId})])});
      const userConfirmation=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${userCandidate.json().data.id}`,
        headers:{authorization:'Bearer approve-token'},payload:{expected_revision:'0',target_id:owner.userId,reason:'confirm source owner mapping'}});
      expect(userConfirmation.statusCode).toBe(200);
      const staleConfirmation=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${userCandidate.json().data.id}`,
        headers:{authorization:'Bearer approve-token'},payload:{expected_revision:'0',target_id:owner.userId,reason:'stale confirmation'}});
      expect(staleConfirmation.statusCode).toBe(409);
      const departmentCandidate=await app.inject({method:'GET',url:'/hub/v1/admin/identity-mappings?source_id=crm-new&kind=department&external_id=dept-ext',headers:{authorization:'Bearer approve-token'}});
      const departmentConfirmation=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${departmentCandidate.json().data.id}`,
        headers:{authorization:'Bearer approve-token'},payload:{expected_revision:'1',target_id:'dept-sales',reason:'confirm source department mapping'}});
      expect(departmentConfirmation.statusCode).toBe(200);
      const customerCandidate=await app.inject({method:'GET',url:'/hub/v1/admin/identity-mappings?source_id=crm-new&kind=customer&external_id=customer-ext',headers:{authorization:'Bearer approve-token'}});
      expect(customerCandidate.json().data).toMatchObject({resolved:false,candidates:[]});
      const customerConfirmation=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${customerCandidate.json().data.id}`,
        headers:{authorization:'Bearer approve-token'},payload:{expected_revision:'2',target_id:'8a2efdd5-3d59-4f5f-97f9-298a68006001',reason:'unresolved customer target'}});
      expect(customerConfirmation.statusCode).toBe(404);
      const mapping=await service.writeMappings(owner,'crm-new','1',customerMappings());
      const unsupportedSample=await app.inject({method:'POST',url:'/hub/v1/admin/sources/crm-new/mappings/validate',
        headers:{authorization:'Bearer owner-token'},payload:{revision:mapping.revision,sample_ref:'sample-1'}});
      expect(unsupportedSample.statusCode).toBe(422);
      expect(unsupportedSample.json()).toMatchObject({request_id:expect.any(String),error:{code:'AUTH_INPUT_INVALID'}});
      const tested=await service.test(owner,'crm-new',created.json().data.revision);
      const approved=await app.inject({method:'POST',url:'/hub/v1/admin/sources/crm-new/approve',headers:{authorization:'Bearer approve-token'},payload:{
        revision:created.json().data.revision,test_report_id:tested.test_report_id,data_contract_ref:tested.data_contract_ref,
      }});
      expect(approved.statusCode).toBe(200);
      const activated=await app.inject({method:'POST',url:'/hub/v1/admin/sources/crm-new/activate',headers:{authorization:'Bearer write-token'},payload:{
        revision:created.json().data.revision,approval_id:approved.json().data.approval_id,
      }});
      expect(activated.statusCode).toBe(200);
      const malformed=await app.inject({method:'POST',url:'/hub/v1/admin/sources/crm-new/test',headers:{authorization:'Bearer owner-token','content-type':'application/json'},payload:'{' });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({request_id:expect.any(String),error:{code:'AUTH_INPUT_INVALID'}});
      const unsupported=await app.inject({method:'POST',url:'/hub/v1/admin/sources/crm-new/test',headers:{authorization:'Bearer owner-token','content-type':'text/plain'},payload:'{}'});
      expect(unsupported.statusCode).toBe(415);
      expect(unsupported.json()).toMatchObject({request_id:expect.any(String),error:{code:'AUTH_INPUT_INVALID'}});
      const oversizedBody=JSON.stringify({expected_revision:'1',padding:'x'.repeat(2*1024*1024)});
      const oversized=await app.inject({method:'POST',url:'/hub/v1/admin/sources/crm-new/test',
        headers:{authorization:'Bearer owner-token','content-type':'application/json'},payload:oversizedBody});
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json()).toMatchObject({request_id:expect.any(String),error:{code:'AUTH_INPUT_INVALID'}});
      const fetched=await app.inject({method:'GET',url:'/hub/v1/admin/sources/crm-new',headers:{authorization:'Bearer owner-token'}});
      expect(fetched.statusCode).toBe(200);
      expect(fetched.body).not.toContain('vault:/crm/credential-v1');
    } finally { await app.close(); }
  });

  it('performs a bounded authenticated REST capability probe against an owned loopback fixture', async () => {
    let seenAuthorization = '';
    const server = createServer((request, response) => {
      seenAuthorization = String(request.headers.authorization ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        protocol: 'hub.source-capability.v1', schema_version: 'customer-v1', source_identity:'fixture-crm',version_domain:'SOURCE_VERSION',
        entities: { customer: { fields: ['customer_id','customer_name','owner_user_id','dept_id','status','source_version','deleted_at'],field_types:{source_version:'integer',deleted_at:'timestamp'}, version_field: 'source_version',
          delete_field:'deleted_at', delete_contract: 'tombstone' } },
      }));
    });
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
    const address=server.address();
    if (!address || typeof address==='string') throw new Error('fixture listen failed');
    try {
      const result=await createBoundedCapabilityProbe({environmentKind:'local_lab'}).run({
        config:{name:'fixture',connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'fixture',
          secret_ref:'vault:/fixture/rest',allowed_entities:['customer'],delete_contract:'tombstone'},
        endpoint:{revision:'fixture-v1',connector:'rest',protocol:'http:',host:'127.0.0.1',port:address.port,allow_loopback_http:true,
          path:'/capability',schema_version:'customer-v1',source_identity:'fixture-crm',entities:{customer:{version_field:'source_version',delete_field:'deleted_at'}}},
        secret:'fixture-secret',mappings:customerMappings(),identityMappings:[],
      });
      expect(result).toMatchObject({passed:true,checks:expect.arrayContaining(['ENDPOINT_REACHABLE','SOURCE_IDENTITY_VALID','READ_ONLY','MAPPING_VALID','VERSION_DELETE_CONTRACT_VALID'])});
      expect(seenAuthorization).toBe('Bearer fixture-secret');
    } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  });

  it('accepts an allowlisted HTTPS endpoint on the default 443 port', async () => {
    let requestedUrl='';
    const fetchMock = vi.fn(async (input:RequestInfo|URL) => { requestedUrl=String(input); return new Response(JSON.stringify({
      protocol:'hub.source-capability.v1',schema_version:'customer-v1',source_identity:'fixture-crm',version_domain:'SOURCE_VERSION',
      entities:{customer:{fields:['customer_id','customer_name','owner_user_id','dept_id','status','source_version','deleted_at'],field_types:{source_version:'integer',deleted_at:'timestamp'},version_field:'source_version',delete_field:'deleted_at',delete_contract:'tombstone'}},
    }),{status:200,headers:{'content-type':'application/json'}}); });
    vi.stubGlobal('fetch',fetchMock);
    try {
      const result=await createBoundedCapabilityProbe({environmentKind:'site'}).run({
        config:{name:'fixture',connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'fixture',
          secret_ref:'vault:/fixture/rest',allowed_entities:['customer'],delete_contract:'tombstone'},
        endpoint:{revision:'fixture-v1',connector:'rest',protocol:'https:',host:'crm.example.test',port:443,path:'/capability',
          schema_version:'customer-v1',source_identity:'fixture-crm',entities:{customer:{version_field:'source_version',delete_field:'deleted_at'}}},
        secret:'fixture-secret',mappings:[{entity:'customer',source_field:'customer_id',target_field:'customer_name',transform:'identity'}],identityMappings:[],
      });
      expect(result.passed).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(requestedUrl).toBe('https://crm.example.test/capability');
    } finally { vi.unstubAllGlobals(); }
  });

  it('performs a read-only PostgreSQL source probe against an owned role and approved objects', async () => {
    const suffix=randomUUID().replaceAll('-','').slice(0,20);
    const schema=`m1_probe_${suffix}`;
    const role=`m1_reader_${suffix}`;
    await fixture.pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await fixture.pool.query(`CREATE SCHEMA ${schema}`);
    await fixture.pool.query(`CREATE TABLE ${schema}.customer_data(customer_id text,source_version bigint,deleted_at timestamptz)`);
    await fixture.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await fixture.pool.query(`GRANT SELECT ON ${schema}.customer_data TO ${role}`);
    try {
      const result=await createBoundedCapabilityProbe({environmentKind:'local_lab'}).run({
        config:{name:'fixture',connector:'postgresql',mode:'FULL_SNAPSHOT',version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'fixture',
          secret_ref:'vault:/fixture/postgres',allowed_entities:['customer'],delete_contract:'tombstone'},
        endpoint:{revision:'fixture-v1',connector:'postgresql',protocol:'postgres:',host:'127.0.0.1',port:fixture.hostPort,
          allow_loopback_plaintext:true,database:'postgres',user:role,schema,entities:{customer:{table:'customer_data',version_field:'source_version',delete_field:'deleted_at'}}},
        secret:'fixture-secret',mappings:[{entity:'customer',source_field:'customer_id',target_field:'customer_name',transform:'identity'}],identityMappings:[],
      });
      expect(result).toMatchObject({passed:true,checks:expect.arrayContaining(['ENDPOINT_REACHABLE','SOURCE_IDENTITY_VALID','READ_ONLY','MAPPING_VALID','VERSION_DELETE_CONTRACT_VALID'])});
      await fixture.pool.query(`CREATE TABLE ${schema}.bad_customer(customer_id text,source_version text,deleted_at text)`);
      await fixture.pool.query(`GRANT SELECT ON ${schema}.bad_customer TO ${role}`);
      const badType=await createBoundedCapabilityProbe({environmentKind:'local_lab'}).run({
        config:{name:'fixture',connector:'postgresql',mode:'FULL_SNAPSHOT',version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'fixture',
          secret_ref:'vault:/fixture/postgres',allowed_entities:['customer'],delete_contract:'tombstone'},
        endpoint:{revision:'fixture-v1',connector:'postgresql',protocol:'postgres:',host:'127.0.0.1',port:fixture.hostPort,
          allow_loopback_plaintext:true,database:'postgres',user:role,schema,entities:{customer:{table:'bad_customer',version_field:'source_version',delete_field:'deleted_at'}}},
        secret:'fixture-secret',mappings:[{entity:'customer',source_field:'customer_id',target_field:'customer_name',transform:'identity'}],identityMappings:[],
      });
      expect(badType).toMatchObject({passed:false,checks:expect.arrayContaining(['VERSION_DELETE_CONTRACT_INVALID'])});
    } finally {
      await fixture.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await fixture.pool.query(`DROP ROLE ${role}`);
    }
  });

  it('rejects column-level UPDATE grants on a PostgreSQL source object', async () => {
    const suffix=randomUUID().replaceAll('-','').slice(0,20);
    const schema=`m1_probe_${suffix}`;
    const role=`m1_reader_${suffix}`;
    await fixture.pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await fixture.pool.query(`CREATE SCHEMA ${schema}`);
    await fixture.pool.query(`CREATE TABLE ${schema}.customer_data(customer_id text,source_version bigint,deleted_at timestamptz)`);
    await fixture.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await fixture.pool.query(`GRANT SELECT ON ${schema}.customer_data TO ${role}`);
    await fixture.pool.query(`GRANT INSERT(customer_id) ON ${schema}.customer_data TO ${role}`);
    await fixture.pool.query(`GRANT UPDATE(source_version) ON ${schema}.customer_data TO ${role}`);
    try {
      const result=await createBoundedCapabilityProbe({environmentKind:'local_lab'}).run({
        config:{name:'fixture',connector:'postgresql',mode:'FULL_SNAPSHOT',version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'fixture',
          secret_ref:'vault:/fixture/postgres',allowed_entities:['customer'],delete_contract:'tombstone'},
        endpoint:{revision:'fixture-v1',connector:'postgresql',protocol:'postgres:',host:'127.0.0.1',port:fixture.hostPort,
          allow_loopback_plaintext:true,database:'postgres',user:role,schema,entities:{customer:{table:'customer_data',version_field:'source_version',delete_field:'deleted_at'}}},
        secret:'fixture-secret',mappings:[{entity:'customer',source_field:'customer_id',target_field:'customer_name',transform:'identity'}],identityMappings:[],
      });
      expect(result).toMatchObject({passed:false,checks:expect.arrayContaining(['READ_ONLY_PERMISSION_INVALID'])});
    } finally {
      await fixture.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await fixture.pool.query(`DROP ROLE ${role}`);
    }
  });

  it('keeps SQL Server unavailable for TESTED even when a deployment profile exists', async () => {
    const owner=await prepareOwner();
    const {service}=managerService();
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config:{name:'CRM',connector:'sqlserver',
      mode:'FULL_SNAPSHOT',version_domain:'SNAPSHOT_OBSERVATION',endpoint_allowlist_ref:'sql-prod',secret_ref:'vault:/crm/credential-v1',
      allowed_entities:['customer'],delete_contract:'tombstone'}});
    await service.writeMappings(owner,'crm-new','1',customerMappings());
    const tested=await service.test(owner,'crm-new','1');
    expect(tested).toMatchObject({status:'FAIL',report:{code:'SOURCE_PROBE_UNAVAILABLE'}});
    await expect(service.get(owner,'crm-new')).resolves.toMatchObject({lifecycle:'DRAFT'});
  });

  it('does not establish TESTED when an allowed entity has no field mappings', async () => {
    const owner=await prepareOwner();
    const {service}=managerService();
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config:{name:'CRM',connector:'rest',mode:'INCREMENTAL',
      version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'}});
    const tested=await service.test(owner,'crm-new','1');
    expect(tested).toMatchObject({status:'FAIL',report:{checks:expect.arrayContaining(['MAPPING_REQUIRED:customer:customer_name'])}});
    await expect(service.get(owner,'crm-new')).resolves.toMatchObject({lifecycle:'DRAFT'});
  });

  it('rejects unknown standard targets and missing required customer fields', async () => {
    const owner=await prepareOwner();
    const {service}=managerService();
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config:{name:'CRM',connector:'rest',mode:'INCREMENTAL',
      version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'}});
    const mapping=await service.writeMappings(owner,'crm-new','1',[
      {entity:'customer',source_field:'customer_id',target_field:'unknown_field',transform:'identity'},
    ]);
    await expect(service.validateMappings(owner,'crm-new',mapping.revision)).resolves.toMatchObject({valid:false,
      errors:expect.arrayContaining(['MAPPING_TARGET_UNSUPPORTED:customer:unknown_field','MAPPING_REQUIRED:customer:customer_name'])});
  });

  it('invalidates applicability when the deployment endpoint profile changes', async () => {
    const owner=await prepareOwner();
    let profile={revision:'fixture-v1',connector:'rest' as const,host:'crm.fixture.invalid',port:443,protocol:'https:' as const,
      path:'/capability',schema_version:'customer-v1',source_identity:'fixture-crm',
      entities:{customer:{version_field:'source_version',delete_field:'deleted_at'}}};
    const endpointAllowlist:EndpointAllowlist={resolve:async()=>profile};
    const secretResolver:SecretResolver={isConfiguredReference:reference=>reference==='vault:/crm/credential-v1',resolve:async()=> 'fixture-secret'};
    const capabilityProbe:CapabilityProbe={run:async()=>({passed:true,checks:['ENDPOINT_REACHABLE']})};
    const service=createSourceRegistryService({pool:fixture.pool,auth,secretResolver,endpointAllowlist,capabilityProbe,environmentKind:'site'});
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config:{name:'CRM',connector:'rest',mode:'INCREMENTAL',
      version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'}});
    await service.writeMappings(owner,'crm-new','1',customerMappings());
    profile={...profile,revision:'fixture-v2',path:'/changed-capability'};
    await expect(service.test(owner,'crm-new','1')).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    await expect(service.get(owner,'crm-new')).resolves.toMatchObject({lifecycle:'DRAFT',revision:'1'});
    const reports=await fixture.pool.query('SELECT id FROM control.source_test_report WHERE source_id=$1',['crm-new']);
    expect(reports.rowCount).toBe(0);
  });

  it('rejects activation when the deployment endpoint profile changes after approval', async () => {
    const owner=await prepareOwner();
    let profile={revision:'fixture-v1',connector:'rest' as const,host:'crm.fixture.invalid',port:443,protocol:'https:' as const,
      path:'/capability',schema_version:'customer-v1',source_identity:'fixture-crm',
      entities:{customer:{version_field:'source_version',delete_field:'deleted_at'}}};
    const endpointAllowlist:EndpointAllowlist={resolve:async()=>profile};
    const secretResolver:SecretResolver={isConfiguredReference:reference=>reference==='vault:/crm/credential-v1',resolve:async()=> 'fixture-secret'};
    const service=createSourceRegistryService({pool:fixture.pool,auth,secretResolver,endpointAllowlist,
      capabilityProbe:{run:async()=>({passed:true,checks:['PROFILE_VALID']})},environmentKind:'site'});
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config:{name:'CRM',connector:'rest',mode:'INCREMENTAL',
      version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'}});
    await service.writeMappings(owner,'crm-new','1',customerMappings());
    const tested=await service.test(owner,'crm-new','1');
    const approval=await service.approve(owner,'crm-new','1',tested.test_report_id,tested.data_contract_ref);
    profile={...profile,revision:'fixture-v2',path:'/changed'};
    await expect(service.activate(owner,'crm-new','1',approval.approval_id)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  });

  it('rejects a capability result if mappings change while the bounded probe runs', async () => {
    const owner=await prepareOwner();
    const secretResolver:SecretResolver={isConfiguredReference:reference=>reference==='vault:/crm/credential-v1',
      resolve:async()=> 'fixture-secret'};
    const endpointAllowlist:EndpointAllowlist={resolve:async()=>({revision:'fixture-v1',connector:'rest',host:'crm.fixture.invalid',port:443,
      protocol:'https:',path:'/capability',schema_version:'customer-v1',source_identity:'fixture-crm',entities:{customer:{version_field:'source_version',delete_field:'deleted_at'}}})};
    let service!:SourceRegistryService;
    const capabilityProbe:CapabilityProbe={run:async()=>{
      await service.writeMappings(owner,'crm-new','2',customerMappings('name'));
      return {passed:true,checks:['ENDPOINT_REACHABLE','SOURCE_IDENTITY_VALID','READ_ONLY','MAPPING_VALID','VERSION_DELETE_CONTRACT_VALID']};
    }};
    service=createSourceRegistryService({pool:fixture.pool,auth,secretResolver,endpointAllowlist,capabilityProbe,environmentKind:'site'});
    await service.create(owner,{source_id:'crm-new',data_owner_user_id:owner.userId,config:{name:'CRM',connector:'rest',mode:'INCREMENTAL',
      version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'crm-prod',secret_ref:'vault:/crm/credential-v1',allowed_entities:['customer'],delete_contract:'tombstone'}});
    await service.writeMappings(owner,'crm-new','1',customerMappings());
    await expect(service.test(owner,'crm-new','1')).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    await expect(service.get(owner,'crm-new')).resolves.toMatchObject({revision:'1',mapping_revision:'3',lifecycle:'DRAFT'});
  });
});

let credentialToken = '';
async function activeSource(): Promise<string> {
  await auth.repository.provisionTenant({ tenantId: 'm1_tenant', businessTimezone: 'UTC' });
  await auth.repository.provisionSubject({ tenantId: 'm1_tenant', userId: 'owner', managementScopes: ['source:write','source:approve','mapping:write'] });
  const credential = createCredential();
  credentialToken = credential.secret;
  await auth.repository.provisionSourceCredential({ sourceId: 'crm-main', tenantId: 'm1_tenant', token: credentialToken,
    secretRef: 'vault://approved/m1', allowedEntities: ['customer'], revision: '1' });
  const digest = createHash('sha256').update('{}').digest();
  await fixture.pool.query(
    `INSERT INTO control.source_registry(tenant_key,source_id,lifecycle,current_config_revision,data_owner_user_id)
     VALUES('m1_tenant','crm-main','ACTIVE',1,'owner')`,
  );
  await fixture.pool.query(
    `INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
     VALUES('m1_tenant','crm-main',1,$1,$2,'owner')`, [digest,JSON.stringify({name:'CRM',connector:'rest',mode:'INCREMENTAL',
       version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'crm-prod',secret_ref:'vault://approved/m1',allowed_entities:['customer'],delete_contract:'tombstone'})],
  );
  await fixture.pool.query(
    `INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
     VALUES('m1_tenant','crm-main',1,$1,'{}','owner')`, [digest],
  );
  await fixture.pool.query(
    `INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
     VALUES('m1_tenant','crm-main',1,$1,'{}','owner')`, [digest],
  );
  await fixture.pool.query(
    `INSERT INTO control.source_channel(tenant_key,source_id,entity,connector,mode,version_domain,channel_epoch,state)
     VALUES('m1_tenant','crm-main','customer','rest','INCREMENTAL','SOURCE_VERSION',1,'active')`,
  );
  return credentialToken;
}

async function prepareOwner() {
  const tenantId='m1_tenant';
  await auth.repository.provisionTenant({tenantId,businessTimezone:'UTC'});
  await auth.repository.provisionSubject({tenantId,userId:'owner',managementScopes:['source:read','source:write','source:approve','mapping:write']});
  await auth.repository.bindIdentity({issuer:'https://idp.example.test',subject:'owner',tenantId,userId:'owner'});
  await auth.repository.provisionSubject({tenantId,userId:'new-owner',managementScopes:['source:read','source:write','source:approve','mapping:write']});
  await auth.repository.bindIdentity({issuer:'https://idp.example.test',subject:'new-owner',tenantId,userId:'new-owner'});
  const credential=createCredential(); credentialToken=credential.secret;
  await auth.repository.provisionSourceCredential({sourceId:'crm-new',tenantId,token:credentialToken,secretRef:'vault:/crm/credential-v1',allowedEntities:['customer'],revision:'0'});
  return auth.resolveOidc('https://idp.example.test','owner');
}

function managerService(pool: typeof fixture.pool = fixture.pool) {
  const seenSecrets:string[]=[];
  const secretResolver:SecretResolver={isConfiguredReference:reference=>reference==='vault:/crm/credential-v1',resolve:async reference=>{
    if(reference!=='vault:/crm/credential-v1') throw new Error('unconfigured');
    seenSecrets.push('fixture-secret'); return 'fixture-secret';
  }};
  const endpointAllowlist:EndpointAllowlist={resolve:async reference=>{
    if(reference==='crm-prod') return {revision:'fixture-v1',connector:'rest',host:'127.0.0.1',port:capabilityPort,protocol:'http:',allow_loopback_http:true,path:'/',
      schema_version:'customer-v1',source_identity:'fixture-crm',entities:{customer:{version_field:'source_version',delete_field:'deleted_at'}}};
    if(reference==='pg-prod') return {revision:'fixture-pg-v1',connector:'postgresql',host:'db.fixture.invalid',port:5432,protocol:'postgres:',
      database:'source',user:'source_reader',schema:'public',entities:{customer:{table:'customers',version_field:'source_version',delete_field:'deleted_at'}}};
    if(reference==='sql-prod') return {revision:'fixture-sql-v1',connector:'sqlserver',host:'sql.fixture.invalid',port:1433,protocol:'mssql:',entities:{}};
    throw new Error('unapproved');
  }};
  const capabilityProbe=createBoundedCapabilityProbe({environmentKind:'local_lab'});
  return {service:createSourceRegistryService({pool,auth,secretResolver,endpointAllowlist,capabilityProbe,environmentKind:'local_lab'}),seenSecrets,
    secretResolver,endpointAllowlist,capabilityProbe};
}

function customerMappings(firstSourceField='customer_name') {
  return [
    {entity:'customer' as const,source_field:firstSourceField,target_field:'customer_name',transform:'trim' as const},
    {entity:'customer' as const,source_field:'owner_user_id',target_field:'owner_user_id',transform:'source-id' as const},
    {entity:'customer' as const,source_field:'dept_id',target_field:'dept_id',transform:'source-id' as const},
    {entity:'customer' as const,source_field:'status',target_field:'status',transform:'identity' as const},
  ];
}

function roleScopedPool() {
  const target=fixture.pool;
  return new Proxy(target,{get(targetObject,property){
    if(property==='connect') return async()=>{
    const client=await target.connect();
    await client.query('SET ROLE hub_api');
    const release=client.release.bind(client);
    client.release=((error?: Error | boolean)=>{
      void client.query('RESET ROLE').then(()=>release(error),()=>release(error));
    }) as typeof client.release;
    return client;
    };
    const value=Reflect.get(targetObject,property,targetObject);
    return typeof value==='function'?value.bind(targetObject):value;
  }}) as unknown as typeof fixture.pool;
}
