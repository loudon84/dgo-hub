# M1-5A implementation brief — durable run admission and API-019–021

**Slice:** A of M1-5; this brief authorizes no product work by itself. Root will select and freeze the exact implementation BASE after committing these planning docs, then explicitly dispatch one Luna source writer. Source observations for seam selection are limited to pin `05b461d422431e92c8893c03f8d1e1c1ac145938` via `git show`. Migrations 001–008 are immutable. Migration 009 remains owned by root for the full M1-5 phase: an A review is a focused slice review and does not freeze or approve the final 009 bytes.

## Scope

Implement only:

- The minimum additive 009 foundation for persisted snapshot schedule, run admission, frozen proof, one attempt/admission state, and the per-tenant/source active-run fence needed by the later snapshot slices.
- Authenticated API-019 create run, API-020 list runs, API-021 run detail with safe counts/completeness/checkpoint summaries.
- Persisted 300-second FULL_SNAPSHOT due schedule and a transaction-safe admission gate that cannot enqueue an overlapping run. Expose the due-run gate for later strict-worker wiring; this slice adds no timer/poller wiring. Source connection, extraction, page stage, and apply are later slices.
- Strict validation for entity/version/delete contracts at run admission, including fail-closed order-line contract requirements.

Do not implement API-022–024, API-060, actual PostgreSQL connector/extraction, staging pages, apply, checkpoint advancement, delete candidate generation, channel cutover, SQL Server, UI, legacy pulls, query gates, deployment, or formal acceptance in this slice. Do not create product files or run tests until dispatched at the exact BASE.

## Contracts for the slice

### Admission and authorization

- **API-019:** `POST /hub/v1/admin/sources/{id}/etl-runs`; body is strict `{ approved_config_revision, run_mode }`, with this implementation accepting only `FULL_SNAPSHOT`. Require current authenticated user `source:write`; verify current source is ACTIVE and exact revision/config approval/test/mapping/channel proof still match. Lock source/channel/schedule in a consistent order, acquire/check security fence, bind all tenant/source fields from current principal and locked registry state. Require `Idempotency-Key`, unique over tenant + source + canonical route/key; same key and same canonical request returns the same durable run ID, changed request returns 409. A schedule or manual request cannot bypass another active run.
- Freeze on the run: tenant/source; run ID, mode and source of request (manual/scheduled); exact `allowed_entities` set; source credential ID/revision/generation and admission source epoch; channel ID/epoch/connector/version domain; config, field mapping, identity mapping revisions and SHA-256 digests; endpoint-profile digest; source test report and API-007 approval/data-contract proof; delete contract; security barrier fence; Owner ID/revision for later Owner-gated reconciliation; schedule revision where applicable; creation time and request digest. These proof columns are immutable after admission. Mutable run columns are status, safe counts, error code, lifecycle timestamps, attempt linkage and validated summary only. No recovered run rebuilds this proof from current configuration.
- **API-020:** `GET /hub/v1/admin/etl-runs`; require `source:read` and filter every row to tenant and authorized source set. Support source, status and bounded time filters plus opaque cursor pagination (default 20, maximum 100). Return only safe run IDs, statuses, counts, timestamps, frozen revision IDs, and checkpoint summary. No stage payload, raw body, secret, endpoint secret ref, or unbounded SQL filter.
- **API-021:** `GET /hub/v1/admin/etl-runs/{id}`; require `source:read`, tenant/source-qualified lookup and same safe response policy. Completeness report is absent/`NOT_STARTED` until a later slice persists proof; never synthesize a successful validation/checkpoint claim in A.
- Reuse current `UserPrincipal` and scopes. A source credential principal is never accepted for admin routes. Cross-tenant and unauthorized source IDs have a non-disclosing not-found/forbidden result per the existing safe envelope. Use `request_id,data` success and `request_id,error:{code,message,retryable,details}` error shape.

### Entity/version/delete gate

- Freeze required entity set exactly from approved `SourceConfig.allowed_entities`; allow a customer-only run.
- If `order` is enabled, refuse admission until the approved config has a line relation, unique source line key, line-to-order FK and complete supported header and line field mappings. No implicit table names or default joins. At the pin, current `EndpointProfile` exposes per-entity table/version/delete fields, but `FieldMapping` and capability probe do not establish this line contract; this admission guard prevents an incomplete order snapshot.
- Permit `SOURCE_VERSION` only if the approved source provides a safe complete-aggregate version and compatible delete-version contract. For hard-delete absence with no safe source version, require configured `SNAPSHOT_OBSERVATION`; without either complete version contract, reject run admission with a stable safe source-contract error.
- A does not allocate an observation, advance checkpoint, apply a business row, or infer absence. It only freezes eligibility and creates the durable run request.

### Migration-009 foundation and scheduler fence

Treat the following as the smallest proposed foundation and review actual DDL/grants line by line before coding:

