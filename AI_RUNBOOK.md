# The Brain — AI Runbook

## Purpose
This runbook restores context for The Brain UI + webhook automation and how it connects to Brain Bot Versol.

## Web UI
- **Entry point:** `index.html`
- Single-page dashboard with signal generator and CoinGecko pricing.

## Webhook trading
- **Endpoint:** `https://the-brain-omega.vercel.app/api/trade`
- **Payload example:**
```json
{
  "symbol": "BTCUSDT",
  "side": "Buy",
  "qty": "15"
}
```

## Handler
- **Primary webhook handler:** `api/trade.js`
- Validates: side, symbol, qty
- Enforces minimum order value (15 USDT)

## Brain Bot Versol (runtime)
- **Runbook:** `../Brain bot Versol/AI_RUNBOOK.md`
- Bot runs locally on Mac for now.
- Secrets are in `.env` in the bot repo (not in config).

## Common tasks
### Start the UI
- Open `index.html` locally (no build step).

### Send a webhook test
- Use the payload above and hit the `/api/trade` endpoint.

## Safety notes
- Keep API keys only in `.env` and never commit them.
- Use `BRAINBOT_DRY_RUN=false` and `BRAINBOT_TESTNET=false` for live trading.
