# M1-1 scoped re-review, fix round 1

Reviewer: GPT-6.1 Sol. Date: 2026-10-24. Prior reviewed HEAD `7866b99fa2c098877b91c84f0b728f14ab4fe18f`; fix source commit `6cf6f8ee5442f6fad04d9ccf3e185b08a7ca0715`; fix HEAD `7dedc3f77094b4c6cb56ecfd8c70dad80765e56c`.

**Spec gate: FAIL. Quality gate: FAIL.** Seven original findings are ADDRESSED. I2 and I5 are NOT ADDRESSED in full. One new Important regression in the fix diff is recorded as M1-T1-I10. Further correction/re-review is required before M1-2 implementation.

Scope is I1–I9 and Important/Critical breakage introduced by their fix. Read the full-range review package, appended public/private implementation reports, changed source/seams, retained logs, source identities, cleanup records and controller I5/I6 rulings in `progress.md:42–43`. No fresh broad project review, product edits, commits, subagents, full suite or Compose build was performed. The blocked-host-artifact guard was read before the one necessary owned probe; rejected raw targets were not touched.

## Spec verdicts

| Finding | Verdict | Evidence and remaining limit |
|---|---|---|
| M1-T1-I1 | **ADDRESSED** | `005_source_registry.sql:185` adds narrow definer credential/channel lock functions; manager `sourceRow`, creation, test persistence and activation use them. Functions fix search_path, revoke PUBLIC and grant API execution without giving credential/channel UPDATE access. The retained real `hub_api` create → mapping → test → approve → activate → pause workflow passes. Existing digest/secret-ref negative checks remain. |
| M1-T1-I2 | **NOT ADDRESSED** | Material rotation, secret changes, newest PASS, profile checks and legal activation states were added, and unchanged approved pause/resume is covered. Credential entity-scope changes still bypass invalidation and permit admission outside approved config; confirmed below. |
| M1-T1-I3 | **ADDRESSED** | REST origin is normalized through URL before comparison. The default HTTPS:443 regression now reaches the stubbed fetch with normalized URL; actual local HTTP fixture probing remains covered. This is URL-contract proof, not external TLS/egress proof. |
| M1-T1-I4 | **ADDRESSED** | PostgreSQL permission query adds effective `has_any_column_privilege` checks for INSERT and UPDATE alongside table checks. Retained owned PostgreSQL negative coverage rejects a login with column write grants; positive SELECT-only probing remains. No source DML is used. |
| M1-T1-I5 | **NOT ADDRESSED** | Shared required-target/allowed-target/transform validation now serves API006 and API012; REST type declaration and PostgreSQL physical version/delete type checks are added. The controller's explicit unsupported `sample_ref` **422** contract is implemented/tested as **400**, detailed below. Bounded schema checks do not prove full snapshot completeness, actual enum contents or every business row. |
| M1-T1-I6 | **ADDRESSED** | API013 supplies a typed, read-only candidate preview with source/kind/external-ID binding; API014 provides initial expected_revision 0 confirmation, tenant-derived target lookup, exact enabled Owner + source:approve + reason, and revision conflict. User/department targets use enabled same-tenant M0 facts. Per the controller ruling, customer candidate `resolved:false` and confirmation 404 remain fail closed until M1-2 supplies the actual canonical target lookup; arbitrary UUIDs are not accepted. The pending customer seam is not grounds to reject this scoped fix. |
| M1-T1-I7 | **ADDRESSED** | Approval/activation routes pass expected revision into their action transaction rather than calling source:read `get`. The locked service checks expected revision. Retained HTTP coverage exercises exact Owner with source:approve only and activation with source:write only. |
| M1-T1-I8 | **ADDRESSED** | The new plugin translates parser/media/body-size failures to the Hub envelope; retained HTTP coverage checks request_id and 400/415/413. Route failures remain sanitized. |
| M1-T1-I9 | **ADDRESSED** | Both reports disclose the stale historical test hash rather than relabeling old results. The new manifest gives raw/LF-normalized hashes and Git blobs. All five current working hashes, byte counts and normalized committed bytes independently match the appended manifest. Historical 210/210 is explicitly not evidence for this fix source. |

