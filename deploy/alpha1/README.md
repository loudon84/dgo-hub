# Alpha 1 local deployment

This Compose project runs the Alpha runtime independently from the legacy demo. It builds the integration service from the repository root and applies migrations once with `hub_migrator`. API, MCP, publisher, worker, Hasura-read, and Hasura metadata use separate database identities. Runtime services never use the migrator URL.

## Local run

Use PowerShell 7.6.5 or later and Docker Compose. `New-LocalCertificates.ps1` uses .NET `CertificateRequest`; it writes an ephemeral CA and leaf into the supplied run directory and does not change the Windows certificate store.

```powershell
$run = node .\deploy\alpha1\prepare-local-run.mjs (Join-Path $env:TEMP 'alpha1-runs') | ConvertFrom-Json
pwsh -File .\deploy\alpha1\New-LocalCertificates.ps1 -CertificateDirectory $run.certificate_directory
```

For a local liveness probe, append synthetic OIDC settings to the generated Compose variables. They are test inputs only; they are not an enterprise IdP configuration and do not provide signed-token authentication.

```powershell
Add-Content $run.compose_vars 'ALPHA1_API_ENV_KIND=local_lab'
Add-Content $run.compose_vars 'ALPHA1_OIDC_ISSUER=https://alpha1.invalid/oidc'
Add-Content $run.compose_vars 'ALPHA1_OIDC_AUDIENCE=alpha1-local-sales'
Add-Content $run.compose_vars 'ALPHA1_OIDC_JWKS_URL=https://alpha1.invalid/jwks'
$project = "alpha1-m0-$($run.run_id.Replace('-', ''))"
docker compose --env-file $run.compose_vars -f .\deploy\alpha1\compose.yaml -p $project config --quiet
docker compose --env-file $run.compose_vars -f .\deploy\alpha1\compose.yaml -p $project up -d --build
```

The initial run without OIDC values must leave API stopped with `AUTH_CONFIG_INVALID`. With the explicit synthetic values, API starts and the management probe verifies the health route and the unauthenticated OIDC boundary. The grant probe provisions one local synthetic principal with the one-shot migrator; it issues a disposable credential through `AuthService`, exercises create/list/revoke and epoch changes using `hub_api`, and places the active credential in a private run volume for the sales probe. The credential itself is never printed.

Run the database grant checks and TLS protocol/network check from the repository root:

```powershell
docker compose --env-file $run.compose_vars -f .\deploy\alpha1\compose.yaml -p $project --profile verify run --no-deps seed-principal
docker compose --env-file $run.compose_vars -f .\deploy\alpha1\compose.yaml -p $project --profile verify run --no-deps grant-probe
.\deploy\alpha1\probe-sales-network.ps1 -EnvFile $run.compose_vars -Project $project -EvidenceDirectory $run.run_root
$env:MANAGEMENT_CA_FILE = Join-Path $run.certificate_directory 'ca.pem'
$env:MANAGEMENT_PORT = [string]$run.management_port
node .\deploy\alpha1\management-probe.mjs
docker compose --env-file $run.compose_vars -f .\deploy\alpha1\compose.yaml -p $project --profile verify run --no-deps verify-audit
```

The sales probe is attached only to `sales_ingress`. The sales proxy also joins `sales_back` for MCP and `sales_loopback_edge` for its loopback-only host port. The management proxy follows the same pattern with `management_ingress`, `management_back`, and `management_loopback_edge`. API is on `management_back` and `control_data`; MCP is on `sales_back`, `control_data`, and `hasura_business`. Hasura has separate business, metadata, and publisher networks. Database and publisher networks remain internal. Only the two TLS proxies publish ports, both on `127.0.0.1`.

`sales_ingress` and all backend networks are Docker internal networks. The two loopback edge networks exist only to support host port forwarding; only their respective proxy joins. Nginx has fixed route allowlists and logs status, method, and upstream status without request URI, headers, or body. Internal networks do not enforce the site's enterprise egress domain allowlist.

## Runtime boundary

Migration 004 creates fixed-search-path `SECURITY DEFINER` functions for API row locks and the publisher's close-only gate action. `hub_api` has column-scoped identity/credential privileges, including only `SELECT(digest)` required by its digest conflict target. It cannot read business tables or change role, scope, binding, tenant, or user associations. `hub_mcp` can read the authenticated identity, current agent credential, and gate, then insert the minimal audit columns; it cannot read source credentials, policy, business rows, or alter gate/epoch state. `hub_publisher` can execute the close function and has no direct gate update privilege. `hub_hasura_read` can select the approved `api` views only. Hasura metadata uses a separate database and login that cannot connect to `alpha1`.

Worker and publisher use the `ops` profile. Strict M0 worker startup exits with `M0_WORKER_NOT_READY` before scanning sources. Strict M0 publisher closes the gate through its narrow function, reports `M0_PUBLISHER_NOT_READY`, and exits. Neither mode opens the gate or enables legacy source polling. Hasura console and development mode are off.

## Site inputs and cleanup

Production stays **BLOCKED** until operators supply the approved OIDC issuer, audience, HTTPS JWKS endpoint, real TLS certificates, network ACLs, and the required identity/policy approvals. The `.invalid` values above are deliberately synthetic. No business answer or M2 readiness is asserted; the query gate remains closed and sales context returns `QUERY_NOT_READY` with a correlated durable audit and no result rows.

Record the Compose project, full container/network IDs and labels, and the full names/labels of its named volumes before cleanup. Stop only the named Alpha project, then remove only its recorded containers, networks, and owned volumes. Do not use `docker system prune` or operate the legacy demo project. Delete the run directory containing generated secret files and private certificate keys after evidence collection.
