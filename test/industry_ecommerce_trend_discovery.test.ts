import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { executeEcommerceTrendDiscovery } from '../server/industry/ecommerce_trend_discovery';
import { getIndustryWorkflowTask } from '../server/industry/workflow_service';

beforeAll(async () => {
  await initDatabase();
});

const originalPrompt = '爆款雷达实机验收：平台是抖音小店，类目是桌面收纳，目标人群是租房年轻人，验证预算上限5000元。请最多使用3个公开可访问且带发布日期和URL的来源，收集截至2026-08-18的需求与竞争信号；明确区分来源事实和你的推断，给出候选机会排名、置信度、反证、最小验证方案、持久任务编号和确认边界。不要登录平台，不要采购、不投放、不发布。';

describe('source-bound ecommerce trend discovery', () => {
  it('persists a bounded verified report from dated and publicly fetched URLs', async () => {
    const userId = `trend_discovery_${Date.now()}`;
    const results = [
      '桌面收纳与租房青年需求趋势报告\n发布日期：2026-06-18，桌面收纳、小空间和租房青年相关需求样本。\nhttps://example.com/reports/storage-2026',
      '抖音家居收纳竞争观察\n2026年05月09日发布，桌面收纳内容和竞争信号观察。\nhttps://example.org/commerce/storage',
      '小空间桌面用品消费洞察\n发布于2025-11-30，租房年轻人关注免安装和可搬运。\nhttps://example.net/insights/desk-storage',
    ];
    let searchIndex = 0;
    const receipt = await executeEcommerceTrendDiscovery({
      userId,
      domain: 'personal',
      requestId: `trend_discovery_request_${Date.now()}`,
      source: 'test',
      actionIntent: originalPrompt,
    } as any, {
      search: async args => {
        expect(args).toMatchObject({ maxResults: 1, requirePublicationDate: true });
        return results[searchIndex++];
      },
      fetchUrl: async args => `公开网页正文 ${String(args.url)} ${'桌面收纳与租房年轻人需求竞争事实。'.repeat(12)}`,
    });

    expect(receipt).toMatchObject({
      ok: true,
      status: 'verified',
      persisted: true,
      sourceCount: 3,
      sourceLimit: 3,
      externalMutation: false,
    });
    expect(receipt.message).toContain('来源事实');
    expect(receipt.message).toContain('推断、候选排名与置信度');
    expect(receipt.message).toContain('反证');
    expect(receipt.message).toContain('最小验证方案');
    expect(receipt.message).toContain('总额不超过 5000 元');
    for (const url of ['https://example.com/reports/storage-2026', 'https://example.org/commerce/storage', 'https://example.net/insights/desk-storage']) {
      expect(receipt.message).toContain(`\`${url}\``);
    }

    const task = getIndustryWorkflowTask({ userId, domain: 'personal', orgId: '' }, receipt.taskId);
    expect(task?.status).toBe('delivered');
    expect(task?.metadata?.workTakeoverVerification?.passed).toBe(true);
  });

  it('persists an honest blocker instead of fabricating sources or rankings', async () => {
    const userId = `trend_blocked_${Date.now()}`;
    const receipt = await executeEcommerceTrendDiscovery({
      userId,
      domain: 'personal',
      requestId: `trend_blocked_request_${Date.now()}`,
      source: 'test',
      actionIntent: originalPrompt,
    } as any, {
      search: async () => { throw new Error('No dated relevant source'); },
      fetchUrl: async () => { throw new Error('must not fetch'); },
    });

    expect(receipt).toMatchObject({
      ok: true,
      status: 'blocked',
      persisted: true,
      sourceCount: 0,
      sourceLimit: 3,
      externalMutation: false,
    });
    expect(receipt.message).toContain('不生成候选排名');
    expect(receipt.message).toContain('不伪造来源');
    expect(getIndustryWorkflowTask({ userId, domain: 'personal', orgId: '' }, receipt.taskId)?.status).toBe('blocked');
  });

  it('accepts a dated public news RSS item when its public item URL returns the Google News fallback', async () => {
    const userId = `trend_news_rss_${Date.now()}`;
    const source = [
      'Home Organization Products Market Report',
      '发布日期：2026-07-23',
      'Home organization demand signal.',
      'https://news.google.com/rss/articles/public-item?oc=5',
    ].join('\n');
    const receipt = await executeEcommerceTrendDiscovery({
      userId,
      domain: 'personal',
      requestId: `trend_news_rss_request_${Date.now()}`,
      source: 'test',
      actionIntent: originalPrompt,
    } as any, {
      search: async () => source,
      fetchUrl: async () => 'Google News',
    });

    expect(receipt).toMatchObject({ ok: true, status: 'verified', sourceCount: 1 });
    expect(receipt.message).toContain('https://news.google.com/rss/articles/public-item?oc=5');
  });

});
