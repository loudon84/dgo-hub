# M0 final engineering review, including Task5

Reviewer: GPT-6.1 Sol, independent of Task5 implementation. Date: 2026-10-24 (Asia/Shanghai).

Reviewed branch: `feat/alpha1-implementation`. Exact HEAD: `caf026a7eefb7005c9c036c2109515fd3e0beac6`. Whole-M0 base: `17d3d28ffe87ebb23e47f167cfe10fe298e6c45c`. The worktree was clean before this report. This report is the only reviewer write; no product edit, commit, test suite, build, Compose operation, resource creation/deletion, environment inspection, secret/certificate read, upstream change, or delegation was performed.

## Dispositions

| Gate | Verdict | Reason |
|---|---|---|
| Task5 Spec | **Needs fixes** | Two material M1 handoff rules do not preserve the authoritative PRD transition semantics. Evidence/status reconciliation itself is satisfactory. |
| Task5 Quality | **Needs fixes** | The queue/current-auth conflation and unspecified channel-switch barrier would leave incompatible instructions for sequential builders. One Minor reference correction is also actionable. |
| Whole-M0 existing runtime/identity/isolation integration | **PASS within the reviewed local engineering scope** | No new Important/Critical runtime defect identified. Task0–4 closures and their separate evidence identities remain intact. |
| Whole-M0 final engineering closure, including required M1 handoff | **Needs fixes** | Task5's two P2 handoff findings must close before dispatching M1-1. This does not reopen the individually approved Task0–4 gates. |
| Site/formal acceptance/release | **BLOCKED / NOT_RUN** | No actual IdP/site approvals/observed eight-component lock/Golden Consumer/remote Hermes observation was obtained. All 48 formal rows remain NOT_RUN. |

**Findings: 2 Important/P2, 1 Minor/P3, 0 Critical/P0/P1.** The two axes share the two material behavioral findings; these are two findings, not four. No style-only smell is raised. No applicable AGENTS.md or separate coding-standard document was found in the reviewed paths. The explicitly prohibited additional review seats were not created.

## Actionable findings

### M0-F-I1 — P2 / Important — Preserve durable jobs across ordinary source edits

**Locations:** `docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md:22` and `:64`; first builder brief `.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/task-1-brief.md:36`; propagated ledger ruling at its `progress.md:24`.

**Authority:** PRD `docs/数据治理与本体集成中台_产品架构与二开说明_v1.0.md:306`, §8.6: active editing pauses admission and already-persisted jobs continue with their frozen configuration. Only source overreach, credential leakage, or channel switching isolates unexecuted events. The same paragraph permits unchanged, still-approved PAUSED configuration to resume.

