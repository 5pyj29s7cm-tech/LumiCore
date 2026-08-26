import { ToolRegistry } from '../registry';
import { addMemory } from '../../memory/store';

type ResearchKind =
  | 'auto'
  | 'law_policy'
  | 'academic'
  | 'patent_ip'
  | 'standards'
  | 'technical_docs'
  | 'news_market';

interface SourceProfile {
  label: string;
  domains: string[];
  checks: string[];
  cautions: string[];
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  query: string;
}

interface ScoredSource extends SearchResult {
  host: string;
  authorityScore: number;
  sourceClass: string;
  matchedAuthorityDomain: string | null;
  fetched?: {
    ok: boolean;
    contentType?: string;
    excerpt?: string;
    detectedDate?: string | null;
    error?: string;
  };
}

const KIND_PROFILES: Record<Exclude<ResearchKind, 'auto'>, SourceProfile> = {
  law_policy: {
    label: 'Law, regulation, policy, case, and government guidance',
    domains: [
      'gov.cn',
      'npc.gov.cn',
      'flk.npc.gov.cn',
      'court.gov.cn',
      'chinacourt.gov.cn',
      'cnipa.gov.cn',
      'samr.gov.cn',
      'cac.gov.cn',
      'miit.gov.cn',
      'ndrc.gov.cn',
      'most.gov.cn',
      'mofcom.gov.cn',
      'pbc.gov.cn',
      'csrc.gov.cn',
    ],
    checks: [
      'Prefer primary government, legislature, court, regulator, or official gazette sources.',
      'Verify effective date, amendment date, jurisdiction, and whether the rule is still in force.',
      'Separate binding law/regulation from guidance, interpretation, commentary, or news.',
    ],
    cautions: [
      'Do not give final legal advice; present source-grounded analysis and recommend professional review for high-stakes decisions.',
      'If official sources conflict, cite the conflict and prefer newer or higher-authority sources.',
    ],
  },
  academic: {
    label: 'Academic literature and papers',
    domains: [
      'doi.org',
      'arxiv.org',
      'pubmed.ncbi.nlm.nih.gov',
      'pmc.ncbi.nlm.nih.gov',
      'aclanthology.org',
      'ieee.org',
      'acm.org',
      'springer.com',
      'nature.com',
      'science.org',
      'sciencedirect.com',
      'ssrn.com',
      'papers.ssrn.com',
    ],
    checks: [
      'Prefer DOI, publisher, preprint server, PubMed/PMC, or official conference/library pages.',
      'Check publication date, venue, peer-review status, sample size, and whether the claim is from results or speculation.',
      'Separate paper findings from later commentary or secondary summaries.',
    ],
    cautions: [
      'Preprints can be useful but should be labeled as not peer reviewed unless the source proves otherwise.',
      'Do not overstate a paper beyond the abstract/results evidence available.',
    ],
  },
  patent_ip: {
    label: 'Patent, copyright, software copyright, and intellectual property',
    domains: [
      'ccopyright.com.cn',
      'ncac.gov.cn',
      'gov.cn',
      'cnipa.gov.cn',
      'cponline.cnipa.gov.cn',
      'wipo.int',
      'epo.org',
      'uspto.gov',
      'copyright.gov',
    ],
    checks: [
      'Prefer patent office, copyright authority, official database, law, and examination guideline sources.',
      'Verify filing/publication date, applicant/assignee, jurisdiction, and current legal status when available.',
      'Separate patentability rules from registration practice and commercial IP strategy.',
    ],
    cautions: [
      'Novelty and inventiveness require a prior-art search; source packets are not a final patentability opinion.',
      'Copyright/software-copyright conclusions depend on authorship, ownership records, licenses, and local filing practice.',
    ],
  },
  standards: {
    label: 'Standards and technical specifications',
    domains: [
      'gb688.cn',
      'samr.gov.cn',
      'std.samr.gov.cn',
      'iso.org',
      'iec.ch',
      'itu.int',
      'ieee.org',
      'w3.org',
      'ietf.org',
    ],
    checks: [
      'Prefer the issuing standards body or official standards platform.',
      'Verify standard number, year, status, replacement relation, scope, and whether it is mandatory or recommended.',
      'Avoid relying on copied PDFs or vendor summaries when official metadata is available.',
    ],
    cautions: [
      'Some standards are paywalled; cite available official metadata and say when full text was not accessible.',
    ],
  },
  technical_docs: {
    label: 'Technical documentation and developer references',
    domains: [
      'docs.github.com',
      'github.com',
      'developer.mozilla.org',
      'nodejs.org',
      'react.dev',
      'typescriptlang.org',
      'vite.dev',
      'tauri.app',
      'openai.com',
      'platform.openai.com',
      'anthropic.com',
      'cloud.google.com',
      'learn.microsoft.com',
    ],
    checks: [
      'Prefer official documentation, release notes, source repositories, and primary API references.',
      'Check version, deprecation status, and whether examples match the local stack.',
      'Use community posts only as secondary troubleshooting evidence.',
    ],
    cautions: [
      'APIs change quickly; include version/date when possible.',
    ],
  },
  news_market: {
    label: 'Current news, company, product, and market information',
    domains: [
      'sec.gov',
      'hkexnews.hk',
      'sse.com.cn',
      'szse.cn',
      'nasdaq.com',
      'nyse.com',
      'reuters.com',
      'apnews.com',
      'prnewswire.com',
      'businesswire.com',
      'theverge.com',
      'techcrunch.com',
    ],
    checks: [
      'Prefer primary filings, official announcements, and reputable news wires.',
      'Check publication date and whether the event actually happened or is only planned/rumored.',
      'Distinguish official statements from analysis, leaks, and commentary.',
    ],
    cautions: [
      'For time-sensitive topics, newer sources may supersede older summaries.',
    ],
  },
};

