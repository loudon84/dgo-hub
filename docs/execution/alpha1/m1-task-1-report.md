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

## Independent review fix round 1

The fix round started from source base `7866b99fa2c098877b91c84f0b728f14ab4fe18f`; the repository also contained the root's docs-only status commits. The source changes are commit `6cf6f8ee5442f6fad04d9ccf3e185b08a7ca0715`.

### Review findings addressed

- **I1:** `hub_api` now exercises the manager's actual create, map, test, approve, activate, and pause workflow. The migration grants only execution on fixed-search-path lock functions needed by that role, revokes PUBLIC access, and keeps credential digest and `secret_ref` unreadable.
- **I2:** Credential generation is tracked separately from the admission epoch. Effective credential changes atomically invalidate approvals/test applicability and pause an active source; unchanged credential updates preserve an approved pause. Approval and activation require the current generation, deployment profile digest, current PASS report, legal lifecycle state, exact Owner, and expected revision.
- **I3–I4:** HTTPS origin matching normalizes explicit port 443; PostgreSQL capability checks reject table and column INSERT/UPDATE privileges while probing read-only.
- **I5:** API012 and API006 use the same bounded mapping validator, with the PRD's allowed/required standard fields, transform compatibility, version/delete contract checks. `sample_ref` is explicitly rejected as unsupported. The PostgreSQL probe does not imply snapshot completeness.
- **I6–I7:** Existing API013 typed candidate preview and API014 expected-revision confirmation are used. The candidate identifier is opaque and binds source, kind, and external ID; tenant comes from the authenticated principal. User and department targets must be enabled records in that same tenant. Exact Owner, `source:approve`, reason, and initial `expected_revision: 0` are required. Customer targets remain unresolved because no canonical customer target exists in the current M0 schema; preview reports unresolved and confirmation fails closed. M1-2 must supply the canonical same-tenant target lookup before customer mappings can be confirmed. The confirmation action checks expected revision under the locked transaction and uses no extra `source:read` scope.
- **I8:** Parser, media type, and body-size errors use the Hub request ID/error envelope and the expected 400/413/415 statuses.
- **I9:** The earlier report's source-test hash `8167f5fd1df939edc3843bae7e3cc469e943d8660bb44b11e9d52ae69cd9d01` was stale. The reviewed pre-fix test bytes were raw SHA-256 `7d1abf6a29c43ebc306bebd27fec70b278786b4e64b78b9f158a8cd6ec5bc88d` and committed LF-normalized SHA-256 `18562dc49f98dbb7ae668f4b21da70883dd3a6bbbaca8ae7a83d86d3ab735838`. The earlier 210-test run remains historical evidence for its then-current bytes only; it is not evidence for this fix-round source.

### Fix-round verification

In `E:\git\dgo-hub\integration-service`:

| Command | Evidence | Exit | Result |
|---|---|---:|---|
| `npm test -- --run acceptance-tests/source-registry.test.ts` | `final-focused-test.log` | 0 | 27/27 focused tests passed; includes PostgreSQL migration/role/immutability/column privilege and owned HTTP probe/workflow coverage |
| `npm run typecheck` | `final-typecheck-rerun.log` | 0 | TypeScript passed |
| `npm run build` | `final-build-rerun.log` | 0 | Build passed |

The retained evidence root is `docs/execution/alpha1/m1-task-1-fix1-evidence-20261024-b2494338b61240be98a1e3add01f84fc/`. It includes raw outputs from passing and failing attempts. Early failures include the expected RED cases for HTTPS:443/column UPDATE, credential rotation, hub_api workflow, and mapping validation. `focused-source-registry-first.log` is a partial run that hung when its race observer watched the old direct SQL lock query after the lock changed to a definer function; it has no claimed exit or test count. An initial full focused run also had a fixture setup mismatch; later scoped runs corrected it. These outputs are retained rather than replaced or represented as passing runs. The accepted final gate is the three commands in the table above.

The M1 migration sequence is 001–005; 001–004 remain unchanged. Migration 005 was written before the first observable RED capture in the original implementation turn; this chronology is preserved and no strict schema-first TDD claim is made. Review fix regressions were captured RED before their relevant implementation changes. Migration 005 normalized SQL SHA-256 is `23b9311c6e6d1d8c67214f061eb37a55493e7356cfbcab032eef8019b05edcef`; committed Git blob is `2bfc243e61a55be73458587a674027b5202feb49`.

