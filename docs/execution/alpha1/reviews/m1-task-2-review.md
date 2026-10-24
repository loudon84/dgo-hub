# M1-2 independent Task-scoped Spec + Quality review

## Spec Compliance

- **FAIL** — M1-T2-I1–I11 below are actionable contract/correctness gaps. M1-T2-I12 is a further input-contract gap.
- **Review scope:** BASE `2c053297685e1aabd7dfb8b681fc120f55c78f1b`, review HEAD `89c6f458d9b775abc8a67a17e05de3dfb8859227`, product source `6bec79c3ab1e48fadeb6ae3449b83aadbe317f0e`. The supplied package's complete integration-service source diff was consumed in sequential ranges, without another Git diff or a separate reread of changed source hunks. Line references below are final-source line numbers mapped from package hunks. No product/Git/index/HEAD mutation, subagent, test, build, Compose command, resource creation, or cleanup was performed.
- **Binding inputs:** complete task-2 brief including controller addenda; task-2-review-brief; implementation report; task-2-review-package; context/m1-task2-interface-preflight; public M1 plan's cross-task rules and M1-2 section; PRD §§8.6 and 9.1–9.4. Historical preflight sketches were interpreted using the later binding addenda, including the approved global guard and server admission fence.

## Strengths

- `integration-service/normalization/canonical.ts:23` uses BigInt scaling and rejects excess scale and overflow; `:38` keeps 20-digit versions as strings. UTF-8 ordering and external identity keys are preserved, and processing metadata is excluded (`:10`, `:55`). The sign omission is separately identified below.
- Caller ownership is explicit in `normalization/apply.ts:216` and `:297`: mandatory PoolClient, no pool connect, transaction commands, release, or swallowed SQL failures. New store exports preserve the legacy ingest path (`normalization/store.ts:6`).
- The new receipt's composite channel/source/entity/domain FK and source-identity FK (`migrations/006_canonical_data_and_receipts.sql:258`) provide meaningful relational boundaries. Unknown-key deletes reserve an identity without inventing required business fields (`normalization/apply.ts:237`, `:317`).
- Frozen proof joins actual approval, PASS report and revision/digest records (`normalization/apply.ts:95`), while ordinary source epoch/generation drift is deliberately not a freshness gate (`:76`). Retirement is checked before receipt version comparison (`:91`, `:227`).
- The guard is acquired before credential locks in the redefined functions and renamed internals have explicit runtime/PUBLIC revocations (`migrations/006_canonical_data_and_receipts.sql:69`, `:117`, `:492`). This fixes the principal reviewed producer/admission paths; I3 identifies the remaining first-lock path.
- API-014 uses the existing revisioned mapping authority and caller transaction (`source-registry/service.ts:665`), while the new function revokes PUBLIC and unrelated runtime EXECUTE (`migrations/006_canonical_data_and_receipts.sql:491`). Human corrections do not update source receipts in that SQL function.
- Retained gate outputs show focused **49/49**, full **240/240 across 15 files**, typecheck and build, all with adjacent exit **0**. Final logs are clean. The SHA/blob manifest records unchanged 001–005 and migration-006 SHA-256 `9c7c6472749ae2db91cde67bb0423e73ae18aa1be2939c5b9e78f4a3985bcbc4` matching the reviewed package's source inventory. Passing runs do not resolve the findings below.

## Issues

### Critical (Must Fix)

None identified.

### Important (Should Fix)

#### M1-T2-I1 — [P1] The actual worker role cannot execute a normal UPSERT

