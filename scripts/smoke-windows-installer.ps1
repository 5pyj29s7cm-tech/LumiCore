param(
  [string]$Installer = "",
  [string]$SkillId = "skill-admin-assistant",
  [int]$TimeoutSeconds = 90,
  [switch]$Keep
)

$ErrorActionPreference = "Stop"
$DesktopSessionHeader = "X-Lumi-Desktop-Session"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($Installer)) {
  $PackageJson = Get-Content (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
  $Installer = Join-Path $ProjectRoot "src-tauri\target\release\bundle\nsis\LumiCore_$($PackageJson.version)_x64-setup.exe"
}
$Installer = [System.IO.Path]::GetFullPath($Installer)
if (!(Test-Path $Installer)) {
  throw "Installer not found: $Installer"
}
$SourceRuntimeMetaPath = Join-Path $ProjectRoot "desktop-resources\dist-server\runtime-meta.json"
if (!(Test-Path $SourceRuntimeMetaPath)) {
  throw "Prepared runtime metadata not found: $SourceRuntimeMetaPath"
}
$ExpectedRuntimeMeta = Get-Content -LiteralPath $SourceRuntimeMetaPath -Raw | ConvertFrom-Json

function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 0)
  $listener.Start()
  try {
    return $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Invoke-JsonRequest {
  param(
    [string]$Uri,
    [string]$Method = "GET",
    [object]$Body = $null,
    [hashtable]$Headers = @{},
    [int]$TimeoutSec = 8
  )

  $params = @{
    Uri = $Uri
    Method = $Method
    TimeoutSec = $TimeoutSec
    Headers = $Headers
  }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Compress -Depth 4)
  }
  return Invoke-RestMethod @params
}

