import { execFile } from 'child_process';

export const WPS_CREATE_DOCUMENT_TOOL = 'wps_create_document_with_text';

export interface WpsCreateDocumentReceipt {
  ok: true;
  status: 'verified';
  automation: 'KWPS.Application';
  attachmentMode: 'attachedExisting' | 'newVisibleInstance';
  attachedExisting: boolean;
  newVisibleInstance: boolean;
  visible: true;
  application: 'WPS Writer';
  processName: 'wps.exe';
  processId: number;
  documentCreated: true;
  documentName: string;
  windowTitle: string;
  bodyText: string;
  bodyTextWithoutTerminalParagraph: string;
  exactTextMatch: true;
  charactersRequested: number;
  charactersReadBack: number;
  saved: false;
  savePath: '';
}

function buildWpsCreateDocumentScript(text: string): string {
  const encodedText = Buffer.from(text, 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$InformationPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    `$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedText}'))`,
    '$beforeIds = @(Get-Process -Name wps -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)',
    '$app = $null',
    '$doc = $null',
    '$success = $false',
    '$attachedExisting = $false',
    '$startedNewApplication = $false',
    'try {',
    "  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('KWPS.Application'); $attachedExisting = $true } catch {}",
    '  if ($null -eq $app) {',
    "    $app = New-Object -ComObject 'KWPS.Application'",
    '    $startedNewApplication = $true',
    '  }',
    '  $app.Visible = $true',
    '  if (-not [bool]$app.Visible) { throw "WPS COM automation did not expose a visible application instance." }',
    '  $doc = $app.Documents.Add()',
    '  if ($null -eq $doc) { throw "WPS did not create a document." }',
    '  try { $doc.Activate() } catch {}',
    '  [void]$app.Selection.TypeText($text)',
    '  Start-Sleep -Milliseconds 350',
    '  $bodyText = [string]$doc.Content.Text',
    '  $bodyWithoutTerminalParagraph = if ($bodyText.EndsWith("`r")) { $bodyText.Substring(0, $bodyText.Length - 1) } else { $bodyText }',
    '  $expectedNormalized = ($text -replace "`r`n", "`n") -replace "`r", "`n"',
    '  $actualNormalized = ($bodyWithoutTerminalParagraph -replace "`r`n", "`n") -replace "`r", "`n"',
    '  $exactTextMatch = $actualNormalized -ceq $expectedNormalized',
    '  if (-not $exactTextMatch) { throw "WPS body readback did not exactly match the requested text." }',
    '  $documentName = [string]$doc.Name',
    '  $windowCaption = ""',
    '  try { $windowCaption = [string]$app.ActiveWindow.Caption } catch {}',
    '  $processes = @(Get-Process -Name wps -ErrorAction SilentlyContinue)',
    '  $windowProcess = $processes | Where-Object {',
    '    $_.MainWindowHandle -ne 0 -and (',
    '      ($documentName -and $_.MainWindowTitle -like "*$documentName*") -or',
    '      ($windowCaption -and $_.MainWindowTitle -like "*$windowCaption*")',
    '    )',
    '  } | Select-Object -First 1',
    '  if ($null -eq $windowProcess) {',
    '    $windowProcess = $processes | Where-Object {',
    '      $_.MainWindowHandle -ne 0 -and $_.Id -notin $beforeIds',
    '    } | Sort-Object StartTime -Descending | Select-Object -First 1',
    '  }',
    '  if ($null -eq $windowProcess) { throw "WPS created the document, but no visible WPS window process could be verified." }',
    '  $windowTitle = [string]$windowProcess.MainWindowTitle',
    '  if ([string]::IsNullOrWhiteSpace($windowTitle)) { throw "WPS window title verification was empty." }',
    '  try {',
    '    [void](Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class LumiWpsForeground {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '}',
    '"@',
    '    )',
    '    [void][LumiWpsForeground]::ShowWindow($windowProcess.MainWindowHandle, 9)',
    '    [void][LumiWpsForeground]::SetForegroundWindow($windowProcess.MainWindowHandle)',
    '  } catch {}',
    '  $receipt = [ordered]@{',
    '    ok = $true',
    "    status = 'verified'",
    "    automation = 'KWPS.Application'",
    "    attachmentMode = $(if ($attachedExisting) { 'attachedExisting' } else { 'newVisibleInstance' })",
    '    attachedExisting = [bool]$attachedExisting',
    '    newVisibleInstance = [bool]$startedNewApplication',
    '    visible = [bool]$app.Visible',
    "    application = 'WPS Writer'",
    "    processName = 'wps.exe'",
    '    processId = [int]$windowProcess.Id',
    '    documentCreated = $true',
    '    documentName = $documentName',
    '    windowTitle = $windowTitle',
    '    bodyText = $bodyText',
    '    bodyTextWithoutTerminalParagraph = $bodyWithoutTerminalParagraph',
    '    exactTextMatch = [bool]$exactTextMatch',
    '    charactersRequested = [int]$text.Length',
    '    charactersReadBack = [int]$bodyWithoutTerminalParagraph.Length',
    '    saved = $false',
    "    savePath = ''",
    '  }',
    '  $success = $true',
    '  $receipt | ConvertTo-Json -Compress -Depth 5',
    '} finally {',
    '  if (-not $success) {',
    '    if ($null -ne $doc) { try { $doc.Close(0) } catch {} }',
    '    if ($startedNewApplication -and $null -ne $app) { try { $app.Quit() } catch {} }',
    '  }',
    '  if ($null -ne $doc) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) } catch {} }',
    '  if ($null -ne $app) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) } catch {} }',
    '  [GC]::Collect()',
    '  [GC]::WaitForPendingFinalizers()',
    '}',
  ].join('\n');
}

