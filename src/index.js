import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getLastWatched, initialize } from './trakt.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Initialize database on startup
await initialize();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString() 
  });
});

// Main API endpoint
app.get('/api/trakt/last', async (req, res) => {
  try {
    const data = await getLastWatched();
    res.json({ ok: true, data });
  } catch (error) {
    console.error('[ERROR] API request failed:', error.message);
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
  console.log(`[INFO] Trakt API server running on port ${PORT}`);
  console.log(`[INFO] Environment: ${process.env.NODE_ENV || 'development'}`);
});
