// Smart Scanner API — Advanced coin detection + Multi-Strategy Auto-Trading Engine
// GET  /api/smart-scanner              → scan top 50 coins
// GET  /api/smart-scanner?coins=BTC,ETH → scan specific coins
// GET  /api/smart-scanner?alert=1       → cron: scan + telegram alerts + auto-trade
// GET  /api/smart-scanner?action=getConfig    → get trading config + strategies
// POST /api/smart-scanner?action=setConfig    → update trading config + strategies
// GET  /api/smart-scanner?action=getPositions → get open positions + history
// POST /api/smart-scanner?action=closePosition → manually close a position
// POST /api/smart-scanner?action=emergencyStop → stop all trading + close all positions

import { RestClientV5 } from 'bybit-api';
import { put, list, del } from '@vercel/blob';

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

interface SmartSignal {
  symbol: string;
  price: number;
  change1h: number;
  change24h: number;
  volume24h: number;
  volumeAnomaly: number;
  momentum: number;
  rsi: number;
  rsiZone: string;
  strength: number;
  signals: string[];
  category: 'early_gainer' | 'breakout' | 'reversal' | 'accumulation' | 'momentum' | 'watch';
  reason: string;
  action: 'strong_buy' | 'buy' | 'watch' | 'sell' | 'strong_sell';
  confidence: number;
  // Extended data for strategy evaluation
  ema9: number; ema21: number; ema50: number;
  macdHist: number; macdCrossing: boolean;
  bollingerLower: number; bollingerUpper: number;
  hourlyVolSpike: number;
  priceRange7d: number;
  volTrend: number;
}

// === 10 TRADING STRATEGIES ===
interface Strategy {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  // Per-strategy performance
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
}

const STRATEGY_DEFINITIONS: Omit<Strategy, 'enabled' | 'trades' | 'wins' | 'losses' | 'pnl'>[] = [
  { id: 'scanner_signal',   name: 'Scanner Signal',      description: 'Trades on scanner BUY/STRONG_BUY — the default multi-indicator signal' },
  { id: 'rsi_reversal',     name: 'RSI Reversal',        description: 'Buys when RSI < 30 (oversold) and hourly RSI is bouncing up' },
  { id: 'ema_crossover',    name: 'EMA Crossover',       description: 'Buys when EMA9 crosses above EMA21 — trend change confirmed' },
  { id: 'macd_momentum',    name: 'MACD Momentum',       description: 'Buys on MACD bullish crossover with positive histogram' },
  { id: 'volume_breakout',  name: 'Volume Breakout',     description: 'Buys when volume spikes 3x+ with price breaking 20-day high' },
  { id: 'bollinger_bounce', name: 'Bollinger Bounce',    description: 'Buys when price touches lower Bollinger Band (oversold bounce)' },
  { id: 'dip_buyer',        name: 'Dip Buyer',           description: 'Buys when 24h change < -5% — catching falling knives with volume' },
  { id: 'trend_follower',   name: 'Trend Follower',      description: 'Buys when price above EMA50 + momentum > 30 — ride the trend' },
  { id: 'accumulation',     name: 'Accumulation',        description: 'Buys during tight range + rising volume — smart money loading up' },
  { id: 'early_gainer',     name: 'Early Gainer',        description: 'Buys on hourly volume surge (3x+) — catch moves before they happen' },
  { id: 'dca_accumulator',  name: 'DCA Accumulator',     description: 'Dollar Cost Averaging — buys dips at set intervals, stacks into position, exits at avg-price profit target' },
];

function evaluateStrategies(sig: SmartSignal, enabledStrategies: string[]): string[] {
  const matched: string[] = [];

  // 1. Scanner Signal — uses the scanner's own BUY/STRONG_BUY
  if (enabledStrategies.includes('scanner_signal')) {
    if ((sig.action === 'buy' || sig.action === 'strong_buy') && sig.strength >= 40) {
      matched.push('scanner_signal');
    }
  }

  // 2. RSI Reversal — RSI < 30 and bouncing
  if (enabledStrategies.includes('rsi_reversal')) {
    if (sig.rsi < 30 && sig.signals.includes('RSI REVERSAL')) {
      matched.push('rsi_reversal');
    }
  }

  // 3. EMA Crossover — EMA9 just crossed above EMA21
  if (enabledStrategies.includes('ema_crossover')) {
    if (sig.ema9 > sig.ema21 && sig.momentum > 0 && sig.rsi > 40 && sig.rsi < 70) {
      matched.push('ema_crossover');
    }
  }

  // 4. MACD Momentum — MACD bullish crossover
  if (enabledStrategies.includes('macd_momentum')) {
    if (sig.macdCrossing && sig.macdHist > 0 && sig.momentum > 10) {
      matched.push('macd_momentum');
    }
  }

  // 5. Volume Breakout — 3x volume + new 20-day high
  if (enabledStrategies.includes('volume_breakout')) {
    if (sig.volumeAnomaly >= 3 && sig.signals.includes('BREAKOUT')) {
      matched.push('volume_breakout');
    }
  }

  // 6. Bollinger Bounce — price near lower Bollinger Band
  if (enabledStrategies.includes('bollinger_bounce')) {
    if (sig.price <= sig.bollingerLower * 1.01 && sig.rsi < 40 && sig.momentum > -30) {
      matched.push('bollinger_bounce');
    }
  }

  // 7. Dip Buyer — 24h down >5% but volume present
  if (enabledStrategies.includes('dip_buyer')) {
    if (sig.change24h <= -5 && sig.volumeAnomaly >= 1.2 && sig.rsi < 40) {
      matched.push('dip_buyer');
    }
  }

  // 8. Trend Follower — above EMA50, strong momentum
  if (enabledStrategies.includes('trend_follower')) {
    if (sig.price > sig.ema50 && sig.momentum > 30 && sig.ema9 > sig.ema21 && sig.rsi > 50 && sig.rsi < 75) {
      matched.push('trend_follower');
    }
  }

  // 9. Accumulation — tight range + rising volume
  if (enabledStrategies.includes('accumulation')) {
    if (sig.priceRange7d < 8 && sig.volTrend > 1.3 && sig.rsi > 35 && sig.rsi < 60) {
      matched.push('accumulation');
    }
  }

  // 10. Early Gainer — hourly volume surge before the big move
  if (enabledStrategies.includes('early_gainer')) {
    if (sig.hourlyVolSpike >= 3 && sig.change1h > 0.5 && sig.rsi < 70) {
      matched.push('early_gainer');
    }
  }

  return matched;
}

interface DcaEntry {
  price: number;
  qty: number;
  usdValue: number;
  time: string;
  orderId: string;
}

interface DcaStack {
  id: string;
  symbol: string;
  entries: DcaEntry[];
  avgEntryPrice: number;
  totalQty: number;
  totalInvested: number;
  stopLoss: number;
  takeProfit: number;
  status: 'open' | 'closed_tp' | 'closed_sl' | 'closed_manual';
  closePrice?: number;
  closeTime?: string;
  pnl?: number;
  pnlPercent?: number;
  openTime: string;
}

interface TradingConfig {
  enabled: boolean;
  positionSizeUSD: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  cooldownHours: number;
  maxPerCoin: number;
  maxTotal: number;
  triggerActions: string[];
  minStrength: number;
  // New features
  trailingStopPercent: number;   // 0 = disabled, e.g. 3 = trail 3% below peak
  profitLockPercent: number;     // Move SL to breakeven after this % gain (0 = disabled)
  maxHoldHours: number;          // Auto-close after N hours (0 = disabled)
  // DCA (Dollar Cost Averaging)
  dcaEnabled: boolean;
  dcaOrderSizeUSD: number;          // Size of each individual DCA buy
  dcaMaxOrders: number;             // Max buys per coin stack
  dcaTriggerDropPercent: number;    // % price drop from last entry to add more
  dcaTakeProfitPercent: number;     // % above avg entry to close in profit
  dcaStopLossPercent: number;       // % below avg entry to cut loss
  dcaCoins: string[];               // Whitelisted coins for DCA (empty = any scanned coin)
}

