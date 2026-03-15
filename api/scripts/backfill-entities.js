#!/usr/bin/env node
/**
 * Backfill entities for existing memories.
 * Runs fast-path entity extraction (regex + known-tech dictionary) on all active Qdrant points.
 * No LLM calls — this is purely regex-based extraction.
 *
 * Usage: node api/scripts/backfill-entities.js
 * Requires: .env configured with QDRANT_URL, BRAIN_API_KEY, and STRUCTURED_STORE
 */

try { await import('dotenv/config'); } catch (e) { /* dotenv not needed in Docker — env injected */ }
import { initQdrant, scrollPoints, updatePointPayload } from '../src/services/qdrant.js';
import { initStore, isEntityStoreAvailable, createEntity, findEntity, linkEntityToMemory, loadAllAliases } from '../src/services/stores/interface.js';
import { extractEntities, loadAliasCache, linkExtractedEntities } from '../src/services/entities.js';
import { initEmbeddings } from '../src/services/embedders/interface.js';

async function backfill() {
  console.log('[backfill] Starting entity backfill for existing memories...');

  // Initialize
  await initEmbeddings();
  await initQdrant();
  await initStore();

  if (!isEntityStoreAvailable()) {
    console.error('[backfill] Entity store not available. Need sqlite or postgres.');
    process.exit(1);
  }

  // Load alias cache
  try {
    const aliases = await loadAllAliases();
    loadAliasCache(aliases);
  } catch (e) {
    console.log('[backfill] No existing aliases — starting fresh');
  }

  let processed = 0;
  let entitiesCreated = 0;
  let linksCreated = 0;
  let offset = null;

  while (true) {
    const result = await scrollPoints({ active: true }, 100, offset);
    const points = result.points || [];

    if (points.length === 0) break;

    for (const point of points) {
      const pay = point.payload;
      const text = pay.text || '';
      const clientId = pay.client_id || 'global';
      const sourceAgent = pay.source_agent || 'unknown';

      const entities = extractEntities(text, clientId, sourceAgent);

      if (entities.length > 0) {
        // Update Qdrant payload with entities
        const entityPayload = entities.map(e => ({ name: e.name, type: e.type }));
        await updatePointPayload(point.id, { entities: entityPayload });

        // Create entities and links in structured store
        await linkExtractedEntities(entities, point.id, { createEntity, findEntity, linkEntityToMemory });
        entitiesCreated += entities.filter(e => !e.entityId).length;
        linksCreated += entities.length;
      }

      processed++;
      if (processed % 50 === 0) {
        console.log(`[backfill] Processed ${processed} memories, ${entitiesCreated} entities created, ${linksCreated} links`);
      }
    }

    offset = result.next_page_offset;
    if (!offset) break;
  }

  console.log(`[backfill] Complete: ${processed} memories processed, ${entitiesCreated} new entities, ${linksCreated} links created`);
  process.exit(0);
}

backfill().catch(err => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
