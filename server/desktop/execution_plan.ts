import crypto from 'node:crypto';
import type { CapabilityExecutionPlan } from '../cognition/capability_execution_plan';
import type { LumiCapabilityLane } from '../cognition/capability_selection';
import {
  normalizeActionIntent,
  type NormalizedSideEffectClass,
} from '../cognition/normalized_action_intent';

export type DesktopApplicationFamily =
  | 'lumi'
  | 'browser'
  | 'office'
  | 'messaging'
  | 'media'
  | 'cad'
  | 'desktop_ai'
  | 'utility'
  | 'unknown';

export type DesktopControlLayer =
  | 'client_native'
  | 'dedicated_adapter'
  | 'browser_dom'
  | 'windows_uia'
  | 'vision';

export type DesktopIdentitySignal =
  | 'process_name'
  | 'executable_path'
  | 'publisher'
  | 'product_name'
  | 'window_class'
  | 'product_version'
  | 'code_signature';

export interface ApplicationCertificationPolicy {
  requiredSignals: DesktopIdentitySignal[];
  publisherPatterns: string[];
  productNamePatterns: string[];
  windowClassPatterns: string[];
  requireValidSignature: boolean;
  versionPolicy: 'observe_exact' | 'unconstrained';
}

export interface DesktopWindowFingerprint {
  title?: string;
  processName?: string;
  processId?: number;
  nativeWindowHandle?: number;
  executablePath?: string;
  publisher?: string;
  productName?: string;
  productVersion?: string;
  windowClass?: string;
  signatureStatus?: string;
}

export interface ApplicationIdentityAssessment {
  matched: boolean;
  certification: 'certified' | 'conditional' | 'mismatch';
  matchedSignals: DesktopIdentitySignal[];
  missingSignals: DesktopIdentitySignal[];
  conflictingSignals: DesktopIdentitySignal[];
  observedVersion?: string;
}

export interface ApplicationIdentity {
  id: string;
  family: DesktopApplicationFamily;
  displayName: string;
  aliases: string[];
  processPatterns: string[];
  /**
   * Generic Windows host processes that may own this app's foreground
   * window. A host match is accepted only together with a matching title, so
   * ApplicationFrameHost.exe by itself can never prove an app identity.
   */
  hostedProcessPatterns?: string[];
  windowTitlePatterns: string[];
  executablePatterns: string[];
  certification: 'certified' | 'conditional' | 'fallback_only';
  certificationPolicy: ApplicationCertificationPolicy;
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
  required: boolean;
  fallbackGroup?: string;
}

export interface WindowIdentity {
  requestedTarget: string;
  processPatterns: string[];
  titlePatterns: string[];
  requireFreshFingerprint: boolean;
  maxObservationAgeMs: number;
}

export interface DesktopVerificationSpec {
  profile: 'open' | 'read' | 'edit' | 'save' | 'send' | 'generic';
  requireApplicationMatch: boolean;
  requireWindowFingerprint: boolean;
  requireTerminalEvidence: boolean;
  requiredSignals: string[];
}

function desktopVerificationProfile(input: {
  text: string;
  operation: string;
  intentKind?: string;
  sideEffectClass: NormalizedSideEffectClass;
}): DesktopVerificationSpec['profile'] {
  // i18n-allow: Reviewed multilingual desktop send/submit intent recognition; not user-visible copy.
  if (input.intentKind === 'messaging_send' || (
    input.sideEffectClass === 'external_commit'
    && /(?:send|message|reply|publish|submit|发送|回复|发布|提交)/iu.test(input.text) // i18n-allow: Reviewed multilingual desktop send/submit input recognition.
  )) return 'send';
  // i18n-allow: Reviewed multilingual desktop open/focus intent recognition; not user-visible copy.
  if (input.operation === 'navigate' || /(?:^|\s)(?:open|launch|focus)(?:\s|$)|(?:打开|启动|聚焦)/iu.test(input.text)) return 'open';
  if (['read', 'status', 'explain'].includes(input.operation)) return 'read';
  // i18n-allow: Reviewed multilingual desktop save/export intent recognition; not user-visible copy.
  if (/(?:save|export|保存|另存|导出)/iu.test(input.text)) return 'save';
  if (input.operation === 'create' || input.operation === 'mutate') return 'edit';
  return 'generic';
}

