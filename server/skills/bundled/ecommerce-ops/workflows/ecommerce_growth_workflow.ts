import { Socket } from "socket.io";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { readDB } from "../../../../../db_layer";
import { ToolExecutionRecord } from "../../../../tools/types";

type VoiceScope = {
  domain: 'personal' | 'work';
  orgId: string;
};

type DesktopRelay = (toolName: string, args: Record<string, any>) => Promise<string>;
type Speak = (text: string) => void | number | Promise<void | number>;

interface EcommerceGrowthWorkflowOptions {
  socket: Socket;
  userText: string;
  userId: string;
  desktopRelay: DesktopRelay;
  speak: Speak;
  voiceScope: VoiceScope;
  isCancelled?: () => boolean;
}

interface WorkflowAction {
  tool?: string;
  clientAction?: Record<string, any>;
  args?: Record<string, any>;
  optional?: boolean;
  delayMs?: number;
  afterMs?: number;
}

interface WorkflowStep {
  text: string;
  actions?: WorkflowAction[];
  postActions?: WorkflowAction[];
  timing?: 'before' | 'during' | 'after';
  actionLeadMs?: number;
  pauseMs?: number;
}

type ActiveWindowInfo = {
  title: string;
  process_name: string;
  pid?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

type ScreenMetrics = {
  width: number;
  height: number;
  x: number;
  y: number;
};

type ScreenPoint = {
  x: number;
  y: number;
  screenWidth?: number;
  screenHeight?: number;
  screenX?: number;
  screenY?: number;
};

type NativeFileEntry = {
  name: string;
  path: string;
  type?: string;
  isDirectory?: boolean;
  is_directory?: boolean;
};

type EcommerceGrowthBrief = {
  sourceText: string;
  brandName: string;
  productName: string;
  platform: string;
  audience: string;
  target: string;
  budgetLabel: string;
  confirmationBoundary: string[];
  contentAngles: string[];
  deliverables: string[];
};

type EcommerceGrowthVerification = {
  passed: boolean;
  checkedAt: string;
  checks: Array<{ label: string; passed: boolean; detail: string }>;
};

type EcommerceGrowthFiles = {
  brief: EcommerceGrowthBrief;
  folder: string;
  fullDemoHtml: string;
  warRoomHtml: string;
  storeAuditHtml: string;
  contentMatrixCsv: string;
  contentMatrixHtml: string;
  videoScriptRtf: string;
  videoScriptHtml: string;
  imageNotesRtf: string;
  imageNotesHtml: string;
  imagePromptsTxt: string;
  videoPromptsTxt: string;
  publishPageHtml: string;
  customerServiceRtf: string;
  customerServiceHtml: string;
  battleReportHtml: string;
  toolConsoleHtml: string;
  taskJson: string;
  verification: string;
  verificationResult: EcommerceGrowthVerification;
};

type EcommerceGrowthFilePaths = Omit<EcommerceGrowthFiles, 'brief' | 'verification' | 'verificationResult'>;

const ECOMMERCE_GROWTH_PATTERNS = [
  /(?:接管|运营|管理|拍|做|开始|执行|演示).{0,24}(?:电商|店铺|网店|抖店|淘宝|天猫|京东|拼多多|小红书|抖音|视频号|账号|商品)/i,
  /(?:电商|店铺|网店|抖店|淘宝|天猫|京东|拼多多|小红书|抖音|视频号).{0,22}(?:接管|运营|管理|增长|发布|内容|短视频|图文|投流|账号|商品|客服|订单)/i,
  /(?:短视频|图文|视频生成|图片生成|内容制作|种草笔记).{0,22}(?:电商|店铺|商品|账号|发布|运营|增长|带货)/i,
  /(?:店铺账号管理|账号管理|店铺运营|电商运营|内容增长|爆品打造|商品发布|自动发布|自动运营)/i,
  /(?:ecommerce|e-commerce|shop|store|merchant|seller|short\s*video|content\s*production).{0,28}(?:take\s*over|operate|growth|publish|manage|demo)/i,
];

const EXTERNAL_TOOL_URLS = {
  jimeng: 'https://jimeng.jianying.com/',
  kling: 'https://klingai.com/',
  capcut: 'https://www.capcut.cn/',
  canva: 'https://www.canva.cn/',
  xiaohongshuCreator: 'https://creator.xiaohongshu.com/',
  douyinCreator: 'https://creator.douyin.com/',
  doudian: 'https://fxg.jinritemai.com/',
};

function normalizeIntentText(text: string): string {
  return String(text || '').replace(/\s+/g, '');
}

export function isEcommerceGrowthRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  return ECOMMERCE_GROWTH_PATTERNS.some(pattern => pattern.test(normalized));
}

function getUserAddress(userId: string): string {
  try {
    const db = readDB();
    const user = (db.users || []).find((u: any) => u.uid === userId);
    const raw = String(user?.displayName || user?.username || '').trim();
    if (!raw) return '';
    if (/^(admin|anonymous|user|guest)$/i.test(raw)) return '';
    return raw;
  } catch {
    return '';
  }
}

function normalizeBriefText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function pickFirstMatch(text: string, patterns: RegExp[], fallback: string): string {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value.replace(/[，。；;,.]$/g, '').slice(0, 32);
  }
  return fallback;
}

function parseBudgetLabel(text: string): string {
  const match = text.match(/(?:预算|投流|广告费|测试预算|日预算)\D{0,4}(\d+(?:\.\d+)?)\s*(万|千|元|块)?/);
  if (!match) return '先用 200 元测试投流，跑出素材胜率后再放量';
  const amount = match[1];
  const unit = match[2] || '元';
  return `${amount}${unit} 测试预算，先验证内容和转化再扩大投放`;
}

function parsePlatform(text: string): string {
  const platforms: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/抖店|抖音小店|巨量|抖音/, '抖音/抖店'],
    [/小红书|种草/, '小红书'],
    [/淘宝|天猫/, '淘宝/天猫'],
    [/京东/, '京东'],
    [/拼多多|多多/, '拼多多'],
    [/视频号|微信小店|微信/, '视频号/微信'],
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(text) && !platforms.includes(label)) platforms.push(label);
  }
  return platforms.length ? platforms.join(' + ') : '抖音/小红书/店铺后台';
}

function parseAudience(text: string, productName: string): string {
  const explicit = pickFirstMatch(text, [
    /(?:人群|受众|客户|用户|买家)\s*[:：]?\s*([^，。；;,.]{2,32})/,
    /面向\s*([^，。；;,.]{2,32})/,
  ], '');
  if (explicit) return explicit;
  if (/母婴|宝宝|儿童|孩子/.test(text + productName)) return '年轻家庭和精细化育儿人群';
  if (/家居|装修|收纳|家具|灯|床|沙发/.test(text + productName)) return '正在改善居住体验的城市家庭';
  if (/美妆|护肤|口红|面膜/.test(text + productName)) return '重视效果证明和真实测评的女性用户';
  if (/数码|手机|耳机|电脑|相机/.test(text + productName)) return '对参数、体验和性价比敏感的数码用户';
  return '有明确需求、正在比较同类商品的潜在买家';
}

function parseTarget(text: string): string {
  if (/清库存|库存/.test(text)) return '清库存并保护毛利';
  if (/新品|冷启动|上新/.test(text)) return '新品冷启动，先拿到可复用内容模型';
  if (/直播|达人/.test(text)) return '为直播和达人合作准备内容资产';
  if (/转化|成交|订单|销量/.test(text)) return '提升转化和订单结果';
  if (/账号|矩阵|粉丝/.test(text)) return '搭建店铺账号内容矩阵';
  return '用内容制作和店铺动作拉动真实成交';
}

function buildContentAngles(productName: string, target: string): string[] {
  return [
    `痛点对比：为什么用户现在需要 ${productName}`,
    `场景种草：把 ${productName} 放进真实工作/生活场景`,
    '真实测评：三句话讲清卖点、证据和适用人群',
    '差评反转：提前回答用户犹豫点',
    `成交引导：围绕「${target}」设计评论区和私信承接`,
    '复购/搭配：给客服和店铺后台准备后续动作',
  ];
}

function parseEcommerceGrowthBrief(userText: string): EcommerceGrowthBrief {
  const sourceText = normalizeBriefText(userText);
  const brandName = pickFirstMatch(sourceText, [
    /(?:品牌|店铺|账号)\s*[:：]?\s*([^，。；;,.]{2,24})/,
    /(?:接管|运营|管理)\s*([^，。；;,.]{2,24})(?:店|账号|店铺)/,
  ], 'Lumi 示例店铺');
  const productName = pickFirstMatch(sourceText, [
    /(?:围绕|关于)\s*([^，。；;,.、]{2,24}?)(?:做|生成|制作|发布|运营)/,
    /(?:商品|产品|主推品|主推商品|卖|推广)\s*[:：]?\s*([^，。；;,.]{2,28})/,
  ], '高复购主推商品');
  const platform = parsePlatform(sourceText);
  const audience = parseAudience(sourceText, productName);
  const target = parseTarget(sourceText);
  const budgetLabel = parseBudgetLabel(sourceText);
  const deliverables = [
    '店铺体检报告',
    '短视频内容矩阵',
    '图文种草笔记包',
    '图片生成提示词',
    '视频生成提示词',
    '发布页草稿',
    '客服接管话术',
    '今日运营战报',
  ];
  return {
    sourceText,
    brandName,
    productName,
    platform,
    audience,
    target,
    budgetLabel,
    contentAngles: buildContentAngles(productName, target),
    deliverables,
    confirmationBoundary: [
      '不自动真实发布内容',
      '不自动真实扣费投流',
      '不自动修改价格和库存',
      '不自动发送客户消息',
    ],
  };
}

