# M0 Task1 — independent GPT-6.1 Sol review

**Spec gate: Needs fixes. Quality gate: Needs fixes.**

Reviewed exact Base `b2f31bb683ef72a0ff3fda0248c5cb7c8b684a02` → Head `68c8657aad4d001ab4cecd6c6e72e6346c311956`, branch `feat/alpha1-implementation`, on 2026-10-23 (Asia/Shanghai). Implementation was by GPT-6 Luna. Two actionable issues are confirmed below; no cosmetic blocker is raised.

## Findings

### M0-T0-I1 — NOT ADDRESSED — [P1 / Important] Continued E strings still hide a real COMMIT from preflight

- **Verified location:** `E:/git/dgo-hub/integration-service/migrations/runner.ts:92` (ordinary-string scanning after the E-string branch at `:81`); detection at `:138` and acceptance at `:196`.
- **Required behavior:** the final Task1 dispatch requires lexing single/E strings correctly and rejecting transaction controls before any pending migration DDL. The documented supported contract requires `standard_conforming_strings=on`; it explicitly includes E strings. This case stays within that contract and uses no mode changes, dynamic SQL, routine side effects, or arbitrary-SQL sandbox assumption.
- **Failure:** PostgreSQL continues an E string across newline-separated adjacent string literals with its escape semantics. The scanner finishes its E branch at the first literal, then treats the continuation as an ordinary string. Its quote positions diverge from the server's and it mistakes the real top-level `COMMIT` for string contents.
- **Exact reproducer:** after applying unchanged 001 and identity 002, submit this as 003 (the newline after `E'x'` is significant):

```sql
CREATE TABLE control.review_e_continuation(id integer); SELECT E'x'
'\'; SELECT 1; ' ; COMMIT; SELECT 1 / 0; SELECT 'x';
```

- **Observed preflight:** a stub pool was connected once and returned `MIGRATION_CONNECTION_FAILED`; it was not rejected as transaction control. The SQL was then exercised once on the dedicated reviewed PostgreSQL fixture.
- **Observed database result:** `runnerError="MIGRATION_APPLY_FAILED"`, `escaped_table="control.review_e_continuation"`, `ledger_003=0`. The CREATE survived the error while no 003 ledger row existed. This is the same atomicity defect as carried I1, despite the ordinary COMMIT/ROLLBACK cases now being rejected.
- **Consequence:** an accepted SQL file can commit partial DDL outside the runner transaction, leaving schema and migration history inconsistent and breaking a subsequent normal retry.
- **Fix direction:** preserve PostgreSQL E-string continuation semantics during lexical scanning (or safely reject an explicitly unsupported form before connecting). Add this actual continuation case and its rollback equivalent to the pre-DDL regression checks. Post-error transaction-state detection cannot undo an already committed CREATE.

### M0-T1-I1 — [P2 / Important] Pagination drops credentials when its timestamp anchor loses microseconds

- **Verified location:** `E:/git/dgo-hub/integration-service/auth/service.ts:429` and `:441`; the keyset predicate is at `:439`. `created_at` is an unrestricted PostgreSQL `timestamptz` at `E:/git/dgo-hub/integration-service/migrations/002_identity_auth.sql:77`.
- **Required behavior:** stable metadata pagination using the server-authoritative `(created_at,id)` position, while every query remains filtered to the current tenant/user. No signed business-query cursor is required here.
- **Failure:** the anchor query returns `created_at` through pg's default Date conversion, which retains milliseconds. The next query sends that Date back as the precise ordering boundary, although PostgreSQL's stored timestamps can contain microseconds. Rows before the true anchor but after the truncated timestamp are excluded.
- **Exact scenario:** three owned credentials had server timestamps `2026-10-23T00:00:00.000900Z`, `.000800Z`, and `.000700Z`. The public list with limit 100 returned all three. A limit-1 first page returned one item and a cursor; the second page using that cursor returned zero items and `next_cursor=null`. These are valid database timestamps; the test fixture deliberately fixes them to make the loss deterministic.
- **Consequence:** valid credentials disappear while traversing the list, preventing a user from reliably enumerating their credentials for management/revocation. Current tests only compare the first two ordinary-time entries and do not cover the precision boundary.
- **Fix direction:** keep the anchor position inside SQL (for example, resolve the owned UUID anchor in a subquery/CTE and compare its native timestamp), or preserve the exact PostgreSQL timestamp representation without a Date round trip. Keep all owner filters and the current opaque own-anchor contract. Add the deterministic submillisecond case.