function verificationSignals(profile: DesktopVerificationSpec['profile']): string[] {
  if (profile === 'open') return [
    'matching foreground application identity after focus/open',
    'fresh window fingerprint',
  ];
  if (profile === 'read') return [
    'matching application identity',
    'fresh content observation or adapter read receipt',
  ];
  if (profile === 'edit') return [
    'verified adapter/UIA mutation receipt',
    'fresh post-action state differs as requested',
  ];
  if (profile === 'save') return [
    'verified save/export receipt',
    'artifact path or content hash and post-save state',
  ];
  if (profile === 'send') return [
    'certified target application identity',
    'confirmation-bound target and payload digest',
    'idempotency-bound delivery or submission receipt',
    'fresh post-commit observation',
  ];
  return ['matching application identity', 'verified terminal receipt'];
}

export interface DesktopRecoveryPolicy {
  maxObservationRetries: number;
  refocusOnMismatch: boolean;
  replanOnWindowChange: true;
  stopOnTargetMismatch: true;
  stopOnUnknownOutcome: true;
  allowLegacyRoute: false;
  allowVisionCommit: false;
  triggers: Array<'popup' | 'occlusion' | 'dpi_change' | 'display_change' | 'window_move' | 'application_restart' | 'login_expired'>;
}

export interface DesktopExecutionPlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  application: ApplicationIdentity;
  expectedWindow: WindowIdentity;
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
  applicationCertification?: ApplicationIdentityAssessment['certification'];
  applicationVersion?: string;
  steps: DesktopStepReceipt[];
  finalState: 'verified_success' | 'failed' | 'blocked' | 'unknown_outcome' | 'target_mismatch';
  evidence: string[];
  completionVerified: boolean;
}

function certificationPolicy(input: Partial<ApplicationCertificationPolicy> & {
  publisherPatterns?: string[];
  productNamePatterns?: string[];
}): ApplicationCertificationPolicy {
  const publisherPatterns = input.publisherPatterns || [];
  const productNamePatterns = input.productNamePatterns || [];
  const windowClassPatterns = input.windowClassPatterns || [];
  const requiredSignals = input.requiredSignals || [
    'process_name',
    'executable_path',
    ...(publisherPatterns.length ? ['publisher' as const] : []),
    ...(productNamePatterns.length ? ['product_name' as const] : []),
    ...(windowClassPatterns.length ? ['window_class' as const] : []),
    ...(input.versionPolicy === 'unconstrained' ? [] : ['product_version' as const]),
    ...(input.requireValidSignature === false ? [] : ['code_signature' as const]),
  ];
  return {
    requiredSignals,
    publisherPatterns,
    productNamePatterns,
    windowClassPatterns,
    requireValidSignature: input.requireValidSignature !== false,
    versionPolicy: input.versionPolicy || 'observe_exact',
  };
}