interface Position {
  id: string;
  symbol: string;
  entryPrice: number;
  qty: number;
  usdValue: number;
  entryTime: string;
  orderId: string;
  stopLoss: number;
  takeProfit: number;
  status: 'open' | 'closed_tp' | 'closed_sl' | 'closed_manual' | 'closed_emergency' | 'closed_trail' | 'closed_time';
  closePrice?: number;
  closeTime?: string;
  pnl?: number;
  pnlPercent?: number;
  signal: { action: string; strength: number; category: string; reason: string };
  strategy: string;  // which strategy triggered this trade
  peakPrice?: number;  // highest price since entry (for trailing stop)
}

interface TradingState {
  config: TradingConfig;
  strategies: Strategy[];
  positions: Position[];
  history: Position[];
  cooldowns: Record<string, string>;
  totalPnl: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  dcaStacks: DcaStack[];
  dcaHistory: DcaStack[];
}

const BLOB_KEY = 'trading/state.json';

const DEFAULT_CONFIG: TradingConfig = {
  enabled: true,
  positionSizeUSD: 10,
  stopLossPercent: 5,
  takeProfitPercent: 10,
  cooldownHours: 4,
  maxPerCoin: 2,
  maxTotal: 10,
  triggerActions: ['buy', 'strong_buy'],
  minStrength: 0,
  trailingStopPercent: 0,
  profitLockPercent: 0,
  maxHoldHours: 0,
  dcaEnabled: false,
  dcaOrderSizeUSD: 10,
  dcaMaxOrders: 5,
  dcaTriggerDropPercent: 3,
  dcaTakeProfitPercent: 8,
  dcaStopLossPercent: 15,
  dcaCoins: [],
};

function getDefaultStrategies(): Strategy[] {
  return STRATEGY_DEFINITIONS.map(d => ({
    ...d,
    enabled: d.id === 'scanner_signal', // Only default strategy ON
    trades: 0, wins: 0, losses: 0, pnl: 0,
  }));
}

// === BLOB STATE MANAGEMENT ===
async function loadState(): Promise<TradingState> {
  try {
    const blobs = await list({ prefix: 'trading/state' });
    if (blobs.blobs.length > 0) {
      const r = await fetch(blobs.blobs[0].url);
      if (r.ok) {
        const state = await r.json() as TradingState;
        // Ensure strategies array exists and has all defined strategies
        if (!state.strategies || state.strategies.length < STRATEGY_DEFINITIONS.length) {
          const existing = state.strategies || [];
          state.strategies = STRATEGY_DEFINITIONS.map(d => {
            const ex = existing.find((s: Strategy) => s.id === d.id);
            return ex || { ...d, enabled: d.id === 'scanner_signal', trades: 0, wins: 0, losses: 0, pnl: 0 };
          });
        }
        // Ensure new config fields
        if (state.config.trailingStopPercent === undefined) state.config.trailingStopPercent = 0;
        if (state.config.profitLockPercent === undefined) state.config.profitLockPercent = 0;
        if (state.config.maxHoldHours === undefined) state.config.maxHoldHours = 0;
        if (state.config.dcaEnabled === undefined) state.config.dcaEnabled = false;
        if (state.config.dcaOrderSizeUSD === undefined) state.config.dcaOrderSizeUSD = 10;
        if (state.config.dcaMaxOrders === undefined) state.config.dcaMaxOrders = 5;
        if (state.config.dcaTriggerDropPercent === undefined) state.config.dcaTriggerDropPercent = 3;
        if (state.config.dcaTakeProfitPercent === undefined) state.config.dcaTakeProfitPercent = 8;
        if (state.config.dcaStopLossPercent === undefined) state.config.dcaStopLossPercent = 15;
        if (state.config.dcaCoins === undefined) state.config.dcaCoins = [];
        if (!state.dcaStacks) state.dcaStacks = [];
        if (!state.dcaHistory) state.dcaHistory = [];
        return state;
      }
    }
  } catch {}
  return {
    config: { ...DEFAULT_CONFIG },
    strategies: getDefaultStrategies(),
    positions: [],
    history: [],
    cooldowns: {},
    totalPnl: 0,
    totalTrades: 0,
    winCount: 0,
    lossCount: 0,
    dcaStacks: [],
    dcaHistory: [],
  };
}

async function saveState(state: TradingState): Promise<void> {
  if (state.history.length > 200) state.history = state.history.slice(-200);
  const now = Date.now();
  for (const [sym, ts] of Object.entries(state.cooldowns)) {
    if (now - new Date(ts).getTime() > state.config.cooldownHours * 3600000) {
      delete state.cooldowns[sym];
    }
  }
  try {
    const blobs = await list({ prefix: 'trading/state' });
    for (const b of blobs.blobs) await del(b.url);
  } catch {}
  await put(BLOB_KEY, JSON.stringify(state), { access: 'public', addRandomSuffix: false });
}

// === INDICATORS ===
function computeRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) avgGain += ch; else avgLoss += -ch;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 100) / 100;
}

function ema(data: number[], period: number): number[] {
  const r: number[] = []; const k = 2 / (period + 1);
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { r.push(data[0]); continue; }
    r.push(data[i] * k + r[i - 1] * (1 - k));
  }
  return r;
}

