# M1-1 Source Registry implementation report

Date: 2026-10-24 (Asia/Shanghai)
Branch: `feat/alpha1-implementation`
Implementation base: `85b46c693977e709d85cd28c2f62340a67bbfacf`
Scope: source registry, mappings, bounded capability testing, owner approval/activation/pause, and current-source authorization only.

## Delivered

- Added migration `integration-service/migrations/005_source_registry.sql`. It adds tenant-scoped source/config/mapping/identity-mapping revisions, test reports, approval records, channels, lifecycle events, source epoch, and typed source security barriers. It leaves migration 001–004 bytes unchanged and uses the existing migration runner.
- Added the source registry service and API-002–API-014 routes. Owner approval binds the config, mapping, identity mapping, owner revision, and current source credential revision. Approval requires the same enabled same-tenant owner identity with `source:approve`. API responses omit endpoint profiles, secret references, raw credential digests, and source credentials.
- Added a source-config `EndpointProfile` resolved by an injected deployment allowlist. The profile is frozen into the config revision digest. A changed profile makes an existing config inapplicable before secret resolution and writes no test report.
- Added bounded REST and PostgreSQL capability probes. REST uses the exact allowlisted origin/path, TLS for non-local profiles, manual redirect handling, a 3-second deadline, a 32 KiB streaming response limit, and checks the declared protocol, schema version, pinned source identity, version domain, mappings, and delete contract. PostgreSQL validates approved identifiers, database/schema/table/columns, source database and login identity, role attributes and read/write grants, then issues only `SELECT ... LIMIT 0` inside `BEGIN READ ONLY` with query and statement timeouts. It does not write to source objects.
- Local HTTP and plaintext PostgreSQL are permitted only for explicitly enabled loopback fixtures in `local_lab`. `site` defaults fail closed without injected SecretResolver, endpoint allowlist, and probe dependencies. Existing `startApp` runtime wiring remains fail closed unless deployment code supplies those dependencies.
- Added current-source authorization on the caller-owned `PoolClient`. It checks tenant/source/kind, credential identity and enabled state, current source epoch and config revision, lifecycle, and entity scope while holding transaction locks. Intake admission freshness (`source_epoch`) remains distinct from durable security barriers. Credential rotation and config revision changes advance their respective revisions once; no-op credential updates do not bump the epoch. Pause/revocation and owner reassignment cannot silently preserve active admission.
- Added tests for source-owner authorization, first activation races, active channel-switch refusal, expected-revision conflicts, admission/pause serialization, changed profile and mapping races, SQL Server fail-closed behavior, secret non-disclosure, route authorization, and real local REST/PostgreSQL probes.

## Test-first and implementation timeline

Migration 005 was written before the first RED. The early source-surface smoke test then failed because `assertCurrentSource` was not yet implemented. Its captured run is `red-focused.log` (1 test failed, exit 1; 2026-10-24 13:29 Asia/Shanghai). The migration file's observed LastWriteTime is 2026-10-24 05:36:32 UTC (13:36:32 Asia/Shanghai); this is a latest-write timestamp, not evidence of initial creation order. The later behavior-focused mapping regression was also captured after the migration: `mapping-contract-red.log` (1 failed, 17 passed; exit 1). It showed a source with an unmapped allowed entity incorrectly receiving TESTED. The implementation now records `MAPPING_REQUIRED:<entity>` and cannot mark the source TESTED. The report preserves the migration-before-RED sequence and does not claim strict test-first schema development.

`probe-race-red.log` also records a stale mapping result being accepted while the probe ran. The GREEN implementation rechecks the frozen config, mapping, identity mapping, owner and credential revisions, lifecycle, credential identity/enabled state, and source epoch before persisting a result. `probe-race-green-01.log` passed 15/15. `admission-lock-green-01.log` passed 16/16 including admission/pause serialization.

During final integration, the first full gate found a TypeScript narrowing error and two migration expectations still hard-coded to 001–004. Those outputs remain in `final-typecheck.log`, `final-test.log`, and `final-build.log`, with exits 2, 1, and 2. The fixes narrowed the loaded digest type and updated migration-runner expectations to include 005. `repair-focused.log` passed all 50 tests across source registry, identity store, and migration runner; `repair-typecheck.log` exited 0. The final full gate is recorded below.

## Verification

Commands ran from `integration-service` with `M0_RUN_EVIDENCE_ROOT` set to the absolute task evidence directory:

