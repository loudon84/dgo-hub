# M0 Task4 implementation and runtime evidence

**Status: DONE_WITH_CONCERNS; pending independent GPT-6.1 Sol review.** Task3 approval is not implied. This report covers Task4 implementation after carried Task3 M0-T3-I1 remediation.

## Source identity and commits

- Authority/base: clean `15dd7667fecb35ef45a8025b9044753970192e94`.
- Carried Task3 I1 implementation commits: `deddfcbe` safely digests deeply nested raw arguments; `9724f627` routes fixture evidence through the explicit run-root input. The preceding focused Postgres readiness fixture correction is `fa5ba313`.
- Task4 final source and tests were frozen and verified with the fixed local-check runner at source git SHA `9724f627daceb6315bb05446667eed56c66fd987`; the runner's pre/post source digest sets are identical. Its run record is `docs/execution/alpha1/m0-task-4-evidence/final-w0-01a166bd/final-w0-20261024-01a166bd/`.
- Task4 source changes: new `deploy/alpha1/` isolated Compose, Dockerfile, secret-file entrypoint/adapters, one-shot DB role provisioning, migration/runtime probes, TLS proxies/configuration and docs; new `integration-service/migrations/004_alpha1_runtime_security.sql`; API lock-query, strict worker/publisher, and migration/identity acceptance updates; root `.dockerignore`.
- Task4 source commit: `135b7f102920f6ee89efb654cd85fb1405007f60`. The tracked report was committed separately immediately afterward. Raw runtime evidence and generated files are excluded.

## Runtime, SQL, and configuration contract

Compose applies migrations exactly once using `hub_migrator`. Runtime identities are separate: `hub_api`, `hub_mcp`, `hub_worker`, `hub_publisher`, `hub_hasura_read`, plus an independent Hasura metadata database/login. Migration 004 adds fixed-search-path security-definer row-lock functions for API identity/credential operations and a publisher close-only gate function. PUBLIC access/default grants are revoked. API receives only the identity and credential operations it needs, including `SELECT(digest)` alone on the global digest registry for its conflict target; the adjacent `kind` column and source credential table remain denied. MCP can read the necessary current identity/credential/gate facts and append the specified audit columns, but cannot read business/source/policy data or write gate/epoch state. Publisher has no direct gate update privilege and can only close through the narrow function. Hasura read can select only approved API views. Metadata login cannot connect to the business database.

File-based runtime inputs include `DATABASE_URL_FILE`, `HASURA_JWT_SECRET_FILE`, and `HASURA_ADMIN_SECRET_FILE`; values are read by bounded entry adapters without shell tracing or printing. The adapter uses the frozen names `HUB_ENVIRONMENT_KIND`, `HUB_ENABLE_LEGACY_LAB`, `HUB_AUTH_ISSUER`, `HUB_AUTH_AUDIENCE`, and `HUB_AUTH_JWKS_URL`, with Compose run values supplied as `ALPHA1_*`. It does not auto-load `.env` or inspect ambient `DATABASE_URL`/`Config.Env`. Missing OIDC makes the API exit safely with `AUTH_CONFIG_INVALID`. Synthetic `.invalid` OIDC values were used only for local liveness and do not establish site authentication readiness.

The worker exits before source scan with `M0_WORKER_NOT_READY`. The publisher closes the existing gate via its close-only function and reports `M0_PUBLISHER_NOT_READY`. Neither opens the gate. Hasura console/development mode is off.

## Images and isolated topology

The pinned Compose set uses PostgreSQL `16.10-alpine`, Hasura `v2.51.1`, Nginx `1.30.6-alpine`, and Node `24.14.1-alpine`. The observed linux/amd64 image IDs and RepoDigests are preserved in `fresh-compose-runs/e849ca81-c63f-4f74-a5e7-c5de79a568c5/pinned-image-identities.txt` and `app-container-image-identities.txt`.

