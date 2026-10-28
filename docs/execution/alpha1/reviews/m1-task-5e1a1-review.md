# M1-5E1a1 API-022 independent task review

Spec Compliance: FAIL.
Task quality: Needs fixes.
Findings: 0 Critical; 2 Important/P1; 3 Important/P2; 0 optional findings.

## Scope and reviewed pins

- Task-scoped review of BASE `4dc37f85f6c18abe39fe19a0bbdd308c24a0f73c` to product `a724c25fee95669bdeb2ceb9d88ec065cf0a4234` (fec4daa, 64e7302, a724c25). Documentation/evidence delivery subsequently updated at `707771d8c8ea80ce9b9b0a8b4e039b006beba5eb`; product findings below refer to a724c25.
- Read the binding task brief first, E master Global constraints, exact schema contract including its clarification, implementer report, and supplied 1,870-line U10 review package. Read the package in bounded chunks; the first output was truncated, so only the omitted sections were retrieved again. No new diff or Git state operations were run.
- Applied code-review-and-quality and the subagent-driven-development task-reviewer prompt. Explicit read-only review instructions override mutation-test advice. No suite, build, mutation experiment, resource operation, or subagent was run. The only checkout write is this report.

## Strengths

- `integration-service/etl-worker/snapshot-recovery.ts:32` and `integration-service/ingestion-api/snapshot-routes.ts:33` implement the narrow bigint/reason/key boundary and current source:write check; the global barrier guard precedes the existing current-principal identity locks at snapshot-recovery.ts:38. There is no Owner-only restriction on API-022.
- `integration-service/migrations/009_snapshot_runs_and_recovery.sql:2684` adds recovery state only to unreleased 009. Operation identity is append-only, the child freezes the parent's proof, and admission preallocates a QUEUED first attempt without starting it (lines 2871-2895). Original run, attempt, stage, outcome and range facts are not reset by this admission.
- `integration-service/etl-worker/snapshot-stage-store.ts:85` copies immutable stage facts into child coordinates with explicit recovery_source provenance; ordinary child manifest completion and C semantic validation remain authoritative. `integration-service/etl-worker/snapshot-apply-worker.ts:141` uses successful original ranges only after digest equality, while unapplied aggregates still use canonical helpers and child outcome/progress in the caller's transaction.
- `integration-service/migrations/009_snapshot_runs_and_recovery.sql:3159` excludes SEALED completion from new D reservation, checks prior FRESH lineage reservations before clearing the source slot, and leaves independent normal run reservation behavior in the existing path. New definer functions use fixed search_path and explicit role grants/revokes (lines 2900-2903, 2996-3001, 3127-3136).

## Findings

### [P1] Allow the successful later B attempt to reuse the original observation

`integration-service/migrations/009_snapshot_runs_and_recovery.sql:3034`

The SEALED observation lookup requires `o.child_attempt_id=p_attempt_id`. The operation's child_attempt_id is the immutable first attempt returned by the 202. If that B worker dies during page copying, the existing crash fallback marks that attempt incomplete and begin_etl_snapshot_attempt creates ordinal 2 or later (009:450-466, 477-494). The recovery manifest/page loaders allow that live later attempt to copy and complete normally, but its C claim then reaches this predicate with the later attempt ID. No operation matches, observation returns NULL, and snapshot-apply-worker.ts:222 fails with SNAPSHOT_OBSERVATION_ALLOCATION_FAILED. An otherwise recoverable copy interruption therefore makes the recovery child unable to complete in SNAPSHOT_OBSERVATION mode.

Keep the immutable 202 attempt identity; verify the actual claimed child attempt and its child manifest/provenance against the operation rather than requiring every execution to be the first reserved attempt. Add a focused owned-PG case that interrupts SEALED B, completes a later B attempt, and verifies original OBS value/time and zero new allocation/D reservation.

### [P1] Renew the B claim while copying a sealed stage

`integration-service/etl-worker/snapshot-worker.ts:98`

The SEALED branch awaits copySealedStage and continues before the heartbeat is installed at line 108. Copying performs separate transactions for each source read and child write and never renews the claim itself (snapshot-stage-store.ts:85-128). A valid large stage or slow destination that takes longer than the configured lease (60 seconds by default) loses the lease before completion; all later page/manifest checks reject it. Repeating the same bounded copy can exhaust four starts without any source or semantic defect.

