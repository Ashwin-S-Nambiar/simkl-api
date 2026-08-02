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
app.use(express.json());

// Verify credentials on startup
await initialize();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Main API endpoint
app.get('/api/watch/last', async (req, res) => {
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
app.use((req, res) => {
  res.status(404).json({ 
    ok: false, 
    error: 'Not found' 
  });
});

app.listen(PORT, () => {
  console.log(`[INFO] Watch history API server running on port ${PORT}`);
  console.log(`[INFO] Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Self-ping to prevent Render free tier spin-down
  if (process.env.NODE_ENV === 'production') {
    const SELF_PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
    const SERVICE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    setInterval(async () => {
      try {
        const response = await fetch(`${SERVICE_URL}/health`);
        if (response.ok) {
          console.log('[INFO] Self-ping successful - keeping service alive');
        }
      } catch (error) {
        console.error('[WARN] Self-ping failed:', error.message);
      }
    }, SELF_PING_INTERVAL);
    
    console.log('[INFO] Self-ping enabled - service will stay active');
  }
});
