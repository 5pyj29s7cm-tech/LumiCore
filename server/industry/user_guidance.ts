import { DESIGN_CAPABILITY_IDENTITY } from '../regions/packs/cn/industry_capability_profile';
import { readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import {
  isCurrentIndustryWorkflowExecutionRequest,
  matchCurrentIndustryWorkflow,
} from '../regions/packs/cn/industry_capability_profile';
import { isDesignProjectStatusRequest } from '../design/status_intent';

export function isCurrentIndustryGuidanceRequest(text: unknown): boolean {
  const value = String(text || '').trim();
  if (isDesignProjectStatusRequest(value)) return false;
  const workflowMatch = matchCurrentIndustryWorkflow(value);
  if (workflowMatch && !isCurrentIndustryWorkflowExecutionRequest(value)) {
    if (isIndustryGuidanceRequest(value)) return true;
    // i18n-allow: Edition-specific capability questions; not user-visible copy.
    if (/(?:是什么|能做什么|支持(?:吗|么|哪些)?|有什么用|怎么用|如何使用)|\b(?:what\s+is|what\s+can|does\s+it\s+support|is\s+.+\s+supported)\b/iu.test(value)) {
      return true;
    }
  }
  if (!isIndustryGuidanceRequest(value)) return false;
  // i18n-allow: Reviewed onboarding and exact-edition input recognition.
  return /(?:\u7b2c\u4e00\u6b21\u4f7f\u7528|\u65b0\u624b|\u5165\u95e8|\u6559\u6211|\u5e26\u6211|\u4ece\u54ea(?:\u91cc)?\u5f00\u59cb|\u4e0b\u4e00\u6b65(?:\u600e\u4e48|\u5e94\u8be5)|(?:lumi|\u5b9a\u5236\u7248|\u8fd9\u4e2a\u7248\u672c).{0,18}\u600e\u4e48\u7528|\b(?:onboarding|teach\s+me|guide\s+me|walk\s+me\s+through|getting\s+started|what\s+should\s+i\s+do\s+next)\b)/iu.test(value);
}

export type IndustryGuidanceLevel = 'beginner' | 'skilled' | 'professional';
export type IndustryGuidanceMode = 'explain' | 'guided' | 'delegate';

export interface IndustryGuidanceScope {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
}

export interface IndustryGuidancePreference {
  level: IndustryGuidanceLevel;
  mode: IndustryGuidanceMode;
  familiarEntryIds: string[];
  updatedAt: string;
}

const SETTINGS_KEY = 'industry_guidance_preferences_v1';
const DEFAULT_PREFERENCE: IndustryGuidancePreference = {
  level: 'beginner',
  mode: 'explain',
  familiarEntryIds: [],
  updatedAt: '',
};

function preferenceKey(scope: IndustryGuidanceScope): string {
  const domainId = scope.domain === 'work'
    ? `work:${String(scope.orgId || '').trim() || 'unbound'}`
    : 'personal';
  return [
    DESIGN_CAPABILITY_IDENTITY.variantId,
    domainId,
    String(scope.userId || '').trim() || 'anonymous',
  ].join(':');
}

function readStore(db: any): Record<string, IndustryGuidancePreference> {
  const raw = (db.settings || []).find((row: any) => row.key === SETTINGS_KEY)?.value;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(db: any, store: Record<string, IndustryGuidancePreference>): void {
  if (!Array.isArray(db.settings)) db.settings = [];
  const value = JSON.stringify(store);
  const row = db.settings.find((item: any) => item.key === SETTINGS_KEY);
  if (row) row.value = value;
  else db.settings.push({ key: SETTINGS_KEY, value });
}

export function getIndustryGuidancePreference(
  scope: IndustryGuidanceScope,
): IndustryGuidancePreference {
  const stored = readStore(readDatabaseTables(["settings"]))[preferenceKey(scope)];
  return {
    ...DEFAULT_PREFERENCE,
    ...(stored || {}),
    familiarEntryIds: Array.from(new Set(
      Array.isArray(stored?.familiarEntryIds) ? stored.familiarEntryIds.map(String) : [],
    )),
  };
}

export function setIndustryGuidancePreference(
  scope: IndustryGuidanceScope,
  patch: Partial<Pick<IndustryGuidancePreference, 'level' | 'mode'>>
    & { familiarEntryId?: string },
): IndustryGuidancePreference {
  const db = readDatabaseTables(["settings"]);
  const store = readStore(db);
  const key = preferenceKey(scope);
  const current = getIndustryGuidancePreference(scope);
  const familiarEntryId = String(patch.familiarEntryId || '').trim();
  const next: IndustryGuidancePreference = {
    level: patch.level || current.level,
    mode: patch.mode || current.mode,
    familiarEntryIds: familiarEntryId
      ? Array.from(new Set([...current.familiarEntryIds, familiarEntryId]))
      : current.familiarEntryIds,
    updatedAt: new Date().toISOString(),
  };
  store[key] = next;
  saveStore(db, store);
  commitDatabaseTables(db);
  return { ...next, familiarEntryIds: [...next.familiarEntryIds] };
}

export function isIndustryGuidanceRequest(text: unknown): boolean {
  const value = String(text || '').trim();
  if (!value) return false;
  return /(?:\u600e\u4e48\u7528|\u5982\u4f55\u4f7f\u7528|\u4f7f\u7528\u65b9\u6cd5|\u64cd\u4f5c\u6d41\u7a0b|\u6559\u6211|\u5e26\u6211|\u5f15\u5bfc|\u7b2c\u4e00\u6b21\u4f7f\u7528|\u65b0\u624b|\u5165\u95e8|\u6211\u4e0d\u4f1a|\u4e0d\u77e5\u9053\u600e\u4e48|\u4ece\u54ea(?:\u91cc)?\u5f00\u59cb|\u4e0b\u4e00\u6b65(?:\u600e\u4e48|\u5e94\u8be5)|\b(?:how\s+to|tutorial|onboarding|teach\s+me|guide\s+me|walk\s+me\s+through|getting\s+started|what\s+should\s+i\s+do\s+next)\b)/iu.test(value);
}

export function isIndustryGuidancePreferenceRequest(text: unknown): boolean {
  const value = String(text || '').trim();
  return /(?:\u6211\u662f\u65b0\u624b|\u6211\u5f88\u719f\u7ec3|\u6211\u662f\u4e13\u4e1a|\u6309\u65b0\u624b|\u4ee5\u540e|\u9ed8\u8ba4|\u8bb0\u4f4f).{0,18}(?:\u53ea\u8bb2\u89e3|\u8fb9\u6559\u8fb9\u505a|\u76f4\u63a5\u4ee3\u529e|\u5f15\u5bfc|\u6a21\u5f0f)|\b(?:remember|default|from\s+now\s+on)\b.{0,40}\b(?:beginner|professional|explain|guided|delegate)\b/iu.test(value);
}

export function inferIndustryGuidanceLevel(
  text: unknown,
  fallback: IndustryGuidanceLevel = 'beginner',
): IndustryGuidanceLevel {
  const value = String(text || '');
  if (/(?:\u4e13\u4e1a|\u719f\u7ec3|\u4e0d\u7528\u8bb2\u57fa\u7840|\u7b80\u6d01\u4e00\u70b9|\b(?:professional|expert|advanced)\b)/iu.test(value)) return 'professional';
  if (/(?:\u6709\u4e00\u4e9b\u7ecf\u9a8c|\u57fa\u7840\u4f1a|\bintermediate\b)/iu.test(value)) return 'skilled';
  if (/(?:\u65b0\u624b|\u7b2c\u4e00\u6b21|\u4e0d\u719f|\u6211\u4e0d\u4f1a|\u5165\u95e8|\bbeginner\b)/iu.test(value)) return 'beginner';
  return fallback;
}

export function inferIndustryGuidanceMode(
  text: unknown,
  fallback: IndustryGuidanceMode = 'explain',
): IndustryGuidanceMode {
  const value = String(text || '');
  if (/(?:\u53ea\u8bb2\u89e3|\u53ea\u544a\u8bc9\u6211|\u4e0d\u8981\u64cd\u4f5c|\u5148\u522b\u505a|\bexplain\s+only\b)/iu.test(value)) return 'explain';
  if (/(?:\u8fb9\u6559\u8fb9\u505a|\u4e00\u6b65\u4e00\u6b65|\u6bcf\u4e00\u6b65|\u5e26\u7740\u6211\u505a|\u5e26\u6211\u505a|\b(?:guided|step\s+by\s+step|walk\s+me\s+through)\b)/iu.test(value)) return 'guided';
  if (/(?:\u76f4\u63a5\u5e2e\u6211\u505a|\u76f4\u63a5\u4ee3\u529e|\u4e0d\u7528\u89e3\u91ca|\bdelegate\b)/iu.test(value)) return 'delegate';
  return fallback;
}

export function formatIndustryUserGuidancePrompt(text: unknown): string {
  if (!isIndustryGuidanceRequest(text)) return '';
  const mode = inferIndustryGuidanceMode(text);
  return [
    '## Industry User Guidance (authoritative)',
    `This is a user-learning request; guidanceMode=${mode}.`,
    'If industry_user_guide is available, call it once to ground the answer in the exact edition and current business context.',
    'Explain at most three concrete steps and use the edition\'s real workspace names. Do not overwhelm the user with the complete tool inventory.',
    mode === 'explain'
      ? 'Explain only. Do not create a project/task, mutate local state, open software, or run a business tool.'
      : mode === 'guided'
        ? 'Explain the next step before action. At most one reversible local step may run in this turn, and only when the user explicitly asked to act. Verify it before proceeding.'
        : 'The user requested delegation. Return to the normal execution pipeline, but keep all confirmation and receipt boundaries.',
    'Never submit, publish, send, file, pay, sign, change price, or modify an external system as part of teaching without the normal exact confirmation.',
    'If required identity or source material is missing, ask one short question instead of guessing.',
  ].join('\n');
}
