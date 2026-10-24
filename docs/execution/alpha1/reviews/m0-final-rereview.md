# M0 final combined fix wave — scoped re-review

Reviewer: GPT-6.1 Sol, independent of the Task5 Luna implementer. Date: 2026-10-24 (Asia/Shanghai).

Exact fix BASE: `caf026a7eefb7005c9c036c2109515fd3e0beac6`. Reviewed HEAD: `a9b0d287da71159f0a119b5da26090f1376e21d9`. Commits: controller review archive `6b504fa`, combined documentation correction `a9b0d28`. Branch: `feat/alpha1-implementation`; worktree clean before this report.

Scope is **M0-F-I1, M0-F-I2, M0-F-M1 and new Important/Critical breakage introduced by this fix diff**. This is the one scoped review after the single combined final fix wave. Unchanged Task0–4 code/evidence and unrelated later-phase product work were not reopened.

## Gates

| Gate | Result |
|---|---|
| Task5 Spec | **PASS** |
| Task5 Quality | **PASS** |
| Whole-M0 local engineering closure, including the required M1 handoff | **PASS** |
| Local M1 entry | **Eligible after the controller records the exact implementation base** |
| Formal/site/product/release acceptance | **BLOCKED / NOT_RUN; unchanged** |

**3 original findings ADDRESSED; 0 NOT ADDRESSED. No new Important/Critical finding identified in the fix diff.** The prior local runtime/identity/isolation PASS and all individual Task0–4 closures remain intact. The engineering conclusion does not certify unimplemented M1 behavior or any site deployment.

## Finding dispositions

### M0-F-I1 — ADDRESSED

The public M1 plan's cross-task rules at `docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md:19`–`:24` now distinguish admission freshness from durable execution authority:

- New intake performs the current tenant/source/credential/entity/config check with the caller's transaction/client; admission-affecting changes advance `source_epoch` and serialize with acceptance.
- A committed job retains immutable approved config/mapping digests, credential identity, channel identity/epoch and accepted security facts. Ordinary pause or config/mapping editing does not cancel it merely because its admission epoch differs.
- Explicit credential revocation/compromise, source-scope security withdrawal/leakage, tenant disable and channel retirement create separately persisted affected-scope security barriers. The worker checks current facts under compatible locks before apply. Later resume/edit/replacement cannot erase a revocation fact.
- Current Owner-binding revision is revalidated for Owner-gated API-007/API-060 actions. Continuing ordinary frozen ingestion does not authorize reuse of an invalidated Owner approval.

The transition table under “Durable-job and channel transition examples” gives concrete after-202 pause/edit, Owner reassignment, security revocation and racing-transition outcomes. M1-3 acceptance and M1-4 execution paragraphs use the same split; the former “any stale source/epoch quarantines” instruction is removed. M1-1 brief deliverable5 and its coverage list, and M1 ledger ruling2, agree. This preserves PRD §8.6 while keeping security withdrawal effective; it does not solve the contradiction by simply ignoring current revocation.

The meaningful planned tests now include frozen R/M/C completion after ordinary pause/edit, new-admission rejection while paused, security-barrier isolation, monotonic revocation facts and one serial admission/transition outcome. These are explicit requirements for subsequent M1 implementation, not claimed executed tests. The original material plan contradiction is closed.

### M0-F-I2 — ADDRESSED

The new cross-task channel rule at public M1 plan `:23` establishes immutable current/pending identity, connector/entity/mode/version domain and monotonically allocated `channel_epoch`. It requires one active primary per tenant/source/entity and never compares REST SOURCE_VERSION with SNAPSHOT_OBSERVATION.

The M1-1 task and brief deliverable6 own first activation, serialization/uniqueness and current/pending channel persistence. First activation consumes the bounded capability test and exact current Owner approval, **without calling future M1-5**. Connector/version-mode switching is explicitly unavailable until the reconciliation capability exists; the first implementation cannot partially activate a pending lane.

M1-5 owns the later complete switching operation: stop old admission; drain or isolate old pending work; stage and validate a complete initial reconciliation; obtain exact current Owner approval bound to the pending channel/config/reconciliation digest; atomically retire the old channel and cut over config plus channel epoch. A pre-cutover failure leaves the old current identity authoritative. Old-epoch replay receives CHANNEL_EPOCH_RETIRED before any version comparison. Canonical UUID continuity uses approved identity mapping.

