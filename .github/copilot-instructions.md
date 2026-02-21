# Copilot instructions for The Brain

## Big picture
- Single-page dashboard lives in `index.html` with all UI + logic inline (Tailwind CDN, Lucide, TradingView widget).
- Portfolio state is stored in `localStorage` under `my_portfolio_v17`; per-coin holdings + avg entry are client-side only.
- Price polling uses CoinGecko (`/api/v3/simple/price`) every 30s to update prices, equity, and PnL.
- “Signal Generator” builds a JSON payload and can forward it to Telegram; the payload is meant for the webhook handler.
- Webhook execution is serverless-style: `api/trade.js` is the primary handler; `trade.js` and `the-brain/trade.js` are legacy/alternate handlers.

## Key workflows
- There is no build step in this repo; open `index.html` directly for local UI testing.
- Deploy as a static site plus a serverless function for `api/trade.js` (e.g., Vercel-style `/api` routing).
- Webhook testing: POST JSON `{ symbol, side, qty }` to `/api/trade` and watch Bybit response logs.

## Project-specific conventions
- Signal payload fields: `symbol` is uppercased and typically suffixed with `USDT` in the UI.
- `side` is normalized to `Buy`/`Sell` in `api/trade.js`; other values are rejected.
- Quantity validation: numeric, > 0, and compared against `MIN_ORDER_QTY` or `MIN_ORDER_QTY_BY_SYMBOL`.
- The UI stores Telegram + Bybit keys in `localStorage` and redacts them in JSON preview.

## Integrations & env vars
- Bybit REST: `POST /v5/order/create` with HMAC signature (`api/trade.js`).
- Env vars used by `api/trade.js`: `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `BYBIT_TESTNET`, `MIN_ORDER_QTY`, `MIN_ORDER_QTY_BY_SYMBOL` (JSON map).
- Telegram API used in the browser for connection tests and signal forwarding.
- TradingView widget for charts, CoinGecko for spot prices.

## Files to reference
- UI + client logic: `index.html`.
- Serverless webhook handler: `api/trade.js` (preferred).
- Legacy/alternate handlers: `trade.js`, `the-brain/trade.js`.