**Scenario:** A REST batch commits and returns 202 at config R/source epoch E. Before the worker claims it, an operator normally pauses the source or edits a mapping into a new DRAFT revision. The frozen plan bumps source_epoch for that transition and then requires `assertCurrentSource` immediately before acceptance/**apply** commit; M1-4 explicitly quarantines any stale source/epoch. The durable R/E job can no longer finish, although no security revocation or channel retirement occurred.

**Consequence:** Ordinary maintenance invalidates already-accepted work contrary to §8.6. The plan's promise to process frozen configuration and its universal current-source test cannot both be implemented. `source_epoch` is correctly useful for admission races, but its equality with current configuration cannot be the sole lifetime authorization of every durable job.

**Minimal correction:** Freeze separate contracts for (a) intake admission under the current source/tenant/credential/entity/config lock and (b) execution of an already-durable job under its immutable approved config/mapping/channel identity. Explicitly classify ordinary pause/config edits versus security revocation, scope removal/leakage, tenant disable, and channel retirement; retain the applicable security checks without silently cancelling all old jobs or silently allowing revoked work. Define the persisted transition/barrier facts that distinguish those cases. Update the public plan, first brief and ledger consistently. Require focused examples: ordinary edit/pause after 202 finishes using R; no fresh intake while paused; security revocation/channel retirement quarantines unexecuted work; a concurrent admission/transition has one serial outcome. These are future implementation requirements, not a request to run a suite for this documentation fix.

### M0-F-I2 — P2 / Important — Specify channel activation and version-mode switching before schema implementation

**Locations:** `docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md:40`, `:42`, `:48`; first builder brief `task-1-brief.md:36`–`:39` in the M1 workspace.

**Authority:** PRD §9.4 at `docs/数据治理与本体集成中台_产品架构与二开说明_v1.0.md:396` requires pausing the old channel, finishing or isolating in-flight work, initial full reconciliation, Data Owner approval, then incrementing `channel_epoch` and atomically switching configuration. Old-epoch events get `CHANNEL_EPOCH_RETIRED`; REST source versions and snapshot observations are not compared. REQ-SRC-001's INV-SRC-001 at `:621` requires one primary synchronization channel per entity. PRD §13.1 preserves standard object UUID through a switch.

**Scenario:** API-005 edits an ACTIVE REST/SOURCE_VERSION source into DB FULL_SNAPSHOT/SNAPSHOT_OBSERVATION, or two competing activations try to establish the primary channel for the same source/entity. Current plan rules require new config/test/approval and a source_epoch bump. They mention storing `channel_epoch` and “channel_epoch semantics,” but define no operation/transition that allocates the new channel epoch, no primary-channel exclusion, and no reconciliation/approval barrier before activation. The first builder is expected to freeze source lifecycle/schema before the later canonicalizer and snapshot tasks.

**Consequence:** Builders can satisfy the enumerated M1-1 instructions and still activate incompatible version domains in one epoch, compare snapshot observations with REST versions, retire old work incorrectly, or allow two primary lanes. Later tasks would have to invent or revise the already-reviewed registry/activation contract. A source auth epoch is not a replacement for this business version boundary.

**Minimal correction:** Add an explicit channel-switch contract and owning task/interface now: immutable current/pending channel identity and version mode; serialization and single-primary exclusion at activation; drain/isolate rule and old-epoch rejection; initial reconciliation and exact Owner approval; atomic config/channel_epoch cutover with stable canonical UUIDs. Identify how M1-1 can deliver ordinary first activation without circularly depending on M1-5, while a mode/channel switch remains unavailable until the reconciliation capability exists. Add meaningful planned tests for concurrent activation, switch failure before cutover, old-epoch replay, no cross-mode version comparison and UUID continuity. Do not invent another auth store or grant a new scope.

### M0-F-M1 — P3 / Minor — Make M1 discovery references resolve from the new workspace

**Locations:** `.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/progress.md:33`–`:34`; public M1 plan `:80`.

**Scenario/evidence:** The new M1 workspace contains only `plan-path`, `progress.md` and `task-1-brief.md`. Its source references name `context/m1-source-contract-preflight.md`, `context/m1-discovery.md`, `context/m1-plan-draft.md`, and `context/sqlserver-driver-contract.md`, but those files are under the **old M0** workspace. The public plan likewise uses the unresolved short SQL Server context reference. The first brief's main source list remains usable, so this is not a runtime or M1-1 blocker by itself.

**Minimal correction:** Link the existing authoritative files by unambiguous repository-root paths or valid relative Markdown links, and link the pinned UI seam discovery where it will be consumed. Do not copy research into competing authoritative versions. Normalize the new ledger's first line to the established `# SDD ledger — plan: docs/plans/...` form in the same edit; its current explicit Plan ID and `plan-path` already preserve identity, so the header alone is not a second finding. Validate these formerly plain-text references in the documentation link check.

## Whole-phase integration assessment

The supplied range package establishes the complete commit/stat/change scope. I inspected the current migration runner, 002–004 SQL, credential codec/types/repository/service, controlled OIDC and HTTP/error/logging paths, strict MCP/readiness/query/audit boundary, legacy registration guards, worker/publisher entrypoints, Compose/role/secret adapters, proxies and corrected transport/probe paths, together with published M0 requirements and prior task reports/reviews. Existing per-task review evidence is carried forward instead of repeating their broad suites.

| Invariant/seam | Assessment |
|---|---|
| Migrations | 001 bytes independently hash to `600491b647d88dd2f282a425afe1005e7fe2c4c87a67b30570de52408a7f2251`. The continuous checksum ledger, single advisory-lock connection, per-migration transaction and explicit local-only legacy adoption remain. The accepted SQL lexical support boundary is documented; no general malicious-SQL sandbox is claimed. |
| Credentials/current identity | Canonical 43-character opaque tokens hash decoded 32 bytes; global digest/kind authority separates source and agent families. OIDC facts resolve from fixed issuer/sub mapping; management scopes and business role remain independent. Lost mint responses cannot recover secrets. Revoke bumps target credential and subject epochs in one transaction. Fresh still-active sibling authentication reads current facts, rather than permanently invalidating every token. |
| Actual API SQL privileges | API uses 004's fixed-search-path locking functions and only required column privileges. The retained fresh 001–004/27-role proof covers real consumer roles, including the necessary digest-only conflict-target SELECT; source credential access is currently absent and M1 correctly requires explicit additive grants. Supplied PoolClient reuse in the auth repository has no nested BEGIN/COMMIT/release. |
| MCP | Exactly five read-only tools; per-request personal-agent auth; strict defaults; start/after-query/after-audit checks; append-only checkpoint/final-denial audit. Audit failure delivers no business data. Default resolver is NOT_READY, including context; no forced ready, gate write or role/admin fallback was found. Full M2 query semantics remain future work. |
| Worker/publisher | Strict worker returns not-ready before loading/scanning sources. Strict publisher closes through `close_query_gate()` and cannot open through its role. Existing demonstration behavior is restricted to explicit local_lab legacy mode. |
| Isolation | Private service networks, separate sales/management TLS proxies, loopback-only host publishing, independent Hasura metadata login/DB, view-only business read login. Corrected certificate negatives require the intended TLS errors; direct TCP connect is forbidden regardless of protocol; exact-address allowed-side liveness is retained separately. |
| M1 positive seams | One source auth authority; monotonic source epoch extension and caller-client current check are explicitly proposed, not misrepresented as current M0 code. REST/PG TESTED preflight precedes full apply; SQL Server remains inactive until real adapter proof. Controlled secret references, exact Owner binding, API-060 as original 59 + one planned extension, 005 onward migrations, decimal strings/BigInt, aggregate atomicity, durable intake/retries, staged complete snapshots/two-observation deletes/>5% approval, conditional real SQL Server and independent Oracle/FI work are present. I1/I2 above are the remaining behavioral plan defects. |

The OpenMetadata pin is available in the controlled upstream-pins file (`2.0.6-release`, `a695261b19d48411a39502a5c5fc0b453729eb4e`), and the retained UI seam discovery describes the separate enterprise worktree/authenticated shell and token-audience caveat. No reference clone was modified or new worktree created by this review.

## Evidence identity and Task5 checks

- Task0/1/2/3/4 initial and fix counts remain separate: 106; 149 plus focused54; 168 plus focused14; 185 plus focused20 and carried deep-argument fix; Task4 fixed191 plus separate focused2/live probe correction. None is summed or rebranded as a test of final HEAD.
- Git comparison independently shows `9724f627..135b7f1` changes exactly the six integration-service paths recorded in the fixed-run manifest. Recomputed current hashes match **6/6**. `135b7f1..caf026a` changes only the API matrix and baseline Markdown under integration-service. Thus unchanged complete runtime/test/migration continuity is established by Git identity plus captured dirty bytes, while the report accurately calls its own hash check a six-entry subset of 24. Task4 probe changes remain separate.
- Read retained fixed check record/output: runner/typecheck/test/build exit0, 12 files/191 tests. Reviewed prior independent 114-log/559-path whitelist and six-stream blob verification; policy-blocked raw trees are excluded. No recursive archive or raw blocked-target read occurred.
- Independently recomputed all five Task5 output hashes; they match its scratch report: build log `a9c32976...3d0`; entry `d3c51e23...006`; lock `b02ec71c...7ae`; Gate `8f696f56...09b`; exit record `998bb016...495`. Retained actual exits are build0/entry2/lock2/Gate2. Entry rejects example/not-approved/wrong-kind inputs; lock rejects synthetic/non-site release input; Gate reports seven missing scene files. Existing acceptance results independently group to **NOT_RUN=48**.
- The 59 original API rows and 12-page/48-ID structure remain. API-001/046–048 are locally implemented with appropriate caveats; API-059 is an M0 boundary adaptation; API-060 is one explicitly planned extension, not implemented.
- No unresolved runtime correctness doubt required a new probe. These were source/evidence/document semantic checks, not a new full suite, build, SQL grant test or Compose observation.

## Carried/minor/deferred triage and exact limits

- W0-R1 is addressed through Task0 and subsequent independent review. W0-M1's missing-path coverage and W0-M2/other final-wave items remain closed as recorded. W0-R2's compiled-layout claim is explicitly scoped to its dedicated source/dist path proof and corrected report wording; it is not historical full-suite/CLI evidence.
- Migration I1/I2 and credential pagination I1 retain Task1 scoped closures. Task2 request-ID/logging I1/I2 retain scoped closures. Task3 I2–I5 retain closures; the deep raw-argument I1 was closed through Task4. Task3 I5 accumulated-fixture attribution and private hash typo were corrected. Task4 I1/I2/I3 remain addressed; its earlier wrapper exit1 and readiness poll exit2 remain disclosed rather than converted to aggregate exit0.
- Missing historical RED streams, corrected Task3 RED and original Task3 full-run Task0/1/2 resource identities remain honest provenance gaps. Later separate runs do not reconstruct them. No new code gate or invented PASS is inferred from unavailable historical material.
- Same-version/data semantics and ETL overlap are M1; relationship/deletion authorization and permission CAS/recovery are M2; metadata/ontology, Hermes, UI and final recovery/performance remain assigned to later phases. Closed M0 capability prevents those omissions from becoming an enabled business-query bypass.
- API is attached only to private internal management/control networks in the current Compose. Actual external enterprise JWKS connectivity was **not** observed; synthetic `.invalid` startup proved liveness only. Before a configured IdP or REST/PG source capability probe, provide and prove a controlled approved outbound path and exact endpoint reachability. Site ACLs remain external BLOCKED; do not broadly widen networks or assume settings alone supply that route. Local M1 fixtures must use explicit owned network attachments. This is a deployment precondition/limit, not a claimed observed authentication failure or an extra M0 local liveness requirement.
- Real IdP/bindings, site DNS/TLS/ACL and grants, eight-component observations/lock/signoffs, source-owner scene approvals, real fixtures/independent source Oracle and remote Hermes v0.22.1 build/Profile/handshake/tool registration/answers remain unavailable. Hermes installation is user-reported and was not re-queried or upgraded. Local engineering evidence does not replace them.
- Seven policy-blocked Task4 host secret/certificate/env targets, plus the older separately listed W0 target, were not read, deleted, retried or packaged. Prior exact resource-absence records remain the evidence; this review did not query the daemon or claim a new cleanup observation.

## Required next scope

Use **one combined documentation fix wave** for M0-F-I1/I2/M1, then **one scoped independent re-review** of those rules/references and any introduced regression. Align public plan, first brief and ledger; validate links and transition examples. No runtime rebuild/full-suite repeat is warranted if runtime/test/migration bytes stay unchanged.

After those two material plan findings close, record the exact new source base and proceed with already-authorized sequential local M1-1 development using the existing M0 interfaces. Missing site inputs do not require another permission pause for that local work. This report grants no site/product/release approval.
