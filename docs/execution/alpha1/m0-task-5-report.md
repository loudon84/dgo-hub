# M0 Task5 — Evidence consolidation and M1 handoff

**Status:** Task5 documentation/evidence work complete at base HEAD 7ab55f998f1dc297732884df1b1b8a5087bda40e. Tasks0–4 have individual local engineering Spec/Quality PASS dispositions. This is not the controller's whole-M0 stage review and does not mark M0 site/formal acceptance complete.

## Source and review record

| Task | Product source identity | Local engineering evidence | Independent disposition |
|---|---|---|---|
| M0-0 | W0-R1 8b2ea433; runner 86b5458; I1/I2 prerequisite corrections 2549a13, 98b726b, a15dce8 | Original full run: typecheck/build/test exit 0, 7 files / 106 tests on Task0 source. 001_init.sql digest remained 600491b647d88dd2f282a425afe1005e7fe2c4c87a67b30570de52408a7f2251. | Sol confirmed W0-R1 and migration I1/I2 closure during Task1 review; see [Task1 review](reviews/m0-task-1-rereview-1.md). |
| M0-1 | Identity implementation 1250b960; foundation corrections above; review head cd531543 | Initial full run: typecheck/build/test exit 0, 10 files / 149 tests. Separate correction run: 54 focused tests; evidence/source manifests are retained in [Task1 report](m0-task-1-report.md). | Sol Spec PASS / Quality PASS at cd531543; no site identity claim. |
| M0-2 | OIDC/API implementation 9240dd1; logging/request-ID fix df61be0; review head 7ed0fe5 | Initial full run on 9240dd1: typecheck/build/test exit 0, 11 files / 168 tests. Separate review-fix focused run: identity HTTP test 14/14, typecheck/build exit 0 on the fix source; full count is not relabeled to the fix SHA. | Sol Spec Approved / Quality Approved at 7ed0fe5. |
| M0-3 | Strict MCP source bc40035; audit-boundary fix a7ce7d4; carried Task4 I1 fixes deddfcbe, 9724f62 | Original full run: typecheck/build/test exit 0, 12 files / 185 tests at the original Task3 source. Later focused fix run: 20/20, typecheck/build exit 0 at fix source; historical missing task0/1/2 lifecycle identities remain disclosed. | Task3's I2–I5 closed by its scoped review; carried I1 closed in Task4 initial review. No remote MCP consumer claim. |
| M0-4 | Deployment source bytes captured by the 24-entry Task4 fixed-run manifest; source subsequently committed 135b7f1. Fix1 source f9ede840, handoff/review evidence 73d9ce92. | Fixed recorder run final-w0-20261024-01a166bd: runner/typecheck/test/build exit 0; 12 files / 191 tests. The run's starting HEAD 9724f627 is the recorder base; its dirty source tree and 24-file pre/post manifests identify tested bytes. Fix1 separately: sales probe suite 2/2, exact-host TLS and direct-address live proof; no replacement full suite or SQL/Compose run. | Initial review confirmed Task3 I1; independent fix1 re-review marks I1/I2/I3 ADDRESSED, Spec PASS / Quality PASS. |

Test counts above belong to the exact source version and evidence described in each linked report; they are not summed and not transferred to one final SHA. Task4 fix1 left the integration-service runtime/test/migration files unchanged.

## Fixed Task4 run reuse check

The original fixed-run manifest has 24 captured product/evidence paths. I compared the six entries whose paths are under integration-service/ against their current worktree SHA-256 values; **6/6 match, 0 mismatches**. This is a six-file subset comparison against the original 24-file manifest, not a claim that the old run started at current HEAD or that every file in the 24-path manifest is a source file. In particular:

- integration-service/auth/service.ts: 97549c856becf794fa38f0004f842a781456862b49ae0e5bc0bac75f4eee5a69
- integration-service/migrations/004_alpha1_runtime_security.sql: 11549b816bd696841ab30beb2b2b457617efa929a9ad397976e1409d75ff7298

Because these runtime/test/migration identities remained stable after the probe-only fix, Task5 reuses the exact fixed run rather than repeating the same 191-test/typecheck/build suite. Its check record is [Task4 final fixed run](m0-task-4-evidence/final-w0-01a166bd/final-w0-20261024-01a166bd/). Existing task lifecycle records were not overwritten, and this check did not reconstruct historical Task3 resource identities.

## Honest current-input validator results

