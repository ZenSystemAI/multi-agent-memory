import { EMBEDDING_DIMS } from './embeddings.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = 'shared_memories';

async function qdrantRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (QDRANT_API_KEY) headers['api-key'] = QDRANT_API_KEY;

  const res = await fetch(`${QDRANT_URL}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Qdrant ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

export async function initQdrant() {
  // Check if collection exists
  try {
    await qdrantRequest(`/collections/${COLLECTION}`);
    console.log(`[qdrant] Collection '${COLLECTION}' exists`);
    return;
  } catch (e) {
    // Collection doesn't exist, create it
  }

  await qdrantRequest('/collections/' + COLLECTION, {
    method: 'PUT',
    body: JSON.stringify({
      vectors: {
        size: EMBEDDING_DIMS,
        distance: 'Cosine',
      },
      optimizers_config: {
        indexing_threshold: 100,
      },
    }),
  });

  // Create payload indices for common filters
  for (const field of ['type', 'source_agent', 'client_id', 'category', 'importance']) {
    await qdrantRequest(`/collections/${COLLECTION}/index`, {
      method: 'PUT',
      body: JSON.stringify({ field_name: field, field_schema: 'Keyword' }),
    });
  }

  await qdrantRequest(`/collections/${COLLECTION}/index`, {
    method: 'PUT',
    body: JSON.stringify({ field_name: 'created_at', field_schema: { type: 'datetime', is_tenant: false } }),
  });

  console.log(`[qdrant] Collection '${COLLECTION}' created with indices`);
}

export async function upsertPoint(id, vector, payload) {
  return qdrantRequest(`/collections/${COLLECTION}/points`, {
    method: 'PUT',
    body: JSON.stringify({
      points: [{ id, vector, payload }],
    }),
  });
}

export async function searchPoints(vector, filter = {}, limit = 10) {
  const body = {
    vector,
    limit,
    with_payload: true,
    score_threshold: 0.3,
  };

  if (Object.keys(filter).length > 0) {
    body.filter = { must: [] };
    for (const [key, value] of Object.entries(filter)) {
      if (value) {
        body.filter.must.push({ key, match: { value } });
      }
    }
    if (body.filter.must.length === 0) delete body.filter;
  }

  const result = await qdrantRequest(`/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return result.result || [];
}

export async function scrollPoints(filter = {}, limit = 50, offset = null) {
  const body = { limit, with_payload: true };

  if (offset) body.offset = offset;

  if (Object.keys(filter).length > 0) {
    body.filter = { must: [] };
    for (const [key, value] of Object.entries(filter)) {
      if (key === 'created_after') {
        body.filter.must.push({ key: 'created_at', range: { gte: value } });
      } else if (value) {
        body.filter.must.push({ key, match: { value } });
      }
    }
    if (body.filter.must.length === 0) delete body.filter;
  }

  const result = await qdrantRequest(`/collections/${COLLECTION}/points/scroll`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return result.result || {};
}

export async function getCollectionInfo() {
  const result = await qdrantRequest(`/collections/${COLLECTION}`);
  return result.result;
}
