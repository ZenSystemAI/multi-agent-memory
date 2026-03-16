import crypto from 'crypto';
import { complete, getLLMInfo } from './llm/interface.js';
import { scrollPoints, updatePointPayload, upsertPoint, findByPayload, searchPoints } from './qdrant.js';
import { embed } from './embedders/interface.js';
import { isEntityStoreAvailable, createEntity, findEntity, linkEntityToMemory, upsertAlias, loadAllAliases } from './stores/interface.js';
import { loadAliasCache, addToAliasCache } from './entities.js';

const SEMANTIC_DEDUP_THRESHOLD = 0.92; // Skip if existing memory is >92% similar

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
  ],
  "entities": [
    {
      "canonical_name": "The standard/official name for this entity",
      "type": "client|person|system|service|domain|technology|workflow|agent",
      "aliases": ["other-name", "abbreviation", "slug"],
      "mentioned_in": ["memory-id-1", "memory-id-2"]
    }
  ]
}

Rules:
- Only create merged_facts when 2+ memories say essentially the same thing
- Only flag contradictions when memories genuinely conflict (not just different aspects)
- Connections should be meaningful, not trivial (e.g., same client mentioned)
- Insights must contain SPECIFIC, ACTIONABLE information not already captured in the source memories. Do NOT generate generic observations like "the system is working well", "there is ongoing commitment to efficiency", "the projects are closely intertwined", or "successful completion indicates effective management". If you have no genuinely novel insight, return an empty insights array.
- If no merges/contradictions/connections/insights found, return empty arrays
- Preserve client_id from source memories
- Extract ALL named entities: client names, people, systems, services, domains, technologies, workflows, agent names
- For each entity, choose the most official/complete form as canonical_name (e.g. "Acme Corporation" not "acme")
- List ALL variant spellings/references as aliases (include slugs, abbreviations, informal names)
- type must be one of: client, person, system, service, domain, technology, workflow, agent
- mentioned_in must only contain memory IDs from the batch being analyzed
- If an entity appears in source_agent fields, its type is "agent"
- If an entity appears in client_id fields, its type is "client"
- Domain names (*.com, *.ca, etc.) have type "domain"
- Tools and software have type "technology"

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
    let totalSkipped = 0;
    let totalEntities = 0;
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
          totalSkipped += result.skipped || 0;
          totalEntities += result.entities || 0;

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
      skipped_dedup: totalSkipped,
      entities_processed: totalEntities,
      errors: errors.length > 0 ? errors : undefined,
      duration_ms: duration,
      llm: getLLMInfo(),
    };

    // Refresh alias cache after consolidation (new aliases may have been discovered)
    if (isEntityStoreAvailable()) {
      try {
        const aliases = await loadAllAliases();
        loadAliasCache(aliases);
      } catch (e) {
        console.error('[consolidation] Alias cache refresh failed:', e.message);
      }
    }

    // Clean up old, low-value events (>30 days, never accessed, medium/low importance)
    let eventsExpired = 0;
    try {
      eventsExpired = await cleanupOldEvents();
    } catch (e) {
      console.error('[consolidation] Event cleanup failed:', e.message);
    }
    summary.events_expired = eventsExpired;

    console.log(`[consolidation] Complete: ${points.length} memories, ${totalMerged} merged, ${totalContradictions} contradictions, ${totalConnections} connections, ${totalInsights} insights, ${totalSkipped} skipped (dedup), ${totalEntities} entities, ${eventsExpired} events expired`);

    return summary;
  } catch (err) {
    isRunning = false;
    throw err;
  }
}

