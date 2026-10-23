# W0 Task 4 report: API/page gap matrix and closeout

- Task state: `implemented`, pending Sol review; W0 broad review remains pending.
- Product acceptance: `BLOCKED` / 48 required A/N/FI results are `NOT_RUN`.
- Date: 2026-10-23 (Asia/Shanghai).
- Repository: `E:\git\dgo-hub`; branch `feat/alpha1-implementation`.
- Source HEAD at review/check time: `1ffd8824b1c00108373823e6239ea63eb23216dc`.
- Scope: documentation only. No production code, tests, upstream clone, `.env`, or dependency files changed. No full typecheck/test suite rerun.

## Deliverables

- `integration-service/contracts/api-gap-matrix.md`: all API-001–059 rows, each with PRD method/path, reuse/adapt/missing classification, M0–M6 phase, source seam/gap, and current test scope. All P01–P12 map to UI-1..UI-5 or an explicit missing aggregate. All required 18 A, 18 N, and 12 FI IDs have phase coverage; phase assignment is not acceptance evidence.
- `integration-service/docs/implementation-baseline.md`: code/test coverage boundaries, W0 engineering versus product readiness, site input gaps and retained backlog.
- `integration-service/docs/upstream-api-assumptions.md`: pinned OpenMetadata/Helix/Hasura contracts and M1/M3/M2 adaptation requirements. Runtime remains `NOT_RUN`.
- `integration-service/docs/hermes-v0.22.1-compatibility.md`: concise M4 handoff; user-reported version remains separate from official tag documentation and unobserved remote runtime.
- `docs/execution/alpha1/status.md`: Task0–3 review status and Task4 pending Sol review, current gate, site input gaps, and superseded roadmap note.
- `docs/plans/2026-10-23-alpha1-m0-identity-isolation-implementation-plan.md`: controller-prepared plan copied and marked `PLANNED`, with implementation authorized after W0 final review.
- `docs/execution/alpha1/w0-readiness-results.json`: machine-readable results with each check's input kind, source SHA, exact JSON and exit code.
- `integration-service/README.md`: distinguishes the legacy runnable prototype and W0 tool readiness from canonical API completion and product acceptance.

## Readiness CLI results

The only build run in this task compiled the existing source before invoking the three readiness CLIs; no test suite ran. Exact JSON is preserved in `w0-readiness-results.json`.

1. Task 1 M0 entry check; input kind `example`; source SHA `1ffd8824b1c00108373823e6239ea63eb23216dc`; expected kind `site`.

   Command: `node dist/scripts/check-m0-entry.js --signoffs ../docs/approvals/alpha1-signoffs.example.json --environment ../docs/approvals/environment-inputs.example.json --expected-kind site`

   Output: `{"status":"BLOCKED","missing":["signoffs:status_not_approved_for_plan","environment:kind_mismatch","example:formal_readiness_rejected"],"example":true,"product_ready":false,"scope":"entry-input-validation"}`

   Exit: `2`. The sample files were recognized as examples; they do not represent an actual site readiness assessment.

2. Task 2 deployment lock release check; input kind `synthetic`; source SHA `1ffd8824b1c00108373823e6239ea63eb23216dc`.

   Command: `node dist/scripts/generate-lock.js --observations deploy/deployment.lock.example.json --pins deploy/upstream-pins.json --release`

   Output: `{"status":"BLOCKED","issues":["environment_kind: release requires site","input_kind: release requires observed deployment data"],"product_ready":false,"scope":"deployment-lock-validation"}`

   Exit: `2`. This checks release-mode rejection of the structural example, not a site deployment.

3. Task 3 Release Gate; input kind `local_check`; recorded run ID `task3-final-20261023`; recorded source SHA `f9abd03f968590ee8fac50ad7916b49453fbb735`.

   Command: `node dist/acceptance-tests/evidence/run-gate.js --run-dir C:\Users\Administrator\AppData\Local\Temp\alpha1-task3-runs\task3-final-20261023`

   Output: `{"status":"BLOCKED","issues":["deployment.lock.json: required file is missing","environment-inputs.json: required file is missing","fixture-manifest.json: required file is missing","golden-consumer/manifest.json: required file is missing","signoffs.json: required file is missing","source-contracts.json: required file is missing","upstream-pins.json: required file is missing"],"product_ready":false}`

   Exit: `2`. This reuses Task 3's previously recorded local check run. The seven missing inputs were not filled with examples.

