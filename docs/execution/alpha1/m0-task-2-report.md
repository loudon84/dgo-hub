# M0 Task2 — implementation report

Status: `DONE_WITH_CONCERNS` — local implementation and verification are complete; independent GPT-6.1 Sol spec/quality review is pending. No enterprise IdP configuration was available, so this report does not claim site SSO or remote Hermes acceptance.

## Provenance

- Repository: `E:/git/dgo-hub`, branch `feat/alpha1-implementation`.
- Exact Task2 base: `04fe627b9b387983395a9aaacd3793e4e37e207b`.
- Product implementation commit: `9240dd1886a91925d158b42a5dd2a07f59fda8e2` (`Implement controlled OIDC identity APIs`).
- Report/evidence handoff closure is committed separately from product source; this final docs/evidence commit is the HEAD supplied for independent review.
- Task2 source and migration001 SHA-256 manifests: `docs/execution/alpha1/m0-task-2-evidence/source-final.sha256.json` and `migration-001-final.sha256.json`.
- Migration001 SHA-256 remains `600491b647d88dd2f282a425afe1005e7fe2c4c87a67b30570de52408a7f2251`.

## Implementation

- `integration-service/auth/oidc.ts` exports `OidcConfiguration`, `OidcAuthenticator`, `OidcConfigurationError`, `readOidcConfiguration(environment?)`, and `createOidcAuthenticator(controlledConfig, authService)`.
- `integration-service/ingestion-api/identity-routes.ts` exports `IdentityRouteOptions` and `registerIdentityRoutes(app, options)` for API001/046/047/048.
- `integration-service/ingestion-api/logging.ts` exports the Fastify logger options used by the app, redacting Authorization, Cookie, and x-source-key headers. Fastify request IDs ignore client-supplied `request-id`; response `request_id` is a fresh server UUID. Request and response bodies are not logged.
- `integration-service/app.ts` exports `buildApp(options?)` and `startApp()`. Importing the module does not read runtime OIDC settings, import the database pool, or listen. Explicit execution validates OIDC settings before constructing the database-backed service or starting the listener.
- `registerRoutes(app, { identity? })` and `buildApp({ identity? })` provide the narrow route registration seam for later Task3 strict/lab wiring. Existing legacy route behavior was not changed in this task.
- The owned PostgreSQL fixture label type now accepts `task2`; no fixture credentials, database URL, or service configuration was read from the ambient environment by this test.

## Controlled OIDC contract

```ts
type OidcEnvironmentKind = 'local_lab' | 'site';
type OidcConfiguration = Readonly<{
  issuer: string;
  audience: string;
  jwksUrl: string;
  environmentKind: OidcEnvironmentKind;
  allowLoopbackHttp?: boolean;
}>;
type OidcAuthenticator = (token: string) => Promise<UserPrincipal>;

readOidcConfiguration(environment?: NodeJS.ProcessEnv): OidcConfiguration;
createOidcAuthenticator(
  controlledConfig: OidcConfiguration,
  authService: Pick<AuthService, 'resolveOidc'>,
): OidcAuthenticator;
```

The runtime names are `HUB_ENVIRONMENT_KIND` (default `site`), `HUB_AUTH_ISSUER`, `HUB_AUTH_AUDIENCE`, `HUB_AUTH_JWKS_URL`, and `HUB_AUTH_ALLOW_LOOPBACK_HTTP` (default `false`). Missing or invalid values throw only `AUTH_CONFIG_INVALID`; values are not echoed. Both issuer and JWKS URL must use HTTPS for `site`. HTTP is accepted only for a loopback URL in explicit `local_lab` with `HUB_AUTH_ALLOW_LOOPBACK_HTTP=true`; remote HTTP, unknown environment kinds, and site loopback exceptions fail closed. Programmatic callers can pass the typed config directly without reading process environment.

JWT verification is pinned to `RS256` or `ES256`, configured issuer/audience and configured JWKS URL, with required `exp`, `iss`, `aud`, and `sub` and normal `nbf` verification. The jose `customFetch` hook uses manual redirect handling and rejects every non-200 response, so it does not follow a redirect to another JWKS host. `jku` and `x5u` token headers are rejected before a fetch. JWKS resolver state is per authenticator instance. After verification, only the configured issuer and verified subject are passed to `AuthService.resolveOidc`; tenant, user, department, business-role, and scope claims are ignored. Invalid credentials/claims map to `AUTH_INVALID` (401), an absent mapping to `PRINCIPAL_MAPPING_MISSING` (401), a disabled binding to `AUTH_REVOKED` (401), and fetch/service availability failures to safe `AUTH_UNAVAILABLE` (503).

## HTTP consumer contract

```ts
type IdentityRouteOptions = Readonly<{
  authenticator: OidcAuthenticator;
  authService: Pick<AuthService,
    'createAgentCredential' | 'listAgentCredentials' | 'revokeAgentCredential'>;
}>;

registerIdentityRoutes(app: FastifyInstance, options: IdentityRouteOptions): Promise<void>;
```

