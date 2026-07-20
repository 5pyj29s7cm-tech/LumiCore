import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type AutocadPlaybackOperation =
  | { kind: 'line'; layer: string; x1: number; y1: number; x2: number; y2: number; label?: string }
  | { kind: 'circle'; layer: string; x: number; y: number; r: number; label?: string }
  | { kind: 'arc'; layer: string; cx: number; cy: number; r: number; start: number; end: number; label?: string }
  | { kind: 'text'; layer: string; x: number; y: number; text: string; height: number; label?: string };

export interface AutocadOperationPayload {
  version: number;
  title: string;
  sourcePath: string;
  geometryReceiptPath: string;
  geometryHash: string;
  geometryVerified: boolean;
  geometryVerificationRequired: boolean;
  operationSetId: string;
  expectedEntityCount: number;
  operations: AutocadPlaybackOperation[];
}

export interface AutocadPlaybackOptions {
  operationsPath: string;
  completionMarkerPath?: string;
  strokeDelayMs?: number;
  createNewDocument?: boolean;
  savePath?: string;
  timeoutMs?: number;
  lockPath?: string;
  lockOwnerToken?: string;
  progressPath?: string;
  resumeCompleted?: number;
  resumeStartingEntityCount?: number;
  resumeDocument?: string;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validOperation(value: any): value is AutocadPlaybackOperation {
  if (!value || typeof value !== 'object' || typeof value.kind !== 'string') return false;
  if (typeof value.layer !== 'string' || !value.layer.trim()) return false;
  if (value.kind === 'line') return [value.x1, value.y1, value.x2, value.y2].every(finite);
  if (value.kind === 'circle') return [value.x, value.y, value.r].every(finite) && value.r > 0;
  if (value.kind === 'arc') {
    return [value.cx, value.cy, value.r, value.start, value.end].every(finite) && value.r > 0;
  }
  if (value.kind === 'text') {
    return [value.x, value.y, value.height].every(finite)
      && value.height > 0
      && typeof value.text === 'string';
  }
  return false;
}

export function readAutocadOperationPayload(filePath: string): AutocadOperationPayload {
  const resolved = path.resolve(filePath);
  if (!/\.json$/i.test(resolved)) throw new Error('AutoCAD operationsPath must be a JSON file.');
  if (!fs.existsSync(resolved)) throw new Error(`AutoCAD operations file not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
    throw new Error('AutoCAD operations file must be a regular JSON file no larger than 8 MB.');
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  const operations = Array.isArray(parsed?.operations) ? parsed.operations : [];
  if (operations.length < 1 || operations.length > 2500 || !operations.every(validOperation)) {
    throw new Error('AutoCAD operations file contains invalid or unsupported drawing operations.');
  }
  const version = Number(parsed.version || 1);
  const geometryHash = String(parsed.geometryHash || '').trim();
  const operationSetId = String(parsed.operationSetId || '').trim();
  const expectedOperationSetId = geometryHash
    ? crypto.createHash('sha256').update(JSON.stringify({ geometryHash, operations })).digest('hex')
    : '';
  if (version < 2 || !geometryHash || !operationSetId || operationSetId !== expectedOperationSetId) {
    throw new Error('AutoCAD operations file is missing a current verified operation-set identity. Re-run cad_prepare_autocad_operations.');
  }
  if (parsed.geometryVerified !== true) {
    throw new Error('AutoCAD operations file does not contain verified geometry.');
  }
  if (parsed.geometryVerificationRequired === true && !String(parsed.geometryReceiptPath || '').trim()) {
    throw new Error('Image-grounded AutoCAD operations are missing their geometry receipt.');
  }
  if (Number(parsed.expectedEntityCount) !== operations.length) {
    throw new Error('AutoCAD operations expectedEntityCount does not match the operation list.');
  }
  return {
    version,
    title: String(parsed.title || path.basename(resolved, '.json')).slice(0, 160),
    sourcePath: String(parsed.sourcePath || ''),
    geometryReceiptPath: String(parsed.geometryReceiptPath || ''),
    geometryHash,
    geometryVerified: true,
    geometryVerificationRequired: parsed.geometryVerificationRequired === true,
    operationSetId,
    expectedEntityCount: operations.length,
    operations,
  };
}

function psLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildAutocadComPlaybackScript(
  payload: AutocadOperationPayload,
  options: AutocadPlaybackOptions,
): string {
  const operationsPath = path.resolve(options.operationsPath);
  const markerPath = options.completionMarkerPath
    ? path.resolve(options.completionMarkerPath)
    : '';
  const lockPath = options.lockPath ? path.resolve(options.lockPath) : '';
  const lockOwnerToken = String(options.lockOwnerToken || '');
  const progressPath = options.progressPath ? path.resolve(options.progressPath) : '';
  const resumeCompleted = Math.max(0, Math.min(Math.floor(Number(options.resumeCompleted) || 0), payload.operations.length));
  const resumeStartingEntityCount = Math.max(0, Math.floor(Number(options.resumeStartingEntityCount) || 0));
  const resumeDocument = String(options.resumeDocument || '');
  const savePath = options.savePath ? path.resolve(options.savePath) : '';
  const requestedDelay = Number(options.strokeDelayMs);
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.max(100, Math.min(Math.round(requestedDelay), 5000))
    : 450;
  const createNewDocument = options.createNewDocument !== false;

  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$InformationPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    `$operationsPath = ${psLiteral(operationsPath)}`,
    `$markerPath = ${psLiteral(markerPath)}`,
    `$lockPath = ${psLiteral(lockPath)}`,
    `$lockOwnerToken = ${psLiteral(lockOwnerToken)}`,
    `$progressPath = ${psLiteral(progressPath)}`,
    `$resumeCompleted = ${resumeCompleted}`,
    `$resumeStartingEntityCount = ${resumeStartingEntityCount}`,
    `$resumeDocument = ${psLiteral(resumeDocument)}`,
    `$savePath = ${psLiteral(savePath)}`,
    `$title = ${psLiteral(payload.title)}`,
    `$operationSetId = ${psLiteral(payload.operationSetId)}`,
    `$geometryHash = ${psLiteral(payload.geometryHash)}`,
    `$geometryReceiptPath = ${psLiteral(payload.geometryReceiptPath)}`,
    `$geometryVerificationRequired = ${payload.geometryVerificationRequired ? '$true' : '$false'}`,
    `$delayMs = ${delayMs}`,
    `$createNewDocument = ${createNewDocument ? '$true' : '$false'}`,
    '$payload = Get-Content -Raw -LiteralPath $operationsPath -Encoding UTF8 | ConvertFrom-Json',
    '$operations = @($payload.operations)',
    `if ($operations.Count -ne ${payload.operations.length}) { throw 'AutoCAD operations file changed after validation.' }`,
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class LumiAutoCadWindow {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '}',
    '"@',
    'function Point3([double]$x, [double]$y) { return ,([double[]]@($x, $y, 0.0)) }',
    'function LayerColor([string]$name) {',
    "  if ($name -match 'WALL|OUTLINE') { return 7 }",
    "  if ($name -match 'ROOM') { return 4 }",
    "  if ($name -match 'DOOR') { return 3 }",
    "  if ($name -match 'WINDOW') { return 5 }",
    "  if ($name -match 'DIM') { return 6 }",
    "  if ($name -match 'TEXT|TITLE|ANNOTATION') { return 2 }",
    '  return 8',
    '}',
    'function EnsureLayer($doc, [string]$name) {',
    "  $safeName = ($name -replace '[<>/\\\\\":;?*|=,]+', '_')",
    "  if ([string]::IsNullOrWhiteSpace($safeName)) { $safeName = 'LUMI' }",
    '  try { $layer = $doc.Layers.Item($safeName) } catch { $layer = $doc.Layers.Add($safeName) }',
    '  try { $layer.Color = LayerColor $safeName } catch {}',
    '  $doc.ActiveLayer = $layer',
    '}',
    'function UpdatePlaybackState([int]$completed, [string]$document, [int]$startingEntityCount) {',
    '  $state = [pscustomobject]@{',
    '    ownerToken = $lockOwnerToken',
    '    operationSetId = $operationSetId',
    '    markerPath = $markerPath',
    '    completed = $completed',
    '    document = $document',
    '    startingEntityCount = $startingEntityCount',
    '    heartbeatAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '  }',
    '  if ($lockPath) { $state | ConvertTo-Json -Compress | Set-Content -LiteralPath $lockPath -Encoding UTF8 }',
    '  if ($progressPath) {',
    '    $progressDirectory = Split-Path -Parent $progressPath',
    '    if ($progressDirectory) { [void](New-Item -ItemType Directory -Force -Path $progressDirectory) }',
    '    $state | ConvertTo-Json -Compress | Set-Content -LiteralPath $progressPath -Encoding UTF8',
    '  }',
    '}',
    '$acad = $null',
    '$startedNewApplication = $false',
    "try { $acad = [Runtime.InteropServices.Marshal]::GetActiveObject('AutoCAD.Application') } catch {}",
    'if ($null -eq $acad) {',
    '  $startedNewApplication = $true',
    "  $clsid = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\AutoCAD.Application\\CLSID' -ErrorAction SilentlyContinue).'(default)'",
    '  $localServer = if ($clsid) { (Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\\CLSID\\$clsid\\LocalServer32" -ErrorAction SilentlyContinue).\'(default)\' } else { \'\' }',
    "  $exeMatch = [regex]::Match([string]$localServer, '^\\s*\"(?<path>[^\"]+\\.exe)\"|^\\s*(?<path>.+?\\.exe)(?:\\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)",
    "  $acadExecutable = if ($exeMatch.Success) { $exeMatch.Groups['path'].Value } else { '' }",
    "  if (-not $acadExecutable -or -not (Test-Path -LiteralPath $acadExecutable)) { throw 'AutoCAD is registered, but its executable path could not be resolved.' }",
    '  [void](Start-Process -FilePath $acadExecutable -PassThru)',
    '  $attachDeadline = (Get-Date).AddSeconds(120)',
    '  while ($null -eq $acad -and (Get-Date) -lt $attachDeadline) {',
    '    Start-Sleep -Milliseconds 500',
    "    try { $acad = [Runtime.InteropServices.Marshal]::GetActiveObject('AutoCAD.Application') } catch {}",
    '  }',
    "  if ($null -eq $acad) { throw 'AutoCAD started, but its COM automation object was not registered within 120 seconds.' }",
    '}',
    '$applicationReady = $false',
    '$applicationDeadline = (Get-Date).AddSeconds(120)',
    'while ((Get-Date) -lt $applicationDeadline -and -not $applicationReady) {',
    '  try {',
    '    $acad.Visible = $true',
    '    [void]$acad.Documents.Count',
    "    if (-not [bool]$acad.GetAcadState().IsQuiescent) { throw 'AutoCAD is still busy.' }",
    '    $applicationReady = $true',
    '  } catch {',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '}',
    "if (-not $applicationReady) { throw 'AutoCAD registered its COM object, but remained busy for more than 120 seconds.' }",
    'if ($resumeCompleted -gt 0) {',
    '  $resumeDoc = $null',
    '  for ($documentIndex = 0; $documentIndex -lt [int]$acad.Documents.Count; $documentIndex += 1) {',
    '    try {',
    '      $candidateResumeDoc = $acad.Documents.Item($documentIndex)',
    '      if ([string]$candidateResumeDoc.Name -eq $resumeDocument) { $resumeDoc = $candidateResumeDoc; break }',
    '    } catch {}',
    '  }',
    "  if ($null -eq $resumeDoc) { throw 'The partial AutoCAD playback document is no longer open; refusing to duplicate the operation set.' }",
    '  $resumeDoc.Activate()',
    '  $createNewDocument = $false',
    '}',
    '$needsDocument = $createNewDocument -and -not $startedNewApplication',
    'try { if ($null -eq $acad.ActiveDocument) { $needsDocument = $true } } catch { $needsDocument = $true }',
    'if ($needsDocument) {',
    '  $documentCreated = $false',
    '  $createDeadline = (Get-Date).AddSeconds(120)',
    '  while ((Get-Date) -lt $createDeadline -and -not $documentCreated) {',
    '    try {',
    '      [void]$acad.Documents.Add()',
    '      $documentCreated = $true',
    '    } catch {',
    '      Start-Sleep -Milliseconds 500',
    '    }',
    '  }',
    "  if (-not $documentCreated) { throw 'AutoCAD opened, but Lumi could not create a drawing document within 120 seconds.' }",
    '}',
    '$doc = $null',
    '$model = $null',
    '$readyDeadline = (Get-Date).AddSeconds(120)',
    'while ((Get-Date) -lt $readyDeadline) {',
    '  try {',
    '    $candidateDoc = $acad.ActiveDocument',
    '    $candidateModel = $null',
    '    if ($null -ne $candidateDoc) { $candidateModel = $candidateDoc.ModelSpace }',
    '    $isQuiescent = $true',
    '    try { $isQuiescent = [bool]$acad.GetAcadState().IsQuiescent } catch {}',
    '    if ($null -ne $candidateDoc -and $null -ne $candidateModel -and $isQuiescent) {',
    '      $doc = $candidateDoc',
    '      $model = $candidateModel',
    '      break',
    '    }',
    '  } catch {}',
    '  Start-Sleep -Milliseconds 500',
    '}',
    "if ($null -eq $doc -or $null -eq $model) { throw 'AutoCAD opened, but its active drawing did not become ready within 120 seconds.' }",
    'try {',
    '  $hwnd = [IntPtr][int64]$acad.HWND',
    '  [void][LumiAutoCadWindow]::ShowWindow($hwnd, 9)',
    '  [void][LumiAutoCadWindow]::SetForegroundWindow($hwnd)',
    '} catch {}',
    '$completed = $resumeCompleted',
    '$startingEntityCount = if ($resumeCompleted -gt 0) { $resumeStartingEntityCount } else { [int]$model.Count }',
    'if ($resumeCompleted -gt 0) {',
    '  if ([string]$doc.Name -ne $resumeDocument) { throw "AutoCAD resume document mismatch. Expected $resumeDocument, found $([string]$doc.Name)." }',
    '  $resumeExpectedCount = $startingEntityCount + $resumeCompleted',
    '  if ([int]$model.Count -ne $resumeExpectedCount) { throw "AutoCAD partial-playback state changed. Expected $resumeExpectedCount entities, found $([int]$model.Count)." }',
    '}',
    'UpdatePlaybackState $completed ([string]$doc.Name) $startingEntityCount',
    'for ($operationIndex = $completed; $operationIndex -lt $operations.Count; $operationIndex += 1) {',
    '  $op = $operations[$operationIndex]',
    '  $index = $operationIndex + 1',
    '  $expectedBefore = $startingEntityCount + $completed',
    '  if ([int]$model.Count -ne $expectedBefore) { throw "AutoCAD entity count drifted before operation $index. Expected $expectedBefore, found $([int]$model.Count)." }',
    '  $drawn = $false',
    '  $operationError = $null',
    '  for ($attempt = 1; $attempt -le 20 -and -not $drawn; $attempt += 1) {',
    '    try {',
    '      try { $doc.Activate() } catch {}',
    '      $model = $doc.ModelSpace',
    '      if ($null -eq $doc -or $null -eq $model) { throw "Assigned AutoCAD drawing is not ready." }',
    '      EnsureLayer $doc ([string]$op.layer)',
    '      $entity = $null',
    "      if ($op.kind -eq 'line') {",
    '        $entity = $model.AddLine((Point3 $op.x1 $op.y1), (Point3 $op.x2 $op.y2))',
    "      } elseif ($op.kind -eq 'circle') {",
    '        $entity = $model.AddCircle((Point3 $op.x $op.y), [double]$op.r)',
    "      } elseif ($op.kind -eq 'arc') {",
    '        $start = [double]$op.start',
    '        $end = [double]$op.end',
    '        if ($end -lt $start) { $swap = $start; $start = $end; $end = $swap }',
    '        $startRad = $start * [Math]::PI / 180.0',
    '        $endRad = $end * [Math]::PI / 180.0',
    '        while ($startRad -lt 0) { $startRad += 2 * [Math]::PI; $endRad += 2 * [Math]::PI }',
    '        while ($endRad -le $startRad) { $endRad += 2 * [Math]::PI }',
    '        $entity = $model.AddArc((Point3 $op.cx $op.cy), [double]$op.r, $startRad, $endRad)',
    "      } elseif ($op.kind -eq 'text') {",
    '        $entity = $model.AddText([string]$op.text, (Point3 $op.x $op.y), [double]$op.height)',
    '      } else {',
    "        throw \"Unsupported operation kind: $($op.kind)\"",
    '      }',
    '      if ($null -ne $entity) { $entity.Update() }',
    '      $doc.Regen(1)',
    '      $drawn = $true',
    '    } catch {',
    '      $operationError = $_.Exception.Message',
    '      $expectedAfter = $startingEntityCount + $completed + 1',
    '      if ([int]$model.Count -eq $expectedAfter) {',
    '        $drawn = $true',
    '        break',
    '      }',
    '      if ([int]$model.Count -gt $expectedAfter) { throw "AutoCAD operation $index created duplicate entities." }',
    "      $retryable = $operationError -match 'rejected by callee|call was rejected|busy|not ready|Null|RPC_E_CALL_REJECTED|0x80010001'",
    '      if (-not $retryable -or $attempt -eq 20) { break }',
    '      Start-Sleep -Milliseconds 500',
    '    }',
    '  }',
    '  if (-not $drawn) {',
    "    throw \"AutoCAD operation $index ($($op.kind)) failed: $operationError\"",
    '  }',
    '  $completed += 1',
    '  $expectedAfter = $startingEntityCount + $completed',
    '  if ([int]$model.Count -ne $expectedAfter) { throw "AutoCAD entity-count verification failed after operation $completed. Expected $expectedAfter, found $([int]$model.Count)." }',
    '  UpdatePlaybackState $completed ([string]$doc.Name) $startingEntityCount',
    '  if ($completed -le 6 -or ($completed % 8) -eq 0) { try { $acad.ZoomExtents() } catch {} }',
    '  Start-Sleep -Milliseconds $delayMs',
    '}',
    'try { $acad.ZoomExtents() } catch {}',
    'if ($savePath) {',
    '  $saveDirectory = Split-Path -Parent $savePath',
    '  if ($saveDirectory) { [void](New-Item -ItemType Directory -Force -Path $saveDirectory) }',
    '  $doc.SaveAs($savePath)',
    '}',
    '$endingEntityCount = [int]$model.Count',
    '$entitiesAdded = $endingEntityCount - $startingEntityCount',
    '$entityCountMatches = $entitiesAdded -eq $operations.Count -and $completed -eq $operations.Count',
    "if (-not $entityCountMatches) { throw 'AutoCAD entity-count verification failed; completion marker was not written.' }",
    '$result = [pscustomobject]@{',
    "  status = 'completed'",
    "  transport = 'mcp_autocad_com'",
    '  visiblePlayback = $true',
    '  geometryVerified = $true',
    '  geometryVerificationRequired = $geometryVerificationRequired',
    '  geometryHash = $geometryHash',
    '  geometryReceiptPath = $geometryReceiptPath',
    '  operationSetId = $operationSetId',
    '  title = $title',
    '  operationCount = $completed',
    '  expectedEntityCount = $operations.Count',
    '  startingEntityCount = $startingEntityCount',
    '  endingEntityCount = $endingEntityCount',
    '  entitiesAdded = $entitiesAdded',
    '  entityCountMatches = $entityCountMatches',
    '  strokeDelayMs = $delayMs',
    '  completionMarkerPath = $markerPath',
    '  completionMarkerExists = $false',
    '  document = [string]$doc.Name',
    '  savePath = $savePath',
    '  autocadVersion = [string]$acad.Version',
    '  alreadyCompleted = $false',
    '}',
    'if ($markerPath) {',
    '  $markerDirectory = Split-Path -Parent $markerPath',
    '  if ($markerDirectory) { [void](New-Item -ItemType Directory -Force -Path $markerDirectory) }',
    '  $result.completionMarkerExists = $true',
    '  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $markerPath -Encoding UTF8',
    '}',
    'if ($progressPath -and (Test-Path -LiteralPath $progressPath)) { Remove-Item -LiteralPath $progressPath -Force }',
    '$result | ConvertTo-Json -Compress',
    '',
  ].join('\n');
}

function executePowerShell(script: string, timeoutMs: number): Promise<string> {
  const scriptDirectory = path.join(os.tmpdir(), 'lumios-autocad-mcp');
  fs.mkdirSync(scriptDirectory, { recursive: true });
  const scriptPath = path.join(scriptDirectory, `playback-${crypto.randomUUID()}.ps1`);
  fs.writeFileSync(
    scriptPath,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script, 'utf-8')]),
  );
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const cleanup = () => {
      try { fs.rmSync(scriptPath, { force: true }); } catch {}
    };
    child.on('error', error => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      cleanup();
      if (timedOut) {
        reject(new Error(`AutoCAD MCP playback timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(formatPowerShellFailure(stderr, stdout, code)));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function decodePowerShellText(value: string): string {
  return value
    .replace(/_x([0-9a-f]{4})_/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function formatPowerShellFailure(stderr: string, stdout: string, code: number | null): string {
  const source = String(stderr || '').trim();
  if (/^#< CLIXML/i.test(source)) {
    const messages = Array.from(source.matchAll(/<S\s+S="Error">([\s\S]*?)<\/S>/gi))
      .map(match => decodePowerShellText(match[1]).trim())
      .filter(Boolean);
    const uniqueMessages = Array.from(new Set(messages));
    if (uniqueMessages.length) return uniqueMessages.join('\n');
  }
  return decodePowerShellText(source || stdout || `PowerShell exited with code ${code}`).trim();
}

function parseJsonFile(filePath: string): Record<string, any> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '').trim();
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readVerifiedCompletionMarker(
  markerPath: string,
  payload: AutocadOperationPayload,
): Record<string, any> | null {
  if (!markerPath || !fs.existsSync(markerPath)) return null;
  const marker = parseJsonFile(markerPath);
  if (!marker) return null;
  const valid = marker.status === 'completed'
    && marker.transport === 'mcp_autocad_com'
    && marker.visiblePlayback === true
    && marker.completionMarkerExists === true
    && marker.geometryVerified === true
    && marker.geometryVerificationRequired === payload.geometryVerificationRequired
    && (!payload.geometryVerificationRequired || marker.geometryReceiptPath === payload.geometryReceiptPath)
    && marker.operationSetId === payload.operationSetId
    && marker.geometryHash === payload.geometryHash
    && Number(marker.operationCount) === payload.operations.length
    && Number(marker.expectedEntityCount) === payload.operations.length
    && Number(marker.entitiesAdded) === payload.operations.length
    && marker.entityCountMatches === true;
  return valid ? marker : null;
}

function readPlaybackProgress(
  progressPath: string,
  payload: AutocadOperationPayload,
): { completed: number; startingEntityCount: number; document: string } | null {
  if (!progressPath || !fs.existsSync(progressPath)) return null;
  const progress = parseJsonFile(progressPath);
  const completed = Number(progress?.completed);
  const startingEntityCount = Number(progress?.startingEntityCount);
  const document = String(progress?.document || '').trim();
  const valid = progress?.operationSetId === payload.operationSetId
    && Number.isInteger(completed)
    && completed > 0
    && completed <= payload.operations.length
    && Number.isInteger(startingEntityCount)
    && startingEntityCount >= 0
    && Boolean(document);
  return valid ? { completed, startingEntityCount, document } : null;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function acquirePlaybackLock(input: {
  lockPath: string;
  markerPath: string;
  ownerToken: string;
  payload: AutocadOperationPayload;
  timeoutMs: number;
}): Promise<{ cachedResult: Record<string, any> | null }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    const cachedResult = readVerifiedCompletionMarker(input.markerPath, input.payload);
    if (cachedResult) return { cachedResult };
    try {
      const descriptor = fs.openSync(input.lockPath, 'wx');
      fs.writeFileSync(descriptor, JSON.stringify({
        ownerToken: input.ownerToken,
        operationSetId: input.payload.operationSetId,
        markerPath: input.markerPath,
        completed: 0,
        heartbeatAt: Date.now(),
      }), 'utf-8');
      fs.closeSync(descriptor);
      return { cachedResult: null };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const lock = parseJsonFile(input.lockPath);
        const heartbeatAt = Number(lock?.heartbeatAt || fs.statSync(input.lockPath).mtimeMs);
        stale = Date.now() - heartbeatAt > 180_000;
      } catch {
        stale = true;
      }
      if (stale) {
        try { fs.rmSync(input.lockPath, { force: true }); } catch {}
        continue;
      }
      await wait(500);
    }
  }
  throw new Error('Timed out waiting for another AutoCAD MCP playback run to finish.');
}

function releasePlaybackLock(lockPath: string, ownerToken: string): void {
  try {
    const lock = parseJsonFile(lockPath);
    if (lock?.ownerToken === ownerToken) fs.rmSync(lockPath, { force: true });
  } catch {}
}

export async function runAutocadComPlayback(options: AutocadPlaybackOptions): Promise<Record<string, any>> {
  const payload = readAutocadOperationPayload(options.operationsPath);
  const markerPath = options.completionMarkerPath ? path.resolve(options.completionMarkerPath) : '';
  if (!markerPath) throw new Error('AutoCAD MCP playback requires a completionMarkerPath.');
  const progressPath = options.progressPath
    ? path.resolve(options.progressPath)
    : `${markerPath}.progress.json`;
  const cachedResult = readVerifiedCompletionMarker(markerPath, payload);
  if (cachedResult) {
    try { fs.rmSync(progressPath, { force: true }); } catch {}
    return {
      ...cachedResult,
      alreadyCompleted: true,
      completionMarkerExists: true,
      operationsPath: path.resolve(options.operationsPath),
    };
  }
  if (process.platform !== 'win32') throw new Error('AutoCAD MCP playback currently requires Windows.');
  const requestedDelay = Number(options.strokeDelayMs);
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.max(100, Math.min(Math.round(requestedDelay), 5000))
    : 450;
  const timeoutMs = Math.max(
    60_000,
    Math.min(options.timeoutMs || 180_000 + payload.operations.length * delayMs * 2, 30 * 60_000),
  );
  const lockPath = options.lockPath ? path.resolve(options.lockPath) : path.join(os.tmpdir(), 'lumios-autocad-playback.lock');
  const lockOwnerToken = options.lockOwnerToken || crypto.randomUUID();
  const acquired = await acquirePlaybackLock({
    lockPath,
    markerPath,
    ownerToken: lockOwnerToken,
    payload,
    timeoutMs,
  });
  if (acquired.cachedResult) {
    try { fs.rmSync(progressPath, { force: true }); } catch {}
    return {
      ...acquired.cachedResult,
      alreadyCompleted: true,
      completionMarkerExists: true,
      operationsPath: path.resolve(options.operationsPath),
    };
  }
  const resume = readPlaybackProgress(progressPath, payload);
  if (!resume && fs.existsSync(progressPath)) {
    try { fs.rmSync(progressPath, { force: true }); } catch {}
  }
  try {
    const script = buildAutocadComPlaybackScript(payload, {
      ...options,
      completionMarkerPath: markerPath,
      strokeDelayMs: delayMs,
      lockPath,
      lockOwnerToken,
      progressPath,
      createNewDocument: resume ? false : options.createNewDocument,
      resumeCompleted: resume?.completed,
      resumeStartingEntityCount: resume?.startingEntityCount,
      resumeDocument: resume?.document,
    });
    const output = await executePowerShell(script, timeoutMs);
    const jsonLine = output.split(/\r?\n/).reverse().find(line => line.trim().startsWith('{'));
    if (!jsonLine) throw new Error(`AutoCAD MCP playback returned no completion result: ${output.slice(-1200)}`);
    const result = JSON.parse(jsonLine.replace(/^\uFEFF/, ''));
    const marker = readVerifiedCompletionMarker(markerPath, payload);
    if (!marker || result.status !== 'completed' || result.completionMarkerExists !== true) {
      throw new Error('AutoCAD MCP playback did not pass completion-marker and entity-count verification.');
    }
    return {
      ...result,
      operationsPath: path.resolve(options.operationsPath),
      resumedFromOperation: resume?.completed || 0,
    };
  } finally {
    releasePlaybackLock(lockPath, lockOwnerToken);
  }
}
