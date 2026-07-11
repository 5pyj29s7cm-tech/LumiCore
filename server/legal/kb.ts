/**
 * Legal Knowledge Base Engine — extends org KB with legal-specific capabilities:
 * case similarity search, statute validation, citation tracking, legal-aware chunking.
 *
 * Built on top of the existing org KB infrastructure (org/db.ts, org/kb.ts).
 * All data stored in org_kb_articles + org_kb_embeddings with legal metadata.
 */
import * as EDB from '../org/db';
import { generateEmbedding, cosineSimilarity } from '../memory/store';
import { chunkLegalText } from './parser';
import { LUMI_EMBEDDING_MODEL } from './types';

// ── Legal Article Types ──────────────────────────────────────────────────

export type LegalArticleType =
  | 'judgment'
  | 'statute'
  | 'contract'
  | 'bid_template'
  | 'legal_opinion'
  | 'case_material'
  | 'evidence'
  | 'pleading'
  | 'transcript'
  | 'research_note'
  | 'company_report';

export interface LegalArticleMeta {
  articleType: LegalArticleType;
  caseNumber?: string;
  court?: string;
  parties?: string[];
  causeOfAction?: string;
  judgmentDate?: string;
  statutesCited?: string[];
  jurisdiction?: string;
  effectiveDate?: string;
  repealedDate?: string;
  /** Whether this statute is still in effect */
  isEffective?: boolean;
}

// ── Create / Index Legal Article ────────────────────────────────────────

export function createLegalArticle(
  orgId: string,
  authorId: string,
  data: { title: string; content: string; category?: string; tags?: string[]; articleType: LegalArticleType; metadata?: LegalArticleMeta },
) {
  const tags = data.tags || [];
  tags.push(`legal:${data.articleType}`);
  if (data.metadata?.caseNumber) tags.push(`case:${data.metadata.caseNumber}`);
  if (data.metadata?.jurisdiction) tags.push(`jurisdiction:${data.metadata.jurisdiction}`);

  return EDB.createKbArticle(orgId, authorId, {
    title: data.title,
    content: data.content,
    category: data.category || `legal_${data.articleType}`,
    tags,
  });
}

export async function indexLegalArticle(orgId: string, articleId: string): Promise<number> {
  const article = EDB.getKbArticle(orgId, articleId);
  if (!article) return 0;

  EDB.deleteKbEmbeddings(articleId);

  const chunks = chunkLegalText(article.content, 800, 150);
  if (chunks.length === 0) return 0;

  let indexed = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const embedding = await generateEmbedding(chunks[i]);
      if (embedding) {
        EDB.saveKbEmbedding(articleId, i, embedding, chunks[i], LUMI_EMBEDDING_MODEL);
        indexed++;
      }
      if (i > 0 && i % 5 === 0) {
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err) {
      console.error(`[LegalKB] Failed to embed chunk ${i} of ${articleId}:`, err);
    }
  }

  return indexed;
}

// ── Case Similarity Search ──────────────────────────────────────────────

export interface CaseResult {
  articleId: string;
  title: string;
  caseNumber?: string;
  court?: string;
  chunk: string;
  score: number;
  date?: string;
}

