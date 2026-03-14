import { getEmbeddingDimensions } from './embedders/interface.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = 'shared_memories';

// Memory decay config
const DECAY_FACTOR = parseFloat(process.env.DECAY_FACTOR) || 0.98;
const DECAY_TYPES = ['fact', 'status']; // events and decisions are historical — don't decay

const QDRANT_TIMEOUT_MS = parseInt(process.env.QDRANT_TIMEOUT_MS) || 10000;

async function qdrantRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (QDRANT_API_KEY) headers['api-key'] = QDRANT_API_KEY;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QDRANT_TIMEOUT_MS);
  try {
    const res = await fetch(`${QDRANT_URL}${path}`, { ...options, headers: { ...headers, ...options.headers }, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Qdrant ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
    }
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Qdrant request timed out after ${QDRANT_TIMEOUT_MS}ms: ${options.method || 'GET'} ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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

  const embeddingDims = getEmbeddingDimensions();
  await qdrantRequest('/collections/' + COLLECTION, {
    method: 'PUT',
    body: JSON.stringify({
      vectors: {
        size: embeddingDims,
        distance: 'Cosine',
      },
      optimizers_config: {
        indexing_threshold: 100,
      },
    }),
  });

  // Create payload indices for common filters
  const keywordFields = ['type', 'source_agent', 'client_id', 'category', 'importance', 'content_hash'];
  for (const field of keywordFields) {
    await qdrantRequest(`/collections/${COLLECTION}/index`, {
      method: 'PUT',
      body: JSON.stringify({ field_name: field, field_schema: 'Keyword' }),
    });
  }

  // Boolean index for active/inactive filtering
  await qdrantRequest(`/collections/${COLLECTION}/index`, {
    method: 'PUT',
    body: JSON.stringify({ field_name: 'active', field_schema: 'Bool' }),
  });

  // Float index for confidence scoring
  await qdrantRequest(`/collections/${COLLECTION}/index`, {
    method: 'PUT',
    body: JSON.stringify({ field_name: 'confidence', field_schema: 'Float' }),
  });

  // Integer index for access count
  await qdrantRequest(`/collections/${COLLECTION}/index`, {
    method: 'PUT',
    body: JSON.stringify({ field_name: 'access_count', field_schema: 'Integer' }),
  });

  // Datetime indices
  for (const field of ['created_at', 'last_accessed_at']) {
    await qdrantRequest(`/collections/${COLLECTION}/index`, {
      method: 'PUT',
      body: JSON.stringify({ field_name: field, field_schema: { type: 'datetime', is_tenant: false } }),
    });
  }

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
      if (value !== undefined && value !== null) {
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

// Update payload fields on existing points (partial update)
export async function updatePointPayload(pointIds, payload) {
  const ids = Array.isArray(pointIds) ? pointIds : [pointIds];
  return qdrantRequest(`/collections/${COLLECTION}/points/payload`, {
    method: 'POST',
    body: JSON.stringify({ payload, points: ids }),
  });
}

// Find points by exact payload field match
export async function findByPayload(field, value, extraFilter = {}, limit = 10) {
  const must = [{ key: field, match: { value } }];
  for (const [key, val] of Object.entries(extraFilter)) {
    if (val !== undefined && val !== null) {
      if (typeof val === 'boolean') {
        must.push({ key, match: { value: val } });
      } else {
        must.push({ key, match: { value: val } });
      }
    }
  }

  const result = await qdrantRequest(`/collections/${COLLECTION}/points/scroll`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { must },
      limit,
      with_payload: true,
    }),
  });
  return (result.result || {}).points || [];
}

// Compute effective confidence with time decay
export function computeEffectiveConfidence(payload) {
  if (!DECAY_TYPES.includes(payload.type)) return payload.confidence || 1.0;

  const baseConfidence = payload.confidence || 1.0;
  const lastAccess = payload.last_accessed_at || payload.created_at;
  if (!lastAccess) return baseConfidence;

  const daysSinceAccess = (Date.now() - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
  return baseConfidence * Math.pow(DECAY_FACTOR, daysSinceAccess);
}

// Get memory stats across the collection
export async function getMemoryStats() {
  const info = await getCollectionInfo();

  // Count by active/inactive
  const activeResult = await qdrantRequest(`/collections/${COLLECTION}/points/count`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { must: [{ key: 'active', match: { value: true } }] },
      exact: true,
    }),
  });

  const consolidatedResult = await qdrantRequest(`/collections/${COLLECTION}/points/count`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { must: [{ key: 'consolidated', match: { value: true } }] },
      exact: true,
    }),
  });

  // Count by type
  const typeCounts = {};
  for (const type of ['event', 'fact', 'decision', 'status']) {
    const r = await qdrantRequest(`/collections/${COLLECTION}/points/count`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { must: [{ key: 'type', match: { value: type } }] },
        exact: true,
      }),
    });
    typeCounts[type] = r.result?.count || 0;
  }

  return {
    total_memories: info.points_count,
    vectors_count: info.vectors_count,
    active: activeResult.result?.count || 0,
    superseded: (info.points_count || 0) - (activeResult.result?.count || 0),
    consolidated: consolidatedResult.result?.count || 0,
    by_type: typeCounts,
  };
}

export { DECAY_TYPES };
