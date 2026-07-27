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
    aliases: ['lumi', 'lumios', '聊天界面', '知识库', '设置'],
    processPatterns: ['lumi', 'lumi-os'],
    windowTitlePatterns: ['lumi', 'lumios'],
    executablePatterns: ['lumi*.exe'],
    certification: 'certified',
    controlLayers: ['client_native'],
  },
  {
    id: 'desktop-browser',
    family: 'browser',
    displayName: 'Certified desktop browser',
    aliases: ['browser', '浏览器', 'edge', 'chrome', '网页', '网站'],
    processPatterns: ['msedge', 'chrome', 'firefox'],
    windowTitlePatterns: ['microsoft edge', 'google chrome', 'mozilla firefox'],
    executablePatterns: ['msedge.exe', 'chrome.exe', 'firefox.exe'],
    certification: 'certified',
    controlLayers: ['browser_dom', 'windows_uia', 'vision'],
  },
  {
    id: 'office-suite',
    family: 'office',
    displayName: 'WPS / Microsoft Office',
    aliases: ['wps', 'word', 'excel', 'powerpoint', 'office', '文档', '表格', '演示文稿'],
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
    aliases: ['wechat', 'weixin', '微信'],
    processPatterns: ['wechat', 'weixin'],
    windowTitlePatterns: ['微信', 'wechat'],
    executablePatterns: ['wechat.exe', 'weixin.exe'],
    certification: 'conditional',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'autocad-desktop',
    family: 'cad',
    displayName: 'AutoCAD',
    aliases: ['autocad', 'cad', 'dwg', '图纸', '平面图'],
    processPatterns: ['acad'],
    windowTitlePatterns: ['autocad'],
    executablePatterns: ['acad.exe'],
    certification: 'certified',
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'desktop-ai-client',
    family: 'desktop_ai',
    displayName: 'Desktop AI client',
    aliases: ['desktop ai', '桌面ai', 'codex', 'claude', 'chatgpt', 'gemini'],
    processPatterns: ['chatgpt', 'claude', 'codex', 'gemini'],
    windowTitlePatterns: ['chatgpt', 'claude', 'codex', 'gemini'],
    executablePatterns: ['chatgpt*.exe', 'claude*.exe', 'codex*.exe'],
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
  const explicit = DESKTOP_APPLICATION_REGISTRY.find(application => (
    application.aliases.some(alias => normalized.includes(alias.toLowerCase()))
  ));
  if (explicit) return { ...explicit, aliases: [...explicit.aliases], processPatterns: [...explicit.processPatterns], windowTitlePatterns: [...explicit.windowTitlePatterns], executablePatterns: [...explicit.executablePatterns], controlLayers: [...explicit.controlLayers] };
  const family = lane === 'design_cad'
    ? 'cad'
    : lane === 'web_or_account'
      ? 'browser'
      : undefined;
  const inferred = family
    ? DESKTOP_APPLICATION_REGISTRY.find(application => application.family === family)
    : undefined;
  const chosen = inferred || UNKNOWN_APPLICATION;
  return { ...chosen, aliases: [...chosen.aliases], processPatterns: [...chosen.processPatterns], windowTitlePatterns: [...chosen.windowTitlePatterns], executablePatterns: [...chosen.executablePatterns], controlLayers: [...chosen.controlLayers] };
}

function matchesPattern(value: string, pattern: string): boolean {
  const normalizedValue = String(value || '').trim().toLowerCase();
  const normalizedPattern = String(pattern || '').trim().toLowerCase().replace(/\*/g, '');
  return Boolean(normalizedValue && normalizedPattern && normalizedValue.includes(normalizedPattern));
}

export function desktopFingerprintMatchesApplication(
  fingerprint: { title?: string; processName?: string } | null | undefined,
  application: ApplicationIdentity,
): boolean {
  if (!fingerprint || application.family === 'unknown') return false;
  const processMatched = application.processPatterns.some(pattern => matchesPattern(fingerprint.processName || '', pattern))
    || application.executablePatterns.some(pattern => matchesPattern(fingerprint.processName || '', pattern));
  const titleMatched = application.windowTitlePatterns.some(pattern => matchesPattern(fingerprint.title || '', pattern));
  return processMatched || titleMatched;
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