function Invoke-DesktopBootstrap {
  param(
    [string]$BaseUrl,
    [string]$DataRoot,
    [hashtable]$NativeClientIdentity,
    [int]$TimeoutSec = 15
  )

  $ProofPath = Join-Path $DataRoot "runtime\desktop-bootstrap.json"
  $LastError = ""
  for ($Attempt = 0; $Attempt -lt 3; $Attempt++) {
    if (!(Test-Path -LiteralPath $ProofPath -PathType Leaf)) {
      throw "Desktop bootstrap proof file not found: $ProofPath"
    }
    $ProofFile = Get-Item -LiteralPath $ProofPath -Force
    if ($ProofFile.LinkType -or $ProofFile.Length -le 0 -or $ProofFile.Length -gt 4096) {
      throw "Desktop bootstrap proof is not a safe regular file"
    }
    $ProofRecord = Get-Content -LiteralPath $ProofPath -Raw | ConvertFrom-Json
    $Proof = [string]$ProofRecord.proof
    if ($ProofRecord.version -ne 1 -or $Proof -notmatch '^[A-Za-z0-9_-]{32,256}$') {
      throw "Desktop bootstrap proof has an invalid format"
    }
    try {
      return Invoke-JsonRequest `
        -Uri "$BaseUrl/auth/bootstrap" `
        -Method "POST" `
        -Body @{ nativeClientIdentity = $NativeClientIdentity } `
        -Headers @{ "X-Lumi-Desktop-Bootstrap" = $Proof } `
        -TimeoutSec $TimeoutSec
    } catch {
      $LastError = $_.Exception.Message
      if ($Attempt -lt 2) { Start-Sleep -Milliseconds 50 }
    }
  }
  throw "Desktop bootstrap failed: $LastError"
}

function Get-Sha256File {
  param([string]$Path)

  $Stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite
  )
  try {
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $Hasher.Dispose()
    }
  } finally {
    $Stream.Dispose()
  }
}

function New-InstallerAcceptanceHarnessIdentity {
  param([object]$RuntimeMeta)

  $BuildId = [string]$RuntimeMeta.buildId
  $SourceFingerprint = [string]$RuntimeMeta.sourceFingerprint
  $AppVersion = [string]$RuntimeMeta.version
  if ($BuildId -notmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') {
    throw "Prepared runtime build id is invalid"
  }
  if ($SourceFingerprint -notmatch '^[a-f0-9]{64}$') {
    throw "Prepared runtime source fingerprint is invalid"
  }
  if ($AppVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw "Prepared runtime version is invalid"
  }
  if ($null -eq $RuntimeMeta.sourceDirty -or $RuntimeMeta.sourceDirty.GetType() -ne [bool]) {
    throw "Prepared runtime source state is invalid"
  }

  $HarnessProcess = Get-Process -Id $PID
  $ExecutablePath = [string]$HarnessProcess.Path
  if ([string]::IsNullOrWhiteSpace($ExecutablePath) -or -not [System.IO.Path]::IsPathRooted($ExecutablePath)) {
    throw "Installer acceptance harness executable path is unavailable"
  }
  $StartedAtUnixMs = [DateTimeOffset]::new($HarnessProcess.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
  $ExecutableSha256 = Get-Sha256File -Path $ExecutablePath

  return [ordered]@{
    schemaVersion = 1
    clientKind = "local_acceptance_harness"
    pid = $PID
    startedAtUnixMs = $StartedAtUnixMs
    executablePath = [System.IO.Path]::GetFullPath($ExecutablePath)
    executableSha256 = $ExecutableSha256
    binaryHashUnavailable = $false
    buildId = $BuildId.ToLowerInvariant()
    buildIdSemantics = "baseline_commit"
    sourceFingerprint = $SourceFingerprint.ToLowerInvariant()
    sourceDirty = [bool]$RuntimeMeta.sourceDirty
    appVersion = $AppVersion
  }
}

function Stop-InstalledBackend {
  param(
    [string]$InstallDir,
    [int]$Port
  )

  Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object {
      $_.CommandLine -like "*$InstallDir*entry.cjs*" -or
      $_.CommandLine -like "*PORT=$Port*"
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Test-IsPathInside {
  param(
    [string]$Path,
    [string]$Parent
  )

  if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Parent)) {
    return $false
  }

  try {
    $separators = [char[]]@(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    )
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd($separators)
    return $fullPath.Equals($fullParent, [System.StringComparison]::OrdinalIgnoreCase) -or
      $fullPath.StartsWith("$fullParent$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase) -or
      $fullPath.StartsWith("$fullParent$([System.IO.Path]::AltDirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Get-ExistingShortcutRoots {
  param(
    [string]$HomeDir,
    [string]$OriginalDesktop,
    [string]$OriginalPrograms,
    [string]$OriginalAppData
  )

  $originalStartMenu = if ([string]::IsNullOrWhiteSpace($OriginalAppData)) { "" } else { Join-Path $OriginalAppData "Microsoft\Windows\Start Menu\Programs" }
  $currentStartMenu = if ([string]::IsNullOrWhiteSpace($env:APPDATA)) { "" } else { Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs" }

  $roots = @(
    $OriginalDesktop,
    $OriginalPrograms,
    $originalStartMenu,
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("Programs"),
    $currentStartMenu,
    (Join-Path $HomeDir "Desktop"),
    (Join-Path $HomeDir "AppData\Roaming\Microsoft\Windows\Start Menu\Programs")
  )

  $seen = @{}
  foreach ($root in $roots) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    try {
      $full = [System.IO.Path]::GetFullPath($root)
      if ($seen.ContainsKey($full)) { continue }
      $seen[$full] = $true
      if (Test-Path -LiteralPath $full) { $full }
    } catch {}
  }
}

function Test-IsInstallerSmokePath {
  param(
    [string]$Path,
    [string]$SmokeRoot
  )

  if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($SmokeRoot)) {
    return $false
  }

  try {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-IsPathInside -Path $fullPath -Parent $SmokeRoot)) {
      return $false
    }
    return $fullPath -match '[\\/]installer-first-run-[^\\/]+[\\/]install([\\/]|$)'
  } catch {
    return $false
  }
}

function Remove-InstallerShortcutResidue {
  param(
    [string]$InstallDir,
    [string]$HomeDir,
    [string]$SmokeRoot,
    [string]$OriginalDesktop,
    [string]$OriginalPrograms,
    [string]$OriginalAppData
  )

  $removed = New-Object System.Collections.Generic.List[string]
  $remaining = New-Object System.Collections.Generic.List[string]
  $shell = $null

  try {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($root in Get-ExistingShortcutRoots -HomeDir $HomeDir -OriginalDesktop $OriginalDesktop -OriginalPrograms $OriginalPrograms -OriginalAppData $OriginalAppData) {
      $links = Get-ChildItem -LiteralPath $root -Filter "*.lnk" -File -Recurse -ErrorAction SilentlyContinue
      foreach ($link in $links) {
        try {
          $shortcut = $shell.CreateShortcut($link.FullName)
          $pointsToInstall = (Test-IsPathInside -Path $shortcut.TargetPath -Parent $InstallDir) -or
            (Test-IsPathInside -Path $shortcut.WorkingDirectory -Parent $InstallDir)
          $pointsToSmokeRun = (Test-IsInstallerSmokePath -Path $shortcut.TargetPath -SmokeRoot $SmokeRoot) -or
            (Test-IsInstallerSmokePath -Path $shortcut.WorkingDirectory -SmokeRoot $SmokeRoot)

          if ($pointsToInstall -or $pointsToSmokeRun) {
            Remove-Item -LiteralPath $link.FullName -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $link.FullName) {
              $remaining.Add($link.FullName)
            } else {
              $removed.Add($link.FullName)
            }
          }
        } catch {
          continue
        }
      }
    }
  } finally {
    if ($shell) {
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) } catch {}
    }
  }

  [pscustomobject]@{
    Removed = $removed.ToArray()
    Remaining = $remaining.ToArray()
  }
}

$Stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$CodexRun = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ".codex-run"))
$RunRoot = [System.IO.Path]::GetFullPath((Join-Path $CodexRun "installer-first-run-$Stamp"))
$InstallDir = Join-Path $RunRoot "install"
$HomeDir = Join-Path $RunRoot "home"
$DataRoot = Join-Path $RunRoot "data-root"
$InstallLog = Join-Path $RunRoot "install.log"
$LaunchOut = Join-Path $RunRoot "launch.out.log"
$LaunchErr = Join-Path $RunRoot "launch.err.log"

New-Item -ItemType Directory -Force -Path $InstallDir, $HomeDir, $DataRoot | Out-Null

$Port = Get-FreePort
$OriginalDesktop = [Environment]::GetFolderPath("Desktop")
$OriginalPrograms = [Environment]::GetFolderPath("Programs")
$OriginalAppData = $env:APPDATA
$OldEnv = @{
  PORT = $env:PORT
  HOST = $env:HOST
  LUMI_DESKTOP = $env:LUMI_DESKTOP
  LUMI_DATA_DIR = $env:LUMI_DATA_DIR
  LUMI_LOG_FILE = $env:LUMI_LOG_FILE
  USERPROFILE = $env:USERPROFILE
}

$App = $null
$Succeeded = $false
$Result = $null
$CleanupFailure = ""
$NativeClientIdentity = $null
$SmokeStage = "initialize"

try {
  $SmokeStage = "prepare-native-client-identity"
  $NativeClientIdentity = New-InstallerAcceptanceHarnessIdentity -RuntimeMeta $ExpectedRuntimeMeta
  $SmokeStage = "install"
  $InstallArgs = @("/S", "/D=$InstallDir")
  $InstallerProcess = Start-Process -FilePath $Installer -ArgumentList $InstallArgs -Wait -PassThru -WindowStyle Hidden
  "installer exit=$($InstallerProcess.ExitCode)" | Set-Content -Path $InstallLog
  if ($InstallerProcess.ExitCode -ne 0) {
    throw "Installer failed with exit code $($InstallerProcess.ExitCode)"
  }

  $InstalledExe = Join-Path $InstallDir "lumi-core.exe"
  if (!(Test-Path $InstalledExe)) {
    $Found = Get-ChildItem -Path $InstallDir -Recurse -Filter "lumi-core.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Found) {
      $InstalledExe = $Found.FullName
    }
  }
  if (!(Test-Path $InstalledExe)) {
    throw "Installed lumi-core.exe not found under $InstallDir"
  }

  $SmokeStage = "validate-installed-runtime"
  $InstalledRuntimeMetaFile = Get-ChildItem -LiteralPath $InstallDir -Filter "runtime-meta.json" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $InstalledRuntimeMetaFile) {
    throw "Installed runtime metadata not found under $InstallDir"
  }
  $InstalledRuntimeMeta = Get-Content -LiteralPath $InstalledRuntimeMetaFile.FullName -Raw | ConvertFrom-Json
  foreach ($Field in @("schemaVersion", "name", "version", "buildId", "builtAt", "channel")) {
    if ([string]::IsNullOrWhiteSpace([string]$InstalledRuntimeMeta.$Field) -or $InstalledRuntimeMeta.$Field -ne $ExpectedRuntimeMeta.$Field) {
      throw "Installed runtime metadata field '$Field' does not match prepared resources"
    }
  }
  if ($InstalledRuntimeMeta.version -eq "0.0.0" -or $InstalledRuntimeMeta.channel -notin @("internal", "public")) {
    throw "Installed runtime metadata version or channel is invalid"
  }

  $env:PORT = [string]$Port
  $env:HOST = "127.0.0.1"
  $env:LUMI_DESKTOP = "1"
  $env:LUMI_DATA_DIR = $DataRoot
  $RuntimeLog = Join-Path $DataRoot "logs\server.log"
  $env:LUMI_LOG_FILE = $RuntimeLog
  $env:USERPROFILE = $HomeDir

  $SmokeStage = "launch-installed-client"
  $App = Start-Process `
    -FilePath $InstalledExe `
    -WorkingDirectory (Split-Path $InstalledExe) `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LaunchOut `
    -RedirectStandardError $LaunchErr

  $SmokeStage = "wait-for-backend-health"
  $BaseUrl = "http://127.0.0.1:$Port/api"
  $Ready = $false
  $Health = $null
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Milliseconds 500
    if ($App.HasExited) {
      throw "Installed app exited before backend became ready"
    }
    try {
      $Health = Invoke-JsonRequest -Uri "$BaseUrl/health" -TimeoutSec 2
      $Ready = $true
      break
    } catch {}
  }
  if (-not $Ready) {
    throw "Installed app backend did not become ready on port $Port"
  }
  if ([string]::IsNullOrWhiteSpace($Health.runtime.version) -or $Health.runtime.version -eq "0.0.0" -or [string]::IsNullOrWhiteSpace($Health.runtime.buildId)) {
    throw "Installed runtime metadata is incomplete"
  }
  if ($Health.runtime.version -ne $InstalledRuntimeMeta.version -or $Health.runtime.buildId -ne $InstalledRuntimeMeta.buildId) {
    throw "Installed health identity does not match runtime-meta.json"
  }
  if ($Health.database.dirty -ne $false) {
    $CleanDeadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds, 15))
    while ((Get-Date) -lt $CleanDeadline) {
      Start-Sleep -Milliseconds 250
      if ($App.HasExited) {
        throw "Installed app exited before startup persistence completed"
      }
      try {
        $CandidateHealth = Invoke-JsonRequest -Uri "$BaseUrl/health" -TimeoutSec 2
        if ($CandidateHealth.database.dirty -eq $false) {
          $Health = $CandidateHealth
          break
        }
      } catch {}
    }
  }
  if ($Health.database.dirty -ne $false) {
    throw "Installed database reports a dirty state"
  }

  $SocketHandshake = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/socket.io/?EIO=4&transport=polling" -TimeoutSec 8).Content
  if (-not $SocketHandshake.StartsWith('0{')) {
    throw "Installed Socket.IO handshake failed"
  }

  $SmokeStage = "desktop-bootstrap"
  $Bootstrap = Invoke-DesktopBootstrap `
    -BaseUrl $BaseUrl `
    -DataRoot $DataRoot `
    -NativeClientIdentity $NativeClientIdentity `
    -TimeoutSec 15
  if (
    -not $Bootstrap.success -or
    [string]::IsNullOrWhiteSpace($Bootstrap.token) -or
    [string]::IsNullOrWhiteSpace($Bootstrap.desktopSessionProof)
  ) {
    throw "Installed app local identity bootstrap failed"
  }
  $AuthHeaders = @{
    Authorization = "Bearer $($Bootstrap.token)"
    $DesktopSessionHeader = [string]$Bootstrap.desktopSessionProof
  }

  $Marketplace = Invoke-JsonRequest -Uri "$BaseUrl/marketplace/skills?lang=zh" -Headers $AuthHeaders -TimeoutSec 8
  if (@($Marketplace).Count -lt 48) {
    throw "Installed marketplace contains fewer than 48 built-in skills"
  }
  $Skill = @($Marketplace | Where-Object { $_.id -eq $SkillId })[0]
  if (-not $Skill) {
    throw "Skill not found in installed marketplace: $SkillId"
  }
  if ($Skill.installSource -ne "bundled") {
    throw "Installer smoke skill must be bundled. $SkillId is $($Skill.installSource)"
  }

  $SmokeStage = "install-bundled-skill"
  $InstallSkill = Invoke-JsonRequest `
    -Uri "$BaseUrl/marketplace/skills/acquire" `
    -Method "POST" `
    -Headers $AuthHeaders `
    -TimeoutSec 30 `
    -Body @{
      skillId = $Skill.id
      skillName = $Skill.name
      installSource = $Skill.installSource
      installPath = $Skill.installPath
    }
  if (-not $InstallSkill.success) {
    throw "Skill install failed: $($InstallSkill | ConvertTo-Json -Compress)"
  }

  $DirName = $SkillId -replace "^skill-", ""
  $SmokeStage = "wait-for-skill-connection"
  $Connected = $false
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds 1
    $Skills = Invoke-JsonRequest -Uri "$BaseUrl/skills" -Headers $AuthHeaders -TimeoutSec 8
    $Connected = [bool](@($Skills.skills | Where-Object { $_.name -eq $DirName -and $_.connected }).Count)
    if ($Connected) {
      break
    }
  }
  if (-not $Connected) {
    throw "Installed $DirName did not connect as an MCP server"
  }

  $SkillDir = Join-Path $HomeDir "lumi_skills\$DirName"
  $RuntimeConfig = Join-Path $DataRoot "data\mcp_config.json"
  $DatabasePath = Join-Path $DataRoot "data\lumi.db"
  $GeneratedOutputDir = Join-Path $DataRoot "data\generated"
  if (!(Test-Path $SkillDir) -or !(Test-Path $RuntimeConfig) -or !(Test-Path $DatabasePath) -or !(Test-Path $GeneratedOutputDir) -or !(Test-Path $RuntimeLog)) {
    throw "Installed skill, MCP config, database, generated-output directory, or runtime log was not persisted in the isolated profile"
  }

  $SmokeStage = "restart-installed-client"
  # Restart with the same clean-user profile and verify skill/MCP persistence.
  if ($App -and -not $App.HasExited) {
    Stop-Process -Id $App.Id -Force -ErrorAction SilentlyContinue
    try { $App.WaitForExit(5000) | Out-Null } catch {}
  }
  Stop-InstalledBackend -InstallDir $InstallDir -Port $Port
  $App = Start-Process `
    -FilePath $InstalledExe `
    -WorkingDirectory (Split-Path $InstalledExe) `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LaunchOut `
    -RedirectStandardError $LaunchErr

  $Restarted = $false
  $RestartHealth = $null
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Milliseconds 500
    if ($App.HasExited) { throw "Installed app exited during persistence restart" }
    try {
      $RestartHealth = Invoke-JsonRequest -Uri "$BaseUrl/health" -TimeoutSec 2
      $Restarted = $true
      break
    } catch {}
  }
  if ($Restarted -and $RestartHealth.database.dirty -ne $false) {
    $CleanDeadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds, 15))
    while ((Get-Date) -lt $CleanDeadline) {
      Start-Sleep -Milliseconds 250
      if ($App.HasExited) { throw "Installed app exited before restart persistence completed" }
      try {
        $CandidateHealth = Invoke-JsonRequest -Uri "$BaseUrl/health" -TimeoutSec 2
        if ($CandidateHealth.database.dirty -eq $false) {
          $RestartHealth = $CandidateHealth
          break
        }
      } catch {}
    }
  }
  if (-not $Restarted -or $RestartHealth.database.dirty -ne $false) {
    throw "Installed app did not restart with a clean database"
  }

  $SmokeStage = "restart-desktop-bootstrap"
  $RestartBootstrap = Invoke-DesktopBootstrap `
    -BaseUrl $BaseUrl `
    -DataRoot $DataRoot `
    -NativeClientIdentity $NativeClientIdentity `
    -TimeoutSec 15
  if (
    -not $RestartBootstrap.success -or
    [string]::IsNullOrWhiteSpace($RestartBootstrap.token) -or
    [string]::IsNullOrWhiteSpace($RestartBootstrap.desktopSessionProof)
  ) {
    throw "Restarted app local identity bootstrap failed"
  }
  $RestartHeaders = @{
    Authorization = "Bearer $($RestartBootstrap.token)"
    $DesktopSessionHeader = [string]$RestartBootstrap.desktopSessionProof
  }
  $RestartMarketplace = Invoke-JsonRequest -Uri "$BaseUrl/marketplace/skills?lang=zh" -Headers $RestartHeaders -TimeoutSec 8
  if (-not [bool](@($RestartMarketplace | Where-Object { $_.id -eq $SkillId -and $_.installed }).Count)) {
    throw "Installed skill state did not persist across restart"
  }
  $RestartSkills = Invoke-JsonRequest -Uri "$BaseUrl/skills" -Headers $RestartHeaders -TimeoutSec 8
  $PersistedSkill = @($RestartSkills.skills | Where-Object { $_.name -eq $DirName })[0]
  if (-not $PersistedSkill -or -not $PersistedSkill.enabled -or $PersistedSkill.broken -or $PersistedSkill.consecutiveCrashes -ne 0 -or $PersistedSkill.toolCount -le 0) {
    throw "Installed MCP configuration did not persist cleanly across restart"
  }
  $RestartHealthStatusBeforeActivation = $PersistedSkill.healthStatus

  # Process-backed MCP skills are intentionally idle after startup when cached
  # tool metadata is available. Explicitly activate the persisted skill to
  # prove that its post-restart on-demand lifecycle is still functional.
  if (-not $PersistedSkill.connected) {
    $Activation = Invoke-JsonRequest `
      -Uri "$BaseUrl/skills/$DirName/enable" `
      -Method "POST" `
      -Headers $RestartHeaders `
      -TimeoutSec 30
    if (-not $Activation.success) {
      throw "Installed MCP skill activation failed after restart"
    }
  }

  $Reconnected = $false
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds 1
    $RestartSkills = Invoke-JsonRequest -Uri "$BaseUrl/skills" -Headers $RestartHeaders -TimeoutSec 8
    $Reconnected = [bool](@($RestartSkills.skills | Where-Object { $_.name -eq $DirName -and $_.connected }).Count)
    if ($Reconnected) { break }
  }
  if (-not $Reconnected) { throw "Installed MCP skill did not reconnect after restart" }

  $SmokeStage = "sqlite-integrity"
  & node (Join-Path $ProjectRoot "scripts\check-sqlite-integrity.mjs") $DatabasePath
  if ($LASTEXITCODE -ne 0) { throw "Installed SQLite integrity or foreign-key check failed" }

  $SmokeStage = "complete"
  $Succeeded = $true
  $Result = [pscustomobject]@{
    ok = $true
    installer = $Installer
    installDir = $InstallDir
    installedExe = $InstalledExe
    port = $Port
    marketplaceCount = @($Marketplace).Count
    installedSkill = @{
      id = $SkillId
      dirName = $DirName
      connected = $Connected
    }
    skillDirExists = (Test-Path $SkillDir)
    runtimeConfigCreated = (Test-Path $RuntimeConfig)
    generatedOutputIsolated = (Test-Path $GeneratedOutputDir)
    runtimeLogIsolated = (Test-Path $RuntimeLog)
    runtime = @{
      version = $Health.runtime.version
      buildId = $Health.runtime.buildId
      channel = $InstalledRuntimeMeta.channel
    }
    socketHandshake = $true
    restartPersistence = $true
    restartHealthStatusBeforeActivation = $RestartHealthStatusBeforeActivation
    restartReconnect = $Reconnected
    sqliteIntegrity = $true
    cleanup = $(if ($Keep) { "kept" } else { "removed" })
    shortcutResidueRemoved = 0
    shortcutResidueRemaining = 0
    runRoot = $(if ($Keep) { $RunRoot } else { $null })
  }
} catch {
  if ($env:GITHUB_ACTIONS -eq "true") {
    $AnnotationTitle = "Windows installer smoke failed ($SmokeStage)"
    $AnnotationMessage = "$($_.Exception.Message)"
    $AnnotationTitle = $AnnotationTitle.Replace("%", "%25").Replace("`r", "%0D").Replace("`n", "%0A").Replace(":", "%3A").Replace(",", "%2C")
    $AnnotationMessage = $AnnotationMessage.Replace("%", "%25").Replace("`r", "%0D").Replace("`n", "%0A")
    Write-Host "::error file=scripts/smoke-windows-installer.ps1,title=$AnnotationTitle::$AnnotationMessage"
  }
  Write-Error $_
  if (Test-Path $LaunchOut) {
    Write-Host "--- launch stdout tail ---"
    Get-Content $LaunchOut -Tail 80 -ErrorAction SilentlyContinue
  }
  if (Test-Path $LaunchErr) {
    Write-Host "--- launch stderr tail ---"
    Get-Content $LaunchErr -Tail 80 -ErrorAction SilentlyContinue
  }
  exit 1
} finally {
  if ($App -and -not $App.HasExited) {
    Stop-Process -Id $App.Id -Force -ErrorAction SilentlyContinue
    try { $App.WaitForExit(5000) | Out-Null } catch {}
  }
  Stop-InstalledBackend -InstallDir $InstallDir -Port $Port

  $Uninstaller = Join-Path $InstallDir "uninstall.exe"
  if (Test-Path $Uninstaller) {
    Start-Process -FilePath $Uninstaller -ArgumentList @("/S") -Wait -WindowStyle Hidden | Out-Null
  }

  $ShortcutCleanup = Remove-InstallerShortcutResidue -InstallDir $InstallDir -HomeDir $HomeDir -SmokeRoot $CodexRun -OriginalDesktop $OriginalDesktop -OriginalPrograms $OriginalPrograms -OriginalAppData $OriginalAppData
  if ($Result) {
    $Result.shortcutResidueRemoved = @($ShortcutCleanup.Removed).Count
    $Result.shortcutResidueRemaining = @($ShortcutCleanup.Remaining).Count
  }
  if (@($ShortcutCleanup.Remaining).Count -gt 0) {
    $CleanupFailure = "Installer shortcut cleanup left residue: $(@($ShortcutCleanup.Remaining) -join ', ')"
  }

  foreach ($Key in $OldEnv.Keys) {
    if ($null -eq $OldEnv[$Key]) {
      Remove-Item -ErrorAction SilentlyContinue "env:$Key"
    } else {
      Set-Item -Path "env:$Key" -Value $OldEnv[$Key]
    }
  }

  if ($Succeeded -and -not $Keep) {
    $ResolvedRunRoot = [System.IO.Path]::GetFullPath($RunRoot)
    if (
      (Test-IsPathInside -Path $ResolvedRunRoot -Parent $CodexRun) -and
      $ResolvedRunRoot -match '[\\/]installer-first-run-[^\\/]+$'
    ) {
      Remove-Item -Recurse -Force -Path $ResolvedRunRoot -ErrorAction SilentlyContinue
    }
  }
}

if ($CleanupFailure) {
  Write-Error $CleanupFailure
  exit 1
}

if ($Result) {
  $Result | ConvertTo-Json -Compress
}
