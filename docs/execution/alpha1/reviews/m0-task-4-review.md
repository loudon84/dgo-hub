# M0 Task4 — independent Spec and Quality review

Reviewer: GPT-6.1 Sol. Implementation: GPT-6 Luna. Reviewed on 2026-10-24.

- Exact BASE: `15dd7667fecb35ef45a8025b9044753970192e94`.
- Exact reviewed HEAD: `419deec30912132afe94aa5195a324d5adec2cf1`.
- Implementation source commit: `135b7f102920f6ee89efb654cd85fb1405007f60`; prerequisite source includes `deddfcbe` and `9724f627`.
- The later controller commit `efb1834` is a documentation status refresh outside this review range. A read-only diff against reviewed HEAD confirmed no current changes under `deploy`, `integration-service`, or `.dockerignore`.
- Read both Task4 briefs and their addenda, the carried Task3 review, private/public implementation reports, complete supplied source-diff inventory and changed source, the packaging whitelist, and the policy-blocked-artifact guard. No applicable AGENTS.md was found in repository ancestors or the affected directories. Used requesting-code-review and verification-before-completion skills; explicit review constraints prohibit repeating the already recorded broad checks.
- No product edits, commits, subagents, broad test reruns, Compose rebuilds, Docker operations, remote service changes, ambient configuration reads, or raw generated secret/certificate/env reads were performed. Only this private review and its narrow reproduction were written.

## First: carried Task3 M0-T3-I1

**M0-T3-I1: ADDRESSED for the exact carried deep-argument audit escape.** Task3 I2–I5 retain their prior scoped closures.

`integration-service/sales-mcp/server.ts:56-94` replaces recursive whole-object `JSON.stringify` with an explicit work stack and incremental SHA-256. Nested arrays/objects are traversed iteratively; strings and keys alone use JSON serialization. Parsed HTTP JSON cannot supply getters, proxies, or executable `toJSON` methods. The 1 MiB request bound still applies. Although the digest call remains before the execution try at line167, the demonstrated recursive call-stack escape is removed for this bounded JSON input. This is not a claim that arbitrary in-process hostile JavaScript objects are supported.

`integration-service/acceptance-tests/mcp-auth.test.ts:510-563` constructs the exact authenticated known-tool request: `find_customers`, object-valued `term`, 10,000 nested objects, synthetic `review-value`, and 60,117 bytes at id1. It asserts tool `isError=true`, no JSON-RPC internal error or raw diagnostic, `TOOL_INPUT_INVALID`, server request correlation, one durable error audit with NULL result count, and zero query executions. The same test then injects an audit INSERT failure and requires correlated `AUDIT_UNAVAILABLE` with an actual attempted insertion and no internal detail.

Retained local evidence, read directly:

- `m0-task-4-evidence/c45d5838-514d-4738-afc5-a94860e12245/i1-red/output.log`: original digest source fails the new audited-result assertion; 1 failed/20 skipped, 09:16:14 local. Several other startup/byte-count attempts remain distinct; they are not substituted for this RED.
- `m0-task-4-evidence/2e39d005-c81d-4a29-a893-146bfbf89fd2/i1-green/output.log`: focused test passes, 1 passed/20 skipped, 09:18:46 local, 3.08s. Its retained command is `npm test -- --run acceptance-tests/mcp-auth.test.ts -t safely audits deeply`, and exit record is0. The earlier `9be32420.../i1-green` is actually a failed 60,118 versus60,117 byte-count attempt; the directory label is not treated as success.
- Current server SHA-256 `08bff7bb9faf9fb969ddfa3b4c9ae2f6926e00d5e13fb6c77a8dda0b992f858f` matches the successful GREEN source record. Subsequent test changes route evidence. Server, MCP test, and fixture helper have no changes between recorder starting HEAD9724 and reviewed HEAD419.
- The fresh final fixed record additionally contains 12 passing files/191 passing tests, including this regression, with typecheck/build exit0. The archival defect in M0-T4-I1 below concerns deliverability of those existing logs; it does not negate the locally observed regression result.

## Spec verdict

**Needs fixes.** Most runtime and permission requirements have concrete supporting source/evidence. Three mandatory verification/handoff requirements remain unsatisfied: durable raw log delivery, certificate hostname rejection proof, and transport-level direct-access rejection proof. These are actionable gaps in the changed Task4 work. There is no demonstrated unauthorized business answer or actual SQL/network privilege escape.

