# M1-4 independent Spec and Quality review

**Spec: FAIL. Quality: Needs fixes.** Three actionable findings: one P1 and two P2. The retained gates are valid evidence for the tested bytes, but do not cover the populated-database upgrade or the two interface/timing cases below. Formal 48-row acceptance remains **NOT_RUN**.

## Pin, authority, and review scope

- BASE: `c616402a79019821da77c0434762c6970a322e61`.
- Reviewed HEAD: `c78153c42e8bb5385e1fa56f889b2448db7ccde9`.
- Product source/test commit: `2189ad75ea1bed4f3edcd3b2e7754dfcbe07c4ee`; evidence commit: `a834075`; final report placement: `c78153c`.
- During final report verification, controller HEAD advanced to docs-only checkpoint `933df85a88fdbd5c274da7e84eda599c7c695d4b` (progress/status only). An explicit integration-service comparison from the reviewed HEAD to that checkpoint is empty; the review pin remains `c78153c`.
- Compared `git diff c616402a79019821da77c0434762c6970a322e61...c78153c42e8bb5385e1fa56f889b2448db7ccde9`, including the supplied full log/stat/U10 product review package. The source-to-HEAD integration-service comparison is empty. Read the complete final Task 4 brief, report and interface preflight, plus the M1 and M0 blocked-artifact policies before source/evidence operations. The final root rulings are authoritative.
- Reviewed all nine changed source/test paths: `etl-worker/worker.ts`, `etl-worker/retry.ts`, migration 008, `acceptance-tests/strict-ingestion.test.ts`, `worker-crash-driver.test.ts`, `canonical-apply.test.ts`, `identity-store.test.ts`, `migrations.test.ts`, and `source-registry.test.ts`. Also read relevant strict intake/validation, canonical apply/model/identifier, migration 006/007, migration runner, runtime configuration and DB entry interfaces. All product locations below are relative to `integration-service/` at the reviewed source pin.
- No applicable repository/ancestor AGENTS.md or separate coding-standards file was found in the bounded searches. Applied the code-review skill's Spec and standards/quality axes directly; the explicit review contract prohibits additional subagents. No additional style-only finding is raised from the smell heuristics.

## Actionable findings

### M1-4-R1 — P1 — Migration 008 cannot upgrade a database containing accepted items

**Location:** `migrations/008_durable_worker_leases_and_retries.sql:20` (backfill), with the still-active guard in immutable `migrations/007_durable_ingestion_jobs.sql:157`.

The brief requires a “minimal additive migration” extending the existing durable job/item tables, while preserving accepted facts. Migration 008 first adds a nullable `operation_id`, then executes `UPDATE ... SET operation_id=gen_random_uuid()`. At that point the 007 BEFORE UPDATE trigger is still installed: it raises SQLSTATE `55000`, `ingestion item update has no worker state change`, whenever `(status,error_code)` is unchanged. This backfill changes neither field. Consequently, **any existing item**, including an ordinary `RECEIVED` item accepted during Task 3, causes the 008 migration transaction to abort. The replacement function is not reached until line 24. Simply moving the final replacement guard earlier would also reject the operation-ID mutation.

**Concrete scenario:** apply 001–007; accept one valid REST batch; run the new migration chain. The first existing item's backfill fires the old guard and aborts 008, leaving the worker's required columns/grants unavailable. The retained migration tests run the complete chain before inserting jobs, so their clean-chain/repeat passes cannot reveal this upgrade failure.

**Required repair:** initialize operation IDs through a migration operation compatible with the old immutable-row trigger (for example, add the column with its UUID default as part of the ALTER), or use an explicitly bounded migration-only transition that preserves every accepted fact/status. Keep 001–007 unchanged and retain immutable operation IDs afterward. Add a real 007-to-008 upgrade regression with pre-existing raw/job/item/outbox rows; verify IDs, proof/facts and statuses survive, and repeat migration is harmless.

### M1-4-R2 — P2 — Known failures retry before the required failure-relative delay

