import { describe, expect, it } from 'vitest';
import {
  applyPaperTrade,
  buildPortfolioSnapshot,
  buildTradingPlan,
  createPortfolio,
} from '../server/skills/bundled/stockbot/logic';

describe('stockbot trading helpers', () => {
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
