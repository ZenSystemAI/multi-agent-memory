import express from 'express';
import { authMiddleware } from './middleware/auth.js';
import { memoryRouter } from './routes/memory.js';
import { briefingRouter } from './routes/briefing.js';
import { webhookRouter } from './routes/webhook.js';
import { initQdrant } from './services/qdrant.js';

const app = express();
const PORT = process.env.PORT || 8084;

app.use(express.json({ limit: '1mb' }));

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'shared-brain', timestamp: new Date().toISOString() });
});

// All other routes require API key
app.use(authMiddleware);

app.use('/memory', memoryRouter);
app.use('/briefing', briefingRouter);
app.use('/webhook', webhookRouter);

async function start() {
  try {
    await initQdrant();
    console.log('[shared-brain] Qdrant collection ready');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[shared-brain] Memory API running on port ${PORT}`);
    });
  } catch (err) {
    console.error('[shared-brain] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
