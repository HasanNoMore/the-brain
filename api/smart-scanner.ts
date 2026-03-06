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
  // Removed: scanner_signal (circular logic), supertrend_ride (too many false flips in choppy markets), vwap_reclaim (incompatible with cron architecture)
  { id: 'rsi_reversal',     name: 'RSI Reversal',        description: 'RSI < 30 (real oversold) + 1h RSI higher than 4h (bounce started) + daily RSI < 40 — no adaptive loosening in bear' },
  { id: 'bollinger_bounce', name: 'Bollinger Bounce',    description: 'Price at lower BB + StochRSI < 20 or bullish divergence required — BB squeeze release excluded' },
  { id: 'dip_buyer',        name: 'Dip Buyer',           description: 'Real dip: -5% minimum (-8% in bear), volume > 2x, RSI < 30, StochRSI < 20, last hour recovering — STRICTER in bear' },
  { id: 'early_gainer',     name: 'Early Gainer',        description: '3x+ hourly volume spike with 1%+ price gain and RSI 40-65 — fixed threshold, no adaptive loosening' },
  { id: 'dca_accumulator',  name: 'DCA Accumulator',     description: 'Dollar Cost Averaging — buys dips at set intervals, stacks into position, exits at avg-price profit target' },
  { id: 'divergence_play',  name: 'Divergence Play',     description: 'Bullish RSI divergence + CMF > 0 (money flow confirms) + volume confirmation — blocked in strong_bear' },
  { id: 'smart_money',      name: 'Smart Money',         description: 'OBV breakout + CMF > 0.10 (meaningful buying, not noise) + volume 1.5x+ + OBV trend positive' },
  { id: 'panic_reversal',   name: 'Panic Reversal',      description: 'Extreme panic: -5%+ hourly drop, 3x+ volume, RSI < 20 AND StochRSI < 10 — triggers 2-3x/month max' },
];

// ============================================================
// ADAPTIVE STRATEGY ENGINE
// Thresholds auto-adjust based on market regime — no manual tuning needed
// Bear market: looser filters to catch real oversold opportunities
// Bull market: tighter filters to avoid chasing
// ============================================================
function getAdaptiveThresholds(regime: MarketRegime) {
  // FIXED: Bear markets are STRICTER, not looser.
  // Higher volatility = higher bar to enter. The old logic was backwards.
  const t = {
    // Scanner strength (scanner_signal removed — kept for any future use)
    scannerStrength:    regime === 'strong_bull' ? 55 : regime === 'bull' ? 50 : 45,
    // RSI oversold: stricter in bear (require MORE oversold to enter)
    rsiOversold:        regime === 'strong_bear' ? 25 : regime === 'bear' ? 28 : regime === 'neutral' ? 32 : 38,
    // Dip buyer: require BIGGER drop in bear markets
    dipPercent:         regime === 'strong_bear' ? -10 : regime === 'bear' ? -8 : regime === 'neutral' ? -5 : -3,
    // Dip buyer: require MORE volume confirmation in bear
    dipVolume:          regime === 'strong_bear' ? 2.5 : regime === 'bear' ? 2.0 : 1.0,
    // Dip buyer: require MORE oversold RSI in bear
    dipRsi:             regime === 'strong_bear' ? 22 : regime === 'bear' ? 28 : 35,
    // Early gainer: require STRONGER volume spike in bear (noise filter)
    earlyGainerVol:     regime === 'strong_bear' ? 5.0 : regime === 'bear' ? 4.0 : regime === 'neutral' ? 3.0 : 2.5,
    // Bollinger RSI: require MORE oversold in bear
    bbRsi:              regime === 'strong_bear' ? 28 : regime === 'bear' ? 32 : regime === 'neutral' ? 38 : 45,
    // Panic reversal: fixed thresholds — never loosened
    panicDrop:          -5.0,
    panicRsi:           20,
    panicVol:           3.0,
  };
  return t;
}

// Current regime — set by executeTrades before strategy evaluation
let _currentRegime: MarketRegime = 'neutral';

