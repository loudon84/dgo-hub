# M1-1 independent Spec and Quality review

Reviewer: GPT-6.1 Sol. Date: 2026-10-24. Implementation BASE `85b46c693977e709d85cd28c2f62340a67bbfacf`; source commit `24f2af628b4c17a7690d808b1d32c18b64b6e91c`; reviewed HEAD `7866b99fa2c098877b91c84f0b728f14ab4fe18f`.

**Spec gate: FAIL. Quality gate: FAIL.** Nine actionable findings: four P1 and five P2. Do not dispatch M1-2 before the controller's fix/review loop. These gates assess implemented M1-1 behavior; they do not assert product/site acceptance.

## Scope and evidence checked

Read the builder brief, review brief including controlled-profile clarification, public corrected M1 plan, PRD §§8.6/9.4 and API-002–014, both implementation reports, complete 2,470-line review package, changed source and relevant M0 role/auth/HTTP seams. No AGENTS.md or additional repository coding-standard file was found by the scoped file search. Used the code-review skill's two axes without further delegation, as expressly required by this dispatch.

Initial `git status --short` showed only the root-owned M1 progress log dirty. No product source was edited by this review. Migrations 001–004 have no diff against BASE. The new 005 working SHA-256 is `3f832e865995c10e8680a65a01c31094b5337cb38f2001ce453673d9d0ff0082`. Eight of nine reported working source hashes match; the exception is I9 below.

Retained verification was inspected rather than rerun: focused 19/19; final full typecheck exit 0; final tests 210/210 across 13 files, exit 0; build exit 0. Earlier full exits 2/1/2 and focused RED failures are retained. Migration-before-RED is admitted; a LastWriteTime is not creation-order evidence and this review does not reconstruct strict test-first development. All 41 inventory PostgreSQL IDs match raw `removed` lifecycle records with ownership and absence true; the inventory has 11 closed HTTP fixtures. This supports local fixture cleanup, not enterprise reachability.

## Spec findings

### M1-T1-I1 — P1 — The actual API role cannot execute source management writes

**Locations:** `integration-service/source-registry/service.ts:160`, `:222`, `:422`, `:514`; `integration-service/migrations/005_source_registry.sql:281` and `:288`.

The service executes direct `FOR UPDATE` against `source_credential`, but 005 grants `hub_api` SELECT columns and security-definer functions only, with no UPDATE column on that table. Activation also directly locks `source_channel`, which has SELECT/INSERT only. PostgreSQL requires UPDATE privilege for these locking reads. The existing real-role test exercises `authenticate_source`, not manager transactions.

**Confirmed scenario:** On a fresh owned database with migrations 001–005 and `SET ROLE hub_api`, list/get/mapping-read/validate succeed; create/update/mapping-write/test/approve/activate/pause all fail `AUTH_UNAVAILABLE`. Direct credential/channel locking reads return SQLSTATE `42501`, permission denied. This blocks APIs 003/005–009/011 independently of deployment providers.

**Minimum correction:** Make manager locking and writes executable with the real API role through narrowly scoped locking/transition functions or the exact necessary column privileges. Preserve denied digest/secret-ref reads, PUBLIC revocation and fixed search paths; do not cure this with broad table privileges. Prove a complete real-role create → mapping → test → approve → activate → pause workflow plus forbidden reads/functions, including resumed activation's channel lock.

### M1-T1-I2 — P1 — Approval applicability does not cover credential changes, current failed tests, or current endpoint profiles

**Locations:** `integration-service/migrations/005_source_registry.sql:202`; `integration-service/source-registry/service.ts:437`, `:452`, `:484` (especially `:488` and `:500`).

Source credential `revision` deliberately carries config revision, so it is not a credential generation. Rotation increments admission epoch while retaining row ID/config revision and does not change registry lifecycle or invalidate persisted test/approval applicability. Approval and activation compare config/mapping/Owner revisions and that same credential revision only. Activation rejects only ACTIVE, not an invalid DRAFT state; it does not require the currently applicable successful test. Endpoint-profile equality is checked before a test, but never when using the resulting approval to activate/resume.

