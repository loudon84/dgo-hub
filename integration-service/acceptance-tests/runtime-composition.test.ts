import Fastify from 'fastify';
import pg from 'pg';
import { afterAll, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { AuthError } from '../auth/errors.js';
import { createAuthService } from '../auth/service.js';
import type { OidcAuthenticator } from '../auth/oidc.js';
import { createSourceRegistryService, failClosedCapabilityProbe, failClosedEndpointAllowlist, failClosedSecretResolver } from '../source-registry/service.js';
import { registerIdentityRoutes } from '../ingestion-api/identity-routes.js';
import { registerSourceRegistryRoutes } from '../source-registry/routes.js';
import { registerSnapshotRoutes } from '../ingestion-api/snapshot-routes.js';

// No connection is made: unauthenticated, parsing and routing checks terminate before database access.
const pool=new pg.Pool({connectionString:'postgres://unused@127.0.0.1:1/unused'});
const authService=createAuthService({pool});
const authenticator:OidcAuthenticator=async()=>{throw new AuthError('AUTH_INVALID');};
const sourceService=createSourceRegistryService({pool,auth:authService,secretResolver:failClosedSecretResolver,endpointAllowlist:failClosedEndpointAllowlist,capabilityProbe:failClosedCapabilityProbe});
const identity={authService,authenticator},sourceRegistry={...identity,sourceService},snapshotRuns={pool,authService,authenticator};
afterAll(async()=>{await pool.end();});

it('starts the full configured route composition and returns bounded errors',async()=>{
 const app=await buildApp({logger:false,identity,sourceRegistry,snapshotRuns,strictIngestion:{pool,authService,authenticator,rawStoragePolicy:'local_lab_fixture'}});
 try {
  expect((await app.inject({method:'GET',url:'/health'})).json()).toEqual({ok:true});
  for(const url of ['/hub/v1/me','/hub/v1/admin/sources','/hub/v1/admin/etl-runs','/hub/v1/admin/quarantine/61000000-0000-4000-8000-000000000001/import-recovery']) {
   const response=await app.inject({method:'GET',url});expect(response.statusCode,response.body).toBe(401);expect(response.json().error.code).toBe('AUTH_INVALID');
  }
  const unknown=await app.inject({method:'GET',url:'/hub/v1/unknown'});
  expect(unknown.statusCode).toBe(404);expect(unknown.json()).toMatchObject({request_id:expect.any(String),error:{code:'NOT_FOUND',message:'NOT_FOUND',retryable:false,details:{}}});
  for(const url of ['/hub/v1/me/agent-credentials','/hub/v1/admin/sources','/hub/v1/admin/sources/x/etl-runs']) {
   const response=await app.inject({method:'POST',url,headers:{'content-type':'application/json'},payload:'{broken'});
   expect(response.statusCode).toBeLessThan(500);expect(response.json().error.code).toBe('AUTH_INPUT_INVALID');expect(response.body).not.toContain('SyntaxError');
  }
 } finally {await app.close();}
});

it('preserves each standalone registrar bounded not-found behavior',async()=>{
 for(const register of [
  (app:ReturnType<typeof Fastify>)=>registerIdentityRoutes(app,identity),
  (app:ReturnType<typeof Fastify>)=>registerSourceRegistryRoutes(app,sourceRegistry),
  (app:ReturnType<typeof Fastify>)=>registerSnapshotRoutes(app,snapshotRuns),
 ]) {
  const app=Fastify({logger:false});try {
   await register(app);const response=await app.inject({method:'GET',url:'/unknown'});
   expect(response.statusCode).toBe(404);expect(response.json()).toMatchObject({error:{code:'NOT_FOUND',message:'NOT_FOUND',retryable:false,details:{}}});
  } finally {await app.close();}
 }
});
