import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

export class ClaudeService {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  async analyze(prompt: string, context?: string): Promise<string> {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: context ? `${context}\n\n${prompt}` : prompt,
      },
    ];

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system:
        'You are an expert trading analyst. Analyze market data and provide concise, actionable insights.',
      messages,
    });

    const block = response.content[0];
    return block.type === 'text' ? block.text : '';
  }
}