function speechPauseMs(text: string, explicit?: number): number {
  if (explicit) return explicit;
  return Math.min(8200, Math.max(2600, text.length * 118));
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseActiveWindow(raw: string): ActiveWindowInfo | null {
  try {
    const parsed = JSON.parse(raw);
    return {
      title: String(parsed?.title || ''),
      process_name: String(parsed?.process_name || parsed?.processName || ''),
      pid: typeof parsed?.pid === 'number' ? parsed.pid : undefined,
      x: typeof parsed?.x === 'number' ? parsed.x : undefined,
      y: typeof parsed?.y === 'number' ? parsed.y : undefined,
      width: typeof parsed?.width === 'number' ? parsed.width : undefined,
      height: typeof parsed?.height === 'number' ? parsed.height : undefined,
    };
  } catch {
    return null;
  }
}

function activeWindowMatches(info: ActiveWindowInfo | null, patterns: RegExp[]): boolean {
  if (!info) return false;
  const haystack = `${info.title} ${info.process_name}`;
  return patterns.some(pattern => pattern.test(haystack));
}

function parseNativeFiles(raw: string): NativeFileEntry[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isNativeDirectory(entry: NativeFileEntry): boolean {
  return entry.type === 'directory' || entry.isDirectory === true || entry.is_directory === true;
}

function powershellCommand(script: string): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildAppActivateCommand(title: string): string {
  const script = `
$title = ${psString(title)}
Add-Type -AssemblyName Microsoft.VisualBasic
$ok = [Microsoft.VisualBasic.Interaction]::AppActivate($title)
Write-Output "APP_ACTIVATE:$ok"
`.trim();
  return powershellCommand(script);
}

function buildActivateProcessCommand(processNames: string[]): string {
  const names = processNames.map(psString).join(', ');
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$names = @(${names})
Add-Type -AssemblyName Microsoft.VisualBasic
foreach ($name in $names) {
  $process = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.ProcessName -match "^$name$"
  } | Sort-Object StartTime -Descending | Select-Object -First 1
  if ($process) {
    $ok = [Microsoft.VisualBasic.Interaction]::AppActivate([int]$process.Id)
    Write-Output "APP_ACTIVATE_PROCESS:$($process.ProcessName):$ok"
    exit 0
  }
}
Write-Output "APP_ACTIVATE_PROCESS:none"
exit 0
`.trim();
  return powershellCommand(script);
}

function buildOpenBrowserWindowCommand(target: string): string {
  const url = psString(target);
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$target = ${url}
$candidates = @(
  "\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe",
  "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe",
  "$env:LOCALAPPDATA\\Microsoft\\Edge\\Application\\msedge.exe",
  "msedge.exe",
  "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
  "\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe",
  "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe",
  "chrome.exe",
  "quark.exe"
)
foreach ($candidate in $candidates) {
  try {
    Start-Process -FilePath $candidate -ArgumentList @("--new-window", $target)
    Start-Sleep -Milliseconds 900
    Add-Type -AssemblyName Microsoft.VisualBasic
    foreach ($name in @("msedge", "chrome", "quark")) {
      $process = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match "^$name$" } | Sort-Object StartTime -Descending | Select-Object -First 1
      if ($process) {
        $ok = [Microsoft.VisualBasic.Interaction]::AppActivate([int]$process.Id)
        Write-Output "OPENED_BROWSER:$($process.ProcessName):$ok"
        exit 0
      }
    }
    Write-Output "OPENED_BROWSER:$candidate"
    exit 0
  } catch {}
}
Start-Process -FilePath $target
Write-Output "OPENED_DEFAULT_BROWSER"
exit 0
`.trim();
  return powershellCommand(script);
}

function buildOpenWpsFileCommand(shortcutPath: string, filePath: string, app: 'writer' | 'spreadsheet'): string {
  const shortcut = shortcutPath ? psString(shortcutPath) : '$null';
  const targetFile = psString(filePath);
  const exeName = app === 'spreadsheet' ? 'et.exe' : 'wps.exe';
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$shortcut = ${shortcut}
$targetFile = ${targetFile}
$exeName = ${psString(exeName)}
$roots = @()
if ($shortcut -and (Test-Path -LiteralPath $shortcut)) {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcut)
  $linkTarget = $link.TargetPath
  if ($linkTarget) {
    $targetDir = Split-Path -Parent $linkTarget
    if ($targetDir) { $roots += $targetDir }
    $parent = Split-Path -Parent $targetDir
    if ($parent) { $roots += $parent }
  }
}
$roots += @(
  'D:\\WPS Office',
  'C:\\Program Files\\WPS Office',
  'C:\\Program Files (x86)\\WPS Office'
)
$candidate = $null
foreach ($root in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
  if (Test-Path -LiteralPath $root) {
    $candidate = Get-ChildItem -LiteralPath $root -Recurse -Filter $exeName -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($candidate) { break }
  }
}
if ($candidate) {
  Start-Process -FilePath $candidate.FullName -ArgumentList @($targetFile) -WorkingDirectory $candidate.DirectoryName
  Write-Output "WPS_FILE:$($candidate.FullName):$targetFile"
  exit 0
}
if ($targetFile -and (Test-Path -LiteralPath $targetFile)) {
  Start-Process -LiteralPath $targetFile
  Write-Output "WPS_FILE_DEFAULT:$targetFile"
  exit 0
}
if ($shortcut -and (Test-Path -LiteralPath $shortcut)) {
  Start-Process -LiteralPath $shortcut
  Write-Output "WPS_SHORTCUT:$shortcut"
  exit 0
}
Write-Output 'WPS_FILE_NOT_FOUND'
exit 2
`.trim();
  return powershellCommand(script);
}

function buildOpenShortcutAppCommand(
  shortcutPath: string,
  processNames: string[],
  fallbackTargets: string[] = [],
): string {
  const shortcut = shortcutPath ? psString(shortcutPath) : '$null';
  const names = processNames.map(psString).join(', ');
  const fallbacks = fallbackTargets.map(psString).join(', ');
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$shortcut = ${shortcut}
$processNames = @(${names})
$fallbackTargets = @(${fallbacks})
Add-Type -AssemblyName Microsoft.VisualBasic
function Focus-TargetProcess {
  foreach ($name in $processNames) {
    $process = Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match $name -or $_.MainWindowTitle -match $name)
    } | Sort-Object StartTime -Descending | Select-Object -First 1
    if ($process) {
      $ok = [Microsoft.VisualBasic.Interaction]::AppActivate([int]$process.Id)
      Write-Output "APP_FOCUSED:$($process.ProcessName):$ok"
      return $true
    }
  }
  return $false
}
if (Focus-TargetProcess) { exit 0 }
if ($shortcut -and (Test-Path -LiteralPath $shortcut)) {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcut)
  if ($link.TargetPath) {
    if ($link.WorkingDirectory) {
      Start-Process -FilePath $link.TargetPath -ArgumentList $link.Arguments -WorkingDirectory $link.WorkingDirectory
    } else {
      Start-Process -FilePath $link.TargetPath -ArgumentList $link.Arguments
    }
  } else {
    Start-Process -LiteralPath $shortcut
  }
  Start-Sleep -Seconds 4
  if (Focus-TargetProcess) { exit 0 }
}
foreach ($target in $fallbackTargets) {
  try {
    Start-Process -FilePath $target
    Start-Sleep -Seconds 4
    if (Focus-TargetProcess) { exit 0 }
  } catch {}
}
Write-Output 'APP_OPEN_ATTEMPTED'
exit 0
`.trim();
  return powershellCommand(script);
}

