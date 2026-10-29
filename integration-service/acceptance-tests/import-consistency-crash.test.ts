import { afterAll, beforeAll, expect, it } from 'vitest';
import { copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import pg from 'pg';
import { runMigrations } from '../migrations/runner.js';
import { runDurableWorkerOnce } from '../etl-worker/worker.js';
import { setupImportRecoveryFixture, setupOrderRecoveryFixture, source, tenant } from './helpers/import-recovery-fixture.js';

let ctx: Awaited<ReturnType<typeof setupImportRecoveryFixture>>;
let order: Awaited<ReturnType<typeof setupOrderRecoveryFixture>>;
let worker: pg.Pool;
let base: string;
const time='2026-10-29T00:00:00Z';
const lines=[{source_line_id:'a',product_code:'p1',product_name:'first',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'},{source_line_id:'b',product_code:'p2',product_name:'second',quantity:'2.000000',unit_price:'6.000000',line_amount:'12.00'}];
function record(pk:string, version='1', number='B1') {return {event_id:randomUUID(),source_pk:pk,source_version:version,operation:'UPSERT',source_updated_at:time,data:{buyer:{source_id:source,source_pk:'sample-ref-i3c'},number,state:'CONFIRMED',at:time,total:'24.00',ccy:'CNY',lines}};}
function body(records:unknown[]) {return JSON.stringify({schema_version:'hub.v1',batch_id:randomUUID(),records});}
async function submit(raw:string) { const response=await fetch(`${base}/hub/v1/admin/sources/${order.src}/import/order`,{method:'POST',headers:{authorization:`Bearer ${ctx.token}`,'content-type':'application/json','idempotency-key':randomUUID()},body:raw}); expect(response.status).toBe(202); return (await response.json() as any).data.job_id as string; }
async function state(id:string) {return (await ctx.fixture.pool.query(`SELECT i.status,i.error_code,i.attempts_started,i.next_retry_at,j.status job_status,j.applied_count,o.claim_token::text,o.lease_expires_at,o.acknowledged_at FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id JOIN control.ingestion_processing_outbox o ON o.job_id=j.id WHERE j.id=$1`,[id])).rows[0];}
async function run() {await runDurableWorkerOnce(worker,{limit:1,leaseMs:1000});}
async function waitDue(id:string) {for(let n=0;n<100;n++){const row=(await ctx.fixture.pool.query(`SELECT (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) AND available_at<=clock_timestamp() AND (i.next_retry_at IS NULL OR i.next_retry_at<=clock_timestamp()) due FROM control.ingestion_processing_outbox o JOIN control.ingestion_job_item i ON i.job_id=o.job_id WHERE o.job_id=$1`,[id])).rows[0];if(row.due)return;await new Promise(r=>setTimeout(r,100));}throw new Error('RETRY_NOT_DUE');}
async function boundary(phase:'beforeItemCommit'|'afterItemCommit', id:string) {
 const child=spawn(process.execPath,[fileURLToPath(new URL('./import-crash-driver.mjs',import.meta.url)),phase],{env:{...process.env,I3C_CONNECTION:`postgres://postgres@127.0.0.1:${ctx.fixture.hostPort}/postgres`},stdio:['ignore','pipe','pipe']});
 let output='', errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);
 try {await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(`boundary timeout: ${output} ${errors}`)),15000);child.stdout.on('data',()=>{if(output.includes('"event":"ready"')){clearTimeout(timeout);resolve();}});child.once('exit',()=>{clearTimeout(timeout);reject(new Error(`child exited: ${output} ${errors}`));});});
  const events=output.trim().split('\n').map(line=>JSON.parse(line));expect(events[0]).toMatchObject({event:'loaded',pid:child.pid,phase});expect(events[0].worker_sha256).toMatch(/^[0-9a-f]{64}$/);expect(events[1]).toMatchObject({event:'ready',pid:child.pid,phase,item:{jobId:id,ordinal:0}});console.log('I3C_CHILD',JSON.stringify(events));
  return {child,output,kill:async()=>{const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));child.kill();console.log('I3C_KILL',child.pid,await closed);for(let n=0;n<50;n++){const sessions=await ctx.fixture.pool.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1',[`i3c-child-${child.pid}`]);if(!sessions.rowCount)return;await new Promise(r=>setTimeout(r,100));}throw new Error('CHILD_SESSION_STILL_OPEN');}};
 } catch(e) {child.kill();throw e;}
}
beforeAll(async()=>{
 ctx=await setupImportRecoveryFixture('candidate');
 const migrations=fileURLToPath(new URL('../migrations/',import.meta.url));
 for(const name of await readdir(migrations)) if(/^0(15|16|17|18|19)_.+\.sql$/.test(name)) await copyFile(join(migrations,name),join(ctx.migrationDirectory,name));
 await runMigrations(ctx.fixture.pool,{directory:ctx.migrationDirectory,environmentKind:'local_lab'});
 order=await setupOrderRecoveryFixture(ctx,'i3c','missing-i3c');
 worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${ctx.fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
 base=await ctx.app.listen({host:'127.0.0.1',port:0});
},120000);
afterAll(async()=>{if(worker)await worker.end();if(ctx?.app)await ctx.app.close();if(ctx?.jwks)await new Promise<void>(r=>ctx.jwks.close(()=>r()));if(ctx?.fixture)await ctx.fixture.close();},30000);

it('admits a complete request over HTTP and reaches a real pre-commit child boundary',async()=>{
 const raw=body([record('control')]);const id=await submit(raw);const frozen=(await ctx.fixture.pool.query(`SELECT b.body_bytes,encode(j.request_digest,'hex') digest FROM control.ingestion_job j JOIN raw.ingestion_batch b ON b.id=j.raw_batch_id WHERE j.id=$1`,[id])).rows[0];expect(frozen.body_bytes.toString()).toBe(raw);const c=await boundary('beforeItemCommit',id);
 const s=await state(id);expect(s.status).toBe('APPLYING');expect(s.attempts_started).toBe(1);expect(s.acknowledged_at).toBeNull();expect(s.claim_token).not.toBeNull();expect(await aggregate('control')).toEqual({identity:null,receipt:null,header:null,lines:[],outbox:[]});
 await c.kill();expect(await aggregate('control')).toEqual({identity:null,receipt:null,header:null,lines:[],outbox:[]});const rolled=await state(id);expect(rolled.status).toBe('APPLYING');expect(rolled.attempts_started).toBe(1);expect(rolled.claim_token).toBe(s.claim_token);expect(rolled.acknowledged_at).toBeNull();await waitDue(id);await run();const final=await state(id);expect(final.status).toBe('APPLIED');expect(final.attempts_started).toBe(2);expect(final.acknowledged_at).not.toBeNull();const applied=await aggregate('control');assertLive(applied,'1','B1');expect(applied.outbox).toHaveLength(1);expect((await ctx.fixture.pool.query(`SELECT b.body_bytes,encode(j.request_digest,'hex') digest FROM control.ingestion_job j JOIN raw.ingestion_batch b ON b.id=j.raw_batch_id WHERE j.id=$1`,[id])).rows[0]).toEqual(frozen);
},30000);

async function aggregate(pk:string) {
 const identity=(await ctx.fixture.pool.query(`SELECT canonical_object_id::text id,order_id::text FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$2 AND entity='order' AND source_pk=$3`,[tenant,order.src,pk])).rows[0] ?? null;
 const receipt=(await ctx.fixture.pool.query(`SELECT canonical_object_id::text id,source_version::text,deleted,encode(source_content_digest,'hex') digest,encode(projection_digest,'hex') projection FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$2 AND entity='order' AND source_pk=$3`,[tenant,order.src,pk])).rows[0] ?? null;
 const header=identity ? (await ctx.fixture.pool.query(`SELECT id::text,customer_id::text,order_no,status,to_char(order_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') order_at,amount::text,currency,source_version::text,deleted_at IS NOT NULL deleted FROM hub.canonical_order WHERE tenant_id=$1 AND id=$2`,[tenant,identity.id])).rows[0] ?? null : null;
 const lineRows=identity ? (await ctx.fixture.pool.query(`SELECT source_line_id,product_code,product_name,quantity::text,unit_price::text,line_amount::text,source_version::text,deleted_at IS NOT NULL deleted FROM hub.canonical_order_line WHERE tenant_id=$1 AND order_id=$2 ORDER BY source_line_id`,[tenant,identity.id])).rows : [];
 const outbox=identity ? (await ctx.fixture.pool.query(`SELECT operation,canonical_object_id::text id,hub_revision::text,encode(source_content_digest,'hex') digest,encode(projection_digest,'hex') projection FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2 AND entity='order' AND canonical_object_id=$3 ORDER BY id`,[tenant,order.src,identity.id])).rows : [];
 return {identity,receipt,header,lines:lineRows,outbox};
}
function assertLive(a:Awaited<ReturnType<typeof aggregate>>,version:string,number:string) {
 expect(a.identity.id).toMatch(/^[0-9a-f-]{36}$/);expect(a.identity.order_id).toBe(a.identity.id);
 expect(a.header).toEqual({id:a.identity.id,customer_id:order.ids[0],order_no:number,status:'CONFIRMED',order_at:'2026-10-29T00:00:00.000000Z',amount:'24.00',currency:'CNY',source_version:version,deleted:false});
 expect(a.lines).toEqual([{source_line_id:'a',product_code:'p1',product_name:'first',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00',source_version:version,deleted:false},{source_line_id:'b',product_code:'p2',product_name:'second',quantity:'2.000000',unit_price:'6.000000',line_amount:'12.00',source_version:version,deleted:false}]);
 expect(a.receipt).toMatchObject({id:a.identity.id,source_version:version,deleted:false});expect(a.receipt.digest).toMatch(/^[0-9a-f]{64}$/);expect(a.outbox.at(-1)).toMatchObject({id:a.identity.id,operation:'UPSERT',digest:a.receipt.digest,projection:a.receipt.projection});
}
async function outcome(raw:string,expected:string,error:null|string=null) {const id=await submit(raw);await run();const s=await state(id);expect({status:s.status,error:s.error_code}).toEqual({status:expected,error});expect(s.acknowledged_at).not.toBeNull();expect(s.job_status).toMatch(/^(SUCCEEDED|COMPLETED|PARTIAL|FAILED)$/);return id;}
function del(pk:string,version:string) {return {event_id:randomUUID(),source_pk:pk,source_version:version,operation:'DELETE',source_updated_at:time,data:null};}

it('enforces source versions, preserves omitted aggregates and applies explicit order tombstones',async()=>{
 const a=record('version-a','2','A2'),b=record('version-b','2','B2');const first=await submit(body([a,b]));await run();
 expect((await ctx.fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1 ORDER BY ordinal',[first])).rows).toEqual([{status:'APPLIED'},{status:'APPLIED'}]);
 const initial=await aggregate('version-a'), omitted=await aggregate('version-b');assertLive(initial,'2','A2');assertLive(omitted,'2','B2');
 await outcome(body([record('version-a','1','STALE')]),'IGNORED_STALE');expect(await aggregate('version-a')).toEqual(initial);expect(await aggregate('version-b')).toEqual(omitted);
 await outcome(body([{...a,event_id:randomUUID()}]),'DUPLICATE');expect(await aggregate('version-a')).toEqual(initial);
 await outcome(body([record('version-a','2','CONFLICT')]),'QUARANTINED','SOURCE_VERSION_CONFLICT');expect(await aggregate('version-a')).toEqual(initial);
 await outcome(body([record('version-a','3','A3')]),'APPLIED');const updated=await aggregate('version-a');assertLive(updated,'3','A3');expect(updated.identity.id).toBe(initial.identity.id);expect(updated.outbox).toHaveLength(2);expect(await aggregate('version-b')).toEqual(omitted);
 const replacement=record('version-a','4','A4');replacement.data.lines=[{source_line_id:'a',product_code:'p1x',product_name:'changed',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'},{source_line_id:'c',product_code:'p3',product_name:'new',quantity:'2.000000',unit_price:'6.000000',line_amount:'12.00'}];await outcome(body([replacement]),'APPLIED');const replaced=await aggregate('version-a');expect(replaced.header).toMatchObject({id:initial.identity.id,customer_id:order.ids[0],order_no:'A4',amount:'24.00',source_version:'4',deleted:false});expect(replaced.lines).toEqual([{source_line_id:'a',product_code:'p1x',product_name:'changed',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00',source_version:'4',deleted:false},{source_line_id:'b',product_code:'p2',product_name:'second',quantity:'2.000000',unit_price:'6.000000',line_amount:'12.00',source_version:'4',deleted:true},{source_line_id:'c',product_code:'p3',product_name:'new',quantity:'2.000000',unit_price:'6.000000',line_amount:'12.00',source_version:'4',deleted:false}]);expect(replaced.receipt).toMatchObject({id:initial.identity.id,source_version:'4',deleted:false});expect(replaced.outbox).toHaveLength(3);expect(await aggregate('version-b')).toEqual(omitted);
 await outcome(body([del('version-a','5')]),'APPLIED');const deleted=await aggregate('version-a');expect(deleted.identity.id).toBe(initial.identity.id);expect(deleted.header.deleted).toBe(true);expect(deleted.lines.map(x=>x.deleted)).toEqual([true,true,true]);expect(deleted.receipt).toMatchObject({id:initial.identity.id,source_version:'5',deleted:true});expect(deleted.outbox).toHaveLength(4);expect(deleted.outbox.at(-1).operation).toBe('DELETE');
 await outcome(body([record('version-a','3','OLD')]),'IGNORED_STALE');expect(await aggregate('version-a')).toEqual(deleted);
 await outcome(body([del('never-seen','5')]),'APPLIED');const reserved=await aggregate('never-seen');expect(reserved.identity.order_id).toBeNull();expect(reserved.header).toBeNull();expect(reserved.lines).toEqual([]);expect(reserved.receipt).toMatchObject({id:reserved.identity.id,source_version:'5',deleted:true});
 await outcome(body([record('never-seen','4')]),'IGNORED_STALE');expect(await aggregate('never-seen')).toEqual(reserved);
 await outcome(body([record('never-seen','5')]),'QUARANTINED','SOURCE_VERSION_CONFLICT');expect(await aggregate('never-seen')).toEqual(reserved);
 await outcome(body([record('never-seen','6','RESTORED')]),'APPLIED');const restored=await aggregate('never-seen');assertLive(restored,'6','RESTORED');expect(restored.identity.id).toBe(reserved.identity.id);expect(await aggregate('version-b')).toEqual(omitted);
},60000);

it('leaves durable facts and all aggregates unchanged after a truncated HTTP body',async()=>{
 const tables=['raw.ingestion_batch','control.ingestion_job','control.ingestion_job_item','control.ingestion_processing_outbox','control.ingestion_management_admission_audit','control.source_version_receipt','control.canonical_apply_outbox','control.canonical_source_identity','hub.canonical_order','hub.canonical_order_line','hub.canonical_customer'];
 const snapshot=async()=>Promise.all(tables.map(async table=>(await ctx.fixture.pool.query(`SELECT count(*)::text count,md5(coalesce(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text),'')) digest FROM ${table} t`)).rows[0]));
 const before=await snapshot();const address=new URL(base);const server=ctx.app.server;
 const aborted=new Promise<void>(resolve=>server.once('request',(req)=>{req.once('aborted',()=>resolve());}));
 await new Promise<void>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:Number(address.port),path:`/hub/v1/admin/sources/${order.src}/import/order`,method:'POST',headers:{authorization:`Bearer ${ctx.token}`,'content-type':'application/json','idempotency-key':randomUUID(),'content-length':'1000'}});req.on('error',()=>resolve());req.on('socket',socket=>socket.once('connect',()=>{req.write('{"schema_version":"hub.v1",');setTimeout(()=>req.destroy(),50);}));setTimeout(()=>reject(new Error('SOCKET_CLOSE_TIMEOUT')),5000).unref();});
 await Promise.race([aborted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('SERVER_ABORT_TIMEOUT')),5000))]);expect(await snapshot()).toEqual(before);
},15000);