## Carried Task0 disposition

| Stable ID | Disposition | Reason |
|---|---|---|
| M0-T0-I1 | **NOT ADDRESSED** | Direct transaction spellings are rejected before connect, but the confirmed E-string continuation bypass still commits DDL without its ledger. |
| M0-T0-I2 | **ADDRESSED** | Startup failure recovers a validated cidfile ID (`helpers/postgres.ts:158`–`:164`), checks exact ID plus task/run labels (`:195`–`:200`), removes only that ID, and requires explicit absence (`:173`–`:185`, `:53`). Unknown identity, label mismatch, rm failure, and inspection ambiguity retain locator/evidence and propagate the original startup error (`:188`–`:191`). Normal close also records `cleanup_unconfirmed` on unconfirmed removal (`:147`–`:152`). |

I2's command-seam regressions cover create-then-throw, removal failure, mismatched labels, and daemon failure during absence verification (`E:/git/dgo-hub/integration-service/acceptance-tests/migration-boundary.test.ts:98`, `:109`, `:131`, `:149`). Pre-cidfile failure retains `start_failure_unresolved` and its locator; it makes no false removed claim. The retained 149-test run covers these tests. This reviewer also observed the helper's successful exact-ID ownership and absence checks for the one focused probe. No additional failure-injection rerun was necessary. W0-R1 was previously confirmed addressed and was not changed by this diff.

## Spec assessment

The identity implementation otherwise matches the reviewed authority and scope:

- `credentials.ts:8`–`:21` enforces canonical unpadded 43-character base64url, exact 32 decoded bytes, and SHA256 of those raw bytes. The global immutable digest/kind registry, constant kind CHECKs, and composite foreign keys in `002_identity_auth.sql:52`–`:104` prevent controlled cross-family registration and preserve tombstones. Agent/source lookup queries use their proper credential table and authority kind (`service.ts:479`, `:507`).
- Tenant key format and immutability are database protected (`002_identity_auth.sql:2`, `:18`), and `credentials.ts:24` derives the PRD execution role. The main PRD §13.1/13.2 was read; its bare-token/raw-byte-digest/tenant-prefixed-role contract takes precedence over old brief prose. Public plan corrections use that authority.
- OIDC resolution does not insert users/bindings. The fixed scope allowlist and current DB identity determine roles/scopes; caller-supplied identity facts do not overwrite them. Create/revoke re-read current bindings and lock relevant identity rows (`service.ts:109`, `:382`, `:454`). Tenant/user composite FKs and owner-filtered list/replay/revoke queries preserve isolation.
- Create normalizes purpose/default TTL, holds a subject lock across registry/credential/receipt insertion, and returns a secret only on the original creation path (`service.ts:137`, `:379`). Replay contains metadata and `secret:null`; the retained concurrent test asserts one credential and one secret-bearing response. Expiry compares server time inclusively at the expiry boundary.
- Revoke privacy and idempotence are implemented at `service.ts:456`–`:468`: non-visible targets are no-ops; first revoke increments credential epoch and target subject epoch in the same transaction. Other credentials can freshly authenticate with the current epoch. Controlled tenant/subject/binding mutations update epochs transactionally.
- Agent snapshots and scope arrays are frozen. Fresh authentication deterministically selects an enabled binding; `assertCurrentAgent` checks the snapshot's original binding and compares current identity/credential epochs and authorization facts (`service.ts:482`, `:519`). It does not silently substitute another enabled binding. Manager-with-null-department and missing-role identities fail business eligibility, while management-only OIDC resolution remains allowed.
- Source provisioning takes an externally supplied secret/secretRef, stores only its digest, and supplies controlled enabled/entities/revision updates. Authentication re-reads those facts and tenant state, and returns a separate frozen SourcePrincipal (`service.ts:298`, `:323`, `:499`). M1 configuration approval/ingestion is outside this task.
- `withAuthTransaction` at `repository.ts:6` reuses a supplied PoolClient without BEGIN/COMMIT/release. Every exported mutation accepts that optional client, so downstream same-database transactions can include the related auth/source changes. The public report's consumer types and error/status table agree with the implementation.