| Requirement | Reviewed evidence and disposition |
| --- | --- |
| Independent owned Alpha deployment | `deploy/alpha1/compose.yaml` is separate from demo Compose. Recorded project names are unique `alpha1-m0-...`; observed resource inventories contain exact IDs/labels. No original demo/upstream changes appear in the source diff. |
| Strict M0 defaults, no forced ready | API/MCP/publisher/worker Compose settings disable legacy lab. Strict worker returns before importing scanning dependencies; publisher calls the close-only function and reports NOT_READY. Initial001 gate is closed even without optional ops profile. Missing OIDC log is `AUTH_CONFIG_INVALID`; synthetic local configuration proves listener liveness only. |
| Owner migrator and runtime roles | One-shot `hub_migrator` applies001–004 before API/MCP/Hasura. Separate API, MCP, worker, publisher, Hasura read, and Hasura metadata accounts are provisioned. API has no migration startup. Migrations001–003 are unchanged in BASE..HEAD. |
| API lock permissions without self-grant |004 creates `control.lock_api_identity(text,text)` and `control.lock_agent_credential_idempotency(text,text,text)`, SECURITY DEFINER with fixed `search_path=pg_catalog,control`, PUBLIC execute revoked, granted only to API. Runtime SQL uses those functions for identity/idempotency locks. API direct UPDATE is limited to subject auth_epoch and credential revoked_at/credential_epoch. No role/scope/binding/tenant association update grants. |
| Minimal credential registry/API lifecycle | API gets SELECT(digest) for the INSERT conflict target and INSERT(digest,kind), without SELECT(kind) or source_credential access. The fresh database source grants include this correction; the real fresh probe performs create/list/revoke and verifies both epoch increments under hub_api. It does not rely on the old manual-instance grant. |
| MCP authority | Exact identity/agent facts and gate SELECT, minimal audit INSERT columns plus sequence USAGE. No gate/epoch/business/source/policy writes/reads beyond specified identity facts. Real MCP login is used for current credential authentication and audit. |
| Publisher close only |004 grants EXECUTE on `control.close_query_gate()` and no direct gate UPDATE. Function hardcodes closed state, increments epoch, and returns state/epoch; PUBLIC execute is revoked and search_path fixed. Actual publisher close succeeds; attempted open, business DML, DDL are denied. |
| Hasura split | Hasura read gets listed columns on the five approved api views and no base/control tables or DML/DDL. Metadata has its own database/login and gets42501 connecting to business DB. Console/dev mode off; only publisher application service receives the admin secret; Hasura itself receives it as verifier. |
| Front/private backend split | Both source and sanitized recorded networks place sales probe only on sales_ingress, proxy on front + sales_back + loopback edge, and MCP on sales_back/control_data/hasura_business. Management has corresponding private backend/entry split. Only the proxies publish127.0.0.1 TLS ports. Direct-denial dynamic proof needs M0-T4-I3 correction. |
| TLS and route allowlist | Nginx exact sales route `/mcp/sales`; other paths404. Explicit CA and normal hostname checking used for successful TLS requests. No plaintext listener configured. Local cert helper uses in-memory .NET crypto and run-scoped files, with no host trust-store modification. Wrong-hostname negative is not valid proof yet: M0-T4-I2. |
| Redaction and trusted request ID | Proxy access logs contain status, method, upstream status only; error URI logging disabled. No new proxy request-ID trust replaces server UUID. Existing HTTP/header/body redaction contracts retained. |
| Run-scoped evidence routing | Controlled absolute `M0_RUN_EVIDENCE_ROOT` routes `<root>/<taskLabel>/<runLabel>/`; summaries follow the actual fixture evidence file. Focused failure-path coverage preserves old path bytes and records created/removal/absence or cleanup_unconfirmed. Final fresh fixture tree includes all task0/1/2/3 labels. |
| Real positive closed-gate protocol | Local TLS initialize, initialized notification, exact five tools, and authenticated context produce correlated `QUERY_NOT_READY`, denied durable audit, NULL result_count. No gate opening. ALPHA_POLICY_NOT_READY is the separate resolver path. |
| A/B revocation sequence | Distinct A/B created through API role; A initialized through TLS before B revoke. API B revoke increments subject/B credential epochs; MCP accepts A with current facts and rejects B as AUTH_REVOKED. New TLS A context returns QUERY_NOT_READY and exactly one audit; B HTTP401. Earlier authenticateAgent under API failure is correctly disclosed as harness consumer error. |
| Resource cleanup and safety | Recorded exact lookups confirm both projects' containers/networks/volumes absent. Seven host secret/cert/env target removals were policy blocked; never re-read or retried. Raw trees remain excluded from Git/context and cannot be packaged. This is an external cleanup limitation, not a production waiver. |

## Quality verdict