- **Location:** `integration-service/migrations/006_canonical_data_and_receipts.sql:515`; consumers `integration-service/normalization/apply.ts:153` and `:164`.
- Every non-duplicate customer/order UPSERT reads `control.source_identity_remap_fence`. No SELECT on that new table is granted to `hub_worker`. Customer apply then also directly reads `control.auth_subject`, which has no worker column/table read grant in 004–006. A correctly admitted UPSERT run as `hub_worker` therefore fails with SQLSTATE 42501 before canonical DML. The added role test (`acceptance-tests/canonical-apply.test.ts:151`) checks four catalog booleans, and does not exercise this call chain as the service role.
- **Fix:** provide the exact required fence/subject fact reads, using bounded column grants or a narrow fixed-search-path function; keep write authority denied. Run at least one complete customer and order apply under the real worker role and verify denied unrelated authority. Do not grant general auth_subject mutation to make the path pass.

#### M1-T2-I2 — [P1] Negative order amounts, line amounts and unit prices are accepted

- **Location:** `integration-service/normalization/canonical.ts:31`; `normalization/models.ts:50`, `:51`, `:60`.
- The decimal parser permits a negative sign and only rejects nonpositive values for `positive:true`. All three monetary schema fields use the default false flag. Consequently a valid full order with amount `"-1.00"`, unit_price `"-2.000000"` or line_amount `"-2.00"` is accepted and persisted; corresponding numeric columns have no nonnegative CHECK either. This contradicts PRD §9.1 and the binding review brief, which exclude refunds/negative reversals.
- **Fix:** explicitly validate nonnegative amounts/prices, preserving quantity > 0 and exact no-rounding scale checks; add matching DB checks where these canonical invariants are enforced. Cover negative values and valid zero independently.

#### M1-T2-I3 — [P1] Source creation retains the inverse first-lock order and can deadlock tenant disable

- **Location:** new guard acquisition in `integration-service/migrations/006_canonical_data_and_receipts.sql:117`, with unchanged caller `integration-service/source-registry/service.ts:250` and `:252`; `currentOwner` locks tenant/subject at `:197`–`:200`.
- `create()` calls `currentOwner()` before `lock_source_credential()`. Thus it takes tenant/auth_subject row locks before the new global guard. A tenant disable's BEFORE STATEMENT trigger (`006:46`) takes that guard before waiting for the tenant row. Schedule: Tcreate finishes currentOwner; Tdisable obtains guard and waits for Tcreate's tenant row; Tcreate calls lock_source_credential and waits for Tdisable's guard. PostgreSQL must abort one transaction. Guarding sourceRow(...true) and the definer internals does not fix this independent creation path.
- **Fix:** acquire the common guard at the beginning of every management transaction that will subsequently take these tenant/subject/source locks, including create, and preserve that order through nested calls. Add a bounded two-transaction creation/disable regression using a lock observer; no stress loop is needed.

#### M1-T2-I4 — [P1] Department confirmation can rewrite a customer's department contrary to its actual owner authority

- **Location:** `integration-service/migrations/006_canonical_data_and_receipts.sql:430`–`:439`, especially `:437`.
- The department branch only proves that some enabled same-tenant subject has the requested department, then unconditionally changes every affected customer to it. For customer C owned by sales user A in department D1, create another enabled user in D2 and confirm C's department external key to D2: the function writes C.dept_id=D2 while A's authoritative department remains D1, and commits audit/outbox/epoch effects. Initial apply correctly rejects this contradiction (`normalization/apply.ts:164`), but API-014 bypasses that rule.
- **Fix:** validate the resolved current owner is enabled/business-eligible and that its actual M0 department equals the confirmed department for each affected row; reject the whole contradictory correction without mutation. Do not rewrite M0 role/department facts. Test D1→D2 contradiction with independently authored before/after state.

#### M1-T2-I5 — [P1] Remap and apply use incompatible projection digests, and a corrected snapshot is applied again

