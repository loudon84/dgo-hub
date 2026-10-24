# M1-2 Interface Preflight — Fixed Commit Facts and Compatibility Constraints

**Reviewed evidence snapshot:** 0afcd73b2ae9b72f27966a1488bcb87a326387b2, read only with `git show <commit>:<path>`. M1-1 scoped review is approved per `task-1-rereview-2.md` and closure record `375273bab344630b3b9345bc89b948056f048bf9`, based on source 75d6640a. This preflight is not the implementation base; root will freeze the post-planning-commit hash.

## Product contract facts

Authority is docs/数据治理与本体集成中台_产品架构与二开说明_v1.0.md, PRD-DGO-HUB-001 v1.0.0. Its front matter marks status REVIEW.

- §5 (around lines 165–166): Source Record is tenant/source/entity/source_pk; canonical objects have stable internal UUIDs. Source PK is not a global object ID.
- §8.1 (around lines 270–284): equal version + same content is DUPLICATE; lower version is IGNORED_STALE; equal version + changed content is QUARANTINED. Batch status derives from item states.
- §8.6 (around lines 304–308): active config edits pause first; durable tasks use frozen config; source compromise/leakage and channel switch isolate pending events.
- §9.1 (around lines 312–320): identifiers case-sensitive, max 128, no leading/trailing whitespace. Amounts are decimal strings and numeric(20,2); quantities and unit prices numeric(20,6); CNY/USD/EUR stay separate; exact parsing/normalization rejects excess scale without rounding. Root requires quantity > 0.
- §9.2 (around lines 322–364): database schemas raw/core/api/projection/control; standard customer/order/line records and source identity map; core row links require composite (tenant_id,id) FKs; source key unique by tenant/source/entity/source_pk; source version numeric(20,0), version_mode, channel_epoch, deleted_at, hub_revision.
- §9.3 (around lines 366–388): REST record and batch shape, full image semantics, <=200 complete order lines, tombstone retention and version ordering. Old versions cannot resurrect deletion.
- §9.4 (around lines 390–396): server allocates snapshot observation only after whole snapshot validation; unchanged content makes no outbox event; channel cutover requires reconciliation and Owner approval; old epoch returns CHANNEL_EPOCH_RETIRED, version domains never cross-compare.
- Root digest ruling: source business digest uses external identity keys before UUID resolution and excludes source_version, observation_seq, channel_epoch and all processing metadata; normalize decimals with BigInt and fixed scales; quantity must be >0.

The public M1 plan § “M1-2 — Canonical model and atomic aggregate apply” (fixed source lines 68–74) scopes migration 006, normalization/store caller-transaction split, canonical entities, identity mappings, receipts, tombstones, outbox, mandatory caller PoolClient, full order replacement <=200, retired-channel check before version comparison and listed meaningful cases.

## Existing database shape

### Migration 001, integration-service/migrations/001_init.sql

- hub.customer has UUID PK, text tenant/source/source ID/owner, version bigint, name/email/phone/deleted, unique (tenant_id,source_system,source_id).
- hub.sales_order has UUID PK, text tenant/source/source ID, customer_id uuid REFERENCES hub.customer(id) only, owner, version bigint, total numeric(18,2), status/deleted; unique (tenant_id,source_system,source_id).
- hub.order_item has UUID PK, order_id REFERENCES hub.sales_order(id) ON DELETE CASCADE, tenant/owner, sku, integer quantity and unit_price numeric(18,2). There is no line source key, currency, version domain, channel epoch or receipt.
- Indexes: idx_customer_scope(tenant_id,owner_user_id), idx_order_scope(tenant_id,owner_user_id,updated_at DESC), idx_item_order(order_id).
- api.customer, api.sales_order, api.order_item, api.sales_summary and api.customer_sales views expose demo columns; customer view masks email/phone.

