import { Router } from 'express';
import { runConsolidation, getConsolidationStatus } from '../services/consolidation.js';

export const consolidationRouter = Router();

// POST /consolidate — Trigger manual consolidation
consolidationRouter.post('/', async (req, res) => {
  try {
    const result = await runConsolidation();
    res.json(result);
  } catch (err) {
    console.error('[consolidation] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /consolidate/status — Current consolidation status
consolidationRouter.get('/status', async (req, res) => {
  try {
    res.json(getConsolidationStatus());
  } catch (err) {
    console.error('[consolidation:status] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