export async function searchSimilarCases(
  orgId: string,
  query: string,
  limit = 5,
): Promise<CaseResult[]> {
  const allEmbeddings = EDB.getAllKbEmbeddings(orgId);
  if (allEmbeddings.length === 0) return [];

  // Only search judgment-type articles
  const judgmentArticles = EDB.listKbArticles(orgId, { category: 'legal_judgment' });
  const judgmentIds = new Set(judgmentArticles.map(a => a.id));
  const relevantEmbeddings = allEmbeddings.filter(e => judgmentIds.has(e.articleId));
  if (relevantEmbeddings.length === 0) return [];

  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await generateEmbedding(query);
  } catch {
    return [];
  }
  if (!queryEmbedding) return [];

  const results = relevantEmbeddings
    .map(emb => {
      let vec: number[];
      try { vec = JSON.parse(emb.embedding); } catch { return null; }
      return { ...emb, score: cosineSimilarity(queryEmbedding!, vec) };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null && r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return results.map(r => {
    const article = judgmentArticles.find(a => a.id === r.articleId);
    let tags: string[] = [];
    try { tags = JSON.parse(article?.tags || '[]'); } catch {}
    const caseNum = tags.find(t => t.startsWith('case:'))?.replace('case:', '');
    const court = tags.find(t => t.startsWith('jurisdiction:'))?.replace('jurisdiction:', '');

    return {
      articleId: r.articleId,
      title: article?.title || '(unknown)',
      caseNumber: caseNum,
      court,
      chunk: r.content,
      score: Math.round(r.score * 1000) / 1000,
      date: article?.createdAt,
    };
  });
}

// ── Statute Search & Validation ─────────────────────────────────────────

export interface StatuteResult {
  articleId: string;
  title: string;
  chunk: string;
  score: number;
  isEffective: boolean;
  content?: string;
}

interface StatuteVerificationSnapshot {
  source: string;
  sourceUrl: string;
  verifiedAt: string;
  articleMin?: number;
  articleMax?: number;
}

interface StatuteRegistryEntry {
  title: string;
  effective: boolean;
  repealedDate?: string;
  verification?: StatuteVerificationSnapshot;
}

const CIVIL_CODE_VERIFICATION: StatuteVerificationSnapshot = {
  source: '国家法律法规数据库',
  sourceUrl: 'https://flk.npc.gov.cn/detail?fileId=&id=ff808081729d1efe01729d50b5c500bf&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E6%B0%91%E6%B3%95%E5%85%B8&type=',
  verifiedAt: '2026-07-12',
  articleMin: 1,
  articleMax: 1260,
};

/** Law-name registry. Formal article verification requires a sourced snapshot. */
const STATUTE_REGISTRY: Record<string, StatuteRegistryEntry> = {
  '民法典': { title: '中华人民共和国民法典', effective: true, verification: CIVIL_CODE_VERIFICATION },
  '刑法': { title: '中华人民共和国刑法', effective: true },
  '刑事诉讼法': { title: '中华人民共和国刑事诉讼法', effective: true },
  '民事诉讼法': { title: '中华人民共和国民事诉讼法', effective: true },
  '行政诉讼法': { title: '中华人民共和国行政诉讼法', effective: true },
  '公司法': { title: '中华人民共和国公司法（2023修订）', effective: true },
  '合同法': { title: '中华人民共和国合同法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '物权法': { title: '中华人民共和国物权法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '侵权责任法': { title: '中华人民共和国侵权责任法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '婚姻法': { title: '中华人民共和国婚姻法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '继承法': { title: '中华人民共和国继承法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '民法通则': { title: '中华人民共和国民法通则', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '担保法': { title: '中华人民共和国担保法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '劳动合同法': { title: '中华人民共和国劳动合同法', effective: true },
  '知识产权法': { title: '中华人民共和国著作权法', effective: true },
  '商标法': { title: '中华人民共和国商标法', effective: true },
  '专利法': { title: '中华人民共和国专利法', effective: true },
  '反不正当竞争法': { title: '中华人民共和国反不正当竞争法', effective: true },
  '消费者权益保护法': { title: '中华人民共和国消费者权益保护法', effective: true },
  '企业破产法': { title: '中华人民共和国企业破产法', effective: true },
  '证券法': { title: '中华人民共和国证券法', effective: true },
  '招标投标法': { title: '中华人民共和国招标投标法', effective: true },
  '政府采购法': { title: '中华人民共和国政府采购法', effective: true },
  '民法典婚姻家庭编': { title: '中华人民共和国民法典 第五编 婚姻家庭', effective: true },
  '民法典继承编': { title: '中华人民共和国民法典 第六编 继承', effective: true },
  '民法典合同编': { title: '中华人民共和国民法典 第三编 合同', effective: true },
  '民法典物权编': { title: '中华人民共和国民法典 第二编 物权', effective: true },
  '民法典侵权责任编': { title: '中华人民共和国民法典 第七编 侵权责任', effective: true },
};

const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function parseArticleNumber(value: string): number | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);

  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let total = 0;
  let section = 0;
  let number = 0;
  let sawNumber = false;

  for (const char of raw) {
    if (char in CHINESE_DIGITS) {
      number = number * 10 + CHINESE_DIGITS[char];
      sawNumber = true;
      continue;
    }
    const unit = units[char];
    if (!unit) return null;
    sawNumber = true;
    if (unit === 10000) {
      total += (section + number) * unit;
      section = 0;
    } else {
      section += (number || 1) * unit;
    }
    number = 0;
  }

  return sawNumber ? total + section + number : null;
}

function extractArticleNumber(citation: string): number | null {
  const match = citation.match(/第([零〇一二两三四五六七八九十百千万\d]+)条/);
  return match ? parseArticleNumber(match[1]) : null;
}

function verificationSource(snapshot: StatuteVerificationSnapshot): string {
  return `${snapshot.source}（核验快照 ${snapshot.verifiedAt}，${snapshot.sourceUrl}）`;
}

export async function searchStatutes(
  orgId: string,
  query: string,
  limit = 5,
): Promise<StatuteResult[]> {
  const results: StatuteResult[] = [];

  // 1. Check built-in registry first
  for (const [key, info] of Object.entries(STATUTE_REGISTRY)) {
    if (query.includes(key) || key.includes(query) || info.title.includes(query)) {
      results.push({
        articleId: `statute:${key}`,
        title: info.title,
        chunk: `${info.title}${info.effective ? ' — 法名状态候选' : ` — 已废止${info.repealedDate ? `（${info.repealedDate}起）` : ''}`}${info.verification ? `；来源核验于 ${info.verification.verifiedAt}` : '；正式交付前需权威来源核验'}`,
        score: 1.0,
        isEffective: info.effective,
      });
    }
  }

  // 2. Search local KB for statute articles
  const statuteArticles = EDB.listKbArticles(orgId, { category: 'legal_statute' });
  if (statuteArticles.length > 0) {
    const allEmbeddings = EDB.getAllKbEmbeddings(orgId);
    const statuteIds = new Set(statuteArticles.map(a => a.id));
    const relevant = allEmbeddings.filter(e => statuteIds.has(e.articleId));

    if (relevant.length > 0) {
      let queryEmb: number[] | null = null;
      try { queryEmb = await generateEmbedding(query); } catch { /* empty */ }

      if (queryEmb) {
        const semantic = relevant
          .map(emb => {
            let vec: number[];
            try { vec = JSON.parse(emb.embedding); } catch { return null; }
            return { ...emb, score: cosineSimilarity(queryEmb!, vec) };
          })
          .filter((s): s is NonNullable<typeof s> => s !== null && s.score > 0.3)
          .sort((a, b) => b.score - a.score);

        for (const s of semantic) {
          const article = statuteArticles.find(a => a.id === s.articleId);
          if (article && !results.find(r => r.articleId === article.id)) {
            let tags: string[] = [];
            try { tags = JSON.parse(article.tags || '[]'); } catch {}
            const effective = !tags.includes('repealed');
            results.push({
              articleId: article.id,
              title: article.title,
              chunk: s.content,
              score: Math.round(s.score * 1000) / 1000,
              isEffective: effective,
            });
          }
        }
      }
    }
  }

  return results.slice(0, limit);
}

// ── Citation Verification ───────────────────────────────────────────────

export interface CitationCheck {
  citation: string;
  type: 'statute' | 'case';
  exists: boolean;
  isEffective: boolean | null;
  source: string;
  detail: string;
}

export function verifyCitation(citation: string, orgId?: string): CitationCheck {
  // Check if it's a statute citation
  const statuteMatch = citation.match(/《([^》]+)》/);
  if (statuteMatch) {
    const statuteName = statuteMatch[1].trim();
    const found = Object.values(STATUTE_REGISTRY).find(
      s => s.title.includes(statuteName) || statuteName.includes(s.title),
    );
    if (found) {
      const articleNumber = extractArticleNumber(citation);
      const verification = found.verification;

      if (!found.effective) {
        return {
          citation,
          type: 'statute',
          exists: true,
          isEffective: false,
          source: verification ? verificationSource(verification) : '内置法名状态表（待权威来源复核）',
          detail: `${found.title} 已于${found.repealedDate || '民法典施行日'}废止，请引用现行法律相关条款`,
        };
      }

      if (articleNumber !== null) {
        const articleVerified = verification
          && verification.articleMin !== undefined
          && verification.articleMax !== undefined
          && articleNumber >= verification.articleMin
          && articleNumber <= verification.articleMax;
        if (!articleVerified) {
          return {
            citation,
            type: 'statute',
            exists: false,
            isEffective: null,
            source: verification ? verificationSource(verification) : '内置法名状态表（不含条文核验）',
            detail: verification?.articleMax !== undefined
              ? `《${statuteName}》存在，但第${articleNumber}条超出已核验条文范围（${verification.articleMin}-${verification.articleMax}条）。`
              : `《${statuteName}》法名已识别，但第${articleNumber}条尚未通过权威文本核验。`,
          };
        }
      } else if (!verification) {
        return {
          citation,
          type: 'statute',
          exists: true,
          isEffective: null,
          source: '内置法名状态表（非实时权威核验）',
          detail: `${found.title} 法名已识别，但正式交付前仍需核验当前版本和生效状态。`,
        };
      }

      return {
        citation,
        type: 'statute',
        exists: true,
        isEffective: true,
        source: verification ? verificationSource(verification) : '内置法名状态表（非实时权威核验）',
        detail: articleNumber === null
          ? `${found.title} 已按所列权威来源核验。`
          : `${found.title} 第${articleNumber}条位于已核验权威文本条文范围内。`,
      };
    }
    return {
      citation,
      type: 'statute',
      exists: false,
      isEffective: null,
      source: '',
      detail: `未在已知法条库中找到《${statuteName}》，请核实法条名称是否准确。`,
    };
  }

  // Check if it's a case number citation: (2024)京0105民初12345号
  const caseMatch = citation.match(/[（(]\d{4}[）)].*?[号字]/);
  if (caseMatch && orgId) {
    const articles = EDB.listKbArticles(orgId, { category: 'legal_judgment' });
    const found = articles.find(a => {
      try {
        const tags = JSON.parse(a.tags || '[]');
        return tags.some((t: string) => t.includes(caseMatch[0]));
      } catch { return false; }
    });
    if (found) {
      return {
        citation,
        type: 'case',
        exists: true,
        isEffective: null,
        source: found.title,
        detail: `案号存在，已收录于知识库。`,
      };
    }
    return {
      citation,
      type: 'case',
      exists: false,
      isEffective: null,
      source: '',
      detail: `案号 ${caseMatch[0]} 未在本地知识库中找到，建议在中国裁判文书网核实。`,
    };
  }

  return {
    citation,
    type: 'statute',
    exists: false,
    isEffective: null,
    source: '',
    detail: '无法识别引用格式，请提供法条名称（《XX法》）或案号。',
  };
}

// ── Batch Citation Verification ─────────────────────────────────────────

export function verifyMultipleCitations(text: string, orgId?: string): CitationCheck[] {
  const checks: CitationCheck[] = [];

  // Find all 《...》 statute citations
  const statuteRe = /《[^》]+》(?:第[零〇一二两三四五六七八九十百千万\d]+条(?:之[零〇一二两三四五六七八九十百千万\d]+)?(?:第[零〇一二两三四五六七八九十百千万\d]+款)?(?:第[零〇一二两三四五六七八九十百千万\d]+项)?)?/g;
  let m: RegExpExecArray | null;
  while ((m = statuteRe.exec(text)) !== null) {
    checks.push(verifyCitation(m[0], orgId));
  }

  // Find all case number patterns
  const caseRe = /[（(]\d{4}[）)][^号]*[号字]/g;
  let cm: RegExpExecArray | null;
  while ((cm = caseRe.exec(text)) !== null) {
    if (!checks.find(c => c.citation === cm![0])) {
      checks.push(verifyCitation(cm[0], orgId));
    }
  }

  return checks;
}
