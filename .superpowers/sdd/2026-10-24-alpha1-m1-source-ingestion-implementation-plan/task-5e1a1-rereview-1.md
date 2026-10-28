# M1-5E1a1 Fix round 1 independent rereview

Spec Compliance: FAIL — one prior mandatory evidence finding remains open.
Task quality: Needs fixes — evidence binding only; no remaining product defect found in this scoped fix diff.
Prior findings: 4 ADDRESSED, 1 NOT ADDRESSED. Remaining severity: 1 P2; 0 P1/Critical.
Prior real-partial-original/source-writer acceptance gap: ADDRESSED.

## Scope

Read the policy-blocked-host-artifacts note first, binding E1a1 brief, prior review, Fix1 report supplement, and the complete 824-line U10 Fix1 review package in three bounded chunks. Reviewed product `55bc0ea1605952baa967ec81c6a4cc90564879c6`, range `707771d8c8ea80ce9b9b0a8b4e039b006beba5eb..55bc0ea1605952baa967ec81c6a4cc90564879c6`, and evidence/report delivery `4bc2ebf837b7478c57519c2421b7b95f288108f5`. Applied the previously loaded code-review-and-quality/task-reviewer instructions with the explicit read-only override. No tests, builds, resources, Git state operations, subagents, or broad source audit were run. Only this rereview report was written.

## Prior finding verdicts

### 1. P1 SEALED OBS pinned to the first child attempt — ADDRESSED

`integration-service/migrations/009_snapshot_runs_and_recovery.sql:3034`

The operation lookup no longer requires the immutable accepted first child_attempt_id to equal the actual later C attempt. Before returning the original sequence, the function still requires an exact live C claim and matching semantic/scope seal. Its new EXISTS binds the actual child run/attempt to an EXTRACTED manifest, a COMPLETE attempt with the same operation_id, the manifest's actual attempt_id, and exact original recovery-source run, attempt, digest and copy-kind (lines 3038-3047). It returns the original observation without inserting a child observation or changing the immutable operation.

The test interrupts the first copy after a persisted page but before manifest completion, observes ordinal 1 INCOMPLETE/no manifest, then completes ordinal 2 and verifies C claims the later ID rather than the response's first reserved ID (`snapshot-recovery.test.ts:331`,369,379). Final assertions preserve original OBS value/time and facts, zero child observation, unchanged D reservation count, and successful canonical progress (lines 477-497). Existing NULL/old/expired C claim checks now target the actual later attempt. Final captured 4/4 supports this path.

### 2. P1 SEALED B copy has no heartbeat — ADDRESSED

`integration-service/etl-worker/snapshot-worker.ts:94`

The common heartbeat is started immediately after beginAttempt, before proof loading and FRESH/SEALED dispatch. Both branches share the existing stop/finally cleanup and lease loss flag; the SEALED path checks lease loss after copying. No claim inspection or extra begin/start was introduced.

The slow-copy fixture delays outside the page-write transaction after COMMIT (`snapshot-recovery.test.ts:108`), so its 11.5-second delay does not hold the global transaction guard and artificially prevent renewal. The worker's configured lease is 10 seconds (line 353). Captured DB values show initial expiry 09:17:33.825422Z, initial observed time 09:17:23.840357Z, later observed time 09:17:35.362890Z, and renewed expiry 09:17:43.861345Z. Thus the run exceeded its initial lease yet retained a live renewed lease and completed ordinal 2 (lines 368-372).

The retained heartbeat RED shows initial expiry actually exceeded by the later DB clock and a failing expiry assertion. This is evidence of the original heartbeat defect rather than an arbitrary sleep-only test.

### 3. P2 failed shared summaries emit string undefined — ADDRESSED

`integration-service/etl-worker/snapshot-runs.ts:197`

