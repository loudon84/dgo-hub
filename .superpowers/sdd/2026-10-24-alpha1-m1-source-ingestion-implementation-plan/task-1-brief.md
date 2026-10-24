# M1-1 builder brief: Source Registry, mappings, current-source authorization

## Authority and dispatch boundary

Follow the [public M1 plan](../../../docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md) and this authoritative workspace identity. Accepted design inputs are the old M0 workspace's [source-contract preflight](../2026-10-23-alpha1-m0-identity-isolation-implementation-plan/context/m1-source-contract-preflight.md), [M1 discovery](../2026-10-23-alpha1-m0-identity-isolation-implementation-plan/context/m1-discovery.md), [SQL Server driver contract](../2026-10-23-alpha1-m0-identity-isolation-implementation-plan/context/sqlserver-driver-contract.md), and [UI seam discovery](../2026-10-23-alpha1-m0-identity-isolation-implementation-plan/context/ui-seam-discovery.md). The public M1 plan is authoritative; these source notes remain linked research, not a competing plan.

- Plan ID: alpha1-m1-source-ingestion-implementation-plan
- Plan workspace: .superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/
- First M1 task: M1-1 Source Registry, mappings, and current source authorization.
- Source code remains undispatched until the controller confirms the GPT-6.1 Sol whole-M0 findings, including scoped Task5 re-review, are closed and records the exact implementation base SHA. Current Task5 documentation SHA `caf026a7eefb7005c9c036c2109515fd3e0beac6` is not an implementation base. Do not infer an implementation base from this planning document's commit or create a new branch/worktree.

Implement only M1-1. Preserve the existing seven module directories. No M1-2 canonical apply, intake batch, worker, snapshot, SQL Server or UI code in this task. No service/database/upstream clone configuration or remote changes.

## Inputs and existing interfaces to inspect at dispatch

Inspect the approved current tree at the recorded base:

- integration-service/auth/types.ts
- integration-service/auth/service.ts
- integration-service/auth/repository.ts
- integration-service/migrations/002_identity_auth.sql
- integration-service/migrations/004_alpha1_runtime_security.sql
- integration-service/migrations/runner.ts and the migration tests
- integration-service/ingestion-api/identity-routes.ts, routes.ts and app.ts
- integration-service/contracts/runtime-config.ts and the existing HTTP/error/logging contract
- Task4 role setup in deploy/alpha1/db-init/00-roles.sh and Task4 scoped Sol review

Confirm the current source credential row/grants are unchanged. If the exact source base differs from the reviewed Task5 M0 handoff, refresh only the relevant seam facts before coding and record the source identities.

## Deliverables