The exact persistence service surface is reused from the approved [Task1 consumer appendix](m0-task-1-report.md#consumer-interface-appendix): `resolveOidc(issuer, subject)`, `createAgentCredential(principal, { purpose, ttl_seconds? }, idempotencyKey)`, `listAgentCredentials(principal, { cursor?, limit? })`, and `revokeAgentCredential(principal, credentialId)`. Task2 did not add credential persistence or a new resolver.

All non-204 success responses use `{ request_id, data }`. Failures use `{ request_id, error: { code, message, retryable, details } }`; details are `{}` for these routes. HTTP input errors map internal `AUTH_INPUT_INVALID` 400 to 422. Malformed JSON receives the same safe 422 envelope. Authentication failures are 401, missing capability is 403, idempotency mismatch is 409, safe storage/provider failure is 503, and absent identity route is 404. DELETE always returns empty 204 for well-formed but unknown, cross-user, cross-tenant, unauthorized, or successfully revoked credential IDs according to the Task1 service privacy contract.

| API | Request | Response data |
| --- | --- | --- |
| API001 `GET /hub/v1/me` | Bearer token | Safe whitelist: `user_id`, `tenant_id`, `department_id`, `business_role`, `management_scopes`, `business_timezone`. |
| API046 `POST /hub/v1/me/agent-credentials` | `Idempotency-Key`; body only `purpose` and optional integer `ttl_seconds` | First create: HTTP 201 with safe metadata, `replayed:false`, and the one-time `secret`. Identical replay: HTTP 201 with metadata and `replayed:true`, with no `secret` field. |
| API047 `GET /hub/v1/me/agent-credentials` | Optional `cursor`, `limit` (default 20, max 100) | Own metadata only: `items`, `next_cursor`; no secret, digest, tenant filter, or user filter. |
| API048 `DELETE /hub/v1/me/agent-credentials/{id}` | Credential ID | Empty 204. |

Examples use placeholders and contain no generated credentials:

```json
{"request_id":"<server-uuid>","data":{"user_id":"alice","tenant_id":"t01","department_id":"sales-east","business_role":"sales","management_scopes":[],"business_timezone":"Asia/Shanghai"}}
```

```json
{"request_id":"<server-uuid>","data":{"credential_id":"<uuid>","purpose":"daily summary","created_at":"<timestamp>","expires_at":"<timestamp>","replayed":false,"secret":"<shown only in first response>"}}
```

```json
{"request_id":"<server-uuid>","data":{"credential_id":"<uuid>","purpose":"daily summary","created_at":"<timestamp>","expires_at":"<timestamp>","replayed":true}}
```

```json
{"request_id":"<server-uuid>","error":{"code":"AUTH_INPUT_INVALID","message":"AUTH_INPUT_INVALID","retryable":false,"details":{}}}
```

## Verification

Initial RED: `npm test -- acceptance-tests/identity-http.test.ts` failed because `auth/oidc.ts` did not exist. The focused suite then exposed implementation issues before final green: malformed token errors were incorrectly classified as unavailable; a signature test altered only base64 padding bits; malformed JSON used Fastify’s default response. These were corrected with strict token parsing, a meaningful signature mutation, and a scoped safe error handler. A later focused RED demonstrated that a 2,049-character verified subject reached Task1 as status 400; OIDC now rejects it as invalid before calling the service.

Final focused command `npm test -- acceptance-tests/identity-http.test.ts`: **13/13 passed** using actual local RSA and EC keys, loopback JWKS servers, Fastify injection, and an owned PostgreSQL instance. It covers issuer/audience/signature/kid/exp/nbf/required claims/algorithm failures, forged claim isolation, hostile `jku`/`x5u` zero-fetch, redirect-to-second-loopback-server zero-fetch, unmapped/disabled subjects, invalid-token zero identity lookup, safe envelopes, replay secret omission, strict bodies, pagination/privacy, revoke behavior, management-only reads, malformed JSON, and log/request-id secret checks.

Final complete checks were run after source freeze:

- `npm run typecheck` — exit 0; retained in `m0-task-2-evidence/final-typecheck.log` and `.exit`.
- `npm run build` — exit 0; retained in `m0-task-2-evidence/final-build.log` and `.exit`.
- `npm test` — exit 0; Vitest 4.1.12, **11 files / 168 tests passed**; retained in `m0-task-2-evidence/final-test.log` and `.exit`.

Final Task2 owned PostgreSQL record: task label `task2`, run label `3616bc4f-5270-4e0a-a70a-29838de113c6`, exact container ID `9c07a1dd87fc480584e43fb8a3fd7d6759e075bb8323b78297f9d56023cef8bd`, image `postgres:16.10-alpine`, RepoDigest `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`, runtime image ID `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`. Evidence records both task/run labels, checked ownership, and `containerAbsentAfterRemoval:true`. The full suite also created and removed one task0-labeled and one task1-labeled fresh fixture; their full-run evidence is retained under `m0-task-2-evidence/full-suite-*`. Existing Task1 evidence files were restored byte-for-byte after the full run; comparison hashes matched.

## Limits and handoff

- No real site issuer, audience, JWKS, key rotation, federation policy, or remote Hermes system was available. The test keys and JWKS exist only on loopback; this is local engineering evidence, not site SSO acceptance.
- Cookie sessions, CSRF, MCP transport, and Task3 legacy-route default hardening are outside Task2 and remain unimplemented here.
- `migrations/001_init.sql` is unchanged by Task2 with the baseline SHA-256 above.
- No push, merge, deployment, or remote service/database operation occurred.