function macd(closes: number[]): { macd: number; signal: number; hist: number } {
  if (closes.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const macdLine = fast.map((f, i) => f - slow[i]);
  const signalLine = ema(macdLine.slice(26), 9);
  const m = macdLine[macdLine.length - 1];
  const s = signalLine[signalLine.length - 1] || 0;
  return { macd: m, signal: s, hist: m - s };
}

function sma(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function bollingerBands(closes: number[], period: number = 20, mult: number = 2): { upper: number; middle: number; lower: number } {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: middle + mult * stdDev, middle, lower: middle - mult * stdDev };
}

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const bybitInterval: Record<string, string> = {
    '1h': '60', '4h': '240', '1d': 'D', '1w': 'W',
  };
  const iv = bybitInterval[interval] || interval;
  try {
    const r = await fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}USDT&interval=${iv}&limit=${limit}`);
    if (!r.ok) return [];
    const data = (await r.json()) as any;
    if (data.retCode !== 0 || !data.result?.list) return [];
    return data.result.list.reverse().map((k: any) => ({
      time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
  } catch { return []; }
}

async function scanCoin(symbol: string): Promise<SmartSignal | null> {
  const [hourly, daily] = await Promise.all([
    fetchKlines(symbol, '1h', 48),
    fetchKlines(symbol, '1d', 60),
  ]);
  if (daily.length < 20 || hourly.length < 24) return null;

  const last = daily[daily.length - 1];
  const prev = daily[daily.length - 2];
  const price = last.close;
  const change24h = prev ? ((price - prev.close) / prev.close) * 100 : 0;

  const lastH = hourly[hourly.length - 1];
  const prevH = hourly.length >= 2 ? hourly[hourly.length - 2] : lastH;
  const change1h = ((lastH.close - prevH.close) / prevH.close) * 100;

  const dailyCloses = daily.map(c => c.close);
  const dailyVolumes = daily.map(c => c.volume);
  const hourlyVolumes = hourly.map(c => c.volume);

  const vol7dAvg = dailyVolumes.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
  const currentVol = last.volume;
  const volumeAnomaly = vol7dAvg > 0 ? Math.round((currentVol / vol7dAvg) * 100) / 100 : 1;

  const hourlyAvgVol = hourlyVolumes.slice(0, -1).reduce((a, b) => a + b, 0) / (hourlyVolumes.length - 1);
  const hourlyVolSpike = hourlyAvgVol > 0 ? lastH.volume / hourlyAvgVol : 1;

  const rsi = computeRSI(dailyCloses);
  const rsi1h = computeRSI(hourly.map(c => c.close));
  const rsiZone = rsi >= 70 ? 'overbought' : rsi >= 60 ? 'strong' : rsi >= 40 ? 'neutral' : rsi >= 30 ? 'weak' : 'oversold';

  const ema9 = ema(dailyCloses, 9);
  const ema21 = ema(dailyCloses, 21);
  const ema50 = ema(dailyCloses, 50);
  const emaCurrent9 = ema9[ema9.length - 1];
  const emaCurrent21 = ema21[ema21.length - 1];
  const emaCurrent50 = ema50.length > 0 ? ema50[ema50.length - 1] : 0;
  const emaTrend = emaCurrent9 > emaCurrent21 ? 1 : -1;

  const macdData = macd(dailyCloses);
  const macdBullish = macdData.hist > 0;
  const macdCrossing = macdData.hist > 0 && macdData.macd < macdData.signal * 1.5;

  // Bollinger Bands
  const bb = bollingerBands(dailyCloses);

  let momentum = 0;
  if (emaTrend > 0) momentum += 20; else momentum -= 20;
  if (macdBullish) momentum += 15; else momentum -= 15;
  if (rsi > 50) momentum += 10; else momentum -= 10;
  if (change24h > 0) momentum += Math.min(20, change24h * 3); else momentum += Math.max(-20, change24h * 3);
  if (volumeAnomaly > 1.5) momentum += 15;
  if (hourlyVolSpike > 2) momentum += 10;
  momentum = Math.max(-100, Math.min(100, Math.round(momentum)));

  const last7Closes = dailyCloses.slice(-7);
  const priceRange7d = (Math.max(...last7Closes) - Math.min(...last7Closes)) / Math.min(...last7Closes) * 100;
  const last7Vols = dailyVolumes.slice(-7);
  const prev7Vols = dailyVolumes.slice(-14, -7);
  const volTrend = prev7Vols.length > 0
    ? (last7Vols.reduce((a, b) => a + b, 0) / last7Vols.length) / (prev7Vols.reduce((a, b) => a + b, 0) / prev7Vols.length)
    : 1;
  const accumulating = priceRange7d < 8 && volTrend > 1.3;

  const justBroke50 = ema50.length > 1 && price > ema50[ema50.length - 1] && prev.close < ema50[ema50.length - 2];

  const signals: string[] = [];
  const reasons: string[] = [];
  let strength = 0;

  if (volumeAnomaly >= 2 && change1h > 1 && rsi < 70) {
    signals.push('VOLUME SPIKE');
    reasons.push(`${volumeAnomaly.toFixed(1)}x avg volume with +${change1h.toFixed(1)}% in 1h`);
    strength += 30;
  }

  if (hourlyVolSpike >= 3 && change1h > 0.5) {
    signals.push('HOURLY SURGE');
    reasons.push(`${hourlyVolSpike.toFixed(1)}x hourly vol spike — early move detected`);
    strength += 25;
  }

  if (rsi < 30 && rsi1h > rsi) {
    signals.push('RSI REVERSAL');
    reasons.push(`Daily RSI ${rsi} oversold, hourly RSI ${rsi1h.toFixed(0)} bouncing`);
    strength += 25;
  }

  const high20d = Math.max(...daily.slice(-21, -1).map(c => c.high));
  if (price > high20d && volumeAnomaly > 1.3) {
    signals.push('BREAKOUT');
    reasons.push(`Price above 20-day high ($${high20d.toFixed(2)}) with volume`);
    strength += 25;
  }

  if (macdCrossing && emaTrend > 0) {
    signals.push('MACD CROSS');
    reasons.push('MACD bullish crossover in uptrend');
    strength += 20;
  }

  if (accumulating) {
    signals.push('ACCUMULATION');
    reasons.push(`Tight ${priceRange7d.toFixed(1)}% range with ${volTrend.toFixed(1)}x rising volume`);
    strength += 20;
  }

  if (justBroke50) {
    signals.push('EMA50 BREAK');
    reasons.push('Price just broke above 50-day EMA — trend change');
    strength += 20;
  }

  if (momentum > 50) {
    signals.push('STRONG MOMENTUM');
    reasons.push(`Momentum score ${momentum} — all indicators aligned bullish`);
    strength += 15;
  }

  if (rsi > 75 && volumeAnomaly < 1.2) {
    signals.push('OVERBOUGHT');
    reasons.push(`RSI ${rsi} overbought without volume support`);
    strength += 10;
  }

  if (!signals.length) return null;

  if (signals.length >= 4) strength += 20;
  else if (signals.length >= 3) strength += 15;
  else if (signals.length >= 2) strength += 10;
  strength = Math.min(100, strength);

  let category: SmartSignal['category'] = 'watch';
  let action: SmartSignal['action'] = 'watch';

  if (signals.includes('VOLUME SPIKE') || signals.includes('HOURLY SURGE')) {
    category = 'early_gainer';
    action = strength > 60 ? 'strong_buy' : 'buy';
  } else if (signals.includes('BREAKOUT') || signals.includes('EMA50 BREAK')) {
    category = 'breakout';
    action = strength > 50 ? 'buy' : 'watch';
  } else if (signals.includes('RSI REVERSAL')) {
    category = 'reversal';
    action = strength > 50 ? 'buy' : 'watch';
  } else if (signals.includes('ACCUMULATION')) {
    category = 'accumulation';
    action = 'watch';
  } else if (signals.includes('STRONG MOMENTUM')) {
    category = 'momentum';
    action = strength > 60 ? 'buy' : 'watch';
  }

  if (signals.includes('OVERBOUGHT')) {
    action = rsi > 80 ? 'strong_sell' : 'sell';
  }

  return {
    symbol, price,
    change1h: Math.round(change1h * 100) / 100,
    change24h: Math.round(change24h * 100) / 100,
    volume24h: currentVol,
    volumeAnomaly,
    momentum,
    rsi, rsiZone,
    strength,
    signals,
    category,
    reason: reasons.join(' | '),
    action,
    confidence: Math.min(95, strength + (signals.length * 5)),
    // Extended data for strategy evaluation
    ema9: emaCurrent9, ema21: emaCurrent21, ema50: emaCurrent50,
    macdHist: macdData.hist, macdCrossing,
    bollingerLower: bb.lower, bollingerUpper: bb.upper,
    hourlyVolSpike,
    priceRange7d,
    volTrend,
  };
}

const TOP_COINS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX',
  'DOT', 'MATIC', 'LINK', 'UNI', 'ATOM', 'LTC', 'NEAR',
  'FIL', 'APT', 'ARB', 'OP', 'IMX', 'INJ', 'SUI', 'SEI',
  'TIA', 'RUNE', 'FET', 'RNDR', 'GRT', 'AAVE', 'MKR',
  'SNX', 'CRV', 'LDO', 'PENDLE', 'STX', 'WLD', 'JUP',
  'PYTH', 'ENA', 'PEPE', 'WIF', 'BONK', 'FLOKI',
  'ORDI', 'TRX', 'XLM', 'ALGO', 'VET', 'FTM', 'SHIB',
];

// === TELEGRAM ===
async function sendTelegramAlert(token: string, chatId: string, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {}
}

function formatPrice(p: number): string {
  return p >= 1000 ? '$' + Math.round(p).toLocaleString() : p >= 1 ? '$' + p.toFixed(2) : '$' + p.toFixed(6);
}

async function sendSignalAlerts(signals: SmartSignal[], tgToken: string, tgChat: string) {
  let alertsSent = 0;

  const earlyGainers = signals.filter(s => s.category === 'early_gainer');
  for (const s of earlyGainers) {
    const volEmoji = s.volumeAnomaly >= 3 ? '🔴🔴🔴' : s.volumeAnomaly >= 2 ? '🔴🔴' : '🔴';
    const msg = `🚨 EARLY GAINER DETECTED\n\nCoin: ${s.symbol}\nPrice: ${formatPrice(s.price)}\n` +
      `1h: ${s.change1h >= 0 ? '+' : ''}${s.change1h}% | 24h: ${s.change24h >= 0 ? '+' : ''}${s.change24h}%\n\n` +
      `${volEmoji} Vol: ${s.volumeAnomaly.toFixed(1)}x | Mom: ${s.momentum} | RSI: ${s.rsi.toFixed(0)}\n` +
      `💪 Strength: ${s.strength}% | 🎯 Conf: ${s.confidence}%\n\n` +
      `${s.signals.join(' | ')}\n${s.reason}\n\n` +
      `⚡ ${s.action.toUpperCase()}`;
    await sendTelegramAlert(tgToken, tgChat, msg);
    alertsSent++;
  }

  const breakouts = signals.filter(s => s.category === 'breakout' && s.strength >= 40);
  for (const s of breakouts) {
    const msg = `📈 BREAKOUT\n\n${s.symbol} @ ${formatPrice(s.price)}\n` +
      `24h: ${s.change24h >= 0 ? '+' : ''}${s.change24h}% | Vol: ${s.volumeAnomaly.toFixed(1)}x\n` +
      `Strength: ${s.strength}% | ${s.reason}\n${s.action.toUpperCase()}`;
    await sendTelegramAlert(tgToken, tgChat, msg);
    alertsSent++;
  }

  const strongBuys = signals.filter(s =>
    (s.action === 'strong_buy' || s.action === 'buy') && s.strength >= 60 &&
    s.category !== 'early_gainer' && s.category !== 'breakout'
  );
  for (const s of strongBuys) {
    const msg = `🧠 BRAIN SIGNAL\n\n${s.symbol} — ${s.action.toUpperCase()}\n` +
      `${formatPrice(s.price)} | Str: ${s.strength}% | ${s.category}\n${s.reason}`;
    await sendTelegramAlert(tgToken, tgChat, msg);
    alertsSent++;
  }

  return alertsSent;
}

// === AUTO-TRADING ENGINE ===
function getBybitClient(): RestClientV5 | null {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  const testnet = process.env.BRAINBOT_TESTNET === 'true';
  return new RestClientV5({ key: apiKey, secret: apiSecret, testnet });
}

async function checkAndClosePositions(
  state: TradingState, client: RestClientV5, tgToken: string, tgChat: string,
): Promise<number> {
  let closed = 0;
  const openPositions = state.positions.filter(p => p.status === 'open');
  const config = state.config;

  for (const pos of openPositions) {
    try {
      const tickerRes = await client.getTickers({ category: 'spot', symbol: `${pos.symbol}USDT` });
      if (tickerRes.retCode !== 0 || !tickerRes.result?.list?.[0]) continue;
      const currentPrice = parseFloat((tickerRes.result.list[0] as any).lastPrice || '0');
      if (currentPrice <= 0) continue;

      // Update peak price for trailing stop
      if (!pos.peakPrice || currentPrice > pos.peakPrice) {
        pos.peakPrice = currentPrice;
      }

      const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      let shouldClose = false;
      let closeReason: Position['status'] = 'closed_sl';

      // Profit Lock: move SL to breakeven once gain exceeds threshold
      if (config.profitLockPercent > 0 && pnlPercent >= config.profitLockPercent) {
        // Raise SL to entry price (breakeven) if not already higher
        if (pos.stopLoss < pos.entryPrice) {
          pos.stopLoss = pos.entryPrice;
        }
      }

      // Trailing Stop: SL trails X% below peak price
      if (config.trailingStopPercent > 0 && pos.peakPrice) {
        const trailSL = pos.peakPrice * (1 - config.trailingStopPercent / 100);
        if (trailSL > pos.stopLoss) {
          pos.stopLoss = Math.round(trailSL * 100) / 100;
        }
      }

      // Check Stop Loss
      if (currentPrice <= pos.stopLoss) {
        shouldClose = true;
        closeReason = config.trailingStopPercent > 0 && pnlPercent > 0 ? 'closed_trail' : 'closed_sl';
      }

      // Check Take Profit
      if (currentPrice >= pos.takeProfit) {
        shouldClose = true;
        closeReason = 'closed_tp';
      }

      // Check Max Hold Time
      if (config.maxHoldHours > 0) {
        const holdMs = Date.now() - new Date(pos.entryTime).getTime();
        if (holdMs >= config.maxHoldHours * 3600000) {
          shouldClose = true;
          closeReason = 'closed_time';
        }
      }

      if (shouldClose) {
        const sellResult = await client.submitOrder({
          category: 'spot', symbol: `${pos.symbol}USDT`, side: 'Sell', orderType: 'Market', qty: String(pos.qty),
        });

        const pnl = (currentPrice - pos.entryPrice) * pos.qty;
        pos.status = closeReason;
        pos.closePrice = currentPrice;
        pos.closeTime = new Date().toISOString();
        pos.pnl = Math.round(pnl * 100) / 100;
        pos.pnlPercent = Math.round(pnlPercent * 100) / 100;

        state.positions = state.positions.filter(p => p.id !== pos.id);
        state.history.push(pos);
        state.totalPnl = Math.round((state.totalPnl + pnl) * 100) / 100;
        state.totalTrades++;
        if (pnl >= 0) state.winCount++; else state.lossCount++;

        // Update strategy stats
        const strat = state.strategies.find(s => s.id === pos.strategy);
        if (strat) {
          strat.trades++;
          strat.pnl = Math.round((strat.pnl + pnl) * 100) / 100;
          if (pnl >= 0) strat.wins++; else strat.losses++;
        }
        closed++;

        const labels: Record<string, string> = {
          closed_tp: '🟢 TAKE PROFIT', closed_sl: '🔴 STOP LOSS',
          closed_trail: '🟡 TRAILING STOP', closed_time: '⏰ TIME EXIT',
        };
        const stratName = strat?.name || pos.strategy;
        const msg = `${labels[closeReason] || closeReason}\n\n` +
          `${pos.symbol} | Strategy: ${stratName}\n` +
          `Entry: ${formatPrice(pos.entryPrice)} → Exit: ${formatPrice(currentPrice)}\n` +
          `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)\n` +
          `💰 Total: ${state.totalPnl >= 0 ? '+' : ''}$${state.totalPnl.toFixed(2)} | Win: ${state.totalTrades > 0 ? Math.round((state.winCount / state.totalTrades) * 100) : 0}%`;
        if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, msg);

        try {
          const date = new Date().toISOString().split('T')[0];
          await put(`trades/${date}/auto_${pos.id}.json`, JSON.stringify({
            id: pos.id, source: 'auto-trader', strategy: pos.strategy, timestamp: new Date().toISOString(),
            symbol: pos.symbol + 'USDT', side: 'Sell', qty: String(pos.qty), orderType: 'Market',
            result: sellResult.retCode === 0 ? 'success' : 'failed', retMsg: sellResult.retMsg,
            entryPrice: pos.entryPrice, exitPrice: currentPrice, pnl, pnlPercent, closeReason,
          }), { access: 'public', addRandomSuffix: false });
        } catch {}
      }
    } catch (e: any) {
      console.error(`[AUTO-TRADE] Error checking ${pos.symbol}:`, e.message);
    }
  }
  return closed;
}

async function executeTrades(
  signals: SmartSignal[], state: TradingState, client: RestClientV5, tgToken: string, tgChat: string,
): Promise<number> {
  const config = state.config;
  if (!config.enabled) return 0;

  const enabledStrategies = state.strategies.filter(s => s.enabled).map(s => s.id);
  if (enabledStrategies.length === 0) return 0;

  const openPositions = state.positions.filter(p => p.status === 'open');
  let tradesPlaced = 0;
  const tradedThisRun = new Set<string>(); // prevent same coin traded twice in one run

  for (const sig of signals) {
    if (tradedThisRun.has(sig.symbol)) continue;

    // Evaluate which strategies match this signal
    const matchedStrategies = evaluateStrategies(sig, enabledStrategies);
    if (matchedStrategies.length === 0) continue;

    // Use the first matching strategy (highest priority = first in list)
    const strategyId = matchedStrategies[0];

    // Check max total
    const currentOpen = openPositions.length + tradesPlaced;
    if (currentOpen >= config.maxTotal) break;

    // Check max per coin
    const coinPositions = openPositions.filter(p => p.symbol === sig.symbol).length;
    if (coinPositions >= config.maxPerCoin) continue;

    // Check cooldown
    const lastCooldown = state.cooldowns[sig.symbol];
    if (lastCooldown) {
      const elapsed = Date.now() - new Date(lastCooldown).getTime();
      if (elapsed < config.cooldownHours * 3600000) continue;
    }

    const qty = config.positionSizeUSD / sig.price;
    const qtyStr = qty >= 1 ? qty.toFixed(4) : qty >= 0.01 ? qty.toFixed(6) : qty.toFixed(8);

    try {
      const result = await client.submitOrder({
        category: 'spot', symbol: `${sig.symbol}USDT`, side: 'Buy', orderType: 'Market',
        qty: String(config.positionSizeUSD), marketUnit: 'quoteCoin',
      });

      if (result.retCode !== 0) {
        if (tgToken && tgChat) {
          await sendTelegramAlert(tgToken, tgChat,
            `⚠️ TRADE FAILED | ${sig.symbol} | ${strategyId}\nError: ${result.retMsg}`);
        }
        continue;
      }

      let fillQty = parseFloat(qtyStr);
      let fillPrice = sig.price;
      try {
        await new Promise(r => setTimeout(r, 500));
        const orderRes = await client.getActiveOrders({
          category: 'spot', symbol: `${sig.symbol}USDT`, orderId: result.result?.orderId,
        });
        if (orderRes.retCode === 0 && orderRes.result?.list?.[0]) {
          const order = orderRes.result.list[0] as any;
          if (parseFloat(order.cumExecQty || '0') > 0) {
            fillQty = parseFloat(order.cumExecQty);
            fillPrice = parseFloat(order.avgPrice || order.cumExecValue) / fillQty || sig.price;
          }
        }
      } catch {}

      const posId = `at_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const stopLoss = Math.round(fillPrice * (1 - config.stopLossPercent / 100) * 100) / 100;
      const takeProfit = Math.round(fillPrice * (1 + config.takeProfitPercent / 100) * 100) / 100;

      const stratName = state.strategies.find(s => s.id === strategyId)?.name || strategyId;

      const position: Position = {
        id: posId, symbol: sig.symbol, entryPrice: fillPrice, qty: fillQty,
        usdValue: Math.round(fillPrice * fillQty * 100) / 100,
        entryTime: new Date().toISOString(), orderId: result.result?.orderId || '',
        stopLoss, takeProfit, status: 'open', peakPrice: fillPrice,
        signal: { action: sig.action, strength: sig.strength, category: sig.category, reason: sig.reason },
        strategy: strategyId,
      };

      state.positions.push(position);
      state.cooldowns[sig.symbol] = new Date().toISOString();
      tradedThisRun.add(sig.symbol);
      tradesPlaced++;

      const allStrategiesText = matchedStrategies.length > 1
        ? `\nAll matching: ${matchedStrategies.join(', ')}` : '';
      const msg = `🤖 AUTO-TRADE\n\n✅ BOUGHT ${sig.symbol}\n` +
        `Strategy: ${stratName}\n` +
        `Price: ${formatPrice(fillPrice)} | Qty: ${fillQty}\n` +
        `🔴 SL: ${formatPrice(stopLoss)} (-${config.stopLossPercent}%)\n` +
        `🟢 TP: ${formatPrice(takeProfit)} (+${config.takeProfitPercent}%)` +
        (config.trailingStopPercent > 0 ? `\n📐 Trail: ${config.trailingStopPercent}%` : '') +
        (config.profitLockPercent > 0 ? `\n🔒 Lock @${config.profitLockPercent}%` : '') +
        `\n\nSignal: ${sig.action.toUpperCase()} ${sig.strength}% | ${sig.category}` +
        allStrategiesText +
        `\n📊 Open: ${openPositions.length + tradesPlaced}/${config.maxTotal}`;
      if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, msg);

      try {
        const date = new Date().toISOString().split('T')[0];
        await put(`trades/${date}/auto_buy_${posId}.json`, JSON.stringify({
          id: posId, source: 'auto-trader', strategy: strategyId, timestamp: new Date().toISOString(),
          symbol: sig.symbol + 'USDT', side: 'Buy', qty: String(fillQty), orderType: 'Market',
          result: 'success', retMsg: result.retMsg, orderId: result.result?.orderId,
          price: fillPrice, stopLoss, takeProfit, signal: sig.action, strength: sig.strength,
        }), { access: 'public', addRandomSuffix: false });
      } catch {}

    } catch (e: any) {
      console.error(`[AUTO-TRADE] Error for ${sig.symbol}:`, e.message);
      if (tgToken && tgChat) {
        await sendTelegramAlert(tgToken, tgChat, `⚠️ TRADE ERROR | ${sig.symbol}\n${e.message}`);
      }
    }
  }

  return tradesPlaced;
}