SELECT_SUMMARY now selects failure_version, so all existing shared summary query/RETURNING uses supply the persisted field. The API-020 failed list case asserts the actual original run returns string `1`, alongside API-021 detail (`snapshot-recovery.test.ts:173`). Retained RED shows received `undefined` versus expected `1`; final focused gate passes.

### 4. P2 disablement test uses an unaccepted key — ADDRESSED

`integration-service/acceptance-tests/snapshot-recovery.test.ts:197`

The successful concurrent winner's original run, exact key, reason and failedVersion are retained as acceptedRecovery. The disablement test verifies one stored operation for that key and parent before disabling the caller, then sends the exact accepted tuple and asserts 401/no data/no additional operation (lines 653-672). It now exercises a request with an existing cached accepted result. Final verbose output confirms this fourth test passes.

The summary/replay RED capture's undefined acceptedRecovery failure is a downstream fixture dependency after the earlier summary assertion failed; it is not an independent demonstration of a replay authorization product bug. The corrected final test and source inspection establish the requested regression protection.

### 5. P2 build-to-loaded-dist binding — NOT ADDRESSED (partially improved)

`integration-service/acceptance-tests/snapshot-recovery.test.ts:42`

The new child-side pre-import hashing is real: each child reads the named module bytes, emits SHA-256/size/PID/run/build-label, and then dynamically imports that same URL (lines 48-52). The parent compares these values to a hash it reads from the live dist path immediately before spawning (lines 44-45,77-78). Both final children emitted `f0a1422b1560cfc25b362588a0af69e9f63ce28b87c354cce8691d2228b643cc`, 15,569 bytes. The corresponding PID/phase/run/attempt COMMIT-hook events bind those executions to the tested aggregates. This closes the original absence of child runtime hash records.

However, `buildCaptureId` is an environment label (defaulting to UNBOUND_BUILD_CAPTURE), not a digest read from the build's output record. The final build command.json and the captured Invoke-Captured.ps1 wrapper record the source snapshots and command exit but no generated dist output hash. The six-file before/after lists contain source files only. The separately generated post-run observation records a post-run artifact-path hash, explicitly after the build/test. Therefore equality between parent/child live-path hashes and a matching build label does not establish that the hashed bytes were the output of build capture `3fa990a2-cbf1-47cc-9f4d-648d89465568`. The original explicit build-to-loaded-bytes requirement remains unverified.

Required correction: run a fresh build capture that persists the resulting dist entry path, size and SHA-256, source HEAD and build-capture ID before the child test gate. Bind the two runtime entry hashes to that persisted output digest (in the test or by an explicit recorded verification), retain source before/after records, and preserve all current historical evidence with this qualification. No product runtime redesign or broad suite is required.

## Required partial-original/source-writer oracle — ADDRESSED

`integration-service/acceptance-tests/snapshot-recovery.test.ts:141`

The original fixture no longer marks the initial queued run INCOMPLETE synthetically (`helpers/snapshot-recovery-http.ts:106`). The case now runs the actual read-only source connector with page size 1, interrupts its second fetch after a page has been committed, and reaches four failed durable starts. It asserts a FAILED original, four persisted pages/facts and no manifest (line 160), then freezes original attempt/error/page/fact state.

After API acceptance it updates source C1 and inserts C2 before the child reads the source, then the actual FRESH worker opens one source connection and fetches both rows, validates/applies to COMPLETE with two aggregates, and checks the original state unchanged (lines 219-253). The later canonical assertion retains changed C1's name. The code remains the ordinary full FRESH scan; it introduces no partial cursor/splice path. This satisfies the previously missing bounded acceptance scenario. Test-only available_at changes accelerate the existing retry schedule; this case does not independently certify real elapsed 5/30/120 delays, whose existing implementation is unchanged by Fix1.

## Evidence checks

