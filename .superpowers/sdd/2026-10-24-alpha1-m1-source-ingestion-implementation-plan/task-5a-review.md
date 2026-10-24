# M1-5A independent Spec and Quality review

**Spec: FAIL. Quality: Needs fixes.** Five source findings remain: three P1 and two P2. These are source defects, separate from the assurance limits below. M1-5 remains **IN_PROGRESS**; formal 48-gate acceptance is **NOT_RUN**.

## Reviewed boundary and source binding

- BASE: `b6177cc8b10537d07c0d25ec6654475045036f1e`.
- Product/test source: `4166e6d47d01ee8daad3c3f81b64055f73f37d8e`.
- Evidence/report commit: `8bd7b970` (report amended before this first review).
- Reviewed HEAD: `c90ed6179692c11b8da995f8654b0cfefba6b752`.
- Comparison: `git diff b6177cc8b10537d07c0d25ec6654475045036f1e...c90ed6179692c11b8da995f8654b0cfefba6b752 -- integration-service`; full retained U10 review package and commit list read.

Read the complete A brief and controller rulings first, A implementation report, master Task 5 brief and preflights for boundaries, both M1/M0 blocked-artifact policies, and relevant existing auth, migration, registry and strict-ingestion seams. No applicable AGENTS.md or repository coding-standards file was found. Applied the code-review skill's spec/standards checks as one assigned reviewer; no subagents were created.

All 11 changed integration-service paths were reviewed: `acceptance-tests/helpers/postgres.ts`, `acceptance-tests/migrations.test.ts`, `acceptance-tests/snapshot-runs.test.ts`, `app.ts`, `auth/errors.ts`, `etl-worker/snapshot-contract.ts`, `etl-worker/snapshot-runs.ts`, `ingestion-api/routes.ts`, `ingestion-api/snapshot-routes.ts`, `migrations/009_snapshot_runs_and_recovery.sql`, and `source-registry/service.ts`. Migrations 001–008 have no diff. Migration 009 remains phase-owned until the complete M1-5 review; this review does not freeze its bytes.

The recorded before/after manifests both identify actual test-time HEAD `0d0154d0a761c55d7523985f5c7138076fc94ea2` with the 11 product/test files dirty or new. Their 11 complete file entries match each other and the committed manifest; each recorded clean blob independently matches `4166e6d:<path>`. Thus the tests bind to the implementation bytes, rather than incorrectly treating the test-time HEAD alone as the tested product. The later evidence/docs commits introduce no additional integration-service source differences. Controller's independent 49-artifact SHA/size inventory reports zero mismatches; this reviewer did not rerun that inventory or the gates.

## Source findings

### M1-5A-R1 — P1 — Schedule persistence cannot execute as hub_api

**Locations:** `integration-service/source-registry/service.ts:583–586`; `integration-service/migrations/009_snapshot_runs_and_recovery.sql:148–149,171`.

The new PostgreSQL FULL_SNAPSHOT activation/resume statement inserts `(tenant_key,source_id,enabled,interval_seconds,next_due_at,schedule_revision)` into `etl_snapshot_schedule` and its conflict branch updates `interval_seconds`. Migration 009 grants `hub_api` schedule SELECT and selected UPDATE columns, but grants no schedule INSERT and no UPDATE on `interval_seconds`. No earlier migration can grant rights on this new table, and the default privileges do not supply them.

**Concrete failure:** activate an approved PostgreSQL source using the real API role, or resume it through the same upsert. PostgreSQL denies the schedule statement; the registry transaction rolls back and the API returns AUTH_UNAVAILABLE/503. Persisted enabled activation scheduling therefore does not work at the required runtime boundary. The snapshot tests call registry create/test/approve/activate using `fixture.pool` before switching the run routes to `hub_api`, masking this defect.

**Required repair:** provide the exact narrowly scoped schedule creation/update authority required by this statement, directly or through an appropriately guarded function, and exercise activation, pause and resume as actual `hub_api`. Preserve PUBLIC revocation and existing authority boundaries.

### M1-5A-R2 — P1 — Admission's security-barrier predicate is ineffective

**Location:** `integration-service/etl-worker/snapshot-runs.ts:153–155` (fence captured at 70–72; approval query at 127–149).