**Confirmed independent scenarios:** (a) Replace an ACTIVE source token at unchanged config revision: it remains ACTIVE and a fresh snapshot authenticated with the new token passes `assertCurrentSource` without testing/approval; pause/resume also accepts the old approval. (b) After a later probe returns FAIL and sets DRAFT, activation still accepts the former approval. (c) Change injected allowlist profile revision/path after approval: old approval still activates. Synthetic probe outcomes isolate lifecycle/binding logic; these are not claims about a real enterprise endpoint.

**Consequence:** Admission can reopen using evidence that no longer establishes the configured credentials or currently approved endpoint/read contract. PRD §8.6 and the brief require re-testing/re-approval after credential/config changes and unchanged-valid approval for resume.

**Minimum correction:** Persist and check the exact credential-material generation and current test applicability, enforce legal transitions, and revalidate the deployment profile at the relevant test/approval/activation boundaries (including changes during a running probe). Credential-effective edits must pause/invalidate atomically. Preserve ordinary unchanged pause/resume; do not use raw equality to every admission-epoch change as approval validity, since activation/pause themselves advance that epoch. Preserve frozen accepted job contracts and independent security barriers. Add separate regressions for rotation, secret/scope changes, latest failed test, profile change during/after testing, and unchanged approved resume.

### M1-T1-I3 — P1 — Standard HTTPS port 443 is rejected before any REST probe

**Location:** `integration-service/source-registry/capability-probe.ts:119`.

`origin` includes the explicit port, while `new URL(...).origin` removes default ports. For a valid allowlisted HTTPS endpoint on 443, the comparison is therefore `https://host !== https://host:443` and throws PROFILE_INVALID. The local fixture tests use random non-default HTTP ports and miss this.

**Confirmed:** The bounded probe with a syntactically valid `site` HTTPS:443 profile returned `{passed:false, checks:[PROFILE_VALID,PROFILE_INVALID]}` with fetch call count zero. No outbound request was made.

**Minimum correction:** Compare normalized URL origins/host-port identities using the same normalization on each side. Cover HTTPS 443 and explicit non-default ports while preserving exact origin/path and redirect restrictions.

### M1-T1-I4 — P1 — PostgreSQL read-only proof misses column write grants

**Location:** `integration-service/source-registry/capability-probe.ts:168`.

`has_table_privilege(...,'INSERT,UPDATE,DELETE,TRUNCATE')` does not detect column-level INSERT/UPDATE grants. A login can therefore modify approved source columns while this test declares READ_ONLY.

**Confirmed:** An owned login with table SELECT plus `GRANT UPDATE(version)` on the approved table had table-write=false, column-write=true, yet the actual PostgreSQL network probe returned PASS including READ_ONLY and VERSION_DELETE_CONTRACT_VALID. The probe issued no source writes; the independent grant query proves write capability.

**Minimum correction:** Inspect effective column-level write privileges as well as table/role/schema/database privileges, including approved views/objects as applicable. Fail closed for a source account with any prohibited effective write capability. Add positive SELECT-only and negative column INSERT/UPDATE cases without issuing DML to a supplied source.

### M1-T1-I5 — P2 — Mapping validation can approve a contract with no usable standard target

**Locations:** `integration-service/source-registry/service.ts:102`, `:333`, `:389`; `integration-service/source-registry/capability-probe.ts:113` and `:159`.

`target_field` accepts any identifier. API-012 and the test's precheck only require at least one mapping per entity; probes only check that mapped source names exist. Thus `customer.id → nonsense` with identity transform counts as a valid customer mapping, with no required customer identity/business fields or target/transform compatibility. API-012 also accepts `sample_ref` at the route and ignores it. PostgreSQL checks column names/queryability but no declared version/delete type semantics before emitting VERSION_DELETE_CONTRACT_VALID.

**Consequence:** TESTED/APPROVED can describe an unusable mapping contract. This is an M1-1 preflight validation gap, not a demand to implement canonical apply or full snapshot completeness now. PRD §9.1 restricts mappings to defined standard attributes and REQ-SRC-001 requires field/delete semantics before activation.