The table and task test requirements cover two competing first activations/one winner, unavailable early switching, failed pre-cutover work, old-epoch replay, no cross-domain comparison and UUID continuity. M1-2's receipt rules and M1-4's worker rules now consume the same channel contract. The ownership and dependency ambiguity identified by I2 is closed without creating a TESTED/first-activation dependency cycle.

### M0-F-M1 — ADDRESSED

The M1 ledger first line now has the established `# SDD ledger — plan: docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md` form. Its source-reference section, the first brief's opening paragraph and the public M1 plan's planning-source list use relative Markdown links to the actual **old M0 workspace** source preflight, discovery, draft, SQL Server driver contract and UI seam discovery. The SQL Server task's formerly unresolved short reference is replaced by the same authoritative path. Research was not recopied into competing versions; the public M1 plan explicitly remains authoritative.

The first brief and ledger do not invent an implementation base: both wait for scoped review closure and a controller-frozen exact base. The original link/identity handoff issue is closed.

## Evidence and scope verification

- Read the supplied `context/m0-final-fix-review-package.txt`, including the archive/fix commit list, stat and scoped documentation diff; inspected the updated public plan, M1 brief/ledger, appended public/private Task5 reports and retained documentation check script/output/exits.
- Exact current HEAD matches dispatch. Git comparison over BASE..HEAD under `integration-service`, `deploy`, `.dockerignore` and `.gitattributes` returns no changed paths. The fix changes documentation and its check harness/evidence only; no runtime/test/migration behavior was changed or retested.
- Retained `commands-and-results.md` records the exact PowerShell link/semantic check and `git diff --check` commands. `exit-codes.txt` records both exits0. The inspected raw `doc-checks.log` reports **53 links, 0 broken, 12 semantic checks PASS**. The script checks the corrected references and required plan wording; these are documentation checks, not runtime behavior tests. The raw diff-check output contains the disclosed LF-to-CRLF warnings and no whitespace error.
- I evaluated the actual corrected transition instructions and task dependencies in addition to reading the checker result. String-presence checks alone would not establish coherent queue/channel semantics.
- The public/private Task5 reports and status retain the earlier source/test identities and the original build0/entry2/lock2/Gate2 results. They do not relabel the old 191-test run as a new final-HEAD test. Formal rows remain48 NOT_RUN.
- No new test/build/check script run, SQL/Compose/network probe, resource/daemon operation, ambient environment/.env/npmrc/Config.Env read, raw secret/certificate read, blocked-target access/retry, upstream modification, product/index/HEAD mutation or subagent occurred. This report is the sole reviewer write.

## Nonblocking evidence distribution note

At reviewed HEADa9b0, `git ls-files docs/execution/alpha1/m0-task-5-final-fix-checks-20261024/*` includes the checker, commands/results and exit record, but **does not include `doc-checks.log` or `diff-check.log`**. Both safe raw logs exist in the shared worktree and were read during this review; their raw bytes are therefore observed locally, not asserted to be delivered by HEADa9b0. The recorded commands, script, counts/exits and direct review support the scoped documentation decision. During closure the controller reported separately reading and staging those two exact safe paths with text conversion disabled, for inclusion in its subsequent closure commit. That archival action does not change the reviewed source HEAD or require a rerun, broad evidence-directory archive, new implementation wave or additional review seat. This note is not another runtime/behavior blocker.

## Limits and M1 entry

The corrected plan explicitly makes an approved controlled outbound path plus verified exact endpoint reachability a prerequisite for actual IdP/REST/PG/SQL Server probes. It does not claim that the current internal-only API networks can already reach an enterprise JWKS endpoint, and does not direct broad network widening. Local M1 fixtures need explicit owned network attachments.

Real IdP/bindings, site DNS/TLS/ACL/grants, actual eight-component observations/lock/signoffs, source-owner scene approvals, real fixture/independent source Oracle and remote Hermes v0.22.1 build/Profile/handshake/tool registration/authorized answers remain unobserved. Hermes installation remains user-reported. The seven Task4 policy-blocked host targets and separately listed older W0 target were not read or retried; no new cleanup observation is claimed. Historic missing RED/resource provenance is not reconstructed by this correction.

The two material M1 handoff blockers and the original Minor reference issue are closed. The controller can record the exact post-closure implementation base and dispatch the already-authorized **local M1-1** task under the corrected plan/brief. Missing site inputs do not require a new permission pause for that local development. Site/product acceptance remains BLOCKED, all48 formal rows remain NOT_RUN, and no release/site approval is granted.