it('reclaims a post-commit process death without a second business effect',async()=>{
 const raw=body([record('post-crash','1','POST')]);const id=await submit(raw);const frozen=(await ctx.fixture.pool.query(`SELECT b.body_bytes,encode(j.request_digest,'hex') digest FROM control.ingestion_job j JOIN raw.ingestion_batch b ON b.id=j.raw_batch_id WHERE j.id=$1`,[id])).rows[0];expect(frozen.body_bytes.toString()).toBe(raw);
 const c=await boundary('afterItemCommit',id);const committed=await aggregate('post-crash');assertLive(committed,'1','POST');expect(committed.outbox).toHaveLength(1);const s=await state(id);expect(s.status).toBe('APPLIED');expect(s.applied_count).toBe(1);expect(s.acknowledged_at).toBeNull();expect(s.claim_token).not.toBeNull();
 await c.kill();await waitDue(id);await run();const end=await state(id);expect(end.status).toBe('APPLIED');expect(end.acknowledged_at).not.toBeNull();expect(end.attempts_started).toBe(1);expect(await aggregate('post-crash')).toEqual(committed);expect((await ctx.fixture.pool.query(`SELECT b.body_bytes,encode(j.request_digest,'hex') digest FROM control.ingestion_job j JOIN raw.ingestion_batch b ON b.id=j.raw_batch_id WHERE j.id=$1`,[id])).rows[0]).toEqual(frozen);
},30000);

