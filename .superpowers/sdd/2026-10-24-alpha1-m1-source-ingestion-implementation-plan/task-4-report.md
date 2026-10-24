# M1-4 Task 4 implementation report

**Result: DONE.** Implementation and final local gates are complete. Independent GPT-6.1 Sol review is the controller's next step. Formal 48-row acceptance remains `NOT_RUN` and product readiness remains false.

## Source identity

- Implementation BASE: `c616402a79019821da77c0434762c6970a322e61`.
- The controller added a docs-only status commit after the BASE. Final gate HEAD: `2d9b67c2f04104afb7995bc26360f285ad89f92b`.
- Product source commit, created after the final gates from the same tested bytes: `2189ad75ea1bed4f3edcd3b2e7754dfcbe07c4ee` (`Implement durable strict ingestion worker`).
- The final-gate pre/post manifests contain raw-byte SHA-256, LF-normalized SHA-256, byte counts, and Git clean blob IDs for every changed source and test file. The manifests compare equal; the gate ran on unchanged source bytes. `git diff` confirmed migrations 001–007 are unchanged from BASE.

## Implementation

Migration 008 extends the existing one-row-per-job processing outbox with bounded leases, fencing tokens, availability, and post-commit acknowledgment. It adds stable per-item operation IDs, durable application-start/retry counts, and retry due times. `hub_worker` receives only the required column grants; prior migrations and role boundaries remain intact.

The strict worker claims jobs in a short, separate `SKIP LOCKED` transaction. For each item it starts a durable attempt, constructs canonical context from frozen job proof, takes the global security barrier guard before other apply locks, then checks and holds the lease token while applying and recording the item and job result in one transaction. It uses the M1-2 customer/order apply functions and does not route strict jobs through the legacy worker. Delays are 5, 30, and 120 seconds, with one initial attempt plus three retries. Terminal items are skipped after recovery; acknowledgment is token-fenced and occurs only after terminal item state is committed.

The worker adapter preserves exact decimal strings and sub-millisecond timestamp precision, maps public fields at the worker boundary, and checks the complete order customer reference tuple against the same-tenant canonical identity. Matching typed barriers and explicit remap fences isolate only affected work; ordinary epoch drift leaves accepted frozen work eligible.

## Acceptance coverage

The final strict worker suite exercises actual durable HTTP jobs with the `hub_worker` PostgreSQL role and real database state. It covers:

- Successful apply, persisted terminal summaries, and `applied_count` based only on committed `APPLIED` effects; mixed terminal outcomes produce `PARTIAL`.
- Source-version outcomes, full source/customer reference tuple mismatch, exact timestamp and decimal adaptation, and all-failure isolation.
- Retry scheduling, four-start budget, stable operation ID, rollback on header trigger failure, selected order-line failure, pre-status failure, and pre-commit failure.
- Expired lease recovery, fresh fencing token and stale-token rejection, distinct claims by concurrent workers, and actual process termination before apply and after commit before ACK.
- Each of `CREDENTIAL_COMPROMISE`, `SOURCE_SCOPE_SECURITY_REMOVAL`, `TENANT_DISABLED`, and `CHANNEL_RETIRED`, plus ordinary source epoch drift.
- Explicit remap fencing of the affected frozen item while an unrelated frozen item completes.
- Role checks showing `hub_api` cannot read raw input or perform canonical core DML while `hub_worker` can apply through the authorized path. The hub uses a shared worker backend; this implementation does not claim fictitious per-tenant RLS.

The full suite also covers immutable earlier migration checks and strict API behavior. Migration expectation tests now include additive 008; 001–007 remain unmodified.

## Final gates

Each command ran once as the final gate, with an absolute `M0_RUN_EVIDENCE_ROOT` pointing to the fresh external runtime directory below. Fixture lifecycle files confirm the environment setting was honored. External originals remain in place; only individually listed artifacts were copied into the official evidence root after the suite completed.

| Command | Exit | Result |
| --- | ---: | --- |
| `M0_RUN_EVIDENCE_ROOT=E:\m1t4-runtime\m1-task-4-final-9b0fd52a-6a5a-4eb1-88f0-f4770281e269 npm run typecheck` | 0 | TypeScript check passed |
| `M0_RUN_EVIDENCE_ROOT=E:\m1t4-runtime\m1-task-4-final-9b0fd52a-6a5a-4eb1-88f0-f4770281e269 npm test -- --reporter=verbose` | 0 | 19 files, 312 tests passed |
| `M0_RUN_EVIDENCE_ROOT=E:\m1t4-runtime\m1-task-4-final-9b0fd52a-6a5a-4eb1-88f0-f4770281e269 npm run build` | 0 | Build passed |