**Minimum correction:** Share a bounded contract validator between API-012 and API-006: defined entity targets, required fields, compatible approved transforms, and connector version/delete schema evidence. Either implement the declared controlled sample reference or explicitly reject unsupported use. Add negative unknown-target/missing-required/type-contract cases and a meaningful valid mapping. Do not substitute full apply for capability testing.

### M1-T1-I6 — P2 — Initial identity confirmation has no API path and its domain is incomplete

**Locations:** `integration-service/source-registry/service.ts:23`, `:238`, `:346`, `:577`; `integration-service/source-registry/routes.ts:146`.

Creation initializes identity mappings to `[]`; API-013 exposes that empty set; API-014 only modifies a mapping already present. The sole population function, `writeIdentityMappings`, is not routed or called by another current producer. A valid Owner PUT for a new external ID returns 404, confirmed by route injection. In addition, the stored contract is only customer/order → UUID; API-013 specifies user/department/customer mappings, while M0 user/department identities are not generally UUIDs.

**Consequence:** The delivered API-013/014 surface cannot perform the explicitly assigned M1-1 identity-mapping confirmation workflow from a new source; ownership mapping types are not yet a usable contract for the next task.

**Minimum correction:** Define and wire the bounded producer/confirmation path for initial mappings under expected-revision and exact current Owner authorization, with the intended user/department/customer target kinds and tenant validation. Keep it within existing API contracts or record an explicit contract decision. Do not require M1-2 canonical apply to silently manufacture this missing onboarding path. Verify initial confirmation and revision conflict through HTTP.

### M1-T1-I7 — P2 — Approval and activation require an unintended extra `source:read` scope

**Locations:** `integration-service/source-registry/routes.ts:92`, `:105`.

Both handlers call `sourceService.get()` for a revision precheck, which requires `source:read`, before the actual action. An enabled exact bound Owner with only `source:approve` is rejected 403 despite being authorized for approval; an operator with `source:write` alone similarly cannot activate. The first case was confirmed through route injection. Direct service tests with combined scopes conceal this route-only difference.

**Minimum correction:** Pass the expected revision into the transaction that performs the authorized action, and perform the comparison under its existing locks. Preserve the intended source:approve + exact Owner and source:write contracts without requiring an incidental read scope. Test both minimal scopes through the routes. This also removes the split precheck/action race.

### M1-T1-I8 — P2 — Parser failures bypass the required HTTP envelope

**Location:** `integration-service/source-registry/routes.ts:42`.

The new plugin has a not-found handler but lacks the scoped error handler present on M0 identity routes. JSON parsing/content-type/body-limit failures occur before the route try/catch. Malformed JSON returned Fastify's `{statusCode,code,error,message}` without request_id or the Hub error object in a confirmed in-process injection.

**Minimum correction:** Add the equivalent safe scoped framework-error translation for these routes, preserving 413/appropriate status and server request IDs. Cover malformed JSON, unsupported content type and body-limit failure. The observed malformed-JSON response was generic; this review does not claim a raw-secret leak from that particular response.

## Quality findings and gate

Quality FAIL independently follows confirmed I1–I4 and I8. The retained 210 passing tests do not exercise the failed manager role workflow, default HTTPS normalization, column-grant negative case, or invalidation scenarios. This is a coverage gap demonstrated by actual failing behavior, not a request for more broad reruns. I5–I7 are Spec gaps with corresponding route/validator coverage needed during correction.

### M1-T1-I9 — P2 — The reported test-source hash does not identify the reviewed file

**Locations:** `docs/execution/alpha1/m1-task-1-report.md:51` and workspace `task-1-report.md:51` (source identity table).

Both report `source-registry.test.ts` SHA-256 `8167f5fd1df939edc3843bae7e3cc469e943d8660bb44b11e9d52ae69cd9d01`. Actual working bytes hash to `7d1abf6a29c43ebc306bebd27fec70b278786b4e64b78b9f158a8cd6ec5bc88d`; committed LF bytes hash to `18562dc49f98dbb7ae668f4b21da70883dd3a6bbbaca8ae7a83d86d3ab735838`. Normalizing working CRLF to LF exactly reproduces the committed file. Thus the mismatch is not explained by line endings alone. Source is clean in Git, but the report's pre-commit hash is stale/unexplained.

