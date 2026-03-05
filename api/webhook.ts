import { RestClientV5 } from 'bybit-api';
import { put, list } from '@vercel/blob';
import Anthropic from '@anthropic-ai/sdk';

// ─── Trade / Activity Logging ─────────────────────────────────────────────────
async function logTrade(trade: Record<string, any>) {
  try {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = { id, timestamp: new Date().toISOString(), ...trade };
    const date = record.timestamp.split('T')[0];
    await put(`trades/${date}/${id}.json`, JSON.stringify(record), { access: 'public', addRandomSuffix: false });
    console.log(`[TRADE LOG] ${id} — ${trade.side} ${trade.symbol}`);
  } catch (e: any) { console.error('[TRADE LOG] Failed to log:', e.message); }
}

async function logActivity(activity: Record<string, any>) {
  try {
    const id = `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = { id, timestamp: new Date().toISOString(), ...activity };
    await put(`activity/${id}.json`, JSON.stringify(record), { access: 'public', addRandomSuffix: false });
  } catch (e: any) { console.error('[ACTIVITY LOG] Failed:', e.message); }
}

// ─── Telegram AI Bot helpers ──────────────────────────────────────────────────
async function sendTgMsg(token: string, chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

async function getAccountData(): Promise<string> {
  const apiKey    = process.env.BYBIT_API_KEY    || '';
  const apiSecret = process.env.BYBIT_API_SECRET || '';
  let balanceStr = '', posStr = '', botStr = '';

  // USDT balance — use RestClientV5 (handles signing correctly)
  try {
    const client = new RestClientV5({ key: apiKey, secret: apiSecret, testnet: false });
    const r = await client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
    const coins = r?.result?.list?.[0]?.coin || [];
    const usdt  = coins.find((c: any) => c.coin === 'USDT');
    if (usdt) balanceStr = `USDT Total: $${parseFloat(usdt.walletBalance||'0').toFixed(2)} | Available: $${parseFloat(usdt.availableToWithdraw||usdt.walletBalance||'0').toFixed(2)}`;
  } catch {}

  // Bot state (positions + P&L)
  try {
    const blobs = await list({ prefix: 'trading/state' });
    if (blobs.blobs.length > 0) {
      const res = await fetch(blobs.blobs[0].url);
      if (res.ok) {
        const state = await res.json() as any;
        const open  = (state.positions || []).filter((p: any) => p.status === 'open');
        const cfg   = state.config || {};
        const wr    = state.totalTrades > 0 ? Math.round((state.winCount / state.totalTrades) * 100) : 0;
        botStr  = `Bot: ${cfg.enabled ? 'ON' : 'OFF'} | Open: ${open.length}/${cfg.maxTotal} | P&L: ${state.totalPnl >= 0 ? '+' : ''}$${(state.totalPnl||0).toFixed(2)} | WinRate: ${wr}%`;
        posStr  = open.length ? open.map((p: any) => `• ${p.symbol} entry $${p.entryPrice?.toFixed(4)} SL $${p.stopLoss?.toFixed(4)}`).join('\n') : 'No open positions';
      }
    }
  } catch {}

  return [balanceStr, botStr, posStr ? `Positions:\n${posStr}` : ''].filter(Boolean).join('\n');
}

async function handleTelegramMessage(body: any, tgToken: string, allowedChatId: string) {
  const message = body?.message;
  if (!message?.text) return;
  const chatId = message.chat?.id?.toString();
  if (allowedChatId && chatId !== allowedChatId) return;

  const text = message.text.trim().toLowerCase();

  // /help
  if (text === '/help' || text === 'help') {
    await sendTgMsg(tgToken, chatId,
      `🧠 *BRAIN Bot Commands*\n\n/balance — USDT balance\n/positions — Open trades\n/status — Bot P&L & config\n/help — This menu\n\nOr ask naturally:\n_"What is my balance?"\n"How many open trades?"\n"Is the bot making money?"_`);
    return;
  }

  // Fetch live account data for all queries
  const context = await getAccountData();

  // Fast command shortcuts
  if (text === '/balance' || text.includes('balance') || text.includes('usdt')) {
    const line = context.split('\n').find(l => l.includes('USDT Total'));
    await sendTgMsg(tgToken, chatId, `💵 ${line || 'Could not fetch balance'}`);
    return;
  }
  if (text === '/positions' || text.includes('position')) {
    const lines = context.split('\n').filter(l => l.startsWith('•') || l === 'No open positions');
    await sendTgMsg(tgToken, chatId, lines.length ? lines.join('\n') : '📭 No open positions');
    return;
  }
  if (text === '/status' || text.includes('bot status') || text.includes('p&l') || text.includes('pnl')) {
    const line = context.split('\n').find(l => l.startsWith('Bot:'));
    await sendTgMsg(tgToken, chatId, `🤖 ${line || 'Could not fetch status'}`);
    return;
  }

  // AI: answer naturally using Claude Haiku
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `You are a trading assistant for The BRAIN Bot (Bybit spot trading bot).
Live data: ${context}
Be concise. Use the data above to answer. No markdown formatting — plain text only.`,
      messages: [{ role: 'user', content: message.text }],
    });
    await sendTgMsg(tgToken, chatId, (r.content[0] as any).text || 'No response');
  } catch (e: any) {
    await sendTgMsg(tgToken, chatId, `⚠️ AI error: ${e.message}`);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch {
      return res.status(400).json({ error: 'Invalid JSON in webhook body' });
    }
  }

  // ── Route: Telegram bot (body has "message" or "update_id" fields) ──────────
  if (payload?.update_id !== undefined || payload?.message?.text) {
    const tgToken = process.env.TELEGRAM_BOT_TOKEN || '';
    const tgChat  = process.env.TELEGRAM_CHAT_ID   || '';
    if (tgToken) {
      await handleTelegramMessage(payload, tgToken, tgChat);
    }
    return res.status(200).json({ ok: true });
  }

  // ── Route: TradingView webhook ────────────────────────────────────────────────
  try {
    // Webhook Bug #1 fix: validate secret token so nobody can spoof trades via this URL
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (webhookSecret) {
      const provided = (req.query?.secret as string) || payload?.secret;
      if (provided !== webhookSecret) {
        console.warn('[WEBHOOK] Rejected — invalid or missing secret');
        return res.status(401).json({ error: 'Unauthorized: invalid webhook secret' });
      }
    }

    const { action, symbol, qty, signal, price } = payload || {};
    if (!action || !symbol) {
      return res.status(400).json({ error: 'Missing action or symbol in webhook payload' });
    }

    const side        = action.toLowerCase() === 'buy' ? 'Buy' : 'Sell';
    // Pine Bug #1 fix: handle BYBIT:BTCUSDT, BINANCE:BTCUSDT, BTCUSDT.P, BTC/USDT formats
    const cleanSymbol = symbol
      .replace(/^(BYBIT|BINANCE|OKX|COINBASE):/i, '')
      .replace(/\.[A-Z]+$/, '')   // strip .P, .PERP etc
      .replace('/', '')
      .toUpperCase();
    const finalSymbol = cleanSymbol.endsWith('USDT') ? cleanSymbol : cleanSymbol + 'USDT';
    const tradeQty    = qty === 'all' ? '0' : (qty || '10');
    const apiKey      = process.env.BYBIT_API_KEY;
    const apiSecret   = process.env.BYBIT_API_SECRET;
    const tgToken     = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat      = process.env.TELEGRAM_CHAT_ID;

    if (!apiKey || !apiSecret) return res.status(500).json({ error: 'Bybit API credentials not configured' });

    const dryRun = process.env.BRAINBOT_DRY_RUN === 'true';
    const testnet = process.env.BRAINBOT_TESTNET === 'true';
    console.log(`[WEBHOOK] ${side} ${finalSymbol} | qty: ${tradeQty} | signal: ${signal || 'unknown'} | dry: ${dryRun}`);

    await logActivity({ type: 'webhook_received', symbol: finalSymbol, side, qty: tradeQty, signal: signal || 'unknown', dryRun, rawPayload: { action, symbol, qty, signal, price } });

    if (tgToken && tgChat) {
      const emoji = side === 'Buy' ? '🟢' : '🔴';
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text: `${emoji} *WEBHOOK ${side.toUpperCase()}*\nSymbol: \`${finalSymbol}\`\nQty: ${tradeQty} USDT\nSignal: ${signal || 'unknown'}\nDry Run: ${dryRun}`, parse_mode: 'Markdown' }),
      }).catch(() => {});
    }

    if (dryRun) {
      await logTrade({ source: 'webhook', symbol: finalSymbol, side, qty: tradeQty, price: price || null, signal: signal || 'unknown', orderType: 'Market', result: 'dry_run', retMsg: `Would ${side} ${tradeQty} USDT of ${finalSymbol}` });
      return res.status(200).json({ success: true, dryRun: true, message: `[DRY RUN] Would ${side} ${tradeQty} USDT of ${finalSymbol}`, signal });
    }

    const client = new RestClientV5({ key: apiKey, secret: apiSecret, testnet });
    let sellQty = tradeQty;
    if (side === 'Sell' && (qty === 'all' || qty === '0')) {
      try {
        const baseCoin   = finalSymbol.replace('USDT', '');
        const balanceRes = await client.getWalletBalance({ accountType: 'UNIFIED', coin: baseCoin });
        const coinBal    = balanceRes.result?.list?.[0]?.coin?.find((c: any) => c.coin === baseCoin);
        const raw = parseFloat(coinBal?.walletBalance || '0');
        // Webhook Bug #2 fix: dynamic precision — Math.floor(x * 100)/100 rounds BTC 0.00012 to 0.00
        const decimals = raw >= 1000 ? 2 : raw >= 1 ? 4 : raw >= 0.01 ? 6 : 8;
        sellQty = String(Math.floor(raw * Math.pow(10, decimals)) / Math.pow(10, decimals));
        if (raw <= 0) {
          await logTrade({ source: 'webhook', symbol: finalSymbol, side, qty: '0', signal: signal || 'unknown', orderType: 'Market', result: 'failed', retMsg: `No ${baseCoin} balance to sell` });
          return res.status(200).json({ success: true, message: `No ${baseCoin} balance to sell`, signal });
        }
      } catch (e: any) {
        console.error('[WEBHOOK] Balance check failed:', e.message);
        return res.status(500).json({ error: 'Failed to check balance for sell-all' });
      }
    }

    const result   = await client.submitOrder({ category: 'spot', symbol: finalSymbol, side, orderType: 'Market', qty: sellQty, ...(side === 'Buy' ? { marketUnit: 'quoteCoin' } : {}) });
    const isSuccess = result.retCode === 0;
    await logTrade({ source: 'webhook', symbol: finalSymbol, side, qty: sellQty, price: price || null, signal: signal || 'unknown', orderType: 'Market', result: isSuccess ? 'success' : 'failed', retMsg: result.retMsg, orderId: result.result?.orderId });

    if (tgToken && tgChat) {
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text: `${isSuccess ? '✅' : '❌'} *${isSuccess ? 'EXECUTED' : 'FAILED'}*\n${side} ${finalSymbol}\nQty: ${sellQty}\nResult: ${result.retMsg}`, parse_mode: 'Markdown' }),
      }).catch(() => {});
    }

    return res.status(200).json({ success: isSuccess, side, symbol: finalSymbol, qty: sellQty, signal, result: result.result, retMsg: result.retMsg });
  } catch (err: any) {
    console.error('[WEBHOOK] Error:', err.message);
    try {
      const p = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      await logTrade({ source: 'webhook', symbol: p?.symbol || 'UNKNOWN', side: p?.action?.toLowerCase() === 'buy' ? 'Buy' : 'Sell', qty: p?.qty || '0', signal: p?.signal || 'unknown', orderType: 'Market', result: 'failed', retMsg: err.message });
    } catch {}
    return res.status(500).json({ error: err.message || 'Webhook error' });
  }
}
