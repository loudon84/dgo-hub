# M1-3 Task 3 Implementation Report

## Result and source commits

**Status: DONE_WITH_CONCERNS.** Implementation and local gates are complete. Independent Sol review remains outstanding. Formal site acceptance stays `NOT_RUN`; these tests use owned PostgreSQL and controlled local fixtures only.

- Dispatch base: `ca32853e931ff8e0c2fdf147bd2e0c962ddf656c`.
- Product source: `ebd41c78df45e7c9affc25a76aa7d2dd9187b5f8` (`Implement durable strict batch ingestion`).
- Compatibility regression fix: `6a401bfd3c89dc37a1217e370ecbe423dbf3c26c` (`Keep strict reads compatible with existing handlers`).
- Recovery coverage: `ab7cfe565766c60e4de5ac8cfa2b5ab7f2334db5` (`Exercise scoped barrier owner recovery flow`).
- The last test/typecheck/build gates ran with the recovery test as an uncommitted source-tree change. After commit, `git hash-object integration-service/acceptance-tests/strict-ingestion.test.ts` and `git rev-parse HEAD:integration-service/acceptance-tests/strict-ingestion.test.ts` both returned `860c244f30e9b25dad7e9eaf20a34aaa1fc45873`, confirming gate bytes equal the committed blob. Gate HEAD at execution was `6a401bfd3c89dc37a1217e370ecbe423dbf3c26c`; recovery-test commit is the current HEAD.

## Scope delivered

Implemented only API-015/016 strict REST intake, API-017/018 safe job reads, and additive migration `007_durable_ingestion_jobs.sql`, using the existing app, AuthService, migration runner, and transaction helper. Added strict duplicate-aware raw JSON parsing, schema and byte limits, PRD §13.3 canonical request digest, source/entity authorization, idempotent replay, atomic raw/job/item/outbox writes, frozen admission proof, and safe paged job/item reads. The parser retains public `department_external_id` and the exact `customer_ref` tuple. The API preserves submitted strings, timestamps, optional-field distinctions, and record order in facts and digest. Public order validation requires explicit `lines`; empty lines are accepted only for DRAFT/CANCELLED.

Migration 007 adds durable raw bytes, jobs/items/idempotency/outbox and the approval security fence. Hub API can insert but cannot read raw payload bytes or write canonical data; worker raw read is granted for later processing. Migrations 001–006 remain unchanged. SHA-256 for 006: `fb52f395bd0c0f1d29e5234788b39737a922bf0f9928f7e99becfb6be91f3065`; SHA-256 for 007: `4e2ccefe6f34d3ef4aa043ee8fe54fc88c45c225d07fd80fb827fef37b564159`.

The raw/LF/Git blob manifest is `docs/execution/alpha1/m1-task-3-evidence/d825e7c7-136b-4900-a644-2014f1d24c0e/source-file-manifest.json`. It covers the 15 product source/test paths in the three implementation commits, with raw SHA-256, normalized-LF SHA-256, and Git blob IDs. All 15 working clean-filter blob IDs match HEAD. Three test files contain one CRLF among otherwise LF endings, with no bare CR; the manifest records both raw and normalized hashes. A dispatch-base diff confirms migrations 001–006 are unchanged.

Source files and tests are in the three source commits listed above. Added `.env.example` documentation for the deployment-controlled raw-storage policy; absent policy fails closed. Acceptance tests explicitly use `local_lab_fixture`. This fixture does not demonstrate at-rest disk encryption.

## Test evidence

Commands ran from `E:\git\dgo-hub\integration-service` with `M0_RUN_EVIDENCE_ROOT=E:\git\dgo-hub\docs\execution\alpha1\m1-task-3-evidence\d825e7c7-136b-4900-a644-2014f1d24c0e`, except the explicitly noted first full-suite attempt.

