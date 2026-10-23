# M0 Task3 independent review

Reviewer: GPT-6.1 Sol. Reviewed on 2026-10-23. Implementer: GPT-6 Luna.

BASE: `e4662f4a319e4ecc6c243bd8d2caa6086db36c45`.
HEAD: `cb0130c5b87897ee320ccf81c26f661baaf6ebeb`.
Product source commit: `bc40035b4398e68d9514a498b3c0fb3c842a4304`.

## Verdicts

- **Spec: Needs fixes.** Four Important findings affect required audit, safe errors, authentication/Origin ordering, and protocol error formatting.
- **Quality: Needs fixes.** SDK and framework behavior bypass application guarantees at two integration boundaries. One additional Minor evidence attribution correction is required.
- No Critical finding or demonstrated unauthorized business-data delivery. These verdicts cover local Task3 engineering only; they do not authorize deployment or product acceptance.

The two axes were assessed separately against the supplied brief and addenda, Task1/2 approved public interfaces, changed code, installed pinned SDK, tests and retained evidence. No applicable AGENTS.md or separate coding-standard document was found. No style-only smell finding is raised. The explicit review instruction prohibited additional agents, so this review did not delegate.

## Findings

### M0-T3-I1 — Important / P1 — SDK input rejection bypasses mandatory audit and safe error handling

**Location:** `integration-service/sales-mcp/server.ts:121` (registerTool inputSchema/callback boundary), with audit performed only inside the callback at lines 128–149. Immediate dependency: installed SDK `dist/esm/server/mcp.js:165` validates before executing the callback and lines 181–200 return the SDK error text.

**Failing scenario:** A currently authenticated caller invokes `find_customers` with `{term:""}`, or `get_sales_context` with an extra identity/property key. The strict schema rejects before the application callback starts. The controlled HTTP probe observed HTTP200/tool `isError=true`, **zero audit INSERTs**, and raw SDK text such as `MCP error -32602: Input validation error...`. An extra synthetic key was copied into that text verbatim. No business query ran.

**Consequence / requirement:** The authenticated validation-failure outcome has no durable audit, bypasses the `AUDIT_UNAVAILABLE` fallback entirely, and returns an implementation-specific diagnostic instead of the required safe stable code. This violates the brief's authority addendum requiring authenticated success/denial/query/**validation** outcomes to be audited and its stable safe error contract. The existing forged-identity test checks rejection and absence of one value, but never checks its audit record or stable error shape.

**Correction / acceptance:** Keep useful advertised schemas, but route known-tool argument failures through the application boundary, return stable `TOOL_INPUT_INVALID`, and append safe normalized/digested failure metadata. Cover empty/invalid/extra-field arguments, including audit-store failure on that path. No input values, unknown property names containing sensitive data, or SDK diagnostics should be echoed.

### M0-T3-I2 — Important / P2 — Tool errors omit the server correlation ID

**Location:** `integration-service/sales-mcp/server.ts:151`, also lines 163–166; `ToolError` at line 39 and `safeError` at lines 46–51 contain only code/message.

**Failing scenario:** A valid tool call is denied as `ALPHA_POLICY_NOT_READY`, fails query execution, changes context, or cannot persist either audit append. Each application response serializes only `{code,message}` into MCP content. The already available `options.requestId` is never included. The probe also confirmed missing request_id on the SDK validation path described in I1.

**Consequence / requirement:** Clients cannot correlate a tool failure with the server's audit/log request ID, especially when auditing is unavailable. A caller-supplied JSON-RPC id is a different identifier. This violates the brief's explicit `safe stable code + request_id` error contract. HTTP authentication envelopes already implement the required correlation correctly.

**Correction / acceptance:** Add the existing server-generated request ID to every tool-error envelope, retaining tool `isError=true` and no business data. Assert the same ID in response, audit and safe request log for not-ready/query/context/primary-audit/final-audit failures.

### M0-T3-I3 — Important / P2 — Origin and initial authentication checks run after body parsing

**Location:** `integration-service/sales-mcp/server.ts:186` (route handler), especially lines 187–198.

**Failing scenario:** POST `/mcp/sales` with JSON body `{` and an invalid Origin returns HTTP400 `MCP_PROTOCOL_ERROR`; the same body without Authorization also returns400. The controlled HTTP probe observed both, with zero authentication calls. Fastify parses the body before this handler executes. DELETE and OPTIONS with invalid Origin correctly returned403 in the same probe; the uncovered path is a parser-rejected POST.

