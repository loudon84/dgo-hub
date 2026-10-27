# M1-5B PostgreSQL snapshot extraction and staging report

## Status

M1-5 remains **IN_PROGRESS**. The formal 48-gate suite is **NOT_RUN**. This report covers B only. The snapshot worker stops at run state VALIDATING with an immutable EXTRACTED manifest. C owns semantic validation, observation assignment, canonical application, and all delete decisions.

Implementation source baseline: 8283a39cde0cda9468cdbb5d77862f45b973f240. The dispatch checkpoint b67088bb5afeff555feb7d45c3d359649f0d7bea changed documentation only; the source baseline remained the requested BASE.

## Implemented

- Added PostgreSQL snapshot profile facts for explicit customer/order primary keys, the order-line table and header foreign key, required updated_at_field, optional source version only for SNAPSHOT_OBSERVATION, and the explicit aggregate-header-and-lines assertion for SOURCE_VERSION. An optional order customer_source_id is validated as an exact source ID value, not an SQL identifier. Profile and mapping facts remain frozen in the approved proof.
- Added PostgreSQL probing for all selected header and line columns, timestamp and version types, distinct read-only role permissions, table and column write grants, unauthorized schemas, line relation access, and profile-to-mapping agreement for source update/delete timestamps. Timestamp-without-time-zone inputs fail closed.
- Added the six exact order-line targets under the existing order field-mapping contract. They are required only for PostgreSQL snapshots; the existing REST mapping contract is preserved.
- Added an injected PostgreSQL source connector using one dedicated connection and one REPEATABLE READ READ ONLY transaction for customer, order-header, and order-line scans. It sets UTC and stable date formatting, uses validated quoted identifiers, a bounded literal fetch size, non-HOLD cursors, and SQL text casts to preserve large integers, exact decimals, and timestamp microseconds. Snapshot identity is hashed private provenance, never a resume token.
- Added attempt-scoped durable page receipts and records, immutable manifest publication, claim tokens and leases, guard-first Hub transactions, stale-token and typed-barrier fences, and database-clock retry availability. Attempts survive a crash as diagnostics; a retry starts a new attempt and a full source scan. A claim alone does not consume a start; the durable start budget is four.
- Wired the snapshot runner into the existing strict worker loop through injected dependencies. The default source factory is fail-closed. The local fixture factory accepts only exact loopback endpoints under local_lab.
- Extended phase-owned migration 009 for attempt/retry/lease state and private stage pages, records, and manifests. Migrations 001–008 are byte-identical to the requested baseline. No released-009 in-place upgrade is claimed.

## Verification

Every test/compiler command used a fresh external runtime root with an absolute M0_RUN_EVIDENCE_ROOT. Raw command, stdout, stderr, exit code, actual HEAD, and before/after status captures are retained in the evidence package.

- **Red-first profile contract:** at BASE, 4/4 new PostgreSQL profile contract cases failed as expected for missing source keys, line relation, aggregate-version proof, and observation-only optional source version.
- **Focused B suite:** 7 affected files, **93/93 passed**. This includes profile and mapping contracts, connector behavior, owned PostgreSQL source-role and repeatable-read checks, migration/recovery, snapshot staging/fencing/retry, source registry, and identity-store regressions.
- **Existing REST strict-ingestion regression:** **30/30 passed** after line-mapping requirements were scoped to PostgreSQL.
- **Strict worker loop restart case:** **1/1 passed** through runDurableWorkerLoop one-shot integration. The owned read-only source backend is verified by PID, username, database, and loopback client, then terminated after the first customer page. Attempt 1 remains incomplete with one diagnostic page; it cannot publish. After retry due time, attempt 2 performs a new full scan of customers, orders, and lines and alone publishes the 3-row EXTRACTED manifest; the run remains VALIDATING.
- **Final snapshot-runs file:** **21/21 passed**, including concurrent claims, stale lease fencing, security-barrier publication denial, retry delays, and four durable starts.
- **Typecheck and build:** npm run typecheck and npm run build both exited 0 on the implementation source. The later follow-up commit changed only the worker-loop acceptance test; that final test ran 21/21 and its focused restart case ran 1/1.
- **Migration integrity and whitespace:** git diff --check passed. Direct diff verification confirmed migrations 001–008 are unchanged from BASE.

The owned source fixture uses a distinct non-superuser writer and read-only ingestion account. It proves write denial for INSERT, UPDATE, DELETE, TRUNCATE, unauthorized columns, and an ungranted schema. It also changes a customer, order header, and order line during a scan and confirms all emitted rows retain one MVCC view. The positive snapshot-run test uses SNAPSHOT_OBSERVATION source tables with no source-version columns. Large bigint, decimal precision, and six-digit timestamp fractions are asserted as exact text.

All 50 recorded owned PostgreSQL fixture runs in the evidence inventory include the pinned image and runtime image identities, exact container IDs, ownership confirmation, removal, and exact-ID absence after removal. No absence claim is inferred from the daemon alone.

