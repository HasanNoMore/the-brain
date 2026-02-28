// RSI Heatmap API — Multi-timeframe RSI for top coins (like Coinglass)
// GET /api/rsi-heatmap          → top 50 coins with RSI at 15m, 1h, 4h, 12h, 24h
// GET /api/rsi-heatmap?coins=20 → limit number of coins

function computeRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss += -change;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function getRSIZone(rsi: number): string {
  if (rsi >= 70) return 'overbought';
  if (rsi >= 60) return 'strong';
  if (rsi >= 40) return 'neutral';
  if (rsi >= 30) return 'weak';
  return 'oversold';
}

interface CoinRSI {
  symbol: string;
  name: string;
  price: number;
  change1h: number;
  change24h: number;
  marketCap: number;
  image: string;
  rsi15m: number;
  rsi1h: number;
  rsi4h: number;
  rsi12h: number;
  rsi24h: number;
  zone15m: string;
  zone1h: string;
  zone4h: string;
  zone12h: string;
  zone24h: string;
  avgRSI: number;
  overallZone: string;
  signal: string;
}

// Fetch klines from Bybit (matches user's trading exchange)
async function fetchKlines(symbol: string, interval: string, limit: number): Promise<number[]> {
  const bybitInterval: Record<string, string> = {
    '15m': '15', '1h': '60', '4h': '240', '12h': '720', '1d': 'D',
  };
  const iv = bybitInterval[interval] || interval;
  try {
    const r = await fetch(
      `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}USDT&interval=${iv}&limit=${limit}`
    );
    if (!r.ok) return [];
    const data = (await r.json()) as any;
    if (data.retCode !== 0 || !data.result?.list) return [];
    // Bybit returns newest first, reverse to oldest first, return close prices
    return data.result.list.reverse().map((k: any) => parseFloat(k[4]));
  } catch { return []; }
}

