import { execFile } from 'child_process';
import type {
  DesktopUiAction,
  DesktopUiActionOptions,
  DesktopUiSnapshotOptions,
} from './native_ui_contract';

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powershellExecutable(): string {
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

export async function captureWindowsUiSnapshot(options: DesktopUiSnapshotOptions = {}) {
  if (process.platform !== 'win32') {
    return {
      status: 'not_supported',
      platform: process.platform,
      note: 'Windows UI Automation snapshots are only available on Windows desktop hosts.',
    };
  }

  const root = options.root === 'desktop' || options.root === 'focused' ? options.root : 'active';
  const maxDepth = clampInt(options.maxDepth, 3, 0, 8);
  const maxNodes = clampInt(options.maxNodes, 80, 1, 300);
  const includeOffscreen = options.includeOffscreen === true;
  const timeoutMs = clampInt(options.timeoutMs, 5000, 1000, 15000);

  const script = options.browserPage
    ? buildWindowsBrowserPageScript(options)
    : buildUiaScript({
    ...options,
    root,
    maxDepth,
    maxNodes,
    includeOffscreen,
  });
  const stdout = await runPowershell(script, timeoutMs, options.signal);
  try {
    return JSON.parse(stdout);
  } catch {
    return {
      status: 'parse_error',
      raw: stdout.slice(0, 4000),
    };
  }
}

export async function runWindowsUiAction(options: DesktopUiActionOptions) {
  if (process.platform !== 'win32') {
    return {
      status: 'not_supported',
      platform: process.platform,
      note: 'Windows UI Automation actions are only available on Windows desktop hosts.',
    };
  }

  const action = normalizeAction(options.action);
  const root = options.root === 'desktop' || options.root === 'focused' ? options.root : 'active';
  const maxDepth = clampInt(options.maxDepth, 5, 0, 8);
  const maxNodes = clampInt(options.maxNodes, 160, 1, 500);
  const includeOffscreen = options.includeOffscreen === true;
  const timeoutMs = clampInt(options.timeoutMs, 8000, 1000, 20000);
  const index = clampInt(options.index, 0, 0, 1000);
  const delayAfterMs = clampInt(options.delayAfterMs, 250, 0, 3000);
  const script = buildUiaActionScript({
    ...options,
    action,
    root,
    maxDepth,
    maxNodes,
    includeOffscreen,
    index,
    delayAfterMs,
  });
  const stdout = await runPowershell(script, timeoutMs, options.signal);
  try {
    return JSON.parse(stdout);
  } catch {
    return {
      status: 'parse_error',
      raw: stdout.slice(0, 4000),
    };
  }
}

function runPowershell(script: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Windows UI Automation cancelled before execution');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      callback();
    };
    const child = execFile(
      powershellExecutable(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 * 4 },
      (error, stdout, stderr) => {
        if (error) {
          finish(() => reject(new Error((stderr || error.message || 'Windows UI Automation snapshot failed').trim())));
          return;
        }
        finish(() => resolve(stdout.trim()));
      },
    );
    const onAbort = () => {
      try { child.kill(); } catch {}
      const error = new Error('Windows UI Automation cancelled because the active task was stopped or superseded');
      error.name = 'AbortError';
      finish(() => reject(error));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeAction(action: unknown): DesktopUiAction {
  const value = String(action || '').trim().toLowerCase();
  if (value === 'click' || value === 'invoke' || value === 'type') return value;
  return 'focus';
}

function buildUiaScript(options: DesktopUiSnapshotOptions & {
  root: 'active' | 'focused' | 'desktop';
  maxDepth: number;
  maxNodes: number;
  includeOffscreen: boolean;
}): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$RootMode = ${psLiteral(options.root)}
$TargetName = ${psLiteral(optionalString(options.name))}
$TargetNameContains = ${psLiteral(optionalString(options.nameContains))}
$TargetAutomationId = ${psLiteral(optionalString(options.automationId))}
$TargetControlType = ${psLiteral(optionalString(options.controlType))}
$TargetClassName = ${psLiteral(optionalString(options.className))}
$TargetProcessId = ${optionalNumber(options.processId)}
$TargetNativeWindowHandle = ${optionalNumber(options.nativeWindowHandle)}
$AllMatches = ${options.allMatches === true ? '$true' : '$false'}
$MaxDepth = ${options.maxDepth}
$MaxNodes = ${options.maxNodes}
$IncludeOffscreen = ${options.includeOffscreen ? '$true' : '$false'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LumiNativeMethods {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@

function RectToMap($rect) {
  if ($null -eq $rect) { return $null }
  if ($rect.IsEmpty) { return $null }
  foreach ($value in @($rect.X, $rect.Y, $rect.Width, $rect.Height, $rect.Right, $rect.Bottom)) {
    if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return $null }
  }
  return [ordered]@{
    x = [Math]::Round($rect.X, 2)
    y = [Math]::Round($rect.Y, 2)
    width = [Math]::Round($rect.Width, 2)
    height = [Math]::Round($rect.Height, 2)
    right = [Math]::Round($rect.Right, 2)
    bottom = [Math]::Round($rect.Bottom, 2)
  }
}

function ControlTypeName($controlType) {
  if ($null -eq $controlType) { return '' }
  return ($controlType.ProgrammaticName -replace '^ControlType\\.', '')
}

function NormalizeText($value) {
  return ([string]$value).Trim().ToLowerInvariant()
}

function ElementMatches($element) {
  if ($null -eq $element) { return $false }
  $current = $element.Current
  $hasCriterion = $false
  if ($TargetName) {
    $hasCriterion = $true
    if ((NormalizeText $current.Name) -ne (NormalizeText $TargetName)) { return $false }
  }
  if ($TargetNameContains) {
    $hasCriterion = $true
    if (-not (NormalizeText $current.Name).Contains((NormalizeText $TargetNameContains))) { return $false }
  }
  if ($TargetAutomationId) {
    $hasCriterion = $true
    if ((NormalizeText $current.AutomationId) -ne (NormalizeText $TargetAutomationId)) { return $false }
  }
  if ($TargetControlType) {
    $hasCriterion = $true
    if ((NormalizeText (ControlTypeName $current.ControlType)) -ne (NormalizeText $TargetControlType)) { return $false }
  }
  if ($TargetClassName) {
    $hasCriterion = $true
    if ((NormalizeText $current.ClassName) -ne (NormalizeText $TargetClassName)) { return $false }
  }
  if ($TargetProcessId -gt 0) {
    $hasCriterion = $true
    if ([int]$current.ProcessId -ne $TargetProcessId) { return $false }
  }
  if ($TargetNativeWindowHandle -gt 0) {
    $hasCriterion = $true
    if ([int]$current.NativeWindowHandle -ne $TargetNativeWindowHandle) { return $false }
  }
  return $hasCriterion
}

$script:Count = 0
$script:Truncated = $false

function ConvertElement($element, [int]$depth) {
  if ($null -eq $element) { return $null }
  if ($script:Count -ge $MaxNodes) {
    $script:Truncated = $true
    return $null
  }

  $current = $element.Current
  if (-not $IncludeOffscreen -and $current.IsOffscreen -and $depth -gt 0) { return $null }
  $script:Count += 1

  $node = [ordered]@{
    name = [string]$current.Name
    automationId = [string]$current.AutomationId
    className = [string]$current.ClassName
    controlType = ControlTypeName $current.ControlType
    localizedControlType = [string]$current.LocalizedControlType
    processId = [int]$current.ProcessId
    nativeWindowHandle = [int]$current.NativeWindowHandle
    isEnabled = [bool]$current.IsEnabled
    isOffscreen = [bool]$current.IsOffscreen
    boundingRectangle = RectToMap $current.BoundingRectangle
    depth = $depth
    children = @()
  }

  if ($depth -lt $MaxDepth -and $script:Count -lt $MaxNodes) {
    try {
      $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($child in $children) {
        $converted = ConvertElement $child ($depth + 1)
        if ($null -ne $converted) { $node.children += $converted }
        if ($script:Count -ge $MaxNodes) {
          $script:Truncated = $true
          break
        }
      }
    } catch {}
  }

  return $node
}

if ($RootMode -eq 'desktop') {
  $desktopRoot = [System.Windows.Automation.AutomationElement]::RootElement
  $hasTarget = [bool]($TargetName -or $TargetNameContains -or $TargetAutomationId -or $TargetControlType -or $TargetClassName -or $TargetProcessId -gt 0 -or $TargetNativeWindowHandle -gt 0)
  if ($hasTarget) {
    $matches = @()
    try {
      $candidateCondition = if ($TargetName) {
        New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::NameProperty,
          $TargetName
        )
      } elseif ($TargetAutomationId) {
        New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
          $TargetAutomationId
        )
      } elseif ($TargetProcessId -gt 0) {
        New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
          $TargetProcessId
        )
      } elseif ($TargetNativeWindowHandle -gt 0) {
        New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty,
          $TargetNativeWindowHandle
        )
      } else {
        [System.Windows.Automation.Condition]::TrueCondition
      }
      $candidates = $desktopRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $candidateCondition)
      foreach ($candidate in $candidates) {
        if (ElementMatches $candidate) {
          $matches += $candidate
          if (-not $AllMatches -or $matches.Count -ge 6) { break }
        }
      }
    } catch {}
    $trees = @()
    foreach ($match in $matches) {
      $converted = ConvertElement $match 0
      if ($null -ne $converted) { $trees += $converted }
      if ($script:Count -ge $MaxNodes) { break }
    }
    $rootElement = if ($matches.Count -gt 0) { $matches[0] } else { $null }
  } else {
    $rootElement = $desktopRoot
  }
} elseif ($RootMode -eq 'focused') {
  $rootElement = [System.Windows.Automation.AutomationElement]::FocusedElement
} else {
  $hwnd = [LumiNativeMethods]::GetForegroundWindow()
  $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $rootElement) {
    $rootElement = [System.Windows.Automation.AutomationElement]::FocusedElement
  }
}

