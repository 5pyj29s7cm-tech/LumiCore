import { assertLegalExecutionActive, legalExecutionSignal, legalWrite } from "../../../../legal/execution";
import { type NormalizedMessage, makeLLMCall } from "../../../../llm/providers";
import { getUserPreferredLLMConfig } from "../../../../llm/user_preferences";
import { providerGetterArguments } from "../../../../llm/provider_getters";
import { getDataDirectory } from "../../../../config/data_path";
import path from "path";
import fs from "fs";
import os from "os";

export async function runLegalLLM(prompt: string, context?: any, maxTokens = 2048): Promise<string | null> {
  assertLegalExecutionActive(context);
  const getters = context?.llmGetters;
  if (!getters) return null;
  const userId = context?.userId || 'anonymous';
  const messages: NormalizedMessage[] = [{ role: 'user', content: prompt }];
  const response = await makeLLMCall(
    messages,
    [],
    { ...getUserPreferredLLMConfig(userId, { maxTokens, domain: context?.domain, orgId: context?.orgId }), signal: context?.executionSignal || legalExecutionSignal() },
    ...providerGetterArguments(getters),
  );
  assertLegalExecutionActive(context);
  return response.text || null;
}

export async function runLegalLLMWithin(prompt: string, context: any, maxTokens: number, timeoutMs: number): Promise<string | null> {
  assertLegalExecutionActive(context);
  const controller = new AbortController();
  const parent = context?.executionSignal || legalExecutionSignal();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  parent?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('Legal model subtask timed out.', 'TimeoutError')), timeoutMs);
  try {
    return await runLegalLLM(prompt, { ...context, executionSignal: controller.signal }, maxTokens);
  } catch (error) {
    assertLegalExecutionActive(context);
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timeout);
    parent?.removeEventListener('abort', abort);
  }
}

export const EXTERNAL_LEGAL_SOURCES = [
  {
    label: '国家法律法规数据库',
    presetId: '',
    url: 'https://flk.npc.gov.cn/',
    use: '核验现行有效法律、行政法规、司法解释引用状态',
  },
  {
    label: '人民法院案例库',
    presetId: 'people-court-case-library',
    url: 'https://rmfyalk.court.gov.cn/',
    use: '优先检索权威案例、参考案例和裁判规则',
  },
  {
    label: '中国裁判文书网',
    presetId: 'china-judgments-online',
    url: 'https://wenshu.court.gov.cn/',
    use: '检索同案由、同争议焦点、同法院层级的公开裁判文书',
  },
  {
    label: '法蝉',
    presetId: 'fachan',
    url: 'https://www.fachans.com/',
    use: '在律所授权账号内补充商业库案例、裁判规则和办案资料',
  },
  {
    label: 'Alpha',
    presetId: 'alpha-lawyer',
    url: 'https://alphalawyer.cn/',
    use: '在律所授权账号内补充案例检索、诉讼策略和办案协同资料',
  },
  {
    label: '企查查',
    presetId: 'qichacha',
    url: 'https://www.qcc.com/',
    use: '查询企业基本信息、股东结构、风险信息和财产线索',
  },
  {
    label: '国家企业信用信息公示系统',
    presetId: 'national-enterprise-credit',
    url: 'https://www.gsxt.gov.cn/',
    use: '核验企业登记、公示、经营异常等官方信息',
  },
  {
    label: '人民法院在线服务',
    presetId: 'court-online-service',
    url: 'https://zxfw.court.gov.cn/',
    use: '半自动立案材料组卷后，由律师人工登录、核对、提交',
  },
];

export const LEGAL_REASONING_BASELINE = [
  '三段论是 Lumi 法律工作的核心基础：所有法律任务都必须先形成内部“大前提/小前提/涵摄结论”，再生成用户要求的工作产物。',
  '大前提：先核验现行有效法律、司法解释和可比类案；小前提：将事实、证据、举证责任和质证风险对应到具体法律要件；结论：完成涵摄、风险提示和文书表达。',
  '普通文书和聊天结果不要把“大前提/小前提/结论”“三段论”等方法论标题作为交付内容输出，除非用户明确要求法律分析底稿。',
  '所有未核验法条、未确认类案、未绑定证据的事实必须标注“待检索/待核验/待补证”。',
].join('\n');

