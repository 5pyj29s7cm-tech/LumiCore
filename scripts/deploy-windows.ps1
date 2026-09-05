# LumiCore Windows Deployment
# Run as Administrator for C:\Program Files install
#   ./scripts/deploy-windows.ps1
# Or for per-user install (no admin needed):
#   ./scripts/deploy-windows.ps1 -InstallDir "$env:LOCALAPPDATA\LumiCore"

param(
  [string]$InstallDir = "$env:ProgramFiles\LumiCore"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Resolve-Path "$ScriptDir\.."

function Invoke-CheckedNativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @()
  )
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath failed with exit code $LASTEXITCODE. Deployment stopped."
  }
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  LumiCore Deployment" -ForegroundColor Cyan
Write-Host "  Install: $InstallDir" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

# ── Prerequisites ──────────────────────────────────────────────────────
Write-Host "[1/6] Checking prerequisites..." -ForegroundColor Yellow

$nodeVersion = Invoke-CheckedNativeCommand -FilePath "node" -ArgumentList @("--version")
if (-not $nodeVersion) {
  Write-Host "ERROR: Node.js not found. Install from https://nodejs.org (v18+)" -ForegroundColor Red
  exit 1
}
Write-Host "  Node.js $nodeVersion" -ForegroundColor Green

$rustVersion = Invoke-CheckedNativeCommand -FilePath "rustc" -ArgumentList @("--version")
if (-not $rustVersion) {
  Write-Host "ERROR: Rust not found. Install from https://rustup.rs" -ForegroundColor Red
  exit 1
}
Write-Host "  Rust $rustVersion" -ForegroundColor Green

# Check VS Build Tools (needed for sqlite3 native module)
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vsWhere) {
  Write-Host "  Visual Studio Build Tools: found" -ForegroundColor Green
} else {
  Write-Host "  WARNING: Visual Studio Build Tools not detected." -ForegroundColor Yellow
  Write-Host "  If sqlite3 fails to build, install from: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022" -ForegroundColor Yellow
}

