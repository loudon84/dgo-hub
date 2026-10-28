# M1-5D2 independent Sol review

## Spec Compliance

- **FAIL — three Important findings.** API-021 cannot round-trip some valid generated cursors, reports a nonexistent candidate for headerless D reservations, and freeze/revalidation maintain separate copies of the mandated canonical digest serializer. Details and causal source references are below.
- Reviewed source-only package `task-5d2-review-package.txt`, BASE `7c8d815d81e015f1594c6990ee7853cc3ef7543c` → product `0871e857fe00b866fdf9a8b51a19641ebfb11d33`, against the complete task brief/controller appendices and `context/m1-task5d2-schema-contract.md`. Corrected report/evidence revision: `c1f1b1b7015103ebcb60098ad90ed0d9631d3444`.

## Strengths

- Guarded database authority is substantive: API-021 checks the enabled exact Owner and both current database scopes; API-060 locks the source/Owner/current OIDC identity and checks paused state, candidate revision/digest, current proof and baseline before either approval or replay (`integration-service/migrations/009_snapshot_runs_and_recovery.sql:2012`, `:2068`, `:2095`, `:2107`, `:2119`).
- Freeze captures exact live baseline membership, and approval compares it with the current count and full tuple fingerprint; equal-count substitution is explicitly exercised (`integration-service/migrations/009_snapshot_runs_and_recovery.sql:1545`, `:1970`; `integration-service/acceptance-tests/snapshot-runs.test.ts:1395`). The public member projection omits canonical UUIDs (`integration-service/migrations/009_snapshot_runs_and_recovery.sql:2062`).
- Approval, idempotency and sensitive-read/approval audit records are immutable, with narrow API EXECUTE grants and revoked table access. Actual locked DB identity epoch is persisted. Approval performs no canonical DML or source activation/schedule release (`integration-service/migrations/009_snapshot_runs_and_recovery.sql:1901`, `:1940`, `:2130`, `:2147`).
- Real HTTP/API-role fixtures exercise audit failure rollback, identity disable/rebind rejection, scoped replay/conflict and independent customer/order approval while retaining pause/busy state (`integration-service/acceptance-tests/snapshot-runs.test.ts:1306`, `:1422`, `:1456`, `:1484`, `:1530`).

## Issues

### Critical (Must Fix)

- None identified.

### Important (Should Fix)

1. **[P2] Generated full-key cursors exceed the accepted cursor limit.** `integration-service/etl-worker/snapshot-runs.ts:331` rejects more than 1024 characters, and `integration-service/ingestion-api/snapshot-routes.ts:57` applies the same cap, while `snapshot-runs.ts:347`/`:379` encode both the outer scope and the full last key without a matching size guarantee. A source ID of 256 ASCII characters is valid under the existing source contract (`integration-service/source-registry/service.ts:67`). With that source ID, a one-character tenant/key, ordinary UUIDs and a 64-character digest, the exact emitted JSON/base64url shape is **1116 characters**. A two-member candidate with `limit=1` therefore returns a next cursor that its next request rejects with 400. Set a defensible bound covering every supported encoded identity (including UTF-8/JSON escaping), or use a bounded representation preserving the required scope/full-key binding. Add one focused HTTP round-trip regression using a valid long source ID.

2. **[P2] Headerless reservations produce a phantom `AWAITING_OWNER` candidate.** `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1997` aggregates `jsonb_build_object(...)` over the LEFT JOIN at `:2003` without filtering out `c.candidate_id IS NULL`. A real D reservation can have no candidate headers: non-hard-delete C completion is deliberately reserved as `SKIPPED` (`:1351`). The LEFT JOIN still contributes one row; `jsonb_build_object` is non-null, so `coalesce(...,'[]')` does not remove it. The STRICT ratio helper (`:1319`) returns NULL for that row, and the CASE labels it `AWAITING_OWNER`. Ordinary API-021 thus returns one all-null candidate requiring Owner approval for a skipped reservation with no such candidate. Apply `FILTER (WHERE c.candidate_id IS NOT NULL)` to the aggregate and add a summary assertion for a skipped or not-yet-frozen reservation, expecting `candidates: []`.

