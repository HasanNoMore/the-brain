# Brain Bot — Full System Architecture & Data Flow

## Generated: 2026-02-28
## Production URL: https://the-brain-omega.vercel.app

---

## 1. SERVICES & PLATFORMS USED

| # | Service | Purpose | URL/Dashboard | Cost |
|---|---------|---------|---------------|------|
| 1 | **Vercel** | Hosting (frontend + API serverless functions) | https://vercel.com/dashboard | Free tier (Hobby) |
| 2 | **Upstash Redis** | Trading state persistence (config, positions, P&L) | https://console.upstash.com | Free tier (10K commands/day) |
| 3 | **Vercel Blob** | Trade journal + activity log storage | Managed by Vercel | Included in Vercel plan |
| 4 | **Bybit** | Crypto exchange API (spot trading + market data) | https://www.bybit.com | Trading fees only |
| 5 | **Anthropic (Claude)** | AI Signal Brain + Chat analysis | https://console.anthropic.com | Pay-per-use API |
| 6 | **CryptoCompare** | News aggregation API | https://min-api.cryptocompare.com | Free tier |
| 7 | **CoinGecko** | Correlation matrix data (30-day returns) | https://api.coingecko.com | Free tier |
| 8 | **Telegram Bot** | Alert notifications + AI chat bot | https://t.me/BotFather | Free |
| 9 | **cron-job.org** | Scheduled scanner trigger (every 5 min) | https://cron-job.org | Free tier |
| 10 | **TradingView** | Chart widget embedding + webhook alerts | https://www.tradingview.com | Free |

---

## 2. ENVIRONMENT VARIABLES (Secrets)

| Variable | Service | Purpose |
|----------|---------|---------|
| `BYBIT_API_KEY` | Bybit | Exchange API authentication |
| `BYBIT_API_SECRET` | Bybit | Exchange API signing |
| `BRAINBOT_TESTNET` | Bybit | `false` = live trading, `true` = testnet |
| `BRAINBOT_DRY_RUN` | Bot | `false` = real orders, `true` = simulate |
| `ANTHROPIC_API_KEY` | Anthropic | Claude AI API access |
| `OPENROUTER_API_KEY` | OpenRouter | Fallback LLM (Mistral) |
| `OPENROUTER_MODEL` | OpenRouter | `mistralai/mistral-7b-instruct:free` |
| `TELEGRAM_BOT_TOKEN` | Telegram | Bot token for sending alerts |
| `TELEGRAM_CHAT_ID` | Telegram | Chat ID to send alerts to |
| `UPSTASH_REDIS_REST_URL` | Upstash | Redis HTTP endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash | Redis authentication |
| `BLOB_READ_WRITE_TOKEN` | Vercel | Blob storage access |
| `CRON_SECRET` | cron-job.org | Bearer token for cron authentication |

**Where configured:** Vercel Dashboard → Project Settings → Environment Variables

---

## 3. FILE STRUCTURE

```
Brain bot Versol/
├── public/
│   └── index.html          # Frontend SPA (3200+ lines)
├── api/
│   ├── smart-scanner.ts    # Core scanner + auto-trader (2500+ lines)
│   ├── portfolio.ts        # Bybit account balances
│   ├── trades-log.ts       # Trade journal (Vercel Blob)
│   ├── activity.ts         # Activity feed (Vercel Blob)
│   ├── webhook.ts          # TradingView + Telegram bot
│   ├── chat.ts             # Claude AI chat endpoint
│   ├── news.ts             # CryptoCompare news
│   ├── correlation.ts      # Coin correlation matrix
│   ├── heatmap.ts          # RSI heatmap data
│   ├── rsi-heatmap.ts      # Advanced RSI analyzer
│   ├── backtest.ts         # Strategy backtester
│   └── trade.ts            # Manual trade executor
├── vercel.json             # Vercel config (60s timeout)
├── package.json            # Dependencies
├── tsconfig.json           # TypeScript config
└── .env                    # Local env vars (not deployed)
```

---