$tree = if ($null -ne $trees -and $trees.Count -gt 0) { $trees[0] } else { ConvertElement $rootElement 0 }
$result = [ordered]@{
  status = if ($null -eq $tree) { 'empty' } else { 'ok' }
  platform = 'win32'
  root = $RootMode
  maxDepth = $MaxDepth
  maxNodes = $MaxNodes
  capturedNodes = $script:Count
  truncated = [bool]$script:Truncated
  tree = $tree
  trees = if ($null -ne $trees) { $trees } else { @() }
  targetMatched = if ($RootMode -eq 'desktop' -and $hasTarget) { [bool]($null -ne $tree) } else { $null }
  note = 'Read-only Windows UI Automation snapshot. Use boundingRectangle with desktop mouse tools only after confirmation.'
}
$result | ConvertTo-Json -Depth 32 -Compress
`;
}

function optionalString(value: unknown): string {
  return String(value || '').trim();
}

function optionalNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function buildUiaActionScript(options: Required<Pick<DesktopUiActionOptions, 'action' | 'root' | 'maxDepth' | 'maxNodes' | 'includeOffscreen'>> & DesktopUiActionOptions & { index: number; delayAfterMs: number }): string {
  const hasText = options.text !== undefined;
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$RootMode = ${psLiteral(options.root || 'active')}
$Action = ${psLiteral(options.action)}
$MaxDepth = ${Number(options.maxDepth)}
$MaxNodes = ${Number(options.maxNodes)}
$IncludeOffscreen = ${options.includeOffscreen ? '$true' : '$false'}
$TargetName = ${psLiteral(optionalString(options.name))}
$TargetNameContains = ${psLiteral(optionalString(options.nameContains))}
$TargetAutomationId = ${psLiteral(optionalString(options.automationId))}
$TargetControlType = ${psLiteral(optionalString(options.controlType))}
$TargetClassName = ${psLiteral(optionalString(options.className))}
$TargetProcessId = ${optionalNumber(options.processId)}
$TargetNativeWindowHandle = ${optionalNumber(options.nativeWindowHandle)}
$TargetIndex = ${Number(options.index)}
$Text = ${psLiteral(hasText ? String(options.text) : '')}
$Append = ${options.append === true ? '$true' : '$false'}
$FallbackClick = ${options.fallbackClick === false ? '$false' : '$true'}
$Verify = ${options.verify === false ? '$false' : '$true'}
$DelayAfterMs = ${Number(options.delayAfterMs)}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LumiNativeMethods {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@

function RectToMap($rect) {
  if ($null -eq $rect) { return $null }
  if ($rect.IsEmpty) { return $null }
  foreach ($value in @($rect.X, $rect.Y, $rect.Width, $rect.Height, $rect.Right, $rect.Bottom)) {
    if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return $null }
  }
  return [ordered]@{
    x = [Math]::Round($rect.X, 2)
    y = [Math]::Round($rect.Y, 2)
    width = [Math]::Round($rect.Width, 2)
    height = [Math]::Round($rect.Height, 2)
    right = [Math]::Round($rect.Right, 2)
    bottom = [Math]::Round($rect.Bottom, 2)
    centerX = [Math]::Round($rect.X + ($rect.Width / 2), 2)
    centerY = [Math]::Round($rect.Y + ($rect.Height / 2), 2)
  }
}

function ControlTypeName($controlType) {
  if ($null -eq $controlType) { return '' }
  return ($controlType.ProgrammaticName -replace '^ControlType\\.', '')
}

function ElementSummary($element, [int]$depth = 0) {
  if ($null -eq $element) { return $null }
  $current = $element.Current
  return [ordered]@{
    name = [string]$current.Name
    automationId = [string]$current.AutomationId
    className = [string]$current.ClassName
    controlType = ControlTypeName $current.ControlType
    localizedControlType = [string]$current.LocalizedControlType
    processId = [int]$current.ProcessId
    nativeWindowHandle = [int]$current.NativeWindowHandle
    isEnabled = [bool]$current.IsEnabled
    isOffscreen = [bool]$current.IsOffscreen
    boundingRectangle = RectToMap $current.BoundingRectangle
    depth = $depth
  }
}

function NormalizeText($value) {
  return ([string]$value).Trim().ToLowerInvariant()
}

function ElementMatches($element) {
  if ($null -eq $element) { return $false }
  $current = $element.Current
  $hasCriterion = $false
  if ($TargetName) {
    $hasCriterion = $true
    if ((NormalizeText $current.Name) -ne (NormalizeText $TargetName)) { return $false }
  }
  if ($TargetNameContains) {
    $hasCriterion = $true
    if (-not (NormalizeText $current.Name).Contains((NormalizeText $TargetNameContains))) { return $false }
  }
  if ($TargetAutomationId) {
    $hasCriterion = $true
    if ((NormalizeText $current.AutomationId) -ne (NormalizeText $TargetAutomationId)) { return $false }
  }
  if ($TargetControlType) {
    $hasCriterion = $true
    $ct = NormalizeText (ControlTypeName $current.ControlType)
    if ($ct -ne (NormalizeText $TargetControlType)) { return $false }
  }
  if ($TargetClassName) {
    $hasCriterion = $true
    if ((NormalizeText $current.ClassName) -ne (NormalizeText $TargetClassName)) { return $false }
  }
  if ($TargetProcessId -gt 0) {
    $hasCriterion = $true
    if ([int]$current.ProcessId -ne $TargetProcessId) { return $false }
  }
  if ($TargetNativeWindowHandle -gt 0) {
    $hasCriterion = $true
    if ([int]$current.NativeWindowHandle -ne $TargetNativeWindowHandle) { return $false }
  }
  return $hasCriterion
}

function GetRootElement() {
  if ($RootMode -eq 'desktop') {
    return [System.Windows.Automation.AutomationElement]::RootElement
  }
  if ($RootMode -eq 'focused') {
    return [System.Windows.Automation.AutomationElement]::FocusedElement
  }
  $hwnd = [LumiNativeMethods]::GetForegroundWindow()
  $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $rootElement) {
    $rootElement = [System.Windows.Automation.AutomationElement]::FocusedElement
  }
  return $rootElement
}

$script:Visited = 0
$script:Truncated = $false
$script:Matches = New-Object System.Collections.ArrayList

function Walk($element, [int]$depth) {
  if ($null -eq $element) { return }
  if ($script:Visited -ge $MaxNodes) {
    $script:Truncated = $true
    return
  }
  $current = $element.Current
  if (-not $IncludeOffscreen -and $current.IsOffscreen -and $depth -gt 0) { return }
  $script:Visited += 1
  if (ElementMatches $element) {
    [void]$script:Matches.Add([ordered]@{ element = $element; depth = $depth })
  }
  if ($depth -ge $MaxDepth) { return }
  try {
    $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) {
      Walk $child ($depth + 1)
      if ($script:Visited -ge $MaxNodes) {
        $script:Truncated = $true
        break
      }
    }
  } catch {}
}

function InvokeElement($element) {
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
    return 'InvokePattern'
  }
  if ($FallbackClick) {
    ClickElement $element
    return 'mouse_click_fallback'
  }
  throw 'Target does not support InvokePattern and fallbackClick is false.'
}

function ClickElement($element) {
  $rect = $element.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) {
    throw 'Target has no clickable bounding rectangle.'
  }
  $x = [int][Math]::Round($rect.X + ($rect.Width / 2))
  $y = [int][Math]::Round($rect.Y + ($rect.Height / 2))
  $handle = [IntPtr]$element.Current.NativeWindowHandle
  if ($handle -ne [IntPtr]::Zero) { [void][LumiNativeMethods]::SetForegroundWindow($handle) }
  try { $element.SetFocus() } catch {}
  [void][LumiNativeMethods]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 80
  [LumiNativeMethods]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [LumiNativeMethods]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return [ordered]@{ x = $x; y = $y }
}

function EscapeSendKeysText($value) {
  $out = ''
  foreach ($ch in ([string]$value).ToCharArray()) {
    $s = [string]$ch
    if ('+^%~(){}[]'.Contains($s)) {
      $out += '{' + $s + '}'
    } else {
      $out += $s
    }
  }
  return $out
}

function TypeIntoElement($element) {
  try { $element.SetFocus() } catch {}
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    $nextValue = $Text
    if ($Append) {
      try { $nextValue = ([string]$pattern.Current.Value) + $Text } catch {}
    }
    $pattern.SetValue($nextValue)
    return 'ValuePattern'
  }

  if (-not $Append) {
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    Start-Sleep -Milliseconds 80
  }
  [System.Windows.Forms.SendKeys]::SendWait((EscapeSendKeysText $Text))
  return 'SendKeys'
}

$root = GetRootElement
Walk $root 0

if ($script:Matches.Count -eq 0) {
  $result = [ordered]@{
    status = 'not_found'
    action = $Action
    root = $RootMode
    matchedCount = 0
    visitedNodes = $script:Visited
    truncated = [bool]$script:Truncated
    query = [ordered]@{
      name = $TargetName
      nameContains = $TargetNameContains
      automationId = $TargetAutomationId
      controlType = $TargetControlType
      className = $TargetClassName
      processId = $TargetProcessId
      nativeWindowHandle = $TargetNativeWindowHandle
      index = $TargetIndex
    }
    note = 'No UI Automation element matched the target. Run desktop_ui_snapshot and refine target fields.'
  }
  $result | ConvertTo-Json -Depth 16 -Compress
  exit 0
}

if ($TargetIndex -ge $script:Matches.Count) {
  $TargetIndex = $script:Matches.Count - 1
}
$match = $script:Matches[$TargetIndex]
$target = $match.element
$before = ElementSummary $target $match.depth
$method = ''
$clickPoint = $null

if ($Action -eq 'focus') {
  try {
    $target.SetFocus()
    $method = 'SetFocus'
  } catch {
    $handle = [IntPtr]$target.Current.NativeWindowHandle
    if ($handle -ne [IntPtr]::Zero -and [LumiNativeMethods]::SetForegroundWindow($handle)) {
      $method = 'SetForegroundWindow'
    } else {
      throw
    }
  }
} elseif ($Action -eq 'click') {
  $clickPoint = ClickElement $target
  $method = 'mouse_click'
} elseif ($Action -eq 'invoke') {
  $method = InvokeElement $target
} elseif ($Action -eq 'type') {
  $method = TypeIntoElement $target
}

if ($DelayAfterMs -gt 0) {
  Start-Sleep -Milliseconds $DelayAfterMs
}

$after = $null
if ($Verify) {
  try { $after = ElementSummary $target $match.depth } catch {}
}

$result = [ordered]@{
  status = 'ok'
  action = $Action
  method = $method
  root = $RootMode
  matchedCount = $script:Matches.Count
  selectedIndex = $TargetIndex
  visitedNodes = $script:Visited
  truncated = [bool]$script:Truncated
  selectedBefore = $before
  selectedAfter = $after
  clickPoint = $clickPoint
  typedLength = if ($Action -eq 'type') { $Text.Length } else { 0 }
  note = 'UI Automation action completed. Verify task-level result before claiming work is done.'
}
$result | ConvertTo-Json -Depth 24 -Compress
`;
}

