# Alpha.1 implementation baseline

**Review snapshot:** 2026-10-23, root HEAD `1ffd8824b1c00108373823e6239ea63eb23216dc`, branch `feat/alpha1-implementation`. This document records static capability and test evidence. It does not claim a site deployment or product acceptance.

## Current implementation shape

`integration-service/` is one TypeScript integration prototype with PostgreSQL migrations, ingestion routes, a polling ETL worker, normalization/store logic, read-only Helix/OpenMetadata binding checks, Hasura permission publishing, and an MCP server. It is not the PRD's finalized multi-service Hub API contract. The product README and early UI spec describe legacy routes (`/v1/ingest`, `/admin/*`, `/mcp`); the main PRD Appendix A requires canonical `/hub/v1/*` and `/mcp/sales` contracts. Use the [59 API gap matrix](../contracts/api-gap-matrix.md) as the row-level assessment.

## Work completed in W0

| Task | Code/document result | Engineering evidence | Product state |
|---|---|---|---|
| Task 0 | Git baseline and scoped ignore rules | typecheck, tests, build passed at baseline SHA in Task 0 report | NOT_RUN |
| Task 1 | strict environment/signoff schemas and M0 entry readiness CLI; no API-001 or login route | focused schema/CLI tests and review fixes recorded in [Task 1 report](../../docs/execution/alpha1/w0-task-1-report.md) | BLOCKED: site environment, identity bindings, approvals absent |
| Task 2 | deployment lock contract/schema/CLI over declared JSON observations | focused validation and review fixes recorded in [Task 2 report](../../docs/execution/alpha1/w0-task-2-report.md) | BLOCKED: no observed site lock |
| Task 3 | evidence contract, local-check recorder, safe file/digest checks, 48-row release gate | recorder run `task3-final-20261023` recorded `typecheck=0`, `test=0` (63 tests), `build=0` at source SHA `f9abd03f968590ee8fac50ad7916b49453fbb735`; later focused changes are separate commits. See [Task 3 report](../../docs/execution/alpha1/w0-task-3-report.md). | Gate BLOCKED; 48 acceptance rows NOT_RUN |
| Task 4 | documentation matrix, readiness outputs, plan copy and status reconciliation | documentation ID/link checks and three specified CLI checks; Task 4 is implemented, pending Sol review | BLOCKED; no product PASS |

## W0 final fix wave

The final local engineering wave addresses W0-I1–I4 and W0-M1/M2. The deployment lock records required distribution digest provenance and accepts a Docker engine ID equal to the resolved descriptor when runtime and probe identities match. The release Gate anchors its expected source pins to the repository-controlled file and rejects explicit `synthetic:`, `example:`, and `fixture:` authority schemes. The entry CLI has a missing-path regression, and the recorder reads Git path lists with NUL delimiters. Vitest/mocker are pinned to 4.1.12; the final fix report records install, audit, focused portability checks, and current source SHA. W0 engineering remains pending the one scoped Sol review; product M0–M6 remains BLOCKED/NOT_RUN.

The W0 tools validate input shape, internal identity consistency, recorded local checks, and evidence structure. They do not establish remote runtime truth, approver identity, production API completion, or product acceptance. The prior local check records are bound to their captured source SHA; they are not rerun evidence for later commits.

## Test coverage and uncovered behavior

- Unit/integration tests cover money and canonicalization logic, row/column policy helpers, legacy ingest and permission flows, binding field checks, MCP tool definitions/query handling, environment/signoff validation, deployment-lock declarations, and evidence path/digest/Gate logic. See the test files and the three committed W0 reports for exact suite counts and scope.
- They do not cover all 59 canonical Hub endpoint schemas/statuses, complete source configuration and approval, canonical batch job/item/quarantine lifecycle, full ETL snapshot/delete overlap handling, complete governance writes, immutable binding release, production identity/API-046–048 routes, complete policy rollback/recovery, or the P01–P12 UI.
- Task 3's Gate suite tests evidence validation and CLI behavior. Its successful synthetic structure fixture is not product-ready, and its local-check recorder runs only typecheck, `npm test`, and build. Product A/N/FI remain NOT_RUN until backed by actual per-ID evidence.
- The three focused readiness CLIs and their exact machine outputs are in [W0 Task 4 report](../../docs/execution/alpha1/w0-task-4-report.md). Input kinds remain explicit: Task 1 and Task 2 use examples; Task 3 Gate consumes the recorded local-check run whose seven site/evidence manifests are absent.

## Environment and product readiness

Site inputs are not ready. Missing: endpoint/auth/profile bindings, CRM and order source contracts and approved real input, IdP configuration/bindings, site signoffs, deployment observations and production consumer evidence. Hermes Agent v0.22.1 is user-reported installed on another machine; the runtime/build, Profile, endpoint, credentials, and MCP handshake were not observed. The pinned compatibility note and actual probe requirements are in [Hermes v0.22.1 compatibility](hermes-v0.22.1-compatibility.md) (see repo-level report path referenced by Task 4 if the optional copy has not been published).

Formal M0 remains BLOCKED. Synthetic/example inputs are useful for schema checks only. The product gate is independent of W0 engineering readiness.

## Remaining product backlog

- The local fix wave closes the retained W0 lock identity, Gate pins, explicit nonreal authority, test-tool advisory, missing-path coverage, and Git path decoding findings. See [W0 final fix report](../../docs/execution/alpha1/w0-final-fix-report.md) for exact commits and evidence.
- Keep the existing static backlog for identity and same-version conflict, relationship authorization/deletion, restart gate behavior, concurrent publication, and overlapping ETL. These are regression/fix-wave items, not resolved by documentation or W0 readiness CLIs.

## Phase map

The authoritative M0–M6 requirements and dependencies are in the [phase gate checklist](../../docs/plans/phase-gates-alpha1.md). API classification, UI page coverage, and all 48 A/N/FI rows are in the linked matrix above. No phase is marked product-verified by this snapshot.
