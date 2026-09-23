import { describe, expect, it } from 'vitest';
import { analyzeReviewInsights, normalizeReviewSourceImport } from '../server/skills/bundled/ecommerce-ops/logic';
import { normalizeReviewSourceRecords } from '../server/skills/bundled/ecommerce-ops/review_source';

describe('ecommerce review source normalization', () => {
  it('normalizes CSV, masks PII, strips URL secrets, and deduplicates stable review IDs', () => {
    const sourceText = [
      '评论编号,平台,店铺ID,商品ID,SKU,评分,评价内容,评价时间,已购,回复状态,评价链接,点赞数',
      'R-1,shopline,STORE-1,P-1,SKU-A,1,"包装破损，联系13800138000，邮箱buyer@example.com，地址:北京市朝阳区幸福路1号",2026-08-01,是,未回复,https://shop.example/reviews/R-1?access_token=secret#private,8',
      'R-1,shopline,STORE-1,P-1,SKU-A,1,"重复记录",2026-08-01,是,未回复,https://shop.example/reviews/R-1,8',
    ].join('\n');

    const result = normalizeReviewSourceRecords({ sourceText });

    expect(result.source).toMatchObject({
      detectedFormat: 'csv',
      importedCount: 2,
      normalizedCount: 1,
      deduplicatedCount: 1,
      piiMaskedCount: 1,
      generatedIdCount: 0,
    });
    expect(result.records[0]).toMatchObject({
      reviewId: 'R-1',
      platform: 'shopline',
      storeId: 'STORE-1',
      productId: 'P-1',
      sku: 'SKU-A',
      rating: 1,
      verifiedPurchase: true,
      replyStatus: 'unreplied',
      helpfulCount: 8,
      sourceUrl: 'https://shop.example/reviews/R-1',
    });
    expect(result.records[0].content).toContain('[phone]');
    expect(result.records[0].content).toContain('[email]');
    expect(result.records[0].content).toContain('[address]');
    expect(result.records[0].content).not.toContain('13800138000');
    expect(result.records[0].sourceUrl).not.toContain('secret');
  });

  it('accepts nested JSON envelopes and explicit dotted-path mappings', () => {
    const sourceText = JSON.stringify({
      data: {
        reviews: [
          {
            id: 'review-9',
            product: { id: 'product-9', sku: 'SKU-9' },
            body: '质量很好，物流很快',
            rating: 5,
            created_at: '2026-08-02T10:00:00Z',
            verified: true,
            replied: true,
          },
        ],
      },
    });

    const result = normalizeReviewSourceRecords({
      sourceText,
      platform: 'shopify',
      storeId: 'STORE-9',
      mapping: { sku: 'product.sku' },
    });

    expect(result.source.detectedFormat).toBe('json');
    expect(result.records[0]).toMatchObject({
      reviewId: 'review-9',
      platform: 'shopify',
      storeId: 'STORE-9',
      productId: 'product-9',
      sku: 'SKU-9',
      rating: 5,
      verifiedPurchase: true,
      replyStatus: 'replied',
      createdAt: '2026-08-02T10:00:00.000Z',
    });
  });

  it('accepts JSONL and generates deterministic IDs when the source has no review ID', () => {
    const sourceText = [
      JSON.stringify({ sku: 'SKU-A', comment: '一般', rating: 3 }),
      JSON.stringify({ sku: 'SKU-B', comment: '尺寸偏小，不推荐', rating: 2 }),
    ].join('\n');

    const first = normalizeReviewSourceRecords({ sourceText, sourceFormat: 'jsonl', platform: 'taobao', storeId: 'S-1' });
    const second = normalizeReviewSourceRecords({ sourceText, sourceFormat: 'jsonl', platform: 'taobao', storeId: 'S-1' });

    expect(first.records).toHaveLength(2);
    expect(first.source.generatedIdCount).toBe(2);
    expect(first.records[0].reviewId).toMatch(/^generated:[a-f0-9]{16}$/);
    expect(first.records.map(record => record.reviewId)).toEqual(second.records.map(record => record.reviewId));
  });

  it('returns bounded pages while analyzing the complete deduplicated source', () => {
    const sourceText = [
      'review_id,sku,rating,content,reply_status',
      '1,A,1,"质量差，包装破损",unreplied',
      '2,B,5,"很好，满意",replied',
      '3,C,3,"一般",unknown',
    ].join('\n');

    const result = normalizeReviewSourceImport({ sourceText, cursor: 1, limit: 1, platform: 'woocommerce', storeId: 'shop-1' });

    expect(result.readOnly).toBe(true);
    expect(result.externalWrites).toBe(false);
    expect(result.page).toMatchObject({ cursor: 1, limit: 1, returnedCount: 1, nextCursor: 2 });
    expect(result.page.records[0].reviewId).toBe('2');
    expect(result.insights).toMatchObject({ totalReviews: 3, positiveCount: 1, neutralCount: 1, negativeCount: 1 });
    expect(result.operationalSummary).toMatchObject({ repliedCount: 1, unrepliedCount: 1, unknownReplyCount: 1, replyCoverage: 50 });
    expect(result.connectorPolicy.blockedByDefault).toContain('reply-to-review');
  });

  it('feeds normalized JSON through the existing insight analyzer', () => {
    const result = analyzeReviewInsights({
      sourceFormat: 'json',
      platform: 'shopline',
      storeId: 'store-1',
      reviewText: JSON.stringify({ reviews: [
        { id: '1', sku: 'A', rating: 1, content: '物流太慢，包装破损' },
        { id: '1', sku: 'A', rating: 1, content: '重复数据' },
        { id: '2', sku: 'B', rating: 5, content: '很好，值得推荐' },
      ] }),
    });

    expect(result.normalization).toMatchObject({ normalizedCount: 2, deduplicatedCount: 1 });
    expect(result.insights).toMatchObject({ totalReviews: 2, positiveCount: 1, negativeCount: 1 });
    expect(result.insights.topics.map(topic => topic.topic)).toEqual(expect.arrayContaining(['logistics', 'packaging']));
  });
});