**Location:** `etl-worker/worker.ts:230`–`:236` and `:282`–`:284`; related regression at `acceptance-tests/strict-ingestion.test.ts:595`–`:614`.

The final brief requires “delays of 5, 30, and 120 seconds after the initial failure and subsequent retry failures.” `startAttempt` writes `next_retry_at = clock_timestamp() + delay` **before** application starts. `recordTransientFailure` then copies that same timestamp from the started item, rather than scheduling from the observed failure. `finishClaim` publishes this earlier timestamp as queue availability.

**Concrete scenario:** the initial attempt starts at T0, spends six seconds waiting on a database operation, then rolls back. Its due time remains T0+5, so the next loop can start the first retry immediately after failure, instead of waiting five seconds. A 20-second second attempt leaves only ten seconds of the required 30-second post-failure delay; a sufficiently long attempt eliminates it completely. This accelerates repeated attempts during the same outage and can exhaust the four-start budget before the ratified waiting periods. Existing tests throw almost immediately, tolerate 200 ms less than the delay, then manually force due times; they mask this case.

**Required repair:** retain durable start/budget facts and a recoverable crash schedule, but when a failure is actually observed persist its due time using the authoritative database clock plus the correct 5/30/120 delay. Enforce due eligibility against that same clock. Add a controlled long-attempt/clock regression showing the complete delay remains after rollback; preserve the four-start cap and stable operation identity through recovery. This finding does not challenge the separate requirement that an uncommitted crashed start consumes its budget.

### M1-4-R3 — P2 — Valid 129–256-character source IDs cannot reach canonical apply

**Location:** `etl-worker/worker.ts:79` and `:310`–`:312`; interface rejection at `normalization/apply.ts:229` / `:339` and `normalization/canonical.ts:46`.

The worker now connects the existing strict admission contract to canonical apply and must preserve source identity as case-sensitive text. Source registration accepts 1–256-character source IDs (`source-registry/service.ts:66`, `:245`–`:246`), consistent with the source-credential constraint in migration 002. The worker passes the unchanged job source ID into `ApplyContext`, but both apply entry points validate it with the **business-object identifier** validator, whose maximum is 128 characters. There is no compatible source-ID validation boundary in this new integration.

**Concrete scenario:** configure/approve a REST source named `A` repeated 129 times, then accept a valid customer or order job for it. Canonical apply throws `CANONICAL_IDENTIFIER_INVALID` before any proof/database query. The worker treats this deterministic contract mismatch as transient, consumes all four starts and ultimately quarantines every otherwise valid item with `RETRY_BUDGET_EXHAUSTED`. Truncating or renaming the frozen source ID would violate source identity and is not a repair.

**Verification:** one minimal, resource-free source probe transpiled `normalization/canonical.ts` in memory and called the actual exported validator. Exit 0; output was `{"sourceIdLength":129,"registrySourceIdRegex":true}` followed by `{"canonicalRejection":"CANONICAL_IDENTIFIER_INVALID"}`. The registry pattern in the probe was checked against the actual registration source. No DB/network/file writes were involved. This is a newly exercised worker/apply interface incompatibility, not a general reopening of earlier phases.

**Required repair:** give context source IDs the already accepted source-ID contract, separately from canonical object/external identifiers, preserving exact case and spelling. Add worker integration coverage at 128/129/256 characters and retain the existing rejection of out-of-contract source IDs. Do not narrow accepted frozen jobs to make the worker fit.

## Behavior examined beyond the findings

