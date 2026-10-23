param([string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$project = [IO.Path]::GetFullPath($ProjectRoot)
$service = Join-Path $project 'integration-service'
$docs = Join-Path $project 'docs'
$output = Join-Path $project 'deliverables'
New-Item -ItemType Directory -Force -Path $output | Out-Null

function Add-Entry($archive, [string]$file, [string]$name) {
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file, ($name -replace '\\','/'), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
}
function New-Package([string]$path, [bool]$includeSource, [bool]$includeDocs) {
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  $archive = [IO.Compression.ZipFile]::Open($path, [IO.Compression.ZipArchiveMode]::Create)
  try {
    if ($includeSource) {
      Get-ChildItem -LiteralPath $service -Recurse -File | Where-Object {
        $relative = $_.FullName.Substring($service.Length).TrimStart('\')
        $relative -notmatch '^(node_modules|dist|coverage|\.git)[\\/]' -and
        $_.Name -ne '.env' -and $_.Name -notlike '*.local'
      } | ForEach-Object {
        $relative = $_.FullName.Substring($service.Length).TrimStart('\')
        Add-Entry $archive $_.FullName "integration-service/$relative"
      }
    }
    if ($includeDocs) {
      foreach ($name in @('OpenMetadata_UI扩展规格说明_v1.0.md','数据治理与本体集成中台_产品架构与二开说明_v1.0.md')) {
        $file = Join-Path $docs $name
        if (Test-Path -LiteralPath $file) { Add-Entry $archive $file "docs/$name" }
      }
    }
  } finally { $archive.Dispose() }
}
New-Package (Join-Path $output '交付件A_integration-service_v1.0.zip') $true $false
New-Package (Join-Path $output 'OpenMetadata_四页面扩展规格_v1.0.zip') $false $true
New-Package (Join-Path $output '数据治理中台_源码与文档_v1.0.zip') $true $true
Get-ChildItem -LiteralPath $output -File | Select-Object Name,Length
