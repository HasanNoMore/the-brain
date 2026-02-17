const crypto = require('crypto');

exports.handler = async function(event, context) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const data = JSON.parse(event.body);
        const { symbol, side, qty, api_key, secret } = data;

        if (!api_key || !secret) {
            return { statusCode: 400, body: "Missing API Keys" };
        }

        console.log(`🚀 Signal: ${side} ${symbol} $${qty}`);

        const timestamp = Date.now().toString();
        const recvWindow = "5000";
        // 'Buy' හෝ 'Sell' අකුරු නිවැරදි කිරීම
        const sideCap = side.charAt(0).toUpperCase() + side.slice(1).toLowerCase(); 
        
        let payload = {
            category: "spot",
            symbol: symbol,
            side: sideCap,
            orderType: "Market",
            qty: qty.toString(),
        };

        // 🔥 CRITICAL FIX: Tell Bybit this quantity is in USDT (Quote Currency)
        // Buy කරන විට පමණක් මෙය අවශ්‍ය වේ.
        if (sideCap === 'Buy') {
            payload.marketUnit = 'quoteCoin';
        }

        const bodyStr = JSON.stringify(payload);
        
        const signature = crypto
            .createHmac("sha256", secret)
            .update(timestamp + api_key + recvWindow + bodyStr)
            .digest("hex");

        const response = await fetch("https://api.bybit.com/v5/order/create", {
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
            return { statusCode: 200, body: `✅ Success! Order ID: ${result.result.orderId}` };
        } else {
            return { statusCode: 400, body: `❌ Bybit Error: ${result.retMsg}` };
        }

    } catch (e) {
        return { statusCode: 500, body: `Server Error: ${e.message}` };
    }
};