From integration-service/, I ran one build and the three controlled CLI validators against existing tracked/example evidence. No signed approval, observed site deployment value, identity binding, eight-component scene, or Golden Consumer record was created:

| Command | Exit | Result |
|---|---:|---|
| npm run build | 0 | CLI build prerequisite; no product readiness conclusion. |
| node dist/scripts/check-m0-entry.js --signoffs ../docs/approvals/alpha1-signoffs.example.json --environment ../docs/approvals/environment-inputs.example.json --expected-kind site | 2 | BLOCKED: signoffs are not approved, the environment kind is local_lab, and the input is explicitly an example. |
| node dist/scripts/generate-lock.js --observations deploy/deployment.lock.example.json --pins deploy/upstream-pins.json --release | 2 | BLOCKED: a release lock requires site kind and observed deployment data; supplied lock is synthetic/example. |
| node dist/acceptance-tests/evidence/run-gate.js --run-dir ../docs/execution/alpha1/m0-task-4-evidence/final-w0-01a166bd/final-w0-20261024-01a166bd | 2 | BLOCKED: seven required formal scene files are missing: deployment lock, environment inputs, fixture manifest, Golden Consumer manifest, signoffs, source contracts, and upstream pins. |

Exact output and exit files: [Task5 validator evidence](m0-task-5-checks-20261024/). Output file digests are listed in the private scratch report. The Gate's 48 results are still **48/48 NOT_RUN**. W0 validation is structure/input checking, not site runtime observation or product acceptance.

## M0 API/status reconciliation

- API-001 and API-046–048 are marked **Implemented locally** in the [API gap matrix](../../../integration-service/contracts/api-gap-matrix.md), with Fastify/real-JWKS/owned-PostgreSQL evidence linked by task. This records local engineering contracts only; the real enterprise IdP, site principal mappings and approved user identities remain unavailable.
- API-059 is recorded as an **M0 identity boundary adaptation** because /mcp/sales exists with per-request personal-agent authentication and origin checks, while complete M4/remote Hermes consumer verification is still outstanding.
- The legacy /v1/ingest/*, /admin/* and demo /mcp stay disabled by default and available only with explicit local_lab plus HUB_ENABLE_LEGACY_LAB=true. M1 /hub/v1/ingest/* is not open yet.
- All 48 formal required acceptance rows remain NOT_RUN; formal M0–M6 stays BLOCKED. Local database grants, local TLS/network probes, auth tests and synthetic records are engineering evidence only.
- Hermes Agent v0.22.1 remains a user-reported installation on a different machine. Its build, endpoint, Profile, handshake, tool registration and authorized answers were not observed; version will not be re-asked.

## Remaining external evidence needed

The site owner/operator must supply or authorize: controlled IdP issuer/audience/JWKS and actual tenant/user bindings; source-owner approved REST/DB contracts and source test identity; current source pins plus actual running identities/config digests/capability probes for all eight required components including OpenMetadata and Helix; signed approvals; approved real input fixture and independent Oracle; and the actual Hermes v0.22.1 endpoint/Profile/handshake and owner-authorized consumer test identities/answers. Site DNS/TLS/egress ACL, database grants, backup/restore and approval records must come from the real target. No repeat user question is necessary for planning or local M1 work.

Task4's owned Docker resources were removed and exact absence checked. Seven generated secret/certificate/env host targets remain because removal was rejected by policy; they are listed in Task4's report and in the private blocked-artifact context. No raw content was read and cleanup was not retried. They remain excluded from Git, Docker build context and any archive.

## M1 implementation handoff

The [M1 detailed plan](../../plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md) and [M1-1 builder brief](../../../.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/task-1-brief.md) are prepared; no M1 source code was added. M1 appends migrations from 005 and reuses M0 AuthService/migration runner. It freezes a new source epoch plus caller-PoolClient assertCurrentSource so activation/pause/rotation and accepted intake share one locked current-source fact. REST/PostgreSQL read-only capability probes precede snapshot apply; SQL Server stays inactive until real snapshot preflight is available.

The plan explicitly adds API-060 (original 59 + one planned extension) for hard-delete candidate approval. The per-source data_owner_user_id must reference an existing enabled same-tenant M0 subject. A source:write operator assigns/reassigns that binding with audit; changes pause the source, advance owner/source revisions and invalidate previous tests/approvals. API-007 source approval and API-060 deletion approval require both source:approve and exact equality with the current bound Owner user ID. API-060 also binds the exact run/candidate digest/revision; scope possession alone cannot approve deletion. No new auth scope or implementation is implied.