- Permitted new manifest: `docs/execution/alpha1/m1-task-5e1a1-fix1-evidence/b526bf7f-43bb-463d-bcde-b94bf972312c/evidence-manifest.json`, recorded SHA-256 `94a528b90dfa6e2c82be9f91486a2020275a83029229343b364e56bdfe42522f`. Read its 32 explicit source/copy pairs and separate generated_observation metadata. Controller reports independent original/copy length+SHA equality 32/32; this report does not claim to have rerun that controller operation.
- Independently recomputed actual raw bytes SHA-256, LF SHA-256, byte size and Git blob SHA-1 for all six listed current source files against each of the final build/typecheck/focused before and after records. Result: 18/18 source brackets match, no byte or blob mismatch. The six postimages also match the review package's blob prefixes. The first read-only helper used the repository root for paths that were relative to integration-service and reported file-not-found; rerunning with the command.json cwd resolved that helper error. It was not a product/source mismatch and touched no files.
- Read final three command/stdout/stderr captures directly at their explicit external roots: build `3fa990a2...`, typecheck `caed6e17...`, focused `1ce86f6c...`. All have actual HEAD 55bc0ea before/after and exit 0. Build finished 09:17:05.529Z before the focused gate began 09:17:18.701Z. Verbose focused stdout reports all four named tests passed.
- Build/typecheck stderr each contain only the captured newline. Focused stderr is 1,204 bytes and contains two intentional afterAggregateCommit fixture failure logs at source lines 281 and 541. Both correspond to the explicitly injected customer/order failures needed to create recoverable original stages; they are qualified fixture diagnostics, not silently empty output or unexplained gate failures.
- Read three retained RED stderr captures. Summary RED establishes the string undefined defect and includes downstream fixture failures. Heartbeat RED establishes actual expired DB lease. The OBS diagnostic capture logs SNAPSHOT_OBSERVATION_ALLOCATION_FAILED after the later-attempt scenario, but also has a page-count assertion mismatch and a downstream worker-count failure; it is retained with those qualifications, not presented as an otherwise pristine isolated test failure. Final Fix1 code/test and 4/4 cover the corrected path.
- Final runtime child events: PIDs 30468/9992, run `27b142f2-e927-45e5-965d-5960b40b4c0b`, attempt `6a17b25d-dc30-4ac4-a74a-71a782e19f2a`, C-REC-4, before/after COMMIT SIGKILL. The tests assert zero six-way effects at checkpoint C3 before COMMIT and all six effects/checkpoint C4 after COMMIT. Attempt ID was added only to existing hooks and does not alter canonical helper transactions.
- Read the exact allowed generated `runtime/post-run-observation.json`: PID checks are at 09:17:49.807Z/09:17:49.812Z, later than the gate. These are later absence observations, not exact exit timestamps. Its post-run dist hash matches the child runtime hashes, subject to finding 5's build-output limitation.
- Read the final owned PostgreSQL lifecycle: container `a403e574d312ca030ace54adddd134003aae276a07f65e32cd455f904b0baab0`, pinned image `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`, one created/image_observed/owned removed sequence, containerAbsentAfterRemoval true. No resource was inspected or changed by this reviewer.
- The blocked b1f package and all other policy targets were never opened or enumerated. Reads were limited to named source context, the supplied diff/report, explicit final external captures and the authorized b526 package files. No secret/config/reference clone or unrelated incomplete artifact was accessed.

## Scoped quality and remaining gate

The production changes are narrow: common heartbeat placement, one shared summary column, stronger child-manifest provenance in the SEALED observation lookup, and attempt IDs on existing test hooks. They retain the original observation, child identity/claim fences, canonical writer and outcome transaction, and existing normal D behavior. No new product breakage was found within this Fix1 range. No out-of-scope product observations were promoted into findings.

Approval remains withheld only for the existing P2 build-output-to-runtime digest requirement. Capture and review that narrow fresh gate. Whole M1/E integration, formal 48, site/Hermes/production, E1a2/API-023/024/remap/cutover and deployment remain outside this task verdict.