const LOW_AUTHORITY_HOSTS = [
  'baidu.com',
  'zhihu.com',
  'csdn.net',
  'jianshu.com',
  'toutiao.com',
  'sohu.com',
  '163.com',
  'wikipedia.org',
];

function inferKind(query: string, requested?: string): Exclude<ResearchKind, 'auto'> {
  const normalized = String(requested || '').trim() as ResearchKind;
  if (normalized && normalized !== 'auto' && KIND_PROFILES[normalized]) return normalized;
  const text = query.toLowerCase();
  if (/(专利|知识产权|软著|软件著作权|著作权|copyright|patent|cnipa|wipo|inventiveness|novelty)/i.test(text)) return 'patent_ip';
  if (/(法律|法规|条例|办法|政策|法条|判例|裁判|法院|监管|合规|law|regulation|policy|statute|case law|court)/i.test(text)) return 'law_policy';
  if (/(论文|文献|期刊|doi|arxiv|pubmed|paper|journal|conference|preprint|peer review)/i.test(text)) return 'academic';
  if (/(标准|国标|iso|iec|ieee|w3c|ietf|gb\/t|gb |specification|standard)/i.test(text)) return 'standards';
  if (/(api|sdk|文档|documentation|release notes|github|npm|python|typescript|react|tauri|openai)/i.test(text)) return 'technical_docs';
  return 'news_market';
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function domainMatches(host: string, domain: string): boolean {
  const clean = domain.toLowerCase().replace(/^www\./, '');
  return host === clean || host.endsWith(`.${clean}`);
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}\n[truncated]`;
}

async function fetchText(url: string, maxChars: number): Promise<ScoredSource['fetched']> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LumiCore-AuthorityResearch/1.0',
        Accept: 'text/html,application/xhtml+xml,application/xml,text/plain,application/json;q=0.8,*/*;q=0.5',
      },
    });
    clearTimeout(timeout);
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      return { ok: false, contentType, error: `HTTP ${response.status}: ${response.statusText}` };
    }
    if (!/text\/|application\/json|application\/xml|application\/xhtml/i.test(contentType)) {
      return { ok: false, contentType, error: `Unsupported content type: ${contentType || 'unknown'}` };
    }
    const raw = await response.text();
    const text = stripTags(raw);
    return {
      ok: true,
      contentType,
      excerpt: truncate(text, maxChars),
      detectedDate: detectDate(text),
    };
  } catch (err: any) {
    return { ok: false, error: err?.name === 'AbortError' ? 'Fetch timed out' : String(err?.message || err) };
  }
}

async function bingSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(
      `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}&mkt=zh-CN`,
      {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      },
    );
    clearTimeout(timeout);
    if (!response.ok) return [];
    const html = await response.text();
    const results: SearchResult[] = [];
    const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = blockRe.exec(html)) && results.length < maxResults) {
      const block = blockMatch[1];
      const urlMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i);
      if (!urlMatch) continue;
      const h2Match = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      results.push({
        title: h2Match ? stripTags(h2Match[1]) : decodeEntities(urlMatch[1]),
        url: decodeEntities(urlMatch[1]),
        snippet: snippetMatch ? stripTags(snippetMatch[1]) : '',
        query,
      });
    }
    return results;
  } catch {
    return [];
  }
}

function detectDate(text: string): string | null {
  const match = text.match(/\b(20\d{2}|19\d{2})(?:[-/.年]\s?(0?[1-9]|1[0-2]))?(?:[-/.月]\s?([0-2]?\d|3[01])日?)?\b/);
  return match?.[0]?.replace(/\s+/g, '') || null;
}

function classifySource(host: string, kind: Exclude<ResearchKind, 'auto'>): string {
  if (!host) return 'unknown';
  if (/\bgov\b|gov\.cn$|\.gov$/.test(host) || domainMatches(host, 'npc.gov.cn') || domainMatches(host, 'flk.npc.gov.cn')) {
    return 'official_government';
  }
  if (kind === 'patent_ip' && /(cnipa|wipo|epo|uspto|copyright|ncac|ccopyright)/i.test(host)) return 'official_ip_authority';
  if (kind === 'standards' && /(iso|iec|itu|w3|ietf|gb688|samr|ieee)/i.test(host)) return 'standards_body';
  if (kind === 'academic' && /(doi|arxiv|pubmed|pmc|aclanthology|ieee|acm|springer|nature|science|sciencedirect|ssrn)/i.test(host)) {
    return 'academic_primary_or_index';
  }
  if (kind === 'technical_docs' && /(docs|developer|learn|github|nodejs|react|typescript|vite|tauri|openai|anthropic|google|microsoft)/i.test(host)) {
    return 'official_or_source_documentation';
  }
  if (kind === 'news_market' && /(sec|hkex|sse|szse|nasdaq|nyse|reuters|apnews|businesswire|prnewswire)/i.test(host)) {
    return 'primary_filing_or_reputable_wire';
  }
  return 'secondary_or_general_web';
}

function scoreSource(result: SearchResult, kind: Exclude<ResearchKind, 'auto'>, authorityDomains: string[]): ScoredSource {
  const host = hostOf(result.url);
  let score = 40;
  let matchedAuthorityDomain: string | null = null;
  for (const domain of authorityDomains) {
    if (domainMatches(host, domain)) {
      matchedAuthorityDomain = domain;
      score += 38;
      break;
    }
  }
  const sourceClass = classifySource(host, kind);
  if (sourceClass.startsWith('official')) score += 18;
  if (sourceClass === 'standards_body' || sourceClass === 'academic_primary_or_index' || sourceClass === 'primary_filing_or_reputable_wire') score += 16;
  if (LOW_AUTHORITY_HOSTS.some(domain => domainMatches(host, domain))) score -= 24;
  if (/blog|forum|bbs|ask|question|community/i.test(host)) score -= 10;
  if (/pdf/i.test(result.url)) score += 4;
  return {
    ...result,
    host,
    authorityScore: Math.max(0, Math.min(100, score)),
    sourceClass,
    matchedAuthorityDomain,
  };
}

function buildSearchQueries(
  query: string,
  kind: Exclude<ResearchKind, 'auto'>,
  jurisdiction: string,
  domains: string[],
): string[] {
  const seedQueries: string[] = [];
  if (kind === 'patent_ip' && /(软著|软件著作权|著作权|copyright|版权)/i.test(query)) {
    seedQueries.push(
      '计算机软件著作权登记办法 官方',
      '计算机软件保护条例 官方',
      '著作权法 作品 独创性 官方',
      '软件著作权 登记 中国版权保护中心',
    );
  } else if (kind === 'patent_ip' && /(专利|patent|新颖性|创造性|现有技术|发明)/i.test(query)) {
    seedQueries.push(
      '专利审查指南 人工智能 算法 官方',
      '专利法 实施细则 发明人 创造性贡献 官方',
      '专利 新颖性 创造性 现有技术 官方',
    );
  } else if (kind === 'law_policy') {
    seedQueries.push(
      `${query} 法律法规数据库`,
      `${query} 国务院 官方`,
    );
  } else if (kind === 'standards') {
    seedQueries.push(`${query} 全国标准信息公共服务平台`);
  }
  const suffix =
    kind === 'law_policy' || kind === 'patent_ip'
      ? `${jurisdiction} official source`
      : kind === 'academic'
        ? 'DOI paper official'
        : kind === 'standards'
          ? 'official standard'
          : 'official documentation';
  const domainQueries = domains.slice(0, 4).map(domain => `${query} site:${domain}`);
  const seededDomainQueries = seedQueries.flatMap(seed => domains.slice(0, 2).map(domain => `${seed} site:${domain}`));
  return unique([`${query} ${suffix}`, ...domainQueries, ...seedQueries, ...seededDomainQueries]).slice(0, 8);
}

function prioritizeAuthorityDomains(
  query: string,
  kind: Exclude<ResearchKind, 'auto'>,
  domains: string[],
): string[] {
  if (kind !== 'patent_ip') return domains;
  const text = query.toLowerCase();
  const preferred = /(软著|软件著作权|著作权|copyright|版权)/i.test(text)
    ? ['ccopyright.com.cn', 'ncac.gov.cn', 'gov.cn', 'copyright.gov']
    : /(专利|patent|新颖性|创造性|现有技术|发明)/i.test(text)
      ? ['cnipa.gov.cn', 'cponline.cnipa.gov.cn', 'wipo.int', 'epo.org', 'uspto.gov']
      : [];
  return unique([
    ...preferred,
    ...domains,
  ]);
}

async function authorityResearchHandler(args: Record<string, any>): Promise<string> {
  const query = String(args.query || args.topic || '').trim();
  if (!query) throw new Error('query is required.');

  const kind = inferKind(query, args.kind);
  const profile = KIND_PROFILES[kind];
  const jurisdiction = String(args.jurisdiction || 'CN').trim() || 'CN';
  const maxResults = Math.min(Math.max(Number(args.maxResults) || 8, 3), 12);
  const fetchTop = Math.min(Math.max(Number(args.fetchTop) || 4, 0), 6);
  const excerptChars = Math.min(Math.max(Number(args.excerptChars) || 900, 300), 1800);
  const extraDomains = Array.isArray(args.sourceDomains)
    ? args.sourceDomains.map((item: unknown) => String(item).trim()).filter(Boolean)
    : [];
  const authorityDomains = prioritizeAuthorityDomains(query, kind, unique([...extraDomains, ...profile.domains]));
  const searchQueries = buildSearchQueries(query, kind, jurisdiction, authorityDomains);

  const searchBatches = await Promise.allSettled(searchQueries.map(searchQuery => bingSearch(searchQuery, maxResults)));
  const rawResults = searchBatches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : []);
  const byUrl = new Map<string, SearchResult>();
  for (const result of rawResults) {
    const key = result.url.replace(/[?#].*$/, '').toLowerCase();
    if (!byUrl.has(key)) byUrl.set(key, result);
  }

  const scored = Array.from(byUrl.values())
    .map(result => scoreSource(result, kind, authorityDomains))
    .sort((a, b) => b.authorityScore - a.authorityScore || a.title.localeCompare(b.title))
    .slice(0, maxResults);

  const fetched = await Promise.allSettled(scored.slice(0, fetchTop).map(source => fetchText(source.url, excerptChars)));
  fetched.forEach((result, index) => {
    scored[index].fetched = result.status === 'fulfilled' ? result.value : { ok: false, error: result.reason?.message || String(result.reason) };
  });

  return JSON.stringify({
    query,
    kind,
    profile: profile.label,
    generatedAt: new Date().toISOString(),
    jurisdiction,
    searchQueries,
    authorityDomains: authorityDomains.slice(0, 24),
    sourceCount: scored.length,
    sources: scored.map(source => ({
      title: source.title,
      url: source.url,
      host: source.host,
      authorityScore: source.authorityScore,
      sourceClass: source.sourceClass,
      matchedAuthorityDomain: source.matchedAuthorityDomain,
      snippet: source.snippet,
      fetched: source.fetched,
    })),
    answerProtocol: [
      'Answer from the strongest primary/official sources first; use secondary sources only as support.',
      'Cite URLs next to factual claims and mention publication/effective dates when available.',
      'Say what was verified, what remains uncertain, and what source would be needed for stronger certainty.',
      'If the user asks to preserve the research, ask before writing it into Lumi knowledge base or memory.',
    ],
    requiredChecks: profile.checks,
    cautions: profile.cautions,
    fallback: scored.length
      ? undefined
      : 'No source candidates were found. Try an exact title, official organization name, law/standard number, DOI, patent publication number, or custom sourceDomains.',
  }, null, 2);
}

function normalizeKeywords(values: unknown[]): string[] {
  return unique(
    values
      .flatMap(value => String(value || '').split(/[,;\uFF0C\uFF1B\s]+/))
      .map(value => value.trim())
      .filter(value => value.length > 1)
      .slice(0, 64),
  );
}

function chunkText(text: string, maxChars = 1800): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    const chunk = text.slice(index, index + maxChars).trim();
    if (chunk) chunks.push(chunk);
    index += maxChars;
  }
  return chunks;
}

function extractSourceUrls(packet: any): string[] {
  const sources = Array.isArray(packet?.sources) ? packet.sources : [];
  return sources
    .map((source: any) => String(source?.url || '').trim())
    .filter(url => /^https?:\/\//i.test(url))
    .slice(0, 16);
}

function buildAuthorityMemoryText(args: Record<string, any>): { title: string; text: string; keywords: string[] } {
  const title = String(args.title || args.query || args.topic || 'Authority research').trim();
  const summary = String(args.summary || '').trim();
  const rawPacket = args.researchPacket ?? args.packet ?? args.evidence ?? '';
  let packet: any = rawPacket;
  if (typeof rawPacket === 'string') {
    try { packet = JSON.parse(rawPacket); } catch {}
  }
  const packetText = typeof packet === 'string' ? packet : JSON.stringify(packet, null, 2);
  const sourceUrls = extractSourceUrls(packet);
  const kind = String(args.kind || packet?.kind || 'authority_research').trim();
  const query = String(args.query || packet?.query || title).trim();
  const generatedAt = String(packet?.generatedAt || new Date().toISOString());
  const text = [
    `Title: ${title}`,
    `Kind: ${kind}`,
    `Query: ${query}`,
    `CapturedAt: ${generatedAt}`,
    sourceUrls.length ? `Sources: ${sourceUrls.join(' ; ')}` : '',
    summary ? `Summary:\n${summary}` : '',
    `Evidence packet:\n${packetText}`,
  ].filter(Boolean).join('\n\n');
  const keywords = normalizeKeywords([
    title,
    query,
    kind,
    'authority_research',
    'authoritative_source',
    'citation',
    ...sourceUrls.map(url => hostOf(url)),
    ...(Array.isArray(args.keywords) ? args.keywords : []),
  ]);
  return { title, text, keywords };
}

async function authorityResearchSaveHandler(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.userConfirmed) {
    throw new Error('Saving authority research into Lumi knowledge requires explicit user confirmation.');
  }
  const userId = String(args.userId || context?.userId || 'system').replace(/[^a-zA-Z0-9_-]/g, '_');
  const domain = args.domain === 'work' ? 'work' : 'personal';
  const orgId = String(args.orgId || '').trim();
  const agentId = String(args.agentId || '').trim();
  const { title, text, keywords } = buildAuthorityMemoryText(args);
  const chunks = chunkText(text, Math.min(Math.max(Number(args.chunkSize) || 1800, 800), 3000));
  const memoryIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const memory = addMemory(
      {
        userId,
        type: 'knowledge',
        content: `[Authority Research: ${title} #${i + 1}/${chunks.length}]\n${chunks[i]}`,
        keywords: [...keywords, `chunk:${i + 1}/${chunks.length}`],
        confidence: 0.82,
        sourceInteractionId: `authority_research:${title}`,
      },
      {
        tier: 'internalized',
        perspective: 'lumi_self',
        importance: 0.62,
        agentId,
        domain,
        orgId,
        source: 'import',
        privacyClass: domain === 'work' ? 'organization' : 'private',
        retention: 'long_term',
        userApproved: true,
      },
    );
    memoryIds.push(memory.id);
  }

  return JSON.stringify({
    saved: true,
    title,
    domain,
    orgId,
    agentId,
    chunkCount: chunks.length,
    memoryIds,
    keywords: keywords.slice(0, 24),
    note: 'Authority research was saved as long-term knowledge memories. It will be retrievable by source, title, query, and cited domains.',
  }, null, 2);
}

