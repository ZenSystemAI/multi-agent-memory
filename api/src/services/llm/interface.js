// LLM provider interface for consolidation engine
// Each provider must implement: complete(prompt, options) → string

const PROVIDER = process.env.CONSOLIDATION_LLM || 'openai';

let provider = null;

export async function initLLM() {
  switch (PROVIDER) {
    case 'openai': {
      const { OpenAIProvider } = await import('./openai.js');
      provider = new OpenAIProvider();
      break;
    }
    case 'anthropic': {
      const { AnthropicProvider } = await import('./anthropic.js');
      provider = new AnthropicProvider();
      break;
    }
    case 'ollama': {
      const { OllamaProvider } = await import('./ollama.js');
      provider = new OllamaProvider();
      break;
    }
    default:
      throw new Error(`Unknown LLM provider: ${PROVIDER}. Use: openai, anthropic, ollama`);
  }
  console.log(`[llm] Consolidation LLM: ${PROVIDER} (${provider.model})`);
}

export async function complete(prompt, options = {}) {
  if (!provider) throw new Error('LLM provider not initialized. Call initLLM() first.');
  return provider.complete(prompt, options);
}

export function getLLMInfo() {
  return {
    provider: PROVIDER,
    model: provider?.model || 'not initialized',
  };
}
