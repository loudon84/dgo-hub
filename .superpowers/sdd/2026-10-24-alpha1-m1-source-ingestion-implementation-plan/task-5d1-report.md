# M1 Task 5D1 implementation report

## Result

D1 is implemented and committed on `feat/alpha1-implementation` at `68bfa36203be6446c47e0927ab9d982b5a380343`, based on `3040666fa9da2de19ba7b8bf632c4765f278b455`. This completes D1 only. D2 and D3 are not implemented; the candidate facts remain reserved for the next authorized gate.

The implementation adds D reservation and immutable consumption facts, per-run source-header presence including explicit source tombstones, stable-scope two-absence streaks, and immutable candidate headers/members. Reservation ordinals allocated under C's source lock order consumption even if database completion clocks tie or move backward. Each entity receives its own UUID candidate header, denominator, count and digest. Full source keys bind to live canonical UUIDs. Both numerator and denominator count distinct live canonical objects; a duplicate live full-key alias fails closed as `STALE` before candidate freeze.

The scope binds the approved tenant/source owner and approval, config and mapping revisions/digests, identity mappings, endpoint profile, channel IDs/epochs/version domains, enabled entities and delete contract. It omits run IDs, transport/page/snapshot provenance, OBS/time, admission counters and ordinary source epoch. Two different successful C COMPLETE runs therefore count independently; invalid/interrupted runs make no presence or absence fact, observed headers reset absence even when explicitly tombstoned, and D's own policy pause cannot stale its candidate.

D independently checks the exact C COMPLETE attempt, extracted/validated manifest, frozen proof, run-bound numeric(20,0) OBS and matching typed security barriers. The exact second-absence OBS and the existing DB `completed_at` are frozen as candidate evidence; no JS `Number` or millisecond `Date` conversion is used. Candidate digests stream ordered full keys and bind canonical IDs, both origin runs, OBS and inferred time. The threshold is exact integer arithmetic: exactly 5% remains pending; any entity over 5% blocks every candidate scope in the cohort, pauses the source, disables its schedule, advances ordinary source epoch and records a private `SYSTEM_POLICY` audit with database worker identity plus frozen Owner approval as authority provenance. No Owner is impersonated as the acting user.

C's successful finish inserts its reservation in the same transaction before clearing the active schedule slot. API-019's cached same-key replay remains ahead of the new-admission busy guard after current-principal validation; a new key, due admission and activation are blocked while a D cohort is busy. The strict worker loop consumes D reservations. It uses existing C serialization and typed fences; source connector access remains read-only. Worker/API roles receive no direct D base-table DML.

## Changed files

- `integration-service/migrations/009_snapshot_runs_and_recovery.sql` adds D tables, keys/FKs/indexes, immutability triggers, exact threshold function, proof loader, C-finish reservation and worker-only consumers.
- `integration-service/etl-worker/snapshot-delete-worker.ts` drains ordered D reservations from the strict worker loop.
- `integration-service/etl-worker/snapshot-runs.ts` guards new manual and due admissions while preserving cached replay ordering.
- `integration-service/source-registry/service.ts` blocks activation while D is busy.
- `integration-service/etl-worker/worker.ts` runs the D worker after C continuation processing.
- `integration-service/acceptance-tests/snapshot-runs.test.ts` adds actual-C D1 tests and explicit runtime child lifecycle capture.
- `.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/context/m1-task5d1-schema-contract.md` records the exact schema, keys, grants, lock order and validation.

Migrations 001–008 remain byte-frozen. Migration 009 remains phase-owned and repeatable. No D1 code writes canonical tombstones, receipts, outbox entries, approvals, or source business data.

## Verification

The focused `acceptance-tests/snapshot-runs.test.ts` suite passed **26/26** against the pinned owned PostgreSQL fixture. The 26 passing test cases were:

