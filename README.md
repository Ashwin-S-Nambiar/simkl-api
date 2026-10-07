<p align="center">
  <a href="https://simkl.ashwin.co.in/api/watch/last"><strong>simkl.ashwin.co.in</strong></a>
  &nbsp;·&nbsp;
  <a href="#what-it-does">what it does</a>
  &nbsp;·&nbsp;
  <a href="#how-it-works">how it works</a>
  &nbsp;·&nbsp;
  <a href="#running-it">running it</a>
</p>

<br>

the source of **[simkl.ashwin.co.in](https://simkl.ashwin.co.in/api/watch/last)**, a small express server that answers one question: what did i watch last?

it reads my [simkl](https://simkl.com/) history, picks the newest thing across tv, anime and movies, attaches a poster, and hands it back as json. the last watched widget on [ashwin.co.in](https://ashwin.co.in) is the only thing that reads it.

fork it, point it at your own simkl account, and you get the same thing for your site. setup takes about ten minutes, most of it waiting on a browser tab.

## what it does

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

| route | what it is |
| --- | --- |
| `GET /api/watch/last` | the most recent movie or episode, as above |
| `GET /health` | `{ "status": "ok", "timestamp": "..." }`, for an uptime monitor |
| `GET /` | lists the routes, so the bare domain says what the service is instead of a 404 that looks like an outage |
| anything else | `404` with `{ "ok": false, "error": "Not found" }` |

- **two shapes.** `type` is `movie` or `episode`. movies return `title`, `year`, `poster_url`, `url` and `watched_at`. episodes add `show_title`, `season` and `episode`.
- **season can be null.** anime tracked through simkl itself uses absolute numbering (`E366`) with no season. shows, and anime scrobbled by clients that map to tmdb or tvdb, come back as `S01E05` and fill both fields. if you build a ui on this, handle the null.
- **one failure needs a human.** a `503` with `"code": "REAUTH_REQUIRED"` means simkl rejected the token, almost always because the app was revoked. run `get-simkl-token.js` again. anything else is a `500` with the message.
- **don't monitor `/`.** it is a static object and returns `200` even when the token is dead, which is exactly what a monitor should catch. use `/health`.

## one question, three requests

simkl has no "give me the latest item" endpoint. you can list your library, but you can't sort it by recency or ask for the top one. so this pulls the last 45 days from the three library buckets (`shows`, `anime`, `movies`), sorts them by `last_watched_at` here, and takes the newest. if nothing was watched in 45 days it falls back to the full history, so the widget shows something instead of going blank.

that's the whole trick. everything else is caching, posters, and making the failures readable.

## how it works

- **caching.** the answer is kept in memory for 5 minutes. simkl's limits are generous and my history doesn't change every second, so this mostly stops a busy page from hammering it. a restart clears it.
- **posters.** tmdb first, when there's a key and the title has a `tmdb` id. simkl's cdn otherwise, `null` if neither has one. simkl posters are asked for as `_m.webp`, which is 340 px wide and about 40% smaller than the jpg.
- **links.** simkl routes on the numeric id, so `/tv/my-show` doesn't resolve. it needs `/tv/1648284/my-show`, and the slug is only for show. anime gets `/anime/`, shows `/tv/`, movies `/movies/`.
- **empty buckets.** simkl sends an empty body, not `{}`, when a bucket has nothing in it, so the response is read as text and checked before parsing. the kind of thing you only find out in production.
- **fails at startup.** missing `SIMKL_CLIENT_ID` or `SIMKL_ACCESS_TOKEN` stops the server before it listens, with the name of what's missing. no tmdb key is a warning, and it carries on.

## the stack

| layer | choices |
| --- | --- |
| server | [express 5](https://expressjs.com) on node 22+, esm with top level `await` |
| data | the [simkl api](https://simkl.docs.apiary.io/), over global `fetch` |
| posters | [tmdb](https://www.themoviedb.org/), with simkl's own artwork as the fallback |
| auth | simkl's pin flow, run once by `get-simkl-token.js` |
| config | [dotenv](https://github.com/motdotla/dotenv), [cors](https://github.com/expressjs/cors) |
| hosting | [render](https://render.com), free tier |

no database. simkl tokens last about five years and there is no refresh token to rotate, so the token lives in an environment variable.

## running it

```sh
git clone https://github.com/Ashwin-S-Nambiar/simkl-api.git
cd simkl-api
npm install
cp .env.example .env
```

### 1. register a simkl app

go to <https://simkl.com/settings/developer/new/> and pick **add a new app**.

not **add a new website**. it looks like the right one and it isn't. website credentials get fewer permissions and can't read watch history, and that shows up later as a confusing `403` that never mentions permissions. this cost me an afternoon.

the redirect uri doesn't matter for this flow, so put anything valid, like `urn:ietf:wg:oauth:2.0:oob`. copy the client id into `.env` as `SIMKL_CLIENT_ID`.

### 2. get a token

```sh
node get-simkl-token.js
```

it prints a 5 character code and waits. open <https://simkl.com/pin>, type the code, approve the app, and the script prints your token. put it in `.env` as `SIMKL_ACCESS_TOKEN`.

you do this once. the token stays good until you revoke the app at <https://simkl.com/settings/connected-apps/>. the code expires after 15 minutes, and if the script says **simkl issued a new code**, the poll ran past a rotation. either way, run it again.

### 3. run it

```sh
npm run dev     # node --watch, reloads on change
npm start       # plain node
curl http://localhost:3001/api/watch/last
```

for nicer posters, grab a key from [tmdb's api settings](https://www.themoviedb.org/settings/api) and set `TMDB_API_KEY`. without it, posters come from simkl at 340 px, which is fine for a small widget. tmdb gives 500 px artwork and covers obscure titles better.

### environment

| variable | required | default | notes |
| --- | --- | --- | --- |
| `SIMKL_CLIENT_ID` | yes | | from your simkl app |
| `SIMKL_ACCESS_TOKEN` | yes | | from `get-simkl-token.js` |
| `TMDB_API_KEY` | no | | falls back to simkl posters |
| `FRONTEND_URL` | no | | the origins allowed through cors, comma separated |
| `PORT` | no | `3001` | |
| `NODE_ENV` | no | `development` | logged at startup |

`FRONTEND_URL` is the site that calls this, so for me it's my portfolio, not this api's own domain. list more than one with commas, like `https://ashwin.co.in,https://v2.ashwin.co.in`. `http://localhost:3000` is always allowed alongside them.

### hosting

i run it on render's free tier; any node host works. build with `npm install`, start with `npm start`, and set every variable above in the host's dashboard, not in a committed file.

the free tier sleeps after 15 idle minutes, and a cold start is long enough that the widget visibly hangs. nothing in this repo keeps it awake, on purpose: a server that pings itself on a free tier is rude and unreliable. an external [uptimerobot](https://uptimerobot.com/) monitor hits `/health` every 5 minutes instead. if the widget feels slow, check the monitor before reading the code.

## the shape of it

```
src/
  index.js            express, cors, the routes and the error shapes
  simkl.js            the three buckets, sorting, posters, links, the cache
get-simkl-token.js    the one time pin flow for a token
.env.example          every variable, with where to get it
```

## known rough edges

- **cors is not a lock.** requests with no `Origin` header (curl, apps, server side fetches) are let through, and cors only restricts browsers. treat the endpoint as public. mine returns what i watched last, which is already on my site, so that's fine. don't put anything private behind it.
- **the cache is per process.** it's in memory, so a restart or a second instance starts cold.
- **45 days, then everything.** a long break means one slow request for the full history, every 5 minutes, until you watch something.
- **cold starts.** see [hosting](#hosting).

### when it breaks

| symptom | cause |
| --- | --- |
| `Missing SIMKL_CLIENT_ID` at startup | `.env` not loaded, or the variable isn't set |
| `Missing SIMKL_ACCESS_TOKEN` | run `node get-simkl-token.js` |
| `503` with `REAUTH_REQUIRED` | the token was revoked, get a new one |
| `403` from simkl | you registered a website, not an app, see [step 1](#1-register-a-simkl-app) |
| a cors error in the browser | no entry in `FRONTEND_URL` matches your site's origin exactly, scheme and port included |
| `poster_url` is `null` | no tmdb key, and simkl has no poster for that title |
| stale answer | the 5 minute cache hasn't expired |

## credit

watch history comes from [simkl](https://simkl.com/). posters come from [tmdb](https://www.themoviedb.org/); this product uses the tmdb api but is not endorsed or certified by tmdb.

---

[simkl.ashwin.co.in](https://simkl.ashwin.co.in/api/watch/last) · [ashwin.co.in](https://ashwin.co.in) · [notes](https://inspect.ashwin.co.in) · [x](https://x.com/ashwinnambiar11) · [github](https://github.com/Ashwin-S-Nambiar)
