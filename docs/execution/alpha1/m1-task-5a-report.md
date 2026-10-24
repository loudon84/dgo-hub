# M1-5A implementation and repair history

The original implementation record below is historical. The Fix1 record supersedes its current-source/test counts and preserves earlier evidence limits. M1-5 remains IN_PROGRESS; independent Fix1 re-review is pending.

## Original implementation record — c90ed617

# M1-5A implementation report

## Status

M1-5 remains **IN_PROGRESS**. The formal 48-gate suite is **NOT_RUN**. This report covers M1-5A only; no M1-5B, extraction, staging, business apply, cutover, or deployment work is included.

## Implemented

- Added phase-owned migration `009_snapshot_runs_and_recovery.sql` for durable run proof, attempts, schedule state, one-active-run fencing, scoped proof foreign keys, immutable admission facts, and the guard-first source lock function. Migrations 001–008 remain unchanged.
- Added PostgreSQL FULL_SNAPSHOT activation scheduling at a persisted 300-second interval, immediate first due time, and pause-time schedule disablement. REST source activation remains unchanged.
- Added API-019 manual admission and API-020/API-021 tenant-scoped list/detail routes with strict inputs, idempotency, safe summaries, and no source bearer-auth fallback.
- Added the callable durable due-run admission gate for later worker wiring. It uses the security barrier first, followed by credential/source/channel/schedule locking. Manual and scheduled admissions share the same one-active-run constraint. No in-memory timer was added.
- Admissions verify current tenant and principal, source credential, enabled entities, approved config revision, mapping and identity mapping revisions, passing capability test, current Owner approval, per-entity active channel proof, and security fences. Customer snapshots are admitted when current proof is valid. Order snapshots fail closed until the approved line-relation contract exists.
- Rejected hard-delete absence handling with the SOURCE_VERSION domain until a compatible delete proof is available. Run detail starts with `NOT_STARTED` completeness and a null checkpoint.

## Verification

All final commands ran with `M0_RUN_EVIDENCE_ROOT` set to the unique external runtime root `E:\m1t5-runtime\m1-task-5a-b0933c9f-5f14-4572-bd82-115eae3c0635`. The retained before/after source snapshots include raw SHA-256, LF-normalized SHA-256, byte size, clean Git blob hash, branch, and HEAD.

- `npm test -- acceptance-tests/snapshot-runs.test.ts`: **6/6 passed**.
- `npm test -- acceptance-tests/migrations.test.ts`: **19/19 passed**.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- Migration 009 was applied and repeated in the test database; privilege checks covered `hub_api` and `hub_worker`.
- Docker fixtures used task label `m1task5`; pinned image `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`; both final-gate containers recorded matching runtime/repo digests, confirmed ownership, exact-ID removal, and absence after removal.

The broader run inventory also contains one earlier fixture event (`88ad9762-f861-4961-90d4-de8e83ad33a0`) marked `start_failure_unresolved` before a container ID was recorded. The Docker daemon responded successfully (`29.8.1`), and a `docker ps -a` query filtered by both exact labels `codex.m0.task=m1task5` and `codex.m0.run=88ad9762-f861-4961-90d4-de8e83ad33a0` exited 0 with zero matches. No container name was supplied by the fixture. There is no current matching container; removal is not asserted because no ID was recorded. No alternate cleanup was attempted. The sanitized start event and query stdout/stderr/exit evidence are in the evidence package; the final-gate containers are independently confirmed removed and absent.

The final API route tests used Fastify `app.inject`. They exercised manual create, same-key replay, changed-request idempotency conflict (409), read-only principal rejection (403), strict invalid-filter rejection (400), safe detail, pause-time replay, and absence of secret material in detail output. Direct service/database tests exercised manual-overlap rejection, the due gate returning null behind an active manual run, concurrent scheduled calls admitting exactly one run, and a later due call remaining fenced. Direct admission tests exercised fail-closed order snapshots and SOURCE_VERSION hard-delete rejection; these are service-level cases, not HTTP route tests. Database checks exercised immutable proof and the `hub_api` update denial.

