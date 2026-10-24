# M1-3 Task 3 Implementation Report

## Result and source commits

**Status: DONE_WITH_CONCERNS.** Implementation and local gates are complete. Independent Sol review remains outstanding. Formal site acceptance stays `NOT_RUN`; these tests use owned PostgreSQL and controlled local fixtures only.

- Dispatch base: `ca32853e931ff8e0c2fdf147bd2e0c962ddf656c`.
- Product source: `ebd41c78df45e7c9affc25a76aa7d2dd9187b5f8` (`Implement durable strict batch ingestion`).
- Compatibility regression fix: `6a401bfd3c89dc37a1217e370ecbe423dbf3c26c` (`Keep strict reads compatible with existing handlers`).
- Recovery coverage: `ab7cfe565766c60e4de5ac8cfa2b5ab7f2334db5` (`Exercise scoped barrier owner recovery flow`).
- Safe evidence commits: original archive `76df2e85428778e2e765447ff230fda7b50a46de`, retention-record update `83bf7dc7aa3c3cb45076e621899b67d85c609697`, current-gate capture `bf92cc1d9d826ec171f426d779e92702539b6b26`, and resource-inventory correction `17db34fa8804ff5fbee0cbfeca4defdb99188adc`. The current whitelist covers 85 evidence files plus itself. Whitelist SHA-256 (the whitelist intentionally excludes its own hash): `06e00bef05d0581f3290a41a18139e684461d4ac3e62884b759d4d96f6463223`.
- The last test/typecheck/build gates ran with the recovery test as an uncommitted source-tree change. After commit, `git hash-object integration-service/acceptance-tests/strict-ingestion.test.ts` and `git rev-parse HEAD:integration-service/acceptance-tests/strict-ingestion.test.ts` both returned `860c244f30e9b25dad7e9eaf20a34aaa1fc45873`, confirming gate bytes equal the committed blob. Gate HEAD at execution was `6a401bfd3c89dc37a1217e370ecbe423dbf3c26c`; `ab7cfe5` is the tested source commit, and later commits contain only the report and safe evidence archive.

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
| Current captured supplement, run `74ee7ba0-3902-4094-ab54-502999bc07ab` | `npm run typecheck`, `npm test` (18 files, 288 tests), `npm run build`; all exit 0 on gate HEAD `eb47494fcd98ca5a2bfb6acba7fe34d4d666b03b`; complete outputs and exit records retained under `gate-captures/74ee7ba0-3902-4094-ab54-502999bc07ab/`. |

The original full-suite gate predates the final test-only recovery coverage; the current captured supplement is the first complete suite run after that addition. The product and test source bytes remained stable throughout the current sequence, and the current full suite passed 18 files and 288 tests.

The existing rows summarize historical executions; their original stdout/stderr remain `NOT_RETAINED` and the summaries are not raw logs. A current-source supplemental sequence was run once with complete stdout/stderr and per-command exit capture. It ran on gate HEAD `eb47494fcd98ca5a2bfb6acba7fe34d4d666b03b` from `2026-10-24T10:47:39.6701736Z` to `2026-10-24T10:47:58.1291617Z`: typecheck exit 0, full suite 18 files/288 tests exit 0, build exit 0. Raw stdout/stderr, command/exit records, and pre/post source manifests are under `gate-captures/74ee7ba0-3902-4094-ab54-502999bc07ab/`. The 15 source/test raw, normalized LF, and Git clean-blob hashes matched before and after; migrations 001–006 still match the dispatch-base blobs, and 007 SHA-256 is unchanged. An initial runner setup invocation launched bare `npm` three times because of a PowerShell argument-binding error; those exit-1 usage responses did not execute any gate and are not counted as gate results. See `gate-output-retention.md` for the historical/current capture distinction.

### Security barrier recovery coverage

The acceptance test now creates a `SOURCE_SCOPE_SECURITY_REMOVAL` barrier through `AuthService.repository.recordSourceScopeSecurityBarrier`, which disables the credential and pauses the source in the existing database function. The same token gets 401 while disabled and no durable intake rows are added. The test then runs the real source-registry `pause`, re-enables the existing credential through `updateSourceCredential` with the same row, revision and entity scope, runs the injected deterministic local capability test, obtains a fresh approval as the exact OIDC Owner, activates, and admits a new job. It asserts credential row ID is unchanged, the new approval fence equals the barrier fence, and the old accepted job's approval/admission fences remain unchanged. The local capability provider is an injected fixture and does not perform a live network test.

