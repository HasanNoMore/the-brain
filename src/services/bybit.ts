import { RestClientV5 } from 'bybit-api';
import { config } from '../config';

export class BybitService {
  private client: RestClientV5;

  constructor() {
    this.client = new RestClientV5({
      key: config.bybit.apiKey,
      secret: config.bybit.apiSecret,
      testnet: config.bybit.testnet,
    });
  }

  async getBalance(coin = 'USDT') {
    const res = await this.client.getWalletBalance({
      accountType: 'UNIFIED',
      coin,
    });
    return res.result;
  }

  async getMarketPrice(symbol: string) {
    const res = await this.client.getTickers({
      category: 'linear',
      symbol,
    });
    return res.result.list[0];
  }

  async placeOrder(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    qty: string;
    orderType?: 'Market' | 'Limit';
    price?: string;
  }) {
    if (config.dryRun) {
      console.log('[DRY RUN] Would place order:', params);
      return null;
    }
    const res = await this.client.submitOrder({
      category: 'linear',
      symbol: params.symbol,
      side: params.side,
      orderType: params.orderType ?? 'Market',
      qty: params.qty,
      price: params.price,
    });
    return res.result;
  }
}
