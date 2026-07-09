export type TradeSide = 'buy' | 'sell';

export interface QuoteLike {
  code: string;
  name?: string;
  price?: number | null;
}

export interface KlineBar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume?: number;
  turnover?: number;
  amplitude?: number;
  changePercent?: number;
  changeAmount?: number;
  turnoverRate?: number;
}

export interface TradePlanArgs {
  code?: string;
  name?: string;
  strategy?: 'intraday' | 'swing' | 'trend' | 'long_term';
  accountSize?: number;
  maxRiskPercent?: number;
  entryPrice?: number;
  stopLossPrice?: number;
  targetPrice?: number;
  holdingDays?: number;
  notes?: string;
}

export interface PaperPosition {
  code: string;
  name?: string;
  quantity: number;
  avgCost: number;
  realizedPnl: number;
}

export interface PaperTrade {
  id: string;
  time: string;
  side: TradeSide;
  code: string;
  name?: string;
  quantity: number;
  price: number;
  grossAmount: number;
  fee: number;
  cashChange: number;
  realizedPnl?: number;
  reason?: string;
}

export interface PaperPortfolio {
  portfolioId: string;
  currency: string;
  initialCash: number;
  cash: number;
  positions: Record<string, PaperPosition>;
  trades: PaperTrade[];
  createdAt: string;
  updatedAt: string;
}

export interface PaperTradeArgs {
  portfolioId?: string;
  side?: TradeSide;
  code?: string;
  name?: string;
  quantity?: number;
  price?: number;
  initialCash?: number;
  fee?: number;
  feeRate?: number;
  minFee?: number;
  stampTaxRate?: number;
  reason?: string;
  time?: string;
}

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stockCodeFromRaw(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.slice(-6);
}

function numericField(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function stockExchangeSymbol(raw: string): string {
  const code = stockCodeFromRaw(raw);
  if (!code) throw new Error('stock code is required');
  return `${/^6/.test(code) ? 'sh' : 'sz'}${code}`;
}

export function parseTencentQuoteText(text: string, raw = ''): QuoteLike & Record<string, any> {
  const match = String(text || '').match(/="([^"]*)"/);
  if (!match) throw new Error('Tencent quote response was not recognized');
  const parts = match[1].split('~');
  const code = parts[2] || stockCodeFromRaw(raw);
  const price = numericField(parts[3]);
  if (!code || price === null) throw new Error('Tencent quote response did not include code and price');
  return {
    code,
    name: parts[1] || code,
    price,
    open: numericField(parts[5]),
    high: numericField(parts[33]),
    low: numericField(parts[34]),
    volume: numericField(parts[6]),
    turnover: numericField(parts[37]),
    changeAmount: numericField(parts[31]),
    changePercent: numericField(parts[32]),
    dataSource: 'tencent',
    quoteTime: parts[30] || undefined,
  };
}

export function parseSinaQuoteText(text: string, raw = ''): QuoteLike & Record<string, any> {
  const match = String(text || '').match(/="([^"]*)"/);
  if (!match) throw new Error('Sina quote response was not recognized');
  const parts = match[1].split(',');
  const code = stockCodeFromRaw(raw);
  const price = numericField(parts[3]);
  const previousClose = numericField(parts[2]);
  if (!code || !parts[0] || price === null) throw new Error('Sina quote response did not include name, code, and price');
  const changeAmount = previousClose === null ? null : roundMoney(price - previousClose);
  return {
    code,
    name: parts[0],
    price,
    open: numericField(parts[1]),
    high: numericField(parts[4]),
    low: numericField(parts[5]),
    volume: numericField(parts[8]),
    turnover: numericField(parts[9]),
    changeAmount,
    changePercent: previousClose && previousClose > 0 ? roundMoney((price - previousClose) / previousClose * 100) : null,
    dataSource: 'sina',
    quoteDate: parts[30] || undefined,
    quoteTime: parts[31] || undefined,
  };
}

function toRiskRate(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim();
  const raw = Number(text.replace('%', '').trim());
  if (!Number.isFinite(raw)) return fallback;
  if (text.includes('%')) return raw / 100;
  if (raw >= 1 || raw > 0.2) return raw / 100;
  return raw;
}

function toSmallPercentRate(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim();
  const raw = Number(text.replace('%', '').trim());
  if (!Number.isFinite(raw)) return fallback;
  if (text.includes('%')) return raw / 100;
  if (raw >= 0.01) return raw / 100;
  return raw;
}

function normalizeLot(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.floor(quantity / 100) * 100;
}

function recentLow(klines: KlineBar[], lookback = 10): number | null {
  const lows = klines.slice(-lookback).map(k => Number(k.low)).filter(Number.isFinite);
  if (!lows.length) return null;
  return Math.min(...lows);
}

function recentHigh(klines: KlineBar[], lookback = 10): number | null {
  const highs = klines.slice(-lookback).map(k => Number(k.high)).filter(Number.isFinite);
  if (!highs.length) return null;
  return Math.max(...highs);
}

