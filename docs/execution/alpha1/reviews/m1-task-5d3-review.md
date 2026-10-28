# M1-5D3 independent task review

**Spec: FAIL. Quality: Needs fixes. Findings: 2 Important/P1, 0 Critical, 0 Minor.**

Reviewed product `ac9fdeec20b2e4b9e2737b287034dd7354f193d9` against base `3fbbd4d38f6568979b6b37b32d5322000f1ddb6a`, task-5d3-brief.md including all appendices, and the corrected implementation report from docs-only follow-up `d98639be8e2af6baf3d7f6d1054fdc3d58cc550c`. This is the independent Sol task gate for D3, not whole-M1 approval.

## Strengths

- `integration-service/etl-worker/snapshot-delete-worker.ts:34`, `:116`, `:121`, `:124`: each aggregate uses the caller-owned PoolClient transaction, the existing customer/order canonical helper, the frozen observation and microsecond timestamp text, and a same-transaction D outcome. False/empty outcome results throw before COMMIT.
- `integration-service/migrations/009_snapshot_runs_and_recovery.sql:2259`, `:2316`, `:2395`: currentness reconstructs original full-qualified membership from live tuples plus this candidate's committed effects, checks the shared fingerprint and expected live count, and persists immutable member operation IDs in the committed claim transaction.
- `integration-service/migrations/009_snapshot_runs_and_recovery.sql:2138`, `:2617`: API-060 replay uses the existing immutable request and own-effect-aware currentness; finalization changes D state without activating the source or enabling its schedule.
- `integration-service/acceptance-tests/snapshot-runs.test.ts:1818`, `:1930`, `:2030`: the added oracle actually terminates owned Node children before/after aggregate COMMIT, resumes real multi-member tombstones, and forces an outcome-write failure to check order/line/receipt/outbox rollback. This provides useful evidence beyond mocked helper outcomes.

## Important — must fix

### 1. [P1] Recover expired started leases through backoff and budget exhaustion

**Location:** `integration-service/migrations/009_snapshot_runs_and_recovery.sql:2352`, `:2419`, `:2421`; `integration-service/etl-worker/snapshot-delete-worker.ts:56`.

An expired APPLYING row is immediately eligible for another claim when its saved `d_next_retry_at` permits it. `begin_etl_snapshot_delete_start` resets that field to `-infinity`; there is no expired-start branch that durably records the crashed start and schedules the required database-clock 5/30/120-second fallback. The explicit error path has those delays, but process death cannot execute that path.

More seriously, let a valid fourth start crash before finalization. After its lease expires, claim commits a new token/lease on the same APPLYING row, because claim does not reject or finalize `d_start_count=4`. Begin cannot increment it and returns NULL. The worker then throws `D_CLAIM_LOST` at line 56 **before** its try/catch and retry/finalize handling. Subsequent lease expirations repeat this cycle. D stays APPLYING/source-busy indefinitely, even if the fourth start had already committed every effect before dying.

Handle expired started claims under the existing guard/source/run locks before issuing a replacement claim: preserve a durable crash-fallback state, wait the database-clock delay for starts 1–3, and finalize the exhausted fourth start as FAILED while preserving C COMPLETE and source/schedule state. Claim acquisition without a begun start must remain free. The existing C continuation claim at migration 009:680–703 demonstrates the required distinction; it is absent from D.

The passing D crash test manually sets both lease expiry and `d_next_retry_at` at `snapshot-runs.test.ts:1944`, while the four-start test follows catchable outcome errors. Neither exercises an exhausted crashed start or proves crash-fallback delay. Add focused D lifecycle cases for those paths, including death after all fourth-start effects commit but before finalization.

### 2. [P1] Retain the current Owner subject lock for below-threshold effects

**Location:** `integration-service/migrations/009_snapshot_runs_and_recovery.sql:2523`.

The below-threshold branch returns true before the `FOR UPDATE OF b,s,t` authority locks at line 2532. Its currentness check still depends on the current Owner being enabled: `etl_snapshot_delete_proof_current` reads `auth_subject owner ... AND owner.enabled` at migration 009:1417, without locking that row. The source-registry row lock protects Owner assignment/revision, but does not lock the Owner's auth-subject state.

This allows a supported concurrent Owner disable to commit across the D effect check. `auth/service.ts:245` updates that subject through `auth/repository.ts:29` without taking the security guard or source lock; 001–008 install no auth-subject security-fence trigger. Once the last `record_etl_snapshot_delete_effect` currentness check returns, such a disable can commit before D COMMIT. The canonical helper validates frozen approval facts (`normalization/apply.ts:105`), and does not supply the missing live Owner-enabled lock. Thus D can commit its tombstone after the current Owner has become disabled, although the same currentness predicate would now reject it. A final stale result afterward cannot roll back that committed effect.