Coverage is for the scope-removal barrier only. A CREDENTIAL_COMPROMISE barrier and a distinct old-token rejection/replacement flow were not tested. In this scope-removal flow, the old token is rejected while the row is disabled and becomes usable again after the same row is explicitly re-enabled and Owner recovery completes; do not describe this as credential compromise revocation.

## Owned PostgreSQL fixture inventory

Evidence root: `docs/execution/alpha1/m1-task-3-evidence/d825e7c7-136b-4900-a644-2014f1d24c0e/`. Inspection was limited to this Task3-selected root. It now records 28 explicit-root lifecycle runs plus 6 no-env runs, 34 unique run labels and containers total, and exactly 34 `created`, 34 `image_observed`, and 34 `removed` events. Every created container has a matching exact-ID removal with `ownershipConfirmed=true` and `containerAbsentAfterRemoval=true`; there are no lifecycle error events. The 7-run current supplement added 7 explicit-root PostgreSQL containers; all use `postgres:16.10-alpine`, repository digest `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`, and runtime image ID `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`.

The table below lists only the 28 explicit-root runs; the two no-env labels `9ed56b7b-e433-41a9-8f64-7c3b3a5734fb` and `ab778678-c440-4929-82ce-4b80c8ea752f` are listed in the separate six-run no-env inventory. The explicit-root runs have 25 PostgreSQL resource summaries. Three lifecycle-complete runs lack a resource summary: prior task0 run `1a71280b-61aa-40f0-a397-27fb42bbffaf`, prior task3 run `ddf4acf5-d90d-4930-9ead-c88c19ec8004`, and current task3 run `f2788d92-0c9f-4667-99ba-ef558712613d`. Their JSONL lifecycle events record exact-ID removal and confirmed absence. The current task0 run `731df9d7-d065-4833-b822-dff3a74ed8a5` has a resource summary named `foundation-postgres-resource-summary.json`; it is included in the count. No summaries were reconstructed.

| Task label | Run label | Container ID |
| --- | --- | --- |
| m1task1 | 43376541-de74-4496-aa10-1d30fac0e8b9 | 17bd794d492114f38f808ad0403f353dbbb08e7fb8bf89dbe867c050a3ad21bb |
| m1task1 | f94623b6-2925-40b7-885d-f8cae1e90099 | 71ef1273f2c10dfb78dba002d8da3a5d33e37b87aa1ce5284923155f9a9167ae |
| task0 | 1a71280b-61aa-40f0-a397-27fb42bbffaf | db4bde7ff8ff4396ed2665f275c5208a83b5795fe0fee1299bcaa55605f5ef15 |
| task1 | 7f957983-1c67-4a0c-a4fa-f144d4e02bbd | 1c32628b51355ab094dac20e0091602d05a74910462be00bf655830dd2cda820 |
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
| m1task1 | 003e2c56-8da2-4983-90a5-f4e9b681568b | 60d0bd174e5ef325684219e5b7f313e1d42e0bbec3d00fbbe57713259dcefc5d |
| task0 | 731df9d7-d065-4833-b822-dff3a74ed8a5 | c7bae70a7b44b7c203a624f0a92eb08e795d3f6dbb25c897c0ca61ac132aafc6 |
| task1 | 42c327a7-ed18-40ae-93e4-cceb4b8d8877 | aabccab59b5dc607add3dc644e48784bdabfeae1c4a6ccabc5a060bc05760bbc |
| task2 | 03f45963-5c78-4e01-8af2-dc91dbdc6c27 | 6393ace3aa8024a6b69a1e850a3934ef2cdf90bcb1ef08e1ed33b70a9b2e1e65 |
| task2 | a26d1c23-2da3-439d-b891-c03b895ac389 | 5249a17e76a71729a065651f530beddc3caa9c0182d24b91a09a74a01fb59fdc |
| task3 | a5866093-803e-43fe-8b7c-6962ea0befb4 | 841c509ec9e7d56ccfcabc2a9fc4d64db79e45cb0a620eb183d4135af7a69283 |
| task3 | f2788d92-0c9f-4667-99ba-ef558712613d | 4dbe1df8d857e2d1d9f29c582f397e030553bdc244fd9267c9cc34d1796de723 |

