import crypto from 'crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const signal = req.body;
        console.log(`🔫 SIGNAL SENT: ${signal.side} ${signal.symbol} (Qty: ${signal.qty})`);

        const apiKey = signal.api_key;
        const apiSecret = signal.secret;
        
        if(!apiKey || !apiSecret) return res.status(400).json({ error: 'Missing Keys' });

        const timestamp = Date.now().toString();
        const recvWindow = '5000';
        
        // Construct Order
        const orderData = {
            category: 'linear',
            symbol: signal.symbol,
            side: signal.side,
            orderType: 'Market',
            qty: signal.qty,
            timeInForce: 'GTC',
            // positionIdx: 0, // 0 = One-Way Mode (Default). 
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
        
        // --- DEBUG LOGGING ---
        console.log("🔴 BYBIT RESPONSE:", JSON.stringify(result)); 

        if(result.retCode === 0) {
            return res.status(200).json({ message: "✅ SUCCESS", data: result });
        } else {
            // This will show the exact error in the Vercel response
            return res.status(400).json({ message: "❌ BYBIT REJECTED", error: result.retMsg, full: result });
        }

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