/** Build the same read-only page adapter used by desktop_open; exported for offline parser/interop checks. */
export function buildWindowsBrowserPageScript(options: DesktopUiSnapshotOptions): string {
  const page = options.browserPage;
  if (!page || !/^https?:\/\//i.test(page.targetUrl)) throw new Error("A browser page snapshot requires an HTTP(S) target URL");
  const processes = [...new Set(page.processNames.map(value => value.replace(/\.exe$/i, "").toLowerCase()).filter(value => /^[a-z0-9_-]+$/.test(value)))];
  if (!processes.length) throw new Error("A browser page snapshot requires browser catalog processes");
  return "$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n"
    + "$TargetUrl = " + psLiteral(page.targetUrl) + "\n$ProcessNames = @(" + processes.map(psLiteral).join(",") + ")\n"
    + "$TargetProcessId = " + optionalNumber(options.processId) + "\n$TargetNativeWindowHandle = " + optionalNumber(options.nativeWindowHandle) + "\n"
    + String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# The managed UIA assembly does not expose the LegacyIAccessible Value or
# AriaProperties IDs. Read those documented COM properties on the same HWND and
# match the Document runtime ID before using managed TextPattern content.
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace LumiBrowserUia {
 [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IAutomation {
  void CompareElements(); void CompareRuntimeIds(); void GetRootElement();
  IElement ElementFromHandle(IntPtr hwnd);
  void ElementFromPoint(); void GetFocusedElement(); void GetRootElementBuildCache();
  void ElementFromHandleBuildCache(); void ElementFromPointBuildCache(); void GetFocusedElementBuildCache();
  void CreateTreeWalker(); void ControlViewWalker(); void ContentViewWalker(); void RawViewWalker();
  void RawViewCondition(); void ControlViewCondition(); void ContentViewCondition(); void CreateCacheRequest();
  void CreateTrueCondition(); void CreateFalseCondition();
  [return: MarshalAs(UnmanagedType.Interface)] object CreatePropertyCondition(int id, [MarshalAs(UnmanagedType.Struct)] object value);
 }
 [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IElement {
  void SetFocus();
  [return: MarshalAs(UnmanagedType.SafeArray, SafeArraySubType=VarEnum.VT_I4)] int[] GetRuntimeId();
  void FindFirst();
  IElements FindAll(int scope, [MarshalAs(UnmanagedType.Interface)] object condition);
  void FindFirstBuildCache(); void FindAllBuildCache(); void BuildUpdatedCache();
  [return: MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int propertyId);
 }
 [ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IElements { int Length { get; } IElement GetElement(int index); }
 public static class DocumentProperties {
  static void Release(object value) { if(value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
  public static Dictionary<string,string[]> Read(IntPtr hwnd) {
   object instance=null, condition=null; IElement root=null; IElements documents=null;
   var result=new Dictionary<string,string[]>();
   try {
    instance=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e")));
    var automation=(IAutomation)instance;
    root=automation.ElementFromHandle(hwnd);
    condition=automation.CreatePropertyCondition(30003, 50030); // Document control type
    documents=root.FindAll(4, condition); // Descendants of this actual native window only
    for(int i=0; i<Math.Min(documents.Length,64); i++) {
     IElement doc=null;
     try {
      doc=documents.GetElement(i);
      string url=doc.GetCurrentPropertyValue(30045) as string; // Value.Value
      if(String.IsNullOrWhiteSpace(url)) url=doc.GetCurrentPropertyValue(30093) as string; // LegacyIAccessible.Value
      string aria=doc.GetCurrentPropertyValue(30102) as string;
      result[String.Join(",", doc.GetRuntimeId())]=new[]{url ?? "", aria ?? ""};
     } catch {} finally { Release(doc); }
    }
   } finally { Release(documents); Release(condition); Release(root); Release(instance); }
   return result;
  }
 }
}
"@

function ReadBrowserDocument($window, $processName) {
  $current = $window.Current
  $hwnd = [int]$current.NativeWindowHandle
  if ($current.IsOffscreen -or $hwnd -le 0) { return $null }
  if ($TargetProcessId -gt 0 -and $current.ProcessId -ne $TargetProcessId) { return $null }
  if ($TargetNativeWindowHandle -gt 0 -and $hwnd -ne $TargetNativeWindowHandle) { return $null }
  $values = [LumiBrowserUia.DocumentProperties]::Read([IntPtr]$hwnd)
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
  $documents = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $fallback = $null
  $count = 0
  foreach ($document in $documents) {
    if (++$count -gt 64) { break }
    try {
      $dc = $document.Current
      if ($dc.IsOffscreen -or $dc.BoundingRectangle.IsEmpty -or $dc.BoundingRectangle.Width -le 0 -or $dc.BoundingRectangle.Height -le 0) { continue }
      # A nested iframe must not stand in for the top-level displayed page.
      $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($document)
      $nested = $false
      for ($depth=0; $null -ne $parent -and $depth -lt 32; $depth++) {
        if ($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { $nested=$true; break }
        if ($parent.Current.NativeWindowHandle -eq $hwnd) { break }
        $parent=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
      }
      if ($nested) { continue }
      $key = [string]::Join(',', $document.GetRuntimeId())
      if (-not $values.ContainsKey($key)) { continue }
      $url = $values[$key][0]
      $uri = $null
      if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http','https')) { continue }
      $loading = 'unknown'
      if ($values[$key][1] -match '(?:^|;)\s*busy\s*=\s*true\s*(?:;|$)') { $loading='loading' }
      elseif ($values[$key][1] -match '(?:^|;)\s*busy\s*=\s*false\s*(?:;|$)') { $loading='not_loading' }
      $observation = [ordered]@{
        source='windows-uia'; observedAt=[DateTime]::UtcNow.ToString('o')
        url=$uri.AbsoluteUri; title=[string]$dc.Name; documentPresent=$true
        textSample=''; loadingState=$loading
        processId=[int]$current.ProcessId; nativeWindowHandle=$hwnd
        processName=$processName; windowTitle=[string]$current.Name
      }
      if ($uri.AbsoluteUri -ceq ([Uri]$TargetUrl).AbsoluteUri) {
        $textPattern=$null
        if ($document.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
          $observation.textSample=[string]$textPattern.DocumentRange.GetText(4096)
        }
        return $observation
      }
      if ($null -eq $fallback) { $fallback=$observation }
    } catch {}
  }
  return $fallback
}

$observation=$null
$fallback=$null
$errors=@()
$windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$count=0
foreach ($window in $windows) {
  if (++$count -gt 128) { break }
  try {
    $current=$window.Current
    $process=[System.Diagnostics.Process]::GetProcessById($current.ProcessId)
    $processName=$process.ProcessName
    if ($ProcessNames -notcontains $processName) { continue }
    $candidate=ReadBrowserDocument $window $processName
    if ($null -eq $candidate) { continue }
    if ($candidate.url -ceq ([Uri]$TargetUrl).AbsoluteUri) { $observation=$candidate; break }
    if ($null -eq $fallback) { $fallback=$candidate }
  } catch { $errors += $_.Exception.Message }
}
if ($null -eq $observation) { $observation=$fallback }
[ordered]@{
  status=if ($null -eq $observation) {'empty'} else {'ok'}
  platform='win32'; pageObservation=$observation; errors=$errors
  note='Read-only observation of a displayed Document in the selected native browser. document_observed does not certify that every network resource finished loading.'
} | ConvertTo-Json -Depth 12 -Compress
`;
}
