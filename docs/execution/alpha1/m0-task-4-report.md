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

`docs/execution/alpha1/m0-task-4-evidence/EVIDENCE-WHITELIST.txt` is the reviewed file-by-file handoff list: 257 untracked sanitized text/JSON/JSONL/log/exit/identity/lifecycle/probe files from the carried Task3 and Task4 evidence roots. A local scan inspected those candidate bytes without printing contents; no credential, authorization, private-key, credential-bearing URL, or JWT patterns were found. The four migration SQLSTATE probe `.mjs` sources were scanned too and included; every `secrets/` and `certs/` tree and every `compose-vars*.env` file is excluded. `m0-task-4-evidence/.gitignore` adds narrow future guards for `**/secrets/`, `**/certs/`, and `**/compose-vars*.env`. The root `.dockerignore` starts with a blanket `**` exclusion and only re-includes the service/deploy inputs needed for the image, so evidence and residual generated files are outside Docker build context. No recursive ZIP/archive was created; any future evidence packaging must consume this explicit whitelist, since Git ignore rules do not constrain archive tools.

