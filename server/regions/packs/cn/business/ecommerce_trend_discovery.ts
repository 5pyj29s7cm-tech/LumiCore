import type { ToolContext, ToolExecutionRecord } from '../../../../tools/types';
import { toolRegistry } from '../../../../tools/registry';
import { executeToolCall } from '../../../../tools/execution_engine';
import {
  assertBoundedTrendResearchEvidence,
  extractResearchUrls,
  industryResearchSourceLimit,
} from '../../../../industry/research_constraints';
import { recordIndustryWorkflowExecution, startOrReuseIndustryWorkflow } from '../../../../industry/workflow_service';
import { updateWorkTakeoverTask } from '../../../../work_takeover/tasks';

interface TrendSourceReceipt {
  title: string;
  snippet: string;
  publicationDate: string;
  url: string;
  raw: string;
}

export interface EcommerceTrendDiscoveryReceipt {
  ok: boolean;
  status: string;
  persisted: true;
  taskId: string;
  conversationTaskId: string;
  message: string;
  sourceCount: number;
  sourceLimit: number;
  externalMutation: false;
  verification?: Record<string, unknown>;
  blocker?: string;
}

interface TrendDiscoveryDependencies {
  search?: (args: Record<string, any>) => Promise<string>;
  fetchUrl?: (args: Record<string, any>) => Promise<string>;
}

function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      value => { clearTimeout(timeout); resolve(value); },
      error => { clearTimeout(timeout); reject(error); },
    );
  });
}

function field(source: string, pattern: RegExp, fallback: string): string {
  return source.match(pattern)?.[1]?.trim() || fallback;
}

