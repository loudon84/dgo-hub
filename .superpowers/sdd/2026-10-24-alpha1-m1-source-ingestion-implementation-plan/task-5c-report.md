# M1-5C snapshot validation, observations, and apply report

## Status

The M1-5C implementation is committed for independent review. M1-5 remains in progress pending review and the integrated phase gate. The formal 48-case suite is **NOT_RUN**. This work makes no site or production acceptance claim.

Implementation commit: `b32b746943d6feec97641c31b093b068ab51d4a9` (`Implement M1 snapshot apply continuation`), based on requested BASE `9e12d44be952cebae4b6286ea92cf1b1b29497ae` on `feat/alpha1-implementation`.

## Implemented

- Extended phase-owned migration 009 with immutable stage page coordinates, C continuation leases and durable start accounting, full validation seals, source-scoped observation allocations with many-to-one per-run bindings, apply outcomes/ranges/checkpoints, bounded fenced readers, and worker-only security-definer operations. Migrations 001–008 were not modified.
- Added bounded page streaming and full semantic validation: frozen config/mapping/identity/profile digests, exact manifest/page coverage, full source-key duplicate detection, order-line parent keys, exact customer reference mapping checks, and canonical fact validation complete before observation allocation or canonical effects.
- Added observation allocation/reuse based on semantic digest and stable proof scope. Unchanged successful snapshots reuse the same source sequence and do not add outbox writes; changed snapshots allocate a new sequence. `SOURCE_VERSION` uses source versions and creates no observation.
- Added atomic canonical customer/order aggregate application with outcomes, ranges and checkpoints, strict-loop integration, durable 5/30/120 second retry delays, claim/start separation, stale-token and barrier checks, and restart recovery from the immutable staged proof.
- Added API-013 source-customer identity discovery as an owner-only, source-qualified, cursor-paginated read. It returns only source PK and target UUID. The test confirms a mapping only through API-014 before the combined order run; a missing exact identity map rejects the entire combined run before observation, outcome, range, or outbox effects.
- Added explicit logical tombstone handling through the existing canonical apply path. C does not infer absence or perform D-owned deletion-candidate work.

## Verification

All final gates used fresh external `E:\m1t5-runtime\<UUID>` roots with absolute `M0_RUN_EVIDENCE_ROOT`, command/stdout/stderr/exit capture, and source manifests recording actual HEAD, raw/LF hashes, byte sizes and Git blobs. The copied evidence is bound to the implementation commit by committed Git blob IDs.

- Focused C, B, API-013/API-014 registry and populated migration tests: `npm exec -- vitest run acceptance-tests/snapshot-validation.test.ts acceptance-tests/snapshot-runs.test.ts acceptance-tests/source-registry.test.ts` — **3 files, 65/65 passed**, exit 0. Runtime: `E:\m1t5-runtime\a3d057c3-5540-45bf-ba41-0f19532445ee`.
- PostgreSQL source/connector/contract regressions: `npm exec -- vitest run acceptance-tests/postgres-snapshot-source.test.ts acceptance-tests/postgres-snapshot-connector.test.ts acceptance-tests/postgres-snapshot-contract.test.ts` — **3 files, 11/11 passed**, exit 0. Runtime: `E:\m1t5-runtime\c738779e-80cc-4dd3-83fa-3f1a8b6d5572`.
- `npm run typecheck` — exit 0. Runtime: `E:\m1t5-runtime\70fc8495-7975-4d24-9817-eb468d886045`.
- `npm run build` — exit 0. Runtime: `E:\m1t5-runtime\0558d1ff-4a99-4928-aea9-befe7095d87c`.
- The owned PostgreSQL end-to-end case exercises customer-only apply, source-customer discovery and exact-owner mapping confirmation through the registry service, combined customer/order apply, missing-map zero-effects rejection, unchanged observation reuse, changed semantic allocation, logical tombstone receipts, `SOURCE_VERSION` without observation, and C recovery. Separate Fastify route tests exercise API-013 listing and API-014 confirmation over HTTP.
- Destination recovery terminates the exact owned PostgreSQL backend once before commit and once after commit. The test preserves the driver’s real termination error; an initial run exposed the untyped pg connection error classification and the runtime was corrected to retry only recognized pg transport termination. Restart recovers from staged proof, preserves the all-or-none range/outcome state, reuses the same observation, and does not reconnect to the source. This verifies backend termination, **not a whole Node process crash**.
- C stale-token tests show a stale claim cannot consume a start. A post-claim typed security barrier prevents proof reads and leaves observation/outcome effects at zero.
- Migration upgrade test applies actual 001–008 to an owned database, populates tenant, subject, credential, active source, config/mapping/identity revisions, active channel, PASS report, owner approval and lifecycle event, then applies assembled 009 and reapplies it. The prior 001–008 checksum rows are identical after reapply. This is a populated legacy-facts upgrade fixture; it does not claim pre-009 C run rows existed.
- `git diff --cached --check` passed before the implementation commit. No live CRM, Hermes, site identity, SQL Server, production database, deployment, query-gate or UI was used.

