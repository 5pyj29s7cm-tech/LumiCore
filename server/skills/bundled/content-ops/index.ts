import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parseString } from 'fast-csv';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\r?\n|[;；]/).map(s => s.trim()).filter(Boolean);
}

const server = new McpServer({ name: 'content-ops', version: '1.0.2' }, { capabilities: { tools: {} } });

server.registerTool('content_topic_pipeline', {
  description: 'Turn raw ideas into a content topic pipeline with angles, formats, hooks, and production notes.',
  inputSchema: {
    rawIdeas: z.string().describe('Ideas, product notes, audience questions, or competitor inspiration'),
    audience: z.string().optional().describe('Target audience'),
    goal: z.string().optional().describe('Content goal such as awareness, conversion, trust, retention'),
    platform: z.string().optional().describe('Platform such as Douyin, Xiaohongshu, TikTok, YouTube, WeChat'),
  },
}, async (args: any) => {
  const ideas = list(args.rawIdeas);
  return ok({
    platform: args.platform || 'TBD',
    audience: args.audience || 'TBD',
    goal: args.goal || 'TBD',
    topics: ideas.slice(0, 12).map((idea, index) => ({
      id: index + 1,
      topic: idea,
      angle: /price|贵|cost|省钱/i.test(idea) ? 'cost/value angle' : /how|怎么|教程|guide/i.test(idea) ? 'how-to angle' : 'story/problem angle',
      suggestedFormat: index % 3 === 0 ? 'short video' : index % 3 === 1 ? 'carousel/post' : 'live/script segment',
      hook: `If you care about ${args.audience || 'this topic'}, here is the key thing most people miss.`,
    })),
    productionNotes: ['Collect proof/materials', 'Check platform policy and claims', 'Prepare cover/title variants', 'Define CTA and comment prompt'],
  });
});

server.registerTool('short_video_script', {
  description: 'Create a short-video script with hook, scene beats, voiceover, caption ideas, and CTA.',
  inputSchema: {
    topic: z.string().describe('Video topic, product, or story'),
    platform: z.string().optional().describe('Target platform'),
    durationSeconds: z.number().optional().describe('Target duration in seconds'),
    style: z.enum(['educational', 'story', 'sales', 'review']).optional().describe('Script style'),
  },
}, async (args: any) => {
  const duration = Math.max(15, Math.min(180, Number(args.durationSeconds || 45)));
  const [hookEnd, contextEnd, valueEnd] = [3, 15, Math.max(25, duration - 10)].map(second => Number((second * Math.min(1, duration / 30)).toFixed(2)));
  return ok({
    topic: args.topic,
    platform: args.platform || 'short video',
    durationSeconds: duration,
    structure: [
      { second: `0-${hookEnd}`, beat: 'Hook', voiceover: `Most people misunderstand ${args.topic}.` },
      { second: `${hookEnd}-${contextEnd}`, beat: 'Problem/context', voiceover: 'Show the real situation and why it matters.' },
      { second: `${contextEnd}-${valueEnd}`, beat: 'Core value', voiceover: 'Give 2-3 concrete points with proof or demo.' },
      { second: `${valueEnd}-${duration}`, beat: 'CTA', voiceover: 'Ask viewers to comment, save, message, or check the next step.' },
    ],
    captions: [`${args.topic}: 3 things to check`, `Before you decide, watch this`, `Save this checklist`],
    shotList: ['Face-to-camera hook', 'Detail close-up or screen recording', 'Before/after or proof', 'CTA end frame'],
  });
});

