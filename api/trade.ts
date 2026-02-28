import { RestClientV5 } from 'bybit-api';
import { put } from '@vercel/blob';

async function logTrade(trade: Record<string, any>) {
  try {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = { id, timestamp: new Date().toISOString(), ...trade };
    const date = record.timestamp.split('T')[0];
    await put(
      `trades/${date}/${id}.json`,
      JSON.stringify(record),
      { access: 'public', addRandomSuffix: false }
    );
  } catch (e: any) {
    console.error('[TRADE LOG] Failed:', e.message);
  }
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { symbol, side, qty, orderType, price } = req.body || {};

    if (!symbol || !side || !qty) {
      return res.status(400).json({ error: 'Missing required fields: symbol, side, qty' });
    }

    if (!['Buy', 'Sell'].includes(side)) {
      return res.status(400).json({ error: 'side must be "Buy" or "Sell"' });
    }

    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      return res.status(500).json({ error: 'Bybit API credentials not configured' });
    }

    const dryRun = process.env.BRAINBOT_DRY_RUN === 'true';
    const testnet = process.env.BRAINBOT_TESTNET === 'true';

    if (dryRun) {
      await logTrade({
        source: 'manual',
        symbol, side, qty, orderType: orderType || 'Market', price,
        result: 'dry_run',
        retMsg: `Would place ${side} ${orderType || 'Market'} for ${qty} ${symbol}`,
      });
      return res.status(200).json({
        success: true,
        dryRun: true,
        message: `[DRY RUN] Would place ${side} ${orderType || 'Market'} order for ${qty} ${symbol}`,
        order: { symbol, side, qty, orderType: orderType || 'Market', price },
      });
    }

    const client = new RestClientV5({
      key: apiKey,
      secret: apiSecret,
      testnet,
    });

    const result = await client.submitOrder({
      category: 'spot',
      symbol,
      side,
      orderType: orderType || 'Market',
      qty,
      ...(orderType === 'Limit' && price ? { price } : {}),
      ...(side === 'Buy' && (!orderType || orderType === 'Market') ? { marketUnit: 'quoteCoin' } : {}),
    });

    const isSuccess = result.retCode === 0;

    await logTrade({
      source: 'manual',
      symbol, side, qty, orderType: orderType || 'Market', price,
      result: isSuccess ? 'success' : 'failed',
      retMsg: result.retMsg,
      orderId: result.result?.orderId,
    });

    return res.status(200).json({
      success: isSuccess,
      dryRun: false,
      result: result.result,
      retMsg: result.retMsg,
    });
  } catch (err: any) {
    console.error('Trade API error:', err);
    await logTrade({
      source: 'manual',
      symbol: req.body?.symbol || 'UNKNOWN',
      side: req.body?.side || 'Buy',
      qty: req.body?.qty || '0',
      orderType: req.body?.orderType || 'Market',
      result: 'failed',
      retMsg: err.message,
    }).catch(() => {});
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