export function sanitizeLegalWorkProductOutput(text: string): string {
  return text
    .replace(/底层三段论|三段论检索框架|三段论/g, '法律分析框架')
    .replace(/大前提/g, '法律依据与裁判规则')
    .replace(/小前提/g, '事实与证据')
    .replace(/涵摄/g, '事实适用分析');
}

export function textArg(args: Record<string, any>, key: string): string {
  return String(args[key] || '').trim();
}

export function legalWorkspaceId(args: Record<string, any>, context?: any): string {
  if (context?.domain === 'work') {
    const orgId = String(context.orgId || '').trim();
    if (!orgId) throw new Error('Organization legal work requires an active organization context.');
    return orgId;
  }
  if (context?.domain === 'personal') {
    const userId = String(context.userId || textArg(args, 'userId') || 'anonymous')
      .trim()
      .replace(/[^a-zA-Z0-9_.@-]+/g, '_');
    return `personal:${userId || 'anonymous'}`;
  }

  // ToolRegistry always injects runtime services into context. Their presence
  // alone does not select a personal data domain; preserve an explicit legacy
  // organization id unless the caller supplied an authoritative domain.
  const explicit = textArg(args, 'orgId');
  if (explicit) return explicit;
  const contextualOrgId = String(context?.orgId || '').trim();
  if (contextualOrgId) return contextualOrgId;
  const userId = String(context?.userId || textArg(args, 'userId') || '')
    .replace(/[^a-zA-Z0-9_.@-]+/g, '_');
  return `personal:${userId || 'anonymous'}`;
}

export function listArg(args: Record<string, any>, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\n|,|;|，|；/).map(s => s.trim()).filter(Boolean);
}

export function roleLabel(role: string): '原告' | '被告' | '通用' {
  if (/被告|被申请人|被上诉人|respondent|defendant/i.test(role)) return '被告';
  if (/原告|申请人|上诉人|plaintiff|claimant/i.test(role)) return '原告';
  return '通用';
}

export function buildCaseContext(args: Record<string, any>): string {
  const fields = [
    ['案件名称', textArg(args, 'caseName')],
    ['我方身份', textArg(args, 'role')],
    ['案由/类型', textArg(args, 'caseType')],
    ['管辖/法院', textArg(args, 'court')],
    ['当事人', textArg(args, 'parties')],
    ['诉请/抗辩目标', textArg(args, 'claims') || textArg(args, 'objective')],
    ['事实摘要', textArg(args, 'facts')],
    ['证据材料', textArg(args, 'evidence')],
    ['对方材料', textArg(args, 'opponentMaterials')],
  ];
  return fields
    .filter(([, value]) => value)
    .map(([label, value]) => `- ${label}: ${value}`)
    .join('\n') || '- 待补充案件基础信息';
}

export function buildSearchQueries(args: Record<string, any>): string[] {
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const issues = listArg(args, 'issues');
  const facts = textArg(args, 'facts');
  const seeds = [
    ...issues.map(issue => `${caseType} ${issue}`),
    `${caseType} 争议焦点 裁判规则`,
    `${caseType} 举证责任`,
    `${caseType} 诉讼时效`,
    `${caseType} 证据目录 证明目的`,
  ];
  if (/违约|合同|货款|交付|质量/.test(facts + caseType)) seeds.push(`${caseType} 违约责任 损失 违约金`);
  if (/劳动|工资|解除|加班/.test(facts + caseType)) seeds.push('劳动争议 违法解除 举证责任');
  if (/借款|利息|本金|转账/.test(facts + caseType)) seeds.push('民间借贷 转账凭证 借贷合意');
  return Array.from(new Set(seeds.map(s => s.trim()).filter(Boolean))).slice(0, 10);
}