export function buildTradingPlan(args: TradePlanArgs, quote?: QuoteLike | null, klines: KlineBar[] = []) {
  const code = String(args.code || quote?.code || '').trim();
  const name = args.name || quote?.name || code;
  const currentPrice = toNumber(quote?.price, toNumber(args.entryPrice));
  const entryPrice = toNumber(args.entryPrice, currentPrice);
  const accountSize = toNumber(args.accountSize);
  const maxRiskPercent = Math.min(Math.max(toRiskRate(args.maxRiskPercent, 0.01), 0.001), 0.2);
  const low = recentLow(klines);
  const high = recentHigh(klines);
  const derivedStop = low && entryPrice > 0 ? Math.min(low * 0.99, entryPrice * 0.95) : entryPrice * 0.95;
  const stopLossPrice = toNumber(args.stopLossPrice, derivedStop);
  const perShareRisk = Math.max(entryPrice - stopLossPrice, 0);
  const riskBudget = accountSize > 0 ? accountSize * maxRiskPercent : 0;
  const riskSizedShares = perShareRisk > 0 && riskBudget > 0 ? normalizeLot(riskBudget / perShareRisk) : 0;
  const cashCappedShares = accountSize > 0 && entryPrice > 0 ? normalizeLot(accountSize / entryPrice) : riskSizedShares;
  const suggestedShares = accountSize > 0 ? Math.min(riskSizedShares, cashCappedShares) : 0;
  const capitalNeeded = suggestedShares * entryPrice;
  const targetPrice = toNumber(args.targetPrice, perShareRisk > 0 ? entryPrice + perShareRisk * 2 : high || entryPrice);
  const rewardPerShare = Math.max(targetPrice - entryPrice, 0);
  const riskRewardRatio = perShareRisk > 0 ? rewardPerShare / perShareRisk : null;
  const holdingDays = Math.min(Math.max(Math.floor(toNumber(args.holdingDays, args.strategy === 'intraday' ? 1 : 20)), 1), 365);

  const warnings: string[] = [];
  if (!code) warnings.push('No stock code was provided.');
  if (entryPrice <= 0) warnings.push('Entry price is missing or invalid.');
  if (stopLossPrice <= 0 || stopLossPrice >= entryPrice) warnings.push('Stop-loss should be below entry for a long-side plan.');
  if (accountSize <= 0) warnings.push('Provide accountSize to calculate position sizing.');
  if (riskRewardRatio !== null && riskRewardRatio < 2) warnings.push('Risk/reward is below 2:1; consider a tighter stop, better entry, or clearer target.');
  if (accountSize > 0 && suggestedShares <= 0) warnings.push('Risk budget is too small for one 100-share lot at the current stop distance.');

  return {
    code,
    name,
    strategy: args.strategy || 'swing',
    quote: {
      currentPrice: roundMoney(currentPrice),
      recentLow: low === null ? null : roundMoney(low),
      recentHigh: high === null ? null : roundMoney(high),
    },
    plan: {
      entryPrice: roundMoney(entryPrice),
      stopLossPrice: roundMoney(stopLossPrice),
      targetPrice: roundMoney(targetPrice),
      holdingDays,
      maxRiskPercent: roundMoney(maxRiskPercent * 100),
      riskBudget: roundMoney(riskBudget),
      perShareRisk: roundMoney(perShareRisk),
      rewardPerShare: roundMoney(rewardPerShare),
      riskRewardRatio: riskRewardRatio === null ? null : roundMoney(riskRewardRatio),
      suggestedShares,
      capitalNeeded: roundMoney(capitalNeeded),
      maxLossAtStop: roundMoney(suggestedShares * perShareRisk),
      potentialGainAtTarget: roundMoney(suggestedShares * rewardPerShare),
    },
    checklist: [
      'Confirm the thesis, catalyst, and invalidation point before any real trade.',
      'Use position sizing from risk budget, not from excitement or fear of missing out.',
      'Review liquidity, upcoming announcements, broader index trend, and sector strength.',
      'This is a planning aid, not investment advice or an order instruction.',
    ],
    warnings,
    notes: args.notes || '',
  };
}

export function createPortfolio(portfolioId = 'default', initialCash = 100000, now = new Date().toISOString()): PaperPortfolio {
  const cash = roundMoney(Math.max(toNumber(initialCash, 100000), 0));
  return {
    portfolioId,
    currency: 'CNY',
    initialCash: cash,
    cash,
    positions: {},
    trades: [],
    createdAt: now,
    updatedAt: now,
  };
}

function tradeFee(args: PaperTradeArgs, grossAmount: number): number {
  if (args.fee !== undefined && args.fee !== null) return roundMoney(Math.max(toNumber(args.fee), 0));
  const feeRate = toSmallPercentRate(args.feeRate, 0.0003);
  const minFee = Math.max(toNumber(args.minFee, 5), 0);
  const stampTaxRate = args.side === 'sell' ? toSmallPercentRate(args.stampTaxRate, 0.0005) : 0;
  const commission = Math.max(grossAmount * feeRate, minFee);
  return roundMoney(commission + grossAmount * stampTaxRate);
}