1. upgrades populated 001–008 registry facts through 009 and preserves every prior checksum;
2. applies and repeats migration 009, with API and worker limited to their exact run rights;
3. claims, starts, stages and publishes one immutable EXTRACTED manifest under the worker role;
4. restarts after terminating its owned PostgreSQL reader and publishes a fresh full scan (includes real D consumption, presence reset, two successful absence facts, 20-object baseline, exact 1/20 candidate, 2/20 all-scope pause and private audit);
5. persists the five second retry delay and fences a prior attempt after a fresh claim;
6. counts crash-after-start recovery toward the four durable start limit;
7. rejects page and manifest publication behind a newer typed tenant barrier;
8. activates, pauses, and resumes the PostgreSQL snapshot schedule as hub_api;
9. persists activation schedule and returns the same run for a same-key replay;
10. does not admit an overlapping manual request and exposes a durable callable due gate;
11. uses exact integer arithmetic for the five-percent boundary across independent entity scopes;
12. preserves same-key API-019 replay while a D reservation blocks new manual, due, and activation work;
13. admits and scans a due schedule from the strict worker loop without a manual run;
14. continues scanning admitted work when another due source is paused by a config edit;
15. serializes simultaneous manual and due admissions to one active durable run;
16. keeps the admitted run and schedule available after the API instance is recreated;
17. admits one due run under concurrent worker calls and leaves later calls behind the active fence;
18. fails closed when order line mappings are missing from the approved mapping revision;
19. fails closed when hard-delete absence has no safe source-version delete contract;
20. rejects manual and due admission behind a historical tenant barrier until a fresh approval;
21. ignores later barriers for another tenant, source, credential, entity, or channel;
22. revalidates OIDC binding after authentication for create, replay, detail, and list;
23. rejects a principal rebound or tenant disabled after OIDC authentication;
24. keeps run lists and details inside the authenticated tenant;
25. enumerates same-millisecond microsecond timestamps and UUID ties through HTTP pages;
26. rejects malformed route UUID, canonical date, cursor payload, and empty cursor safely.

`npm run typecheck` and `npm run build` passed after the final source changes. Formal 48-gate remains **NOT RUN**, as required for this D1 handoff.

## Not covered by this D1 gate

- Duplicate live source-key aliases fail closed in the freeze SQL but do not yet have a dedicated end-to-end alias fixture.
- The final suite does not force equal/backward C `completed_at` clocks; DB reservation ordinal ordering is implemented, but the timestamp tie case has no explicit scenario.
- Every individual current-proof drift field (each Owner/config/field-map/identity-map/profile/channel/delete-contract change) is not independently mutated in a D fixture. Existing C typed-barrier and admission tests cover adjacent fences, while D checks its exact proof and matching typed barriers in SQL.
- D worker crash/restart during consumption is not fault-injected. C continuation recovery is covered by the existing actual-process recovery cases.
- No D2 candidate approval/decision API, D3 logical-delete write, tombstone/receipt/outbox mutation, or API-060 member endpoint is part of D1.

## Captures and lifecycle evidence

The capture index is `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/capture-index.md`. The detached artifact manifest is `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/detached-manifest.json`, with its own checksum in `detached-manifest.sha256`. Three final gate metadata files identify the exact command, stdout/stderr/exit digests, `M0_RUN_EVIDENCE_ROOT`, execution root and actual HEAD at gate:

- Full focused suite: `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/gates/ebca33ef-a15a-41e9-a97b-6bdfaca6dc4f/capture-metadata.json` (external root `E:\m1t5-runtime\ebca33ef-a15a-41e9-a97b-6bdfaca6dc4f`).
- Typecheck: `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/gates/91663241-93d1-4fd8-84be-72b993717fbc/capture-metadata.json` (external root `E:\m1t5-runtime\91663241-93d1-4fd8-84be-72b993717fbc`).
- Build: `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/gates/33e1f484-8aeb-4413-9256-3cc70a12006c/capture-metadata.json` (external root `E:\m1t5-runtime\33e1f484-8aeb-4413-9256-3cc70a12006c`).