function buildOpenWeChatCommand(personalShortcutPath: string, enterpriseShortcutPath = ''): string {
  const personalShortcut = personalShortcutPath ? psString(personalShortcutPath) : '$null';
  const enterpriseShortcut = enterpriseShortcutPath ? psString(enterpriseShortcutPath) : '$null';
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class LumiWinFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$personalShortcut = ${personalShortcut}
$enterpriseShortcut = ${enterpriseShortcut}

function Focus-ProcessWindow($process, $label) {
  if (-not $process) { return $false }
  try {
    if ($process.MainWindowHandle -and $process.MainWindowHandle -ne 0) {
      [LumiWinFocus]::ShowWindowAsync($process.MainWindowHandle, 9) | Out-Null
      Start-Sleep -Milliseconds 250
      [LumiWinFocus]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
      Start-Sleep -Milliseconds 250
      try { [Microsoft.VisualBasic.Interaction]::AppActivate($process.Id) | Out-Null } catch {}
      Write-Output "WECHAT_FOCUSED_WINDOW:$label"
      return $true
    }
  } catch {}
  return $false
}

function Focus-PersonalWeChat {
  $processes = Get-Process | Where-Object { $_.ProcessName -match '^(Weixin|WeChat)$' } | Sort-Object @{ Expression = { if ($_.MainWindowTitle -match '微信|WeChat|Weixin') { 0 } else { 1 } } }, Id
  foreach ($process in $processes) {
    if (Focus-ProcessWindow $process $process.ProcessName) { return $true }
  }
  return $false
}

if (Focus-PersonalWeChat) { exit 0 }

$personalTitles = @('微信', 'Weixin', 'WeChat')
foreach ($title in $personalTitles) {
  try {
    if ([Microsoft.VisualBasic.Interaction]::AppActivate($title)) {
      Write-Output "WECHAT_FOCUSED_EXISTING:$title"
      exit 0
    }
  } catch {}
}

$personalProcess = Get-Process | Where-Object { $_.ProcessName -match '^(Weixin|WeChat)$' } | Select-Object -First 1
if ($personalProcess) {
  try {
    if ([Microsoft.VisualBasic.Interaction]::AppActivate($personalProcess.Id)) {
      Write-Output "WECHAT_FOCUSED_PROCESS:$($personalProcess.ProcessName)"
      exit 0
    }
  } catch {}
}

if ($personalShortcut -and (Test-Path -LiteralPath $personalShortcut)) {
  try {
    Start-Process -FilePath $personalShortcut
    Start-Sleep -Seconds 2
    if (Focus-PersonalWeChat) {
      Write-Output "WECHAT_OPENED_PERSONAL_SHORTCUT"
      exit 0
    }
    foreach ($title in $personalTitles) {
      if ([Microsoft.VisualBasic.Interaction]::AppActivate($title)) {
        Write-Output "WECHAT_OPENED_PERSONAL_SHORTCUT"
        exit 0
      }
    }
  } catch {}
}

$personalCandidates = @(
  "D:\\Weixin\\Weixin.exe",
  "$env:ProgramFiles\\Tencent\\Weixin\\Weixin.exe",
  "$env:ProgramFiles(x86)\\Tencent\\Weixin\\Weixin.exe",
  "$env:LOCALAPPDATA\\Tencent\\Weixin\\Weixin.exe",
  "$env:ProgramFiles\\Tencent\\WeChat\\WeChat.exe",
  "$env:ProgramFiles(x86)\\Tencent\\WeChat\\WeChat.exe",
  "$env:LOCALAPPDATA\\Tencent\\WeChat\\WeChat.exe",
  "Weixin.exe",
  "WeChat.exe"
)
foreach ($candidate in $personalCandidates) {
  try {
    if ((Test-Path -LiteralPath $candidate) -or $candidate -match '^(Weixin|WeChat)\\.exe$') {
      Start-Process -FilePath $candidate
      Start-Sleep -Seconds 2
      if (Focus-PersonalWeChat) {
        Write-Output "WECHAT_OPENED_PERSONAL_EXE"
        exit 0
      }
      foreach ($title in $personalTitles) {
        if ([Microsoft.VisualBasic.Interaction]::AppActivate($title)) {
          Write-Output "WECHAT_OPENED_PERSONAL_EXE"
          exit 0
        }
      }
    }
  } catch {}
}

if ($enterpriseShortcut -and (Test-Path -LiteralPath $enterpriseShortcut)) {
  try {
    Start-Process -FilePath $enterpriseShortcut
    Start-Sleep -Seconds 2
    if ([Microsoft.VisualBasic.Interaction]::AppActivate('企业微信')) {
      Write-Output "WECHAT_OPENED_ENTERPRISE_FALLBACK"
      exit 0
    }
  } catch {}
}

Write-Output "WECHAT_FOCUS_ATTEMPTED"
exit 0
`.trim();
  return powershellCommand(script);
}

function rtfUnicodeEscape(text: string): string {
  let escaped = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === '\\') escaped += '\\\\';
    else if (char === '{') escaped += '\\{';
    else if (char === '}') escaped += '\\}';
    else if (char === '\n') escaped += '\\par\n';
    else if (code <= 0x7f) escaped += char;
    else escaped += `\\u${code > 32767 ? code - 65536 : code}?`;
  }
  return escaped;
}

function buildRtf(title: string, body: string): string {
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Microsoft YaHei;}}\n\\viewkind4\\uc1\\pard\\f0\\fs34\\b ${rtfUnicodeEscape(title)}\\b0\\par\n\\fs22 ${rtfUnicodeEscape(body)}\\par\n}`;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlList(items: string[]): string {
  return items.map(item => `<li>${escapeHtml(item)}</li>`).join('\n');
}

function buildBaseHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: "Microsoft YaHei", "Inter", Arial, sans-serif; background: #080b12; color: #f8fafc; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 20% 0%, rgba(20, 184, 166, .16), transparent 28%), linear-gradient(135deg, #080b12 0%, #101827 46%, #121018 100%); }
    main { width: min(1180px, calc(100vw - 48px)); margin: 0 auto; padding: 34px 0 48px; }
    .hero { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(280px, .85fr); gap: 18px; align-items: stretch; }
    .panel { border: 1px solid rgba(255,255,255,.11); background: rgba(8, 12, 20, .78); box-shadow: 0 24px 80px rgba(0,0,0,.32); border-radius: 18px; overflow: hidden; }
    .pad { padding: 22px; }
    .eyebrow { color: #5eead4; font-size: 11px; font-weight: 900; letter-spacing: .22em; text-transform: uppercase; }
    h1 { margin: 10px 0 8px; font-size: clamp(34px, 5vw, 64px); line-height: .95; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 22px; letter-spacing: 0; }
    p { color: rgba(248,250,252,.72); line-height: 1.72; margin: 0; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
    .card { border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.045); border-radius: 12px; padding: 14px; min-height: 116px; }
    .metric { font-size: 28px; font-weight: 900; color: #fff; }
    .label { color: rgba(255,255,255,.5); font-size: 12px; margin-top: 5px; }
    .band { margin-top: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    ul { margin: 0; padding-left: 18px; color: rgba(248,250,252,.78); line-height: 1.8; }
    .pill { display: inline-flex; align-items: center; gap: 8px; border: 1px solid rgba(94,234,212,.24); color: #99f6e4; background: rgba(20,184,166,.1); border-radius: 999px; padding: 7px 10px; font-size: 12px; font-weight: 800; margin: 3px; }
    .timeline { display: grid; gap: 10px; }
    .step { display: grid; grid-template-columns: 34px 1fr auto; gap: 12px; align-items: center; padding: 12px; border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.04); border-radius: 12px; }
    .dot { width: 28px; height: 28px; border-radius: 10px; display: grid; place-items: center; background: #14b8a6; color: #04111a; font-weight: 900; }
    .status { color: #bbf7d0; font-size: 12px; font-weight: 900; }
    .tool-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .tool { padding: 14px; border: 1px solid rgba(255,255,255,.1); border-radius: 14px; background: rgba(15,23,42,.78); }
    .tool strong { display: block; margin-bottom: 6px; }
    .warn { border-color: rgba(251,191,36,.28); background: rgba(251,191,36,.08); color: #fde68a; }
    .textarea { width: 100%; min-height: 160px; resize: vertical; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; background: rgba(2,6,23,.72); color: #f8fafc; padding: 13px; font: 14px/1.65 "Microsoft YaHei", Arial, sans-serif; }
    @media (max-width: 900px) { main { width: min(100vw - 24px, 720px); padding-top: 18px; } .hero, .band { grid-template-columns: 1fr; } .grid, .tool-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 560px) { .grid, .tool-grid { grid-template-columns: 1fr; } h1 { font-size: 38px; } }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

function buildWarRoomHtml(brief: EcommerceGrowthBrief): string {
  const metrics = [
    ['6 条', '短视频/图文选题已排期'],
    ['4 组', '外部图片生成提示词'],
    ['3 条', '发布草稿已准备'],
    ['0 次', '默认不真实发布/扣费'],
  ];
  const body = `
    <section class="hero">
      <div class="panel pad">
        <div class="eyebrow">ECOMMERCE GROWTH WAR ROOM</div>
        <h1>${escapeHtml(brief.brandName)}<br />增长作战室</h1>
        <p>任务目标：围绕「${escapeHtml(brief.productName)}」，在 ${escapeHtml(brief.platform)} 上完成店铺诊断、内容制作、外部工具调度、发布草稿和客服承接准备。Lumi 已进入可交付状态，真实发布和投流仍停在确认边界前。</p>
        <div style="margin-top:14px">
          ${brief.confirmationBoundary.map(item => `<span class="pill">${escapeHtml(item)}</span>`).join('')}
        </div>
      </div>
      <div class="panel pad">
        <h2>接管判断</h2>
        <div class="timeline">
          <div class="step"><div class="dot">1</div><div><strong>识别店铺任务</strong><p>${escapeHtml(brief.sourceText || '自然语言触发电商接管')}</p></div><span class="status">DONE</span></div>
          <div class="step"><div class="dot">2</div><div><strong>拆成可执行结果</strong><p>诊断、内容矩阵、图文/视频提示词、发布页、客服草稿。</p></div><span class="status">DONE</span></div>
          <div class="step"><div class="dot">3</div><div><strong>进入外部工具链</strong><p>浏览器、WPS/表格、剪映/即梦/可灵/Canva、店铺后台和微信。</p></div><span class="status">READY</span></div>
        </div>
      </div>
    </section>
    <section class="grid">
      ${metrics.map(([value, label]) => `<div class="card"><div class="metric">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`).join('')}
    </section>
    <section class="band">
      <div class="panel pad"><h2>目标人群</h2><p>${escapeHtml(brief.audience)}</p></div>
      <div class="panel pad"><h2>运营目标</h2><p>${escapeHtml(brief.target)}。${escapeHtml(brief.budgetLabel)}</p></div>
    </section>`;
  return buildBaseHtml(`${brief.brandName} 增长作战室`, body);
}

function buildStoreAuditHtml(brief: EcommerceGrowthBrief): string {
  const checks = [
    ['主图/封面', '需要补一张强对比结果图，一张使用场景图，一张卖点拆解图。'],
    ['标题卖点', `标题必须把「${brief.productName}」的核心利益点放到前 18 个字。`],
    ['详情/笔记', '缺少用户犹豫点回答：适合谁、不适合谁、和同类区别、售后承诺。'],
    ['客服承接', '需要把咨询、砍价、催发货、售后和差评修复做成固定话术。'],
    ['发布节奏', '建议 3 天 6 条内容，小额测试，胜率高的选题再复制。'],
  ];
  const body = `
    <section class="panel pad">
      <div class="eyebrow">STORE DIAGNOSIS</div>
      <h1>店铺体检报告</h1>
      <p>${escapeHtml(brief.platform)} / ${escapeHtml(brief.productName)} / ${escapeHtml(brief.target)}</p>
    </section>
    <section class="band">
      <div class="panel pad"><h2>我看到的问题</h2><ul>${htmlList(checks.map(([label, desc]) => `${label}：${desc}`))}</ul></div>
      <div class="panel pad"><h2>今天要拿到的结果</h2><ul>${htmlList([
        '完成 6 条短视频和图文选题矩阵',
        '生成图片和视频外部工具提示词',
        '准备发布标题、正文、标签和评论区钩子',
        '准备微信/客服回复草稿，不自动发送',
      ])}</ul></div>
    </section>`;
  return buildBaseHtml('店铺体检报告', body);
}

function buildFullDemoHtml(brief: EcommerceGrowthBrief, publishDraft: string): string {
  const scriptText = buildVideoScriptText(brief);
  const imagePrompts = buildImagePromptsText(brief);
  const videoPrompts = buildVideoPromptsText(brief);
  const serviceText = buildCustomerServiceText(brief);
  const sectionStyle = 'margin-top:16px';
  const body = `
    <section class="panel pad">
      <div class="eyebrow">LUMI ECOMMERCE TAKEOVER</div>
      <h1>${escapeHtml(brief.productName)}<br />电商增长全链路结果</h1>
      <p>店铺：${escapeHtml(brief.brandName)}　平台：${escapeHtml(brief.platform)}　目标：${escapeHtml(brief.target)}</p>
      <div style="margin-top:14px">
        ${brief.confirmationBoundary.map(item => `<span class="pill">${escapeHtml(item)}</span>`).join('')}
      </div>
    </section>
    <section class="grid">
      <div class="card"><div class="metric">店铺体检</div><div class="label">主图、标题、详情页、客服承接</div></div>
      <div class="card"><div class="metric">内容矩阵</div><div class="label">6 条短视频/图文/客服选题</div></div>
      <div class="card"><div class="metric">外部工具</div><div class="label">即梦、可灵、剪映、Canva、创作平台</div></div>
      <div class="card"><div class="metric">确认边界</div><div class="label">发布、投流、改价、发消息前停下</div></div>
    </section>
    <section class="band" style="${sectionStyle}">
      <div class="panel pad"><h2>店铺诊断结论</h2><ul>${htmlList([
        `主推品「${brief.productName}」需要把核心利益点前置到封面和标题`,
        '详情页要补“适合谁 / 不适合谁 / 和同类区别 / 售后承诺”',
        '客服话术要提前覆盖询价、催发货、售后和差评修复',
        '先用小额内容测试，胜率高的选题再复制放量',
      ])}</ul></div>
      <div class="panel pad"><h2>内容矩阵</h2><ul>${htmlList(brief.contentAngles)}</ul></div>
    </section>
    <section class="band" style="${sectionStyle}">
      <div class="panel pad"><h2>短视频脚本</h2><pre style="white-space:pre-wrap;word-break:break-word;margin:0;color:rgba(248,250,252,.78);font:14px/1.72 'Microsoft YaHei',Arial,sans-serif">${escapeHtml(scriptText)}</pre></div>
      <div class="panel pad"><h2>图像/视频工具提示词</h2><pre style="white-space:pre-wrap;word-break:break-word;margin:0;color:rgba(248,250,252,.78);font:14px/1.72 'Microsoft YaHei',Arial,sans-serif">${escapeHtml(`${imagePrompts}\n\n${videoPrompts}`)}</pre></div>
    </section>
    <section class="band" style="${sectionStyle}">
      <div class="panel pad"><h2>发布草稿</h2><pre style="white-space:pre-wrap;word-break:break-word;margin:0;color:rgba(248,250,252,.78);font:14px/1.72 'Microsoft YaHei',Arial,sans-serif">${escapeHtml(publishDraft)}</pre></div>
      <div class="panel pad"><h2>客服/微信草稿</h2><pre style="white-space:pre-wrap;word-break:break-word;margin:0;color:rgba(248,250,252,.78);font:14px/1.72 'Microsoft YaHei',Arial,sans-serif">${escapeHtml(serviceText)}</pre></div>
    </section>
    <section class="panel pad warn" style="${sectionStyle}">
      <h2>下一步确认</h2>
      <p>确认账号、库存、价格、活动和发布边界后，Lumi 再进入真实平台粘贴草稿、回收外部工具生成结果、写回任务中心。</p>
    </section>`;
  return buildBaseHtml(`${brief.productName} 电商增长全链路结果`, body);
}

function buildContentMatrixCsv(brief: EcommerceGrowthBrief): string {
  const rows = [
    ['序号', '内容类型', '平台', '选题', '开头钩子', '核心画面/素材', '转化动作', '状态'],
    ['1', '短视频', brief.platform, brief.contentAngles[0], '你是不是也遇到这个问题？', '痛点前后对比、商品近景、用户表情', '评论区引导「发型号/预算」', '可生成'],
    ['2', '短视频', brief.platform, brief.contentAngles[1], '真实场景里它到底有没有用？', '桌面/家庭/门店真实使用场景', '引导收藏并私信关键词', '可生成'],
    ['3', '图文', '小红书/店铺详情', brief.contentAngles[2], '三句话讲清楚值不值得买', '测评截图、卖点卡片、对比表', '正文放购买理由和适用人群', '可生成'],
    ['4', '短视频', '抖音/视频号', brief.contentAngles[3], '差评里说的问题，我先帮你拆开', '差评截图打码、实际解决过程', '降低犹豫，导向客服咨询', '可生成'],
    ['5', '直播/达人', '抖音/店铺后台', brief.contentAngles[4], '今晚只讲一个最容易买错的点', '达人口播、商品细节、限时利益点', '停在发布和投流确认前', '待确认'],
    ['6', '客服/复购', '微信/店铺客服', brief.contentAngles[5], '买完以后怎么用才不浪费？', '使用步骤、搭配商品、售后承诺', '转复购/搭配购', '可生成'],
  ];
  return `\ufeff${rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')}`;
}

function buildContentMatrixHtml(brief: EcommerceGrowthBrief): string {
  const rows = [
    ['短视频', brief.platform, brief.contentAngles[0], '痛点对比', '评论区承接'],
    ['短视频', brief.platform, brief.contentAngles[1], '真实场景', '私信关键词'],
    ['图文', '小红书/店铺详情', brief.contentAngles[2], '测评对比', '收藏和咨询'],
    ['短视频', '抖音/视频号', brief.contentAngles[3], '差评反转', '降低犹豫'],
    ['直播/达人', '抖音/店铺后台', brief.contentAngles[4], '直播预热', '待确认发布'],
    ['客服/复购', '微信/店铺客服', brief.contentAngles[5], '售后承接', '复购和搭配购'],
  ];
  const table = `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr>${['类型', '平台', '选题', '素材方向', '转化动作'].map(item => `<th style="border-bottom:1px solid rgba(255,255,255,.12);padding:12px;text-align:left;color:#99f6e4">${item}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${rows.map(row => `<tr>${row.map(cell => `<td style="border-bottom:1px solid rgba(255,255,255,.08);padding:12px;color:rgba(248,250,252,.78)">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>`;
  const body = `
    <section class="panel pad">
      <div class="eyebrow">CONTENT MATRIX</div>
      <h1>短视频内容矩阵</h1>
      <p>${escapeHtml(brief.productName)} / ${escapeHtml(brief.platform)} / ${escapeHtml(brief.target)}</p>
    </section>
    <section class="panel pad" style="margin-top:16px">${table}</section>`;
  return buildBaseHtml('短视频内容矩阵', body);
}

function buildReadableTextHtml(title: string, eyebrow: string, text: string): string {
  const body = `
    <section class="panel pad">
      <div class="eyebrow">${escapeHtml(eyebrow)}</div>
      <h1>${escapeHtml(title)}</h1>
      <p>这份结果已经写入本地交付包，可继续复制到外部工具、发布平台或客服窗口。</p>
    </section>
    <section class="panel pad" style="margin-top:16px">
      <pre style="white-space:pre-wrap;word-break:break-word;margin:0;color:rgba(248,250,252,.82);font:15px/1.8 'Microsoft YaHei',Arial,sans-serif">${escapeHtml(text)}</pre>
    </section>`;
  return buildBaseHtml(title, body);
}

function buildVideoScriptText(brief: EcommerceGrowthBrief): string {
  return [
    `${brief.productName} 60 秒短视频脚本`,
    '',
    '定位：结果导向、真实使用、降低用户犹豫。',
    `目标人群：${brief.audience}`,
    `运营目标：${brief.target}`,
    '',
    '镜头 1｜0-3 秒｜痛点钩子',
    `画面：用户正在遇到和 ${brief.productName} 相关的典型问题。字幕：别急着买，先看这三个点。`,
    '',
    '镜头 2｜3-12 秒｜场景代入',
    '画面：真实桌面/家庭/门店环境，展示使用前的混乱或低效。',
    '',
    '镜头 3｜12-28 秒｜核心卖点',
    `画面：${brief.productName} 细节特写，配三条卖点卡片：适合谁、解决什么、和同类区别。`,
    '',
    '镜头 4｜28-45 秒｜证据和反差',
    '画面：前后对比、测评结果、用户评价截图打码展示。',
    '',
    '镜头 5｜45-60 秒｜成交承接',
    '口播：想知道适不适合你，把你的使用场景发给我，我让客服帮你判断。',
    '',
    '发布备注：默认不自动发布，不自动投流。确认标题、价格、库存和活动边界后再执行。',
  ].join('\n');
}

function buildImageNotesText(brief: EcommerceGrowthBrief): string {
  return [
    `${brief.productName} 图文种草笔记包`,
    '',
    '笔记标题候选：',
    `1. 我终于知道 ${brief.productName} 为什么能提高转化了`,
    `2. 买 ${brief.productName} 前，先看这 4 个细节`,
    `3. ${brief.audience} 更适合这样选`,
    '',
    '正文结构：',
    '第一段：一句话讲痛点，让用户觉得“这就是我”。',
    '第二段：三条卖点，每条都必须配证据或场景。',
    '第三段：不适合人群和注意事项，降低售后风险。',
    '第四段：引导用户评论自己的场景，客服再承接。',
    '',
    '配图建议：',
    '封面图：结果对比 + 一句大字钩子。',
    '第二张：商品细节和关键卖点。',
    '第三张：适用/不适用人群表。',
    '第四张：使用步骤或搭配建议。',
  ].join('\n');
}

function buildImagePromptsText(brief: EcommerceGrowthBrief): string {
  return [
    '图片生成提示词（交给即梦/Canva/外部图文工具）',
    '',
    `1. 电商主图：${brief.productName}，高质感产品摄影，真实使用场景，干净背景，突出核心卖点，适合 ${brief.platform} 商品封面。`,
    `2. 对比海报：左侧展示用户痛点，右侧展示使用 ${brief.productName} 后的改善结果，中文卖点卡片，电商详情页风格。`,
    `3. 种草笔记封面：面向 ${brief.audience}，自然光场景，真实生活感，小红书图文封面构图，醒目标题区域留白。`,
    `4. 客服解释图：把 ${brief.productName} 的适合人群、不适合人群、售后承诺做成清晰信息图。`,
  ].join('\n');
}

function buildVideoPromptsText(brief: EcommerceGrowthBrief): string {
  return [
    '视频生成提示词（交给可灵/即梦/剪映/外部视频工具）',
    '',
    `生成一个 9:16 电商短视频，主题是 ${brief.productName}，目标用户是 ${brief.audience}。`,
    '风格：真实、干净、带一点工作流质感，不要过度广告片。',
    '镜头节奏：前 3 秒强钩子，中段三组卖点，结尾评论/私信承接。',
    `口播方向：围绕「${brief.target}」，讲清楚痛点、证据、适用人群和购买前注意事项。`,
    '字幕：大字短句，避免长段文字遮挡商品。',
    '结尾：不要直接下单催促，改成“把你的使用场景发我，我帮你判断”。',
  ].join('\n');
}

function buildPublishDraft(brief: EcommerceGrowthBrief): string {
  return [
    `标题：${brief.productName} 别急着买，先看这 3 个真实使用点`,
    '',
    `正文：今天我让 Lumi 先把 ${brief.brandName} 的主推品拆成内容和转化动作。`,
    `适合人群：${brief.audience}`,
    `核心目标：${brief.target}`,
    '',
    '我不会只发一条泛泛的广告，而是先用 6 条内容测试用户真实反馈：痛点、场景、测评、差评反转、直播预热和客服承接。',
    '',
    '如果你也在选同类商品，可以把你的使用场景发出来，我先帮你判断适不适合，再决定要不要买。',
    '',
    '#电商运营 #短视频带货 #图文种草 #店铺增长 #AI助理',
    '',
    '置顶评论：想看对比表或者适用人群清单，评论“清单”。',
  ].join('\n');
}

function buildPublishPageHtml(brief: EcommerceGrowthBrief, publishDraft: string): string {
  const body = `
    <section class="panel pad">
      <div class="eyebrow">PUBLISH DRAFT</div>
      <h1>发布准备页</h1>
      <p>这里模拟真实发布前的最后一步：标题、正文、标签和置顶评论都已准备，但发布按钮前必须确认价格、库存、活动和账号权限。</p>
    </section>
    <section class="band">
      <div class="panel pad"><h2>发布草稿</h2><textarea class="textarea">${escapeHtml(publishDraft)}</textarea></div>
      <div class="panel pad warn"><h2>确认边界</h2><ul>${htmlList(brief.confirmationBoundary)}</ul><p style="margin-top:12px">Lumi 可以继续打开外部平台和粘贴草稿，但默认不会替你真实发布或扣费。</p></div>
    </section>`;
  return buildBaseHtml('发布准备页', body);
}

function buildCustomerServiceText(brief: EcommerceGrowthBrief): string {
  return [
    `${brief.brandName} 客服/微信接管话术`,
    '',
    '售前咨询：',
    `你好，我先帮你判断一下适不适合。你主要想用 ${brief.productName} 解决什么问题？预算和使用场景方便说一下吗？`,
    '',
    '价格犹豫：',
    '我理解你想比较价格。这个版本更适合看长期使用和售后保障，如果你只需要临时替代方案，我也可以直接告诉你不一定要买贵的。',
    '',
    '催发货：',
    '我这边先帮你查发货节点。如果今天能出单号我会直接同步；如果库存或物流有延迟，我会把可选处理方案给你。',
    '',
    '售后/差评修复：',
    '先别着急，我把问题拆成使用方式、商品状态和物流三类来排查。能发一下照片或使用场景吗？我先给你一个明确处理方案。',
    '',
    'Lumi 边界：草稿可复制到电脑微信或店铺客服窗口，默认不自动发送。',
  ].join('\n');
}

function buildToolConsoleHtml(brief: EcommerceGrowthBrief): string {
  const tools = [
    ['即梦 AI', '生成主图、封面、场景图', EXTERNAL_TOOL_URLS.jimeng],
    ['可灵 AI', '生成商品短视频镜头', EXTERNAL_TOOL_URLS.kling],
    ['剪映/CapCut', '剪辑、字幕、节奏和发布素材', EXTERNAL_TOOL_URLS.capcut],
    ['Canva 可画', '图文封面、详情页卡片', EXTERNAL_TOOL_URLS.canva],
    ['抖店后台', '商品、订单、售后、库存', EXTERNAL_TOOL_URLS.doudian],
    ['小红书创作平台', '图文笔记发布和数据反馈', EXTERNAL_TOOL_URLS.xiaohongshuCreator],
  ];
  const body = `
    <section class="panel pad">
      <div class="eyebrow">EXTERNAL TOOL CHAIN</div>
      <h1>外部工具调度台</h1>
      <p>Lumi 不把这些能力都塞进自己的客户端，而是把任务拆好后交给外部强工具：图片、视频、剪辑、店铺后台、创作平台、微信客服。</p>
    </section>
    <section class="tool-grid" style="margin-top:16px">
      ${tools.map(([name, desc, url]) => `<a class="tool" href="${escapeHtml(url)}"><strong>${escapeHtml(name)}</strong><p>${escapeHtml(desc)}</p><span class="pill">${escapeHtml(url)}</span></a>`).join('')}
    </section>
    <section class="band">
      <div class="panel pad"><h2>当前商品</h2><p>${escapeHtml(brief.productName)} / ${escapeHtml(brief.platform)}</p></div>
      <div class="panel pad"><h2>下一步</h2><p>打开对应外部页面，把提示词、脚本、草稿粘贴进去，生成素材并回收结果。</p></div>
    </section>`;
  return buildBaseHtml('外部工具调度台', body);
}

function buildBattleReportHtml(brief: EcommerceGrowthBrief, files: Partial<EcommerceGrowthFiles>): string {
  const body = `
    <section class="panel pad">
      <div class="eyebrow">TODAY OPERATION REPORT</div>
      <h1>今日运营战报</h1>
      <p>这不是“我给你一些建议”，而是 Lumi 已经把电商接管任务推进到可检查的结果：文件、脚本、提示词、发布草稿、客服承接和确认边界。</p>
    </section>
    <section class="grid">
      <div class="card"><div class="metric">已完成</div><div class="label">店铺体检、内容矩阵、短视频脚本</div></div>
      <div class="card"><div class="metric">已准备</div><div class="label">图片/视频生成提示词、发布页</div></div>
      <div class="card"><div class="metric">已复制</div><div class="label">客服/微信回复草稿可粘贴</div></div>
      <div class="card"><div class="metric">待确认</div><div class="label">发布、投流、价格、库存、发送消息</div></div>
    </section>
    <section class="band">
      <div class="panel pad"><h2>交付文件</h2><ul>${htmlList([
        files.warRoomHtml || '',
        files.storeAuditHtml || '',
        files.contentMatrixHtml || files.contentMatrixCsv || '',
        files.videoScriptHtml || files.videoScriptRtf || '',
        files.publishPageHtml || '',
      ].filter(Boolean).map(item => path.basename(item)))}</ul></div>
      <div class="panel pad"><h2>接下来我会做什么</h2><ul>${htmlList([
        '等你确认账号、商品、价格和库存边界',
        '把草稿粘贴到对应发布/客服窗口',
        '回收外部工具生成的图片和视频结果',
        '把数据反馈写回任务中心，继续迭代下一轮内容',
      ])}</ul></div>
    </section>`;
  return buildBaseHtml('今日运营战报', body);
}

function buildVerificationText(result: EcommerceGrowthVerification, brief: EcommerceGrowthBrief): string {
  return [
    `${brief.brandName} 电商增长交付验证`,
    `检查时间：${result.checkedAt}`,
    `结果：${result.passed ? '通过' : '需要复核'}`,
    '',
    ...result.checks.map(check => `${check.passed ? '✓' : '×'} ${check.label}：${check.detail}`),
  ].join('\n');
}

function verifyEcommerceGrowthFiles(files: EcommerceGrowthFilePaths, brief: EcommerceGrowthBrief): EcommerceGrowthVerification {
  const hasText = (filePath: string, patterns: RegExp[]) => {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return patterns.every(pattern => pattern.test(content));
    } catch {
      return false;
    }
  };
  const existsWithSize = (filePath: string, minBytes = 80) => {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).size >= minBytes;
    } catch {
      return false;
    }
  };
  const checks = [
    {
      label: '交付包目录存在',
      passed: fs.existsSync(files.folder),
      detail: files.folder,
    },
    {
      label: '作战室包含商品和平台',
      passed: hasText(files.warRoomHtml, [new RegExp(escapeRegExp(brief.productName)), new RegExp(escapeRegExp(brief.platform.split('/')[0]))]),
      detail: path.basename(files.warRoomHtml),
    },
    {
      label: '内容矩阵已生成',
      passed: hasText(files.contentMatrixCsv, [/短视频/, /图文/, /客服/]) && hasText(files.contentMatrixHtml, [/短视频/, /图文/, /客服/]),
      detail: `${path.basename(files.contentMatrixCsv)} / ${path.basename(files.contentMatrixHtml)}`,
    },
    {
      label: '图片和视频提示词已生成',
      passed: hasText(files.imagePromptsTxt, [/图片生成提示词/]) && hasText(files.videoPromptsTxt, [/视频生成提示词/]),
      detail: `${path.basename(files.imagePromptsTxt)} / ${path.basename(files.videoPromptsTxt)}`,
    },
    {
      label: '发布页和客服草稿已准备',
      passed: hasText(files.publishPageHtml, [/发布准备页/, /确认边界/]) && existsWithSize(files.customerServiceRtf, 300) && hasText(files.customerServiceHtml, [/客服/, /默认不自动/]),
      detail: `${path.basename(files.publishPageHtml)} / ${path.basename(files.customerServiceHtml)}`,
    },
  ];
  return {
    passed: checks.every(check => check.passed),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

function getDesktopOutputDirectory(folderName: string): string {
  const candidates = [
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
    process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : '',
    'C:\\Users\\Public\\Desktop',
  ].filter(Boolean);
  const baseDir = candidates.find(candidate => fs.existsSync(candidate)) || path.join(os.tmpdir(), 'LumiOS-Demo');
  const folder = path.join(baseDir, folderName);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function writeUtf8(filePath: string, content: string): string {
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function writeRtf(filePath: string, title: string, body: string): string {
  fs.writeFileSync(filePath, buildRtf(title, body), 'utf8');
  return filePath;
}

export function createEcommerceGrowthFiles(
  input: string | EcommerceGrowthBrief,
  options: { outputDirectory?: string } = {},
): EcommerceGrowthFiles {
  const brief = typeof input === 'string' ? parseEcommerceGrowthBrief(input) : input;
  const folder = options.outputDirectory || getDesktopOutputDirectory('Lumi-电商增长交付包');
  fs.mkdirSync(folder, { recursive: true });

  const publishDraft = buildPublishDraft(brief);
  const filePaths: EcommerceGrowthFilePaths = {
    folder,
    fullDemoHtml: path.join(folder, '00-Lumi-电商增长全链路结果.html'),
    warRoomHtml: path.join(folder, '01-Lumi-电商增长作战室.html'),
    storeAuditHtml: path.join(folder, '02-Lumi-店铺体检报告.html'),
    contentMatrixCsv: path.join(folder, '03-Lumi-短视频内容矩阵.csv'),
    contentMatrixHtml: path.join(folder, '03-Lumi-短视频内容矩阵.html'),
    videoScriptRtf: path.join(folder, '04-Lumi-短视频脚本与分镜.rtf'),
    videoScriptHtml: path.join(folder, '04-Lumi-短视频脚本与分镜.html'),
    imageNotesRtf: path.join(folder, '05-Lumi-图文种草笔记包.rtf'),
    imageNotesHtml: path.join(folder, '05-Lumi-图文种草笔记包.html'),
    imagePromptsTxt: path.join(folder, '06-Lumi-图片生成提示词.txt'),
    videoPromptsTxt: path.join(folder, '07-Lumi-视频生成提示词.txt'),
    publishPageHtml: path.join(folder, '08-Lumi-发布准备页.html'),
    customerServiceRtf: path.join(folder, '09-Lumi-客服接管话术.rtf'),
    customerServiceHtml: path.join(folder, '09-Lumi-客服接管话术.html'),
    battleReportHtml: path.join(folder, '10-Lumi-今日运营战报.html'),
    toolConsoleHtml: path.join(folder, '11-Lumi-外部工具调度台.html'),
    taskJson: path.join(folder, '12-Lumi-电商任务参数.json'),
  };
  const partialFiles: Partial<EcommerceGrowthFiles> = { ...filePaths };

  writeUtf8(filePaths.fullDemoHtml, buildFullDemoHtml(brief, publishDraft));
  writeUtf8(filePaths.warRoomHtml, buildWarRoomHtml(brief));
  writeUtf8(filePaths.storeAuditHtml, buildStoreAuditHtml(brief));
  writeUtf8(filePaths.contentMatrixCsv, buildContentMatrixCsv(brief));
  writeUtf8(filePaths.contentMatrixHtml, buildContentMatrixHtml(brief));
  const videoScriptText = buildVideoScriptText(brief);
  const imageNotesText = buildImageNotesText(brief);
  const customerServiceText = buildCustomerServiceText(brief);
  writeRtf(filePaths.videoScriptRtf, `${brief.productName} 短视频脚本与分镜`, videoScriptText);
  writeUtf8(filePaths.videoScriptHtml, buildReadableTextHtml(`${brief.productName} 短视频脚本与分镜`, 'VIDEO SCRIPT', videoScriptText));
  writeRtf(filePaths.imageNotesRtf, `${brief.productName} 图文种草笔记包`, imageNotesText);
  writeUtf8(filePaths.imageNotesHtml, buildReadableTextHtml(`${brief.productName} 图文种草笔记包`, 'IMAGE NOTE PACKAGE', imageNotesText));
  writeUtf8(filePaths.imagePromptsTxt, buildImagePromptsText(brief));
  writeUtf8(filePaths.videoPromptsTxt, buildVideoPromptsText(brief));
  writeUtf8(filePaths.publishPageHtml, buildPublishPageHtml(brief, publishDraft));
  writeRtf(filePaths.customerServiceRtf, `${brief.brandName} 客服接管话术`, customerServiceText);
  writeUtf8(filePaths.customerServiceHtml, buildReadableTextHtml(`${brief.brandName} 客服接管话术`, 'SERVICE DRAFT', customerServiceText));
  writeUtf8(filePaths.toolConsoleHtml, buildToolConsoleHtml(brief));
  writeUtf8(filePaths.battleReportHtml, buildBattleReportHtml(brief, partialFiles));
  writeUtf8(filePaths.taskJson, JSON.stringify({ brief, files: filePaths, publishDraft }, null, 2));

  const verificationResult = verifyEcommerceGrowthFiles(filePaths, brief);
  const verification = path.join(folder, '13-Lumi-交付验证记录.txt');
  writeUtf8(verification, buildVerificationText(verificationResult, brief));

  return { brief, ...filePaths, verification, verificationResult };
}

export async function runEcommerceGrowthWorkflow({
  socket,
  userText,
  userId,
  desktopRelay,
  speak,
  voiceScope,
  isCancelled,
}: EcommerceGrowthWorkflowOptions): Promise<{ responseText: string; toolCalls: ToolExecutionRecord[] }> {
  void voiceScope;
  const address = getUserAddress(userId);
  const greeting = address ? `收到，${address}。` : '收到。';
  const spokenLines: string[] = [];
  const toolCalls: ToolExecutionRecord[] = [];

  const emitTool = (
    id: string,
    name: string,
    args: Record<string, any>,
    result?: string,
    error?: string,
  ) => {
    socket.emit('agent:tool_call', {
      correlationId: id,
      toolCallId: id,
      name,
      arguments: args,
      args,
      result,
      error,
      source: 'ecommerce_growth_workflow',
    });
  };

  const runTool = async (name: string, args: Record<string, any> = {}, optional = true) => {
    const id = `ecommerce-growth-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    emitTool(id, name, args);
    try {
      const output = await desktopRelay(name, args);
      const fullOutput = String(output || '');
      const result = fullOutput.slice(0, 700);
      emitTool(id, name, args, result);
      toolCalls.push({ id, name, arguments: args, result });
      return fullOutput;
    } catch (err: any) {
      const error = err?.message || String(err);
      console.warn(`[EcommerceGrowthWorkflow] ${name} failed: ${error}`);
      emitTool(id, name, args, undefined, error);
      toolCalls.push({ id, name, arguments: args, result: '', error });
      if (!optional) throw err;
      return '';
    }
  };

  const runClientAction = (args: Record<string, any>) => runTool('client_action', args, true);

  const runAction = async (action: WorkflowAction) => {
    if (isCancelled?.()) return;
    if (action.delayMs) await wait(action.delayMs);
    if (isCancelled?.()) return;
    if (action.clientAction) {
      await runClientAction(action.clientAction);
    } else if (action.tool) {
      await runTool(action.tool, action.args || {}, action.optional !== false);
    }
    if (action.afterMs) await wait(action.afterMs);
  };

  const runActions = async (actions: WorkflowAction[] = []) => {
    for (const action of actions) {
      if (isCancelled?.()) break;
      await runAction(action);
    }
  };

  const startSpeech = (text: string, pauseMs?: number): Promise<void> => {
    if (isCancelled?.()) return Promise.resolve();
    spokenLines.push(text);
    return Promise.resolve(speak(text)).then(async result => {
      if (typeof result === 'number') {
        if (result > 0) await wait(result);
        return;
      }
      await wait(speechPauseMs(text, pauseMs));
    });
  };

  const say = async (text: string, pauseMs?: number) => {
    await startSpeech(text, pauseMs);
  };

  const runStep = async (step: WorkflowStep) => {
    if (isCancelled?.()) return;
    const actions = step.actions || [];
    const postActions = step.postActions || [];
    const totalMs = speechPauseMs(step.text, step.pauseMs);
    const timing = step.timing || 'before';

    if (timing === 'before') {
      await runActions(actions);
      await startSpeech(step.text, step.pauseMs);
      await runActions(postActions);
      return;
    }

    if (timing === 'after') {
      await startSpeech(step.text, step.pauseMs);
      await runActions(actions);
      await runActions(postActions);
      return;
    }

    const speechDone = startSpeech(step.text, step.pauseMs);
    const startedAt = Date.now();
    const leadMs = Math.min(step.actionLeadMs ?? 920, Math.max(300, totalMs - 650));
    await wait(leadMs);
    await runActions(actions);
    await wait(Math.max(0, totalMs - (Date.now() - startedAt)));
    await speechDone;
    await runActions(postActions);
  };

  const getActiveWindow = async () => {
    const raw = await runTool('desktop_active_window', {}, true);
    return parseActiveWindow(raw);
  };

  const waitForActiveWindow = async (patterns: RegExp[], timeoutMs = 5000) => {
    const started = Date.now();
    while (!isCancelled?.() && Date.now() - started < timeoutMs) {
      const info = await getActiveWindow();
      if (activeWindowMatches(info, patterns)) return info;
      await wait(650);
    }
    return null;
  };

  const listNativeFiles = async (dirPath: string) => {
    const raw = await runTool('desktop_list_files', { path: dirPath, limit: 320 }, true);
    return parseNativeFiles(raw);
  };

  const getDesktopDirectories = async () => {
    const candidates = new Set<string>();
    const home = os.homedir();
    candidates.add(path.join(home, 'Desktop'));
    candidates.add(path.join(home, 'OneDrive', 'Desktop'));
    if (process.env.PUBLIC) candidates.add(path.join(process.env.PUBLIC, 'Desktop'));
    candidates.add('C:\\Users\\Public\\Desktop');

    const homeEntries = await listNativeFiles(home);
    for (const entry of homeEntries) {
      if (isNativeDirectory(entry) && /^(desktop|桌面)$/i.test(entry.name)) {
        candidates.add(entry.path);
      }
    }
    return [...candidates];
  };

  const findDesktopShortcut = async (patterns: RegExp[]) => {
    const dirs = await getDesktopDirectories();
    const matches: NativeFileEntry[] = [];
    for (const dir of dirs) {
      const files = await listNativeFiles(dir);
      for (const file of files) {
        if (isNativeDirectory(file)) continue;
        const name = file.name || path.basename(file.path || '');
        if (!/\.lnk$/i.test(name) && !/\.url$/i.test(name)) continue;
        if (patterns.some(pattern => pattern.test(name))) matches.push(file);
      }
    }
    matches.sort((a, b) => a.name.localeCompare(b.name));
    return matches[0]?.path || '';
  };

  let wallpaperModeActive = false;

  const enterWallpaperMode = async () => {
    await runTool('desktop_cursor_glow_show', { timeoutMs: 170000 }, true);
    await runTool('desktop_set_wallpaper_mode', {
      enabled: true,
      source: 'ecommerce_growth_workflow',
      timeoutMs: 170000,
    }, true);
    wallpaperModeActive = true;
    await wait(350);
  };

  const exitWallpaperMode = async () => {
    if (wallpaperModeActive) {
      await runTool('desktop_set_wallpaper_mode', {
        enabled: false,
        source: 'ecommerce_growth_workflow',
      }, true);
      wallpaperModeActive = false;
      await wait(250);
    }
    await runTool('desktop_cursor_glow_hide', {}, true);
  };

  let cachedScreenMetrics: ScreenMetrics | null = null;

  const getScreenMetrics = async (): Promise<ScreenMetrics> => {
    if (cachedScreenMetrics) return cachedScreenMetrics;
    try {
      const raw = await runTool('desktop_capture_screen', { quality: 30 }, true);
      const parsed = JSON.parse(raw);
      cachedScreenMetrics = {
        width: Number(parsed?.width) || 1920,
        height: Number(parsed?.height) || 1080,
        x: Number(parsed?.x) || 0,
        y: Number(parsed?.y) || 0,
      };
    } catch {
      cachedScreenMetrics = { width: 1920, height: 1080, x: 0, y: 0 };
    }
    return cachedScreenMetrics;
  };

  const cursorArgs = (point: ScreenPoint) => ({
    x: point.x,
    y: point.y,
    coordinateSpace: 'screen',
    screenWidth: point.screenWidth,
    screenHeight: point.screenHeight,
    screenX: point.screenX || 0,
    screenY: point.screenY || 0,
  });

  const pointCursor = async (point: ScreenPoint, click = false) => {
    await runTool('desktop_cursor_glow_update', cursorArgs(point), true);
    await wait(260);
    if (click) {
      await runTool('desktop_cursor_glow_click', cursorArgs(point), true);
      await runTool('desktop_mouse_click_at', { x: point.x, y: point.y, button: 'left' }, true);
      await wait(180);
    }
  };

  const pointActiveWindowRatio = async (
    patterns: RegExp[],
    xRatio: number,
    yRatio: number,
    click = false,
    fallback = { xRatio, yRatio },
  ) => {
    const info = await getActiveWindow();
    if (activeWindowMatches(info, patterns) && info?.width && info.height && info.width > 0 && info.height > 0) {
      const screen = await getScreenMetrics();
      const point: ScreenPoint = {
        x: Math.round((info.x || 0) + info.width * xRatio),
        y: Math.round((info.y || 0) + info.height * yRatio),
        screenWidth: screen.width,
        screenHeight: screen.height,
        screenX: screen.x,
        screenY: screen.y,
      };
      await pointCursor(point, click);
      return point;
    }
    const screen = await getScreenMetrics();
    const point: ScreenPoint = {
      x: Math.round(screen.x + screen.width * fallback.xRatio),
      y: Math.round(screen.y + screen.height * fallback.yRatio),
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenX: screen.x,
      screenY: screen.y,
    };
    await pointCursor(point, click);
    return point;
  };

  const closeActiveWindow = async (patterns?: RegExp[]) => {
    if (patterns) {
      const info = await getActiveWindow();
      if (!activeWindowMatches(info, patterns)) return;
    }
    await runTool('desktop_keyboard_press', { key: 'alt+f4' }, true);
    await wait(900);
  };

  socket.emit('agent:status', {
    status: 'thinking',
    agentName: 'Lumi',
    phase: 'ecommerce_growth_workflow',
    detail: 'Running ecommerce growth workflow',
  });

  const files = createEcommerceGrowthFiles(userText);
  const brief = files.brief;
  const publishDraft = buildPublishDraft(brief);
  const customerServiceDraft = buildCustomerServiceText(brief);
  const verificationText = files.verificationResult.passed ? '交付自检已经通过' : '交付自检里还有项目需要复核';
  const browserPatterns = [/chrome/i, /edge/i, /firefox/i, /browser/i, /msedge/i, /iexplore/i, /quark/i, /夸克/i];
  const officePatterns = [/wps/i, /winword/i, /word/i, /writer/i, /notepad/i, /excel/i, /et/i, /记事本/i];
  const explorerPatterns = [/explorer/i, /文件资源管理器/i];
  const wechatPatterns = [/wechat/i, /weixin/i, /微信/i, /wxwork/i];

  const activateBrowserWindow = async () => {
    await runTool('desktop_run_command', {
      command: buildActivateProcessCommand(['quark', 'chrome', 'msedge', 'firefox', 'iexplore']),
    }, true);
    await wait(450);
  };

  const closeBrowserTab = async () => {
    await activateBrowserWindow();
    const info = await getActiveWindow();
    if (!activeWindowMatches(info, browserPatterns)) return;
    await runTool('desktop_keyboard_press', { key: 'ctrl+w' }, true);
    await wait(700);
  };

  const openBrowserAction = (filePath: string, afterMs = 1800): WorkflowAction => ({
    tool: 'desktop_run_command',
    args: { command: buildOpenBrowserWindowCommand(pathToFileURL(filePath).href) },
    afterMs,
  });

  const openBrowserPage = async (filePath: string, afterMs = 1800) => {
    await runTool('desktop_run_command', {
      command: buildOpenBrowserWindowCommand(pathToFileURL(filePath).href),
    }, true);
    await wait(afterMs);
    await activateBrowserWindow();
  };

  try {
    const wpsShortcut = await findDesktopShortcut([/wps/i, /WPS Office/i, /金山/i]);
    const jianyingShortcut = await findDesktopShortcut([/剪映/i, /jianying/i, /capcut/i]);
    const realPlatformUrls = [
      EXTERNAL_TOOL_URLS.doudian,
      EXTERNAL_TOOL_URLS.douyinCreator,
      EXTERNAL_TOOL_URLS.xiaohongshuCreator,
    ];
    const jianyingPatterns = [/jianying/i, /capcut/i, /剪映/i];
    const spreadsheetPatterns = [/wps/i, /et/i, /excel/i, /spreadsheet/i, /表格/i];
    const writerPatterns = [/wps/i, /winword/i, /word/i, /writer/i, /notepad/i, /文档/i];

    const openExternalUrl = async (target: string, afterMs = 2200) => {
      await runTool('desktop_run_command', {
        command: buildOpenBrowserWindowCommand(target),
      }, true);
      await wait(afterMs);
      await activateBrowserWindow();
    };

    await runStep({
      text: `${greeting}我直接跑真实接管。先生成交付包，再打开你电脑里的软件和平台。`,
      actions: [
        { tool: 'desktop_show_lumi_window', afterMs: 250 },
        { clientAction: { action: 'ecommerce_growth_panel', stage: 'intake' } },
      ],
      pauseMs: 3600,
    });

    await enterWallpaperMode();

    await runTool('desktop_open', { target: files.folder }, true);
    await wait(1800);
    await pointActiveWindowRatio(explorerPatterns, 0.45, 0.46, true, { xRatio: 0.45, yRatio: 0.48 });
    await say(`结果包已经落到桌面。`, 1800);
    await closeActiveWindow(explorerPatterns);

    await runClientAction({ action: 'ecommerce_growth_panel', stage: 'content' });
    await runTool('desktop_run_command', {
      command: buildOpenWpsFileCommand(wpsShortcut, files.contentMatrixCsv, 'spreadsheet'),
    }, true);
    await wait(5200);
    let active = await waitForActiveWindow(spreadsheetPatterns, 5200);
    if (active) {
      await pointActiveWindowRatio(spreadsheetPatterns, 0.42, 0.48, true, { xRatio: 0.42, yRatio: 0.48 });
      await say(`内容矩阵已经进 WPS 表格。`, 2200);
      await closeActiveWindow(spreadsheetPatterns);
    } else {
      await say(`表格文件已生成，但 WPS 没抢到前台。`, 2200);
    }

    await runTool('desktop_run_command', {
      command: buildOpenWpsFileCommand(wpsShortcut, files.videoScriptRtf, 'writer'),
    }, true);
    await wait(4600);
    active = await waitForActiveWindow(writerPatterns, 5200);
    if (active) {
      await pointActiveWindowRatio(writerPatterns, 0.48, 0.52, true, { xRatio: 0.48, yRatio: 0.52 });
      await say(`短视频脚本和分镜也在真实文档里。`, 2400);
      await closeActiveWindow(writerPatterns);
    }

    await runClientAction({ action: 'ecommerce_growth_panel', stage: 'tools' });
    await runTool('desktop_clipboard_write', { text: buildVideoPromptsText(brief) }, true);
    await runTool('desktop_run_command', {
      command: buildOpenShortcutAppCommand(
        jianyingShortcut,
        ['Jianying', 'CapCut', '剪映'],
        [
          'C:\\Users\\Administrator\\AppData\\Local\\JianyingPro\\Apps\\JianyingPro.exe',
          'JianyingPro.exe',
          'CapCut.exe',
        ],
      ),
    }, true);
    await wait(6200);
    active = await waitForActiveWindow(jianyingPatterns, 8200);
    if (active) {
      await pointActiveWindowRatio(jianyingPatterns, 0.5, 0.56, true, { xRatio: 0.5, yRatio: 0.56 });
      await say(`剪映已打开，视频提示词在剪贴板。`, 2400);
      await closeActiveWindow(jianyingPatterns);
    } else {
      await say(`剪映没有聚焦成功，我继续打开真实平台。`, 2200);
    }

    await runClientAction({ action: 'ecommerce_growth_panel', stage: 'publish' });
    await runTool('desktop_clipboard_write', { text: publishDraft }, true);
    await say(`现在进入账号和发布平台。`, 1700);
    for (const url of realPlatformUrls) {
      await openExternalUrl(url, 2400);
      await pointActiveWindowRatio(browserPatterns, 0.5, 0.36, false, { xRatio: 0.5, yRatio: 0.36 });
      await wait(900);
      await closeBrowserTab();
    }

    await runTool('desktop_clipboard_write', { text: buildImagePromptsText(brief) }, true);
    await openExternalUrl(EXTERNAL_TOOL_URLS.jimeng, 2400);
    await pointActiveWindowRatio(browserPatterns, 0.55, 0.52, false, { xRatio: 0.55, yRatio: 0.52 });
    await say(`图文和图片生成提示词也准备好了。`, 2300);
    await closeBrowserTab();

    const realPersonalWechatShortcut = await findDesktopShortcut([/^(?!.*企业).*微信/i, /^wechat/i, /^weixin/i]);
    const realEnterpriseWechatShortcut = await findDesktopShortcut([/企业微信/i, /wxwork/i]);
    await runTool('desktop_clipboard_write', { text: customerServiceDraft }, true);
    await runTool('desktop_run_command', { command: buildOpenWeChatCommand(realPersonalWechatShortcut, realEnterpriseWechatShortcut) }, true);
    await wait(3200);
    active = await waitForActiveWindow(wechatPatterns, 6200);
    if (active) {
      await pointActiveWindowRatio(wechatPatterns, 0.5, 0.86, false, { xRatio: 0.5, yRatio: 0.86 });
      await say(`微信已打开，回复草稿准备好了，不自动发送。`, 2600);
    } else {
      await say(`微信没有抢到前台，草稿已经放到剪贴板。`, 2400);
    }

    await runTool('desktop_open', { target: files.folder }, true);
    await wait(1600);
    await pointActiveWindowRatio(explorerPatterns, 0.5, 0.46, false, { xRatio: 0.5, yRatio: 0.48 });
    await runClientAction({ action: 'ecommerce_growth_panel', stage: 'result' });
    await say(`这轮真实接管先跑到这里。产物在桌面，发布和投放等你确认。`, 3200);
    await closeActiveWindow(explorerPatterns);

    if (!isCancelled?.()) {
      await exitWallpaperMode();
      await runTool('desktop_show_lumi_window', {}, true);
      await wait(500);
      await runTool('desktop_run_command', { command: buildAppActivateCommand('Lumi') }, true);
      await wait(800);
    }

    return {
      responseText: spokenLines.join('\n'),
      toolCalls,
    };

    await runStep({
      text: `${greeting}我来接管。先把店铺和商品跑成一份结果包；发布、投流、改价和发消息前，我会停下来等你确认。`,
      actions: [
        { tool: 'desktop_show_lumi_window', afterMs: 250 },
        { clientAction: { action: 'ecommerce_growth_panel', stage: 'intake' } },
      ],
      pauseMs: 5200,
    });

    await enterWallpaperMode();

    await runStep({
      text: `我先把全链路结果看板打开，先看完整产出。`,
      actions: [
        { clientAction: { action: 'ecommerce_growth_panel', stage: 'diagnosis' } },
        openBrowserAction(files.fullDemoHtml, 2200),
      ],
      timing: 'after',
      pauseMs: 4200,
    });
    await waitForActiveWindow(browserPatterns, 5200);
    await pointActiveWindowRatio(browserPatterns, 0.52, 0.36, false, { xRatio: 0.52, yRatio: 0.38 });

    await openBrowserPage(files.storeAuditHtml, 1600);
    await pointActiveWindowRatio(browserPatterns, 0.45, 0.48, false, { xRatio: 0.45, yRatio: 0.48 });
    await say(`店铺体检完成，我先给你看结论和动作。`, 3400);
    await closeBrowserTab();

    await runStep({
      text: `内容矩阵出来了，我打开表格给你看。`,
      actions: [
        { clientAction: { action: 'ecommerce_growth_panel', stage: 'content' } },
        openBrowserAction(files.contentMatrixHtml, 1600),
      ],
      timing: 'after',
      pauseMs: 3600,
    });
    await waitForActiveWindow(browserPatterns, 5200);
    await pointActiveWindowRatio(browserPatterns, 0.48, 0.48, false, { xRatio: 0.5, yRatio: 0.48 });
    await closeBrowserTab();

    await openBrowserPage(files.videoScriptHtml, 1500);
    await waitForActiveWindow(browserPatterns, 5000);
    await pointActiveWindowRatio(browserPatterns, 0.5, 0.42, false, { xRatio: 0.5, yRatio: 0.44 });
    await say(`短视频脚本和分镜也好了。`, 3000);
    await closeBrowserTab();

    await openBrowserPage(files.imageNotesHtml, 1500);
    await waitForActiveWindow(browserPatterns, 5000);
    await pointActiveWindowRatio(browserPatterns, 0.5, 0.46, false, { xRatio: 0.5, yRatio: 0.46 });
    await say(`图文笔记包也准备好了。`, 2800);
    await closeBrowserTab();

    await runStep({
      text: `接下来我调用外部工具。图片、视频、剪辑和发布，都交给专业页面处理。`,
      actions: [
        { clientAction: { action: 'ecommerce_growth_panel', stage: 'tools' } },
        openBrowserAction(files.toolConsoleHtml, 1600),
      ],
      timing: 'after',
      pauseMs: 5200,
    });
    await waitForActiveWindow(browserPatterns, 5200);
    await pointActiveWindowRatio(browserPatterns, 0.42, 0.42, true, { xRatio: 0.42, yRatio: 0.42 });

    await runTool('desktop_clipboard_write', { text: buildImagePromptsText(brief) }, true);
    await wait(400);
    await say(`图片提示词已经复制，外部工具入口在这里。`, 3200);

    await runTool('desktop_clipboard_write', { text: buildVideoPromptsText(brief) }, true);
    await wait(400);
    await pointActiveWindowRatio(browserPatterns, 0.64, 0.42, false, { xRatio: 0.64, yRatio: 0.42 });
    await say(`视频提示词也复制好了，等你确认后再进具体平台。`, 3300);
    await closeBrowserTab();

    await runStep({
      text: `发布草稿准备好了。我只打开给你看，真实发布前等你确认。`,
      actions: [
        { clientAction: { action: 'ecommerce_growth_panel', stage: 'publish' } },
        { tool: 'desktop_clipboard_write', args: { text: publishDraft }, afterMs: 300 },
        openBrowserAction(files.publishPageHtml, 1700),
      ],
      timing: 'after',
      pauseMs: 4600,
    });
    await waitForActiveWindow(browserPatterns, 5200);
    await pointActiveWindowRatio(browserPatterns, 0.45, 0.62, true, { xRatio: 0.45, yRatio: 0.62 });
    await closeBrowserTab();

    await openBrowserPage(files.customerServiceHtml, 1500);
    await waitForActiveWindow(browserPatterns, 5000);
    await pointActiveWindowRatio(browserPatterns, 0.5, 0.5, false, { xRatio: 0.5, yRatio: 0.5 });
    await say(`客服和微信草稿也准备好了。`, 3000);
    await closeBrowserTab();

    const personalWechatShortcut = await findDesktopShortcut([/^(?!.*企业).*微信/i, /^wechat/i, /^weixin/i]);
    const enterpriseWechatShortcut = await findDesktopShortcut([/企业微信/i, /wxwork/i]);
    await runTool('desktop_clipboard_write', { text: customerServiceDraft }, true);
    await runTool('desktop_run_command', { command: buildOpenWeChatCommand(personalWechatShortcut, enterpriseWechatShortcut) }, true);
    await wait(3200);
    const activeWeChat = await waitForActiveWindow(wechatPatterns, 5200);
    if (activeWeChat) {
      await pointActiveWindowRatio(wechatPatterns, 0.5, 0.86, false, { xRatio: 0.5, yRatio: 0.86 });
      await wait(500);
      await say(`微信已经打开，草稿在剪贴板，默认不粘贴不发送。`, 3300);
    } else {
      await say(`没有聚焦到微信，我先把草稿放进剪贴板和交付包。`, 3400);
    }

    await openBrowserPage(files.battleReportHtml, 1600);
    await waitForActiveWindow(browserPatterns, 5200);
    await pointActiveWindowRatio(browserPatterns, 0.5, 0.44, false, { xRatio: 0.5, yRatio: 0.44 });
    await say(`这是运营战报：我做了什么、还卡在哪、下一步等你确认什么，都在这里。${verificationText}。`, 5200);
    await closeBrowserTab();

    await runTool('desktop_open', { target: files.folder }, true);
    await wait(2600);
    await pointActiveWindowRatio(explorerPatterns, 0.5, 0.46, false, { xRatio: 0.5, yRatio: 0.48 });
    await say(`结果包在桌面。确认边界以后，我继续往下接。`, 3600);

    if (!isCancelled?.()) {
      await exitWallpaperMode();
      await runTool('desktop_show_lumi_window', {}, true);
      await wait(500);
      await runClientAction({ action: 'ecommerce_growth_panel', stage: 'result' });
      await say(`这轮我跑完了。等你确认账号、库存和发布边界，我继续。`, 4200);
      await runTool('desktop_run_command', { command: buildAppActivateCommand('Lumi') }, true);
      await wait(800);
    }
  } finally {
    await exitWallpaperMode();
  }

  return {
    responseText: spokenLines.join('\n'),
    toolCalls,
  };
}