- **Lease ownership and lock order:** the existing one-row-per-job outbox is extended, not duplicated. Claims are bounded to 1–100, use `FOR UPDATE OF o SKIP LOCKED`, generate a fresh UUID token and commit separately. Item start/apply/error/invalid-fact transactions acquire the global barrier guard before outbox/item locks. Their claim check binds job, tenant, source, token, unexpired lease and unacknowledged state, retaining the outbox row lock until transaction end. A reclaimer skips an outbox row still locked by an applying transaction even if its timestamp expires. Once reclaimed, the stale token fails both mutation checks and ACK predicates. No source/auth mutations occur during claim.
- **Atomic item result:** canonical apply uses the caller's `PoolClient`. Canonical header/lines, receipt, business apply outbox, item terminal status and derived job summary share the same transaction. Error recording follows rollback in another fenced transaction. A commit with lost client response is protected by the persisted terminal row: subsequent failure recording/processing skips it. `finishClaim` runs after item transaction completion, requires all terminal items before ACK and releases/reschedules otherwise. The long-failure timing defect is R2.
- **Start and replay:** operation IDs are durably created once and immutable; attempts/retries have bounded monotonic counters, and terminal skips/claims do not increment them. A committed start left `APPLYING` remains counted; recovery advances within the four-start budget and quarantines an exhausted fourth crashed start. A committed terminal item is skipped after a crash before ACK, protecting canonical state/outbox from a second mutation.
- **Frozen proof and barriers:** context comes from tenant/source-qualified job proof, not payload or current registry revision. Apply remains the validator of the frozen approval/test/config/mapping tuple and typed security facts. The worker adds no current-source epoch/pause/revision freshness gate. Existing apply checks retired channel/security facts before receipt/version comparison and preserves the narrow explicit remap fence. All four typed barriers have retained worker cases; remap isolation and unrelated frozen completion are covered. The untested drift/recovery combinations are listed separately below.
- **Adapter and summaries:** structured facts are revalidated through the strict public validator, including strict enums/fields/identifiers and order status/empty-line rules. Decimal strings are padded without numeric conversion. Timestamp fractions are retained separately while whole seconds/offsets normalize to UTC. DELETE uses outer `source_updated_at`. The order reference query binds tenant, exact reference source ID, entity, source PK, the frozen mapping revision, the same UUID and a live same-tenant customer. `DUPLICATE`/`IGNORED_STALE` remain successful terminal states distinct from `APPLIED`; only `APPLIED` contributes to `applied_count`. All-failure/mixed/pending summaries are derived from persisted item states.
- **Scope and permissions:** migration 008 adds only processing columns, their constraints/index/guard and worker column grants; raw/public/proof columns and operation ID are not granted for worker mutation. Git comparison confirms migrations 001–007 unchanged. The strict startup selects only the durable loop and requires `current_user=hub_worker`; the legacy local-lab path remains separately gated. No new queue, auth registry, mapping authority, routes, Task 5 manual retry/snapshot feature or query-gate opening was added. Actual strict CLI startup remains an assurance gap, not a proven source defect.

## Retained evidence and source binding

Evidence root: `docs/execution/alpha1/m1-task-4-evidence/ba0044f2-2d67-4a12-b12e-0f830f188a77/`.

Independently checked all **185 explicit whitelist entries** in `evidence-file-manifest.json` for path containment, byte count and SHA-256: **zero mismatches**. No recursive evidence staging/archive or blocked-path read was performed. The final pre/post source manifests have identical raw hashes, LF hashes, byte counts and clean blobs for all nine paths; each clean blob equals the corresponding blob committed in `2189ad75`. The actual gate HEAD was `2d9b67c2f04104afb7995bc26360f285ad89f92b` with those nine dirty source/test files. This is not misrepresented as a gate run at the later source commit.

Read final command/stdout/stderr/exit captures under `final-gate/checks/`:

| Retained command (all with the absolute external M0 evidence root below) | Exit | Observed capture |
| --- | ---: | --- |
| `npm run typecheck` | 0 | `tsc --noEmit -p tsconfig.json`; empty stderr |
| `npm test -- --reporter=verbose` | 0 | 19 files / 312 tests passed; empty stderr; includes 15 M1-4 worker cases |
| `npm run build` | 0 | `tsc -p tsconfig.json`; empty stderr |

The exact root is `E:\m1t4-runtime\m1-task-4-final-9b0fd52a-6a5a-4eb1-88f0-f4770281e269`. Individual post-gate safe copies and hashes are recorded by `final-gate/copy-manifest.json`; external originals were left untouched. The retained full-suite recorder run uses that external root, avoiding concurrent in-repository lifecycle writes changing the recorder source snapshot. There is no change to the validator/trust anchor or test-suite parallelism in the product diff.