Per-source before/after raw SHA-256, LF-normalized SHA-256, byte sizes and Git blob bindings are in `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/source-bindings.json`. The original three gate metadata files recorded HEAD `854df4cfb2492a5cd70da7343131e49d58f8e407`. Git history confirms that commit’s parent is `3040666fa9da2de19ba7b8bf632c4765f278b455`; final product commit `68bfa36203be6446c47e0927ab9d982b5a380343` has the same parent and was created by amending 854df. There was no reset or rebase. `git diff 854df4cfb2492a5cd70da7343131e49d58f8e407 68bfa36203be6446c47e0927ab9d982b5a380343` is limited to `integration-service/acceptance-tests/snapshot-runs.test.ts` (9 insertions, 4 deletions) for child lifecycle instrumentation. The original `source-bindings.json` is a base-to-product binding, not per-gate before/after evidence; fresh per-gate captures below supersede the original three gates. The original binding records raw equality except the SQL migration CRLF checkout, whose LF-normalized digest matches its product Git blob.

Owned PostgreSQL IDs/labels/image digest/ownership/removal/absence and the two Node child PIDs/labels/exit signals/recovery events are individually captured under `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/owned-lifecycle/`. No secrets, `.env`, npm configuration, generated secrets, blocked host paths, or reference clone contents were copied into evidence. Earlier failed gate captures remain preserved by UUID with explicit per-file whitelists.

The product source/test commit is separate from the report/evidence commit. The report/evidence commit ID is recorded in the final handoff after it is created.

## Corrected gate binding and fresh final gates

The original gate HEAD `854df4cfb2492a5cd70da7343131e49d58f8e407` was a temporary product commit with parent `3040666fa9da2de19ba7b8bf632c4765f278b455`. Product commit `68bfa36203be6446c47e0927ab9d982b5a380343` also has parent `3040666fa9da2de19ba7b8bf632c4765f278b455`; it amended 854df and differs only by the test child lifecycle instrumentation noted above. No reset or rebase occurred. The earlier source-bindings file’s `before` values describe the base commit, not a true per-gate before snapshot, so it is not used to claim per-gate bracketing.

Three fresh gates were run against the committed D1 source with actual HEAD `4163984f28cde7e70a9452416e43b71a0afad7ee` (report/evidence commit whose parent is product commit 68bfa). Each gate has independent, actual `source-before.json` and `source-after.json` captured immediately around the command, containing HEAD and raw/LF SHA-256, byte sizes and Git blobs for all seven whitelisted source files. Every source file is unchanged across each gate and binds to the product tree; the SQL checkout’s CRLF raw hash differs while the LF-normalized hash matches the Git blob.

- Focused suite: 26/26 passed, exit 0, `E:\m1t5-runtime\df90d946-3af4-45cf-835f-6c65be2c8117`; package metadata and source manifests: `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/fresh-gates-4163984f-20261028/gates/df90d946-3af4-45cf-835f-6c65be2c8117/`.
- Typecheck: passed, exit 0, `E:\m1t5-runtime\e9e2ef4b-0e8f-40e1-9c06-200980cc593b`; package metadata and source manifests: `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/fresh-gates-4163984f-20261028/gates/e9e2ef4b-0e8f-40e1-9c06-200980cc593b/`.
- Build: passed, exit 0, `E:\m1t5-runtime\cbaef082-b59c-4b7c-a23c-34000369b8dc`; package metadata and source manifests: `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/fresh-gates-4163984f-20261028/gates/cbaef082-b59c-4b7c-a23c-34000369b8dc/`.

The corrected fresh-gate capture index is `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/fresh-gates-4163984f-20261028/capture-index.md`; its source-to-product commit comparison is `source-binding-summary.json`. The focused suite’s fresh owned PostgreSQL and Node lifecycle files are included under that bundle’s `owned-lifecycle/`. Earlier capture-wrapper setup failures were retained as external attempts and were not counted as npm gates.

## Fix1: round-one D1 review repairs

Product source/test commit: 634e0c84cf2cf3d7953feb1e03d35f3387b27dfd (parent 52732c6084ec91c7d94235ff6ac66e25e18198f8).

