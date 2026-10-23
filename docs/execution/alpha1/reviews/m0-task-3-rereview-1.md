# M0 Task3 fix round1 — independent scoped re-review

Reviewer: GPT-6.1 Sol. Implementation: GPT-6 Luna.

- FIX_BASE: `cb0130c5b87897ee320ccf81c26f661baaf6ebeb`.
- Reviewed HEAD: `08764b0ca514bcc039938e9dd06b1b4795092db1`.
- Fix source: `a7ce7d4975f19dbd24e14868eb57304b46fc3e62`.
- Scope: original I1–I5 and breakage introduced by this fix diff. No product edits, commits, additional agents, broad suite rerun or historical resource recovery.

## Gates

**Spec: Needs fixes. Quality: Needs fixes.**

I2–I5 are ADDRESSED. I1 is partially improved but **NOT ADDRESSED**: newly exposed raw argument processing can still escape the mandatory audited safe-error boundary. One Important/P1 remains; no duplicate new finding is opened for the same invariant. No demonstrated unauthorized business result was returned.

## Disposition by original ID

### M0-T3-I1 — NOT ADDRESSED (partial; Important/P1)

The ordinary reproductions are fixed. The application overrides the SDK tools/call handler at `integration-service/sales-mcp/server.ts:179` while preserving registered advertised schemas. Known tools now call runSalesTool's strict Zod validation inside execute, and the retained tests prove safe audited rejection of empty/invalid/forged arguments plus AUDIT_UNAVAILABLE when that audit fails.

However, the override now supplies **unvalidated raw arguments** to execute. At `integration-service/sales-mcp/server.ts:129`, `safeArgsDigest(args)` executes before the try at line133 and before runSalesTool at line136. The helper at line56 uses recursive `JSON.stringify(value)`. Previously SDK validation prevented a deep arbitrary object from reaching this callback; this fix makes the path reachable.

**Exact failing scenario:** An authenticated POST `/mcp/sales` sends normal JSON-RPC2.0 tools/call, id1, name find_customers, arguments.term equal to an object containing10,000 nested `{x:...}` objects ending in the synthetic string `review-value`. The entire JSON body is60,117bytes, below the configured1MiB body limit. A schema should reject term's object type as TOOL_INPUT_INVALID. Instead the digest throws a RangeError before application capture/error/audit handling.

**Observed result:** HTTP200, JSON-RPC `error:{code:-32603,message:"Maximum call stack size exceeded"}`, **zero audit appends**, no server request_id. The control case with the same invalid term object at depth1 returned tool isError=true, stable TOOL_INPUT_INVALID, a server request_id and one audit append. Both requests authenticated; neither performed a business query. This is a controlled new scenario inside the changed raw-dispatch boundary, not an untouched observation or inferred failure.

**Consequence:** A known-tool validation failure can still bypass durable audit and safe stable error routing; the implementation also exposes raw internal diagnostics and loses correlation on this path. This continues I1 and affects the universal I2 guarantee through the same root cause. I2's explicit handled-error branches are otherwise corrected, so this is counted once under I1.

**Required correction:** Validate/normalize or safely bound raw arguments before recursive digest work, and keep every pre-execution operation inside a safe audited boundary. Provide a nonthrowing safe digest strategy for invalid/overdeep inputs rather than moving the same potentially throwing digest into an unaudited catch. Retain stable TOOL_INPUT_INVALID/tool isError and no data; failure to persist its audit must return correlated AUDIT_UNAVAILABLE. Add this bounded deep-invalid request to `integration-service/acceptance-tests/mcp-auth.test.ts`, with both working and failed audit insertion. No full-suite/history rerun is needed.

### M0-T3-I2 — ADDRESSED for the originally identified error paths

`integration-service/sales-mcp/server.ts:47` safeError now carries request_id, and toolErrorResult at line53 covers both primary and supplemental AUDIT_UNAVAILABLE responses. Not-ready/query/current-context errors use the request's server ID. No caller ID is substituted.

Retained focused test updates check not-ready response/audit correlation across all five tools; during-audit denial correlation with both append-only events; request IDs for primary/final audit failure; and a new controlled query-error test correlating response, audit and safe request log. The current `returns a correlated safe query error linked to its audit and request log` test also checks that raw upstream/path/argument/token values stay absent from logs. I1's newly reachable exception remains an open correlated-error escape and is not double-counted here.

### M0-T3-I3 — ADDRESSED

`integration-service/sales-mcp/server.ts:200` uses onRequest before body parsing. The exact `/mcp/sales` boundary performs exact-Origin checks and per-request authenticateAgent there; the resulting principal is kept in a WeakMap keyed by that request object, then required by the route handler. It is not shared across requests. No trust is inferred from Host or forwarded headers.

The retained `keeps present invalid Origin at 403 and accepts absent or exact allowed Origin` test now verifies malformed JSON+invalid Origin403, malformed/missing auth401, unsupported content-type+missing auth401, oversized/missing auth401, invalid-Origin GET/DELETE/OPTIONS403 with no auth calls, and allowed/absent Origin200. The early hook's ordering also covers unsupported/oversized requests with invalid Origin by inspection; those two exact combinations are not separately asserted. No unresolved correctness doubt remains for the original parser-order reproductions.

### M0-T3-I4 — ADDRESSED for the original parser-error path

