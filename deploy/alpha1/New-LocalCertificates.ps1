param([Parameter(Mandatory=$true)][string]$CertificateDirectory)
$ErrorActionPreference = 'Stop'
$directory = [System.IO.Path]::GetFullPath($CertificateDirectory)
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$now = [DateTimeOffset]::UtcNow
$notBefore = $now.AddMinutes(-5)
$notAfter = $now.AddDays(1)
$caKey = [System.Security.Cryptography.RSA]::Create(3072)
$leafKey = [System.Security.Cryptography.RSA]::Create(2048)
$caCertificate = $null
$leafCertificate = $null
$unsigned = $null
try {
  $caRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=Alpha1 Task4 Ephemeral CA', $caKey,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
  $caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign, $true))
  $caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false))
  $caCertificate = $caRequest.CreateSelfSigned($notBefore, $notAfter)

  $leafRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=sales.local', $leafKey,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $leafRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
  $leafRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
  $eku = [System.Security.Cryptography.OidCollection]::new()
  [void]$eku.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  $leafRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $true))
  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName('localhost'); $san.AddDnsName('sales.local'); $san.AddDnsName('management.local')
  $san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
  $leafRequest.CertificateExtensions.Add($san.Build())
  $unsigned = $leafRequest.Create($caCertificate, $notBefore, $notAfter, [byte[]](1,2,3,4,5,6,7,8))
  $leafCertificate = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($unsigned, $leafKey)
  [System.IO.File]::WriteAllText((Join-Path $directory 'ca.pem'), $caCertificate.ExportCertificatePem())
  [System.IO.File]::WriteAllText((Join-Path $directory 'leaf.pem'), $leafCertificate.ExportCertificatePem())
  [System.IO.File]::WriteAllText((Join-Path $directory 'leaf-key.pem'), $leafKey.ExportPkcs8PrivateKeyPem())
  Write-Output '{"status":"READY","certificate_names":["sales.local","management.local","localhost","127.0.0.1"],"host_trust_store_modified":false}'
} finally {
  if ($leafCertificate) { $leafCertificate.Dispose() }
  if ($unsigned) { $unsigned.Dispose() }
  if ($caCertificate) { $caCertificate.Dispose() }
  $leafKey.Dispose(); $caKey.Dispose()
}
