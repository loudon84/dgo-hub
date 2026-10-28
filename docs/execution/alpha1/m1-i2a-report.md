# M1-I2a management import admission — implementation report

Status: implementation prepared for independent review; not accepted, committed, deployed or registered in the production app. Base HEAD before and after runs: `ca229f009c563c2299bbbd4ec8f35c474beb0857`. Working source was modified, so the HEAD bracket alone does not identify the tested tree; the raw SHA-256 hashes below identify the current tested files. These are filesystem byte hashes, not LF-normalized Git blob IDs. The schema contract was frozen before production code. No worker was started for the import intake fixture.

## Scope

`ingestion-api/management-import.ts` exposes explicit test-only registration, real OIDC management admission, original canonical digest and exact raw bytes, frozen mapped items, job, outbox and actor audit in one transaction. Existing source/credential/channel/fence and current user checks govern admission. Existing read routes check the current principal for import receipts. `011_management_import_admission.sql` changes route and NULL profile constraints, adds typed import proof validation and a job-linked immutable audit, and replaces the hardened 006 owner-change function with connector-aware proof matching. No change to 001–010; the existing worker and production app remain unregistered for import. `contracts/simulated-import.md` describes the extension, numeric JSON rejection and pending I2b. `context/m1-i2a-schema-contract.md` records the contract. The 010 upgrade test was narrowly changed to copy 010 into its dedicated directory: previously it accidentally included every later migration and expected only 010.

## Evidence and validation

All database fixture commands used a fresh absolute `M0_RUN_EVIDENCE_ROOT` under `E:/m1t5-runtime/<UUID>`; each directory retains actual output, exit and HEAD brackets. Commands ran in `E:/git/dgo-hub/integration-service`.

- TDD RED `npx vitest run acceptance-tests/management-import.test.ts`: 0/1, expected 202 received 404, `E:/m1t5-runtime/22d91c6e-f6e0-44fb-be45-b9db94f46d6d`.
- Intermediate 503/constraint failure preserved `E:/m1t5-runtime/35d155b7-e4c9-49e8-9653-fa974b6bd777`: historical `ingestion_job_check1` was the route/entity check; `ingestion_job_check` is applied-count. Migration now verifies those definitions before dropping check1; the applied-count constraint is retained and tested.
- Final `npx vitest run acceptance-tests/management-import.test.ts`: 13/13, exit 0, `E:/m1t5-runtime/77e91401-656b-4275-a88e-7cb541eadd05`. Real signed OIDC via owned loopback JWKS and real PostgreSQL hub_api; activated source under 001–010 upgraded to 011 and reapply; exact raw/effective and independently constructed original digest and approval/report comparison; 1/100/101 and actual 4 MiB/+1; duplicate/numeric input, typed foreign order reference and decimal/version strings; wrong tenant/scope/source-token, current actor race and pause race/replay; concurrent idempotency and changed discarded field; FI01 first write/before commit and FI02 real socket drop after commit; default app route absent; direct hub_worker 006 NULL-proof traversal. No worker processes import jobs.
- `npx vitest run acceptance-tests/strict-ingestion.test.ts`: 30/30, exit 0, `E:/m1t5-runtime/bdacafcd-b6ba-4164-b9d6-2ca165842cca` (external REST regression).
- `npx vitest run acceptance-tests/simulated-import.test.ts`: 17/17, exit 0, `E:/m1t5-runtime/48f077a5-e983-4760-a3ea-e84e0f5ab889`. Earlier run 16/17 in `E:/m1t5-runtime/f55ea03c-c3dd-4202-90e0-d1ab9bfb81e2` exposed the 010-only migration test's assumption after 011 was added; correction isolates 010 rather than weakening its assertion.
- `npx vitest run acceptance-tests/canonical-apply.test.ts`: 32/32, exit 0, `E:/m1t5-runtime/1873f49b-ee56-4a30-b77a-5d673679dc46` (external 006 consumer regression).
- `npx vitest run source-registry/import-sample.test.ts`: 3/3, exit 0, `E:/m1t5-runtime/d6f19923-6fa5-4a0a-b4ac-99476ea8cade`. `npm run typecheck` and `npm run build`: both exit 0, output and brackets `E:/m1t5-runtime/284857bf-3b6b-44fc-8aaa-260d6241ba75`.
- No broad database suite was run: earlier baseline 409 tests / 3 failures plus unhandled error remains carried, not masked or claimed fixed.

## Exact source identity and protected files

Current raw SHA-256:

