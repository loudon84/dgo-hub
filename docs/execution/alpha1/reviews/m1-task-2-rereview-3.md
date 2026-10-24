## Finding Verdicts

- **M1-T2-I14 — ADDRESSED.** `integration-service/migrations/006_canonical_data_and_receipts.sql:341` adds DB-owned transaction stamping; `:345` unconditionally overwrites the receipt/outbox `apply_xid` with `pg_current_xact_id()`. For an unconsumed effect, `:538` requires both artifacts belong to the current transaction and `:539` recomputes the resolved current owner/department projection digest, with source digest equality across receipt/outbox. The helper consumes its locked references, and an exactly consumed replay returns without effects at `:528` only after the existing proof/channel/barrier/remap checks. `acceptance-tests/canonical-apply.test.ts:539` covers the existing-customer/partial-core-update/stale-artifact negative with T0 rollback; `:601` proves a worker-supplied historical XID is overwritten; the amended actual apply test proves matching current receipt/outbox XIDs. The approved minimal DB transaction binding is implemented without caller flags, timestamps or xmin.
- **M1-T2-I15 — ADDRESSED for the original lock-order defect.** `migrations/006_canonical_data_and_receipts.sql:547` locks the complete derived subject set in deterministic C order before reading eligibility at `:558`/`:564`, retaining those locks through caller completion. Audit/reference/epoch changes follow those reads. The direct-helper test at `acceptance-tests/canonical-apply.test.ts:642` prepares valid current-transaction core/receipt/outbox artifacts, observes an actual subject-lock wait against an M0 disable, then verifies rejection and T0 rollback. The new predicate's NULL handling is a distinct breakage identified as I16 below.
- **Preserved closures:** I1–I13 and the previously closed portions of I14/I15 are not re-reviewed. Earlier I1–I5/I7–I12 closures and Fix2's I6/I13 closures remain in effect. This round assesses only the two remaining defects and the new migration/test diff.

## New Breakage in the Fix Diff

### M1-T2-I16 — Important / P1 — A NULL business role passes the new post-lock eligibility check

- **Locations:** `integration-service/migrations/006_canonical_data_and_receipts.sql:560` and `:566`.
- The new PL/pgSQL conditions reject `v_subject_role <> 'sales'`. `business_role` is nullable in the existing identity model; management-only/unassigned subjects can have NULL. In SQL, `NULL <> 'sales'` is NULL. When the subject exists, is enabled, and its department matches, the complete condition evaluates to `false OR false OR NULL OR false`, which is NULL. PL/pgSQL IF does not enter the rejection branch for NULL. Both the user and department branches therefore accept an enabled same-department subject with no sales role. The prior `NOT EXISTS (... business_role='sales' ...)` predicate correctly rejected that case.
- **Concrete regression using the new direct-helper fixture:** use the valid v2 core/receipt/outbox proof prepared by `canonical-apply.test.ts:642`, but have the M0 authority transaction withdraw B's business role by setting `business_role=NULL`, keeping enabled=true and department=sales-east. The helper waits for the sorted subject lock; after the M0 transaction commits, it reads NULL under that lock and does not raise. It can record the reference/audit/epoch effects and commit the staged canonical assignment to an ineligible B. No caller-supplied fake XID, obsolete artifact, cross-tenant spoof or ordinary-epoch freshness assumption is required.
- **Scope:** this is introduced by the new post-lock predicate. The original timing defect is fixed, and the ordinary applyCustomer JavaScript eligibility check remains outside this new direct-entry defect. Existing passing tests use `enabled=false` and do not cover nullable role withdrawal.
- **Fix:** reject with the null-safe predicate `v_subject_role IS DISTINCT FROM 'sales'` in both branches, retaining the new lock ordering. Add a focused direct-helper NULL-role/role-withdrawal rejection and assert core/reference/receipt/outbox/audit/epochs roll back to T0. No new identity rules or phone/input policy are needed.
- **Verification status:** established statically from SQL three-valued logic and the new predicates; not claimed as an executed probe. The nullable role shape is already represented in the retained canonical fixtures/identity model. No additional source crawl or test execution was required.

## Out-of-Scope Observations

- None. No untouched source issue was promoted into this loop.

## Covering Evidence and Limits

- **Range:** fix base `891fd892e2a9179cebad8aa33cd0d82c726f94aa`; review HEAD `d527beb7db6342d8a8092e93fb0eeab6fa386aa9`; source `d69e9d7a505f3f593e4fb9bd209439cb221540c6`. The complete commit/stat list and supplied U10 migration/test source diff were read once in sequential ranges; final line numbers were mapped from package hunks. No Git command, unrelated source scan, separate changed-file reread or subagent was used.
- **Binding rules:** same task-2 brief/review brief, previous two open findings and controller-approved ledger 046b6e1 transaction binding. The helper retains frozen approval/report/source/channel/security/remap checks before the consumed-reference no-effect return; the patch does not add a current Data Owner/lifecycle freshness condition or alter the ordinary caller-owned transaction contract.
- **Final gate actually inspected:** `docs/execution/alpha1/m1-task-2-fix3-evidence-1ab42e9c-d3a6-453a-b322-11aa63a5ac41/fix3-verified-canonical-apply.log` shows **30/30 passed**. `fix3-verified-typecheck.log` and `fix3-verified-build.log` show successful commands. `fix3-attempt-exit-manifest.json` records **0/0/0** for those final commands. Final logs contain no warnings. No test, typecheck, build, whole-suite or Compose run was repeated by this reviewer.
- **Chronology:** the earlier `fix3-final-canonical-apply.log` is a retained 42P10 failure with 25 passed/5 failed, not the final successful run. The earlier 30/30 logs precede the last collation correction. The last `fix3-verified-*` sequence is the evidence for the reviewed bytes.
- **Source binding:** the gate ran at HEAD `046b6e1d4ea356bee6ffbc68a4f535aa90a5bae6` plus uncommitted migration/test changes, before source commit d69e9d7. It was not run at d69e9d7. The source manifest and root audit bind both final raw/LF hashes and Git blobs to the later source commit, with no intervening source edits. The package blob IDs match the manifest. 001–005 remain unchanged. 006 SHA-256 is `aa2eb3abdfcc7a8b457a7c9e7818487a524432f1b5a841dc65813deac34c92ae`.
- **Resource evidence:** read the formal 24-file whitelist metadata and five-fixture inventory; root audited full IDs/labels, image facts, ownership, exact removal and absence. No HTTP fixtures were created in this round. This reviewer created no resources, queried no live inventory and performed no cleanup. No blocked scratch/host target or untracked run directory was read, staged, copied, moved, deleted, archived or retried. No .env/npmrc, ambient secret/environment, Config.Env or raw certificates were read. Only this review report was written; product/Git/index/HEAD remain untouched.
- **Cannot verify:** runtime execution of the NULL-role counterexample; the retained tests do not cover it. Existing local evidence does not establish future durable-job provenance/worker orchestration, production role pools, guard throughput, site runtime, real IdP, production egress, SQL Server, remote Hermes or deployment. Those established scope limits remain, and all 48 formal site acceptance rows remain NOT_RUN. No new performance claim is made for the approved global guard.

## Verdict

**Fix round:** Both original findings addressed; new Important breakage remains — **M1-T2-I16**.

**Spec:** FAIL.

**Quality:** Needs fixes.

**Coverage:** I14/I15 have direct code and real-PG regression evidence in the final 30/30 gate. The new role predicate requires null-safe rejection before the direct-helper eligibility contract can be approved.