## Limits

No production source database or credential was used. Production DNS pinning, TLS peer verification, private-network egress policy, and deployment resolver/factory wiring remain unverified; the production factory stays fail-closed until that deployment-owned policy is injected. The read-only role proof applies to the owned PostgreSQL fixtures only.

B performs no observation allocation, semantic READY transition, canonical write, tombstone processing, hard-delete inference, delete-candidate creation, API-060 action, cutover, SQL Server integration, UI, or query-gate work. C/D/E and whole-phase review remain.

## Commits and evidence

- Product and focused tests: 0e7d4bf2d27cc567848c0ce80cfd49dfbfa07457 (Implement PostgreSQL snapshot extraction and staging), followed by 7e2cc26e6a352a8c52ae43c61c9c8ba3446b5412 (Exercise snapshots through strict worker loop).
- Evidence package: docs/execution/alpha1/m1-task-5b-evidence/35044d58-f640-4265-adfe-a7b0147429ab/.
- The package contains an explicit artifact SHA-256/byte-size manifest, source-before/source-after snapshots and LF/blob/size bindings, committed source bindings, raw red and green gate captures, and the individual owned-fixture lifecycle records. The external raw capture root is E:\m1t5-runtime; the capture index maps each retained item to its unique command root.
- The report at .superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/task-5b-report.md is byte-identical to docs/execution/alpha1/m1-task-5b-report.md.

## Fix 1 — independent review findings R1–R5

The first independent review marked all five findings for correction. Fix 1 addresses each finding in product code and focused regression coverage:

- **R1 — due admission:** the strict snapshot worker now reads due schedules and invokes the existing guarded `admitDueSnapshotRun` gate before selecting scan candidates. The strict-loop acceptance case starts with a due schedule and no manual run, then verifies one scheduled run begins and reaches the injected source connector.
- **R2 — manifest proof:** phase-owned 009 now uses NULL-safe comparisons for every frozen proof digest and binds the manifest to the active attempt and operation. It requires the exact distinct relation-count set, non-null row/page counts, per-relation receipt counts and page ranges, exact ordered page-digest lists, and a matching total page count. Hub-worker negative cases for omitted proof, duplicate/omitted relation entries, null counts, and incorrect digest lists leave the attempt unpublished.
- **R3 — retained memory:** the worker keeps receipt metadata (keys, page number, row count, and digest) for manifest construction and releases each page's source rows after staging. The multi-page strict-loop case verifies the same complete manifest counts and digest-list lengths.
- **R4 — active cancellation:** the injected connector contract now carries an abort signal through connect and exposes connection cancellation. Abort cancels the outstanding query; local-lab connect can be interrupted; rollback and close are bounded best-effort cleanup. A pending-FETCH fixture verifies cancellation resolves without manually completing that query and publishes no page.
- **R5 — aggregate source version:** the owned source fixture declares a header trigger and a line trigger that both advance the order's bigint `source_version`. The fixture asserts monotonic advancement for a header change and a line change, then verifies extraction reads the line-updated header version. The separate MVCC case continues to mutate customer, header, and line rows during extraction and checks one repeatable-read view.

### Fix 1 verification

The initial retained diagnostic capture at `E:\m1t5-runtime\c434eacb-b78a-49fe-9aa3-d8b34ba820bc` recorded the partial-fix failures (due connector not called, malformed manifest accepted, pending FETCH not cancelled) and the aggregate fixture case passing. That capture was inspected; the red gate was not repeated.

The first Fix 1 focused attempt could not start its owned fixture because Docker Desktop's Linux engine pipe was absent. Safe CLI output identified the stopped daemon; the attempt had no container ID and its lifecycle entries are `start_failure_unresolved`, not removal claims. The existing Docker service and Desktop application were started. Engine readiness returned within 22 seconds (`docker version` server `29.8.1`), after which the final focused run used fresh external root `E:\m1t5-runtime\fix1-focused-f402119f-8c80-4e66-8e06-3aea134e999c` and absolute `M0_RUN_EVIDENCE_ROOT`.

- Exact focused command: `npm test -- acceptance-tests/snapshot-runs.test.ts acceptance-tests/postgres-snapshot-source.test.ts acceptance-tests/postgres-snapshot-connector.test.ts` — **3 files, 28/28 passed**, exit 0.
- `npm run typecheck` — exit 0, external root `E:\m1t5-runtime\fix1-typecheck-13d259a4-fa22-459d-9fbe-05f3725d8c36`.
- `npm run build` — exit 0, external root `E:\m1t5-runtime\fix1-build-2b58911e-138c-4526-af4a-1a8e948008e5`.
- `git diff --check` passed. Direct comparison confirmed migrations 001–008 are unchanged from the accepted B source baseline. The three focused owned PostgreSQL containers used the pinned image, recorded exact IDs and ownership labels, and each has a removal event plus exact-ID absence confirmation.
- These Fix 1 results are separate from the earlier 93/93 focused suite and 30/30 REST regression. They do not relabel those earlier counts. The formal 48-case suite remains **NOT_RUN**.

