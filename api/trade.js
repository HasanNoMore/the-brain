import crypto from 'crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        let signal;
        try {
            signal = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } catch (e) {
            console.log('Failed to parse signal:', req.body);
            return res.status(400).json({ error: 'Invalid JSON', received: req.body });
        }

    console.log(`🔫 SIGNAL SENT: ${signal.side} ${signal.symbol} (Qty: ${signal.qty})`);

        const apiKey = process.env.BYBIT_API_KEY;
        const apiSecret = process.env.BYBIT_API_SECRET;
        const useTestnet = (process.env.BYBIT_TESTNET || '').toLowerCase() === 'true';
        const minOrderQtyDefault = Number(process.env.MIN_ORDER_QTY || '0.001');
        let minOrderQtyBySymbol = {};
        try {
            minOrderQtyBySymbol = process.env.MIN_ORDER_QTY_BY_SYMBOL
                ? JSON.parse(process.env.MIN_ORDER_QTY_BY_SYMBOL)
                : {};
        } catch (e) {
            console.log('Invalid MIN_ORDER_QTY_BY_SYMBOL JSON. Using default min qty.');
        }

        if (!apiKey || !apiSecret) return res.status(400).json({ error: 'Missing Keys' });

        const timestamp = Date.now().toString();
        const recvWindow = '5000';

        const rawSide = String(signal.side || '').toLowerCase();
        const side = rawSide === 'buy' ? 'Buy' : rawSide === 'sell' ? 'Sell' : null;
        if (!side) {
            return res.status(400).json({ error: 'Invalid side', received: signal.side });
        }

        const symbol = String(signal.symbol || '').toUpperCase();
        if (!symbol) {
            return res.status(400).json({ error: 'Invalid symbol', received: signal.symbol });
        }

        const qty = Number(signal.qty);
        if (!Number.isFinite(qty) || qty <= 0) {
            return res.status(400).json({ error: 'Invalid qty', received: signal.qty });
        }
        const minOrderQty = Number(minOrderQtyBySymbol?.[signal.symbol]) || minOrderQtyDefault;
        if (minOrderQty > 0 && qty < minOrderQty) {
            return res.status(400).json({
                error: 'Qty below minimum',
                minOrderQty,
                received: qty,
            });
        }

        const orderData = {
            category: 'spot',
            symbol,
            side,
            orderType: 'Market',
            qty: qty.toString(),
            timeInForce: 'GTC',
        };

        const jsonBody = JSON.stringify(orderData);
        const signaturePayload = timestamp + apiKey + recvWindow + jsonBody;
        const signature = crypto.createHmac('sha256', apiSecret).update(signaturePayload).digest('hex');

        const baseUrl = useTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
        const response = await fetch(`${baseUrl}/v5/order/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-SIGN': signature,
                'X-BAPI-RECV-WINDOW': recvWindow,
            },
            body: jsonBody,
        });

        const result = await response.json();
        console.log('🔴 BYBIT RESPONSE:', JSON.stringify(result));

        if (result.retCode === 0) {
            return res.status(200).json({ message: '✅ SUCCESS', data: result });
        } else {
            return res.status(400).json({ message: '❌ BYBIT REJECTED', error: result.retMsg, full: result });
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
