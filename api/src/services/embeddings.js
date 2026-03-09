import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 768;

export async function embed(text) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMS,
  });
  return response.data[0].embedding;
}

export { EMBEDDING_DIMS };