Exact command, stdout, stderr, and exit files are under `docs/execution/alpha1/m1-task-4-evidence/ba0044f2-2d67-4a12-b12e-0f830f188a77/final-gate/checks/`. `final-gate/copy-manifest.json` records each source, destination, byte count, and SHA-256. Pre/post source manifests are in `final-gate/source-manifest-pre.json` and `final-gate/source-manifest-post.json`.

## Test and gate history

The evidence root retains all initial RED, focused GREEN, and failed-run captures; failed attempts were not replaced. Key iterations:

- `red-01` failed as intended because `runDurableWorkerOnce` was not implemented yet. `green-01` exposed an ambiguous SQL `status` reference; it was qualified before `green-02` passed.
- Early focused runs retained a parse error (`focused-02`, `focused-04`), a wrong-working-directory npm `ENOENT` (`focused-03`), test-fixture ordering and adapter failures (`focused-06` through `focused-13`), and a migration-008 history mismatch (`final2-suite`). These were corrected and the final suite passes.
- `focused-08` / `focused-09` retained PostgreSQL SQLSTATE `22P02`: JSON target IDs were being coerced to UUID even though valid owner fixtures are text IDs. The adapter now parses the IDs as text. Barrier tests were made independent by restoring approval state between typed barrier admissions.
- `focused-remap-01` retained test-fixture SQLSTATE `08P01` from an extra bind parameter. The corrected `focused-remap-02` passes.
- The first full suite (`final2-suite`, exit 1) had four stale migration-list expectations, a tenant-global count assertion that observed parallel fixture rows, and a recorder hash assertion racing with test lifecycle files written under the in-repository evidence root. The count query is now keyed to the unique job item; only additive migration expectations were updated. The recorder validator and trust anchors were left unchanged. The final gate used a fresh external runtime and captured logs outside Git, so the recorded source snapshot remained stable.
- The first typecheck (`final-typecheck`, exit 2) found a TypeScript discriminated-union narrowing error, corrected before the passing `final2-typecheck` and final gate.

Exact commands and original stdout, stderr, and exit codes remain in the numbered files at the evidence root. The successful focused worker run (`focused-15`), recorder check (`focused-17`), and remap case captures (`final-gate/focused/`) are also retained.

## Local resources and limits

Across the retained Task 4 focused runs and final suite, 35 owned local PostgreSQL containers are recorded with exact container ID, task/run labels, image digest, ownership check, removal event, and helper-confirmed absence. A separate post-gate `docker ps --all --quiet --no-trunc --filter id=<exact-id>` check confirmed all 35 IDs absent. Their identifiers and results are in `final-gate/owned-resources-summary.json`; copied raw lifecycle and resource summaries are listed in `final-gate/copy-manifest.json`.

Fixtures used synthetic local data and owned ephemeral PostgreSQL containers. No real CRM, SQL Server, Hermes, site identity provider, external endpoint, secret, certificate, deployment, or source-system write was used. No manual quarantine retry or Task 5 API was added. The formal 48-row acceptance and release decision were not run or changed.

## Fix round 1/5 — independent review findings R1–R3

**Result: DONE for the three scoped findings; independent re-review is next.** The repair base and final-gate HEAD were `6f9b7cc1bacf364b143c622914c5848dacffd935` (the source tree was unchanged from the user-pinned implementation base by controller docs-only commits). The focused gates ran on that HEAD's uncommitted repair bytes. Product/test commit `7ea2e94beb6fef43228094aa7f616a90ae65b3cd` contains exactly those tested source bytes. Migrations 001–007 remain unchanged.

### Repairs

- **R1 / P1:** Migration 008 now adds `operation_id uuid NOT NULL DEFAULT gen_random_uuid()` in the `ALTER TABLE`; it no longer updates populated items through migration 007's immutable-row trigger. The regression applies migrations 001–007 to owned PostgreSQL, inserts a valid FK- and constraint-complete accepted raw batch, frozen job proof, received item and outbox row, then upgrades through 008 and repeats the migration runner. It compares the raw bytes, complete job proof row, accepted item facts/status, and outbox identity/timestamp before and after. It checks that operation ID remains stable across the repeat and that the item/job can make a valid worker-state transition afterward.
- **R2 / P2:** Attempt-start still persists the fallback retry timestamp for crash recovery and consumes the durable attempt budget. When the worker observes a failed apply, its fenced status transaction now schedules 5/30/120 seconds from database `clock_timestamp()`. Retry eligibility uses that same database clock. A real trigger sleeps 5.5 seconds and then raises inside the canonical transaction; after rollback the test verifies more than four seconds remain, an immediate second worker run does not start attempt two, and the operation ID is unchanged. The existing four-start test still verifies attempts 1–4 and stable operation identity.
- **R3 / P2:** ApplyContext now validates `sourceId` with the source registry's exact 1–256 ASCII source-ID pattern, separately from the existing 128-character business identifier validator. No source ID is changed or truncated. Canonical apply tests cover 128/129/256, invalid source IDs, and rejection of a 129-character business primary key. A strict HTTP/worker integration test registers and admits frozen jobs for 128/129/256-character source IDs, executes them through `hub_worker`, and checks the exact stored source ID, `APPLIED` item state, successful job summary and applied count.

