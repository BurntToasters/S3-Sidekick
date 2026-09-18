#requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Pinned 7-Zip setup must run on Windows.' }

$expectedVersion = '26.02'
function Find-SevenZip {
  $candidates = @()
  $command = Get-Command 7z.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles '7-Zip\7z.exe') }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $banner = (& $candidate i 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 0 -and $banner -match ("(?m)^7-Zip " + [regex]::Escape($expectedVersion) + "(?:\s|$)")) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

$sevenZip = Find-SevenZip
if ($sevenZip) {
  Write-Host "Pinned 7-Zip $expectedVersion is already installed: $sevenZip"
  exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Installing pinned 7-Zip $expectedVersion requires an elevated PowerShell session."
}
$winget = Get-Command winget.exe -ErrorAction SilentlyContinue
if (-not $winget) { throw 'winget.exe is required to install the pinned, manifest-hashed 7-Zip package.' }

# winget's community manifest pins the installer URL and SHA-256 for this exact version.
& $winget.Source install --exact --id 7zip.7zip --version $expectedVersion --source winget --scope machine --accept-package-agreements --accept-source-agreements --silent --force
if ($LASTEXITCODE -ne 0) { throw "Pinned 7-Zip installation failed with exit code $LASTEXITCODE." }
$sevenZip = Find-SevenZip
if (-not $sevenZip) { throw "7-Zip $expectedVersion was installed but could not be verified." }
Write-Host "Pinned 7-Zip $expectedVersion is ready: $sevenZip"