const CERTIFICATION_POLICIES = {
  lumi: certificationPolicy({
    productNamePatterns: ['lumi', 'lumicore', 'lumios'],
    requireValidSignature: false,
  }),
  chrome: certificationPolicy({
    publisherPatterns: ['google llc', 'google inc'],
    productNamePatterns: ['google chrome'],
    windowClassPatterns: ['chrome_widgetwin_*'],
  }),
  edge: certificationPolicy({
    publisherPatterns: ['microsoft corporation'],
    productNamePatterns: ['microsoft edge'],
    windowClassPatterns: ['chrome_widgetwin_*'],
  }),
  firefox: certificationPolicy({
    publisherPatterns: ['mozilla corporation', 'mozilla foundation'],
    productNamePatterns: ['firefox'],
    windowClassPatterns: ['mozillawindowclass'],
  }),
  browser: certificationPolicy({
    publisherPatterns: ['google llc', 'google inc', 'microsoft corporation', 'mozilla corporation', 'mozilla foundation'],
    productNamePatterns: ['google chrome', 'microsoft edge', 'firefox'],
    windowClassPatterns: ['chrome_widgetwin_*', 'mozillawindowclass'],
  }),
  wps: certificationPolicy({
    publisherPatterns: ['kingsoft', 'zhuhai kingsoft office software'],
    productNamePatterns: ['wps office', 'wps writer', 'wps spreadsheets', 'wps presentation'],
  }),
  microsoftOffice: certificationPolicy({
    publisherPatterns: ['microsoft corporation'],
    productNamePatterns: ['microsoft office', 'microsoft word', 'microsoft excel', 'microsoft powerpoint'],
  }),
  office: certificationPolicy({
    publisherPatterns: ['kingsoft', 'zhuhai kingsoft office software', 'microsoft corporation'],
    productNamePatterns: ['wps office', 'wps writer', 'wps spreadsheets', 'wps presentation', 'microsoft office', 'microsoft word', 'microsoft excel', 'microsoft powerpoint'],
  }),
  wechat: certificationPolicy({
    publisherPatterns: ['tencent', 'tencent technology'],
    productNamePatterns: ['wechat', 'weixin'],
  }),
  neteaseMusic: certificationPolicy({
    requiredSignals: ['process_name'],
    requireValidSignature: false,
    versionPolicy: 'unconstrained',
  }),
  autocad: certificationPolicy({
    publisherPatterns: ['autodesk'],
    productNamePatterns: ['autocad'],
  }),
  chatgpt: certificationPolicy({
    publisherPatterns: ['openai'],
    productNamePatterns: ['chatgpt'],
  }),
  claude: certificationPolicy({
    publisherPatterns: ['anthropic'],
    productNamePatterns: ['claude'],
  }),
  codex: certificationPolicy({
    publisherPatterns: ['openai'],
    productNamePatterns: ['codex'],
  }),
  gemini: certificationPolicy({
    publisherPatterns: ['google llc', 'google inc'],
    productNamePatterns: ['gemini'],
  }),
  desktopAi: certificationPolicy({
    publisherPatterns: ['openai', 'anthropic', 'google llc', 'google inc'],
    productNamePatterns: ['chatgpt', 'claude', 'codex', 'gemini'],
  }),
  calculator: certificationPolicy({
    requiredSignals: ['process_name'],
    requireValidSignature: false,
    versionPolicy: 'unconstrained',
  }),
  unknown: certificationPolicy({
    requiredSignals: ['process_name', 'executable_path'],
    requireValidSignature: false,
    versionPolicy: 'unconstrained',
  }),
} satisfies Record<string, ApplicationCertificationPolicy>;

