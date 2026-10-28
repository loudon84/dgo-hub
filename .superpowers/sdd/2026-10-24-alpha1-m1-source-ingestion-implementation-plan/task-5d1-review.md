# Spec Compliance

- **FAIL — issues found.** Five Important defects prevent acceptance of M1-5D1: missing initial absence facts after scope change, reservation of tombstone-only contracts, starvation behind prepared cohorts, acceptance of superseded test/approval proof, and failure to invalidate `AWAITING_OWNER` cohorts on drift.
- **Quality: Needs fixes.** Critical: **0**. Important: **5**. Minor: **0**. The findings below are source-derived behavior defects; the uncovered assurance cases are listed separately.
- Reviewed task requirements, including all controller appendices, against the integration-service review package for `3040666fa9da2de19ba7b8bf632c4765f278b455..68bfa36203be6446c47e0927ab9d982b5a380343`. Evidence handoff is `76f6111`; the corrected fresh capture index is the final verification oracle. This is a D1 task gate, not a whole-branch audit or approval for D2/D3.

# Strengths

- `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1378` inserts the D reservation inside successful C finish before clearing `active_run_id`. Existing `assert_etl_snapshot_continuation` takes the global guard and source lock (`:728`), preserving serialization across this handoff.
- `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1188` gives reservations a database ordinal. Consumption uses that ordinal at `:1637`, and freeze refuses unconsumed pending reservations at `:1450`, so the intended accounting order is independent of completion clock precision.
- `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1680` inserts observed stage-header keys into presence without requiring canonical identity; explicit tombstones therefore still reset absence. Full tenant/source/entity/key joins are retained throughout membership selection.
- `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1522` counts distinct live canonical UUIDs for each entity denominator. Duplicate live aliases fail closed before freeze at `:1480`; headers and members have restrictive scoped FKs and immutable triggers (`:1250`, `:1275`, `:1308`).
- `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1318` uses exact numeric cross multiplication, including the exactly-5% boundary. Freeze creates all entity headers before the source-level decision and atomically pauses/disables scheduling, records `SYSTEM_POLICY` with the actual database invoker, and preserves frozen Owner approval as provenance (`:1593`–`:1612`).
- `integration-service/etl-worker/snapshot-runs.ts:235` validates the current principal before cached replay, and `:241` returns a matching durable replay before `lockedProof` applies D busy checks. New manual/due admissions and activation use the existing conflict behavior (`:99`, `:262`; `integration-service/source-registry/service.ts:555`).
- `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1396` revokes D base-table rights from runtime roles, granting the worker reservation SELECT and the consumption procedure only. D1 adds no canonical-delete, receipt, outbox, approval, member API, or source connector write.

# Issues

## Critical — none

## Important

### I1 — Seed missing live keys when starting a new stable scope

**Location:** `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1684`–`:1704`, especially `:1689` and `:1702`.

The only insertion of a scoped streak selects this run's **present** keys. The subsequent absence UPDATE can only change a streak that already exists under the new scope digest. If key K was live under scope A, disappears, and the next eligible run uses approved scope B, K has no B row to update. Every later B run that also omits K still inserts nothing for K. This also affects a live canonical key missing from the first D-accounted snapshot. K never reaches absence count 1 or 2, although the binding requirement says the first complete absence in the new scope starts at 1 and the next distinct eligible absence reaches 2. Old A facts remaining in the table do not repair the missing B fact.

**Fix:** Inside the same consumption transaction, seed the current scope's eligible full live source identities that lack a scoped streak, with observed keys reset to presence and missing keys initialized to this run's first absence. Retain previous scope facts, and avoid incrementing a newly seeded row twice. Add an actual-C regression covering a key already missing on the first run after a scope change, followed by a second complete missing run.

### I2 — Require the approved inferred-absence delete contract before reserving D

**Location:** `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1347`–`:1349`; contract values are defined/validated in `integration-service/source-registry/service.ts:18` and `:105`.

Reservation tests FULL_SNAPSHOT, SNAPSHOT_OBSERVATION and entity channel domains, but never tests the delete contract. The actual supported enum is `tombstone | hard_delete`; an approved OBS source using `tombstone` therefore becomes PENDING and is subsequently consumed because proof-current merely checks that its contract equals the frozen contract (`:1423`). Explicit tombstone keys are correctly treated as presence, but a missing source row under that tombstone-only agreement is incorrectly eligible for inferred absence, candidate freeze and source-wide policy pause. Even without a candidate, the unsupported contract temporarily occupies D busy state. The binding brief requires safe SKIPPED with no busy reservation when inferred absence was not approved.