export function registerAuthorityResearchTools(registry: ToolRegistry): void {
  registry.register({
    name: 'authority_research',
    description:
      'Find and score authoritative sources for questions about laws, regulations, policies, cases, patents, software copyright, standards, academic papers, technical docs, and current company/news facts. It searches primary domains first, fetches excerpts from top sources, and returns an evidence packet with URLs, authority scores, checks, and cautions. Use before answering high-stakes or citation-heavy questions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Research question or source title/number to verify.' },
        topic: { type: 'string', description: 'Alias for query.' },
        kind: {
          type: 'string',
          description: 'Research kind. Defaults to auto inference.',
          enum: ['auto', 'law_policy', 'academic', 'patent_ip', 'standards', 'technical_docs', 'news_market'],
        },
        jurisdiction: { type: 'string', description: 'Jurisdiction or region hint, e.g. CN, US, EU. Defaults to CN.' },
        sourceDomains: {
          type: 'array',
          description: 'Optional custom trusted domains to prioritize, e.g. ["cnipa.gov.cn", "npc.gov.cn"].',
          items: { type: 'string' },
        },
        maxResults: { type: 'number', description: 'Maximum scored sources to return, 3-12. Default 8.' },
        fetchTop: { type: 'number', description: 'How many top sources to fetch excerpts from, 0-6. Default 4.' },
        excerptChars: { type: 'number', description: 'Characters per fetched excerpt, 300-1800. Default 900.' },
      },
      required: ['query'],
    },
    handler: authorityResearchHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'authority_research_save',
    description:
      'Save a verified authority_research packet, citation summary, or source bundle into Lumi long-term knowledge memory after explicit user confirmation. Use when the user says to remember, absorb, keep, deposit into knowledge base, or reuse the research later. Never call silently.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable knowledge title.' },
        query: { type: 'string', description: 'Original research question.' },
        kind: {
          type: 'string',
          description: 'Research kind.',
          enum: ['law_policy', 'academic', 'patent_ip', 'standards', 'technical_docs', 'news_market'],
        },
        summary: { type: 'string', description: 'Short source-grounded summary to store with the packet.' },
        researchPacket: { type: 'string', description: 'JSON string or text returned by authority_research.' },
        keywords: { type: 'array', description: 'Optional retrieval keywords.', items: { type: 'string' } },
        domain: { type: 'string', description: 'personal or work. Default personal.' },
        orgId: { type: 'string', description: 'Organization ID when domain is work.' },
        agentId: { type: 'string', description: 'Optional agent scope. Empty means shared user knowledge.' },
        chunkSize: { type: 'number', description: 'Characters per memory chunk, 800-3000. Default 1800.' },
      },
      required: ['title', 'researchPacket'],
    },
    handler: authorityResearchSaveHandler,
    permission: 'user',
    securityLevel: 'confirm',
  });
}