Lock and validate the current Owner subject under the established lock order for every effect, including the below-threshold branch, and hold that lock through the aggregate/outcome COMMIT. This does not require a new pause or D approval for below-threshold work. Add a focused two-client race showing that Owner disable either commits first and causes no D effect, or waits until the already-authorized aggregate transaction commits. The supplied epoch case is above threshold and does not cover this early-return path.

## Evidence and named cross-cutting checks

- Used `code-review-and-quality/SKILL.md` and `subagent-driven-development/task-reviewer-prompt.md`. The supplied U10 package was viewed in bounded chunks after an initial combined tool result was truncated. No diff was regenerated. No suite or mutation test was run; the read-only task instruction overrides the general review skill's mutation suggestion.
- **Canonical transaction contract risk:** inspected `normalization/apply.ts` frozen-proof validation and customer/order deletion paths. They accept the same client and leave transaction ownership with the worker, preserve logical order-line deletion, and do not check the current Owner's enabled state. No second D canonical writer or production business DELETE was introduced by this diff.
- **Expired-start lifecycle risk:** compared only the existing C claim's expiration/backoff/exhaustion branch (migration 009:660–720) with the D additions. This establishes the failure in finding 1 without rerunning an already-evidenced suite.
- **Live authority serialization risk:** inspected only auth-subject/binding schema and locking contracts in migrations 002/004/006, `auth/service.ts:227–289`, and `auth/repository.ts:6–39`. Supported subject updates are not serialized by D's global guard/source lock; the below-threshold D path supplies no subject lock.
- **Shared currentness/serializer risk:** inspected the unchanged D2 baseline seed/member serializers, baseline fingerprint, candidate-current predicate, proof-current predicate, source lock, and the API-060 wrapper entry locks. This checked the owning contracts replaced or called by D3, rather than reopening D1/D2 as a whole.
- **Captured-source binding:** independently read actual committed blob bytes with `git cat-file` and compared all five explicit product paths against before/after captures for final build `4699ecb8...`, snapshot `349a4cfe...`, and schema `0805cee9...`: **30 path/capture records, five checks each, zero mismatches**. Checks covered actual HEAD, Git blob identity, committed LF byte SHA-256, actual raw source byte SHA-256, and raw size. This was a read-only object check, not an index/HEAD operation. Frozen migration 001–008 bytes also match the base commit exactly (8/8).
- Final captured stdout shows unfiltered snapshot **26/26** and schema **1/1** passing. Final gate stderr is empty; the retained diagnostic failures are explicitly distinguished in the corrected report. Build dist metadata and both D child import records agree on worker SHA-256 `cb8ff507fb5361c0d57e559b41f6fed6141bd2dea0d75357e0d632c8c792ff70`.
- Read the final D lifecycle capture: before-COMMIT child PID 45180 reports zero committed effects and resumes to two; after-COMMIT PID 41260 reports one, renews heartbeat beyond its initial lease, and resumes to three. The false-outcome capture records four starts, failure-relative delays, stable operation identity, and unchanged order/line/receipt/outbox facts on each rejected transaction. These prove the executed branches, not the missing crash-exhaustion or below-threshold revocation branches.
- Read the four exact-owned final PostgreSQL lifecycle records: each records its pinned digest, ownership-confirmed removal, and absence. Read the Node lifecycle records and later exact-PID absence capture for 45180/41260/44388/18568 at `2026-10-28T04:06:49.3806219Z`. The later observation is correctly qualified; it is not an exit-time absence claim. No resource was created, signaled, or cleaned during review.
- Root separately checked the 64-entry artifact manifest and report equality. This review verified source-byte binding and substantive captured assertions, not a duplicate full manifest-metadata audit. The corrected report accurately says operation IDs are allocated at claim, describes formal **48 cases**, and identifies the full schema-contract path.

## Assurance limits

No pre-implementation RED exists; the corrected report says so. The supplied D evidence does not execute a live old-token D holder after replacement, the fourth-start process-death path, or the below-threshold Owner-disable race. The existing C stale-claim test is not evidence for D's separate routines. No formal 48-case/site, Hermes, production, E, whole-M1, or whole-phase result is claimed. No secret/config files, blocked host artifacts, broad temporary directories, or unrelated task evidence were read. Only this review report was written; product files, index, HEAD and branch state were not mutated.

**Assessment:** D3 has useful atomic effect/replay evidence, but the two lifecycle/authority defects prevent acceptance. Spec FAIL; task quality Needs fixes.