- `integration-service/ingestion-api/management-import.ts`: `5412d726e1ce88c453c0ee39e74b359dd3a545f4a87354af9746cb661d1940b4`
- `integration-service/ingestion-api/strict-ingestion.ts`: `da0f618e31430550a26cfd35fd044fde06ff63505af4df8ec3c7980a3dbe0fc0`
- `integration-service/migrations/011_management_import_admission.sql`: `ad5deee2dcbefdc297cc5ce0931ae41298abfa2bc5b061af77051e32e144309e`
- `integration-service/acceptance-tests/management-import.test.ts`: `3a16e3dec829f8e4a0d413a5f89ff7eeda507c632d0134db11dc44aae06c0ef3`
- `integration-service/acceptance-tests/simulated-import.test.ts`: `bc1919ee900bf381b198544bbca5a6fd03a34179bec8a26beb850c384f8710ca`
- `integration-service/contracts/simulated-import.md`: `e041272c93f175328da81eed03d7ea68f1d36e07aad002c477bb024022bed20a`

Controller-provided pre-task and current raw hashes match: user-dirty 009 `40e2b46a9027fa69ea16b7826bd69f7c2d7cd9183ed76fce5e9dbcacdd0c367f`; quarantine test `ebf0a384211b9c3eeb5fb0d745ebfcc17c3e94b9a777d3071f49a0e2a58e4aaf`; diagnostic `db446c13e549aed68e7d06d55db837ebcc02713d84425d81cfb1861d86053472`. Existing unrelated dirty and untracked files were not staged. Pre-task raw hashes of changed own paths were not captured; base commit identifies tracked originals, not byte-for-byte working copies.

## I2b and I3 boundaries

The existing worker dereferences profile as non-NULL and uses legacy reference semantics. The 009 quarantine index REST branch also requires a non-NULL profile and its capture trigger copies the job profile: an import quarantine would violate that constraint. I2b must provide compatible application and a safe typed quarantine path before any worker consumes import jobs or production route registration; I3 owns deeper recovery semantics. This slice does not assert application, canonical effects, recovery, rollout or platform acceptance. Current tests do not prove every possible source/mapping race, every malformed metadata case, nor negative external proof insertion in isolation; independent review must assess these limitations.


## Final source-bracketed assurance addendum

At `E:/m1t5-runtime/e40a1910-12d9-4e56-9b5d-24ba5f15722a`, one final gate ran `npx vitest run acceptance-tests/management-import.test.ts` (13/13, exit 0), `npm run typecheck` (exit 0) and `npm run build` (exit 0). Immediately before and after, `source-before.sha256` and `source-after.sha256` record identical raw hashes for 110 non-ignored TypeScript, SQL and contract files under the service, excluding node_modules and dist. Both HEAD brackets are ca229f009c563c2299bbbd4ec8f35c474beb0857; individual exact command/output/exit files are retained in the directory. One prior shell attempt failed to parse the manifest pipeline before creating a fixture or executing any gate command; the corrected gate is recorded here.

## Independent review fix round 1

I2A-R1: a deterministic owned PostgreSQL interleaving holds admission after source locking until the mapping edit has entered its lock acquisition. The accepted job retains original bytes, the independently observed old mapping revision/digest and trimmed effective record. After the edit has paused the source, the same original/key returns that job without additional raw/job/item/outbox/audit rows or changing the stored facts. The test then re-tests, reapproves and reactivates the edited mapping. I2A-R2: a real external source admits with its valid non-NULL profile; a hub_api insert with NULL is rejected by the constraint; a hub_worker invocation traverses the valid 006 proof and rejects a mismatched report profile, and external HTTP admission also rejects that mismatch. I2A-R3: a provisioned external token is first proven to authenticate the source, then receives 401 from the management import route with raw/job/item/outbox/audit counts unchanged. No product implementation changed in this round.

C4: three exact ordered migration-history assertions were updated to include 011, and CLI ledger count to 11; all previous entries remain asserted. Before correction, the focused commands failed exactly on the missing 011: `migrations.test.ts -t 'runs the compiled CLI'` in `E:/m1t5-runtime/96e973c8-e956-4645-af3a-44e2ffffd0d9`; `identity-store.test.ts -t 'applies the current migrations'` in `E:/m1t5-runtime/66eb9810-9981-4cc6-917a-7749fd0aba61`; `source-registry.test.ts -t 'applies migration 008'` in `E:/m1t5-runtime/cd305463-4615-4637-a2cc-a680e8c91379`. The corresponding focused green runs, each 1/1, are `E:/m1t5-runtime/dc968cd1-8a70-4e4d-948b-c5f279bd215d`, `E:/m1t5-runtime/62baa8e2-7e6a-4dfa-9ede-7888642f1ee6` and `E:/m1t5-runtime/343feb73-059f-4b01-a1df-d1d99c7b60b8`. Pattern-selected runs report other tests skipped by the selection, not removed or disabled.