- **Location:** `integration-service/migrations/006_canonical_data_and_receipts.sql:427`, `:439`, `:451`; `normalization/apply.ts:265`, `:267`, `:348`, `:350`.
- Initial apply hashes a canonical JSON wrapper containing normalized decimal strings, source digest and resolved identity values. Remap instead hashes `to_jsonb(c/o)::text`: a different field set, PostgreSQL JSON whitespace/key ordering and JSON numeric values, including id/version/channel/hub_revision. The order remap hash also omits complete lines. These values cannot be the same authoritative resolved-projection digest, even for the same projection.
- There is a concrete no-op consequence as well: apply snapshot seq N under mapping A; remap to B; approve/admit mapping B; apply unchanged source business content at N+1. Remap deliberately leaves the receipt untouched, so its projection_digest still represents A. The new B digest fails `prior.projection_digest.equals(projection)`, and the code changes core/hubRevision and emits another UPSERT outbox even though the correction is already reflected in core. Decimal-string fixes made to initial JS hashing do not fix this SQL path.
- **Fix:** define one exact projection field set and canonical serializer, with decimal strings and complete lines, shared by initial apply, remap and no-op evaluation. Compare against authoritative current resolved projection state after a human correction while preserving source-content receipt/version semantics. Cover maximum-precision values and remap→unchanged-snapshot recovery.

#### M1-T2-I6 — [P1] A source update can change ownership without invalidating old/new authorization epochs

- **Location:** `integration-service/normalization/apply.ts:278` and `:292`.
- A frozen approved map may contain both owner external keys A and B. Apply customer C with A, then a higher valid source version with B and its matching department. The upsert changes owner_user_id/dept_id, but the entire apply path has no old/new auth_subject epoch update, ownership audit or narrow controlled permission effect. Only the separate API remap function increments epochs (`006:470`). Old/new in-flight authorization snapshots therefore survive a source-driven ownership change, contrary to the caller-transaction ownership/epoch contract.
- **Fix:** detect effective ownership/department changes, lock the affected old/new authority rows in deterministic order, and perform their required epoch/audit effects through a narrow worker-usable controlled seam in the same caller transaction. Keep ordinary receipt replay/no-op free of fabricated effects and retain the role boundary.

#### M1-T2-I7 — [P1] Current owner eligibility is read without a lock that serializes subject revocation

- **Location:** `integration-service/normalization/apply.ts:164`–`:166`; related target checks `migrations/006_canonical_data_and_receipts.sql:395`–`:400`.
- `resolveCustomerOwner` reads enabled/business_role/department without a row lock. The new common guard protects tenant/credential/channel writes, not auth_subject writes. The unchanged M0 `writeSubject` path updates auth_subject directly (`auth/service.ts:244`) without this guard. Schedule: apply validates enabled sales A/D1; M0 disables A or changes A to D2 and commits; apply inserts/updates customer owned by A/D1 and commits. The FK only proves that the subject exists. Remap target checks have the same read-before-late-epoch-update window.
- **Fix:** retain appropriate locks on every subject whose current eligibility/department authorizes the canonical mutation, through commit, using a consistent order with actor/old/new subject locks. Revalidate targets under those locks and ensure M0 disable/department/role updates serialize. Add a narrow two-client negative race.

#### M1-T2-I8 — [P2] Whole-order replacement physically erases old line identities and tombstones

- **Location:** `integration-service/normalization/apply.ts:379`; the test explicitly expects disappearance at `acceptance-tests/canonical-apply.test.ts:396`.
- Every UPSERT deletes all existing lines and inserts fresh default UUIDs. A retained source_line_id receives a different id after each source version, and a line omitted from the next full image leaves no logical deletion row. This violates PRD §9.3's same-transaction logical deletion of disappeared lines and §9.2's stable canonical identity. The current test codifies the wrong physical-disappearance result.
- **Fix:** reconcile by `(tenant_id,order_id,source_line_id)`: preserve existing UUIDs for retained/restored lines, update their full image, and logically delete missing lines in the same transaction. Keep complete-image semantics and the 200-line limit. Assert preserved IDs and retained deleted rows through removal/restoration.

#### M1-T2-I9 — [P2] Unchanged snapshot tombstones always produce another core revision/outbox

