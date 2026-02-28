import axios from 'axios';
import { config } from '../config';

export class DiscordService {
  async sendMessage(content: string) {
    if (!config.discord.webhookUrl) return;
    await axios.post(config.discord.webhookUrl, { content });
  }

  async alert(message: string) {
    await this.sendMessage(`**BrainBot Alert**\n${message}`);
  }
}
