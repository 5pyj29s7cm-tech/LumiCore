import fs from 'fs';
import path from 'path';
import type { WorkTakeoverTask } from './tasks';

export type WorkTakeoverExpectedSurface =
  | 'wechat'
  | 'browser'
  | 'office'
  | 'spreadsheet'
  | 'cad'
  | 'bim'
  | 'video_editor'
  | 'store_platform'
  | 'creator_platform'
  | 'file_explorer'
  | 'lumi';

export interface DesktopWindowObservation {
  title: string;
  processName: string;
  pid?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface DesktopProcessObservation {
  name: string;
  pid?: number;
  title?: string;
}

export interface DesktopScreenObservation {
  captured: boolean;
  width?: number;
  height?: number;
  format?: string;
  byteEstimate?: number;
}

export interface WorkTakeoverVerificationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface WorkTakeoverResultVerification {
  verificationId: string;
  checkedAt: string;
  passed: boolean;
  status: 'passed' | 'needs_review' | 'blocked';
  summary: string;
  activeWindow?: DesktopWindowObservation | null;
  screen?: DesktopScreenObservation | null;
  detectedSurfaces: WorkTakeoverExpectedSurface[];
  checks: WorkTakeoverVerificationCheck[];
  blockers: string[];
}

export interface WorkTakeoverVerificationInput {
  activeWindowRaw?: string;
  runningProcessesRaw?: string;
  expectedSurfaces?: WorkTakeoverExpectedSurface[];
  filePaths?: string[];
  draftRequired?: boolean;
  requireActiveWindow?: boolean;
  screenRaw?: string;
  requireScreenEvidence?: boolean;
  requiredArtifactLabels?: string[];
  expectedContentTerms?: string[];
  minMatchedContentTerms?: number;
  minFileBytes?: number;
}

const SURFACE_PATTERNS: Record<WorkTakeoverExpectedSurface, RegExp[]> = {
  wechat: [/wechat/i, /weixin/i, /wxwork/i, /微信/i, /企业微信/i],
  browser: [/chrome/i, /msedge/i, /edge/i, /firefox/i, /browser/i, /quark/i, /夸克/i],
  office: [/wps/i, /winword/i, /word/i, /wpp/i, /office/i, /notepad/i, /文档/i],
  spreadsheet: [/et/i, /excel/i, /spreadsheet/i, /表格/i],
  cad: [/cad/i, /autocad/i, /freecad/i, /zwcad/i, /浩辰/i, /中望/i],
  bim: [/revit/i, /dynamo/i, /bim/i],
  video_editor: [/jianying/i, /capcut/i, /剪映/i, /prproj/i, /premiere/i],
  store_platform: [/抖店/i, /小店/i, /商家后台/i, /店铺/i, /fxg/i, /seller/i, /shop/i],
  creator_platform: [/creator/i, /创作者/i, /小红书/i, /抖音/i, /视频号/i],
  file_explorer: [/explorer/i, /文件资源管理器/i, /资源管理器/i],
  lumi: [/lumi/i, /lumi-os/i],
};

const CATEGORY_CONTENT_TERMS: Record<string, string[]> = {
  customer: ['客户', '需求', '方案', '报价', '合同', '跟进', '回复'],
  store: ['店铺', '订单', '售后', '库存', '客服', '风险', '回复'],
  account: ['账号', '店铺', '内容', '发布', '投放', '客服', '微信', '清单'],
  video_publish: ['视频', '脚本', '标题', '封面', '发布', '平台', '素材'],
  design_delivery: ['装修', '户型', '面积', '风格', '预算', '材料', 'CAD', 'Revit', '方案'],
  legal_case: ['立案', '证据', '材料', '事实', '时间线', '风险', '提交'],
  general_work: ['任务', '清单', '草稿', '结果', '确认'],
  personal: ['事项', '提醒', '回复', '确认'],
};

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.dxf', '.svg',
  '.log', '.yaml', '.yml', '.rtf',
]);

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function parseJson(raw?: string): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseDesktopWindow(raw?: string): DesktopWindowObservation | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const title = compact(parsed.title);
  const processName = compact(parsed.process_name || parsed.processName || parsed.process || parsed.name);
  if (!title && !processName) return null;
  return {
    title,
    processName,
    pid: Number.isFinite(Number(parsed.pid)) ? Number(parsed.pid) : undefined,
    x: Number.isFinite(Number(parsed.x)) ? Number(parsed.x) : undefined,
    y: Number.isFinite(Number(parsed.y)) ? Number(parsed.y) : undefined,
    width: Number.isFinite(Number(parsed.width)) ? Number(parsed.width) : undefined,
    height: Number.isFinite(Number(parsed.height)) ? Number(parsed.height) : undefined,
  };
}