## Run history and limits

An exploratory destination-kill run initially failed because a real untyped pg transport error was treated as permanent; that behavior was corrected and the final 65-test gate passed. Early SOURCE_VERSION and migration-upgrade attempts also failed on fixture setup and are not counted as green results. The final focused run includes the corrected coverage. An earlier connector run had malformed manifest paths and is not cited; the corrected manifest-bound run passed 11/11.

The actual Node process crash is **NOT_RUN**. Foreign-source customer-reference behavior is implemented through the frozen `customer_source_id` and exact live mapping checks, but this final acceptance set does not include a distinct foreign-source-reference fixture. The tests exercise selected role boundaries and direct denied writes, not the entire DB privilege matrix. Whole-phase review and formal 48-case acceptance remain outstanding.

## Evidence and commits

The whitelisted raw captures, before/after manifests, committed-source blob bindings, and artifact SHA-256/size manifest are in `docs/execution/alpha1/m1-task-5c-evidence/11053c7f-3c10-4215-8f36-60612b060aee/`. The external originals remain at their runtime roots. `artifact-manifest.json` lists every copied artifact; `commit-binding.json` confirms the captured source blobs match implementation commit `b32b746943d6feec97641c31b093b068ab51d4a9`.

This report is duplicated byte-for-byte at `.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/task-5c-report.md` and `docs/execution/alpha1/m1-task-5c-report.md`. The misplaced `workspace/task-5c-report.md` was removed from the tracked tree. Report and evidence changes are committed separately from implementation. The evidence package contains 11 complete owned PostgreSQL fixture teardown records with exact image digest, ownership confirmation, and exact-ID absence verification. `capture-index.json` records SHA-256 and size for every retained evidence artifact and marks unavailable historical roots as NOT_RETAINED. The earlier same-source fallback bypass experiment/revert and the invalid in-repository evidence-root run have no retained external capture; they are not presented as passing evidence.

## Fixround 1 — review findings R1–R10 and G1

This section supersedes conflicting coverage and limitation statements above. The earlier report and implementation commit `b32b746943d6feec97641c31b093b068ab51d4a9` are retained as history. Fixround 1 product/test changes are committed separately at `2ad5d36f0b41b2422859bf2f22f81c28e84f2b1a`, parent `f43c672e8421b490984867ff3557b406374c0e40`. The test captures record actual HEAD `f43c672e8421b490984867ff3557b406374c0e40`; their before/after source hashes and Git blobs match the final committed files, as shown in `commit-binding.json`.

