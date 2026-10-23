# M0 Task 3 — Strict MCP and source boundary

**Status:** Local implementation and engineering verification complete. Independent GPT-6.1 Sol review is pending at product commit `bc40035b4398e68d9514a498b3c0fb3c842a4304`.

## Provenance

- Repository: `E:/git/dgo-hub`; branch: `feat/alpha1-implementation`.
- Exact dispatch baseline: `e4662f4a319e4ecc6c243bd8d2caa6086db36c45`.
- Product commit: `bc40035b4398e68d9514a498b3c0fb3c842a4304` (`Implement strict M0 sales MCP boundary`).
- Product scope includes the strict sales MCP, explicit local lab compatibility, shared runtime config, migration 003, and focused integration coverage. `migrations/001_init.sql` and `002_identity_auth.sql` were not changed.
- Existing Task1/Task2 approved reports, reviews, and evidence were preserved. The final full test suite temporarily overwrote four Task1 evidence outputs and created one Task2 output directory; I restored the four tracked files byte-for-byte and removed the suite-created Task2 directory. Task3 fixture evidence remains under its unique `m0-task-3-evidence/` paths.

## Implemented boundary

- Strict sales MCP is `POST/GET/DELETE /mcp/sales` over the pinned MCP SDK transport. It authenticates one opaque 43-character personal-agent Bearer credential on each HTTP request through Task1 `AuthService`; management/OIDC JWTs and source credentials do not authenticate. No identity, tenant, role, or department override is accepted in tool inputs.
- Exactly five fixed read-only tools are registered: `get_sales_context`, `find_customers`, `get_customer_orders`, `get_order_detail`, and `get_sales_summary`. `get_sales_context` uses only the trusted principal; other tools map validated arguments to fixed query definitions. There is no arbitrary SQL or caller-supplied GraphQL.
- The Hasura JWT is signed HS256 from the explicitly supplied `HASURA_JWT_SECRET`, uses audience `hasura-sales`, expires after 60 seconds, and has one role derived as `hub_<tenant>_<business_role>`. User, tenant, and optional department claims come from the fresh principal. The MCP process does not use a Hasura Admin Secret.
- Before query, after query, and after durable audit, the service rechecks current agent authorization, gate state/epoch, and the readiness snapshot. It returns no query data if any recheck fails or changes. The default resolver always reports `ALPHA_POLICY_NOT_READY`; no runtime force-ready flag exists. A test-only injected resolver exercises the ready path. An open legacy gate or `sales_reader` role is not M2 applied proof.
- Audit records contain request ID, credential reference, exact auth/gate epochs, argument SHA-256 digest, tool/protocol, result count when a result may be returned, and nullable binding/policy version slots. They contain no credential, arguments, Hasura token, raw target/header, or result. The first append is an `audit_checkpoint`; if the final post-audit check fails, a second `return_check` event with the same server request ID records the final denial/error and no result count. Consumers must correlate by request ID and use the last event by audit ID as the request decision; the checkpoint does not claim the client received data. If either audit append fails, the MCP tool returns `AUDIT_UNAVAILABLE` and no business data. MCP receives INSERT only; no historical audit row is updated.
- Present invalid `Origin` is rejected with HTTP 403 before credential authentication or query work. `HUB_MCP_ALLOWED_ORIGINS` is an exact comma-separated HTTP(S) origin list; wildcard, path, query, credentials, and duplicate entries fail configuration. A missing `Origin` remains usable with Bearer auth. The service does not infer origin trust from `Host` or forwarded-host headers. Fastify's default proxy trust remains off; the MCP listener binds `0.0.0.0`, so ingress/network policy must restrict reachability.
- Default runtime is `HUB_ENVIRONMENT_KIND=site` and `HUB_ENABLE_LEGACY_LAB=false`. Site plus the legacy flag is rejected. `/v1/ingest/*`, `/admin/*`, and demo `/mcp` are absent by default. They are restored only when both `HUB_ENVIRONMENT_KIND=local_lab` and `HUB_ENABLE_LEGACY_LAB=true` are explicitly supplied. This explicit lab selection also enables fixed-source worker scans and the legacy publisher bootstrap. The default worker does not scan configured CRM/order sources; the strict publisher closes the query gate and exits `not_ready` without bootstrap/opening it. The existing lab demo path remains documented and is not the strict M0 identity path.
- Factories and imports remain side-effect safe. Process entrypoints parse explicit environment at startup; they do not load `.env`. The MCP port is `MCP_PORT` (default 3001, integer 1–65535). API `PORT` defaults to 3000. MCP startup requires `DATABASE_URL`, `HASURA_URL`, and `HASURA_JWT_SECRET`; the URLs and MCP port are validated, the database URL is required, and config values are never echoed. SDK package-lock resolution remains 1.32.1 and Hermes v0.22.1 compatibility guidance is unchanged; no SDK/protocol upgrade or remote Hermes call was made.

## Migration and Task4 consumer contract

