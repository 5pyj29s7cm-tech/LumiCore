import { describe, expect, it } from 'vitest';
import {
  assertBoundedTrendResearchEvidence,
  industryResearchSourceLimit,
} from '../server/industry/research_constraints';

const sourceInput = '\u7206\u6b3e\u96f7\u8fbe\u5b9e\u673a\u9a8c\u6536\uff1a\u5e73\u53f0\u662f\u6296\u97f3\u5c0f\u5e97\uff0c\u7c7b\u76ee\u662f\u684c\u9762\u6536\u7eb3\uff0c\u76ee\u6807\u4eba\u7fa4\u662f\u79df\u623f\u5e74\u8f7b\u4eba\u3002\u8bf7\u6700\u591a\u4f7f\u75283\u4e2a\u516c\u5f00\u53ef\u8bbf\u95ee\u4e14\u5e26\u53d1\u5e03\u65e5\u671f\u548cURL\u7684\u6765\u6e90\uff1b\u660e\u786e\u533a\u5206\u6765\u6e90\u4e8b\u5b9e\u548c\u4f60\u7684\u63a8\u65ad\uff0c\u7ed9\u51fa\u7f6e\u4fe1\u5ea6\u3001\u53cd\u8bc1\u548c\u6700\u5c0f\u9a8c\u8bc1\u65b9\u6848\u3002';

function receipt(index: number) {
  return {
    id: `source-${index}`,
    name: 'web_search',
    arguments: {},
    result: `Source ${index} 2026-08-${10 + index} https://example.test/source-${index}`,
    terminalVerification: { status: 'verified', strategy: 'measured', reason: 'public search result' },
  } as any;
}

describe('bounded trend research evidence', () => {
  it('reads the normal Chinese source limit and accepts only grounded dated URLs', () => {
    expect(industryResearchSourceLimit(sourceInput)).toBe(3);
    expect(() => assertBoundedTrendResearchEvidence({
      sourceInput,
      resultSummary: [
        '\u6765\u6e90\u4e8b\u5b9e\uff1aSource 1\uff0c\u53d1\u5e03\u65e5\u671f 2026-08-11\uff0cURL=https://example.test/source-1',
        'Source 2\uff0c\u53d1\u5e03\u65e5\u671f 2026-08-12\uff0cURL=https://example.test/source-2',
        'Source 3\uff0c\u53d1\u5e03\u65e5\u671f 2026-08-13\uff0cURL=https://example.test/source-3',
        '\u63a8\u65ad\uff1a\u5019\u9009\u673a\u4f1a\u3002\u7f6e\u4fe1\u5ea6\uff1a\u4e2d\u3002\u53cd\u8bc1\uff1a\u6570\u636e\u53ef\u80fd\u8fc7\u65f6\u3002\u6700\u5c0f\u9a8c\u8bc1\u65b9\u6848\uff1a\u5148\u505a\u5c0f\u6837\u672c\u3002',
      ].join('\n'),
      evidenceRecords: [receipt(1), receipt(2), receipt(3)],
    })).not.toThrow();
  });

  it('rejects hidden extra reads and ungrounded source URLs', () => {
    expect(() => assertBoundedTrendResearchEvidence({
      sourceInput,
      resultSummary: '\u4e8b\u5b9e\u4e0e\u63a8\u65ad\uff1b\u7f6e\u4fe1\u5ea6\uff1b\u53cd\u8bc1\uff1b\u9a8c\u8bc1\u65b9\u6848\uff1b2026-08-11 https://example.test/source-1',
      evidenceRecords: [receipt(1), receipt(2), receipt(3), receipt(4)],
    })).toThrow(/exceeded the user source limit/);

    expect(() => assertBoundedTrendResearchEvidence({
      sourceInput,
      resultSummary: '\u4e8b\u5b9e\u4e0e\u63a8\u65ad\uff1b\u7f6e\u4fe1\u5ea6\uff1b\u53cd\u8bc1\uff1b\u9a8c\u8bc1\u65b9\u6848\uff1b2026-08-11 https://invented.test/source',
      evidenceRecords: [receipt(1)],
    })).toThrow(/absent from the verified receipts/);

    expect(() => assertBoundedTrendResearchEvidence({
      sourceInput,
      resultSummary: '\u622a\u6b62\u65e5\u671f2026-08-18\u3002\u4e8b\u5b9e\u4e0e\u63a8\u65ad\uff1b\u7f6e\u4fe1\u5ea6\uff1b\u53cd\u8bc1\uff1b\u9a8c\u8bc1\u65b9\u6848\uff1bhttps://example.test/source-1 \u65e0\u53d1\u5e03\u65e5\u671f\u3002',
      evidenceRecords: [receipt(1)],
    })).toThrow(/missing a publication date/);
  });
});