**Needs fixes.** Runtime changes are small and permission grants are tied to implemented SQL. The real role and protocol evidence supports the closed M0 behavior. The new deployment test harness nevertheless has two verified false-PASS paths, and its raw evidence handoff omits every Task4 log. These block acceptance of the stated verification guarantees until corrected.

### M0-T4-I1 — Important/P1: deliver the existing raw logs in the explicit safe handoff

**Locations:** `docs/execution/alpha1/m0-task-4-report.md:79`; `docs/execution/alpha1/m0-task-4-evidence/EVIDENCE-WHITELIST.txt:1`; root `.gitignore:6`; final fixed `check-results.json:25` (and other stdout/stderr entries).

**Scenario/evidence:** The public report describes a file-by-file text/JSON/JSONL/log handoff and says future packaging must consume that whitelist. Actual whitelist has261 lines and **zero `.log` entries**. `git ls-tree -r --name-only 419deec... docs/execution/alpha1/m0-task-4-evidence` likewise contains **zero tracked Task4 logs**. Root `*.log` ignore explains why a builder based on untracked/nonignored files omitted them. The required raw logs still exist locally, including focused I1 RED/GREEN, fresh SQL27/27, TLS/network/auth/audit outputs, focused migration18/18, and all six fixed runner stdout/stderr files. I read the relevant known sanitized logs; they are not lost. Their presence on this machine does not put them in the declared package.

**Consequence:** A clean checkout or whitelist-based archive lacks the actual outputs supporting the committed exits/hashes and cannot replay/inspect the fixed record as handed off. The report's statement that this list includes logs is false. Raw checks/probes are a required reusable Task4 deliverable and Task5 input.

**Required correction:** Sanitize/review the specific existing raw command logs, add each permitted file explicitly to the safe handoff and durable tracking/package, retain original failed attempts as appropriate, and correct counts/claims. Verify every referenced fixed stdout/stderr path is present and hash-equal in the final deliverable. Do not reconstruct old logs or rerun191 tests to manufacture replacements. Do not recursively archive the evidence roots or include/read the policy-blocked raw trees.

### M0-T4-I2 — Important/P1: connect to the real TLS endpoint for hostname rejection

**Locations:** `deploy/alpha1/sales-probe.mjs:17-20`, `:49-50`.

**Scenario:** The wrong-hostname case calls `send(...,{host:'wrong.local'})`. The helper uses that same host for `hostname` (TCP/DNS target) and `servername` unless `connectHost` is provided. The call never supplies `connectHost`. Its catch counts **any** rejection as PASS. `wrong.local` is not the recorded `sales.local` proxy alias; resolution failure, timeout, or connection refusal therefore satisfies the check before certificate hostname verification occurs.

**Observed evidence:** The actual retained fresh sales log records `wrong_hostname_rejected:PASS` with no error code/layer. It cannot distinguish a certificate mismatch from the wrong target being unreachable. Successful trusted sales.local requests prove the real endpoint works, but do not repair this separate wrong-destination test.

**Consequence:** The required real negative hostname verification has not been established, despite being reported as passing. The check can stay green if hostname verification is broken.