## 4. DATA FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│                        CRON-JOB.ORG                             │
│                 Fires every 5 minutes                           │
│         GET /api/smart-scanner?alert=1                          │
│         Authorization: Bearer <CRON_SECRET>                     │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                    VERCEL SERVERLESS                              │
│                  /api/smart-scanner.ts                            │
│                                                                  │
│  1. SCAN ──────────────────────────────────────────────────────  │
│     │ Fetch 110 coins × 3 timeframes (1h + 4h + daily)          │
│     │ from Bybit Public API                                      │
│     │ Compute: RSI, EMA, MACD, BB, OBV, CMF, StochRSI,          │
│     │          Supertrend, VWAP, ATR, Divergence, Squeeze        │
│     │ Generate signals: strength, confidence, action, category   │
│     ▼                                                            │
│  2. DETECT MARKET REGIME ────────────────────────────────────── │
│     │ Analyze BTC: RSI + momentum + EMA structure + supertrend   │
│     │ Output: strong_bull / bull / neutral / bear / strong_bear   │
│     ▼                                                            │
│  3. SEND TELEGRAM ALERTS ────────────────────────────────────── │
│     │ Filter: breakout ≥55%, early_gainer ≥55%, brain ≥72%       │
│     │ Dedup: 6h TTL per coin+category (stored in Redis)          │
│     │ Max: 6 alerts per cron run                                 │
│     ▼                                                            │
│  4. MANAGE POSITIONS ────────────────────────────────────────── │
│     │ Check SL, TP, trailing stop, profit lock, max hold time    │
│     │ Check scanner-driven exit (SELL signal on held coin)       │
│     │ Execute sell orders via Bybit API                           │
│     ▼                                                            │
│  5. EXECUTE NEW TRADES ──────────────────────────────────────── │
│     │ Filter: SAFE_TRADING_COINS only                            │
│     │ Filter: min confidence, BTC regime guard                   │
│     │ Match: 11 strategies (evaluateStrategies)                  │
│     │ AI Brain: Claude Haiku APPROVE/REJECT (if enabled)         │
│     │ Execute: Bybit spot market buy                             │
│     │ Log: Redis state + Vercel Blob (Trade Journal)             │
│     ▼                                                            │
│  6. SAVE STATE ──────────────────────────────────────────────── │
│     │ Write to Upstash Redis (alertTimes + positions + config)   │
│     │ Write activity to Vercel Blob                               │
│     ▼                                                            │
│  7. RETURN JSON ─────────────────────────────────────────────── │
│     Summary: scanned, found, alerts, trades, positions closed    │
└──────────────────────────────────────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ TELEGRAM │ │ UPSTASH  │ │  BYBIT   │
    │  Bot API │ │  Redis   │ │ Exchange │
    │  Alerts  │ │  State   │ │  Orders  │
    └──────────┘ └──────────┘ └──────────┘
```

---

## 5. API ENDPOINTS

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/smart-scanner` | GET | Scan coins, return signals |
| `/api/smart-scanner?alert=1` | GET | Cron: scan + alert + trade (auth required) |
| `/api/smart-scanner?action=getConfig` | GET | Get bot config + strategies |
| `/api/smart-scanner?action=setConfig` | POST | Update bot config + strategies |
| `/api/smart-scanner?action=getPositions` | GET | Open positions + history + daily picks |
| `/api/smart-scanner?action=closePosition` | POST | Manually close a position |
| `/api/smart-scanner?action=closeDcaStack` | POST | Manually close a DCA stack |
| `/api/smart-scanner?action=emergencyStop` | POST | Close ALL positions, disable bot |
| `/api/smart-scanner?action=resetStats` | POST | Reset P&L and trade counters |
| `/api/smart-scanner?action=dailyPick` | GET | AI-ranked daily top 5 coin picks |
| `/api/smart-scanner?action=trackPicks` | GET | Track 24h performance of yesterday's picks |
| `/api/smart-scanner?action=debugTrade` | GET | Full diagnostic of trade pipeline |
| `/api/smart-scanner?action=cleanup` | POST | Delete old Vercel Blob data |
| `/api/portfolio` | GET | Bybit account balances |
| `/api/trades-log` | GET/POST/DELETE | Trade journal (Vercel Blob) |
| `/api/activity` | GET | Activity feed (Vercel Blob) |
| `/api/news` | GET | Crypto news (CryptoCompare) |
| `/api/correlation` | POST | 30-day correlation matrix (CoinGecko) |
| `/api/heatmap` | GET | RSI heatmap data |
| `/api/rsi-heatmap` | GET | Advanced RSI analysis |
| `/api/backtest` | POST | Strategy backtester |
| `/api/trade` | POST | Manual trade executor |
| `/api/chat` | POST | Claude AI chat + chart analysis |
| `/api/webhook` | POST | TradingView webhooks + Telegram bot |

---

## 6. STORAGE MAP