| Command / gate bytes | Result |
| --- | --- |
| `npx vitest run ingestion-api/strict-contract.test.ts ingestion-api/strict-intake.test.ts acceptance-tests/strict-ingestion.test.ts` | 3 files, 25 tests passed; exit 0, on the test/source tree committed in `6a401bf` |
| `npm run typecheck` | Passed; exit 0, after recovery coverage was added, before its commit; committed test blob verified identical |
| `npm test` | 18 files, 288 tests passed; exit 0, on source commit `6a401bf` with the explicit evidence-root environment |
| `npm run build` | Passed; exit 0, after recovery coverage was added, before its commit; committed test blob verified identical |
| First `npm test` attempt, without `M0_RUN_EVIDENCE_ROOT` | 18 files, 9 failures: 7 `identity-http`, 1 `source-registry` from a duplicate global not-found handler, and 1 `canonical-apply` migration expectation still ending at 006. Fixed in `6a401bf`; this unconfigured attempt also wrote to default evidence locations described below. It is not a passing gate. |
| `npx vitest run acceptance-tests/identity-http.test.ts acceptance-tests/source-registry.test.ts acceptance-tests/canonical-apply.test.ts` | 3 files, 76 tests passed; exit 0 after the compatibility fix |
| First recovery-test focused run: `npx vitest run acceptance-tests/strict-ingestion.test.ts` | 10 tests, 8 passed and 2 failed; exit 1. It exposed the actual scope-removal behavior: the previous test expected 409 but received 401 because the barrier disables the credential. The following reads also got 401 because the failing test stopped before controlled credential re-enable. |
| Final recovery-test focused run: `npx vitest run acceptance-tests/strict-ingestion.test.ts` | 1 file, 10 tests passed; exit 0. Run with explicit evidence root on source bytes later committed in `ab7cfe5`. |

The full-suite gate predates the final test-only recovery coverage; the product files did not change after `6a401bf`. The new acceptance test itself, typecheck, and build passed on the exact committed recovery-test bytes. No repeated full suite was run after that test-only addition.

### Security barrier recovery coverage

The acceptance test now creates a `SOURCE_SCOPE_SECURITY_REMOVAL` barrier through `AuthService.repository.recordSourceScopeSecurityBarrier`, which disables the credential and pauses the source in the existing database function. The same token gets 401 while disabled and no durable intake rows are added. The test then runs the real source-registry `pause`, re-enables the existing credential through `updateSourceCredential` with the same row, revision and entity scope, runs the injected deterministic local capability test, obtains a fresh approval as the exact OIDC Owner, activates, and admits a new job. It asserts credential row ID is unchanged, the new approval fence equals the barrier fence, and the old accepted job's approval/admission fences remain unchanged. The local capability provider is an injected fixture and does not perform a live network test.

Coverage is for the scope-removal barrier only. A CREDENTIAL_COMPROMISE barrier and a distinct old-token rejection/replacement flow were not tested. In this scope-removal flow, the old token is rejected while the row is disabled and becomes usable again after the same row is explicitly re-enabled and Owner recovery completes; do not describe this as credential compromise revocation.

## Owned PostgreSQL fixture inventory

Evidence root: `docs/execution/alpha1/m1-task-3-evidence/d825e7c7-136b-4900-a644-2014f1d24c0e/`. Inspection was limited to this Task3-selected root. It contains 21 lifecycle runs, 21 unique run labels and container IDs, and exactly 21 `created`, 21 `image_observed`, and 21 `removed` events. Every created container has a matching exact-ID removal with `ownershipConfirmed=true` and `containerAbsentAfterRemoval=true`; there are no lifecycle error events. The image for all 21 is `postgres:16.10-alpine`, repository digest `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`, runtime image ID `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`.

The explicit-root run has 19 resource summaries. Two lifecycle-complete runs lack the helper's summary JSON: task0 run `1a71280b-61aa-40f0-a397-27fb42bbffaf` and task3 run `ddf4acf5-d90d-4930-9ead-c88c19ec8004`. Their JSONL lifecycle events do record exact removal and confirmed absence. No attempt was made to reconstruct those summaries.

