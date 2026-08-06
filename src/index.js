// Must come first: simkl.js reads process.env at module scope, and ES module
// imports are evaluated in order before any statement in this file runs.
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import { getLastWatched, initialize } from './simkl.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Verify credentials on startup
await initialize();

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'simkl-api',
    endpoints: ['/api/watch/last', '/health'],
    docs: 'https://github.com/Ashwin-S-Nambiar/simkl-api'
  });
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Main API endpoint
app.get('/api/watch/last', async (_req, res) => {
  try {
    const data = await getLastWatched();
    res.json({ ok: true, data });
  } catch (error) {
    console.error('[ERROR] API request failed:', error.message);

    // Re-authentication is an operator action, not a transient server fault
    if (error.code === 'REAUTH_REQUIRED') {
      return res.status(503).json({
        ok: false,
        code: 'REAUTH_REQUIRED',
        error: error.message
      });
    }

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ 
    ok: false, 
    error: 'Not found' 
  });
});

app.listen(PORT, () => {
  console.log(`[INFO] Watch history API server running on port ${PORT}`);
  console.log(`[INFO] Environment: ${process.env.NODE_ENV || 'development'}`);
});
