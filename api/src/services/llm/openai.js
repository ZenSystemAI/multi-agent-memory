import OpenAI from 'openai';

export class OpenAIProvider {
  constructor() {
    this.model = process.env.CONSOLIDATION_MODEL || 'gpt-4o-mini';
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async complete(prompt, options = {}) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: 'You are a memory consolidation engine. Analyze memories and produce structured JSON output.' },
        { role: 'user', content: prompt },
      ],
      temperature: options.temperature || 0.3,
      max_tokens: options.max_tokens || 4096,
      response_format: { type: 'json_object' },
    });
    return response.choices[0].message.content;
  }
}
