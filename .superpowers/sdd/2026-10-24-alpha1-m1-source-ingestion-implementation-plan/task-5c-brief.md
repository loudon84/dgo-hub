# M1-5C provisional implementation brief — full validation, observations, and canonical apply

**Status:** Provisional C-only plan. Canonical/apply source basis is exact commit `8283a39cde0cda9468cdbb5d77862f45b973f240`; B interface facts are read only from committed pin `8d9f1dca3bda9c0a58a410168005a39183206561`, plus B planning contract `task-5b-brief.md`. No mutable B checkout was read. No product code, tests, database, source, network, credentials, or Git state were changed. B is committed and independent Sol review is active; root must select the final reviewed BASE and explicitly dispatch C. Migrations 001–008 remain frozen. Migration 009 remains owned by the full M1-5 phase; any C additions require an explicit additive diff and review of A/B guarantees and recovery.

## C outcome and boundary

C consumes only a complete immutable B `EXTRACTED` manifest and its attempt-scoped pages. It validates the entire snapshot before allocating an observation or making canonical changes. It then applies deterministic customer and order aggregates, with one aggregate per atomic apply range. C adds no route or authority scope; it adds only the explicitly selected read-only `mode=source_customers` to the existing API-013 identity-mappings route. API-019/020/021 remain the admitted-run and safe status/read surface. API-022 through API-024 and API-060 remain later phase work; C does not implement delete candidates or approvals.

A successful run means all required relations were extracted, all whole-snapshot and cross-reference checks passed, and every terminal aggregate outcome completed successfully. A quarantined row, unresolved identity, failed/raced apply, incomplete stage, or lost source transaction prevents run success. Such a run cannot advance last-successful-snapshot or any absence streak, even if earlier aggregate ranges committed. Keep successful/applied counts limited to actual `APPLIED` results.

## Exact source seams and existing apply behavior

At the reviewed source pin:

- `integration-service/normalization/store.ts` re-exports `applyCustomer`, `applyOrderAggregate`, `ApplyContext`, and `ApplyResult` from `normalization/apply.ts`.
- Both apply helpers take a caller-owned `PoolClient`; neither owns the transaction. C must wrap the helper and its durable apply outcome, range receipt, and checkpoint in the same short Hub transaction.
- `ApplyContext` binds the admitted tenant/source, credential and source epochs, entity/channel/version domain, frozen config/mapping/identity proof and digests, endpoint profile/test evidence, Owner proof, and original admission security fence. `verifyFrozenApplyContext` is guard-first and checks the current typed security barriers. Preserve that proof and recheck it at every effect boundary. Ordinary pause or config drift alone does not erase already accepted run proof.
- `applyCustomer` can allocate a live canonical UUID for a new source identity. `applyOrderAggregate` requires a live canonical customer UUID selected by the exact frozen customer identity mapping. API-014 updates that mapping only after its target resolves to a live canonical customer. This creates a real first-load dependency; C must not invent a reservation or dynamic identity authority.
- `sourceContentDigest` already normalizes canonical business facts. Observation versioning is separate from `SOURCE_VERSION`; preserve either domain's exact 20-digit decimal text and never convert it through JavaScript `Number`. Existing apply logic updates a receipt on unchanged observation content without emitting another canonical outbox event. Keep and test that behavior.
- Existing canonical helper calls write the canonical object, source identity/receipt, and outbox within the caller transaction. Preserve helper behavior and ensure the range outcome/checkpoint commits atomically with those writes.

## Owner-approved identity onboarding and order references

Use the root-approved two-pass path for a first load containing new customers and orders:

1. Approve and run a complete customer-only snapshot through apply.
2. Owner uses existing API-014 to map each order customer external key to the corresponding live canonical customer UUID.
3. Owner adds the order entity under the same approved connector, mode, and domain; provides the reviewed complete header/line profile and mappings; retests, approves, and activates that configuration.
4. The next combined customer-and-order run stages and validates the whole snapshot before it applies any aggregate.

Do not auto-create UUID reservations, silently extend identity mappings, or infer a target by matching display data. If any order customer's identity has no approved live target, fail whole C validation before observation allocation, checkpoint advancement, or business apply. The operator then completes Owner onboarding and starts a new approved full run. State this operational constraint explicitly.

For B's approved PostgreSQL contract, `order.customer_source_id` is optional, 1–256 characters, and included in the frozen profile/digest. It is required for order-only extraction; if customer extraction is enabled and the field is absent, the customer source is the same source. C must follow that definition:

- Same-source reference: the external customer key must occur in the complete staged customer PK set, and the exact frozen Owner mapping must target the live canonical source-identity tuple's UUID.
- Explicit other-source reference: accept only when the full source identity tuple is live in the same tenant and the exact frozen Owner mapping names its UUID. Never infer cross-source mapping.
- Validate each referenced UUID against the canonical source identity, tenant, and live target within the guarded apply transaction. A deleted, missing, ambiguous, or changed target fails before that order applies.