The first full-suite attempt without the evidence-root environment also created six new PostgreSQL runs across default paths. Root preserved six tracked output files before restoring those exact paths to their `ca32853` blobs. The preservation copy and `preservation-manifest.json` are under `misplaced-suite-182538/`; the manifest records each original path, preserved path, SHA-256, and original Git blob. Those six preserved snapshots contain three run labels absent from the base logs; the other three runs came from new default output files. All six new runs were deduplicated against their base log entries and against the explicit-root inventory. Each has exactly one create, image-observed, and exact-ID removed event, with both ownership and post-removal absence confirmed.

After deduplication and the captured current-source sequence, the evidence root accounts for 34 new runs and 34 unique containers: 28 explicit-root and 6 no-env runs, with 34 `created`, 34 `image_observed`, and 34 `removed` events. All 34 have confirmed exact-ID removal and post-removal absence, with zero overlaps, incomplete runs, or lifecycle errors. The current gate capture also records one loopback HTTP capability fixture closed with its port released.

| Default task | New run label | Container ID | Image | Source metadata |
| --- | --- | --- | --- | --- |
| task0 | 742f7d48-cd03-4e59-8041-5c418e35edec | ca57f94e4b12a6044974357a99593429728fccbe058eae0d16504f3a92e26ca0 | postgres:16.10-alpine | preserved M0 foundation lifecycle and summary |
 postgres:16.10-alpine | preserved M0 task1 lifecycle and summary |
 postgres:16.10-alpine | preserved M1 task1 lifecycle and summary |
| task2 | 4852d06e-9dfa-483d-ba5d-2df1f0b31bff | 9f6e0053ccf516b83effbbd13d805adf41c35ddb25edeaa993eb479de14826ec | postgres:16.10-alpine | copied from `m0-task-2-evidence/review-round1/9da20160-dea9-4575-93c5-4ae7a6666fc4/` |
| task3 | 9558e0b7-3250-48ca-93df-d2e17c9f16a6 | 3cf4ecc233aa8f939e195292280e81ef3f88e4f646780cb42e698b10a9d98920 | postgres:16.10-alpine | copied from `m0-task-3-evidence/db927681-3930-4d6a-b8f8-078f4739277e/` |
| task2 | 738613a7-d18d-4e3b-9d1b-bd99c5e84343 | 3eb3078a041fe6ee2f0326f180f58910d092ca278989976b4cbf7aa9ff6b87f3 | postgres:16.10-alpine | copied from `integration-service/acceptance-tests/evidence/m1-task-2/` |

All six image-observed events report repo digest `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297` and runtime image ID `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`.

The task2 resources `4852…` and `7386…` have summary JSON with the helper's exact-container cleanup statement; their lifecycle logs supply the explicit `ownershipConfirmed=true` and `containerAbsentAfterRemoval=true` fields. Task3 run `9558…` has no resource summary; its lifecycle log has both explicit confirmation fields. The M1-task-1 loopback capability fixture summary records fixture ID `4be12fca-bdab-4d04-8ddb-7a9803eb067f` and `server closed and port released`; it is not a PostgreSQL container.

## Evidence path side effects and limits

The first unconfigured full-suite attempt used helper defaults. With `evidenceRoot`, the PostgreSQL helper writes under `<absolute root>/<taskLabel>/<runLabel>/`; without it, it writes to the caller's `evidenceFile`. The non-Docker boundary tests use temporary roots. Root hash-verified the six tracked lifecycle/summary files against their current contents, copied them and a preservation manifest into the Task3 evidence root, then restored exactly those six original paths to their `ca32853` Git blob bytes. The six-path `git status` check is clean after restoration. The new default output files explicitly authorized for preservation were copied, not moved, under `misplaced-suite-182538/`; their SHA-256 hashes match their original paths. The three new default run directories/files remain untouched and excluded from the package. Their PostgreSQL lifecycle records were audited by exact run label and full container ID; there is no created-only fixture and no daemon error used as evidence of absence.

