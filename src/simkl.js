const CLIENT_ID = process.env.SIMKL_CLIENT_ID;
const ACCESS_TOKEN = process.env.SIMKL_ACCESS_TOKEN;
const SIMKL_API_BASE = 'https://api.simkl.com';
const SIMKL_IMAGE_BASE = 'https://simkl.in/posters';
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

const APP_NAME = 'simkl-api';
const APP_VERSION = '1.0';
const USER_AGENT = `WatchHistory/${APP_VERSION} (+https://ashwin.co.in)`;

export class ReauthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReauthRequiredError';
    this.code = 'REAUTH_REQUIRED';
  }
}

// In-memory cache with 5 minute TTL
let cache = { data: null, timestamp: 0 };
let fullCache = { data: null, timestamp: 0 };
let entryCache = { entry: null, timestamp: 0 };
const CACHE_TTL = 300000;
const DETAIL_TTL = 12 * 3600000;
const detailCache = new Map();

// Only pull recently-touched items so the payload stays small. Simkl has no
// "sort by recency" parameter, so we fetch a window and sort locally.
const RECENT_WINDOW_DAYS = 45;

/**
 * Verify Simkl credentials are present
 */
export async function initialize() {
  console.log('[INFO] Initializing Simkl API...');

  if (!CLIENT_ID) {
    throw new Error('Missing SIMKL_CLIENT_ID');
  }

  if (!ACCESS_TOKEN) {
    throw new Error('Missing SIMKL_ACCESS_TOKEN - run: node get-simkl-token.js');
  }

  if (!TMDB_API_KEY) {
    console.warn('[WARN] TMDB_API_KEY not found - falling back to Simkl posters');
  }

  console.log('[INFO] Simkl API credentials verified');
}

/**
 * Build the query string Simkl requires on every request
 * @param {Object} extra - Additional query parameters
 * @returns {string} Encoded query string
 */
function buildQuery(extra = {}) {
  return new URLSearchParams({
    client_id: CLIENT_ID,
    'app-name': APP_NAME,
    'app-version': APP_VERSION,
    ...extra
  }).toString();
}

function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'simkl-api-key': CLIENT_ID,
    'Authorization': `Bearer ${ACCESS_TOKEN}`
  };
}

/**
 * Fetch one library bucket from Simkl
 * @param {string} type - 'shows', 'movies' or 'anime'
 * @param {string|null} dateFrom - ISO timestamp to filter from, or null for everything
 * @returns {Promise<Object>} Raw Simkl response ({} when the bucket is empty)
 */
