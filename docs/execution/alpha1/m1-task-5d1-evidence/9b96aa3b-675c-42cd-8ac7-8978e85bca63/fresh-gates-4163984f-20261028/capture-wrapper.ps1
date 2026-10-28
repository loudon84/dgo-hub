param([ValidateSet('test','typecheck','build')][string]$Gate)
$ErrorActionPreference = 'Stop'
$repo = 'E:\git\dgo-hub'
$svc = Join-Path $repo 'integration-service'
$uuid = [guid]::NewGuid().ToString()
$root = Join-Path 'E:\m1t5-runtime' $uuid
New-Item -ItemType Directory -Path $root | Out-Null
$sourcePaths = @(
  '.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/context/m1-task5d1-schema-contract.md',
  'integration-service/acceptance-tests/snapshot-runs.test.ts',
  'integration-service/etl-worker/snapshot-delete-worker.ts',
  'integration-service/etl-worker/snapshot-runs.ts',
  'integration-service/etl-worker/worker.ts',
  'integration-service/migrations/009_snapshot_runs_and_recovery.sql',
  'integration-service/source-registry/service.ts'
)
function Get-SourceManifest([string]$Phase) {
  $files = @()
  foreach ($relative in $sourcePaths) {
    $path = Join-Path $repo ($relative.Replace('/', '\'))
    $bytes = [IO.File]::ReadAllBytes($path)
    $lf = [Text.Encoding]::UTF8.GetString($bytes).Replace("`r`n", "`n")
$rawHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    $lfBytes = [Text.Encoding]::UTF8.GetBytes($lf)
$lfHash = ([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($lfBytes))).Replace('-', '').ToLowerInvariant()
    $blob = (& git -C $repo hash-object -- $relative).Trim()
    $files += [ordered]@{path=$relative; size_bytes=$bytes.Length; sha256_raw=$rawHash; sha256_lf_normalized=$lfHash; git_blob=$blob; raw_matches_git_blob=($rawHash -eq $lfHash -and ((& git -C $repo rev-parse "HEAD:$relative").Trim() -eq $blob))}
  }
  return [ordered]@{phase=$Phase; captured_at_utc=[DateTimeOffset]::UtcNow.ToString('o'); actual_HEAD=(& git -C $repo rev-parse HEAD).Trim(); files=$files}
}
$cmd = switch ($Gate) {
  'test' { 'npm test -- --run acceptance-tests/snapshot-runs.test.ts' }
  'typecheck' { 'npm run typecheck' }
  'build' { 'npm run build' }
}
Set-Content -LiteralPath (Join-Path $root 'command.txt') -Value $cmd -Encoding UTF8
Set-Content -LiteralPath (Join-Path $root 'evidence-root.txt') -Value $root -Encoding UTF8
$before = Get-SourceManifest 'before'
$before | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'source-before.json') -Encoding UTF8
$env:M0_RUN_EVIDENCE_ROOT = $root
$npm = (Get-Command npm.cmd).Source
$stdout = Join-Path $root 'stdout.log'; $stderr = Join-Path $root 'stderr.log'
$parts = $cmd.Split(' '); $cmdArgs = $parts[1..($parts.Length - 1)]; $p = Start-Process -FilePath $npm -ArgumentList $cmdArgs -WorkingDirectory $svc -RedirectStandardOutput $stdout -RedirectStandardError $stderr -Wait -PassThru -NoNewWindow
$after = Get-SourceManifest 'after'
$after | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'source-after.json') -Encoding UTF8
Set-Content -LiteralPath (Join-Path $root 'exit-code.txt') -Value ([string]$p.ExitCode) -Encoding ascii
$meta = [ordered]@{gate=$Gate; command=$cmd; working_directory=$svc; M0_RUN_EVIDENCE_ROOT=$root; external_capture_root=$root; actual_HEAD_before=$before.actual_HEAD; actual_HEAD_after=$after.actual_HEAD; exit_code=$p.ExitCode; source_before='source-before.json'; source_after='source-after.json'; files=@{ 'command.txt'=@{size_bytes=(Get-Item (Join-Path $root 'command.txt')).Length;sha256=(Get-FileHash (Join-Path $root 'command.txt') -Algorithm SHA256).Hash.ToLowerInvariant()}; 'stdout.log'=@{size_bytes=(Get-Item $stdout).Length;sha256=(Get-FileHash $stdout -Algorithm SHA256).Hash.ToLowerInvariant()}; 'stderr.log'=@{size_bytes=(Get-Item $stderr).Length;sha256=(Get-FileHash $stderr -Algorithm SHA256).Hash.ToLowerInvariant()}; 'exit-code.txt'=@{size_bytes=(Get-Item (Join-Path $root 'exit-code.txt')).Length;sha256=(Get-FileHash (Join-Path $root 'exit-code.txt') -Algorithm SHA256).Hash.ToLowerInvariant()} }}
$meta | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'capture-metadata.json') -Encoding UTF8
Write-Output "ROOT=$root"
Write-Output "GATE=$Gate EXIT=$($p.ExitCode) HEAD=$($before.actual_HEAD)"



