# M1-3 Fix1 independent re-review

**Scoped Spec: PASS. Scoped Quality: Approved.** R1–R5 are all ADDRESSED. No new material source defect was found in the five-file repair diff. This closes the five source findings from `task-3-review.md`; the earlier missing-assurance list remains distinct and is not represented as newly tested.

## Review pin and scope

- Original reviewed HEAD: `90ce1940a32d3bf6bf4a1573b61f66a94452604a`.
- Fix source/test commit: `ccab1a043294a677db1c3ad54142bd2291c81e60`.
- Fix evidence/report HEAD and actual working HEAD during this re-review: `c7580032b6db43617c5c318e6bd8074ecbcb0c68`.
- Reviewed the full scoped product diff prepared in `context/task-3-fix1-review-source.diff` and the changed implementations/tests. Exactly five product/test paths changed: `strict-contract.ts`, `strict-ingestion.ts`, their contract/parser tests, and `acceptance-tests/strict-ingestion.test.ts`. A Git comparison confirms no integration-service differences between the fix source commit and evidence/report HEAD. Migrations 001–007 are unchanged from the original reviewed HEAD; the migration-range diff exited 0.
- Re-read the original review, authoritative brief including the final order empty-lines addendum, appended Fix1 report, and both M1/M0 policy-blocked artifact guards. Applied the existing code-review axes within the explicitly scoped independent re-review. No subagents were used.

## Finding dispositions

| Finding | Verdict | Repair and verification |
| --- | --- | --- |
| M1-3-R1, P1 | **ADDRESSED** | `integration-service/ingestion-api/strict-contract.ts:252` and `:255` require actual string status/currency values before enum membership, retaining the explicit CONFIRMED/COMPLETED nonempty-lines check. Array/object values cannot reach the string enum checks or be retained as an image. Contract regression at `strict-contract.test.ts:104` includes a valid DRAFT control for currency so another invalid field cannot mask the currency defect. Real PostgreSQL/HTTP regression at `acceptance-tests/strict-ingestion.test.ts:203` requires 422, nonretryable errors and unchanged durable counts for the array/object cases. Retained RED output shows the former 202 acceptance; final focused gate passes. |
| M1-3-R2, P2 | **ADDRESSED** | `integration-service/ingestion-api/strict-ingestion.ts:45` and `:52` compare every record's offset-adjusted whole second and separately padded fractional digits; `:227` / `:243` insert the selected minimum/maximum original timestamp strings. Comparing fractional digits separately avoids JavaScript millisecond truncation when selecting endpoints. The existing timestamp length bound makes padding to 20 digits sufficient for every currently validated fraction. There is no sort or mutation of records, raw body, public facts or digest inputs. The real PostgreSQL/HTTP regression at `acceptance-tests/strict-ingestion.test.ts:223` covers three unordered records, different offsets, an interior minimum, and maximum candidates differing by one microsecond; it checks 202, stored UTC microsecond endpoints, original ordinal facts and safe GET success. RED output retains the former 503; final gate passes. This follows the root ruling to use min/max over all instants. |
| M1-3-R3, P2 | **ADDRESSED** | `integration-service/ingestion-api/strict-contract.ts:233–234` now applies the existing identifier validator to both external identity fields. Names retain the general string contract. Contract regression at `strict-contract.test.ts:117` rejects 129 characters and either leading or trailing whitespace, and asserts accepted mixed-case spelling is preserved. The authenticated real PostgreSQL/HTTP invalid-image regression at `acceptance-tests/strict-ingestion.test.ts:203` verifies rejection without durable rows. |
| M1-3-R4, P2 | **ADDRESSED** | `integration-service/ingestion-api/strict-contract.ts:11` / `:73` limits error pointer construction to static known schema fields and numeric indexes 0–200; unknown property names return a safe containing path instead of copying request text. Both duplicate parsing and unknown-field validation use this helper. `strict-intake.test.ts:27` checks unauthenticated duplicate-private-key errors, while `acceptance-tests/strict-ingestion.test.ts:244` checks authenticated unknown and duplicate private keys, complete-response marker absence, 422/nonretryable errors and unchanged durable counts. The intermediate fixture correction does not remove authenticated unknown-field coverage. |
| M1-3-R5, P2 | **ADDRESSED** | `integration-service/ingestion-api/strict-contract.ts:15` / `:95` sets and checks depth 32 before further value descent; both object and array recursion increment the same depth. No blanket RangeError conversion is introduced. The 5,000-array case is covered by `strict-contract.test.ts:130`, unauthenticated HTTP at `strict-intake.test.ts:40`, and authenticated PostgreSQL/HTTP at `acceptance-tests/strict-ingestion.test.ts:244`. Tests require the normal input error, 422/nonretryable semantics and no rows. Legitimate hub.v1 nesting remains well within the bound. |