| Task label | Run label | Container ID |
| --- | --- | --- |
| m1task1 | 43376541-de74-4496-aa10-1d30fac0e8b9 | 17bd794d492114f38f808ad0403f353dbbb08e7fb8bf89dbe867c050a3ad21bb |
| m1task1 | 9ed56b7b-e433-41a9-8f64-7c3b3a5734fb | 756435adcb76249456a1e1f8d4589dcc750fc8859c484f5491528e8a804fa2cc |
| m1task1 | f94623b6-2925-40b7-885d-f8cae1e90099 | 71ef1273f2c10dfb78dba002d8da3a5d33e37b87aa1ce5284923155f9a9167ae |
| task0 | 1a71280b-61aa-40f0-a397-27fb42bbffaf | db4bde7ff8ff4396ed2665f275c5208a83b5795fe0fee1299bcaa55605f5ef15 |
| task1 | 7f957983-1c67-4a0c-a4fa-f144d4e02bbd | 1c32628b51355ab094dac20e0091602d05a74910462be00bf655830dd2cda820 |
| task1 | ab778678-c440-4929-82ce-4b80c8ea752f | 9af73074fc00b8bdb21ec5605fd03373aa49f8572a71322617f34100e286e052 |
| task2 | 13354232-d058-42c5-95a5-2023254feeaf | 8ae37428335e82501fdda4a529600adc0c8817f5f9ffcd3f1bb09b21d81dce8d |
| task2 | 7365dcbb-4746-4f2e-a479-2bd7906bc812 | b3f1a53834f313fd04d66272342af2380cd8fcc269599b24309a2a47a06c0414 |
| task2 | a82d9f74-c27e-4415-aba7-b0dcdfd19201 | f108fc93f91fe781c70cd93e971b8c8d75dc0b7306a37c0d314c30d86382a4fd |
| task2 | e4ebff35-e111-48b2-b409-9fe8091527b0 | fbfeb13843f609ab7d1883140764fb70ba72e109369f19157706621aa8311fd0 |
| task3 | 33fce12e-8223-4410-92b2-6c77e0941c8b | ab39ef00983c9ab57fa84aeb4b47ac873f39b16828d537ff34a2571be6984425 |
| task3 | 39b4fdbd-daa9-4a9f-802c-d891222b053f | 2af873adfcbb1b995b64ee420f917879e6e5c4775016cc33b6f151b2271a7a61 |
| task3 | 41ec850c-e259-41de-ad05-57174a544e42 | 6d7cf5a35738f2f9a0f52d9680afe9e5358ac2c649afb960babdd1b5a90859e4 |
| task3 | 4bbd4ab9-698c-4da8-af3c-8b39d3fb228a | 1a801b4e2a07dec5cf1ea6b98d91f2c10f93b60e315e65a403cff89ffbf13268 |
| task3 | 4c4c1ebc-f8d7-453b-b634-d2838224d08d | a7b3dd7086a7880af33d9ce96d7048e1ccc5c1e4229d3ef3fe386f1afa97a0f5 |
| task3 | 4ee7acf6-6d49-45e0-9f11-228f23610c42 | a3c86ff97e6b92cd07d5e3a71d3bedc73a2c49430ee3bf9cd4276517b9ec3334 |
| task3 | 72123994-74e1-4969-828d-14bbca09e39e | 2715fb3e30c053d215517159eb40f1784dd6c88a4e32d9afb9896004fe3e9053 |
| task3 | 9b6f83d0-c80e-4ea0-a753-873589d3d5f5 | e3c2c83498114e9a3da821555faa1addbad43b714cafe040a156975a1f6c6332 |
| task3 | 9d4003dc-d28f-4730-9489-c4985a349bbf | e47558f55504429068a7468756761e2dc03a6246b6c17c6342da8e2f63707af2 |
| task3 | ddf4acf5-d90d-4930-9ead-c88c19ec8004 | a475d45b5bc927118491993ad52afcb051239a5a1d9354e0b43e359ecf8e0d3e |
| task3 | e45559fa-3038-436b-a0cf-c947e0b3276a | f42c51a43c03e1517bf57c6927bc198a19ff09019100a3ddb0e29a86a0290108 |
| task3 | f8149014-84b1-465f-9ff9-a1826d104cc4 | dbfbe5e62dbff285a78a3e275a42afb23d054b2479d7f5b303443ca7174c8d22 |
| task3 | fbbde63d-dde0-4719-b654-e82d4545a429 | 38d91d55d3b7532a0003a7bcc3cce5a66503991738b6c8f8451ca0b22d68d2d9 |

The first full-suite attempt without the evidence-root environment also created six new PostgreSQL runs across default paths. Root preserved six tracked output files before restoring those exact paths to their `ca32853` blobs. The preservation copy and `preservation-manifest.json` are under `misplaced-suite-182538/`; the manifest records each original path, preserved path, SHA-256, and original Git blob. Those six preserved snapshots contain three run labels absent from the base logs; the other three runs came from new default output files. All six new runs were deduplicated against their base log entries and against the explicit-root inventory. Each has exactly one create, image-observed, and exact-ID removed event, with both ownership and post-removal absence confirmed.

