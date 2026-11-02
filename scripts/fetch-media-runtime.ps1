# Obtain only the Windows runtime already pinned by media-runtime.manifest.json.
# No PATH lookup, package installation, user-data scan, or media execution.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$DestinationDirectory,
  [string]$ManifestPath,
  [string]$ArchivePath,
  [string]$GitHubEnvFile
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
if (-not $ManifestPath) { $ManifestPath = Join-Path $PSScriptRoot 'media-runtime.manifest.json' }

function Absolute-Path([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) {
    throw 'Media runtime paths must be absolute.'
  }
  $full = [IO.Path]::GetFullPath($Value)
  if ($full -eq [IO.Path]::GetPathRoot($full)) { return $full }
  return $full.TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-NoReparse([string]$Value) {
  $itemPath = [IO.Path]::GetFullPath($Value)
  while (-not [string]::IsNullOrWhiteSpace($itemPath)) {
    if (Test-Path -LiteralPath $itemPath) {
      $item = Get-Item -LiteralPath $itemPath -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('Linked media runtime path is not allowed: ' + $itemPath)
      }
    }
    $parent = [IO.Directory]::GetParent($itemPath)
    if ($null -eq $parent) { break }
    $itemPath = $parent.FullName
  }
}

function File-Sha256([string]$File) {
  $stream = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
  } finally { $stream.Dispose() }
}

function Assert-File([string]$File, [long]$Size, [string]$Sha) {
  Assert-NoReparse $File
  $item = Get-Item -LiteralPath $File -Force
  if ($item.PSIsContainer -or $item.Length -ne $Size -or (File-Sha256 $File) -cne $Sha) {
    throw ('Media runtime input differs from pinned manifest: ' + $item.Name)
  }
}

function Assert-Source([string]$Directory, $Manifest) {
  Assert-NoReparse $Directory
  $actual = @()
  $pending = New-Object 'Collections.Generic.Stack[string]'
  $pending.Push($Directory)
  while ($pending.Count -gt 0) {
    foreach ($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked media runtime source is not allowed.' }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
      else { $actual += $item.FullName.Substring($Directory.Length + 1).Replace('\', '/') }
    }
  }
  $expected = @($Manifest.files | ForEach-Object { $_.path })
  if ($actual.Count -ne 4 -or @(Compare-Object $actual $expected).Count -ne 0) {
    throw 'Media runtime source must contain exactly the four pinned files.'
  }
  foreach ($entry in $Manifest.files) {
    Assert-File (Join-Path $Directory $entry.path) ([long]$entry.size) $entry.sha256
  }
}

function Publish-Source([string]$Directory, [string]$ManifestHash, [bool]$Reused) {
  if ($GitHubEnvFile) {
    $envFile = Absolute-Path $GitHubEnvFile
    Assert-NoReparse $envFile
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw 'GitHub environment file must already exist.' }
    [IO.File]::AppendAllText($envFile, "LUMI_MEDIA_RUNTIME_SOURCE=$Directory`n", (New-Object Text.UTF8Encoding $false))
  }
  [ordered]@{ sourceDirectory = $Directory; manifestSha256 = $ManifestHash; archiveSha256 = $manifest.archive.sha256;
    version = $manifest.version; platform = $manifest.platform; arch = $manifest.arch; filesVerified = 4;
    reused = $Reused; executablesRun = 0; license = $manifest.license.spdx } | ConvertTo-Json -Compress
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) {
  throw 'This pinned media input supports Windows x64 only.'
}
$destination = Absolute-Path $DestinationDirectory
$manifestFile = Absolute-Path $ManifestPath
if ($destination -match '[\r\n]') { throw 'Media runtime destination contains a newline.' }
Assert-NoReparse $destination
Assert-NoReparse $manifestFile
$manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$manifestHash = File-Sha256 $manifestFile
$allowed = @('bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE', 'README.txt')
if ($manifest.schemaVersion -ne 1 -or $manifest.platform -cne 'win32' -or $manifest.arch -cne 'x64' -or
    @($manifest.files).Count -ne 4 -or @($manifest.files.path | Sort-Object -Unique).Count -ne 4 -or
    @(Compare-Object @($manifest.files.path) $allowed).Count -ne 0) { throw 'Invalid Windows media manifest file set.' }
if ($manifest.license.spdx -cne 'GPL-3.0-or-later' -or $manifest.license.nonfreeEnabled -isnot [bool] -or $manifest.license.nonfreeEnabled) {
  throw 'Pinned media license policy does not match the reviewed distribution.'
}
foreach ($entry in $manifest.files) {
  if ($entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $entry.size -le 0 -or $entry.size -gt 512MB) { throw 'Invalid pinned media file hash or size.' }
}
if ($manifest.archive.url -cnotmatch '^https://github\.com/GyanD/codexffmpeg/releases/download/[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+\.zip$' -or
    $manifest.archive.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $manifest.archive.sizeBytes -le 0 -or
    $manifest.archive.sizeBytes -gt 1GB -or $manifest.archive.rootDirectory -cnotmatch '^[a-zA-Z0-9._-]+$') {
  throw 'Invalid pinned upstream archive identity.'
}
if (Test-Path -LiteralPath $destination) {
  if (-not (Test-Path -LiteralPath $destination -PathType Container)) { throw 'Media destination is not a directory.' }
  Assert-Source $destination $manifest
  Publish-Source $destination $manifestHash $true
  exit 0
}

$parentDirectory = [IO.Directory]::GetParent($destination).FullName
[IO.Directory]::CreateDirectory($parentDirectory) | Out-Null
Assert-NoReparse $parentDirectory
# Owned temporary directory is retained on failure for CI diagnostics; never delete an input/cache.
$stage = Join-Path $parentDirectory ('.lumi-media-fetch-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stage) | Out-Null
$source = Join-Path $stage 'source'
[IO.Directory]::CreateDirectory((Join-Path $source 'bin')) | Out-Null
if ($ArchivePath) {
  $archive = Absolute-Path $ArchivePath
  Assert-NoReparse $archive
} else {
  $archive = Join-Path $stage 'upstream.zip'
  Invoke-WebRequest -Uri $manifest.archive.url -OutFile $archive -UseBasicParsing -TimeoutSec 600
}
Assert-File $archive ([long]$manifest.archive.sizeBytes) $manifest.archive.sha256
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveStream = [IO.File]::Open($archive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  $zip = New-Object IO.Compression.ZipArchive($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $true)
  try {
    foreach ($entry in $manifest.files) {
      $zipPath = $manifest.archive.rootDirectory + '/' + $entry.path
      $matches = @($zip.Entries | Where-Object { $_.FullName -ceq $zipPath })
      if ($matches.Count -ne 1 -or $matches[0].Length -ne [long]$entry.size) { throw ('Missing/duplicate/wrong-size pinned ZIP member: ' + $entry.path) }
      $zipEntry = $matches[0]
      if ((($zipEntry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Linked ZIP members are not accepted.' }
      $output = Join-Path $source $entry.path
      $inputStream = $zipEntry.Open()
      try {
        $outputStream = [IO.File]::Open($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
      } finally { $inputStream.Dispose() }
      Assert-File $output ([long]$entry.size) $entry.sha256
    }
  } finally { $zip.Dispose() }
} finally { $archiveStream.Dispose() }
Assert-Source $source $manifest
Assert-NoReparse $destination
if (Test-Path -LiteralPath $destination) { throw 'Media destination appeared during preparation; refusing overwrite.' }
[IO.Directory]::Move($source, $destination)
Assert-Source $destination $manifest
Publish-Source $destination $manifestHash $false
