# THE BRAIN — FULL CODE AUDIT
### Honest assessment. No hype. Every bug listed.
**Date:** March 4, 2026  
**Files audited:** `api/smart-scanner.ts` (2821 lines), `api/backtest.ts` (734 lines)  
**Files still needed:** `api/webhook.ts`, `api/trade.ts`, `src/services/bybit.ts`, `vercel.json`

---

## CRITICAL BUGS — These can lose you real money

### BUG #1: Stop Loss is NOT real-time — it only checks on cron cycles

**Location:** `checkAndClosePositions()` line 1289-1447

**Problem:** Your stop loss is checked only when the cron job runs (every 5-10 minutes depending on your `vercel.json` config). If BTC drops 5% in 2 minutes, the bot doesn't know until the next cron tick. By then, your 3.5% stop loss is already blown past.

**How this loses money:** You set SL at -3.5%, but price drops -7% between cron scans. The bot sells at -7%, not -3.5%. This is the #1 reason for unexpected large losses.

**Fix:** This is a fundamental limitation of Vercel serverless + cron architecture. Real-time stop losses require:
- Bybit's built-in conditional orders (server-side SL), OR
- A persistent WebSocket connection (not possible on Vercel serverless)

**Recommended fix code — place Bybit server-side SL at entry time:**
```typescript
// After buying, immediately place a conditional SL order on Bybit
await client.submitOrder({
  category: 'spot',
  symbol: `${sig.symbol}USDT`,
  side: 'Sell',
  orderType: 'Market',
  qty: String(fillQty),
  triggerPrice: String(stopLoss),
  triggerDirection: 2, // triggers when price falls below
  orderFilter: 'tpslOrder',
});
```

---

### BUG #2: Sell order uses `pos.qty` but actual Bybit balance may differ

**Location:** `checkAndClosePositions()` line 1386

```typescript
const closeResult = await client.submitOrder({
  category: 'spot', symbol: `${pos.symbol}USDT`, side: 'Sell',
  orderType: 'Market', qty: String(pos.qty),  // ← This qty might not match actual balance
});
```

**Problem:** The `pos.qty` is calculated from the fill at entry time. But:
- Partial TP1 already sold some (line 1337 reduces `pos.qty`)
- Rounding errors accumulate: `Math.round((pos.qty - sellQty) * 1e8) / 1e8` can leave dust
- If you manually sold some through Bybit app, the bot doesn't know

**How this loses money:** If `pos.qty` is slightly higher than actual balance, the sell order FAILS with "insufficient balance". The position stays open. No stop loss executes. Price keeps dropping. The error is caught in a try/catch that just logs and continues (line 1442).

**Fix:** Before selling, check actual balance:
```typescript
// Get real balance before selling
const balRes = await client.getWalletBalance({ accountType: 'UNIFIED', coin: pos.symbol });
const coinBal = balRes.result?.list?.[0]?.coin?.find((c: any) => c.coin === pos.symbol);
const actualQty = parseFloat(coinBal?.availableToWithdraw || '0');
const sellQty = Math.min(pos.qty, actualQty);
if (sellQty <= 0) { /* mark position as closed_manual, log warning */ }
```

---

### BUG #3: DCA sell uses `stack.totalQty` — same balance mismatch issue

**Location:** `checkAndCloseDcaStacks()` line 1738

Same problem as Bug #2 but for DCA stacks. The `totalQty` is the sum of all DCA buy fills, but actual Bybit balance can differ.

---

### BUG #4: AI Brain filter defaults to APPROVE on any error

**Location:** `aiFilterSignal()` line 1165-1168

```typescript
} catch (e: any) {
  return { action: 'APPROVE', confidence: 50, reasoning: `Error: ${e.message}` };
}
```

**Problem:** If the Claude API times out, returns garbage, or has a network error, the signal is auto-approved. This means when the AI brain is "enabled", every API failure = an unfiltered trade goes through.

**Fix:** Default to REJECT on error, not APPROVE:
```typescript
return { action: 'REJECT', confidence: 0, reasoning: `AI unavailable: ${e.message}` };
```

---

### BUG #5: `getActiveOrders` may not return filled market orders

**Location:** `executeTrades()` line 1576-1589

```typescript
const orderRes = await client.getActiveOrders({
  category: 'spot', symbol: `${sig.symbol}USDT`, orderId: result.result?.orderId,
});
```

