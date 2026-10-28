param(
  [Parameter(Mandatory=$true)][string]$Label,
  [Parameter(Mandatory=$true)][string]$WorkingDirectory,
  [Parameter(Mandatory=$true)][string]$RunRoot,
  [Parameter(Mandatory=$true)][string[]]$SourcePaths,
  [Parameter(Mandatory=$true)][string[]]$CommandArguments
)
$ErrorActionPreference = 'Stop'
$RunRoot = [IO.Path]::GetFullPath($RunRoot)
$env:M0_RUN_EVIDENCE_ROOT = $RunRoot
$cwd = [IO.Path]::GetFullPath($WorkingDirectory)
$outDir = Join-Path $RunRoot $Label
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
function Git-Text([string[]]$GitArgs) {
  $psi = [Diagnostics.ProcessStartInfo]::new('git')
  $psi.WorkingDirectory = $cwd
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  foreach ($arg in $GitArgs) { $psi.ArgumentList.Add($arg) }
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync(); $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "git $($GitArgs -join ' ') failed: $($e.Result)" }
  return $o.Result.Trim()
}
function Snapshot([string]$Phase) {
  $rows = foreach ($rel in $SourcePaths) {
    $path = Join-Path $cwd $rel
    $bytes = [IO.File]::ReadAllBytes($path)
    $lf = [Text.Encoding]::UTF8.GetBytes([Text.Encoding]::UTF8.GetString($bytes).Replace("`r`n","`n"))
    $sha = [Security.Cryptography.SHA256]::HashData($bytes)
    $lfSha = [Security.Cryptography.SHA256]::HashData($lf)
    $blob = Git-Text @('hash-object','--',$rel)
    [pscustomobject]@{ path=$rel; size=$bytes.Length; sha256=([Convert]::ToHexString($sha).ToLowerInvariant()); lf_sha256=([Convert]::ToHexString($lfSha).ToLowerInvariant()); git_blob=$blob }
  }
  $rows | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $outDir "$Phase-source.json") -Encoding utf8
}
$started = [DateTime]::UtcNow.ToString('o')
$head = Git-Text @('rev-parse','HEAD')
Snapshot 'before'
$psi = [Diagnostics.ProcessStartInfo]::new('cmd.exe')
$psi.WorkingDirectory = $cwd; $psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$psi.ArgumentList.Add('/d'); $psi.ArgumentList.Add('/c')
$psi.ArgumentList.Add(('npm.cmd ' + ($CommandArguments -join ' ')))
$p = [Diagnostics.Process]::Start($psi)
$stdoutTask = $p.StandardOutput.ReadToEndAsync(); $stderrTask = $p.StandardError.ReadToEndAsync()
$stdoutTask.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $outDir 'stdout.txt') -Encoding utf8
$stderrTask.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $outDir 'stderr.txt') -Encoding utf8
$p.WaitForExit()
$exitCode = $p.ExitCode
Snapshot 'after'
$headAfter = Git-Text @('rev-parse','HEAD')
[pscustomobject]@{ label=$Label; program='cmd.exe'; arguments=@('/d','/c',('npm.cmd '+($CommandArguments -join ' '))); cwd=$cwd; evidence_root=$RunRoot; actual_head_before=$head; actual_head_after=$headAfter; started_utc=$started; finished_utc=[DateTime]::UtcNow.ToString('o'); exit_code=$exitCode; stdout=(Join-Path $outDir 'stdout.txt'); stderr=(Join-Path $outDir 'stderr.txt') } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $outDir 'command.json') -Encoding utf8
Write-Output "CAPTURED label=$Label exit=$exitCode root=$RunRoot head=$head"
Get-Content -LiteralPath (Join-Path $outDir 'stdout.txt')
Get-Content -LiteralPath (Join-Path $outDir 'stderr.txt') | ForEach-Object { [Console]::Error.WriteLine($_) }
exit $exitCode


