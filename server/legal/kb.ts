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
  verificationStatus?: 'verified' | 'expired' | 'missing' | 'repealed';
  sourceUrl?: string;
  reviewAfter?: string;
  content?: string;
}

interface StatuteVerificationSnapshot {
  source: string;
  sourceUrl: string;
  verifiedAt: string;
  reviewAfter: string;
  versionDate: string;
  effectiveDate: string;
  articleMin?: number;
  articleMax?: number;
}

interface StatuteRegistryEntry {
  title: string;
  aliases?: string[];
  effective: boolean;
  repealedDate?: string;
  verification?: StatuteVerificationSnapshot;
}

const STATUTE_SNAPSHOT_VERIFIED_AT = '2026-07-12';
const STATUTE_SNAPSHOT_REVIEW_AFTER = '2026-10-10';

function officialStatuteSnapshot(
  sourceUrl: string,
  versionDate: string,
  effectiveDate: string,
  articleMax: number,
  source = '国家法律法规数据库',
): StatuteVerificationSnapshot {
  return {
    source,
    sourceUrl,
    verifiedAt: STATUTE_SNAPSHOT_VERIFIED_AT,
    reviewAfter: STATUTE_SNAPSHOT_REVIEW_AFTER,
    versionDate,
    effectiveDate,
    articleMin: 1,
    articleMax,
  };
}

const CIVIL_CODE_VERIFICATION = officialStatuteSnapshot(
  'https://flk.npc.gov.cn/detail?fileId=&id=ff808081729d1efe01729d50b5c500bf&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E6%B0%91%E6%B3%95%E5%85%B8&type=',
  '2020-05-28',
  '2021-01-01',
  1260,
);

const COMPANY_LAW_VERIFICATION = officialStatuteSnapshot(
  'https://flk.npc.gov.cn/detail?fileId=&id=ff8081818c9108eb018cb6922f750c07&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E5%85%AC%E5%8F%B8%E6%B3%95&type=',
  '2023-12-29',
  '2024-07-01',
  266,
);

const CIVIL_PROCEDURE_LAW_VERIFICATION = officialStatuteSnapshot(
  'https://www.npc.gov.cn/npc/c2/c30834/202401/P020240108541839745616.pdf',
  '2023-09-01',
  '2024-01-01',
  306,
  '中国人大网（全国人大常委会公报现行全文）',
);

const CRIMINAL_PROCEDURE_LAW_VERIFICATION = officialStatuteSnapshot(
  'https://flk.npc.gov.cn/detail?fileId=&id=ff8080816f135f46016f1d1b81b01351&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E5%88%91%E4%BA%8B%E8%AF%89%E8%AE%BC%E6%B3%95&type=',
  '2018-10-26',
  '2018-10-26',
  308,
);

const ADMINISTRATIVE_PROCEDURE_LAW_VERIFICATION = officialStatuteSnapshot(
  'https://flk.npc.gov.cn/detail?id=2c909fdd678bf17901678bf858550a0f',
  '2017-06-27',
  '2017-07-01',
  103,
);

const LABOR_CONTRACT_LAW_VERIFICATION = officialStatuteSnapshot(
  'https://flk.npc.gov.cn/detail?fileId=&id=2c909fdd678bf17901678bf74d7106b3&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E5%8A%B3%E5%8A%A8%E5%90%88%E5%90%8C%E6%B3%95&type=',
  '2012-12-28',
  '2013-07-01',
  98,
);

const LABOR_LAW_VERIFICATION = officialStatuteSnapshot(
  'https://flk.npc.gov.cn/detail?id=ff8080816f135f46016f20f16ee11737&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E5%8A%B3%E5%8A%A8%E6%B3%95',
  '2018-12-29',
  '2018-12-29',
  107,
);

const TRADEMARK_LAW_VERIFICATION = officialStatuteSnapshot(
  'https://flk.npc.gov.cn/detail?fileId=&id=ff8080816f135f46016f217645451b35&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E5%95%86%E6%A0%87%E6%B3%95&type=',
  '2019-04-23',
  '2019-11-01',
  73,
);

const PATENT_LAW_VERIFICATION = officialStatuteSnapshot(
  'https://flk.npc.gov.cn/detail?fileId=&id=ff808081752b7d430175e4651cbd1547&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E4%B8%93%E5%88%A9%E6%B3%95&type=',
  '2020-10-17',
  '2021-06-01',
  82,
);

const ANTI_UNFAIR_COMPETITION_LAW_VERIFICATION = officialStatuteSnapshot(
  'https://www.npc.gov.cn/npc/c2/c30834/202506/t20250627_446247.html',
  '2025-06-27',
  '2025-10-15',
  41,
  '中国人大网（现行全文）',
);

