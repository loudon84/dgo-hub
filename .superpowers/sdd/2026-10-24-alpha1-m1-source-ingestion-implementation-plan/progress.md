# SDD ledger — plan: docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md

## Authoritative planning identity

- Public plan: docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md
- Plan ID: alpha1-m1-source-ingestion-implementation-plan
- Planning workspace: .superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/
- Planning source/base at freeze: feat/alpha1-implementation, M0 Task5 began at `7ab55f998f1dc297732884df1b1b8a5087bda40e`, its Task5 handoff commit is `caf026a7eefb7005c9c036c2109515fd3e0beac6`, and scoped Task5 re-review is pending. Neither SHA is an M1 implementation base.
- Source implementation status: no M1 source changes started. First implementation dispatch waits on closure of whole-M0 review findings and the controller's exact post-review base.

## Current status

- M1-1 Source Registry/mappings/current-source authorization: brief prepared, not dispatched.
- M1-2 canonical model/atomic aggregate apply: planned, blocked on M1-1 review.
- M1-3 strict REST batch/durable jobs: planned, blocked on M1-1 and M1-2.
- M1-4 durable worker/retry/quarantine: planned, blocked on M1-2 and M1-3.
- M1-5 PostgreSQL snapshots/deletion/recovery: planned, blocked on M1-1/2/4.
- M1-6 SQL Server adapter: planned; real integration remains conditional on an owned disposable instance.
- M1-7 OpenMetadata P02–04 worktree integration and FI/oracle handoff: planned after API contracts stabilize; no existing clone is modified.

## Frozen preflight rulings

1. Keep M0 AuthService and migration runner authoritative; append migrations from 005; no duplicate credentials/registry.
2. Add source_epoch to the existing source credential authority and assertCurrentSource(snapshot, entity, PoolClient) for new intake admission. Admission epoch changes serialize with intake. Durable jobs capture frozen approved config/mapping/channel identity and accepted security facts; they continue after ordinary pause/edit. Workers check durable current security revocation/tenant-disable/channel-retirement facts before apply. Do not equate ordinary epoch drift with revocation or let frozen jobs past a matching security barrier.
3. REST and PostgreSQL read-only capability probes may establish TESTED before snapshot apply. SQL Server remains DRAFT/inactive until its real adapter performs actual read-only SNAPSHOT preflight.
4. Secret resolution is an injected, deployment-controlled opaque-reference resolver; never client-provided secret bytes, paths or URLs.
5. API-060 is planned as the sole explicit extension to original APIs 001–059. Per-source data_owner_user_id must point to an existing enabled subject in that tenant; source:write assigns/changes it with an audit record and invalidates approvals/tests. API-007 and API-060 approvals require both source:approve and exact equality to the currently bound owner user ID. Changing owner/config/mapping/candidate digest invalidates prior approval; generic scope possession alone is insufficient. No new auth scope.
6. The full-snapshot >5% hard-delete condition pauses the source; approval binds exact source/run/candidate digest and source/owner revision.
7. Preserve the existing seven module directories and three reference clones. UI work uses a separate worktree from the pinned OpenMetadata extension seam.

## Source references

- M0 approved handoff: [Task5 brief](../2026-10-23-alpha1-m0-identity-isolation-implementation-plan/task-5-brief.md), Task1–4 reports/reviews, and [M1 source-contract preflight](../2026-10-23-alpha1-m0-identity-isolation-implementation-plan/context/m1-source-contract-preflight.md).
- Read-only discovery: [M1 discovery](../2026-10-23-alpha1-m0-identity-isolation-implementation-plan/context/m1-discovery.md), [M1 plan draft](../2026-10-23-alpha1-m0-identity-isolation-implementation-plan/context/m1-plan-draft.md), [SQL Server driver contract](../2026-10-23-alpha1-m0-identity-isolation-implementation-plan/context/sqlserver-driver-contract.md), and [OpenMetadata UI seam discovery](../2026-10-23-alpha1-m0-identity-isolation-implementation-plan/context/ui-seam-discovery.md). The public M1 plan is the sole implementation-plan authority; these remain source research, not competing plans.
- First brief: [M1-1 builder brief](task-1-brief.md).
