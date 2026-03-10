import crypto from 'crypto';
import { complete, getLLMInfo } from './llm/interface.js';
import { scrollPoints, updatePointPayload, upsertPoint, findByPayload } from './qdrant.js';
import { embed } from './embedders/interface.js';

// Consolidation run history (in-memory, persisted via Qdrant events)
let lastRunAt = null;
let isRunning = false;

const CONSOLIDATION_PROMPT = `You are analyzing a batch of agent memories from a shared brain system. These memories were stored by different AI agents working on different machines.

Analyze the following memories and produce a JSON response with these fields:

{
  "merged_facts": [
    {
      "content": "The consolidated fact combining multiple memories",
      "source_memories": ["id1", "id2"],
      "key": "a-unique-key-for-this-fact",
      "client_id": "global or client slug",
      "importance": "critical|high|medium|low"
    }
  ],
  "contradictions": [
    {
      "memory_a": "id of first memory",
      "memory_b": "id of second memory",
      "description": "What the contradiction is",
      "suggested_resolution": "Which one is likely correct and why"
    }
  ],
  "connections": [
    {
      "memories": ["id1", "id2"],
      "relationship": "Description of how these memories are related"
    }
  ],
  "insights": [
    {
      "content": "A pattern or insight noticed across multiple memories",
      "source_memories": ["id1", "id2", "id3"],
      "importance": "high|medium|low"
    }
  ]
}

Rules:
- Only create merged_facts when 2+ memories say essentially the same thing
- Only flag contradictions when memories genuinely conflict (not just different aspects)
- Connections should be meaningful, not trivial (e.g., same client mentioned)
- Insights should be actionable patterns, not just summaries
- If no merges/contradictions/connections/insights found, return empty arrays
- Preserve client_id from source memories

MEMORIES TO ANALYZE:
`;

export async function runConsolidation() {
  if (isRunning) {
    return { status: 'skipped', reason: 'Consolidation already running' };
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    // Pull unconsolidated memories
    const unconsolidated = await scrollPoints({ consolidated: false }, 200);
    const points = unconsolidated.points || [];

    if (points.length === 0) {
      isRunning = false;
      lastRunAt = new Date().toISOString();
      return { status: 'complete', memories_processed: 0, message: 'No unconsolidated memories found' };
    }

    // Group by client_id for focused analysis
    const groups = {};
    for (const point of points) {
      const clientId = point.payload.client_id || 'global';
      if (!groups[clientId]) groups[clientId] = [];
      groups[clientId].push(point);
    }

    let totalMerged = 0;
    let totalContradictions = 0;
    let totalConnections = 0;
    let totalInsights = 0;
    const errors = [];

    for (const [clientId, groupPoints] of Object.entries(groups)) {
      // Process in batches of 50 to stay within context limits
      for (let i = 0; i < groupPoints.length; i += 50) {
        const batch = groupPoints.slice(i, i + 50);

        try {
          const result = await consolidateBatch(batch, clientId);
          totalMerged += result.merged;
          totalContradictions += result.contradictions;
          totalConnections += result.connections;
          totalInsights += result.insights;

          // Mark batch as consolidated
          const ids = batch.map(p => p.id);
          await updatePointPayload(ids, { consolidated: true, consolidated_at: new Date().toISOString() });
        } catch (err) {
          errors.push({ client_id: clientId, batch_start: i, error: err.message });
          console.error(`[consolidation] Batch error for ${clientId}:`, err.message);
        }
      }
    }

    const duration = Date.now() - startTime;
    lastRunAt = new Date().toISOString();
    isRunning = false;

    const summary = {
      status: 'complete',
      memories_processed: points.length,
      groups_processed: Object.keys(groups).length,
      merged_facts: totalMerged,
      contradictions_found: totalContradictions,
      connections_found: totalConnections,
      insights_generated: totalInsights,
      errors: errors.length > 0 ? errors : undefined,
      duration_ms: duration,
      llm: getLLMInfo(),
    };

    // Log the consolidation run as an event
    try {
      const content = `Consolidation run: processed ${points.length} memories, merged ${totalMerged} facts, found ${totalContradictions} contradictions, ${totalConnections} connections, ${totalInsights} insights`;
      const vector = await embed(content);
      await upsertPoint(crypto.randomUUID(), vector, {
        text: content,
        type: 'event',
        source_agent: 'consolidation-engine',
        client_id: 'global',
        category: 'procedural',
        importance: 'medium',
        content_hash: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
        created_at: lastRunAt,
        last_accessed_at: lastRunAt,
        access_count: 0,
        confidence: 1.0,
        active: true,
        consolidated: true, // Meta — don't re-consolidate this
        metadata: { consolidation_summary: summary },
      });
    } catch (e) {
      console.error('[consolidation] Failed to log run event:', e.message);
    }

    return summary;
  } catch (err) {
    isRunning = false;
    throw err;
  }
}