Do not add C-only source fields unless the reviewed B profile is shown to lack a required time coordinate. Use declared source update/delete timestamps for explicit source tombstones. Absence from a full snapshot is not a tombstone; D owns absence candidates.

## Whole-snapshot validation and observation reuse

Add a C validation boundary after B's complete manifest and before any effects. It must verify the immutable manifest/page digests, expected entity/relation coverage, frozen proof digests, unique full source keys, valid canonical payloads and exact numeric/timestamp strings, complete order header/line relations, and customer references. Validate every entity and cross-reference for the entire snapshot before writing an observation, apply checkpoint, or canonical object. A partially staged or incomplete attempt remains diagnostic only.

Bind a normalized semantic snapshot digest to all enabled entity business facts and explicit delete facts, including full source keys and line facts. Use the existing canonical content normalization (including exact decimals, normalized timestamps, and deterministic UTF-8 line ordering). Exclude run/attempt IDs, pages, cursors, PostgreSQL snapshot text, and allocated observation values.

Reuse an earlier observation only when a prior **successful complete run** has the same semantic digest and the exact same source, config revision, field/identity mapping revisions and digests, endpoint profile digest, channels and epochs, entity set, version domain, and proof scope. A failed or partial prior run never qualifies. Recheck current approval and typed barriers independently for every run; ephemeral credential or Owner approval IDs do not enter semantic identity when approved configuration/mappings are unchanged. Reused observation values never authorize an old blocked job.

Otherwise allocate the next source-scoped 20-digit observation sequence under the active-source fence, only after whole-snapshot validation. Persist that observation once on the run and reuse it for recovery/apply of that run. Do not compare sequence values across channels, domains, or sources. Under `SOURCE_VERSION`, retain the source's original exact version strings and allocate no observation. D may use distinct successful complete runs with a reused identical observation to count repeated absence; C must not update that absence state.

## Apply ordering, transaction, and recovery

Apply customers before orders in deterministic full-key order. Within each entity, process deterministic full source-key order; keep each order header, all lines, canonical helper writes, outbox, durable aggregate outcome, immutable range receipt, and checkpoint in one transaction. Acquire the required guard before locking or writing. Keep source network IO outside every Hub transaction.

A crash before the aggregate transaction commits leaves none of its canonical effect, outbox, receipt, outcome, or checkpoint. A crash after commit leaves all of them. On restart, recover the same validated stage, observation, operation/range identity, and frozen proof; skip only a range whose durable committed receipt/outcome matches that exact proof. Do not allocate a new observation or rescan PostgreSQL to resume destination apply. Recheck the exact typed security barriers before each new aggregate transaction. No physical core-row deletion is allowed.

A run with any failed or quarantined terminal outcome remains unsuccessful. Do not advance last-successful state or D's complete-absence streak from it. Already committed aggregate ranges remain durable and are recovered idempotently; they do not make the overall run complete. API summaries expose only safe run state and approved counts, never staged rows, snapshot text, credentials, or source query details.

## Phase-owned schema and code seams

## B interface refresh at committed pin 8d9f1dca3bda9c0a58a410168005a39183206561

This is a read-only interface refresh using `git show <pin>:<path>`; no mutable B checkout was read. B is committed and independent Sol review is active. C remains provisional and must use the final reviewed BASE selected by root.

