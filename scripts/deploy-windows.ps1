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

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  LumiCore Deployment" -ForegroundColor Cyan
Write-Host "  Install: $InstallDir" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

# ── Prerequisites ──────────────────────────────────────────────────────
Write-Host "[1/6] Checking prerequisites..." -ForegroundColor Yellow

$nodeVersion = try { node --version } catch { "" }
if (-not $nodeVersion) {
  Write-Host "ERROR: Node.js not found. Install from https://nodejs.org (v18+)" -ForegroundColor Red
  exit 1
}
Write-Host "  Node.js $nodeVersion" -ForegroundColor Green

$rustVersion = try { rustc --version } catch { "" }
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
npm install
Write-Host "  Done." -ForegroundColor Green

# ── Build ─────────────────────────────────────────────────────────────
Write-Host "[3/6] Building frontend + backend..." -ForegroundColor Yellow

Write-Host "  Building frontend..." -ForegroundColor Gray
npm run build
Write-Host "  Building backend..." -ForegroundColor Gray
npm run build:server
Write-Host "  Downloading Node.js runtime..." -ForegroundColor Gray
node scripts/download-node-binary.mjs
Write-Host "  Preparing desktop resources..." -ForegroundColor Gray
npm run prepare:desktop
Write-Host "  Done." -ForegroundColor Green

# ── Compile Rust ──────────────────────────────────────────────────────
Write-Host "[4/6] Compiling desktop shell (Rust)... this may take a few minutes" -ForegroundColor Yellow
Push-Location "$ProjectDir\src-tauri"
cargo build --release
Pop-Location
Write-Host "  Done." -ForegroundColor Green

# ── Install ───────────────────────────────────────────────────────────
Write-Host "[5/6] Installing to $InstallDir..." -ForegroundColor Yellow

# Create install directory
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Copy exe
$exeSrc = "$ProjectDir\src-tauri\target\release\lumi-core.exe"
if (-not (Test-Path $exeSrc)) {
  Write-Host "ERROR: lumi-core.exe not found at $exeSrc" -ForegroundColor Red
  exit 1
}
Copy-Item $exeSrc "$InstallDir\lumi-core.exe" -Force
Write-Host "  lumi-core.exe" -ForegroundColor Gray

# Copy WebView2Loader.dll (Windows only)
$dllSrc = "$ProjectDir\src-tauri\target\release\WebView2Loader.dll"
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
$distServerSrc = "$ProjectDir\desktop-resources\dist-server"
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

Pop-Location

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Deployment complete!" -ForegroundColor Cyan
Write-Host "  Data: $env:USERPROFILE\LumiCore\data\" -ForegroundColor Cyan
Write-Host "  App:  $InstallDir\" -ForegroundColor Cyan
Write-Host "  Desktop shortcut ready." -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