### RED and failure history

All test output remains in the external runtime root. Initial RED and harness failures were retained:

- `red-migration` (exit 1) first reproduced migration 008 failure on populated 007 rows. That first broad migration-file run also exposed a test-only temporary-directory prefix mismatch; its cleanup guard rejected the new fixture prefix and the remaining tests then reported cleanup errors. I changed the new fixture prefix to the suite's already guarded `m0-migration-` root and reran the migration RED in isolation.
- `red-r1-focused` (exit 1) isolated the intended `MIGRATION_APPLY_FAILED` at version 008.
- `red-r2-r3-focused` (exit 1) showed the source-ID rejection, but the long attempt hit Vitest's default 5-second test timeout and closed its test database. I raised only that long test's timeout to 15 seconds, then `red-r2-focused` (exit 1) completed the 5.5-second database failure and observed `next_retry_at` 546 ms in the past. This confirmed early retry after a known failure.
- `red-r3-worker` (exit 1), run with the old apply validator restored temporarily, accepted all three HTTP batches. The 128-character job applied; 129- and 256-character jobs remained `RETRY_PENDING` / `PROCESSING`, with `applied_count=0`. The apply validator throws `CANONICAL_IDENTIFIER_INVALID` for those valid context IDs; the worker treats it as transient. The final integration test also asserts no apply exception remains after repair.

The first combined RED's test timeout and directory cleanup failures were test-harness issues; the isolated RED runs below are the defect-specific evidence. No earlier failed gate output was overwritten.

### Final focused gates

All test commands used the absolute external `M0_RUN_EVIDENCE_ROOT` `E:\m1t4-runtime\m1-task-4-fix1-7d8fad1f-349f-45e5-8691-3e54fa720f16`.

| Command | Exit | Output |
| --- | ---: | --- |
| `npm test -- --reporter=verbose --testNamePattern='upgrades accepted 007' acceptance-tests/migrations.test.ts` | 0 | R1 populated upgrade and repeat: 1 passed |
| `npm test -- --reporter=verbose --testNamePattern='full retry delay|registered 256-character limit' acceptance-tests/strict-ingestion.test.ts acceptance-tests/canonical-apply.test.ts` | 0 | R2/R3 focused: 2 passed |
| `npm test -- --reporter=verbose --testNamePattern='upgrades accepted 007|keeps the retry budget|full retry delay|registered 256-character limit|128, 129, and 256 character source IDs' acceptance-tests/migrations.test.ts acceptance-tests/strict-ingestion.test.ts acceptance-tests/canonical-apply.test.ts` | 0 | 3 files; 5 passed, 76 skipped |
| `npm run typecheck` | 0 | `tsc --noEmit -p tsconfig.json` |
| `npm run build` | 0 | `tsc -p tsconfig.json` |

The focused suite includes migration repeat/idempotency, database-backed retry timing and four-start budget, canonical invalid-source/business-ID checks, and actual HTTP-to-worker application at the three source-ID lengths. No full 312-test rerun was performed in this fix round; the prior 312-test gate remains evidence only for its earlier bytes. Formal 48-row acceptance remains `NOT_RUN`.

### Source and resource binding

The final focused gate ran at HEAD `6f9b7cc1bacf364b143c622914c5848dacffd935`; product commit `7ea2e94beb6fef43228094aa7f616a90ae65b3cd` was created afterward. The pre-commit source snapshot and post-commit manifest match across all seven explicit source/test paths for raw SHA-256, LF-normalized SHA-256, byte size and clean Git blob: zero mismatches. The snapshot was taken immediately after the final gate before source commit; the post-commit manifest verifies the committed bytes. Both manifests and their comparison are retained.

Twelve owned ephemeral PostgreSQL containers were recorded for the retained RED/GREEN/final commands. The resource audit checked each exact container ID with `docker ps --all --quiet --no-trunc --filter id=<id>`; all twelve had one image observation, exact ownership-checked removal, and were absent afterward. Lifecycle and resource summaries are retained. Tests used synthetic local fixtures only. No external system, ambient environment, npm configuration, secret, certificate, raw container environment, deployment or source-system write was used.

The runtime originals remain untouched at `E:\m1t4-runtime\m1-task-4-fix1-7d8fad1f-349f-45e5-8691-3e54fa720f16`. Individually hashed copies are under `docs/execution/alpha1/m1-task-4-fix1-evidence/6fdb2d28-0d50-4422-b363-d7c028584f0c/`; `copy-manifest.json` lists each source, destination, size and SHA-256, and the copy verification reported zero mismatches. Earlier five M1-4 assurance limits listed above remain open; this fix round closes only R1–R3.