### Upstash Redis (Key: `trading-state`)
```
{
  config: {
    enabled, positionSizeUSD, stopLossPercent, takeProfitPercent,
    cooldownHours, maxPerCoin, maxTotal, minStrength, minConfidence,
    trailingStopPercent, profitLockPercent, maxHoldHours,
    tp1Percent, tp1SizePercent, maxDrawdownUSD,
    dcaEnabled, dcaOrderSizeUSD, dcaMaxOrders, dcaTriggerDropPercent,
    dcaTakeProfitPercent, dcaStopLossPercent, dcaCoins[],
    aiBrainEnabled
  },
  strategies: [{ id, name, enabled, trades, wins, losses, pnl }],
  positions: [{ id, symbol, entryPrice, qty, stopLoss, takeProfit, status, strategy, ... }],
  history: [closed positions, last 200],
  cooldowns: { symbol → ISO timestamp },
  dcaStacks: [{ id, symbol, entries[], avgEntryPrice, totalQty, status }],
  dcaHistory: [closed DCA stacks],
  alertTimes: { "SYMBOL_category" → timestamp_ms },
  dailyPicks: [{ date, regime, picks[{ symbol, score, ... }] }],
  totalPnl, totalTrades, winCount, lossCount
}
```

### Vercel Blob Storage
```
trades/{YYYY-MM-DD}/{trade_id}.json     → Individual trade records
activity/cron_{timestamp}.json          → Cron scan summaries
```

---

## 7. TRADING STRATEGIES (11 active)

| # | Strategy | Conditions | Type |
|---|----------|-----------|------|
| 1 | Scanner Signal | action=buy/strong_buy + strength≥40 | Core |
| 2 | RSI Reversal | RSI<35 + (RSI REVERSAL signal OR StochRSI<20) | Core |
| 3 | Bollinger Bounce | price ≤ lower BB × 1.01 + RSI<45 | Core |
| 4 | Dip Buyer | 24h change ≤ -3% + volume≥1.3x + RSI<45 | Core |
| 5 | Early Gainer | hourly vol spike ≥2x + 1h change>0.3% | Core |
| 6 | DCA Accumulator | Separate DCA engine (dollar cost averaging) | Core |
| 7 | Divergence Play | RSI bullish divergence + RSI<55 | Pro |
| 8 | Supertrend Ride | Supertrend flipped bullish + momentum>0 | Pro |
| 9 | Smart Money | OBV breakout + CMF>0.05 + RSI<68 | Pro |
| 10 | VWAP Reclaim | Price reclaims VWAP + volume≥1.2x + CMF>0 | Advanced |
| 11 | Panic Reversal | 1h drop≤-3% + RSI<25 + volume≥1.8x + StochRSI<15 | Advanced |

---

## 8. CRON JOBS (cron-job.org)

| Job | URL | Schedule | Purpose |
|-----|-----|----------|---------|
| Scanner + Auto-Trade | `/api/smart-scanner?alert=1` | Every 5 min | Scan, alert, trade |
| Daily Coin Picker | `/api/smart-scanner?action=dailyPick` | Daily 08:00 UTC | AI-ranked top 5 picks |
| Pick Performance | `/api/smart-scanner?action=trackPicks` | Daily 08:05 UTC | Track yesterday's pick returns |

---

## 9. CURRENT BOT STATUS (2026-02-28)

| Parameter | Value |
|-----------|-------|
| Bot Enabled | YES |
| AI Brain | ON (Claude Haiku) |
| USDT Available | $301.84 |
| Position Size | $40 |
| Max Positions | 6 |
| Stop Loss | 3.5% |
| Take Profit | 12% |
| Trailing Stop | 2.5% |
| Profit Lock | 4% |
| Max Hold | 72h |
| Min Strength | 40% |
| Min Confidence | 40% |
| Max Drawdown | $0 (disabled) |
| Strategies Active | 11/11 |
| Open Positions | 0 |
| Total Trades | 0 |
| Market Regime | STRONG BEAR |

---

## 10. WHY NO TRADES HAVE EXECUTED

The bot is working correctly. No trades happened because:

1. **Market is in STRONG BEAR regime** — BTC down ~47% from October 2025 ATH
2. **Out of 110 coins scanned, only 1 safe BUY signal exists** (ICP at 65%)
3. **All other coins are WATCH** (15-45% strength) — too weak to trade
4. **Dip Buyer needs -3%+ drops** — most coins are -1% to -2% daily (not enough)
5. **RSI Reversal needs RSI<35** — most coins are RSI 40-60 (not oversold enough)
6. **The bot correctly waits** — it doesn't force trades in a dead market

When the market moves (a real crash day or a bounce), the bot will trade.

---

## 11. DEPLOYMENT

```bash
# Deploy to production
cd "Brain bot Versol"
vercel --prod

# Check deployment
vercel ls

# View logs
vercel logs the-brain-omega.vercel.app

# Environment variables
vercel env ls
vercel env add VARIABLE_NAME
```
