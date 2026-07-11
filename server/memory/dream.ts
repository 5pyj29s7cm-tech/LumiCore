import { readDB, writeDB } from '../../db_layer';
import { getGateConfig, getRecentIdleState } from '../autonomy/safety_gate';
import { getUserPreferredLLMConfig } from '../llm/user_preferences';
import { makeLLMCall, NormalizedMessage } from '../llm/providers';
import {
  addMemory,
  decayMemoryAssociations,
  getUnconsolidatedEpisodic,
  promoteMemories,
  queryMemories,
} from './store';
import { consolidateEpisodic, consolidateNarrative, selfReflect, ConsolidationContext } from './consolidator';
import { Memory } from './types';
import { loadEmotionalState } from '../personality/state';

export interface DreamLLMGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
}

export interface SleepCycleState {
  userId: string;
  status: 'awake' | 'sleeping' | 'dreaming' | 'rested' | 'skipped' | 'failed';
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastSkippedAt?: string;
  lastReason?: string;
  dreamCount: number;
  lastDreamTitle?: string;
  lastDreamSummary?: string;
  lastReport?: DreamCycleReport;
}

export interface DreamCycleOptions {
  force?: boolean;
  reason?: string;
  domain?: string;
  orgId?: string;
  minRecentMemories?: number;
  maxMemories?: number;
  windowHours?: number;
  cooldownHours?: number;
}

export interface DreamCycleReport {
  userId: string;
  status: 'dreamed' | 'skipped' | 'partial' | 'failed';
  reason?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  domain: string;
  orgId: string;
  recentMemoryCount: number;
  unconsolidatedCount: number;
  lowConfidenceCount: number;
  consolidatedMemoryId?: string;
  narrativeMemoryId?: string;
  reflectionMemoryId?: string;
  dreamMemoryId?: string;
  dreamTitle?: string;
  dreamSummary?: string;
  insights: string[];
  confusion: string[];
  questions: string[];
  safety: string[];
}

interface DreamSynthesis {
  title?: string;
  dream?: string;
  insights?: string[];
  confusion?: string[];
  nextQuestions?: string[];
  keywords?: string[];
  emotionalTone?: string;
  importance?: number;
}

const SLEEP_STATE_KEY_PREFIX = 'lumi_sleep_cycle_state_';

function stateKey(userId: string): string {
  return `${SLEEP_STATE_KEY_PREFIX}${userId}`;
}

export function getSleepCycleState(userId: string): SleepCycleState {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === stateKey(userId));
    if (setting?.value) {
      return {
        userId,
        status: 'awake',
        dreamCount: 0,
        ...JSON.parse(setting.value),
      };
    }
  } catch {}
  return { userId, status: 'awake', dreamCount: 0 };
}

function saveSleepCycleState(userId: string, patch: Partial<SleepCycleState>): SleepCycleState {
  const next: SleepCycleState = {
    ...getSleepCycleState(userId),
    ...patch,
    userId,
  };
  try {
    const db = readDB();
    if (!db.settings) db.settings = [];
    let setting = db.settings.find((s: any) => s.key === stateKey(userId));
    const value = JSON.stringify(next);
    if (setting) setting.value = value;
    else db.settings.push({ key: stateKey(userId), value });
    writeDB(db);
  } catch {}
  return next;
}