- **Location:** `integration-service/normalization/apply.ts:237` and `:317`.
- DELETE branches execute before snapshot unchanged-content handling. Apply a tombstone for source key K at observation N, then the identical tombstone content at N+1: both branches allocate a revision, write receipt and write a DELETE outbox unconditionally. An unknown-key tombstone also creates repeated outbox events despite no core change. The higher observation must advance the receipt high-water without another projection/outbox mutation when content and deletion state are unchanged.
- **Fix:** handle unchanged SNAPSHOT_OBSERVATION content before allocating/writing deletion effects, including unknown-key reservations and existing deleted aggregates. Verify receipt high-water advances while object identity, core/hub revision and outbox remain unchanged.

#### M1-T2-I10 — [P2] Frozen approved configuration is not bound to the channel's connector/mode/version domain

- **Location:** `integration-service/normalization/apply.ts:84`, `:95`, `:118`.
- The channel read proves tenant/source/entity plus context versionDomain/epoch, while the frozen approved config query only checks allowed_entities. It never proves that this channel's connector/mode/version_domain equals the frozen approved config's corresponding values. A mismatched proof assembled from a valid same-source approval and a different-domain active channel can therefore pass verification and write a receipt in that channel's domain. This is precisely the negative trusted-context consistency boundary the primitive is supposed to verify; future immutable job storage cannot replace this missing authoritative tuple check.
- **Fix:** select and validate connector, mode and version domain against the frozen config, and reject the mismatched tuple before any receipt/core mutation. Also compare the report/approval's exact contract reference if those records are part of the frozen proof contract. Add an independently authored same-source mismatched-channel proof rejection; do not compare an accepted job to the latest ordinary config revision.

#### M1-T2-I11 — [P2] Required transaction/role/race acceptance evidence is substantially absent

- **Location:** `integration-service/acceptance-tests/canonical-apply.test.ts:151`, `:423`; API remap exercise `acceptance-tests/source-registry.test.ts:536`–`:577`.
- The complete new test file has one middle-line failure against an initially absent aggregate, not the required T0-preserving failure matrix at header/first/middle/last line plus receipt/outbox. Its outbox rollback count is filtered through a header subquery that becomes empty after rollback, so that assertion cannot detect an orphaned outbox row. There is no persisted 200-line success/201 rejection, no test showing the helper observes no nested transaction/release, and no real-role end-to-end worker apply. The API-014 test seeds its affected core/reference/receipt rows manually; it does not exercise actual apply→remap concurrency, remap rollback, or old/new in-flight authorization epoch behavior.
- Existing guard/admission tests are useful but are not the required remap/apply or owner-eligibility race evidence. The retained logs show the tests that exist passed; they do not show these acceptance scenarios ran. The earlier `canonical-apply-red.log` is a fixture duplicate-tenant error; red2 reaches the missing apply export. Behavioral REDs for snapshot/no-op/numeric/null/ordering are real and retained, but are not evidence for the missing matrix.
- **Fix:** add the explicit targeted acceptance cases with independently authored T0/header/representative-line/receipt/outbox/mapping/epoch expectations and meaningful row scopes; exercise actual service roles. Run the focused additions and then the required final gate for the repaired source, retaining exact fixture lifecycle evidence. This review did not regenerate broad validation.

### Minor (Nice to Have)

#### M1-T2-I12 — [P2] Canonical text and order identifiers omit PRD input limits

- **Location:** `integration-service/normalization/models.ts:24`, `:31`, `:35`, `:48`, `:57`.
- canonicalText has no 2,048-character maximum; phone is unbounded; order_no uses canonicalText rather than the 128-character, no-edge-whitespace business identifier validator. Oversized names/phone or a padded/129-character order number are accepted by this strict canonical boundary despite PRD §9.1. The future intake parser's total request limit does not enforce per-field limits for other callers.
- **Fix:** encode the prescribed field maxima and classify order_no using its identifier contract. Add boundary examples without changing source identifier case or trimming input.