function evaluateStrategies(sig: SmartSignal, enabledStrategies: string[]): string[] {
  const matched: string[] = [];
  // Removed: scanner_signal (circular logic), supertrend_ride (false flips in choppy markets), vwap_reclaim (needs real-time, incompatible with cron)

  // 1. RSI Reversal — hard thresholds, no adaptive loosening in bear markets
  if (enabledStrategies.includes('rsi_reversal')) {
    if (
      sig.rsi < 30 &&          // real oversold — not adaptive (old: up to 45 in strong_bear)
      sig.rsi1h > sig.rsi &&   // 1h RSI higher than 4h RSI: bounce already started
      sig.dailyRsi < 40 &&     // macro context agrees: daily also oversold
      sig.change1h > -5        // not in a live crash right now
    ) {
      matched.push('rsi_reversal');
    }
  }

  // 2. Bollinger Bounce — requires reversal confirmation, not just touching the band
  if (enabledStrategies.includes('bollinger_bounce')) {
    if (
      sig.price <= sig.bollingerLower * 1.015 &&      // at or below lower BB
      (sig.stochRsi < 20 || sig.bullDivergence) &&    // reversal signal required — old code had none
      sig.momentum > -50 &&                            // not in free fall
      sig.change1h > -3 &&                             // slight recovery or stabilizing
      !sig.bbSqueezeRelease                            // BB expanding = trend continuation, not reversal
    ) {
      matched.push('bollinger_bounce');
    }
  }

  // 3. Dip Buyer — STRICTER in bear, not looser (old logic was backwards)
  if (enabledStrategies.includes('dip_buyer')) {
    const dipThreshold = (_currentRegime === 'bear' || _currentRegime === 'strong_bear') ? -8 : -5;
    if (
      sig.change24h <= dipThreshold &&  // real dip: -5% normal, -8% in bear (old: -2.5% in strong_bear)
      sig.volumeAnomaly >= 2.0 &&       // real capitulation (old: 0.3x in strong_bear)
      sig.rsi < 30 &&                   // deeply oversold
      sig.stochRsi < 20 &&              // confirmed oversold
      sig.change1h > 0                  // last hour showing recovery — not still falling
    ) {
      matched.push('dip_buyer');
    }
  }

  // 4. Early Gainer — fixed 3x minimum, no adaptive loosening
  if (enabledStrategies.includes('early_gainer')) {
    if (
      sig.hourlyVolSpike >= 3.0 &&      // real unusual activity (old: 1.5x in strong_bear)
      sig.change1h > 1.0 &&             // price actually moving up (old: 0.2%)
      sig.rsi >= 40 && sig.rsi < 65     // not overbought, not deeply oversold
    ) {
      matched.push('early_gainer');
    }
  }

  // 5. Divergence Play — improved: money flow + volume confirmation + blocked in strong_bear
  if (enabledStrategies.includes('divergence_play')) {
    if (
      sig.bullDivergence &&
      sig.cmf > 0 &&                    // money flow confirms (old: not checked)
      sig.volumeAnomaly > 1.0 &&        // volume confirms the divergence (old: not checked)
      sig.rsi < 60 &&
      _currentRegime !== 'strong_bear'  // no divergence trades in strong bear (old: not checked)
    ) {
      matched.push('divergence_play');
    }
  }

  // 6. Smart Money — tightened: CMF 0.10 minimum, OBV trend confirmed
  if (enabledStrategies.includes('smart_money')) {
    if (
      sig.obvBreakout &&
      sig.cmf > 0.10 &&               // meaningful buying (old: 0.03 — too low, any bull had this)
      sig.volumeAnomaly >= 1.5 &&     // confirms OBV breakout is real (old: not checked)
      sig.obvTrend > 0 &&             // OBV in uptrend (old: not checked)
      sig.rsi < 70
    ) {
      matched.push('smart_money');
    }
  }

  // 7. Panic Reversal — fixed strict thresholds, no adaptive loosening
  if (enabledStrategies.includes('panic_reversal')) {
    if (
      sig.change1h <= -5.0 &&         // real panic (old: -2.0% in strong_bear — just normal volatility)
      sig.volumeAnomaly >= 3.0 &&     // actual capitulation (old: 1.2x in strong_bear)
      sig.rsi < 20 &&                 // extreme oversold (old: < 30 in strong_bear)
      sig.stochRsi < 10               // confirmed extreme (old: < 20)
    ) {
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
  slOrderId?: string;  // Bybit server-side conditional SL order ID
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

// 8 kept strategies — scanner_signal, supertrend_ride, vwap_reclaim removed per STRATEGY_PLAN.md
const DEFAULT_ENABLED_STRATEGIES = new Set([
  'rsi_reversal',      // RSI < 30 + 1h RSI recovery + daily RSI < 40
  'bollinger_bounce',  // Lower BB + StochRSI < 20 or divergence required
  'dip_buyer',         // -5% min (-8% in bear), 2x vol, RSI < 30, recovering
  'early_gainer',      // 3x+ hourly vol spike, 1%+ price gain, RSI 40-65
  'dca_accumulator',   // DCA into whitelisted coins
  'divergence_play',   // Bullish divergence + CMF + volume confirmation
  'smart_money',       // OBV breakout + CMF > 0.10 + vol 1.5x+
  'panic_reversal',    // -5%+ hourly, 3x vol, RSI < 20, StochRSI < 10
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

// _stateLoadedFromRedis: true = safe to trade, false = Redis failed → block all trades
let _stateLoadedFromRedis = false;

async function loadState(): Promise<TradingState> {
  _stateLoadedFromRedis = false;
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
        _stateLoadedFromRedis = true;
        return state;
      }
    }
  } catch {}
  // Redis failed — return safe shell with trading DISABLED to prevent wrong-amount trades
  console.error('[STATE] Redis load FAILED — trading blocked until state is verified');
  return {
    config: { ...DEFAULT_CONFIG, enabled: false },
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

async function saveState(state: TradingState, tgToken?: string, tgChat?: string): Promise<void> {
  if (state.history.length > 200) state.history = state.history.slice(-200);
  const now = Date.now();
  for (const [sym, ts] of Object.entries(state.cooldowns)) {
    if (now - new Date(ts).getTime() > state.config.cooldownHours * 3600000) {
      delete state.cooldowns[sym];
    }
  }
  const body = JSON.stringify(state);
  const doSave = () => fetch(`${UPSTASH_URL}/set/${REDIS_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body,
  });

  // Bug #9 fix: retry once on failure. If both fail, send emergency Telegram alert.
  // A failed save after a real trade = bot forgets the position = no SL/TP ever executes.
  let r = await doSave();
  if (!r.ok) {
    await new Promise(res => setTimeout(res, 2000));
    r = await doSave();
  }
  if (!r.ok) {
    const err = await r.text().catch(() => 'unknown');
    console.error(`[STATE] Redis save FAILED after retry: HTTP ${r.status} — ${err}`);
    if (tgToken && tgChat) {
      await sendTelegramAlert(tgToken, tgChat,
        `🚨 CRITICAL: STATE SAVE FAILED\n\nOpen positions may not be tracked!\nBot cannot manage SL/TP until state is restored.\nHTTP ${r.status} — ${err}\n\nCheck bot immediately.`);
    }
  }
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
  // Bug #4 fix: if AI Brain is enabled but can't be reached for ANY reason, default to REJECT.
  // Approving on error means every API failure = unfiltered trade. That's dangerous.
  if (!apiKey) return { action: 'REJECT', confidence: 0, reasoning: 'AI Brain enabled but ANTHROPIC_API_KEY not configured' };
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
    if (!response.ok) return { action: 'REJECT', confidence: 0, reasoning: `AI API error: HTTP ${response.status}` };
    const d = (await response.json()) as any;
    const text = d.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { const p = JSON.parse(m[0]); return { action: p.action || 'REJECT', confidence: p.confidence ?? 0, reasoning: p.reasoning || '' }; }
    return { action: 'REJECT', confidence: 0, reasoning: 'AI response could not be parsed — trade blocked for safety' };
  } catch (e: any) {
    return { action: 'REJECT', confidence: 0, reasoning: `AI unreachable: ${e.message}` };
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

// Dynamic price rounding — avoids SL/TP being rounded to same value for low-price coins
function roundPrice(p: number): number {
  if (p >= 1000) return Math.round(p * 100) / 100;   // $1234.56
  if (p >= 100)  return Math.round(p * 100) / 100;   // $123.45
  if (p >= 10)   return Math.round(p * 1000) / 1000; // $12.345
  if (p >= 1)    return Math.round(p * 1000) / 1000; // $1.234
  if (p >= 0.1)  return Math.round(p * 10000) / 10000; // $0.1234
  if (p >= 0.01) return Math.round(p * 100000) / 100000; // $0.01234
  return Math.round(p * 1000000) / 1000000; // $0.001234
}

async function sendSignalAlerts(signals: SmartSignal[], tgToken: string, tgChat: string, state: TradingState) {
  let alertsSent = 0;
  const MAX_ALERTS_PER_RUN = 2;            // max 2 alerts per cron cycle
  const ALERT_TTL_MS = 12 * 60 * 60 * 1000; // 12h dedup — same coin won't alert twice in 12h
  const now = Date.now();

  if (!state.alertTimes) state.alertTimes = {};
  const at = state.alertTimes;

  // Prune old entries
  for (const k of Object.keys(at)) {
    if (now - at[k] > 24 * 3600000) delete at[k];
  }

  // Only strongest early gainers (strength >= 70, not just 55)
  const earlyGainers = signals.filter(s => s.category === 'early_gainer' && s.strength >= 70);
  for (const s of earlyGainers) {
    if (alertsSent >= MAX_ALERTS_PER_RUN) break;
    const key = `${s.symbol}_early_gainer`;
    if (at[key] && now - at[key] < ALERT_TTL_MS) continue;
    at[key] = now;
    const msg = `🚨 EARLY GAINER\n\n${s.symbol} @ ${formatPrice(s.price)}\n` +
      `1h: ${s.change1h >= 0 ? '+' : ''}${s.change1h}% | Vol: ${s.volumeAnomaly.toFixed(1)}x\n` +
      `Strength: ${s.strength}% | RSI: ${s.rsi.toFixed(0)}\n${s.signals.slice(0,3).join(' | ')}`;
    await sendTelegramAlert(tgToken, tgChat, msg);
    alertsSent++;
  }

  // Only real breakouts (strength >= 70)
  if (alertsSent < MAX_ALERTS_PER_RUN) {
    const breakouts = signals.filter(s => s.category === 'breakout' && s.strength >= 70);
    for (const s of breakouts) {
      if (alertsSent >= MAX_ALERTS_PER_RUN) break;
      const key = `${s.symbol}_breakout`;
      if (at[key] && now - at[key] < ALERT_TTL_MS) continue;
      at[key] = now;
      const msg = `📈 BREAKOUT\n\n${s.symbol} @ ${formatPrice(s.price)}\n` +
        `24h: ${s.change24h >= 0 ? '+' : ''}${s.change24h}% | Str: ${s.strength}%\n${s.reason.split(' | ')[0]}`;
      await sendTelegramAlert(tgToken, tgChat, msg);
      alertsSent++;
    }
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
          pos.stopLoss = roundPrice(trailSL);
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
        // Cancel server-side SL order first to prevent double-sell
        if (pos.slOrderId) {
          try {
            await client.cancelOrder({ category: 'spot', symbol: `${pos.symbol}USDT`, orderId: pos.slOrderId });
          } catch {}
        }

        // Bug #2 fix: check actual wallet balance before selling — pos.qty can drift from real balance
        // Use walletBalance (total including locked in orders) NOT availableToWithdraw (which excludes coins locked in SL orders)
        let sellQty = pos.qty;
        try {
          const balRes = await client.getWalletBalance({ accountType: 'UNIFIED', coin: pos.symbol });
          const coinBal = balRes.result?.list?.[0]?.coin?.find((c: any) => c.coin === pos.symbol);
          const totalQty = parseFloat(coinBal?.walletBalance || '0');
          const availableQty = parseFloat(coinBal?.availableToWithdraw || '0');
          if (totalQty <= 0) {
            // Ghost position — coin truly not in wallet at all, calculate real P&L
            const pnl = (currentPrice - pos.entryPrice) * pos.qty;
            const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
            pos.status = 'closed_manual';
            pos.closePrice = currentPrice;
            pos.closeTime = new Date().toISOString();
            pos.pnl = Math.round(pnl * 100) / 100;
            pos.pnlPercent = Math.round(pnlPct * 100) / 100;
            state.positions = state.positions.filter(p => p.id !== pos.id);
            state.history.push(pos);
            state.totalPnl = Math.round((state.totalPnl + pnl) * 100) / 100;
            state.totalTrades++;
            if (pnl >= 0) state.winCount++; else state.lossCount++;
            if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat,
              `⚠️ GHOST POSITION PURGED | ${pos.symbol}\nCoin not in wallet — P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`);
            continue;
          }
          // Cancel server-side SL order first to free locked coins, then use available balance
          if (pos.slOrderId) {
            try { await client.cancelOrder({ category: 'spot', symbol: `${pos.symbol}USDT`, orderId: pos.slOrderId }); } catch {}
          }
          sellQty = Math.min(pos.qty, totalQty);
        } catch {}

        const closeResult = await client.submitOrder({
          category: 'spot', symbol: `${pos.symbol}USDT`, side: 'Sell', orderType: 'Market', qty: String(sellQty),
        });

        if (closeResult.retCode !== 0) {
          console.error(`[AUTO-TRADE] Sell order failed for ${pos.symbol}: ${closeResult.retMsg}`);
        } else {
          const pnl = (currentPrice - pos.entryPrice) * sellQty;
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
  // SAFETY: if Redis failed to load, _stateLoadedFromRedis=false — never trade with fallback defaults
  if (!_stateLoadedFromRedis) {
    if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat,
      `🛑 TRADE BLOCKED — Redis state failed to load. Bot will not trade until state is verified.\nCheck Upstash dashboard.`);
    return 0;
  }

  const config = state.config;
  if (!config.enabled) return 0;

  const enabledStrategies = state.strategies.filter(s => s.enabled).map(s => s.id);
  if (enabledStrategies.length === 0) return 0;

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
        qty: String(positionSizeUSD), marketUnit: 'quoteCoin', // Bug #7 fix: use AI-modified size if set
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
        // Bug #5 fix: market orders fill instantly and disappear from getActiveOrders.
        // getHistoricOrders returns completed orders with real fill qty and avg price.
        await new Promise(r => setTimeout(r, 500));
        const orderRes = await client.getHistoricOrders({
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
      // ATR-based SL: use 2x ATR% if it's wider than the configured SL, capped at 2x configured SL.
      // Prevents getting stopped out by normal volatility on high-ATR coins.
      const atrSlPercent = sig.atrPercent > 0
        ? Math.min(sig.atrPercent * 2, config.stopLossPercent * 2)
        : config.stopLossPercent;
      const finalSlPercent = Math.max(config.stopLossPercent, atrSlPercent);
      const stopLoss = roundPrice(fillPrice * (1 - finalSlPercent / 100));
      const takeProfit = roundPrice(fillPrice * (1 + config.takeProfitPercent / 100));

      const stratName = state.strategies.find(s => s.id === strategyId)?.name || strategyId;

      const tp1Price = config.tp1Percent > 0 ? roundPrice(fillPrice * (1 + config.tp1Percent / 100)) : undefined;

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

      // Bug #1 fix: Place server-side conditional SL on Bybit immediately after buy.
      // This fires even if the cron is delayed, not relying on 5-min polling.
      try {
        const slResult = await client.submitOrder({
          category: 'spot', symbol: `${sig.symbol}USDT`, side: 'Sell',
          orderType: 'Market', qty: String(fillQty),
          triggerPrice: String(stopLoss),
          triggerDirection: 2, // 2 = triggers when price falls AT or BELOW triggerPrice
          orderFilter: 'tpslOrder',
        });
        if (slResult.retCode === 0) {
          position.slOrderId = slResult.result?.orderId;
        } else {
          console.error(`[SL-ORDER] Failed for ${sig.symbol}: ${slResult.retMsg}`);
          if (tgToken && tgChat) await sendTelegramAlert(tgToken, tgChat,
            `⚠️ SERVER SL FAILED | ${sig.symbol}\nFalling back to cron-only SL\nError: ${slResult.retMsg}`);
        }
      } catch (e: any) {
        console.error(`[SL-ORDER] Exception for ${sig.symbol}:`, e.message);
      }

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

      // Cancel server-side SL order before selling to prevent double-sell
      if (pos.slOrderId) {
        try {
          await client.cancelOrder({ category: 'spot', symbol: `${pos.symbol}USDT`, orderId: pos.slOrderId });
        } catch {}
      }

      // Bug #2 fix: check actual wallet balance before selling (use walletBalance not availableToWithdraw)
      let emergencySellQty = pos.qty;
      try {
        const balRes = await client.getWalletBalance({ accountType: 'UNIFIED', coin: pos.symbol });
        const coinBal = balRes.result?.list?.[0]?.coin?.find((c: any) => c.coin === pos.symbol);
        const totalQty = parseFloat(coinBal?.walletBalance || '0');
        if (totalQty <= 0) {
          // Ghost position — calculate real P&L from market price
          const pnl = (currentPrice - pos.entryPrice) * pos.qty;
          const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
          errors.push(`${pos.symbol}: ghost — P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
          pos.status = 'closed_emergency';
          pos.closePrice = currentPrice;
          pos.closeTime = new Date().toISOString();
          pos.pnl = Math.round(pnl * 100) / 100;
          pos.pnlPercent = Math.round(pnlPct * 100) / 100;
          state.history.push(pos);
          state.totalPnl = Math.round((state.totalPnl + pnl) * 100) / 100;
          state.totalTrades++;
          if (pnl >= 0) state.winCount++; else state.lossCount++;
          continue;
        }
        emergencySellQty = Math.min(pos.qty, totalQty);
      } catch {}

      const sellResult = await client.submitOrder({
        category: 'spot', symbol: `${pos.symbol}USDT`, side: 'Sell', orderType: 'Market', qty: String(emergencySellQty),
      });

      if (sellResult.retCode !== 0) {
        errors.push(`${pos.symbol}: ${sellResult.retMsg}`);
      } else {
        const pnl = (currentPrice - pos.entryPrice) * emergencySellQty;
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
        existingStack.takeProfit = roundPrice(existingStack.avgEntryPrice * (1 + config.dcaTakeProfitPercent / 100));
        existingStack.stopLoss = roundPrice(existingStack.avgEntryPrice * (1 - config.dcaStopLossPercent / 100));
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
      await saveState(state, tgToken, tgChat);
      return res.status(200).json({ success: true, ...result });
    }

    // Force-clears ghost positions from state without placing sell orders (use when coins aren't in wallet)
    if (action === 'purgePositions' && req.method === 'POST') {
      const state = await loadState();
      const client = getBybitClient();
      const open = state.positions.filter(p => p.status === 'open');
      const now = new Date().toISOString();
      for (const pos of open) {
        // Fetch current market price for accurate P&L instead of faking $0
        let currentPrice = pos.entryPrice;
        if (client) {
          try {
            const tickerRes = await client.getTickers({ category: 'spot', symbol: `${pos.symbol}USDT` });
            if (tickerRes.retCode === 0 && tickerRes.result?.list?.[0])
              currentPrice = parseFloat((tickerRes.result.list[0] as any).lastPrice || '0') || pos.entryPrice;
          } catch {}
        }
        const pnl = (currentPrice - pos.entryPrice) * pos.qty;
        const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pos.status = 'closed_manual' as any;
        pos.closePrice = currentPrice;
        pos.closeTime = now;
        pos.pnl = Math.round(pnl * 100) / 100;
        pos.pnlPercent = Math.round(pnlPercent * 100) / 100;
        state.history.push(pos);
        state.totalPnl = Math.round((state.totalPnl + pnl) * 100) / 100;
        state.totalTrades++;
        if (pnl >= 0) state.winCount++; else state.lossCount++;
      }
      state.positions = state.positions.filter(p => p.status === 'open');
      state.dcaStacks = (state.dcaStacks || []).map(s => ({ ...s, status: 'closed' as any }));
      state.config.enabled = false;
      await saveState(state);
      return res.status(200).json({ success: true, purged: open.length, message: `Cleared ${open.length} ghost positions. Bot disabled.` });
    }

    // Re-sync: scan wallet for coins that are in history (closed_manual with pnl=0) but still held.
    // Re-injects them as active positions with correct SL/TP from current config.
    if (action === 'resyncPositions' && req.method === 'POST') {
      const state = await loadState();
      const client = getBybitClient();
      if (!client) return res.status(500).json({ error: 'Bybit not configured' });
      const config = state.config;

      // Get wallet balances
      const balRes = await client.getWalletBalance({ accountType: 'UNIFIED' });
      const walletCoins = balRes.result?.list?.[0]?.coin || [];
      const heldCoins: Record<string, { qty: number; usdValue: number }> = {};
      for (const c of walletCoins as any[]) {
        const qty = parseFloat(c.walletBalance || '0');
        const usd = parseFloat(c.usdValue || '0');
        if (usd > 1 && c.coin !== 'USDT') heldCoins[c.coin] = { qty, usdValue: usd };
      }

      // Find closed_manual trades with pnl=0 whose coin is still in wallet
      const alreadyTracked = new Set(state.positions.filter(p => p.status === 'open').map(p => p.symbol));
      let resynced = 0;
      const results: string[] = [];

      // Collect entries to remove after loop (avoid splice-during-iteration bug)
      const toRemove: number[] = [];
      for (let i = 0; i < state.history.length; i++) {
        const hist = state.history[i];
        if (hist.status !== 'closed_manual') continue;
        const sym = hist.symbol;
        if (!heldCoins[sym] || alreadyTracked.has(sym)) continue;

        // Get current price
        let currentPrice = hist.entryPrice;
        try {
          const tickerRes = await client.getTickers({ category: 'spot', symbol: `${sym}USDT` });
          if (tickerRes.retCode === 0 && tickerRes.result?.list?.[0])
            currentPrice = parseFloat((tickerRes.result.list[0] as any).lastPrice || '0') || hist.entryPrice;
        } catch {}

        // Re-create position with correct SL/TP from current config
        const entryPrice = hist.entryPrice;
        const qty = heldCoins[sym].qty;
        const stopLoss = roundPrice(entryPrice * (1 - config.stopLossPercent / 100));
        const takeProfit = roundPrice(entryPrice * (1 + config.takeProfitPercent / 100));
        const tp1 = config.tp1Percent > 0 ? roundPrice(entryPrice * (1 + config.tp1Percent / 100)) : undefined;

        const newPos: Position = {
          id: `resync_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          symbol: sym,
          entryPrice,
          qty,
          usdValue: Math.round(currentPrice * qty * 100) / 100,
          entryTime: hist.entryTime,
          orderId: hist.orderId || '',
          stopLoss,
          takeProfit,
          status: 'open',
          peakPrice: Math.max(currentPrice, hist.peakPrice || currentPrice),
          tp1,
          tp1Hit: false,
          signal: hist.signal,
          strategy: hist.strategy,
        };

        state.positions.push(newPos);
        alreadyTracked.add(sym);
        resynced++;
        results.push(`${sym}: entry $${entryPrice} | SL $${stopLoss} (-${config.stopLossPercent}%) | TP $${takeProfit} (+${config.takeProfitPercent}%)`);
        toRemove.push(i);
      }
      // Remove history entries in reverse order to preserve indices
      for (let i = toRemove.length - 1; i >= 0; i--) {
        state.history.splice(toRemove[i], 1);
      }

      // Place server-side SL orders on Bybit for each re-synced position
      for (const pos of state.positions.filter(p => p.status === 'open' && p.id.startsWith('resync_'))) {
        try {
          const slResult = await client.submitOrder({
            category: 'spot', symbol: `${pos.symbol}USDT`, side: 'Sell',
            orderType: 'Market', qty: String(pos.qty),
            triggerPrice: String(pos.stopLoss),
            triggerDirection: 2,
            orderFilter: 'tpslOrder',
          });
          if (slResult.retCode === 0) pos.slOrderId = slResult.result?.orderId;
        } catch {}
      }

      await saveState(state);
      return res.status(200).json({ success: true, resynced, positions: results });
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

    // === COIN INSIGHT ===
    if (action === 'coinInsight') {
      const rawSym = ((req.query?.symbol as string) || '').toUpperCase().replace(/USDT$/i, '').trim();
      if (!rawSym) return res.status(400).json({ error: 'symbol required — e.g. ?action=coinInsight&symbol=BTC' });

      // Fetch 4 timeframes + Fear & Greed concurrently
      const [tf15m, tf1h, tf4h, tf1d, fgRes] = await Promise.all([
        fetchKlines(rawSym, '15', 96),
        fetchKlines(rawSym, '1h', 48),
        fetchKlines(rawSym, '4h', 200),
        fetchKlines(rawSym, '1d', 30),
        fetch('https://api.alternative.me/fng/?limit=1').then(r => r.json()).catch(() => ({ data: [{ value: '50', value_classification: 'Neutral' }] })),
      ]) as [Candle[], Candle[], Candle[], Candle[], any];

      if (tf4h.length < 50) return res.status(404).json({ error: `No market data for ${rawSym}. Check the symbol.` });

      const price   = tf4h[tf4h.length - 1].close;
      const prev24h = tf4h.length >= 7 ? tf4h[tf4h.length - 7].close : tf4h[0].close;
      const ch24h   = ((price - prev24h) / prev24h) * 100;
      const prev7d  = tf1d.length >= 8 ? tf1d[tf1d.length - 8].close : (tf1d[0]?.close || price);
      const ch7d    = tf1d.length > 0 ? ((price - prev7d) / prev7d) * 100 : 0;
      const fearGreed = { value: parseInt(fgRes?.data?.[0]?.value || '50'), label: fgRes?.data?.[0]?.value_classification || 'Neutral' };

      // ── 15m ──
      const c15   = tf15m.map(c => c.close);
      const rsi15 = computeRSI(c15);
      const st15  = computeSupertrend(tf15m);
      const mac15 = macd(c15);

      // ── 1h ──
      const c1h   = tf1h.map(c => c.close);
      const rsi1h = computeRSI(c1h);
      const st1h  = computeSupertrend(tf1h);
      const mac1h = macd(c1h);

      // ── 4h ──
      const c4h    = tf4h.map(c => c.close);
      const rsi4h  = computeRSI(c4h);
      const st4h   = computeSupertrend(tf4h);
      const mac4h  = macd(c4h);
      const bb4h   = bollingerBands(c4h);
      const e9_ci  = ema(c4h, 9).slice(-1)[0];
      const e21_ci = ema(c4h, 21).slice(-1)[0];
      const e50_ci = ema(c4h, 50).slice(-1)[0];
      const atr4h  = computeATR(tf4h);
      const atrPct = (atr4h / price) * 100;
      const vols4h = tf4h.map(c => c.volume);
      const volAvg = vols4h.slice(-43, -1).reduce((a: number, b: number) => a + b, 0) / 42;
      const volX   = volAvg > 0 ? vols4h[vols4h.length - 1] / volAvg : 1;

      // StochRSI on 4h
      const rsiSeries4h: number[] = [];
      for (let i = 14; i <= c4h.length; i++) rsiSeries4h.push(computeRSI(c4h.slice(0, i)));
      let stoch4h = 50;
      if (rsiSeries4h.length >= 14) {
        const rec = rsiSeries4h.slice(-14), mn = Math.min(...rec), mx = Math.max(...rec);
        if (mx !== mn) stoch4h = Math.round(((rsiSeries4h[rsiSeries4h.length - 1] - mn) / (mx - mn)) * 100);
      }
      const bbPos = price < bb4h.lower * 1.005 ? 'oversold' : price > bb4h.upper * 0.995 ? 'overbought' : 'neutral';

      // ── 1D ──
      const c1d    = tf1d.map(c => c.close);
      const rsi1d  = computeRSI(c1d);
      const e7d    = ema(c1d, 7).slice(-1)[0];
      const e21d   = ema(c1d, Math.min(21, c1d.length)).slice(-1)[0];
      const dayTrend = e7d > e21d * 1.005 ? 'up' : e7d < e21d * 0.995 ? 'down' : 'sideways';
      const sup30  = Math.min(...tf1d.map(c => c.low));
      const res30  = Math.max(...tf1d.map(c => c.high));

      // Bullish alignment score
      let bullScore = 0;
      if (st15.bullish)                  bullScore++;
      if (st1h.bullish)                  bullScore++;
      if (st4h.bullish)                  bullScore++;
      if (dayTrend === 'up')             bullScore++;
      if (rsi15 > 50 && rsi15 < 75)     bullScore++;
      if (rsi1h > 50 && rsi1h < 75)     bullScore++;
      if (rsi4h > 50 && rsi4h < 72)     bullScore++;
      if (rsi1d > 50 && rsi1d < 70)     bullScore++;
      if (mac4h.hist > 0)                bullScore++;
      if (e9_ci > e21_ci)                bullScore++;

      // ── CoinGecko: ATH/ATL + year-by-year history (concurrent, graceful fail) ──
      const CG_IDS: Record<string, string> = {
        BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin', XRP:'ripple',
        ADA:'cardano', AVAX:'avalanche-2', DOT:'polkadot', LINK:'chainlink', ATOM:'cosmos',
        LTC:'litecoin', NEAR:'near', ARB:'arbitrum', OP:'optimism', INJ:'injective-protocol',
        SUI:'sui', AAVE:'aave', MKR:'maker', TRX:'tron', XLM:'stellar', JUP:'jupiter',
        MATIC:'matic-network', UNI:'uniswap', DOGE:'dogecoin', SHIB:'shiba-inu',
        TON:'the-open-network', HBAR:'hedera-hashgraph', ICP:'internet-computer',
        APT:'aptos', SEI:'sei-network', WIF:'dogwifcoin', BONK:'bonk',
        PEPE:'pepe', FTM:'fantom', CRV:'curve-dao-token', LDO:'lido-dao',
        HYPE:'hyperliquid',
      };
      const cgId = CG_IDS[rawSym] || rawSym.toLowerCase();
      const cgBase = 'https://api.coingecko.com/api/v3';

      const [cgMarket, cgChart] = await Promise.all([
        fetch(`${cgBase}/coins/${cgId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`)
          .then(r => r.ok ? r.json() as Promise<any> : null).catch(() => null),
        fetch(`${cgBase}/coins/${cgId}/market_chart?vs_currency=usd&days=max&interval=daily`)
          .then(r => r.ok ? r.json() as Promise<any> : null).catch(() => null),
      ]) as [any, any];

      let historical: any = null;
      if (cgMarket?.market_data) {
        const md = cgMarket.market_data;
        const ath = md.ath?.usd || 0;
        const atl = md.atl?.usd || 0;
        const athDate = md.ath_date?.usd ? md.ath_date.usd.split('T')[0] : null;
        const atlDate = md.atl_date?.usd ? md.atl_date.usd.split('T')[0] : null;
        const fromAthPct = md.ath_change_percentage?.usd || 0;
        const toAthPct  = ath > price ? Math.round(((ath - price) / price) * 10000) / 100 : 0;

        // Year-by-year: last price of each calendar year
        const yearMap: Record<string, number> = {};
        if (cgChart?.prices?.length) {
          for (const [ts, p] of cgChart.prices) {
            const yr = new Date(ts).getFullYear().toString();
            yearMap[yr] = p; // keeps overwriting → last price of year
          }
          // Current year → use live price
          yearMap[new Date().getFullYear().toString()] = price;
        }
        const yearlyPrices = Object.entries(yearMap)
          .sort(([a], [b]) => parseInt(a) - parseInt(b))
          .map(([year, p]) => ({ year, price: Math.round(p * 1000) / 1000 }));

        // Launch info
        const launchTs   = cgChart?.prices?.[0]?.[0];
        const launchP    = cgChart?.prices?.[0]?.[1];
        const launchDate = launchTs ? new Date(launchTs).toISOString().split('T')[0] : null;
        const allTimeReturn = launchP && launchP > 0 ? Math.round(((price - launchP) / launchP) * 100) : null;

        // Fibonacci recovery targets (from current price up toward ATH)
        const range = ath - price;
        const fib236 = range > 0 ? Math.round((price + range * 0.236) * 10000) / 10000 : null;
        const fib382 = range > 0 ? Math.round((price + range * 0.382) * 10000) / 10000 : null;
        const fib618 = range > 0 ? Math.round((price + range * 0.618) * 10000) / 10000 : null;

        historical = {
          ath:  Math.round(ath * 10000) / 10000,
          atl:  Math.round(atl * 10000) / 10000,
          athDate, atlDate,
          fromAthPct: Math.round(fromAthPct * 100) / 100,
          toAthPct,
          yearlyPrices,
          launchDate, launchPrice: launchP ? Math.round(launchP * 10000000) / 10000000 : null,
          allTimeReturn,
          fibTargets: { fib236, fib382, fib618, ath: Math.round(ath * 10000) / 10000 },
          marketCap: md.market_cap?.usd || null,
          rank: cgMarket.market_cap_rank || null,
        };
      }

      // Check if user holds this coin
      let position: { entryPrice: number; qty: number; pnlPct: number } | null = null;
      try {
        const st = await loadState();
        const pos = st.positions.find(p => p.symbol === rawSym && p.status === 'open');
        if (pos) position = { entryPrice: pos.entryPrice, qty: pos.qty, pnlPct: ((price - pos.entryPrice) / pos.entryPrice) * 100 };
      } catch {}

      // AI Analysis via Claude Haiku
      const posCtx = position
        ? `\nYOU HOLD ${rawSym}: Entry $${position.entryPrice.toFixed(4)} | Unrealized P&L: ${position.pnlPct.toFixed(2)}%`
        : '\nNo existing position.';

      const insightPrompt = `You are a professional crypto trader. Analyze ${rawSym}/USDT for a spot trade decision.

MARKET DATA: Price $${price.toFixed(6)} | 24h: ${ch24h.toFixed(1)}% | 7d: ${ch7d.toFixed(1)}%

MULTI-TIMEFRAME:
15m: RSI ${rsi15} | MACD ${mac15.hist > 0 ? 'Bullish' : 'Bearish'} | ST ${st15.bullish ? 'BULL' : 'BEAR'}${st15.flipped ? ' ⚡FLIP' : ''}
1h:  RSI ${rsi1h} | MACD ${mac1h.hist > 0 ? 'Bullish' : 'Bearish'} | ST ${st1h.bullish ? 'BULL' : 'BEAR'}${st1h.flipped ? ' ⚡FLIP' : ''}
4h:  RSI ${rsi4h} | StochRSI ${stoch4h} | MACD ${mac4h.hist > 0 ? 'Bullish' : 'Bearish'} | ST ${st4h.bullish ? 'BULL' : 'BEAR'}${st4h.flipped ? ' ⚡FLIP' : ''} | Vol ${volX.toFixed(1)}x | BB ${bbPos}
1D:  RSI ${rsi1d} | Trend ${dayTrend.toUpperCase()} | EMA7 ${e7d > e21d ? 'above' : 'below'} EMA21

LEVELS: Support $${sup30.toFixed(4)} | Resistance $${res30.toFixed(4)} | EMA9 $${e9_ci.toFixed(4)} | EMA21 $${e21_ci.toFixed(4)} | EMA50 $${e50_ci.toFixed(4)}
ATR: ${atrPct.toFixed(2)}% | Bullish alignment: ${bullScore}/10 | Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label})
${posCtx}

Respond ONLY with this exact JSON (no extra text):
{"verdict":"STRONG BUY|BUY|WAIT|SELL|STRONG SELL","confidence":<40-95>,"bias":"<6 words max: 1-3 day outlook>","upside":<% target>,"downside":<% risk>,"summary":"<2 direct sentences: what the setup says + exact action>","positionAdvice":"${position ? '1 clear sentence on the existing position' : ''}"}`;

      let verdict = 'WAIT', confidence = 50, bias = 'Mixed signals', upside = 5, downside = 3;
      let summary = 'AI analysis unavailable.', positionAdvice = '';
      try {
        const aiKey = process.env.ANTHROPIC_API_KEY;
        if (aiKey) {
          const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': aiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: insightPrompt }] }),
          });
          if (aiRes.ok) {
            const aiData = await aiRes.json() as any;
            const aiText = aiData.content?.[0]?.text || '{}';
            const m = aiText.match(/\{[\s\S]*\}/);
            if (m) {
              const p = JSON.parse(m[0]);
              verdict        = p.verdict        || 'WAIT';
              confidence     = Math.min(95, Math.max(40, parseInt(p.confidence) || 50));
              bias           = p.bias           || 'Mixed signals';
              upside         = parseFloat(p.upside)   || 5;
              downside       = parseFloat(p.downside) || 3;
              summary        = p.summary        || '';
              positionAdvice = p.positionAdvice || '';
            }
          }
        }
      } catch {}

      return res.status(200).json({
        symbol: rawSym, price,
        change24h: Math.round(ch24h * 100) / 100,
        change7d:  Math.round(ch7d  * 100) / 100,
        verdict, confidence, bias,
        upside:   Math.round(upside   * 10) / 10,
        downside: Math.round(downside * 10) / 10,
        summary, positionAdvice,
        timeframes: {
          tf15m: { rsi: rsi15, macd: mac15.hist > 0, supertrend: st15.bullish, flipped: st15.flipped },
          tf1h:  { rsi: rsi1h, macd: mac1h.hist > 0, supertrend: st1h.bullish, flipped: st1h.flipped },
          tf4h:  { rsi: rsi4h, stochRsi: stoch4h, macd: mac4h.hist > 0, supertrend: st4h.bullish, flipped: st4h.flipped, volume: Math.round(volX * 10) / 10, bbPosition: bbPos },
          tf1d:  { rsi: rsi1d, trend: dayTrend, emaAlignment: e7d > e21d },
        },
        levels: {
          support:    Math.round(sup30    * 10000) / 10000,
          resistance: Math.round(res30    * 10000) / 10000,
          ema9:       Math.round(e9_ci    * 10000) / 10000,
          ema21:      Math.round(e21_ci   * 10000) / 10000,
          ema50:      Math.round(e50_ci   * 10000) / 10000,
          bbLower:    Math.round(bb4h.lower * 10000) / 10000,
          bbUpper:    Math.round(bb4h.upper * 10000) / 10000,
          atrPercent: Math.round(atrPct * 100) / 100,
        },
        bullishScore: bullScore,
        fearGreed, position, historical,
        timestamp: Date.now(),
      });
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
        }
      }
      // Always save state so alertTimes persists — prevents duplicate Telegram alerts
      await saveState(state, tgToken, tgChat);

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
      if (tgToken && tgChat && minute < 10 && hour === 9) { // once a day at 9:00 UTC
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
      topSignals: allSignals.filter(s => s.action === 'buy' || s.action === 'strong_buy').slice(0, 5).map((s: SmartSignal) => ({ symbol: s.symbol, action: s.action, strength: s.strength })),
    });
  } catch (err: any) {
    console.error('Smart Scanner error:', err.message);
    return res.status(500).json({ error: err.message || 'Scanner error' });
  }
}
