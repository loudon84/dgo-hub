# M1-5A Fix 1 scoped independent re-review

**Spec: FAIL. Quality: Needs fixes.** R1–R4 are **ADDRESSED**. R5 is **NOT_ADDRESSED** in full: the original malformed UUID/cursor cases are repaired, but one concrete invalid date still reaches PostgreSQL and becomes retryable 503. Its remaining severity is P2. G1 is substantially improved, with the residual assurance limits recorded separately below.

M1-5 remains **IN_PROGRESS**; formal 48-gate acceptance remains **NOT_RUN**. This review does not approve B–E or freeze phase-owned migration 009.

## Scope and evidence binding

Read the complete A brief/controller rulings, original R1–R5/G1 review, historical/current implementation report, and full `context/task-5a-fix1-review-package.txt` commit log/stat/U10 diff. The M1/M0 blocked-artifact policies remain binding and were reread. The code-review skill's two axes were applied within the assigned single-reviewer scope; no subagents were used.

- Previous reviewed HEAD: `c90ed6179692c11b8da995f8654b0cfefba6b752`.
- Fix implementation BASE: `515ecbcd2bbbdcaeb1c6382b110e6f373c236ac2`.
- Fix product/test commit: `b2ea8e7998ece418fba1e105e38adda8e19e4d1e`.
- Evidence commit: `f7f6e086`; reviewed final HEAD: `aa1f46cf7952f60d8b325cedf9dcab767b226f3f`.
- Source comparison: `git diff c90ed6179692c11b8da995f8654b0cfefba6b752...aa1f46cf7952f60d8b325cedf9dcab767b226f3f -- integration-service`.

Reviewed all seven changed paths: snapshot and migration acceptance tests, `auth/service.ts`, `auth/types.ts`, snapshot run repository/routes, and migration 009. Existing auth repository/locked-identity seams and all affected snapshot list/detail callers were checked only as necessary to assess these repairs. No broader prior-phase audit was performed, and no additional material regression was found in the other repair hunks.

The 117-entry retained artifact manifest has controller-reported independent SHA/size verification with zero mismatches. Independently checked recorded source binding: the corrected final-build before/after manifests contain 13 source files with identical complete entries; their raw hashes/sizes match the committed manifest, and every committed source blob matches `b2ea8e7:<path>`. All eight immutable migration entries match before/after, committed raw hashes and original BASE blobs. There is no 001–008 source diff.

Test-time HEAD was **515ecbc plus dirty implementation edits**, not the already committed fix. Chronology is explicit: the expanded 16-test snapshot pre-gate snapshot at `2026-10-24T15:41:07Z` matches the final source except `acceptance-tests/migrations.test.ts`, whose separate fixture was subsequently changed to request the pinned image. The migration pre-gate snapshot at `15:42:01Z`, typecheck snapshots at `15:43:01Z/15:43:18Z`, and corrected build snapshots at `15:44:30Z/15:44:35Z` match the 13 committed source files. Thus the final snapshot suite covers the final snapshot/auth implementation, while the subsequent migration run and compiler/build captures cover the final fixture change as well. Earlier narrower/mismatching captures are retained as history and are not substituted for these final captures.

## Original finding dispositions

| Finding | Disposition | Source and retained verification |
|---|---|---|
| M1-5A-R1, P1 | **ADDRESSED** | Migration 009:150–151 adds only the schedule INSERT columns used by activation; line 173 adds `interval_seconds` to the existing narrow schedule UPDATE grant. PUBLIC remains revoked. Snapshot test:105–118 performs schedule creation, pause and conflict-update resume through the real hub_api role. The focused pre-fix RED is retained; the final suite includes the passing lifecycle case. |
| M1-5A-R2, P1 | **ADDRESSED** | `snapshot-runs.ts:139–179` loads the persisted `approval_security_fence` and checks applicable typed barriers newer than that approval, including null source/credential/entity/channel scopes. Current admission fence is retained separately. Tests:277–310 reject manual/API-role and due/worker-role admission after tenant disable/re-enable under old approval, recover with fresh tested approval, and permit unrelated tenant/source/credential/entity/channel barriers. |
| M1-5A-R3, P1 | **ADDRESSED** | `auth/service.ts:407–411` reuses `identityByOidc(..., true)`/`control.lock_api_identity`, checks the enabled binding/subject/tenant, matches tenant/user/issuer/subject, and reads current required scope. `snapshot-runs.ts:222–223,288–289,312–313` acquires the global barrier guard first and invokes this check for create/replay/list/detail. All affected route callers pass the auth dependency. Deterministic inject cases change binding, scope, principal binding target or tenant state between authentication and repository work. |
| M1-5A-R4, P2 | **ADDRESSED** | `snapshot-runs.ts:285–304` uses a canonical run UUID cursor and a tenant-qualified database anchor, comparing the exact stored `(created_at,run_id)`. No Date conversion participates in the page boundary. Test:429–465 traverses same-millisecond microsecond values and UUID ties via HTTP pages and checks exactly three unique run IDs with no omissions/repeats. |
| M1-5A-R5, P2 | **NOT_ADDRESSED** in full | Complete UUID checks, canonical UUID cursor decoding and empty-cursor rejection repair the named UUID/cursor examples. Calendar validation repairs the named malformed date. The remaining year-zero case below still produces the same erroneous availability-error class. |

Auth exception semantics were inspected directly: the new `assertCurrentPrincipal` calls `identityByOidc` without wrapping the whole assertion in `authQuery`. It throws the existing `AuthError` values for missing/revoked/rebound/forbidden identities. The snapshot transaction's catch preserves `AuthError`, so AUTH_REVOKED and AUTH_CONTEXT_CHANGED reach the route with their intended 401 statuses, and current-scope denial reaches 403. The retained intermediate 503 failure is historical; it is not the final implementation. The shared `assertCallerMatches` change adds issuer/subject comparison to its existing callers without introducing another auth authority.

