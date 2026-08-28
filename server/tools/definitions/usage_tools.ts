import { readDB } from '../../../db_layer';
import { ToolRegistry } from '../registry';

type UsageRange = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'all' | 'custom';
type UsageGroupBy = 'provider' | 'model' | 'provider_model' | 'mode' | 'day';

interface UsageRow {
  userId?: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  mode?: string;
  interactionId?: string;
  timestamp?: string;
}

interface UsageBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  providers: string[];
  models: string[];
  modes: string[];
  firstAt?: string;
  lastAt?: string;
}

export function registerUsageTools(registry: ToolRegistry): void {
  registry.register({
    name: 'usage_get_summary',
    description: 'Summarize Lumi LLM/model token usage by provider, model, provider+model, mode, or day. Use this before answering questions about which model was used today and how many tokens/calls were consumed.',
    parameters: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          enum: ['today', 'yesterday', '7d', '30d', '90d', 'all', 'custom'],
          description: 'Time range. Defaults to today.',
        },
        groupBy: {
          type: 'string',
          enum: ['provider', 'model', 'provider_model', 'mode', 'day'],
          description: 'Grouping dimension. Defaults to provider_model.',
        },
        provider: {
          type: 'string',
          description: 'Optional provider filter, e.g. deepseek, qwen, ark, openai, gemini.',
        },
        model: {
          type: 'string',
          description: 'Optional model filter.',
        },
        mode: {
          type: 'string',
          description: 'Optional usage mode filter, e.g. chat, voice, vision, task, meeting, autonomy.',
        },
        startDate: {
          type: 'string',
          description: 'For custom range: local date or ISO timestamp.',
        },
        endDate: {
          type: 'string',
          description: 'For custom range: local date or ISO timestamp. Exclusive end.',
        },
        limit: {
          type: 'number',
          description: 'Max number of grouped rows to return. Defaults to 30.',
        },
        includeRecords: {
          type: 'boolean',
          description: 'Include recent raw usage records. Defaults to false.',
        },
      },
      required: [],
    },
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const range = normalizeRange(args.range);
      const groupBy = normalizeGroupBy(args.groupBy);
      const window = getRangeWindow(range, args.startDate, args.endDate);
      const rows = getFilteredUsageRows(userId, window, args);
      const grouped = groupUsage(rows, groupBy)
        .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls)
        .slice(0, Math.max(1, Math.min(Number(args.limit) || 30, 100)));

      const totals = rows.reduce<{ promptTokens: number; completionTokens: number; totalTokens: number; calls: number }>((sum, row) => ({
        promptTokens: sum.promptTokens + Number(row.promptTokens || 0),
        completionTokens: sum.completionTokens + Number(row.completionTokens || 0),
        totalTokens: sum.totalTokens + Number(row.totalTokens || 0),
        calls: sum.calls + 1,
      }), { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 });

      return JSON.stringify({
        generatedAt: new Date().toISOString(),
        userId,
        range,
        startAt: window.startAt,
        endAt: window.endAt,
        groupBy,
        filters: {
          provider: args.provider || null,
          model: args.model || null,
          mode: args.mode || null,
        },
        totals,
        groups: grouped,
        recordCount: rows.length,
        note: 'Token usage is based on recorded provider/model usage. It is not a billing invoice; provider pricing and cached/billed token rules may differ.',
        recentRecords: args.includeRecords
          ? rows.slice(-20).reverse().map(row => ({
              provider: row.provider || 'unknown',
              model: row.model || 'unknown',
              mode: row.mode || 'chat',
              totalTokens: Number(row.totalTokens || 0),
              promptTokens: Number(row.promptTokens || 0),
              completionTokens: Number(row.completionTokens || 0),
              timestamp: row.timestamp,
              interactionId: row.interactionId,
            }))
          : undefined,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });
}

