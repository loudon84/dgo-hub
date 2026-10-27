# M1-5C Fixround 1 independent re-review

**Spec compliance: Needs fixes.**

**Quality: Needs fixes.**

Review scope: the complete 1,144-line `context/task-5c-fix1-review-package.txt`, its seven product/test paths, the updated brief including the controller's latest-allocation observation ruling, and the appended Fixround 1 report. Review BASE `d264b8fc2c2252375bd28b0e2444ce76db05483e`; supplied HEAD `2d4770762c2f63b5d878c471ae1ca9d078e4eb52`; product/test commit `2ad5d36f0b41b2422859bf2f22f81c28e84f2b1a`. Read-only verification later observed HEAD `0f10d3604aca31cec9afe1825c2971b378a40899`; all seven current product/test raw hashes and committed Git blobs matched the supplied product commit. The review remains bound to that product and supplied diff.

No suites, compiler commands, databases or child processes were run by the reviewer. No product/Git/index/HEAD changes were made; this report is the only reviewer write. Prior review context was retained; unchanged product areas were not reopened for a broad audit.

## Disposition of original findings

| ID | Disposition | Evidence and remaining limit |
| --- | --- | --- |
| C5C-R1 | **ADDRESSED** | `snapshot-apply-worker.ts:143` asserts the C claim before helpers; line 152 throws on false recording inside the caller transaction. The focused stale-token regression invalidates the lease immediately before recording and verifies canonical/outbox equality with the pre-state and zero outcome/range/checkpoint effects. |
| C5C-R2 | **ADDRESSED** | Migration 009 line 1047 admits cross-run reuse only from `next_value-1`, with matching semantic/scope digests and a COMPLETE binding; a run's existing binding remains the recovery value. A→B→A and failed partially applied B→A cases allocate above B. This implements the controller's explicit high-water ruling. |
| C5C-R3 | **ADDRESSED for the original missing renewal and expired-token failure defects** | Worker lines 173–186 add periodic renewal and explicit effect-boundary checks; SQL line 815 rejects failure writes from an expired token. The 12-second pause under a 10-second lease completes in one start, and expired-token failure returns STALE without releasing the active run. **New retry regression F1 below remains required.** |
| C5C-R4 | **NOT ADDRESSED completely** | Whole-batch customer validation is now called before sealing, but SQL line 965 still admits a mapped subject whose business role is NULL. See residual finding R4 below. |
| C5C-R5 | **ADDRESSED** | Worker line 144 invokes the exact reference check before the order helper, inside the token-fenced aggregate transaction. Migration 009 lines 753–773 resolve the configured tenant/source/PK/UUID tuple and hold SHARE locks on that tuple and live customer through commit. Same-source and foreign-source tuple mutations after validation reject the order; no order outcome is created. |
| C5C-R6 | **ADDRESSED** | Worker line 95 preserves true/false markers before timestamp parsing. The real PostgreSQL boolean false/true worker path completes, retains SOURCE_VERSION without an observation, and stores deletion at the exact approved source update timestamp `2026-10-25 11:00:00.654321+00`. |
| C5C-R7 | **ADDRESSED** | `source-registry/service.ts:674` asserts the current principal and source:approve within the guarded Owner query transaction. HTTP coverage rejects removed scope and disabled binding while keeping the original supplied principal. |
| C5C-R8 | **ADDRESSED** | Migration 009 line 924 limits staged-customer membership to `p_customer_source_id=p_source_id`. The combined run includes local customer extraction and a frozen/live foreign reference C-F absent from the local customer stage. |
| C5C-R9 | **ADDRESSED** | `snapshot-continuation-store.ts:155` now yields one aggregate header per semantic chunk, so `proofFacts` retains one order's at most 200 lines rather than 500 complete orders. No global Node row set was added. This also makes customer iteration one row at a time; the extra round trips are a performance tradeoff, not a correctness blocker in this scoped review. |
| C5C-R10 | **ADDRESSED** | Migration 009 lines 705–708 add the same admitted credential, expected entity and channel filters used by the continuation assertion. The targeted path continues through an unrelated typed barrier; matching barrier behavior remains covered by the retained earlier gate. |

