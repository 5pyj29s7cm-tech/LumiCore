import { describe, expect, it } from 'vitest';
import {
  applyPaperTrade,
  buildPortfolioSnapshot,
  buildTradingPlan,
  createPortfolio,
  parseSinaQuoteText,
  parseTencentQuoteText,
  stockExchangeSymbol,
} from '../server/skills/bundled/stockbot/logic';

describe('stockbot trading helpers', () => {
  it('parses Tencent and Sina quote fallback payloads', () => {
    const tencent = parseTencentQuoteText(
      'v_sh600519="1~\u8d35\u5dde\u8305\u53f0~600519~1182.19~1199.30~1191.00~34096~15394~18706~1182.19~2~1182.18~1~1182.17~7~1182.16~14~1182.15~113~1182.20~33~1182.26~5~1182.35~1~1182.36~1~1182.42~1~~20260709161445~-17.11~-1.43~1191.99~1178.00~1182.19/34096/4035216946~34096~403522~0.27~17.87";',
      '600519',
    );
    const sina = parseSinaQuoteText(
      'var hq_str_sh600519="\u8d35\u5dde\u8305\u53f0,1191.000,1199.300,1182.190,1191.990,1178.000,1182.190,1182.200,3409634,4035216946.000,173,1182.190,100,1182.180,700,1182.170,1400,1182.160,11300,1182.150,3300,1182.200,500,1182.260,100,1182.350,100,1182.360,100,1182.420,2026-07-09,15:34:59,00,D|400|472876.00";',
      'sh600519',
    );

    expect(stockExchangeSymbol('600519')).toBe('sh600519');
    expect(stockExchangeSymbol('000001')).toBe('sz000001');
    expect(tencent).toMatchObject({
      code: '600519',
      name: '\u8d35\u5dde\u8305\u53f0',
      price: 1182.19,
      changePercent: -1.43,
      dataSource: 'tencent',
    });
    expect(sina).toMatchObject({
      code: '600519',
      name: '\u8d35\u5dde\u8305\u53f0',
      price: 1182.19,
      high: 1191.99,
      low: 1178,
      dataSource: 'sina',
    });
  });

  it('builds a risk-managed trading plan with A-share lot sizing', () => {
    const plan = buildTradingPlan(
      {
        code: '600519',
        accountSize: 100000,
        maxRiskPercent: 1,
        entryPrice: 20,
        stopLossPrice: 18,
        targetPrice: 25,
      },
      { code: '600519', name: 'Demo', price: 20 },
      [],
    );

    expect(plan.plan.riskBudget).toBe(1000);
    expect(plan.plan.perShareRisk).toBe(2);
    expect(plan.plan.suggestedShares).toBe(500);
    expect(plan.plan.capitalNeeded).toBe(10000);
    expect(plan.plan.riskRewardRatio).toBe(2.5);
    expect(plan.warnings).toEqual([]);
  });

  it('defaults target to about two times risk when no target is supplied', () => {
    const plan = buildTradingPlan(
      {
        code: '000001',
        accountSize: 50000,
        entryPrice: 10,
        stopLossPrice: 9,
      },
      { code: '000001', name: 'Demo Bank', price: 10 },
      [],
    );

    expect(plan.plan.targetPrice).toBe(12);
    expect(plan.plan.riskRewardRatio).toBe(2);
  });

  it('treats fractional human risk inputs like 0.5 as 0.5 percent', () => {
    const plan = buildTradingPlan(
      {
        code: '000001',
        accountSize: 100000,
        maxRiskPercent: 0.5,
        entryPrice: 10,
        stopLossPrice: 9,
      },
      { code: '000001', name: 'Demo Bank', price: 10 },
      [],
    );

    expect(plan.plan.maxRiskPercent).toBe(0.5);
    expect(plan.plan.riskBudget).toBe(500);
    expect(plan.plan.suggestedShares).toBe(500);
  });

  it('records paper buys and sells without placing real orders', () => {
    const empty = createPortfolio('demo', 10000, '2026-07-04T00:00:00.000Z');
    const afterBuy = applyPaperTrade(empty, {
      side: 'buy',
      code: '000001',
      name: 'Demo Bank',
      quantity: 200,
      price: 10,
      fee: 0,
      time: '2026-07-04T01:00:00.000Z',
    });
    const afterSell = applyPaperTrade(afterBuy, {
      side: 'sell',
      code: '000001',
      quantity: 100,
      price: 12,
      fee: 0,
      time: '2026-07-04T02:00:00.000Z',
    });
    const snapshot = buildPortfolioSnapshot(afterSell, {
      '000001': { code: '000001', name: 'Demo Bank', price: 11 },
    });

    expect(afterBuy.cash).toBe(8000);
    expect(afterBuy.positions['000001'].quantity).toBe(200);
    expect(afterSell.cash).toBe(9200);
    expect(afterSell.positions['000001'].quantity).toBe(100);
    expect(snapshot.realizedPnl).toBe(200);
    expect(snapshot.positions[0].unrealizedPnl).toBe(100);
    expect(snapshot.boundary).toContain('Paper trading only');
  });
});