## Documentation checks

- ID coverage: 59/59 PRD API IDs, 12/12 PRD page IDs, 18/18 A IDs, 18/18 N IDs, 12/12 FI IDs appear in the matrix with phase assignment. No isolated API/page/acceptance ID.
- Link check: all relative Markdown document links in changed Markdown files resolve; external URLs excluded. Result: `PASS`.
- `git diff --check`: `PASS`.
- No behavior changed; RED/GREEN is not applicable.

## Environment, current status, and limits

Site endpoint/auth/Profile bindings, CRM and order source contracts and approved real input, IdP configuration/bindings, site signoffs, and actual deployment observations are absent. Hermes Agent v0.22.1 is user-reported installed on another machine; its runtime build, Profile, MCP initialize/tools/list, authorization behavior and tool prefix were not probed. No real Hermes or Golden Consumer acceptance is claimed. W0 local readiness and product M0–M6 acceptance remain separate.

W0 broad review backlog is preserved:

- Docker 29.8.1/containerd may legitimately report `.Id == RepoDigest == OCI index descriptor`. Task 2 currently rejects equality. Keep a real distribution digest mandatory and never substitute `.Id`; the compatibility contract needs correction in the final review/fix wave.
- Current dependency audit classifies 1 moderate `@vitest/mocker` and 2 critical `tinypool`/Vitest entries in development tooling. `npm audit --omit=dev` reports 0; normalized archived/current lock JSON matches all 255 entries, with the raw digest difference due only to CRLF/LF. No claim that all dependencies are safe; no auto-upgrade.
- Task 1's unreadable-input suite lacks a nonexistent-path case (Task 1 review M1); carry to W0 final checklist.
- Existing backlog remains: identity/same-version conflict, relationship authorization/deletion, restart gate, concurrent publication, and overlapping ETL regressions.

## RED / GREEN

Documentation-only change; there is no new behavior, so RED/GREEN is not applicable. Validation was limited to required documentation ID/link checks and the three specified readiness CLI checks. The unchanged full typecheck/test/build suite was not rerun.

## Task 4 correction round 1 — page ownership fixes

- Review base: `642bd72492abd2cae2ab25a8fa3f44830b054d88`; review source: `.superpowers/sdd/alpha1/task-4-review.md`.
- Scope: documentation-only correction. No code, tests, full suite, build, readiness CLI, upstream source, or environment input changed/read.
- I1: restored the PRD's canonical P03 title **字段与身份映射** and ownership of API-010–014, explicitly including user/department/customer identity mapping; P04 is now **同步任务与隔离**, owning API-017–024/051 and the job/event/quarantine/retry/operation lifecycle. The prior legacy event/failure/watermark/retry routes are described as partial seams; a failure list is not claimed to be a quarantine lifecycle.
- I2: restored P09 **权限验证** with API-045: draft preview against synthetic fixtures and read-only verification of an applied policy as an authorized principal using the fixed template. The existing `/admin/permissions/preview` route accepts caller-supplied tenant/user and columns, echoes requested columns, counts Hub API-view rows with tenant/owner filters, and labels the result a pre-release estimate requiring later Hasura recheck. It does not resolve an authorized principal, use a fixed template ID, inspect the applied Hasura policy, or prove effective permissions. Existing `core.test.ts` checks policy helpers only; no route-level preview or applied-policy verification test was found.
- Kept draft, approval, apply, CAS, revoke and recovery concerns under P08 **授权策略**. Reclassified API-040 policy-revision validation as Missing; the API-045 draft preview does not implement API-040.
- Focused comparison against PRD Appendix B: all 12 canonical page IDs and titles match; each page now carries its Appendix B workflow summary and API ownership. P03/P04/P08/P09 ownership is explicit. Four-page aggregation remains UI-1 through UI-4, with UI-5 for native OpenMetadata and operations/delivery surfaces.
- Relative Markdown link check across changed committed docs: PASS. Page ID/title inventory: 12/12; API-045/API-040 ownership cross-check: PASS. `git diff --check`: PASS.
- No new CLI output or product status is asserted. Site readiness remains BLOCKED; all 48 A/N/FI remain NOT_RUN; W0 broad review remains pending.