function parseJsonObject(text: string): any | null {
  const cleaned = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function compactMemory(memory: Memory): string {
  const tags = [
    memory.tier,
    memory.perspective,
    memory.type,
    `confidence=${memory.confidence.toFixed(2)}`,
    `importance=${memory.importance.toFixed(2)}`,
  ].join('/');
  return `[${tags}] ${memory.content.slice(0, 260)}`;
}

function nowInNightWindow(): boolean {
  const hour = new Date().getHours();
  return hour >= 1 && hour <= 6;
}

function shouldRunSleepCycle(userId: string, options: DreamCycleOptions): { allowed: boolean; reason?: string } {
  if (options.force) return { allowed: true };

  const gate = getGateConfig(userId);
  if (!gate.alwaysOnline) return { allowed: false, reason: 'Always Online is disabled' };

  const state = getSleepCycleState(userId);
  const cooldownMs = Math.max(1, options.cooldownHours ?? 6) * 60 * 60 * 1000;
  if (state.lastCompletedAt && Date.now() - Date.parse(state.lastCompletedAt) < cooldownMs) {
    return { allowed: false, reason: `Sleep cycle cooldown is active (${options.cooldownHours ?? 6}h)` };
  }

  const idle = getRecentIdleState(userId);
  if (gate.requireIdle) {
    if (idle && idle.ageSeconds <= 300) {
      const minIdle = Math.max(gate.minIdleSeconds || 120, 300);
      if (idle.idleSeconds < minIdle) {
        return { allowed: false, reason: `User is active (idle ${idle.idleSeconds}s < ${minIdle}s)` };
      }
    } else if (!nowInNightWindow()) {
      return { allowed: false, reason: 'No recent idle data and not in night rest window' };
    }
  }

  return { allowed: true };
}

async function synthesizeDream(
  ctx: ConsolidationContext,
  memories: Memory[],
  lowConfidence: Memory[],
  getters: DreamLLMGetters,
): Promise<DreamSynthesis | null> {
  if (memories.length < 3) return null;

  const prompt = [
    'You are Lumi during sleep. This is an internal dream-like memory consolidation pass.',
    'You are not chatting with the user. You are quietly organizing memory to reduce confusion.',
    'Rules:',
    '- Do not mutate core identity.',
    '- Do not delete original memories.',
    '- Distinguish confirmed facts from uncertain or conflicting fragments.',
    '- Keep the original language when possible.',
    '- Sound like a short dream journal, not a technical report.',
    '',
    'Return ONLY valid JSON:',
    '{',
    '  "title": "short Chinese title",',
    '  "dream": "2-5 sentence first-person dream/reflection",',
    '  "insights": ["stable patterns I should remember"],',
    '  "confusion": ["uncertain or conflicting things to avoid overclaiming"],',
    '  "nextQuestions": ["gentle questions to ask later if needed"],',
    '  "keywords": ["3-8 searchable terms"],',
    '  "emotionalTone": "quiet|warm|focused|concerned|curious",',
    '  "importance": 0.3',
    '}',
    '',
    'Recent memories:',
    ...memories.slice(0, 36).map(compactMemory),
    lowConfidence.length ? '' : '',
    lowConfidence.length ? 'Low-confidence or possibly confused fragments:' : '',
    ...lowConfidence.slice(0, 12).map(compactMemory),
  ].filter(Boolean).join('\n');

  const messages: NormalizedMessage[] = [{ role: 'user', content: prompt }];
  const result = await makeLLMCall(
    messages,
    [],
    { provider: ctx.provider, model: ctx.model, maxTokens: 900, userId: ctx.userId },
    getters.getDeepSeek,
    getters.getGemini,
    getters.getOpenAI,
    getters.getAnthropic,
    getters.getQwen,
    getters.getOllama,
    getters.getLmStudio,
    getters.getArk,
    getters.getXiaomi,
    getters.getKimi,
    getters.getGlm,
    getters.getRelay,
  );

  const parsed = parseJsonObject(result.text || '');
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as DreamSynthesis;
}

function addDreamMemory(ctx: ConsolidationContext, dream: DreamSynthesis): Memory | null {
  const title = String(dream.title || '梦境整理').trim().slice(0, 40);
  const body = String(dream.dream || '').trim();
  if (!body) return null;

  const insights = Array.isArray(dream.insights) ? dream.insights.map(String).filter(Boolean).slice(0, 5) : [];
  const confusion = Array.isArray(dream.confusion) ? dream.confusion.map(String).filter(Boolean).slice(0, 5) : [];
  const questions = Array.isArray(dream.nextQuestions) ? dream.nextQuestions.map(String).filter(Boolean).slice(0, 3) : [];
  const content = [
    `[睡眠梦境：${title}] ${body}`,
    insights.length ? `稳定线索：${insights.join('；')}` : '',
    confusion.length ? `待确认/易错乱：${confusion.join('；')}` : '',
    questions.length ? `醒来后可轻问：${questions.join('；')}` : '',
  ].filter(Boolean).join('\n').slice(0, 900);

  return addMemory(
    {
      userId: ctx.userId,
      type: 'knowledge',
      content,
      keywords: [
        'sleep',
        'dream',
        'memory_consolidation',
        ...((Array.isArray(dream.keywords) ? dream.keywords : []).map(String)),
      ].map(k => k.toLowerCase().trim()).filter(Boolean).slice(0, 10),
      confidence: 0.76,
      sourceInteractionId: `dream_cycle_${Date.now()}`,
      source: 'consolidation',
      domain: ctx.domain || 'personal',
      orgId: ctx.orgId || '',
      privacyClass: 'private',
      retention: 'long_term',
    },
    {
      tier: 'growth',
      perspective: 'lumi_growth',
      importance: Math.max(0.35, Math.min(0.85, Number(dream.importance) || 0.55)),
      source: 'consolidation',
      domain: ctx.domain || 'personal',
      orgId: ctx.orgId || '',
      privacyClass: 'private',
      retention: 'long_term',
    },
  );
}

export async function runDreamCycle(
  context: Partial<ConsolidationContext> & { userId: string },
  options: DreamCycleOptions,
  getters: DreamLLMGetters,
): Promise<DreamCycleReport> {
  const startedAt = new Date().toISOString();
  const userId = context.userId;
  const domain = options.domain ?? context.domain ?? 'personal';
  const orgId = options.orgId ?? context.orgId ?? '';
  const allowed = shouldRunSleepCycle(userId, options);
  if (!allowed.allowed) {
    const completedAt = new Date().toISOString();
    const report: DreamCycleReport = {
      userId,
      status: 'skipped',
      reason: allowed.reason,
      startedAt,
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      domain,
      orgId,
      recentMemoryCount: 0,
      unconsolidatedCount: 0,
      lowConfidenceCount: 0,
      insights: [],
      confusion: [],
      questions: [],
      safety: ['No memory was changed because the sleep gate skipped this cycle.'],
    };
    saveSleepCycleState(userId, { status: 'skipped', lastSkippedAt: completedAt, lastReason: allowed.reason, lastReport: report });
    return report;
  }

  saveSleepCycleState(userId, { status: 'dreaming', lastStartedAt: startedAt, lastReason: options.reason || 'sleep_cycle' });

  const pref = getUserPreferredLLMConfig(userId, { maxTokens: 900 });
  const ctx: ConsolidationContext = {
    userId,
    provider: (context.provider || pref.provider) as ConsolidationContext['provider'],
    model: context.model || pref.model,
    domain,
    orgId,
  };

  const cutoff = new Date(Date.now() - Math.max(6, options.windowHours ?? 36) * 60 * 60 * 1000).toISOString();
  const recent = queryMemories({
    userId,
    after: cutoff,
    limit: options.maxMemories || 48,
    minConfidence: 0.15,
    domain,
    orgId,
  });
  const unconsolidated = getUnconsolidatedEpisodic(userId, domain, orgId);
  const lowConfidence = recent.filter(m => m.confidence < 0.45 || /不确定|矛盾|错误|混乱|conflict|uncertain/i.test(m.content));

  const minRecent = Math.max(1, options.minRecentMemories ?? 3);
  if (!options.force && recent.length < minRecent && unconsolidated.length < minRecent) {
    const completedAt = new Date().toISOString();
    const report: DreamCycleReport = {
      userId,
      status: 'skipped',
      reason: `Not enough recent memories for dreaming (${recent.length}/${minRecent})`,
      startedAt,
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      domain,
      orgId,
      recentMemoryCount: recent.length,
      unconsolidatedCount: unconsolidated.length,
      lowConfidenceCount: lowConfidence.length,
      insights: [],
      confusion: [],
      questions: [],
      safety: ['No memory was changed because the dream had too little material.'],
    };
    saveSleepCycleState(userId, { status: 'skipped', lastSkippedAt: completedAt, lastReason: report.reason, lastReport: report });
    return report;
  }

  let consolidated: Memory | null = null;
  let narrative: Memory | null = null;
  let reflection: Memory | null = null;
  let dreamMemory: Memory | null = null;
  let dream: DreamSynthesis | null = null;
  const safety = [
    'Original memories were not deleted.',
    'Core identity was not mutated.',
    'Uncertain fragments were stored as uncertainty, not as facts.',
  ];

  try {
    if (unconsolidated.length >= 6) {
      consolidated = await consolidateEpisodic(ctx, Math.min(10, Math.max(6, unconsolidated.length)), getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic, getters.getQwen, getters.getOllama, getters.getLmStudio, getters.getArk, getters.getXiaomi, getters.getKimi, getters.getGlm, getters.getRelay);
    }
    if (recent.length >= 6) {
      narrative = await consolidateNarrative(ctx, Math.max(1, Math.ceil((options.windowHours ?? 36) / 24)), 6, getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic, getters.getQwen, getters.getOllama, getters.getLmStudio, getters.getArk, getters.getXiaomi, getters.getKimi, getters.getGlm, getters.getRelay);
    }
    reflection = await selfReflect(ctx, getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic, getters.getQwen, getters.getOllama, getters.getLmStudio, getters.getArk, getters.getXiaomi, getters.getKimi, getters.getGlm, getters.getRelay);
    dream = await synthesizeDream(ctx, recent, lowConfidence, getters);
    if (dream) dreamMemory = addDreamMemory(ctx, dream);

    decayMemoryAssociations(userId);
    const emotionalState = loadEmotionalState(userId);
    promoteMemories(userId, emotionalState.intimacy);
  } catch (err: any) {
    const completedAt = new Date().toISOString();
    const report: DreamCycleReport = {
      userId,
      status: consolidated || narrative || reflection || dreamMemory ? 'partial' : 'failed',
      reason: err.message || 'Dream cycle failed',
      startedAt,
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      domain,
      orgId,
      recentMemoryCount: recent.length,
      unconsolidatedCount: unconsolidated.length,
      lowConfidenceCount: lowConfidence.length,
      consolidatedMemoryId: consolidated?.id,
      narrativeMemoryId: narrative?.id,
      reflectionMemoryId: reflection?.id,
      dreamMemoryId: dreamMemory?.id,
      dreamTitle: dream?.title,
      dreamSummary: dream?.dream,
      insights: Array.isArray(dream?.insights) ? dream!.insights!.map(String).slice(0, 5) : [],
      confusion: Array.isArray(dream?.confusion) ? dream!.confusion!.map(String).slice(0, 5) : [],
      questions: Array.isArray(dream?.nextQuestions) ? dream!.nextQuestions!.map(String).slice(0, 3) : [],
      safety,
    };
    saveSleepCycleState(userId, { status: report.status === 'failed' ? 'failed' : 'rested', lastCompletedAt: completedAt, lastReason: report.reason, lastReport: report });
    return report;
  }

  const completedAt = new Date().toISOString();
  const report: DreamCycleReport = {
    userId,
    status: consolidated || narrative || reflection || dreamMemory ? 'dreamed' : 'skipped',
    reason: consolidated || narrative || reflection || dreamMemory ? options.reason || 'sleep_cycle_completed' : 'No consolidation output was needed',
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    domain,
    orgId,
    recentMemoryCount: recent.length,
    unconsolidatedCount: unconsolidated.length,
    lowConfidenceCount: lowConfidence.length,
    consolidatedMemoryId: consolidated?.id,
    narrativeMemoryId: narrative?.id,
    reflectionMemoryId: reflection?.id,
    dreamMemoryId: dreamMemory?.id,
    dreamTitle: dream?.title,
    dreamSummary: dream?.dream,
    insights: Array.isArray(dream?.insights) ? dream!.insights!.map(String).slice(0, 5) : [],
    confusion: Array.isArray(dream?.confusion) ? dream!.confusion!.map(String).slice(0, 5) : [],
    questions: Array.isArray(dream?.nextQuestions) ? dream!.nextQuestions!.map(String).slice(0, 3) : [],
    safety,
  };

  const prior = getSleepCycleState(userId);
  saveSleepCycleState(userId, {
    status: report.status === 'dreamed' ? 'rested' : 'skipped',
    lastCompletedAt: completedAt,
    lastReason: report.reason,
    dreamCount: prior.dreamCount + (report.status === 'dreamed' ? 1 : 0),
    lastDreamTitle: report.dreamTitle,
    lastDreamSummary: report.dreamSummary,
    lastReport: report,
  });

  return report;
}
