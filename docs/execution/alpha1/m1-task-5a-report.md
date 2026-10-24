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

