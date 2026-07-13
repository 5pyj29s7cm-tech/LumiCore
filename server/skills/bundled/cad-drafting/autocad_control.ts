import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export type AutocadPlaybackOperation =
  | { kind: 'line'; layer: string; x1: number; y1: number; x2: number; y2: number; label?: string }
  | { kind: 'circle'; layer: string; x: number; y: number; r: number; label?: string }
  | { kind: 'arc'; layer: string; cx: number; cy: number; r: number; start: number; end: number; label?: string }
  | { kind: 'text'; layer: string; x: number; y: number; text: string; height: number; label?: string };

export interface AutocadOperationPayload {
  version: number;
  title: string;
  operations: AutocadPlaybackOperation[];
}

export interface AutocadPlaybackOptions {
  operationsPath: string;
  completionMarkerPath?: string;
  strokeDelayMs?: number;
  createNewDocument?: boolean;
  savePath?: string;
  timeoutMs?: number;
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
  return {
    version: Number(parsed.version || 1),
    title: String(parsed.title || path.basename(resolved, '.json')).slice(0, 160),
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
    `$savePath = ${psLiteral(savePath)}`,
    `$title = ${psLiteral(payload.title)}`,
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
    '$completed = 0',
    'foreach ($op in $operations) {',
    '  $index = $completed + 1',
    '  $drawn = $false',
    '  $operationError = $null',
    '  for ($attempt = 1; $attempt -le 20 -and -not $drawn; $attempt += 1) {',
    '    try {',
    '      $doc = $acad.ActiveDocument',
    '      $model = $doc.ModelSpace',
    '      if ($null -eq $doc -or $null -eq $model) { throw "Active AutoCAD drawing is not ready." }',
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
    "      $retryable = $operationError -match 'rejected by callee|call was rejected|busy|not ready|Null|RPC_E_CALL_REJECTED|0x80010001'",
    '      if (-not $retryable -or $attempt -eq 20) { break }',
    '      Start-Sleep -Milliseconds 500',
    '    }',
    '  }',
    '  if (-not $drawn) {',
    "    throw \"AutoCAD operation $index ($($op.kind)) failed: $operationError\"",
    '  }',
    '  $completed += 1',
    '  if ($completed -le 6 -or ($completed % 8) -eq 0) { try { $acad.ZoomExtents() } catch {} }',
    '  Start-Sleep -Milliseconds $delayMs',
    '}',
    'try { $acad.ZoomExtents() } catch {}',
    'if ($savePath) {',
    '  $saveDirectory = Split-Path -Parent $savePath',
    '  if ($saveDirectory) { [void](New-Item -ItemType Directory -Force -Path $saveDirectory) }',
    '  $doc.SaveAs($savePath)',
    '}',
    'if ($markerPath) {',
    '  $markerDirectory = Split-Path -Parent $markerPath',
    '  if ($markerDirectory) { [void](New-Item -ItemType Directory -Force -Path $markerDirectory) }',
    '  @("completed=$completed", "title=$title", "method=mcp_autocad_com") | Set-Content -LiteralPath $markerPath -Encoding UTF8',
    '}',
    '[pscustomobject]@{',
    "  status = 'completed'",
    "  transport = 'mcp_autocad_com'",
    '  visiblePlayback = $true',
    '  title = $title',
    '  operationCount = $completed',
    '  strokeDelayMs = $delayMs',
    '  completionMarkerPath = $markerPath',
    '  completionMarkerExists = [bool]($markerPath -and (Test-Path -LiteralPath $markerPath))',
    '  document = [string]$doc.Name',
    '  savePath = $savePath',
    '  autocadVersion = [string]$acad.Version',
    '} | ConvertTo-Json -Compress',
    '',
  ].join('\n');
}

function executePowerShell(script: string, timeoutMs: number): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`AutoCAD MCP playback timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
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

export async function runAutocadComPlayback(options: AutocadPlaybackOptions): Promise<Record<string, any>> {
  if (process.platform !== 'win32') throw new Error('AutoCAD MCP playback currently requires Windows.');
  const payload = readAutocadOperationPayload(options.operationsPath);
  const requestedDelay = Number(options.strokeDelayMs);
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.max(100, Math.min(Math.round(requestedDelay), 5000))
    : 450;
  const timeoutMs = Math.max(
    60_000,
    Math.min(options.timeoutMs || 180_000 + payload.operations.length * delayMs * 2, 30 * 60_000),
  );
  const script = buildAutocadComPlaybackScript(payload, { ...options, strokeDelayMs: delayMs });
  const output = await executePowerShell(script, timeoutMs);
  const jsonLine = output.split(/\r?\n/).reverse().find(line => line.trim().startsWith('{'));
  if (!jsonLine) throw new Error(`AutoCAD MCP playback returned no completion result: ${output.slice(-1200)}`);
  const result = JSON.parse(jsonLine);
  if (result.status !== 'completed' || result.completionMarkerExists !== true) {
    throw new Error('AutoCAD MCP playback did not produce its completion marker.');
  }
  return {
    ...result,
    operationsPath: path.resolve(options.operationsPath),
  };
}