async function emergencyCloseAll(
  state: TradingState, client: RestClientV5, tgToken: string, tgChat: string,
): Promise<{ closed: number; errors: string[] }> {
  const errors: string[] = [];
  let closed = 0;
  const openPositions = state.positions.filter(p => p.status === 'open');

  for (const pos of openPositions) {
    try {
      const tickerRes = await client.getTickers({ category: 'spot', symbol: `${pos.symbol}USDT` });
      const currentPrice = tickerRes.retCode === 0 && tickerRes.result?.list?.[0]
        ? parseFloat((tickerRes.result.list[0] as any).lastPrice || '0') : pos.entryPrice;

      const sellResult = await client.submitOrder({
        category: 'spot', symbol: `${pos.symbol}USDT`, side: 'Sell', orderType: 'Market', qty: String(pos.qty),
      });

      const pnl = (currentPrice - pos.entryPrice) * pos.qty;
      const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      pos.status = 'closed_emergency';
      pos.closePrice = currentPrice;
      pos.closeTime = new Date().toISOString();
      pos.pnl = Math.round(pnl * 100) / 100;
      pos.pnlPercent = Math.round(pnlPercent * 100) / 100;

      state.history.push(pos);
      state.totalPnl = Math.round((state.totalPnl + pnl) * 100) / 100;
      state.totalTrades++;
      if (pnl >= 0) state.winCount++; else state.lossCount++;

      const strat = state.strategies.find(s => s.id === pos.strategy);
      if (strat) { strat.trades++; strat.pnl = Math.round((strat.pnl + pnl) * 100) / 100; if (pnl >= 0) strat.wins++; else strat.losses++; }
      closed++;

      if (sellResult.retCode !== 0) errors.push(`${pos.symbol}: ${sellResult.retMsg}`);
    } catch (e: any) {
      errors.push(`${pos.symbol}: ${e.message}`);
    }
  }

  state.positions = state.positions.filter(p => p.status === 'open');
  state.config.enabled = false;

  if (tgToken && tgChat) {
    await sendTelegramAlert(tgToken, tgChat,
      `🛑 EMERGENCY STOP\n\nClosed ${closed} positions\nTrading DISABLED\n` +
      `Total P&L: ${state.totalPnl >= 0 ? '+' : ''}$${state.totalPnl.toFixed(2)}\n` +
      (errors.length > 0 ? `\n⚠️ Errors:\n${errors.join('\n')}` : ''));
  }

  return { closed, errors };
}

