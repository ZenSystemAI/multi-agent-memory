import { Router } from 'express';
import { getMemoryStats, scrollPoints, computeEffectiveConfidence, DECAY_TYPES } from '../services/qdrant.js';

export const statsRouter = Router();

// GET /memory/stats — Memory health dashboard
statsRouter.get('/', async (req, res) => {
  try {
    const stats = await getMemoryStats();

    // Sample decayed memories (facts/statuses with low effective confidence)
    let decayedCount = 0;
    try {
      const recentFacts = await scrollPoints({ type: 'fact' }, 100);
      const points = recentFacts.points || [];
      for (const point of points) {
        const eff = computeEffectiveConfidence(point.payload);
        if (eff < 0.5) decayedCount++;
      }
    } catch (e) {
      // Non-critical
    }

    res.json({
      ...stats,
      decayed_below_50pct: decayedCount,
      decay_config: {
        factor: parseFloat(process.env.DECAY_FACTOR) || 0.98,
        affected_types: DECAY_TYPES,
      },
    });
  } catch (err) {
    console.error('[stats] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
