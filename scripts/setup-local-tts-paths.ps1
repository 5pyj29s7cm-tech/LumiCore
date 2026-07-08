param(
  [string]$Root = "",
  [switch]$PrintOnly
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = Join-Path $repoRoot "local-tts"
}

$resolvedRoot = [System.IO.Path]::GetFullPath($Root)
$driveName = ([System.IO.Path]::GetPathRoot($resolvedRoot)).TrimEnd("\")
$drive = Get-PSDrive -Name $driveName.TrimEnd(":") -PSProvider FileSystem

Write-Host "Local TTS root: $resolvedRoot"
Write-Host ("Drive {0} free: {1:N2} GB" -f $drive.Name, ($drive.Free / 1GB))

$dirs = @(
  $resolvedRoot,
  (Join-Path $resolvedRoot "huggingface"),
  (Join-Path $resolvedRoot "modelscope"),
  (Join-Path $resolvedRoot "torch"),
  (Join-Path $resolvedRoot "cosyvoice"),
  (Join-Path $resolvedRoot "gptsovits")
)

if (-not $PrintOnly) {
  foreach ($dir in $dirs) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  Write-Host "Created local TTS directories. No models were downloaded."
}

Write-Host ""
Write-Host "Add these lines to .env when you are ready to enable local CosyVoice:"
Write-Host "LUMI_LOCAL_TTS_HOME=$($resolvedRoot.Replace('\','/'))"
Write-Host "HF_HOME=$((Join-Path $resolvedRoot 'huggingface').Replace('\','/'))"
Write-Host "MODELSCOPE_CACHE=$((Join-Path $resolvedRoot 'modelscope').Replace('\','/'))"
Write-Host "TORCH_HOME=$((Join-Path $resolvedRoot 'torch').Replace('\','/'))"
Write-Host "LOCAL_COSYVOICE_ENABLED=true"
Write-Host "LOCAL_COSYVOICE_API_URL=http://127.0.0.1:50000"
Write-Host "LOCAL_COSYVOICE_TTS_PATH=/inference_sft"
