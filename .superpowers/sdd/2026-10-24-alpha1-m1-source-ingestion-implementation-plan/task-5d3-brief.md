# M1-5D3 — fenced logical apply and recovery

**Status:** Ready for controller dispatch from independently accepted D2 product `23cac1b6a3f00b595ecff085dc59f14dd771bc73` (Spec PASS / Quality Approved, task-5d2-rereview-1.md). Fixed-pin seams and shared serializers are refreshed in context/m1-task5d3-apply-preflight.md. One writer, then independent Sol Spec/Quality review. This slice applies only the immutable, current D1 candidate revisions with D2 approval where required.

## Goal and effect boundary

Apply below-threshold candidates under the approved hard-delete contract, and above-threshold candidates only after every required scoped set has current exact approval. Write only logical tombstones through the existing canonical helper transaction and preserve C snapshot truth. Keep the source paused and its schedule disabled until explicit existing activation after all D work is terminal.

## Before every candidate effect

In the same caller-owned Hub transaction as the aggregate effect, acquire the existing global security-barrier guard first and exact source serialization fence next. Verify:

- exact tenant/source, current D claim token/lease, candidate and operation identity;
- original C run/attempt/manifest and immutable frozen config, field mapping, identity mapping, endpoint/profile, channel/domain, entity/delete-contract, approval, and typed security barrier proof;
- the latest fully processed C cohort and no newer presence fact/active C run that could supersede this absence;
- current Owner identity/revision and enabled tenant/subject for each required approval;
- immutable full candidate membership and server-recomputed digest/revision;
- all above-threshold set approvals are current before the first effect;
- immutable baseline denominator and expected current count `baseline_count - this candidate's successful tombstones`; current exact live membership remains unchanged except for those own committed effects;
- the second successful complete run's bound approved observation is strictly greater than last presence receipt and its DB `completed_at` is bound as inferred absence time.

Any unrelated denominator or membership delta, proof/Owner drift, typed barrier, newer C presence/cohort or invalid approval marks the candidate `STALE` before another effect. Never silently reuse approval against changed facts. D's own successful tombstones do not invalidate remaining members in the same immutable candidate.

## Logical tombstone contract

Use `applyCustomer(client, context, input)` or `applyOrderAggregate(client, context, input)` from `integration-service/normalization/apply.ts` with the caller's client. One aggregate per transaction; for orders preserve the helper's complete order/line aggregate semantics. The existing helper performs guard-first frozen-proof validation and writes canonical state, identity, receipt, and outbox atomically. In that same transaction write the idempotent D effect outcome/state. Do not add a second canonical writer or outbox insert.

Use only the already-bound `SNAPSHOT_OBSERVATION` value supplied by the reviewed C proof and candidate binding, greater than the key's last presence observation. The tombstone timestamp is DB `completed_at` of the second successful complete run. It represents inferred observation time, not a source event timestamp. Never use worker wall-clock for this field, increment a previous version, or allocate a D-only synthetic sequence. Do not alter explicit source tombstones, which remain C-owned with declared source version/timestamp.

Preserve canonical UUID, identity tuple, receipts, history, and required effect/outbox records. Physical deletes are forbidden. A successful D action cannot change C `COMPLETE`, counts, or outcome; D failure/pending/completion is exposed only in reconciliation state.

## Recovery and serialization

Persist claim, lease, attempt/start count, next retry, operation and terminal facts durably, using the existing strict worker lifecycle/fence and bounded retry policy where the refreshed source supports it. Recover the exact immutable candidate/operation and skip only a matching committed D effect receipt. A pre-commit crash leaves no canonical state, receipt, outbox or D success; post-commit crash leaves all facts together and resume observes them once. Stale claim holders cannot commit or finalize. No source query or network I/O occurs inside Hub transaction.

D remains source-busy while `PENDING`, `AWAITING_OWNER`, or `APPLYING`. Existing C work admitted earlier may drain under original proof, while D waits. New API-019 and due admission remain blocked. Terminal `FAILED`, `STALE`, `COMPLETE`, or `SKIPPED` releases only D's busy marker; no finalizer unpauses source, reenables schedule, clears unrelated state, or rewrites C result.

## Acceptance evidence

- Below-threshold auto-action is allowed only under exact approved absence contract; above-threshold action is blocked until every scoped set approval is current.
- Stays paused after API-060 approval and throughout D apply; explicit activation is the only resume path and conflicts while D unresolved.
- Frozen proof, owner, barriers, candidate membership/digest, newer C presence/cohort, and exact source/tenant identity are rechecked before every effect.
- `baseline_count - own successful tombstones` rule permits later members of the same set; unrelated object/member delta stales before further effects.
- Exact observed timestamp and already-bound OBS greater than last presence are used; no source event-time fiction or fabricated version.
- Crash before and after aggregate commit, repeat invocation, lease expiry/token fencing, partial multi-member resume, owner/source/barrier races, and newer C run/presence races preserve one logical effect per approved key.
- Canonical UUID, identity, history, receipts and append-only outbox are preserved; no physical `DELETE`; C status remains `COMPLETE` if D action fails.
- Terminal D states release reservation while preserving source pause and disabled schedule. No source network inside Hub transaction.
- Final assembled 009 validated on populated 001–008 followed by reapplying that identical final 009. 001–008 blobs remain unchanged.

