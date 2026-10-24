# M0 Task5 private scratch report

Worktree: E:/git/dgo-hub
Branch: feat/alpha1-implementation
Base at task start: 7ab55f998f1dc297732884df1b1b8a5087bda40e (clean)
Task scope: evidence/docs/M1 plan only; no product source edits.
Public report: docs/execution/alpha1/m0-task-5-report.md

## Source/review evidence

See public Task5 report table for per-task commits/counts. Do not sum suite counts or attach them to current HEAD. Current branch starts from the controller-declared M0 base. Task4 initial and fix1 review artifacts establish individual closure:

- Task4 initial implementation report source: 135b7f102920f6ee89efb654cd85fb1405007f60.
- Task4 fix1 source: f9ede840b11e65d57287495d69c81348101f509a.
- Task4 fix1 report/evidence commit: 73d9ce92b7ea28db73d7d265f79a55c982f903a.
- Independent disposition: docs/execution/alpha1/reviews/m0-task-4-rereview-1.md, Spec PASS / Quality PASS; I1/I2/I3 ADDRESSED.
- Review says integration-service runtime/test/migration bytes did not change.

The Task4 fixed recorder says starting git SHA 9724f627daceb6315bb05446667eed56c66fd987, dirty=true, and has a 24-entry source/evidence worktree manifest. I read only the safe manifest JSON and compared every integration-service/ entry against the current path; 6 entries, 0 mismatches. Manifest entries for auth/service.ts and migration 004 are recorded in the public M0 report. This is explicitly 6 of 24, not an assertion that 9724 was the full final source SHA. The recorder run record is docs/execution/alpha1/m0-task-4-evidence/final-w0-01a166bd/final-w0-20261024-01a166bd/; check-results file digest listed below.

No Task4 full suite, SQL grant probe, migration test or Compose run was repeated. No historical Task3 resource identities were reconstructed. The seven policy-blocked host paths were not read/retried and are excluded from tracked source and this evidence.

## Controlled current-input validator commands

Working directory for all commands below: E:/git/dgo-hub/integration-service. Input files are tracked examples/synthetic evidence or the existing recorded local-check run. No environment secret/config file, ambient DB value, Docker service, database or remote endpoint was read or contacted.

1. npm run build
   - Exit: 0
   - Captured output: docs/execution/alpha1/m0-task-5-checks-20261024/build.log
   - SHA-256: a9c32976e2c37eda1c02f06b567108e5d945fb32295731ac1f282d490c1083d0
2. node dist/scripts/check-m0-entry.js --signoffs ../docs/approvals/alpha1-signoffs.example.json --environment ../docs/approvals/environment-inputs.example.json --expected-kind site
   - Exit: 2, status BLOCKED, signoffs:status_not_approved_for_plan, environment:kind_mismatch, example:formal_readiness_rejected; product_ready:false.
   - Captured output: docs/execution/alpha1/m0-task-5-checks-20261024/entry.stdout.log
   - SHA-256: d3c51e23083a9dbeca49a2315ef96d94878ed298b580e44f5b6bbbc3250e0006
3. node dist/scripts/generate-lock.js --observations deploy/deployment.lock.example.json --pins deploy/upstream-pins.json --release
   - Exit: 2, status BLOCKED, release requires site kind and observed deployment data; product_ready:false.
   - Captured output: docs/execution/alpha1/m0-task-5-checks-20261024/lock.stdout.log
   - SHA-256: b02ec71cb6d962a1ce88ebcdfae4b6735f04e7cf05f808892b7bd834c1c677ae
4. node dist/acceptance-tests/evidence/run-gate.js --run-dir ../docs/execution/alpha1/m0-task-4-evidence/final-w0-01a166bd/final-w0-20261024-01a166bd
   - Exit: 2, status BLOCKED, missing deployment.lock.json, environment-inputs.json, fixture-manifest.json, golden-consumer/manifest.json, signoffs.json, source-contracts.json and upstream-pins.json; product_ready:false.
   - Captured output: docs/execution/alpha1/m0-task-5-checks-20261024/gate.stdout.log
   - SHA-256: 8f696f5612985eb963650c7b515582c5f54e41adac7432e2c755b2f6cb94809b

Captured exit-codes.txt says build=0, entry=2, lock=2, gate=2; SHA-256 998bb016bd170df450385ebb8aa911c5c87eb02f9e822e3d22c045f494af8495. The Gate's retained acceptance result groups to NOT_RUN=48. These validator invocations do not assess product runtime or make any A/N/FI row PASS.

## Documentation semantic/coverage/link checks