`lockedProof` compares stored barriers with `effective_fence > fence`, where `fence` is the latest global sequence value obtained under the global barrier guard in the same transaction. Existing committed barriers cannot have a larger fence, and new barrier writers are serialized behind this guard. Consequently this check cannot reject an existing security barrier. The approval query does not load `approval_security_fence`; the check also omits the existing typed credential/entity/channel matching and nullable tenant-wide source scope.

**Concrete failure:** approve and activate a source, disable its tenant through the existing repository (which records TENANT_DISABLED), then re-enable that tenant without replacing the source's approval. The source can remain ACTIVE and the old approval's config/credential/mapping tuple still matches. Both manual and due admission accept that pre-barrier approval and freeze the newer fence, placing the earlier barrier behind the run's fence. Existing strict REST admission instead tests typed applicable barriers since `proof.approval_security_fence` (`strict-ingestion.ts:216–225`).

**Required repair:** use the persisted approval fence as the historical authorization boundary, check the applicable barrier types against each frozen entity/credential/channel context under the first global guard, and retain the current admission fence separately. Prove stale approval rejection and correctly scoped unrelated barriers with actual API/worker roles.

### M1-5A-R3 — P1 — New run paths do not fully revalidate the authenticated identity

**Locations:** `integration-service/etl-worker/snapshot-runs.ts:196–206,255–258,283–287`; `integration-service/ingestion-api/snapshot-routes.ts:15–20`.

Manual admission accepts an auth dependency as unused `_auth: unknown`. Its locked check verifies only that the principal's tenant/user remains enabled and retains source:write; it never verifies that the principal's issuer/subject is still enabled and bound to that same tenant/user. List/detail only inspect scopes on the supplied principal and query its tenant, with no current binding/subject/scope check in the data operation. The route does perform real OIDC authentication, so this is an operation-time stale-principal gap, not a source-token fallback.

**Concrete failure:** OIDC resolves a principal, then its identity binding is disabled or rebound before the request obtains a database connection. The former subject remains enabled with source scopes. Create still inserts or replays under the old identity; list/detail still return that tenant's runs. For reads, removing source:read or disabling the subject after principal resolution likewise goes unchecked. Existing `control.lock_api_identity(issuer,subject)` and the auth service's identity-matching pattern already supply an authority seam; checking an arbitrary enabled user row is insufficient.

**Required repair:** revalidate the issuer/subject binding, enabled tenant/subject and applicable current scope at the operation boundary, match the current identity to the supplied principal, and include replay/read paths. Reuse existing auth authority and preserve guard-first ordering. Add deterministic cases where binding/scope changes occur between authentication and repository work.

### M1-5A-R4 — P2 — API-020 cursor truncates the database sort key

**Location:** `integration-service/etl-worker/snapshot-runs.ts:270–280`; timestamp definition `migrations/009_snapshot_runs_and_recovery.sql:44`.

Pagination orders and filters by full PostgreSQL `(created_at,run_id)`, but builds the cursor with a JavaScript Date's millisecond `toISOString()`. `created_at` is `timestamptz DEFAULT clock_timestamp()`, so it can retain microseconds that the driver/Date path discards.

**Concrete failure:** page size 1 returns a row at `.123900`, and another eligible row is at `.123800`. The generated anchor is `.123000`; the next page's `< anchor` excludes the second row permanently. Equal original timestamps can also skip remaining UUID tie-break rows when the original timestamp has a nonzero microsecond remainder.

**Required repair:** retain an exact database timestamp in the cursor or resolve an authorized run-ID anchor to its database sort key, keeping both sides of pagination at identical precision. Test multi-page enumeration with same-millisecond timestamps and UUID ties, asserting no omitted or repeated rows.

### M1-5A-R5 — P2 — Malformed cursor/run IDs reach SQL casts and become availability errors

**Locations:** `integration-service/etl-worker/snapshot-runs.ts:268–276,283–287`; error mapping `ingestion-api/snapshot-routes.ts:9–12`.

The UUID checks accept any 36 characters from `[0-9a-f-]`, including 36 hyphens. The cursor timestamp check validates only a prefix such as `2026-99-99T`. These values reach `$7::uuid`, `$6::timestamptz`, or the inferred UUID run-ID comparison. PostgreSQL rejects the cast; the route converts the unclassified exception into retryable AUTH_UNAVAILABLE/503.

**Concrete failure:** request `/hub/v1/admin/etl-runs/------------------------------------`, or supply a canonical base64url cursor encoding an invalid prefixed date plus a regex-accepted invalid UUID. Validly authenticated bad input yields 503 rather than a stable input/not-found result. An empty cursor is also silently treated as no cursor.