Thus existing single UUID FK does not prove tenant scope, and cascade delete would lose lines. Use additive constraints/columns or a ruled canonical table/view plan. Preserve view columns until consumer replacement is defined. Do not edit 001.

### Migration 002, integration-service/migrations/002_identity_auth.sql

control.tenant is tenant authority; control.auth_subject PK is (tenant_key,user_id); credential_digest_registry is global and immutable; source_credential is unique on (tenant_key,source_id), with unique (id,tenant_key,source_id), FK to digest registry, allowed entities, enabled and revision. Reuse it; do not introduce a bearer store.

### Migration 005, integration-service/migrations/005_source_registry.sql

- Adds source_epoch to existing source_credential.
- source_registry binds tenant/source and same-tenant data_owner_user_id, and tracks lifecycle/current config, field mapping, identity mapping and Owner revisions.
- config/mapping/identity_mapping revision tables already persist digest, JSON mappings, creator and time.
- Test and Owner approval bind those revisions and digests, source credential revision, report and owner revision.
- source_channel has immutable UUID/tenant/source/entity/connector/mode/version_domain/channel_epoch identity; trigger prevents identity mutation and retired-to-active; unique partial index allows one active primary per tenant/source/entity.
- source_security_barrier stores CREDENTIAL_COMPROMISE, SOURCE_SCOPE_SECURITY_REMOVAL, TENANT_DISABLED, CHANNEL_RETIRED. hub_worker currently reads channel/barrier only.
- locked auth/credential/barrier definer functions fix search_path and revoke PUBLIC execute before explicit role grants. Preserve this authority.

## Existing TypeScript contracts

- integration-service/source-registry/service.ts defines Connector rest/postgresql/sqlserver; SyncMode FULL_SNAPSHOT/INCREMENTAL; VersionDomain SOURCE_VERSION/SNAPSHOT_OBSERVATION; SourceConfig with endpoint_allowlist_ref, opaque secret_ref, allowed_entities, tombstone/hard_delete contract; FieldMapping {entity,source_field,target_field,transform}; IdentityMapping {kind: user | department | customer, external_id, target_id: string | null}. Revisioned mapping/digest storage already exists; reuse the same authority.
- integration-service/auth/types.ts defines SourcePrincipal with sourceId, tenantId, allowedEntities, credentialId, revision and sourceEpoch. AuthService.assertCurrentSource(snapshot,entity,client:PoolClient) exists.
- integration-service/auth/service.ts lines 533–565: authenticateSource returns source/tenant/credential/revision/source_epoch; assertCurrentSource calls lock_current_source and checks enabled tenant/credential, ACTIVE lifecycle, scope, current credential/config revision and source_epoch. Admission-only; it is not durable-worker freshness.
- integration-service/auth/repository.ts withAuthTransaction reuses supplied PoolClient without nested BEGIN/COMMIT/release. Apply uses the same caller-owns-transaction rule.
- Durable apply must not use assertCurrentSource equality as worker lifetime auth. It checks separate persisted security barriers and channel retirement inside the apply transaction; ordinary source_epoch drift alone cannot invalidate accepted frozen work.

## Current normalization implementation

- normalization/models.ts trims keys and permits 160 chars; money/quantity/version use JS number; order line cap is 500; order total compares via Math.round and floating arithmetic.
- normalization/store.ts ingest(kind,sourceSystem,eventId,payload) owns withTransaction; SHA-256 input is JSON.stringify(record); it locks source + event ID; compares version through Number; equal version is treated as stale; order lines are deleted and reinserted. It has no channel/domain receipt, entity canonical digest, tombstone history, tenant-composite relationships, or caller-client apply primitive.
- integration-service/db.ts withTransaction owns BEGIN/COMMIT/ROLLBACK and client release. Keep for top-level callers; new apply functions take an existing client and never call withTransaction.

## Compatibility constraints for the implementation plan