// === DCA ENGINE ===
async function checkAndCloseDcaStacks(
  state: TradingState, client: RestClientV5, tgToken: string, tgChat: string,
): Promise<number> {
  let closed = 0;
  const openStacks = state.dcaStacks.filter(s => s.status === 'open');
  const config = state.config;

  for (const stack of openStacks) {
    try {
      const tickerRes = await client.getTickers({ category: 'spot', symbol: `${stack.symbol}USDT` });
      if (tickerRes.retCode !== 0 || !tickerRes.result?.list?.[0]) continue;
      const currentPrice = parseFloat((tickerRes.result.list[0] as any).lastPrice || '0');
      if (currentPrice <= 0) continue;

      const pnlPercent = ((currentPrice - stack.avgEntryPrice) / stack.avgEntryPrice) * 100;
      let shouldClose = false;
      let closeReason: DcaStack['status'] = 'closed_sl';

      if (currentPrice >= stack.takeProfit) {
        shouldClose = true;
        closeReason = 'closed_tp';
      } else if (currentPrice <= stack.stopLoss) {
        shouldClose = true;
        closeReason = 'closed_sl';
      }

      if (shouldClose) {
        const sellResult = await client.submitOrder({
          category: 'spot', symbol: `${stack.symbol}USDT`, side: 'Sell', orderType: 'Market', qty: String(stack.totalQty),
        });

        const pnl = (currentPrice - stack.avgEntryPrice) * stack.totalQty;
        stack.status = closeReason;
        stack.closePrice = currentPrice;
        stack.closeTime = new Date().toISOString();
        stack.pnl = Math.round(pnl * 100) / 100;
        stack.pnlPercent = Math.round(pnlPercent * 100) / 100;

        state.dcaStacks = state.dcaStacks.filter(s => s.id !== stack.id);
        state.dcaHistory.push(stack);
        state.totalPnl = Math.round((state.totalPnl + pnl) * 100) / 100;
        state.totalTrades++;
        if (pnl >= 0) state.winCount++; else state.lossCount++;

        const strat = state.strategies.find(s => s.id === 'dca_accumulator');
        if (strat) {
          strat.trades++;
          strat.pnl = Math.round((strat.pnl + pnl) * 100) / 100;
          if (pnl >= 0) strat.wins++; else strat.losses++;
        }
        closed++;

        const labels: Record<string, string> = { closed_tp: '🟢 DCA TAKE PROFIT', closed_sl: '🔴 DCA STOP LOSS' };
        const msg = `${labels[closeReason] || closeReason}\n\n` +
          `${stack.symbol} | DCA Stack (${stack.entries.length} buys)\n` +
          `Avg Entry: ${formatPrice(stack.avgEntryPrice)} → Exit: ${formatPrice(currentPrice)}\n` +
          `Invested: $${stack.totalInvested.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)\n` +
          `💰 Total: ${state.totalPnl >= 0 ? '+' : ''}$${state.totalPnl.toFixed(2)}`;
        if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, msg);

        try {
          const date = new Date().toISOString().split('T')[0];
          await put(`trades/${date}/dca_close_${stack.id}.json`, JSON.stringify({
            id: stack.id, source: 'dca-engine', strategy: 'dca_accumulator',
            timestamp: new Date().toISOString(), symbol: stack.symbol + 'USDT',
            side: 'Sell', qty: String(stack.totalQty), orderType: 'Market',
            result: sellResult.retCode === 0 ? 'success' : 'failed', retMsg: sellResult.retMsg,
            avgEntryPrice: stack.avgEntryPrice, exitPrice: currentPrice, pnl, pnlPercent,
            orders: stack.entries.length, closeReason,
          }), { access: 'public', addRandomSuffix: false });
        } catch {}
      }
    } catch (e: any) {
      console.error(`[DCA] Error checking stack ${stack.symbol}:`, e.message);
    }
  }
  return closed;
}