Only sales and management TLS proxies publish loopback host ports. Sales ingress probe is attached only to `sales_ingress`; the sales proxy bridges that front network to private `sales_back` and its own host-forwarding edge. MCP is on `sales_back`, control data, and Hasura business networks, never the untrusted ingress. Management uses the analogous ingress/backend/loopback-edge split. API is live on management backend and control data. Database, Hasura business, publisher, and metadata paths use separate networks. Inventory and exact container/network/volume IDs and labels are retained in each run evidence directory. Docker internal networks prove local topology only; the site's external egress ACL remains BLOCKED pending operator inputs.

## Focused migration and real runtime probes

Focused migration acceptance rerun passed **18/18** after deriving the actual default-ACL owner behavior. Evidence: `docs/execution/alpha1/m0-task-4-evidence/focused-migration-rerun-537ac4b5eedb422c82c5438a4e6d938d/`.

A fresh empty-database Compose run applied migrations 001–004 and the real role-grant probe passed **27/27** under the actual runtime logins. It checks positive required lifecycle operations and SQLSTATE-specific denials for self-grants/role membership/DDL, forbidden identity changes, business and source credential reads, gate/epoch writes, and unauthorized Hasura/metadata connections. This fresh initialization reproduces the digest-only registry grant from migration 004; no manual grant is relied on. Full role-specific outputs and identities are in `fresh-grant-probe.log` and `fresh-grant-probe-identity.txt`.

Separate live probes passed for trusted local TLS, wrong hostname and untrusted CA rejection, HTTP denial, no-token 401, exactly five advertised MCP tools, absent admin/manage/ingest/Hasura routes, and sales-side inability to reach direct DB/Hasura/API/publisher/MCP listeners. API was positively shown listening through the management TLS health route while the sales-side network denial ran. The real MCP context request authenticated through TLS, returned `QUERY_NOT_READY`, and recorded a correlated durable denied audit row with `result_count=null`. This is the expected closed-gate path. `ALPHA_POLICY_NOT_READY` remains the separate resolver behavior already covered by Task3 tests; it was not substituted for the live closed-gate result. No gate was opened and no business answer was claimed.

The dedicated credential sequence created distinct active credentials A and B. A successfully initialized through real TLS before B was revoked. API revocation of B incremented subject and B credential epochs. The MCP role then accepted still-active A under current facts and rejected B as `AUTH_REVOKED`; a fresh TLS HTTP context call using A authenticated and returned `QUERY_NOT_READY`, while B returned HTTP 401. Audit verification found exactly one correlated durable row and no result count. A prior diagnostic tried `authenticateAgent` under `hub_api` and correctly got `AUTH_UNAVAILABLE` because authentication belongs to `hub_mcp`; the final sequence uses the proper consumer role. First failed probe/build/command attempts remain preserved alongside their corrected reruns in the evidence root.

## Final fixed checks

The fixed runner was executed once with a fresh `M0_RUN_EVIDENCE_ROOT`:

`npm run record:local-checks -- --output-parent E:\git\dgo-hub\docs\execution\alpha1\m0-task-4-evidence\final-w0-01a166bd --run-id final-w0-20261024-01a166bd`

Evidence is under `docs/execution/alpha1/m0-task-4-evidence/final-w0-01a166bd/final-w0-20261024-01a166bd/`. Runner exit was 0; fixed typecheck, test, and build each exited 0. Test result: 12 files and 191 tests passed. The fresh fixture record covers task0/1/2/3 with created, observed, removed and cleanup-confirmed lifecycle entries; no unresolved fixture resources. The 48 product acceptance rows remain `NOT_RUN`. This local evidence does not establish Hermes 0.22.1 remote behavior, site OIDC, site TLS/DNS/ACLs, approvals, deployment readiness, or product acceptance.

## Resource cleanup and remaining concern

Owned Docker resources were recorded before exact cleanup. Project `alpha1-m0-a91d65b2151644d9a46392d1da80985e` cleanup confirmed absence of 23 containers, 10 networks, and 3 volumes. Fresh project `alpha1-m0-e849ca81c63f4f74a5e7c5de79a568c5` cleanup confirmed absence of 22 containers, 10 networks, and 3 volumes. Exact lifecycle inventories are retained in their respective evidence directories. An initial absence-check script misclassified Docker's `no such network` response; that failure is retained, and corrected exact lookups confirmed absence. No broad compose teardown or prune was used.