The final focused migration run initially exposed a test-fixture isolation failure: `beforeEach` left the `raw` schema behind, so a later compiled CLI migration attempt collided with earlier raw tables at migration 007. The fixture now drops `raw` with the other migration schemas, and uses the `m1task5` Docker label. The retained 18/19 failure capture documents the issue; the final run passed 19/19.

## Commits and evidence

- Product/test commit: `4166e6d47d01ee8daad3c3f81b64055f73f37d8e` (`Implement durable PostgreSQL snapshot run admission`), based on requested BASE `b6177cc8b10537d07c0d25ec6654475045036f1e`.
- Evidence package: `docs/execution/alpha1/m1-task-5a-evidence/a93f4178-219f-4418-b8e0-4f11266c8c64/`.
- The package contains an explicit artifact SHA/size manifest, before/after/committed source manifests, test and compiler/build stdout/stderr/exit captures, the initial RED and migration-failure captures, run-owned Docker lifecycle evidence for the final gates, and the BASE-to-product-commit source diff.

## Scope remaining

M1-5A does not implement extraction, staging pages, business application, observations, checkpoint writes, deletes, APIs 022/024/060, cutover, SQL Server, UI/query-gate work, or network/deployment activity. Formal 48-gate evidence remains NOT_RUN pending the later M1-5 phases.

## Controller evidence inventory clarification

The retained sanitized docker-ownership-review.json contains all 58 recorded lifecycle events from this slice's 20 run labels: 19 created, 19 image-observed and 19 ownership-confirmed removed/absent containers, plus the one start_failure_unresolved event with no container ID. There is no created run lacking a confirmed removal/absence record. Only the two final-gate lifecycle JSONLs are copied verbatim; other raw lifecycle originals remain in the fresh external runtime. The no-ID startup is not counted as removed: its retained healthy-daemon exact task+run label query returned exit 0 with no matches. Controller independently checked all 49 artifact sizes/SHA-256 values and found zero mismatches. These retained records do not imply a new live resource check by the controller.


## Fix round 1 record — product b2ea8e79

# M1-5A implementation report

## Status

M1-5 remains **IN_PROGRESS**. The formal 48-gate suite is **NOT_RUN**. This report covers M1-5A and its first review-fix round. M1-5B and later phases remain pending.

## Implemented scope

- Added phase-owned migration `009_snapshot_runs_and_recovery.sql` for durable run proof, attempts, schedule state, one-active-run fencing, scoped proof foreign keys, immutable admission facts, and the guard-first source lock function. Migrations 001–008 remain unchanged.
- Added PostgreSQL FULL_SNAPSHOT activation scheduling at a persisted 300-second interval, immediate first due time, and pause-time schedule disablement. REST source activation remains unchanged.
- Added API-019 manual admission and API-020/API-021 tenant-scoped list/detail routes with strict inputs, idempotency, safe summaries, and no source bearer-auth fallback.
- Added the callable durable due-run admission gate for later worker wiring. It uses the security barrier first, followed by credential/source/channel/schedule locking. Manual and scheduled admissions share the one-active-run constraint. No in-memory timer was added.
- Admissions verify current tenant and principal, source credential, enabled entities, approved config revision, mapping and identity mapping revisions, passing capability test, current Owner approval, per-entity active channel proof, and security fences. Customer snapshots are admitted when current proof is valid. Order snapshots fail closed until the approved line-relation contract exists.
- Rejected hard-delete absence handling with the SOURCE_VERSION domain until a compatible delete proof is available. Run detail starts with `NOT_STARTED` completeness and a null checkpoint.

## Review fixes in this round