function isDcaEligible(sig: SmartSignal): boolean {
  // Not overbought, experiencing a dip, volume not dead
  return (
    sig.rsi >= 25 && sig.rsi <= 60 &&
    sig.change24h <= 2 &&
    sig.change24h >= -30 &&
    sig.volumeAnomaly >= 0.5 &&
    sig.price < sig.ema21  // price below short-term EMA = dip
  );
}

async function executeDcaTrades(
  signals: SmartSignal[], state: TradingState, client: RestClientV5, tgToken: string, tgChat: string,
): Promise<number> {
  const config = state.config;
  if (!config.dcaEnabled) return 0;

  const dcaStratEnabled = state.strategies.find(s => s.id === 'dca_accumulator')?.enabled;
  if (!dcaStratEnabled) return 0;

  let tradesPlaced = 0;

  for (const sig of signals) {
    // Coin whitelist check
    if (config.dcaCoins.length > 0 && !config.dcaCoins.includes(sig.symbol)) continue;

    // DCA eligibility check
    if (!isDcaEligible(sig)) continue;

    const existingStack = state.dcaStacks.find(s => s.symbol === sig.symbol && s.status === 'open');

    if (existingStack) {
      // Check if price has dropped enough from last entry to add another buy
      const lastEntry = existingStack.entries[existingStack.entries.length - 1];
      const dropFromLast = ((lastEntry.price - sig.price) / lastEntry.price) * 100;
      if (dropFromLast < config.dcaTriggerDropPercent) continue;

      // Check max orders
      if (existingStack.entries.length >= config.dcaMaxOrders) continue;

      // Place additional DCA buy
      try {
        const result = await client.submitOrder({
          category: 'spot', symbol: `${sig.symbol}USDT`, side: 'Buy', orderType: 'Market',
          qty: String(config.dcaOrderSizeUSD), marketUnit: 'quoteCoin',
        });
        if (result.retCode !== 0) {
          if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, `⚠️ DCA BUY FAILED | ${sig.symbol}\n${result.retMsg}`);
          continue;
        }

        await new Promise(r => setTimeout(r, 500));
        let fillQty = config.dcaOrderSizeUSD / sig.price;
        let fillPrice = sig.price;
        try {
          const orderRes = await client.getActiveOrders({ category: 'spot', symbol: `${sig.symbol}USDT`, orderId: result.result?.orderId });
          if (orderRes.retCode === 0 && orderRes.result?.list?.[0]) {
            const order = orderRes.result.list[0] as any;
            if (parseFloat(order.cumExecQty || '0') > 0) {
              fillQty = parseFloat(order.cumExecQty);
              fillPrice = parseFloat(order.avgPrice || order.cumExecValue) / fillQty || sig.price;
            }
          }
        } catch {}

        existingStack.entries.push({ price: fillPrice, qty: fillQty, usdValue: fillPrice * fillQty, time: new Date().toISOString(), orderId: result.result?.orderId || '' });
        existingStack.totalQty = Math.round((existingStack.totalQty + fillQty) * 1e8) / 1e8;
        existingStack.totalInvested = Math.round((existingStack.totalInvested + fillPrice * fillQty) * 100) / 100;
        existingStack.avgEntryPrice = Math.round((existingStack.totalInvested / existingStack.totalQty) * 100) / 100;
        existingStack.takeProfit = Math.round(existingStack.avgEntryPrice * (1 + config.dcaTakeProfitPercent / 100) * 100) / 100;
        existingStack.stopLoss = Math.round(existingStack.avgEntryPrice * (1 - config.dcaStopLossPercent / 100) * 100) / 100;
        tradesPlaced++;

        const msg = `📉 DCA ADD #${existingStack.entries.length} | ${sig.symbol}\n` +
          `Price: ${formatPrice(fillPrice)} | Drop: -${dropFromLast.toFixed(1)}% from last\n` +
          `Avg Entry: ${formatPrice(existingStack.avgEntryPrice)} | Total: $${existingStack.totalInvested.toFixed(2)}\n` +
          `🟢 TP: ${formatPrice(existingStack.takeProfit)} (+${config.dcaTakeProfitPercent}%)\n` +
          `🔴 SL: ${formatPrice(existingStack.stopLoss)} (-${config.dcaStopLossPercent}%)\n` +
          `Orders: ${existingStack.entries.length}/${config.dcaMaxOrders}`;
        if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, msg);
      } catch (e: any) {
        console.error(`[DCA] Error adding to stack ${sig.symbol}:`, e.message);
      }

    } else {
      // New DCA stack — check total open stack limit (share maxTotal with regular positions)
      const totalOpen = state.positions.filter(p => p.status === 'open').length + state.dcaStacks.filter(s => s.status === 'open').length;
      if (totalOpen >= config.maxTotal) continue;

      // Check cooldown
      const lastCooldown = state.cooldowns[sig.symbol];
      if (lastCooldown) {
        const elapsed = Date.now() - new Date(lastCooldown).getTime();
        if (elapsed < config.cooldownHours * 3600000) continue;
      }

      // Open first DCA buy
      try {
        const result = await client.submitOrder({
          category: 'spot', symbol: `${sig.symbol}USDT`, side: 'Buy', orderType: 'Market',
          qty: String(config.dcaOrderSizeUSD), marketUnit: 'quoteCoin',
        });
        if (result.retCode !== 0) {
          if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, `⚠️ DCA BUY FAILED | ${sig.symbol}\n${result.retMsg}`);
          continue;
        }

        await new Promise(r => setTimeout(r, 500));
        let fillQty = config.dcaOrderSizeUSD / sig.price;
        let fillPrice = sig.price;
        try {
          const orderRes = await client.getActiveOrders({ category: 'spot', symbol: `${sig.symbol}USDT`, orderId: result.result?.orderId });
          if (orderRes.retCode === 0 && orderRes.result?.list?.[0]) {
            const order = orderRes.result.list[0] as any;
            if (parseFloat(order.cumExecQty || '0') > 0) {
              fillQty = parseFloat(order.cumExecQty);
              fillPrice = parseFloat(order.avgPrice || order.cumExecValue) / fillQty || sig.price;
            }
          }
        } catch {}

        const stackId = `dca_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const tp = Math.round(fillPrice * (1 + config.dcaTakeProfitPercent / 100) * 100) / 100;
        const sl = Math.round(fillPrice * (1 - config.dcaStopLossPercent / 100) * 100) / 100;

        const newStack: DcaStack = {
          id: stackId,
          symbol: sig.symbol,
          entries: [{ price: fillPrice, qty: fillQty, usdValue: fillPrice * fillQty, time: new Date().toISOString(), orderId: result.result?.orderId || '' }],
          avgEntryPrice: fillPrice,
          totalQty: fillQty,
          totalInvested: Math.round(fillPrice * fillQty * 100) / 100,
          stopLoss: sl,
          takeProfit: tp,
          status: 'open',
          openTime: new Date().toISOString(),
        };

        state.dcaStacks.push(newStack);
        state.cooldowns[sig.symbol] = new Date().toISOString();
        tradesPlaced++;

        const msg = `🤖 DCA STARTED | ${sig.symbol}\n` +
          `Entry #1: ${formatPrice(fillPrice)} | $${(fillPrice * fillQty).toFixed(2)}\n` +
          `RSI: ${sig.rsi.toFixed(0)} | 24h: ${sig.change24h >= 0 ? '+' : ''}${sig.change24h}%\n` +
          `🟢 TP: ${formatPrice(tp)} (+${config.dcaTakeProfitPercent}%)\n` +
          `🔴 SL: ${formatPrice(sl)} (-${config.dcaStopLossPercent}%)\n` +
          `Next buy if -${config.dcaTriggerDropPercent}% | Max ${config.dcaMaxOrders} orders`;
        if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, msg);

        try {
          const date = new Date().toISOString().split('T')[0];
          await put(`trades/${date}/dca_open_${stackId}.json`, JSON.stringify({
            id: stackId, source: 'dca-engine', strategy: 'dca_accumulator',
            timestamp: new Date().toISOString(), symbol: sig.symbol + 'USDT',
            side: 'Buy', qty: String(fillQty), orderType: 'Market', result: 'success',
            price: fillPrice, takeProfit: tp, stopLoss: sl,
          }), { access: 'public', addRandomSuffix: false });
        } catch {}
      } catch (e: any) {
        console.error(`[DCA] Error opening stack ${sig.symbol}:`, e.message);
      }
    }
  }

  return tradesPlaced;
}

