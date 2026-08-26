import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import {
  applyPaperTrade,
  buildPortfolioSnapshot,
  buildTradingPlan,
  createPortfolio,
  parseSinaQuoteText,
  parseTencentQuoteText,
  stockExchangeSymbol,
} from './logic';
import type { KlineBar, PaperPortfolio, QuoteLike } from './logic';

// ── East Money public API helpers (no API key needed) ──────────────────────

const UA = 'LumiCore/3.0';
const PAPER_DIR = path.join(os.homedir(), '.lumi_stockbot');
const PAPER_FILE = path.join(PAPER_DIR, 'paper_portfolios.json');

function marketCode(code: string): string {
  const c = code.replace(/\D/g, '');
  if (/^6/.test(c)) return `1.${c}`;
  return `0.${c}`;
}

async function fetchJSON(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchGbkText(url: string, referer: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new TextDecoder('gbk').decode(await res.arrayBuffer());
}

async function fetchEastMoneyQuoteData(raw: string): Promise<QuoteLike & Record<string, any>> {
  const secid = raw.includes('.') ? raw : marketCode(raw);
  const fields = 'f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f60,f116,f117,f162,f167,f169,f170,f171';
  const data = await fetchJSON(
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`
  );
  const d = data?.data;
  if (!d) throw new Error(`No data for "${raw}"`);
  return {
    code: d.f57,
    name: d.f58,
    price: d.f43 != null ? d.f43 / 100 : null,
    high: d.f44 != null ? d.f44 / 100 : null,
    low: d.f45 != null ? d.f45 / 100 : null,
    open: d.f46 != null ? d.f46 / 100 : null,
    volume: d.f47,
    turnover: d.f48,
    changePercent: d.f169 != null ? d.f169 / 100 : null,
    changeAmount: d.f170 != null ? d.f170 / 100 : null,
    amplitude: d.f171 != null ? d.f171 / 100 : null,
    limitUp: d.f51 != null ? d.f51 / 100 : null,
    limitDown: d.f52 != null ? d.f52 / 100 : null,
    pe: d.f60 != null ? d.f60 / 100 : null,
    pb: d.f167 != null ? d.f167 / 100 : null,
    totalCap: d.f116,
    floatCap: d.f117,
    turnoverRate: d.f162 != null ? d.f162 / 100 : null,
    volumeRatio: d.f50 != null ? d.f50 / 100 : null,
    dataSource: 'eastmoney',
  };
}

async function fetchTencentQuoteData(raw: string): Promise<QuoteLike & Record<string, any>> {
  const symbol = stockExchangeSymbol(raw);
  const text = await fetchGbkText(`https://qt.gtimg.cn/q=${symbol}`, 'https://gu.qq.com/');
  return parseTencentQuoteText(text, raw);
}

async function fetchSinaQuoteData(raw: string): Promise<QuoteLike & Record<string, any>> {
  const symbol = stockExchangeSymbol(raw);
  const text = await fetchGbkText(`https://hq.sinajs.cn/list=${symbol}`, 'https://finance.sina.com.cn/');
  return parseSinaQuoteText(text, raw);
}

async function fetchQuoteData(raw: string): Promise<QuoteLike & Record<string, any>> {
  const errors: string[] = [];
  try {
    return await fetchEastMoneyQuoteData(raw);
  } catch (e: any) {
    errors.push(`eastmoney: ${e.message}`);
  }
  try {
    const quote = await fetchTencentQuoteData(raw);
    return { ...quote, fallbackFrom: 'eastmoney', fallbackErrors: errors };
  } catch (e: any) {
    errors.push(`tencent: ${e.message}`);
  }
  try {
    const quote = await fetchSinaQuoteData(raw);
    return { ...quote, fallbackFrom: 'eastmoney,tencent', fallbackErrors: errors };
  } catch (e: any) {
    errors.push(`sina: ${e.message}`);
  }
  throw new Error(errors.join('; '));
}

async function fetchKlineData(raw: string, period = 'daily', limit = 30) {
  const safeLimit = Math.min(Math.max(Number(limit || 30), 1), 365);
  const kltMap: Record<string, string> = { daily: '101', weekly: '102', monthly: '103' };
  const klt = kltMap[period] || '101';
  const secid = raw.includes('.') ? raw : marketCode(raw);
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
  const data = await fetchJSON(
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=${fields2}&klt=${klt}&fqt=1&end=20500101&lmt=${safeLimit}`
  );
  const rawLines = data?.data?.klines || [];
  const name = data?.data?.name || raw;
  const klines: KlineBar[] = rawLines.map((line: string) => {
    const parts = line.split(',');
    return {
      date: parts[0],
      open: Number(parts[1]),
      close: Number(parts[2]),
      high: Number(parts[3]),
      low: Number(parts[4]),
      volume: Number(parts[5]),
      turnover: Number(parts[6]),
      amplitude: Number(parts[7]),
      changePercent: Number(parts[8]),
      changeAmount: Number(parts[9]),
      turnoverRate: Number(parts[10]),
    };
  });
  const recent = klines.slice(-5).map((k: any) => k.close);
  const trend = recent.length >= 2 ? (recent[recent.length - 1] >= recent[0] ? 'up' : 'down') : 'flat';
  return { code: raw, name, period, count: klines.length, trend, klines };
}

function loadPaperStore(): Record<string, PaperPortfolio> {
  try {
    if (!fs.existsSync(PAPER_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(PAPER_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePaperStore(store: Record<string, PaperPortfolio>): void {
  if (!fs.existsSync(PAPER_DIR)) fs.mkdirSync(PAPER_DIR, { recursive: true });
  fs.writeFileSync(PAPER_FILE, `${JSON.stringify(store, null, 2)}\n`);
}

async function refreshPortfolioQuotes(portfolio: PaperPortfolio): Promise<Record<string, QuoteLike>> {
  const quotes: Record<string, QuoteLike> = {};
  for (const code of Object.keys(portfolio.positions)) {
    try {
      quotes[code] = await fetchQuoteData(code);
    } catch {
      // Portfolio snapshots still work with avg cost marks when quote refresh fails.
    }
  }
  return quotes;
}

// ── Tool 1: stock_search ───────────────────────────────────────────────────

async function searchStocks(args: any) {
  const keyword = String(args.keyword || '');
  if (!keyword.trim()) return err('keyword is required');
  try {
    const data = await fetchJSON(
      `https://searchadapter.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=14&token=D43BF722C8E33BDC906FB84A85B32659&count=10`
    );
    const items = data?.QuotationCodeTable?.Data || [];
    if (!items.length) return ok({ query: keyword, count: 0, results: [], hint: 'No matching stocks found' });
    const results = items.map((it: any) => ({
      code: it.Code,
      name: it.Name,
      market: it.MktNum === '1' ? 'SH' : it.MktNum === '0' ? 'SZ' : it.MktNum,
      type: it.SecurityTypeName || 'stock',
    }));
    return ok({ query: keyword, count: results.length, results });
  } catch (e: any) {
    return err(`Search failed: ${e.message}`);
  }
}

// ── Tool 2: stock_quote ────────────────────────────────────────────────────

async function getQuote(args: any) {
  const raw = String(args.code || '').trim();
  if (!raw) return err('code is required (e.g. 600519 or 000001)');
  try {
    return ok(await fetchQuoteData(raw));
  } catch (e: any) {
    return err(`Quote failed: ${e.message}`);
  }
}

// ── Tool 3: stock_kline ────────────────────────────────────────────────────

async function getKline(args: any) {
  const raw = String(args.code || '').trim();
  const period = String(args.period || 'daily');
  const limit = Math.min(Number(args.limit || 30), 365);
  if (!raw) return err('code is required');
  try {
    return ok(await fetchKlineData(raw, period, limit));
  } catch (e: any) {
    return err(`K-line failed: ${e.message}`);
  }
}

// ── Tool 7: stock_trade_plan ────────────────────────────────────────────────

async function getTradePlan(args: any) {
  const raw = String(args.code || '').trim();
  let quote: QuoteLike | null = null;
  let klines: KlineBar[] = [];
  const dataWarnings: string[] = [];
  try {
    if (raw) quote = await fetchQuoteData(raw);
  } catch (e: any) {
    dataWarnings.push(`Quote refresh failed: ${e.message}`);
  }
  try {
    if (raw) klines = (await fetchKlineData(raw, 'daily', 30)).klines;
  } catch (e: any) {
    dataWarnings.push(`K-line refresh failed: ${e.message}`);
  }
  try {
    const plan = buildTradingPlan(args, quote, klines);
    return ok({ ...plan, dataWarnings });
  } catch (e: any) {
    return err(`Trade plan failed: ${e.message}`);
  }
}

// ── Tool 8: paper_trade ─────────────────────────────────────────────────────

async function runPaperTrade(args: any) {
  const portfolioId = String(args.portfolioId || 'default');
  const raw = String(args.code || '').trim();
  let quote: QuoteLike | null = null;
  try {
    if (raw && !args.price) quote = await fetchQuoteData(raw);
  } catch (e: any) {
    return err(`Paper trade quote failed: ${e.message}. Provide price to record the simulation manually.`);
  }

  try {
    const store = loadPaperStore();
    const existing = store[portfolioId] || createPortfolio(portfolioId, args.initialCash);
    const next = applyPaperTrade(existing, { ...args, portfolioId }, quote);
    store[portfolioId] = next;
    savePaperStore(store);
    const quotes = quote ? { [next.trades[next.trades.length - 1].code]: quote } : {};
    return ok({
      trade: next.trades[next.trades.length - 1],
      snapshot: buildPortfolioSnapshot(next, quotes),
    });
  } catch (e: any) {
    return err(`Paper trade failed: ${e.message}`);
  }
}

// ── Tool 9: paper_portfolio ─────────────────────────────────────────────────

async function getPaperPortfolio(args: any) {
  const portfolioId = String(args.portfolioId || 'default');
  try {
    const store = loadPaperStore();
    let portfolio = store[portfolioId];
    if (!portfolio || args.reset === true) {
      portfolio = createPortfolio(portfolioId, args.initialCash);
      store[portfolioId] = portfolio;
      savePaperStore(store);
    }
    const quotes = args.refreshQuotes === false ? {} : await refreshPortfolioQuotes(portfolio);
    return ok(buildPortfolioSnapshot(portfolio, quotes));
  } catch (e: any) {
    return err(`Paper portfolio failed: ${e.message}`);
  }
}

// ── Tool 4: market_index ────────────────────────────────────────────────────

const INDICES: Record<string, { secid: string; name: string }> = {
  sh:      { secid: '1.000001', name: '上证指数' },
  sz:      { secid: '0.399001', name: '深证成指' },
  chinext: { secid: '0.399006', name: '创业板指' },
  star:    { secid: '1.000688', name: '科创50' },
  hs300:   { secid: '1.000300', name: '沪深300' },
  sz50:    { secid: '1.000016', name: '上证50' },
  zz500:   { secid: '1.000905', name: '中证500' },
};

async function getMarketIndex(args: any) {
  const code = String(args.index || 'all').toLowerCase();
  try {
    const targets = code === 'all'
      ? Object.entries(INDICES)
      : Object.entries(INDICES).filter(([k]) => k === code || INDICES[k].secid === code);
    if (!targets.length) return err(`Unknown index "${code}". Try: ${Object.keys(INDICES).join(', ')}`);

    const fields = 'f43,f44,f45,f46,f47,f48,f57,f58,f169,f170,f171';
    const results: any[] = [];
    for (const [, info] of targets) {
      const data = await fetchJSON(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${info.secid}&fields=${fields}`
      );
      const d = data?.data;
      if (!d) continue;
      results.push({
        name: d.f58,
        price: d.f43 != null ? d.f43 / 100 : null,
        high: d.f44 != null ? d.f44 / 100 : null,
        low: d.f45 != null ? d.f45 / 100 : null,
        open: d.f46 != null ? d.f46 / 100 : null,
        volume: d.f47,
        turnover: d.f48,
        changePercent: d.f169 != null ? d.f169 / 100 : null,
        changeAmount: d.f170 != null ? d.f170 / 100 : null,
        amplitude: d.f171 != null ? d.f171 / 100 : null,
      });
    }
    return ok({ indices: results });
  } catch (e: any) {
    return err(`Index failed: ${e.message}`);
  }
}

// ── Tool 5: hot_sectors ────────────────────────────────────────────────────

async function getHotSectors(_args: any) {
  try {
    const fields = 'f2,f3,f4,f8,f12,f14,f15,f20,f104,f105,f128,f140';
    const data = await fetchJSON(
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=30&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=${fields}`
    );
    const items = data?.data?.diff || [];
    const sectors = items.map((it: any) => ({
      code: it.f12,
      name: it.f14,
      index: it.f15,
      changePercent: it.f3 != null ? it.f3 / 100 : null,
      changeAmount: it.f4 != null ? it.f4 / 100 : null,
      turnoverRate: it.f8 != null ? it.f8 / 100 : null,
      totalCap: it.f20,
      // Leading stock
      leadStock: it.f128 ? { code: it.f128, name: it.f140 } : null,
      upCount: it.f104,
      downCount: it.f105,
    }));
    // Sort by changePercent descending
    sectors.sort((a: any, b: any) => (b.changePercent ?? -999) - (a.changePercent ?? -999));
    return ok({ count: sectors.length, sectors });
  } catch (e: any) {
    return err(`Hot sectors failed: ${e.message}`);
  }
}

// ── Tool 6: stock_news ──────────────────────────────────────────────────────

async function getStockNews(args: any) {
  const raw = String(args.code || '').trim();
  if (!raw) return err('code is required');
  try {
    const secid = raw.includes('.') ? raw : marketCode(raw);
    // Use East Money's news/list endpoint
    const data = await fetchJSON(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58`
    );
    const name = data?.data?.f58 || raw;
    const newsData = await fetchJSON(
      `https://push2.eastmoney.com/api/qt/stock/news/get?secid=${secid}&pagesize=10&pageindex=1&source=web`
    );
    const items = (newsData?.data?.list || []).map((it: any) => ({
      title: it.title || it.TITLE,
      time: it.showTime || it.SHOWTIME || it.time,
      source: it.source || it.SOURCE,
      url: it.url || it.URL,
      summary: (it.digest || it.DIGEST || '').replace(/<[^>]+>/g, '').slice(0, 150),
    }));
    return ok({ code: raw, name, count: items.length, news: items });
  } catch (e: any) {
    return err(`News failed: ${e.message}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ok(data: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { content: [{ type: 'text' as const, text: `StockBot error: ${message}` }], isError: true };
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'stockbot', version: '1.1.2' }, { capabilities: { tools: {} } });

server.registerTool('stock_search', {
  description: 'Search A-stock by name or code. Returns matching stocks with code, name, and market.',
  inputSchema: { keyword: z.string().describe('Search keyword, e.g. "茅台" or "600519"') },
}, searchStocks);

server.registerTool('stock_quote', {
  description: 'Get real-time quote for a stock: price, change%, volume, PE, PB, market cap, limit up/down, etc.',
  inputSchema: { code: z.string().describe('Stock code, e.g. "600519" or "000001"') },
}, getQuote);

server.registerTool('stock_kline', {
  description: 'Get K-line (candlestick) data. Returns OHLCV bars with date, amplitude, turnover rate.',
  inputSchema: {
    code: z.string().describe('Stock code'),
    period: z.enum(['daily', 'weekly', 'monthly']).optional().describe('K-line period (default: daily)'),
    limit: z.number().optional().describe('Number of bars (default: 30, max: 365)'),
  },
}, getKline);

server.registerTool('market_index', {
  description: 'Get major Chinese market indices: 上证, 深证, 创业板, 科创50, 沪深300, 上证50, 中证500. Pass "all" for all.',
  inputSchema: {
    index: z.string().optional().describe('Index key: sh, sz, chinext, star, hs300, sz50, zz500, or "all" (default)'),
  },
}, getMarketIndex);

server.registerTool('hot_sectors', {
  description: 'Get today\'s hottest industry sectors ranked by change%. Includes leading stock per sector.',
  inputSchema: {},
}, getHotSectors);

server.registerTool('stock_news', {
  description: 'Get latest news and announcements for a stock.',
  inputSchema: { code: z.string().describe('Stock code, e.g. "600519"') },
}, getStockNews);

server.registerTool('stock_trade_plan', {
  description: 'Build a risk-managed paper trading plan with entry, stop, target, position sizing, and a review checklist. This does not place orders or provide investment advice.',
  inputSchema: {
    code: z.string().optional().describe('Stock code, e.g. "600519". Quote/K-line data will be used when available.'),
    name: z.string().optional().describe('Optional stock name if code is unavailable.'),
    strategy: z.enum(['intraday', 'swing', 'trend', 'long_term']).optional().describe('Trading style. Default: swing.'),
    accountSize: z.number().optional().describe('Paper account size or real account capital used only for sizing calculations.'),
    maxRiskPercent: z.number().optional().describe('Maximum risk per trade. Accepts 1 for 1% or 0.01 for 1%. Default: 1%.'),
    entryPrice: z.number().optional().describe('Planned entry price. Defaults to latest quote when available.'),
    stopLossPrice: z.number().optional().describe('Invalidation/stop-loss price. Defaults to a conservative recent-low estimate.'),
    targetPrice: z.number().optional().describe('Target/exit price. Defaults to roughly 2R above entry when possible.'),
    holdingDays: z.number().optional().describe('Expected holding period in days.'),
    notes: z.string().optional().describe('Thesis, catalyst, sector context, or personal review notes.'),
  },
}, getTradePlan);

server.registerTool('paper_trade', {
  description: 'Record a simulated buy/sell in Lumi StockBot paper trading. Paper trading only: no brokerage connection and no real order placement.',
  inputSchema: {
    portfolioId: z.string().optional().describe('Paper portfolio id. Default: default.'),
    side: z.enum(['buy', 'sell']).describe('Simulated trade side.'),
    code: z.string().describe('Stock code, e.g. "600519".'),
    name: z.string().optional().describe('Optional stock name.'),
    quantity: z.number().describe('Share quantity. A-share lots are rounded down to 100-share lots.'),
    price: z.number().optional().describe('Simulated execution price. Defaults to latest quote when available.'),
    initialCash: z.number().optional().describe('Initial paper cash when creating a new portfolio. Default: 100000.'),
    fee: z.number().optional().describe('Explicit simulated fee. If omitted, a simple commission/stamp-tax estimate is used.'),
    feeRate: z.number().optional().describe('Commission rate. Accepts 0.0003 or 0.03 for 0.03%.'),
    minFee: z.number().optional().describe('Minimum commission. Default: 5.'),
    stampTaxRate: z.number().optional().describe('Sell-side stamp tax estimate. Default: 0.0005.'),
    reason: z.string().optional().describe('Why this simulated trade was recorded.'),
  },
}, runPaperTrade);

server.registerTool('paper_portfolio', {
  description: 'Get or reset a StockBot paper trading portfolio with cash, positions, P/L, and recent simulated trades.',
  inputSchema: {
    portfolioId: z.string().optional().describe('Paper portfolio id. Default: default.'),
    initialCash: z.number().optional().describe('Initial paper cash when creating or resetting a portfolio. Default: 100000.'),
    reset: z.boolean().optional().describe('Reset this paper portfolio. This only affects simulated StockBot paper data.'),
    refreshQuotes: z.boolean().optional().describe('Refresh market quotes for current marks. Default: true.'),
  },
}, getPaperPortfolio);

const transport = new StdioServerTransport();
await server.connect(transport);
