# M0 Task4 fix round1 — independent scoped re-review

Reviewer: GPT-6.1 Sol, separate from the implementing agent. The human explicitly selected GPT-6.1 Sol to implement this bounded fix wave; that authorization supersedes the original Luna-only implementation instruction for this wave.

- Previous reviewed HEAD: `419deec30912132afe94aa5195a324d5adec2cf1`.
- Fix dispatch BASE: `efb18348f92cadd690da4ee2f9a2cf344a3dede4` (documentation refresh after the previous review).
- Fix source: `f9ede840b11e65d57287495d69c81348101f509a`.
- Reviewed final HEAD: `73d9ce92b7ea28db73d7d265f79a55c982f903a3` (safe evidence/report commit).
- The controller's later `caf0160` archives the initial review and refreshes pending status. It is outside the fix source/evidence range. A read-only diff against73d9 confirmed no current changes under deploy, integration-service, .dockerignore, or .gitattributes.

Scope: original M0-T4-I1/I2/I3 and Important/Critical breakage introduced by their fix diff. Read the initial review, appended public/private fix reports, supplied source patch, affected source, and retained safe checks/probes/manifests. No product edits, commits, subagents, broad test suite, Compose build, Docker operation, new resource, ambient environment/config read, or raw secret/certificate/env read occurred during this re-review. The seven earlier policy-blocked targets were not inspected or retried.

## Gates

**Spec: PASS for the scoped Task4 correction. Quality: PASS for the scoped Task4 correction.**

**M0-T4-I1, M0-T4-I2, and M0-T4-I3 are ADDRESSED. No new Important/Critical finding was identified in the fix diff.** The carried M0-T3-I1 closure and prior Task3 I2–I5 scoped closures remain intact; integration-service runtime/test/migration bytes did not change in this wave.

There is no remaining Task4 review blocker to proceeding with the planned Task5 work. This is not M0 completion, M1 approval, product acceptance, release approval, or site readiness.

## Spec dispositions

### M0-T4-I1 — ADDRESSED: original raw logs are durably delivered without byte changes

Relevant changes: `.gitattributes:2`, `docs/execution/alpha1/m0-task-4-evidence/EVIDENCE-WHITELIST.txt`, appended public `m0-task-4-report.md` fix1 section, and `fix1-20261024-sol/existing-log-review.json` / `tracked-handoff-verification.json`.

The fix explicitly tracks the114 previously omitted original Task4 log files and adds them to the packaging whitelist. It also retains new fix evidence. The appended report corrects the original list-includes-logs statement and separates historical results from this wave. `.gitattributes` sets `-text` only for the Task4 evidence raw log pattern; read-only `git check-attr text` returned `unset` for both a final fixed stdout log and a fix1 focused log. This prevents platform checkout normalization from invalidating the recorded stream digests.

I independently read **Git objects from exact HEAD73d9**, rather than trusting worktree presence or the implementer's staged verification. One `git cat-file --batch` read covered all whitelist entries plus the required source/hash inputs; blob contents were hashed in memory without emitting their bytes. Results:

-559 whitelist entries,559 distinct paths,559 HEAD blobs present;271 paths end in `.log`.
-Zero whitelist paths under secrets/certs or matching compose-vars env files.
-All114 original log blobs match SHA-256s from the retained pre-fix log inventory, with zero mismatches. Its recorded sensitive-pattern flags are all empty. This comparison independently validates byte preservation against the original inventory; it is not a claim that a pattern scan proves every possible secret absence.
-All six original fixed runner stdout/stderr blobs match the exact SHA-256s from the original `check-results.json`, including the three zero-length stderr streams. The fixed test stdout remains12files/191tests. Those original bytes were preserved, not regenerated.
-The seven final fix source blobs match their recorded source digests; current source files match too.

The required existing raw output is now present in the declared durable delivery. No old command was rerun to reconstruct evidence, and no recursive archive was created or required.

### M0-T4-I2 — ADDRESSED: certificate negatives connect to the intended live endpoint

Relevant changes: `deploy/alpha1/sales-probe.mjs:18-21,49-59`, `deploy/alpha1/probe-transport.mjs:3-14`, `deploy/alpha1/probe-focused-live.mjs:25-37`, and focused regression coverage in `sales-probe.test.mjs`.