server.registerTool('account_performance_review', {
  description: 'Calculate video metrics from an exported CSV/TSV with exact column mapping. Missing or invalid metrics remain unknown; no platform login, publishing, or causal diagnosis is performed.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    metricsText: z.string().describe('Exported CSV/TSV including a header row; all parsed records are analyzed, not only the first 20'),
    period: z.string().optional().describe('User-supplied review period; not inferred from the data'),
    delimiter: z.enum([',', '\t', ';']).default(',').describe('Exact export delimiter: comma, tab, or semicolon'),
    columnMapping: z.object({
      videoId: z.string().optional(), title: z.string().optional(),
      views: z.string().optional(), likes: z.string().optional(), comments: z.string().optional(),
      saves: z.string().optional(), shares: z.string().optional(), completionRate: z.string().optional(),
    }).optional().describe('Exact source header for each field. Unmapped fields use only an identical canonical header; no guessed aliases'),
    completionRateUnit: z.enum(['percent', 'fraction']).default('percent').describe('Unit for bare completion-rate numbers: percent 0..100 or fraction 0..1. An explicit % always means percent'),
  },
}, async (args: any) => {
  const rowLimit = 50_000;
  const table = await new Promise<{ headers: string[]; rows: Record<string, string>[] }>((resolve, reject) => {
    const parsed = { headers: [] as string[], rows: [] as Record<string, string>[] };
    parseString(args.metricsText, { headers: true, ignoreEmpty: true, trim: true, delimiter: args.delimiter ?? ',', maxRows: rowLimit + 1 })
      .on('headers', (headers: string[]) => { parsed.headers = headers; })
      .on('data', (row: Record<string, string>) => { parsed.rows.push(row); })
      .on('error', reject).on('end', () => resolve(parsed));
  });
  if (!table.headers.length || !table.rows.length) throw new Error('The report must contain a header row and at least one data row.');
  if (table.rows.length > rowLimit) throw new Error('CSV row limit exceeded. Split the export into at most 50000 records; no aggregate was calculated.');
  const counts = ['views', 'likes', 'comments', 'saves', 'shares'] as const;
  const fields = ['videoId', 'title', ...counts, 'completionRate'] as const;
  const mapping = Object.fromEntries(fields.map(field => {
    const column = args.columnMapping?.[field] ?? (table.headers.includes(field) ? field : null);
    if (column !== null && !table.headers.includes(column)) throw new Error('Mapped column does not exist: ' + column);
    return [field, column];
  })) as Record<typeof fields[number], string | null>;
  const mapped = Object.values(mapping).filter((column): column is string => column !== null);
  if (new Set(mapped).size !== mapped.length) throw new Error('Each mapped field must use a distinct source column.');
  const round = (value: number) => Number(value.toFixed(6));
  const rows = table.rows.map((source, index) => {
    const issues: Array<{ field: string; reason: string }> = [];
    const readMetric = (field: typeof counts[number] | 'completionRate'): number | null => {
      const column = mapping[field];
      if (!column) { issues.push({ field, reason: 'missing_column' }); return null; }
      const raw = String(source[column] ?? '').normalize('NFKC').trim();
      if (!raw) { issues.push({ field, reason: 'missing_value' }); return null; }
      if (field !== 'completionRate') {
        const value = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw) ? Number(raw.replaceAll(',', '')) : NaN;
        if (Number.isSafeInteger(value) && value >= 0) return value;
      } else if (/^(?:\d+(?:\.\d+)?|\.\d+)\s*%?$/.test(raw)) {
        const value = Number(raw.replace('%', '').trim()) * (raw.endsWith('%') || args.completionRateUnit !== 'fraction' ? 1 : 100);
        if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
      }
      issues.push({ field, reason: field === 'completionRate' ? 'invalid_rate' : 'invalid_count' });
      return null;
    };
    const metrics = Object.fromEntries([...counts, 'completionRate'].map(field => [field, readMetric(field as typeof counts[number] | 'completionRate')])) as Record<typeof counts[number] | 'completionRate', number | null>;
    const interactions = [metrics.likes, metrics.comments, metrics.saves, metrics.shares];
    const interactionSum = interactions.every(value => value !== null) ? interactions.reduce<number>((sum, value) => sum + value!, 0) : null;
    const engagementCount = interactionSum !== null && Number.isSafeInteger(interactionSum) ? interactionSum : null;
    const rate = (value: number | null) => value !== null && metrics.views !== null && metrics.views > 0 ? round(value / metrics.views * 100) : null;
    return {
      recordNumber: index + 1,
      videoId: mapping.videoId ? String(source[mapping.videoId]) : null,
      title: mapping.title ? String(source[mapping.title]) : null,
      raw: Object.fromEntries(fields.map(field => [field, mapping[field] ? source[mapping[field]!] : null])),
      metrics, ratesPercent: { likes: rate(metrics.likes), comments: rate(metrics.comments), saves: rate(metrics.saves), shares: rate(metrics.shares), engagement: rate(engagementCount) },
      engagementCount, issues,
    };
  });
  const totals = Object.fromEntries(counts.map(field => {
    const values = rows.map(row => row.metrics[field]).filter((value): value is number => value !== null);
    const sum = values.reduce((total, value) => total + value, 0);
    const validSum = values.length && Number.isSafeInteger(sum) ? sum : null;
    return [field, { value: values.length === rows.length ? validSum : null, knownSum: validSum, validRows: values.length, unknownRows: rows.length - values.length }];
  }));
  const aggregateRate = (values: Array<number | null>) => {
    if (rows.some(row => row.metrics.views === null) || values.some(value => value === null)) return { value: null, reason: 'incomplete_data' };
    const denominator = rows.reduce((sum, row) => sum + row.metrics.views!, 0);
    if (denominator === 0) return { value: null, reason: 'zero_denominator' };
    const numerator = values.reduce<number>((sum, value) => sum + value!, 0);
    if (!Number.isSafeInteger(denominator) || !Number.isSafeInteger(numerator)) return { value: null, reason: 'unsafe_aggregate' };
    return { value: round(numerator / denominator * 100), reason: null };
  };
  const completionRate = rows.some(row => row.metrics.views === null || row.metrics.completionRate === null)
    ? { value: null, reason: 'incomplete_data' }
    : (() => {
      const views = rows.reduce((sum, row) => sum + row.metrics.views!, 0);
      return views === 0 ? { value: null, reason: 'zero_denominator' }
        : !Number.isSafeInteger(views) ? { value: null, reason: 'unsafe_aggregate' }
        : { value: round(rows.reduce((sum, row) => sum + row.metrics.views! * row.metrics.completionRate!, 0) / views), reason: null };
    })();
  return ok({
    period: args.period ?? null,
    source: { headers: table.headers, columnMapping: mapping, rowCount: rows.length, completionRateUnit: args.completionRateUnit ?? 'percent', maximumRows: rowLimit, delimiter: args.delimiter ?? ',' },
    totals,
    ratesPercent: {
      likes: aggregateRate(rows.map(row => row.metrics.likes)), comments: aggregateRate(rows.map(row => row.metrics.comments)),
      saves: aggregateRate(rows.map(row => row.metrics.saves)), shares: aggregateRate(rows.map(row => row.metrics.shares)),
      engagement: aggregateRate(rows.map(row => row.engagementCount)), completionWeightedByViews: completionRate,
    },
    dataQuality: {
      missingColumns: [...counts, 'completionRate'].filter(field => !mapping[field as typeof fields[number]]),
      missingValueCount: rows.flatMap(row => row.issues).filter(issue => issue.reason === 'missing_value').length,
      invalidValueCount: rows.flatMap(row => row.issues).filter(issue => issue.reason.startsWith('invalid_')).length,
      zeroViewRecords: rows.filter(row => row.metrics.views === 0).map(row => row.recordNumber),
    },
    formulas: { interactionRate: '(likes + comments + saves + shares) / views * 100', individualRate: 'metric / views * 100', completionRate: 'sum(views * completionRatePercent) / sum(views)' },
    limitations: ['Only supplied export records are analyzed; no platform data was fetched.', 'Unknown inputs and zero denominators are not converted to zero.', 'Weighted completion uses supplied rates and views; it is not a platform-verified overall completion rate.', 'Rates do not establish causes, unique engaged viewers, revenue, profit, or recommendations.'],
    rows,
  });
});