After that deduplication, the evidence root accounts for 27 new runs and 27 unique containers across the explicit-root gates and the unconfigured attempt: 27 `created`, 27 `image_observed`, and 27 `removed` events, with zero mismatched or incomplete runs and zero lifecycle error events.

| Default task | New run label | Container ID | Image | Source metadata |
| --- | --- | --- | --- | --- |
| task0 | 742f7d48-cd03-4e59-8041-5c418e35edec | ca57f94e4b12a6044974357a99593429728fccbe058eae0d16504f3a92e26ca0 | postgres:16.10-alpine | preserved M0 foundation lifecycle and summary |
| task1 | ab778678-c440-4929-82ce-4b80c8ea752f | 9af73074fc00b8bdb21ec5605fd03373aa49f8572a71322617f34100e286e052 | postgres:16.10-alpine | preserved M0 task1 lifecycle and summary |
| m1task1 | 9ed56b7b-e433-41a9-8f64-7c3b3a5734fb | 756435adcb76249456a1e1f8d4589dcc750fc8859c484f5491528e8a804fa2cc | postgres:16.10-alpine | preserved M1 task1 lifecycle and summary |
| task2 | 4852d06e-9dfa-483d-ba5d-2df1f0b31bff | 9f6e0053ccf516b83effbbd13d805adf41c35ddb25edeaa993eb479de14826ec | postgres:16.10-alpine | copied from `m0-task-2-evidence/review-round1/9da20160-dea9-4575-93c5-4ae7a6666fc4/` |
| task3 | 9558e0b7-3250-48ca-93df-d2e17c9f16a6 | 3cf4ecc233aa8f939e195292280e81ef3f88e4f646780cb42e698b10a9d98920 | postgres:16.10-alpine | copied from `m0-task-3-evidence/db927681-3930-4d6a-b8f8-078f4739277e/` |
| task2 | 738613a7-d18d-4e3b-9d1b-bd99c5e84343 | 3eb3078a041fe6ee2f0326f180f58910d092ca278989976b4cbf7aa9ff6b87f3 | postgres:16.10-alpine | copied from `integration-service/acceptance-tests/evidence/m1-task-2/` |

All six image-observed events report repo digest `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297` and runtime image ID `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`.

The task2 resources `4852…` and `7386…` have summary JSON with the helper's exact-container cleanup statement; their lifecycle logs supply the explicit `ownershipConfirmed=true` and `containerAbsentAfterRemoval=true` fields. Task3 run `9558…` has no resource summary; its lifecycle log has both explicit confirmation fields. The M1-task-1 loopback capability fixture summary records fixture ID `4be12fca-bdab-4d04-8ddb-7a9803eb067f` and `server closed and port released`; it is not a PostgreSQL container.

## Evidence path side effects and limits

The first unconfigured full-suite attempt used helper defaults. With `evidenceRoot`, the PostgreSQL helper writes under `<absolute root>/<taskLabel>/<runLabel>/`; without it, it writes to the caller's `evidenceFile`. The non-Docker boundary tests use temporary roots. Root hash-verified the six tracked lifecycle/summary files against their current contents, copied them and a preservation manifest into the Task3 evidence root, then restored exactly those six original paths to their `ca32853` Git blob bytes. The six-path `git status` check is clean after restoration. The new default output files explicitly authorized for preservation were copied, not moved, under `misplaced-suite-182538/`; their SHA-256 hashes match their original paths. The three new default run directories/files remain untouched and excluded from the package. Their PostgreSQL lifecycle records were audited by exact run label and full container ID; there is no created-only fixture and no daemon error used as evidence of absence.

`evidence-file-whitelist.json` in the official evidence root lists the safe files by relative path, SHA-256, size, file category, and safe resource/lifecycle metadata; it excludes its own hash. The whitelist includes the selected evidence-root lifecycle and summary files, the preservation manifest and six snapshots, and the six authorized copies. No other scratch roots or default paths are in the whitelist. The initial failed full-suite run log was not recovered from those approved metadata paths, so no additional run ID/log is claimed.

The local test evidence does not establish disk encryption at rest, external CRM/IdP/Hermes behavior, deployment raw-storage policy configuration, site acceptance, M1-4 worker behavior, or CREDENTIAL_COMPROMISE recovery. No raw payload, credential secret, environment file, or certificate is included in this report.