1. Migration 006 only; append to current checksum runner and preserve 001–005 history.
2. Keep seven module directories; normalization and migrations are M1-2 scope. M1-3 owns REST parser/durable batch; M1-4 owns worker claim/retry; M1-5 owns full snapshot/reconciliation/cutover.
3. Consume reviewed M1-1 source/mapping/auth interfaces. No second identity registry, auth authority, migration runner, or new top-level directory.
4. Extend explicit DB grants narrowly. Migration 005 gives the shared all-tenant hub_worker role SELECT on security barriers/channels but not canonical writes; hub_api manages source registry and later raw intake but receives no direct canonical DML. Grant only the apply DML/security reads needed by hub_worker. Prove role boundaries, and prove tenant isolation through immutable trusted job/source/approval binding and composite FKs—not role-level tenant isolation or invented RLS/per-tenant roles.
5. A caller transaction must cover aggregate row(s), lines, receipt/tombstone, outbox, and any owner map/audit/epoch effect required by the ruling.
6. API intake later calls M1-1 assertCurrentSource just before durable acceptance. Apply checks current security barrier and channel; it does not compare accepted epoch to current ordinary source_epoch.
7. First channel activation is supported by M1-1 bounded capability test and exact Owner approval. Switching channel or version mode remains unavailable until M1-5 reconciliation. M1-2 may consume a persisted observation version supplied by M1-5, but cannot allocate one.
8. Typed internal outcomes map to existing HTTP/job errors in M1-3. Keep raw payload and secrets out of outbox/read APIs.
9. PRD/plan are planning authority, PRD remains REVIEW, and historical test reports are not acceptance claims.

M1-1 scoped review is now approved per task-1-rereview-2.md and closure record 375273bab344630b3b9345bc89b948056f048bf9, based on source 75d6640a and evidence snapshot 0afcd73b2ae9b72f27966a1488bcb87a326387b2. No product code, probes, tests, package installs, resource creation or Git mutations were done.


### Source profile / mapping details

- integration-service/source-registry/capability-probe.ts exports EndpointProfile: revision, connector, protocol, host, port, optional loopback allowances, optional REST path/schema_version/source_identity, optional PostgreSQL database/user/schema, and an entities map keyed by customer/order. Each EntityProfile has optional table plus version_field and optional delete_field. This is an endpoint allowlist result frozen into source config by M1-1; M1-2 consumes only already approved mapping revisions and channel identity and does no endpoint resolution.
- SourceConfig stores allowed_entities, connector, mode, version_domain and delete_contract (tombstone or hard_delete), plus endpoint_allowlist_ref and opaque secret_ref. M1-2 should treat the approved channel's connector/mode/domain as authoritative and must not accept these values from the event.
- FieldMapping is entity + source_field + target_field + transform (identity, trim, decimal-string, source-id). IdentityMapping is kind + external_id + nullable target_id; kinds are user, department and customer. Field mappings are JSON snapshots in source_mapping_revision; identity mappings are JSON snapshots in source_identity_mapping_revision. Approval/test records bind exact revisions/digests; apply uses frozen admission proof, while a narrow remap fence blocks only corrected identity keys from stale jobs.
- Capability test validates mapped source fields and version/delete fields. It proves bounded source shape/readability only; it does not prove full snapshot consistency, business completeness, ownership mapping semantics, or canonical apply.


## Controller rulings and corrected PRD interpretation

Fixed PRD section 9.2 explicitly provides required-field, default and status semantics in the Standard Object Fields table (lines 338-364); follow it verbatim and infer no additional defaults or required-field rules. Customer requires customer_name, owner_user_id, dept_id, status (ACTIVE/INACTIVE); phone is optional and defaults null. Order requires customer_id, order_no, status (DRAFT/CONFIRMED/COMPLETED/CANCELLED), order_at, amount and currency. Lines require parent order_id, source_line_id, product_code, product_name, quantity, unit_price and line_amount. Shared tenant_id and id, source_updated_at, source_version, version_mode, channel_epoch, deleted_at and hub_revision follow the exact table entries. See fixed source PRD section 9.2, Standard Object Fields, lines 338-364.

