const crypto = require('crypto');

exports.handler = async function(event, context) {
    // 1. Only allow POST requests
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        // 2. Parse Data from TradingView
        const data = JSON.parse(event.body);
        const { symbol, side, qty, api_key, secret } = data;

        if (!api_key || !secret) {
            return { statusCode: 400, body: "Missing API Keys in Payload" };
        }

        console.log(`🚀 Signal Received: ${side} ${symbol} ${qty}`);

        // 3. Prepare Bybit Order
        const endpoint = "/v5/order/create";
        const timestamp = Date.now().toString();
        const recvWindow = "5000";
        
        const payload = {
            category: "spot",
            symbol: symbol,
            side: side.charAt(0).toUpperCase() + side.slice(1).toLowerCase(), // Ensure 'Buy' or 'Sell'
            orderType: "Market",
            qty: qty.toString(),
        };

        const bodyStr = JSON.stringify(payload);
        
        // 4. Create Signature (The Magic Part ✨)
        const signature = crypto
            .createHmac("sha256", secret)
            .update(timestamp + api_key + recvWindow + bodyStr)
            .digest("hex");

        // 5. Send to Bybit
        const response = await fetch("https://api.bybit.com" + endpoint, {
            method: "POST",
            headers: {
                "X-BAPI-API-KEY": api_key,
                "X-BAPI-SIGN": signature,
                "X-BAPI-TIMESTAMP": timestamp,
                "X-BAPI-RECV-WINDOW": recvWindow,
                "Content-Type": "application/json"
            },
            body: bodyStr
        });

        const result = await response.json();
        console.log("Bybit Response:", result);

        if (result.retCode === 0) {
            return { statusCode: 200, body: `✅ Success: Trade Executed! ID: ${result.result.orderId}` };
        } else {
            return { statusCode: 400, body: `❌ Bybit Error: ${result.retMsg}` };
        }

    } catch (e) {
        return { statusCode: 500, body: `Server Error: ${e.message}` };
    }
};
