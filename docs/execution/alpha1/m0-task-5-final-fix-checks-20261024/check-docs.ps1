$ErrorActionPreference = 'Stop'
$files = @(
  'docs/plans/2026-10-23-alpha1-m0-identity-isolation-implementation-plan.md',
  'docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md',
  'docs/execution/alpha1/status.md',
  'docs/execution/alpha1/m0-task-5-report.md',
  '.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/progress.md',
  '.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/task-1-brief.md',
  '.superpowers/sdd/2026-10-23-alpha1-m0-identity-isolation-implementation-plan/task-5-report.md',
  'docs/execution/alpha1/m0-task-5-final-fix-checks-20261024/commands-and-results.md'
)
$broken = [Collections.Generic.List[string]]::new()
$linkCount = 0
foreach ($file in $files) {
  $fullPath = (Resolve-Path -LiteralPath $file).Path
  $content = [IO.File]::ReadAllText($fullPath)
  foreach ($match in [regex]::Matches($content, '\[[^\]]*\]\(([^)]+)\)')) {
    $destination = $match.Groups[1].Value.Trim()
    if ($destination -match '^(https?://|mailto:|#|data:|codex:)') { continue }
    $destination = ($destination -split '[?#]', 2)[0]
    if (-not $destination) { continue }
    $linkCount++
    $candidate = Join-Path (Split-Path -Parent $fullPath) ($destination -replace '/', '\')
    if (-not (Test-Path -LiteralPath $candidate)) {
      [void]$broken.Add("$file -> $destination")
    }
  }
}
Write-Output "MARKDOWN_LINKS_CHECKED=$linkCount"
Write-Output "BROKEN_LINKS=$($broken.Count)"
$broken | ForEach-Object { Write-Output $_ }

$m1 = [IO.File]::ReadAllText((Resolve-Path -LiteralPath 'docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md'))
$ledger = [IO.File]::ReadAllText((Resolve-Path -LiteralPath '.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/progress.md'))
$ledgerTitle = Get-Content -LiteralPath '.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/progress.md' -TotalCount 1
$brief = [IO.File]::ReadAllText((Resolve-Path -LiteralPath '.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/task-1-brief.md'))
$checks = @(
  [pscustomobject]@{ Name='durable ordinary pause/edit'; Passed=($m1 -match 'ordinary pause or ordinary endpoint/config/mapping edit stops new admission and leaves already durable jobs eligible') },
  [pscustomobject]@{ Name='separate durable security barrier'; Passed=($m1 -match 'durable security barrier') },
  [pscustomobject]@{ Name='epoch mismatch not lifetime auth'; Passed=($m1 -match 'admission epoch decides whether a new batch may commit; it is not a worker lifetime authorization token') },
  [pscustomobject]@{ Name='single primary channel'; Passed=($m1 -match 'at most one active primary synchronization channel') },
  [pscustomobject]@{ Name='M1-1 first activation without M1-5'; Passed=($m1 -match 'First activation can use M1-1.*without depending on M1-5') },
  [pscustomobject]@{ Name='switch owned by M1-5'; Passed=($m1 -match 'channel or version-mode switch remains unavailable until the M1-5') },
  [pscustomobject]@{ Name='old epoch rejection'; Passed=($m1 -match 'CHANNEL_EPOCH_RETIRED') },
  [pscustomobject]@{ Name='no cross-mode compare'; Passed=($m1 -match 'never compared') },
  [pscustomobject]@{ Name='transition table'; Passed=($m1 -match 'Durable-job and channel transition examples') },
  [pscustomobject]@{ Name='current owner approval revision'; Passed=($brief -match 'Owner-bound API-007/API-060 approvals are invalidated when the binding revision changes') },
  [pscustomobject]@{ Name='normalized ledger heading'; Passed=($ledgerTitle -eq '# SDD ledger — plan: docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md') },
  [pscustomobject]@{ Name='brief has security and switch cases'; Passed=(($brief -match 'security barrier') -and ($brief -match 'connector or version-mode switching is explicitly unavailable')) }
)
$failed = 0
foreach ($check in $checks) {
  $state = if ($check.Passed) { 'PASS' } else { 'FAIL' }
  Write-Output "SEMANTIC_$($check.Name.ToUpper().Replace(' ', '_'))=$state"
  if (-not $check.Passed) { $failed++ }
}
if ($broken.Count -or $failed) { exit 1 }