export function applyPaperTrade(portfolio: PaperPortfolio, args: PaperTradeArgs, quote?: QuoteLike | null): PaperPortfolio {
  const side = args.side;
  if (side !== 'buy' && side !== 'sell') throw new Error('side must be "buy" or "sell"');
  const code = String(args.code || quote?.code || '').trim();
  if (!code) throw new Error('code is required');
  const name = args.name || quote?.name || portfolio.positions[code]?.name || code;
  const quantity = normalizeLot(toNumber(args.quantity));
  if (quantity <= 0) throw new Error('quantity must be a positive 100-share lot');
  const price = roundMoney(toNumber(args.price, toNumber(quote?.price)));
  if (price <= 0) throw new Error('price is required when no quote is available');

  const next: PaperPortfolio = {
    ...portfolio,
    positions: { ...portfolio.positions },
    trades: [...portfolio.trades],
  };
  const grossAmount = roundMoney(quantity * price);
  const fee = tradeFee({ ...args, side }, grossAmount);
  const now = args.time || new Date().toISOString();

  let realizedPnl = 0;
  if (side === 'buy') {
    const cashChange = roundMoney(-(grossAmount + fee));
    if (next.cash + cashChange < -0.0001) throw new Error('not enough paper cash for this simulated buy');
    const previous = next.positions[code] || { code, name, quantity: 0, avgCost: 0, realizedPnl: 0 };
    const newQty = previous.quantity + quantity;
    const newAvgCost = newQty > 0
      ? roundMoney((previous.avgCost * previous.quantity + grossAmount + fee) / newQty)
      : 0;
    next.positions[code] = {
      ...previous,
      name,
      quantity: newQty,
      avgCost: newAvgCost,
    };
    next.cash = roundMoney(next.cash + cashChange);
    next.trades.push({
      id: `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      time: now,
      side,
      code,
      name,
      quantity,
      price,
      grossAmount,
      fee,
      cashChange,
      reason: args.reason,
    });
  } else {
    const held = next.positions[code];
    if (!held || held.quantity < quantity) throw new Error('not enough paper shares for this simulated sell');
    const previous = { ...held };
    realizedPnl = roundMoney((price - previous.avgCost) * quantity - fee);
    previous.quantity -= quantity;
    previous.realizedPnl = roundMoney(previous.realizedPnl + realizedPnl);
    const cashChange = roundMoney(grossAmount - fee);
    next.cash = roundMoney(next.cash + cashChange);
    if (previous.quantity <= 0) {
      delete next.positions[code];
    } else {
      next.positions[code] = { ...previous };
    }
    next.trades.push({
      id: `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      time: now,
      side,
      code,
      name,
      quantity,
      price,
      grossAmount,
      fee,
      cashChange,
      realizedPnl,
      reason: args.reason,
    });
  }

  next.updatedAt = now;
  return next;
}

export function buildPortfolioSnapshot(portfolio: PaperPortfolio, quotes: Record<string, QuoteLike> = {}) {
  const positions = Object.values(portfolio.positions).map(position => {
    const markPrice = toNumber(quotes[position.code]?.price, position.avgCost);
    const marketValue = position.quantity * markPrice;
    const costBasis = position.quantity * position.avgCost;
    const unrealizedPnl = marketValue - costBasis;
    return {
      ...position,
      markPrice: roundMoney(markPrice),
      marketValue: roundMoney(marketValue),
      costBasis: roundMoney(costBasis),
      unrealizedPnl: roundMoney(unrealizedPnl),
      unrealizedPnlPercent: costBasis > 0 ? roundMoney(unrealizedPnl / costBasis * 100) : 0,
    };
  });
  const marketValue = positions.reduce((sum, row) => sum + row.marketValue, 0);
  const realizedPnl = portfolio.trades.reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0);
  const totalEquity = portfolio.cash + marketValue;
  const totalReturn = totalEquity - portfolio.initialCash;
  return {
    portfolioId: portfolio.portfolioId,
    currency: portfolio.currency,
    cash: roundMoney(portfolio.cash),
    marketValue: roundMoney(marketValue),
    totalEquity: roundMoney(totalEquity),
    initialCash: roundMoney(portfolio.initialCash),
    totalReturn: roundMoney(totalReturn),
    totalReturnPercent: portfolio.initialCash > 0 ? roundMoney(totalReturn / portfolio.initialCash * 100) : 0,
    realizedPnl: roundMoney(realizedPnl),
    positions,
    tradeCount: portfolio.trades.length,
    recentTrades: portfolio.trades.slice(-10),
    updatedAt: portfolio.updatedAt,
    boundary: 'Paper trading only. No brokerage connection, no order placement, and no investment advice.',
  };
}
