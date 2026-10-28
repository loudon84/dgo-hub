# M1 Task 5D1 capture index

Product source commit: `68bfa36203be6446c47e0927ab9d982b5a380343`, parent `3040666fa9da2de19ba7b8bf632c4765f278b455`. The original gates ran at temporary commit `854df4cfb2492a5cd70da7343131e49d58f8e407`, also parented by `3040666`; 68bfa amended 854df, so 854df is not the parent of 68bfa. No reset or rebase occurred. Fresh gates at HEAD `4163984f28cde7e70a9452416e43b71a0afad7ee` with actual per-gate before/after source manifests are indexed in `fresh-gates-4163984f-20261028/capture-index.md`. Base: `3040666fa9da2de19ba7b8bf632c4765f278b455`. Branch: `feat/alpha1-implementation`.

## Original three gate captures (historical; superseded by fresh gates below)

`M0_RUN_EVIDENCE_ROOT` equaled the external root on each command. Raw command, stdout, stderr, exit code, source root and digests are copied under the listed gate folder and described in its `capture-metadata.json`.

| Gate | External root | Exit | Copied metadata |
|---|---|---:|---|
| Focused snapshot acceptance suite (26/26) | `E:\m1t5-runtime\ebca33ef-a15a-41e9-a97b-6bdfaca6dc4f` | 0 | `gates/ebca33ef-a15a-41e9-a97b-6bdfaca6dc4f/capture-metadata.json` |
| Typecheck | `E:\m1t5-runtime\91663241-93d1-4fd8-84be-72b993717fbc` | 0 | `gates/91663241-93d1-4fd8-84be-72b993717fbc/capture-metadata.json` |
| Build | `E:\m1t5-runtime\33e1f484-8aeb-4413-9256-3cc70a12006c` | 0 | `gates/33e1f484-8aeb-4413-9256-3cc70a12006c/capture-metadata.json` |

The original `source-bindings.json` compares the base source to the final product source and does not provide true before/after snapshots around each command. The original `three-gate-metadata.json` records the 854df HEAD only. Treat the three rows above and their logs as historical captures; they are superseded by the fresh gates and per-command source snapshots in `fresh-gates-4163984f-20261028/capture-index.md`.

## Owned runtime resources from the original full suite (historical)

Only test-owned resources were inspected and cleaned. The PostgreSQL fixture helper used immutable image `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`, `taskLabel=m1task5`, unique run labels, tmpfs-only database storage and its existing ownership checks. The three exact `containerId` / `runLabel` pairs are in `owned-lifecycle/postgres/postgres-lifecycle-<runLabel>.jsonl`; each ends with `ownershipConfirmed=true`, `containerAbsentAfterRemoval=true` after `docker rm --force`. No other containers were targeted.

`owned-lifecycle/node-child-lifecycle.jsonl` records the two test-created `snapshot-continuation-child` processes with phase/run label, entry point, PID, ownership scope, `SIGKILL`, observed `exit_code=null` plus `signal=SIGKILL`, and subsequent C recovery. No other Node process was targeted. The copied lifecycle files are the complete whitelist for these resources.

## Earlier attempts retained

Every listed external root's explicit command/output/error/exit artifacts is copied under `gates/<UUID>/`; failed captures are retained rather than overwritten.

| External root | Result / correction |
|---|---|
| `02b438b2-3d28-4d06-8b29-addbd589ff9d` | Intentional RED before reservation/consumption implementation; reservation completion assertion failed as expected. |
| `1fab5a28-368a-4f05-bcdc-080e8f371f98` | Exposed unqualified `digest` resolution under the security-definer search path; calls were qualified with `public.digest`. |
| `e61c0fa5-2cba-4e39-85ec-5e1e9890e4d2` | Direct C-continuation fixture hit the new D busy fence before the test drained its reservation; test now invokes the D worker after direct successful C completion. |
| `4848edbd-14e0-4fe1-a831-76a45a29b60b` | Earlier focused C/D completion pass. |
| `df0b7cb1-72dc-477c-b0bb-1d833fea5624`, `31fc2963-db1d-4b5b-bba1-311f7ed4a4e4`, `ffb6b5a7-91b1-4ee7-b919-55329f0dac43` | Intermediate candidate-oracle failures while baseline/setup and over-threshold query fixtures were being corrected; details are in the preserved stdout/stderr files. |
| `4c4577da-a972-43b7-89f7-b6f5661761cd` | Native PostgreSQL surfaced a mismatched parenthesis in candidate selection; corrected before the passing migration gates. |
| `b706d17b-53ef-4122-91ac-c54f68321e62` | Over-threshold real-C test fixture had a customer-source identity mismatch; corrected to use the original approved customer source. |
| `117f1d70-3e91-46ea-af59-2ebe45146ba9`, `63b7f6d0-d06a-426a-bfb0-ec224b71eda8` | Typecheck/build caught optional endpoint customer profile narrowing; corrected with the fixture's known-present customer profile. |
| `112a27b4-8156-4b32-9e96-2cf746360ea2`, `bd46d440-dc0e-448a-ae81-59f039d884bb`, `b13c2fb1-9362-4e1a-a3ae-40dbe6a06d41`, `83cd27e0-d06a-426a-bfb0-ec224b71eda8`, `c1bcc386-fcbb-4a1e-8e6b-bf34c37d10ad`, `ee962319-07d6-4b73-94ff-5c8dd8a8fcb9` | Earlier passing D oracle, migration, typecheck/build and full-suite runs retained for chronology. |

The external artifacts were copied by explicit UUID and filename whitelist. Generated temporary migration copies under test roots, ignored reference clones, `.env`/credential material, npm configuration, and blocked host-artifact paths are excluded from this package.

Report copies: .superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/task-5d1-report.md and docs/execution/alpha1/m1-task-5d1-report.md are identical, SHA-256 `4bbc9b10d5466787994c8fe8eb53a273989abcd00e7cb5313cea121c0d7cf1ad`.

## Corrected fresh gate capture

The fresh final gate captures and true per-command source-before/after manifests are in `fresh-gates-4163984f-20261028/capture-index.md`. See that index for corrected Git parentage, all three fresh UUID roots, exact HEAD, hashes/sizes/blobs, and the copied owned lifecycle records. The earlier 854df metadata and logs remain retained as historical artifacts. The earlier source-bindings.json compares base to product and is not per-gate bracketing evidence.

## Capture wrapper setup attempts

These attempts are retained under their original external UUID directories and were not counted as npm gates:

| External UUID | Result |
|---|---|
| `939e2f1b-efce-403a-8015-bad19375d64c` | Wrapper stopped at unsupported PowerShell `utf8NoBOM` encoding parameter before npm invocation. |
| `fa681987-207e-4a09-a525-acc1a41f8f31`, `8e5f5c28-33f0-43da-a181-670cf00fa042` | Wrapper failed because this PowerShell/.NET runtime lacks `SHA256.HashData`; npm was not invoked. |
| `f1d11674-7872-4304-b367-58cad25fd535`, `cb97124d-3873-4d8e-9f0e-5d845d1100df`, `c7e8f8d2-3b5b-4e8a-84c1-b2c32a42b54b` | Wrapper invoked npm with an extra `npm` command token and received `Unknown command: "npm"`; these are wrapper failures, not test/typecheck/build gate results. |

The fresh capture wrapper was corrected and all three requested commands then ran successfully with separate UUID roots.