The five Important findings were addressed in migration 009, the serial D worker queue, and the owned-Postgres snapshot acceptance fixture:

- **I1 scope seeding:** a newly consumed scope seeds a first-absence fact for an existing live canonical identity only when a matching source/channel/epoch SNAPSHOT_OBSERVATION receipt binds the same full source key and canonical UUID. The current run is stamped on the seed, so the subsequent missing-key update cannot count the same run twice. Exact 1/20 remains at the allowed 5% boundary.
- **I2 delete contract:** the C-finish reservation admits only FULL_SNAPSHOT + SNAPSHOT_OBSERVATION + hard_delete. The worker defensively changes any ineligible reservation to SKIPPED before consumption; the tombstone fixture confirms no consumption and no busy state.
- **I3 bounded fairness:** the worker reads only its existing D reservation queue and orders sources by the DB-owned last_worker_checked_at, reservation ordinal, and stable keys. This is scheduling metadata only; immutable C source/run/proof facts do not change. The one-slot test creates a later actual C reservation and confirms its consumption while an earlier prepared candidate remains.
- **I4 latest test currentness:** D proof validity requires its frozen PASS test report to remain the newest report under the same source revision tuple using (created_at,id) ordering. Same-revision newer PASS and FAIL reports both stale the old reservation before consumption.
- **I5 prepared freshness:** bounded worker checks include both prepared PENDING and AWAITING_OWNER candidate cohorts. Config drift marks them STALE and clears the D busy guard; the AWAITING_OWNER case retains the policy pause and disabled schedule.

The TDD RED gate at base 52732c6084ec91c7d94235ff6ac66e25e18198f8 failed at the expected I1 assertion (new-scope first absence was 0, expected 1). Subsequent fixture/setup failures were retained as failed attempts and corrected before the passing gate; no failed attempt is represented as a successful gate.

Final fresh gates ran at exact HEAD 634e0c84cf2cf3d7953feb1e03d35f3387b27dfd; all seven whitelisted source files have independent before/after manifests for each gate. The migration raw checkout is CRLF while its LF-normalized SHA-256 matches the Git blob.

- Focused actual-C/owned-PostgreSQL acceptance file: **26/26 passed**, exit 0; external root E:\m1t5-runtime\de0f17b2-f53c-42ae-b56b-eeefbdf0eda4; copied capture docs/execution/alpha1/m1-task-5d1-evidence/fix1-46ade654-87b4-4fb0-a63c-492d44157101/gates/acceptance/.
- Typecheck: **passed**, exit 0; external root E:\m1t5-runtime\9203944f-c555-40cd-a3a1-0f6833bd183d; copied capture docs/execution/alpha1/m1-task-5d1-evidence/fix1-46ade654-87b4-4fb0-a63c-492d44157101/gates/typecheck/.
- Build: **passed**, exit 0; external root E:\m1t5-runtime\910b55ad-6d92-4f2c-8b79-627b92ab10f9; copied capture docs/execution/alpha1/m1-task-5d1-evidence/fix1-46ade654-87b4-4fb0-a63c-492d44157101/gates/build/.

The owned lifecycle whitelist is docs/execution/alpha1/m1-task-5d1-evidence/fix1-46ade654-87b4-4fb0-a63c-492d44157101/owned-lifecycle/; it records three exact owned PostgreSQL container create/image/remove/absence records and the test-created Node child IDs, kill/recovery events. The detached SHA/size manifest is docs/execution/alpha1/m1-task-5d1-evidence/fix1-46ade654-87b4-4fb0-a63c-492d44157101/detached-manifest.json with checksum a0f95810b295e58b1a65b82fbeac5149e57c9372af856bcc0e70662c7b6f4ac8; the capture index is docs/execution/alpha1/m1-task-5d1-evidence/fix1-46ade654-87b4-4fb0-a63c-492d44157101/capture-index.md. Only explicit whitelist artifacts were copied.

Formal 48-gate remains **NOT RUN**. This is D1 only; D2 and D3 remain reserved for their authorized phases.