The sales request helper now uses the configured endpoint for the TCP destination while allowing the deliberately wrong TLS servername. An omitted443 endpoint port also resolves to443 correctly. The shared classifier accepts only `ERR_TLS_CERT_ALTNAME_INVALID` for hostname failure, and a small explicit list of certificate trust errors for missing CA. DNS failure, refusal, timeout, and unexpected errors produce `pass:false` with unexpected_failure; a successful TLS request also produces `pass:false` for a negative test.

The focused regression launches the actual amended `sales-probe.mjs` against a newly owned TLS listener. Retained final `green-frozen.log` shows the expected hostname code/layer and trust code/layer. A separate real connection-refusal test checks both certificate-negative classifications reject ECONNREFUSED. The current test source confirms these assertions and successful correct-CA control.

The final minimal live deployment, `fix1-20261024-sol/live-exact-addresses/sales-only.log`, proves the same endpoint `sales.local:443` has all three outcomes:

| Request | Actual result |
| --- | --- |
| Explicit fresh CA, sales.local identity | HTTP401 from the live MCP boundary; PASS |
| Same TCP destination and CA, wrong.local servername | ERR_TLS_CERT_ALTNAME_INVALID / certificate_hostname; PASS |
| Same TCP destination and sales.local servername, no explicit CA | UNABLE_TO_VERIFY_LEAF_SIGNATURE / certificate_trust; PASS |

The successful request and classified failures establish certificate verification at the intended layer. They do not claim signed IdP authentication, credential success, or business readiness in this transport-only fixture.

### M0-T4-I3 — ADDRESSED: TCP success fails isolation and exact live interfaces are tested

Relevant changes: `deploy/alpha1/probe-transport.mjs:17-40`, `deploy/alpha1/sales-probe.mjs:105-119`, `deploy/alpha1/probe-sales-network.ps1:17-41`, and the new bounded fixture scripts/tests.

The shared connector uses `net.connect`. Its connect event immediately records reachable=true/TCP_CONNECTED and destroys the socket, regardless of subsequent protocol. DNS errors/timeouts, refused connections, network unreachability, TCP timeout, and unexpected errors have distinct layers. The sales check accepts only the explicit transport-denial layers. DNS-only failure and unknown protocol/TLS errors cannot substitute for direct-address proof. Publisher has no M0 listener and is now INFO/network_proof=false.

The retained reachable-plaintext control demonstrates the exact old false PASS (`EPROTO` despite an accepted TCP connection), then invokes the amended sales probe against the same plaintext target. The new result is isolation **FAIL**, reachable=true/TCP_CONNECTED. The intentionally incomplete child protocol fixture exits1; the outer Node suite asserts that failure and exits0. Other child MCP readiness/tool assertions fail because that fixture is deliberately a minimal TLS response server, and are not presented as passing application checks.

The production wrapper now obtains running owned DB/Hasura/API/MCP identities and all direct IPv4 interfaces, saves safe target metadata, and mounts only that JSON into the sales probe with `SALES_NETWORK_TARGETS_FILE`. Ownership labels and one-running-target expectations are checked before deriving targets. Dockerfile copies the imported transport helper so the revised sales script has its runtime dependency.

The final bounded live project `alpha1-m0-8db20f4adc8645cf9367d900a9e63694` records **ten distinct direct IP/port targets**:2DB,2API,3MCP,3Hasura. I independently compared every target's container ID, IP and network ID against retained actual identity outputs: zero mismatches. The same ten target keys appear in all three probe outputs:

-Allowed-before:13PASS/0FAIL, including10 TCP_CONNECTED plus API health, MCP401, Hasura health.
-Sales-only:13PASS/0FAIL plus5INFO. All ten exact interfaces return ENETUNREACH/network_unreachable; the other three PASS results are the real TLS cases above. Four DNS lookups return dns_timeout as INFO, and absent publisher listener is the fifth INFO.
-Allowed-after:13PASS/0FAIL, with the same10 TCP_CONNECTED and three health/boundary checks.

The actual retained sales client identity has only sales_ingress. The proxy bridges sales_ingress to sales_back. The separate allowed-side client joins the private fixture networks, and actual service identities match the intended backend/control/Hasura attachments. All seven fixture containers have zero host-published port bindings and zero volume-type mounts; Postgres data uses tmpfs. The positive checks before/after eliminate the earlier stopped-service and protocol-mismatch explanations for the sales-side negative result.