3. **[P2] Freeze and approval keep independent digest serializer implementations.** The new freeze baseline seed/member fold at `integration-service/migrations/009_snapshot_runs_and_recovery.sql:1545` is repeated in the new fingerprint helper at `:1849`; the candidate seed/member fold at `:1583` is separately repeated in `etl_snapshot_delete_candidate_recomputed_digest` at `:1879`. Freeze does not call either helper. The implementations agree today, but the task explicitly requires one canonical serializer authority, and the new duplicate logic leaves future field/order changes able to invalidate all frozen approvals or omit a binding from one path. This is a concrete structural requirement failure rather than an assertion of a current hash mismatch. Make freeze and revalidation call shared seed/member serialization and folding helpers; directly reuse the baseline fingerprint helper for the freeze-time baseline. Preserve a focused actual C→D lifecycle assertion proving frozen and recomputed values agree.

### Minor (Nice to Have)

- None recorded.

## Evidence and assurance

- Independently checked all **39** explicit packaged artifacts against both their recorded byte counts/SHA-256 and their individually named original external files. Package manifest SHA-256 is `e702f30efd294e5f83606190502c4fb8bc9513c513ad066c2df898ec9db601d9`. No directory crawl or recursive copy/cleanup was performed.
- For every gate, captured before/after manifests are identical and retain their true actual HEAD. Independently recomputed source raw SHA-256, LF SHA-256 and byte counts, then checked the recorded Git blob against the actual product `0871e857...` object and its content. Five paths match for each historical filtered gate; six paths match for each final full/typecheck/build gate. Focused Git object reads were solely to establish this required immutable source binding; the supplied diff was not regenerated.
- Read exact command/stdout/stderr/exit captures. Final full snapshot file: **26 passed, exit 0**, actual HEAD `0871e857...`, root `474a4e3c-df66-41d4-994f-cd0c67235271`. Typecheck and build: **exit 0**, same product HEAD, roots `1e9709ca-855c-4a5d-b2c2-f5c38f9ea1f2` and `b265b52c-ad75-468d-b7ee-77422ac0ea4c`. All five captured stderr files are empty. The two historical filtered runs each have 1 passed/25 intentionally skipped and actual HEAD `7c8d815...`; they were not relabeled as postcommit runs.
- Read the explicit PostgreSQL/Node lifecycle artifacts: final full gate records three named, image-pinned owned containers with ownership-confirmed removal/absence, and only labeled test-created continuation child PIDs with termination/recovery records. These are captured lifecycle attestations, not a fresh inspection of host resources.
- Both corrected implementation reports are byte-identical, SHA-256 `2367b587814f21a5b5799ed3372d9958bec30e6cb6d98060cff6a88d329550cc`. The report accurately qualifies default 20/max 100 calls against a two-member fixture: truncation beyond 20 and large-set pressure are **not empirically proven**. This existing assurance limit does not explain or cover finding 1.
- Bounded checks outside the diff addressed named risks only: inherited proof might omit current Owner/latest test authority (read `etl_snapshot_delete_proof_current`, `009...sql:1407`); legal skipped reservations might have no headers (read `reserve_etl_snapshot_delete_run`, `:1333` and STRICT ratio `:1319`); accepted source IDs might be shorter than the cursor counterexample (checked `source-registry/service.ts:67`); run UUID spelling might introduce another cursor mismatch (checked existing lowercase-only UUID matcher, `snapshot-runs.ts:34`, and did not record that suspected issue).
- No suites, migrations, resources or mutation tests were rerun. A read-only arithmetic serialization check established the 1116-character cursor counterexample. Product, index, HEAD, branch state, databases and resources were not changed. Only this review report was written.
- D3 effects, effect-aware baseline reconstruction after own tombstones, durable-approval epoch invalidation at D3 execution, formal 48 gates, Sites, Hermes and production/live-source behavior remain outside this D2 acceptance evidence. No claim of those capabilities or environments is made.

## Assessment

**Task quality: Needs fixes.** Counts: **0 Critical / 3 Important / 0 Minor**. The security transaction and captured local verification are strong, but the API-021 paging/summary defects and independent serializer copies prevent D2 acceptance at this source pin.
