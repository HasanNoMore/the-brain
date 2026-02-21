import crypto from 'crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        let signal;
        try {
            signal = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } catch (e) {
            console.log("Failed to parse signal:", req.body);
            return res.status(400).json({ error: 'Invalid JSON', received: req.body });
        }

        console.log(`🔫 SIGNAL SENT: ${signal.side} ${signal.symbol} (Qty: ${signal.qty})`);

        const apiKey = signal.api_key;
        const apiSecret = signal.secret;

        if (!apiKey || !apiSecret) return res.status(400).json({ error: 'Missing Keys' });

        const timestamp = Date.now().toString();
        const recvWindow = '5000';
        const minOrderValueDefault = Number(process.env.MIN_ORDER_VALUE || '15');

        const symbol = String(signal.symbol || '').toUpperCase();
        const minOrderValue = minOrderValueDefault;
        if (minOrderValue > 0) {
            try {
                const tickerResponse = await fetch(
                    `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`
                );
                const ticker = await tickerResponse.json();
                const lastPrice = Number(ticker?.result?.list?.[0]?.lastPrice || 0);
                if (lastPrice > 0) {
                    const qtyValue = Number(signal.qty);
                    const notional = qtyValue * lastPrice;
                    if (notional < minOrderValue) {
                        return res.status(400).json({
                            error: 'Order value below minimum',
                            minOrderValue,
                            lastPrice,
                            notional,
                            receivedQty: qtyValue,
                        });
                    }
                }
            } catch (e) {
                console.log('Failed to fetch ticker for min notional check:', e.message);
            }
        }

        const orderData = {
            category: 'spot',
            symbol,
            side: signal.side,
            orderType: 'Market',
            qty: signal.qty,
            timeInForce: 'GTC',
        };

        const jsonBody = JSON.stringify(orderData);
        const signature_payload = timestamp + apiKey + recvWindow + jsonBody;
        const signature = crypto.createHmac('sha256', apiSecret).update(signature_payload).digest('hex');

        const response = await fetch('https://api.bybit.com/v5/order/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-SIGN': signature,
                'X-BAPI-RECV-WINDOW': recvWindow
            },
            body: jsonBody
        });

        const result = await response.json();
        console.log("🔴 BYBIT RESPONSE:", JSON.stringify(result));

        if (result.retCode === 0) {
            return res.status(200).json({ message: "✅ SUCCESS", data: result });
        } else {
            return res.status(400).json({ message: "❌ BYBIT REJECTED", error: result.retMsg, full: result });
        }

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
