import crypto from 'node:crypto';
import type { CapabilityExecutionPlan } from '../cognition/capability_execution_plan';
import type { LumiCapabilityLane } from '../cognition/capability_selection';
import type { NormalizedSideEffectClass } from '../cognition/normalized_action_intent';

export type DesktopApplicationFamily =
  | 'lumi'
  | 'browser'
  | 'office'
  | 'messaging'
  | 'cad'
  | 'desktop_ai'
  | 'unknown';

export type DesktopControlLayer =
  | 'client_native'
  | 'dedicated_adapter'
  | 'browser_dom'
  | 'windows_uia'
  | 'vision';

export interface ApplicationIdentity {
  id: string;
  family: DesktopApplicationFamily;
  displayName: string;
  aliases: string[];
  processPatterns: string[];
  windowTitlePatterns: string[];
  executablePatterns: string[];
  certification: 'certified' | 'conditional' | 'fallback_only';
  controlLayers: DesktopControlLayer[];
}

export interface DesktopActionStep {
  stepId: string;
  operation: 'observe' | 'focus_or_open' | 'act' | 'commit' | 'verify';
  layer: DesktopControlLayer;
  allowedTools: string[];
  preconditions: string[];
  expectedEvidence: string[];
  sideEffectClass: NormalizedSideEffectClass;
  requiresFreshObservation: boolean;
  invalidatesOnWindowChange: boolean;
  requiresConfirmation: boolean;
}

export interface DesktopVerificationSpec {
  requireApplicationMatch: boolean;
  requireWindowFingerprint: boolean;
  requireTerminalEvidence: boolean;
  requiredSignals: string[];
}

export interface DesktopRecoveryPolicy {
  maxObservationRetries: number;
  refocusOnMismatch: boolean;
  replanOnWindowChange: true;
  stopOnTargetMismatch: true;
  stopOnUnknownOutcome: true;
  allowLegacyRoute: false;
  allowVisionCommit: false;
}

export interface DesktopExecutionPlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  application: ApplicationIdentity;
  operation: string;
  steps: DesktopActionStep[];
  sideEffectClass: NormalizedSideEffectClass;
  verification: DesktopVerificationSpec;
  recovery: DesktopRecoveryPolicy;
}

export interface DesktopStepReceipt {
  stepId: string;
  status: 'verified' | 'failed' | 'blocked' | 'unknown';
  layer: DesktopControlLayer;
  applicationMatched: boolean;
  windowFingerprintBefore?: string;
  windowFingerprintAfter?: string;
  evidence: string[];
  error?: string;
}

export interface DesktopExecutionReceipt {
  planId: string;
  taskId: string;
  applicationMatched: boolean;
  steps: DesktopStepReceipt[];
  finalState: 'verified_success' | 'failed' | 'blocked' | 'unknown_outcome' | 'target_mismatch';
  evidence: string[];
  completionVerified: boolean;
}