The local fixture inventory records 19 PostgreSQL lifecycles and 19 HTTP fixtures for this fix round. Exact owned PostgreSQL container IDs were checked absent after cleanup; HTTP fixtures were closed. The partial interrupted fixture and its cleanup are recorded in the inventory and per-run lifecycle outputs. No external source, remote Hermes, site runtime, or SQL Server was available or tested.

### Tested source identity

These hashes describe the source bytes used by the final focused test/typecheck/build and the source commit. The test file contains one CRLF and 741 LF line endings; its raw and LF-normalized hashes are therefore both included. Git blob IDs identify the committed bytes.

| File | Raw SHA-256 | LF-normalized SHA-256 | Bytes | Git blob |
|---|---|---|---:|---|
| `integration-service/migrations/005_source_registry.sql` | `23b9311c6e6d1d8c67214f061eb37a55493e7356cfbcab032eef8019b05edcef` | same | 20547 | `2bfc243e61a55be73458587a674027b5202feb49` |
| `integration-service/source-registry/capability-probe.ts` | `7780d9e0f59b5cc2339bbd9aae072250e706d2b88ba186519906f390f854b1ea` | same | 13385 | `792187e039db0c2ac3a43193152589def6a3a260` |
| `integration-service/source-registry/routes.ts` | `3e9394da2fcb621f0b204f296cafb4ece424b716b47721c2dfbab7a969b89007` | same | 10068 | `5c3bec03c2eff39903b2ac10df51e041e320d82a` |
| `integration-service/source-registry/service.ts` | `5c6f3a24172bc52abcb78f9c1223115625ddbaaeea15da1e69e524670246b638` | same | 50085 | `dc1121a53287371b4ff391632a658ad7f2c8794a` |
| `integration-service/acceptance-tests/source-registry.test.ts` | `ec3a589ca981f6403f7fc0e91ab4cc501c675cb08b78f4cbf05b2299901d48ee` | `a7d3becdab741e6e002b731dba6c46502c6a45181f643fbf10db209abd6526d1` | 54989 | `000165dc79aacdb292a3d577a9263810c066573d` |

Commit `6cf6f8ee5442f6fad04d9ccf3e185b08a7ca0715` changes only the five files in this manifest. Root-owned `progress.md` remains unstaged. Evidence is committed separately from source.

### Limits

The PostgreSQL and REST probes were exercised against explicitly owned local fixtures. Production credentials, external egress, a configured source or IdP, SQL Server, remote Hermes, and the site runtime remain unverified. No full snapshot completeness or ingestion/apply behavior is claimed. M1-2 canonical apply, batch worker, durable snapshot engine, and UI remain outside this task.

## Independent re-review fix round 2

Fix-round 2 began at `7dedc3f77094b4c6cb56ecfd8c70dad80765e56c` and source changes are commit `75d6640a57939791477203b7a196abbdde34dcee`. The earlier source findings I1/I3/I4/I6/I7/I8/I9 remain closed and were not broadened.

### Remaining findings addressed

- **I2:** `update_source_credential` and `upsert_source_credential` now detect effective credential/config applicability changes (secret/ref, enabled state, entity scope, or revision). A real change advances `source_epoch` and `credential_generation` exactly once, and invalidates registry applicability in the same transaction when a registry row exists. ACTIVE/PAUSED sources become PAUSED; other lifecycle states become DRAFT. No-op updates return without changing either generation or epoch. Ordinary manager pause/resume does not mutate credential generation and retains a valid approval. Credential scope expansion/removal, enable changes, and revision changes invalidate applicability. Upsert emits lifecycle effects only when the corresponding registry row exists, preserving pre-onboarding credential rotation and the composite FK.
- **I2 admission:** `lock_current_source` now locks credential, tenant, registry and active channel rows together. Admission requires the current credential revision to equal the registry's current config revision, the entity to appear in both credential scope and the current config's `allowed_entities`, and an active channel whose connector/mode/version domain match that config. Thus an entity added only to the credential scope remains inadmissible even after the supported config is retested, reapproved and reactivated.
- **I5:** Unsupported `sample_ref` returns a sanitized Hub error envelope with HTTP 422. Malformed JSON remains 400; unsupported media remains 415; oversized body remains 413.
- **I10:** Credential rotation before source registry onboarding succeeds and advances epoch/generation. Registry lifecycle effects are skipped when no registry row exists; registered active rotation coverage remains in the focused suite.

