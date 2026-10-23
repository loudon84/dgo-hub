# M0 Task2 — independent GPT-6.1 Sol review

**Spec gate: Changes required. Quality gate: Changes required.**

Reviewer: GPT-6.1 Sol, 2026-10-23 (Asia/Shanghai). Exact BASE `04fe627b9b387983395a9aaacd3793e4e37e207b`; reviewed HEAD `5f3e574a2360a446355238a281719cb33bcd1a7b`; product implementation `9240dd1886a91925d158b42a5dd2a07f59fda8e2`. Branch `feat/alpha1-implementation`.

This review covers the Task2 diff and its immediate consumers. Task0/Task1, including I1/I2 and the fixed PostgreSQL pagination boundary, retain their prior local approvals. No new broad baseline review was performed. No applicable AGENTS.md or additional repository coding-standard file was found in the repository or its E:/ ancestors. The code-review skill's two axes were applied directly; the explicit dispatch instruction prohibited additional agents.

## Spec gate — Changes required

Two actionable P2 / Important findings remain. Neither changes the assessment that the controlled OIDC and credential authorization paths fail closed; both concern the new HTTP observability and logging contract.

### M0-T2-I1 — P2 / Important — Reuse the request's logged ID in response envelopes

**Verified location:** `E:/git/dgo-hub/integration-service/ingestion-api/identity-routes.ts:15` (success); the same defect occurs at `:32` (failure) and `:39` (404). `E:/git/dgo-hub/integration-service/app.ts:15` disables incoming request-ID trust but leaves Fastify's separate request-ID generator in place.

**Requirement:** `E:/git/dgo-hub/docs/plans/2026-10-23-alpha1-m0-identity-isolation-implementation-plan.md:119` requires a server-generated, traceable per-request ID and a unified envelope/request_id. The Task2 brief also calls for a bounded server-generated trace ID. Appendix A.1 determines the envelope shape.

**Failing case and consequence:** For an ordinary successful `GET /hub/v1/me`, Fastify logs its own request ID while `envelope()` creates an unrelated UUID after authentication. That response UUID is never attached to the request logger or logged elsewhere. The same applies to safe errors and 404s. A caller supplying the public `request_id` therefore cannot locate the corresponding server request or failure, despite receiving a field presented as its trace identifier. This also leaves 204 request tracing on a separate identity.

**Verification:** A focused no-database `Fastify.inject` probe ran the reviewed TypeScript through in-memory TypeScript transpilation, used the new logger options with `requestIdHeader:false`, and supplied an in-memory identity/service stub. GET returned 200; `responseRequestIdMatchesAnyLogId:false` and `responseRequestIdAppearsAnywhereInLogs:false`. No raw credentials were used or printed.

**Required correction:** Generate one trusted ID when the request begins and use that same value for the request logger and every success/error/404 envelope. Preserve rejection of client-supplied IDs. Add a focused assertion correlating a response ID with its captured logs, including a failure path.

### M0-T2-I2 — P2 / Important — Stop logging rejected request values through the default URL serializer

**Verified location:** `E:/git/dgo-hub/integration-service/ingestion-api/logging.ts:6`–`:8`. The helper adds header redaction but retains Fastify's default request serializer. The executable app uses this helper at `E:/git/dgo-hub/integration-service/app.ts:14`–`:15`.

**Requirement:** `E:/git/dgo-hub/docs/plans/2026-10-23-alpha1-m0-identity-isolation-implementation-plan.md:119` says not to write arbitrary incoming strings to service logs and to log only minimal state. The Task2 brief requires secret-free logging on error/validation paths; the review brief explicitly excludes raw tokens and claims from logged fields.

**Failing case and consequence:** `GET /hub/v1/me/agent-credentials?unexpected=<private-value>` correctly returns 422, but Fastify's automatic incoming-request log has already copied the complete request target into `req.url`. Header redaction cannot remove a token or private value supplied in a rejected query/cursor or path. Thus rejection does not enforce the promised logging boundary. The inherited serializer also includes client-controlled host/accept-version fields, rather than the required minimal state. This finding is about the logging behavior of the newly added identity APIs, not Task3 legacy authorization hardening.