- Connector exports are `SnapshotRelation`, `SnapshotStageRow`, `SnapshotPage`, `SnapshotScanResult`, `SnapshotPageSink`, `PostgresSourceConnectionFactory`, `SourceEgressPolicy`, `SnapshotSourceError`, `MAX_SNAPSHOT_PAGE_SIZE`, `extractPostgresSnapshot`, and the fail-closed/local-lab source factories. A stage row is `entity, relation, source_pk, parent_source_pk, source_version, facts`; page is `entity, relation, page_no, rows, first_key, last_key, page_digest`.
- `createSnapshotStageStore(pool)` from `snapshot-stage-store.ts` exposes `claim`, `loadFrozenProof`, `beginAttempt`, `heartbeat`, `writePage`, `complete`, and `fail`, plus `expectedSnapshotRelations` and `snapshotManifestDigest`. It has no read-manifest/page/record, C run-claim, observation, apply, outcome, or terminal-run method. In particular, `loadFrozenProof` rejects any run not in SCANNING; after B completes the manifest and transitions the run to VALIDATING, C needs a separately fenced proof loader for VALIDATING/APPLYING.
- The immutable manifest stores `state='EXTRACTED'`, relation list, relation row/page counts and ordered page digests, total row/page counts, private snapshot identity, attempt and operation IDs, and config/mapping/identity/profile digests. B stores pages in `etl_snapshot_stage_page`, records in `etl_snapshot_stage_record`, and manifest in `etl_snapshot_manifest`. Direct access is revoked from API/worker/MCP/publisher/Hasura/public; worker calls the narrow security-definer write procedures. B's completion leaves the run `VALIDATING`, marks the extraction attempt `COMPLETE`, clears its scan lease, and leaves the schedule `active_run_id` attached.
- B's strict runtime is already composed into `runDurableWorkerLoop`: it runs `runDurableWorkerOnce` then serially `runSnapshotWorkerOnce(pool, dependencies)`. That snapshot worker only extracts; it supports injected resolver/factory/egress policy/page size/lease seconds. C should run from the same strict loop after extraction through a separate C coordinator and dedicated fenced continuation claim. Current B claim functions only admit `QUEUED`/`SCANNING`; B assertion requires `SCANNING`; B has no C lease or stage reader. Do not consume a new B attempt or use 008 item leases to apply.
- Add only narrow 009 C procedures/views: read exact complete EXTRACTED manifest, receipts and rows with persisted page_no/row_ordinal for a fenced tenant/source/run/attempt; recompute and compare manifest/page digests and coverage before semantic validation; claim/heartbeat/release C continuation while `VALIDATING`/`APPLYING`; persist observation/validation; atomically record aggregate outcome/range/checkpoint; and finish/release schedule after all outcomes. Keep row locks short and source IO outside Hub transactions. Only `hub_worker` gets these worker operations; API gets safe summary/view columns only.
- Schema facts: attempt ordinal is 1–4; stage pages and records have immutable mutation triggers. Page keys are tenant/source/run/attempt/entity/relation/page number. Record keys add relation and parent/source PK. Existing complete SQL checks relation coverage, page counts/sequences, order-line facts and parent headers, but C must independently recompute the manifest digest and each per-page digest against ordered durable rows, then compare the ordered digest list and receipts before semantic canonical/cross-identity validation. B currently discards row-to-page association and within-page ordinal in `etl_snapshot_stage_record`, so exact page recomputation is impossible after restart. Root ruling: persist immutable `page_no`/`row_ordinal` coordinates with each staged record (or equivalent immutable page-row relation) in the same transaction as `write_etl_snapshot_page`; the B reviewer will assess whether this lands as a B fix or as C-owned additive 009 work. C dispatch depends on the selected reviewed BASE preserving this page linkage. Preserve all existing stage facts and immutability.
- Migration acceptance for the C-assembled 009 is a database populated through 001–008 → assembled 009, followed by reapplication of the identical 009. Never apply changed 009 content to an existing ledger that records an earlier 009 body.

Extend only phase-owned `009_snapshot_runs_and_recovery.sql` as needed for C's whole-run validation proof, durable observation allocation/reuse binding, per-aggregate outcome, immutable apply-range receipt, and recoverable checkpoint. Pin exact tenant/source/run/attempt/manifest/proof keys, uniqueness, state checks, append-only/immutable guards, FKs, worker-only write grants, and safe API read columns before coding. Keep B's immutable page, record, and `EXTRACTED` manifest contracts intact. `hub_api` must not gain stage or business write access; no API, MCP, publisher, Hasura-reader, or public role can write C apply proof. `hub_worker` receives only required fenced operations. Never revise 001–008.

Expected implementation seams:

- `integration-service/etl-worker/snapshot-contract.ts` and `snapshot-runs.ts`: C eligibility/status transitions and a safe validation/apply summary compatible with API-019/020/021. Keep run in `VALIDATING` until full validation is durable; then move to `APPLYING`. Do not claim B's `EXTRACTED` manifest is `READY`.
- New focused C validation/observation module: consume only B's exact complete-manifest/stage-store exports; validate all entities/references; compute semantic digest; serialize observation reuse/allocation under the active-source fence.
- New focused C apply coordinator or equivalent strict-worker seam: build `ApplyContext` from frozen run proof; call existing helpers with caller-owned transactions; record per-aggregate outcome/range/checkpoint atomically; recover only exact committed ranges.
- `integration-service/etl-worker/worker.ts`: compose C in the existing strict worker runtime without enabling the M1–4 local-lab legacy worker or duplicating the existing serial run lease.
- `integration-service/migrations/009_snapshot_runs_and_recovery.sql`: add the minimum C proof rows and worker grants; do not modify B stage facts in place or weaken their immutability.

B exports are now recorded against committed pin `8d9f1dca3bda9c0a58a410168005a39183206561` below. Refresh them again only if independent review changes the selected BASE; do not dispatch C until root selects that reviewed BASE.

## Required focused acceptance evidence