Use fresh UUID-isolated roots under absolute `M0_RUN_EVIDENCE_ROOT`, capture exact command/stdout/stderr/exit, actual HEAD, explicit-whitelist before/after dirty/blob source manifests, and clean only owned database/Node child resources. Test evidence is local-only. Formal 48 gates remain `NOT_RUN` unless performed.

## Review handoff

Provide exact accepted source pin, source and migration diff, fresh evidence, crash/recovery matrix, grants, unresolved races and assurance limits to independent Sol review. Whole M1-5 schema, populated upgrade, integrated local oracle, and whole-phase review remain required after D3. Do not claim production/site/source or formal gate completion.

## Pin-checked delete input notes

At the reviewed C pin, both existing strict delete schemas accept exactly `{source_pk, source_version, deleted_at}`; pass the already-bound observation as decimal `source_version` and the second complete run's exact DB `completed_at` as offset RFC3339 `deleted_at`. The digest excludes `source_version` but includes `source_pk` and `deleted_at`; persist/read the exact run time losslessly as RFC3339 text with microseconds because a JavaScript `Date` can truncate PostgreSQL `timestamptz` precision. Order deletion applies the same logical-delete time to live lines, advances their hub revisions, and writes one order-level receipt/outbox operation. See `context/m1-task5d3-delete-semantics.md`.

D cannot reuse C `loadProof`, C claim assertions, or `record_etl_snapshot_aggregate` after C `COMPLETE`: C finish clears its claim and the C loader is restricted to live continuation states. D needs a D-fenced loader that verifies the completed immutable C run/seal/manifest/observation and reconstructs the same `ApplyContext` from frozen proof; the canonical helper itself can still enforce the C-derived frozen proof and typed barriers. Recheck current Owner separately, because the helper validates frozen Owner approval but does not enforce current Owner revision. Preserve helper replay rules and record D effect idempotency in the same aggregate transaction.

## Controller clarification before D2 pin refresh

Source-state preservation distinguishes threshold policy: an above-threshold cohort must already be PAUSED with scheduling disabled, and remains so through approval, effects and finalization until explicit existing activation. A below-threshold cohort is eligible for automatic action under the approved absence contract; do not introduce a new pause requirement solely for that case. Preserve its current source/schedule state and use the D reservation to block new admission until terminal. No D finalizer activates a source or enables a schedule. Any independently paused/disabled state remains unchanged.

D2 adds freeze-time baseline_membership_digest bound into candidate_digest. At D3 refresh verify the exact shared serializer and reconstruct the original baseline from current live full-qualified tuples plus this exact candidate's own durably committed tombstone members, then compare the original fingerprint as well as baseline_count minus own successful tombstones. Unrelated equal-count substitution must stale. Stored approval binds actual issuer/subject/tenant/user and DB auth_epoch; any later epoch change invalidates authority along with enabled/binding/Owner/scope/barrier changes. Do not depend on token TTL or persist tokens.

## Execution details to finalize after accepted D2 pin

Use a durable D run/cohort claim with an initial start plus at most three automatic retries (four durable starts total), DB-clock failure-relative 5/30/120-second delays, and crash-start fallback consistent with the existing strict worker lifecycle. Claim acquisition/inspection alone does not count as a start. Persist operation identity per member once; recovery must not invent a new OBS, timestamp or operation. Processing a multi-member cohort in one live started lease does not consume a new start per member. Maintain heartbeat for long work and await in-flight heartbeat errors before finalization; lost/expired claimant cannot apply, record success, retry or finalize.

Before every aggregate, take the barrier/source locks and hold claim/row locks through currentness, canonical helper call and D outcome record. Lock the current identity/tenant/subject authority rows used for approval verification so a concurrent revoke/rebind/epoch/scope/Owner change cannot commit across the effect check. Preserve existing lock order. A rejected false/empty outcome-write result must throw inside the same transaction, rolling back canonical writes. Do not copy the old C defect of committing helper side effects before rejecting a missing receipt. For an unrecorded member, any helper DUPLICATE/IGNORED_STALE/quarantine or changed identity/version is a safe stale/failure rather than fabricated D success; only an exact matching prior committed D outcome is a resumable success.

Required local oracle includes real owned Node process termination before aggregate COMMIT and after COMMIT with actual changed tombstone effects, not only duplicates or PostgreSQL-backend termination. Verify canonical object/UUID, logical order-line state where applicable, identity/receipt, append-only outbox, D effect record and progress all absent together before commit or present together after; restart applies/observes once with exact same OBS/microsecond inferred timestamp/operation. Include multi-member partial resume, baseline reconstruction after own effects, unrelated equal-count replacement, identity epoch/Owner/barrier/newer-cohort invalidation and stale claim fencing. Assert no source connector is invoked for D recovery and no physical business DELETE occurs. Clearly label unexecuted crossproducts and formal/site cases.

Create exact `context/m1-task5d3-schema-contract.md` before product edits from the accepted pin, then implement the slice as one writer. Final report paths are `.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/task-5d3-report.md` and `docs/execution/alpha1/m1-task-5d3-report.md`, identical. Use true immediate source-before/after manifests per fresh external UUID gate with matching absolute M0_RUN_EVIDENCE_ROOT, actual HEAD, captured command/stdout/stderr/exit and raw/LF size/hash/blob bindings to committed product. Explicit whitelist safe repo evidence copies and manifest, exact-owned PG/Node cleanup records, no secret/config/blocked paths, separate product/evidence commits. No E implementation, push, merge or deployment. Independent Sol review is mandatory; D as a whole remains open until D3 closes.