**Problem:** `getActiveOrders` returns ACTIVE (open/unfilled) orders. A market order fills instantly and moves to order history. So this call often returns empty, and the fallback `fillQty = parseFloat(qtyStr)` uses the ESTIMATED qty, not actual fill.

This means `pos.qty` in your state can be WRONG from the start. When you later try to sell `pos.qty`, it might fail (Bug #2).

**Fix:** Use `getOrderHistory` instead:
```typescript
const orderRes = await client.getHistoricOrders({
  category: 'spot', symbol: `${sig.symbol}USDT`, orderId: result.result?.orderId,
});
```

---

## MEDIUM SEVERITY BUGS

### BUG #6: Trailing stop only moves UP during cron checks

**Location:** `checkAndClosePositions()` line 1305-1307

```typescript
if (!pos.peakPrice || currentPrice > pos.peakPrice) {
  pos.peakPrice = currentPrice;
}
```

**Problem:** `peakPrice` only updates when cron runs. If price spikes to +10% between crons then falls to +2%, the bot never saw the +10% peak. The trailing stop is calculated from a lower peak, so it's looser than intended.

**Impact:** Less profit captured on trailing stops. Not a money-loser, but a money-leaver.

---

### BUG #7: Position size ignores AI-modified size

**Location:** `executeTrades()` line 1557-1563

```typescript
let positionSizeUSD = config.positionSizeUSD;
if (config.aiBrainEnabled) {
  // ... AI may set positionSizeUSD to a different value
  if (aiDecision.modifiedSize) positionSizeUSD = aiDecision.modifiedSize;
}

const qty = positionSizeUSD / sig.price;  // Uses modified size
// ...
const result = await client.submitOrder({
  // ...
  qty: String(config.positionSizeUSD),  // ← USES ORIGINAL SIZE, NOT MODIFIED
  marketUnit: 'quoteCoin',
});
```

**Problem:** The order is placed with `config.positionSizeUSD` (the original $30), not the AI-modified `positionSizeUSD`. The AI size adjustment does nothing.

**Fix:** Change line 1563 to:
```typescript
qty: String(positionSizeUSD),  // Use the possibly-modified value
```

---

### BUG #8: `catch {}` silently swallows critical errors in 12+ places

Throughout the code, errors are caught and ignored:
- Line 415: `} catch {}` — Redis load failure
- Line 636: `} catch { return []; }` — Kline fetch failure  
- Line 963: `} catch (e: any) { ... return null; }` — Scan failure
- Line 1589: `} catch {}` — Order fill check failure
- Line 1847: `} catch {}` — DCA fill check failure
- Line 2662: `} catch {}` — Analysis failures

**Problem:** When these fail, you get no error in Vercel logs, no Telegram alert, nothing. The bot just silently does the wrong thing or skips critical operations.

---

### BUG #9: State save can fail silently after trades execute

**Location:** `saveState()` line 433-454

```typescript
if (!r.ok) {
  const err = await r.text().catch(() => 'unknown');
  console.error(`[STATE] Redis save FAILED: HTTP ${r.status} — ${err}`);
  // Don't throw — cron must continue.
}
```

**Problem:** If Redis save fails AFTER a trade was placed, the position is not recorded in state. Next cron cycle loads old state without the new position. The bot:
1. Doesn't know it has an open position
2. Never checks stop loss for that position
3. Never sells it
4. You have a position that the bot forgot about

**Fix:** If save fails after trades, retry. If retry fails, send emergency Telegram alert.

---

## STRATEGY LOGIC ISSUES

### ISSUE #1: 9 strategies enabled by default — too many entry signals

All these are ON by default: scanner_signal, rsi_reversal, bollinger_bounce, dip_buyer, early_gainer, divergence_play, smart_money, vwap_reclaim, panic_reversal.

With 110 coins scanned and 9 strategies, the bot can match dozens of coins per cycle. The `maxTotal: 8` limit helps, but it fills up fast with low-quality signals.

**Recommendation:** Start with 2-3 strategies max. Test each one individually before combining.

### ISSUE #2: 3.5% stop loss is too tight for most altcoins

Many altcoins have 5-10% daily swings. A 3.5% SL gets triggered by normal volatility, not actual trend changes. This is why win rate is low — positions get stopped out and then the coin recovers.

**Recommendation:** Use ATR-based stops. `sig.atrPercent` is already calculated. Set SL = 2x ATR%.

### ISSUE #3: Cron interval determines trading speed

Vercel cron typically runs every 5-10 minutes. This means:
- Entry: 5-10 min delay after signal appears
- Exit: 5-10 min delay after SL/TP price is hit
- In fast-moving crypto, this delay = slippage = money lost

This is an architectural limitation, not a bug you can fix.

---

## WHAT WORKS WELL (being honest)

1. **Redis state safety** — `_stateLoadedFromRedis` flag blocks trades if Redis fails. Good.
2. **Max drawdown auto-disable** — Bot turns off if losses exceed threshold. Good.
3. **SAFE_TRADING_COINS whitelist** — Meme coins alert but don't auto-trade. Good.
4. **Adaptive thresholds** — Strategy parameters adjust to market regime. Smart design.
5. **Cooldown system** — Prevents buying the same coin repeatedly. Good.
6. **Trade logging to Blob storage** — Creates audit trail. Good.
7. **Emergency stop** — One-click close all positions. Essential and it works.
8. **Partial TP1** — Selling 50% at first target, letting rest run. Good risk management concept.
9. **Balance pre-check** — Checks USDT balance before trading. Prevents some failed orders.

---

## ACTION PLAN — Priority Order

### IMMEDIATE (before putting any real money at risk):

1. **Fix Bug #1:** Place Bybit server-side conditional SL orders at entry time
2. **Fix Bug #2:** Check actual balance before selling
3. **Fix Bug #5:** Use `getHistoricOrders` instead of `getActiveOrders` for fill data
4. **Fix Bug #7:** Use modified position size in order submission

### SHORT-TERM (within 1 week):

5. **Fix Bug #4:** Default AI filter to REJECT on error
6. **Fix Bug #9:** Add retry + emergency alert for state save failures
7. **Reduce to 2-3 strategies** and test each independently
8. **Widen stop losses** to ATR-based

### LONG-TERM (architecture):

9. Replace Vercel cron with persistent process (Railway/Render) for real-time monitoring
10. Add WebSocket price feeds for instant SL/TP execution
11. Build proper backtesting that simulates cron delays and slippage

---

---

## PINE SCRIPT BUGS (`brain_spot_alerts.pine`)

### PINE BUG #1: Webhook sends `syminfo.ticker` — may not match Bybit format

**Location:** Line 115

```pine
alert_message='{"action": "buy", "symbol": "' + syminfo.ticker + '", ...}'
```

**Problem:** `syminfo.ticker` returns different formats depending on the chart:
- On a BYBIT chart: returns `BTCUSDT` (good)
- On a BINANCE chart: returns `BTCUSDT` (good)
- But sometimes returns `BTCUSDT.P` (perpetual) or `BTC/USDT`

The webhook handler at line 134 of `webhook.ts` does:
```typescript
const cleanSymbol = symbol.replace('BYBIT:', '').replace('BINANCE:', '').toUpperCase();
```
This handles `BYBIT:BTCUSDT` but NOT `BTCUSDT.P` — the `.P` suffix would create `BTCUSDT.PUSDT` after appending USDT.

**Fix in webhook.ts:** Also strip `.P` and similar suffixes:
```typescript
const cleanSymbol = symbol.replace('BYBIT:', '').replace('BINANCE:', '')
  .replace(/\.[A-Z]+$/, '').replace('/','').toUpperCase();
```

### PINE BUG #2: `strategy.exit` TP/SL alert fires for ALL exit types

**Location:** Line 125

The `strategy.exit` with `alert_message` fires whether SL, TP, or trailing stop is hit. The webhook receives `"signal": "TP_SL_TRAIL"` for all three — you can't distinguish which one triggered the exit. This makes trade logging inaccurate.

### PINE BUG #3: Pine Script and Smart Scanner are TWO SEPARATE trading systems

This is a **design issue**, not a code bug. You have:
1. **Pine Script** (`brain_spot_alerts.pine`) → sends signals to `api/webhook.ts` → places trades directly on Bybit
2. **Smart Scanner** (`api/smart-scanner.ts`) → cron job every 5 min → scans 110 coins → places trades on Bybit

These two systems **don't know about each other**:
- Pine buys LINK via webhook → Smart Scanner doesn't see this position → may also buy LINK
- Smart Scanner sells a position → Pine still thinks it's long → sends another sell signal for a position that no longer exists
- Both systems can exceed your intended risk limits because neither knows the other's positions

**Fix:** Either disable webhook trading or disable smart-scanner auto-trading. Don't run both simultaneously.

---

## WEBHOOK HANDLER BUGS (`api/webhook.ts`)

### WEBHOOK BUG #1: No authentication on TradingView webhook

**Location:** Line 130 onward

Anyone who knows your URL (`https://the-brain-omega.vercel.app/api/webhook`) can POST a fake signal:
```json
{"action": "buy", "symbol": "SHIB", "qty": "1000"}
```
And your bot will execute it on Bybit with real money.

**Fix:** Add a secret token to your webhook URL and validate it:
```typescript
const webhookSecret = process.env.WEBHOOK_SECRET;
if (webhookSecret && payload.secret !== webhookSecret) {
  return res.status(401).json({ error: 'Invalid webhook secret' });
}
```

### WEBHOOK BUG #2: `qty: "all"` sell doesn't handle rounding for small-qty coins

**Location:** Line 149-157

```typescript
sellQty = String(Math.floor(raw * 100) / 100);
```

For coins like SHIB where you might hold 500,000 units, `Math.floor(raw * 100) / 100` is fine. But for BTC where you hold 0.00012345, this rounds to 0.00 — effectively zero. The sell fails silently.

**Fix:** Use dynamic precision based on price:
```typescript
const decimals = raw >= 1 ? 4 : raw >= 0.01 ? 6 : 8;
sellQty = String(Math.floor(raw * Math.pow(10, decimals)) / Math.pow(10, decimals));
```

---

## `src/services/bybit.ts` BUG

### BYBIT SERVICE BUG #1: Uses `category: 'linear'` instead of `'spot'`

**Location:** `bybit.ts` lines 23 and 36

```typescript
async getMarketPrice(symbol: string) {
  const res = await this.client.getTickers({ category: 'linear', ... });
}
async placeOrder(params: ...) {
  const res = await this.client.submitOrder({ category: 'linear', ... });
}
```

**Problem:** `linear` is for USDT perpetual futures. Your bot is supposed to trade SPOT. This means `src/services/bybit.ts` would place futures orders, not spot orders, if it were used. 

**Good news:** This file (`src/services/bybit.ts`) appears to be the LOCAL CLI bot entry point (`src/index.ts`), not the Vercel serverless functions. The Vercel API files (`api/smart-scanner.ts`, `api/webhook.ts`, `api/trade.ts`) create their own `RestClientV5` instances and correctly use `category: 'spot'`. So this bug only affects local development testing.

**Fix anyway:**
```typescript
category: 'spot',
```

---

## FRONTEND SECURITY ISSUE (`index.html`)

### FRONTEND BUG #1: Telegram bot token exposed in browser

The frontend stores `tgToken` and `tgChat` in localStorage and sends Telegram API calls directly from the browser (lines 1829, 1833, 2934, 3050). Anyone who inspects your browser or intercepts traffic can steal your Telegram bot token.

**Impact:** Low for trading (bot token can't access Bybit), but someone could spam your Telegram chat or impersonate your bot.

---

## UPDATED COMPLETE ACTION PLAN

### STOP IMMEDIATELY:
1. **Disable one of the two trading systems** — either Pine Script webhook OR Smart Scanner auto-trade. Running both = double risk, conflicting positions.

### FIX BEFORE LIVE TRADING:
2. **Bug #1:** Place Bybit server-side conditional SL at entry time
3. **Bug #2:** Check actual balance before selling
4. **Bug #5:** Use `getHistoricOrders` for fill data
5. **Bug #7:** Use modified position size in order
6. **Webhook Bug #1:** Add authentication to webhook endpoint

### FIX WITHIN 1 WEEK:
7. **Bug #4:** Default AI filter to REJECT on error
8. **Bug #9:** Retry state save + emergency alert
9. **Pine Bug #1:** Fix symbol format handling
10. **Webhook Bug #2:** Fix sell qty rounding for small amounts
11. **Reduce strategies** to 2-3 and test individually

### ARCHITECTURE (LONG-TERM):
12. Move from Vercel cron to persistent process for real-time SL
13. Add WebSocket price monitoring
14. Build proper backtester that simulates real conditions (cron delays, slippage, partial fills)
