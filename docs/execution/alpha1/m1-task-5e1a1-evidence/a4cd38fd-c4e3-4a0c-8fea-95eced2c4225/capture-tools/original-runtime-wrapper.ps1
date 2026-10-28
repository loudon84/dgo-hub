param([Parameter(Mandatory=$true)][string]$Label,[Parameter(Mandatory=$true)][string]$Program,[string[]]$Arguments=@())
$ErrorActionPreference='Stop'
$repo='E:\git\dgo-hub'; $service=Join-Path $repo 'integration-service'; $root=$env:M0_RUN_EVIDENCE_ROOT
if(-not $root -or -not (Test-Path -LiteralPath $root)){ throw 'M0_RUN_EVIDENCE_ROOT_REQUIRED' }
$runDir=Join-Path $root $Label
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$files=& git -C $repo ls-files -- integration-service/ingestion-api integration-service/etl-worker integration-service/auth integration-service/contracts integration-service/migrations integration-service/normalization integration-service/acceptance-tests integration-service/app.ts
function Snap([string]$tag){
  $dest=Join-Path $runDir $tag; New-Item -ItemType Directory -Path $dest -Force | Out-Null
  $rows=@()
  foreach($rel in $files){
    $full=Join-Path $repo $rel
    if(-not (Test-Path -LiteralPath $full -PathType Leaf)){continue}
    $bytes=[System.IO.File]::ReadAllBytes($full)
    $raw=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    $text=[System.Text.Encoding]::UTF8.GetString($bytes).Replace("`r`n","`n").Replace("`r","`n")
    $lf=[System.Text.Encoding]::UTF8.GetBytes($text)
    $lfHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($lf)).ToLowerInvariant()
    $blob=(& git -C $repo hash-object -- $rel).Trim()
    $copy=Join-Path $dest ($rel.Replace('/','\'))
    New-Item -ItemType Directory -Path (Split-Path -Parent $copy) -Force | Out-Null
    [System.IO.File]::WriteAllBytes($copy,$bytes)
    $copyBytes=[System.IO.File]::ReadAllBytes($copy)
    $copyHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($copyBytes)).ToLowerInvariant()
    if($raw -ne $copyHash){throw "EVIDENCE_COPY_HASH_MISMATCH:$rel"}
    $rows+= [pscustomobject]@{path=$rel;size=$bytes.Length;sha256_raw=$raw;sha256_lf=$lfHash;git_blob=$blob;copy_path=$copy;copy_sha256=$copyHash}
  }
  $head=(& git -C $repo rev-parse HEAD).Trim()
  [pscustomobject]@{label=$Label;snapshot=$tag;head=$head;files=$rows} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runDir "$tag-manifest.json") -Encoding utf8
}
Snap 'before'
$stdout=Join-Path $runDir 'stdout.txt'; $stderr=Join-Path $runDir 'stderr.txt'
Push-Location $service
try {
  $process=Start-Process -FilePath $Program -ArgumentList $Arguments -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $exit=$process.ExitCode
} finally { Pop-Location }
Snap 'after'
[pscustomobject]@{label=$Label;program=$Program;arguments=$Arguments;exit_code=$exit;stdout=$stdout;stderr=$stderr;started_utc=(Get-Item $stdout).CreationTimeUtc.ToString('o');finished_utc=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runDir 'command.json') -Encoding utf8
Get-Content -Raw $stdout
Get-Content -Raw $stderr
"EXIT_CODE=$exit"
exit $exit