export function inferDisputeFocuses(args: Record<string, any>): string[] {
  const explicit = listArg(args, 'issues');
  if (explicit.length > 0) return explicit.slice(0, 8);

  const source = [
    textArg(args, 'caseType'),
    textArg(args, 'facts'),
    textArg(args, 'materials'),
    textArg(args, 'complaint'),
    textArg(args, 'evidence'),
    textArg(args, 'transcript'),
    textArg(args, 'trialNotes'),
  ].join(' ');

  if (/劳动|工资|解除|加班|社保|竞业/.test(source)) {
    return ['劳动关系及主体资格', '解除或处分行为是否合法', '工资报酬及补偿金额', '考勤、通知、规章制度和送达证据'];
  }
  if (/借款|本金|利息|转账|还款|担保/.test(source)) {
    return ['借贷合意是否成立', '款项交付与还款情况', '利息、违约金和担保责任', '诉讼时效与催收证据'];
  }
  if (/合同|货款|交付|质量|违约|发票|订单|签收/.test(source)) {
    return ['合同关系及履行事实', '付款条件是否成就及欠款金额', '质量异议或拒付抗辩是否成立', '违约责任、损失和违约金调整'];
  }
  if (/侵权|损害|过错|责任|赔偿|事故/.test(source)) {
    return ['侵权行为及过错认定', '损害事实与因果关系', '赔偿范围和金额依据', '责任比例和减免责事由'];
  }
  return ['法律关系与主体资格', '核心事实是否成立', '证据链完整性与举证责任', '责任承担方式和请求范围'];
}

export function materialSummary(args: Record<string, any>): string {
  const entries = [
    ['起诉状/申请书', textArg(args, 'complaint')],
    ['证据材料', textArg(args, 'evidence')],
    ['庭审笔录/会议记录', textArg(args, 'transcript') || textArg(args, 'trialNotes')],
    ['案件材料', textArg(args, 'materials')],
    ['对方意见', textArg(args, 'opponentArguments') || textArg(args, 'opponentMaterials')],
  ].filter(([, value]) => value);

  if (entries.length === 0) return '- 待补充起诉状、证据、庭审笔录或其他案件材料';
  return entries
    .map(([label, value]) => `- ${label}: ${value.slice(0, 500)}`)
    .join('\n');
}

export const LEGAL_MATERIAL_EXTENSIONS = new Set([
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.csv', '.txt', '.md', '.rtf',
]);

export const LEGAL_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);

export const NOTICE_LINK_MAX_BYTES = 25 * 1024 * 1024;

export function extractFirstUrl(input: string): string {
  const match = input.match(/https?:\/\/[^\s<>"'，。；、）)\]]+/i);
  return match ? match[0].replace(/[。。，，；;、]+$/u, '') : '';
}

export function safeFileSegment(input: string, fallback = 'material'): string {
  const cleaned = String(input || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 90);
  return cleaned || fallback;
}

export function ensureLegalIntakeDir(orgId: string): string {
  return getDataDirectory(path.join('legal_intake', safeFileSegment(orgId || 'default', 'default')));
}

export function ensureLegalDeliveryRoot(orgId: string): string {
  return getDataDirectory(path.join('legal_delivery', safeFileSegment(orgId || 'default', 'default')));
}

export function ensureLegalExternalWorkspaceRoot(orgId: string): string {
  return getDataDirectory(path.join('legal_external_workspaces', safeFileSegment(orgId || 'default', 'default')));
}

function uniqueLegalFolder(baseDir: string, caseName: string, suffix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = safeFileSegment(`${stamp}_${caseName || 'legal'}_${suffix}`, `${stamp}_legal_${suffix}`);
  let candidate = path.join(baseDir, base);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, `${base}_${counter}`);
    counter += 1;
  }
  legalWrite(() => fs.mkdirSync(candidate, { recursive: true }));
  return candidate;
}

export function resolveWritableOutputDir(input: string, fallbackRoot: string, caseName: string, suffix: string): string {
  if (input) {
    const resolved = path.resolve(expandLocalPath(input));
    legalWrite(() => fs.mkdirSync(resolved, { recursive: true }));
    return resolved;
  }
  return uniqueLegalFolder(fallbackRoot, caseName, suffix);
}

export function expandLocalPath(input: string): string {
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return '';
  const home = os.homedir();
  if (/^~(?=$|[\\/])/.test(raw)) return raw.replace(/^~(?=$|[\\/])/, home);
  if (/^(桌面|desktop)(?=$|[\\/])/i.test(raw)) {
    return path.join(home, 'Desktop', raw.replace(/^(桌面|desktop)[\\/]?/i, ''));
  }
  if (/^(文档|documents?)(?=$|[\\/])/i.test(raw)) {
    return path.join(home, 'Documents', raw.replace(/^(文档|documents?)[\\/]?/i, ''));
  }
  return raw;
}