// === MAIN HANDLER ===
export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = req.query?.action;

    // === CONFIG & STRATEGY MANAGEMENT ===
    if (action === 'getConfig') {
      const state = await loadState();
      return res.status(200).json({
        success: true,
        config: state.config,
        strategies: state.strategies,
        stats: {
          openPositions: state.positions.filter(p => p.status === 'open').length,
          totalTrades: state.totalTrades,
          totalPnl: state.totalPnl,
          winCount: state.winCount,
          lossCount: state.lossCount,
          winRate: state.totalTrades > 0 ? Math.round((state.winCount / state.totalTrades) * 100) : 0,
        },
      });
    }

    if (action === 'setConfig' && req.method === 'POST') {
      const state = await loadState();
      const body = req.body || {};
      const nc = body;
      if (typeof nc.enabled === 'boolean') state.config.enabled = nc.enabled;
      if (typeof nc.positionSizeUSD === 'number') state.config.positionSizeUSD = nc.positionSizeUSD;
      if (typeof nc.stopLossPercent === 'number') state.config.stopLossPercent = nc.stopLossPercent;
      if (typeof nc.takeProfitPercent === 'number') state.config.takeProfitPercent = nc.takeProfitPercent;
      if (typeof nc.cooldownHours === 'number') state.config.cooldownHours = nc.cooldownHours;
      if (typeof nc.maxPerCoin === 'number') state.config.maxPerCoin = nc.maxPerCoin;
      if (typeof nc.maxTotal === 'number') state.config.maxTotal = nc.maxTotal;
      if (Array.isArray(nc.triggerActions)) state.config.triggerActions = nc.triggerActions;
      if (typeof nc.minStrength === 'number') state.config.minStrength = nc.minStrength;
      if (typeof nc.trailingStopPercent === 'number') state.config.trailingStopPercent = nc.trailingStopPercent;
      if (typeof nc.profitLockPercent === 'number') state.config.profitLockPercent = nc.profitLockPercent;
      if (typeof nc.maxHoldHours === 'number') state.config.maxHoldHours = nc.maxHoldHours;
      if (typeof nc.dcaEnabled === 'boolean') state.config.dcaEnabled = nc.dcaEnabled;
      if (typeof nc.dcaOrderSizeUSD === 'number') state.config.dcaOrderSizeUSD = nc.dcaOrderSizeUSD;
      if (typeof nc.dcaMaxOrders === 'number') state.config.dcaMaxOrders = nc.dcaMaxOrders;
      if (typeof nc.dcaTriggerDropPercent === 'number') state.config.dcaTriggerDropPercent = nc.dcaTriggerDropPercent;
      if (typeof nc.dcaTakeProfitPercent === 'number') state.config.dcaTakeProfitPercent = nc.dcaTakeProfitPercent;
      if (typeof nc.dcaStopLossPercent === 'number') state.config.dcaStopLossPercent = nc.dcaStopLossPercent;
      if (Array.isArray(nc.dcaCoins)) state.config.dcaCoins = nc.dcaCoins;

      // Update strategy toggles
      if (Array.isArray(nc.strategies)) {
        for (const s of nc.strategies) {
          const existing = state.strategies.find(ex => ex.id === s.id);
          if (existing && typeof s.enabled === 'boolean') {
            existing.enabled = s.enabled;
          }
        }
      }

      await saveState(state);
      return res.status(200).json({ success: true, config: state.config, strategies: state.strategies });
    }

    if (action === 'getPositions') {
      const state = await loadState();
      const client = getBybitClient();
      const openPositions = state.positions.filter(p => p.status === 'open');

      const enriched = [];
      for (const pos of openPositions) {
        let currentPrice = pos.entryPrice;
        let pnl = 0;
        let pnlPercent = 0;
        try {
          if (client) {
            const tickerRes = await client.getTickers({ category: 'spot', symbol: `${pos.symbol}USDT` });
            if (tickerRes.retCode === 0 && tickerRes.result?.list?.[0]) {
              currentPrice = parseFloat((tickerRes.result.list[0] as any).lastPrice || '0');
            }
          }
          pnl = Math.round((currentPrice - pos.entryPrice) * pos.qty * 100) / 100;
          pnlPercent = Math.round(((currentPrice - pos.entryPrice) / pos.entryPrice) * 10000) / 100;
        } catch {}
        enriched.push({ ...pos, currentPrice, pnl, pnlPercent });
      }

      // Enrich open DCA stacks with live price
      const enrichedDca = [];
      for (const stack of state.dcaStacks.filter(s => s.status === 'open')) {
        let currentPrice = stack.avgEntryPrice;
        let pnl = 0;
        let pnlPercent = 0;
        try {
          if (client) {
            const tickerRes = await client.getTickers({ category: 'spot', symbol: `${stack.symbol}USDT` });
            if (tickerRes.retCode === 0 && tickerRes.result?.list?.[0]) {
              currentPrice = parseFloat((tickerRes.result.list[0] as any).lastPrice || '0');
            }
          }
          pnl = Math.round((currentPrice - stack.avgEntryPrice) * stack.totalQty * 100) / 100;
          pnlPercent = Math.round(((currentPrice - stack.avgEntryPrice) / stack.avgEntryPrice) * 10000) / 100;
        } catch {}
        enrichedDca.push({ ...stack, currentPrice, pnl, pnlPercent });
      }

      return res.status(200).json({
        success: true,
        positions: enriched,
        history: state.history.slice(-50).reverse(),
        strategies: state.strategies,
        dcaStacks: enrichedDca,
        dcaHistory: state.dcaHistory.slice(-50).reverse(),
        stats: {
          openPositions: enriched.length,
          openDcaStacks: enrichedDca.length,
          totalTrades: state.totalTrades,
          totalPnl: state.totalPnl,
          winCount: state.winCount,
          lossCount: state.lossCount,
          winRate: state.totalTrades > 0 ? Math.round((state.winCount / state.totalTrades) * 100) : 0,
          unrealizedPnl: enriched.reduce((sum, p) => sum + p.pnl, 0) + enrichedDca.reduce((sum, s) => sum + s.pnl, 0),
        },
      });
    }

    if (action === 'closePosition' && req.method === 'POST') {
      const { positionId } = req.body || {};
      if (!positionId) return res.status(400).json({ error: 'Missing positionId' });

      const state = await loadState();
      const pos = state.positions.find(p => p.id === positionId && p.status === 'open');
      if (!pos) return res.status(404).json({ error: 'Position not found' });

      const client = getBybitClient();
      if (!client) return res.status(500).json({ error: 'Bybit not configured' });

      const tgToken = process.env.TELEGRAM_BOT_TOKEN || '';
      const tgChat = process.env.TELEGRAM_CHAT_ID || '';

      let currentPrice = pos.entryPrice;
      try {
        const tickerRes = await client.getTickers({ category: 'spot', symbol: `${pos.symbol}USDT` });
        if (tickerRes.retCode === 0 && tickerRes.result?.list?.[0])
          currentPrice = parseFloat((tickerRes.result.list[0] as any).lastPrice || '0');
      } catch {}

      const sellResult = await client.submitOrder({
        category: 'spot', symbol: `${pos.symbol}USDT`, side: 'Sell', orderType: 'Market', qty: String(pos.qty),
      });

      const pnl = (currentPrice - pos.entryPrice) * pos.qty;
      const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      pos.status = 'closed_manual';
      pos.closePrice = currentPrice;
      pos.closeTime = new Date().toISOString();
      pos.pnl = Math.round(pnl * 100) / 100;
      pos.pnlPercent = Math.round(pnlPercent * 100) / 100;

      state.positions = state.positions.filter(p => p.id !== positionId);
      state.history.push(pos);
      state.totalPnl = Math.round((state.totalPnl + pnl) * 100) / 100;
      state.totalTrades++;
      if (pnl >= 0) state.winCount++; else state.lossCount++;

      const strat = state.strategies.find(s => s.id === pos.strategy);
      if (strat) { strat.trades++; strat.pnl = Math.round((strat.pnl + pnl) * 100) / 100; if (pnl >= 0) strat.wins++; else strat.losses++; }

      await saveState(state);

      if (tgToken && tgChat) {
        await sendTelegramAlert(tgToken, tgChat,
          `📤 MANUAL CLOSE | ${pos.symbol}\n${formatPrice(pos.entryPrice)} → ${formatPrice(currentPrice)}\nP&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
      }

      return res.status(200).json({ success: true, position: pos });
    }

    if (action === 'emergencyStop' && req.method === 'POST') {
      const state = await loadState();
      const client = getBybitClient();
      if (!client) return res.status(500).json({ error: 'Bybit not configured' });
      const tgToken = process.env.TELEGRAM_BOT_TOKEN || '';
      const tgChat = process.env.TELEGRAM_CHAT_ID || '';
      const result = await emergencyCloseAll(state, client, tgToken, tgChat);
      await saveState(state);
      return res.status(200).json({ success: true, ...result });
    }

    // === SCANNER MODE (default) ===
    const isAlertMode = req.query?.alert === '1';
    if (isAlertMode) {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        const auth = req.headers?.authorization;
        if (auth !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const customCoins = req.body?.coins || req.query?.coins;
    const coinList: string[] = customCoins
      ? (typeof customCoins === 'string' ? customCoins.split(',').map((s: string) => s.trim().toUpperCase()) : customCoins)
      : TOP_COINS;

    const batchSize = 8;
    const allSignals: SmartSignal[] = [];

    for (let i = 0; i < coinList.length; i += batchSize) {
      const batch = coinList.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(s => scanCoin(s)));
      results.forEach(r => { if (r) allSignals.push(r); });
      if (i + batchSize < coinList.length) await new Promise(r => setTimeout(r, 250));
    }

    allSignals.sort((a, b) => b.strength - a.strength);

    let alertsSent = 0;
    let tradesPlaced = 0;
    let positionsClosed = 0;

    if (isAlertMode) {
      const tgToken = process.env.TELEGRAM_BOT_TOKEN || '';
      const tgChat = process.env.TELEGRAM_CHAT_ID || '';

      if (tgToken && tgChat && allSignals.length > 0) {
        alertsSent = await sendSignalAlerts(allSignals, tgToken, tgChat);
      }

      const client = getBybitClient();
      if (client) {
        const state = await loadState();
        positionsClosed = await checkAndClosePositions(state, client, tgToken, tgChat);
        positionsClosed += await checkAndCloseDcaStacks(state, client, tgToken, tgChat);
        if (state.config.enabled) {
          tradesPlaced = await executeTrades(allSignals, state, client, tgToken, tgChat);
          tradesPlaced += await executeDcaTrades(allSignals, state, client, tgToken, tgChat);
        }
        await saveState(state);
      }

      // Periodic summary
      const hour = new Date().getUTCHours();
      const minute = new Date().getUTCMinutes();
      if (tgToken && tgChat && minute < 10 && (hour === 0 || hour === 6 || hour === 12 || hour === 18)) {
        const state = await loadState();
        const openPos = state.positions.filter(p => p.status === 'open');
        const openDca = state.dcaStacks.filter(s => s.status === 'open');
        const enabledStrats = state.strategies.filter(s => s.enabled).map(s => s.name).join(', ');
        const topCoins = allSignals.slice(0, 5).map(s => `  • ${s.symbol}: ${s.action} (${s.strength}%)`).join('\n');

        const summary = `📊 BRAIN SCANNER — ${hour}:00 UTC\n\n` +
          `Scanned: ${coinList.length} | Signals: ${allSignals.length}\n` +
          `Top 5:\n${topCoins || '  None'}\n\n` +
          `🤖 Bot: ${state.config.enabled ? 'ON' : 'OFF'} | Pos: ${openPos.length}/${state.config.maxTotal}` +
          (state.config.dcaEnabled ? ` | DCA: ${openDca.length} stacks` : '') + '\n' +
          `Strategies: ${enabledStrats || 'None'}\n` +
          `P&L: ${state.totalPnl >= 0 ? '+' : ''}$${state.totalPnl.toFixed(2)} | Win: ${state.totalTrades > 0 ? Math.round((state.winCount / state.totalTrades) * 100) : 0}% (${state.totalTrades})`;
        await sendTelegramAlert(tgToken, tgChat, summary);
      }
    }

    const earlyGainers = allSignals.filter(s => s.category === 'early_gainer');
    const breakouts = allSignals.filter(s => s.category === 'breakout');
    const reversals = allSignals.filter(s => s.category === 'reversal');
    const accumulations = allSignals.filter(s => s.category === 'accumulation');

    return res.status(200).json({
      success: true,
      scanned: coinList.length,
      found: allSignals.length,
      timestamp: Date.now(),
      alertsSent, tradesPlaced, positionsClosed,
      summary: {
        earlyGainers: earlyGainers.length,
        breakouts: breakouts.length,
        reversals: reversals.length,
        accumulations: accumulations.length,
        strongBuys: allSignals.filter(s => s.action === 'strong_buy').length,
        buys: allSignals.filter(s => s.action === 'buy').length,
        sells: allSignals.filter(s => s.action === 'sell' || s.action === 'strong_sell').length,
      },
      signals: allSignals,
    });
  } catch (err: any) {
    console.error('Smart Scanner error:', err.message);
    return res.status(500).json({ error: err.message || 'Scanner error' });
  }
}