Use only isolated local Hub and PostgreSQL fixtures with independent fixture-owner and source read-only roles; do not connect to business systems or production. Before implementation, capture the exact accepted BASE and source-before evidence. After each focused gate, preserve exact command, stdout/stderr/exit, actual HEAD, and safe artifact hashes under the task report path; no broad evidence-tree staging. Formal 48-case suite remains `NOT_RUN`.

Acceptance traces:

- Two-pass first-load trace: customer-only full run applies; API-014 exact Owner mapping links a new order customer's live UUID; approved combined run validates all customer/order/header/line facts before apply.
- Missing or stale same-source and explicit other-source identity targets reject the whole run before observation, checkpoint, canonical write, or outbox.
- Corrupt/incomplete manifest, duplicate key, orphan line, missing relation, invalid exact decimal/timestamp, and partial-attempt stage never become absence or apply input.
- Identical complete successful snapshots reuse the observation only with exact semantic digest and full scope; changed business facts or proof scope allocate a new monotonic value after validation. Failed partial run is never a reuse candidate. `SOURCE_VERSION` remains byte-exact and gets no observation.
- Unchanged canonical business content updates the appropriate receipt without a second outbox event. Explicit source tombstones are logical canonical deletes; absence remains D-only.
- Process crash immediately before and after the aggregate transaction proves all-or-none canonical effect/outbox/outcome/range/checkpoint. Recovery reuses complete validated stage and observation, with no new source transaction; a stale worker token cannot commit.
- Typed barriers stop the next effect, while ordinary pause/config drift does not rewrite accepted frozen proof. Retired channels and changed exact identity proof fail closed.
- Verify API-019/020/021 status/read scopes, safe counts, filters, default page size 20 and max 100, plus denials for source/token callers attempting admin capabilities. This is a C-scope trace, not a claim that all API-019–024/060 work is complete.
- Verify the C-assembled 009 from a database populated through 001–008, then reapply that identical assembled 009 and verify idempotency, recovery after populated rows, immutability and grants. Never apply changed 009 content to a ledger recording an earlier 009. Whole M1-5 integrated gate and review remain required.

Report path: `E:\\git\\dgo-hub\\.superpowers\\sdd\\2026-10-24-alpha1-m1-source-ingestion-implementation-plan\\task-5c-report` (and the corresponding `docs/execution/alpha1/m1-task-5c-report` evidence path if the phase convention requires it). No live CRM, Hermes, SQL Server, source endpoint, production database, real credential, deployment, query-gate activation, or UI workflow is in scope. Do not claim M1-5 complete at C; D, E, and whole-phase review remain.


## API-013 discovery check for the two-pass path

At the pinned source, GET `/hub/v1/admin/identity-mappings` is the existing identity-mapping API. With `source_id`, `kind=customer`, and `external_id`, it requires `source:approve`, verifies the exact source Owner and enabled current Owner, and returns up to 50 rows from `api.canonical_customer_identity` as `{target_id, label}` (UUID and customer name). That gives an Owner an authorized way to see live candidate UUIDs without fixture-superuser SQL, and API-014 remains the only operation that confirms the external-key-to-UUID mapping.

However, this existing candidate response is not enough to reliably identify the newly created customer's exact source key: it is tenant-wide, unpaged, and omits the source-qualified `canonical_source_identity.source_pk` tuple. It can also be ambiguous when customer names repeat. The source identity table is not directly granted to `hub_api` at this pin. The root-approved C contract adds a narrowly scoped optional discovery mode to this same API-013 route (no new route or authority scope), selected only by explicit `mode=source_customers`, `source_id`, and `kind=customer`: exact tenant and source, required `source:approve` plus the exact currently enabled source Owner check (optionally also `source:read` if consistent with existing auth); default API-013 behavior and its existing authorization remain unchanged when the mode is absent. The new mode is read-only, page size default 20/max 100 with a cursor ordered under C collation, and returns only unconfirmed source-qualified `source_pk` → live canonical UUID summaries for the requested source. It returns no customer name, raw payload, credential, or mapping decision. Add a narrow API view and column-level SELECT grant in phase-owned 009; do not grant broad access to `control.canonical_source_identity`. Revalidate the current principal and exact current source Owner at the query boundary. API-014 remains the only operation that confirms/writes the external-key-to-UUID mapping.

C's acceptance trace should enumerate a customer-only run, use this API-013 mode to discover the exact source key/UUID pairs, explicitly confirm them through API-014, and then run the combined snapshot. Verify the requested source is the only source returned, source keys distinguish any candidate UUIDs, and the read mode cannot update mappings. If the source-qualified safe view/grant cannot be implemented additively in phase-owned 009 without broadening API access, stop C dispatch and return the schema/grant seam for review.

