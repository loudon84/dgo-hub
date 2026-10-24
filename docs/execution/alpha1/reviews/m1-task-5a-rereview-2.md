# M1-5A Fix 2 scoped independent re-review

**Spec: PASS. Quality: Approved for this scoped repair. M1-5A-R5: ADDRESSED.** No additional finding or material regression was found in the two-file fix. R1–R4 remain closed under the previous re-review. The original source findings R1–R5 are now closed; the G1 assurance limits below remain recorded.

## Review boundary

- Previous reviewed HEAD: `aa1f46cf7952f60d8b325cedf9dcab767b226f3f`.
- Fix BASE: `deb3ee873a2fdfae5a150b0bb8ef9056ecaa7ca3`.
- Product/test commit: `025bf0fd887d3510d2890be73fc8694d2a7124d0`.
- Reviewed final HEAD/evidence commit: `5b750b0118c5c1c7de14d74f3cc88d63bb2071a6`.
- Comparison: `git diff aa1f46cf7952f60d8b325cedf9dcab767b226f3f...5b750b0118c5c1c7de14d74f3cc88d63bb2071a6 -- integration-service`.

Read the full scoped review package, the Fix 2 report append, the A brief and previous re-review's R5/G1 contract. Applied the existing code-review workflow to the sole open finding and possible new breakage in this tiny diff. Only `etl-worker/snapshot-runs.ts` and `acceptance-tests/snapshot-runs.test.ts` change. No migration changes, additional product behavior or broader prior-phase audit is involved.

## R5 closure

`integration-service/etl-worker/snapshot-runs.ts:42` now rejects `year === 0` with the existing `AUTH_INPUT_INVALID` error before calendar processing and before either bound is passed to SQL. Both `created_from` and `created_to` use this validator. The existing calendar, time, offset, UUID and cursor checks remain in place.

`integration-service/acceptance-tests/snapshot-runs.test.ts:474–488` extends the existing Fastify inject case to send both year-zero bounds and assert HTTP 400, `AUTH_INPUT_INVALID`, and `retryable: false`. It also asserts 200 for the valid `0001-01-01T00:00:00Z` lower-bound control. Existing malformed date/UUID/cursor/empty-cursor assertions remain in the same case. This verifies the concrete request from the previous finding through the actual route and hub_api database boundary.

The retained RED uses the extended test with the pre-fix validator and fails because a year-zero request returns 503 instead of 400. The same focused case is GREEN after the one-line guard. The implementation directly closes the PostgreSQL year-zero input-domain mismatch; no broader auth, pagination or lifecycle change is introduced.

## Retained verification and source binding

Read actual retained commands, stdout/stderr and exits from `docs/execution/alpha1/m1-task-5a-evidence/fix2-82e6cec7-4566-45c9-b9f6-1d77d0b0881a/`:

| Capture | Actual retained result |
|---|---|
| Focused RED malformed-input HTTP case | Exit 1; 1 failed, 15 skipped; expected 400, received 503 |
| Same focused GREEN case | Exit 0; 1 passed, 15 skipped |
| `npm run typecheck` | Exit 0, empty stderr |
| `npm run build` | Exit 0, empty stderr |

No migration suite or full snapshot suite was rerun in Fix 2, and none is claimed for these new bytes. The previous Fix 1 16-test snapshot and 19-test migration results remain historical evidence for that source revision.

All four command captures identify actual test-time HEAD `deb3ee8`, with the test/validator edits outside that HEAD. RED has the new regression test and the prior validator blob `b12544e...`; GREEN has the fixed validator blob `68eeea1...`. GREEN, typecheck and build each have two-file pre/post snapshots with identical raw SHA-256, LF SHA-256, size and clean-blob entries. Independently checked those entries against the committed manifest and both Git blobs at `025bf0f`: zero mismatches. Snapshot timestamps bracket GREEN at `15:58:10Z–15:58:14Z`, typecheck at `15:58:22Z–15:58:26Z`, and build at `15:58:40Z–15:58:44Z`; the committed manifest was captured afterward at `15:59:29Z` on 2026-10-24 UTC.

Independently verified every one of the manifest's **35** named safe artifacts for SHA-256 and byte size: **zero mismatches**. Only exact paths inside the approved package were read. This is file/evidence verification, not a new gate run.

The retained RED and GREEN lifecycle JSONLs each record a unique fixture with the approved pinned PostgreSQL image/digest, exact container ID, matching run/task ownership, exact-ID removal and confirmed absence. Both removals have `ownershipConfirmed: true` and `containerAbsentAfterRemoval: true`. No new Docker query, resource action or cleanup was performed. Earlier lifecycle accounting and the historical no-ID startup limitation remain as previously recorded.

## Remaining assurance and phase boundaries

G1 retains the previous limits: positive status/time-filter and default-20/maximum-100 result-count coverage; the untested subject-disabled and other authorization cross-products; the incomplete canonical/source-authority/worker/PUBLIC negative matrix; additional cross-tenant create/replay/cursor variants; and API-instance recreation rather than a process/database restart test. These are recorded assurance limits, not reopened R1–R4 findings or new source defects in this repair. Prior Task 3 and the distinct original Task 4 assurance gaps remain separate.

**M1-5 remains IN_PROGRESS. Formal 48-gate acceptance remains NOT_RUN.** Migration 009 remains phase-owned until the full M1-5 review; 001–008 remain immutable. B–E, extraction/staging/apply/deletion/cutover and deployment are not approved or implemented by this scoped repair review.

No product or Git mutation, subagent, test/fixture rerun, source/database connection, external network/site test, environment/secret/certificate/Config.Env read, blocked-target access or cleanup retry was performed. Only this re-review report was written.

**Disposition:** close R5 and approve the scoped Fix 2 source/evidence. Preserve the G1 assurance ledger and all later M1-5 review gates.
