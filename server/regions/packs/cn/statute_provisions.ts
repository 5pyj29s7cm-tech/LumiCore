import crypto from 'node:crypto';

const NUM = '[零〇一二两三四五六七八九十百千万\\d]+';
export const statuteTextCopy = {
  domainRule: '- 仅访问国家法律法规数据库及其已核对的官方文件存储 HTTPS 域名；买卖合同解释的固定2020版本另核验已登记的最高法院官方正文、独立章节及正文SHA，不跟随任意下载跳转。',
  saleContractHtml: {
    url: 'https://www.court.gov.cn/zixun/xiangqing/282621.html',
    recordId: 'ff808181799def980179b09685cf1802',
    versionDate: '2020-12-29', effectiveDate: '2021-01-01', articleMax: 33,
    sectionHeading: '关于审理买卖合同纠纷案件适用法律问题的解释',
    sectionBoundary: '最高人民法院',
    publicationMarker: '2020年12月29日',
    revisionMarker: '根据2020年12月23日最高人民法院',
    bodySha256: '1e33bbddf19cff8e6b0aa0e30e102e3e3b54ba9bd07d6b75e876d8cfd239fa31',
  },
  changed: '官方原文内容发生变化，需要重新复核',
  unavailable: '权威原文未取得或结构校验未通过；仅核验了版本元数据，具体条文不得放行。',
  historical: ' 案件事实日期早于本版本施行日期，需核对历史版本和时间效力规则，不能直接适用现行条文。',
  applicability: ' 案件时间、地域及适用关系仍待复核。',
  temporal: {
    civilKey: '民法典', civilTitle: '中华人民共和国民法典', repealCitation: '《民法典》第1260条', repealKeyword: '废止',
    authorityKey: '民法典时间效力规定',
    authorityTitle: '最高人民法院关于适用《中华人民共和国民法典》时间效力的若干规定',
    authorityAliases: ['民法典时间效力司法解释'],
    historicalMissing: '本法当前已废止；需核验本法历史原文、施行/废止有效区间及本案时间效力依据，不能以现行民法典快照或事实年份代替。',
    outsideInterval: (until?: string) => `本案事实日期不在本法已登记的废止前区间（${until || '截止日期未核验'}）。仍需核对时间效力规则，不得直接适用旧法。`,
    historicalSource: (version: string, from: string, until: string, url: string) => `国家法律法规数据库历史版本（${version}；施行 ${from}；截止 ${until}；${url}）`,
    intervalVerified: (url: string) => `施行及废止截止来源已核验；废止截止依据：《民法典》第1260条（${url}）。`,
    intervalMissing: '施行/废止区间来源未核验。',
    historicalReviewed: (analysis: string) => `时间效力条文连续摘录已核验；提供的适用说明：${analysis}。具体案件适用及例外仍须律师复核。`,
    historicalReviewMissing: '缺少与本引用及事实日期绑定的权威时间效力条文连续摘录和适用说明，不能放行。',
    procedure: ' 程序规则须按相应程序行为时点及时间效力依据复核；不使用实体事实日期代替程序日期。',
    reviewed: (analysis: string) => ` 权威时间效力条文连续摘录已核验；提供的适用说明：${analysis}。具体案件适用结论仍须律师复核。`,
    reviewMissing: ' 缺少对应时点及权威时间效力依据，适用状态保持待复核。',
  },
};
export function quotedStatuteText(text: string): string | undefined {
  return text.match(/^\s*(?:(?:规定|明确|指出|要求)(?:为|了|如下)?)?\s*[：:,，]?\s*[“"‘'「『]([^”"’'」』]+)[”"’'」』]/)?.[1];
}
const ARTICLE = `第${NUM}条(?:之${NUM})?(?:\\s*第${NUM}款)?(?:\\s*第[（(]?${NUM}[）)]?项)?`;
export function extractStatuteReferences(text: string): Array<{ citation: string; quotedText?: string }> {
  const result: Array<{ citation: string; quotedText?: string }> = [];
  const pattern = new RegExp(`《([^》]+)》\\s*(?:${ARTICLE})?`, 'g');
  for (const match of text.matchAll(pattern)) {
    if (/(?:合同|协议|规格书|说明书|招标文件|投标文件|采购文件|报价单|证据目录|起诉状|答辩状|授权委托书)(?:[（(][^）)]*[）)])?$/.test(match[1])) continue;
    let citation = match[0].trim();
    let offset = match.index! + match[0].length;
    for (;;) {
      const next = text.slice(offset).match(new RegExp(`^\\s*[、，,及和至到]\\s*(${ARTICLE})`));
      if (!next) break;
      result.push({ citation });
      citation = `《${match[1]}》${next[1]}`;
      offset += next[0].length;
    }
    result.push({ citation, quotedText: quotedStatuteText(text.slice(offset)) });
  }
  return result;
}
export function statuteNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = '零一二三四五六七八九';
  let sum = 0, pending = 0;
  for (const char of value.replace(/〇/g, '零').replace(/两/g, '二')) {
    const digit = digits.indexOf(char);
    if (digit >= 0) pending = digit;
    else {
      const unit = ({ 十: 10, 百: 100, 千: 1000, 万: 10000 } as Record<string, number>)[char];
      if (!unit) return NaN;
      sum += (pending || 1) * unit;
      pending = 0;
    }
  }
  return sum + pending;
}