## Quality and verification assessment

The fix confines behavior changes to deployment probe code, target routing, helper packaging, test/fixture scripts, and archival handling. No API/AuthService/MCP server/worker/publisher/migration runtime code, Compose topology, or Nginx routing changes appear in419..73d9. The required fixture complexity is bounded to the concrete original verification gaps; no new identity product or production dependency was introduced.

Retained focused command: `node --test deploy/alpha1/sales-probe.test.mjs`. Final frozen output is **2passed/0failed**, exit0. I recomputed its SHA-256 and matched `commands-and-results.json`: `0f48160ee081a1d1b7ce185128dacd22b61ce3add68c5d662a657642d0402421`. The initial RED is retained, exit1, and fails at the missing hostname classification assertion. The report correctly discloses that the precise RED-time test bytes were not separately snapshotted and that later test assertions were added; this review does not invent a byte-identical RED source record.

Retained syntax checks cover all four JS probe/test files and both PowerShell scripts: zero syntax/parser errors. The seven-file final-live source-pre/source-post arrays are identical, and I independently matched all seven SHA-256s to both73d9 Git blobs and current worktree bytes. No rerun of these successful focused checks or of the191-test full suite was necessary to close the review.

The original fixed record remains distinct: starting HEAD9724 plus the captured dirty Task4 source bytes subsequently committed135b7. It supports the original191-test/typecheck/build source, and does not claim to test the changed fix1 probes. The new focused/live evidence supports the changed probe bytes. The previously reviewed real27-role SQL checks and authenticated closed-gate/A-B credential behavior retain their original scope; no SQL/lifecycle retest was performed or implied.

## Exit codes and resource lifecycle

Read all three run manifests, raw final probe outputs, actual safe identity metadata, and exact absence records. Every absence entry matches a created resource ID, has a nonzero Docker not-found lookup, and carries explicit recognized absence output.

| Run project suffix | Resources | Probe command exits | Explicit absence |
| --- | --- | --- | --- |
|034f82d9550a4f0b96d4be8ff39171a9 |6containers +7networks |allowed-before0 / sales-only0 / allowed-after0 |13/13 |
|6879797f5a6f4c3683f0f0ad47ea36ae |6containers +7networks |allowed-before0 / sales-only0 / allowed-after0 |13/13 |
|8db20f4adc8645cf9367d900a9e63694 |7containers +7networks |allowed-before0 / sales-only0 / allowed-after0 |14/14 |

Each retained run reports statusPASS and fresh generated secret/certificate directory absence `[true,true]`. The first two runs are earlier evidence and are not relabeled as the final exact-address/source run.

The wrapper-exit files contain **1**, inherited from final intentional not-found lookup through PowerShell LASTEXITCODE. Initial pg_isready polls contain exit2 before later readiness success (two polls in each earlier run, one in the final run). These observed nonzero results remain retained and correctly explained. I do not claim that every command or aggregate wrapper invocation exited0. The actual three probe command exits and cleanup proof establish their narrower results. Improving aggregate wrapper exit hygiene would be a future convenience; it is not an unresolved Important defect in these explicitly recorded results.

The seven earlier policy-blocked host artifact targets remain an external cleanup limitation. This fix did not touch them, and their prior guard continues to apply. No reviewer resource inspection, deletion, or trust-store operation was performed.

## Limits and next gate

The changed full Compose wrapper and rebuilt image path were **not executed end-to-end** in this wave. Their target-mount and helper-COPY changes were inspected; actual classifier behavior and service/interface isolation were exercised through mounted-source minimal live fixtures using an existing immutable application image. That is sufficient for these scoped findings, and is not relabeled as a new full Compose/product acceptance run.

The fixture API/MCP listeners used explicit synthetic configuration and an unusable DB identity; no authenticated application/database or migration work was part of the correction. Hasura used a fresh owned metadata fixture. Real enterprise IdP/JWKS/CA/egress, site TLS/DNS/network ACLs, operator approvals/deployment lock, remote Hermes0.22.1, M2 row/column semantics, real business answers, and48 product acceptance rows remain unverified/NOT_RUN as previously recorded.

**Disposition:** close M0-T4-I1/I2/I3; retain the earlier Task3 closures; proceed to the planned Task5 scope. This scoped PASS does not close M0 or advance M1/release/site readiness by itself.
