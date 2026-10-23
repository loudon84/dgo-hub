# M0 Task1 — scoped fix round 1 re-review

**Round verdict: Approved. Resulting Spec gate: Approved. Resulting Quality gate: Approved.**

Reviewer: GPT-6.1 Sol, 2026-10-23 (Asia/Shanghai). Fix base `68c8657aad4d001ab4cecd6c6e72e6346c311956`; final Head `cd5315439c404e3ab1e88635ff4d28bc0a29cab8`; product fix commit `a15dce871dd7017385e10f8b6dfc3ce18e3c2b50`, followed by the evidence/report commit. Scope is the two original findings and regressions introduced by this fix diff. The unchanged Task1 baseline was not re-reviewed.

## Finding dispositions

### M0-T0-I1 — ADDRESSED

Original title: **Continued E strings still hide a real COMMIT from preflight** (P1 / Important).

At `E:/git/dgo-hub/integration-service/migrations/runner.ts:63`, continuation discovery now walks newline-bearing whitespace, line comments and nested block comments. At `:128`–`:142`, all segments following the initial E string are scanned with backslash escape handling instead of switching to ordinary-string handling. Thus the precise original reproducer's real COMMIT/ROLLBACK returns to the top-level statement scanner. The shared quoted-string scanner at `:51` preserves escaped characters and doubled quotes. Discovery at `:245`–`:248` rejects transaction controls and unsupported lexical forms before a connection is requested.

The implementation also conservatively rejects a backslash-bearing continued E-string segment with `MIGRATION_SQL_LEXING_UNSUPPORTED` when no transaction-control error takes priority. This is an explicit supported-SQL boundary documented at `E:/git/dgo-hub/integration-service/README.md:63`, consistent with the original finding's allowed safe-rejection fix. It is not being represented as a general SQL sandbox. Ordinary legal continuation remains supported.

Regression evidence is concrete:

- `E:/git/dgo-hub/integration-service/acceptance-tests/migration-boundary.test.ts:44` exercises the original COMMIT and ROLLBACK reproducer and asserts `pool.connect()` is never called. The positive continuation case at `:56` is allowed through to the stub connection.
- `E:/git/dgo-hub/integration-service/acceptance-tests/migrations.test.ts:162` copies unchanged 001/002 plus the exact failing 003 form for both controls. It checks the safe transaction-control rejection, absent escaped table, and absent ledger/count zero, proving no earlier pending DDL/ledger was applied.
- Both test files passed in the retained focused 54/54 run described below. No new unresolved correctness doubt requires repeating the PostgreSQL probe.

### M0-T1-I1 — ADDRESSED

Original title: **Pagination drops credentials when its timestamp anchor loses microseconds** (P2 / Important).

At `E:/git/dgo-hub/integration-service/auth/service.ts:429`, cursor validation reads only the owned credential UUID. At `:437`–`:449`, an SQL CTE resolves the native `(created_at,id)` position and the keyset comparison stays entirely inside PostgreSQL. No timestamp used as the ordering boundary passes through JavaScript Date. Cursor validation, CTE anchor resolution, and the list itself all retain the current tenant/user filters (`:430`, `:439`, `:443`). The descending timestamp/UUID order, limit+1 behavior, safe metadata results, and own-anchor contract remain intact.

`E:/git/dgo-hub/integration-service/acceptance-tests/identity-store.test.ts:146` fixes timestamps to the original `.000900Z/.000800Z/.000700Z` scenario, verifies all three IDs in the unpaged reference, and traverses limit-1 pages through exhaustion with an exact ordered three-ID comparison (`:159`–`:170`). Existing malformed and cross-user/cross-tenant cursor tests remain present in the same focused test file. The retained focused run passes this regression.

### M0-T0-I2 — ADDRESSED (carried)

The prior review's addressed disposition remains in force. The helper is not changed by this fix diff, and no new cleanup regression was found in the changed tests/evidence paths. It was not reopened or independently rerun.

## New Critical / Important breakage in changed code

**None found.** The changed product code is limited to migration string scanning and the credential list anchor. The focused review found no new blocking behavior in those changes. There are no remaining actionable findings from the original review.

## Out-of-scope observations

**None added.** No unchanged-baseline observations were promoted into this fix round. OIDC HTTP/JWKS, MCP transport, site deployment, remote Hermes, and formal product acceptance remain outside this local engineering approval; their prior NOT_RUN/BLOCKED status is not upgraded.

## Evidence and verification boundary

- Read the supplied `task-1-rereview-1-package.txt` (fix commits/stat/diff) once, the appended public Fix round 1 section, and the retained round1 logs before final line verification. No Git diff or full-suite repeat was performed.
- Retained command: `npm test -- acceptance-tests/migration-boundary.test.ts acceptance-tests/migrations.test.ts acceptance-tests/identity-store.test.ts`. Its `round1/focused-test.log` reports Vitest 4.1.12, **3 files / 54 tests passed**, with `focused-test.exit=0`. `npm run typecheck` and `npm run build` have their own retained logs and exit files, each **0**. These are implementation evidence, not newly executed reviewer tests.
- The RED summary explicitly identifies itself as a summary (51 passed / 3 failed), not a reconstructed raw log. The prior independently observed failure remains in the original review/probe. This re-review does not infer raw RED output beyond those retained materials.
- Current branch ref is `feat/alpha1-implementation` at the requested final Head. Both round1 seven-file digest manifests agree, and all seven current file SHA256 values match them. Unchanged 001 remains `600491b647d88dd2f282a425afe1005e7fe2c4c87a67b30570de52408a7f2251`.
- Retained round1 lifecycle evidence records final foundation container `1e23a0abdf1eb1bf1ec6af8be88ad19409a5f6b39716ad9143cc0f11e82dcd4c`, labels `task0` / run `1462f684-eb54-4957-a2de-730199b101ea`, and identity container `8575e30c53996079184f12536b15d98b37bd8cb017dfa2b9b44a7fddb7be63a6`, labels `task1` / run `974e4acf-8010-4f7d-9104-301c7c962d47`. The earlier foundation retry is separately recorded as `dd6e3c83714ecc9ddc36c7ea078c0f127ddcbfd6e86b8aa64a4da411ce949672`, run `e59632d6-133e-4df4-acbe-ce04ca42a587`. All three have exact ownership and absence-confirmed removal events. Image RepoDigest and runtime image ID remain separately recorded.
- No new test process, fixture, service, environment/secret inspection, product edit, index/HEAD mutation, commit, push, merge, deployment, or agent delegation occurred during re-review. The only write was this scoped report.

Both original blockers are closed, carried I2 remains closed, and no new Critical/Important regression was found. The Task1 local Spec and Quality gates can therefore be marked **Approved** for the reviewed final Head.