The minimal forward migration is `integration-service/migrations/003_mcp_audit_boundary.sql`. It alters the existing `control.agent_audit` only; it does not rewrite 001/002 or add an auth registry. New nullable fields are:

```text
request_id uuid
credential_id uuid
auth_epoch bigint
gate_epoch bigint
 result_count integer
 args_digest bytea
 protocol_version text
 binding_version text
 policy_version text
 stage text
```

`auth_epoch` and `gate_epoch` are persisted as PostgreSQL bigint without converting through JavaScript number; query-gate reads use `epoch::text`. Checks require nonnegative epochs/result counts when present and exactly 32 digest bytes when present. Binding/policy versions remain nullable until M2 provides an applied resolver; no version is fabricated.

The narrow strict MCP database SQL surface is:

```sql
SELECT state, epoch::text AS epoch
FROM control.query_gate
WHERE id = 1;

INSERT INTO control.agent_audit
  (tenant_id, user_id, tool_name, outcome, error_code, duration_ms,
   request_id, credential_id, auth_epoch, gate_epoch, result_count,
   args_digest, protocol_version, binding_version, policy_version, stage)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);
```

Task4 should grant MCP `SELECT(id,state,epoch)` on `control.query_gate`, column-scoped `INSERT` for the listed `control.agent_audit` fields, and `USAGE` on the existing `control.agent_audit_id_seq` sequence used by the table serial primary key. Include the existing Task1 AuthService read grants needed for `authenticateAgent`/`assertCurrentAgent`. MCP needs no audit `UPDATE`, DELETE, auth-registry write, gate write, or Hasura metadata privilege. The strict publisher is a separate process; its only M0 action here is `UPDATE control.query_gate SET state='closed', epoch=epoch+1, changed_at=now() WHERE id=1`. Task4 remains M0 and must deploy a default NOT_READY combination; the M2 applied resolver and verified-ready state are not implemented here.

Programmatic integration seams are `createMcpApp({ authService, pool, queryExecutor, readinessResolver?, allowedOrigins?, runtime? })`, `AlphaReadinessResolver({principal, gate}) -> {ready, reason, bindingVersion, policyVersion}`, and `SalesQueryExecutor({principal, name, variables}) -> data`. The runtime factory has no ready override. `startMcp(environment?)` validates config before loading the pool or listening. Task4 may inject its future M2 readiness resolver only once that M2 capability exists; the M0 deployment must use the default not-ready behavior.

## RED, verification, and owned resources

A test-first RED was observed before adding the MCP factory/auth boundary. Its initial console output was not retained, so no reconstructed RED artifact is claimed. Focused GREEN after the append-only audit changes: `npm test -- --run acceptance-tests/mcp-auth.test.ts` — **16/16 passed**. Final full gate, run after the migration-ledger assertions were updated for 003:

- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `npm test` — exit 0, Vitest 4.1.12, **12 files / 185 tests passed**.

Logs and exit codes are in `m0-task-3-evidence/01b16a7e-7b7b-4060-a7d8-f90e6b81d82c/final-gate/`. Earlier failed typecheck attempts and their exact output are preserved in `m0-task-3-evidence/80350071-801c-4b29-ad1f-0612f642b1ab/pre-final-gate-attempts/`; the type errors were fixed before the final gate. Test coverage includes real owned PostgreSQL migration/audit behavior, signed Hasura JWT interception and verification, all-five default readiness including context, wrong credential family, forged identity input, origin rejection before auth/query, query and audit barriers for revocation/epoch/expiry, a fresh credential succeeding, primary and final-event audit failures, strict/lab routes, worker/publisher guards, and safe request logging.

The final full suite created 12 task3-owned `postgres:16.10-alpine` fixtures. Each lifecycle file records `task3` and its unique run label; the ownership check used the full container ID and both Docker labels before exact-ID removal, and confirmed absence afterward. The sanitized joined IDs, labels, RepoDigest/runtime image identity, and lifecycle log paths are in `m0-task-3-evidence/postgres-fixture-summary.json`; individual logs remain in their unique run folders. The suite also ran Task0/1/2-owned fixtures. Their current-run lifecycle records were not copied before the existing Task1 outputs were restored and a transient Task2 output directory was removed. Their exact IDs and labels are not retained, so this report does not reconstruct them; the suite passed, including fixture cleanup. No pre-existing user container/database, service, clone, or remote endpoint was touched. No secret, `.env`, `.npmrc`, ambient database URL, or Config.Env was read by the implementation or test harness.

## Limits

No site IdP/source inputs were available or needed for this local implementation. No remote Hermes v0.22.1 instance was accessed, no SDK/protocol version was upgraded, and this does not establish Hermes interoperability, site origin allowlist values, M2 applied binding/policy proof, production database grants, deployment readiness, or product acceptance. The active `sales_reader` compatibility route exists only under the explicit local lab flag. M1 batch ingestion and M2 query semantics remain outside this Task3 change.