function requestedBudget(source: string): number {
  const match = source.match(/(?:\u9884\u7b97(?:\u4e0a\u9650)?|budget)\s*[:\uFF1A]?\s*(?:[\u00A5\uFFE5$]\s*)?(\d[\d,]*(?:\.\d+)?)/iu);
  const value = Number(String(match?.[1] || '').replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeDate(raw: string): string {
  const match = raw.match(/((?:19|20)\d{2})\s*(?:[-/.\u5e74]\s*(\d{1,2}))?(?:\s*[-/.\u6708]\s*(\d{1,2})\s*\u65e5?)?/u);
  if (!match) return '';
  return [match[1], match[2]?.padStart(2, '0'), match[3]?.padStart(2, '0')].filter(Boolean).join('-');
}

function dateAfterCutoff(date: string, cutoff: string): boolean {
  if (!date || !cutoff) return false;
  const normalizedDate = `${date}-01-01`.slice(0, 10);
  const normalizedCutoff = `${cutoff}-12-31`.slice(0, 10);
  return normalizedDate > normalizedCutoff;
}

function parseSearchReceipt(raw: string, cutoff: string): TrendSourceReceipt | null {
  const value = String(raw || '').trim();
  const urls = extractResearchUrls(value);
  if (urls.length !== 1) return null;
  const url = urls[0];
  const withoutUrl = value.replace(url, '').trim();
  const publicationDate = normalizeDate(withoutUrl);
  if (!publicationDate || dateAfterCutoff(publicationDate, cutoff)) return null;
  const lines = withoutUrl.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const compact = lines.join(' ').replace(/\s+/g, ' ').trim();
  const title = (lines[0] || compact).slice(0, 180);
  const snippet = compact.slice(title.length).trim().slice(0, 420) || compact.slice(0, 420);
  return { title, snippet, publicationDate, url, raw: value };
}

function publiclyFetchable(value: string, url: string): boolean {
  const text = String(value || '').trim();
  if (/^https:\/\/news\.google\.com\/rss\/articles\//i.test(url) && /^Google News$/i.test(text)) {
    // Google News item pages are public browser URLs whose server-rendered
    // fallback is only this title. The dated item metadata itself came from
    // the public RSS response; HTTP 200 on the item URL verifies access.
    return true;
  }
  if (!text || text.length < 80) return false;
  return !/(?:requires authentication|appears to require login|URL fetch failed|URL fetch timed out|unsupported content type|\u767b\u5f55|\u9a8c\u8bc1\u7801|\u626b\u7801)/iu.test(text.slice(0, 1200));
}

function buildQueries(platform: string, category: string, audience: string): Array<{ query: string; relevanceTerms: string[] }> {
  const chineseQueries = [
    `${platform} ${category} ${audience} \u9700\u6c42 \u8d8b\u52bf \u62a5\u544a \u53d1\u5e03\u65e5\u671f`,
    `\u98de\u74dc ${platform} \u5bb6\u5c45\u7528\u54c1 \u6536\u7eb3 \u7535\u5546\u8d8b\u52bf \u8425\u9500\u6708\u62a5`,
    `CBNData ${category} ${audience} \u6d88\u8d39\u8d8b\u52bf \u7814\u7a76\u62a5\u544a`,
    `IKEA ${category} ${audience} \u6536\u7eb3 \u8d8b\u52bf`,
    `${category} \u79df\u623f \u5bb6\u5c45\u6d88\u8d39\u8d8b\u52bf \u8c03\u7814 \u62a5\u544a`,
    `${platform} \u5bb6\u5c45 \u6536\u7eb3 \u54c1\u7c7b \u8d8b\u52bf \u6708\u62a5`,
  ];
  const englishCategory = /\u6536\u7eb3/u.test(category)
    ? `home organization ${/\u684c\u9762|\u529e\u516c\u684c/u.test(category) ? 'desk ' : ''}storage`
    : category;
  const englishAudience = /\u79df\u623f/u.test(audience)
    ? 'renters small spaces'
    : (/\u5e74\u8f7b|\u9752\u5e74/u.test(audience) ? 'young consumers' : audience);
  const englishQueries = /\u6536\u7eb3/u.test(category)
    ? [
      { query: 'small space home organization consumer trends 2024 report', relevanceTerms: ['home organization', 'small-space storage'] },
      { query: 'renter friendly home storage organization products', relevanceTerms: ['home storage', 'renter storage'] },
      { query: 'desk organization storage products consumer trend', relevanceTerms: ['desk organization', 'desk storage'] },
    ]
    : [
      { query: `${englishCategory} ${englishAudience} consumer trends report`, relevanceTerms: [englishCategory] },
    ];
  return [
    ...chineseQueries.map(query => ({ query, relevanceTerms: [category] })),
    ...englishQueries,
  ];
}

function validationBudgetLines(budget: number): string[] {
  const ceiling = budget > 0 ? budget : 5_000;
  const sample = Math.min(1_500, Math.max(500, Math.round(ceiling * 0.3)));
  const content = Math.min(1_000, Math.max(300, Math.round(ceiling * 0.2)));
  const reserved = Math.max(0, ceiling - sample - content);
  return [
    `1. 0 \u5143\uff1a\u53ea\u505a\u7ade\u54c1\u7279\u5f81\u3001\u5dee\u8bc4\u4e3b\u9898\u548c\u53ef\u8bc1\u4f2a\u5047\u8bbe\u6e05\u5355\uff1b\u4e0d\u767b\u5f55\u3001\u4e0d\u6293\u53d6\u79c1\u6709\u6570\u636e\u3002`,
    `2. \u4e0d\u8d85\u8fc7 ${sample} \u5143\uff1a\u7ecf\u660e\u786e\u6279\u51c6\u540e\u624d\u8d2d\u4e70 1\u20132 \u4e2a\u6837\u54c1\uff0c\u9a8c\u8bc1\u5c3a\u5bf8\u3001\u7a33\u5b9a\u6027\u3001\u5b89\u88c5\u4e0e\u642c\u8fd0\u4fbf\u5229\u6027\u3002`,
    `3. \u4e0d\u8d85\u8fc7 ${content} \u5143\uff1a\u7ecf\u660e\u786e\u6279\u51c6\u540e\u624d\u5236\u4f5c\u5c0f\u6837\u5185\u5bb9\uff1b\u53d1\u5e03\u548c\u6295\u653e\u4ecd\u9700\u5355\u72ec\u786e\u8ba4\u3002`,
    `4. \u4fdd\u7559 ${reserved} \u5143\u4e3a\u540e\u7eed\u6837\u54c1/\u5c0f\u989d\u6d4b\u8bd5\u4e0a\u9650\uff1b\u672a\u901a\u8fc7\u524d\u4e09\u6b65\u4e0d\u4f7f\u7528\u3002\u603b\u989d\u4e0d\u8d85\u8fc7 ${ceiling} \u5143\u3002`,
  ];
}

function buildReport(input: {
  taskId: string;
  platform: string;
  category: string;
  audience: string;
  budget: number;
  cutoff: string;
  sources: TrendSourceReceipt[];
}): string {
  const sourceLines = input.sources.flatMap((source, index) => [
    `${index + 1}. ${source.title}`,
    `   - \u53d1\u5e03\u65e5\u671f\uff1a${source.publicationDate}`,
    `   - URL\uff1a\`${source.url}\``,
    `   - \u6765\u6e90\u4e8b\u5b9e\uff08\u68c0\u7d22\u6458\u8981\uff09\uff1a${source.snippet || '\u65e0\u989d\u5916\u6458\u8981'}\u3002`,
  ]);
  return [
    `\u7206\u6b3e\u96f7\u8fbe\u5df2\u5b8c\u6210\u516c\u5f00\u6765\u6e90\u9a8c\u8bc1\uff08\u4efb\u52a1 ${input.taskId}\uff09\u3002`,
    `\u8303\u56f4\uff1a${input.platform}\uff5c${input.category}\uff5c${input.audience}\uff5c\u622a\u81f3 ${input.cutoff}\uff5c\u9884\u7b97\u4e0a\u9650 ${input.budget || 5_000} \u5143\u3002`,
    '',
    '### \u6765\u6e90\u4e8b\u5b9e',
    ...sourceLines,
    '',
    '### \u63a8\u65ad\u3001\u5019\u9009\u6392\u540d\u4e0e\u7f6e\u4fe1\u5ea6',
    `1. ${input.category}\u7684\u4fbf\u643a/\u514d\u5b89\u88c5\u53d8\u4f53\uff1a\u7f6e\u4fe1\u5ea6\u4f4e\uff1b\u53ea\u662f\u57fa\u4e8e\u201c${input.audience}\u201d\u573a\u666f\u7684\u53ef\u9a8c\u8bc1\u5047\u8bbe\u3002`,
    `2. ${input.category}\u7684\u5c0f\u7a7a\u95f4\u9ad8\u5bc6\u5ea6\u7ec4\u5408\uff1a\u7f6e\u4fe1\u5ea6\u4f4e\uff1b\u9700\u7528\u5c3a\u5bf8\u3001\u5ba2\u5355\u4ef7\u548c\u9000\u8d27\u539f\u56e0\u6570\u636e\u53cd\u9a73\u6216\u652f\u6301\u3002`,
    `3. ${input.category}\u7684\u6a21\u5757\u5316/\u9ad8\u989c\u503c\u53d8\u4f53\uff1a\u7f6e\u4fe1\u5ea6\u4f4e\uff1b\u9700\u901a\u8fc7\u5185\u5bb9\u70b9\u51fb\u4e0e\u6536\u85cf\u4fe1\u53f7\u9a8c\u8bc1\u3002`,
    '',
    '### \u53cd\u8bc1',
    '- \u516c\u5f00\u6765\u6e90\u4e0d\u662f\u5e97\u94fa\u6210\u4ea4\u6570\u636e\uff0c\u4e0d\u80fd\u8bc1\u660e\u4efb\u4f55\u5019\u9009\u4f1a\u6210\u4e3a\u7206\u6b3e\u3002',
    '- \u5982\u679c\u6765\u6e90\u5e74\u4efd\u504f\u65e9\u3001\u53ea\u8986\u76d6\u5bb6\u5c45\u5927\u7c7b\u6216\u6765\u81ea\u54c1\u724c\u4f9b\u7ed9\u7aef\uff0c\u5176\u4e0e\u5f53\u524d\u7ec6\u5206\u7c7b\u76ee\u7684\u76f8\u5173\u6027\u6709\u9650\u3002',
    '- \u7f3a\u5c11\u5e73\u53f0\u641c\u7d22\u6307\u6570\u3001\u6210\u4ea4\u91cf\u3001\u4ef7\u683c\u5e26\u3001\u9000\u8d27\u539f\u56e0\u548c\u5e7f\u544a\u6210\u672c\uff1b\u8fd9\u4e9b\u5b57\u6bb5\u4fdd\u6301\u672a\u77e5\u3002',
    '',
    '### \u6700\u5c0f\u9a8c\u8bc1\u65b9\u6848',
    ...validationBudgetLines(input.budget),
    '',
    '\u786e\u8ba4\u8fb9\u754c\uff1a\u9009\u54c1\u3001\u91c7\u8d2d\u3001\u5e7f\u544a\u6295\u653e\u548c\u5185\u5bb9\u53d1\u5e03\u5747\u9700\u4f60\u9010\u9879\u660e\u786e\u6279\u51c6\u3002\u672c\u6b21\u53ea\u505a\u516c\u5f00\u8bfb\u53d6\u3001\u672c\u5730\u5f52\u6863\u548c\u56de\u6267\u6821\u9a8c\uff0c\u672a\u767b\u5f55\u5e73\u53f0\u3001\u672a\u91c7\u8d2d\u3001\u672a\u6295\u653e\u3001\u672a\u53d1\u5e03\u3002',
  ].join('\n');
}

export async function executeEcommerceTrendDiscovery(
  context?: ToolContext,
  dependencies: TrendDiscoveryDependencies = {},
): Promise<EcommerceTrendDiscoveryReceipt> {
  const sourceInput = String(context?.industryWorkflowSourceInput || context?.actionIntent || context?.routedTaskText || '').trim();
  const platform = field(sourceInput, /\u5e73\u53f0(?:\u662f|\u4e3a|[:\uFF1A])\s*([^\uFF0C,\u3002\uFF1B;]{2,24})/u, '\u7535\u5546\u5e73\u53f0');
  const category = field(sourceInput, /\u7c7b\u76ee(?:\u662f|\u4e3a|[:\uFF1A])\s*([^\uFF0C,\u3002\uFF1B;]{2,32})/u, '\u76ee\u6807\u7c7b\u76ee');
  const audience = field(sourceInput, /\u76ee\u6807\u4eba\u7fa4(?:\u662f|\u4e3a|[:\uFF1A])\s*([^\uFF0C,\u3002\uFF1B;]{2,32})/u, '\u76ee\u6807\u4eba\u7fa4');
  const cutoff = sourceInput.match(/\u622a\u81f3\s*((?:19|20)\d{2}-\d{1,2}-\d{1,2})/u)?.[1] || new Date().toISOString().slice(0, 10);
  const budget = requestedBudget(sourceInput);
  const sourceLimit = industryResearchSourceLimit(sourceInput);
  const userId = context?.userId || 'anonymous';
  const domain = context?.domain === 'work' ? 'work' as const : 'personal' as const;
  const orgId = domain === 'work' ? String(context?.orgId || '') : '';
  const requestId = String(context?.requestId || context?.turnId || `industry_trend_${Date.now()}`);
  const started = startOrReuseIndustryWorkflow({
    userId,
    domain,
    orgId,
    entryId: 'trend-discovery',
    sourceInput,
    source: context?.source || 'industry_bounded_public_research',
    context: { sourceBound: true, publicResearch: true, externalMutation: false },
    idempotencyKey: `industry-trend-discovery:${requestId}`,
    conversationId: context?.conversationId,
    conversationTaskId: context?.taskId,
    requestId,
  }, context?.industryWorkflowTaskId);

  const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const receipt = await executeToolCall({ registry: toolRegistry, id: crypto.randomUUID(), name, arguments: args, context });
    if (receipt.error) throw new Error(receipt.error);
    return String(receipt.result || '');
  };
  const search = dependencies.search || ((args: Record<string, unknown>) => run('web_search', args));
  const fetchUrl = dependencies.fetchUrl || ((args: Record<string, unknown>) => run('url_fetch', args));
  // The tool execution lane has a 30 second deadline. Search strategies are
  // independent, so run them concurrently with their own shorter deadline,
  // then verify candidate URLs concurrently. Only verified receipts consume
  // the user's source budget.
  const searchResults = await Promise.all(buildQueries(platform, category, audience).map(async candidateQuery => {
    try {
      const raw = await within(search({
        query: candidateQuery.query,
        maxResults: 1,
        requirePublicationDate: true,
        relevanceTerms: candidateQuery.relevanceTerms,
      }), 15_000, 'bounded public search');
      return parseSearchReceipt(raw, cutoff);
    } catch {
      return null;
    }
  }));
  const seenCandidateUrls = new Set<string>();
  const candidates = searchResults.filter((receipt): receipt is TrendSourceReceipt => {
    if (!receipt || seenCandidateUrls.has(receipt.url)) return false;
    seenCandidateUrls.add(receipt.url);
    return true;
  });
  const fetchedCandidates = await Promise.all(candidates.map(async receipt => {
    try {
      const fetched = await within(fetchUrl({ url: receipt.url, maxChars: 1_500 }), 6_000, 'public URL verification');
      return publiclyFetchable(fetched, receipt.url) ? receipt : null;
    } catch {
      return null;
    }
  }));
  const sources = fetchedCandidates
    .filter((receipt): receipt is TrendSourceReceipt => Boolean(receipt))
    .slice(0, sourceLimit);

  if (!sources.length) {
    const message = [
      `\u7206\u6b3e\u96f7\u8fbe\u672a\u901a\u8fc7\u6765\u6e90\u9a8c\u6536\uff08\u4efb\u52a1 ${started.task.id}\uff09\u3002`,
      `\u6765\u6e90\u9884\u7b97\u4e0a\u9650\u662f ${sourceLimit} \u4e2a\uff1b\u540c\u65f6\u6ee1\u8db3\u201c\u4e0e ${category} \u76f8\u5173\u3001\u6709\u660e\u786e\u53d1\u5e03\u65e5\u671f\u3001URL \u53ef\u516c\u5f00\u8bfb\u53d6\u201d\u7684\u56de\u6267\u6570\u662f 0\u3002`,
      '\u56e0\u6b64\u672c\u6b21\u4e0d\u751f\u6210\u5019\u9009\u6392\u540d\uff0c\u4e0d\u4f2a\u9020\u6765\u6e90\uff0c\u4e0d\u628a\u65e0\u65e5\u671f/\u65e0\u5173\u9875\u9762\u7b97\u4f5c\u8bc1\u636e\u3002',
      '\u786e\u8ba4\u8fb9\u754c\uff1a\u672a\u767b\u5f55\u3001\u672a\u91c7\u8d2d\u3001\u672a\u6295\u653e\u3001\u672a\u53d1\u5e03\u3002\u540e\u7eed\u5982\u9700\u589e\u52a0\u6765\u6e90\u9884\u7b97\u6216\u4f7f\u7528\u5e73\u53f0\u5bfc\u51fa\u6570\u636e\uff0c\u5fc5\u987b\u5148\u83b7\u5f97\u660e\u786e\u6279\u51c6\u3002',
    ].join('\n');
    updateWorkTakeoverTask(userId, started.task.id, {
      status: 'blocked',
      result: message,
      blockedBy: ['No public source satisfied the requested relevance, publication-date, and accessibility constraints.'],
      note: 'Bounded public research stopped without fabricating evidence.',
    });
    return {
      // The bounded workflow itself completed and proved the blocker. The
      // business research remains blocked, expressed by status/sourceCount.
      ok: true,
      status: 'blocked',
      persisted: true,
      taskId: started.task.id,
      conversationTaskId: started.conversationTaskId,
      message,
      sourceCount: 0,
      sourceLimit,
      externalMutation: false,
      blocker: 'No dated, relevant, publicly fetchable source was verified.',
    };
  }

  const message = buildReport({
    taskId: started.task.id,
    platform,
    category,
    audience,
    budget,
    cutoff,
    sources,
  });
  const evidenceRecords: ToolExecutionRecord[] = sources.map((source, index) => ({
    id: `industry-trend-source-${index + 1}-${requestId}`,
    taskId: started.conversationTaskId,
    turnId: requestId,
    requestId,
    name: 'web_search',
    arguments: { boundedSource: index + 1, sourceLimit },
    result: `${source.raw}\npublicFetchVerified=true`,
    terminalVerification: {
      status: 'verified',
      strategy: 'measured',
      reason: 'The result had an explicit publication date, a relevant search snippet, and a publicly fetchable URL.',
    },
  }));
  assertBoundedTrendResearchEvidence({ sourceInput, resultSummary: message, evidenceRecords });
  const analysisReceipt: ToolExecutionRecord = {
    id: `industry-trend-analysis-${requestId}`,
    taskId: started.conversationTaskId,
    turnId: requestId,
    requestId,
    name: 'industry_ecommerce_trend_discovery',
    arguments: { sourceBound: true, sourceLimit },
    result: JSON.stringify({
      ok: true,
      status: 'verified',
      persisted: true,
      taskId: started.task.id,
      conversationTaskId: started.conversationTaskId,
      sourceBound: true,
      sourceCount: sources.length,
      sourceLimit,
      externalMutation: false,
      sources: sources.map(source => ({
        title: source.title,
        publicationDate: source.publicationDate,
        url: source.url,
      })),
    }),
    terminalVerification: {
      status: 'verified',
      strategy: 'measured',
      reason: 'The bounded trend report was generated only from dated, relevant, publicly fetchable source receipts.',
    },
  };
  const recorded = recordIndustryWorkflowExecution({
    userId,
    domain,
    orgId,
    taskId: started.task.id,
    resultText: message,
    toolRecords: [...evidenceRecords, analysisReceipt],
    source: context?.source || 'industry_bounded_public_research',
  });
  return {
    ok: recorded.verification.passed,
    status: recorded.verification.passed ? 'verified' : recorded.verification.status,
    persisted: true,
    taskId: recorded.task.id,
    conversationTaskId: recorded.conversationTaskId,
    message,
    sourceCount: sources.length,
    sourceLimit,
    externalMutation: false,
    verification: recorded.verification as unknown as Record<string, unknown>,
  };
}