# ── Install dependencies ──────────────────────────────────────────────
Write-Host "[2/6] Installing npm dependencies..." -ForegroundColor Yellow
Push-Location $ProjectDir
try {
Invoke-CheckedNativeCommand -FilePath "npm.cmd" -ArgumentList @("ci")
Write-Host "  Done." -ForegroundColor Green

# ── Build ─────────────────────────────────────────────────────────────
Write-Host "[3/6] Building frontend + backend..." -ForegroundColor Yellow

Write-Host "  Building frontend..." -ForegroundColor Gray
Invoke-CheckedNativeCommand -FilePath "npm.cmd" -ArgumentList @("run", "build")
Write-Host "  Building backend..." -ForegroundColor Gray
Invoke-CheckedNativeCommand -FilePath "npm.cmd" -ArgumentList @("run", "build:server")
Write-Host "  Downloading Node.js runtime..." -ForegroundColor Gray
Invoke-CheckedNativeCommand -FilePath "node" -ArgumentList @("scripts/download-node-binary.mjs")
Write-Host "  Preparing desktop resources..." -ForegroundColor Gray
Invoke-CheckedNativeCommand -FilePath "npm.cmd" -ArgumentList @("run", "prepare:desktop")
Write-Host "  Done." -ForegroundColor Green

# ── Compile Rust ──────────────────────────────────────────────────────
Write-Host "[4/6] Compiling desktop shell (Rust)... this may take a few minutes" -ForegroundColor Yellow
Push-Location "$ProjectDir\src-tauri"
try {
  # A separate build destination prevents installing a previous release EXE.
  $DeployTargetRoot = [IO.Path]::GetFullPath((Join-Path $ProjectDir "src-tauri\target"))
  $DeployTargetDir = Join-Path $DeployTargetRoot ("deploy-" + [Guid]::NewGuid().ToString("N"))
  Invoke-CheckedNativeCommand -FilePath "cargo" -ArgumentList @("build", "--release", "--target-dir", $DeployTargetDir)
} finally {
  Pop-Location
}
Write-Host "  Done." -ForegroundColor Green

# ── Install ───────────────────────────────────────────────────────────
Write-Host "[5/6] Installing to $InstallDir..." -ForegroundColor Yellow

# Check all mandatory build outputs before touching the installation.
$exeSrc = Join-Path $DeployTargetDir "release\lumi-core.exe"
if (-not (Test-Path $exeSrc)) {
  throw "lumi-core.exe not found at $exeSrc"
}
$distServerSrc = "$ProjectDir\desktop-resources\dist-server"
foreach ($requiredFile in @("entry.cjs", "server.mjs", "node.exe", "runtime-meta.json")) {
  if (-not (Test-Path -LiteralPath (Join-Path $distServerSrc $requiredFile) -PathType Leaf)) {
    throw "Prepared backend file $requiredFile is missing. Deployment stopped."
  }
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $exeSrc "$InstallDir\lumi-core.exe" -Force
Write-Host "  lumi-core.exe" -ForegroundColor Gray

# Copy WebView2Loader.dll (Windows only)
$dllSrc = Join-Path $DeployTargetDir "release\WebView2Loader.dll"
if (Test-Path $dllSrc) {
  Copy-Item $dllSrc "$InstallDir\WebView2Loader.dll" -Force
  Write-Host "  WebView2Loader.dll" -ForegroundColor Gray
} else {
  $dllSrc2 = "$ProjectDir\desktop-resources\WebView2Loader.dll"
  if (Test-Path $dllSrc2) {
    Copy-Item $dllSrc2 "$InstallDir\WebView2Loader.dll" -Force
    Write-Host "  WebView2Loader.dll (from desktop-resources)" -ForegroundColor Gray
  } else {
    Write-Host "  WARNING: WebView2Loader.dll not found - app may fail to start" -ForegroundColor Yellow
  }
}

# Copy dist-server (Node.js backend)
Copy-Item "$distServerSrc\*" "$InstallDir\dist-server\" -Recurse -Force
Write-Host "  dist-server/" -ForegroundColor Gray

# Copy GPT-SoVITS if exists (optional local voice)
$ttsSrc = "$ProjectDir\desktop-resources\gpt-sovits-src"
if ((Test-Path $ttsSrc) -and (Get-ChildItem $ttsSrc -Filter *.py | Select-Object -First 1)) {
  Copy-Item "$ttsSrc\*" "$InstallDir\gpt-sovits-src\" -Recurse -Force
  Write-Host "  gpt-sovits-src/ (local TTS)" -ForegroundColor Gray
}

Write-Host "  Installed." -ForegroundColor Green

# ── Desktop shortcut ──────────────────────────────────────────────────
Write-Host "[6/6] Creating desktop shortcut..." -ForegroundColor Yellow

$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = "$desktopPath\LumiCore.lnk"
$WScriptShell = New-Object -ComObject WScript.Shell
$Shortcut = $WScriptShell.CreateShortcut($shortcutPath)
$Shortcut.TargetPath = "$InstallDir\lumi-core.exe"
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.Description = "LumiCore - Personal AI"
if (Test-Path "$InstallDir\lumi-core.exe") {
  $Shortcut.IconLocation = "$InstallDir\lumi-core.exe,0"
}
$Shortcut.Save()
Write-Host "  Shortcut: $shortcutPath" -ForegroundColor Green

} finally {
  Pop-Location
  if ($DeployTargetDir -and (Test-Path -LiteralPath $DeployTargetDir)) {
    $ResolvedDeployTarget = (Resolve-Path -LiteralPath $DeployTargetDir).Path
    if (-not $ResolvedDeployTarget.StartsWith($DeployTargetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a build directory outside the deployment target root."
    }
    Remove-Item -LiteralPath $ResolvedDeployTarget -Recurse -Force
  }
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Deployment complete!" -ForegroundColor Cyan
Write-Host "  Data: $env:USERPROFILE\LumiCore\data\" -ForegroundColor Cyan
Write-Host "  App:  $InstallDir\" -ForegroundColor Cyan
Write-Host "  Desktop shortcut ready." -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