`evidence-file-whitelist.json` lists safe files by relative path, SHA-256, size, category, and safe resource/lifecycle metadata; it excludes its own hash. It includes selected lifecycle and resource summaries, preservation snapshots, current gate stdout/stderr, command/exit records, and source/capture manifests. Historical gate output, including the initial unconfigured suite, remains `NOT_RETAINED`; historical command summaries are not represented as raw logs. The current captured sequence is recorded separately and does not replace historical evidence.

The local test evidence does not establish disk encryption at rest, external CRM/IdP/Hermes behavior, deployment raw-storage policy configuration, site acceptance, M1-4 worker behavior, or CREDENTIAL_COMPROMISE recovery. No raw payload, credential secret, environment file, or certificate is included in this report.
## Fix1 follow-up — reviewed R1–R5 (2026-10-24)

**Fix1 source status: DONE; independent pinned re-review pending.** This section is additive to the historical report above. Its original results, resource inventory, and `NOT_RETAINED` gate-output limits remain historical facts. Formal site acceptance remains `NOT_RUN`. The exact fix base was `0a493f4c594b76f42adfea6bcfc2667705c37b05`; the reviewed product at `90ce1940a32d3bf6bf4a1573b61f66a94452604a` was identical. Root's intervening `bcfb34c167768a053250ccedefcb1f0759efe75f` was docs-only and was the actual HEAD during fix1 gates. The single explicit five-file source/test commit is `ccab1a043294a677db1c3ad54142bd2291c81e60`.

| Review item | Repair and regression |
| --- | --- |
| R1 (P1) | Order status and currency require actual string enum members before retention. Array/object values return 422; array `CONFIRMED` cannot bypass the required nonempty lines rule. Contract and real HTTP/PostgreSQL tests assert 422, nonretryable, and no new intake rows. |
| R2 (P2) | Admission scans all validated record instants for chronological minimum and maximum. It compares offsets and subsecond digits without rounding to JavaScript milliseconds, while leaving input array order, public record facts, raw bytes and digest inputs untouched. A three-record real PostgreSQL/HTTP test proves descending source-time order, differing offsets, microsecond endpoints, preserved stored ordinal facts, 202, and safe job GET range. |
| R3 (P2) | Customer `owner_external_id` and `department_external_id` use the existing 1–128-character identifier validator with no surrounding whitespace. Accepted spelling/case remains intact. Contract and real HTTP/PostgreSQL invalid-image tests cover bounds and no durable writes. |
| R4 (P2) | Error paths may contain only static schema field segments and array indexes 0–200; unknown property names fall back to their trusted containing path. Duplicate unknown-key and unknown-field requests containing `SYNTHETIC_PRIVATE_MARKER` return 422 without that marker anywhere in the complete HTTP response. |
| R5 (P2) | The JSON reader checks a depth limit of 32 before descending into another value. A 5,000-array request below 4 MiB now returns deterministic 422, `INGEST_INPUT_INVALID`, nonretryable, and no durable rows, without a blanket RangeError catch. |

### Fix1 commands, gate bytes, and evidence

Every test command and both compiler commands had absolute `M0_RUN_EVIDENCE_ROOT=E:\git\dgo-hub\docs\execution\alpha1\m1-task-3-fix1-evidence\6d154143-5941-42f6-ab69-247e9d61f0a0` set. Captured command JSON records the actual gate HEAD, UTC finish and exit code; paired stdout/stderr retain raw output. The initial acceptance test still contained its old hardcoded evidence root, so its three PostgreSQL runs landed under the prior Task3 root despite the environment variable. Fix1 changes the test to honor the explicit variable, and the final gate used the new root. No pre-existing old evidence file was modified, moved, or deleted; the three new untracked subdirectories remain in place.

