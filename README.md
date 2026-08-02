# Watch History API

Express API server that fetches your last watched movie or TV episode from **Simkl** (default) or **Trakt**, with poster images from TMDB. Deployed on Render's free tier.

## Providers

| | Simkl (recommended) | Trakt (legacy) |
|---|---|---|
| App registration | Free | Requires Trakt VIP |
| Token lifetime | ~5 years, no refresh token | 3 months, single-use rotating refresh token |
| Database needed | No | Yes, to persist rotated tokens |

Simkl is the default because its access tokens don't rotate — there is no refresh
step that can fail and lock the app out. Select a provider with `WATCH_PROVIDER`.

## Features

- Fetches last watched content (movies, episodes or anime)
- Enriches data with poster images from TMDB, falling back to Simkl posters
- 5-minute response caching
- Self-ping every 14 minutes to prevent Render free tier spin-down

## Prerequisites

- Node.js >= 18.0.0
- PostgreSQL database (optional - falls back to env variables)
- Trakt.tv API credentials
- TMDB API key (optional - for posters)

## Environment Variables

```env
# Provider selection - "simkl" (default when SIMKL_ACCESS_TOKEN is set) or "trakt"
WATCH_PROVIDER=simkl

# Required for Simkl
SIMKL_CLIENT_ID=your_simkl_client_id
SIMKL_ACCESS_TOKEN=your_simkl_access_token

# Not needed for the PIN flow, which uses the client id alone.
# Keep it only if you switch to the OAuth authorization-code flow.
SIMKL_CLIENT_SECRET=your_simkl_client_secret

# Required for Trakt (legacy provider)
TRAKT_CLIENT_ID=your_trakt_client_id
TRAKT_CLIENT_SECRET=your_trakt_client_secret
TRAKT_REFRESH_TOKEN=your_refresh_token
DATABASE_URL=postgresql://user:password@host:port/database

# Optional
TMDB_API_KEY=your_tmdb_api_key
FRONTEND_URL=https://your-frontend-url.com
PORT=3001
NODE_ENV=production
RENDER_EXTERNAL_URL=https://your-render-app.onrender.com
```

## API Endpoints

### `GET /api/watch/last`

Returns the last watched movie or episode. `GET /api/trakt/last` is kept as an
alias for the existing portfolio widget and returns an identical response.

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

### Simkl (recommended)

1. Create an app at <https://simkl.com/settings/developer/new/> (free, no VIP needed)
2. Put the client ID in `.env` as `SIMKL_CLIENT_ID`
3. Run the PIN flow and enter the 5-character code at <https://simkl.com/pin>:

```bash
node get-simkl-token.js
```

4. Save the printed token as `SIMKL_ACCESS_TOKEN`

The token does not rotate and stays valid until revoked under
<https://simkl.com/settings/connected-apps/>, so this is a one-time setup.

### Trakt (legacy)

```bash
node get-token.js
```

Creating a Trakt API app now requires Trakt VIP. The script writes the refresh
token straight to `DATABASE_URL` when set — necessary because the running server
reads the database before the environment, so a stale row would shadow a new token.

## Database

Only used by the Trakt provider, which must persist single-use refresh tokens
across rotations. The Simkl provider needs no database.