async function consolidateBatch(points, clientId) {
  // Collect valid IDs for output validation
  const batchIds = new Set(points.map(p => p.id));

  // Format memories for the LLM — wrapped in XML tags to resist prompt injection
  const memoriesText = points.map(p => {
    const pay = p.payload;
    // Escape any XML-like tags in the memory content to prevent tag injection
    const safeText = pay.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<memory id="${p.id}" type="${pay.type}" agent="${pay.source_agent}" client="${pay.client_id}" created="${pay.created_at}">\n${safeText}\n</memory>`;
  }).join('\n\n');

  const prompt = CONSOLIDATION_PROMPT + memoriesText;
  const responseText = await complete(prompt);

  let result;
  try {
    result = JSON.parse(responseText);
  } catch (e) {
    console.error('[consolidation] LLM returned invalid JSON:', responseText.slice(0, 200));
    return { merged: 0, contradictions: 0, connections: 0, insights: 0 };
  }

  // Validate: strip any memory IDs not in the current batch
  if (result.merged_facts) {
    for (const fact of result.merged_facts) {
      if (fact.source_memories) {
        fact.source_memories = fact.source_memories.filter(id => batchIds.has(id));
      }
    }
  }
  if (result.contradictions) {
    result.contradictions = result.contradictions.filter(c =>
      batchIds.has(c.memory_a) && batchIds.has(c.memory_b)
    );
  }
  if (result.connections) {
    for (const conn of result.connections) {
      if (conn.memories) {
        conn.memories = conn.memories.filter(id => batchIds.has(id));
      }
    }
    result.connections = result.connections.filter(c => c.memories && c.memories.length >= 2);
  }
  if (result.insights) {
    for (const insight of result.insights) {
      if (insight.source_memories) {
        insight.source_memories = insight.source_memories.filter(id => batchIds.has(id));
      }
    }
  }
  if (result.entities) {
    for (const ent of result.entities) {
      if (ent.mentioned_in) {
        ent.mentioned_in = ent.mentioned_in.filter(id => batchIds.has(id));
      }
    }
  }

  const VALID_IMPORTANCE = ['critical', 'high', 'medium', 'low'];
  const sanitizeImportance = (val) => VALID_IMPORTANCE.includes(val) ? val : 'medium';

  const now = new Date().toISOString();
  let merged = 0, contradictions = 0, connections = 0, insights = 0;

  // Store merged facts as new memories (with dedup)
  let skipped = 0;
  if (result.merged_facts?.length > 0) {
    for (const fact of result.merged_facts) {
      const content = fact.content;
      const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

      // Exact dedup: skip if identical content already exists
      const existing = await findByPayload('content_hash', contentHash, { active: true });
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const vector = await embed(content);

      // Semantic dedup: skip if a very similar memory already exists
      const similar = await searchPoints(vector, { active: true }, 1);
      if (similar.length > 0 && similar[0].score >= SEMANTIC_DEDUP_THRESHOLD) {
        skipped++;
        continue;
      }

      await upsertPoint(crypto.randomUUID(), vector, {
        text: content,
        type: 'fact',
        source_agent: 'consolidation-engine',
        client_id: fact.client_id || clientId,
        category: 'semantic',
        importance: sanitizeImportance(fact.importance),
        key: fact.key || contentHash,
        content_hash: contentHash,
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

  // Store insights as new memories (with dedup)
  if (result.insights?.length > 0) {
    for (const insight of result.insights) {
      const content = insight.content;
      const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

      // Exact dedup: skip if identical content already exists
      const existing = await findByPayload('content_hash', contentHash, { active: true });
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const vector = await embed(content);

      // Semantic dedup: skip if a very similar memory already exists
      const similar = await searchPoints(vector, { active: true }, 1);
      if (similar.length > 0 && similar[0].score >= SEMANTIC_DEDUP_THRESHOLD) {
        skipped++;
        continue;
      }

      await upsertPoint(crypto.randomUUID(), vector, {
        text: content,
        type: 'fact',
        source_agent: 'consolidation-engine',
        client_id: clientId,
        category: 'semantic',
        importance: sanitizeImportance(insight.importance),
        content_hash: contentHash,
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

  // Process entities discovered by the LLM
  let entitiesProcessed = 0;
  if (result.entities?.length > 0 && isEntityStoreAvailable()) {
    for (const ent of result.entities) {
      try {
        // Find or create the entity
        let entity = await findEntity(ent.canonical_name);
        let entityId;
        if (entity) {
          entityId = entity.id;
          // Bump mention count
          await createEntity({ canonical_name: ent.canonical_name, entity_type: ent.type || entity.entity_type });
        } else {
          const created = await createEntity({ canonical_name: ent.canonical_name, entity_type: ent.type || 'system' });
          entityId = created.id;
          addToAliasCache(ent.canonical_name, entityId, ent.canonical_name, ent.type || 'system');
        }

        // Register aliases
        if (ent.aliases && entityId) {
          for (const alias of ent.aliases) {
            const aliasResult = await upsertAlias(entityId, alias);
            if (aliasResult.created) {
              addToAliasCache(alias, entityId, ent.canonical_name, ent.type || 'system');
            }
          }
        }

        // Link to mentioned memories
        if (ent.mentioned_in && entityId) {
          for (const memId of ent.mentioned_in) {
            await linkEntityToMemory(entityId, memId, 'mentioned');
          }
        }

        entitiesProcessed++;
      } catch (e) {
        console.error(`[consolidation] Entity processing failed for "${ent.canonical_name}":`, e.message);
      }
    }
  }

  return { merged, contradictions, connections, insights, skipped, entities: entitiesProcessed };
}

const EVENT_TTL_DAYS = parseInt(process.env.EVENT_TTL_DAYS) || 30;

async function cleanupOldEvents() {
  const cutoff = new Date(Date.now() - EVENT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Scroll events older than TTL that were never accessed and are medium/low importance
  const result = await scrollPoints({}, 200);
  const points = (result.points || []).filter(p => {
    const pay = p.payload;
    return pay.type === 'event' &&
      pay.active === true &&
      pay.access_count === 0 &&
      pay.created_at < cutoff &&
      (pay.importance === 'medium' || pay.importance === 'low');
  });

  if (points.length === 0) return 0;

  // Mark as inactive (soft delete) rather than hard delete
  const ids = points.map(p => p.id);
  await updatePointPayload(ids, { active: false, expired_at: new Date().toISOString() });
  console.log(`[consolidation] Expired ${ids.length} old events (>${EVENT_TTL_DAYS} days, never accessed, medium/low importance)`);
  return ids.length;
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