**Consequence / requirement:** A present invalid Origin does not invariably receive403, and a missing initial credential does not invariably receive401 before MCP parsing. The pinned [MCP transport security rule](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning) explicitly requires403 for a present invalid Origin. The dispatch also requires initial authentication before protocol/tool work. No unauthorized query/data leak was observed, but the declared transport/auth boundary is incomplete.

**Correction / acceptance:** Put exact-Origin and initial credential checks into an endpoint-scoped lifecycle stage before content parsing, preserving server request IDs and the existing absent-Origin CLI path. Test malformed JSON, unsupported content type and oversized body with invalid Origin/missing credentials, alongside all supported methods. Preserve exact controlled allowlists and no Host/forwarded trust.

### M0-T3-I4 — Important / P2 — Parser errors use an application envelope instead of JSON-RPC

**Location:** `integration-service/sales-mcp/server.ts:218`, also fallback line 212.

**Failing scenario:** A parser-rejected JSON request is handled by setErrorHandler, which sends `{request_id,error:{code:"MCP_PROTOCOL_ERROR",message:...}}`. The observed malformed-body probe returned this shape. It lacks `jsonrpc:"2.0"`, an appropriate null/known id, and a numeric JSON-RPC error code. Authentication added before parsing in I3 would still leave this path for an authenticated client.

**Consequence / requirement:** A client receives a non-JSON-RPC object for a protocol-format error, contrary to the brief's explicit protocol-channel requirement. The SDK cannot format it because the error occurs before transport.handleRequest. Existing focused tests do not exercise malformed JSON.

**Correction / acceptance:** Format authenticated parse/invalid-request failures as safe JSON-RPC errors (parse error -32700 where applicable), retaining safe correlation metadata without raw parser diagnostics. Keep initial authentication/Origin failures in their required HTTP channels. Verify an authenticated malformed JSON request independently from a valid JSON-RPC tool validation failure.

### M0-T3-I5 — Minor / P3 — Accumulated fixtures are attributed to the final full run

**Location:** `docs/execution/alpha1/m0-task-3-report.md:71`, matching private report line71, and `docs/execution/alpha1/m0-task-3-evidence/postgres-fixture-summary.json:2`.

**Failing scenario / evidence:** The reports state that the final full suite created12 Task3 fixtures and the summary labels them all as that suite. Eleven retained lifecycle logs precede the final run: removal times span14:34–14:43UTC. The full test log starts22:45:24 Shanghai time (14:45:24UTC), duration5.36s. Only retained run `4da4ff25-ae40-4524-bba8-a59a3861c6c5`, container `74a510b47d5bb68a3762bdf33a4cb5e25122dab8cf76800e3e02e971c55c2147`, is created14:45:25.759 and removed14:45:28.291UTC in that interval.

**Consequence / correction:** Cleanup evidence for the12 retained fixtures is internally consistent, but its run attribution is inaccurate. Relabel the12 as the accumulated Task3 inventory, distinguish the retained final-run Task3 fixture, and keep the stated Task0/1/2 current-run provenance gap. Correct documentation from existing timestamps only; do not rerun tests or reconstruct lost historical records.

## Conforming behavior and evidence assessment

- Strict `/mcp/sales` obtains each request's principal via Task1 authenticateAgent. Opaque canonical decoding/family separation and current subject/tenant/binding/credential facts are delegated to the approved AuthService. No caller identity override or cached principal/result was found. The five schemas are strict and fixed; arbitrary query/mutation paths are absent.
- Default readiness is closed independently of the old gate/policy. All five tools, including context, take the boundary path. The installed runtime has no environment ready override or MCP gate-write operation. Fixed Hasura documents remain explicitly deferred for M2 semantics.
- Internal Hasura JWT uses derived tenant execution role, one exact allowed/default role, trusted identity/optional department, aud `hasura-sales`, TTL60s and no Admin Secret. Retained tests verify signature, role, tenant/user, audience and TTL; the department claim is present in inspected code, but not explicitly asserted in that JWT test.
- Application execution performs current-auth/gate/readiness capture before work, after query, and after audit; changed gate/version or Task1 current-auth failure discards all result data. Tests contain revocation, gate-epoch, expiry and during-audit barriers plus fresh-credential success. Subject/tenant/department/role and readiness-version changes are supported through inspected equality/AuthService checks; distinct MCP integration barriers for all those changes were not retained.
- Append-only audit ordering conforms: INSERT `audit_checkpoint`, then final current-state recheck, then same-request INSERT `return_check` on failure. No earlier row is updated; supplemental-audit failure returns `AUDIT_UNAVAILABLE` with no result. This is a checkpoint/last-known-decision contract, with no network-delivery guarantee. Migration003 preserves001/002, uses lossless epoch strings/bigints and existing audit storage. Task4 grants remain a documented future deployment action, not verified grants.
- Strict API/MCP legacy routes are absent; runtime requires local_lab plus explicit true, rejects site+legacy and invalid booleans/origins. Worker source selection is empty in strict mode; publisher close-only seam avoids bootstrap/opening. The strict worker returns not_ready before imports/scans; the publisher updates closed and returns not_ready. Existing liveness health is not used as sales readiness.
- Standard request logging uses the approved minimal serializer and server UUID; the focused sentinel test excludes raw target/credential/args/result from logs/audit. I1 remains the separate SDK error-text exception.
- Inspected the retained final gate logs and exit files: typecheck0/build0/test0, Vitest4.1.12,12files/185passed. These are prior implementation execution records at the reported source, not reviewer reruns or production proof. Focused16passed is reported and its16 test definitions are retained; a separate focused raw console log is not in the committed Task3 evidence directory. Initial RED is explicitly unretained.
- Read all12 retained Task3 lifecycle logs through the summary. Each has matching full container ID across created/image_observed/removed events and final ownershipConfirmed/containerAbsentAfterRemoval=true. I5 addresses attribution only. Historical Task0/1/2 lifecycle records lost during the fullrun remain unverified; the documented bounded events recovery returned none. This review did not attempt recovery, inspect ambient secrets/services, or rerun history.

