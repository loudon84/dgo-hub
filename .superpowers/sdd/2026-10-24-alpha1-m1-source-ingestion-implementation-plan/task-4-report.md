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