**Minimum correction:** Correct the identity record from exact reviewed bytes, identify newline convention, and associate the final verification with the actual tested source capture. Preserve old results and disclose the discrepancy; do not relabel retained runs or claim exact byte correspondence without evidence. The other eight reported source hashes match working bytes.

## Bounded review verification and resource cleanup

Commands ran from `E:/git/dgo-hub`:

```text
node .superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/review-evidence/narrow-review.mjs
node .superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/review-evidence/permission-probe.mjs
```

The first script was run initially, then expanded once at the controller's request to cover all real-role manager operations. Both successful invocations exited 0 because they capture observed failures as review evidence; they are not passing product tests. Scripts check that TypeScript emission for six relevant modules exactly matches the existing built modules before using them. No broad typecheck/test/build or Compose build was repeated. No `.env`, ambient configuration files, blocked host artifacts, raw secrets/certificates, user services or upstream resources were read or changed.

One initial pre-resource invocation exited 1 because single-file NodeNext transpilation chose CommonJS; the comparison itself was corrected to ESNext, matching the project's existing ESM build. No resource was created on that attempt. Its tool output was `STALE_EMITTED_CODE` at script line 16; it was a review harness error, not a product build failure.

Safe evidence is under this workspace's `review-evidence/`:

- `narrow-review.mjs`; original `narrow-review-results.json`; expanded `narrow-review-results-7aab8e34-7289-4cad-9f75-ae96e3903c9f.json`; `postgres-lifecycle.jsonl`.
- `permission-probe.mjs`; `permission-probe-results.json`; `permission-postgres-lifecycle.jsonl`.

Exactly three review-owned PostgreSQL 16.10 lifecycles were created, with `codex.m0.task=m1task1` and run labels below. Raw lifecycle records include image reference/repo digest and prove exact ownership, removal and absence:

| Run label | Full container ID | Cleanup |
|---|---|---|
| `96fcb74f-f384-4f51-8030-b674d5f886be` | `06fe92d200f1e69af9b9586a7fdc3d84d1d8ae90b13bacc9b90a70c693c58693` | confirmed removed/absent |
| `97ae726a-7c4c-47fc-8970-d7ae84b5df7c` | `6c19f19c212e71b929c48421904ae4b2795fd3445e78b1ab3916cdfda8a65222` | confirmed removed/absent |
| `7aab8e34-7289-4cad-9f75-ae96e3903c9f` | `e009a98359b82c49b55fdaac69fb92271a72bfe186b0fec4792506e4b784c7ba` | confirmed removed/absent |

No review HTTP listener was opened; route probes used Fastify inject. The HTTPS check replaced fetch with a counter and made zero network requests. The PostgreSQL negative test changed grants only on its owned fixture; no source DML was issued by the probe.

## Preserved boundaries and cannot-verify limits

The unchanged M0 migrations and role boundaries were not reopened as a broad review. Source credential authority remains the M0 row plus global digest registry. Caller-owned current-source assertion, first-channel uniqueness and unavailable switching have meaningful local tests. Security barriers are separate persisted append-only facts; future durable intake/worker/apply behavior remains assigned to M1-2 onward and is not rejected for being absent here.

The deployment-controlled endpoint-profile extension is an accepted M1-1 seam. Local REST and separate-login PostgreSQL probes are genuine bounded fixture proof. `startApp` supplies fail-closed defaults and has no production provider adapter wired through its current environment-only entrypoint; a controlled custom bootstrap/injection remains necessary. Missing real providers, approved enterprise egress/IdP, site PostgreSQL and SQL Server evidence are declared limits, not the reason these gates fail. SQL Server remains unavailable/DRAFT, switching remains unavailable until M1-5, and no Hermes/site/product acceptance was performed. The 48 required product acceptance rows remain NOT_RUN.