`integration-service/sales-mcp/server.ts:236` distinguishes authenticated framework errors, sends JSON-RPC2.0 with null id, server request_id and numeric code. Invalid JSON body maps to -32700/Parse error; other parser/request failures map to -32600/Invalid request without raw diagnostics. Initial Origin/auth failures keep their HTTP error envelopes.

The retained `formats authenticated malformed JSON as a safe correlated JSON-RPC parse error` test verifies HTTP400, exact JSON-RPC shape/code/null id, request_id, absent parser sentinel and zero queries. This directly closes the original failing scenario. The old transport.handleRequest catch fallback was not changed; no reachable newly introduced failure through that fallback was demonstrated, so it is not a new blocking finding in this scoped review.

### M0-T3-I5 — ADDRESSED

Both reports line71 label the12 retained lifecycle files as accumulated Task3 inventory and identify only run `4da4ff25-ae40-4524-bba8-a59a3861c6c5`, container `74a510b47d5bb68a3762bdf33a4cb5e25122dab8cf76800e3e02e971c55c2147`, as the retained Task3 fixture inside the original14:45:24UTC/5.36s fullrun. The summary's suite label and finalFullRun section match that correction. The missing Task0/1/2 current-run provenance and no-result bounded recovery remain explicit. No missing IDs were reconstructed.

## Verification and provenance

Read the supplied full fix package, two-commit history and product diff: source `a7ce7d4` plus docs/evidence `08764b0`. Current HEAD matches dispatch. Only server.ts and mcp-auth.test.ts changed product/test behavior; fixed SQL, readiness, append-only ordering, AuthService, runtime/lab guards and JWT logic retain their prior review scope.

Successful retained evidence is rooted at `docs/execution/alpha1/m0-task-3-evidence/fix-round1/af2246ce-645e-46eb-a63e-841b9c142bb9/`:

- `green-3/mcp-auth.command.txt`, `.exit`, `.log`: exact focused `npm test -- --run acceptance-tests/mcp-auth.test.ts`, exit0,1file/20tests passed,23:17:44 local start,3.50s.
- `typecheck-final/typecheck.command.txt`, `.exit`, `.log`: npm run typecheck, exit0.
- `build-final/build.command.txt`, `.exit`, `.log`: npm run build, exit0.
- All3 command records share server SHA256 `f350124605d3bc9e3977e6ced4b84afbbfcabb9b12a9ea8285f81f9a745dc92e` and test SHA256 `266bd74a11a9109445989c9f7d86eac4383ebb5e79517b62864532364996f6dd`. Read-only Get-FileHash agrees with both current files. Their recorded HEAD is the precommit base; the matching file identities establish the tested worktree source without relabeling the old commit as the fix source.
- Initial RED raw log is retained, with13failed/7passed including cascading failures after the shared credential restoration assertion. The corrected RED raw log is lost; that run's claimed10/10 split is an implementation report, not independently retained raw evidence. The later replacement attempt was blocked before execution; this review did not recreate it or change source. This gap does not invalidate the distinct successful retained GREEN/typecheck/build records.
- Read all5 newly added lifecycle files. Each retains the same full container ID through its3 events and final ownershipConfirmed=true/containerAbsentAfterRemoval=true, including `e513a459-2f12-4e87-9db8-1e4c43ce1908`'s removed_after_start_failure event. The green-3 fixture is run `870bb847-d486-4d5c-8fa9-fdecff241dc6`, container `9a8723d1c44c7ccf90c11f6c41bddfcac937f803269dc4c02a0df7d4327b0f51`, created15:17:45.791 and removed15:17:48.108UTC in the retained focused run window. No Docker query/removal was performed by this review.

The original185-test fullrun remains prior-source evidence and was not repeated or claimed for this fix. The retained20 tests establish their covered scenarios, not the deep raw-argument case above.

## Reviewer probe

Only one bounded probe was necessary for the concrete new raw-digest concern. Source: `task-3-rereview-1-probe.mjs`; exact console output: `task-3-rereview-1-probe.log`, both next to this report. It imported existing compiled server output; read-only in-memory TypeScript ES2022/ES-module transpilation comparison confirmed equality with current server.ts, normalizing line endings. No build was executed.

The script uses synthetic principal/AuthService, in-memory query/audit recorder, controlled readiness/executor and a newly owned loopback ephemeral listener. Two invalid-argument requests only, zero business queries, no database/container/user service/upstream access. It exited0 and closed the listener in finally (`owned_loopback_listener_closed=true`). All raw values are synthetic; no secrets or environment were dumped.

## Nonblocking ledger and boundaries

- Private workspace `task-3-report.md:79` abbreviates the test hash incorrectly as `...b62832364996f6dd`, omitting `645`. The public report and all3 command records have the correct full hash above. Correct that private handoff typo with the next report update; it is not an additional product finding or verification failure.
- No unrelated untouched observations are promoted into this fix gate. No real Hasura permission behavior, M2 applied proof, site grants/IdP/proxy/origin values, remote Hermes0.22.1 or production readiness is verified. The default runtime must remain NOT_READY until controlled M2 proof exists. Audit checkpoint success continues to mean execution checkpoint, not network delivery.

**Required next scope:** original I1's raw-argument digest escape and its focused regression; retain I2–I5 closures. Spec and Quality each remain Needs fixes because of that one verified Important defect.
