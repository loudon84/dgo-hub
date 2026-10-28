# M1-5D3 Fix1 scoped rereview

**Spec: FAIL. Quality: Needs fixes. Prior findings: 2/2 ADDRESSED. New material findings: 1 Important/P1, 0 Critical, 0 Minor.**

Scope: the two findings in `task-5d3-review.md` and material breakage introduced by their fix, under the same task-5d3 brief and appendices. Reviewed Fix1 product `7600189aa53fefc327a295f38948b87996bbb854` against `d98639be8e2af6baf3d7f6d1054fdc3d58cc550c`, the supplied Fix1 U10 review package, and appended Fix1 implementation/evidence claims. This does not reopen accepted D1/D2 or constitute whole-M1 review. The full package's initially truncated test section was recovered through a bounded read; no diff was regenerated.

## Prior findings

1. **Recover expired started leases through backoff and budget exhaustion — ADDRESSED.** Migration `integration-service/migrations/009_snapshot_runs_and_recovery.sql:2357` now distinguishes a still-owned expired started claim from an explicit retry whose token was cleared. Starts 1–3 persist database-clock 5/30/120-second fallback and invalidate the old lease without incrementing starts; an exhausted fourth start becomes FAILED at `:2358`. The worker cannot enter its previous claim/begin exception loop for that state. The expanded test at `integration-service/acceptance-tests/snapshot-runs.test.ts:2377` captures fallback state and old-token rejection, and `:2445` checks an actual fourth-start Node SIGKILL after effect COMMIT: FAILED, busy=false, C COMPLETE, unchanged source/schedule and one preserved effect/receipt/outbox. The new null-parameter hole below is a separate consequence of the new unowned fallback representation.

2. **Retain the current Owner subject lock for below-threshold effects — ADDRESSED.** Migration `integration-service/migrations/009_snapshot_runs_and_recovery.sql:2536` selects the exact Owner subject `FOR UPDATE` and checks `enabled` before the below-threshold return. The unchanged caller-owned aggregate transaction retains that lock through COMMIT. The two-client test at `integration-service/acceptance-tests/snapshot-runs.test.ts:2479` observes the exact disable UPDATE waiting on a transaction-id lock while the worker is at its pre-COMMIT gate; the captured result subsequently preserves one lawful effect and C COMPLETE, with D STALE and the below-threshold source/schedule ACTIVE/enabled. No new D approval or pause requirement was added.

## New Important finding

### [P1] Reject NULL token and NULL lease explicitly in the new unowned fallback state

**Location:** `integration-service/migrations/009_snapshot_runs_and_recovery.sql:2529`, `:2578`, `:2621`, `:2649`.

The fix now intentionally stores `status='APPLYING', d_claim_token=NULL, d_lease_expires_at=NULL` during crash backoff (`:2365`). Its four PL/pgSQL guards use the equivalent of:

```sql
IF ... OR d.d_claim_token IS DISTINCT FROM p_claim_token
       OR d.d_lease_expires_at <= clock_timestamp() THEN ...
```

For a caller supplying `NULL::uuid`, NULL is not distinct from the saved NULL, and the lease comparison is NULL. The whole rejection condition is therefore NULL rather than true, so PL/pgSQL skips the rejection branch. These functions are non-STRICT, worker-executable routines, so the argument reaches their bodies.

For example, during the persisted fallback a `hub_worker` call to `finish_etl_snapshot_delete_apply(tenant, source, run, NULL::uuid, 'FAILED', 'NULL_FENCE_TEST')` passes the token/lease guard and finalizes the run without owning any live claim. A NULL-token retry similarly changes retry state. Currentness/preflight and effect recording contain the same guard shape. Thus clearing the claim no longer fences all claimless invocations, violating the exact live-token/lease requirement and allowing a stale or malformed worker invocation to finalize during backoff.

Require the stored token, supplied token and lease to be non-null, require exact token equality, and require a live lease. An affirmative predicate rejected with `IS NOT TRUE`, or explicit NULL checks, avoids three-valued-logic bypass. Apply it consistently to all four affected guards. Add focused assertions supplying NULL during the unowned fallback and during a live replacement claim: every mutation/finalizer must reject, and token/start/lease/retry/effect facts must remain unchanged. The new tests at `snapshot-runs.test.ts:2365` exercise non-null old UUIDs, which explains why they pass without covering this case.

## Verification and evidence limits

- Independently compared actual committed blob bytes and current raw source bytes against the before/after captures for final build, unfiltered snapshot and typecheck: **18 path/capture records, 90 checks, zero mismatches** across migration 009, snapshot acceptance and unchanged worker. Checks covered actual HEAD, Git blob identity, committed LF SHA-256, raw SHA-256 and raw size. Worker blob remains `dde90426efad9f53686e0d3a1c8904e53bad0a8c`. These were read-only Git object checks; no index/HEAD operation occurred.
- Final captured stdout reports build success, typecheck success, and unfiltered snapshot **26/26 passed in 160.31s**. Final stderr is empty. No suite or mutation test was rerun. Root separately checks artifact metadata; a matching artifact hash does not by itself validate the artifact's source attribution or assertions.
- Read the actual final D lifecycle records: fallback deltas are 4.998656, 29.996041 and 119.996620 seconds relative to database time, with no effect/start increment; these are persisted due-time observations, not evidence of waiting 120 wall-clock seconds. Old UUID calls to begin/heartbeat/retry/load/members/preflight/effect/finalize are rejected, and replacement-token state is retained. These records do not test a NULL argument.
- Actual failure classifications come from raw **stderr**, not folder labels or conversational chronology: runtime `c3b3ab14...` exposes the original immediate recovery defect; `ae96cbcb...` receives `RETRY_PENDING` for an old-token retry instead of STALE; `51c1a490...` reaches the Owner race and observes no Lock wait. Focused `8c1220a4...` is GREEN. The folders `owner-lock-red` and `null-token-diagnostic` are misleading labels for the latter two actual failures.
- Three documentary/resource-evidence corrections were sent to the controller and are pending its verification in a supplemental package: (a) use the raw-stderr classification above; (b) the final fourth-start child in the lifecycle bytes is **PID 40852**, whereas the supplied later PID observation queries 14932 and omits 40852; (c) the manifest's single final PostgreSQL lifecycle destination declares a `f9edc001...` source path but its bytes describe run `06b88d28...` / container `fe658e7a...`, and it does not contain separate records for all three claimed final containers. The copied file's hash matches the manifest, so this is an attribution/completeness issue, not a hash mismatch. Preserve the original package as history and provide exact original-to-unique-destination bindings and the missing exact-PID observation. No cleanup retry or new suite is needed.
- Reused the previously read review skill and task-reviewer contract. No broad source audit, product/index/Git mutation, subagent, source/network transaction, resource creation/cleanup, secret/config read, or blocked-artifact access occurred. Only this rereview report was written. Original no-preimplementation-RED and formal/site/Hermes/production/E/whole-M1 limitations remain; the focused Fix1 REDs do not retroactively change them.

**Assessment:** both requested fixes are present and have relevant regression evidence. The new NULL-token/NULL-lease bypass prevents accepting Fix1. Spec FAIL; Quality Needs fixes.
