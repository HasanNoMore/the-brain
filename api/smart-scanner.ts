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
import { list, del, put } from '@vercel/blob';

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

type MarketRegime = 'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear';

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
  rsi1h: number;              // hourly RSI for MTF
  strength: number;
  signals: string[];
  category: 'early_gainer' | 'breakout' | 'reversal' | 'accumulation' | 'momentum' | 'divergence' | 'squeeze' | 'watch';
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
  // Advanced indicators
  atrPercent: number;
  obvTrend: number;
  obvBreakout: boolean;
  cmf: number;
  stochRsi: number;
  supertrendBullish: boolean;
  supertrendFlip: boolean;
  bullDivergence: boolean;
  bbSqueeze: boolean;
  bbSqueezeRelease: boolean;
  vwap: number;
  mtfConfluent: boolean;
  // Daily timeframe (Mega Scanner V2)
  dailyRsi: number;            // RSI on daily closes — macro context
  dailyTrend: 'up' | 'down' | 'sideways';  // EMA7 vs EMA21 on daily
  dailySupport: number;        // 30-day low
  dailyResistance: number;     // 30-day high
  change7d: number;            // 7-day price change %
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
  // === CORE STRATEGIES ===
  { id: 'scanner_signal',   name: 'Scanner Signal',      description: 'Multi-indicator BUY/STRONG_BUY with multi-timeframe confirmation — the core brain signal' },
  { id: 'rsi_reversal',     name: 'RSI Reversal',        description: 'Oversold bounce — RSI < 35 with hourly RSI recovering + StochRSI confirmation' },
  { id: 'bollinger_bounce', name: 'Bollinger Bounce',    description: 'Mean reversion at lower Bollinger Band — statistical edge when price hits 2 std devs below' },
  { id: 'dip_buyer',        name: 'Dip Buyer',           description: 'Catches 3%+ dips with volume confirmation — falling knife catcher with RSI safety net' },
  { id: 'early_gainer',     name: 'Early Gainer',        description: 'Hourly volume surge (2x+) with positive price action — catches moves before they explode' },
  { id: 'dca_accumulator',  name: 'DCA Accumulator',     description: 'Dollar Cost Averaging — buys dips at set intervals, stacks into position, exits at avg-price profit target' },
  // === PRO STRATEGIES ===
  { id: 'divergence_play',  name: 'Divergence Play',     description: 'RSI bullish divergence — price makes lower low but RSI makes higher low: highest conviction reversal signal' },
  { id: 'supertrend_ride',  name: 'Supertrend Ride',     description: 'ATR-based trend flip detection — buys when Supertrend flips from bearish to bullish with momentum' },
  { id: 'smart_money',      name: 'Smart Money',         description: 'OBV breakout + positive money flow (CMF) — detects institutional accumulation while retail panics' },
  // === ADVANCED STRATEGIES ===
  { id: 'vwap_reclaim',     name: 'VWAP Reclaim',        description: 'Price reclaims 24h VWAP with volume — institutional re-entry signal after a shakeout' },
  { id: 'panic_reversal',   name: 'Panic Reversal',      description: 'Extreme hourly drop (-3%+) with capitulation volume + deep oversold RSI — buys the forced-seller exhaustion' },
];

// ============================================================
// ADAPTIVE STRATEGY ENGINE
// Thresholds auto-adjust based on market regime — no manual tuning needed
// Bear market: looser filters to catch real oversold opportunities
// Bull market: tighter filters to avoid chasing
// ============================================================
function getAdaptiveThresholds(regime: MarketRegime) {
  const t = {
    // Scanner signal min strength
    scannerStrength:    regime === 'strong_bull' ? 55 : regime === 'bull' ? 50 : 35,
    // RSI oversold threshold
    rsiOversold:        regime === 'strong_bear' ? 45 : regime === 'bear' ? 42 : 35,
    // Dip buyer: min 24h drop %
    dipPercent:         regime === 'strong_bear' ? -2.5 : regime === 'bear' ? -3 : -5,
    // Dip buyer: min volume
    dipVolume:          regime === 'strong_bear' ? 0.3 : regime === 'bear' ? 0.5 : 1.0,
    // Dip buyer: max RSI
    dipRsi:             regime === 'strong_bear' ? 50 : regime === 'bear' ? 47 : 40,
    // Early gainer vol spike
    earlyGainerVol:     regime === 'strong_bear' ? 1.5 : regime === 'bear' ? 2.0 : 3.0,
    // Bollinger RSI max
    bbRsi:              regime === 'strong_bear' ? 52 : regime === 'bear' ? 48 : 42,
    // Panic reversal 1h drop threshold
    panicDrop:          regime === 'strong_bear' ? -2.0 : -3.0,
    panicRsi:           regime === 'strong_bear' ? 30 : 25,
    panicVol:           regime === 'strong_bear' ? 1.2 : 1.8,
  };
  return t;
}

// Current regime — set by executeTrades before strategy evaluation
let _currentRegime: MarketRegime = 'neutral';