export interface StatuteProvision { text: string; paragraphs: string[] }
export interface StatuteTextSnapshot {
  recordId: string;
  versionDate: string;
  fetchedAt: string;
  sha256: string;
  sourceUrl: string;
  provisions: Record<string, StatuteProvision>;
}

export interface ReviewedStatuteHtmlSource {
  url: string;
  recordId: string;
  versionDate: string;
  effectiveDate: string;
  articleMax: number;
  sectionHeading: string;
  sectionBoundary: string;
  publicationMarker: string;
  revisionMarker: string;
  bodySha256: string;
}

/** A reviewed, independently delimited official annex, never a guessed page. */
export function extractReviewedStatuteHtml(html: string, source: ReviewedStatuteHtmlSource): string {
  const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const compact = (value: string) => value.replace(/\s/g, '');
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!compact(text).includes(compact(source.publicationMarker))) throw new Error('Official HTML publication date mismatch');
  const headings = [...text.matchAll(new RegExp(`^[ \\t　]*${escaped(source.sectionHeading)}[ \\t　]*$`, 'gm'))];
  if (headings.length !== 1) throw new Error('Official HTML independent section is missing or ambiguous');
  const heading = headings[0], start = text.lastIndexOf(source.sectionBoundary, heading.index!);
  if (start < 0 || compact(text.slice(start, heading.index)) !== compact(source.sectionBoundary)) {
    throw new Error('Official HTML section title mismatch');
  }
  const afterHeading = heading.index! + heading[0].length;
  const next = text.slice(afterHeading).match(new RegExp(`\\n[ \\t　]*${escaped(source.sectionBoundary)}[ \\t　]*\\n`));
  if (!next || next.index === undefined) throw new Error('Official HTML section end is missing');
  const body = text.slice(start, afterHeading + next.index).trim();
  if (!compact(body).includes(compact(source.revisionMarker))) throw new Error('Official HTML revision mismatch');
  // HTML paragraph boundaries are retained. Some official headings lack a
  // space after the article number; insert only that formatting delimiter.
  const formatted = body.replace(new RegExp(`^([ \\t　]*第${NUM}条)(?=[^ \\t　\\r\\n])`, 'gm'), '$1 ');
  if (crypto.createHash('sha256').update(formatted).digest('hex') !== source.bodySha256) {
    throw new Error('Reviewed official HTML body SHA mismatch');
  }
  return formatted;
}

