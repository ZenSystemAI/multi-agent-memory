#!/usr/bin/env node
/**
 * One-time cleanup script for Shared Brain duplicate memories.
 * Run on Beelink where Qdrant is at localhost:6333.
 *
 * Usage: node cleanup-duplicates.js [--dry-run]
 *
 * What it removes:
 * 1. Duplicate content_hash entries (keeps newest, deletes older copies)
 * 2. Consolidation run log events ("Consolidation run: processed N memories...")
 * 3. Vague consolidation "insight" platitudes
 */

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION = 'shared_memories';
const DRY_RUN = process.argv.includes('--dry-run');

const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';

async function qdrantRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (QDRANT_API_KEY) headers['api-key'] = QDRANT_API_KEY;
  const res = await fetch(`${QDRANT_URL}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

async function scrollAll() {
  const points = [];
  let offset = null;
  while (true) {
    const body = { limit: 100, with_payload: true, with_vector: false };
    if (offset) body.offset = offset;
    const result = await qdrantRequest(`/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    points.push(...result.result.points);
    offset = result.result.next_page_offset;
    if (!offset) break;
  }
  return points;
}

async function deletePoints(ids) {
  if (ids.length === 0) return;
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would delete ${ids.length} points`);
    return;
  }
  await qdrantRequest(`/collections/${COLLECTION}/points/delete`, {
    method: 'POST',
    body: JSON.stringify({ points: ids }),
  });
  console.log(`  Deleted ${ids.length} points`);
}

// Platitude patterns — vague consolidation insights with no actionable content
const PLATITUDE_PATTERNS = [
  /indicates? (?:effective|strong|an ongoing|a robust) (?:project management|integration|collaboration|commitment)/i,
  /ongoing commitment to improving the efficiency/i,
  /operational (?:status|capabilities?) (?:of|and) the (?:Shared Brain|system)/i,
  /closely (?:intertwined|linked|related)/i,
  /successful completion of workflows indicates/i,
  /cross-referencing of (?:memory )?repositories indicate/i,
  /a critical factor in the successful launch/i,
];

function isPlatitude(text) {
  return PLATITUDE_PATTERNS.some(p => p.test(text));
}

async function main() {
  console.log(`Shared Brain Cleanup ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log('---');

  // Step 1: Scroll all points
  console.log('Scrolling all points...');
  const allPoints = await scrollAll();
  console.log(`Total points: ${allPoints.length}`);

  const toDelete = new Set();

  // Step 2: Find duplicate content_hash entries (keep newest)
  console.log('\n--- Duplicate content_hash entries ---');
  const byHash = {};
  for (const p of allPoints) {
    const hash = p.payload?.content_hash;
    if (!hash) continue;
    if (!byHash[hash]) byHash[hash] = [];
    byHash[hash].push(p);
  }

  let dupGroups = 0;
  let dupCount = 0;
  for (const [hash, points] of Object.entries(byHash)) {
    if (points.length <= 1) continue;
    // Sort by created_at descending — keep newest
    points.sort((a, b) => new Date(b.payload.created_at) - new Date(a.payload.created_at));
    const keep = points[0];
    const dupes = points.slice(1);
    dupGroups++;
    dupCount += dupes.length;
    console.log(`  hash=${hash} (${points.length} copies) — keeping ${keep.id} (${keep.payload.created_at}), deleting ${dupes.length}`);
    for (const d of dupes) {
      toDelete.add(d.id);
    }
  }
  console.log(`Found ${dupGroups} duplicate groups, ${dupCount} entries to remove`);

  // Step 3: Find consolidation run log events
  console.log('\n--- Consolidation run log events ---');
  let runLogCount = 0;
  for (const p of allPoints) {
    if (p.payload?.source_agent === 'consolidation-engine' &&
        p.payload?.type === 'event' &&
        p.payload?.text?.startsWith('Consolidation run: processed')) {
      if (!toDelete.has(p.id)) {
        toDelete.add(p.id);
        runLogCount++;
      }
    }
  }
  console.log(`Found ${runLogCount} consolidation run logs to remove`);

  // Step 4: Find platitude insights
  console.log('\n--- Platitude insights ---');
  let platitudeCount = 0;
  for (const p of allPoints) {
    if (p.payload?.source_agent === 'consolidation-engine' &&
        p.payload?.text &&
        isPlatitude(p.payload.text)) {
      if (!toDelete.has(p.id)) {
        toDelete.add(p.id);
        platitudeCount++;
        console.log(`  "${p.payload.text.slice(0, 80)}..."`);
      }
    }
  }
  console.log(`Found ${platitudeCount} platitude insights to remove`);

  // Step 5: Execute deletions
  const deleteIds = Array.from(toDelete);
  console.log(`\n--- Total: ${deleteIds.length} points to delete ---`);

  if (deleteIds.length > 0) {
    // Delete in batches of 100
    for (let i = 0; i < deleteIds.length; i += 100) {
      const batch = deleteIds.slice(i, i + 100);
      await deletePoints(batch);
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
