import Anthropic from '@anthropic-ai/sdk';

// CoinGecko symbol → ID mapping
const COIN_ID_MAP: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
  XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin', AVAX: 'avalanche-2',
  DOT: 'polkadot', MATIC: 'matic-network', TRX: 'tron', LTC: 'litecoin',
  SHIB: 'shiba-inu', UNI: 'uniswap', LINK: 'chainlink', ATOM: 'cosmos',
  XLM: 'stellar', XMR: 'monero', ALGO: 'algorand', BCH: 'bitcoin-cash',
  RNDR: 'render-token', FLUX: 'zelcash', DUSK: 'dusk-network',
};

async function fetchMarketData(symbols: string[]): Promise<string> {
  if (!symbols.length) return '';

  const ids = symbols
    .map((s) => COIN_ID_MAP[s.toUpperCase()] || s.toLowerCase())
    .join(',');

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`
    );
    if (!res.ok) return '';
    const data = (await res.json()) as Record<string, any>;

    const lines = symbols.map((s) => {
      const id = COIN_ID_MAP[s.toUpperCase()] || s.toLowerCase();
      const info = data[id];
      if (!info) return `${s}: price unavailable`;
      return `${s}: $${info.usd?.toLocaleString() ?? '?'} | 24h change: ${info.usd_24h_change?.toFixed(2) ?? '?'}% | 24h vol: $${info.usd_24h_vol?.toLocaleString() ?? '?'}`;
    });

    return `\n\nLive market data:\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

export default async function handler(req: any, res: any) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, symbols, image } = req.body || {};
    if (!message && !image) return res.status(400).json({ error: 'Missing message' });

    const marketContext = await fetchMarketData(symbols || []);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const client = new Anthropic({ apiKey });

    // Build content blocks - support text + image (vision)
    const content: any[] = [];

    if (image) {
      // image is expected as { data: base64string, media_type: "image/png"|"image/jpeg"|etc }
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.media_type || 'image/png',
          data: image.data,
        },
      });
    }

    content.push({
      type: 'text',
      text: message || 'Analyze this chart screenshot. Identify patterns, support/resistance levels, trends, and give a trading recommendation.',
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: `You are The Brain — an expert crypto trading AI assistant integrated into a portfolio dashboard. You have access to live market data and can analyze chart screenshots. When analyzing charts, identify key patterns (support/resistance, trend lines, indicators), provide price targets, and give actionable trade recommendations with entry/exit points. Use plain text (no markdown). Keep responses under 200 words unless the user asks for detail.${marketContext}`,
      messages: [{ role: 'user', content }],
    });

    const block = response.content[0];
    const reply = block.type === 'text' ? block.text : 'No response generated.';

    return res.status(200).json({ reply });
  } catch (err: any) {
    console.error('Chat API error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