## Remaining source defect

### M1-5A-R5 — P2 — Year-zero date passes validation and reaches the PostgreSQL timestamp cast

**Locations:** `integration-service/etl-worker/snapshot-runs.ts:35–49,279–280,294–300`; transaction error mapping at 78–81.

The new RFC3339 expression permits a four-digit year of `0000`. The validator checks month/day/time/offset and finite `Date.parse`, but does not reject year zero. JavaScript accepts `0000-01-01T00:00:00Z`; PostgreSQL's timestamp input domain has no year zero. The original string is passed unchanged into `$4::timestamptz` or `$5::timestamptz`. Its database input error is converted by the transaction into AUTH_UNAVAILABLE and returned as retryable 503.

**Minimum concrete request:** an authenticated reader sends `GET /hub/v1/admin/etl-runs?created_from=0000-01-01T00%3A00%3A00Z`. This is invalid input for the backing timestamp domain and must receive the stable 400 envelope, rather than an availability error. No existing run is required because the invalid bound cast itself fails.

A minimal read-only source probe evaluated only the current validator body, with its TypeScript annotation removed in memory and the existing fail behavior represented as an error. It accepted year zero with finite value `-62167219200000`. The same probe rejected February 30, April 31, 24:00 and a nonleap February 29, and accepted a valid leap day. No database or fixture was started or queried.

**Required repair:** reject unsupported year zero before SQL (or explicitly map input to a supported timestamp domain), and add this exact route regression expecting nonretryable AUTH_INPUT_INVALID/400. Retain the strict UUID/cursor and other calendar checks already repaired. This is the unclosed date-validation part of R5, not a new unrelated feature request.

## G1 focused assurance ledger

**G1 is partially addressed; these limits are not additional source defects.** The final suite adds meaningful evidence for real-role activation/resume; manual-versus-due contention; typed historical barriers/fresh approval; OIDC binding revocation/rebinding, tenant and scope drift; tenant-qualified detail/list reads and guessed source filtering; exact cursor traversal; malformed UUID/date/cursor handling; and safe responses. API instance recreation verifies that the persisted admitted run/schedule can be read by a newly built Fastify app. It does not simulate a process or database restart. The callable due gate remains persisted and guarded without introducing a timer.

Role evidence includes actual hub_api lifecycle/create/read execution, denial of raw SELECT and run-status update, and actual hub_worker due admission and proof-column update denial. Privilege metadata additionally checks schedule insert/update, PUBLIC schedule INSERT/run SELECT and API credential-digest SELECT. The repair grants remain narrow and do not add raw/canonical/source-authority rights.

Residual limits from the original G1 remain explicit:

- No positive status/time-filter result assertions or default-20/maximum-100 result-count traversal are present. Positive HTTP pagination is tested at limit 1; foreign/guessed source filters are tested with empty results.
- Current subject-disabled reads and every create/read/replay cross-product of revocation types are not separately exercised; the common locked authority check is source-reviewed and selected cases are tested.
- The new actual-role negative checks do not amount to the complete raw/stage/canonical/source-authority/worker/PUBLIC permission matrix. In particular, canonical/source-authority denials and comprehensive new-object PUBLIC permissions are not newly executed. Stage objects are outside A.
- Cross-tenant detail/list isolation and unrelated source progress are tested; this is not every cross-tenant create/replay or cursor variant.

These limits should remain in the assurance ledger and guide bounded later verification; they do not justify claiming a full security matrix or a fresh full suite. Prior Task 3 assurance limits and the distinct original Task 4 worker gaps remain unchanged by this scoped re-review.

## Retained command and lifecycle evidence

Read the actual final retained stdout/stderr/exit captures: expanded snapshot suite **16/16**, migration suite **19/19**, typecheck exit **0**, corrected build exit **0**. All final stderr captures are empty. The package retains the R1 RED and intermediate failed snapshot run, followed by 12/12, 15/15 and final 16/16 captures. These are implementation-run results; this reviewer did not rerun gates or claim full-suite acceptance.

The final migration fixture now explicitly requests the approved PostgreSQL digest. The package is assembled from six distinct external command roots under `E:/m1t5-runtime`; only whitelisted safe artifacts were copied. The original external files remain untouched.

Independently counted the nine raw lifecycle JSONLs retained in this repair package: six M1-task-labelled fixtures plus three separately identified historical task0 fixtures, with nine unique created IDs and nine ownership-confirmed removals with absence true. Combined with the original 19 M1 task fixtures, the retained inventory represents **25 M1-task created/removed fixtures**, plus **3 task0 fixtures**, or **28 distinct created fixtures across both label groups**. The historical no-ID startup is separate and is not counted as removed. Its already retained healthy-daemon exact task+run-label query returned exit 0/zero matches; no new live probe was made. The helper's deterministic startup name is source-visible; absence of a name in retained startup evidence must not be described as the helper supplying no name.

No product/Git mutation, subagent, new fixture, resource action, database/source connection, network/site test, environment/secret/certificate/Config.Env read, blocked-target access, cleanup retry or raw external artifact copy occurred in this review. Only this re-review report was written. The sole execution beyond read-only inspection was the small in-memory date-validator probe described above.

**Disposition:** close R1–R4 for this fixed source; keep R5 open at P2 and retain G1's residual assurance limits. Repair and verify the exact year-zero input before A approval. Migration 009 remains owned by the full M1-5 phase; B–E and formal acceptance remain outstanding.
