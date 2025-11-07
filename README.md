# Trakt API

Express API server that fetches your last watched movie or TV episode from Trakt.tv with poster images from TMDB. Make use of Render for deploying trakt-api as it's free hosting alternative and Neon for trakt-db.

## Features

- Fetches last watched content (movies or episodes) from Trakt.tv
- Enriches data with poster images from TMDB
- Token auto-refresh with PostgreSQL persistence
- 5-minute response caching
- Self-ping to prevent Render free tier spin-down

## Prerequisites

- Node.js >= 18.0.0
- PostgreSQL database (optional - falls back to env variables)
- Trakt.tv API credentials
- TMDB API key (optional - for posters)

## Environment Variables

```env
# Required
TRAKT_CLIENT_ID=your_trakt_client_id
TRAKT_CLIENT_SECRET=your_trakt_client_secret
TRAKT_REFRESH_TOKEN=your_refresh_token

# Optional
DATABASE_URL=postgresql://user:password@host:port/database
TMDB_API_KEY=your_tmdb_api_key
FRONTEND_URL=https://your-frontend-url.com
PORT=3001
NODE_ENV=production
RENDER_EXTERNAL_URL=https://your-render-app.onrender.com
```

## API Endpoints

### `GET /api/trakt/last`
Returns the last watched movie or episode.

**Response:**
```json
{
  "ok": true,
  "data": {
    "type": "movie",
    "title": "The Matrix",
    "year": 1999,
    "poster_url": "https://image.tmdb.org/t/p/w500/...",
    "trakt_url": "https://trakt.tv/movies/the-matrix-1999",
    "watched_at": "2025-10-28T12:34:56.000Z"
  }
}
```

### `GET /health`
Health check endpoint.

## Token Setup

Run `get-token.js` to obtain your initial Trakt refresh token:
```bash
node get-token.js
```

## Database

The API automatically creates a `tokens` table for storing refresh tokens. Without a database, it falls back to the `TRAKT_REFRESH_TOKEN` environment variable.
