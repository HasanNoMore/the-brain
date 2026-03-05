# THE BRAIN — Strategy Assessment & Improvement Plan
### Honest review of all 11 strategies

---

## CURRENT 11 STRATEGIES — KEEP, IMPROVE, OR REMOVE

### 1. Scanner Signal — REMOVE
**Why:** This is not a strategy. It just says "if the scanner says buy, buy." It's circular logic — the scanner generates the signal, then this strategy says "yes do what the scanner says." Every other strategy below IS the scanner. This one is redundant and causes double-entries.

### 2. RSI Reversal — KEEP & IMPROVE
**Why it works:** Oversold bounces have real statistical edge. When RSI drops below 30, the probability of a bounce is genuinely higher than random.
**Problem:** Current threshold is too loose in bear markets (RSI < 45 in strong_bear). RSI 45 is not oversold — it's neutral.
**Improvement:** 
- Require RSI < 30 (real oversold), not adaptive thresholds that go up to 45
- Require 1h RSI HIGHER than 4h RSI (confirming the bounce started)
- Add: daily RSI must also be < 40 (macro context agrees)
- Add: price must be above its 200-period EMA on 1h (not fighting major trend)

### 3. Bollinger Bounce — KEEP & IMPROVE  
**Why it works:** Mean reversion at 2 standard deviations has mathematical backing. Price spends ~95% of time within 2 std devs.
**Problem:** In a strong downtrend, price can ride the lower band for days. The current `momentum > -50` filter is too weak.
**Improvement:**
- Require: price touched lower BB AND bounced (current candle closes above previous candle's low)
- Require: RSI showing bullish divergence OR StochRSI turning up from < 20
- Add: BB must not be expanding rapidly (BBwidth increasing = trend continuation, not reversal)

### 4. Dip Buyer — IMPROVE SIGNIFICANTLY
**Why it can work:** Buying dips in fundamentally strong coins after panic selling.
**Problem:** Currently buys ANY -3% drop. In bear markets, -3% is just the beginning. The adaptive thresholds make it WORSE — in strong_bear it buys at -2.5% with volume as low as 0.3x. That's not a dip, that's normal bearish price action.
**Improvement:**
- Remove adaptive loosening in bear markets (that's backwards — be STRICTER in bear markets)
- Require: -5% drop minimum (real dip, not noise)
- Require: volume > 2x average (real capitulation, not normal selling)
- Require: RSI < 30 AND StochRSI < 20 (deep oversold)
- Require: 1h candle shows recovery (close > open on the last hourly candle)
- In bear/strong_bear: require -8% drop instead of -5%

### 5. Early Gainer — KEEP & IMPROVE
**Why it works:** Volume precedes price. A 3x volume spike with positive price action is one of the most reliable early signals.
**Problem:** Current threshold is too low in bear markets (1.5x volume). That's barely above normal.
**Improvement:**
- Minimum 3x volume spike in ALL regimes (real unusual activity, not noise)
- Require: price up > 1% in 1h (not just 0.2% — that's nothing)
- Require: RSI between 40-65 (not overbought, not deeply oversold)
- Add: check if volume spike is concentrated in the last 2-3 candles (not spread across 24h)

### 6. DCA Accumulator — KEEP BUT FIX LOGIC
**Why it works:** DCA is mathematically sound for accumulating in downtrends IF you have a clear exit plan.
**Problem:** Current isDcaEligible() is too loose. It buys any coin with RSI 25-60 and price below EMA21. In a bear market, EVERYTHING is below EMA21.
**Improvement:**
- Only DCA into coins on the whitelist (already done)
- Require: coin must have positive 7-day money flow (CMF > 0) — someone is accumulating
- Limit to 3-5 specific coins you believe in long-term, not the entire SAFE_TRADING_COINS list
- Bigger drop between DCA entries: 8% instead of 5% (let it really dip)

### 7. Divergence Play — KEEP (best strategy)
**Why it works:** Bullish divergence (price lower low + RSI higher low) is one of the highest-probability reversal signals in technical analysis. It has genuine statistical edge.
**Problem:** Current detection is crude — only looks at 2 swing lows. Professional divergence detection needs cleaner logic.
**Improvement:**
- Keep as-is for detection logic (it's adequate)
- Add: require volume increase on the second low (smart money buying the second dip)
- Add: require CMF turning positive (money flow confirms the divergence)
- Add: require daily trend not in strong_bear on that specific coin

### 8. Supertrend Ride — REMOVE
**Why remove:** Supertrend flips happen CONSTANTLY in choppy/sideways markets. The "flip" signal fires every time price crosses the ATR band, which in a ranging market means buying at the top of every small bounce and getting stopped out.
**The data:** In the current strong_bear market, Supertrend has been flipping back and forth on most altcoins weekly. Each flip = a losing trade.
**Alternative:** If you want trend-following, use the EMA crossover within the scanner_signal logic instead. It's slower but has fewer false signals.

### 9. Smart Money (OBV) — KEEP & IMPROVE
**Why it works:** OBV breakout + positive CMF genuinely detects accumulation. When OBV makes new highs while price is flat or down, big buyers are loading up.
**Problem:** Current CMF threshold is 0.03 — too low. In a bull market everything has positive CMF.
**Improvement:**
- Require CMF > 0.10 (meaningful buying pressure, not noise)
- Require OBV trend > 50% above 20-bar average (strong breakout, not marginal)
- Add: volume must be 1.5x+ average (confirms the OBV breakout is real)
- Add: price must be within 5% of a support level (accumulation at support = strongest signal)

### 10. VWAP Reclaim — REMOVE
**Why remove:** VWAP is an intraday indicator. Your bot checks every 5 minutes on 4h candles. By the time the cron detects a VWAP reclaim, the move already happened. This strategy needs real-time execution to work — it's fundamentally incompatible with a cron-based architecture.

### 11. Panic Reversal — KEEP & TIGHTEN
**Why it works:** Capitulation selling (sudden -5%+ drops with huge volume and deep oversold RSI) is one of the best buying opportunities. The forced sellers are done, and price bounces.
**Problem:** Current thresholds in strong_bear (-2% drop, RSI<30, vol 1.2x) are way too loose. A -2% hourly drop in a bear market is NORMAL, not panic.
**Improvement:**
- Require: -5% hourly drop minimum (real panic, not normal volatility)
- Require: volume > 3x average (actual capitulation volume)
- Require: RSI < 20 AND StochRSI < 10 (extreme oversold only)
- This should trigger maybe 2-3 times per month, not multiple times per week

---

## RECOMMENDED FINAL STRATEGY SET

### KEEP (7 strategies):
1. **RSI Reversal** (improved) — oversold bounce
2. **Bollinger Bounce** (improved) — mean reversion  
3. **Dip Buyer** (significantly tightened) — your "buy the dip" strategy
4. **Early Gainer** (improved) — volume spike detection (your "whale movement" detector)
5. **DCA Accumulator** (fixed) — long-term accumulation
6. **Divergence Play** (improved) — highest conviction reversal
7. **Smart Money** (improved) — institutional accumulation detection
8. **Panic Reversal** (tightened) — capitulation buying

### REMOVE (3 strategies):
- **Scanner Signal** — redundant circular logic
- **Supertrend Ride** — too many false flips in choppy markets  
- **VWAP Reclaim** — incompatible with cron-based architecture

---

## WHAT YOU ASKED ABOUT — HOW EACH IS HANDLED

| What you want | How the bot handles it |
|---|---|
| Buy the dip | Dip Buyer + Panic Reversal + RSI Reversal |
| Whale/big money movement | Early Gainer (volume spike) + Smart Money (OBV/CMF) |
| News-driven moves | Early Gainer catches the EFFECT of news (volume spike + price move) |
| Avoid scam coins | SAFE_TRADING_COINS whitelist (46 established coins only) |
| Catch coins early in gains | Early Gainer + Bollinger Bounce at support |
| All market conditions | Adaptive thresholds adjust per regime, BUT bot trades less in bear markets (correct behavior) |

---

## WHAT THE BOT CANNOT DO (being honest)

- **Predict news before it happens** — impossible without insider info
- **Identify whale wallets** — needs on-chain data, not CEX data
- **Catch the exact bottom** — nobody can, the bot catches the bounce
- **Win every trade** — 55-60% win rate with 2:1 reward:risk is professional-grade
- **Replace human judgment** — it's a tool, not a crystal ball

---

## NEXT STEP

Feed this document to Claude Code:

```
Read STRATEGY_PLAN.md and update evaluateStrategies() and 
getAdaptiveThresholds() in api/smart-scanner.ts to match 
the improved conditions. Remove scanner_signal, supertrend_ride, 
and vwap_reclaim. Tighten all thresholds as described.
```