Root rulings incorporated: currency text plus CHECK CNY/USD/EUR; source_version numeric(20,0), canonical 1-20 digit string and never Number; parse decimal strings with BigInt, normalize to exact scale 2 for money and 6 for quantity/unit price, reject excess scale without rounding and quantity <= 0; deterministic C collation for case-sensitive max-128 IDs without edge whitespace; lines [] valid but omitted lines invalid; header amount is authoritative and no equality-to-lines check; new core canonical/projection/read-view tables coexist with legacy hub.* and api.* until M2 controlled replacement; deleted_at and tombstones retain stable UUID; receipts append-retained with no cleanup TTL; shared hub_worker gets minimum apply DML and hub_api raw-intake only with no direct core DML; caller PoolClient atomically applies core/receipt/outbox/required auth_epoch; ordinary durable work uses frozen admission proof and typed security barriers; hub_worker is cross-tenant so isolation proof uses trusted job/source/approval binding plus composite FKs, not per-role isolation; internal results are APPLIED, DUPLICATE, IGNORED_STALE, QUARANTINED(SOURCE_VERSION_CONFLICT), CHANNEL_EPOCH_RETIRED, with M1-3 doing HTTP mapping.

Owner external key resolves to enabled same-tenant control.auth_subject through the existing typed, revisioned JSON identity-mapping workflow, with exact current Data Owner confirmation and reason. No parallel owner registry or auth authority.

M1-1 scoped review is approved. This is a preflight evidence snapshot, not the implementation base; root will freeze the exact post-planning-commit base before dispatch. The controller has ruled that API-014 owner/department/customer confirmation immediately remaps matching existing canonical rows in the same transaction through a narrow controlled seam, preserving UUIDs/receipts and updating affected auth epochs. A per-object remap fence must prevent old frozen jobs from restoring prior targets; unchanged source business digest remains DUPLICATE and preserves current projection. No additional PRD/controller contract blocker remains.

## M1-1 typed identity and security seam refresh

Source of these implementation facts: `git show 0afcd73b2ae9b72f27966a1488bcb87a326387b2:<path>`. This is the M1-1 reviewed evidence snapshot; root will freeze the post-planning-commit base.

### Typed map and API behavior

The actual service type is IdentityMapping = {kind:'user'|'department'|'customer', external_id:string, target_id:string|null}. Current per-source authority is control.source_identity_mapping_revision with revision, canonical mapping_digest and JSON mappings; test reports and Owner approvals bind its revision/digest. The parser rejects duplicate (kind,external_id). FieldMapping already permits owner_user_id, dept_id and order.customer_id targets with source-id transforms.

GET /hub/v1/admin/identity-mappings accepts source_id, kind and external_id. Candidate mode requires kind+external_id, verifies source:approve, same-tenant source and exact current bound Owner. kind=user lists enabled same-tenant auth_subject users, max 50; kind=department lists distinct non-null departments on enabled same-tenant subjects, max 50. kind=customer currently returns resolved=false and candidates=[]. Candidate and list IDs use canonical base64url(UTF8(source_id + NUL + kind + NUL + external_id)).

PUT /hub/v1/admin/identity-mappings/:id takes expected_revision, target_id and reason. It requires source:approve, valid opaque ID, exact current Owner, enabled same-tenant user target or a department on an enabled same-tenant subject. It locks source, checks expected_revision+1 equals stored identity_mapping_revision, appends the next JSON revision and digest, changes ACTIVE to PAUSED (or non-ACTIVE to DRAFT), advances source_epoch via AuthService repository and appends IDENTITY_MAPPING_CONFIRMED with reason. expected_revision 0 is valid when stored revision is 1. Current customer write branch rejects SOURCE_NOT_FOUND.

