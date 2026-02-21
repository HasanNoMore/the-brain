const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

const ID_MAP = {
    BTC: "bitcoin",
    ETH: "ethereum",
    SOL: "solana",
    BNB: "binancecoin",
    XRP: "ripple",
    ADA: "cardano",
    DOGE: "dogecoin",
    AVAX: "avalanche-2",
    DOT: "polkadot",
    MATIC: "matic-network",
    TRX: "tron",
    LTC: "litecoin",
    SHIB: "shiba-inu",
    UNI: "uniswap",
    LINK: "chainlink",
    ATOM: "cosmos",
    XLM: "stellar",
    XMR: "monero",
    ALGO: "algorand",
    BCH: "bitcoin-cash",
    RNDR: "render-token",
    FLUX: "zelcash",
    DUSK: "dusk-network",
};

function normalizeSymbols(symbols = []) {
    return [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
}

function toCoinGeckoIds(symbols) {
    return symbols
        .map((symbol) => ID_MAP[symbol] || symbol.toLowerCase())
        .filter(Boolean);
}

function formatMarketData(marketData, symbols) {
    if (!marketData || symbols.length === 0) {
        return "No CoinGecko symbols provided.";
    }

    const rows = symbols.map((symbol) => {
        const id = ID_MAP[symbol] || symbol.toLowerCase();
        const entry = marketData[id];
        if (!entry) return `${symbol}: price unavailable`;
        const price = entry.usd?.toLocaleString(undefined, { maximumFractionDigits: 6 });
        const change = entry.usd_24h_change;
        const changeText = typeof change === "number" ? `${change.toFixed(2)}%` : "n/a";
        return `${symbol}: $${price} (24h ${changeText})`;
    });

    return rows.join("\n");
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const { message, symbols = [] } = req.body || {};
    if (!message || typeof message !== "string") {
        res.status(400).json({ error: "Missing message" });
        return;
    }

    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) {
        res.status(500).json({ error: "OPENROUTER_API_KEY is not set" });
        return;
    }

    const model = process.env.OPENROUTER_MODEL || "mistralai/mistral-7b-instruct:free";
    const normalizedSymbols = normalizeSymbols(symbols);
    const ids = toCoinGeckoIds(normalizedSymbols);

    let marketSummary = "No market data available.";
    if (ids.length) {
        const url = `${COINGECKO_BASE}/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`;
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            marketSummary = formatMarketData(data, normalizedSymbols);
        }
    }

    const systemPrompt =
        "You are The Brain, a concise crypto assistant. Answer in 3-5 sentences max. Use the market data when helpful.";
    const userPrompt = `User question: ${message}\n\nLive market data:\n${marketSummary}`;

    try {
        const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${openRouterKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": req.headers.host || "the-brain-omega.vercel.app",
                "X-Title": "The Brain Omega",
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
            }),
        });

        if (!aiResponse.ok) {
            const errorText = await aiResponse.text();
            res.status(500).json({ error: "OpenRouter error", detail: errorText });
            return;
        }

        const data = await aiResponse.json();
        const reply = data?.choices?.[0]?.message?.content || "No response from AI.";

        res.status(200).json({ reply, marketSummary });
    } catch (error) {
        res.status(500).json({ error: "Failed to reach OpenRouter", detail: String(error) });
    }
}