**Required correction:** Keep TCP target at the live known sales endpoint (e.g. connectHost sales.local), deliberately use a mismatched TLS servername/check identity, retain normal certificate verification, and accept only the expected hostname mismatch error (`ERR_TLS_CERT_ALTNAME_INVALID` or the platform's explicitly verified equivalent). Unexpected DNS/connect/timeout errors must fail or be BLOCKED. Apply the same intended-layer discipline to the untrusted-CA negative at line49. Prove correct-host success and mismatched-host rejection against one owned live TLS listener with retained classified output; no full suite is needed for this bounded probe correction.

### M0-T4-I3 — Important/P1: test direct TCP connectivity without requiring HTTPS success

**Locations:** `deploy/alpha1/sales-probe.mjs:98-108`.

**Scenario:** This loop uses imported `https.request` for PostgreSQL5432 and plaintext API3000/MCP3001 (also Hasura8080). It records reachable only after an HTTP response, and classifies **every TLS/protocol error or timeout** as unreachable. A successful TCP connection to an HTTP listener produces EPROTO; PostgreSQL can accept TCP and wait for a PostgreSQL startup packet while the probe waits for TLS. Both paths can receive an isolation PASS.

**Independent bounded reproduction:** `task-4-review-network-probe.mjs` / `.txt` beside this report reproduces the exact classification against one newly owned ephemeral127.0.0.1 HTTP listener. Actual exit0 output: `tcp_connections_accepted:1`, `existing_probe_result:{reachable:false,code:EPROTO}`, `false_isolation_pass:true`. Listener was closed in finally. No Docker, database, user service, secret, or external network was accessed.

**Observed deployment evidence:** Fresh sales log labels all five direct targets PASS with TIMEOUT. API allowed-side health200 and sanitized running topology resolve the earlier stopped-API issue, but the flawed transport classifier still cannot tell TCP denial from a reachable incompatible listener. The static attachments support the intended isolation; this finding is not a demonstrated current topology escape.

**Required correction:** Use a bounded TCP connector and count **any successful TCP connect** to a forbidden actual listener as failure, irrespective of application protocol. Separately record DNS unavailability and network refusal/timeout, and retain actual owned target identities/addresses where needed to test direct addresses as required. Keep allowed-side liveness proof for API/MCP/DB/Hasura. Publisher has no M0 listener; label that fact distinctly rather than treating its stopped/no-listener condition as standalone network proof. Include a focused reachable-plaintext control that fails the isolation check and real sales-only negative checks that pass, under minimal new owned resources. Do not reuse removed runs, read policy-blocked CA/secrets, or repeat the broad SQL/full191 suite for this harness correction.

## Verified retained checks, provenance, and limits

**Final fixed record:** `docs/execution/alpha1/m0-task-4-evidence/final-w0-01a166bd/final-w0-20261024-01a166bd/`. Read `run.json`, `check-results.json`, raw stdout/stderr, worktree-manifest metadata,24-entry pre/post source digests, and fresh fixture lifecycles. The recorded fixed typecheck/test/build exits are0. Raw final test output is12files/191tests, start10:05:14 local, duration5.61s. Independently recomputed all six stdout/stderr hashes: all match their committed metadata. Pre/post24-entry lists match exactly and all24 current file hashes match. Starting HEAD9724 identifies inherited committed source; dirty Task4 file bytes identify the subsequently committed135b7 implementation. No sole-HEAD9724 tested-final-source claim is made.

The four final fixture IDs are `e241d76e539966613dd51bdeb131f941bd1bce1c172afd35e30835e55603386f` (task0), `a40f49d548faae6b10045a4d5e5fd6250554dd11063ae304c7bf5bc94d2220d1` (task1), `aca297fd82a116a96f77b2eea9df272b7f00d65f69a35d516c604e39bf80eb80` (task2), and `41b0e49ea269a5b19ff3ee629e0b24384e9a84c5adf6b19bc3f65a892efa3c0c` (task3). Read each created/image_observed/removed sequence; each concludes ownershipConfirmed=true and containerAbsentAfterRemoval=true in the10:05:15–18 local test window. Prior Task3 missing historic fixture provenance stays disclosed and was not reconstructed.

**Real runtime:** Read known sanitized outputs in fresh run `e849ca81-c63f-4f74-a5e7-c5de79a568c5`, including fresh-grant27PASS/0FAIL, management health/OIDC boundary, sales protocol, durable audit, A/B prepare/revoke/TLS sequence, missing-OIDC error, strict worker/publisher, pinned identities, and sanitized network/container/volume inventories. Focused migration log is18/18. Recorded database/migrator images and four official pinned linux/amd64 references have explicit observed RepoDigests, separate from runtime image IDs. The full sanitized container inventory supplies full application image IDs; the convenience `app-container-image-identities.txt` field called image-id uses short container IDs and should not be used as the authoritative image identity. No missing RepoDigest is filled with an image ID.

**Cleanup:** Exact retained absence records total35 resources for the fresh project (22containers,10networks,3volumes) and36 for the earlier owned project (23containers,10networks,3volumes). The corrected records use explicit not-found results. No reviewer Docker query/removal was necessary. Policy-blocked seven raw host target removals remain external limitations with their guard honored; no approval to waive them is inferred.

**Cannot verify / not claimed:** Real enterprise OIDC/JWKS authentication or controlled site CA/egress, DNS/TLS/network ACLs, real approvals/deployment lock, M2 row/column policy semantics, real business-role query answers, remote Hermes0.22.1, and product acceptance. Synthetic `.invalid` values only make the local API listener usable for liveness/unauthenticated-boundary checks; no new IdP was implemented. The48 product rows remain NOT_RUN. Hasura administrative denial was observed on its shared listener from a probe attached to hasura_data; the probe name “mcp_side” is not evidence that the probe ran inside the actual MCP container. Secret-based denial and static MCP business-network reachability are supported separately.

## Required next scope

Keep M0-T3-I1 closed and retain Task3 I2–I5 closures. Correct M0-T4-I1/I2/I3 in one bounded implementation wave, preserve the already successful local evidence, and return for independent Sol re-review. Spec and Quality are both Needs fixes until that evidence/harness scope is closed. Task4 runtime implementation and existing full checks do not by themselves authorize Task5 completion, M0 closure, M1 formal transition, release, or site deployment.
