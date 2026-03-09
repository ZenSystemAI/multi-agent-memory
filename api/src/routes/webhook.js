import { Router } from 'express';
import crypto from 'crypto';
import { embed } from '../services/embeddings.js';
import { upsertPoint } from '../services/qdrant.js';
import { createEvent, upsertStatus } from '../services/baserow.js';
import { scrubCredentials } from '../services/scrub.js';

export const webhookRouter = Router();

// POST /webhook/n8n — Auto-log workflow execution results
webhookRouter.post('/n8n', async (req, res) => {
  try {
    const {
      workflow_name,
      workflow_id,
      execution_id,
      status,      // 'success' | 'error'
      message,     // optional description
      client_id,   // optional
      items_processed, // optional count
      error_message,   // optional if status=error
    } = req.body;

    if (!workflow_name || !status) {
      return res.status(400).json({
        error: 'Missing required fields: workflow_name, status',
        example: {
          workflow_name: 'seo-rank-update',
          workflow_id: 'abc123',
          execution_id: 'exec_456',
          status: 'success',
          message: 'Updated 42 keywords for jetloans.ca',
          client_id: 'jetloans',
          items_processed: 42,
        },
      });
    }

    const now = new Date().toISOString();

    // Build content string
    let content = `n8n workflow "${workflow_name}" ${status === 'success' ? 'completed successfully' : 'FAILED'}`;
    if (message) content += `: ${message}`;
    if (items_processed) content += ` (${items_processed} items processed)`;
    if (error_message) content += ` — Error: ${error_message}`;
    if (execution_id) content += ` [execution: ${execution_id}]`;

    content = scrubCredentials(content);

    const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const pointId = crypto.randomUUID();

    // Store as event in Qdrant
    const vector = await embed(content);
    await upsertPoint(pointId, vector, {
      text: content,
      type: 'event',
      source_agent: 'n8n',
      client_id: client_id || 'global',
      category: 'episodic',
      importance: status === 'error' ? 'high' : 'medium',
      content_hash: contentHash,
      created_at: now,
      access_count: 0,
      consolidated: false,
      metadata: {
        workflow_name,
        workflow_id: workflow_id || null,
        execution_id: execution_id || null,
        status,
        items_processed: items_processed || null,
      },
    });

    // Store as event in Baserow
    try {
      await createEvent({
        content,
        type: 'event',
        source_agent: 'n8n',
        client_id: client_id || 'global',
        category: 'episodic',
        importance: status === 'error' ? 'high' : 'medium',
        content_hash: contentHash,
        created_at: now,
      });
    } catch (e) {
      console.error('[webhook:n8n] Baserow write failed:', e.message);
    }

    // If workflow errored, also update status
    if (status === 'error') {
      try {
        await upsertStatus({
          subject: workflow_name,
          status: `ERROR: ${error_message || message || 'Unknown error'}`,
          source_agent: 'n8n',
          category: 'episodic',
        });
      } catch (e) {
        console.error('[webhook:n8n] Status update failed:', e.message);
      }
    }

    res.status(201).json({ id: pointId, content });
  } catch (err) {
    console.error('[webhook:n8n] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