Start claim renewal before dispatching either FRESH or SEALED work, preserve cancellation/lost-lease handling, and stop renewal in the common finally path. Verify a copy lasting longer than its initial lease completes, while a genuinely stale holder still cannot write.

### [P2] Do not serialize an absent failure version as the literal string undefined

`integration-service/etl-worker/snapshot-runs.ts:67`

summary() now emits failure_version for every FAILED/INCOMPLETE row, but SELECT_SUMMARY (lines 196-198) does not select failure_version. API-020 listSnapshotRuns uses that projection at line 314; API-019 existing-result queries use it too. Those paths therefore return `failure_version: "undefined"` for terminal failures. API-021 happens to work because its detail query explicitly adds the column at line 367. The shared summary change introduces an invalid public CAS value outside that detail path.

Include failure_version in every projection feeding this field, or restrict the field to the detail representation with an explicit typed input. Check a failed list entry as well as the already covered detail response.

### [P2] Exercise an actually accepted operation in the disablement replay test

`integration-service/acceptance-tests/snapshot-recovery.test.ts:502`

The test named "does not replay an accepted operation after caller disablement" sends `snapshot-recovery-red`. In the final suite, the successful initial operation is instead accepted under `snapshot-recovery-race-a` or `snapshot-recovery-race-b` at lines 82-87. The default red key is never successfully submitted. Counting all operations before and after does not establish that this key has a cached 202. The test proves rejection of a fresh request by a disabled user, and would also pass if replay-specific currentness were removed.

Retain the exact accepted key, original run and normalized body (or create an isolated accepted operation), assert that matching operation exists, then revoke/disable and replay that exact tuple. Preserve the no-new-operation assertion.

### [P2] Capture loaded dist binding in a fresh gate; historical post-run hashes do not meet the required oracle

`docs/execution/alpha1/m1-task-5e1a1-report.md:47`

The report and the permitted post-run observation explicitly say neither Node child emitted a loaded-module digest. The command snapshots cover 14 source/document paths, not dist. The artifact hashes were collected after the gate; import paths and modification timestamps do not prove that those bytes were the ones loaded by the two historical crash processes. This leaves the brief's explicit build-to-loaded-dist binding requirement unverified. The historical crashes and 4/4 result remain valid within that qualification.

After the product fixes, capture a fresh build artifact manifest and have each owned Node child identify/hash the actual dist entry it imports, bound to PID, run ID and the gate/build capture. Preserve the old captures and label their historical limitation; do not backfill an inferred historical load digest.

## Evidence and verification checks