it('reserves a customer identity for a first tombstone and restores it only at a higher version',async()=>{
 const submitCustomer=async(rec:unknown,status:string,error:string|null=null)=>{const response=await fetch(`${base}/hub/v1/admin/sources/${source}/import/customer`,{method:'POST',headers:{authorization:`Bearer ${ctx.token}`,'content-type':'application/json','idempotency-key':randomUUID()},body:body([rec])});expect(response.status).toBe(202);const id=(await response.json() as any).data.job_id;await run();const s=await state(id);expect({status:s.status,error:s.error_code}).toEqual({status,error});expect(s.acknowledged_at).not.toBeNull();};
 const customer=(version:string)=>({event_id:randomUUID(),source_pk:'new-customer',source_version:version,operation:'UPSERT',source_updated_at:time,data:{display:'Restored',rep:'rep-a',team:'team-a',state:'ACTIVE'}});
 const snapshot=async()=>{const identity=(await ctx.fixture.pool.query(`SELECT canonical_object_id::text id,customer_id::text FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$2 AND entity='customer' AND source_pk='new-customer'`,[tenant,source])).rows[0];const receipt=(await ctx.fixture.pool.query(`SELECT canonical_object_id::text id,source_version::text,deleted FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$2 AND entity='customer' AND source_pk='new-customer'`,[tenant,source])).rows[0];const core=(await ctx.fixture.pool.query(`SELECT id::text,customer_name,owner_user_id,dept_id,status,source_version::text,deleted_at IS NOT NULL deleted FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2`,[tenant,identity.id])).rows[0]??null;const outbox=(await ctx.fixture.pool.query(`SELECT operation,canonical_object_id::text id FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2 AND entity='customer' AND canonical_object_id=$3 ORDER BY id`,[tenant,source,identity.id])).rows;return {identity,receipt,core,outbox};};
 await submitCustomer(del('new-customer','5'),'APPLIED');const tomb=await snapshot();expect(tomb.identity.customer_id).toBeNull();expect(tomb.receipt).toEqual({id:tomb.identity.id,source_version:'5',deleted:true});expect(tomb.core).toBeNull();
 await submitCustomer(customer('4'),'IGNORED_STALE');expect(await snapshot()).toEqual(tomb);
 await submitCustomer(customer('5'),'QUARANTINED','SOURCE_VERSION_CONFLICT');expect(await snapshot()).toEqual(tomb);
 await submitCustomer(customer('6'),'APPLIED');const restored=await snapshot();expect(restored.identity).toEqual({id:tomb.identity.id,customer_id:tomb.identity.id});expect(restored.receipt).toEqual({id:tomb.identity.id,source_version:'6',deleted:false});expect(restored.core).toEqual({id:tomb.identity.id,customer_name:'Restored',owner_user_id:'owner',dept_id:'dept1',status:'ACTIVE',source_version:'6',deleted:false});expect(restored.outbox.at(-1)).toEqual({id:tomb.identity.id,operation:'UPSERT'});expect(restored.outbox.length).toBe(tomb.outbox.length+1);
},30000);
