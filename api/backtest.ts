import Anthropic from '@anthropic-ai/sdk';

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  type: 'buy' | 'sell';
  entry: number;
  exit: number;
  entryTime: number;
  exitTime: number;
  pnlPercent: number;
  pnlAbsolute: number;
}

interface BacktestResult {
  trades: Trade[];
  totalReturn: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpeRatio: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  avgWin: number;
  avgLoss: number;
  bestTrade: number;
  worstTrade: number;
  avgHoldingPeriod: number;
  buyAndHoldReturn: number;
  equityCurve: { time: number; equity: number }[];
}

interface StrategyLogic {
  type: 'ma_crossover' | 'rsi' | 'macd' | 'bollinger' | 'breakout' | 'squeeze_momentum' | 'volume_breakout' | 'volume_divergence' | 'multi_timeframe' | 'custom';
  params: Record<string, number>;
  longCondition: string;
  exitCondition: string;
  stopLoss?: number;
  takeProfit?: number;
  trailingStop?: number;
}

// === INDICATORS ===

function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function ema(data: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { result.push(data[0]); continue; }
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(data: number[], period: number = 14): number[] {
  const result: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 0; i < data.length; i++) {
    if (i === 0) { result.push(50); continue; }
    const change = data[i] - data[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);

    if (i < period) { result.push(50); continue; }

    const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
    const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

function macd(data: number[], fast: number = 12, slow: number = 26, signal: number = 9) {
  const emaFast = ema(data, fast);
  const emaSlow = ema(data, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

function bollingerBands(data: number[], period: number = 20, stdDev: number = 2) {
  const middle = sma(data, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const width: number[] = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { upper.push(NaN); lower.push(NaN); width.push(NaN); continue; }
    const slice = data.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const sd = Math.sqrt(variance) * stdDev;
    upper.push(mean + sd);
    lower.push(mean - sd);
    width.push((mean + sd - (mean - sd)) / mean * 100); // BB width as % of price
  }
  return { upper, middle, lower, width };
}

// Average True Range
function atr(candles: Candle[], period: number = 14): number[] {
  const result: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { result.push(candles[i].high - candles[i].low); continue; }
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    if (i < period) {
      result.push(tr);
      continue;
    }
    // Smoothed ATR
    result.push((result[i - 1] * (period - 1) + tr) / period);
  }
  return result;
}

// Volume SMA
function volumeSma(candles: Candle[], period: number): number[] {
  const volumes = candles.map(c => c.volume);
  return sma(volumes, period);
}

// Highest high over period
function highest(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    result.push(Math.max(...data.slice(i - period + 1, i + 1)));
  }
  return result;
}

// Lowest low over period
function lowest(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    result.push(Math.min(...data.slice(i - period + 1, i + 1)));
  }
  return result;
}

// === SPOT BACKTEST ENGINE (LONG-ONLY) ===

// Realistic execution costs for Bybit spot market orders
const FEE_RATE = 0.001;       // 0.1% taker fee per side
const SLIPPAGE_RATE = 0.0005; // 0.05% market order slippage per side
const BUY_COST = 1 + FEE_RATE + SLIPPAGE_RATE;   // effective buy = price × 1.0015
const SELL_COST = 1 - FEE_RATE - SLIPPAGE_RATE;  // effective sell = price × 0.9985

function runBacktest(candles: Candle[], strategy: StrategyLogic, initialCapital: number = 10000): BacktestResult {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const trades: Trade[] = [];
  let position: { entry: number; entryTime: number; trailingHigh: number } | null = null;
  let equity = initialCapital;
  let peakEquity = initialCapital;
  let maxDrawdown = 0;
  const equityCurve: { time: number; equity: number }[] = [{ time: candles[0]?.time || 0, equity: initialCapital }];

  // Pre-compute indicators for buy/sell signals
  let buySignals: boolean[] = [];
  let sellSignals: boolean[] = [];

  switch (strategy.type) {
    case 'ma_crossover': {
      const fast = ema(closes, strategy.params.fastPeriod || 9);
      const slow = ema(closes, strategy.params.slowPeriod || 21);
      buySignals = fast.map((f, i) => i > 0 && f > slow[i] && fast[i - 1] <= slow[i - 1]);
      sellSignals = fast.map((f, i) => i > 0 && f < slow[i] && fast[i - 1] >= slow[i - 1]);
      break;
    }
    case 'rsi': {
      const rsiValues = rsi(closes, strategy.params.period || 14);
      const oversold = strategy.params.oversold || 30;
      const overbought = strategy.params.overbought || 70;
      // Buy when RSI crosses up from oversold, sell when hits overbought
      buySignals = rsiValues.map((v, i) => i > 0 && rsiValues[i - 1] < oversold && v >= oversold);
      sellSignals = rsiValues.map((v, i) => i > 0 && v > overbought);
      break;
    }
    case 'macd': {
      const m = macd(closes, strategy.params.fast || 12, strategy.params.slow || 26, strategy.params.signal || 9);
      buySignals = m.histogram.map((h, i) => i > 0 && h > 0 && m.histogram[i - 1] <= 0);
      sellSignals = m.histogram.map((h, i) => i > 0 && h < 0 && m.histogram[i - 1] >= 0);
      break;
    }
    case 'bollinger': {
      const bb = bollingerBands(closes, strategy.params.period || 20, strategy.params.stdDev || 2);
      // Buy at lower band (oversold), sell at upper band
      buySignals = closes.map((c, i) => i > 0 && c <= bb.lower[i] && !isNaN(bb.lower[i]));
      sellSignals = closes.map((c, i) => i > 0 && c >= bb.upper[i] && !isNaN(bb.upper[i]));
      break;
    }
    case 'breakout': {
      // Price breakout above N-period high with volume confirmation
      const lookback = strategy.params.lookback || 20;
      const volPeriod = strategy.params.volPeriod || 20;
      const volMult = strategy.params.volMultiplier || 1.5;
      const exitLookback = strategy.params.exitLookback || 10;

      const highestHigh = highest(highs, lookback);
      const lowestLow = lowest(lows, exitLookback);
      const volSma = volumeSma(candles, volPeriod);
      const rsiValues = rsi(closes, 14);

      buySignals = candles.map((c, i) => {
        if (i < lookback || isNaN(highestHigh[i - 1])) return false;
        const breakout = c.close > highestHigh[i - 1]; // Close above previous highest high
        const volumeSpike = c.volume > volSma[i] * volMult; // Volume confirmation
        const momentumOk = rsiValues[i] > 50 && rsiValues[i] < 80; // Not overbought
        return breakout && volumeSpike && momentumOk;
      });

      sellSignals = candles.map((c, i) => {
        if (i < exitLookback || isNaN(lowestLow[i - 1])) return false;
        return c.close < lowestLow[i - 1]; // Close below lowest low = exit
      });
      break;
    }
    case 'squeeze_momentum': {
      // Bollinger Band squeeze → expansion breakout
      // When BB width is at its lowest (tight squeeze), wait for expansion + bullish candle
      const bbPeriod = strategy.params.bbPeriod || 20;
      const squeezeLookback = strategy.params.squeezeLookback || 120;
      const momentumPeriod = strategy.params.momentumPeriod || 12;

      const bb = bollingerBands(closes, bbPeriod, 2);
      const rsiValues = rsi(closes, 14);
      const mom = ema(closes, momentumPeriod);
      const atrValues = atr(candles, 14);

      buySignals = candles.map((c, i) => {
        if (i < squeezeLookback || isNaN(bb.width[i])) return false;

        // Find min BB width in lookback (squeeze)
        const recentWidths = bb.width.slice(Math.max(0, i - squeezeLookback), i);
        const validWidths = recentWidths.filter(w => !isNaN(w));
        if (!validWidths.length) return false;
        const minWidth = Math.min(...validWidths);
        const currentWidth = bb.width[i];
        const prevWidth = bb.width[i - 1];

        // Squeeze release: width was near minimum and now expanding
        const wasSqueezed = prevWidth < minWidth * 1.2;
        const expanding = currentWidth > prevWidth * 1.05;
        const bullish = c.close > c.open; // Green candle
        const aboveMiddle = c.close > bb.middle[i]; // Above BB middle
        const momentumUp = mom[i] > mom[i - 1]; // Momentum increasing
        const rsiOk = rsiValues[i] > 45 && rsiValues[i] < 75;

        return wasSqueezed && expanding && bullish && aboveMiddle && momentumUp && rsiOk;
      });

      sellSignals = candles.map((c, i) => {
        if (i < 3) return false;
        // Sell when price drops below BB middle or RSI hits overbought
        const belowMiddle = c.close < bb.middle[i] && !isNaN(bb.middle[i]);
        const overbought = rsiValues[i] > 78;
        return belowMiddle || overbought;
      });
      break;
    }
    case 'volume_breakout': {
      // Volume-price analysis: detect accumulation → breakout
      const volPeriod = strategy.params.volPeriod || 20;
      const pricePeriod = strategy.params.pricePeriod || 10;
      const volSpike = strategy.params.volSpike || 2.0;

      const volSma = volumeSma(candles, volPeriod);
      const priceHigh = highest(highs, pricePeriod);
      const rsiValues = rsi(closes, 14);
      const fastMa = ema(closes, 9);
      const slowMa = ema(closes, 21);

      buySignals = candles.map((c, i) => {
        if (i < Math.max(volPeriod, pricePeriod) + 1) return false;

        // Accumulation: low volume for several bars, then volume spike
        const recentVols = candles.slice(Math.max(0, i - 5), i).map(x => x.volume);
        const avgRecentVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
        const wasQuiet = avgRecentVol < volSma[i - 1] * 0.8; // Below average recently

        const volumeExplodes = c.volume > volSma[i] * volSpike; // Current bar volume explodes
        const priceBreakout = c.close > priceHigh[i - 1] && !isNaN(priceHigh[i - 1]); // New high
        const bullishCandle = c.close > c.open;
        const trendAligned = fastMa[i] > slowMa[i]; // Trend filter

        return wasQuiet && volumeExplodes && priceBreakout && bullishCandle && trendAligned;
      });

      sellSignals = candles.map((c, i) => {
        if (i < 2) return false;
        // Exit on trend reversal or momentum loss
        const trendLost = fastMa[i] < slowMa[i] && fastMa[i - 1] >= slowMa[i - 1];
        const overbought = rsiValues[i] > 80;
        return trendLost || overbought;
      });
      break;
    }
    case 'volume_divergence': {
      // Price makes lower lows + volume decreasing = sellers exhausted → buy reversal
      const lookback = strategy.params.lookback || 10;
      const volPeriod = strategy.params.volPeriod || 20;
      const rsiValues = rsi(closes, 14);
      const fastMa = ema(closes, 9);
      const slowMa = ema(closes, 21);
      const volSma = volumeSma(candles, volPeriod);

      buySignals = candles.map((c, i) => {
        if (i < lookback + 2) return false;

        // Check for lower lows in price
        const recentLows = candles.slice(i - lookback, i + 1).map(x => x.low);
        let lowerLowCount = 0;
        for (let j = 1; j < recentLows.length; j++) {
          if (recentLows[j] < recentLows[j - 1]) lowerLowCount++;
        }

        // Check for decreasing volume during the drop
        const recentVols = candles.slice(i - lookback, i + 1).map(x => x.volume);
        let decVolCount = 0;
        for (let j = 1; j < recentVols.length; j++) {
          if (recentVols[j] < recentVols[j - 1]) decVolCount++;
        }

        const priceFalling = lowerLowCount >= Math.floor(lookback * 0.4);
        const volFading = decVolCount >= Math.floor(lookback * 0.5);
        const rsiBouncing = rsiValues[i] > rsiValues[i - 2] && rsiValues[i] < 45;
        const bullishCandle = c.close > c.open;
        const nearLow = (c.close - Math.min(...recentLows)) / Math.min(...recentLows) < 0.03;

        return priceFalling && volFading && (rsiBouncing || bullishCandle) && nearLow;
      });

      sellSignals = candles.map((c, i) => {
        if (i < 2) return false;
        const rsiHigh = rsiValues[i] > 70;
        const trendLost = fastMa[i] < slowMa[i] && fastMa[i - 1] >= slowMa[i - 1];
        return rsiHigh || trendLost;
      });
      break;
    }
    case 'multi_timeframe': {
      // Weekly uptrend + daily squeeze/dip = high probability entry
      // Simulate weekly data from daily candles
      const weeklyCloses: number[] = [];
      for (let i = 0; i < closes.length; i += 7) {
        const slice = closes.slice(i, Math.min(i + 7, closes.length));
        weeklyCloses.push(slice[slice.length - 1]);
      }

      const wFast = ema(weeklyCloses, strategy.params.weeklyFast || 9);
      const wSlow = ema(weeklyCloses, strategy.params.weeklySlow || 21);

      // Daily indicators
      const dFast = ema(closes, strategy.params.dailyFast || 9);
      const dSlow = ema(closes, strategy.params.dailySlow || 21);
      const rsiValues = rsi(closes, 14);
      const bb = bollingerBands(closes, 20, 2);

      buySignals = candles.map((c, i) => {
        if (i < 30) return false;

        // Weekly trend (map daily index to weekly)
        const wIdx = Math.floor(i / 7);
        if (wIdx >= wFast.length || wIdx >= wSlow.length) return false;
        const weeklyUptrend = wFast[wIdx] > wSlow[wIdx];

        // Daily: pullback to support or squeeze release
        const dailyDip = rsiValues[i] > 35 && rsiValues[i] < 50 && dFast[i] > dSlow[i];
        const nearBBLower = !isNaN(bb.lower[i]) && c.close <= bb.lower[i] * 1.02;
        const dailyCrossover = i > 0 && dFast[i] > dSlow[i] && dFast[i - 1] <= dSlow[i - 1];

        return weeklyUptrend && (dailyDip || nearBBLower || dailyCrossover);
      });

      sellSignals = candles.map((c, i) => {
        if (i < 2) return false;
        const wIdx = Math.floor(i / 7);
        const weeklyLost = wIdx > 0 && wIdx < wFast.length && wFast[wIdx] < wSlow[wIdx];
        const rsiOB = rsiValues[i] > 75;
        const dailyCrossDown = dFast[i] < dSlow[i] && dFast[i - 1] >= dSlow[i - 1];
        return weeklyLost || rsiOB || dailyCrossDown;
      });
      break;
    }
    default: {
      const fast = ema(closes, 10);
      const slow = ema(closes, 30);
      buySignals = fast.map((f, i) => i > 0 && f > slow[i] && fast[i - 1] <= slow[i - 1]);
      sellSignals = fast.map((f, i) => i > 0 && f < slow[i] && fast[i - 1] >= slow[i - 1]);
    }
  }

  // === RUN SIMULATION (LONG ONLY — SPOT) ===
  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const price = candle.close;

    if (position) {
      const pnlPct = (price - position.entry) / position.entry * 100;

      // Update trailing high
      if (price > position.trailingHigh) position.trailingHigh = price;

      // Check trailing stop
      if (strategy.trailingStop) {
        const trailDrop = (position.trailingHigh - price) / position.trailingHigh * 100;
        if (trailDrop >= strategy.trailingStop) {
          const rawExit = position.trailingHigh * (1 - strategy.trailingStop / 100);
          const exitPrice = rawExit * SELL_COST; // apply fee + slippage on sell
          const actualPnl = (exitPrice - position.entry) / position.entry * 100;
          const pnlAbs = equity * (actualPnl / 100);
          equity += pnlAbs;
          trades.push({
            type: 'sell', entry: position.entry, exit: exitPrice,
            entryTime: position.entryTime, exitTime: candle.time,
            pnlPercent: Math.round(actualPnl * 100) / 100, pnlAbsolute: pnlAbs,
          });
          position = null;
          // Continue to check buy signal on same bar
        }
      }

      // Check fixed stop loss
      if (position && strategy.stopLoss && pnlPct <= -strategy.stopLoss) {
        const rawExit = position.entry * (1 - strategy.stopLoss / 100);
        const exitPrice = rawExit * SELL_COST;
        const actualPnl = (exitPrice - position.entry) / position.entry * 100;
        const pnlAbs = equity * (actualPnl / 100);
        equity += pnlAbs;
        trades.push({
          type: 'sell', entry: position.entry, exit: exitPrice,
          entryTime: position.entryTime, exitTime: candle.time,
          pnlPercent: Math.round(actualPnl * 100) / 100, pnlAbsolute: pnlAbs,
        });
        position = null;
      }

      // Check fixed take profit
      if (position && strategy.takeProfit && pnlPct >= strategy.takeProfit) {
        const rawExit = position.entry * (1 + strategy.takeProfit / 100);
        const exitPrice = rawExit * SELL_COST;
        const actualPnl = (exitPrice - position.entry) / position.entry * 100;
        const pnlAbs = equity * (actualPnl / 100);
        equity += pnlAbs;
        trades.push({
          type: 'sell', entry: position.entry, exit: exitPrice,
          entryTime: position.entryTime, exitTime: candle.time,
          pnlPercent: Math.round(actualPnl * 100) / 100, pnlAbsolute: pnlAbs,
        });
        position = null;
      }

      // Check sell signal — apply fee + slippage on exit
      if (position && sellSignals[i]) {
        const exitPrice = price * SELL_COST;
        const actualPnl = (exitPrice - position.entry) / position.entry * 100;
        const pnlAbs = equity * (actualPnl / 100);
        equity += pnlAbs;
        trades.push({
          type: 'sell', entry: position.entry, exit: exitPrice,
          entryTime: position.entryTime, exitTime: candle.time,
          pnlPercent: Math.round(actualPnl * 100) / 100, pnlAbsolute: pnlAbs,
        });
        position = null;
      }
    }

    // Buy signal (only when not in position)
    // Apply fee + slippage on entry: effective buy price is slightly higher than close
    if (!position && buySignals[i]) {
      const effectiveEntry = price * BUY_COST;
      position = { entry: effectiveEntry, entryTime: candle.time, trailingHigh: effectiveEntry };
    }

    // Track equity curve
    if (position) {
      const unrealized = equity * ((price - position.entry) / position.entry);
      equityCurve.push({ time: candle.time, equity: equity + unrealized });
    } else {
      equityCurve.push({ time: candle.time, equity });
    }

    // Track drawdown
    const currentEquity = position
      ? equity + equity * ((price - position.entry) / position.entry)
      : equity;
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const dd = (peakEquity - currentEquity) / peakEquity * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Close open position at last price (apply sell cost)
  if (position && candles.length > 0) {
    const rawLast = candles[candles.length - 1].close;
    const lastPrice = rawLast * SELL_COST;
    const pnlPct = (lastPrice - position.entry) / position.entry * 100;
    const pnlAbs = equity * (pnlPct / 100);
    equity += pnlAbs;
    trades.push({
      type: 'sell', entry: position.entry, exit: lastPrice,
      entryTime: position.entryTime, exitTime: candles[candles.length - 1].time,
      pnlPercent: Math.round(pnlPct * 100) / 100, pnlAbsolute: pnlAbs,
    });
  }

  // Buy and hold comparison — include round-trip execution cost
  const buyAndHoldReturn = candles.length >= 2
    ? ((candles[candles.length - 1].close * SELL_COST - candles[0].close * BUY_COST) / (candles[0].close * BUY_COST)) * 100
    : 0;

  const winners = trades.filter(t => t.pnlPercent > 0);
  const losers = trades.filter(t => t.pnlPercent <= 0);
  const totalReturn = ((equity - initialCapital) / initialCapital) * 100;

  const grossProfit = winners.reduce((s, t) => s + t.pnlAbsolute, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnlAbsolute, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 999.99 : 0) : grossProfit / grossLoss;

  const returns = trades.map(t => t.pnlPercent);
  const avgReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
    : 0;
  const sharpeRatio = stdReturn === 0 ? 0 : (avgReturn / stdReturn) * Math.sqrt(252);

  const avgHoldingMs = trades.length
    ? trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / trades.length
    : 0;

  return {
    trades,
    totalReturn: Math.round(totalReturn * 100) / 100,
    winRate: trades.length ? Math.round((winners.length / trades.length) * 10000) / 100 : 0,
    profitFactor: Math.round(profitFactor * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    totalTrades: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    avgWin: winners.length ? Math.round(winners.reduce((s, t) => s + t.pnlPercent, 0) / winners.length * 100) / 100 : 0,
    avgLoss: losers.length ? Math.round(losers.reduce((s, t) => s + t.pnlPercent, 0) / losers.length * 100) / 100 : 0,
    bestTrade: trades.length ? Math.round(Math.max(...trades.map(t => t.pnlPercent)) * 100) / 100 : 0,
    worstTrade: trades.length ? Math.round(Math.min(...trades.map(t => t.pnlPercent)) * 100) / 100 : 0,
    avgHoldingPeriod: Math.round(avgHoldingMs / (1000 * 60 * 60 * 24) * 10) / 10,
    buyAndHoldReturn: Math.round(buyAndHoldReturn * 100) / 100,
    equityCurve: equityCurve.filter((_, i) => i % Math.max(1, Math.floor(equityCurve.length / 200)) === 0),
  };
}

async function fetchOHLC(symbol: string, days: number = 365): Promise<Candle[]> {
  const idMap: Record<string, string> = {
    BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
    XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin', AVAX: 'avalanche-2',
    DOT: 'polkadot', MATIC: 'matic-network', LTC: 'litecoin', LINK: 'chainlink',
    SHIB: 'shiba-inu', UNI: 'uniswap', ATOM: 'cosmos', RNDR: 'render-token',
  };

  const coinId = idMap[symbol.toUpperCase()] || symbol.toLowerCase();

  // Try Binance API first (better OHLC + volume data)
  try {
    const interval = days <= 30 ? '1h' : '1d';
    const limit = days <= 30 ? Math.min(days * 24, 1000) : Math.min(days, 1000);
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}USDT&interval=${interval}&limit=${limit}`
    );
    if (res.ok) {
      const data = (await res.json()) as any[];
      return data.map((k: any) => ({
        time: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
    }
  } catch {}

  // Fallback to CoinGecko OHLC
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`
    );
    if (res.ok) {
      const data = (await res.json()) as number[][];
      return data.map(([time, open, high, low, close]) => ({
        time, open, high, low, close, volume: 0,
      }));
    }
  } catch {}

  return [];
}