### RED and GREEN evidence

Fresh evidence root: `docs/execution/alpha1/m1-task-1-fix2-evidence-20261024-0eb98c9e4866453d9a38c3ad465038fa/` (absolute root pointer in `m1-task-1-fix2-evidence-root.txt`).

In `E:\git\dgo-hub\integration-service`:

| Command | Evidence | Exit | Result |
|---|---|---:|---|
| `npm test -- --run acceptance-tests/source-registry.test.ts` before implementation | `red-fix2-regressions.log` | 1 | 26 passed, 3 failed at the intended I2, I5, and I10 regressions |
| `npm test -- --run acceptance-tests/source-registry.test.ts` after implementation | `green-fix2-regressions.log` | 0 | 29/29 passed |
| `npm run typecheck` | `final-typecheck.log` | 0 | TypeScript passed |
| `npm run build` | `final-build.log` | 0 | Build passed |

The I2 regression covers credential entity extension, stale approval rejection, order admission denial before and after current-config reapproval, continued customer admission, no-op generation stability, and entity-scope removal. Existing tests cover valid pause/resume and registered active secret rotation. I10 covers new source credentials rotated before registry creation and exact generation/epoch increments. The actual migration chain 001–005 runs in both RED and GREEN test processes. Migrations 001–004 are unchanged.

The RED and GREEN test runs each used an owned `postgres:16.10-alpine` fixture. Both exact IDs were confirmed absent after removal; both local HTTP fixtures were closed and their ports released. The IDs, run labels, image digest, timestamps and cleanup outcomes are in this root's `m1task1/<runLabel>/postgres-lifecycle.jsonl`, `postgres-resource-summary.json`, and `capability-http-resource-summary.json`. RED used run label `1e061809-db85-4ed4-972c-52afbb58f57a`, container `9446d70999b0e1d7376b89edfaa2ad6226d34bb03062035d23748c190ab931b4`; GREEN used run label `a77603b0-01a6-4f6e-b493-00c9876ad704`, container `04697093c9d76d735a6605f2c25eb87bc18a0f260a84869fd3b2de9842e1398b`. Both used repo/runtime digest `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`.

### Tested source identity

These are the source bytes used for the final focused suite, typecheck and build. The test file contains one CRLF and 820 bare LF line endings.

| File | Raw SHA-256 | LF-normalized SHA-256 | Bytes | Git blob |
|---|---|---|---:|---|
| `integration-service/migrations/005_source_registry.sql` | `7085104c2ef23033398ade93441def385fc04b67bd3d39c73bf7e5cfe90a3f7f` | same | 22627 | `b59b25d1e9b08790eec943e9b159e39ee3593158` |
| `integration-service/source-registry/routes.ts` | `29cee7ca7773e0042037ce0ec12f101ee45119bb5d1ad9e655cabe69e0504069` | same | 10180 | `d1b36862bae0ac5ce33f8759813afff58f3c92d1` |
| `integration-service/acceptance-tests/source-registry.test.ts` | `4df59596929563c42bf37307fa80dde548418e6fc52a667552b5c5ce1cec4183` | `76b9b14f43b147b22a078e36ad1f12bf737a41a9714c411d8d1fd7d28484968e` | 61561 | `f4328fc799037d714c9d6697fdf88b85ad55cc2b` |

Migration 005 raw and LF SQL digest is `7085104c2ef23033398ade93441def385fc04b67bd3d39c73bf7e5cfe90a3f7f`. No migration 001–004 changes are present in the fix commit.

### Limits

The tests use explicitly owned local PostgreSQL and loopback HTTP fixtures. No production source, IdP, external egress, SQL Server, remote Hermes or site runtime was exercised. Current-source checks establish entity/config/channel applicability, not full snapshot completeness or ingestion/apply behavior. M1-2 remains gated on independent scoped re-review.