export const DESKTOP_APPLICATION_REGISTRY: readonly ApplicationIdentity[] = [
  {
    id: 'lumi-client',
    family: 'lumi',
    displayName: 'Lumi desktop client',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['lumi', 'lumios', '聊天界面', '知识库', '设置'],
    processPatterns: ['lumi', 'lumi-os'],
    windowTitlePatterns: ['lumi', 'lumios'],
    executablePatterns: ['lumi*.exe'],
    certification: 'certified',
    controlLayers: ['client_native'],
  },
  {
    id: 'chrome-browser',
    family: 'browser',
    displayName: 'Google Chrome',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['google chrome', 'chrome', '谷歌浏览器'],
    processPatterns: ['chrome'],
    windowTitlePatterns: ['google chrome'],
    executablePatterns: ['chrome.exe'],
    certification: 'certified',
    controlLayers: ['browser_dom', 'windows_uia', 'vision'],
  },
  {
    id: 'edge-browser',
    family: 'browser',
    displayName: 'Microsoft Edge',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['microsoft edge', 'edge', '微软浏览器'],
    processPatterns: ['msedge'],
    windowTitlePatterns: ['microsoft edge'],
    executablePatterns: ['msedge.exe'],
    certification: 'certified',
    controlLayers: ['browser_dom', 'windows_uia', 'vision'],
  },
  {
    id: 'firefox-browser',
    family: 'browser',
    displayName: 'Mozilla Firefox',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['mozilla firefox', 'firefox', '火狐浏览器'],
    processPatterns: ['firefox'],
    windowTitlePatterns: ['mozilla firefox', 'firefox'],
    executablePatterns: ['firefox.exe'],
    certification: 'certified',
    controlLayers: ['browser_dom', 'windows_uia', 'vision'],
  },
  {
    id: 'desktop-browser',
    family: 'browser',
    displayName: 'Certified desktop browser',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['browser', '浏览器', '网页', '网站'],
    processPatterns: ['msedge', 'chrome', 'firefox'],
    windowTitlePatterns: ['microsoft edge', 'google chrome', 'mozilla firefox'],
    executablePatterns: ['msedge.exe', 'chrome.exe', 'firefox.exe'],
    certification: 'certified',
    controlLayers: ['browser_dom', 'windows_uia', 'vision'],
  },
  {
    id: 'wps-spreadsheet',
    family: 'office',
    displayName: 'WPS Spreadsheets',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['wps spreadsheets', 'wps spreadsheet', 'wps 表格', 'wps表格'],
    processPatterns: ['et'],
    // i18n-allow: Reviewed multilingual window-title fingerprint.
    windowTitlePatterns: ['wps spreadsheets', 'wps 表格'],
    executablePatterns: ['et.exe'],
    certification: 'certified',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'wps-presentation',
    family: 'office',
    displayName: 'WPS Presentation',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['wps presentation', 'wps 演示', 'wps演示'],
    processPatterns: ['wpp'],
    // i18n-allow: Reviewed multilingual window-title fingerprint.
    windowTitlePatterns: ['wps presentation', 'wps 演示'],
    executablePatterns: ['wpp.exe'],
    certification: 'certified',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'wps-writer',
    family: 'office',
    displayName: 'WPS Writer',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['wps writer', 'wps 文字', 'wps文字', 'wps'],
    processPatterns: ['wps'],
    // i18n-allow: Reviewed multilingual window-title fingerprint.
    windowTitlePatterns: ['wps writer', 'wps 文字', 'wps'],
    executablePatterns: ['wps.exe'],
    certification: 'certified',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'microsoft-word',
    family: 'office',
    displayName: 'Microsoft Word',
    aliases: ['microsoft word', 'word'],
    processPatterns: ['winword'],
    windowTitlePatterns: ['microsoft word', 'word'],
    executablePatterns: ['winword.exe'],
    certification: 'certified',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'microsoft-excel',
    family: 'office',
    displayName: 'Microsoft Excel',
    aliases: ['microsoft excel', 'excel'],
    processPatterns: ['excel'],
    windowTitlePatterns: ['microsoft excel', 'excel'],
    executablePatterns: ['excel.exe'],
    certification: 'certified',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'microsoft-powerpoint',
    family: 'office',
    displayName: 'Microsoft PowerPoint',
    aliases: ['microsoft powerpoint', 'powerpoint'],
    processPatterns: ['powerpnt'],
    windowTitlePatterns: ['microsoft powerpoint', 'powerpoint'],
    executablePatterns: ['powerpnt.exe'],
    certification: 'certified',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'office-suite',
    family: 'office',
    displayName: 'Office suite (generic target)',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['office suite', 'office', '办公软件', '文档', '表格', '演示文稿'],
    processPatterns: ['wps', 'et', 'wpp', 'winword', 'excel', 'powerpnt'],
    windowTitlePatterns: ['wps', 'word', 'excel', 'powerpoint'],
    executablePatterns: ['wps.exe', 'et.exe', 'wpp.exe', 'winword.exe', 'excel.exe', 'powerpnt.exe'],
    certification: 'certified',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'wechat-desktop',
    family: 'messaging',
    displayName: 'WeChat desktop',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['wechat', 'weixin', '微信'],
    processPatterns: ['wechat', 'weixin'],
    // i18n-allow: Reviewed multilingual window-title fingerprint.
    windowTitlePatterns: ['微信', 'wechat'],
    executablePatterns: ['wechat.exe', 'weixin.exe'],
    certification: 'conditional',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'autocad-desktop',
    family: 'cad',
    displayName: 'AutoCAD',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['autocad', 'cad', 'dwg', '图纸', '平面图'],
    processPatterns: ['acad'],
    windowTitlePatterns: ['autocad'],
    executablePatterns: ['acad.exe'],
    certification: 'certified',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'chatgpt-desktop',
    family: 'desktop_ai',
    displayName: 'ChatGPT desktop',
    aliases: ['chatgpt desktop', 'chatgpt'],
    processPatterns: ['chatgpt'],
    windowTitlePatterns: ['chatgpt'],
    executablePatterns: ['chatgpt*.exe'],
    certification: 'conditional',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'claude-desktop',
    family: 'desktop_ai',
    displayName: 'Claude desktop',
    aliases: ['claude desktop', 'claude'],
    processPatterns: ['claude'],
    windowTitlePatterns: ['claude'],
    executablePatterns: ['claude*.exe'],
    certification: 'conditional',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'codex-desktop',
    family: 'desktop_ai',
    displayName: 'Codex desktop',
    aliases: ['codex desktop', 'codex'],
    processPatterns: ['codex'],
    windowTitlePatterns: ['codex'],
    executablePatterns: ['codex*.exe'],
    certification: 'conditional',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'gemini-desktop',
    family: 'desktop_ai',
    displayName: 'Gemini desktop',
    aliases: ['gemini desktop', 'gemini'],
    processPatterns: ['gemini'],
    windowTitlePatterns: ['gemini'],
    executablePatterns: ['gemini*.exe'],
    certification: 'conditional',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'desktop-ai-client',
    family: 'desktop_ai',
    displayName: 'Desktop AI client (generic target)',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['desktop ai', '桌面 ai', '桌面ai'],
    processPatterns: ['chatgpt', 'claude', 'codex', 'gemini'],
    windowTitlePatterns: ['chatgpt', 'claude', 'codex', 'gemini'],
    executablePatterns: ['chatgpt*.exe', 'claude*.exe', 'codex*.exe', 'gemini*.exe'],
    certification: 'conditional',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
];

const UNKNOWN_APPLICATION: ApplicationIdentity = {
  id: 'unverified-desktop-application',
  family: 'unknown',
  displayName: 'Unverified desktop application',
  aliases: [],
  processPatterns: [],
  windowTitlePatterns: [],
  executablePatterns: [],
  certification: 'fallback_only',
  controlLayers: ['windows_uia', 'vision'],
};

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function resolveDesktopApplicationIdentity(
  text: string,
  lane?: LumiCapabilityLane,
): ApplicationIdentity {
  const normalized = String(text || '').toLowerCase();
  const explicit = DESKTOP_APPLICATION_REGISTRY
    .flatMap(application => application.aliases
      .filter(alias => desktopTextMatchesAlias(normalized, alias))
      .map(alias => ({ application, aliasLength: alias.length })))
    .sort((left, right) => right.aliasLength - left.aliasLength)[0]?.application;
  if (explicit) return { ...explicit, aliases: [...explicit.aliases], processPatterns: [...explicit.processPatterns], windowTitlePatterns: [...explicit.windowTitlePatterns], executablePatterns: [...explicit.executablePatterns], controlLayers: [...explicit.controlLayers] };
  const inferredId = lane === 'design_cad'
    ? 'autocad-desktop'
    : lane === 'web_or_account'
      ? 'desktop-browser'
      : undefined;
  const inferred = inferredId
    ? DESKTOP_APPLICATION_REGISTRY.find(application => application.id === inferredId)
    : undefined;
  const chosen = inferred || UNKNOWN_APPLICATION;
  return { ...chosen, aliases: [...chosen.aliases], processPatterns: [...chosen.processPatterns], windowTitlePatterns: [...chosen.windowTitlePatterns], executablePatterns: [...chosen.executablePatterns], controlLayers: [...chosen.controlLayers] };
}

function desktopTextMatchesAlias(normalizedText: string, alias: string): boolean {
  const normalizedAlias = alias.trim().toLowerCase();
  if (!normalizedAlias) return false;
  if (/^[a-z0-9][a-z0-9 ._+-]*$/i.test(normalizedAlias)) {
    const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(normalizedText);
  }
  return normalizedText.includes(normalizedAlias);
}

function normalizeProcessName(value: string): string {
  const raw = String(value || '').trim().toLowerCase().replace(/\\/g, '/').split('/').pop() || '';
  return raw.replace(/\.exe$/i, '');
}

function processMatchesPattern(value: string, pattern: string): boolean {
  const normalizedValue = normalizeProcessName(value);
  const normalizedPattern = normalizeProcessName(pattern);
  if (!normalizedValue || !normalizedPattern) return false;
  const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(normalizedValue);
}

function titleMatchesPattern(value: string, pattern: string): boolean {
  const normalizedValue = String(value || '').trim().toLowerCase();
  const normalizedPattern = String(pattern || '').trim().toLowerCase().replace(/\*/g, '');
  return Boolean(normalizedValue && normalizedPattern && normalizedValue.includes(normalizedPattern));
}

export function desktopFingerprintMatchesApplication(
  fingerprint: { title?: string; processName?: string } | null | undefined,
  application: ApplicationIdentity,
): boolean {
  if (!fingerprint || application.family === 'unknown') return false;
  const processName = String(fingerprint.processName || '').trim();
  const processMatched = application.processPatterns.some(pattern => processMatchesPattern(processName, pattern))
    || application.executablePatterns.some(pattern => processMatchesPattern(processName, pattern));
  // A process identity is stronger than a title. For example, a Chrome tab
  // titled "AutoCAD" is not the AutoCAD desktop program.
  if (processName) return processMatched;
  return application.windowTitlePatterns.some(pattern => titleMatchesPattern(fingerprint.title || '', pattern));
}

export function desktopFingerprintMatchesRequestedTarget(
  fingerprint: { title?: string; processName?: string } | null | undefined,
  target: string,
  explicitApplication = '',
): boolean {
  if (!fingerprint) return false;
  const identityText = explicitApplication || (/^https?:\/\//i.test(target) ? 'browser' : target);
  const lane = /^https?:\/\//i.test(target) ? 'web_or_account' : undefined;
  const identity = resolveDesktopApplicationIdentity(identityText, lane);
  if (identity.family !== 'unknown') return desktopFingerprintMatchesApplication(fingerprint, identity);

  const processName = normalizeProcessName(fingerprint.processName || '');
  const requested = explicitApplication || target;
  const requestedProcess = normalizeProcessName(requested);
  if (processName && requestedProcess && !/[\\/]/.test(requested)) {
    return processName === requestedProcess;
  }
  const leaf = String(target || '').replace(/\\/g, '/').split('/').pop() || '';
  const titleNeedle = leaf.replace(/\.[a-z0-9]{1,12}$/i, '').trim().toLowerCase();
  return Boolean(
    processName
    && titleNeedle.length >= 2
    && String(fingerprint.title || '').toLowerCase().includes(titleNeedle)
  );
}

function toolsForLayer(layer: DesktopControlLayer, family: DesktopApplicationFamily): string[] {
  if (layer === 'client_native') return ['client_get_state', 'client_action'];
  if (layer === 'browser_dom') return ['mcp_playwright_browser_snapshot', 'mcp_playwright_browser_click', 'mcp_playwright_browser_type'];
  if (layer === 'windows_uia') return ['desktop_active_window', 'desktop_ui_snapshot', 'desktop_ui_focus', 'desktop_ui_invoke', 'desktop_ui_click', 'desktop_ui_type'];
  if (layer === 'vision') return ['desktop_capture_screen', 'computer_use'];
  if (family === 'cad') return ['cad_prepare_autocad_operations', 'cad_draw_floorplan_in_autocad', 'mcp_cad-drafting_autocad_new_document', 'mcp_cad-drafting_autocad_playback_file'];
  if (family === 'office') return ['wps_create_document_with_text', 'desktop_ui_snapshot', 'desktop_ui_type'];
  if (family === 'messaging') return ['wechat_read_recent_chat', 'wechat_send_message'];
  if (family === 'desktop_ai') return ['desktop_ai_ask', 'desktop_ai_roundtable'];
  return [];
}

export function buildDesktopExecutionPlan(input: {
  text: string;
  lane: LumiCapabilityLane;
  capabilityExecutionPlan?: CapabilityExecutionPlan;
  taskId?: string;
  recoveredCurrentAppEdit?: boolean;
}): DesktopExecutionPlan {
  const application = resolveDesktopApplicationIdentity(input.text, input.lane);
  const sideEffectClass = input.capabilityExecutionPlan?.risk.sideEffectClass || 'none';
  const layers = input.recoveredCurrentAppEdit
    ? application.controlLayers.filter(layer => layer === 'windows_uia')
    : application.controlLayers;
  const effectiveLayers = layers.length ? layers : ['windows_uia' as const];
  const taskId = input.taskId || input.capabilityExecutionPlan?.taskId || '';
  const steps: DesktopActionStep[] = [{
    stepId: 'observe-target',
    operation: 'observe',
    layer: application.family === 'lumi' ? 'client_native' : 'windows_uia',
    allowedTools: application.family === 'lumi'
      ? ['client_get_state']
      : ['desktop_list_apps', 'desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen'],
    preconditions: ['fresh application/window identity'],
    expectedEvidence: ['application identity', 'active window fingerprint'],
    sideEffectClass: 'none',
    requiresFreshObservation: true,
    invalidatesOnWindowChange: false,
    requiresConfirmation: false,
  }];
  effectiveLayers.forEach((layer, index) => {
    if (layer === 'vision' && sideEffectClass === 'external_commit') return;
    steps.push({
      stepId: `act-${index + 1}-${layer}`,
      operation: sideEffectClass === 'external_commit' ? 'commit' : 'act',
      layer,
      allowedTools: toolsForLayer(layer, application.family),
      preconditions: ['target application matched', 'fresh active-window fingerprint'],
      expectedEvidence: ['tool receipt', 'post-action state observation'],
      sideEffectClass,
      requiresFreshObservation: true,
      invalidatesOnWindowChange: true,
      requiresConfirmation: sideEffectClass === 'external_commit',
    });
  });
  steps.push({
    stepId: 'verify-result',
    operation: 'verify',
    layer: application.family === 'lumi' ? 'client_native' : effectiveLayers[0],
    allowedTools: application.family === 'lumi'
      ? ['client_get_state']
      : ['desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen'],
    preconditions: ['terminal action receipt exists'],
    expectedEvidence: ['application still matches', 'requested state is observable'],
    sideEffectClass: 'none',
    requiresFreshObservation: true,
    invalidatesOnWindowChange: false,
    requiresConfirmation: false,
  });
  return {
    schemaVersion: 1,
    planId: `desktop_${digest({ taskId, application: application.id, sideEffectClass, steps: steps.map(step => step.stepId) }).slice(0, 24)}`,
    taskId,
    application,
    operation: input.capabilityExecutionPlan?.intent.operation || 'mutate',
    steps,
    sideEffectClass,
    verification: {
      requireApplicationMatch: true,
      requireWindowFingerprint: application.family !== 'lumi',
      requireTerminalEvidence: true,
      requiredSignals: application.family === 'lumi'
        ? ['verified client state']
        : ['matching application identity', 'fresh post-action observation'],
    },
    recovery: {
      maxObservationRetries: sideEffectClass === 'external_commit' ? 0 : 2,
      refocusOnMismatch: sideEffectClass !== 'external_commit',
      replanOnWindowChange: true,
      stopOnTargetMismatch: true,
      stopOnUnknownOutcome: true,
      allowLegacyRoute: false,
      allowVisionCommit: false,
    },
  };
}

export function verifyDesktopExecutionReceipt(
  plan: DesktopExecutionPlan,
  receipt: Omit<DesktopExecutionReceipt, 'completionVerified' | 'finalState'>,
): DesktopExecutionReceipt {
  const requiredStepIds = new Set(plan.steps.map(step => step.stepId));
  const received = new Map(receipt.steps.map(step => [step.stepId, step]));
  const complete = Array.from(requiredStepIds).every(stepId => received.get(stepId)?.status === 'verified');
  const applicationMatched = receipt.applicationMatched
    && receipt.steps.every(step => step.applicationMatched);
  const unknownCommit = plan.sideEffectClass === 'external_commit'
    && receipt.steps.some(step => step.status === 'unknown');
  const targetMismatch = !applicationMatched;
  return {
    ...receipt,
    applicationMatched,
    finalState: targetMismatch
      ? 'target_mismatch'
      : unknownCommit
        ? 'unknown_outcome'
        : complete
          ? 'verified_success'
          : receipt.steps.some(step => step.status === 'blocked')
            ? 'blocked'
            : 'failed',
    completionVerified: complete && applicationMatched && !unknownCommit,
  };
}