const CONSUMER_PROTECTION_LAW_VERIFICATION = officialStatuteSnapshot(
  'https://www.npc.gov.cn/zgrdw/npc/lfzt/xfzqybhfxza/2014-01/02/content_1872488.htm',
  '2013-10-25',
  '2014-03-15',
  63,
  '中国人大网（现行全文）',
);

const ENTERPRISE_BANKRUPTCY_LAW_VERIFICATION = officialStatuteSnapshot(
  'https://www.npc.gov.cn/npc/c2/c183/c198/201905/t20190522_25968.html',
  '2006-08-27',
  '2007-06-01',
  136,
  '中国人大网（现行全文）',
);

/** Law-name registry. Formal article verification requires a sourced snapshot. */
const STATUTE_REGISTRY: Record<string, StatuteRegistryEntry> = {
  '民法典': { title: '中华人民共和国民法典', effective: true, verification: CIVIL_CODE_VERIFICATION },
  '刑法': { title: '中华人民共和国刑法', effective: true },
  '刑事诉讼法': { title: '中华人民共和国刑事诉讼法', effective: true, verification: CRIMINAL_PROCEDURE_LAW_VERIFICATION },
  '民事诉讼法': { title: '中华人民共和国民事诉讼法', effective: true, verification: CIVIL_PROCEDURE_LAW_VERIFICATION },
  '行政诉讼法': { title: '中华人民共和国行政诉讼法', effective: true, verification: ADMINISTRATIVE_PROCEDURE_LAW_VERIFICATION },
  '公司法': { title: '中华人民共和国公司法（2023修订）', effective: true, verification: COMPANY_LAW_VERIFICATION },
  '合同法': { title: '中华人民共和国合同法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '物权法': { title: '中华人民共和国物权法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '侵权责任法': { title: '中华人民共和国侵权责任法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '婚姻法': { title: '中华人民共和国婚姻法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '继承法': { title: '中华人民共和国继承法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '民法通则': { title: '中华人民共和国民法通则', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '担保法': { title: '中华人民共和国担保法', effective: false, repealedDate: '2021-01-01', verification: CIVIL_CODE_VERIFICATION },
  '劳动合同法': { title: '中华人民共和国劳动合同法', effective: true, verification: LABOR_CONTRACT_LAW_VERIFICATION },
  '劳动法': { title: '中华人民共和国劳动法', effective: true, verification: LABOR_LAW_VERIFICATION },
  '知识产权法': { title: '中华人民共和国著作权法', effective: true },
  '商标法': { title: '中华人民共和国商标法', effective: true, verification: TRADEMARK_LAW_VERIFICATION },
  '专利法': { title: '中华人民共和国专利法', effective: true, verification: PATENT_LAW_VERIFICATION },
  '反不正当竞争法': { title: '中华人民共和国反不正当竞争法（2025修订）', effective: true, verification: ANTI_UNFAIR_COMPETITION_LAW_VERIFICATION },
  '消费者权益保护法': { title: '中华人民共和国消费者权益保护法', effective: true, verification: CONSUMER_PROTECTION_LAW_VERIFICATION },
  '企业破产法': { title: '中华人民共和国企业破产法', effective: true, verification: ENTERPRISE_BANKRUPTCY_LAW_VERIFICATION },
  '证券法': { title: '中华人民共和国证券法', effective: true },
  '招标投标法': { title: '中华人民共和国招标投标法', effective: true },
  '政府采购法': { title: '中华人民共和国政府采购法', effective: true },
  '民法典婚姻家庭编': { title: '中华人民共和国民法典 第五编 婚姻家庭', aliases: ['民法典婚姻家庭编'], effective: true, verification: { ...CIVIL_CODE_VERIFICATION, articleMin: 1040, articleMax: 1118 } },
  '民法典继承编': { title: '中华人民共和国民法典 第六编 继承', aliases: ['民法典继承编'], effective: true, verification: { ...CIVIL_CODE_VERIFICATION, articleMin: 1119, articleMax: 1163 } },
  '民法典合同编': { title: '中华人民共和国民法典 第三编 合同', aliases: ['民法典合同编'], effective: true, verification: { ...CIVIL_CODE_VERIFICATION, articleMin: 463, articleMax: 988 } },
  '民法典物权编': { title: '中华人民共和国民法典 第二编 物权', aliases: ['民法典物权编'], effective: true, verification: { ...CIVIL_CODE_VERIFICATION, articleMin: 205, articleMax: 462 } },
  '民法典侵权责任编': { title: '中华人民共和国民法典 第七编 侵权责任', aliases: ['民法典侵权责任编'], effective: true, verification: { ...CIVIL_CODE_VERIFICATION, articleMin: 1164, articleMax: 1258 } },
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
  return `${snapshot.source}（版本 ${snapshot.versionDate}，施行 ${snapshot.effectiveDate}，核验快照 ${snapshot.verifiedAt}，复核期限 ${snapshot.reviewAfter}，${snapshot.sourceUrl}）`;
}

function verificationAsOfDate(value?: string | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function isVerificationSnapshotCurrent(snapshot: StatuteVerificationSnapshot, asOf?: string | Date): boolean {
  return verificationAsOfDate(asOf) <= snapshot.reviewAfter;
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
      const verificationStatus: NonNullable<StatuteResult['verificationStatus']> = !info.effective
        ? 'repealed'
        : !info.verification
          ? 'missing'
          : isVerificationSnapshotCurrent(info.verification)
            ? 'verified'
            : 'expired';
      const verificationSummary = !info.effective
        ? info.verification ? `；废止状态来源：${info.verification.source}` : '；废止状态待权威来源复核'
        : info.verification
          ? verificationStatus === 'verified'
            ? `；权威快照核验于 ${info.verification.verifiedAt}，复核期限 ${info.verification.reviewAfter}`
            : `；权威快照已于 ${info.verification.reviewAfter} 到期，正式交付前必须刷新`
          : '；正式交付前需权威来源核验';
      results.push({
        articleId: `statute:${key}`,
        title: info.title,
        chunk: `${info.title}${info.effective ? ' — 法名状态候选' : ` — 已废止${info.repealedDate ? `（${info.repealedDate}起）` : ''}`}${verificationSummary}`,
        score: 1.0,
        isEffective: info.effective,
        verificationStatus,
        sourceUrl: info.verification?.sourceUrl,
        reviewAfter: info.verification?.reviewAfter,
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
  verificationStatus?: 'verified' | 'expired' | 'missing' | 'repealed' | 'not_found';
  sourceUrl?: string;
  verifiedAt?: string;
  reviewAfter?: string;
}

export interface CitationVerificationOptions {
  asOf?: string | Date;
}

function snapshotMetadata(snapshot?: StatuteVerificationSnapshot): Pick<CitationCheck, 'sourceUrl' | 'verifiedAt' | 'reviewAfter'> {
  return snapshot
    ? {
        sourceUrl: snapshot.sourceUrl,
        verifiedAt: snapshot.verifiedAt,
        reviewAfter: snapshot.reviewAfter,
      }
    : {};
}

export function verifyCitation(
  citation: string,
  orgId?: string,
  options: CitationVerificationOptions = {},
): CitationCheck {
  // Check if it's a statute citation
  const statuteMatch = citation.match(/《([^》]+)》/);
  if (statuteMatch) {
    const statuteName = statuteMatch[1].trim();
    const found = Object.values(STATUTE_REGISTRY).find(
      s => s.title.includes(statuteName)
        || statuteName.includes(s.title)
        || s.aliases?.some(alias => alias.includes(statuteName) || statuteName.includes(alias)),
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
          verificationStatus: 'repealed',
          ...snapshotMetadata(verification),
        };
      }

      if (verification && !isVerificationSnapshotCurrent(verification, options.asOf)) {
        return {
          citation,
          type: 'statute',
          exists: true,
          isEffective: null,
          source: verificationSource(verification),
          detail: `${found.title} 的权威核验快照已于 ${verification.reviewAfter} 到期，必须重新访问权威来源确认当前版本和生效状态后才能正式交付。`,
          verificationStatus: 'expired',
          ...snapshotMetadata(verification),
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
            verificationStatus: verification ? 'not_found' : 'missing',
            ...snapshotMetadata(verification),
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
          verificationStatus: 'missing',
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
        verificationStatus: verification ? 'verified' : 'missing',
        ...snapshotMetadata(verification),
      };
    }
    return {
      citation,
      type: 'statute',
      exists: false,
      isEffective: null,
      source: '',
      detail: `未在已知法条库中找到《${statuteName}》，请核实法条名称是否准确。`,
      verificationStatus: 'not_found',
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

export function verifyMultipleCitations(
  text: string,
  orgId?: string,
  options: CitationVerificationOptions = {},
): CitationCheck[] {
  const checks: CitationCheck[] = [];

  // Find all 《...》 statute citations
  const statuteRe = /《[^》]+》(?:第[零〇一二两三四五六七八九十百千万\d]+条(?:之[零〇一二两三四五六七八九十百千万\d]+)?(?:第[零〇一二两三四五六七八九十百千万\d]+款)?(?:第[零〇一二两三四五六七八九十百千万\d]+项)?)?/g;
  let m: RegExpExecArray | null;
  while ((m = statuteRe.exec(text)) !== null) {
    checks.push(verifyCitation(m[0], orgId, options));
  }

  // Find all case number patterns
  const caseRe = /[（(]\d{4}[）)][^号]*[号字]/g;
  let cm: RegExpExecArray | null;
  while ((cm = caseRe.exec(text)) !== null) {
    if (!checks.find(c => c.citation === cm![0])) {
      checks.push(verifyCitation(cm[0], orgId, options));
    }
  }

  return checks;
}
