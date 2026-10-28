# M1-I2b implementation report — pending independent review

Base HEAD: `c8166e8b422f3964b059cee5cd636177568b132c`. Status: local implementation prepared for review; not accepted, committed, deployed, or platform-certified. The schema/wiring contract was frozen in `context/m1-i2b-schema-contract.md` before product edits.

## Implementation

The compatible application registers the I2a import route through the existing source-registry/strict options. Worker context preserves a NULL import profile and requires a frozen SIMULATED_IMPORT INCREMENTAL SOURCE_VERSION configuration, matching non-null sample proofs, NULL approval/report/job profile and exact route; external profiles remain non-null and equal. Import order reference resolution uses the accepted typed tuple key for the frozen mapping and checks the exact live same-tenant identity/UUID under row locks. REST keeps the legacy key. The aggregate exposes narrow transaction hooks after header and each line for FI03.

Additive 012 extends the quarantine origin/shape, capture, listing and retry state; import proof trigger checks immutable job/config provenance, and API-024 returns SCOPE_UNAVAILABLE before creating any operation or child. Public filtering supports IMPORT. Documented deployment prerequisite is 012 then inventory/drain incompatible claimants, verify all compatible strict workers, and only then expose matching API. No runtime lock/capability guard is claimed; common hub SHA is evidence only. Default worker requires strict enablement. I3 owns import recovery.

## Verification and source identity

- First meaningful RED: actual OIDC intake and hub_worker failed with NULL `.toString()` at `E:/m1t5-runtime/0704e52f-f1e9-4bb4-b349-d42600d0cff6/test.log`.
- Final gate `E:/m1t5-runtime/2d447a72-e867-4c8e-8fc1-a2c5e9b57e32`: `npx vitest run acceptance-tests/management-import-worker.test.ts acceptance-tests/management-import.test.ts acceptance-tests/canonical-apply.test.ts acceptance-tests/strict-ingestion.test.ts acceptance-tests/migrations.test.ts acceptance-tests/identity-store.test.ts acceptance-tests/source-registry.test.ts` 146/146, exit 0; `npm run typecheck` and `npm run build`, each exit 0. Individual logs/exits are there. Raw SHA-256 manifests of 118 product TS/SQL/MD files, including untracked new files, are identical immediately before and after; HEAD before/after is the base above. This bracket identifies the exact tested tree, not a commit of changes.
- Full new test file uses actual signed OIDC, source API, PostgreSQL hub_api and hub_worker. It covers same-source sample before rows; customer applied -> explicit typed mapping -> retest/reapproval/reactivation -> two-line order with independent literals, customer UUID and large version; explicit foreign confirmed reference and order-only source; mismatched live tuple target, missing reference, actual other-tenant source/identity and rejected cross-tenant confirmation, deleted customer, durable quarantine/list/API-024 with zero operation/child/outbox change and forged proof rejection; same-key replay, changed-body conflict and source-version duplicate; immutable body/effective item/proofs; accepted job survives mapping edit/pause; credential barrier after claim and retirement fence; concurrent customer deletion blocks behind order lock and serializes; FI03 after header and first of two lines rolls back header, all lines, receipt/outbox and success status then retries to full aggregate. Scope is fixture proof, not every possible concurrency schedule.
- 011 -> 012 upgrade and runner reapply plus direct SQL reapply exercised in that test, with an activated import source and existing REST and SNAPSHOT quarantine records already present; the full prior quarantine rows were unchanged after 012 and direct SQL reapply. Actual clean-base 009 bytes were separately used for targeted bootstrap and quarantine checks in `E:/m1t5-runtime/353cb87b-1f7b-4b7b-9b6e-6a7115fa4118` (1 pass, 5 excluded), establishing that normal import does not depend on user-dirty 009 snapshot extensions. 012 references no appended snapshot binding, registry or snapshot target objects; the four replaced 009 functions exist at HEAD. The same populated legacy quarantine upgrade also ran with exact HEAD 009 bytes.
- Preserved quarantine-read full file: 35/36 at `E:/m1t5-runtime/5d84ae71-ec57-4921-9acd-14c48bb97f86`; `API-024 rejects a historical snapshot without quarantine-time binding` expected 409 but got 400, the carried snapshot-v2 mismatch. Earlier collection failed solely because the environment root used forward slashes, `E:/m1t5-runtime/7c126e9a-4b10-4999-b3df-64ca42914995`; the corrected backslash-path run is reported separately. Do not claim that suite passed. Prior broad baseline 409 pass / 3 fail plus unhandled error remains carried; no broad package run is claimed.
- Protected SHA-256 values unchanged: user 009 `40e2b46a9027fa69ea16b7826bd69f7c2d7cd9183ed76fce5e9dbcacdd0c367f`; user quarantine test `ebf0a384211b9c3eeb5fb0d745ebfcc17c3e94b9a777d3071f49a0e2a58e4aaf`; diagnostic `db446c13e549aed68e7d06d55db837ebcc02713d84425d81cfb1861d86053472`. Migrations 001–011 untouched.

## Owned files and final raw SHA-256