All locations above refer to fix commit `ccab1a0`; paths without a repeated directory are within `integration-service/ingestion-api/` unless explicitly prefixed by `acceptance-tests/`.

## Evidence examined

Evidence root: `docs/execution/alpha1/m1-task-3-fix1-evidence/6d154143-5941-42f6-ab69-247e9d61f0a0/`.

Read retained command records, relevant stdout/stderr, final source manifests, migration immutability and owned PostgreSQL inventory/lifecycle records. Independently hash-checked all **44** exact whitelist entries: no mismatch. Whitelist SHA-256 is `adad3a5825529ea388c381aaf067305b30529e044d7c4b62af4ec8b35d7c4742`.

| Retained capture | Observed result |
| --- | --- |
| `red-unit` | Exit 1; 5 failures / 20 tests, including accepted malformed enum/identifier inputs and the original RangeError. One unauthenticated unknown-field fixture also expected 422 from an intentionally unconfigured app and got 503. |
| `red-acceptance` | Exit 1; 3 failures / 13 tests. Output directly records invalid enum 202, unordered timestamp batch 503, and private property name in the error response. |
| `red-enum` | Exit 1 for the refined standalone enum regression, with the unrelated currency control made otherwise valid. |
| `green-focused` | Exit 1; 32/33 pass, one remaining unconfigured-app fixture expectation. The correction retains pre-auth duplicate coverage and authenticated unknown-field coverage. |
| `gate-focused` | Exit 0; 3 files, **33/33 tests pass**, including the real owned PostgreSQL/HTTP acceptance file. |
| `gate-typecheck` / `gate-build` | Each exit 0; both final stdout and empty stderr captures retained. |

The final gate commands ran at actual HEAD `bcfb34c167768a053250ccedefcb1f0759efe75f` with five dirty source/test files, rather than at the later fix commit. Independently compared `source-gate-pre-manifest.json` and `source-gate-post-manifest.json`: all five raw SHA-256, LF hashes and Git clean blobs match. Each final gate clean blob also equals the corresponding committed blob at `ccab1a043294a677db1c3ad54142bd2291c81e60`. The earlier intermediate source manifests are not substituted for these final bytes. Migration immutability evidence covers 001–007; Git confirms no migration change through the evidence/report pin.

The four retained PostgreSQL lifecycles each contain one create, image observation and removal for the same full container ID, with `ownershipConfirmed=true` and `containerAbsentAfterRemoval=true`. The selected image is `postgres:16.10-alpine`, repository digest `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`. Three runs initially wrote new untracked metadata beneath the old Task3 root because of the test's hardcoded root; the report discloses this, and individual safe copies are retained under `misplaced-owned-runs/`. This re-review inspected the selected copies and their hashes, without touching the originals. The final test honors `M0_RUN_EVIDENCE_ROOT` and its selected run is retained in the Fix1 root. No cleanup is needed or attempted by this reviewer. Historical removal records are evidence of the recorded cleanup, not a new live Docker inventory check.

## Testing and assurance limits

No tests, compiler/build gate, Docker command, external source probe or resource operation was rerun during this re-review. No additional source-only probe was needed: the scoped implementation and retained real HTTP/PostgreSQL regressions resolve the original uncertainties. Only this review report was written; no product, Git, progress, status or original evidence was mutated.

The final **33-test focused gate** is the post-fix test result. The earlier **18-file / 288-test full-suite pass** belongs to the pre-fix reviewed source and is not claimed as a post-fix full-suite execution. Original historical NOT_RETAINED output remains NOT_RETAINED; Fix1 does not reconstruct it.

The original separate assurance gaps concerning cross-tenant/source/entity negative matrices, controlled final-assertion races, additional transaction failure positions, broader policy/immutability/role matrices and actual dropped-response transport remain as recorded. This re-review does not convert their absence into new source defects or claim that all were closed by the focused repair tests.

Raw-storage encryption, live upstream capability probing, compromise recovery, M1-4 execution, snapshots, SQL Server, UI and external/site systems were not established by this repair or re-review. Formal 48-row site acceptance remains NOT_RUN. This approval is for the R1–R5 repair and material regressions introduced by its diff, with the earlier assurance limitations preserved.