**Spec gate remains Needs fixes** because stable list traversal and the carried migration atomicity guarantee fail under the confirmed scenarios.

## Quality assessment and evidence

- Read the review brief, final dispatch update, Task0 review, public Task1 report, and retained verification evidence before source/probing. Used the code-review skill's separate spec/quality assessment; the explicit task instruction prohibited further subagents, so none were spawned. Explicit ancestor/affected-directory AGENTS checks found none.
- The provided review package names the five exact commits through Head and 31 changed files. Current `.git/HEAD` and the loose branch ref resolve to the requested branch/Head. All 14 current source/test/README SHA256 values matched the retained pre-gate manifest; the four retained manifests agree. Unchanged 001 SHA256 is `600491b647d88dd2f282a425afe1005e7fe2c4c87a67b30570de52408a7f2251`.
- Retained `docs/execution/alpha1/m0-task-1-evidence/final-test.log` reports Vitest 4.1.12, 10 files, **149 passed**, with `.exit=0`. Typecheck/build have their own command logs and `.exit=0`. The implementation's four recorded owned-fixture lifecycles show exact-ID removal and absence confirmation. These are retained implementation results, not a fresh reviewer suite run.
- No full suite, build, typecheck, site, or OIDC/MCP acceptance run was repeated. The only new execution was the bounded probe command below, exit **0**. Before importing existing dist modules, the script transpiled and compared all seven used TS modules in memory with their compiled counterparts; all matched, without writing dist.

```powershell
node 'E:/git/dgo-hub/.superpowers/sdd/2026-10-23-alpha1-m0-identity-isolation-implementation-plan/task-1-review-probe.mjs'
```

Observed probe results:

```json
{"probe":"compiled_identity","matches":7}
{"probe":"e_string_continuation_preflight","connects":1,"error":"MIGRATION_CONNECTION_FAILED"}
{"probe":"microsecond_pagination","storedCount":3,"firstCount":1,"hasCursor":true,"secondCount":0,"nextCursor":null}
{"probe":"e_string_continuation_commit_escape","runnerError":"MIGRATION_APPLY_FAILED","result":{"escaped_table":"control.review_e_continuation","ledger_003":0}}
```

The script is retained beside this report. It uses one fresh fixture and two precise unresolved checks; the pagination setup only changes synthetic rows created by this probe. Probe lifecycle is retained in `E:/git/dgo-hub/.superpowers/sdd/2026-10-23-alpha1-m0-identity-isolation-implementation-plan/task-1-review-probe-lifecycle.jsonl`:

- Full container ID `6f2289a70a681da3a7c63b4d62afa5f5a1c863cf11e8d9f32f6a4da863fe762a`.
- Ownership labels `codex.m0.task=task1` and `codex.m0.run=4d929602-efb2-4f5c-920c-9a44aaa292be`.
- Image reference `postgres:16.10-alpine`; independently observed RepoDigest `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297` and runtime image ID `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`.
- Created `2026-10-23T13:17:00.809Z`; removed `2026-10-23T13:17:03.044Z`, with `ownershipConfirmed=true` and `containerAbsentAfterRemoval=true`. Temporary migration files were removed only after resolving the absolute path and checking its system-temp parent and task prefix.

The tests are meaningful and the public evidence avoids a site/product PASS claim, but the uncovered lexical and timestamp cases are correctness defects, so **Quality gate is Needs fixes**. The missing historical codec/R1 RED raw output is explicitly disclosed in the implementation/prior report; it was not reconstructed or treated as evidence of nonexistent testing.

No product code, existing service, user database/container, reference clone, index, commit, or remote state was changed. No existing secrets, .env, ambient DATABASE_URL, or Docker Config.Env was read; no connection text or raw token was printed. Reviewer writes were limited to this report and its scratch probe/evidence. OIDC/JWKS HTTP, MCP transport, deployment, remote Hermes, and all formal product/site acceptance remain outside this local review; no PASS is inferred for them.