M1-2 extends these same candidate/update semantics after resolving non-deleted same-tenant canonical customer targets from new core. Keep the typed identity mapping revision, digest, opaque codec, exact Owner authorization and expected revision flow. Do not create a separate owner/customer registry or route. At apply, use the job's frozen identity_mapping_revision: user to enabled same-tenant auth_subject, department to department on enabled same-tenant subject, customer to same-tenant canonical customer UUID. Order customer FK includes tenant_id. An unresolved or tombstoned customer target follows typed mapping quarantine; incoming owner_user_id is never authorization truth.

### Mapping change and atomic core ownership

At snapshot 0afcd, API-014 changes mapping revision, source lifecycle/admission epoch and lifecycle audit, but not existing core ownership or auth_subject.auth_epoch. The controller requires human remap to update canonical references, audit/outbox/hub_revision and affected old/new auth_epoch atomically, without broad hub_api core DML or false source-version conflict.

Controller ruling: keep API-014 and the same revision authority. In the same caller PoolClient transaction that writes confirmed mapping revision, invoke a narrow fixed-search-path controlled function from migration 006 with PUBLIC revoked and explicit hub_api EXECUTE. It immediately remaps matching existing canonical references, records audit/outbox/hub_revision, increments affected old/new auth_subject.auth_epoch, leaves receipts/tombstones untouched and preserves object UUIDs. Existing AuthService repository advances source_epoch in that transaction. Do not grant hub_api direct core DML or change M0 identity/role/department authority. No-op confirmation causes no fabricated epoch/outbox mutation; reject/quarantine a contradictory mapped department, never rewrite M0 to fit source data. Worker gets only minimum apply DML. Human corrections are not SOURCE_VERSION_CONFLICT.

### Credential generation and review-sensitive facts

Migration 005 adds source_credential.credential_generation default 1. Credential upsert/update increments generation on policy/secret/config-revision changes as implemented; source_epoch also advances. source_test_report and source_owner_approval bind config/mapping/identity revisions and digests, credential revision/generation, endpoint_profile_digest, data_contract_ref and test_report_id. Admission freezes this approval proof. Ordinary later pause/config edits/credential generation drift do not cancel an admitted frozen job by themselves.

The reviewed auth/types.ts SourcePrincipal has sourceId/tenantId/allowedEntities/credentialId/revision/sourceEpoch, not credential_generation. authenticateSource/assertCurrentSource checks enabled tenant/credential, ACTIVE lifecycle, entity scope, current config/credential revision and source_epoch. Use it only at new-job admission. At apply, verify frozen credential_generation and other proof against exact approval/test rows but do not require equality with current generation or source_epoch. M1-1 review closure reports the I2 scope/enabled and pre-onboard credential-rotation guard fixes; source evidence is the closure record and reviewed commit.

Migration 005 exposes narrow SECURITY DEFINER lock_source_credential and lock_source_channel functions with fixed search_path and PUBLIC EXECUTE revoked. hub_api uses these for locks rather than credential/channel write grants. hub_worker has SELECT on security barriers/channels but no canonical apply DML. M1-2 grants only minimum core apply DML to hub_worker and keeps hub_api raw-intake separate without direct core DML.

### Citations at reviewed evidence snapshot 0afcd73b2ae9b72f27966a1488bcb87a326387b2

- integration-service/source-registry/service.ts: IdentityMapping/parser, `identityMappings`, `updateIdentityMapping`; integration-service/source-registry/routes.ts: GET/PUT identity-mappings handlers.

- integration-service/migrations/005_source_registry.sql:1-3, 46-101, 103-164, 166-209, 310-355.
- integration-service/auth/types.ts SourcePrincipal; integration-service/auth/service.ts:533-565.
- Product fields remain PRD-DGO-HUB-001 v1.0.0 §9.2, Standard Object Fields, lines 338-364; PRD status REVIEW.
