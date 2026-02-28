export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Fetch top 50 coins from CoinGecko
    const cgRes = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=24h'
    );
    if (!cgRes.ok) throw new Error('CoinGecko API error');
    const coins = (await cgRes.json()) as any[];

    const heatmap = coins.map((c: any) => ({
      id: c.id,
      symbol: (c.symbol || '').toUpperCase(),
      name: c.name,
      price: c.current_price,
      change24h: c.price_change_percentage_24h || 0,
      marketCap: c.market_cap || 0,
      volume24h: c.total_volume || 0,
      image: c.image,
    }));

    return res.status(200).json({ success: true, data: heatmap });
  } catch (err: any) {
    console.error('Heatmap API error:', err.message);
    return res.status(500).json({ error: err.message || 'Heatmap error' });
  }
}
