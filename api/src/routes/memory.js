import { Router } from 'express';
import crypto from 'crypto';
import { embed } from '../services/embeddings.js';
import { upsertPoint, searchPoints } from '../services/qdrant.js';
import { createEvent, upsertFact, upsertStatus, listEvents, listFacts, listStatuses } from '../services/baserow.js';
import { scrubCredentials } from '../services/scrub.js';

export const memoryRouter = Router();

// POST /memory — Store a memory
memoryRouter.post('/', async (req, res) => {
  try {
    const { type, content, source_agent, client_id, category, importance, metadata } = req.body;

    // Validate required fields
    if (!type || !content || !source_agent) {
      return res.status(400).json({
        error: 'Missing required fields: type, content, source_agent',
        valid_types: ['event', 'fact', 'decision', 'status'],
        valid_agents: ['claude-code', 'antigravity', 'morpheus', 'n8n'],
      });
    }

    if (!['event', 'fact', 'decision', 'status'].includes(type)) {
      return res.status(400).json({ error: `Invalid type: ${type}. Must be event, fact, decision, or status` });
    }

    // Scrub credentials
    const cleanContent = scrubCredentials(content);

    // Generate content hash for dedup
    const contentHash = crypto.createHash('sha256').update(cleanContent).digest('hex').slice(0, 16);

    // Generate point ID
    const pointId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Build payload
    const payload = {
      text: cleanContent,
      type,
      source_agent,
      client_id: client_id || 'global',
      category: category || 'episodic',
      importance: importance || 'medium',
      content_hash: contentHash,
      created_at: now,
      access_count: 0,
      consolidated: false,
      ...(metadata ? { metadata } : {}),
    };

    // Embed and store in Qdrant
    const vector = await embed(cleanContent);
    await upsertPoint(pointId, vector, payload);

    // Store in Baserow (structured)
    const baserowData = {
      content: cleanContent,
      source_agent,
      client_id: client_id || 'global',
      category: category || 'episodic',
      importance: importance || 'medium',
      content_hash: contentHash,
      created_at: now,
    };

    let baserowResult = null;
    try {
      if (type === 'event' || type === 'decision') {
        baserowData.type = type;
        baserowResult = await createEvent(baserowData);
      } else if (type === 'fact') {
        baserowData.key = req.body.key || contentHash;
        baserowData.value = cleanContent;
        baserowResult = await upsertFact(baserowData);
      } else if (type === 'status') {
        baserowData.subject = req.body.subject || 'unknown';
        baserowData.status = req.body.status_value || cleanContent;
        baserowResult = await upsertStatus(baserowData);
      }
    } catch (baserowErr) {
      // Qdrant succeeded, Baserow failed — log but don't fail the request
      console.error('[baserow] Write failed (Qdrant succeeded):', baserowErr.message);
    }

    res.status(201).json({
      id: pointId,
      type,
      content_hash: contentHash,
      stored_in: {
        qdrant: true,
        baserow: !!baserowResult,
      },
    });
  } catch (err) {
    console.error('[memory:store] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /memory/search — Semantic search via Qdrant
memoryRouter.get('/search', async (req, res) => {
  try {
    const { q, type, source_agent, client_id, category, limit } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Missing required query parameter: q' });
    }

    const vector = await embed(q);

    const filter = {};
    if (type) filter.type = type;
    if (source_agent) filter.source_agent = source_agent;
    if (client_id) filter.client_id = client_id;
    if (category) filter.category = category;

    const results = await searchPoints(vector, filter, parseInt(limit) || 10);

    res.json({
      query: q,
      count: results.length,
      results: results.map(r => ({
        id: r.id,
        score: r.score,
        ...r.payload,
      })),
    });
  } catch (err) {
    console.error('[memory:search] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /memory/query — Structured query via Baserow
memoryRouter.get('/query', async (req, res) => {
  try {
    const { type, source_agent, category, client_id, since, key, subject } = req.query;

    let results;
    const filters = { source_agent, category, client_id };

    if (type === 'fact' || type === 'facts') {
      if (key) filters.key = key;
      results = await listFacts(filters);
    } else if (type === 'status' || type === 'statuses') {
      if (subject) filters.subject = subject;
      results = await listStatuses(filters);
    } else {
      // Default to events (includes decisions)
      if (since) filters.since = since;
      results = await listEvents(filters);
    }

    res.json({
      type: type || 'events',
      count: results.results?.length || 0,
      results: results.results || [],
    });
  } catch (err) {
    console.error('[memory:query] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
