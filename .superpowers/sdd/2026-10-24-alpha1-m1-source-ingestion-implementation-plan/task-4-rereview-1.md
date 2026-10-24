# M1-4 Fix1 independent scoped re-review

**Scoped Spec: PASS. Scoped Quality: Approved.** M1-4-R1, R2 and R3 are **ADDRESSED**. No new material defect was found in the seven-file repair diff. This closes the three source findings; the original five M1-4 assurance limits and earlier Task 3 limits remain separate and open. Formal 48-row acceptance remains **NOT_RUN**.

## Review pin and scope

- Previous review HEAD: `c78153c42e8bb5385e1fa56f889b2448db7ccde9`.
- Repair source/test commit: `7ea2e94beb6fef43228094aa7f616a90ae65b3cd`.
- Fix evidence/report HEAD and observed working HEAD: `c7d60ca91bf34100dee4f9bcda539615b88128a4`.
- Actual focused-gate HEAD: `6f9b7cc1bacf364b143c622914c5848dacffd935`, with the seven uncommitted repair paths.

Re-read the original R1–R3 review, complete Task 4 brief, appended Fix1 report and both M1/M0 blocked-artifact policies. Reviewed the supplied complete scoped log/stat/U10 package and changed source/test interfaces. Followed the root ruling allowing a minimal normalization-context source-ID validator with the exact existing 1–256 registry pattern, while preserving the 128-character business/external identifier validator and immutable migrations 001–007. Applied the existing code-review axes without further delegation, as required by the scoped review contract.

The repair touches `etl-worker/worker.ts`, migration 008, `normalization/apply.ts`, `normalization/canonical.ts`, and the migration, strict-ingestion and canonical-apply acceptance tests. An explicit comparison confirms no integration-service changes between the repair source commit and Fix evidence/report HEAD. Another explicit comparison confirms migrations 001–007 are unchanged from the original reviewed HEAD. All source/test locations below are within `integration-service/` at the repair commit.

## Finding dispositions

| Finding | Verdict | Repair and relevant evidence |
| --- | --- | --- |
| **M1-4-R1 / P1** | **ADDRESSED** | `migrations/008_durable_worker_leases_and_retries.sql:14` adds `operation_id uuid NOT NULL DEFAULT gen_random_uuid()` directly. The row-level UPDATE backfill is removed, so migration 007's old BEFORE UPDATE guard is never invoked for UUID initialization. The later processing guard still makes operation identity and accepted facts immutable. `acceptance-tests/migrations.test.ts:91` first applies 001–007, inserts constraint/FK-complete raw/job/proof/item/outbox rows, upgrades to 008, repeats the runner with no new applied migration, and compares raw bytes, the complete job row, accepted item facts/status/time and outbox job/timestamp facts. It verifies a populated UUID and its stability through a valid processing-state update. The original error is isolated in retained `red-r1-focused`: migration 008 rejects with `MIGRATION_APPLY_FAILED`. Both focused GREEN and the final combined focused gate pass. The test uses seeded durable rows rather than claiming an HTTP admission test; that is sufficient for the trigger/backfill regression. |
| **M1-4-R2 / P2** | **ADDRESSED** | `etl-worker/worker.ts:217` computes retry eligibility against database `clock_timestamp()`; the JS-clock comparison is removed. At `:282`–`:286`, observed failure is persisted with database current time plus `durableRetryDelayMs(attempts_started)`, rather than reusing the attempt-start due timestamp. Attempts/retries and the stable operation ID are not reset. The durable attempt-start transaction retains its crash fallback due time, and fourth-start exhaustion still clears due time and quarantines. `acceptance-tests/strict-ingestion.test.ts:722` makes a real PostgreSQL trigger sleep 5.5 seconds then fail: the test requires `RETRY_PENDING`, one counted attempt, the original operation ID and more than four seconds still due; an immediate worker invocation must leave attempts at one. Retained isolated RED observes **−546 ms** remaining. The final focused gate passes this regression and the existing four-start/5–30–120 budget test. |
| **M1-4-R3 / P2** | **ADDRESSED** | `normalization/canonical.ts:54` adds `validateCanonicalSourceId` with the registry's exact ASCII pattern `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`, returns the original string, and does no trimming/case conversion. Both apply entry points use it at `normalization/apply.ts:229` and `:339`. The general 128-character identifier validator and canonical business schemas are unchanged. `acceptance-tests/canonical-apply.test.ts:1492` covers source lengths 128/129/256, rejects length 257 and a slash-containing source, and still rejects a 129-character business PK. The real HTTP-to-`hub_worker` regression at `acceptance-tests/strict-ingestion.test.ts:483` admits all three source lengths, checks no apply errors, and verifies exact stored source IDs with `APPLIED`/`SUCCEEDED` and count 1. Its retained RED preserves the 128-character success control while 129/256 remain `RETRY_PENDING`/`PROCESSING`; final focused GREEN passes all three. |