| Run/capture prefix | Exact command (from `integration-service`) | Result |
| --- | --- | --- |
| `red-unit` | `npx vitest run ingestion-api/strict-contract.test.ts ingestion-api/strict-intake.test.ts` | Exit 1; 5 expected failures, 15 passes among 20 tests. |
| `red-acceptance` | `npx vitest run acceptance-tests/strict-ingestion.test.ts` | Exit 1; 3 expected failures, 10 passes among 13 real PostgreSQL/HTTP tests. |
| `red-enum` | `npx vitest run ingestion-api/strict-contract.test.ts -t 'rejects non-string order enums'` | Exit 1 after refining the currency case to use a valid DRAFT image; invalid enum was still accepted. |
| `green-focused` | `npx vitest run ingestion-api/strict-contract.test.ts ingestion-api/strict-intake.test.ts acceptance-tests/strict-ingestion.test.ts` | Exit 1; 32 pass and one test-fixture failure. An unauthenticated unknown-field request reached the intentionally unconfigured app and returned 503; the pre-auth duplicate-key assertion and authenticated acceptance unknown-field assertion remain the correct boundaries. |
| `green-focused2` | Same focused command | Exit 0; 3 files and 33 tests passed after correcting that test boundary. This run still used the prior hardcoded PostgreSQL evidence root. |
| `typecheck`, `build` | `npm run typecheck`; `npm run build` | Each exit 0 before the evidence-root test edit; outputs retained. |
| `gate-focused` | Same focused command | Exit 0; 3 files and 33 tests passed on the final five source/test file bytes, with PostgreSQL evidence in the fix1 root. |
| `gate-typecheck`, `gate-build` | `npm run typecheck`; `npm run build` | Each exit 0 on the final bytes. |

The final gate HEAD was `bcfb34c167768a053250ccedefcb1f0759efe75f` with five uncommitted source/test changes; `source-gate-pre-manifest.json` and `source-gate-post-manifest.json` record matching raw SHA-256, normalized-LF SHA-256 and Git clean-blob IDs for all five files. After the source commit, each gate clean-blob ID matched its `ccab1a0` committed blob exactly. The earlier `source-pre-manifest.json`/`source-post-manifest.json` are retained as an intermediate snapshot before the test evidence-root edit; they are not represented as the final gate bytes. `migration-immutability.json` verifies migrations 001–007 against fix BASE, gate HEAD and worktree. Migration 006 retains SHA-256 `fb52f395bd0c0f1d29e5234788b39737a922bf0f9928f7e99becfb6be91f3065`, and 007 retains `4e2ccefe6f34d3ef4aa043ee8fe54fc88c45c225d07fd80fb827fef37b564159`.

Fix1 evidence is under `docs/execution/alpha1/m1-task-3-fix1-evidence/6d154143-5941-42f6-ab69-247e9d61f0a0/`. `evidence-file-whitelist.json` names 44 individually hashed safe evidence files (whitelist SHA-256 `adad3a5825529ea388c381aaf067305b30529e044d7c4b62af4ec8b35d7c4742`; it omits its own hash). It contains only command/output captures, source/migration manifests, and PostgreSQL lifecycle/resource metadata; no raw payload, credentials, env, certificates, or ignored reference clones. Source/product staging and evidence staging used explicit file paths.

`owned-postgres-inventory.json` records four fix1 runs: old-root run labels `08d85c79-aaf5-43ef-8c31-db9801cfb234`, `8d8adeb7-4ab5-4460-b8c4-6b3ab38daa5f`, `fb7203fd-e8bc-4e0b-993e-d6bc37e0bf4b`, and new-root run `5b1843bd-c589-494d-8acb-ab557808c744`. The first three old-root lifecycle and summary files were copied individually into `misplaced-owned-runs/`, with matching source/destination SHA-256; their original untracked subdirectories remain untouched. Every run's lifecycle has one `created`, one `image_observed`, and one `removed` for the same full container ID, with `ownershipConfirmed=true` and `containerAbsentAfterRemoval=true`; the summary also confirms exact-ID removal and absence. The local fixture used `postgres:16.10-alpine`; no daemon error was treated as absence. No external CRM, IdP, Hermes, SQL Server, worker orchestration, snapshot, UI or deployment validation was run. The prior evidence limitations and formal site acceptance status remain unchanged.