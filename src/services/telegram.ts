import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';

export class TelegramService {
  private bot: TelegramBot | null = null;

  constructor() {
    if (config.telegram.botToken) {
      this.bot = new TelegramBot(config.telegram.botToken, { polling: false });
    }
  }

  async sendMessage(text: string, chatId?: string) {
    if (!this.bot) return;
    const target = chatId ?? config.telegram.chatId;
    await this.bot.sendMessage(target, text, { parse_mode: 'Markdown' });
  }

  async alert(message: string) {
    await this.sendMessage(`*BrainBot Alert*\n${message}`);
  }
}