export function parseDesktopScreen(raw?: string): DesktopScreenObservation | null {
  if (!raw) return null;
  const parsed = parseJson(raw);
  const source = parsed && typeof parsed === 'object' ? parsed : { image_base64: raw };
  const base64 = compact(source.image_base64 || source.base64 || source.data);
  const width = Number(source.width || source.screenWidth || source.screen_width);
  const height = Number(source.height || source.screenHeight || source.screen_height);
  const byteEstimate = base64 ? Math.floor(base64.length * 0.75) : 0;
  const captured = Boolean(base64 && byteEstimate > 1024 && (!Number.isFinite(width) || width > 0) && (!Number.isFinite(height) || height > 0));
  return {
    captured,
    width: Number.isFinite(width) && width > 0 ? width : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined,
    format: compact(source.format || source.mime || source.type) || undefined,
    byteEstimate: byteEstimate || undefined,
  };
}

export function parseDesktopProcesses(raw?: string): DesktopProcessObservation[] {
  const parsed = parseJson(raw);
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.processes)
    ? parsed.processes
    : [];
  return items
    .map((item: any) => ({
      name: compact(item?.name || item?.processName || item?.process_name || item?.ProcessName),
      pid: Number.isFinite(Number(item?.pid || item?.id || item?.Id)) ? Number(item?.pid || item?.id || item?.Id) : undefined,
      title: compact(item?.title || item?.mainWindowTitle || item?.MainWindowTitle),
    }))
    .filter(item => item.name || item.title);
}

function haystackForWindow(window: DesktopWindowObservation | null): string {
  return compact(`${window?.title || ''} ${window?.processName || ''}`);
}

function haystackForProcess(process: DesktopProcessObservation): string {
  return compact(`${process.name || ''} ${process.title || ''}`);
}

export function detectDesktopSurfaces(
  activeWindow: DesktopWindowObservation | null,
  processes: DesktopProcessObservation[] = [],
): WorkTakeoverExpectedSurface[] {
  const haystacks = [haystackForWindow(activeWindow), ...processes.map(haystackForProcess)].filter(Boolean);
  const surfaces: WorkTakeoverExpectedSurface[] = [];
  for (const [surface, patterns] of Object.entries(SURFACE_PATTERNS) as Array<[WorkTakeoverExpectedSurface, RegExp[]]>) {
    if (haystacks.some(text => patterns.some(pattern => pattern.test(text)))) surfaces.push(surface);
  }
  return unique(surfaces);
}

function fileExists(filePath: string): boolean {
  try {
    return Boolean(filePath && fs.existsSync(filePath));
  } catch {
    return false;
  }
}

function fileSize(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function safeReadTextSnippet(filePath: string, limit = 24_000): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return '';
    const ext = path.extname(filePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return `${path.basename(filePath)} bytes=${stat.size}`;
    return fs.readFileSync(filePath, 'utf8').slice(0, limit);
  } catch {
    return '';
  }
}

function taskArtifactPaths(task: WorkTakeoverTask): string[] {
  return task.artifacts.map(artifact => artifact.path || '').filter(Boolean);
}

function taskEvidenceText(task: WorkTakeoverTask, filePaths: string[]): string {
  return [
    task.title,
    task.summary,
    task.sourceMessage,
    task.result,
    ...task.nextActions,
    ...task.drafts.map(draft => draft.text),
    ...task.artifacts.flatMap(artifact => [artifact.label, artifact.content, artifact.path]),
    ...filePaths.map(filePath => safeReadTextSnippet(filePath)),
  ].map(compact).filter(Boolean).join('\n');
}