**Fix:** Gate PENDING on the actual approved hard-delete/inferred-absence contract as well as the observation domain; reserve a SKIPPED summary otherwise. Repeat the eligibility check defensively during consumption. Add a real C-completed OBS/tombstone case proving SKIPPED, no absence facts/candidates and no D admission block.

### I3 — Prepared PENDING cohorts permanently monopolize the worker source limit

**Location:** `integration-service/etl-worker/snapshot-delete-worker.ts:6`–`:7`; `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1475`–`:1476` and `:1612`–`:1613`.

The source scan takes the lexically first 20 PENDING sources. A successfully frozen, nonempty cohort at or below 5% deliberately stays PENDING for D2/D3. On every later tick its consumption call finds no unconsumed run and freeze returns false because the candidate already exists. Those sources nevertheless keep occupying the same LIMIT slots forever. Once 20 early sources hold prepared cohorts, all later sources' C-complete reservations are never consumed, and their new C admissions remain blocked indefinitely. No retry or restart changes the ordering.

**Fix:** Distinguish actionable accounting/freezing work from already prepared cohorts in the worker's bounded selection, or use a durable fair cursor. Preserve a separate bounded freshness check for prepared cohorts. Add a deterministic case with more sources than the configured limit and prepared early cohorts, proving a later unconsumed reservation progresses.

### I4 — Superseded capability-test proof still authorizes D consumption and freeze

**Location:** `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1416`–`:1424`.

The current-proof predicate only requires the original bound test row to remain PASS. A new capability test can be recorded without changing config, field-map, identity-map, credential or Owner revisions. The source service records the new report and sets lifecycle to TESTED or DRAFT (`integration-service/source-registry/service.ts:489`–`:500`). C admission explicitly rejects an approval whose test has been superseded (`integration-service/etl-worker/snapshot-runs.ts:172`). D omits that check and ignores this lifecycle/proof change, so an old completed cohort can still advance streaks and freeze candidates after a newer FAIL or after a newer PASS awaiting fresh approval. Excluding ordinary source_epoch to preserve D's own pause is correct, but it must not also preserve superseded approval authority.

**Fix:** Check that the bound approval/test remains the current accepted proof, including the established newer-report rule and relevant frozen digest/provenance bindings, before any facts are advanced and before freeze. Keep D's own PAUSED/ordinary-epoch transition valid. Add unchanged-revision PASS/FAIL retest cases between C completion and D consumption.

### I5 — Above-threshold cohorts never become STALE after Owner/config drift

**Location:** `integration-service/etl-worker/snapshot-delete-worker.ts:7`; `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1454`–`:1455` and `:1612`.

An above-threshold cohort transitions to AWAITING_OWNER. The worker selects only PENDING sources, and freeze likewise selects only PENDING runs, so that cohort can never reach either existing freshness check again. If its Owner, config, mappings or channels change, the immutable candidate correctly retains old proof but its run remains busy AWAITING_OWNER forever. After the user obtains fresh approval, activation still fails the new busy guard (`integration-service/source-registry/service.ts:559`), leaving no D1 transition that invalidates the obsolete cohort and releases its reservation. This violates the required stale-on-current-proof-drift behavior. D2/D3 are outside this implementation and cannot be assumed to repair this D1 state machine.

**Fix:** Provide a bounded worker path that validates all prepared unresolved cohort states, including AWAITING_OWNER, and atomically marks obsolete cohorts STALE while preserving the source pause and disabled schedule. Keep candidate facts immutable. Add an over-threshold actual-C cohort, then change Owner/config proof and prove STALE, busy release, and preserved pause state.

## Minor — none

# Verification checked