The command runner rejected host removal of these generated run files as `blocked by policy`. The controller explicitly directed no retry through another mechanism. These are the exact residual paths; no file contents or secret bytes are included here:

- `E:\git\dgo-hub\docs\execution\alpha1\m0-task-4-evidence\owned-deploy\a91d65b2-1516-44d9-a463-92d1da80985e\secrets\`
- `E:\git\dgo-hub\docs\execution\alpha1\m0-task-4-evidence\owned-deploy\a91d65b2-1516-44d9-a463-92d1da80985e\certs\`
- `E:\git\dgo-hub\docs\execution\alpha1\m0-task-4-evidence\owned-deploy\a91d65b2-1516-44d9-a463-92d1da80985e\compose-vars.env`
- `E:\git\dgo-hub\docs\execution\alpha1\m0-task-4-evidence\fresh-compose-runs\e849ca81-c63f-4f74-a5e7-c5de79a568c5\secrets\`
- `E:\git\dgo-hub\docs\execution\alpha1\m0-task-4-evidence\fresh-compose-runs\e849ca81-c63f-4f74-a5e7-c5de79a568c5\certs\`
- `E:\git\dgo-hub\docs\execution\alpha1\m0-task-4-evidence\fresh-compose-runs\e849ca81-c63f-4f74-a5e7-c5de79a568c5\compose-vars.env`
- `E:\git\dgo-hub\docs\execution\alpha1\m0-task-4-evidence\fresh-compose-runs\e849ca81-c63f-4f74-a5e7-c5de79a568c5\compose-vars-no-oidc.env`

These generated artifacts are outside Git source tracking. The fixed runner's worktree manifest recorded path/hash metadata only; it did not capture file contents. This host cleanup limitation is the reason status is DONE_WITH_CONCERNS. Independent Sol review is required before Task5; no release or deployment approval is inferred.

## Evidence index

- Fresh live Compose/runtime: `docs/execution/alpha1/m0-task-4-evidence/fresh-compose-runs/e849ca81-c63f-4f74-a5e7-c5de79a568c5/`
- Earlier owned Compose diagnostic run: `docs/execution/alpha1/m0-task-4-evidence/owned-deploy/a91d65b2-1516-44d9-a463-92d1da80985e/`
- Focused SQL/migration tests: `docs/execution/alpha1/m0-task-4-evidence/focused-migration-rerun-537ac4b5eedb422c82c5438a4e6d938d/`
- Final fixed checks and fixture lifecycle: `docs/execution/alpha1/m0-task-4-evidence/final-w0-01a166bd/final-w0-20261024-01a166bd/`
- Task5 handoff's pre-recorded evidence-root input remains the controller-recorded `9724f627` value; this report does not overwrite it.



## Final source identity clarification and Task5 SQL handoff

The final recorder `run.json` records its starting Git HEAD as `9724f627daceb6315bb05446667eed56c66fd987`. At that moment the Task4 code/tests were in the worktree and their actual bytes were captured by the 24-entry `source-sha256-pre-run.txt` and `source-sha256-post-run.txt` manifests. I compared both manifests (24 entries, zero differences) and recomputed the current 24 worktree file hashes (zero mismatches). Those checked source bytes are the Task4 source subsequently committed as `135b7f102920f6ee89efb654cd85fb1405007f60`; 9724 is the recorder's base commit identity, not the sole identity of the tested final source.

For Task5 SQL/runtime integration, `integration-service/migrations/004_alpha1_runtime_security.sql` defines `control.lock_api_identity(p_issuer text, p_subject text)` and `control.lock_agent_credential_idempotency(p_tenant_key text, p_user_id text, p_idempotency_key text)`, granted only to `hub_api`, plus `control.close_query_gate()`, granted only to `hub_publisher`. Each function revokes PUBLIC execute and fixes `search_path`. The exact role/database setup and PUBLIC CONNECT revocations live in `deploy/alpha1/db-init/00-roles.sh`. Extend grants through controlled migrations there, retaining the Task4 role separation and consumer boundaries.

## Evidence handoff manifest

`docs/execution/alpha1/m0-task-4-evidence/EVIDENCE-WHITELIST.txt` is the file-by-file handoff list. The original committed list had 261 entries and omitted all 114 Task4 raw `.log` files because of root `*.log` ignore. The previous count of 257 and claim that raw logs were included were incorrect. Fix1 below expands this to 559 tracked paths, including 271 raw logs. Historical failed attempts remain distinct. Every `secrets/` and `certs/` tree and every `compose-vars*.env` file remains excluded. The narrow evidence `.gitignore` guards and root `.dockerignore` remain in effect. Any future packaging must consume this explicit whitelist; no recursive archive was created.

## Task4 fix1 — I1/I2/I3 implementation, pending independent re-review

GPT-6.1 Sol implemented this user-authorized bounded fix from clean BASE `efb18348f92cadd690da4ee2f9a2cf344a3dede4`. Source commit: `f9ede840b11e65d57287495d69c81348101f509a`. This report and the exact safe evidence are delivered in the subsequent evidence commit. No finding is marked reviewer-approved here; Task5/M0/M1/release/site gates remain pending their independent decisions.

**I1, durable original outputs.** `fix1-20261024-sol/existing-log-review.json` records the exact 114 pre-existing log candidates, byte lengths, line counts, SHA-256s, and zero sensitive-pattern flags. Selection excluded blocked secret/certificate/env targets before reading. No historical log was altered or reconstructed. Each reviewed file was force-added by its individual path. `.gitattributes` disables text normalization only for tracked Task4 raw logs so Git preserves their recorded bytes across platforms. All 114 original log blobs were rehashed from the staged Git view and matched the original scan. `tracked-handoff-verification.json` also verifies all six final fixed stdout/stderr blobs against the SHA-256s in the original `check-results.json`: six matches, no missing paths. The whitelist now has 261 original paths + 114 original logs + 184 new safe evidence files = **559 paths**, including **271 logs**. Generated secret/certificate/env contents are absent from this list.

The original **12 files / 191 tests** and typecheck/build results still belong to the recorded starting HEAD `9724f627daceb6315bb05446667eed56c66fd987` plus its captured dirty source bytes, subsequently committed as `135b7f102920f6ee89efb654cd85fb1405007f60`. They do not certify the changed fix1 probe bytes. No full 191-test, SQL grant, migration or Compose deployment build was repeated.

**I2, intended certificate layer.** `sales-probe.mjs` now keeps the TCP destination at the configured live endpoint when TLS servername changes. `probe-transport.mjs` accepts only `ERR_TLS_CERT_ALTNAME_INVALID` for wrong hostname, and explicit certificate trust codes for unknown CA. DNS, refusal, timeout and other failures cannot satisfy either negative. The final owned listener returned HTTP 401 with the fresh explicit CA and correct identity; the same TCP endpoint returned `ERR_TLS_CERT_ALTNAME_INVALID` with `wrong.local` and `UNABLE_TO_VERIFY_LEAF_SIGNATURE` without the CA. These are certificate-negative results against a live MCP endpoint, not business authentication or readiness proof.

**I3, actual TCP and exact live addresses.** The shared connector uses `net.connect`; any connect event fails a forbidden-access check regardless of HTTP/TLS/PostgreSQL protocol. DNS unavailability/timeouts, TCP refusal/timeouts, network unreachability and unexpected errors have separate layers. Unexpected failures and DNS-only results cannot replace direct-IP denial. The production wrapper derives direct IPv4 targets from owned running DB/API/MCP/Hasura identities, saves safe target metadata, and mounts only that file into sales. Publisher's absent M0 listener is informational with `network_proof:false`.

The focused plaintext control retained in `green-frozen.log` accepted a TCP connection and made the old HTTPS classifier return `EPROTO` / false isolation PASS. The amended sales probe then recorded `TCP_CONNECTED` / isolation FAIL against that same listener. Its deliberately minimal protocol fixture has unrelated MCP assertions marked FAIL and exits 1 as expected; the Node regression suite asserts the specific TCP failure and exits 0. A separate real refusal case verifies that `ECONNREFUSED` is a network denial and fails both certificate-negative classifications.

Commands and outputs:

- `node --test deploy/alpha1/sales-probe.test.mjs`: initial `red.log` exit 1 at the missing hostname classification assertion; final `green-frozen.log` exit 0, **2 passed / 0 failed**. RED-time test bytes were not separately snapshotted; later assertions added positive TLS, old plaintext classification and refusal coverage. The original probe source BASE hash and unmodified RED output are retained without reconstructing history.
- `& ./deploy/alpha1/verify-probe-fix1.ps1 -EvidenceDirectory E:/git/dgo-hub/docs/execution/alpha1/m0-task-4-evidence/fix1-20261024-sol/live-exact-addresses`: final live project `alpha1-m0-8db20f4adc8645cf9367d900a9e63694`, exact image IDs, labels, target addresses, raw commands/output/exits in `live-run.json` and individual logs. `allowed-before.log` and `allowed-after.log`: **13/13 PASS each**, including the same ten direct IP/port combinations and API health 200 / MCP no-token 401 / Hasura health 200. `sales-only.log`: **13/13 PASS**, three real TLS checks plus ten direct-IP denials, all `ENETUNREACH` / `network_unreachable`. Four separately retained name lookups timed out at `dns_timeout` and are INFO only.
- `node --check` for all four changed/new JS probe/test files and PowerShell parser checks for both scripts: zero errors, retained in `syntax-checks.json`. Source/docs `git diff --check` passed. The later all-artifact staged whitespace check reported original CRLF/trailing spaces in immutable raw logs; those bytes were intentionally preserved. `git diff --cached --check -- . ':(exclude,glob)**/*.log'` returned 0. Final live seven-file source manifests before/after are identical and match the current worktree bytes; `commands-and-results.json` retains these hashes and the focused command/result mapping.

The final live fixture used **7 containers / 7 internal networks**, no published ports, no named/anonymous volume (Postgres data used tmpfs), no application migration or authenticated database query. API/MCP were actual existing immutable application image `sha256:e54d5f4084e976f985a52969da8e32d9f1340258061e4fdf7416860b1a9736aa` with fresh controlled startup inputs and an unusable DB identity. Hasura used its own fresh ephemeral Postgres metadata fixture. These establish listener liveness only. New probe source was mounted read-only; no application image rebuild or runtime permission change was needed. Sales client joined only `sales_ingress`; the separate allowed client joined private fixture networks to test all ten exact interfaces. Fresh secrets were mounted individually only in intended consumers. Seven module directories are retained.

Two preceding bounded runs remain separate: project `alpha1-m0-034f82d9550a4f0b96d4be8ff39171a9` in the fix1 root, and `alpha1-m0-6879797f5a6f4c3683f0f0ad47ea36ae` in `live-final/`. Both proved TLS and sales direct-IP denial while permitted-side checks used service aliases. The latter added DNS-timeout classification; the final run added one allowed client to prove each exact target IP before/after. They are not relabeled as the final source/address proof.

**Exit and cleanup details.** All three actual probes in each live run exited 0. Startup readiness polling initially returned `pg_isready` exit 2 (twice in each earlier run, once in the final run), then 0. The wrapper `*-exit.txt` captures **1**, inherited through PowerShell `$LASTEXITCODE` from the final intentional Docker not-found absence lookup; it is retained as observed and is not claimed as aggregate runner exit 0. Each run's own `status:PASS`, per-command exits and raw outputs carry the probe results. Exact ID/ownership checks and explicit not-found results confirm **13/13**, **13/13**, and **14/14** resources absent, respectively. All three fresh certificate/secret directories were removed and their absence recorded. The earlier seven policy-blocked host targets were never read or retried and remain external cleanup limitations.

The unchanged enterprise OIDC/JWKS, site TLS/DNS/ACL, deployment lock/approval, remote Hermes, M2 policy and product acceptance limits continue. The changed full Compose wrapper/image packaging was not rebuilt or rerun; its shared transport behavior is covered by the focused tests and mounted-source live fixture. Independent scoped re-review must decide I1/I2/I3 closure.