1. `control.etl_snapshot_schedule`, key `(tenant_key,source_id)`, FK to existing source registry. Fields: `enabled`, `interval_seconds` constrained to 300 for default FULL_SNAPSHOT, `next_due_at`, `schedule_revision`, `active_run_id` nullable FK, `last_run_id`, `updated_at`. No endpoint or secret bytes.
2. `control.etl_run`, PK `run_id`, tenant/source composite FK, `run_mode`, `request_kind`, `status`, `idempotency_key`, request digest, all frozen proof fields above, expected entity set, safe extracted/applied/quarantined counts default zero, `created_at/started_at/completed_at`, stable error code, checkpoint/completeness summary JSON only after later validation. Unique `(tenant_key,source_id,request_route,idempotency_key)`. Partial unique `(tenant_key,source_id)` where status is one of `QUEUED`, `SCANNING`, `VALIDATING`, `READY`, `APPLYING` provides one active snapshot lane per source.
3. `control.etl_run_attempt`, PK `attempt_id`, run FK, ordinal, stable operation UUID, status (`QUEUED`, `RUNNING`, `INCOMPLETE`, `FAILED`, `COMPLETE`), source snapshot identity nullable until B, bounded start/end/error facts. Extraction attempt retries and retry due fields are extended in later M1-5 slices while 009 is still phase-owned; no fake resumable cursor field in A.

The due-run gate claims a due schedule row with row lock/`SKIP LOCKED`, checks source ACTIVE/current approved revision/security barrier, and inserts one run plus first attempt while setting `active_run_id` in the same short control transaction. It is a callable transaction boundary only; strict-worker timer/poll wiring is later. The partial unique run index is the final guard against manual/scheduled races. After that transaction commits, release the DB lock; A never holds a control transaction open while contacting an upstream source. On conflict, leave due schedule durable and skip this source until the active run is terminal. The later extraction slice owns updating next due/active linkage on terminal completion. Repeated gate calls are idempotent and cannot create parallel scans. Do not use an in-memory timer as the schedule of record.

009 must `REVOKE ALL ... FROM PUBLIC`, preserve earlier grant boundaries, and add only exact columns/functions. `hub_api` may request a run via `control.request_snapshot_run(...)` (or an equally narrow caller-owned insert) and read safe summaries through tenant/source-qualified queries; it gets no raw-stage select or canonical DML. `hub_worker` may call `control.claim_due_snapshot_run(...)` and mutate only schedule/run/attempt lifecycle columns granted for that function; it does not gain tenant isolation by assumed RLS. Any SECURITY DEFINER function has fixed `search_path`, explicit owner, `REVOKE PUBLIC`, and exact EXECUTE grants. Tenant/source predicates are mandatory, with positive and negative checks under actual roles. PUBLIC has no new function/table permission. Use the existing `runMigrations(pool, options)`/one-shot migrator; migration SQL has no top-level transaction control. Do not alter or renumber migrations 001–008.

## Proposed file map

Implement only files required by this slice, with exact interface names settled in the source review before edits:

- `integration-service/migrations/009_snapshot_runs_and_recovery.sql`: schedule, run, attempt foundation; immutable-proof update trigger/checks; indexes/FKs; explicit PUBLIC revoke and least-column grants.
- `integration-service/etl-worker/snapshot-contract.ts`: exported `SnapshotRunMode`, `SnapshotRunStatus`, `SnapshotRunProof`, `SnapshotRunSummary`; no external secret/config body.
- `integration-service/etl-worker/snapshot-runs.ts`: caller-transaction `createSnapshotRun`, `listSnapshotRuns`, `getSnapshotRun`, and `admitDueSnapshotRun` gate for later strict-worker scheduling. Bind every query to tenant/source/run; no timer loop or source I/O in these repository methods.
- `integration-service/ingestion-api/snapshot-routes.ts`: strict API-019–021 route schemas, scope checks, idempotency and safe response mapping using existing envelope.
- `integration-service/source-registry/service.ts`: create the persisted schedule row idempotently on source activation/resume, with the first full snapshot due immediately; tie schedule revision to the active config proof.
- Existing ingestion route/bootstrap composition file at the frozen source BASE: mount the new route object without changing existing API-015–018 behavior or legacy feature flags.
- `integration-service/acceptance-tests/migrations.test.ts`: additive 009 expectation, preserving 001–008 checks.
- `integration-service/acceptance-tests/snapshot-runs.test.ts`: isolated synthetic local PostgreSQL cases below. No `.env`, raw secret, real source, or live existing database.

If the frozen BASE has different names/route composition points, report that with exact `git show BASE:path` evidence and update the implementation map before edits; do not silently edit the checkout or broaden scope.

## Red/green evidence required after dispatch