The retry repair keeps the existing barrier-first lock order, fenced lease/item transaction and atomic canonical/item-summary boundaries. The source-ID change affects only context source validation; frozen proof, source/tenant query predicates, canonical PK/external-ID limits, source-content digesting and case-sensitive identity remain unchanged. The migration repair adds no queue, authority, public route or new permission grant. No additional documented-standard breach or material regression was found within this repair diff.

## Evidence inspected and binding limits

Official copied evidence root: `docs/execution/alpha1/m1-task-4-fix1-evidence/6fdb2d28-0d50-4422-b363-d7c028584f0c/`.

Independently checked every one of the **69 explicit `copy-manifest.json` entries** for destination containment, byte size and SHA-256: **zero mismatches**. The external runtime originals at `E:\m1t4-runtime\m1-task-4-fix1-7d8fad1f-349f-45e5-8691-3e54fa720f16` were not accessed or changed by this reviewer.

Read actual command/stdout/stderr/exit records, including the isolated RED cases and final focused/typecheck/build captures:

| Retained capture | Observed result |
| --- | --- |
| `red-r1-focused` | Exit 1; isolated populated-007 upgrade failure at migration 008 |
| `red-r2-focused` | Exit 1; long database failure finishes with due time 546 ms in the past |
| `red-r3-worker` | Exit 1; 128-character job applies, 129/256 jobs remain pending for retry |
| `green-r1-focused` | Exit 0; populated upgrade/repeat regression passes |
| `green-r2-r3-focused` | Exit 0; two selected timing/canonical-source tests pass |
| `focused-green` | Exit 0; **3 files, 5 passed / 76 skipped**; empty stderr |
| `typecheck` | Exit 0; `tsc --noEmit -p tsconfig.json`; empty stderr |
| `build` | Exit 0; `tsc -p tsconfig.json`; empty stderr |

The final focused command selects `upgrades accepted 007|keeps the retry budget|full retry delay|registered 256-character limit|128, 129, and 256 character source IDs` across the three changed acceptance files. Test commands include the absolute external `M0_RUN_EVIDENCE_ROOT`. Typecheck/build command files contain their plain npm commands; the report describes the external test environment separately.

The initial broad `red-migration` capture also contains a test temporary-directory prefix cleanup-guard failure. The final fixture prefix now falls under the existing guarded `m0-migration-` prefix. The initial combined R2/R3 RED contains a default 5-second timeout and subsequent terminated connection; the corrected long test alone has a 15-second timeout. These harness failures remain retained and are distinguished from the defect-specific isolated REDs. They are not treated as passing evidence or removed from the history.

Compared both source manifests field by field: all seven paths have matching raw SHA-256, LF SHA-256, byte size and clean Git blob, and every clean blob equals its source object at `7ea2e94`. **The file named `source-manifest-pre.json` is explicitly a `post-focused-gate-pre-source-commit` snapshot.** It was captured after the gate, before source commit; the other snapshot is post-commit. Therefore this pair proves the recorded post-gate snapshot matches the later committed source. It is **not** an independently captured pre-gate/post-gate equality proof, and this review does not claim otherwise. The report now accurately states that timing. The gate's association with the repaired bytes also relies on the retained execution chronology and implementer's unchanged-source account.

Parsed all twelve whitelisted PostgreSQL lifecycle files: **12 distinct exact container IDs**, each with one create, one image observation and one removal event carrying ownership confirmation and post-removal absence. The copied resource audit records the same twelve as removed/absent. The selected image digest is `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`. These are retained lifecycle/audit observations, not new live Docker checks. No resource issue warranted a reviewer rerun.

## Assurance and execution boundaries

The earlier **19-file / 312-test full-suite pass belongs to source `2189ad75`**, before this repair. No full suite was run in Fix1 or by this reviewer. The current post-fix result is the five-test focused gate plus typecheck/build above; it must not be relabeled as a new 312-test run. Source binding has the post-gate-only snapshot limitation stated above.

The five original M1-4 assurance limits remain as recorded in `task-4-review.md`: started-attempt crash window; adversarial lease overlap/stale-holder mutation; frozen pause/config/mapping/Owner drift and post-recovery old jobs; broader reference/tenant/defensive/DELETE variants; and strict CLI/role-negative integration. This repair directly adds only the R1 upgrade, R2 long-failure and R3 source-length regressions. Earlier Task 3 missing assurance remains distinct; none is inferred closed from these five tests.

No tests, compiler/build gate, source probe, DB/HTTP/network/container operation, resource cleanup, Git mutation or product edit was performed during this re-review. No secret/env/npmrc/certificate/Config.Env/blocked-target contents were read and no alternate cleanup was attempted. Only this re-review file was written. This approval covers R1–R3 and material regressions introduced by their scoped fix; it does not establish formal site acceptance or production readiness. Formal 48-row acceptance remains **NOT_RUN**.
