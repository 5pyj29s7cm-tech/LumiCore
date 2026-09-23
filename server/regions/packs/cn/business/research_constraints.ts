import type { ToolExecutionRecord } from '../../../../tools/types';

export const DEFAULT_INDUSTRY_RESEARCH_SOURCE_LIMIT = 8;

export function industryResearchSourceLimit(
  sourceInput: unknown,
  fallback = DEFAULT_INDUSTRY_RESEARCH_SOURCE_LIMIT,
): number {
  const source = String(sourceInput || '');
  const explicit = source.match(
    /(?:\u6700\u591a|\u81f3\u591a|\u4e0d\u8d85\u8fc7)\s*(?:\u4f7f\u7528|\u8bfb\u53d6|\u67e5\u627e|\u8bbf\u95ee)?\s*(\d{1,2})\s*(?:\u4e2a|\u6761|\u9875)?[^\u3002\uFF1B;\r\n]{0,80}?(?:\u6765\u6e90|\u7f51\u9875|\u7f51\u7ad9|sources?|pages?|sites?)/iu,
  ) || source.match(
    /(?:use|read|visit)\s+(?:at\s+most|no\s+more\s+than)\s+(\d{1,2})\s+(?:sources?|pages?|sites?)/iu,
  );
  const boundedFallback = Math.max(1, Math.min(DEFAULT_INDUSTRY_RESEARCH_SOURCE_LIMIT, Number(fallback) || DEFAULT_INDUSTRY_RESEARCH_SOURCE_LIMIT));
  if (!explicit) return boundedFallback;
  return Math.max(1, Math.min(DEFAULT_INDUSTRY_RESEARCH_SOURCE_LIMIT, Number(explicit[1]) || boundedFallback));
}

export function extractResearchUrls(value: unknown): string[] {
  const urls = String(value || '').match(/https?:\/\/[^\s<>"'`]+/giu) || [];
  return Array.from(new Set(urls.map(url => url.replace(/[\]\[)>,.;\u3002\uFF0C\uFF1B\uFF01\uFF1F]+$/u, ''))));
}

function hasPublicationDateBeforeUrl(summary: string, url: string): boolean {
  const index = summary.indexOf(url);
  if (index < 0) return false;
  const around = summary.slice(Math.max(0, index - 180), index + url.length + 180);
  if (/(?:\u65e0|\u672a\u63d0\u4f9b|\u7f3a\u5c11|\u7f3a\u5931)\s*(?:\u660e\u786e)?\s*(?:\u53d1\u5e03)?\u65e5\u671f|(?:no|without|missing)\s+(?:a\s+)?(?:publication\s+)?date|undated/iu.test(around)) {
    return false;
  }
  const context = summary.slice(Math.max(0, index - 180), index);
  return /(?:19|20)\d{2}\s*(?:[-/.\u5e74]\s*\d{1,2})?(?:\s*[-/.\u6708]\s*\d{1,2}\s*\u65e5?)?/u.test(context);
}

export function assertBoundedTrendResearchEvidence(input: {
  sourceInput: unknown;
  resultSummary: unknown;
  evidenceRecords: ToolExecutionRecord[];
}): void {
  const source = String(input.sourceInput || '');
  const summary = String(input.resultSummary || '');
  const limit = industryResearchSourceLimit(source);
  const researchRecords = input.evidenceRecords.filter(record => (
    ['web_search', 'url_fetch'].includes(record.name)
    && !record.error
    && String(record.result || '').trim()
  ));

  if (!researchRecords.length) {
    throw new Error('Trend research has no verified public-source receipt.');
  }
  if (researchRecords.length > limit) {
    throw new Error(`Trend research exceeded the user source limit (${researchRecords.length}/${limit}).`);
  }

  const receiptUrls = new Set(researchRecords.flatMap(record => extractResearchUrls(record.result)));
  const citedUrls = extractResearchUrls(summary);
  if (!citedUrls.length) {
    throw new Error('Trend research summary must show the exact source URLs.');
  }
  if (citedUrls.length > limit) {
    throw new Error(`Trend research summary exceeded the user source limit (${citedUrls.length}/${limit}).`);
  }
  for (const url of citedUrls) {
    if (!receiptUrls.has(url)) {
      throw new Error(`Trend research cited a URL that is absent from the verified receipts: ${url}`);
    }
  }

  const requiresDatedUrls = /(?:\u53d1\u5e03\u65e5\u671f|\u65e5\u671f).{0,24}(?:URL|\u94fe\u63a5)|(?:URL|\u94fe\u63a5).{0,24}(?:\u53d1\u5e03\u65e5\u671f|\u65e5\u671f)|dated\s+sources?/iu.test(source);
  if (requiresDatedUrls) {
    const undated = citedUrls.filter(url => !hasPublicationDateBeforeUrl(summary, url));
    if (undated.length) {
      throw new Error(`Trend research summary is missing a publication date beside ${undated.length} cited URL(s).`);
    }
  }

  const requiredSections: Array<[RegExp, RegExp, string]> = [
    [/(?:\u4e8b\u5b9e).{0,40}(?:\u63a8\u65ad)|facts?.{0,40}inference/iu, /\u4e8b\u5b9e[\s\S]{0,5000}\u63a8\u65ad|facts?[\s\S]{0,5000}inference/iu, 'facts versus inference'],
    [/(?:\u7f6e\u4fe1\u5ea6|confidence)/iu, /(?:\u7f6e\u4fe1\u5ea6|confidence)/iu, 'confidence'],
    [/(?:\u53cd\u8bc1|counter[-\s]?evidence)/iu, /(?:\u53cd\u8bc1|counter[-\s]?evidence)/iu, 'counter-evidence'],
    [/(?:\u9a8c\u8bc1\u65b9\u6848|validation\s+plan)/iu, /(?:\u9a8c\u8bc1\u65b9\u6848|validation\s+plan)/iu, 'validation plan'],
  ];
  for (const [requested, present, label] of requiredSections) {
    if (requested.test(source) && !present.test(summary)) {
      throw new Error(`Trend research summary is missing ${label}.`);
    }
  }
}
