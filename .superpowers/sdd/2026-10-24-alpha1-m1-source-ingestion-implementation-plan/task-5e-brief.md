# M1-5E — Manual recovery and channel cutover

> For agentic workers: execute sequentially with superpowers:subagent-driven-development. Latest user model override: all subsequently dispatched implementation, preflight, repair and independent-review subagents use GPT-6.1 Terra with Medium reasoning. Product inspection remains delegated. The already-running E1a2-1 Luna implementation may finish its current slice; historical Luna/Sol attributions remain unchanged.

**Status:** E1a1 locally accepted after two repair rounds: product55bc0ea, evidence023dde5, final independent Spec PASS / Quality Approved. E1a2-1 is next. User authorized the whole E phase on 2026-10-28. Continue authorized local work without an additional plan-approval pause.

**Goal:** Provide explicit auditable manual recovery of preserved ingestion/snapshot facts and a controlled primary-channel cutover with immutable reconciliation evidence.

**Spec:** `E:/git/dgo-hub/docs/数据治理与本体集成中台_产品架构与二开说明_v1.0.md` §§8.6,9.2–9.4/API-022–024; public M1 plan M1-5 and frozen rules; SDD `task-5-brief.md`. `context/m1-task5e-approval-bootstrap.md` is an early proposal and must be reconciled against the accepted source before implementation.

**Accepted entry:** D closure `3f1661d293cc76feb4dce07dc3d091dfd2bb8154`, product `0112c661c4a543d614ba8685693a8384b8dc7201`. D1/D2/D3 independently accepted. E does not reopen those slices or assert whole-M1 completion.

## Global constraints

- Preserve the existing seven top-level modules, sole AuthService/credential registry, migration runner, strict envelopes and management scope vocabulary. No additional user-facing route without an explicit controller contract ruling.
- Migrations 001–008 are frozen. 009 remains unreleased and phase-owned; add only the slice's justified schema/functions/grants. Validate populated upgrade and identical final009 reapply where it changes.
- API-022 requires source:write. API-023 requires source:read and the exact current same-tenant Owner. API-024 requires that Owner plus source:approve. Source credentials cannot call management APIs. Idempotency for mutation endpoints is tenant/source/route scoped and still rechecks current authority before replay.
- Preserve original raw/event/run/stage/outcome/proof facts. Manual recovery creates an immutable operation/attempt link, never resets a terminal original row, modifies a source version, silently selects a new target, clears barriers or uses current mappings as the original frozen proof.
- Remap recovery requires explicit current Owner confirmation and an approved exact mapping revision tied to original fact/full-qualified identity/canonical UUID. Ambiguity, revoked authority, matching barriers and retired epochs fail closed.
- Pending config, endpoint, credential and complete per-entity channel set are separate from current proof. Pause old admission before reconciliation; old durable work drains or is durably isolated. Pending staging does not apply canonical data or infer absence.
- Pending ingress bearer and upstream connector secret are distinct. E2a must reserve a new source-bearer digest without replacing the current digest; E3 promotes that exact reservation atomically with the channel/config set. A generation/epoch increment alone does not invalidate a freshly presented old bearer. Keep the global digest registry immutable/non-reusable, including abandoned reservations. The preferred preparation contract resolves an allowlisted external secret reference already shared with the intended producer, stores only the digest/reservation, and never returns bearer plaintext through a management API. Concrete resolver binding is finalized at the accepted E2a entry pin; local fixtures do not imply a production secret provider is configured.
- Final reconciliation approval binds its validated stage/digest, exact pending config/test/mappings/credential/channel set, current enabled Owner/revision and security facts. Cutover alone atomically retires old channels, advances epochs and publishes new current config/credential state. Failure before commit preserves the old current lane.
- Canonical UUID continuity is established by approved identity mapping only. SOURCE_VERSION and SNAPSHOT_OBSERVATION are distinct domains; a retired epoch is rejected before comparing versions. No source-system writes, physical business deletes, second canonical writer, or source/network I/O inside Hub transaction.
- Reuse the established barrier-first lock order and caller-owned PoolClient transactions. All claimed mutations require supplied/stored non-NULL exact tokens and a live non-NULL lease. Hold current authority locks through commit; test old-token/NULL/revocation cases rather than relying on success paths.
- Four durable starts, DB-clock failure-relative 5/30/120 delays where retry applies; claims without starts do not consume attempts. Recovery after lost upstream MVCC connection starts a fresh full scan; only a complete validated immutable stage can resume destination apply.
- One product writer. Fresh external UUID M0_RUN_EVIDENCE_ROOT per gate; exact command/stdout/stderr/exit/actualHEAD and immediate before/after source raw/LF/hash/size/blob captures. Build before Node child tests; bind loaded dist bytes to that build. Separate source and evidence/report commits.
- Evidence copies use explicit unique destinations and verify both original-source and destination hashes. Preserve historical errors with qualifications. Exact owned PG/Node lifecycle and later absence observations must refer to IDs actually extracted from that run's logs.
- Never access/delete/move/copy the targets in SDD context/policy-blocked-host-artifacts.md or its M0 reference. Preserve unrelated/incomplete artifacts. No secrets/.env/npmrc/Config.Env/reference-clone reads or blanket staging/cleanup.
- No M1-6/7, real cutover, push, merge, deployment, live IdP/CRM/order/Hermes claim. Formal 48-case/site acceptance remains NOT_RUN. M1-5 integrated gate and whole-phase review remain separate required work after local E slices.