| Command | Raw output | Exit | Result |
|---|---|---:|---|
| `npm test -- acceptance-tests/source-registry.test.ts` | `profile-mapping-green-02.log` | 0 | 19/19 tests |
| `npm run typecheck` | `final-typecheck-02.log` | 0 | TypeScript passed |
| `npm test` | `final-test-02.log` | 0 | 210/210 tests, 13 files |
| `npm run build` | `final-build-02.log` | 0 | Build passed |

Each row's numeric exit is recorded in the matching `.exit` file. All raw outputs, including failed attempts, are retained under `docs/execution/alpha1/m1-task-1-evidence-20261024-cad9155fade24a7982692426928f8513/`.

The focused PostgreSQL acceptance suite uses an owned PostgreSQL 16.10 container. It applies migrations 001–005, checks rerun/immutability behavior, checks the migration role grants (including absence of direct source credential digest/secret-ref reads), uses a separate login role with only SELECT on a local source fixture, and verifies the actual bounded REST probe over an owned loopback HTTP server. Resource inventory lists all 41 owned PostgreSQL fixture lifecycles (including three task0 foundation captures and the first run captured under the earlier task evidence directory) and 11 HTTP fixture lifecycles; all 41 exact container IDs have `confirmed removed by exact owned container ID`, and every recorded HTTP fixture says the server closed and port released. See `owned-resource-inventory.json`, the earlier evidence directory's two lifecycle files, and each current fixture's `postgres-lifecycle.jsonl` for IDs, labels, image references/digests, ports, and create/cleanup events. No user resource or upstream clone was changed.

## Source and migration identity

SHA-256 hashes of the final M1-1 source inputs before report/commit:

| File | SHA-256 |
|---|---|
| `integration-service/migrations/005_source_registry.sql` | `3f832e865995c10e8680a65a01c31094b5337cb38f2001ce453673d9d0ff0082` |
| `integration-service/source-registry/capability-probe.ts` | `596281565d0329ffc3987b166507ec0b039ce50fb33b9d6466580096fba2a4bd` |
| `integration-service/source-registry/routes.ts` | `0279c845a63d5c5339eab5f96c4b8c73d80dc595efc950f0de378dd83fec06ab` |
| `integration-service/source-registry/service.ts` | `3105e3435dacc2a031327970510caa2f2810ecd21fbf52e7a709bb5054d6d35f` |
| `integration-service/acceptance-tests/source-registry.test.ts` | `8167f5fd1df939edc3843bae7e3cc469e943d8660bb44b11e9d52ae69cd9d01` |
| `integration-service/auth/service.ts` | `006e75eb6d02e8ae9c65dfc322b1ffebb84e31a7d871ffdf26576d79eb8e8e22` |
| `integration-service/auth/types.ts` | `41b26d854ed8f0fe7df1b98431155b037e843da29f64e7ff2e555dfdbfec6c1a` |
| `integration-service/ingestion-api/routes.ts` | `981e19027f1da3c3b6642465d7527143c894ab5e010d3798b4c6070656b7e5bb` |
| `integration-service/app.ts` | `64c59a001187a08f87bb80d7d7adecbcff5fbbbe711ee535f2470c12db373e5` |

Migration 001–004 Git blobs at base and working tree match exactly: `001_init` `523be309e06915b1b3c03c5f1ffb55c8b3bfe4f7`; `002_identity_auth` `4d9bb4b40fac91f65262d84834c1958d5121cdc1`; `003_mcp_audit_boundary` `1b6f8ef3c89013cc8d5cc3e78601dd11a009be68`; `004_alpha1_runtime_security` `d9d6dae66ee205b37e2f83418713a94c9249fc1d`. Migration 005 SHA-256 is also listed above.

## Limits

- SQL Server capability testing is intentionally unavailable and returns `SOURCE_PROBE_UNAVAILABLE`; the source stays DRAFT. No SQL Server endpoint or deployment was available.
- PostgreSQL and REST reachability were proven only against the explicitly owned local fixtures. There was no production source connection, approved outbound path, configured IdP/source, external egress check, remote Hermes run, or site runtime test. No site acceptance or production-readiness claim is made.
- The profile is a minimal deployment-controlled allowlist shape, not a general connector language. The current PostgreSQL probe checks declared objects, required columns, identity, read-only access, and queryability; it does not prove full snapshot completeness or implement snapshot ingestion/apply.
- `startApp` has no default production secret/endpoint provider and therefore fails closed until deployment injects one. No new KMS or platform service was introduced.
- M1-2 canonical apply, batch worker, durable snapshot engine, and UI remain out of scope.