server.registerTool('comment_insight_report', {
  description: 'Analyze comment or review text into themes, objections, content ideas, and response frames.',
  inputSchema: {
    commentsText: z.string().describe('Comments, reviews, DMs, or community feedback'),
  },
}, async (args: any) => {
  const comments = list(args.commentsText);
  return ok({
    themes: {
      price: comments.filter(c => /price|cost|expensive|贵|价格/i.test(c)).length,
      trust: comments.filter(c => /real|fake|trust|靠谱吗|真假|信任/i.test(c)).length,
      howTo: comments.filter(c => /how|怎么|教程|where|哪里/i.test(c)).length,
      complaint: comments.filter(c => /bad|refund|complaint|差|退|投诉/i.test(c)).length,
    },
    representativeComments: comments.slice(0, 8),
    contentIdeas: ['Answer the most repeated question', 'Make objection-handling post', 'Show proof/process', 'Create comparison/checklist'],
    responseFrame: 'Acknowledge first, answer concretely, avoid arguing, invite evidence/order details if support is needed.',
  });
});

server.registerTool('content_calendar_builder', {
  description: 'Create a weekly or monthly content calendar from themes, cadence, channels, and goals.',
  inputSchema: {
    themes: z.union([z.string(), z.array(z.string())]).describe('Themes or content pillars'),
    cadence: z.string().optional().describe('Posting cadence'),
    channels: z.union([z.string(), z.array(z.string())]).optional().describe('Channels/platforms'),
  },
}, async (args: any) => {
  const themes = list(args.themes);
  const channels = list(args.channels || 'primary channel');
  return ok({
    cadence: args.cadence || '3-5 posts/week',
    contentPillars: themes,
    calendar: themes.slice(0, 7).map((theme, index) => ({
      day: index + 1,
      channel: channels[index % channels.length] || 'primary channel',
      theme,
      format: index % 2 === 0 ? 'short video' : 'post/carousel',
      productionTask: 'Draft hook, gather material, edit, schedule, prepare comment response',
    })),
    operatingChecklist: ['Batch script writing', 'Batch shooting/material capture', 'Daily comment review', 'Weekly metric review'],
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