- **R1:** Granted `hub_api` only the schedule INSERT columns used during PostgreSQL activation and `interval_seconds` on schedule UPDATE. Regression tests run activation, pause, and resume through the real `hub_api`-scoped service. Public schedule writes, API raw reads, API credential digest reads, and worker proof updates remain denied.
- **R2:** Admission checks typed barriers newer than the persisted approval security fence. Tenant-wide barriers with null source scope apply to every source; credential, entity, source, and channel barriers apply only when their scopes match. A management-tenant disable/re-enable blocks manual and due admission under old approval proof. New Owner approval permits recovery; unrelated scoped barriers do not block the run. Existing runs are not rewritten.
- **R3:** Create, replay, list, and detail revalidate the authenticated principal against the current issuer/subject identity binding, enabled tenant and subject, current operation scope, and supplied principal identity using the existing `control.lock_api_identity` authority seam. API checks retain the global barrier guard first. Tests change binding, tenant enablement, and scope after authentication and confirm the operation is denied.
- **R4:** Pagination cursors carry a canonical run UUID; PostgreSQL resolves its exact stored timestamp and UUID for descending keyset pagination, preserving microseconds and timestamp ties. Route enumeration covers tied rows without omissions or repeats.
- **R5:** Date bounds require complete valid RFC3339 values with at most microseconds and a timezone. Cursor input must decode to a canonical UUID; empty and malformed cursors are rejected before SQL. Guessed or malformed run IDs return safe 404 responses; malformed filters return safe 400 responses.
- **G1:** Added focused coverage for tenant/source isolation, current authorization, manual-versus-due concurrency, durable reads after API instance recreation, independent source progress under an unrelated barrier, actual role grants and denials, and no raw/proof-secret output. HTTP assertions are identified below; concurrency and barrier state transitions are service/database checks.

## Verification

- Initial focused review RED: the real `hub_api` activation lifecycle exposed missing schedule INSERT privilege. After the grant fix, the API role lifecycle passed.
- An intermediate focused run exposed two issues: a test recovered before creating new approval proof, and auth service error wrapping collapsed `AUTH_REVOKED` into `AUTH_UNAVAILABLE`. Both were corrected; the subsequent focused run passed 12/12.
- Expanded focused snapshot suite: **16/16 passed**. It includes Fastify `app.inject` cases for OIDC binding drift on create/replay/read, current-scope and tenant denial, timestamp/UUID pagination, malformed/guessed identifiers, and tenant isolation. Direct service/database tests cover barriers, manual-versus-due concurrency, durability after API recreation, unrelated source progress, and actual database role enforcement.
- Focused migration suite: **19/19 passed**, including populated 008→009, repeat migration, and role checks. The test uses the approved pinned PostgreSQL image digest.
- `npm run typecheck`: exit 0. `npm run build`: exit 0. The corrected final build source snapshot has 13 source files before and after with no hash changes; it also records all eight immutable migrations. The committed-source manifest records the post-commit source hashes and the same 001–008 migration bytes.
- `git diff --check`: passed before the product commit.

Across the original implementation and this review-fix round, retained M1-5 task-labelled Docker lifecycle evidence records 25 created, image-observed, owned, and removed/absent fixtures. One earlier startup attempt has a retained `start_failure_unresolved` event with no container ID; a healthy-daemon query filtered by its exact task and run labels exited 0 with zero matches, so no removal is claimed for that attempt. The current review-fix round added six created/image-observed/removed fixtures. Three task0 migration-fixture bundles are separate from the M1-5 task labels and are included as selected safe lifecycle metadata. No fixture is reported as currently present based solely on stale evidence.

The earlier migration run's 18/19 failure capture documents a fixture-isolation issue: `beforeEach` left the `raw` schema behind, so a later compiled CLI migration attempt collided with earlier raw tables at migration 007. The fixture now drops `raw` with the other migration schemas; the final run passed 19/19.

## Commits and evidence

- Initial product commit: `4166e6d47d01ee8daad3c3f81b64055f73f37d8e`, based on requested BASE `b6177cc8b10537d07c0d25ec6654475045036f1e`.
- Review-fix product commit: `b2ea8e7998ece418fba1e105e38adda8e19e4d1e`, based on review-fix BASE `515ecbcd2bbbdcaeb1c6382b110e6f373c236ac2`.
- Evidence package: `docs/execution/alpha1/m1-task-5a-evidence/3b75d1a8-69f9-4873-b22e-55e1df26671e/`. Its explicit SHA-256/byte-size manifest covers retained command, stdout, stderr, exit, HEAD, source diff and snapshots, test captures, and selected sanitized lifecycle records. The evidence package was assembled from per-command external runtime roots; original external files were preserved.

## Scope remaining

M1-5A does not implement extraction, staging pages, business application, observations, checkpoint writes, deletes, APIs 022/024/060, cutover, SQL Server, UI/query-gate work, or network/deployment activity. Formal 48-gate evidence remains NOT_RUN pending the later M1-5 phases.