The focused-15 capture contains 14 worker passes before the remap case was added; `final-gate/focused/focused-remap-02` adds the retained focused remap pass, and the final full suite includes all 15. The crash test really spawns and terminates a child worker, rather than merely throwing an in-process exception. Read retained RED (`runDurableWorkerOnce is not a function`), failed first typecheck, prior full-suite failure summary, and relevant focused/remap captures. The prior failures remain present and are not substituted for the final gate.

Parsed every whitelisted PostgreSQL lifecycle: **35 distinct exact container IDs**, each with one create, one image observation and one removal event with ownership and post-removal absence confirmed. The resource audit also lists all 35 as absent after its exact-ID Docker checks, exit 0. Image digest is `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`. These are independently inspected retained records, not a new live resource inventory by this reviewer.

## Missing assurance, separate from source findings

These are limits of the retained M1-4 integration evidence. They are not additional proven defects, nor claims that earlier assurance gaps are closed.

1. **Started-attempt crash window:** actual termination is after claim (asserted attempts=0) and after terminal commit. There is no kill after durable attempt-start commit but before/inside apply proving persisted due time, counted start and remaining budget across an actual process restart. The source does persist these facts; R2 concerns observed-failure timing.
2. **Adversarial lease overlap:** two workers completing distinct jobs and a manual stale-token ACK predicate are covered. There is no controlled test holding an active apply transaction past lease expiry while a reclaimer competes, then resuming an old holder after token replacement to prove both status mutation and ACK rejection. Source locking/predicates support this behavior, but the retained tests are weaker than that scenario.
3. **Frozen drift/recovery matrix:** worker execution covers source epoch drift and a narrow remap fence; it does not independently exercise accepted work through ordinary pause, current config/mapping/Owner changes, or an unexecuted pre-barrier job applied only after later Owner-approved recovery. Earlier ordinary-pause tests concern intake receipt replay, not worker execution. Typed barriers are directly inserted fixture facts rather than every real management operation in the worker test.
4. **Reference/tenant/defensive variants:** the worker test uses a missing different-source customer tuple. It does not cover an existing other-source collision, same-source mismatched UUID, cross-tenant target or deleted target through this worker path, nor corrupt durable public facts or DELETE effects/counts. Existing canonical/FK tests establish parts of these boundaries, not the complete new worker integration matrix.
5. **Runtime and role negatives:** real `hub_worker` apply/claim/recovery/ACK and API raw/core rejection are established, and the full suite retains earlier canonical role checks (including auth-subject mutation rejection). The new strict compiled CLI startup, rejection of an incorrect runtime role, and the full post-008 negative matrix for registry/tenant/proof/raw mutation and unrelated reads are not exercised as a worker entrypoint test. The shared worker legitimately reads jobs across tenants; no fictitious tenant-specific DB role/RLS is assumed.

The earlier Task 3 assurance list from `task-3-rereview-1.md` remains distinct: cross-tenant/source/entity negatives, controlled final-assertion races, broader policy/immutability/role matrices and actual dropped-response transport were not globally closed by this change. Some item rollback positions are now covered in M1-4, without retroactively claiming all older intake/transport guarantees.

No equivalent full-suite/typecheck/build rerun, DB/container/resource operation, external network/source probe, site/IdP/CRM/Hermes/SQL Server access, secret/env/certificate read, cleanup retry, Git mutation or product edit was performed during this review. Only this review file was written; the single source-only identifier probe is described above. Formal 48-row acceptance remains **NOT_RUN**.

## Disposition

**Spec FAIL / Quality Needs fixes:** address M1-4-R1 (P1), M1-4-R2 (P2) and M1-4-R3 (P2), then obtain a scoped independent re-review with source-bound repair evidence. No additional documented-standard breach or style-only smell finding is asserted. The evidence integrity checks pass as retained-evidence checks; they do not close these source defects or establish production readiness.
