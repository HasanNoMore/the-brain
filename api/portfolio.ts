import { RestClientV5 } from 'bybit-api';

// Real Portfolio API — fetches actual Bybit account balances
// Uses Bybit's own tickers for accurate pricing (not CoinGecko)
// GET /api/portfolio → returns all non-zero balances with USD values

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      return res.status(500).json({ error: 'Bybit API credentials not configured' });
    }

    const testnet = process.env.BRAINBOT_TESTNET === 'true';
    const client = new RestClientV5({ key: apiKey, secret: apiSecret, testnet });

    // Fetch unified account balance
    const balanceRes = await client.getWalletBalance({ accountType: 'UNIFIED' });

    if (balanceRes.retCode !== 0) {
      return res.status(500).json({ error: 'Bybit API error: ' + balanceRes.retMsg });
    }

    const account = balanceRes.result?.list?.[0];
    if (!account) {
      return res.status(200).json({ success: true, holdings: [], totalUSD: 0 });
    }

    // Filter non-zero balances
    const coins = (account.coin || []).filter((c: any) => {
      const bal = parseFloat(c.walletBalance || '0');
      return bal > 0.00001;
    });

    // Get prices from Bybit's own tickers — most accurate for coins in your account
    const nonStable = coins
      .map((c: any) => c.coin)
      .filter((s: string) => s !== 'USDT' && s !== 'USDC');

    const prices: Record<string, number> = {};

    // Fetch spot tickers from Bybit for each coin
    if (nonStable.length > 0) {
      try {
        const tickerRes = await client.getTickers({ category: 'spot' });
        if (tickerRes.retCode === 0 && tickerRes.result?.list) {
          for (const ticker of tickerRes.result.list) {
            const sym = (ticker as any).symbol as string;
            const lastPrice = parseFloat((ticker as any).lastPrice || '0');
            if (lastPrice > 0 && sym.endsWith('USDT')) {
              const coin = sym.replace('USDT', '');
              prices[coin] = lastPrice;
            }
          }
        }
      } catch {}
    }

    // Build holdings array
    const holdings = coins.map((c: any) => {
      const symbol = c.coin;
      const balance = parseFloat(c.walletBalance || '0');
      const available = parseFloat(c.availableToWithdraw || '0');
      const locked = balance - available;

      let usdValue = 0;
      let price = 0;
      if (symbol === 'USDT' || symbol === 'USDC') {
        price = 1;
        usdValue = balance;
      } else if (prices[symbol]) {
        price = prices[symbol];
        usdValue = balance * price;
      }
      // No fallback to Bybit usdValue — if we can't price it, show 0

      return {
        symbol,
        balance: Math.round(balance * 1e8) / 1e8,
        available: Math.round(available * 1e8) / 1e8,
        locked: Math.round(locked * 1e8) / 1e8,
        price: Math.round(price * 1e8) / 1e8,
        usdValue: Math.round(usdValue * 100) / 100,
        unrealisedPnl: parseFloat(c.unrealisedPnl || '0'),
      };
    });

    // Sort by USD value (largest first)
    holdings.sort((a, b) => b.usdValue - a.usdValue);

    const totalUSD = Math.round(holdings.reduce((sum, h) => sum + h.usdValue, 0) * 100) / 100;
    const totalEquity = parseFloat(account.totalEquity || '0');
    const totalPnl = parseFloat(account.totalPerpUPL || '0');

    return res.status(200).json({
      success: true,
      accountType: account.accountType,
      totalEquity: Math.round(totalEquity * 100) / 100,
      totalUSD,
      totalPnl: Math.round(totalPnl * 100) / 100,
      holdings,
      coinCount: holdings.length,
    });
  } catch (err: any) {
    console.error('Portfolio API error:', err.message);
    return res.status(500).json({ error: err.message || 'Portfolio error' });
  }
}