async function parseStrategyWithAI(pineScript: string, apiKey: string): Promise<StrategyLogic> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `You are a Pine Script parser for SPOT TRADING (long-only, no shorts). Given Pine Script code, extract the strategy logic and return ONLY a JSON object (no markdown, no explanation) with this exact structure:
{
  "type": "ma_crossover" | "rsi" | "macd" | "bollinger" | "breakout" | "squeeze_momentum" | "volume_breakout" | "volume_divergence" | "multi_timeframe" | "custom",
  "params": { key: number pairs for the strategy parameters },
  "longCondition": "human readable description of BUY condition",
  "exitCondition": "human readable description of SELL/exit condition",
  "stopLoss": number (percentage, optional),
  "takeProfit": number (percentage, optional),
  "trailingStop": number (percentage, optional)
}

Strategy type mapping:
- ma_crossover: params = { fastPeriod, slowPeriod }
- rsi: params = { period, oversold, overbought }
- macd: params = { fast, slow, signal }
- bollinger: params = { period, stdDev }
- breakout: params = { lookback, volPeriod, volMultiplier, exitLookback }
- squeeze_momentum: params = { bbPeriod, squeezeLookback, momentumPeriod }
- volume_breakout: params = { volPeriod, pricePeriod, volSpike }
- volume_divergence: params = { lookback, volPeriod }
- multi_timeframe: params = { weeklyFast, weeklySlow, dailyFast, dailySlow }

IMPORTANT: This is for SPOT trading only. Convert any short entries to sell/exit signals instead. No short positions.

Always return valid JSON only.`,
    messages: [{ role: 'user', content: pineScript }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';

  try {
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned) as StrategyLogic;
  } catch {
    return {
      type: 'ma_crossover',
      params: { fastPeriod: 9, slowPeriod: 21 },
      longCondition: 'Fast EMA crosses above Slow EMA',
      exitCondition: 'Fast EMA crosses below Slow EMA',
    };
  }
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { symbol, pineScript, strategyType, params, days, stopLoss, takeProfit, trailingStop } = req.body || {};

    if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

    const apiKey = process.env.ANTHROPIC_API_KEY;

    let strategy: StrategyLogic;

    if (pineScript && apiKey) {
      strategy = await parseStrategyWithAI(pineScript, apiKey);
    } else {
      strategy = {
        type: strategyType || 'ma_crossover',
        params: params || { fastPeriod: 9, slowPeriod: 21 },
        longCondition: 'Based on indicator signals',
        exitCondition: 'Based on indicator signals',
      };
    }

    if (stopLoss) strategy.stopLoss = stopLoss;
    if (takeProfit) strategy.takeProfit = takeProfit;
    if (trailingStop) strategy.trailingStop = trailingStop;

    const candles = await fetchOHLC(symbol, days || 365);
    if (!candles.length) {
      return res.status(400).json({ error: 'Could not fetch price data for ' + symbol });
    }

    const result = runBacktest(candles, strategy);

    return res.status(200).json({
      success: true,
      symbol,
      mode: 'spot',
      strategy: {
        type: strategy.type,
        params: strategy.params,
        longCondition: strategy.longCondition,
        exitCondition: strategy.exitCondition,
        stopLoss: strategy.stopLoss,
        takeProfit: strategy.takeProfit,
        trailingStop: strategy.trailingStop,
      },
      period: `${candles.length} candles (${days || 365} days)`,
      result,
    });
  } catch (err: any) {
    console.error('Backtest API error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