## Required residual and new findings

1. **C5C-R4 — P1: NULL business roles still pass whole-batch customer validation.** `integration-service/migrations/009_snapshot_runs_and_recovery.sql:965`. For an existing enabled mapped subject with `business_role=NULL` and a nonnull department equal to the frozen mapped department, all other disjuncts are false and `owner_state.business_role<>'sales'` is NULL. PL/pgSQL IF does not enter its rejection branch for NULL, so this invalid customer passes the successful validation seal and observation boundary. The unchanged helper checks `business_role !== 'sales'` and quarantines it later during apply. A later invalid customer can therefore still allow an observation and earlier customer/outbox/range commits, the exact failure R4 required preventing. Nullable business roles are a supported subject state. **Fix:** use `owner_state.business_role IS DISTINCT FROM 'sales'` or an equivalent explicit NULL-safe condition. Add a late-customer fixture with an enabled mapped subject, NULL role and matching department; assert no seal/observation/canonical/outbox/outcome/range/checkpoint effects and unchanged earlier customer data. The existing missing-mapping case does not exercise this condition.

2. **C5C-F1 — P2: A transient background heartbeat error becomes permanent run failure.** `integration-service/etl-worker/snapshot-apply-worker.ts:177` (related lines 181–183 and 230–237). The periodic heartbeat catch discards the original error and sets `leaseLost`. At the next boundary the worker throws a new `SNAPSHOT_C_START_LEASE_LOST`, which has no recognized pg transport/transaction SQLSTATE and is classified nonretryable. If only the heartbeat connection had a transient termination/serialization failure and the C token/lease is still valid, `store.fail(...,false)` succeeds and terminally fails/releases the run after one start, instead of preserving the admitted run and using the required DB-clock 5/30/120 transient retries. This is introduced by the renewal fix; the passing long-work case tests successful heartbeats only. **Fix:** distinguish an authoritative false/lost claim from a heartbeat transport/transaction exception, preserve the original exception for the existing retry classifier, and stop effects while its status is unresolved. A still-live claim with a recognized transient heartbeat error must record a retryable failure; an expired/replaced token must not mutate the run. Add a focused one-shot heartbeat pg transport/transaction failure with a still-live lease, asserting retained active_run_id, retry wait/start accounting, same observation/range recovery and eventual success.

## G1 — actual process termination established, full atomic-effects acceptance still incomplete

**G1: NOT ADDRESSED completely.** This is an acceptance gap, not a claim that the child was merely simulated or that R1 remains broken.

The child fixture really imports the worker, communicates its selected aggregate boundary over IPC, and waits there. The parent forks an owned child, validates the run ID, sends SIGKILL and asserts the exit signal (`integration-service/acceptance-tests/snapshot-runs.test.ts:760`, `:770`, `:773`). Retained final lifecycle records establish PID **34684** before COMMIT and PID **16188** after COMMIT, both later recovered with observation **9** and three ranges. Recovery uses the staged continuation and the source-connect counter remains unchanged. The before hook runs inside the aggregate transaction after proof recording and before COMMIT; the after hook runs after the helper transaction has returned from COMMIT.

However, `processCrashRun` starts at `snapshot-runs.test.ts:756` immediately after the completed destination-crash-after run and never changes source business data before either child run. Both runs reuse observation 9 and the same semantic facts. The unchanged canonical helper's equal-version/equal-digest branch returns DUPLICATE before canonical/outbox/receipt writes. The SIGKILL cases therefore demonstrate process death around **C outcome/range/checkpoint recording for duplicate business data**, not the required all-or-none canonical effect + outbox + durable proof boundary for changed business data. Their before/after assertions at lines 774–792 inspect outcomes/ranges/observation/status, but do not inspect canonical row values, outbox, source receipt or checkpoint state. The backend-termination case remains distinct and cannot supply the omitted process-crash acceptance by itself.