- `integration-service/etl-worker/worker.ts` a238fc52de3ac3a8236d87f81ab4f4e231bfe18072ff420dfab5f7ace3ef9e28
- `integration-service/normalization/apply.ts` a55351e4e92b99cc6b8e89dc51bf0a1a5abb5c034c6ca1910f0470ca6de43a7b
- `integration-service/ingestion-api/routes.ts` 73b1260ff818ff4dd3a989d3ec2218884ca42d11d71e4235d547c4b78d298573
- `integration-service/ingestion-api/quarantine-read.ts` fd28c4aa075c2a10d5237fdfa09b53d56b7c659bd7f95e886afaa4f84b6b2cf9
- `integration-service/migrations/012_import_quarantine.sql` 2dbdb863d0d0c25420471943a0fe71af3f2fc6d118fa8b3efae051aebe16d906
- `integration-service/contracts/simulated-import.md` 6583ae727c6c6656078d9abbe6c5441925306a63b035f25250a350f4278c2e2e
- `integration-service/acceptance-tests/management-import-worker.test.ts` 4287744d25f82fd81235e0fcc7a4fe0376132ebe890faa41b51e7c36e15d70f7
- `integration-service/acceptance-tests/management-import.test.ts` 705860e952c7fcdf9ba9f71c20cc4c13378e09865acb1faf35b85504660f45ed
- `integration-service/acceptance-tests/canonical-apply.test.ts` e272f00574c3887aa81060f47b6b132c7bf7abed8b99afd8ed07212033ce429e
- `integration-service/acceptance-tests/migrations.test.ts` 0f3d746ddbcc6084a5de05fe5ea7522c56c1e3affaed9d03c932dffc76f0daaf
- `integration-service/acceptance-tests/identity-store.test.ts` 1c1fcc90f64b66c94b4a6e3957455a02abfd19ce513bd3385bcbcc19c950dba0
- `integration-service/acceptance-tests/source-registry.test.ts` 8d96925f79a3c320e3a4836533cd7e771df50a1d82e60389d231407d5736b302

Additional task-owned planning/report artifacts: `context/m1-i2b-final-preflight.md`, `context/m1-i2b-schema-contract.md`, this report and durable `docs/execution/alpha1/m1-i2b-report.md`. Independent spec/quality review remains required before commit. No unrelated dirty files were staged.

## Review fix round 1

I2B-R1: both real OIDC-to-worker positive scenarios now query and independently assert literal order status, order timestamp, currency, order source timestamp, and each line's product code, product name and source timestamp, in addition to the previously asserted customer UUID, key, exact amounts, quantity and large version. Both complete two-line aggregates are checked after persisted application. I2B-R2: the lifecycle paragraph now describes the implemented 011 connector-aware proof consumer and worker verification, with deployment prerequisites stated separately.

Focused gate `E:/m1t5-runtime/5c3dc984-5d2a-4a24-8929-59b748f01393`: full `acceptance-tests/management-import-worker.test.ts` 6/6, `npm run typecheck` and `npm run build` all exit 0; exact commands, logs, exits, and 118-file raw SHA-256 before/after manifests are in that directory. Manifest differences: none; HEAD before and after `c8166e8b422f3964b059cee5cd636177568b132c`. Compared with the preceding 146-test bracket, only the two fix-owned product files below differ. The preceding 146-test result applies to its recorded pre-fix bytes, not the amended test file.

- `integration-service/acceptance-tests/management-import-worker.test.ts`: `0ffb864e35c9278a4618b93b3614970dc18295ff727ea3e8a7ca08e5aad623c8`.
- `integration-service/contracts/simulated-import.md`: `ccf7900b291716a98015553d171fb2eb920b39c9bdf0ccc2ef2d98db90506576`.

The owned-file hashes above in the original report describe the pre-fix gate; the two hashes in this addendum supersede them. Protected 009, quarantine-read test and diagnostic hashes remain identical to those listed above. The controller separately checked the pre-task quarantine log `f4714588`, which also records 35/36 and the same test 801 expected 409/actual 400; it remains a carried baseline. The incorrect evidence-directory character in both report copies was corrected to `...14c48bb97f86`. The prior 146-test gate now contains `commands-retrospective.txt`, explicitly identified as reconstructed from the execution transcript; the review-fix gate contains commands recorded at execution.

No implementation code changed in this fix round. Pending independent scoped review; no commit or deployment.

## Independent review disposition

The controller reports independent rereview 1 as Spec PASS and Quality Approved, with I2B-R1 and I2B-R2 addressed. This is local engineering acceptance; deployment, site acceptance and I3 recovery remain separate. The accepted 13-path savepoint is authorized on base c8166e8.

Savepoint whitespace correction: `git diff --cached --check` identified one surplus blank line at EOF in each of the following test files. Only those trailing blank lines were removed; no test was rerun for whitespace. The 146-test gate applies to the before hashes; the after hashes are the committed bytes:

- `acceptance-tests/canonical-apply.test.ts`: before `e272f00574c3887aa81060f47b6b132c7bf7abed8b99afd8ed07212033ce429e`, after `a8f558a02f20ba80f4c6681bf4771faf97d0e41681887b62e7f6fa2c09140dfb`.
- `acceptance-tests/migrations.test.ts`: before `0f3d746ddbcc6084a5de05fe5ea7522c56c1e3affaed9d03c932dffc76f0daaf`, after `549c805b5a5452eaef71274323072cb5f06922ab77ac907f5c43102e6c285a89`.