async function consolidateBatch(points, clientId) {
  // Format memories for the LLM
  const memoriesText = points.map(p => {
    const pay = p.payload;
    return `[ID: ${p.id}] [Type: ${pay.type}] [Agent: ${pay.source_agent}] [Client: ${pay.client_id}] [Created: ${pay.created_at}]\n${pay.text}`;
  }).join('\n\n---\n\n');

  const prompt = CONSOLIDATION_PROMPT + memoriesText;
  const responseText = await complete(prompt);

  let result;
  try {
    result = JSON.parse(responseText);
  } catch (e) {
    console.error('[consolidation] LLM returned invalid JSON:', responseText.slice(0, 200));
    return { merged: 0, contradictions: 0, connections: 0, insights: 0 };
  }

  const now = new Date().toISOString();
  let merged = 0, contradictions = 0, connections = 0, insights = 0;

  // Store merged facts as new memories
  if (result.merged_facts?.length > 0) {
    for (const fact of result.merged_facts) {
      const content = fact.content;
      const vector = await embed(content);
      await upsertPoint(crypto.randomUUID(), vector, {
        text: content,
        type: 'fact',
        source_agent: 'consolidation-engine',
        client_id: fact.client_id || clientId,
        category: 'semantic',
        importance: fact.importance || 'medium',
        key: fact.key || crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
        content_hash: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
        created_at: now,
        last_accessed_at: now,
        access_count: 0,
        confidence: 1.0,
        active: true,
        consolidated: true,
        metadata: { source_memories: fact.source_memories, consolidation_type: 'merged' },
      });
      merged++;
    }
  }

  // Store contradictions as decision-type memories (need human/agent review)
  if (result.contradictions?.length > 0) {
    for (const contradiction of result.contradictions) {
      const content = `CONTRADICTION DETECTED: ${contradiction.description}. Suggested resolution: ${contradiction.suggested_resolution}`;
      const vector = await embed(content);
      await upsertPoint(crypto.randomUUID(), vector, {
        text: content,
        type: 'event',
        source_agent: 'consolidation-engine',
        client_id: clientId,
        category: 'episodic',
        importance: 'high',
        content_hash: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
        created_at: now,
        last_accessed_at: now,
        access_count: 0,
        confidence: 1.0,
        active: true,
        consolidated: true,
        metadata: {
          consolidation_type: 'contradiction',
          memory_a: contradiction.memory_a,
          memory_b: contradiction.memory_b,
        },
      });
      contradictions++;
    }
  }

  // Update connection metadata on existing points
  if (result.connections?.length > 0) {
    for (const connection of result.connections) {
      for (const memoryId of (connection.memories || [])) {
        try {
          await updatePointPayload(memoryId, {
            connections: connection.memories.filter(id => id !== memoryId),
            connection_description: connection.relationship,
          });
        } catch (e) {
          // Point might not exist — skip
        }
      }
      connections++;
    }
  }

  // Store insights as new memories
  if (result.insights?.length > 0) {
    for (const insight of result.insights) {
      const content = insight.content;
      const vector = await embed(content);
      await upsertPoint(crypto.randomUUID(), vector, {
        text: content,
        type: 'fact',
        source_agent: 'consolidation-engine',
        client_id: clientId,
        category: 'semantic',
        importance: insight.importance || 'medium',
        content_hash: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
        created_at: now,
        last_accessed_at: now,
        access_count: 0,
        confidence: 0.8, // Insights start at slightly lower confidence
        active: true,
        consolidated: true,
        metadata: { source_memories: insight.source_memories, consolidation_type: 'insight' },
      });
      insights++;
    }
  }

  return { merged, contradictions, connections, insights };
}

export function getConsolidationStatus() {
  return {
    is_running: isRunning,
    last_run_at: lastRunAt,
    llm: getLLMInfo(),
    enabled: process.env.CONSOLIDATION_ENABLED !== 'false',
    interval: process.env.CONSOLIDATION_INTERVAL || '0 */6 * * *',
  };
}