function contentTermsForTask(task: WorkTakeoverTask, input: WorkTakeoverVerificationInput): string[] {
  return unique([
    ...(CATEGORY_CONTENT_TERMS[task.category] || []),
    ...(input.expectedContentTerms || []),
  ]);
}

function matchedContentTerms(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter(term => lower.includes(term.toLowerCase()));
}

function fileTextEvidence(filePaths: string[]): string {
  return filePaths.map(filePath => safeReadTextSnippet(filePath)).map(compact).filter(Boolean).join('\n');
}

function shouldCheckArtifactContent(task: WorkTakeoverTask, input: WorkTakeoverVerificationInput, filePaths: string[]): boolean {
  return Boolean(
    input.expectedContentTerms?.length
    || input.requiredArtifactLabels?.length
    || task.artifacts.length
    || filePaths.length
  );
}

function check(id: string, label: string, passed: boolean, detail: string): WorkTakeoverVerificationCheck {
  return { id, label, passed, detail };
}

export function verifyWorkTakeoverResult(
  task: WorkTakeoverTask,
  input: WorkTakeoverVerificationInput = {},
): WorkTakeoverResultVerification {
  const activeWindow = parseDesktopWindow(input.activeWindowRaw);
  const processes = parseDesktopProcesses(input.runningProcessesRaw);
  const screen = parseDesktopScreen(input.screenRaw);
  const detectedSurfaces = detectDesktopSurfaces(activeWindow, processes);
  const expectedSurfaces = unique(input.expectedSurfaces || []);
  const filePaths = unique([...(input.filePaths || []), ...taskArtifactPaths(task)]);
  const checks: WorkTakeoverVerificationCheck[] = [];

  checks.push(check(
    'task_context',
    '任务上下文已结构化',
    Boolean(compact(task.summary || task.sourceMessage || task.title) && task.nextActions.length > 0),
    task.nextActions.length
      ? `nextActions=${task.nextActions.slice(0, 4).join('；')}`
      : '缺少可执行的下一步动作',
  ));

  checks.push(check(
    'confirmation_boundaries',
    '确认边界已记录',
    task.confirmationRequired.length > 0,
    task.confirmationRequired.length
      ? task.confirmationRequired.slice(0, 5).join('；')
      : '缺少发送/提交/发布/登录等确认边界',
  ));

  if (input.draftRequired || /微信|消息|回复|客服|发送/i.test(`${task.title} ${task.summary} ${task.sourceMessage}`)) {
    checks.push(check(
      'draft_ready',
      '沟通草稿已准备',
      task.drafts.length > 0,
      task.drafts.length ? `drafts=${task.drafts.length}` : '没有记录沟通草稿',
    ));
  }

  if (filePaths.length) {
    const missing = filePaths.filter(filePath => !fileExists(filePath));
    checks.push(check(
      'files_exist',
      '交付文件/路径存在',
      missing.length === 0,
        missing.length ? `缺失：${missing.slice(0, 5).join('；')}` : `已检查 ${filePaths.length} 个路径`,
    ));

    const minFileBytes = Math.max(1, Number(input.minFileBytes || 16));
    const undersized = filePaths
      .filter(filePath => fileExists(filePath))
      .filter(filePath => {
        try {
          return fs.statSync(filePath).isFile() && fileSize(filePath) < minFileBytes;
        } catch {
          return false;
        }
      });
    checks.push(check(
      'file_content_size',
      '交付文件不是空文件',
      undersized.length === 0,
      undersized.length
        ? `内容过少：${undersized.slice(0, 5).map(filePath => `${filePath}(${fileSize(filePath)}B)`).join('；')}`
        : `文件大小达到最低阈值 ${minFileBytes}B`,
    ));
  }

  const requiredArtifactLabels = unique(input.requiredArtifactLabels || []);
  if (requiredArtifactLabels.length) {
    const labels = task.artifacts.map(artifact => artifact.label);
    const missingLabels = requiredArtifactLabels.filter(label => !labels.some(existing => existing.includes(label) || label.includes(existing)));
    checks.push(check(
      'artifact_labels',
      '必需交付物已记录',
      missingLabels.length === 0,
      missingLabels.length ? `缺少：${missingLabels.join('；')}` : `已记录：${requiredArtifactLabels.join('；')}`,
    ));
  }

  if (shouldCheckArtifactContent(task, input, filePaths)) {
    const evidenceText = taskEvidenceText(task, filePaths);
    const fileEvidenceText = fileTextEvidence(filePaths);
    const compactEvidence = evidenceText.replace(/\s+/g, '');
    const compactFileEvidence = fileEvidenceText.replace(/\s+/g, '');
    const terms = contentTermsForTask(task, input);
    const matched = matchedContentTerms(evidenceText, terms);
    const fileMatched = matchedContentTerms(fileEvidenceText, terms);
    const minMatches = Number.isFinite(Number(input.minMatchedContentTerms))
      ? Math.max(0, Number(input.minMatchedContentTerms))
      : Math.min(2, terms.length);
    const hasEnoughText = compactEvidence.length >= 30;
    const hasEnoughFileText = filePaths.length === 0 || compactFileEvidence.length >= 20;
    const hasEnoughTerms = terms.length === 0 || matched.length >= minMatches;
    const hasEnoughFileTerms = filePaths.length === 0 || terms.length === 0 || fileMatched.length >= Math.min(1, minMatches);
    checks.push(check(
      'artifact_content_quality',
      '交付内容贴合任务',
      hasEnoughText && hasEnoughTerms && hasEnoughFileText && hasEnoughFileTerms,
      [
        hasEnoughText ? `内容长度=${compactEvidence.length}` : `内容过少=${compactEvidence.length}`,
        terms.length ? `命中关键词=${matched.slice(0, 8).join('、') || '无'}；要求=${minMatches}` : '',
        filePaths.length ? `文件内容长度=${compactFileEvidence.length}；文件关键词=${fileMatched.slice(0, 5).join('、') || '无'}` : '',
      ].filter(Boolean).join('；'),
    ));
  }

  if (expectedSurfaces.length) {
    const missing = expectedSurfaces.filter(surface => !detectedSurfaces.includes(surface));
    checks.push(check(
      'expected_surfaces',
      '预期外部窗口/会话已出现',
      missing.length === 0,
      missing.length
        ? `未检测到：${missing.join('；')}；当前=${detectedSurfaces.join('、') || '无'}`
        : `检测到：${detectedSurfaces.join('、')}`,
    ));
  } else if (input.requireActiveWindow) {
    checks.push(check(
      'active_window',
      '当前活动窗口可读',
      Boolean(activeWindow),
      activeWindow ? `${activeWindow.processName} ${activeWindow.title}` : '没有读到活动窗口',
    ));
  }

  if (input.requireScreenEvidence) {
    checks.push(check(
      'screen_evidence',
      '屏幕截图可读',
      Boolean(screen?.captured),
      screen?.captured
        ? `${screen.width || '?'}x${screen.height || '?'} ${screen.format || ''}`.trim()
        : '没有拿到有效截图，不能证明 Lumi 真的看见了当前桌面',
    ));
  }

  checks.push(check(
    'result_written',
    '任务结果已回写',
    Boolean(compact(task.result) || task.artifacts.length > 0 || task.drafts.length > 0),
    compact(task.result || `artifacts=${task.artifacts.length}; drafts=${task.drafts.length}`) || '暂无结果、交付物或草稿',
  ));

  const failed = checks.filter(item => !item.passed);
  const blockers = failed.map(item => `${item.label}：${item.detail}`);
  const passed = failed.length === 0;
  const status: WorkTakeoverResultVerification['status'] = passed
    ? 'passed'
    : failed.some(item => ['task_context', 'confirmation_boundaries'].includes(item.id))
    ? 'blocked'
    : 'needs_review';

  return {
    verificationId: `wt_verify_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    checkedAt: new Date().toISOString(),
    passed,
    status,
    summary: passed
      ? '任务结果验证通过：桌面证据、确认边界、产物内容和草稿状态满足当前安全闭环。'
      : `任务结果需要复核：${blockers.slice(0, 3).join('；')}`,
    activeWindow,
    screen,
    detectedSurfaces,
    checks,
    blockers,
  };
}
