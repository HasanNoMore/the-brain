export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { symbols } = req.body || {};
    if (!symbols || !Array.isArray(symbols) || symbols.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 symbols' });
    }

    const coins = symbols.slice(0, 10); // max 10

    // Map symbols to CoinGecko IDs
    const idMap: Record<string, string> = {
      BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin',
      XRP:'ripple', ADA:'cardano', DOGE:'dogecoin', AVAX:'avalanche-2',
      DOT:'polkadot', MATIC:'matic-network', TRX:'tron', LTC:'litecoin',
      SHIB:'shiba-inu', UNI:'uniswap', LINK:'chainlink', ATOM:'cosmos',
      XLM:'stellar', XMR:'monero', ALGO:'algorand', BCH:'bitcoin-cash',
      NEAR:'near', STX:'blockstack', SUI:'sui', APT:'aptos',
      ARB:'arbitrum', OP:'optimism', FIL:'filecoin', AAVE:'aave',
      MKR:'maker', INJ:'injective-protocol', RNDR:'render-token',
      FET:'fetch-ai', PEPE:'pepe', WIF:'dogwifcoin', BONK:'bonk',
    };

    // Fetch 30-day price history for each coin
    const histories: Record<string, number[]> = {};
    await Promise.all(coins.map(async (sym: string) => {
      const id = idMap[sym.toUpperCase()] || sym.toLowerCase();
      try {
        const r = await fetch(
          `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=30&interval=daily`
        );
        if (r.ok) {
          const data: any = await r.json();
          const prices = (data.prices || []).map((p: number[]) => p[1]);
          // Convert to daily returns
          const returns: number[] = [];
          for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i-1]) / prices[i-1]);
          }
          histories[sym.toUpperCase()] = returns;
        }
      } catch {}
    }));

    // Calculate Pearson correlation matrix
    const syms = Object.keys(histories);
    const matrix: Record<string, Record<string, number>> = {};

    for (const a of syms) {
      matrix[a] = {};
      for (const b of syms) {
        if (a === b) { matrix[a][b] = 1; continue; }
        matrix[a][b] = pearson(histories[a], histories[b]);
      }
    }

    return res.status(200).json({ success: true, symbols: syms, matrix });
  } catch (err: any) {
    console.error('Correlation API error:', err.message);
    return res.status(500).json({ error: err.message || 'Correlation error' });
  }
}

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i]; sumY2 += y[i] * y[i];
  }

  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;
  return Math.round(((n * sumXY - sumX * sumY) / denom) * 100) / 100;
}
