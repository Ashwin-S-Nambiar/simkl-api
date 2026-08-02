# Simkl API

Express API server that fetches the last movie, show or anime I watched from [Simkl](https://simkl.com/), with poster art from TMDB. Deployed on Render's free tier and consumed by the last-watched widget on [ashwin.co.in](https://ashwin.co.in).

Base URL: <https://simkl.ashwin.co.in>

## Features

- Fetches last watched content across shows, anime and movies
- Enriches data with poster images from TMDB, falling back to Simkl posters
- 5-minute response caching
- Self-ping every 14 minutes to prevent Render free tier spin-down
- No database required — Simkl access tokens do not rotate

## Prerequisites

- Node.js >= 18.0.0
- A Simkl API app (free — <https://simkl.com/settings/developer/new/>)
- TMDB API key (optional — for higher quality posters)

## Environment Variables

```env
# Required
SIMKL_CLIENT_ID=your_simkl_client_id
SIMKL_ACCESS_TOKEN=your_simkl_access_token

# Optional
TMDB_API_KEY=your_tmdb_api_key
FRONTEND_URL=https://ashwin.co.in
PORT=3001
NODE_ENV=production
RENDER_EXTERNAL_URL=https://simkl.ashwin.co.in
```

`FRONTEND_URL` is the CORS allow-list entry, so it holds the *portfolio* origin —
`http://localhost:3000` is always allowed alongside it for local work.

`RENDER_EXTERNAL_URL` is only the self-ping target. Render injects it
automatically with the `*.onrender.com` hostname; setting it explicitly to the
custom domain keeps the keep-alive request on the public URL.

## Token Setup

Simkl access tokens are long-lived (~5 years) and there is no refresh token to
rotate, so this is a one-time setup. The token stays valid until you revoke the
app under <https://simkl.com/settings/connected-apps/>.

1. Create an app at <https://simkl.com/settings/developer/new/> — choose
   **"Add a new app"**, not "Add a new website", which grants only limited
   permissions and cannot read watch history
2. Put the client ID in `.env` as `SIMKL_CLIENT_ID`
3. Run the PIN flow and enter the 5-character code at <https://simkl.com/pin>:

```bash
node get-simkl-token.js
```

4. Save the printed token as `SIMKL_ACCESS_TOKEN`

## API Endpoints

### `GET /api/watch/last`

Returns the last watched movie or episode.

**Response:**

```json
{
  "ok": true,
  "data": {
    "type": "movie",
    "title": "Dune: Part Two",
    "year": 2024,
    "poster_url": "https://image.tmdb.org/t/p/w500/...",
    "url": "https://simkl.com/movies/dune-part-two",
    "watched_at": "2026-08-01T09:00:00Z"
  }
}
```

For episodes the payload also carries `show_title`, `season` and `episode`.

Returns `503` with `"code": "REAUTH_REQUIRED"` if the access token has been
revoked, which is the only condition requiring manual intervention.

### `GET /health`

Health check endpoint.

## Notes

Simkl has no "sort by most recent" parameter, so the service pulls the last 45
days of activity across the `shows`, `anime` and `movies` buckets and sorts
locally, falling back to a full history pull if nothing was watched in that
window.
