import { config } from './config';
import { BybitService } from './services/bybit';
import { TelegramService } from './services/telegram';
import { DiscordService } from './services/discord';
import { ClaudeService } from './ai/claude';

async function main() {
  console.log('🤖 Brain Bot Versol starting...');
  console.log(`Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE'} | Testnet: ${config.bybit.testnet}`);

  const bybit = new BybitService();
  const telegram = new TelegramService();
  const discord = new DiscordService();
  const claude = new ClaudeService();

  // Startup notification
  await Promise.allSettled([
    telegram.alert('Brain Bot Versol started'),
    discord.alert('Brain Bot Versol started'),
  ]);

  // Example: fetch BTC price and get AI analysis
  try {
    const ticker = await bybit.getMarketPrice('BTCUSDT');
    const analysis = await claude.analyze(
      `BTC current price: ${ticker?.lastPrice}. Should I trade now?`
    );
    console.log('AI Analysis:', analysis);
  } catch (err) {
    console.error('Error during analysis:', err);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