- Relative links in six changed public Markdown files: 52 checked, zero broken. Link inputs were status, Task5 public report, implementation baseline, API gap matrix, M0 plan and M1 plan. (The M1 brief link is separately checked below by explicit path existence.)
- API gap matrix row count: original API-001–059 plus planned API-060 = 60 rows. UI page count and 48 acceptance-ID table are unchanged.
- Existing fixed-run acceptance file: 48 rows grouped NOT_RUN=48.
- M1 public plan task headings: 7, dependency order M1-1 through M1-7.
- M1 append-only migration sequence explicitly names 005, 006, 007 and 008.
- Workspace plan identity, first builder brief and public plan path exist. The brief says no source coding until whole-M0 review and exact post-review source base are supplied.
- git diff --check: exit 0; Git reported only expected LF-to-CRLF checkout warnings for three modified Markdown files. No whitespace error.
- git status at check time showed only docs/reports/check outputs and M1 plan files; no changed integration-service product file. Build output is ignored generated dist.

## M1 plan decisions

M0 AuthService remains source credential authority; one row per (tenant_key,source_id), existing global digest registry and optional caller-owned PoolClient repository methods are reused. Proposed source_epoch/assertCurrentSource(snapshot,entity,client) lock closes the gap that current authenticateSource returns a revision snapshot without later current-state assertion. It is proposed M1 code, not current M0 capability.

Probes: REST and PostgreSQL can produce TESTED after bounded read-only capability/schema/version/delete checks, before snapshot apply. SQL Server cannot be TESTED until its adapter performs the read-only consistent snapshot probe. Secret resolution is deployment injected and accepts only opaque controlled references; no local files, arbitrary URLs, caller credentials, or imagined KMS.

API-060 is explicitly planned (original 59 + 1), not implemented. data_owner_user_id must reference an existing enabled same-tenant M0 subject. A source:write operator assigns/reassigns it with audit; reassignment pauses and invalidates prior test/approval. API-007 and API-060 require source:approve plus exact current-owner user ID; API-060 binds run/source/candidate digest and revision. Scope alone is insufficient. No new scope.

M1 public plan and M1-1 brief are ready, but no M1 code is started. Whole-M0 review at caf026a passed local runtime/identity/isolation and required a bounded docs fix wave for M0-F-I1/I2/M1. This wave is complete; the scoped Sol re-review remains next. Avoid dispatch until that review is closed and the controller freezes an exact implementation base.

## Combined whole-M0 review fix wave (2026-10-24)

Independent whole-M0 review: [public review](../../../docs/execution/alpha1/reviews/m0-final-review.md), exact review HEAD `caf026a7eefb7005c9c036c2109515fd3e0beac6`. The review passed local runtime/identity/isolation and found M0-F-I1/I2/M1 in the M1 handoff. The single combined correction wave made documentation-only edits to the public M1 plan, M1 ledger/first brief, M0 published plan/status, and public/private Task5 reports. No source behavior changed.

- I1: differentiated admission `source_epoch` from durable-job execution; ordinary pause/config/mapping edits stop new intake but accepted jobs continue under frozen revisions. Explicit credential revocation/compromise, source-scope security withdrawal/leakage, tenant disable and channel retirement are separately persisted monotonic security barriers checked before apply. Epoch mismatch alone is not a cancellation reason; frozen jobs cannot bypass a matching barrier.
- I2: M1-1 owns first activation, pending/current immutable channel identity, one-primary serialization, and an unavailable switch path until M1-5. M1-5 owns full reconciliation, exact bound Owner approval, drain/isolation, atomic config and `channel_epoch` cutover, stable UUID preservation and `CHANNEL_EPOCH_RETIRED` old-epoch handling. No cross-mode version comparison.
- M1: normalized the ledger heading and replaced plaintext refs with Markdown links to the authoritative old M0 context artifacts, including UI seam discovery. Discovery notes were linked, not recopied.
- Added the controlled outbound route and exact reachability precondition before actual IdP/source probes. No actual probe, network change, test/build, service, database, or source inspection was conducted in this docs-only wave.
- Existing controlled validators remain build `0`, site entry `2/BLOCKED`, release lock `2/BLOCKED`, Gate `2/BLOCKED`; formal rows remain 48 `NOT_RUN`. Previous Task4 191 test evidence was reused only because the six-entry `integration-service` source subset remained byte-identical to its captured 24-entry manifest; this is not stated as a sole final-HEAD run.

Documentation check commands and exact outputs are in the public [final-fix docs checks](../../../docs/execution/alpha1/m0-task-5-final-fix-checks-20261024/commands-and-results.md): link/semantic checker exit 0 (53 links, 0 broken, 12 assertions PASS) and git diff --check exit 0. The scoped Sol re-review remains pending; M1 code stays undispatched.