## Review focus

1. An idempotent manual retry replay after authority or mapping drift must not create new recovery authority.
2. A mapping correction must not reinterpret a different original object or move its canonical identity silently.
3. Complete pending-stage approval must not depend on first making that channel active, and cannot mutate current credentials early.
4. Concurrent old worker completion, current Owner disable, new source admission and cutover must serialize; no split current channel/config/credential state.
5. A crash at any transition keeps immutable proof and exactly one durable effect; a lost scan cannot masquerade as complete reconciliation.

## Execution sequence

- [ ] Refresh exact E interfaces at the accepted entry pin; controller resolves load-bearing choices in the ledger.
- [ ] Publish thin E slice briefs with exact source seams and acceptance tests before product dispatch.
- [ ] Implement each slice with genuine defect/feature RED, GREEN, source/evidence binding, and independent Spec/Quality review before dependent coding, using the latest user model override above.
- [ ] Reconcile final009 populated upgrade/reapply and E integration evidence; update public status with precise local and unexecuted limits.

Exact slice boundaries and signatures are finalized from `context/m1-task5e-interface-preflight.md` before dispatch; this master is not permission to implement speculative tables or APIs.

## Controller-selected slice sequence (2026-10-28)

- [x] **E1a1:** API-022 immutable linked snapshot retry, fresh scan vs sealed-stage recovery, lineage-safe D counting. Product55bc0ea; evidence023dde5; task-5e1a1-rereview-2.md Spec PASS / Quality Approved. Formal/integrated limits remain.
- [x] **E1a2-1:** API-023 safe unified quarantine identity/index and listing, including immutable REST and snapshot origins, exact current Owner scope, payload exclusion and bounded stable paging. Refresh source seams at the accepted E1a1 pin before the detailed dispatch.
- [x] **E1a2-2:** API-024 same-target REST recovery through a real linked child job/outbox and existing canonical worker. Preserve the original frozen field-mapping and identity-mapping proof separately. The public mapping_revision retains its field-mapping meaning. Snapshot origins return a documented scope-unavailable conflict in this intermediate slice.
- [ ] **E1a3:** API-024 targeted snapshot aggregate recovery with a C-compatible linked operation and frozen provenance. Do not silently expand a single aggregate into a whole-run API-022 retry or derive source:write authority from Owner source:approve. This slice is required before whole-E completion.
- [ ] **E1b:** Explicit current-Owner remap confirmation bound to original fact, exact target UUID and approved mapping revision/digest, with identity fencing. No implicit retarget in ordinary retry.
- [ ] **E2a:** Separate pending source/config/credential/channel proof, targeted capability test and config preapproval; preserve current lane.
- [ ] **E2b:** Full pending-stage-only snapshot validation and immutable digest, zero canonical/delete/observation effects before cutover.
- [ ] **E3:** Exact current-Owner final reconciliation approval and atomic channel/config/credential cutover with old-job isolation and post-cutover continuation.

Each dependent slice starts only after its predecessor's independent Spec/Quality acceptance. These are thin implementation gates inside the already authorized E phase, not new user approval steps. Whole M1-5 integration and whole-phase review remain separate after E; E approval alone cannot assert formal/site acceptance.
