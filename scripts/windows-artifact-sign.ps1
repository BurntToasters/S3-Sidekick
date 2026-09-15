#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$FilePath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:SKIP_WIN_CODESIGN -eq '1') {
  Write-Host "SKIP_WIN_CODESIGN=1; leaving Windows artifact unsigned: $FilePath"
  exit 0
}
if ($env:OS -ne 'Windows_NT') { throw 'Azure Artifact Signing must run on Windows.' }

$required = @('AZURE_CLIENT_ID','AZURE_TENANT_ID','AZURE_CLIENT_SECRET','AZURE_ARTIFACT_SIGNING_ENDPOINT','AZURE_ARTIFACT_SIGNING_ACCOUNT','AZURE_ARTIFACT_SIGNING_PROFILE','AZURE_ARTIFACT_SIGNING_PUBLISHER','AZURE_ARTIFACT_SIGNING_PUBLISHER_DN')
$missing = @($required | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) })
if ($missing.Count) { throw "Missing Azure Artifact Signing environment variables: $($missing -join ', ')" }

$resolved = (Resolve-Path -LiteralPath $FilePath).Path
if ([IO.Path]::GetExtension($resolved).ToLowerInvariant() -in @('.appx','.msix','.appxbundle','.msixbundle')) { throw "Microsoft Store package signing is intentionally excluded: $resolved" }
. (Join-Path $PSScriptRoot 'artifact-signing-tools.ps1')
Import-BundledPowerShellSecurityModule
$tools = Get-ArtifactSigningTools
$expectedPublisher = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER.Trim()

# Idempotent for the bundle flow: the runtime is signed pre-bundle, then the
# bundler invokes this signCommand again for staged copies. Re-signing an
# already-valid binary is unnecessary work and changes its timestamp, so
# leave it untouched and only sign unsigned files (notably the NSIS
# uninstaller via !uninstfinalize). Note the bundler patches the runtime's
# package-type marker between signing passes, which intentionally invalidates
# the pre-bundle signature and forces the staged copy through this script.
try {
  $existing = Get-AuthenticodeSignature -LiteralPath $resolved
  if ($existing.Status -eq [System.Management.Automation.SignatureStatus]::Valid -and $existing.SignerCertificate -and $existing.TimeStamperCertificate) {
    $existingPublisher = $existing.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    $existingSubject = $existing.SignerCertificate.Subject.Trim()
    if ($existingPublisher -eq $expectedPublisher -and $existingSubject -eq $env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN.Trim()) {
      Write-Host "Already signed by ${expectedPublisher}; leaving bytes unchanged: $resolved"
      exit 0
    }
  }
} catch {
  # Fall through to signing when the existing state cannot be determined.
}

$metadataPath = Join-Path ([IO.Path]::GetTempPath()) "artifact-signing-$PID-$([Guid]::NewGuid().ToString('N')).json"
try {
  $metadata = @{
    Endpoint = $env:AZURE_ARTIFACT_SIGNING_ENDPOINT.Trim()
    CodeSigningAccountName = $env:AZURE_ARTIFACT_SIGNING_ACCOUNT.Trim()
    CertificateProfileName = $env:AZURE_ARTIFACT_SIGNING_PROFILE.Trim()
    ExcludeCredentials = @('ManagedIdentityCredential','WorkloadIdentityCredential','SharedTokenCacheCredential','VisualStudioCredential','VisualStudioCodeCredential','AzureCliCredential','AzurePowerShellCredential','AzureDeveloperCliCredential','InteractiveBrowserCredential')
  } | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($metadataPath, $metadata, (New-Object Text.UTF8Encoding($false)))

  Write-Host "Artifact Signing: $resolved"
  # Single timestamp host is a single point of failure for releases. Retry ACS
  # briefly, then fall back to DigiCert before failing the build.
  $timestampUrls = @('http://timestamp.acs.microsoft.com', 'http://timestamp.digicert.com')
  $signed = $false
  $lastExit = 0
  foreach ($timestampUrl in $timestampUrls) {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
      Write-Host "Signing with timestamp server $timestampUrl (attempt $attempt): $resolved"
      & $tools.SignToolPath sign /v /debug /fd SHA256 /tr $timestampUrl /td SHA256 /dlib $tools.DlibPath /dmdf $metadataPath $resolved
      $lastExit = $LASTEXITCODE
      if ($lastExit -eq 0) { $signed = $true; break }
      Start-Sleep -Milliseconds 500
    }
    if ($signed) { break }
  }
  if (-not $signed) { throw "SignTool failed with exit code $lastExit for $resolved (timestamp servers: $($timestampUrls -join ', '))" }
} finally {
  Remove-Item -LiteralPath $metadataPath -Force -ErrorAction SilentlyContinue
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolved
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { throw "Authenticode verification failed for ${resolved}: $($signature.Status) $($signature.StatusMessage)" }
if (-not $signature.SignerCertificate) { throw "Missing signer certificate: $resolved" }
$publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
if ($publisher -ne $env:AZURE_ARTIFACT_SIGNING_PUBLISHER.Trim()) { throw "Unexpected Authenticode publisher for $resolved. Expected '$($env:AZURE_ARTIFACT_SIGNING_PUBLISHER.Trim())', got '$publisher'." }
$subject = $signature.SignerCertificate.Subject.Trim()
$expectedSubject = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN.Trim()
if ($subject -ne $expectedSubject) { throw "Unexpected Authenticode Subject for $resolved. Expected '$expectedSubject', got '$subject'." }
if (-not $signature.TimeStamperCertificate) { throw "Missing RFC3161 timestamp: $resolved" }
Write-Host "Verified Authenticode signature: $subject ($resolved)"
