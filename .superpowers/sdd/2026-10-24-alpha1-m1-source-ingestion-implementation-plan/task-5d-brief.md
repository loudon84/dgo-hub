# M1-5D: absence reconciliation and delete approval

**Status:** Refreshed provisional implementation brief; planning only. D follows the reviewed A–C slices. This brief must be refreshed against the final immutable C source pin before D1 implementation. Migration 009 remains owned by the complete M1-5 phase; migrations 001–008 remain byte-frozen.

## Goal and boundary

Consume successful C `COMPLETE` snapshots exactly once to maintain full-key absence facts, freeze immutable candidate sets, pause safely above the exact 5% threshold, expose safe review through API-021, record exact-owner API-060 approvals, and later apply approved logical tombstones through C's caller-owned aggregate transaction seam.

C `COMPLETE` means its full frozen entity set was extracted, validated, and all present/explicit-tombstone aggregates were applied. It does not mean D reconciliation is complete. D stores a separate status: `PENDING`, `AWAITING_OWNER`, `APPLYING`, `COMPLETE`, `FAILED`, `STALE`, or a safe no-op `SKIPPED` result. No synthetic C run status is introduced.

D is split into reviewed sequential gates:

1. **D1 — durable consumption, streaks, candidate freeze, threshold pause.** No tombstones, API-060, or API-021 candidate-member route.
2. **D2 — API-021 safe review and API-060 approval.** No canonical business DML or candidate application.
3. **D3 — fenced logical apply and recovery.** Uses the D1/D2 immutable facts and the existing C aggregate helper transaction.

Each gate has one writer, followed by independent Sol Spec/Quality review. The next gate starts only after the prior review accepts it. The exact source map, migration baseline, and procedure interfaces are refreshed from the selected immutable pin at each dispatch; do not silently infer new authority.

## Frozen D semantics

- Count distinct successful C `COMPLETE` run IDs only. A failed, stale, partial, invalid, interrupted, or otherwise ineligible run neither increments nor resets a streak. A complete run with a changed frozen config/field mapping/identity mapping/profile/channel/domain/entity/delete-contract proof starts a new scope streak at 1. Preserve old-scope facts for diagnosis; never mix them into the new streak.
- Scope facts by tenant, source, entity, and the full source identity key. Presence in an eligible successful complete run resets that key's streak. Exclude entities outside that run's frozen enabled-entity set. Candidate after two consecutive distinct complete runs omit the key.
- Reconcile completed runs chronologically and consume each once. A backlog must not let an older absence act over newer presence. Process each run's own immutable manifest/facts in order; only freeze/action the latest current cohort after newer pending run presence facts have been processed. If a newer C run is active, D effects wait. If current proof, owner, candidate, or membership drifts, mark the candidate `STALE` and require a new current candidate/approval.
- C finish must reserve D work in the same successful transaction that marks C `COMPLETE` and clears C's active schedule slot, for an absence-enabled `SNAPSHOT_OBSERVATION` contract. This closes the gap where API-019 could admit another C run between C completion and a later D claim. D1 adds the minimum C-finish reservation and due/admission guard. A source without an eligible absence contract records a safe `SKIPPED`/complete summary; it never fabricates a `SOURCE_VERSION` deletion version.
- D states `PENDING`, `AWAITING_OWNER`, and `APPLYING` are source-busy states. They block new API-019 admission and due-schedule admission. Existing activation while D approval/action is unresolved returns 409. C work already admitted under the original frozen proof drains under that proof; D candidate effects wait until no C run is active. D terminal `FAILED`, `STALE`, `COMPLETE`, or `SKIPPED` releases the busy marker, preserves the source pause, and cannot enable a schedule.
- At each C-success boundary, preserve the immutable candidate baseline count. Before each apply, expected live count is `baseline_count - this_candidate_successful_tombstones`. Recheck candidate membership and all other denominator-affecting changes. D's own already-committed tombstones do not stale the remaining same candidate; any unrelated count or membership drift makes it `STALE` before another effect.
- Freeze all scoped entity candidate sets before action. Use exact integer comparison `candidate_count * 100 > active_count * 5`. If any required set is over 5%, pause the whole source before any candidate action and block all candidate actions until every above-threshold set has its own current exact-set approval. Keep the source paused after approval and action. Existing explicit activation is required to resume.
- For absence deletion, the deletion timestamp is the DB `completed_at` of the second successful complete snapshot that established the streak. It is an inferred observed time, not a source event timestamp and never worker wall-clock time. Under `SNAPSHOT_OBSERVATION`, the D tombstone version must be an already approved/bound observation strictly greater than the key's last presence receipt. Never increment an old value or synthesize an observation. Bind the immutable candidate to origin run(s), the second-run observation and its time basis. Explicit source tombstones remain C-owned and use their real declared source version/timestamp.
- Preserve the latest-observation high-water rule from C: reuse only the current allocation high-water value when its latest successful COMPLETE binding matches semantic digest and stable proof scope. A matching older observation behind a later allocation is not reusable. The second successful snapshot may reuse its C observation only if that observation is greater than last presence.
- Keep logical tombstones only. Preserve canonical UUID, identity, source-version receipts, history, and required outbox/effect records. Physical core-row deletion is forbidden.

## Candidate set, denominator, digest

Maintain immutable revisions per `(tenant, source, entity)`. The revision binds at least: source/run identity; complete run(s) that established the streak; full sorted source keys; frozen config, field, identity, endpoint/profile, channel/domain, entity and delete-contract proof; observation/version basis; exact baseline active count; numerator; candidate digest; and current status. Revisions advance whenever a bound membership/proof/count/approval-relevant fact changes; old facts remain immutable.