/** DOCX paragraph boundaries, not sentence count, define statutory paragraphs. */
export function parseOfficialStatuteText(text: string, articleMax: number): Record<string, StatuteProvision> {
  const re = new RegExp(`^[ \\t　]*第(${NUM})条(?:之(${NUM}))?[ \\t　]+`, 'gm');
  const matches = [...text.matchAll(re)];
  const provisions: Record<string, StatuteProvision> = {};
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const key = `${statuteNumber(m[1])}${m[2] ? `-${statuteNumber(m[2])}` : ''}`;
    if (provisions[key]) throw new Error('Duplicate statutory article; full-text structure requires review');
    const body = text.slice(m.index! + m[0].length, matches[i + 1]?.index ?? text.length)
      .split(new RegExp(`\\n\\s*第${NUM}[编章节]`))[0].trim();
    const paragraphs: string[] = [];
    for (const line of body.split(/\n\s*\n/).map(v => v.trim()).filter(Boolean)) {
      // Numbered items belong to the preceding paragraph, not a new statutory paragraph.
      if (/^[（(][零〇一二两三四五六七八九十百\d]+[）)]/.test(line) && paragraphs.length) paragraphs[paragraphs.length - 1] += `\n${line}`;
      else paragraphs.push(line);
    }
    if (!paragraphs.length) throw new Error('Empty statutory article');
    provisions[key] = { text: paragraphs.join('\n\n'), paragraphs };
  }
  for (let n = 1; n <= articleMax; n++) if (!provisions[String(n)]) throw new Error(`Incomplete authority text: article ${n} unavailable`);
  if (!articleMax || matches.length < articleMax || Math.max(...matches.map(m => statuteNumber(m[1]))) !== articleMax) throw new Error('Incomplete or inconsistent authority text');
  return provisions;
}

export function createStatuteTextSnapshot(text: string, articleMax: number, metadata: Omit<StatuteTextSnapshot, 'provisions' | 'sha256'>): StatuteTextSnapshot {
  return { ...metadata, sha256: crypto.createHash('sha256').update(text).digest('hex'), provisions: parseOfficialStatuteText(text, articleMax) };
}

export function checkStatuteProvision(citation: string, snapshot?: StatuteTextSnapshot, quotedText?: string) {
  const m = citation.match(new RegExp(`第(${NUM})条(?:之(${NUM}))?(?:\\s*第(${NUM})款)?(?:\\s*第[（(]?(${NUM})[）)]?项)?`));
  if (!snapshot || !m) return { provisionVerified: false, quotationVerified: false, detail: '仅查到法律名称、版本和条号范围；尚未核验所引具体条文原文。', verificationStatus: 'metadata_only' as const };
  const key = `${statuteNumber(m[1])}${m[2] ? `-${statuteNumber(m[2])}` : ''}`;
  const provision = snapshot.provisions[key];
  let selected = m[3] ? provision?.paragraphs[statuteNumber(m[3]) - 1] : provision?.text;
  if (m[4] && selected) {
    const items = [...selected.matchAll(new RegExp(`(?:^|\\n)[（(](${NUM})[）)]`, 'g'))];
    const index = items.findIndex(item => statuteNumber(item[1]) === statuteNumber(m[4]));
    selected = index < 0 ? undefined : selected.slice(items[index].index! + items[index][0].length, items[index + 1]?.index).trim();
  }
  if (!selected) return { provisionVerified: false, quotationVerified: false, detail: '权威原文中没有找到所引条、款或项；不能作为已核实引用。', verificationStatus: 'not_found' as const };
  const normalize = (s: string) => s.replace(/\s/g, '');
  const quotationVerified = quotedText === undefined ? null : Boolean(normalize(quotedText)) && normalize(selected).includes(normalize(quotedText));
  return {
    provisionVerified: true, quotationVerified, sourceText: selected,
    verificationStatus: quotationVerified === false ? 'text_mismatch' as const : 'verified' as const,
    detail: quotationVerified === false ? '引号内文字与对应权威条文原文不符。' : '所引条、款、项已定位到权威原文；未核实转述、法律解释和本案适用结论。',
  };
}