## Focused unchanged-code checks

- **Named risk: new global guard versus every first row lock.** Checked only AuthService's relevant tenant/source credential/epoch/provisioning paths (`auth/service.ts:199`–`:347`), 005's tenant/barrier/epoch internals (`005_source_registry.sql:299`–`:339`), and source-registry currentOwner/create plus locking call sites. Credential upsert/update, tenant write triggers, tenant-disable producer, current-source assertion, sourceRow(...true), apply and remap acquire the new guard before their relevant source/tenant row locks; renamed bypass functions are revoked. The currentOwner-before-guard creation path is I3. No concurrency probe or stress run was performed.
- **Named risk: worker grants versus new direct reads.** Checked only 004 role grants and 005's runtime grant tail. 004 auth_subject reads go to API/MCP, 005 adds no worker subject reads, and 006 does not grant the new fence read. This establishes I1 statically without claiming tenant isolation from the shared role.
- **Named risk: current owner authority changing during apply.** Checked only unchanged AuthService subject update statements (`auth/service.ts:227`–`:253`). They do not participate in the source guard, establishing the concrete schedule in I7.
- No broader codebase crawl or repeated Git diff occurred. No changed source hunk was cut off mid-function. The only changed-file content outside its diff was the expressly permitted unchanged locking call-site check in source-registry/service.ts.

## Evidence and Cannot verify

- Read retained `source-hash-manifest.json`, `attempt-exit-manifest.json`, whitelist metadata, selected RED raw logs, focused-freeze GREEN and all three gate raw logs plus their exit files under `docs/execution/alpha1/m1-task-2-evidence-a34fb9ca-3a69-492a-8a14-ea52a5a154b1/`. Final counts/exits match the report. The manifest records all attempts, including repaired failures; successful final logs have no warnings. Historical failures are preserved evidence, not new final failures.
- The corrected inventory reports 47 PostgreSQL fixtures with 0 unconfirmed cleanup and 15 HTTP fixtures with 0 incomplete cleanup; root's supplied lifecycle audit confirms exact ownership/absence. The report correction concerning container `65be01e04e74373aafe8711e01d1d44abcce46fe9bda2df82fa17a09179d4f4e` is acknowledged. The literal old manual cleanup argv was not preserved; it is not claimed reconstructed. This reviewer performed no new resource query or cleanup.
- **Cannot verify:** source bytes before/after each individual historical test invocation from its raw stdout alone. The supplied source/blob/LF manifest and root freeze audit bind the retained final evidence; this reviewer did not repeat a Git inventory or broad gate to recreate it.
- **Cannot verify:** full caller transaction correctness at future intake/worker durable-job boundaries, frozen admission provenance/persistence, or real production role pools. These are M1-3/M1-4 obligations. Their absence does not waive the primitive's I1/I10 consistency checks.
- **Cannot verify:** production authorization/query invalidation beyond the local retained tests, site runtime, real IdP, production egress, SQL Server, remote Hermes, or deployment. All 48 formal acceptance rows remain NOT_RUN.
- The global all-tenant guard has an explicit, unmeasured throughput cost: unrelated tenants' admission/apply/security-management transactions serialize until commit, including complete 200-line applies. This is the approved Alpha choice, not a performance finding or production-capacity claim. Correcting I3 is still required under that choice.
- No secrets, ambient environment, .env/npmrc/Config.Env, raw certificates, upstream resources or policy-blocked host artifacts were read. No narrow execution probe was required, so no probe fixture or cleanup/absence obligation was created.

## Assessment

**Spec:** FAIL.

**Task quality:** Needs fixes.

**Reasoning:** The append-only migration and caller-owned apply boundary are a useful foundation, and the retained final tests genuinely pass. The worker role is nevertheless unable to execute the new happy path, while ownership authorization, lock ordering, projection consistency and line/tombstone semantics contain concrete contract defects; these require fixes and the missing focused acceptance evidence before task approval.