function parseReceipt(stdout: string): WpsCreateDocumentReceipt {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const candidate = [...lines].reverse().find(line => line.startsWith('{') && line.endsWith('}'));
  if (!candidate) throw new Error('WPS automation returned no structured verification receipt.');
  const parsed = JSON.parse(candidate) as Partial<WpsCreateDocumentReceipt>;
  if (
    parsed.ok !== true
    || parsed.status !== 'verified'
    || parsed.automation !== 'KWPS.Application'
    || parsed.visible !== true
    || parsed.documentCreated !== true
    || parsed.exactTextMatch !== true
    || parsed.saved !== false
    || !['attachedExisting', 'newVisibleInstance'].includes(String(parsed.attachmentMode || ''))
    || (
      parsed.attachmentMode === 'attachedExisting'
        ? parsed.attachedExisting !== true || parsed.newVisibleInstance !== false
        : parsed.attachedExisting !== false || parsed.newVisibleInstance !== true
    )
    || !Number.isInteger(parsed.processId)
    || Number(parsed.processId) <= 0
    || !String(parsed.documentName || '').trim()
    || !String(parsed.windowTitle || '').trim()
  ) {
    throw new Error('WPS automation receipt was incomplete or unverified.');
  }
  return parsed as WpsCreateDocumentReceipt;
}

export async function createVisibleWpsDocumentWithText(
  text: string,
  timeoutMs = 30_000,
): Promise<WpsCreateDocumentReceipt> {
  if (process.platform !== 'win32') {
    throw new Error('WPS COM automation is available only on Windows.');
  }
  const requestedText = String(text || '');
  if (!requestedText.trim()) throw new Error('text is required.');
  if (requestedText.length > 100_000) {
    throw new Error('WPS visible document input is limited to 100,000 characters per call.');
  }

  const encodedCommand = Buffer
    .from(buildWpsCreateDocumentScript(requestedText), 'utf16le')
    .toString('base64');

  return new Promise<WpsCreateDocumentReceipt>((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedCommand,
      ],
      {
        windowsHide: true,
        timeout: Math.max(5_000, Math.min(timeoutMs, 60_000)),
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(
            `WPS COM automation failed: ${String(stderr || error.message || error).trim()}`,
          ));
          return;
        }
        try {
          resolve(parseReceipt(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
