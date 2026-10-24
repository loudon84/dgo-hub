param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
$permitted = [IO.Path]::GetFullPath((Join-Path $repo 'docs/execution/alpha1/m0-task-4-evidence/fix1-20261024-sol'))
if ($evidence -ne $permitted -and -not $evidence.StartsWith($permitted + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'FIX1_EVIDENCE_PATH_REQUIRED' }
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$sourcePaths = @('deploy/alpha1/sales-probe.mjs','deploy/alpha1/probe-transport.mjs','deploy/alpha1/probe-sales-network.ps1','deploy/alpha1/sales-probe.test.mjs','deploy/alpha1/probe-focused-live.mjs','deploy/alpha1/verify-probe-fix1.ps1','deploy/alpha1/Dockerfile')
function Save-SourceHashes([string]$name) {
  @($sourcePaths | ForEach-Object { @{path=$_; sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash.ToLowerInvariant()} }) | ConvertTo-Json | Set-Content (Join-Path $evidence $name)
}
Save-SourceHashes 'source-pre.json'
$id = [guid]::NewGuid().ToString('N')
$project = "alpha1-m0-$id"
$resources = [Collections.Generic.List[object]]::new()
$commands = [Collections.Generic.List[object]]::new()
$secrets = Join-Path $evidence 'secrets'
$certs = Join-Path $evidence 'certs'
$mountRepo = $repo.Replace('\','/')
$mountEvidence = $evidence.Replace('\','/')
$images = @{
  node = 'node:24.14.1-alpine@sha256:6222c83590744c8e778520946b72d1cc4309293886610dc59a4ce3fdfe6f9b40'
  nginx = 'nginx:1.30.6-alpine@sha256:84ed8c0dd296c188bfc24ed506f46589e9285fb0b11cf3a04d91d524d3067e11'
  db = 'postgres:16.10-alpine@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297'
  hasura = 'hasura/graphql-engine:v2.51.1@sha256:9c89fa691cff4171d24903b948b4c7d33207a28cc3a8ec96a088de2f6f40bed5'
  app = 'sha256:e54d5f4084e9' # Resolve only this already built immutable image, never an old container.
}
$images.app = (& docker image inspect --format '{{.Id}}' $images.app).Trim()
if ($LASTEXITCODE -ne 0) { throw 'IMMUTABLE_APP_IMAGE_MISSING' }
function Invoke-Docker([string]$name, [string[]]$DockerArgs, [switch]$AllowFailure) {
  $out = @(& docker @DockerArgs 2>&1)
  $exitCode = $LASTEXITCODE
  $out | Set-Content -LiteralPath (Join-Path $evidence "$name.log")
  $commands.Add(@{ name=$name; executable='docker'; arguments=$DockerArgs; exit_code=$exitCode; output="$name.log" })
  if ($exitCode -ne 0 -and -not $AllowFailure) { throw "DOCKER_COMMAND_FAILED:$name" }
  return $out
}
function New-OwnedContainer([string]$service, [string]$network, [string[]]$Extra) {
  $out = Invoke-Docker "create-$service" (@('run','-d','--name',"$project-$service",'--label',"alpha1.fix1.run=$id",'--label',"com.docker.compose.project=$project",'--label',"com.docker.compose.service=$service",'--network',"${project}_$network",'--network-alias',$service) + $Extra)
  $container = ($out | Select-Object -Last 1).ToString().Trim()
  if ($container -notmatch '^[a-f0-9]{64}$') { throw 'EXACT_CONTAINER_ID_MISSING' }
  $resources.Add(@{ type='container'; id=$container; service=$service })
  return $container
}
function Add-Network([string]$container, [string]$network, [string]$service) {
  Invoke-Docker "connect-$service-$network" @('network','connect','--alias',$service,"${project}_$network",$container) | Out-Null
}
$result = 'FAIL'
try {
  New-Item -ItemType Directory -Path $secrets,$certs | Out-Null
  [IO.File]::WriteAllText((Join-Path $secrets 'pg-password'), [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
  [IO.File]::WriteAllText((Join-Path $secrets 'admin'), [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
  [IO.File]::WriteAllText((Join-Path $secrets 'jwt'), [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
  # No authenticated app/database call in this transport-only fixture. Missing
  # fixture identity is deliberately unusable and confers no owner privileges.
  [IO.File]::WriteAllText((Join-Path $secrets 'app-url'), 'postgresql://transport_probe_disabled@db:5432/transport_probe_disabled')
  & (Join-Path $PSScriptRoot 'New-LocalCertificates.ps1') -CertificateDirectory $certs | Set-Content (Join-Path $evidence 'certificate-issuance.txt')
  foreach ($network in @('sales_ingress','sales_back','management_back','control_data','hasura_business','hasura_data','admin_publish')) {
    $out = Invoke-Docker "create-network-$network" @('network','create','--internal','--label',"alpha1.fix1.run=$id",'--label',"com.docker.compose.project=$project","${project}_$network")
    $resources.Add(@{ type='network'; id=($out | Select-Object -Last 1).ToString().Trim(); name=$network })
  }
  $db = New-OwnedContainer 'db' 'control_data' @('--mount',"type=bind,src=$mountEvidence/secrets/pg-password,dst=/run/owned/pg-password,readonly",'--tmpfs','/var/lib/postgresql/data','--env','POSTGRES_PASSWORD_FILE=/run/owned/pg-password',$images.db)
  Add-Network $db 'hasura_data' 'db'
  for ($attempt=0; $attempt -lt 30; $attempt++) {
    $ready = Invoke-Docker "db-ready-$attempt" @('exec',$db,'pg_isready','-U','postgres','-d','postgres') -AllowFailure
    if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Milliseconds 500
  }
  $hasura = New-OwnedContainer 'hasura' 'hasura_business' @('--mount',"type=bind,src=$mountEvidence/secrets/pg-password,dst=/run/owned/pg-password,readonly",'--mount',"type=bind,src=$mountEvidence/secrets/admin,dst=/run/owned/admin,readonly",'--entrypoint','/bin/sh',$images.hasura,'-ec','export HASURA_GRAPHQL_METADATA_DATABASE_URL="postgresql://postgres:$(cat /run/owned/pg-password)@db:5432/postgres"; export HASURA_GRAPHQL_ADMIN_SECRET="$(cat /run/owned/admin)"; export HASURA_GRAPHQL_ENABLE_CONSOLE=false; export HASURA_GRAPHQL_DEV_MODE=false; exec graphql-engine serve')
  Add-Network $hasura 'hasura_data' 'hasura'; Add-Network $hasura 'admin_publish' 'hasura'
  $appCommon = @('--mount',"type=bind,src=$mountEvidence/secrets/app-url,dst=/run/owned/app-url,readonly",'--mount',"type=bind,src=$mountRepo/deploy/alpha1,dst=/probe,readonly",'--env','HUB_ENVIRONMENT_KIND=local_lab','--env','HUB_ENABLE_LEGACY_LAB=false','--env','DATABASE_URL_FILE=/run/owned/app-url')
  $api = New-OwnedContainer 'api' 'management_back' ($appCommon + @('--env','HUB_AUTH_ISSUER=https://issuer.invalid','--env','HUB_AUTH_AUDIENCE=transport-probe','--env','HUB_AUTH_JWKS_URL=https://issuer.invalid/jwks',$images.app,'api'))
  Add-Network $api 'control_data' 'api'
  $mcp = New-OwnedContainer 'mcp' 'sales_back' ($appCommon + @('--mount',"type=bind,src=$mountEvidence/secrets/jwt,dst=/run/owned/jwt,readonly",'--env','HUB_MCP_ALLOWED_ORIGINS=https://sales.local','--env','HASURA_URL=http://hasura:8080','--env','HASURA_JWT_SECRET_FILE=/run/owned/jwt',$images.app,'mcp'))
  Add-Network $mcp 'control_data' 'mcp'; Add-Network $mcp 'hasura_business' 'mcp'
  $proxy = New-OwnedContainer 'sales-proxy' 'sales_back' @('--mount',"type=bind,src=$mountRepo/deploy/alpha1/nginx/sales.conf,dst=/etc/nginx/conf.d/default.conf,readonly",'--mount',"type=bind,src=$mountEvidence/certs,dst=/run/alpha1,readonly",$images.nginx)
  Add-Network $proxy 'sales_ingress' 'sales.local'
  $targets = @()
  foreach ($pair in @(@($db,'db',5432),@($api,'api',3000),@($mcp,'mcp',3001),@($hasura,'hasura',8080))) {
    $networks = (Invoke-Docker "addresses-$($pair[1])" @('inspect','--format','{{json .NetworkSettings.Networks}}',$pair[0]) | Out-String | ConvertFrom-Json)
    $index=0
    foreach ($net in $networks.PSObject.Properties) {
      $targets += @{ name="$($pair[1])-ip$index"; host=$net.Value.IPAddress; port=$pair[2]; container_id=$pair[0]; network_id=$net.Value.NetworkID }; $index++
    }
  }
  $targets | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $evidence 'live-targets.json')
  $sales = New-OwnedContainer 'sales-probe' 'sales_ingress' @('--mount',"type=bind,src=$mountRepo/deploy/alpha1,dst=/probe,readonly",'--mount',"type=bind,src=$mountEvidence/live-targets.json,dst=/evidence/live-targets.json,readonly",'--mount',"type=bind,src=$mountEvidence/certs/ca.pem,dst=/evidence/certs/ca.pem,readonly",$images.node,'-e','setInterval(()=>{},10000)')
  # One controlled permitted-side client covers every private target interface.
  # The untrusted sales probe stays attached to sales_ingress alone.
  $allowed = New-OwnedContainer 'allowed-probe' 'control_data' @('--mount',"type=bind,src=$mountRepo/deploy/alpha1,dst=/probe,readonly",'--mount',"type=bind,src=$mountEvidence/live-targets.json,dst=/evidence/live-targets.json,readonly",$images.node,'-e','setInterval(()=>{},10000)')
  foreach ($network in @('sales_back','management_back','hasura_business','hasura_data','admin_publish')) { Add-Network $allowed $network 'allowed-probe' }
  Start-Sleep -Seconds 3
  Invoke-Docker 'allowed-before' @('exec',$allowed,'node','/probe/probe-focused-live.mjs','allowed','/evidence/live-targets.json') | Out-Null
  Invoke-Docker 'sales-only' @('exec',$sales,'node','/probe/probe-focused-live.mjs','sales','/evidence/live-targets.json','/evidence/certs/ca.pem') | Out-Null
  Invoke-Docker 'allowed-after' @('exec',$allowed,'node','/probe/probe-focused-live.mjs','allowed','/evidence/live-targets.json') | Out-Null
  $result='PASS'
} finally {
  foreach ($resource in $resources) {
    if ($resource.type -eq 'container') {
      Invoke-Docker "identity-$($resource.service)" @('inspect','--format','{{.Id}}|{{.Image}}|{{json .Config.Labels}}|{{json .NetworkSettings.Networks}}|{{json .HostConfig.PortBindings}}|{{json .Mounts}}|{{.State.Status}}',$resource.id) -AllowFailure | Out-Null
    } else {
      Invoke-Docker "identity-network-$($resource.name)" @('network','inspect','--format','{{.Id}}|{{json .Labels}}|{{.Internal}}|{{json .Containers}}',$resource.id) -AllowFailure | Out-Null
    }
  }
  # Remove only exact created IDs after verifying their run ownership label.
  foreach ($resource in ($resources | Where-Object type -eq 'container')) {
    $owner = (& docker inspect --format '{{index .Config.Labels "alpha1.fix1.run"}}' $resource.id).Trim()
    if ($LASTEXITCODE -ne 0 -or $owner -ne $id) { throw 'CLEANUP_OWNERSHIP_UNCONFIRMED' }
    Invoke-Docker "remove-$($resource.service)" @('rm','-f',$resource.id) | Out-Null
  }
  foreach ($resource in ($resources | Where-Object type -eq 'network')) {
    $owner = (& docker network inspect --format '{{index .Labels "alpha1.fix1.run"}}' $resource.id).Trim()
    if ($LASTEXITCODE -ne 0 -or $owner -ne $id) { throw 'CLEANUP_OWNERSHIP_UNCONFIRMED' }
    Invoke-Docker "remove-network-$($resource.name)" @('network','rm',$resource.id) | Out-Null
  }
  $absence = @()
  foreach ($resource in $resources) {
    $args = if ($resource.type -eq 'container') { @('inspect',$resource.id) } else { @('network','inspect',$resource.id) }
    $out = @(& docker @args 2>&1); $code=$LASTEXITCODE
    $confirmed = $code -ne 0 -and ($out -join ' ') -match '(No such object|No such container|network .* not found|no such network)'
    $absence += @{ type=$resource.type; id=$resource.id; exit_code=$code; absent=$confirmed; output=($out -join "`n") }
  }
  $absence | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $evidence 'cleanup-absence.json')
  foreach ($path in @($secrets,$certs)) {
    $resolved = [IO.Path]::GetFullPath($path)
    if (-not $resolved.StartsWith($permitted + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'CLEANUP_PATH_OUTSIDE_FIX1' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  @{ project=$project; run_id=$id; status=$result; images=$images; resources=$resources; host_generated_targets_absent=(@(-not(Test-Path -LiteralPath $secrets),-not(Test-Path -LiteralPath $certs))); commands=$commands } | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $evidence 'live-run.json')
  Save-SourceHashes 'source-post.json'
  if (@($absence | Where-Object { -not $_.absent }).Count -ne 0) { throw 'CLEANUP_UNCONFIRMED' }
}
if ($result -ne 'PASS') { throw 'FOCUSED_LIVE_FAILED' }
Write-Output "FOCUSED_LIVE_PASS:$project"
