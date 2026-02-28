import { put, list, del } from '@vercel/blob';

// Trade Log API — stores and retrieves trade history from Vercel Blob
// GET  /api/trades-log          → list all trades (newest first)
// GET  /api/trades-log?stats=1  → get performance stats
// POST /api/trades-log          → log a new trade
// DELETE /api/trades-log?url=x  → delete a specific trade

interface TradeRecord {
  id: string;
  timestamp: string;
  source: 'webhook' | 'manual' | 'bot';
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: string;
  price?: string;
  signal?: string;
  orderType: string;
  result: 'success' | 'failed' | 'dry_run';
  retMsg?: string;
  orderId?: string;
  pnl?: number;
  pnlPercent?: number;
  // For linking buy→sell pairs
  linkedTradeId?: string;
  entryPrice?: number;
  exitPrice?: number;
  holdingDuration?: string;
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET — list trades or get stats
    if (req.method === 'GET') {
      const { cursor } = await list({ prefix: 'trades/', mode: 'folded' });
      const blobs = await list({ prefix: 'trades/' });

      // Read all trade records
      const trades: (TradeRecord & { blobUrl: string })[] = [];
      for (const blob of blobs.blobs) {
        try {
          const r = await fetch(blob.url);
          const trade = await r.json() as TradeRecord;
          trades.push({ ...trade, blobUrl: blob.url });
        } catch {}
      }

      // Sort newest first
      trades.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Stats mode
      if (req.query?.stats === '1') {
        const stats = calculateStats(trades);
        return res.status(200).json({ success: true, stats, totalTrades: trades.length });
      }

      // Limit to last 100
      const limited = trades.slice(0, 100);
      return res.status(200).json({ success: true, trades: limited, total: trades.length });
    }

    // POST — log a new trade
    if (req.method === 'POST') {
      const body = req.body || {};
      const trade: TradeRecord = {
        id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        source: body.source || 'manual',
        symbol: body.symbol || 'UNKNOWN',
        side: body.side || 'Buy',
        qty: body.qty || '0',
        price: body.price,
        signal: body.signal,
        orderType: body.orderType || 'Market',
        result: body.result || 'success',
        retMsg: body.retMsg,
        orderId: body.orderId,
        pnl: body.pnl,
        pnlPercent: body.pnlPercent,
        linkedTradeId: body.linkedTradeId,
        entryPrice: body.entryPrice,
        exitPrice: body.exitPrice,
        holdingDuration: body.holdingDuration,
      };

      const blob = await put(
        `trades/${trade.timestamp.split('T')[0]}/${trade.id}.json`,
        JSON.stringify(trade),
        { access: 'public', addRandomSuffix: false }
      );

      return res.status(200).json({ success: true, trade, url: blob.url });
    }

    // DELETE — remove a trade
    if (req.method === 'DELETE') {
      const url = req.query?.url;
      if (!url) return res.status(400).json({ error: 'Missing url parameter' });
      await del(url);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err: any) {
    console.error('Trades log error:', err.message);
    return res.status(500).json({ error: err.message || 'Trades log error' });
  }
}

function calculateStats(trades: TradeRecord[]) {
  const completed = trades.filter(t => t.result === 'success');
  const buys = completed.filter(t => t.side === 'Buy');
  const sells = completed.filter(t => t.side === 'Sell');
  const withPnl = sells.filter(t => t.pnl !== undefined && t.pnl !== null);

  const totalPnl = withPnl.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const wins = withPnl.filter(t => (t.pnl || 0) > 0);
  const losses = withPnl.filter(t => (t.pnl || 0) <= 0);
  const winRate = withPnl.length > 0 ? (wins.length / withPnl.length * 100) : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnlPercent || 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnlPercent || 0), 0) / losses.length : 0;
  const bestTrade = withPnl.length > 0 ? Math.max(...withPnl.map(t => t.pnl || 0)) : 0;
  const worstTrade = withPnl.length > 0 ? Math.min(...withPnl.map(t => t.pnl || 0)) : 0;

  // Group by symbol
  const bySymbol: Record<string, { trades: number; pnl: number }> = {};
  completed.forEach(t => {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, pnl: 0 };
    bySymbol[t.symbol].trades++;
    bySymbol[t.symbol].pnl += t.pnl || 0;
  });

  // Group by day for equity curve
  const byDay: Record<string, number> = {};
  let runningPnl = 0;
  const sortedSells = [...withPnl].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  sortedSells.forEach(t => {
    const day = t.timestamp.split('T')[0];
    runningPnl += t.pnl || 0;
    byDay[day] = runningPnl;
  });

  return {
    totalTrades: completed.length,
    totalBuys: buys.length,
    totalSells: sells.length,
    totalPnl: Math.round(totalPnl * 100) / 100,
    winRate: Math.round(winRate * 10) / 10,
    winningTrades: wins.length,
    losingTrades: losses.length,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    bestTrade: Math.round(bestTrade * 100) / 100,
    worstTrade: Math.round(worstTrade * 100) / 100,
    bySymbol,
    equityCurve: Object.entries(byDay).map(([date, pnl]) => ({ date, pnl })),
    dryRuns: trades.filter(t => t.result === 'dry_run').length,
    failed: trades.filter(t => t.result === 'failed').length,
  };
}