- Migration RED: schema/run route missing or 009 rejects; GREEN applies 001–009, repeat skips 009 without data/proof changes, and proves 001–008 source checksums/bytes unchanged.
- API-019 RED: missing strict route/active-run/idempotency gate; GREEN creates a durable 202 run with frozen proof from current config and stable replay of same key; same key with changed run request is 409; disabled/paused/stale revision/wrong scope/cross-tenant is rejected without run or attempt rows.
- Scheduler RED: duplicate due/manual contenders can create overlapping runs; GREEN two concurrent transactions yield one active source run, due polling creates no second run while active, due state survives restart, and unrelated tenant/source can proceed.
- Entity gate RED: incomplete order mapping can be admitted; GREEN customer-only admitted; order admitted only with explicit approved line relation/key/order FK/all required maps; no guess is generated. Unsafe source version + no snapshot observation fails closed.
- API-020/021 RED: unsafe/unfiltered list or stage leakage; GREEN safe default/max page, tenant/source filtering, status/time filters, no payload/credential/secret exposure and no fabricated completeness/checkpoint success.
- Role checks: actual `hub_api` can perform only API run admission/safe reads; cannot select stage/raw or mutate canonical/source authority. `hub_worker` can claim/admission-gate permitted fields only. Cross-tenant run IDs and guessed source IDs do not leak existence. PUBLIC has no new function/table permission.

Capture exact command/stdout/stderr/exit for focused RED/GREEN, typecheck, build and any required scoped suite in the dispatch evidence package; bind tested source bytes with pre/post raw SHA-256/LF SHA-256/size/Git blob manifest. Keep failed attempts. Use unique run-owned PostgreSQL fixture containers pinned to the approved PostgreSQL 16 image digest and record exact IDs, ownership, image, cleanup, and post-cleanup absence. These requirements describe future dispatched verification; no evidence or passing status is claimed by this planning brief.

## Phase A exit and later blockers

A closes only after independent Spec/Quality review of schema/run admission/API/scheduler behavior and tested source binding. Review must state the tested commit/source bytes and actual role evidence. 009 remains phase-owned and may change in later slices under an explicit focused review; the final M1-5 review covers the complete migration and all dependent source.

Load-bearing later design point: channel-switch approval bootstrap. Before Phase E dispatch, define whether pending config gets a separate API-007 test/approval before staging and a distinct final Owner reconciliation receipt afterward, and how the current unique approval constraint accommodates both without making pending config current. The safe sequence is pending revision/channel persisted separately, complete stage validation without business apply, exact current Owner receipt for final digest, then one guarded transaction retiring old channel and activating pending config/new epoch; apply under the new frozen proof only after cutover. Precommit failure leaves the old channel current.






## Controller rulings and implementation authorization

- Coding is authorized only by the forthcoming exact-BASE dispatch. Source inspection remains delegated to Luna, review to GPT-6.1 Sol. Preserve all blocked host artifacts and external prior runtime roots.
- A run freezes proof PER REQUIRED ENTITY: existing channels are entity-scoped. Persist a typed immutable entity-to-channel/context proof map or child rows; never use one customer's channel for an order. Source-wide config/approval facts may be shared only where the existing schema does so. Verify actual SourceConfig entity property names/exports against BASE; planning names do not create new authority.
- Phase A may explicitly reject order snapshot admission until Phase B implements the approved order-line profile/mapping contract. Do not invent line relation fields or claim a positive order snapshot contract in A. A must prove customer-only eligibility and safe incomplete-order rejection; Phase B owns the full positive order contract and real source extraction.
- Activation/resume creates an enabled snapshot schedule only for a currently approved PostgreSQL FULL_SNAPSHOT config; REST sources retain their existing behavior. Scheduling must not contact sources in A. The due gate requires active enabled tenant/credential/source, frozen per-entity approved channel/proof and typed security-fence checks; persisted rows are authority, no in-memory authorization shortcut.
- Use the shared global security guard as the FIRST lock before source/channel/schedule row locks on all new admission paths. Do not claim that a shared backend role is tenant RLS. Reads/API derive tenant from verified principal and use explicit predicates; source bearer tokens are never admin principals.
- Migration009 stays phase-owned until whole M1-5 review. No deployment or reuse of an already released009 is authorized; later diffs require explicit review/upgrade treatment. 001–008 remain immutable.
- One writer only. Capture red-first focused tests and exact stdout/stderr/exits/source pre/post raw/LF/cleanblob/size snapshots, then typecheck/build; one full-suite gate is required at final integrated M1-5, not every intermediate slice. Use unique external absolute M0_RUN_EVIDENCE_ROOT and captures outside Git to avoid the known recorder race; copy only individually safe hash/size-whitelisted artifacts after tests. Unique owned PG IDs/labels/removal/absence only, no env/secret/certificate/Config.Env read, no policy-rejected cleanup retry.
- Commit explicit product/test/doc paths first, separate explicit safe evidence/report whitelist next. Write identical reports to this workspace/task-5a-report.md and docs/execution/alpha1/m1-task-5a-report.md, with full M1-5 marked IN_PROGRESS. No literal workspace/ directory, progress/status/public-plan edits, push/merge/deploy, Task5B implementation or subagents.

