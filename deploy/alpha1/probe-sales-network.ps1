param(
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [Parameter(Mandatory = $true)][string]$Project,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory
)

$ErrorActionPreference = 'Stop'
$resolvedEnv = (Resolve-Path -LiteralPath $EnvFile).Path
$resolvedEvidence = [System.IO.Path]::GetFullPath($EvidenceDirectory)
if ($Project -notmatch '^alpha1-m0-[a-f0-9]{32}$') { throw 'OWNED_PROJECT_NAME_REQUIRED' }
if (-not [System.IO.Directory]::Exists($resolvedEvidence)) { throw 'EVIDENCE_DIRECTORY_MISSING' }
$run = [guid]::NewGuid().ToString('N')
$logPath = Join-Path $resolvedEvidence "sales-probe-$run.log"
$exitPath = Join-Path $resolvedEvidence "sales-probe-$run-exit-code.txt"
$identityPath = Join-Path $resolvedEvidence "sales-probe-$run-container-identity.txt"
$targetPath = Join-Path $resolvedEvidence "sales-probe-$run-targets.json"
$targets = @()
foreach ($service in @('db', 'hasura', 'api', 'mcp')) {
  $port = @{ db = 5432; hasura = 8080; api = 3000; mcp = 3001 }[$service]
  $ids = @(& docker ps -q --filter "label=com.docker.compose.project=$Project" --filter "label=com.docker.compose.service=$service")
  if ($LASTEXITCODE -ne 0 -or $ids.Count -ne 1) { throw "LIVE_OWNED_TARGET_REQUIRED:$service" }
  $identity = & docker inspect --format '{{json .Config.Labels}}' $ids[0] | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $identity.'com.docker.compose.project' -ne $Project -or $identity.'com.docker.compose.service' -ne $service) { throw 'TARGET_OWNERSHIP_UNCONFIRMED' }
  $networks = & docker inspect --format '{{json .NetworkSettings.Networks}}' $ids[0] | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'TARGET_NETWORK_INSPECT_FAILED' }
  $index = 0
  foreach ($network in $networks.PSObject.Properties) {
    if (-not $network.Value.IPAddress) { continue }
    $targets += @{ name = "$service-ip$index"; host = $network.Value.IPAddress; port = $port; container_id = $ids[0]; network_id = $network.Value.NetworkID }
    $index++
  }
  if ($index -eq 0) { throw 'TARGET_DIRECT_ADDRESS_REQUIRED' }
}
$targets | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $targetPath

$beforeIds = @(& docker ps -aq --filter "label=com.docker.compose.project=$Project" --filter 'label=com.docker.compose.service=sales-probe')
& docker compose --env-file $resolvedEnv -f deploy/alpha1/compose.yaml -p $Project --profile verify run --no-deps --volume "${targetPath}:/run/alpha1/network-targets.json:ro" --env 'SALES_NETWORK_TARGETS_FILE=/run/alpha1/network-targets.json' sales-probe *> $logPath
$exitCode = $LASTEXITCODE
$exitCode | Set-Content -LiteralPath $exitPath
$afterIds = @(& docker ps -aq --filter "label=com.docker.compose.project=$Project" --filter 'label=com.docker.compose.service=sales-probe')
$containerId = $afterIds | Where-Object { $_ -notin $beforeIds } | Select-Object -First 1
if ($containerId) {
  & docker inspect --format '{{.Id}}|{{json .Config.Labels}}|{{.State.Status}}|{{.State.ExitCode}}' $containerId | Set-Content -LiteralPath $identityPath
} else {
  'NO_CONTAINER_ID_RETURNED' | Set-Content -LiteralPath $identityPath
  if ($exitCode -eq 0) { $exitCode = 1; $exitCode | Set-Content -LiteralPath $exitPath }
}
Get-Content -LiteralPath $logPath
Write-Output "probe_exit_code=$exitCode"
Write-Output "resource_identity_file=$identityPath"
exit $exitCode