async function fetchBucket(type, dateFrom) {
  const query = buildQuery(dateFrom ? { date_from: dateFrom } : {});
  const url = `${SIMKL_API_BASE}/sync/all-items/${type}/all?${query}`;

  const response = await fetch(url, { headers: buildHeaders() });

  if (response.status === 401 || response.status === 403) {
    throw new ReauthRequiredError(
      'Simkl rejected the access token - it was likely revoked. Run: node get-simkl-token.js'
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Simkl ${type} request failed: ${response.status} ${body}`);
  }

  // Simkl returns an empty body (not JSON) when a bucket has no items
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    console.warn(`[WARN] Could not parse Simkl ${type} response as JSON`);
    return {};
  }
}

/**
 * Flatten a Simkl bucket response into comparable entries
 * @param {Object} payload - Raw bucket response
 * @returns {Array<Object>} Entries with a watched timestamp
 */
function collectEntries(payload) {
  const entries = [];

  for (const [key, items] of Object.entries(payload)) {
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      // Movies come back under `movie`, shows and anime both under `show`
      const media = item.movie || item.show;
      if (!media) continue;

      const watchedAt = item.last_watched_at;
      if (!watchedAt) continue; // never watched - only on a watchlist

      entries.push({
        watchedAt,
        media,
        item,
        lastWatched: item.last_watched || null,
        // Anime lives in its own bucket but is shaped like a show, so keep the
        // bucket around - it decides the simkl.com path segment later
        bucket: key,
        isMovie: key === 'movies' || Boolean(item.movie)
      });
    }
  }

  return entries;
}

/**
 * Parse Simkl's episode marker
 *
 * Two shapes come back. Seasoned shows - and anime scrobbled by clients that
 * map to TMDB/TVDB numbering - use "S01E05". Anime tracked through Simkl itself
 * uses absolute numbering with no season at all ("E366"), so a season-less
 * result is normal rather than a parse failure.
 *
 * @param {string|null} marker - Episode marker
 * @returns {{season: number|null, episode: number}|null} Parsed numbers or null
 */
function parseEpisodeMarker(marker) {
  if (!marker) return null;

  const seasoned = /S(\d+)E(\d+)/i.exec(marker);
  if (seasoned) {
    return {
      season: parseInt(seasoned[1], 10),
      episode: parseInt(seasoned[2], 10)
    };
  }

  const absolute = /^E(\d+)$/i.exec(marker.trim());
  if (absolute) {
    return {
      season: null,
      episode: parseInt(absolute[1], 10)
    };
  }

  return null;
}

/**
 * Render a display title, omitting the season when there isn't one
 * @param {string} title - Show title
 * @param {{season: number|null, episode: number}|null} parsed - Parsed marker
 * @returns {string} Display title
 */
function formatEpisodeTitle(title, parsed) {
  if (!parsed) return title;

  return parsed.season != null
    ? `${title} S${parsed.season}E${parsed.episode}`
    : `${title} E${parsed.episode}`;
}

/**
 * Build a canonical simkl.com link for a media item
 *
 * Simkl routes on the numeric id, not the slug - "/tv/my-show" does not resolve
 * to the title page, it needs "/tv/1648284/my-show". The slug is cosmetic; the
 * id alone works, so it is only appended when present.
 *
 * @param {string} segment - simkl.com path segment: 'movies', 'anime' or 'tv'
 * @param {Object} media - Simkl media object
 * @returns {string|null} Canonical URL or null when the id is missing
 */
function buildSimklUrl(segment, media) {
  const simklId = media.ids?.simkl ?? media.ids?.simkl_id;
  if (!simklId) return null;

  const slug = media.ids?.slug;
  return slug
    ? `https://simkl.com/${segment}/${simklId}/${slug}`
    : `https://simkl.com/${segment}/${simklId}`;
}

/**
 * Fetch a poster, preferring TMDB and falling back to Simkl's own image
 * @param {string} type - 'movie' or 'tv'
 * @param {Object} media - Simkl media object
 * @returns {Promise<string|null>} Poster URL or null
 */
async function fetchPoster(type, media) {
  const tmdbId = media.ids?.tmdb;

  if (TMDB_API_KEY && tmdbId) {
    try {
      const endpoint = type === 'movie'
        ? `${TMDB_API_BASE}/movie/${tmdbId}`
        : `${TMDB_API_BASE}/tv/${tmdbId}`;

      const response = await fetch(`${endpoint}?api_key=${TMDB_API_KEY}`, {
        headers: { 'User-Agent': USER_AGENT }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.poster_path) {
          return `${TMDB_IMAGE_BASE}${data.poster_path}`;
        }
      } else {
        console.warn(`[WARN] Failed to fetch TMDB data for ${type} ${tmdbId}`);
      }
    } catch (error) {
      console.error(`[ERROR] TMDB fetch failed: ${error.message}`);
    }
  }

  // Simkl poster paths look like "24/24273cee77f9d9f". The _m size is 340px
  // wide - ample for the 100x150 widget even at 2x DPR - and webp is roughly
  // 40% smaller than the equivalent jpg.
  if (media.poster) {
    return `${SIMKL_IMAGE_BASE}/${media.poster}_m.webp`;
  }

  return null;
}

/**
 * Shape a Simkl entry into the response format the portfolio consumes
 * @param {Object} entry - Entry from collectEntries
 * @returns {Promise<Object>} Normalised last-watched payload
 */
async function normaliseEntry(entry) {
  const { media, watchedAt, lastWatched, isMovie, bucket } = entry;

  if (isMovie) {
    console.log(`[INFO] Last watched: ${media.title} (${media.year})`);

    const posterUrl = await fetchPoster('movie', media);
    const url = buildSimklUrl('movies', media);

    return {
      type: 'movie',
      title: media.title,
      year: media.year,
      poster_url: posterUrl,
      url,
      watched_at: watchedAt
    };
  }

  const parsed = parseEpisodeMarker(lastWatched);
  const title = formatEpisodeTitle(media.title, parsed);

  console.log(`[INFO] Last watched: ${title}`);

  const posterUrl = await fetchPoster('tv', media);
  const url = buildSimklUrl(bucket === 'anime' ? 'anime' : 'tv', media);

  return {
    type: 'episode',
    title,
    show_title: media.title,
    season: parsed?.season ?? null,
    episode: parsed?.episode ?? null,
    year: media.year,
    poster_url: posterUrl,
    url,
    watched_at: watchedAt
  };
}

/**
 * Fetch the most recently watched item across shows, anime and movies
 * @param {string|null} dateFrom - ISO timestamp to filter from
 * @returns {Promise<Object|null>} Most recent entry or null
 */
async function fetchMostRecent(dateFrom) {
  const buckets = await Promise.all([
    fetchBucket('shows', dateFrom),
    fetchBucket('anime', dateFrom),
    fetchBucket('movies', dateFrom)
  ]);

  const entries = buckets.flatMap(collectEntries);

  if (!entries.length) {
    return null;
  }

  entries.sort((a, b) =>
    new Date(b.watchedAt).getTime() - new Date(a.watchedAt).getTime()
  );

  return entries[0];
}

async function getRecentEntry() {
  const now = Date.now();

  if (entryCache.timestamp && now - entryCache.timestamp < CACHE_TTL) {
    return entryCache.entry;
  }

  const dateFrom = new Date(now - RECENT_WINDOW_DAYS * 86400000).toISOString();
  let entry = await fetchMostRecent(dateFrom);

  // Nothing watched recently - fall back to a full pull so the widget still
  // shows something rather than going blank after a quiet month
  if (!entry) {
    console.log(`[INFO] No activity in ${RECENT_WINDOW_DAYS} days, pulling full history...`);
    entry = await fetchMostRecent(null);
  }

  entryCache = { entry, timestamp: Date.now() };
  return entry;
}

/**
 * Get last watched item with caching
 * @returns {Promise<Object|null>} Last watched item
 */
export async function getLastWatched() {
  const now = Date.now();

  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    console.log('[INFO] Returning cached data');
    return cache.data;
  }

  console.log('[INFO] Cache expired or empty, fetching fresh data...');

  const entry = await getRecentEntry();

  if (!entry) {
    console.log('[INFO] No watch history found');
    cache = { data: null, timestamp: Date.now() };
    return null;
  }

  const data = await normaliseEntry(entry);
  cache = { data, timestamp: Date.now() };

  return data;
}

async function fetchPublic(path, extra = {}) {
  const response = await fetch(`${SIMKL_API_BASE}${path}?${buildQuery(extra)}`, {
    headers: { 'User-Agent': USER_AGENT, 'simkl-api-key': CLIENT_ID }
  });

  if (!response.ok) {
    throw new Error(`Simkl ${path} request failed: ${response.status}`);
  }

  return response.json();
}

async function remember(key, load) {
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.timestamp < DETAIL_TTL) return hit.data;

  try {
    const data = await load();
    detailCache.set(key, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    console.warn(`[WARN] ${error.message}`);
    return hit?.data ?? null;
  }
}

function decodeEntities(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function englishTitle(detail) {
  const en = decodeEntities(detail?.en_title)?.replace(/\s+(season\s+\d+|s\d+|part\s+\d+|cour\s+\d+)$/i, '').trim();
  return en || null;
}

function splitTitle(name) {
  const colon = /^(.+?):\s+(.+)$/.exec(name);
  if (!colon) {
    const dash = /^(.+?)\s+-\s+(.+)$/.exec(name);
    return dash
      ? { main: dash[1], subtitle: null, arc: dash[2] }
      : { main: name, subtitle: null, arc: null };
  }

  const dash = /^(.+?)\s+-\s+(.+)$/.exec(colon[2]);
  return dash
    ? { main: colon[1], subtitle: dash[1], arc: dash[2] }
    : { main: colon[1], subtitle: colon[2], arc: null };
}

function findEpisodeTitle(episodes, parsed) {
  if (!Array.isArray(episodes) || !parsed) return null;

  const match = episodes.find((e) =>
    e.type === 'episode' &&
    e.episode === parsed.episode &&
    (parsed.season == null || e.season == null || e.season === parsed.season)
  );

  const title = decodeEntities(match?.title)?.trim();
  return title && !/^episode\s+\d+$/i.test(title) ? title : null;
}

function pickRating(ratings, key) {
  const rating = ratings?.[key];
  return rating?.rating != null ? { rating: rating.rating, votes: rating.votes ?? null } : null;
}

function buildLinks(ids) {
  return {
    imdb: ids.imdb ? `https://www.imdb.com/title/${ids.imdb}` : null,
    mal: ids.mal ? `https://myanimelist.net/anime/${ids.mal}` : null,
    anilist: ids.anilist ? `https://anilist.co/anime/${ids.anilist}` : null,
    tmdb: ids.tmdb ? `https://www.themoviedb.org/${ids.tmdb_type === 'movie' ? 'movie' : 'tv'}/${ids.tmdb}` : null
  };
}

async function enrichEntry(entry) {
  const { media, item, watchedAt, lastWatched, bucket } = entry;
  const kind = bucket === 'anime' ? 'anime' : entry.isMovie ? 'movie' : 'tv';
  const isFilm = entry.isMovie || item?.anime_type === 'movie';
  const simklId = media.ids?.simkl ?? media.ids?.simkl_id;
  const detailPath = kind === 'anime' ? 'anime' : kind === 'movie' ? 'movies' : 'tv';
  const parsed = isFilm ? null : parseEpisodeMarker(lastWatched);

  const [detail, episodes, posterUrl] = await Promise.all([
    simklId ? remember(`detail:${detailPath}:${simklId}`, () => fetchPublic(`/${detailPath}/${simklId}`, { extended: 'full' })) : null,
    simklId && parsed ? remember(`episodes:${detailPath}:${simklId}`, () => fetchPublic(`/${detailPath}/episodes/${simklId}`)) : null,
    fetchPoster(isFilm ? 'movie' : 'tv', media)
  ]);

  const english = englishTitle(detail);
  const display = english || decodeEntities(media.title);
  const ids = { ...(detail?.ids ?? {}), ...(media.ids ?? {}), tmdb_type: isFilm ? 'movie' : 'tv' };
  const trailer = detail?.trailers?.find((t) => t.youtube);

  console.log(`[INFO] Enriched: ${display}${parsed ? ` E${parsed.episode}` : ''}`);

  return {
    type: isFilm ? 'movie' : 'episode',
    kind,
    title: {
      original: decodeEntities(media.title),
      english,
      display,
      ...splitTitle(display)
    },
    episode: parsed
      ? { season: parsed.season, number: parsed.episode, title: findEpisodeTitle(episodes, parsed) }
      : null,
    year: media.year ?? detail?.year ?? null,
    poster_url: posterUrl,
    fanart_url: detail?.fanart ? `https://simkl.in/fanart/${detail.fanart}_medium.webp` : null,
    url: buildSimklUrl(kind === 'anime' ? 'anime' : isFilm ? 'movies' : 'tv', media),
    watched_at: watchedAt,
    progress: isFilm
      ? null
      : {
          watched: item?.watched_episodes_count ?? null,
          total: item?.total_episodes_count ?? detail?.total_episodes ?? null,
          status: item?.status ?? null
        },
    ratings: {
      imdb: pickRating(detail?.ratings, 'imdb'),
      mal: pickRating(detail?.ratings, 'mal'),
      simkl: pickRating(detail?.ratings, 'simkl'),
      mine: item?.user_rating ?? null
    },
    genres: detail?.genres ?? [],
    runtime: detail?.runtime ?? null,
    certification: detail?.certification ?? null,
    airing: detail?.status ?? null,
    season_label: detail?.season_name_year ?? null,
    network: detail?.network ?? null,
    studios: (detail?.studios ?? []).map((s) => s.name),
    director: detail?.director ?? null,
    overview: decodeEntities(detail?.overview) ?? null,
    trailer_url: trailer ? `https://www.youtube.com/watch?v=${trailer.youtube}` : null,
    links: buildLinks(ids)
  };
}

export async function getLastWatchedFull() {
  const now = Date.now();

  if (fullCache.data && now - fullCache.timestamp < CACHE_TTL) {
    return fullCache.data;
  }

  const entry = await getRecentEntry();
  const data = entry ? await enrichEntry(entry) : null;
  fullCache = { data, timestamp: Date.now() };

  return data;
}
