param(
  [Parameter(Mandatory = $true)][string]$InstallerPathsJson,
  [string]$ExpectedRuntimePath,
  [switch]$SignatureOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Authenticode verification must run on Windows.' }
if ([string]::IsNullOrWhiteSpace($env:AZURE_ARTIFACT_SIGNING_PUBLISHER)) { throw 'AZURE_ARTIFACT_SIGNING_PUBLISHER is required for Authenticode verification.' }
if ($SignatureOnly -and -not [string]::IsNullOrWhiteSpace($ExpectedRuntimePath)) { throw 'SignatureOnly cannot be combined with ExpectedRuntimePath.' }
if (-not $SignatureOnly -and [string]::IsNullOrWhiteSpace($ExpectedRuntimePath)) { throw 'ExpectedRuntimePath is required for strict installer verification.' }
. (Join-Path $PSScriptRoot 'artifact-signing-tools.ps1')
Import-BundledPowerShellSecurityModule

function Assert-TrustedArtifact([System.IO.FileInfo]$File, [string]$ExpectedPublisher) {
  $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { throw "Invalid or missing Authenticode signature: $($File.FullName) ($($signature.Status))" }
  if (-not $signature.SignerCertificate) { throw "Missing signer certificate: $($File.FullName)" }
  $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($publisher -ne $ExpectedPublisher) { throw "Unexpected publisher for $($File.FullName): '$publisher'" }
  if (-not $signature.TimeStamperCertificate) { throw "Missing RFC3161 timestamp: $($File.FullName)" }
  Write-Host "Verified: $($File.FullName)"
}

if (-not $InstallerPathsJson.Trim().StartsWith('[')) { throw 'InstallerPathsJson must be a JSON array.' }
try {
  $parsedInstallerPaths = ConvertFrom-Json -InputObject $InstallerPathsJson -ErrorAction Stop
} catch {
  throw "InstallerPathsJson is invalid: $($_.Exception.Message)"
}
$rawInstallerPaths = @($parsedInstallerPaths)
if ($rawInstallerPaths.Count -eq 0) { throw 'InstallerPathsJson must contain at least one installer.' }

$expected = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER.Trim()
$runtime = $null
$baselineRuntimeHash = $null
if (-not $SignatureOnly) {
  $runtime = Get-Item -LiteralPath (Resolve-Path -LiteralPath $ExpectedRuntimePath).Path
  if ($runtime.PSIsContainer -or $runtime.Extension.ToLowerInvariant() -ne '.exe') { throw 'ExpectedRuntimePath must resolve to an executable file.' }
  Assert-TrustedArtifact $runtime $expected
  $baselineRuntimeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $runtime.FullName).Hash
}

$seenPaths = @{}
$installers = @()
foreach ($rawPath in $rawInstallerPaths) {
  if ($rawPath -isnot [string] -or [string]::IsNullOrWhiteSpace($rawPath)) { throw 'Every installer path must be a non-empty string.' }
  $installer = Get-Item -LiteralPath (Resolve-Path -LiteralPath $rawPath).Path
  if ($installer.PSIsContainer -or $installer.Extension.ToLowerInvariant() -notin @('.exe', '.msi')) { throw "Installer path is not an .exe or .msi file: $rawPath" }
  $identity = $installer.FullName.ToLowerInvariant()
  if ($seenPaths.ContainsKey($identity)) { throw "Duplicate installer path: $($installer.FullName)" }
  if ($runtime -and $identity -eq $runtime.FullName.ToLowerInvariant()) { throw "Installer path aliases the expected runtime: $($installer.FullName)" }
  $seenPaths[$identity] = $true
  $installers += $installer
}

$sevenZip = Get-Command 7z.exe -ErrorAction SilentlyContinue
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("s3-sidekick-authenticode-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
  foreach ($installer in $installers) {
    Assert-TrustedArtifact $installer $expected
    $extractDir = Join-Path $tempRoot ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $extractDir | Out-Null
    if ($installer.Extension.ToLowerInvariant() -eq '.msi') {
      $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/a', $installer.FullName, '/qn', "TARGETDIR=$extractDir") -Wait -PassThru
      if ($process.ExitCode -ne 0) { throw "MSI extraction failed for $($installer.FullName): exit $($process.ExitCode)" }
    } else {
      if (-not $sevenZip) { throw '7z.exe is required to inspect signed NSIS installer payloads.' }
      & $sevenZip.Source x '-y' "-o$extractDir" $installer.FullName | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "NSIS extraction failed for $($installer.FullName): exit $LASTEXITCODE" }
    }
    $embedded = @(Get-ChildItem -LiteralPath $extractDir -File -Recurse -Filter 's3-sidekick.exe')
    if ($embedded.Count -ne 1) { throw "Expected exactly one embedded s3-sidekick.exe in $($installer.FullName); found $($embedded.Count)" }
    Assert-TrustedArtifact $embedded[0] $expected
    if (-not $SignatureOnly) {
      $embeddedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $embedded[0].FullName).Hash
      if ($embeddedHash -ne $baselineRuntimeHash) { throw "Embedded runtime differs from the signed pre-bundle runtime in $($installer.FullName)" }
    }
  }
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
$mode = if ($SignatureOnly) { 'signature-only evidence' } else { 'strict runtime-byte verification' }
Write-Host "Verified $($installers.Count) exact timestamped installer(s), including extracted runtime signatures, from '$expected' ($mode)."