function evaluateStrategies(sig: SmartSignal, enabledStrategies: string[]): string[] {
  const matched: string[] = [];
  const T = getAdaptiveThresholds(_currentRegime);

  // 1. Scanner Signal — auto-adapts strength threshold by regime
  if (enabledStrategies.includes('scanner_signal')) {
    if ((sig.action === 'buy' || sig.action === 'strong_buy') && sig.strength >= T.scannerStrength) {
      matched.push('scanner_signal');
    }
  }

  // 2. RSI Reversal — auto-adapts RSI threshold by regime
  if (enabledStrategies.includes('rsi_reversal')) {
    if (sig.rsi < T.rsiOversold && (sig.signals.includes('RSI REVERSAL') || sig.stochRsi < 25) && sig.change1h > -8) {
      matched.push('rsi_reversal');
    }
  }

  // 3. Bollinger Bounce — auto-adapts RSI threshold
  if (enabledStrategies.includes('bollinger_bounce')) {
    if (sig.price <= sig.bollingerLower * 1.015 && sig.rsi < T.bbRsi && sig.momentum > -50) {
      matched.push('bollinger_bounce');
    }
  }

  // 4. Dip Buyer — fully adaptive: drop%, volume, RSI all adjust to regime
  if (enabledStrategies.includes('dip_buyer')) {
    if (sig.change24h <= T.dipPercent && sig.volumeAnomaly >= T.dipVolume && sig.rsi < T.dipRsi) {
      matched.push('dip_buyer');
    }
  }

  // 5. Early Gainer — volume spike threshold auto-adjusts
  if (enabledStrategies.includes('early_gainer')) {
    if (sig.hourlyVolSpike >= T.earlyGainerVol && sig.change1h > 0.2 && sig.rsi < 72) {
      matched.push('early_gainer');
    }
  }

  // 6. Divergence Play — RSI bullish divergence
  if (enabledStrategies.includes('divergence_play')) {
    if (sig.bullDivergence && sig.rsi < 60 && sig.momentum > -50) {
      matched.push('divergence_play');
    }
  }

  // 7. Supertrend Ride — ATR-based trend flip
  if (enabledStrategies.includes('supertrend_ride')) {
    if (sig.supertrendFlip && sig.momentum > -10 && sig.rsi < 70) {
      matched.push('supertrend_ride');
    }
  }

  // 8. Smart Money — institutional accumulation
  if (enabledStrategies.includes('smart_money')) {
    if (sig.obvBreakout && sig.cmf > 0.03 && sig.rsi < 70 && sig.momentum > -20) {
      matched.push('smart_money');
    }
  }

  // 9. VWAP Reclaim
  if (enabledStrategies.includes('vwap_reclaim')) {
    if (sig.vwap > 0 && sig.price > sig.vwap && sig.price < sig.vwap * 1.02 &&
        sig.volumeAnomaly >= 0.8 && sig.rsi > 30 && sig.rsi < 68) {
      matched.push('vwap_reclaim');
    }
  }

  // 10. Panic Reversal — fully adaptive thresholds
  if (enabledStrategies.includes('panic_reversal')) {
    if (sig.change1h <= T.panicDrop && sig.rsi < T.panicRsi && sig.volumeAnomaly >= T.panicVol && sig.stochRsi < 20) {
      matched.push('panic_reversal');
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
  // Partial Take Profit
  tp1Percent: number;       // First TP level % above entry (0 = disabled)
  tp1SizePercent: number;   // % of position to sell at TP1 (e.g. 50)
  // Trade filters
  minConfidence: number;    // Skip signals with confidence below this (0 = disabled)
  maxDrawdownUSD: number;   // Auto-disable bot if totalPnl <= -this (0 = disabled)
  // DCA (Dollar Cost Averaging)
  dcaEnabled: boolean;
  dcaOrderSizeUSD: number;          // Size of each individual DCA buy
  dcaMaxOrders: number;             // Max buys per coin stack
  dcaTriggerDropPercent: number;    // % price drop from last entry to add more
  dcaTakeProfitPercent: number;     // % above avg entry to close in profit
  dcaStopLossPercent: number;       // % below avg entry to cut loss
  dcaCoins: string[];               // Whitelisted coins for DCA (empty = any scanned coin)
  // AI Brain
  aiBrainEnabled: boolean;           // Claude AI reviews each trade signal before execution
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
  status: 'open' | 'closed_tp' | 'closed_sl' | 'closed_manual' | 'closed_emergency' | 'closed_trail' | 'closed_time' | 'closed_signal';
  closePrice?: number;
  closeTime?: string;
  pnl?: number;
  pnlPercent?: number;
  signal: { action: string; strength: number; category: string; reason: string };
  strategy: string;  // which strategy triggered this trade
  peakPrice?: number;  // highest price since entry (for trailing stop)
  tp1?: number;        // TP1 price level (set at entry if tp1Percent > 0)
  tp1Hit?: boolean;    // Whether TP1 partial sell already executed
}

interface DailyPick {
  date: string;
  regime: MarketRegime;
  tracked?: boolean;
  avgReturn?: number;
  picks: Array<{
    symbol: string; price: number; compositeScore: number;
    technicalScore: number; sentimentScore: number;
    moneyFlowScore: number; riskScore: number;
    action: string; strength: number; rsi: number; reason: string;
    aiScore?: number; aiReason?: string;
    returnPercent?: number; currentPrice?: number;
  }>;
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
  alertTimes?: Record<string, number>;
  dailyPicks?: DailyPick[];
}



const DEFAULT_CONFIG: TradingConfig = {
  enabled: true,
  positionSizeUSD: 30,          // $30 per trade
  stopLossPercent: 3.5,         // tight SL — preserve capital
  takeProfitPercent: 12,        // 1:2.37 R:R ratio
  cooldownHours: 24,            // max 1 trade per coin per day
  maxPerCoin: 1,                // 1 position per coin at a time
  maxTotal: 8,                  // 8 × $30 = $240 max exposure
  triggerActions: ['buy', 'strong_buy'],
  minStrength: 50,              // reject weak signals
  trailingStopPercent: 2.5,     // trail SL 2.5% below peak
  profitLockPercent: 4,         // move SL to breakeven after 4% gain
  maxHoldHours: 72,             // max 3 days hold — no bag holding
  tp1Percent: 5,                // sell 50% at +5% to lock partial profit
  tp1SizePercent: 50,           // sell 50% at TP1
  minConfidence: 55,            // reject low-confidence signals
  maxDrawdownUSD: 80,           // auto-disable bot if down $80 total
  dcaEnabled: false,
  dcaOrderSizeUSD: 30,          // $30 per DCA order
  dcaMaxOrders: 3,              // 3 entries max per DCA stack
  dcaTriggerDropPercent: 5,     // wait for 5% dip before adding
  dcaTakeProfitPercent: 8,
  dcaStopLossPercent: 10,       // tighter DCA SL
  dcaCoins: [],
  aiBrainEnabled: false,        // AI Brain OFF by default
};

// Sniper strategy set: only high-quality, multi-condition strategies ON by default
const DEFAULT_ENABLED_STRATEGIES = new Set([
  'scanner_signal',    // Core multi-indicator — must-have
  'rsi_reversal',      // Oversold bounce — key bear market strategy
  'bollinger_bounce',  // Mean reversion at lower band
  'dip_buyer',         // Catches 3%+ dips with volume
  'early_gainer',      // Hourly vol surge — catches early moves
  'divergence_play',   // Highest conviction reversal signal
  'smart_money',       // Institutional accumulation detection
  'vwap_reclaim',      // Institutional re-entry after shakeout
  'panic_reversal',    // Capitulation exhaustion — best bear market signal
]);

function getDefaultStrategies(): Strategy[] {
  return STRATEGY_DEFINITIONS.map(d => ({
    ...d,
    enabled: DEFAULT_ENABLED_STRATEGIES.has(d.id),
    trades: 0, wins: 0, losses: 0, pnl: 0,
  }));
}

// === UPSTASH REDIS STATE MANAGEMENT ===
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY = 'trading-state';

async function loadState(): Promise<TradingState> {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${REDIS_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (r.ok) {
      const { result } = await r.json() as { result: string | TradingState | null };
      if (result) {
        let parsed: any = typeof result === 'string' ? JSON.parse(result) : result;
        if (typeof parsed === 'string') parsed = JSON.parse(parsed); // handle legacy double-encoded
        const state: TradingState = parsed as TradingState;
        // Always sync strategies with STRATEGY_DEFINITIONS — add new, remove old, keep stats
        {
          const existing = state.strategies || [];
          state.strategies = STRATEGY_DEFINITIONS.map(d => {
            const ex = existing.find((s: Strategy) => s.id === d.id);
            return ex || { ...d, enabled: DEFAULT_ENABLED_STRATEGIES.has(d.id), trades: 0, wins: 0, losses: 0, pnl: 0 };
          });
        }
        // Ensure new config fields
        if (state.config.trailingStopPercent === undefined) state.config.trailingStopPercent = 0;
        if (state.config.profitLockPercent === undefined) state.config.profitLockPercent = 0;
        if (state.config.maxHoldHours === undefined) state.config.maxHoldHours = 0;
        if (state.config.tp1Percent === undefined) state.config.tp1Percent = 0;
        if (state.config.tp1SizePercent === undefined) state.config.tp1SizePercent = 50;
        if (state.config.minConfidence === undefined) state.config.minConfidence = 0;
        if (state.config.maxDrawdownUSD === undefined) state.config.maxDrawdownUSD = 0;
        if (state.config.dcaEnabled === undefined) state.config.dcaEnabled = false;
        if (state.config.dcaOrderSizeUSD === undefined) state.config.dcaOrderSizeUSD = 10;
        if (state.config.dcaMaxOrders === undefined) state.config.dcaMaxOrders = 5;
        if (state.config.dcaTriggerDropPercent === undefined) state.config.dcaTriggerDropPercent = 3;
        if (state.config.dcaTakeProfitPercent === undefined) state.config.dcaTakeProfitPercent = 8;
        if (state.config.dcaStopLossPercent === undefined) state.config.dcaStopLossPercent = 15;
        if (state.config.dcaCoins === undefined) state.config.dcaCoins = [];
        if (state.config.aiBrainEnabled === undefined) state.config.aiBrainEnabled = false;
        if (!state.dcaStacks) state.dcaStacks = [];
        if (!state.dcaHistory) state.dcaHistory = [];
        if (!state.dailyPicks) state.dailyPicks = [];
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
  await fetch(`${UPSTASH_URL}/set/${REDIS_KEY}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(state),
  });
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

// ─── Advanced Indicators ─────────────────────────────────────────────────────

function computeATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close)
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

function computeOBV(candles: Candle[]): { trend: number; breakout: boolean } {
  const arr: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    if      (candles[i].close > candles[i - 1].close) arr.push(arr[i - 1] + candles[i].volume);
    else if (candles[i].close < candles[i - 1].close) arr.push(arr[i - 1] - candles[i].volume);
    else                                               arr.push(arr[i - 1]);
  }
  const latest  = arr[arr.length - 1];
  const avg20   = arr.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const high20  = Math.max(...arr.slice(-21, -1));
  return {
    trend:    avg20 !== 0 ? Math.round(((latest - avg20) / Math.abs(avg20)) * 100) : 0,
    breakout: latest > high20,
  };
}

function computeCMF(candles: Candle[], period: number = 20): number {
  const slice = candles.slice(-period);
  let mfvSum = 0, volSum = 0;
  for (const c of slice) {
    const hl = c.high - c.low;
    if (hl === 0) continue;
    mfvSum += ((c.close - c.low) - (c.high - c.close)) / hl * c.volume;
    volSum += c.volume;
  }
  return volSum > 0 ? Math.round((mfvSum / volSum) * 1000) / 1000 : 0;
}

function detectBullishDivergence(prices: number[], rsis: number[]): boolean {
  if (prices.length < 8 || rsis.length < 8) return false;
  const n = Math.min(prices.length, rsis.length);
  const p = prices.slice(-n); const r = rsis.slice(-n);
  let li2 = -1, li1 = -1;
  for (let i = n - 2; i > n / 2; i--) {
    if (p[i] < p[i - 1] && p[i] < p[i + 1]) { li2 = i; break; }
  }
  if (li2 < 0) return false;
  for (let i = li2 - 2; i > 0; i--) {
    if (p[i] < p[i - 1] && p[i] < p[i + 1]) { li1 = i; break; }
  }
  if (li1 < 0) return false;
  return p[li2] < p[li1] * 0.99 && r[li2] > r[li1] + 2;
}

function detectBBSqueeze(closes: number[], highs: number[], lows: number[], period: number = 20): { squeezed: boolean; releasing: boolean } {
  if (closes.length < period + 2) return { squeezed: false, releasing: false };
  const mkC = (cl: number[], hi: number[], lo: number[]): Candle[] =>
    cl.map((c, i) => ({ close: c, high: hi[i] ?? c, low: lo[i] ?? c, open: c, volume: 1, time: i }));
  const bbWidth  = (cl: number[]) => { const b = bollingerBands(cl, period, 2); return b.upper - b.lower; };
  const kcWidth  = (cl: number[], hi: number[], lo: number[]) => 3 * computeATR(mkC(cl, hi, lo), period);
  const sq1 = bbWidth(closes)             < kcWidth(closes,             highs,             lows);
  const sq2 = bbWidth(closes.slice(0,-1)) < kcWidth(closes.slice(0,-1), highs.slice(0,-1), lows.slice(0,-1));
  const bb  = bollingerBands(closes, period, 2);
  return { squeezed: sq1, releasing: sq2 && !sq1 && closes[closes.length - 1] > bb.middle };
}

function computeSupertrend(candles: Candle[], period: number = 10, multiplier: number = 3): { bullish: boolean; flipped: boolean } {
  if (candles.length < period + 1) return { bullish: true, flipped: false };
  const trs: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close)
    ));
  }
  const atrArr: number[] = [trs[0]];
  for (let i = 1; i < trs.length; i++) atrArr.push((atrArr[i - 1] * (period - 1) + trs[i]) / period);
  const fUp: number[] = [], fDn: number[] = [], trend: boolean[] = [];
  for (let i = 0; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    fUp.push(hl2 + multiplier * (atrArr[i] || 0));
    fDn.push(hl2 - multiplier * (atrArr[i] || 0));
  }
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { trend.push(true); continue; }
    fUp[i] = fUp[i] < fUp[i-1] || candles[i-1].close > fUp[i-1] ? fUp[i] : fUp[i-1];
    fDn[i] = fDn[i] > fDn[i-1] || candles[i-1].close < fDn[i-1] ? fDn[i] : fDn[i-1];
    const prev = trend[i - 1];
    if  (prev && candles[i].close < fDn[i]) trend.push(false);
    else if (!prev && candles[i].close > fUp[i]) trend.push(true);
    else trend.push(prev);
  }
  const cur = trend[trend.length - 1], prv = trend[trend.length - 2] ?? true;
  return { bullish: cur, flipped: !prv && cur };
}

function computeVWAP(candles: Candle[]): number {
  const slice = candles.slice(-6); // 24h VWAP from last 6 × 4h bars
  let tpvSum = 0, volSum = 0;
  for (const c of slice) {
    tpvSum += ((c.high + c.low + c.close) / 3) * c.volume;
    volSum += c.volume;
  }
  return volSum > 0 ? Math.round((tpvSum / volSum) * 100000) / 100000 : 0;
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

// skipDaily flag: set to true for fast cron scans, false for daily picks
let _skipDailyCandles = false;

async function scanCoin(symbol: string): Promise<SmartSignal | null> {
  try {
  // 4h candles for all indicators + optional daily for macro context
  const BARS_PER_DAY = 6;
  const fetches: Promise<Candle[]>[] = [
    fetchKlines(symbol, '1h', 48),
    fetchKlines(symbol, '4h', 200),
  ];
  if (!_skipDailyCandles) fetches.push(fetchKlines(symbol, '1d', 30));
  const [hourly, fourHour, daily = []] = await Promise.all(fetches) as [Candle[], Candle[], Candle[]];
  if (fourHour.length < 50 || hourly.length < 24) {
    console.log(`[SCAN] ${symbol}: insufficient data (4h=${fourHour.length}, 1h=${hourly.length})`);
    return null;
  }

  const last = fourHour[fourHour.length - 1];
  const price = last.close;

  // 24h change = compare current price with price 6 bars ago on 4h (= 24h back)
  const prev24h = fourHour.length >= 7 ? fourHour[fourHour.length - 7] : fourHour[0];
  const change24h = prev24h ? ((price - prev24h.close) / prev24h.close) * 100 : 0;

  const lastH = hourly[hourly.length - 1];
  const prevH = hourly.length >= 2 ? hourly[hourly.length - 2] : lastH;
  const change1h = ((lastH.close - prevH.close) / prevH.close) * 100;

  const fhCloses = fourHour.map(c => c.close);
  const fhVolumes = fourHour.map(c => c.volume);
  const hourlyVolumes = hourly.map(c => c.volume);

  // vol7dAvg — use last 42 4h bars (7 days) excluding current bar
  const vol7dAvg = fhVolumes.slice(-43, -1).reduce((a, b) => a + b, 0) / 42;
  const currentVol = last.volume;
  const volumeAnomaly = vol7dAvg > 0 ? Math.round((currentVol / vol7dAvg) * 100) / 100 : 1;

  const hourlyAvgVol = hourlyVolumes.slice(0, -1).reduce((a, b) => a + b, 0) / (hourlyVolumes.length - 1);
  const hourlyVolSpike = hourlyAvgVol > 0 ? lastH.volume / hourlyAvgVol : 1;

  const rsi = computeRSI(fhCloses);
  const rsi1h = computeRSI(hourly.map(c => c.close));
  const rsiZone = rsi >= 70 ? 'overbought' : rsi >= 60 ? 'strong' : rsi >= 40 ? 'neutral' : rsi >= 30 ? 'weak' : 'oversold';

  const ema9 = ema(fhCloses, 9);
  const ema21 = ema(fhCloses, 21);
  const ema50 = ema(fhCloses, 50);
  const emaCurrent9 = ema9[ema9.length - 1];
  const emaCurrent21 = ema21[ema21.length - 1];
  const emaCurrent50 = ema50.length > 0 ? ema50[ema50.length - 1] : 0;
  const emaTrend = emaCurrent9 > emaCurrent21 ? 1 : -1;

  const macdData = macd(fhCloses);
  const macdBullish = macdData.hist > 0;
  const macdCrossing = macdData.hist > 0 && macdData.macd < macdData.signal * 1.5;

  // Bollinger Bands on 4h closes
  const bb = bollingerBands(fhCloses);

  let momentum = 0;
  if (emaTrend > 0) momentum += 20; else momentum -= 20;
  if (macdBullish) momentum += 15; else momentum -= 15;
  if (rsi > 50) momentum += 10; else momentum -= 10;
  if (change24h > 0) momentum += Math.min(20, change24h * 3); else momentum += Math.max(-20, change24h * 3);
  if (volumeAnomaly > 1.5) momentum += 15;
  if (hourlyVolSpike > 2) momentum += 10;
  momentum = Math.max(-100, Math.min(100, Math.round(momentum)));

  // 7-day range → last 42 4h bars
  const last7Closes = fhCloses.slice(-42);
  const priceRange7d = last7Closes.length > 0
    ? (Math.max(...last7Closes) - Math.min(...last7Closes)) / Math.min(...last7Closes) * 100
    : 0;
  // Volume trend: last 7d vs prev 7d (in 4h bars)
  const last7Vols = fhVolumes.slice(-42);
  const prev7Vols = fhVolumes.slice(-84, -42);
  const volTrend = prev7Vols.length > 0
    ? (last7Vols.reduce((a, b) => a + b, 0) / last7Vols.length) / (prev7Vols.reduce((a, b) => a + b, 0) / prev7Vols.length)
    : 1;
  const accumulating = priceRange7d < 8 && volTrend > 1.3;

  // ─── Advanced indicators ─────────────────────────────────────────────────
  const atrValue   = computeATR(fourHour);
  const atrPercent = price > 0 ? Math.round((atrValue / price) * 10000) / 100 : 0;

  const obv        = computeOBV(fourHour);
  const cmfValue   = computeCMF(fourHour);

  // RSI series — reused for StochRSI + Divergence (computed once)
  const rsiSeries: number[] = [];
  for (let i = 14; i <= fhCloses.length; i++) rsiSeries.push(computeRSI(fhCloses.slice(0, i)));

  let stochRsiVal = 50;
  if (rsiSeries.length >= 14) {
    const rec = rsiSeries.slice(-14);
    const minR = Math.min(...rec), maxR = Math.max(...rec);
    if (maxR !== minR) stochRsiVal = Math.round(((rsiSeries[rsiSeries.length - 1] - minR) / (maxR - minR)) * 100);
  }

  const fhLows    = fourHour.map(c => c.low);
  const fhHighs_  = fourHour.map(c => c.high);
  const bullDiv   = detectBullishDivergence(fhLows.slice(-20), rsiSeries.slice(-20));
  const squeeze   = detectBBSqueeze(fhCloses, fhHighs_, fhLows);
  const st        = computeSupertrend(fourHour);
  const vwap      = computeVWAP(fourHour);
  const prevClose = fourHour.length >= 2 ? fourHour[fourHour.length - 2].close : price;
  const vwapReclaim = price > vwap && prevClose < vwap && vwap > 0;

  // MTF Confluence: 1h + 4h both trending bullish
  const hCloses  = hourly.map(c => c.close);
  const hEma9    = ema(hCloses, 9);
  const hEma21   = ema(hCloses, 21);
  const mtfConfl = hEma9[hEma9.length - 1] > hEma21[hEma21.length - 1] && rsi1h > 50 && emaTrend > 0 && rsi > 50;

  // Daily timeframe indicators (Mega Scanner V2)
  let dailyRsi = 50, dailyTrend: 'up' | 'down' | 'sideways' = 'sideways';
  let dailySupport = 0, dailyResistance = 0, change7d = 0;
  if (daily.length >= 7) {
    const dCloses = daily.map(c => c.close);
    dailyRsi = computeRSI(dCloses);
    const dEma7 = ema(dCloses, 7);
    const dEma21d = ema(dCloses, Math.min(21, dCloses.length));
    const e7 = dEma7[dEma7.length - 1], e21 = dEma21d[dEma21d.length - 1];
    dailyTrend = e7 > e21 * 1.005 ? 'up' : e7 < e21 * 0.995 ? 'down' : 'sideways';
    dailySupport = Math.min(...daily.map(c => c.low));
    dailyResistance = Math.max(...daily.map(c => c.high));
    const prev7d = daily.length >= 8 ? daily[daily.length - 8].close : daily[0].close;
    change7d = prev7d > 0 ? Math.round(((price - prev7d) / prev7d) * 10000) / 100 : 0;
  }

  // 20-day high breakout → last 120 4h bars (= 20 days × 6 bars)
  const high20d = fourHour.length > 121
    ? Math.max(...fourHour.slice(-121, -1).map(c => c.high))
    : Math.max(...fourHour.slice(0, -1).map(c => c.high));
  // justBroke50: use previous 4h bar instead of previous daily bar
  const prevBar = fourHour[fourHour.length - 2];
  const justBroke50 = ema50.length > 1 && price > ema50[ema50.length - 1] && prevBar.close < ema50[ema50.length - 2];

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
    reasons.push(`4h RSI ${rsi} oversold, hourly RSI ${rsi1h.toFixed(0)} bouncing`);
    strength += 25;
  }

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
    reasons.push('Price just broke above 50-period EMA (4h) — trend change');
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

  // ─── Advanced signals ────────────────────────────────────────────────────
  if (bullDiv && rsi < 55) {
    signals.push('BULL DIVERGENCE');
    reasons.push('RSI bullish divergence: price lower low, RSI higher low — smart money buying dip');
    strength += 30;
  }

  if (squeeze.releasing && momentum > 0) {
    signals.push('SQUEEZE RELEASE');
    reasons.push('Bollinger Band squeeze ending — volatility expansion and directional move imminent');
    strength += 25;
  }

  // OBV BREAKOUT: requires strong trend AND confirmed by real volume spike (not just any bull market)
  if (obv.breakout && obv.trend > 30 && volumeAnomaly >= 1.5) {
    signals.push('OBV BREAKOUT');
    reasons.push(`OBV above 20-bar high (+${obv.trend.toFixed(0)}% trend) — institutional accumulation detected`);
    strength += 20;
  }

  if (st.flipped) {
    signals.push('SUPERTREND FLIP');
    reasons.push('Price crossed above Supertrend line — confirmed trend change to bullish');
    strength += 25;
  }

  // CMF FLOW: raised threshold to avoid common bull-market noise
  if (cmfValue > 0.22) {
    signals.push('CMF FLOW');
    reasons.push(`CMF ${cmfValue.toFixed(2)} — strong buying pressure dominant (money flowing in)`);
    strength += 15;
  }

  // STOCH OVERSOLD: require RSI also low to filter false positives
  if (stochRsiVal < 20 && change1h > 0 && rsi < 50) {
    signals.push('STOCH OVERSOLD');
    reasons.push(`StochRSI ${stochRsiVal} — precise oversold timing with upward price action`);
    strength += 20;
  }

  // MTF CONFLUENCE: bonus only — requires 2+ other signals to prevent spam
  if (mtfConfl && signals.length >= 2) {
    signals.push('MTF CONFLUENCE');
    reasons.push('1h + 4h EMAs and RSI both aligned bullish — multi-timeframe confirmation');
    strength += 15;
  }

  if (vwapReclaim) {
    signals.push('VWAP RECLAIM');
    reasons.push(`Price reclaimed 24h VWAP ($${vwap.toFixed(4)}) — buyers took intraday control`);
    strength += 15;
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
  } else if (signals.includes('BULL DIVERGENCE') || signals.includes('STOCH OVERSOLD')) {
    category = 'divergence';
    action = strength > 50 ? 'buy' : 'watch';
  } else if (signals.includes('SQUEEZE RELEASE') || signals.includes('SUPERTREND FLIP')) {
    category = 'squeeze';
    action = strength > 55 ? 'buy' : 'watch';
  } else if (signals.includes('OBV BREAKOUT') || signals.includes('CMF FLOW') || signals.includes('VWAP RECLAIM')) {
    category = 'accumulation';
    action = strength > 55 ? 'buy' : 'watch';
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
    rsi, rsiZone, rsi1h,
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
    // Advanced indicators
    atrPercent,
    obvTrend: obv.trend, obvBreakout: obv.breakout,
    cmf: cmfValue,
    stochRsi: stochRsiVal,
    supertrendBullish: st.bullish, supertrendFlip: st.flipped,
    bullDivergence: bullDiv,
    bbSqueeze: squeeze.squeezed, bbSqueezeRelease: squeeze.releasing,
    vwap,
    mtfConfluent: mtfConfl,
    // Daily timeframe (Mega Scanner V2)
    dailyRsi, dailyTrend, dailySupport, dailyResistance, change7d,
  };
  } catch (e: any) {
    console.log(`[SCAN] ${symbol}: ERROR — ${e.message}`);
    return null;
  }
}

const TOP_COINS = [
  // Mega caps (8)
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX',
  // Large caps (9)
  'DOT', 'MATIC', 'LINK', 'UNI', 'ATOM', 'LTC', 'NEAR', 'TRX', 'XLM',
  // DeFi (8)
  'AAVE', 'MKR', 'CRV', 'LDO', 'PENDLE', 'SNX', 'GMX', 'BAL',
  // L2 / Infrastructure (5)
  'ARB', 'OP', 'IMX', 'STX', 'STRK',
  // AI / Data / RWA / Agents (9)
  'FET', 'RNDR', 'GRT', 'WLD', 'TAO', 'AGIX', 'ONDO', 'AIXBT', 'VIRTUAL',
  // Ecosystems / Emerging L1s (8)
  'INJ', 'SUI', 'SEI', 'APT', 'TIA', 'JUP', 'PYTH', 'ENA',
  // Quality mid-caps (10)
  'FIL', 'RUNE', 'HBAR', 'ICP', 'KAVA', 'ROSE', 'CFX', 'BLUR', 'JTO', 'AERO',
  // Meme — alerts only, never auto-trade (6)
  'PEPE', 'WIF', 'BONK', 'FLOKI', 'ORDI', 'MEME',
  // Blue-chip alts (4)
  'ALGO', 'VET', 'FTM', 'SHIB',
  // === MEGA SCANNER V2 — 43 new coins ===
  // Gaming / Metaverse (7)
  'AXS', 'SAND', 'GALA', 'MANA', 'ENJ', 'ILV', 'BEAM',
  // More DeFi (6)
  'COMP', 'SUSHI', 'YFI', 'DYDX', '1INCH', 'CAKE',
  // Infrastructure / Storage (7)
  'AR', 'THETA', 'CELO', 'ZEC', 'KDA', 'IOTA', 'EGLD',
  // Mid-cap L1s (6)
  'FLOW', 'MINA', 'ZIL', 'KLAY', 'ONE', 'KAS',
  // Trending / Utility (10)
  'TWT', 'MASK', 'SSV', 'LRC', 'SKL', 'ANKR', 'CHZ',
  'CKB', 'API3', 'STORJ',
  // Data / IoT (4)
  'OCEAN', 'JASMY', 'IOTX', 'SC',
  // New narratives (3)
  'W', 'ZRO', 'ETHFI',
]; // ~110 coins total

// Liquid, established coins approved for auto-trading (46 coins).
// Meme/high-volatility coins still alert but NEVER auto-trade.
const SAFE_TRADING_COINS = new Set([
  // Mega caps
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX',
  // Large caps
  'DOT', 'LINK', 'ATOM', 'LTC', 'NEAR', 'ARB', 'OP',
  'INJ', 'SUI', 'AAVE', 'MKR', 'TRX', 'XLM',
  // Quality mid-caps
  'FET', 'RNDR', 'ICP', 'HBAR', 'STX', 'JUP', 'ENA',
  'TIA', 'APT', 'SEI', 'PENDLE', 'GMX', 'RUNE', 'AERO',
  // V2 additions — established + liquid
  'COMP', 'DYDX', 'AR', 'THETA', 'EGLD', 'KAS', 'FLOW',
  'MINA', 'OCEAN', 'ALGO', 'FTM', 'CHZ', 'LRC', 'ETHFI',
  'W', 'ZRO',
]);

// === MARKET REGIME DETECTOR ===
function detectMarketRegime(btcSig: SmartSignal | undefined): MarketRegime {
  if (!btcSig) return 'neutral';
  let score = 0;
  // RSI
  if (btcSig.rsi > 60) score += 2; else if (btcSig.rsi > 50) score += 1;
  else if (btcSig.rsi < 40) score -= 2; else if (btcSig.rsi < 50) score -= 1;
  // Momentum
  if (btcSig.momentum > 40) score += 2; else if (btcSig.momentum > 10) score += 1;
  else if (btcSig.momentum < -40) score -= 2; else if (btcSig.momentum < -10) score -= 1;
  // EMA structure
  if (btcSig.ema9 > btcSig.ema21 && btcSig.ema21 > btcSig.ema50) score += 2;
  else if (btcSig.ema9 < btcSig.ema21 && btcSig.ema21 < btcSig.ema50) score -= 2;
  // 24h change
  if (btcSig.change24h > 3) score += 1; else if (btcSig.change24h < -3) score -= 1;
  // Supertrend
  if (btcSig.supertrendBullish) score += 1; else score -= 1;
  // Daily trend
  if (btcSig.dailyTrend === 'up') score += 1; else if (btcSig.dailyTrend === 'down') score -= 1;
  if (score >= 5) return 'strong_bull';
  if (score >= 2) return 'bull';
  if (score <= -5) return 'strong_bear';
  if (score <= -2) return 'bear';
  return 'neutral';
}

// === SCORING FUNCTIONS (Daily Picker + AI) ===
function computeTechnicalScore(s: SmartSignal): number {
  let score = 0;
  if (s.ema9 > s.ema21 && s.ema21 > s.ema50) score += 25;
  else if (s.ema9 > s.ema21) score += 15;
  else if (s.ema9 < s.ema21 && s.ema21 < s.ema50) score += 0;
  else score += 8;
  if (s.rsi >= 45 && s.rsi <= 65) score += 20;
  else if (s.rsi >= 35 && s.rsi <= 70) score += 12;
  else if (s.rsi < 30) score += 15;
  else score += 5;
  score += Math.max(0, Math.min(20, (s.momentum + 50) * 0.2));
  score += Math.min(20, s.signals.length * 5);
  if (s.supertrendBullish) score += 8;
  if (s.mtfConfluent) score += 7;
  if (s.dailyTrend === 'up') score += 5;
  else if (s.dailyTrend === 'down') score -= 5;
  return Math.min(100, Math.round(score));
}

function computeMoneyFlowScore(s: SmartSignal): number {
  let score = 50;
  score += Math.max(-25, Math.min(25, s.obvTrend * 0.5));
  score += Math.max(-25, Math.min(25, s.cmf * 100));
  if (s.volumeAnomaly > 1.5) score += 10;
  if (s.volumeAnomaly > 2.5) score += 10;
  if (s.obvBreakout) score += 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function computeRiskScore(s: SmartSignal): number {
  let score = 70;
  if (s.atrPercent > 5) score -= 20; else if (s.atrPercent > 3) score -= 10; else score += 10;
  if (s.priceRange7d < 5) score += 10; else if (s.priceRange7d > 15) score -= 15;
  if (s.rsi < 35 && s.change1h > 0) score += 10;
  if (s.rsi > 75) score -= 15;
  if (s.dailyRsi < 30) score += 5; // oversold on daily = opportunity
  if (s.dailyRsi > 75) score -= 10;
  return Math.max(0, Math.min(100, score));
}

async function fetchNewsSentiment(symbols: string[]): Promise<Record<string, number>> {
  const scores: Record<string, number> = {};
  try {
    const r = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=popular');
    if (!r.ok) return scores;
    const data = (await r.json()) as any;
    const articles = (data.Data || []).slice(0, 50);
    const nameMap: Record<string, string[]> = {
      BTC:['bitcoin','btc'],ETH:['ethereum','eth'],SOL:['solana'],BNB:['binance','bnb'],XRP:['xrp','ripple'],
      ADA:['cardano'],DOGE:['dogecoin'],AVAX:['avalanche'],DOT:['polkadot'],LINK:['chainlink'],
      SUI:['sui'],ARB:['arbitrum'],OP:['optimism'],NEAR:['near protocol'],AAVE:['aave'],
      INJ:['injective'],FET:['fetch.ai','fet'],RNDR:['render'],ICP:['internet computer'],
    };
    const pos = ['bullish','surge','gain','rally','breakout','adoption','partnership','upgrade','launch','soar','milestone','growth'];
    const neg = ['bearish','crash','dump','hack','exploit','lawsuit','ban','regulation','drop','plunge','fear','scam','decline','sec'];
    for (const sym of symbols) {
      const terms = nameMap[sym] || [sym.toLowerCase()];
      const relevant = articles.filter((a: any) => {
        const text = `${a.title} ${(a.body || '').substring(0, 200)}`.toLowerCase();
        return terms.some((t: string) => text.includes(t));
      });
      if (!relevant.length) { scores[sym] = 50; continue; }
      let sum = 0;
      for (const a of relevant) {
        const text = `${a.title} ${(a.body || '').substring(0, 300)}`.toLowerCase();
        let s = 0;
        pos.forEach(w => { if (text.includes(w)) s++; });
        neg.forEach(w => { if (text.includes(w)) s--; });
        sum += s;
      }
      scores[sym] = Math.max(0, Math.min(100, 50 + sum * 10));
    }
  } catch {}
  return scores;
}

// === AI SIGNAL BRAIN ===
interface AITradeDecision {
  action: 'APPROVE' | 'REJECT' | 'MODIFY';
  confidence: number;
  reasoning: string;
  modifiedSize?: number;
}

async function aiFilterSignal(
  sig: SmartSignal, regime: MarketRegime, recentTrades: any[],
): Promise<AITradeDecision> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { action: 'APPROVE', confidence: 50, reasoning: 'AI unavailable' };
  try {
    const recentPerf = recentTrades.slice(-5).map((t: any) =>
      `${t.symbol}: ${t.pnlPercent >= 0 ? '+' : ''}${t.pnlPercent?.toFixed(1)}% (${t.strategy})`
    ).join(', ');
    const prompt = `You are The Brain — a risk-aware crypto trading AI.
SIGNAL: ${sig.symbol} @ $${sig.price} | ${sig.action} | Str: ${sig.strength}% | Conf: ${sig.confidence}%
RSI: ${sig.rsi.toFixed(1)} | Mom: ${sig.momentum} | ATR%: ${sig.atrPercent}% | CMF: ${sig.cmf}
Signals: ${sig.signals.join(', ')} | Category: ${sig.category}
EMA9: $${sig.ema9.toFixed(4)} | EMA21: $${sig.ema21.toFixed(4)} | EMA50: $${sig.ema50.toFixed(4)}
Daily RSI: ${sig.dailyRsi.toFixed(0)} | Daily Trend: ${sig.dailyTrend} | 7d: ${sig.change7d}%
1h: ${sig.change1h}% | 24h: ${sig.change24h}% | Supertrend: ${sig.supertrendBullish ? 'BULL' : 'BEAR'}
CONTEXT: Market=${regime} | Recent: ${recentPerf || 'none'}
Reply ONLY with JSON: {"action":"APPROVE"|"REJECT","confidence":0-100,"reasoning":"1-2 sentences"}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
    });
    clearTimeout(timeout);
    if (!response.ok) return { action: 'APPROVE', confidence: 50, reasoning: 'AI API error' };
    const d = (await response.json()) as any;
    const text = d.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { const p = JSON.parse(m[0]); return { action: p.action || 'APPROVE', confidence: p.confidence || 50, reasoning: p.reasoning || '' }; }
    return { action: 'APPROVE', confidence: 50, reasoning: 'Parse error' };
  } catch (e: any) {
    return { action: 'APPROVE', confidence: 50, reasoning: `Error: ${e.message}` };
  }
}

async function aiRankPicks(topSignals: SmartSignal[], regime: MarketRegime): Promise<Array<{ symbol: string; aiScore: number; aiReason: string }>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fallback = topSignals.map(s => ({ symbol: s.symbol, aiScore: 50, aiReason: 'AI unavailable' }));
  if (!apiKey) return fallback;
  try {
    const summary = topSignals.map(s =>
      `${s.symbol}: $${s.price}, RSI=${s.rsi.toFixed(0)}, Mom=${s.momentum}, Str=${s.strength}%, ` +
      `DailyRSI=${s.dailyRsi.toFixed(0)}, DailyTrend=${s.dailyTrend}, 7d=${s.change7d}%, ` +
      `Signals=[${s.signals.join(',')}], CMF=${s.cmf.toFixed(2)}, ATR=${s.atrPercent.toFixed(1)}%`
    ).join('\n');
    const prompt = `You are a quant analyst. Market regime: ${regime}.
Top 10 coins by technical score:
${summary}
Rank best to worst for NEXT 24 HOURS. Reply ONLY with JSON array: [{"symbol":"BTC","score":85,"reason":"1 sentence"}]`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });
    clearTimeout(timeout);
    if (!response.ok) return fallback;
    const d = (await response.json()) as any;
    const text = d.content?.[0]?.text || '';
    const m = text.match(/\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  return fallback;
}

// === TELEGRAM ===
async function sendTelegramAlert(token: string, chatId: string, text: string) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[TELEGRAM] Failed to send alert: HTTP ${res.status} — ${errBody}`);
    }
  } catch (e: any) {
    console.error(`[TELEGRAM] Fetch error: ${e.message}`);
  }
}

function formatPrice(p: number): string {
  return p >= 1000 ? '$' + Math.round(p).toLocaleString() : p >= 1 ? '$' + p.toFixed(2) : '$' + p.toFixed(6);
}

async function sendSignalAlerts(signals: SmartSignal[], tgToken: string, tgChat: string, state: TradingState) {
  let alertsSent = 0;
  const MAX_ALERTS_PER_RUN = 6;          // hard cap per cron cycle
  const ALERT_TTL_MS = 6 * 60 * 60 * 1000; // 6h deduplication — no repeat same coin+type
  const now = Date.now();

  // Use state.alertTimes (persisted in main state.json) — immune to Blob CDN delays
  if (!state.alertTimes) state.alertTimes = {};
  const at = state.alertTimes;

  // Prune entries older than 24h to keep the object small
  for (const k of Object.keys(at)) {
    if (now - at[k] > 24 * 3600000) delete at[k];
  }

  const earlyGainers = signals.filter(s => s.category === 'early_gainer' && s.strength >= 55);
  for (const s of earlyGainers) {
    if (alertsSent >= MAX_ALERTS_PER_RUN) break;
    const key = `${s.symbol}_early_gainer`;
    if (at[key] && now - at[key] < ALERT_TTL_MS) continue;
    at[key] = now;
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

  const breakouts = signals.filter(s => s.category === 'breakout' && s.strength >= 55);
  for (const s of breakouts) {
    if (alertsSent >= MAX_ALERTS_PER_RUN) break;
    const key = `${s.symbol}_breakout`;
    if (at[key] && now - at[key] < ALERT_TTL_MS) continue;
    at[key] = now;
    const msg = `📈 BREAKOUT\n\n${s.symbol} @ ${formatPrice(s.price)}\n` +
      `24h: ${s.change24h >= 0 ? '+' : ''}${s.change24h}% | Vol: ${s.volumeAnomaly.toFixed(1)}x\n` +
      `Strength: ${s.strength}% | ${s.reason}\n${s.action.toUpperCase()}`;
    await sendTelegramAlert(tgToken, tgChat, msg);
    alertsSent++;
  }

  // Raised to 72 — only genuinely strong signals pass (prevents bull-market noise spam)
  const strongBuys = signals.filter(s =>
    (s.action === 'strong_buy' || s.action === 'buy') && s.strength >= 72 &&
    s.category !== 'early_gainer' && s.category !== 'breakout'
  );
  for (const s of strongBuys) {
    if (alertsSent >= MAX_ALERTS_PER_RUN) break;
    const key = `${s.symbol}_${s.category}`;
    if (at[key] && now - at[key] < ALERT_TTL_MS) continue;
    at[key] = now;
    const msg = `🧠 BRAIN SIGNAL\n\n${s.symbol} — ${s.action.toUpperCase()}\n` +
      `${formatPrice(s.price)} | Str: ${s.strength}% | ${s.category}\n${s.reason}`;
    await sendTelegramAlert(tgToken, tgChat, msg);
    alertsSent++;
  }

  // alertTimes is saved when state is persisted (no extra blob needed)
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
  scanSignals?: SmartSignal[],
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

      // Partial TP1: sell tp1SizePercent% of position at TP1 price, let rest run to TP2
      if (config.tp1Percent > 0 && pos.tp1 && !pos.tp1Hit && currentPrice >= pos.tp1) {
        try {
          const sellQty = Math.round(pos.qty * (config.tp1SizePercent / 100) * 1e8) / 1e8;
          if (sellQty > 0) {
            const tp1Result = await client.submitOrder({ category: 'spot', symbol: `${pos.symbol}USDT`, side: 'Sell', orderType: 'Market', qty: String(sellQty) });
            if (tp1Result.retCode === 0) {
              const partialPnl = Math.round((currentPrice - pos.entryPrice) * sellQty * 100) / 100;
              pos.qty = Math.round((pos.qty - sellQty) * 1e8) / 1e8;
              pos.tp1Hit = true;
              if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat,
                `⚡ PARTIAL TP1 HIT\n\n${pos.symbol} | ${config.tp1SizePercent}% sold\nPrice: ${formatPrice(currentPrice)} (+${config.tp1Percent}%)\nPartial P&L: +$${partialPnl.toFixed(2)}\nRemainder runs to TP2: ${formatPrice(pos.takeProfit)}`);
            } else {
              console.error(`[AUTO-TRADE] Partial TP1 sell failed for ${pos.symbol}: ${tp1Result.retMsg}`);
            }
          }
        } catch (e: any) {
          console.error(`[AUTO-TRADE] Partial TP1 error for ${pos.symbol}:`, e.message);
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

      // Scanner-driven exit: close if scanner now says SELL on this coin
      if (!shouldClose && scanSignals) {
        const scanSig = scanSignals.find(s => s.symbol === pos.symbol);
        if (scanSig && (scanSig.action === 'sell' || scanSig.action === 'strong_sell')) {
          const holdMs = Date.now() - new Date(pos.entryTime).getTime();
          // Only close if held >4h OR already profitable — avoid exiting brand-new entries
          if (holdMs > 4 * 3600000 || pnlPercent > 0) {
            shouldClose = true;
            closeReason = 'closed_signal';
          }
        }
      }

      if (shouldClose) {
        const closeResult = await client.submitOrder({
          category: 'spot', symbol: `${pos.symbol}USDT`, side: 'Sell', orderType: 'Market', qty: String(pos.qty),
        });

        if (closeResult.retCode !== 0) {
          console.error(`[AUTO-TRADE] Sell order failed for ${pos.symbol}: ${closeResult.retMsg}`);
        } else {
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

          // Log sell to Trade Journal
          try {
            const sellLog = {
              id: `sell_${Date.now()}`, timestamp: new Date().toISOString(), source: 'bot',
              symbol: pos.symbol, side: 'Sell', qty: String(pos.qty),
              price: String(currentPrice), signal: closeReason,
              orderType: 'Market', result: 'success',
              pnl: pos.pnl, pnlPercent: pos.pnlPercent,
              linkedTradeId: pos.id, entryPrice: pos.entryPrice, exitPrice: currentPrice,
            };
            await put(`trades/${new Date().toISOString().split('T')[0]}/sell_${pos.id}.json`, JSON.stringify(sellLog), {
              contentType: 'application/json', access: 'public', allowOverwrite: true,
            });
          } catch {}

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
            closed_signal: '📡 SCANNER EXIT',
          };
          const stratName = strat?.name || pos.strategy;
          const msg = `${labels[closeReason] || closeReason}\n\n` +
            `${pos.symbol} | Strategy: ${stratName}\n` +
            `Entry: ${formatPrice(pos.entryPrice)} → Exit: ${formatPrice(currentPrice)}\n` +
            `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)\n` +
            `💰 Total: ${state.totalPnl >= 0 ? '+' : ''}$${state.totalPnl.toFixed(2)} | Win: ${state.totalTrades > 0 ? Math.round((state.winCount / state.totalTrades) * 100) : 0}%`;
          if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, msg);
        }
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
  if (!config.enabled) {
    if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, `⚙️ DEBUG: executeTrades skipped — config.enabled=false`);
    return 0;
  }

  const enabledStrategies = state.strategies.filter(s => s.enabled).map(s => s.id);
  if (enabledStrategies.length === 0) {
    if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, `⚙️ DEBUG: No strategies enabled`);
    return 0;
  }

  const openPositions = state.positions.filter(p => p.status === 'open');
  let tradesPlaced = 0;
  const tradedThisRun = new Set<string>(); // prevent same coin traded twice in one run
  const skipReasons: string[] = []; // diagnostic: track why signals are skipped

  // Pre-flight: check available USDT balance — skip all trades if insufficient
  let availableUSDT = 0;
  try {
    const balRes = await client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
    const usdtCoin = balRes.result?.list?.[0]?.coin?.find((c: any) => c.coin === 'USDT');
    availableUSDT = parseFloat(usdtCoin?.availableToWithdraw || usdtCoin?.walletBalance || '0');
  } catch (e: any) {
    if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, `⚙️ DEBUG: USDT balance check FAILED: ${e.message}`);
  }
  if (availableUSDT < config.positionSizeUSD) {
    if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat, `⚙️ DEBUG: Insufficient USDT: $${availableUSDT.toFixed(2)} < $${config.positionSizeUSD} needed`);
    return 0;
  }

  // Market Regime Detection — auto-sets adaptive thresholds for ALL strategies
  const btcSig = signals.find(s => s.symbol === 'BTC');
  const regime = detectMarketRegime(btcSig);
  _currentRegime = regime; // tells evaluateStrategies which thresholds to use
  const btcStronglyBearish = regime === 'strong_bear' || regime === 'bear';

  // Diagnostic: track safe signals that match ANY strategy (not just BUY action)
  const buySignals = signals.filter(s => {
    if (!SAFE_TRADING_COINS.has(s.symbol)) return false;
    if (s.action === 'buy' || s.action === 'strong_buy') return true;
    // Also include dip/oversold signals even if action=watch
    return s.change24h <= -3 || s.rsi < 35;
  });

  for (const sig of signals) {
    if (tradedThisRun.has(sig.symbol)) continue;

    // Only trade safe, liquid coins — skip meme/high-volatility coins
    if (!SAFE_TRADING_COINS.has(sig.symbol)) continue;

    // Evaluate which strategies match this signal FIRST (before any filters)
    const matchedStrategies = evaluateStrategies(sig, enabledStrategies);
    if (matchedStrategies.length === 0) continue;

    // Regime-aware guard — only applies to non-bear-market strategies
    const BEAR_MARKET_STRATEGIES = new Set(['dip_buyer', 'rsi_reversal', 'bollinger_bounce', 'divergence_play', 'panic_reversal', 'vwap_reclaim', 'smart_money']);
    const isBearMarketEntry = matchedStrategies.some(s => BEAR_MARKET_STRATEGIES.has(s));
    // Adaptive min confidence: bear market = 0 (adaptive thresholds already control quality)
    const effectiveMinConf = isBearMarketEntry ? 0 : (config.minConfidence || 0);
    if (effectiveMinConf > 0 && sig.confidence < effectiveMinConf) {
      skipReasons.push(`${sig.symbol}: conf ${sig.confidence}% < ${effectiveMinConf}%`);
      continue;
    }

    // BTC Macro Guard — bear-market strategies EXEMPT
    if (btcStronglyBearish && sig.symbol !== 'BTC' && !isBearMarketEntry) {
      if ((sig.action !== 'strong_buy' && sig.action !== 'buy') || sig.confidence < 75) {
        skipReasons.push(`${sig.symbol}: BTC guard blocked (${sig.action}, conf=${sig.confidence}%, strats=${matchedStrategies.join(',')})`);
        continue;
      }
    }

    // Max Drawdown guard — auto-disable bot if threshold crossed
    if (config.maxDrawdownUSD > 0 && state.totalPnl <= -config.maxDrawdownUSD) {
      state.config.enabled = false;
      if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat,
        `🛑 MAX DRAWDOWN HIT\n\nBot auto-disabled.\nTotal P&L: $${state.totalPnl.toFixed(2)}\nLimit: -$${config.maxDrawdownUSD}`);
      break;
    }

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

    // AI Brain filter (if enabled) — Claude reviews signal before trading
    let positionSizeUSD = config.positionSizeUSD;
    if (config.aiBrainEnabled) {
      const aiDecision = await aiFilterSignal(sig, regime, state.history.slice(-10));
      if (aiDecision.action === 'REJECT') {
        skipReasons.push(`${sig.symbol}: AI REJECTED — ${aiDecision.reasoning}`);
        if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat,
          `🧠 AI REJECT | ${sig.symbol}\n${aiDecision.reasoning}\nConf: ${aiDecision.confidence}%`);
        continue;
      }
      if (aiDecision.modifiedSize) positionSizeUSD = aiDecision.modifiedSize;
    }

    const qty = positionSizeUSD / sig.price;
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
            // avgPrice is already price-per-coin; only divide cumExecValue if avgPrice missing
            fillPrice = parseFloat(order.avgPrice || '0') || (parseFloat(order.cumExecValue || '0') / fillQty) || sig.price;
          }
        }
      } catch {}

      const posId = `at_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const stopLoss = Math.round(fillPrice * (1 - config.stopLossPercent / 100) * 100) / 100;
      const takeProfit = Math.round(fillPrice * (1 + config.takeProfitPercent / 100) * 100) / 100;

      const stratName = state.strategies.find(s => s.id === strategyId)?.name || strategyId;

      const tp1Price = config.tp1Percent > 0 ? Math.round(fillPrice * (1 + config.tp1Percent / 100) * 100) / 100 : undefined;

      const position: Position = {
        id: posId, symbol: sig.symbol, entryPrice: fillPrice, qty: fillQty,
        usdValue: Math.round(fillPrice * fillQty * 100) / 100,
        entryTime: new Date().toISOString(), orderId: result.result?.orderId || '',
        stopLoss, takeProfit, status: 'open', peakPrice: fillPrice,
        tp1: tp1Price, tp1Hit: false,
        signal: { action: sig.action, strength: sig.strength, category: sig.category, reason: sig.reason },
        strategy: strategyId,
      };

      state.positions.push(position);
      state.cooldowns[sig.symbol] = new Date().toISOString();
      tradedThisRun.add(sig.symbol);
      tradesPlaced++;

      // Log to Trade Journal (Vercel Blob) so it appears in the Journal tab
      try {
        const tradeLog = {
          id: posId, timestamp: new Date().toISOString(), source: 'bot',
          symbol: sig.symbol, side: 'Buy', qty: String(fillQty),
          price: String(fillPrice), signal: `${sig.action} ${sig.strength}% ${sig.category}`,
          orderType: 'Market', result: 'success', orderId: result.result?.orderId || '',
        };
        await put(`trades/${new Date().toISOString().split('T')[0]}/${posId}.json`, JSON.stringify(tradeLog), {
          contentType: 'application/json', access: 'public', allowOverwrite: true,
        });
      } catch {}

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


    } catch (e: any) {
      console.error(`[AUTO-TRADE] Error for ${sig.symbol}:`, e.message);
      if (tgToken && tgChat) {
        await sendTelegramAlert(tgToken, tgChat, `⚠️ TRADE ERROR | ${sig.symbol}\n${e.message}`);
      }
    }
  }

  // Diagnostic: if no trades placed, send debug info to Telegram
  if (tradesPlaced === 0 && tgToken && tgChat && buySignals.length > 0) {
    const btcInfo = btcSig ? `mom=${btcSig.momentum.toFixed(0)}, rsi=${btcSig.rsi.toFixed(0)}, ${btcSig.action}` : 'no BTC data';
    const topBuys = buySignals.slice(0, 3).map(s =>
      `${s.symbol}: ${s.action} str=${s.strength}% conf=${s.confidence}% rsi=${s.rsi.toFixed(0)} 24h=${s.change24h.toFixed(1)}%`
    ).join('\n');
    const reasons = skipReasons.slice(0, 5).join('\n');
    await sendTelegramAlert(tgToken, tgChat,
      `⚙️ TRADE DEBUG\n\n` +
      `USDT: $${availableUSDT.toFixed(2)} | BTC: ${btcStronglyBearish ? '🔴 BEARISH' : '🟢 OK'} (${btcInfo})\n` +
      `Strategies: ${enabledStrategies.length} | Open: ${openPositions.length}/${config.maxTotal}\n\n` +
      `Top BUY signals:\n${topBuys || 'None'}\n\n` +
      `Skip reasons:\n${reasons || 'None'}`
    );
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

      if (sellResult.retCode !== 0) {
        errors.push(`${pos.symbol}: ${sellResult.retMsg}`);
      } else {
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
      }
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
        const dcaCloseResult = await client.submitOrder({
          category: 'spot', symbol: `${stack.symbol}USDT`, side: 'Sell', orderType: 'Market', qty: String(stack.totalQty),
        });

        if (dcaCloseResult.retCode !== 0) {
          console.error(`[DCA] Sell order failed for ${stack.symbol}: ${dcaCloseResult.retMsg}`);
        } else {
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
        }
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
    // Only DCA safe, liquid coins — skip meme/high-volatility coins
    if (!SAFE_TRADING_COINS.has(sig.symbol)) continue;

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
              fillPrice = parseFloat(order.avgPrice || '0') || (parseFloat(order.cumExecValue || '0') / fillQty) || sig.price;
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
              fillPrice = parseFloat(order.avgPrice || '0') || (parseFloat(order.cumExecValue || '0') / fillQty) || sig.price;
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
      if (typeof nc.tp1Percent === 'number') state.config.tp1Percent = nc.tp1Percent;
      if (typeof nc.tp1SizePercent === 'number') state.config.tp1SizePercent = nc.tp1SizePercent;
      if (typeof nc.minConfidence === 'number') state.config.minConfidence = nc.minConfidence;
      if (typeof nc.maxDrawdownUSD === 'number') state.config.maxDrawdownUSD = nc.maxDrawdownUSD;
      if (typeof nc.dcaEnabled === 'boolean') state.config.dcaEnabled = nc.dcaEnabled;
      if (typeof nc.dcaOrderSizeUSD === 'number') state.config.dcaOrderSizeUSD = nc.dcaOrderSizeUSD;
      if (typeof nc.dcaMaxOrders === 'number') state.config.dcaMaxOrders = nc.dcaMaxOrders;
      if (typeof nc.dcaTriggerDropPercent === 'number') state.config.dcaTriggerDropPercent = nc.dcaTriggerDropPercent;
      if (typeof nc.dcaTakeProfitPercent === 'number') state.config.dcaTakeProfitPercent = nc.dcaTakeProfitPercent;
      if (typeof nc.dcaStopLossPercent === 'number') state.config.dcaStopLossPercent = nc.dcaStopLossPercent;
      if (Array.isArray(nc.dcaCoins)) state.config.dcaCoins = nc.dcaCoins;
      if (typeof nc.aiBrainEnabled === 'boolean') state.config.aiBrainEnabled = nc.aiBrainEnabled;

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
        dailyPicks: (state.dailyPicks || []).slice(0, 7),
        stats: {
          openPositions: enriched.length,
          openDcaStacks: enrichedDca.length,
          totalTrades: state.totalTrades,
          totalPnl: state.totalPnl,
          winCount: state.winCount,
          lossCount: state.lossCount,
          winRate: state.totalTrades > 0 ? Math.round((state.winCount / state.totalTrades) * 100) : 0,
          unrealizedPnl: enriched.reduce((sum, p) => sum + p.pnl, 0) + enrichedDca.reduce((sum, s) => sum + s.pnl, 0),
          aiBrainEnabled: state.config.aiBrainEnabled,
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

      if (sellResult.retCode !== 0) {
        return res.status(500).json({ error: `Sell order failed: ${sellResult.retMsg}` });
      }

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

    if (action === 'closeDcaStack' && req.method === 'POST') {
      const { stackId } = req.body || {};
      if (!stackId) return res.status(400).json({ error: 'Missing stackId' });

      const state = await loadState();
      const stack = state.dcaStacks.find(s => s.id === stackId && s.status === 'open');
      if (!stack) return res.status(404).json({ error: 'DCA stack not found' });

      const client = getBybitClient();
      if (!client) return res.status(500).json({ error: 'Bybit not configured' });

      const tgToken = process.env.TELEGRAM_BOT_TOKEN || '';
      const tgChat = process.env.TELEGRAM_CHAT_ID || '';

      let currentPrice = stack.avgEntryPrice;
      try {
        const tickerRes = await client.getTickers({ category: 'spot', symbol: `${stack.symbol}USDT` });
        if (tickerRes.retCode === 0 && tickerRes.result?.list?.[0])
          currentPrice = parseFloat((tickerRes.result.list[0] as any).lastPrice || '0');
      } catch {}

      const dcaSellResult = await client.submitOrder({ category: 'spot', symbol: `${stack.symbol}USDT`, side: 'Sell', orderType: 'Market', qty: String(stack.totalQty) });

      if (dcaSellResult.retCode !== 0) {
        return res.status(500).json({ error: `Sell order failed: ${dcaSellResult.retMsg}` });
      }

      const pnl = (currentPrice - stack.avgEntryPrice) * stack.totalQty;
      const pnlPercent = ((currentPrice - stack.avgEntryPrice) / stack.avgEntryPrice) * 100;

      stack.status = 'closed_manual';
      stack.closePrice = currentPrice;
      stack.closeTime = new Date().toISOString();
      stack.pnl = Math.round(pnl * 100) / 100;
      stack.pnlPercent = Math.round(pnlPercent * 100) / 100;

      state.dcaStacks = state.dcaStacks.filter(s => s.id !== stackId);
      state.dcaHistory.push(stack);
      state.totalPnl = Math.round((state.totalPnl + pnl) * 100) / 100;
      state.totalTrades++;
      if (pnl >= 0) state.winCount++; else state.lossCount++;

      const strat = state.strategies.find(s => s.id === 'dca_accumulator');
      if (strat) { strat.trades++; strat.pnl = Math.round((strat.pnl + pnl) * 100) / 100; if (pnl >= 0) strat.wins++; else strat.losses++; }

      await saveState(state);

      if (tgToken && tgChat) {
        await sendTelegramAlert(tgToken, tgChat,
          `📤 DCA MANUAL CLOSE | ${stack.symbol}\nAvg: ${formatPrice(stack.avgEntryPrice)} → ${formatPrice(currentPrice)}\nP&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)\nOrders: ${stack.entries.length}`);
      }

      return res.status(200).json({ success: true, stack });
    }

    if (action === 'resetStats' && req.method === 'POST') {
      const state = await loadState();
      // Clear P&L counters and trade history — keep open positions and config
      state.totalPnl = 0;
      state.winCount = 0;
      state.lossCount = 0;
      state.history = [];
      state.dcaHistory = [];
      for (const s of state.strategies) {
        s.trades = 0; s.wins = 0; s.losses = 0; s.pnl = 0;
      }
      await saveState(state);
      return res.status(200).json({ success: true, message: 'Stats reset. P&L, history and strategy counters cleared.' });
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

    if (action === 'cleanup' && req.method === 'POST') {
      let deleted = 0;
      for (const prefix of ['trades/', 'activity/']) {
        let hasMore = true;
        let cursor: string | undefined;
        while (hasMore) {
          const result = await list({ prefix, cursor, limit: 1000 });
          if (result.blobs.length > 0) {
            await del(result.blobs.map(b => b.url));
            deleted += result.blobs.length;
          }
          hasMore = result.hasMore;
          cursor = result.cursor;
        }
      }
      return res.status(200).json({ success: true, deleted, message: `Deleted ${deleted} old trade/activity blobs. Trading state preserved.` });
    }

    // === DAILY COIN PICKER ===
    if (action === 'dailyPick') {
      _skipDailyCandles = false; // daily picks NEED daily candles for scoring
      const coinList = TOP_COINS;
      const batchSize = 8;
      const allSignals: SmartSignal[] = [];
      for (let i = 0; i < coinList.length; i += batchSize) {
        const batch = coinList.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(s => scanCoin(s)));
        results.forEach(r => { if (r) allSignals.push(r); });
        if (i + batchSize < coinList.length) await new Promise(r => setTimeout(r, 250));
      }
      allSignals.sort((a, b) => b.strength - a.strength);

      const btcSig = allSignals.find(s => s.symbol === 'BTC');
      const regime = detectMarketRegime(btcSig);

      // Fetch news sentiment for top coins
      const safeBuys = allSignals.filter(s => SAFE_TRADING_COINS.has(s.symbol));
      const topSymbols = safeBuys.slice(0, 20).map(s => s.symbol);
      const newsScores = await fetchNewsSentiment(topSymbols);

      // Score all safe coins
      const scored = safeBuys.map(s => ({
        ...s,
        technicalScore: computeTechnicalScore(s),
        sentimentScore: newsScores[s.symbol] ?? 50,
        moneyFlowScore: computeMoneyFlowScore(s),
        riskScore: computeRiskScore(s),
        compositeScore: 0,
      }));
      scored.forEach(s => {
        s.compositeScore = Math.round(
          s.technicalScore * 0.40 + s.sentimentScore * 0.15 +
          s.moneyFlowScore * 0.25 + s.riskScore * 0.20
        );
      });
      scored.sort((a, b) => b.compositeScore - a.compositeScore);

      // AI ranking of top 10 (if API key available)
      const top10 = scored.slice(0, 10);
      const aiRanks = await aiRankPicks(top10, regime);
      for (const ar of aiRanks) {
        const match = scored.find(s => s.symbol === ar.symbol);
        if (match) {
          (match as any).aiScore = ar.aiScore;
          (match as any).aiReason = ar.aiReason;
          // Blend AI score: 70% composite + 30% AI
          match.compositeScore = Math.round(match.compositeScore * 0.7 + ar.aiScore * 0.3);
        }
      }
      scored.sort((a, b) => b.compositeScore - a.compositeScore);
      const picks = scored.slice(0, 5);

      // Store in Redis
      const state = await loadState();
      if (!state.dailyPicks) state.dailyPicks = [];
      const today = new Date().toISOString().split('T')[0];
      state.dailyPicks.unshift({
        date: today, regime,
        picks: picks.map(p => ({
          symbol: p.symbol, price: p.price, compositeScore: p.compositeScore,
          technicalScore: p.technicalScore, sentimentScore: p.sentimentScore,
          moneyFlowScore: p.moneyFlowScore, riskScore: p.riskScore,
          action: p.action, strength: p.strength, rsi: p.rsi,
          reason: p.reason.split(' | ').slice(0, 3).join(' | '),
          aiScore: (p as any).aiScore, aiReason: (p as any).aiReason,
        })),
      });
      if (state.dailyPicks.length > 30) state.dailyPicks = state.dailyPicks.slice(0, 30);
      await saveState(state);

      // Telegram
      const tgToken = process.env.TELEGRAM_BOT_TOKEN || '';
      const tgChat = process.env.TELEGRAM_CHAT_ID?.trim().replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') || '';
      if (tgToken && tgChat) {
        const re: Record<string, string> = { strong_bull: '🟢🟢', bull: '🟢', neutral: '🟡', bear: '🔴', strong_bear: '🔴🔴' };
        const msg = `🏆 DAILY TOP PICKS — ${today}\n\n` +
          `Market: ${re[regime] || '🟡'} ${regime.toUpperCase()}\nScanned: ${allSignals.length} coins\n\n` +
          picks.map((p, i) =>
            `${['🥇','🥈','🥉','4️⃣','5️⃣'][i]} ${p.symbol} — ${p.compositeScore}/100\n` +
            `   ${formatPrice(p.price)} | RSI: ${p.rsi.toFixed(0)} | ${p.action.toUpperCase()}\n` +
            `   T:${p.technicalScore} F:${p.moneyFlowScore} R:${p.riskScore} S:${p.sentimentScore}` +
            ((p as any).aiReason ? `\n   🧠 ${(p as any).aiReason}` : '')
          ).join('\n\n');
        await sendTelegramAlert(tgToken, tgChat, msg);
      }

      return res.status(200).json({ success: true, date: today, regime, scanned: allSignals.length, picks });
    }

    // === TRACK PICKS PERFORMANCE ===
    if (action === 'trackPicks') {
      const state = await loadState();
      if (!state.dailyPicks || state.dailyPicks.length < 2) {
        return res.status(200).json({ success: true, message: 'Not enough pick data yet' });
      }
      const yesterday = state.dailyPicks[1];
      if (yesterday.tracked) {
        return res.status(200).json({ success: true, message: 'Already tracked', date: yesterday.date });
      }
      for (const pick of yesterday.picks) {
        try {
          const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pick.symbol}USDT`);
          const data = (await r.json()) as any;
          const cp = parseFloat(data.result?.list?.[0]?.lastPrice || '0');
          if (cp > 0) {
            pick.returnPercent = Math.round(((cp - pick.price) / pick.price) * 10000) / 100;
            pick.currentPrice = cp;
          }
        } catch {}
      }
      yesterday.tracked = true;
      yesterday.avgReturn = Math.round(
        yesterday.picks.reduce((sum, p) => sum + (p.returnPercent || 0), 0) / yesterday.picks.length * 100
      ) / 100;
      await saveState(state);

      const tgToken = process.env.TELEGRAM_BOT_TOKEN || '';
      const tgChat = process.env.TELEGRAM_CHAT_ID?.trim().replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') || '';
      if (tgToken && tgChat) {
        const msg = `📊 PICK PERFORMANCE — ${yesterday.date}\n\n` +
          yesterday.picks.map((p, i) =>
            `${['🥇','🥈','🥉','4️⃣','5️⃣'][i]} ${p.symbol}: ${(p.returnPercent || 0) >= 0 ? '+' : ''}${(p.returnPercent || 0).toFixed(1)}%`
          ).join('\n') +
          `\n\n📈 Avg return: ${(yesterday.avgReturn || 0) >= 0 ? '+' : ''}${(yesterday.avgReturn || 0).toFixed(1)}%`;
        await sendTelegramAlert(tgToken, tgChat, msg);
      }
      return res.status(200).json({ success: true, date: yesterday.date, avgReturn: yesterday.avgReturn });
    }

    // === DEBUG: Test trade execution pipeline (no real orders) ===
    if (action === 'debugTrade') {
      const state = await loadState();
      const client = getBybitClient();
      const debug: any = {
        configEnabled: state.config.enabled,
        bybitClient: !!client,
        strategies: state.strategies.filter(s => s.enabled).map(s => s.id),
        openPositions: state.positions.filter(p => p.status === 'open').length,
        maxTotal: state.config.maxTotal,
        minStrength: state.config.minStrength,
        minConfidence: state.config.minConfidence,
        maxDrawdownUSD: state.config.maxDrawdownUSD,
        totalPnl: state.totalPnl,
        cooldowns: state.cooldowns,
        alertTimesCount: Object.keys(state.alertTimes || {}).length,
      };
      // Check USDT
      if (client) {
        try {
          const balRes = await client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
          const usdtCoin = balRes.result?.list?.[0]?.coin?.find((c: any) => c.coin === 'USDT');
          debug.availableUSDT = parseFloat(usdtCoin?.availableToWithdraw || usdtCoin?.walletBalance || '0');
          debug.usdtSufficient = debug.availableUSDT >= state.config.positionSizeUSD;
        } catch (e: any) {
          debug.usdtError = e.message;
        }
      }
      // Quick scan top 10 coins — with detailed error capture
      const quickCoins = ['BTC','ETH','SOL','BNB','XRP','ADA','AVAX','ICP','DOT','LINK'];
      const scanErrors: Record<string, string> = {};
      const scanResults = await Promise.all(quickCoins.map(async (s) => {
        try {
          const result = await scanCoin(s);
          if (!result) scanErrors[s] = 'returned null (insufficient data or calculation error)';
          return result;
        } catch (e: any) {
          scanErrors[s] = e.message;
          return null;
        }
      }));
      debug.scanErrors = scanErrors;
      const validSignals = scanResults.filter(r => r !== null) as SmartSignal[];
      validSignals.sort((a, b) => b.strength - a.strength);
      const btcSig = validSignals.find(s => s.symbol === 'BTC');
      debug.btcScanned = !!btcSig;
      if (btcSig) {
        debug.btcMomentum = btcSig.momentum;
        debug.btcRsi = btcSig.rsi;
        debug.btcAction = btcSig.action;
        debug.btcBearish = btcSig.action === 'strong_sell' || (btcSig.momentum < -30 && btcSig.rsi < 42);
      }
      const enabledStrats = state.strategies.filter(s => s.enabled).map(s => s.id);
      debug.signalAnalysis = validSignals.map(s => {
        const matched = evaluateStrategies(s, enabledStrats);
        return {
          symbol: s.symbol, action: s.action, strength: s.strength, confidence: s.confidence,
          rsi: Math.round(s.rsi), change24h: Math.round(s.change24h * 10) / 10,
          category: s.category, strategiesMatched: matched,
          inSafeCoins: SAFE_TRADING_COINS.has(s.symbol),
          passesConfidence: s.confidence >= state.config.minConfidence,
        };
      });
      return res.status(200).json({ success: true, debug });
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

    // Skip daily candles during fast cron scans — saves ~110 API calls and ~8 seconds
    // Daily candles are only needed for dailyPick action (already handled separately)
    _skipDailyCandles = isAlertMode;

    const customCoins = req.body?.coins || req.query?.coins;
    const coinList: string[] = customCoins
      ? (typeof customCoins === 'string' ? customCoins.split(',').map((s: string) => s.trim().toUpperCase()) : customCoins)
      : TOP_COINS;

    const batchSize = 10;  // increased from 8 → 10 for faster scanning
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
      const tgChat = process.env.TELEGRAM_CHAT_ID?.trim().replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') || '';

      console.log(`[SCANNER ALERT] tgToken=${tgToken ? 'SET' : 'MISSING'}, tgChat=${tgChat ? tgChat : 'MISSING'}, signals=${allSignals.length}`);

      const state = await loadState();

      if (tgToken && tgChat && allSignals.length > 0) {
        alertsSent = await sendSignalAlerts(allSignals, tgToken, tgChat, state);
      }

      // Trade execution FIRST — activity logging happens after (non-critical)
      const client = getBybitClient();
      if (client) {
        positionsClosed = await checkAndClosePositions(state, client, tgToken, tgChat, allSignals);
        positionsClosed += await checkAndCloseDcaStacks(state, client, tgToken, tgChat);
        if (state.config.enabled) {
          tradesPlaced = await executeTrades(allSignals, state, client, tgToken, tgChat);
          tradesPlaced += await executeDcaTrades(allSignals, state, client, tgToken, tgChat);
        } else {
          await sendTelegramAlert(tgToken, tgChat, `⚙️ DEBUG: Bot disabled in Redis state — config.enabled=false. Toggle ON from dashboard and Save.`);
        }
      } else {
        await sendTelegramAlert(tgToken, tgChat, `⚙️ DEBUG: Bybit client NULL — check BYBIT_API_KEY and BYBIT_API_SECRET env vars`);
      }
      // Always save state so alertTimes persists — prevents duplicate Telegram alerts
      await saveState(state);

      // Activity log — fire-and-forget (non-blocking, after critical work is done)
      try {
        const regime = detectMarketRegime(allSignals.find(s => s.symbol === 'BTC'));
        const topBuys = allSignals.filter(s => s.action === 'buy' || s.action === 'strong_buy').slice(0, 3);
        put(`activity/cron_${Date.now()}.json`, JSON.stringify({
          id: `cron_${Date.now()}`, timestamp: new Date().toISOString(), type: 'cron_scan',
          scanned: allSignals.length, alerts: alertsSent, trades: tradesPlaced, regime,
          topSignals: topBuys.map(s => ({ symbol: s.symbol, action: s.action, strength: s.strength })),
        }), { contentType: 'application/json', access: 'public', allowOverwrite: true });
      } catch {}

      // Periodic self-diagnostic summary (every 6h) — no manual checking needed
      const hour = new Date().getUTCHours();
      const minute = new Date().getUTCMinutes();
      if (tgToken && tgChat && minute < 10 && (hour === 0 || hour === 6 || hour === 12 || hour === 18)) {
        const openPos = state.positions.filter(p => p.status === 'open');
        const openDca = state.dcaStacks.filter(s => s.status === 'open');
        const currentRegime = detectMarketRegime(allSignals.find(s => s.symbol === 'BTC'));
        const T = getAdaptiveThresholds(currentRegime);
        const regimeEmoji: Record<string,string> = { strong_bull:'🟢🟢', bull:'🟢', neutral:'🟡', bear:'🔴', strong_bear:'🔴🔴' };
        const tradeable = allSignals.filter(s => {
          const safe = SAFE_TRADING_COINS.has(s.symbol);
          const dip = s.change24h <= T.dipPercent && s.volumeAnomaly >= T.dipVolume && s.rsi < T.dipRsi;
          const rsiRev = s.rsi < T.rsiOversold;
          return safe && (dip || rsiRev || s.action === 'buy' || s.action === 'strong_buy');
        });
        const topCoins = allSignals.slice(0, 5).map(s => `  • ${s.symbol}: ${s.action} ${s.strength}%`).join('\n');
        const summary = `📊 BRAIN — ${hour}:00 UTC\n\n` +
          `${regimeEmoji[currentRegime] || '🟡'} Regime: ${currentRegime.toUpperCase()}\n` +
          `Thresholds: Dip≥${Math.abs(T.dipPercent)}% RSI<${T.rsiOversold} Vol≥${T.dipVolume}x\n\n` +
          `Scanned: ${coinList.length} | Signals: ${allSignals.length}\n` +
          `Tradeable: ${tradeable.length} coins | Trades placed: ${tradesPlaced}\n` +
          `Top:\n${topCoins || '  None'}\n\n` +
          `🤖 ${state.config.enabled ? 'ON' : '❌ OFF'} | Pos: ${openPos.length}/${state.config.maxTotal}` +
          (state.config.dcaEnabled ? ` | DCA: ${openDca.length}` : '') + `\n` +
          `P&L: ${state.totalPnl >= 0 ? '+' : ''}$${state.totalPnl.toFixed(2)} | Win: ${state.totalTrades > 0 ? Math.round((state.winCount / state.totalTrades) * 100) : 0}% (${state.totalTrades}t)`;
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