**Required repair:** validate complete canonical UUID/date/cursor structure before the query, including empty cursor handling, and map malformed input to the intended safe 400/404 envelope. Add route cases for these exact inputs.

## Spec and standards assessment

The implementation stays within A's feature boundary: durable run/schedule/first-attempt rows, immutable proof, one-active-run partial unique index, 300-second persisted scheduling, and API-019–021. Manual and scheduled insertion share the guarded admission path; per-entity channel data comes from locked database channel rows. Customer-only admission is supported and order admission explicitly fails closed, consistent with the controller ruling that B owns the positive order-line contract. SOURCE_VERSION with hard-delete absence is rejected. No observations, extraction, staging, business application, checkpoint advancement, deletion, retry/cutover API, competing queue, or new auth authority is implemented or expected here.

The new definer helper has a fixed search_path, an explicit owner and restricted EXECUTE grants. New tables/functions revoke PUBLIC. API summaries enumerate safe fields and initially report NOT_STARTED/null checkpoint; no source secret or stage payload is selected for these responses. REST and legacy route gates retain their composition. These observations do not resolve R1–R5. No separate nonfunctional smell is used as a blocking finding.

## Retained verification and missing assurance

Read the actual retained command captures: snapshot tests **6/6**, migration tests **19/19**, typecheck exit **0**, build exit **0**. The retained RED fails because the run schema is absent. The retained intermediate **18/19** migration run fails at the compiled CLI's migration 007 because fixture isolation left the raw schema; the subsequent fixture change drops raw as well and the final 19/19 capture is retained. No change to 001–008 is involved. These are retained implementation results, not a fresh reviewer rerun or a full-suite result.

**M1-5A-G1 — assurance gap, separate from source defects:** the six snapshot tests do not cover the brief's required cross-tenant/guessed-source cases, current binding/tenant/subject drift, typed barriers, positive list pagination/filter traversal, simultaneous manual-versus-due contenders, restart durability, or unrelated tenant/source progression. Actual role execution covers manual create/read and one update denial as hub_api, and due admission as hub_worker; privilege metadata covers selected grants. It does not prove real-role activation/resume, denial of raw/stage/canonical/source-authority access, the broader worker-negative boundary, or comprehensive PUBLIC permissions. The uncovered activation role path contains R1. Fill the focused A gaps during repair; do not label service tests as route cases or imply full-suite coverage.

Fastify inject tests cover create/replay/changed-request conflict, read-only POST denial, one invalid list filter, safe detail and paused replay. Overlap/due concurrency and order/version-contract rejection are direct service/database tests. No positive HTTP list traversal or full security matrix is retained.

The fixture helper's startup recovery/ownership checks and exact-ID cleanup contract were read; no new live Docker/resource operation was performed. Sanitized inventory retains 58 events across 20 run labels: 19 created/image-observed/ownership-confirmed removed-and-absent resources, plus the one no-ID start failure. The final snapshot fixture starts by approved digest. The final migration fixture starts by mutable `postgres:16.10-alpine` (migrations.test.ts:59), with the retained observation showing the exact approved digest/runtime image ID. Describe this as observed digest binding, not as both callers requesting a pinned digest; use the explicit imageReference for subsequent scoped fixtures.

Only the two final lifecycle JSONLs are copied verbatim; other original lifecycle records remain external. The no-ID start's retained healthy Docker 29.8.1 exact task+run label query exited 0 with zero matches; no removal is asserted. A wording correction is appropriate: `helpers/postgres.ts:103` passes deterministic `--name dgo-m0-${runLabel}`. The failure event did not record that name or retain the raw startup command; “no name recorded in retained startup evidence” is accurate, whereas “the fixture supplied no name” is not. This does not establish a current resource leak or require another live probe. Raw startup/CID-path evidence was not copied, and no cleanup retry was attempted.

No gates, fixtures, containers, source connections, external network/site tests, blocked targets, environment/secret files, certificate material or Config.Env were accessed or rerun for this review. No product or Git mutation was made. This review writes only this report. Prior Task 3 assurance limits and Task 4's distinct original worker assurance gaps remain open; this A review closes none of them. B–E and formal acceptance remain outstanding.

**Disposition:** repair R1–R5 and supply focused missing A assurance before approving A or dispatching dependent source implementation. Review the repair at a newly fixed source/evidence commit; retain phase ownership of 009.