1. Append migration 005_source_registry.sql using the existing checksum runner. Do not edit 001–004 or introduce another migration runner.
2. Add tenant-scoped revisioned source registry, source field mapping and identity mapping persistence and API contracts for API-002–014.
3. Keep control.source_credential and credential_digest_registry as the only source credential authority. Extend the current source row with monotonic source_epoch and expose it on SourcePrincipal.
4. Add AuthService.assertCurrentSource(snapshot, entity, client: PoolClient). With caller-owned client, lock/re-read tenant+source credential and compare exact source/tenant, credential identity/kind, enabled flags, entity allowlist, current source config revision and source_epoch. Do not start/commit/release nested transactions. The manager's state transition and assertion must use compatible row locks and commit atomically.
5. Bind source credentials to frozen source config revisions through the existing source credential revision field; document exactly which value it carries. Admission-affecting source pause/activation, ordinary credential replacement, allowed-entity/config revision change and secret_ref update advance admission `source_epoch` in the same transaction. Keep admission freshness separate from durable-job execution: ordinary pause/config/mapping edit blocks new admission while already accepted jobs continue under frozen approved revisions. Persist separate typed security facts for explicit credential compromise/revocation, source-scope security removal/leakage, tenant disable, and channel retirement; workers check those facts under transaction locks before applying and isolate matching pending work. Do not cancel a job merely because its admission epoch is stale, and do not allow frozen jobs past a matching security barrier. A later resume/config/credential edit cannot erase a security revocation fact.
6. Implement lifecycle DRAFT → TESTED → APPROVED → ACTIVE → PAUSED. 'source:write' creates/updates, tests and activates/pauses subject to current valid test/Owner approval. 'source:approve' is necessary for owner approvals but never sufficient alone. M1-1 supports first activation from its bounded capability result and exact current Owner approval. Persist immutable current/pending channel identity, connector, entity, mode/version domain and `channel_epoch`; enforce one active primary per tenant/source/entity with serializing lock plus uniqueness. Until M1-5 provides complete initial reconciliation, connector or version-mode switching is explicitly unavailable; M1-1 must not partly activate a pending channel.
7. Store a per-source data_owner_user_id whose composite tenant/user FK points at an existing enabled M0 auth_subject. A caller with source:write can assign/change the owner only within the caller tenant; record actor, old/new owner, owner revision and audit event. Owner reassignment immediately pauses active source, bumps source epoch, invalidates test/approval applicability and requires test and approval bound to new owner. A Data Owner action must require current enabled owner principal, same tenant, exact equality principal.userId=data_owner_user_id and source:approve. Owner-bound API-007/API-060 approvals are invalidated when the binding revision changes and must be checked against the current binding again at execution. Ordinary accepted ingestion may continue on its frozen approved config, but it cannot reuse an old Owner approval. Do not add source:activate or deletion scopes.
8. Persist immutable/revisioned source configuration, source/mapping canonical digests, secret_ref, endpoint allowlist reference, connector/mode, allowed entities, mapping contracts, test report, Data Owner approval and lifecycle event. APIs never return raw token, secret bytes, connection material, digest or raw input. Config/mapping edits use expected_revision; stale updates return 409. Source deletion is out of scope.
9. Provide a deployment-injected SecretResolver interface for opaque configured references, not a KMS/product. It may resolve bounded secret material in memory only for a source test. Reject body secret values, local filesystem paths and arbitrary URLs; redact secret and sensitive references from errors/logs. Keep endpoint egress allowlisting separate.
10. API-006 read-only tests: a REST source can pass a bounded authenticated schema/version/delete contract probe without full apply; PostgreSQL probe checks approved database/object identity, required mapped fields, read-only permission, mapping/delete/version contract. No write/DDL is issued. Before an actual IdP or source probe, require an approved controlled outbound path and verify exact endpoint reachability; never broadly widen egress. SQL Server remains DRAFT/unavailable until M1-6 implements its full preflight.
11. Add exact minimum hub_api column/function grants required for these workflows; revoke PUBLIC, fix search_path on any SECURITY DEFINER function. Keep hub_mcp, hub_publisher, hub_worker and Hasura grants unchanged. Tests must prove role-specific positive operations and forbidden source-table/digest/function access.
12. Keep existing response envelope {request_id,data} / {request_id,error:{code,message,retryable,details}}, server-generated request IDs, safe logging and bodyless 204 as appropriate. Legacy /admin/* and /v1/ingest/* must remain inaccessible outside explicit local_lab legacy mode.

## Required focused coverage

- Real isolated PostgreSQL migration 005 from clean M0 baseline and migration runner repeat/checksum behavior.
- Lifecycle transition table; tenant isolation and non-disclosing cross-tenant reads; owner assignment to an existing same-tenant enabled subject only; source:write authorization and audit; exact bound owner plus source:approve required for API-007 approval.
- Source config/mapping/credential/owner revisions bind test and approval digests; any relevant update invalidates stale approval/test. Active edits auto-pause.
- Expected-revision race is deterministic and produces one winner/one conflict.
- Source credential digest remains globally unique; rotate through M0 repository authority. No second token registry. source_epoch increments exactly once for each auth-effective state change and never for no-op updates.
- assertCurrentSource accepts only unchanged current snapshots, rejects paused/disabled/rotated/revised/re-scoped/tenant-disabled snapshots and wrong entity. Supplied PoolClient remains caller-owned and has no nested BEGIN/COMMIT/release.
- Concurrent source activation/pause/rotation and current-check demonstrate a serial order; no accepted intake contract relies only on pre-parse authentication.
- Two first-activation attempts for one primary entity have one winner. First activation succeeds without M1-5; channel/mode switch returns unavailable until M1-5 exists. Failure before cutover leaves current channel/config/epoch unchanged.
- A 202 job survives ordinary pause/config edit under its frozen approved contract; admission stays closed until current config is re-approved/active. Epoch drift alone does not quarantine. Explicit credential revocation, source-scope security withdrawal, tenant disable and channel retirement isolate matching pending jobs. A later config edit/resume cannot remove the barrier.
- A Data Owner reassignment after job acceptance invalidates old API-007/API-060 approvals by owner revision; ordinary frozen ingestion can finish, but an Owner-gated action fails unless the new exact Owner approves the current revision.
- Any later channel switch must stop old admission, drain/isolate old work, complete/validate initial reconciliation, require exact current Owner approval of pending channel/reconciliation digest, atomically cut over config plus epoch, preserve UUIDs, and reject old events as `CHANNEL_EPOCH_RETIRED` before version comparison. Never compare `SOURCE_VERSION` with `SNAPSHOT_OBSERVATION`.
- Secret resolver accepts configured opaque references only, never emits secret material or reference through HTTP/error/log. Endpoint allowlist remains explicit.
- REST/PostgreSQL capability tests can produce TESTED prior to full snapshot apply; SQL Server cannot become TESTED by a TCP-only or mock probe.
- M0 HTTP error envelope/request ID and strict legacy routing behavior remain covered; no secrets in captures.
- Existing runtime role boundary is preserved and only M1-required hub_api privileges/functions are added; negative tests confirm forbidden access.

## Evidence and handoff

Before implementation, report the exact approved source base. Preserve one red focused failure, then green focused verification; perform one full typecheck/test/build on the final M1-1 source and report commands, exits, counts, source hashes, logs, migration SQL digest, fixture image/repo digest, full resource IDs/labels and confirmed cleanup. Do not include unreviewed files or secret-bearing fixture files in an archive; use explicit safe file lists. Preserve all failed attempt outputs. Do not declare product acceptance PASS or site-ready. Commit product source separately from report/evidence; request the separate Sol review before task M1-2.