## Named focused regression coverage for corrections

All product regression changes belong in `integration-service/acceptance-tests/mcp-auth.test.ts`; the review did not modify that file.

- **I1:** Extend existing `rejects forged tool identity fields and manager credentials without a department` to assert a safe stable error and durable audit. Add known-tool invalid/empty/extra-field arguments and validation-path audit failure; check zero business queries and no reflected synthetic key sentinel. Existing `returns AUDIT_UNAVAILABLE without business data when durable audit fails` covers only an execution callback path.
- **I2:** Extend existing `advertises exactly five fixed tools and audits all five as not ready by default`, `rechecks authorization after durable audit and returns no data when the audit write overlaps revocation`, both audit-unavailable tests, and `keeps raw request, credential, argument, and result values out of logs and audit` with response/audit/log request-ID correlation. Add a controlled query-error response assertion.
- **I3:** Extend existing `keeps present invalid Origin at 403 and accepts absent or exact allowed Origin` and `requires personal opaque Bearer auth before MCP protocol work` with malformed JSON/unsupported content type/oversized body, absent and invalid credentials, and the remaining supported HTTP methods. Assert no tool/query work.
- **I4:** Add a separate authenticated malformed-JSON case asserting JSON-RPC2.0, parse-error numeric code, null id, safe server correlation, no parser text and no query. Keep it separate from authenticated well-formed tool-validation cases.
- **I5:** Check existing lifecycle timestamps and revise the two reports/summary attribution in the same correction wave. No historical resource recovery or test rerun is needed.

## Reviewer probe and boundaries

The only live probe was `node .superpowers/sdd/2026-10-23-alpha1-m0-identity-isolation-implementation-plan/task-3-review-probe.mjs`, using synthetic AuthService/principal, in-memory pool/audit recorder, controlled readiness/executor and a newly owned127.0.0.1 ephemeral listener. It exited0 and closed its listener in finally (`owned_loopback_listener_closed=true`); queryCalls remained0. No PG/Docker container or upstream resource was created or accessed. Its source is retained next to this report.

The probe imported existing compiled output. An in-memory TypeScript transpilation comparison (ES2022/ES module output, LF-normalized) confirmed identical source output for server, queries, tools, legacy, runtime-config and logging; no build/product file was regenerated. Controlled valid context appended one audit with protocol_version2025-03-26. Invalid empty-term and extra-field calls appended0. Invalid-Origin malformed JSON and missing-auth malformed JSON returned400. Invalid-Origin DELETE/OPTIONS returned403. This is new review evidence, not reconstructed implementation history.

No full suite was repeated. No product edits, commits, push, deployment, user services, secrets or ambient environment dumps. Real Hasura permission/field/relation behavior, applied M2 proof, site grants/IdP/origin allowlist/proxy topology, and remote Hermes0.22.1 remain unverified. Default runtime must remain NOT_READY until M2 supplies controlled applied proof.

**Counts:** Spec4 Important; Quality4 Important integration/error defects plus1 Minor evidence defect. Worst within each axis: M0-T3-I1. Re-review should be scoped to these IDs and their focused regressions.
