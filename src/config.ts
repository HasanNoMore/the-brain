import dotenv from 'dotenv';

dotenv.config({ override: true });

export const config = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  },
  bybit: {
    apiKey: process.env.BYBIT_API_KEY ?? '',
    apiSecret: process.env.BYBIT_API_SECRET ?? '',
    testnet: process.env.BRAINBOT_TESTNET === 'true',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
  },
  dryRun: process.env.BRAINBOT_DRY_RUN === 'true',
};
