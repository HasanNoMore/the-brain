import crypto from 'crypto';

export default async function handler(req, res) {
    // 1. Security: Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const signal = req.body;
        console.log(`🔫 SIGNAL: ${signal.side} ${signal.symbol}`);

        // 2. Grab Keys
        const apiKey = signal.api_key;
        const apiSecret = signal.secret;
        
        if(!apiKey || !apiSecret) {
            return res.status(400).json({ error: 'Missing Keys' });
        }

        // 3. Prepare Bybit Order
        const timestamp = Date.now().toString();
        const recvWindow = '5000';
        const orderData = {
            category: 'linear',
            symbol: signal.symbol,
            side: signal.side,
            orderType: 'Market',
            qty: signal.qty,
            timeInForce: 'GTC'
        };
        
        const jsonBody = JSON.stringify(orderData);
        
        // 4. Sign (HMAC SHA256)
        const signature_payload = timestamp + apiKey + recvWindow + jsonBody;
        const signature = crypto.createHmac('sha256', apiSecret).update(signature_payload).digest('hex');

        // 5. Send to Bybit
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
        
        if(result.retCode === 0) {
            return res.status(200).json({ message: "✅ SUCCESS", data: result });
        } else {
            return res.status(400).json({ message: "❌ FAILED", error: result });
        }

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
