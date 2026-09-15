param(
  [Parameter(Mandatory = $true)][string]$InstallerPathsJson,
  [string]$ExpectedRuntimePath,
  [switch]$SignatureOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Authenticode verification must run on Windows.' }
if ([string]::IsNullOrWhiteSpace($env:AZURE_ARTIFACT_SIGNING_PUBLISHER)) { throw 'AZURE_ARTIFACT_SIGNING_PUBLISHER is required for Authenticode verification.' }
if ([string]::IsNullOrWhiteSpace($env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN)) { throw 'AZURE_ARTIFACT_SIGNING_PUBLISHER_DN is required for full Authenticode identity verification.' }
if ($SignatureOnly -and -not [string]::IsNullOrWhiteSpace($ExpectedRuntimePath)) { throw 'SignatureOnly cannot be combined with ExpectedRuntimePath.' }
if (-not $SignatureOnly -and [string]::IsNullOrWhiteSpace($ExpectedRuntimePath)) { throw 'ExpectedRuntimePath is required for strict installer verification.' }
. (Join-Path $PSScriptRoot 'artifact-signing-tools.ps1')
Import-BundledPowerShellSecurityModule

function Assert-TrustedArtifact([System.IO.FileInfo]$File, [string]$ExpectedPublisher, [string]$ExpectedSubject) {
  $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { throw "Invalid or missing Authenticode signature: $($File.FullName) ($($signature.Status))" }
  if (-not $signature.SignerCertificate) { throw "Missing signer certificate: $($File.FullName)" }
  $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($publisher -ne $ExpectedPublisher) { throw "Unexpected publisher for $($File.FullName): '$publisher'" }
  $subject = $signature.SignerCertificate.Subject.Trim()
  if ($subject -ne $ExpectedSubject) { throw "Unexpected certificate Subject for $($File.FullName). Expected '$ExpectedSubject', got '$subject'." }
  if (-not $signature.TimeStamperCertificate) { throw "Missing RFC3161 timestamp: $($File.FullName)" }
  Write-Host "Verified: $($File.FullName)"
}

# Tauri's Windows bundler patches the __TAURI_BUNDLE_TYPE marker in the main
# binary per package type (MSI -> MSI, NSIS -> NSS) and re-signs it, then
# restores the pre-bundle binary on disk. The embedded runtime therefore
# differs from the pre-bundle runtime in exactly three places: the 3-byte
# marker suffix, the PE checksum, and the Authenticode certificate table.
# Hashing the image bytes below the certificate table with those regions
# zeroed keeps strict payload verification possible.
$bundleTokenPrefix = '__TAURI_BUNDLE_TYPE_VAR_'

function Get-PeBundleTokenOffset([byte[]]$Bytes, [string]$SourcePath) {
  $unknownToken = $bundleTokenPrefix + 'UNK'
  $latin1 = [System.Text.Encoding]::GetEncoding(28591)
  $text = $latin1.GetString($Bytes)
  $offset = $text.IndexOf($unknownToken, [System.StringComparison]::Ordinal)
  if ($offset -lt 0) { throw "Missing $unknownToken marker in $SourcePath" }
  if ($text.IndexOf($unknownToken, $offset + 1, [System.StringComparison]::Ordinal) -ge 0) { throw "Multiple $unknownToken markers in $SourcePath" }
  return $offset
}

function Get-PeBundleToken([byte[]]$Bytes, [int]$BundleTokenOffset, [string]$SourcePath) {
  $tokenLength = $bundleTokenPrefix.Length + 3
  if ($BundleTokenOffset -lt 0 -or ($BundleTokenOffset + $tokenLength) -gt $Bytes.Length) { throw "Bundle marker offset is out of range in $SourcePath" }
  $latin1 = [System.Text.Encoding]::GetEncoding(28591)
  $token = $latin1.GetString($Bytes, $BundleTokenOffset, $tokenLength)
  if (-not $token.StartsWith($bundleTokenPrefix, [System.StringComparison]::Ordinal)) { throw "Missing bundle marker at the expected offset in $SourcePath" }
  return $token
}

function Get-NormalizedRuntimeHash([byte[]]$Bytes, [string]$SourcePath, [int]$BundleTokenOffset) {
  if ($Bytes.Length -lt 0x40) { throw "File is too small to be a PE image: $SourcePath" }
  $peOffset = [System.BitConverter]::ToInt32($Bytes, 0x3C)
  if ($peOffset -lt 0 -or ($peOffset + 24) -ge $Bytes.Length) { throw "Invalid PE header offset in $SourcePath" }
  if ([System.BitConverter]::ToUInt32($Bytes, $peOffset) -ne 0x00004550) { throw "Missing PE signature in $SourcePath" }
  $optionalHeaderOffset = $peOffset + 24
  $magic = [System.BitConverter]::ToUInt16($Bytes, $optionalHeaderOffset)
  $dataDirectoryOffset = $null
  if ($magic -eq 0x10B) {
    $dataDirectoryOffset = $optionalHeaderOffset + 96
  } elseif ($magic -eq 0x20B) {
    $dataDirectoryOffset = $optionalHeaderOffset + 112
  } else {
    throw ("Unsupported PE optional header magic 0x{0:X} in {1}" -f $magic, $SourcePath)
  }
  $checksumOffset = $optionalHeaderOffset + 64
  $certificateEntryOffset = $dataDirectoryOffset + (4 * 8)
  if (($certificateEntryOffset + 8) -gt $Bytes.Length) { throw "Certificate table entry is out of range in $SourcePath" }
  $certificateOffset = [int][System.BitConverter]::ToUInt32($Bytes, $certificateEntryOffset)
  $certificateSize = [int][System.BitConverter]::ToUInt32($Bytes, $certificateEntryOffset + 4)
  if ($certificateOffset -le 0 -or $certificateSize -le 0 -or (($certificateOffset + $certificateSize) -gt $Bytes.Length)) { throw "Missing Authenticode certificate table in $SourcePath" }

  $normalized = New-Object byte[] $certificateOffset
  [System.Array]::Copy($Bytes, 0, $normalized, 0, $certificateOffset)
  [System.Array]::Clear($normalized, ($BundleTokenOffset + $bundleTokenPrefix.Length), 3)
  [System.Array]::Clear($normalized, $checksumOffset, 4)
  [System.Array]::Clear($normalized, $certificateEntryOffset, 8)

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = [System.BitConverter]::ToString($sha256.ComputeHash($normalized)).Replace('-', '')
  } finally {
    $sha256.Dispose()
  }
  return [PSCustomObject]@{
    Hash = $hash
    CertificateOffset = [int]$certificateOffset
  }
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
$expectedSubject = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN.Trim()
$runtime = $null
$baselineRuntimeHash = $null
$runtimeTokenOffset = $null
$baselineCertificateOffset = $null
if (-not $SignatureOnly) {
  $runtime = Get-Item -LiteralPath (Resolve-Path -LiteralPath $ExpectedRuntimePath).Path
  if ($runtime.PSIsContainer -or $runtime.Extension.ToLowerInvariant() -ne '.exe') { throw 'ExpectedRuntimePath must resolve to an executable file.' }
  Assert-TrustedArtifact $runtime $expected $expectedSubject
  $runtimeBytes = [System.IO.File]::ReadAllBytes($runtime.FullName)
  $runtimeTokenOffset = Get-PeBundleTokenOffset $runtimeBytes $runtime.FullName
  $baselinePayload = Get-NormalizedRuntimeHash $runtimeBytes $runtime.FullName $runtimeTokenOffset
  $baselineRuntimeHash = $baselinePayload.Hash
  $baselineCertificateOffset = $baselinePayload.CertificateOffset
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

$expectedSevenZipVersion = '26.02'
$sevenZipCandidates = @()
$sevenZipCommand = Get-Command 7z.exe -ErrorAction SilentlyContinue
if ($sevenZipCommand) { $sevenZipCandidates += $sevenZipCommand.Source }
if ($env:ProgramFiles) { $sevenZipCandidates += (Join-Path $env:ProgramFiles '7-Zip\7z.exe') }
$sevenZipPath = $null
foreach ($candidate in ($sevenZipCandidates | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  $banner = (& $candidate i 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0 -and $banner -match ("(?m)^7-Zip " + [regex]::Escape($expectedSevenZipVersion) + "(?:\s|$)")) {
    $sevenZipPath = (Resolve-Path -LiteralPath $candidate).Path
    break
  }
}
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("s3-sidekick-authenticode-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
  foreach ($installer in $installers) {
    Assert-TrustedArtifact $installer $expected $expectedSubject
    $extractDir = Join-Path $tempRoot ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $extractDir | Out-Null
    if ($installer.Extension.ToLowerInvariant() -eq '.msi') {
      # Quote both paths: Start-Process joins ArgumentList with spaces, so an
      # unquoted path (default TEMP lives under C:\Users\<name>) breaks msiexec.
      $msiArguments = @('/a', ('"{0}"' -f $installer.FullName), '/qn', ('TARGETDIR="{0}"' -f $extractDir))
      $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArguments -Wait -PassThru
      if ($process.ExitCode -ne 0) { throw "MSI extraction failed for $($installer.FullName): exit $($process.ExitCode)" }
    } else {
      if (-not $sevenZipPath) { throw "Pinned 7z.exe $expectedSevenZipVersion is required to inspect signed NSIS installer payloads. Run npm run setup:win:7zip." }
      & $sevenZipPath x '-y' "-o$extractDir" $installer.FullName | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "NSIS extraction failed for $($installer.FullName): exit $LASTEXITCODE" }
    }
    $embedded = @(Get-ChildItem -LiteralPath $extractDir -File -Recurse -Filter 's3-sidekick.exe')
    if ($embedded.Count -ne 1) { throw "Expected exactly one embedded s3-sidekick.exe in $($installer.FullName); found $($embedded.Count)" }
    Assert-TrustedArtifact $embedded[0] $expected $expectedSubject
    if (-not $SignatureOnly) {
      $embeddedBytes = [System.IO.File]::ReadAllBytes($embedded[0].FullName)
      $embeddedToken = Get-PeBundleToken $embeddedBytes $runtimeTokenOffset $embedded[0].FullName
      $allowedTokens = if ($installer.Extension.ToLowerInvariant() -eq '.msi') { @($bundleTokenPrefix + 'MSI', $bundleTokenPrefix + 'UNK') } else { @($bundleTokenPrefix + 'NSS', $bundleTokenPrefix + 'UNK') }
      if ($allowedTokens -notcontains $embeddedToken) { throw "Unexpected bundle marker in the embedded runtime in $($installer.FullName): '$embeddedToken'" }
      $embeddedPayload = Get-NormalizedRuntimeHash $embeddedBytes $embedded[0].FullName $runtimeTokenOffset
      if ($embeddedPayload.CertificateOffset -ne $baselineCertificateOffset) { throw "Embedded runtime layout differs from the signed pre-bundle runtime in $($installer.FullName) (marker '$embeddedToken', certificate offset $($embeddedPayload.CertificateOffset) vs $baselineCertificateOffset)" }
      if ($embeddedPayload.Hash -ne $baselineRuntimeHash) { throw "Embedded runtime payload differs from the signed pre-bundle runtime in $($installer.FullName) (marker '$embeddedToken', expected $baselineRuntimeHash, found $($embeddedPayload.Hash))" }
    }
    # NSIS writes the uninstaller at install time from the installer payload;
    # signing only the outer .exe leaves an unsigned uninstall.exe on disk.
    # The bundle must run signCommand (!uninstfinalize) so the extracted
    # uninstaller below carries a valid signature.
    if ($installer.Extension.ToLowerInvariant() -eq '.exe') {
      $uninstallers = @(Get-ChildItem -LiteralPath $extractDir -File -Recurse | Where-Object { $_.Name -match '(?i)^uninstall.*\.exe$' })
      if ($uninstallers.Count -ne 1) { throw "Expected exactly one extracted uninstaller in $($installer.FullName); found $($uninstallers.Count). Ensure signCommand ran during bundling (!uninstfinalize)." }
      Assert-TrustedArtifact $uninstallers[0] $expected $expectedSubject
    }
  }
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
$mode = if ($SignatureOnly) { 'signature-only evidence' } else { 'strict runtime payload verification' }
Write-Host "Verified $($installers.Count) exact timestamped installer(s), including extracted runtime signatures, from '$expectedSubject' ($mode)."
