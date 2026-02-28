export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const filter = (req.query?.filter || '').toUpperCase();

    // Use CryptoCompare free news API
    const ccRes = await fetch(
      'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=popular'
    );

    if (!ccRes.ok) throw new Error('News API error');
    const data: any = await ccRes.json();
    const articles = (data.Data || []).slice(0, 50);

    let news = articles.map((a: any) => ({
      title: a.title,
      url: a.url,
      source: a.source_info?.name || a.source,
      body: (a.body || '').substring(0, 200),
      publishedAt: a.published_on ? new Date(a.published_on * 1000).toISOString() : null,
      imageUrl: a.imageurl,
      categories: a.categories || '',
      tags: (a.tags || '').split('|').filter(Boolean),
    }));

    // Filter by coin symbols if provided
    if (filter) {
      const filterSyms = filter.split(',').map((s: string) => s.trim());
      // Also map to full names for better matching
      const nameMap: Record<string, string[]> = {
        BTC: ['bitcoin', 'btc'], ETH: ['ethereum', 'eth', 'ether'],
        SOL: ['solana', 'sol'], BNB: ['bnb', 'binance'],
        XRP: ['xrp', 'ripple'], ADA: ['cardano', 'ada'],
        DOGE: ['dogecoin', 'doge'], AVAX: ['avalanche', 'avax'],
        DOT: ['polkadot', 'dot'], LINK: ['chainlink', 'link'],
        UNI: ['uniswap', 'uni'], NEAR: ['near protocol', 'near'],
        STX: ['stacks', 'stx'], SUI: ['sui'], APT: ['aptos'],
        ARB: ['arbitrum'], OP: ['optimism'],
      };

      const searchTerms = filterSyms.flatMap((s: string) => nameMap[s] || [s.toLowerCase()]);

      news = news.filter((n: any) => {
        const text = `${n.title} ${n.body} ${n.categories} ${n.tags.join(' ')}`.toLowerCase();
        return searchTerms.some((term: string) => text.includes(term));
      });
    }

    return res.status(200).json({ success: true, articles: news.slice(0, 30) });
  } catch (err: any) {
    console.error('News API error:', err.message);
    return res.status(500).json({ error: err.message || 'News error' });
  }
}