The denominator is the number of current live active canonical objects in the exact tenant/source/entity scope, counted under the existing global/source guard and serialization fence. Candidate keys are exact full source identities, never display names or partial identifiers. Compute and freeze every enabled entity's set and threshold decision before action. Empty denominator with zero candidates yields no action. Any unexpected denominator or key-membership change is `STALE` before further action.

Digest is recomputed server-side from canonical serialization and includes all proof above, sorted full identity keys, immutable run binding, candidate revision, observation/version basis, baseline denominator and count. API caller-supplied digest is a comparison value, never evidence.

## D2 API contract

No new candidate-list route. Extend API-021 ordinary run summary with safe D status/counts/candidate IDs/revisions/digests/denominator and approval state, without member keys. Ordinary API-021 retains normal `source:read` behavior. Exact-set page uses only explicit `include=delete_candidates`; it requires `source:approve`, current principal, and the exact currently enabled source Owner bound to the same tenant/source at operation time. It exposes only source-qualified full identity keys; no business names, raw payloads, credentials, or unrelated rows. Use strict query validation, default page size 20/max 100, stable C-collation-safe cursor, and safe audit evidence. API-014 remains the only identity-mapping confirmation/write route.

API-060 remains exactly `POST /hub/v1/admin/sources/{id}/delete-candidates/{candidate_id}/approve`, with the existing scoped `Idempotency-Key`; required JSON fields are exactly `run_id`, `candidate_revision`, `candidate_digest`, `expected_owner_revision`, `reason`. Require `source:approve`, exact current enabled Owner, and recheck current proof/candidate/digest/denominator/source pause at approval and immediately before effect. Stale candidate/Owner returns 409 with no approval. Same idempotency key/request replays its durable original result; same key/different request conflicts. API records approval/audit/idempotency only and performs no canonical DML.

## Storage, grants, and worker boundaries

Extend only phase-owned 009 from the final reviewed 009. Add only required D tables/columns/indexes/FKs and fixed-search-path, worker-only security-definer procedures/views for once-only run consumption, streak facts, immutable candidate revisions/members, separate reconciliation status, approvals/idempotency evidence, source-busy reservation, and resumable apply outcomes. API reads only safe summary/member projections under authorized modes. API-060 can write approval/audit/idempotency evidence only. `hub_worker` alone can consume/update D state and invoke guarded canonical apply. Do not grant broad canonical identity/business-table access to API roles or add a parallel queue.

The existing strict lifecycle/global barrier/source guard serializes claims and effects. No source IO is in a Hub transaction. Recheck original C frozen proof, exact global/source guard, current security barriers, current Owner where required, candidate revision/digest and typed source/channel barriers before every effect. D claims require no active C work; new C admission sees the D busy reservation. Reuse C's aggregate apply helper in a caller-owned transaction, with outcome, D apply state, and effect evidence atomically committed. Recovery resumes the same immutable candidate and operation, not a recalculated set represented as already approved.

### Verified source pin and refresh before later slices

The corrected immutable C source pin `1546dcfb33fed12e3d474c5e96b4a0c8761a965b` was available and all code observations in `context/m1-task5d-interface-preflight.md` use only `git show` at that pin. Before D1 implementation, refresh exact function signatures, lock ordering and grant/procedure details from the builder's selected pin. Before D2 and D3, refresh affected interfaces again after the preceding accepted slice. Do not use mutable checkout source for these source maps or silently carry a stale interface forward.

## Slice acceptance boundaries

### D1

Test complete-only eligibility, idempotent once-only consumption, chronological backlog and newer-presence precedence, scope-change streak restart, presence reset, frozen enabled-entity exclusion, duplicate/interrupted/failure behavior, observation high-water eligibility, exact denominator, 0%/exactly 5%/>5% boundaries, whole-source pause, all-scope prefreeze, busy reservation/admission/activation conflicts, and C/D serialization. Assert D1 never creates logical tombstones, API-060 approvals, or exact candidate member responses. Include source without absence contract and source-version no-fabrication cases.

### D2

Test ordinary API-021 safe summary, exact Owner + `source:approve` exact-set page, unauthorized/stale tenant/source/Owner denial, strict params/cursor, page 20/100, hidden members in default read, API-060 malformed/unknown fields, exact idempotency replay/conflict, stale revision/digest/denominator/Owner 409, and durable approval/audit with zero canonical DML.

### D3

Test source stays paused through approval/action; per-effect frozen proof/typed barriers/current Owner; expected count baseline less own successes; unrelated denominator/membership drift stales before next effect; newer presence/current run/backlog races; safe inferred timestamp and already-bound greater observation; logical tombstone preserves UUID/history/receipt/outbox; crash before/after aggregate commit, repeated processing, stale worker fencing; D status does not rewrite C `COMPLETE`; terminal D releases busy marker without unpausing or enabling schedule.

## Migration and evidence gates

Migrations 001–008 are frozen. 009 is unreleased and phase-owned; validate only the fully assembled phase version against a populated 001–008 database, then reapply that identical 009. Never apply a changed 009 over an old checksum ledger as an upgrade test. Each future acceptance command uses a fresh UUID runtime under absolute `M0_RUN_EVIDENCE_ROOT`, captures actual HEAD and dirty/blob-bound source before and after, explicit whitelist, and owned PostgreSQL/Node child resources with cleanup. No live CRM/Hermes/SQL Server, production, deployment, UI, query-gate, or real source writes are in scope. Formal 48 gates remain `NOT_RUN` absent evidence.

## Planning artifacts

- D preflight: `context/m1-task5d-interface-preflight.md`
- D1: `task-5d1-brief.md`
- D2: `task-5d2-brief.md`
- D3: `task-5d3-brief.md`
- Public M1 plan: `docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md`