The final source-bracketed focused gate is `E:/m1t5-runtime/d784e34f-51c1-4335-8dc6-d1ec42dba1b2`: management import 14/14, external proof/token 2/2 (30 unselected), typecheck and build all exit 0; 110 source files have identical raw before/after manifests. Earlier test-development failures are retained: mapping test used a wrong test-only column in `E:/m1t5-runtime/64ff7957-bc6a-4e48-8e95-2632b4cea776`; hub_api fixture initially attempted a SELECT of ungranted job proof columns in `E:/m1t5-runtime/163e05e2-1dc2-4330-b192-4beb936eb3d6`. The fixes corrected the tests, not production permissions or code.

Fix-round current raw SHA-256 (superseding the first-round management test hash above):

- `integration-service/acceptance-tests/management-import.test.ts`: `a2a889b0ed6f2183319a2ac1355d2530c08bb6fd9635bf992d28422480167bd4`
- `integration-service/acceptance-tests/strict-ingestion.test.ts`: `396fa8223d2d5dea5a3fee604df82dcd9e80161f1369ccc24dc09cb6352ddc63`
- `integration-service/acceptance-tests/migrations.test.ts`: `f58febcf6c1706bfb85c65962b6349d45aa08d254e11b8ce888ed9bbf95764ca`
- `integration-service/acceptance-tests/identity-store.test.ts`: `38ad171f147e1b267c1e5a8637526d28572a2183611c9897f7516f0a222e0b2e`
- `integration-service/acceptance-tests/source-registry.test.ts`: `83d68401be464b76e444a929ed17cac8a0fab0453c2c8aa95f882466aa18c6b0`

Protected 009, quarantine test and diagnostic raw hashes remain identical to the pre-task values recorded above. The source snapshot and fix round remain subject to independent scoped re-review; no commit or activation is claimed.

## Independent review fix round 2

I2A-F1: the external-proof and real-token tests have moved to `integration-service/acceptance-tests/strict-external-proof.test.ts` with their own owned PostgreSQL fixture. The original `strict-ingestion.test.ts` assertions and fixture are restored; there is no Git diff in that file. No production code, grant or assertion was weakened.

Before isolation, the full `npx vitest run acceptance-tests/strict-ingestion.test.ts` reproduced the finding: 30/32 passed, two original exact-count tests saw one extra job/raw/item/outbox; full output and raw-source brackets are retained at `E:/m1t5-runtime/a7bbc007-b09e-4bdb-b1f3-663d93fab0ce`. After isolation, `npx vitest run acceptance-tests/strict-ingestion.test.ts acceptance-tests/strict-external-proof.test.ts` passed 32/32 across two files; `npm run typecheck` and `npm run build` both passed. Logs, exits and identical before/after raw hashes for 111 service TypeScript/SQL/contract files are at `E:/m1t5-runtime/9bffa976-bf40-48cb-acaf-f2a7ec090ef5`. An intermediate typecheck caught the new test file's missing `node:path` import; it was added before this gate.

Current raw SHA-256 of isolated test: `ebc99051c2a68fab314f567c73bc6307193dad92c870aa5849b9e9146a017bac` (Git-filtered blob `5156bcdd059d88c91b3763f1afe310e0d8a26837`). Restored original strict test raw SHA-256 is `7ede576273c7610cec15d7710f8b2d7524d730decc26b850c363f99c2126d705`. Protected 009, quarantine test and diagnostic remain at their pre-task hashes. Fix round 1 test hashes above describe its reviewed snapshot; the strict external coverage now resides in the isolated file. Pending scoped re-review; no commit claimed.

## Independent re-review and savepoint

The controller reports scoped re-review 2 as specification PASS and quality APPROVED, with I2A-F1 addressed and no new breakage. The controlled admission remains unregistered in production; I2b/I3 prerequisites and the prior full-suite baseline remain as stated above. A local savepoint was authorized for the eleven owned product/report paths only, without push, merge or deployment.

During staged whitespace verification, `management-import.test.ts` had one extra blank line at EOF. Only that final blank line was removed: raw SHA-256 before `a2a889b0ed6f2183319a2ac1355d2530c08bb6fd9635bf992d28422480167bd4`, after `9f51fc1c7ec2bf1a0bf7f628a09f8640218d1966b7528be31a123cb907b51bcb`. The recorded 14/14 test source was the before hash; this EOF-only normalization does not alter executable tokens, and no runtime rerun was made for it.