### M1-T1-I2 — P1 — Entity-scope changes remain outside the approved configuration authority

**Locations:** `integration-service/migrations/005_source_registry.sql:253–269` (`update_source_credential`); current-source proof in `control.lock_current_source` in the same migration and `integration-service/auth/service.ts` `assertCurrentSource`; generation checks in `integration-service/source-registry/service.ts` approval/activation queries.

The new credential generation increments only when secret material/reference changes. `update_source_credential` changes `allowed_entities`, enabled state and revision, but pauses/invalidates only when `secret_changed` is true. Consequently a scope change at unchanged config revision leaves the source ACTIVE with the existing generation and test/approval. Current-source proof checks the credential entity list and config **revision**, but not the approved config's entity set or an active approved entity channel.

**Confirmed scenario:** Start from a tested/approved ACTIVE source whose config, mappings and channel permit only customer. Call the controlled M0 repository method `updateSourceCredential(source, tenant, true, '1', ['customer','order'])`. The row remains ACTIVE, generation 1, credential entities customer+order, config entities customer only. `authenticateSource(token,'order')` followed by transaction-scoped `assertCurrentSource(snapshot,'order',client)` succeeds. No order mapping, approved order config or order channel exists. Pause followed by activation with the old approval also succeeds.

**Consequence:** A fresh intake principal is authorized for an entity outside the tested/approved source contract. The additional epoch is insufficient because a newly authenticated principal receives that epoch. This is the original I2 approval/admission authority gap, now demonstrated for scope, rather than a new task's ingestion implementation.

**Minimum correction:** Treat every relevant controlled credential/config/entity-scope change atomically: advance the appropriate generation/applicability fact, pause/invalidate when the frozen test/approval is no longer applicable, and preserve no-op plus unchanged approved pause/resume. Current-source admission must independently require the requested entity in the approved current config and its active channel, with compatible transaction locks; unsupported credential extras must fail closed even after retest/reapproval. Test extension/removal, stale approval and fresh-principal admission, including credential/config disagreement. Preserve ordinary frozen jobs and the separate durable security barriers; do not require worker equality to the latest admission epoch.

### M1-T1-I5 — P2 — Unsupported sample reference has the wrong status contract

**Locations:** `integration-service/source-registry/routes.ts:151`; `integration-service/acceptance-tests/source-registry.test.ts:432`; controller ruling `progress.md:43`.

The ruling explicitly permits a bounded unsupported seam with `sample_ref` rejected as **422**, instead of ignoring it. The handler throws `AuthError('AUTH_INPUT_INVALID')`, whose route status is 400, and the new regression asserts 400. The shared mapping validator portion of I5 is corrected, but this explicit API012 requirement is not.

**Minimum correction:** Return a safe 422 Hub envelope for this unsupported semantic input and update the focused HTTP assertion to 422. Keep malformed JSON at 400, body-size failure at 413 and media failure at 415. This is a small contract correction; it does not require implementing sample ingestion.

## Quality verdict and new fix regression

**Quality FAIL** follows the confirmed I2 bypass and the new I10 regression. I1, I3, I4 and I8's original failing behaviors are corrected with meaningful retained coverage. I5's remaining status mismatch is a Spec failure, not a reason to demand broader tests.

### M1-T1-I10 — P1 / Important — Credential rotation fails before source-registry onboarding

**Location:** `integration-service/migrations/005_source_registry.sql:237–244`, newly added rotation lifecycle audit in `upsert_source_credential`.

The M0 credential repository supports provision/rotation before a source registry exists; registry creation itself requires a pre-provisioned credential. The new rotation branch updates any registry row, then unconditionally inserts a lifecycle event selected from the credential row. When no registry row exists, that event violates `source_lifecycle_event`'s `(tenant_key,source_id)` FK and rolls the credential replacement back.