// Map CoinGecko IDs to Binance symbols
const SYMBOL_MAP: Record<string, string> = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', binancecoin: 'BNB',
  ripple: 'XRP', dogecoin: 'DOGE', cardano: 'ADA', avalanche: 'AVAX',
  polkadot: 'DOT', chainlink: 'LINK', uniswap: 'UNI', cosmos: 'ATOM',
  litecoin: 'LTC', near: 'NEAR', filecoin: 'FIL', aptos: 'APT',
  arbitrum: 'ARB', optimism: 'OP', immutable: 'IMX', injective: 'INJ',
  sui: 'SUI', sei: 'SEI', celestia: 'TIA', thorchain: 'RUNE',
  'fetch-ai': 'FET', 'render-token': 'RNDR', 'the-graph': 'GRT',
  aave: 'AAVE', maker: 'MKR', havven: 'SNX', 'curve-dao-token': 'CRV',
  'lido-dao': 'LDO', pendle: 'PENDLE', stacks: 'STX', worldcoin: 'WLD',
  jupiter: 'JUP', pyth: 'PYTH', wormhole: 'W', ethena: 'ENA',
  pepe: 'PEPE', dogwifcoin: 'WIF', bonk: 'BONK', floki: 'FLOKI',
  ordinals: 'ORDI', tron: 'TRX', stellar: 'XLM', algorand: 'ALGO',
  vechain: 'VET', fantom: 'FTM', 'matic-network': 'MATIC',
  'shiba-inu': 'SHIB', toncoin: 'TON', 'internet-computer': 'ICP',
  hedera: 'HBAR', 'leo-token': 'LEO', kaspa: 'KAS',
};

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const coinLimit = Math.min(50, parseInt(req.query?.coins || '50') || 50);

    // Fetch top coins from CoinGecko for prices + metadata
    const cgRes = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${coinLimit}&page=1&sparkline=false&price_change_percentage=1h,24h`
    );
    if (!cgRes.ok) throw new Error('CoinGecko API error');
    const coins = (await cgRes.json()) as any[];

    // For each coin, fetch multi-timeframe klines from Binance and compute RSI
    const results: CoinRSI[] = [];
    const batchSize = 5;

    for (let i = 0; i < coins.length; i += batchSize) {
      const batch = coins.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(async (coin: any) => {
        const binSymbol = SYMBOL_MAP[coin.id] || (coin.symbol || '').toUpperCase();
        if (!binSymbol) return null;

        try {
          // Fetch all timeframes in parallel
          const [k15m, k1h, k4h, k12h, k1d] = await Promise.all([
            fetchKlines(binSymbol, '15m', 20),
            fetchKlines(binSymbol, '1h', 20),
            fetchKlines(binSymbol, '4h', 20),
            fetchKlines(binSymbol, '12h', 20),
            fetchKlines(binSymbol, '1d', 20),
          ]);

          const rsi15m = k15m.length >= 15 ? computeRSI(k15m) : -1;
          const rsi1h = k1h.length >= 15 ? computeRSI(k1h) : -1;
          const rsi4h = k4h.length >= 15 ? computeRSI(k4h) : -1;
          const rsi12h = k12h.length >= 15 ? computeRSI(k12h) : -1;
          const rsi24h = k1d.length >= 15 ? computeRSI(k1d) : -1;

          const validRSIs = [rsi15m, rsi1h, rsi4h, rsi12h, rsi24h].filter(r => r >= 0);
          const avgRSI = validRSIs.length > 0
            ? Math.round(validRSIs.reduce((a, b) => a + b, 0) / validRSIs.length * 100) / 100
            : 50;

          // Generate signal
          let signal = '';
          const oversoldCount = validRSIs.filter(r => r < 30).length;
          const overboughtCount = validRSIs.filter(r => r >= 70).length;
          if (oversoldCount >= 3) signal = 'STRONG BUY — Multi-TF oversold';
          else if (oversoldCount >= 2) signal = 'BUY SIGNAL — Oversold on 2+ timeframes';
          else if (overboughtCount >= 3) signal = 'STRONG SELL — Multi-TF overbought';
          else if (overboughtCount >= 2) signal = 'SELL SIGNAL — Overbought on 2+ timeframes';
          else if (rsi4h >= 0 && rsi4h < 35 && rsi1h >= 0 && rsi1h > rsi4h) signal = 'REVERSAL — RSI bouncing from oversold';
          else if (rsi4h >= 0 && rsi4h > 65 && rsi1h >= 0 && rsi1h < rsi4h) signal = 'WEAKENING — RSI falling from overbought';

          return {
            symbol: (coin.symbol || '').toUpperCase(),
            name: coin.name,
            price: coin.current_price,
            change1h: coin.price_change_percentage_1h_in_currency || 0,
            change24h: coin.price_change_percentage_24h || 0,
            marketCap: coin.market_cap || 0,
            image: coin.image,
            rsi15m, rsi1h, rsi4h, rsi12h, rsi24h,
            zone15m: rsi15m >= 0 ? getRSIZone(rsi15m) : 'unknown',
            zone1h: rsi1h >= 0 ? getRSIZone(rsi1h) : 'unknown',
            zone4h: rsi4h >= 0 ? getRSIZone(rsi4h) : 'unknown',
            zone12h: rsi12h >= 0 ? getRSIZone(rsi12h) : 'unknown',
            zone24h: rsi24h >= 0 ? getRSIZone(rsi24h) : 'unknown',
            avgRSI,
            overallZone: getRSIZone(avgRSI),
            signal,
          } as CoinRSI;
        } catch { return null; }
      }));

      batchResults.forEach(r => { if (r) results.push(r); });

      // Rate limit between batches
      if (i + batchSize < coins.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    // Sort by avg RSI (most oversold first — best buy opportunities)
    results.sort((a, b) => a.avgRSI - b.avgRSI);

    // Summary stats
    const oversold = results.filter(r => r.overallZone === 'oversold').length;
    const overbought = results.filter(r => r.overallZone === 'overbought').length;
    const withSignals = results.filter(r => r.signal).length;

    return res.status(200).json({
      success: true,
      total: results.length,
      summary: { oversold, overbought, neutral: results.length - oversold - overbought, withSignals },
      data: results,
    });
  } catch (err: any) {
    console.error('RSI Heatmap error:', err.message);
    return res.status(500).json({ error: err.message || 'RSI Heatmap error' });
  }
}
