## Finding Verdicts

- **M1-T2-I16 — ADDRESSED.** Both post-lock eligibility branches now use `v_subject_role IS DISTINCT FROM 'sales'` (`integration-service/migrations/006_canonical_data_and_receipts.sql:560`, `:566`). This evaluates to true for NULL and deterministically rejects an enabled same-department subject whose sales role has been withdrawn. It preserves rejection for other non-sales roles and acceptance of sales, without changing the previously approved locking/transaction-proof/fence behavior.
- **Behavioral evidence:** `integration-service/acceptance-tests/canonical-apply.test.ts:739` adds an actual hub_worker direct-helper regression. It commits the role withdrawal, explicitly verifies enabled=true/role=NULL/department=sales-east, stages current v2 core/receipt/outbox proof, and expects 42501. After rollback it compares full customer, identity references, receipt, outbox, ownership audit and old/new epochs with T0, then rechecks the withdrawn role. The existing enabled=false lock-wait regression remains unchanged.
- **Previous closures preserved:** I1–I15 remain closed. Their untouched implementations were not re-reviewed in this narrow round.

## New Breakage in the Fix Diff

- **None identified.** The product diff consists of the two null-safe predicate substitutions; the remaining source change is the focused direct-entry regression. Both intended branches were checked against the original I16 diagnosis.

## Out-of-Scope Observations

- None. No unrelated source scan or new scope was introduced.

## Covering Evidence and Limits

- **Review range:** base `d527beb7db6342d8a8092e93fb0eeab6fa386aa9`, HEAD `773e048b5345854f6260d924d573a523ef4841cd`, source `e6cfa2f5c1b777a18e65cacbb9b02702b7f727c0`. Read the complete supplied range commit/stat list and U10 source diff once. The assessment uses the same binding task brief/review brief and original I16; only I16 and this fix's new effects were assessed. No Git command, repeated changed-source read, broad crawl or subagent was used.
- **RED:** retained `red-null-helper-effective.log` shows the actual standalone direct-helper test failing because its promise resolved instead of rejecting, one failed/30 skipped. The no-match filter run is not behavioral evidence. The earlier combined-race failure is preserved and is not the final result.
- **Final gate inspected:** `verified-canonical-apply.log` shows **31/31 passed**; `verified-typecheck.log` and `verified-build.log` show successful commands. `verified-gate-manifest.json` records **exit 0/0/0**, identical start/end hashes and `sourceBytesStableDuringGate=true`. Final outputs are clean. No test/build/typecheck/full suite/Compose command was repeated by this reviewer.
- **Exact provenance:** gate HEAD was `911af6df65411cf6de8fa9cfaa8fe733b9996076` with uncommitted tested source. The gate was not run at e6cfa2f. `source-provenance.json` records e6cfa2f's direct parent as that gate HEAD, the same tested raw/LF hashes, and committed blobs matching the review package. Root independently checked this binding. The intermediate manifest with unavailable wrong-relative-path hashes is not used for final provenance. Migrations 001–005 remain unchanged; 006 SHA-256 is `fb52f395bd0c0f1d29e5234788b39737a922bf0f9928f7e99becfb6be91f3065`.
- **Safe evidence:** inspected the final manifests/logs, relevant RED assertions, explicit 21-file whitelist metadata and inventory metadata in `docs/execution/alpha1/m1-task-2-fix4-evidence-d850a531-11ce-40af-9683-87093c562d45/`. Four owned PostgreSQL fixtures have exact IDs/labels, image facts, ownership/removal/absence evidence, audited by root; no HTTP fixture. This reviewer created no resource, queried no live inventory and performed no cleanup. No untracked/blocked host or scratch target, .env/npmrc, ambient secret/environment, Config.Env or raw certificate material was accessed. Only this report file was written; product/Git/index/HEAD remain untouched.
- **Cannot verify beyond this gate:** future intake/durable-job provenance, worker orchestration, production role pools, global-guard throughput, site runtime, real IdP, production egress, SQL Server, remote Hermes or deployment. These established scope limits do not reopen I16. The 31-test run is canonical-apply coverage, not a newly claimed 255-test whole-suite run. All 48 formal site acceptance rows remain NOT_RUN.

## Verdict

**Fix round:** All scoped findings addressed; no new Critical/Important breakage.

**Spec:** PASS for M1-2 with previous closures preserved.

**Quality:** Approved for M1-2.

**Open task-review findings:** None across I1–I16 after this round. This closes the task-scoped M1-2 review and does not claim whole-M1, whole-branch or formal site acceptance.
