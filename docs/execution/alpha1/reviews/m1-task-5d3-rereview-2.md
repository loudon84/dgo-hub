# M1-5D3 Fix2 scoped rereview

**Spec: PASS. Quality: Approved. Open finding: ADDRESSED. New material findings: 0 Critical, 0 Important, 0 Minor.**

Reviewed product `0112c661c4a543d614ba8685693a8384b8dc7201` against Fix2 base `551a95a8d5143a708743db0653572a3647aded50`, the supplied Fix2 U10 package, and the Fix2 implementation-report appendix. Scope is the sole open P1 from `task-5d3-rereview-1.md` and material breakage introduced by this fix, under the same task brief and binding appendices. The original two P1 findings remain closed from rereview 1. This is a task-scoped acceptance, not whole-M1/phase approval.

## Open finding disposition

**Reject NULL token and NULL lease explicitly in the new unowned fallback state — ADDRESSED.**

`integration-service/migrations/009_snapshot_runs_and_recovery.sql:2529`, `:2579`, `:2623`, and `:2652` now explicitly reject a NULL supplied token, NULL stored token, unequal token, NULL lease, or expired lease before currentness, effect recording, finalization, or retry can proceed. The rejection condition is true for the previously vulnerable `(stored NULL, supplied NULL, lease NULL)` case; it can no longer become an unknown SQL boolean and fall through. Valid non-NULL matching live claims retain their existing path. The diff introduces no grant, canonical-writer, source-state, or retry-policy change.

The regression helper at `integration-service/acceptance-tests/snapshot-runs.test.ts:2264` probes all eight worker-facing operations with NULL tokens. Its `:2295` comparison inspects run/error/token/start/lease/retry facts, operations, effects, canonical deletion, receipt and outbox counts **on the same transaction before savepoint rollback**. The expected returns at `:2326` also reject any success-shaped response. Calls at `:2399` and `:2416` cover both a live replacement claim and persisted unowned fallback. Consequently rollback does not conceal a mutation, and one probe cannot corrupt the next probe's fixture.

## Verification

- Read the complete supplied Fix2 diff once. No changed source file was separately reread, no suite was rerun, and no broader audit was opened.
- Independently verified actual committed blob bytes and raw source bytes against before/after captures for fixed-HEAD build, typecheck and covering test: **12 path/capture records, 60 checks, zero mismatches**. Each check covered actual HEAD, Git blob identity, committed LF SHA-256, raw SHA-256 and raw size for the two changed paths.
- Verified the qualifying RED uses base migration bytes (`9b2a746...`) and the **same acceptance-test bytes as the final commit** (`68e9d7b...`). Its raw stderr shows the NULL-token retry changing `d_error_code` to `NULL_TOKEN_TEST`, creating a lease and changing retry time; the same-transaction assertion fails before rollback. This directly demonstrates the reviewed defect. The initial `D_EFFECTS_INCOMPLETE` fixture failure is correctly labeled diagnostic rather than the qualifying RED.
- Read worktree GREEN and final fixed-HEAD stdout: both are **1 passed / 25 skipped**. The final covering run at `3b55bcab...` passes in 149.49 seconds, with empty stderr. Fixed-HEAD build and typecheck also exit 0. The report correctly retains Fix1's 26/26 run as historical and does not relabel this focused result as a full 26-test rerun.
- Independently verified worker source bytes are unchanged between base and product. Actual built worker bytes are 11,251 bytes with SHA-256 `cb8ff507fb5361c0d57e559b41f6fed6141bd2dea0d75357e0d632c8c792ff70`, matching build metadata and the final D child import records.
- Read both uniquely named final PostgreSQL lifecycle captures: run labels `279b4d3d...` and `dba88d9a...` match their recorded pinned image, container, ownership-confirmed removal and absence. Read final D/C lifecycle records and the exact-PID observation: D PIDs 43212/35044/37660 and C PIDs 17496/26608 match the later absence query at `2026-10-28T05:11:56.9098459Z`. This is a later observation, not an exit-time claim. The final fourth-start record still shows FAILED/start 4, busy=false, C COMPLETE and one preserved effect/receipt/outbox.
- Root independently verified all 51 explicit artifact original/destination hashes and sizes, paired reports and final command exits. Root also verified the separate seven-file Fix1 correction supplement: accurate raw-stderr labels, three unique original-to-destination PostgreSQL lifecycle records, and later exact PID 40852 absence. Those documentary limitations from rereview 1 are closed by that supplemental evidence; the original historical package remains unchanged.

## Assurance limits

This review closes the open D3 NULL-fencing finding and finds no new material breakage in the small fix. It does not claim an unfiltered Fix2 suite, formal 48-case/site acceptance, Hermes, production, E, or whole-M1 completion. Initial implementation's missing pre-implementation RED remains historical; Fix2's genuine RED does not alter it. No source/index/HEAD/branch mutation, subagent, runtime resource operation, secret/config read, blocked artifact or incomplete helper access occurred. Only this rereview report was written.

**Assessment:** all four vulnerable guards now fail closed on absent claim facts, and the regression detects unauthorized writes before rollback in both required states. Spec PASS; Quality Approved.
