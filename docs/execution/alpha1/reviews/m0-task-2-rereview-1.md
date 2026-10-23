# M0 Task2 — scoped fix round 1 re-review

**Round verdict: Approved. Resulting Spec gate: Approved. Resulting Quality gate: Approved.**

Reviewer: GPT-6.1 Sol, 2026-10-23 (Asia/Shanghai). Fix BASE `5f3e574a2360a446355238a281719cb33bcd1a7b`; reviewed final HEAD `7ed0fe59d717b3582141b45aeff2dce7d4074bda`; source fix `df61be0fc698e07a2b895a3c0caa4dbda8e764ab`. Branch `feat/alpha1-implementation`.

Scope is the two original Task2 findings and regressions introduced by this fix diff. Unchanged OIDC/AuthService and the previously approved Task0/Task1 baseline were not reopened.

## Finding dispositions

### M0-T2-I1 — ADDRESSED

Original title: **Reuse the request's logged ID in response envelopes** (P2 / Important).

At `E:/git/dgo-hub/integration-service/app.ts:16`, Fastify now creates a server UUID when the request begins and keeps `requestIdHeader:false`. At `E:/git/dgo-hub/integration-service/ingestion-api/identity-routes.ts:14`, `:31`, and `:38`, success, failure, and 404 envelopes reuse `request.id`. Every changed handler/error-handler call passes the actual request into those helpers; no response helper creates a separate UUID. DELETE remains bodyless 204 and retains the same request logger context. The public consumer handoff explicitly documents the generator, rejected incoming IDs, and logger configuration required by later Fastify consumers.

The regression at `E:/git/dgo-hub/integration-service/acceptance-tests/identity-http.test.ts:287` uses the real `buildApp()` path and captured production logger options. Assertions at `:330`–`:333` correlate successful, invalid-bearer, 404, and invalid-path responses with the captured IDs. The forged request-ID assertion is at `:294`, with sentinel absence at `:328`. The DELETE completion assertion at `:339` checks a 204 log against its incoming request ID, and `:309` verifies the empty response. The retained focused run passes these assertions.

### M0-T2-I2 — ADDRESSED

Original title: **Stop logging rejected request values through the default URL serializer** (P2 / Important).

At `E:/git/dgo-hub/integration-service/ingestion-api/logging.ts:10`, the request serializer now emits only `{ id, method, route }`, using the static registered route pattern or a constant `unmatched` value. It does not emit raw URL, query, path parameters, host, version or other incoming headers, body, or raw claims. The response serializer at `:11` emits status only. Fastify's request context and completion logs retain the trusted ID and response timing; the existing header redaction remains in place as well.

The regression at `E:/git/dgo-hub/integration-service/acceptance-tests/identity-http.test.ts:304` exercises a rejected dynamic path; `:311` exercises rejected query input plus client-controlled host/version; and `:316` exercises a rejected body. The assertions at `:324`–`:328` verify that all these sentinels, the hostile incoming request ID, and malformed bearer text are absent from captured logs. Existing credential creation/replay assertions and secret absence checks remain in the same focused suite. These tests now run through the production app factory rather than a separately configured Fastify test app.

## New Critical / Important breakage in changed code

**None found.** The product diff changes request-ID generation, envelope ID plumbing and request/response serializers. It does not change identity resolution, authorization, persistence, idempotency/replay, pagination or revoke semantics. All envelope call sites are updated consistently. The added regression exercises the original failures through the actual app configuration. No cosmetic issue is used as an approval gate.

## Out-of-scope observations and provenance notes

- **No new out-of-scope code findings added.** Task3 MCP and legacy route isolation, enterprise OIDC configuration/site SSO, remote Hermes, and product acceptance remain separate work and retain their prior NOT_RUN/BLOCKED limits.
- The public report's older paragraph at `E:/git/dgo-hub/docs/execution/alpha1/m0-task-2-report.md:103` still says “Final complete checks.” Its 168-test evidence belongs to the initial Task2 implementation `9240dd1886a91925d158b42a5dd2a07f59fda8e2`, before this review fix. It is not treated as a new full-suite run or evidence against the current fix source. The controller has already identified the wording and will label that preserved history in documentation closure; this is a nonblocking provenance clarification, not a request for another suite run.

## Evidence and verification boundary

- Read `task-2-rereview-1-package.txt` once, including the commits, stat and fix diff; read the appended Review round 1 public report and retained review-round logs. No fresh Git diff was requested or executed.
- Current HEAD matches the requested final HEAD. All four current fix source/test files match `docs/execution/alpha1/m0-task-2-evidence/review-round1/source.sha256.json`. The working tree was clean before this report write.
- Retained command `npm test -- acceptance-tests/identity-http.test.ts` reports Vitest 4.1.12, **1 file / 14 tests passed**, `focused-green.exit=0`. `npm run typecheck` and `npm run build` each have retained command output and exit **0**. These are implementation evidence, not newly executed reviewer checks. The retained RED file is explicitly sanitized, with removed sentinel/captured payload material; it records **1 failed / 13 passed** and exit **1**, not an unsanitized raw failure transcript.
- Final focused fixture: task label `task2`, run label `c074489f-611e-48ae-83dc-d6a99b1241f3`, exact container ID `666485a8e20ff8b86ec2858dd63912b9cf93e101247556a646acb2ecab4f2e27`. Its evidence records ownership confirmed and absence confirmed after exact-ID removal. An earlier round-one fixture is retained separately: task label `task2`, run label `9bdc3158-22b7-4471-b7d8-1ef66c9bd06b`, ID `a16529aa666e090697b634cf5c890741c30ab61361ed8d2be23880075333e052`, also with confirmed removal. Both separately record the image reference, RepoDigest and runtime image ID.
- No unresolved correctness doubt required a reviewer probe. No test/full-suite repeat, new resource, existing service operation, environment/secret read, product/index/HEAD mutation, commit, push, merge, deployment, upstream-clone modification or agent delegation occurred. This scoped report is the only filesystem write during re-review.

Both original findings are closed. No new Critical/Important defect was found in the scoped fix. Task2 local engineering Spec and Quality gates are therefore **Approved** for the reviewed final HEAD; this does not upgrade external/site acceptance.