Each final gate has its own before/after status, actual HEAD, raw stdout/stderr, exit code, and selected source raw/LF SHA-256, byte-size, and Git-blob captures. The tested source was bracketed at `b7b85419c8c2be1595b8832408014540efbcf314`; `committed-source-bindings.json` confirms all six changed source/test/migration Git blobs match product commit `e7856336e3788ccb13a084ebcbd13cbb72f9bf6a`. The safe, individually copied artifact whitelist and SHA-256/byte-size manifest are in `docs/execution/alpha1/m1-task-5b-evidence/fix1-253a8351-7b41-44f2-af63-af440ebdcf2b/`.

## Fix 1 commit and remaining limits

- Product and focused tests: `e7856336e3788ccb13a084ebcbd13cbb72f9bf6a` (`fix: close M1-5B snapshot review gaps`).
- Evidence and report update are a separate documentation commit.

Production DNS pinning, TLS peer verification, private-network egress policy, and deployment resolver/factory wiring remain unverified; the default real-source factory remains fail-closed. The fixture proves behavior only for the owned local PostgreSQL reader/writer setup. B still stops at VALIDATING with EXTRACTED; it performs no semantic approval, observation assignment, canonical write, delete inference/candidate, API-060 action, cutover, or C/D/E work. Whole-phase review and the final integrated M1-5 gate remain outstanding.
## Fix 2 — independent review finding N1

Fix 2 handles expected source-local denials during strict-loop due admission. `runDurableWorkerLoop` now catches only `AuthError` values whose codes are `SOURCE_CONFLICT`, `SOURCE_NOT_FOUND`, or `SOURCE_CONTRACT_INVALID` for each schedule; it emits a bounded diagnostic with tenant/source identifiers and the error code, then continues scanning remaining schedules and already-admitted attempts. Other exceptions are rethrown, and the existing guarded admission call remains the security boundary.

### Fix 2 verification

- RED: `npm test -- acceptance-tests/snapshot-runs.test.ts -t "continues scanning admitted work when another due source is paused by a config edit"` — **1 failed, 22 skipped** (exit 1). The paused due schedule raised `SOURCE_CONFLICT` through `lockedProof` / `admitDueSnapshotRun` and escaped `runDurableWorkerLoop` before the unrelated admitted source could proceed.
- GREEN: the same focused command — **1 passed, 22 skipped** (exit 0). The regression leaves the disabled schedule enabled and due after a config edit to PAUSED, adds an unrelated admitted run, asserts a safe warning for the paused schedule, and verifies the unrelated run reaches the injected connector failure path and is recorded as incomplete.
- `npm run typecheck` — exit 0. `npm run build` — exit 0. No broader suite was rerun for Fix 2.
- Both owned PostgreSQL test fixtures used pinned image `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`; their exact IDs are `efc14f5fc0c81b23db65b6a8529c541a51917dd597ff9a2729e0485f4d41ea03` (RED) and `e10431e9b9137f66f5dfadf75e738791131330a0d99a31898b24a371d1167225` (GREEN). Each lifecycle record confirms ownership, removal, and exact-ID absence.
- Captures are under four distinct external roots: `E:\m1t5-runtime\fix2-red-ac546846-6b4f-4ac4-aac4-5c9ab95fbfa8`, `E:\m1t5-runtime\fix2-green-36f37381-1b9e-4817-b3fa-ac783b068eaf`, `E:\m1t5-runtime\fix2-typecheck-6439afef-48da-436c-ad74-621fd09471a0`, and `E:\m1t5-runtime\fix2-build-c4346f77-203e-413e-aad9-209c448e5436`. Each gate retained its exact command, stdout/stderr, exit, before/after HEAD and status, and selected source raw/LF SHA-256, byte-size, and Git-blob snapshots. All gates were run against working-tree changes bracketed at `1a0271f650b7c0746f059d24dcf7cdafeb08e7a3`; `committed-source-bindings.json` confirms both tested source blobs match product commit `8e6f1cfc0d1e1f0aa577806d8ba47c66a1a0b93b`.
- The individually whitelisted copied captures, fixture lifecycle records, binding document, and artifact SHA-256/byte-size manifest are in `docs/execution/alpha1/m1-task-5b-evidence/fix2-7bd8650d-1d6b-4aeb-b0a0-287d16410a63/`.

### Fix 2 commit and remaining limits

- Product and focused regression: `8e6f1cfc0d1e1f0aa577806d8ba47c66a1a0b93b` (`fix: isolate denied snapshot schedules`).
- Evidence and report update are committed separately.
- Original R1–R5 remain addressed. The formal 48-case suite remains **NOT_RUN**; production DNS pinning, TLS peer verification, private-network egress policy, and deployment resolver/factory wiring remain unverified. B still ends at VALIDATING with EXTRACTED; C/D/E, whole-phase review, and the final integrated M1-5 gate remain outstanding.