**Required acceptance fix (P2):** before each owned child case, change a canonical business fact and approved source timestamp so the selected aggregate actually applies and emits an outbox event. Capture/assert the canonical state, source receipt/version, outbox event, outcome, exact range and checkpoint before kill and after exit: all pre-state/absent before COMMIT, all new matching state after COMMIT. Restart from the same immutable attempt/manifest, bound observation and aggregate/range identity; assert a single committed event/range after recovery and no new source connection. Preserve actual child PID/IPC/kill/exit/lifecycle and fresh exact source bindings.

## Retained evidence and exact-binding qualification

The reviewer independently read the five final commands, stdout, stderr and exits:

| Gate/root suffix | Retained result |
| --- | --- |
| `233e7c9f-8cb6-4850-864c-88820d0c54ae` main PostgreSQL continuation case | **1 passed, 23 skipped**, exit 0 |
| `0aae254a-9656-49b2-ac7b-d5bcd1438ff9` API-013 discovery case | **1 passed, 31 skipped**, exit 0 |
| `60db80c4-70ea-43ac-90c7-ff59876e1420` populated 001–008→009→identical reapply | **1 passed, 23 skipped**, exit 0 |
| `35f2fada-2a04-49f0-b683-845c7603bd5c` typecheck | exit 0 |
| `f784f652-a976-45e2-9fdc-e096f8fb7f56` build | exit 0 |

All five retained final stderr files are empty. These are targeted Fixround 1 gates; the historical 65/65 and 11/11 results are not a new full-suite run against this fix. Controller supplied the 200-artifact SHA/size audit with zero mismatches; this reviewer independently checked all seven commit-binding product blobs/current raw hashes rather than rerunning the entire artifact audit.

**E1 — evidence precision correction required:** the blanket exact-byte match statement at `task-5c-report.md:46` and `docs/execution/alpha1/m1-task-5c-evidence/49b6d3ec-1fce-4b9a-983f-f1a4b400d798/commit-binding.json:6` is too broad for the child fixture. The final main gate's actual before and after manifests record `snapshot-continuation-child.mjs` as **1804 bytes**, SHA-256 `6a82b1091509bd19017f63911523af8a6b4ee073c5b8c9aba45de87d199dca0b`, working blob `d7815bf553b4427a86270435ffe4fa386b624fff`. The committed/current file is **1803 bytes**, SHA-256 `3cf0063eb6016fb8c0a08a6c3f295d97bc817b45b82dbecb9efa46a639ce9ce3`, blob `84f0b638a8d1c3f71145d793c11c7ea462866d75`. The populated migration/typecheck/build final captures retain the same 1804-byte child facts; the API gate's selected-source manifest does not include that child.

An exact read-only Git blob diff was performed. The sole change is removal of one trailing blank line after `await target.end();`; executable content is identical. Thus this is **not a behavioral product blocker or evidence that the child kill did not occur**. Preserve the historical manifests and state six exact source matches plus this explicit whitespace-equivalent child exception; do not relabel the old captured hash as the committed one. Any new G1 gate should bind its actual final child bytes exactly. Correct both report copies and binding explanation while retaining original capture truth.

## Remaining assurance boundaries

- No new full project suite, formal 48-case acceptance or whole M1-5 gate was run or required for this focused fix review. Their absence is not a new Fixround 1 code finding.
- Complete DB privilege-matrix coverage remains outstanding; the fixes retain narrow worker-only procedures and the API projection. No broad grant regression was found in this diff.
- The bounded one-order memory fix is established by the new query limit and control flow, not a heap benchmark. No optional benchmark was requested or run.
- G1's real process-kill improvement and the harmless child newline difference are both credited accurately. They do not waive changed-data atomicity acceptance or the R4/F1 product defects.
- No D/E implementation or other out-of-scope expansion is requested. Approval can follow focused correction and evidence for R4, F1 and G1, plus E1's precise historical binding wording.