**Confirmed scenario:** Provision a tenant and source credential, without creating source_registry. Rotate to a new distinct token through `AuthService.repository.provisionSourceCredential`: it fails `AUTH_INPUT_INVALID`. A direct call of the same definer function on the owned fixture confirms SQLSTATE `23503`, constraint `source_lifecycle_event_tenant_key_source_id_fkey`. Before this fix the rotation had no registry-dependent audit insert. This is an actual regression in the changed M0 authority seam, not a reopening of unrelated M0 findings.

**Minimum correction:** Keep credential rotation/generation/epoch atomic and functional when the registry has not yet been created. Emit registry lifecycle audit/pause effects only for a corresponding registry row, or use an appropriate existing credential audit seam that does not require registry onboarding. Add a regression for pre-registry rotation and retain registered ACTIVE rotation coverage. Do not create a second credential authority or weaken the composite FK.

## Retained verification, identities and cleanup

Evidence root: `docs/execution/alpha1/m1-task-1-fix1-evidence-20261024-b2494338b61240be98a1e3add01f84fc/`.

- `final-focused-test.log`: 27/27 tests, one file; report records exit 0.
- `final-typecheck-rerun.log` and `final-build-rerun.log`: clean output; report records exit 0.
- RED outputs for credential rotation, role workflow, default-port/column permissions and mapping validation were inspected. The partial old-query-observer hang remains partial, with no invented completion or test count.
- Inventory has 19 PostgreSQL and 19 HTTP fixtures. Eighteen PostgreSQL records use `removed`; the interrupted run uses `removed_after_test_harness_deadlock`. All 19 raw lifecycle records report exact ownership and absence after removal. HTTP inventory records closure. This is retained local evidence, not a new live check of user resources.
- Current source manifest independently matches 005 raw/LF SHA-256 `23b9311c6e6d1d8c67214f061eb37a55493e7356cfbcab032eef8019b05edcef`, probe `7780d9e0f59b5cc2339bbd9aae072250e706d2b88ba186519906f390f854b1ea`, routes `3e9394da2fcb621f0b204f296cafb4ece424b716b47721c2dfbab7a969b89007`, service `5c6f3a24172bc52abcb78f9c1223115625ddbaaeea15da1e69e524670246b638`, and test raw `ec3a589ca981f6403f7fc0e91ab4cc501c675cb08b78f4cbf05b2299901d48ee` / committed LF `a7d3becdab741e6e002b731dba6c46502c6a45181f643fbf10db209abd6526d1`.

### One necessary bounded re-review probe

Command, cwd `E:/git/dgo-hub`:

```text
node .superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/review-evidence/fix1-scope-probe.mjs
```

Exit 0 means the harness captured observed outcomes, not that the product scenarios passed. The script checks current source-to-emitted-module equality before using built code. It runs migrations 001–005 on one owned fixture, tests I2 and I10, and uses an injected capability result solely to isolate lifecycle/authorization logic. No external capability endpoint or IdP is contacted and no HTTP listener is created.

Safe artifacts: `review-evidence/fix1-scope-probe.mjs`, `fix1-scope-probe-results.json`, `fix1-scope-postgres-lifecycle.jsonl`.

Owned resource: run `419bd1b5-4c63-46bd-a60e-9a79cda05993`; task label `m1task1`; full container ID `a23eb74d7b7d4e83b6495d4b3c03664851e45ecbe8d4a39441bdb952a0ebbb27`; image `postgres:16.10-alpine`; repo/runtime digest `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`. Exact ID/labels were checked before removal; lifecycle records confirm removal and absence. No review fixture remains.

## Limits preserved

No full 210-test repeat, broad typecheck/build repeat, Compose build, source mutation, user-resource operation, raw secret/certificate/env inspection, external egress widening, remote Hermes or upstream change occurred. Site providers/runtime/IdP, production sources and SQL Server remain unverified; default production providers remain fail closed. Pending customer canonical target lookup, durable intake/apply/worker and full snapshot behavior stay assigned to subsequent tasks. Migration-before-original-RED chronology remains as disclosed. The 48 required product acceptance rows remain NOT_RUN; neither gate is a product/site acceptance claim.