- **No tests, mutations, resource operations or product edits were run by this reviewer.** The only write is this review file. The prescribed mutation experiment was not performed because the task explicitly prohibits test/source mutation and repeats of captured gates.
- Independently recomputed size and SHA-256 for all **137** detached-manifest entries: **0 mismatches**. Read the actual three fresh stdout/stderr and metadata, rather than accepting report booleans. Focused suite stdout reports **26/26**, one test file passed; typecheck/build report their compiler commands; all three exits are **0**, all stderr files are empty. Files are under `docs/execution/alpha1/m1-task-5d1-evidence/9b96aa3b-675c-42cd-8ac7-8978e85bca63/fresh-gates-4163984f-20261028/`.
- For each gate, independently compared all seven source-before/source-after records: unchanged paths, sizes, raw SHA-256, LF SHA-256 and Git blob IDs. Recomputed current source hashes and read the corresponding committed `68bfa362...` blobs: **0 mismatches**. SQL checkout CRLF explains the raw difference; its LF hash equals the committed blob hash. All six other files match raw committed bytes. Actual captured HEAD is **4163984f28cde7e70a9452416e43b71a0afad7ee** before and after every gate.
- Read commit objects: both historical `854df4c...` and final product `68bfa362...` have parent `3040666f...`; `4163984f...` has parent `68bfa362...`. Compared the seven named blobs across 854df/68: only `snapshot-runs.test.ts` differs, **9 insertions/4 deletions**, matching the visible lifecycle instrumentation. This verifies the ancestry and source delta; the statement that no reset/rebase command occurred is historical process testimony, not provable from these commit objects alone.
- Compared committed migration blobs for **001–008** at BASE and product: all eight byte-identical. The package adds D to phase-owned 009 and does not weaken migration checksums or represent an old-009 checksum replacement as a deployed upgrade. The captured populated-001–008/009-reapply tests are accepted as local execution evidence.
- Read the fresh owned lifecycle records: three pinned PostgreSQL containers have created/image-observed/removal records with matching IDs/labels/digest, ownership confirmation and absence-after-removal; two owned Node PIDs have spawn, SIGKILL/exit and recovery records. These are local fixture records, not evidence about external services or current resource state.
- Original `source-bindings.json` is historical BASE-to-product evidence, not per-gate bracketing. The fresh per-gate manifests supersede the original gates. Formal **48 gates remain NOT_RUN**; site, real CRM/Hermes/SQL Server and UI behavior remain unverified.

# Focused checks outside diff

- **Risk: reservation/admission or canonical membership races.** Checked existing `assert_etl_snapshot_continuation` and `lock_etl_snapshot_source` in 009, `sourceRow` locking, canonical apply's guard/source credential entry, and the global advisory guard in migration 006. The common global transaction guard serializes the freeze reads and existing canonical writers; source lock ordering closes the C-finish admission gap.
- **Risk: cached replay rejected by D busy state.** Read the unchanged `createSnapshotRun` transaction around the changed `lockedProof` call; current-principal validation precedes the durable replay lookup, and matching replay returns before new admission.
- **Risk: D accidentally changes observation reuse.** Checked existing `persist_etl_snapshot_observation` (`009:1035`) and C scope digest/proof validation. The allocator still considers only the latest high-water allocation and requires a successful COMPLETE binding; D uses the already-bound numeric OBS and database completion time.
- **Risk: unsupported delete contracts and stale approval proof.** Checked only source config parsing, the capability-test finalization path, existing C admission's proof selection and the C frozen-proof loader. These checks establish I2 and I4; they did not expand into a registry-wide audit.
- Read the named schema-contract document. The supplied product diff excludes that planning file; its seven-file source binding was independently verified with the other capture sources. Git plumbing reads above were restricted to named commit metadata and blob comparisons needed for required evidence verification; no Git state changed.

# Uncovered assurance — separate from the five defects

- The 26 passing cases do not prove the changed-scope/already-missing, OBS/tombstone-SKIPPED, superseded-test, prepared-source starvation, or AWAITING_OWNER-drift behaviors above. These need focused regressions with the fixes.
- Dedicated D fixtures are still absent for duplicate live aliases, equal/backward completion clocks, every individual current-proof drift field, D consumption crash/restart, matching versus unrelated barriers applied specifically between C COMPLETE and D, and simultaneous C-finish/new-admission handoff. Existing adjacent C tests are useful but do not establish those D interleavings.
- The added membership test binds the candidate OBS to its second run but does not explicitly compare the first and second absence-run OBS values. No additional fixture proves the blocked `OBS <= last presence` branch, multiple queued complete cohorts with newer presence, or an already-admitted C drain under a pending D reservation.
- D table/procedure grants can be inspected in the diff, and actual API/worker paths run in the capture. The changed tests do not independently exercise every new D table's denial of direct API/worker DML or each immutable trigger. In particular, `etl_snapshot_delete_run` has no selective update trigger protecting its reservation identity/original C binding fields; runtime roles lack direct UPDATE, so no current authorized corruption path was established. Its schema-contract claim of guarded immutable reservation fields should be reconciled explicitly before relying on it in D2/D3.
- Live runtime endpoint-allowlist changes outside the stored approved config are not checked by D's SQL-only entry point and are not exercised by this evidence. The controller should clarify whether such external profile changes are required to stale D immediately or only when a new durable config/test proof records the change.

# Assessment

**Spec: FAIL. Quality: Needs fixes.** The captured gates are authentic and source-bound, and the implementation has useful transaction and authority boundaries. They do not cover the five source-derived defects above. Fix and independently review D1 before authorizing D2.