**Verification:** The same isolated probe sent an unknown query parameter containing a deliberately non-secret sentinel. It observed `invalidQueryStatus:422`, `rejectedQueryValueAppearsInLogs:true`, and `rejectedQueryLoggedField:"req.url"`. Only booleans and the field name were printed. Inspection of the installed Fastify request serializer confirms it emits the full `req.url` before route validation.

**Required correction:** Configure a minimal request log whitelist that excludes raw request targets/query values and client headers; a static matched route identifier can provide route context. Preserve status/timing and the trusted request ID. Extend log-sentinel coverage to rejected query/path input as well as headers, bodies, and errors.

## Quality gate — Changes required

M0-T2-I1 breaks correlation needed to diagnose the public API's failures. M0-T2-I2 leaves request data in ordinary logs despite the new logger being presented as the safe boundary. These are the same two findings assessed on the quality axis, not additional or cosmetic blockers. No independent Critical/Important defect was found in the other changed code. Indentation or abstraction preferences were not treated as approval gates.

The controlled issuer/audience/JWKS configuration, RS256/ES256 restriction, required claims and nbf check, HTTPS/site restriction, explicit local loopback exception, redirect rejection and hostile jku/x5u rejection are consistent with the frozen requirements. Authenticator instances have separate JWKS state. Verified issuer/subject alone reach the approved DB resolver; token tenant/role/department/scopes are not consumed as authorization facts. AuthService remains the source of current identity, normalized idempotency, privacy-preserving revoke, scopes and epochs. HTTP input errors map the internal 400 to 422; first creation and replay both return 201 and replay omits the secret. Whitelisted me/list/create responses and empty DELETE204 follow the requested contract. Importing app.ts has no listener, DB import, or runtime-config read. The helper diff only extends the task label union.

## Evidence and verification boundary

- Read the review brief, complete Task2 implementation brief and final addenda, inherited Task0/Task1 boundaries, approved Task1 rereview and public consumer appendix, supplied diff package, public Task2 report and retained final logs before code/probe review.
- Retained implementation evidence: `npm test` reports Vitest 4.1.12, **11 files / 168 tests passed**, exit **0**; `npm run typecheck` and `npm run build` each have retained logs and exit **0**. These were not rerun by the reviewer. The public report records the focused RSA/EC/JWKS/Fastify/owned-PostgreSQL coverage; code inspection confirms its concrete assertions, including the two-server redirect zero-fetch check. The existing log assertions do not test response/log ID correlation or rejected URL values, explaining why the two findings pass that suite.
- All seven current Task2 source files match `docs/execution/alpha1/m0-task-2-evidence/source-final.sha256.json`. The fixed BASE resolves and current HEAD/branch match dispatch. The auth persistence/types/errors and migrations are unchanged in the Task2 diff. Migration001 SHA-256 is still `600491b647d88dd2f282a425afe1005e7fe2c4c87a67b30570de52408a7f2251`.
- Final Task2 retained fixture: task label `task2`, run label `3616bc4f-5270-4e0a-a70a-29838de113c6`, exact container ID `9c07a1dd87fc480584e43fb8a3fd7d6759e075bb8323b78297f9d56023cef8bd`. Its removal event records ownership confirmed and absence confirmed. Final full-suite task0/task1 runs are separately recorded with task/run labels and exact IDs, likewise with confirmed removal; older retained task0 events are not represented as fresh review runs.
- The reviewer ran only the focused in-memory HTTP/logging probe described above. It created no listener, container or database, used no ambient runtime configuration, and made no external network request. No full-suite repeat, existing-service operation, environment/secret read, product edit, commit, push, merge, deployment, upstream-clone modification or agent delegation occurred. This review report is the only filesystem write.
- Missing real enterprise IdP/site configuration remains an explicit external **BLOCKED** acceptance item, not a Task2 code finding. Local engineering evidence does not approve site SSO, remote Hermes, Task3 MCP/legacy isolation, or all product acceptance IDs.

**Finding counts:** Spec: 2 (worst P2 / Important). Quality: the same 2 (worst P2 / Important); 0 additional findings. Fix and narrowly re-review M0-T2-I1/I2 before marking the Task2 local gates Approved.