- Read permitted external final command.json/stdout.txt/stderr.txt for `2d38489d-1b00-4c77-9fe0-d23182dcfb29/final-build`, `0d334fbb-2a2f-4918-8ff1-72d843f38ad7/final-typecheck`, and `ef2d8618-ad0f-4b81-9bde-15b31261a8a4/final-snapshot-recovery`. All report actual HEAD a724c25 before/after and exit 0; final stderr contains no warning/error. Build finished 08:25:01Z, before the 08:25:21Z test gate. Final focused output reports 4/4.
- Independently recomputed current raw SHA-256, LF SHA-256, raw size, and Git blob SHA-1 for all 14 explicit source paths in each of the three original before-source manifests. Each matches its recorded after-source entry and actual current source: 42/42 records, 0 mismatches. Git blob hashes were computed from canonical LF bytes with the Git blob header, without Git commands or index writes.
- Substantive test inspection: customer FRESH/SEALED HTTP case at snapshot-recovery.test.ts:64, real two-line order recovery at line 373, actual role grant separation at line 486, disablement case at line 496. The main case exercises actual C children killed before/after aggregate COMMIT, and asserts identity/object/outcome/range/receipt/outbox plus checkpoint atomicity (lines 254-306). The order case checks original O100 receipt/outbox, O200 absence, exact two-line O200 output, original facts/OBS immutability and ordered outbox prefix (lines 373-484). These cases do not exercise interruption of the SEALED B copy or a copy exceeding the initial lease.
- Read the exact original PostgreSQL lifecycle log under `ef2d8618-ad0f-4b81-9bde-15b31261a8a4/m1task5/e6c579e0-3234-4836-b21e-75481e75af1a/postgres-lifecycle.jsonl`: one created/image_observed/removed sequence, pinned postgres digest 029660..., container 63c892..., ownershipConfirmed and containerAbsentAfterRemoval true. One shared fixture for four tests is consistent with beforeAll/afterAll.
- Read the permitted replacement manifest `docs/execution/alpha1/m1-task-5e1a1-evidence/a4cd38fd-c4e3-4a0c-8fea-95eced2c4225/evidence-manifest.json` and selected named copies. It declares 27 unique original-to-destination pairs. The controller independently reports 27/27 original/destination byte/hash equality; this review independently checks substantive contents and the 42 source bindings above, and does not present the controller's package hashing as its own operation.
- Read the replacement package's genuine RED stderr: HTTP expected 202, received 404, at test line 13; exit 1 and one failed test. Read the retained 64e diagnostic: expected/received checkpoint JSONB text ordering/spacing difference, plus its explicitly controlled C failure log. The final a724 assertion compares structured JSONB while retaining text precision assertions. Neither historical failure is relabeled as a final gate failure.
- Final test stdout records actual child PIDs 40740 and 25100, run cb7df164-86ba-413a-bbf7-8eee82726fd6, before/after COMMIT SIGKILL. The replacement observation records both PIDs absent at 08:34:34.784Z; this is a later absence observation, not an inferred exact exit time.
- The policy note identified b1f6295c-6bb2-4c46-b12b-b544d8c03a66 as blocked and non-authoritative. The controller withdrew the original contrary dispatch instruction. This reviewer never opened or enumerated that directory. All substantive evidence reads were the explicit original external paths or the separately authorized a4cd replacement; no blocked target, secret/config file, partial D artifact, reference clone or helper cleanup was accessed.

## Named checks outside changed hunks

- Reserved-attempt and four-start compatibility: checked only 009's existing begin/claim/failure functions at lines 424-565. They consume QUEUED first identity, then allocate later attempts and use existing 5/30/120 crash fallback. This check exposed finding 1; no claim-inspection start was added.
- Lock order/currentness risk: checked only AuthService assertCurrentPrincipal and identityByOidc (auth/service.ts:105-132,407-412), lock_api_identity (004:12), lock_source_credential and security guard (006:5,117). The global guard is an exclusive transaction advisory lock; current-principal rows are locked before admission and held in the caller transaction. The differing inner source/run order in recovery loaders does not establish a deadlock between guarded worker transactions because the common guard serializes them.
- Canonical/progress transaction risk: checked only the truncated applyOne/processClaim boundaries (snapshot-apply-worker.ts:131-180,182-234), canonical frozen context checks (normalization/apply.ts:69-135), existing C proof/assert functions (009:723-749,848-877) and aggregate writer (009:1070-1094). Existing canonical helper calls and false-outcome rollback remain in one PoolClient transaction; new reuse is child-local and exact-scope claim guarded. No second canonical writer was introduced.
- Shared representation risk: checked only SELECT_SUMMARY and its named call sites in snapshot-runs.ts:196-198,206,243,314,367. This exposed finding 3.

## Limits and required next gate

- Cannot verify / required acceptance gap: the incomplete-extraction acceptance fixture marks an unstarted run INCOMPLETE directly (helpers/snapshot-recovery-http.ts:106-108,116-120). The source-writer changes occur before the child scan; the four cases do not demonstrate a genuinely interrupted partial original scan with changed source rows between attempts. The code follows the ordinary full FRESH scan path, but that particular required acceptance oracle is not established by these captures.
- No independent runtime rerun was needed to establish the source-level contradictions above, and none was authorized as a suite repetition. Required Fix 1 validation should cover the two B lifecycle cases, the failed summary projection, the actual accepted-key revoke replay, and fresh loaded-dist evidence. Keep whole M1/E integration, formal 48, site/Hermes/production, API-023/024/remap/cutover and deployment unclaimed.
- Approval cannot be given until the five findings are corrected and the focused new gate is reviewed. No whole-M1 or whole-E verdict is made here.