- **R1 — atomic stale-token rollback:** assert the C token inside the aggregate transaction before calling canonical apply; false outcome/range/checkpoint recording throws inside that transaction. Regression verifies canonical and outbox writes roll back together with receipt facts.
- **R2 — observation allocation:** only an unchanged snapshot matching the latest source allocation and a successful COMPLETE result reuses its observation. A→B→A allocates a new sequence above B; A→partially-applied then failed B→A also allocates a new sequence above B. Recovery of an individual run continues with its bound allocation.
- **R3 — lease fencing:** heartbeat during long work; expired claim/start tokens cannot terminal-fail or mutate the run. Expired stale token is rejected.
- **R4 — pre-seal validation:** validates every customer owner/department against frozen mapping and live enabled sales identities before seal/observation. A late invalid customer rejects the batch with zero observation/effects.
- **R5 — exact target locks:** same-source and foreign-source tests mutate the exact source-qualified customer target after sealing and before order application. Both reject the order outcome and fail safely; no canonical order outcome is created. Same-source coverage uses a newly retested/approved config revision.
- **R6 — typed tombstone value:** boolean `false` and `true` remain distinct under timestamp profile normalization; source-version tombstone preserves source time.
- **R7 — API-013 authorization:** current principal is asserted inside the guarded owner-query transaction; stale scope and disabled binding are rejected.
- **R8 — foreign stage membership:** stage membership is scoped to the configured customer source; a frozen exact foreign-source mapping resolves an order reference absent from local customer stage.
- **R9 — bounded order streaming:** semantic proof reads one order per bounded chunk and retains only that order’s lines during conversion.
- **R10 — typed barrier scope:** claim-time barrier matching uses the same typed credential/entity/channel tuple as the assertion; an unrelated valid barrier does not block C, while the matching barrier blocks before proof/effects.
- **G1 — actual Node child crash:** owned child processes were SIGKILLed at the before-COMMIT and after-COMMIT hooks, then restarted. Both recoveries retain observation 9 and finish with three ranges; no source reconnection occurs. Exact child PIDs are 34684 (before) and 16188 (after). This is a process crash test, distinct from the separate PostgreSQL backend termination test.

Final focused evidence gates all exited 0: `vitest run acceptance-tests/snapshot-runs.test.ts -t "restarts after terminating its owned PostgreSQL reader" --testTimeout=120000` (runtime `E:\m1t5-runtime\233e7c9f-8cb6-4850-864c-88820d0c54ae`); `vitest run acceptance-tests/source-registry.test.ts -t "discovers source-qualified customer identities" --testTimeout=60000` (`E:\m1t5-runtime\0aae254a-9656-49b2-ac7b-d5bcd1438ff9`); populated 001–008→009→identical reapply test (`E:\m1t5-runtime\60db80c4-70ea-43ac-90c7-ff59876e1420`); `npm run typecheck` (`E:\m1t5-runtime\35f2fada-2a04-49f0-b683-845c7603bd5c`); and `npm run build` (`E:\m1t5-runtime\f784f652-a976-45e2-9fdc-e096f8fb7f56`). The two-step customer discovery/confirmation then combined run is exercised by the owned PostgreSQL end-to-end path. Captures include command, stdout, stderr, exit, and selected-source before/after manifests.

The evidence package is `docs/execution/alpha1/m1-task-5c-evidence/49b6d3ec-1fce-4b9a-983f-f1a4b400d798/`. `capture-index.json` hashes each retained copied artifact and records 36 owned PostgreSQL fixture lifecycle records, all with exact owned removal and post-removal absence, plus six child lifecycle files. `artifact-manifest.json` hashes and sizes each retained package file. External originals remain in their exact `E:\m1t5-runtime\<UUID>` roots. Historical captures that were not safely retained remain identified as unavailable; the earlier same-source fallback experiment/revert and the in-repository evidence-root run are not passing evidence.

The formal 48-case suite remains **NOT_RUN**. The full DB permission matrix, real external CRM/Hermes integrations, production/site/deployment/query-gate/UI claims remain outside this verification. No whole-project suite was run for Fixround 1.