function normalizeRange(value: unknown): UsageRange {
  const raw = String(value || 'today');
  if (['today', 'yesterday', '7d', '30d', '90d', 'all', 'custom'].includes(raw)) return raw as UsageRange;
  return 'today';
}

function normalizeGroupBy(value: unknown): UsageGroupBy {
  const raw = String(value || 'provider_model');
  if (['provider', 'model', 'provider_model', 'mode', 'day'].includes(raw)) return raw as UsageGroupBy;
  return 'provider_model';
}

function getRangeWindow(range: UsageRange, startDate?: unknown, endDate?: unknown): { startAt: string | null; endAt: string | null } {
  if (range === 'all') return { startAt: null, endAt: null };
  if (range === 'custom') {
    return {
      startAt: parseDateLike(startDate, false),
      endAt: parseDateLike(endDate, true),
    };
  }

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  if (range === 'yesterday') {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
  } else if (range === '7d' || range === '30d' || range === '90d') {
    const days = Number(range.replace('d', ''));
    start.setDate(end.getDate() - days);
  }

  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function parseDateLike(value: unknown, exclusiveEnd: boolean): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date = dateOnly ? new Date(`${raw}T00:00:00`) : new Date(raw);
  if (!Number.isFinite(date.getTime())) return null;
  if (dateOnly && exclusiveEnd) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function getFilteredUsageRows(userId: string, window: { startAt: string | null; endAt: string | null }, args: Record<string, any>): UsageRow[] {
  const db = readDB();
  const providerFilter = String(args.provider || '').trim().toLowerCase();
  const modelFilter = String(args.model || '').trim().toLowerCase();
  const modeFilter = String(args.mode || '').trim().toLowerCase();
  return ((db.tokenUsage || []) as UsageRow[])
    .filter(row => row && (row.userId === userId || row.userId === 'anonymous' || userId === 'anonymous'))
    .filter(row => !window.startAt || String(row.timestamp || '') >= window.startAt!)
    .filter(row => !window.endAt || String(row.timestamp || '') < window.endAt!)
    .filter(row => !providerFilter || String(row.provider || '').toLowerCase() === providerFilter)
    .filter(row => !modelFilter || String(row.model || '').toLowerCase() === modelFilter)
    .filter(row => !modeFilter || String(row.mode || '').toLowerCase() === modeFilter)
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
}

function groupUsage(rows: UsageRow[], groupBy: UsageGroupBy): Array<{ key: string } & UsageBucket> {
  const map = new Map<string, UsageBucket>();
  for (const row of rows) {
    const key = getGroupKey(row, groupBy);
    const bucket = map.get(key) || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      calls: 0,
      providers: [],
      models: [],
      modes: [],
    };
    bucket.promptTokens += Number(row.promptTokens || 0);
    bucket.completionTokens += Number(row.completionTokens || 0);
    bucket.totalTokens += Number(row.totalTokens || 0);
    bucket.calls += 1;
    bucket.providers = pushUnique(bucket.providers, row.provider || 'unknown');
    bucket.models = pushUnique(bucket.models, row.model || 'unknown');
    bucket.modes = pushUnique(bucket.modes, row.mode || 'chat');
    const ts = row.timestamp || '';
    if (ts) {
      if (!bucket.firstAt || ts < bucket.firstAt) bucket.firstAt = ts;
      if (!bucket.lastAt || ts > bucket.lastAt) bucket.lastAt = ts;
    }
    map.set(key, bucket);
  }
  return Array.from(map.entries()).map(([key, bucket]) => ({ key, ...bucket }));
}

function getGroupKey(row: UsageRow, groupBy: UsageGroupBy): string {
  if (groupBy === 'provider') return row.provider || 'unknown';
  if (groupBy === 'model') return row.model || 'unknown';
  if (groupBy === 'mode') return row.mode || 'chat';
  if (groupBy === 'day') return String(row.timestamp || '').slice(0, 10) || 'unknown';
  return `${row.provider || 'unknown'}:${row.model || 'unknown'}`;
}

function pushUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}
