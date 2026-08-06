# simkl-api

A small Express server that answers exactly one question: what did I watch last?

It reads my [Simkl](https://simkl.com/) history, picks the most recent thing across TV, anime and movies, attaches a poster, and hands it back as JSON. The "last watched" widget on [ashwin.co.in](https://ashwin.co.in) is the only thing that consumes it.

Live endpoint: <https://simkl.ashwin.co.in/api/watch/last>

```json
{
  "ok": true,
  "data": {
    "type": "episode",
    "title": "Frieren: Beyond Journey's End E12",
    "show_title": "Frieren: Beyond Journey's End",
    "season": null,
    "episode": 12,
    "year": 2023,
    "poster_url": "https://image.tmdb.org/t/p/w500/...",
    "url": "https://simkl.com/anime/1522280/frieren",
    "watched_at": "2026-08-01T09:00:00Z"
  }
}
```

Fork it, point it at your own Simkl account, and you get the same thing for your site. Setup takes about ten minutes, most of which is waiting on a browser tab.

## Why it exists

Simkl has no "give me the most recent item" endpoint. You can list your library, but you cannot sort it by recency or ask for the top result. So this service pulls the last 45 days from the three library buckets (`shows`, `anime`, `movies`), sorts them locally by `last_watched_at`, and takes the newest. If you have watched nothing in 45 days it falls back to a full history pull so the widget shows something instead of going blank.

That is the whole trick. Everything else here is caching, poster lookup, and making the failure modes legible.

## Requirements

- Node.js 18 or newer (the code uses global `fetch`, ESM and top-level `await`)
- A free Simkl account with some watch history on it
- A [TMDB](https://www.themoviedb.org/) API key, optional, for nicer posters

## Setup

### 1. Clone and install

```bash
git clone https://github.com/Ashwin-S-Nambiar/simkl-api.git
cd simkl-api
npm install
```

### 2. Register a Simkl app

Go to <https://simkl.com/settings/developer/new/> and pick **"Add a new app"**.

Do not pick "Add a new website". It looks like the right choice and it is not. Website credentials get a reduced permission set that cannot read watch history, and the failure surfaces later as a confusing 403 rather than anything that mentions permissions. This cost me an afternoon.

Redirect URI does not matter for this flow, so put anything valid such as `urn:ietf:wg:oauth:2.0:oob`.

Copy the client ID it gives you.

### 3. Create your .env

```bash
cp .env.example .env   # or just create the file
```

```env
SIMKL_CLIENT_ID=your_client_id_here
SIMKL_ACCESS_TOKEN=          # filled in by the next step
TMDB_API_KEY=                # optional
FRONTEND_URL=http://localhost:3000
PORT=3001
NODE_ENV=development
```

### 4. Get an access token

```bash
node get-simkl-token.js
```

The script prints a 5 character code and waits. Open <https://simkl.com/pin>, type the code, approve the app, and the script prints your token. Paste it into `.env` as `SIMKL_ACCESS_TOKEN`.

You do this once. Simkl tokens are long lived (they advertise roughly five years) and there is no refresh token to rotate, which is why this project needs no database. The token stays good until you revoke the app at <https://simkl.com/settings/connected-apps/>.

Two things that can go wrong here:

- **"Simkl issued a new code. Re-run this script."** means the poll ran past the point where Simkl rotated the code. Just run it again.
- The code expires after 15 minutes. Run it again.

### 5. Run it

```bash
npm run dev     # nodemon, reloads on change
npm start       # plain node
curl http://localhost:3001/api/watch/last
```

If the token is good you get JSON. If it is not, the server refuses to start and tells you which variable is missing.

### 6. TMDB key (optional)

Without it, posters come from Simkl's own CDN at 340px wide, which is fine for a small widget. With it, you get TMDB's 500px artwork and better coverage on obscure titles. Grab one from [TMDB's API settings](https://www.themoviedb.org/settings/api) and drop it in as `TMDB_API_KEY`. The server logs a warning at startup when the key is absent and carries on.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SIMKL_CLIENT_ID` | yes | | From your Simkl app |
| `SIMKL_ACCESS_TOKEN` | yes | | From `get-simkl-token.js` |
| `TMDB_API_KEY` | no | | Falls back to Simkl posters when unset |
| `FRONTEND_URL` | no | | Origin allowed through CORS |
| `PORT` | no | `3001` | |
| `NODE_ENV` | no | `development` | Logged at startup |

`FRONTEND_URL` holds the origin of the site that will call this, so for me that is my portfolio, not this API's own domain. `http://localhost:3000` is always allowed alongside it so local development works without editing anything.

Worth knowing: requests with no `Origin` header (curl, mobile apps, server side fetches) are allowed through. CORS only restricts browsers, so treat this endpoint as public regardless of what you put in `FRONTEND_URL`. Mine returns what I watched last, which is already on my public site, so that is fine. Do not put anything private behind it.

## Endpoints

### `GET /api/watch/last`

Returns the most recent item. `type` is either `movie` or `episode`.

Movies return `type`, `title`, `year`, `poster_url`, `url` and `watched_at`. Episodes add `show_title`, `season` and `episode`.

`season` is `null` for anime tracked through Simkl itself, because that uses absolute episode numbering (`E366`) with no season component. Shows and anime scrobbled by clients that map to TMDB or TVDB numbering come back as `S01E05` and populate both fields. If you are building a UI on top of this, handle the null.

A `503` with `"code": "REAUTH_REQUIRED"` means Simkl rejected the token, almost always because the app was revoked. Re-run `get-simkl-token.js`. This is the one failure that needs a human.

### `GET /health`

Returns `{ "status": "ok", "timestamp": "..." }`. Useful as an uptime monitor target, see below.

### `GET /`

Lists the endpoints above. This exists so that pasting the bare domain into a browser tells you what the service is instead of returning a 404 that looks like an outage.

Do not point an uptime monitor at it. It is a static object and returns `200` even when the Simkl token is dead, which is exactly the failure you want a monitor to catch. Use `/health`.

Anything else returns `404` with `{ "ok": false, "error": "Not found" }`.

## Deploying

I run this on Render's free tier. Any Node host works.

- Build: `npm install`
- Start: `npm start`
- Set every variable from the table above in the host's dashboard, not in a committed file

The free tier spins the instance down after 15 idle minutes, and a cold start takes long enough that the widget visibly hangs. Nothing in this repo keeps the service awake, deliberately, because a self-pinging server on a free tier is both rude and unreliable. I point an external [UptimeRobot](https://uptimerobot.com/) monitor at `/health` every 5 minutes instead.

So if the widget starts feeling slow, check the monitor before you go reading the code.

## How it works

Roughly 350 lines in `src/simkl.js` doing the following:

**Caching.** Responses are cached in memory for 5 minutes. Simkl's rate limits are generous and my watch history does not change every second, so this mostly protects against a busy page hammering the endpoint. Restarting the process clears it.

**Poster lookup.** TMDB first when a key and a `tmdb` id are both present, Simkl's CDN otherwise, `null` if neither has one. Simkl posters are requested as `_m.webp`, which is 340px and roughly 40% smaller than the jpg equivalent.

**Links.** Simkl routes on numeric id, so `/tv/my-show` does not resolve. The URL needs `/tv/1648284/my-show`, and the slug is cosmetic. Anime gets `/anime/`, shows get `/tv/`, movies get `/movies/`.

**Empty buckets.** Simkl returns an empty body rather than `{}` when a bucket has nothing in it, so the response is read as text and checked before parsing. This is the kind of thing you only find out in production.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Missing SIMKL_CLIENT_ID` at startup | `.env` not loaded or variable not set |
| `Missing SIMKL_ACCESS_TOKEN` | Run `node get-simkl-token.js` |
| `503` with `REAUTH_REQUIRED` | Token revoked, generate a new one |
| `403` from Simkl | You registered a website instead of an app, see step 2 |
| `Not allowed by CORS` in the browser | `FRONTEND_URL` does not match your site's origin exactly, including scheme and port |
| Posters are `null` | No TMDB key and no Simkl poster for that title |
| Empty or stale response | Nothing watched in 45 days, or the 5 minute cache has not expired |