export const DESKTOP_APPLICATION_REGISTRY: readonly ApplicationIdentity[] = [
  {
    id: 'lumi-client',
    family: 'lumi',
    displayName: 'Lumi desktop client',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['lumi', 'lumicore', 'lumios', '聊天界面', '知识库', '设置'],
    processPatterns: ['lumi', 'lumi-core', 'lumi-os'],
    windowTitlePatterns: ['lumi', 'lumicore', 'lumios'],
    executablePatterns: ['lumi*.exe'],
    certification: 'certified',
    certificationPolicy: CERTIFICATION_POLICIES.lumi,
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
    certificationPolicy: CERTIFICATION_POLICIES.chrome,
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
    certificationPolicy: CERTIFICATION_POLICIES.edge,
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
    certificationPolicy: CERTIFICATION_POLICIES.firefox,
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
    certificationPolicy: CERTIFICATION_POLICIES.browser,
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
    certificationPolicy: CERTIFICATION_POLICIES.wps,
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
    certificationPolicy: CERTIFICATION_POLICIES.wps,
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
    certificationPolicy: CERTIFICATION_POLICIES.wps,
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
    certificationPolicy: CERTIFICATION_POLICIES.microsoftOffice,
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
    certificationPolicy: CERTIFICATION_POLICIES.microsoftOffice,
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
    certificationPolicy: CERTIFICATION_POLICIES.microsoftOffice,
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
    certificationPolicy: CERTIFICATION_POLICIES.office,
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
    certificationPolicy: CERTIFICATION_POLICIES.wechat,
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'netease-cloud-music',
    family: 'media',
    displayName: 'NetEase Cloud Music',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['netease cloud music', 'netease music', 'cloudmusic', '网易云音乐', '网易云'],
    processPatterns: ['cloudmusic'],
    // A playing track may replace the product name in the window title, so
    // the native process identity is the authoritative signal.
    // i18n-allow: Reviewed multilingual application fingerprints for exact target matching.
    windowTitlePatterns: ['netease cloud music', 'cloudmusic', '网易云音乐'],
    executablePatterns: ['cloudmusic.exe'],
    certification: 'conditional',
    certificationPolicy: CERTIFICATION_POLICIES.neteaseMusic,
    controlLayers: ['windows_uia', 'vision'],
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
    certificationPolicy: CERTIFICATION_POLICIES.autocad,
    controlLayers: ['dedicated_adapter', 'windows_uia', 'vision'],
  },
  {
    id: 'windows-calculator',
    family: 'utility',
    displayName: 'Windows Calculator',
    // i18n-allow: Reviewed multilingual application aliases for exact target matching.
    aliases: ['windows calculator', 'microsoft calculator', 'calculator', 'windows 计算器', '计算器'],
    processPatterns: ['calculatorapp', 'calculator'],
    hostedProcessPatterns: ['applicationframehost'],
    windowTitlePatterns: ['windows calculator', 'calculator', '计算器'],
    executablePatterns: ['calculatorapp.exe', 'calculator.exe'],
    certification: 'conditional',
    certificationPolicy: CERTIFICATION_POLICIES.calculator,
    controlLayers: ['windows_uia', 'vision'],
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
    certificationPolicy: CERTIFICATION_POLICIES.chatgpt,
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
    certificationPolicy: CERTIFICATION_POLICIES.claude,
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
    certificationPolicy: CERTIFICATION_POLICIES.codex,
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
    certificationPolicy: CERTIFICATION_POLICIES.gemini,
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
    certificationPolicy: CERTIFICATION_POLICIES.desktopAi,
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
  certificationPolicy: CERTIFICATION_POLICIES.unknown,
  controlLayers: ['windows_uia', 'vision'],
};

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cloneApplicationIdentity(application: ApplicationIdentity): ApplicationIdentity {
  return {
    ...application,
    aliases: [...application.aliases],
    processPatterns: [...application.processPatterns],
    ...(application.hostedProcessPatterns
      ? { hostedProcessPatterns: [...application.hostedProcessPatterns] }
      : {}),
    windowTitlePatterns: [...application.windowTitlePatterns],
    executablePatterns: [...application.executablePatterns],
    certificationPolicy: {
      ...application.certificationPolicy,
      requiredSignals: [...application.certificationPolicy.requiredSignals],
      publisherPatterns: [...application.certificationPolicy.publisherPatterns],
      productNamePatterns: [...application.certificationPolicy.productNamePatterns],
      windowClassPatterns: [...application.certificationPolicy.windowClassPatterns],
    },
    controlLayers: [...application.controlLayers],
  };
}

export function resolveDesktopApplicationIdentity(
  text: string,
  lane?: LumiCapabilityLane,
): ApplicationIdentity {
  const normalized = String(text || '').toLowerCase();
  // i18n-allow: Reviewed multilingual local artifact target recognition; not user-visible copy.
  const fileOrArtifactTarget = /(?:[a-z]:[\\/]|(?:^|[\\/])[^\\/]+\.(?:pdf|pptx?|docx?|xlsx?|dwg|dxf|txt|md|csv|zip)|\b(?:pdf|pptx?|docx?|xlsx?|dwg|dxf|file|folder|document|presentation|spreadsheet|drawing)\b|文件夹|文件|资料|文档|图纸|演示文稿)/iu.test(normalized);
  // i18n-allow: Reviewed multilingual Lumi client-surface recognition; not user-visible copy.
  const explicitLumiClientTarget = /(?:lumi\s*(?:os|客户端|client|界面|窗口)|聊天界面|客户端(?:的|里)?(?:知识库|设置|聊天|壁纸)|client_action)/iu.test(normalized);
  // Prefer the semantic target of the requested desktop action over nouns in
  // the follow-on payload. In "Open WPS and create a Word document", WPS is
  // the application identity while Word is the requested document type.
  const normalizedIntent = normalizeActionIntent(text);
  const semanticTarget = normalizedIntent.kind === 'desktop_operation'
    ? String(normalizedIntent.target || '').trim().toLowerCase()
    : '';
  const semanticApplication = semanticTarget
    ? DESKTOP_APPLICATION_REGISTRY
        .flatMap(application => application.aliases
          .filter(alias => desktopTextMatchesAlias(semanticTarget, alias))
          .filter(() => application.family !== 'lumi' || !fileOrArtifactTarget || explicitLumiClientTarget)
          .map(alias => ({ application, aliasLength: alias.length })))
        .sort((left, right) => right.aliasLength - left.aliasLength)[0]?.application
    : undefined;
  if (semanticApplication) return cloneApplicationIdentity(semanticApplication);
  const explicit = DESKTOP_APPLICATION_REGISTRY
    .flatMap(application => application.aliases
      .filter(alias => desktopTextMatchesAlias(normalized, alias))
      // A document or directory whose name contains "Lumi" is a local
      // target, not the Lumi client. This production misclassification built
      // a client-native plan and consequently forbade desktop_open.
      .filter(() => application.family !== 'lumi' || !fileOrArtifactTarget || explicitLumiClientTarget)
      .map(alias => ({ application, aliasLength: alias.length })))
    .sort((left, right) => right.aliasLength - left.aliasLength)[0]?.application;
  if (explicit) return cloneApplicationIdentity(explicit);
  const inferredId = lane === 'design_cad'
    ? 'autocad-desktop'
    : lane === 'web_or_account'
      ? 'desktop-browser'
      : undefined;
  const inferred = inferredId
    ? DESKTOP_APPLICATION_REGISTRY.find(application => application.id === inferredId)
    : undefined;
  const chosen = inferred || UNKNOWN_APPLICATION;
  return cloneApplicationIdentity(chosen);
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

function textMatchesPattern(value: string, pattern: string): boolean {
  const normalizedValue = String(value || '').trim().toLowerCase().replace(/\\/g, '/');
  const normalizedPattern = String(pattern || '').trim().toLowerCase().replace(/\\/g, '/');
  if (!normalizedValue || !normalizedPattern) return false;
  const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return normalizedPattern.includes('*')
    ? new RegExp(`^${escaped}$`, 'i').test(normalizedValue)
    : normalizedValue.includes(normalizedPattern);
}

function signalMatchesPatterns(value: string, patterns: string[]): boolean {
  return patterns.length === 0 || patterns.some(pattern => textMatchesPattern(value, pattern));
}

export function assessDesktopApplicationIdentity(
  fingerprint: DesktopWindowFingerprint | null | undefined,
  application: ApplicationIdentity,
): ApplicationIdentityAssessment {
  const matchedSignals: DesktopIdentitySignal[] = [];
  const missingSignals: DesktopIdentitySignal[] = [];
  const conflictingSignals: DesktopIdentitySignal[] = [];
  if (!fingerprint || application.family === 'unknown') {
    return { matched: false, certification: 'mismatch', matchedSignals, missingSignals, conflictingSignals };
  }

  const policy = application.certificationPolicy;
  const processName = String(fingerprint.processName || '').trim();
  const executablePath = String(fingerprint.executablePath || '').trim();
  const executableName = executablePath.replace(/\\/g, '/').split('/').pop() || '';
  const processMatched = Boolean(processName) && (
    application.processPatterns.some(pattern => processMatchesPattern(processName, pattern))
    || application.executablePatterns.some(pattern => processMatchesPattern(processName, pattern))
  );
  const hostedProcessMatched = Boolean(processName)
    && Boolean(application.hostedProcessPatterns?.some(pattern => processMatchesPattern(processName, pattern)));
  const hostedWindowTitleMatched = hostedProcessMatched
    && application.windowTitlePatterns.some(pattern => titleMatchesPattern(fingerprint.title || '', pattern));
  const effectiveProcessMatched = processMatched || hostedWindowTitleMatched;
  const executableMatched = Boolean(executablePath) && application.executablePatterns.some(
    pattern => processMatchesPattern(executableName, pattern),
  );

  const evaluate = (
    signal: DesktopIdentitySignal,
    value: string,
    matches: boolean,
  ): void => {
    if (!value) {
      if (policy.requiredSignals.includes(signal)) missingSignals.push(signal);
      return;
    }
    (matches ? matchedSignals : conflictingSignals).push(signal);
  };

  evaluate('process_name', processName, effectiveProcessMatched);
  evaluate('executable_path', executablePath, executableMatched);
  evaluate(
    'publisher',
    String(fingerprint.publisher || ''),
    signalMatchesPatterns(String(fingerprint.publisher || ''), policy.publisherPatterns),
  );
  evaluate(
    'product_name',
    String(fingerprint.productName || ''),
    signalMatchesPatterns(String(fingerprint.productName || ''), policy.productNamePatterns),
  );
  evaluate(
    'window_class',
    String(fingerprint.windowClass || ''),
    signalMatchesPatterns(String(fingerprint.windowClass || ''), policy.windowClassPatterns),
  );
  evaluate('product_version', String(fingerprint.productVersion || ''), true);
  const signatureStatus = String(fingerprint.signatureStatus || '').trim();
  evaluate(
    'code_signature',
    signatureStatus,
    !policy.requireValidSignature || /^(?:valid|trusted|signed_valid)$/i.test(signatureStatus),
  );

  // Process and executable path are authoritative. A browser tab or renamed
  // executable must never inherit identity from a matching window title.
  const strongIdentityMatched = processName
    ? effectiveProcessMatched
    : executablePath
      ? executableMatched
      : application.windowTitlePatterns.some(pattern => titleMatchesPattern(fingerprint.title || '', pattern));
  const matched = strongIdentityMatched && conflictingSignals.length === 0;
  const certification = !matched
    ? 'mismatch'
    : missingSignals.length === 0
      ? 'certified'
      : 'conditional';
  return {
    matched,
    certification,
    matchedSignals,
    missingSignals,
    conflictingSignals,
    ...(fingerprint.productVersion ? { observedVersion: fingerprint.productVersion } : {}),
  };
}

export function desktopFingerprintMatchesApplication(
  fingerprint: DesktopWindowFingerprint | null | undefined,
  application: ApplicationIdentity,
): boolean {
  return assessDesktopApplicationIdentity(fingerprint, application).matched;
}

export function desktopFingerprintMatchesRequestedTarget(
  fingerprint: DesktopWindowFingerprint | null | undefined,
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
  if (processName && requestedProcess && /^[A-Za-z0-9_.+-]+$/.test(requested.trim())) {
    return processName === requestedProcess;
  }
  const leaf = String(target || '').replace(/\\/g, '/').split('/').pop() || '';
  const naturalLeaf = leaf
    // i18n-allow: Reviewed Chinese folder-containment phrase recognition; not user-visible copy.
    .split(/(?:文件夹)?(?:里的|中的|里|中)/u)
    .filter(Boolean)
    .pop() || leaf;
  const titleNeedle = naturalLeaf
    // i18n-allow: Reviewed Chinese desktop command-prefix recognition; not user-visible copy.
    .replace(/^(?:请|帮我|现在|直接)?(?:打开|启动|运行|查看|读取)\s*/u, '')
    .replace(/\.(?:pdf|pptx?|docx?|xlsx?|dwg|dxf|txt|md|csv)$/i, '')
    .replace(/[。！？，,]+$/u, '')
    .trim()
    .toLowerCase();
  return Boolean(
    processName
    && titleNeedle.length >= 2
    && String(fingerprint.title || '').toLowerCase().includes(titleNeedle)
  );
}

function toolsForLayer(layer: DesktopControlLayer, family: DesktopApplicationFamily): string[] {
  if (layer === 'client_native') return ['client_get_state', 'client_action'];
  if (layer === 'browser_dom') return ['mcp_playwright_browser_snapshot', 'mcp_playwright_browser_click', 'mcp_playwright_browser_type'];
  if (layer === 'windows_uia') return [
    'desktop_active_window',
    'desktop_ui_snapshot',
    'desktop_ui_focus',
    'desktop_ui_invoke',
    'desktop_ui_click',
    'desktop_ui_type',
    'keyboard_press',
    'desktop_keyboard_press',
  ];
  if (layer === 'vision') return [
    'desktop_capture_screen',
    'computer_use',
    'mouse_move',
    'mouse_click',
    'mouse_drag',
    'keyboard_type',
    'keyboard_press',
  ];
  if (family === 'cad') return ['cad_prepare_autocad_operations', 'cad_draw_floorplan_in_autocad', 'mcp_cad-drafting_autocad_new_document', 'mcp_cad-drafting_autocad_playback_file'];
  if (family === 'office') return ['wps_create_document_with_text', 'desktop_ui_snapshot', 'desktop_ui_type'];
  if (family === 'messaging') return ['wechat_read_recent_chat', 'wechat_send_message'];
  if (family === 'desktop_ai') return ['desktop_ai_ask', 'desktop_ai_collect_answer'];
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
  const requestedTarget = String(input.capabilityExecutionPlan?.intent.target || input.text || '').trim();
  const sideEffectClass = input.capabilityExecutionPlan?.risk.sideEffectClass || 'none';
  const operation = input.capabilityExecutionPlan?.intent.operation || 'mutate';
  const verificationProfile = desktopVerificationProfile({
    text: input.text,
    operation,
    intentKind: input.capabilityExecutionPlan?.intent.kind,
    sideEffectClass,
  });
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
    required: true,
  }];
  steps.push({
    stepId: 'focus-or-open-target',
    operation: 'focus_or_open',
    layer: application.family === 'lumi' ? 'client_native' : 'windows_uia',
    allowedTools: application.family === 'lumi'
      ? ['client_action', 'desktop_show_lumi_window']
      : ['desktop_open', 'desktop_window_control', 'desktop_ui_focus'],
    preconditions: ['target identity resolved from the newest request'],
    expectedEvidence: ['matching foreground application after focus/open'],
    sideEffectClass: 'none',
    requiresFreshObservation: false,
    invalidatesOnWindowChange: true,
    requiresConfirmation: false,
    required: false,
  });
  effectiveLayers.forEach((layer, index) => {
    if (layer === 'vision' && sideEffectClass === 'external_commit') return;
    steps.push({
      stepId: `act-${index + 1}-${layer}`,
      operation: sideEffectClass === 'external_commit' ? 'commit' : 'act',
      layer,
      allowedTools: toolsForLayer(layer, application.family),
      preconditions: ['target application matched', 'fresh active-window fingerprint'],
      expectedEvidence: verificationSignals(verificationProfile),
      sideEffectClass,
      requiresFreshObservation: true,
      invalidatesOnWindowChange: true,
      requiresConfirmation: sideEffectClass === 'external_commit',
      required: false,
      fallbackGroup: 'desktop-actuation',
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
    required: true,
  });
  return {
    schemaVersion: 1,
    planId: `desktop_${digest({ taskId, application: application.id, sideEffectClass, steps: steps.map(step => step.stepId) }).slice(0, 24)}`,
    taskId,
    application,
    expectedWindow: {
      requestedTarget,
      processPatterns: [...application.processPatterns, ...application.executablePatterns],
      titlePatterns: [...application.windowTitlePatterns],
      requireFreshFingerprint: application.family !== 'lumi',
      maxObservationAgeMs: 15_000,
    },
    operation,
    steps,
    sideEffectClass,
    verification: {
      profile: verificationProfile,
      requireApplicationMatch: true,
      requireWindowFingerprint: application.family !== 'lumi',
      requireTerminalEvidence: true,
      requiredSignals: application.family === 'lumi'
        ? ['verified client state', ...verificationSignals(verificationProfile)]
        : verificationSignals(verificationProfile),
    },
    recovery: {
      maxObservationRetries: sideEffectClass === 'external_commit' ? 0 : 2,
      refocusOnMismatch: sideEffectClass !== 'external_commit',
      replanOnWindowChange: true,
      stopOnTargetMismatch: true,
      stopOnUnknownOutcome: true,
      allowLegacyRoute: false,
      allowVisionCommit: false,
      triggers: ['popup', 'occlusion', 'dpi_change', 'display_change', 'window_move', 'application_restart', 'login_expired'],
    },
  };
}

export function verifyDesktopExecutionReceipt(
  plan: DesktopExecutionPlan,
  receipt: Omit<DesktopExecutionReceipt, 'completionVerified' | 'finalState'>,
): DesktopExecutionReceipt {
  const requiredStepIds = new Set(plan.steps.filter(step => step.required).map(step => step.stepId));
  const received = new Map(receipt.steps.map(step => [step.stepId, step]));
  const requiredComplete = Array.from(requiredStepIds).every(stepId => received.get(stepId)?.status === 'verified');
  const actuationSteps = plan.steps.filter(step => (
    step.operation === 'focus_or_open' || step.operation === 'act' || step.operation === 'commit'
  ));
  const actuationComplete = ['read', 'status', 'explain'].includes(plan.operation)
    || actuationSteps.some(step => received.get(step.stepId)?.status === 'verified');
  const complete = requiredComplete && actuationComplete;
  const verifiedPostOpen = plan.verification.profile === 'open'
    && plan.steps.some(step => (
      step.operation === 'focus_or_open'
      && received.get(step.stepId)?.status === 'verified'
      && received.get(step.stepId)?.applicationMatched === true
    ))
    && received.get('verify-result')?.status === 'verified';
  const applicationMatched = receipt.applicationMatched
    && receipt.steps
      .filter(step => (
        (requiredStepIds.has(step.stepId) || step.status === 'verified')
        && !(verifiedPostOpen && step.stepId === 'observe-target')
      ))
      .every(step => step.applicationMatched);
  const identityBound = receipt.planId === plan.planId && receipt.taskId === plan.taskId;
  const unknownCommit = plan.sideEffectClass === 'external_commit'
    && receipt.steps.some(step => step.status === 'unknown');
  const targetMismatch = !applicationMatched || !identityBound;
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
