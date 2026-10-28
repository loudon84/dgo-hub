param([ValidateSet('build','typecheck','recovery','worker')][string]$taskGate)
$runId=[guid]::NewGuid().ToString(); $root="E:/m1t5-runtime/$runId"
New-Item -ItemType Directory -Path $root -Force | Out-Null
$env:M0_RUN_EVIDENCE_ROOT=$root.Replace('/','\')
$files=@('integration-service/acceptance-tests/quarantine-read.test.ts','integration-service/acceptance-tests/recovery-crash-driver.mjs','integration-service/acceptance-tests/strict-ingestion.test.ts','integration-service/ingestion-api/quarantine-read.ts','integration-service/ingestion-api/quarantine-recovery.ts','integration-service/ingestion-api/strict-ingestion.ts','integration-service/ingestion-api/strict-contract.ts','integration-service/etl-worker/worker.ts','integration-service/normalization/apply.ts','integration-service/migrations/001_init.sql','integration-service/migrations/002_identity_auth.sql','integration-service/migrations/003_mcp_audit_boundary.sql','integration-service/migrations/004_alpha1_runtime_security.sql','integration-service/migrations/005_source_registry.sql','integration-service/migrations/006_canonical_data_and_receipts.sql','integration-service/migrations/007_durable_ingestion_jobs.sql','integration-service/migrations/008_durable_worker_leases_and_retries.sql','integration-service/migrations/009_snapshot_runs_and_recovery.sql','.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/context/m1-task5e1a2-2-schema-contract.md','docs/数据治理与本体集成中台_产品架构与二开说明_v1.0.md','docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md')
function Capture($name) {
 $rows=foreach($f in $files){$bytes=[IO.File]::ReadAllBytes((Resolve-Path $f)); $lf=[Text.Encoding]::UTF8.GetBytes(([Text.Encoding]::UTF8.GetString($bytes) -replace "`r`n","`n")); $sha=[Security.Cryptography.SHA256]::Create(); [pscustomobject]@{path=$f;size=$bytes.Length;raw_sha256=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLower();lf_sha256=([BitConverter]::ToString($sha.ComputeHash($lf))).Replace('-','').ToLower();git_blob=(git hash-object -- $f)} }
 $rows | ConvertTo-Json | Set-Content -Encoding utf8 "$root/$name.json"
 git rev-parse HEAD | Set-Content "$root/$name-head.txt"
}
$command=switch($taskGate){'build'{'npm run build'} 'typecheck'{'npm run typecheck'} 'recovery'{'npx vitest run acceptance-tests/quarantine-read.test.ts -t ''creates and runs a same-target|preserves the complete order'''} 'worker'{'npx vitest run acceptance-tests/strict-ingestion.test.ts -t "applies a committed HTTP job|quarantines an order"'}}
"cwd=E:/git/dgo-hub/integration-service; command=$command; M0_RUN_EVIDENCE_ROOT=$env:M0_RUN_EVIDENCE_ROOT" | Set-Content "$root/command.txt"
Capture 'before'
if($taskGate -eq 'recovery'){Get-FileHash 'integration-service/dist/etl-worker/worker.js' -Algorithm SHA256 | ConvertTo-Json | Set-Content "$root/dist-worker-before.json"}
Push-Location integration-service
try {
 switch($taskGate){
  'build' { & npm run build 1>"$root/stdout.txt" 2>"$root/stderr.txt" }
  'typecheck' { & npm run typecheck 1>"$root/stdout.txt" 2>"$root/stderr.txt" }
  'recovery' { & npx vitest run acceptance-tests/quarantine-read.test.ts -t 'creates and runs a same-target|preserves the complete order' 1>"$root/stdout.txt" 2>"$root/stderr.txt" }
  'worker' { & npx vitest run acceptance-tests/strict-ingestion.test.ts -t 'applies a committed HTTP job|quarantines an order' 1>"$root/stdout.txt" 2>"$root/stderr.txt" }
 }
 $code=$LASTEXITCODE
} finally { Pop-Location }
Capture 'after'
if($taskGate -eq 'build'){Get-FileHash 'integration-service/dist/etl-worker/worker.js' -Algorithm SHA256 | ConvertTo-Json | Set-Content "$root/dist-worker.json"}
if($taskGate -eq 'recovery'){Get-FileHash 'integration-service/dist/etl-worker/worker.js' -Algorithm SHA256 | ConvertTo-Json | Set-Content "$root/dist-worker-after.json"}
$code | Set-Content "$root/exit.txt"
Write-Output "gate=$taskGate root=$root exit=$code"
Get-Content "$root/stdout.txt"
Get-Content "$root/stderr.txt"
