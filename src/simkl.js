import fetch from 'node-fetch';

const CLIENT_ID = process.env.SIMKL_CLIENT_ID;
const ACCESS_TOKEN = process.env.SIMKL_ACCESS_TOKEN;
// Overridable so the provider can be pointed at a mock server in tests
const SIMKL_API_BASE = process.env.SIMKL_API_BASE || 'https://api.simkl.com';
const SIMKL_IMAGE_BASE = 'https://simkl.in/posters';

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
const CACHE_TTL = 300000;

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
      // Movies come back under `movie`, shows and anime under `show`
      const media = item.movie || item.show || item.anime;
      if (!media) continue;

      const watchedAt = item.last_watched_at;
      if (!watchedAt) continue; // never watched - only on a watchlist

      entries.push({
        watchedAt,
        media,
        lastWatched: item.last_watched || null,
        isMovie: key === 'movies' || Boolean(item.movie)
      });
    }
  }

  return entries;
}

/**
 * Parse Simkl's "S01E05" episode marker
 * @param {string|null} marker - Episode marker
 * @returns {{season: number, episode: number}|null} Parsed numbers or null
 */
function parseEpisodeMarker(marker) {
  if (!marker) return null;

  const match = /S(\d+)E(\d+)/i.exec(marker);
  if (!match) return null;

  return {
    season: parseInt(match[1], 10),
    episode: parseInt(match[2], 10)
  };
}

/**
 * Build the poster URL from Simkl's own image path.
 * Simkl poster paths look like "24/24273cee77f9d9f". The _m size is 340px wide,
 * ample for the 100x150 widget even at 2x DPR, and webp is roughly 40% smaller
 * than the equivalent jpg. No network call is needed to construct this.
 * @param {Object} media - Simkl media object
 * @returns {string|null} Poster URL or null
 */
function posterUrlFor(media) {
  if (!media.poster) {
    return null;
  }

  return `${SIMKL_IMAGE_BASE}/${media.poster}_m.webp`;
}

/**
 * Shape a Simkl entry into the response format the portfolio consumes
 * @param {Object} entry - Entry from collectEntries
 * @returns {Object} Normalised last-watched payload
 */
function normaliseEntry(entry) {
  const { media, watchedAt, lastWatched, isMovie } = entry;
  const slug = media.ids?.slug;

  if (isMovie) {
    console.log(`[INFO] Last watched: ${media.title} (${media.year})`);

    const posterUrl = posterUrlFor(media);
    const url = slug ? `https://simkl.com/movies/${slug}` : null;

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
  const title = parsed
    ? `${media.title} S${parsed.season}E${parsed.episode}`
    : media.title;

  console.log(`[INFO] Last watched: ${title}`);

  const posterUrl = posterUrlFor(media);
  const url = slug ? `https://simkl.com/tv/${slug}` : null;

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

  const dateFrom = new Date(now - RECENT_WINDOW_DAYS * 86400000).toISOString();
  let entry = await fetchMostRecent(dateFrom);

  // Nothing watched recently - fall back to a full pull so the widget still
  // shows something rather than going blank after a quiet month
  if (!entry) {
    console.log(`[INFO] No activity in ${RECENT_WINDOW_DAYS} days, pulling full history...`);
    entry = await fetchMostRecent(null);
  }

  if (!entry) {
    console.log('[INFO] No watch history found');
    cache = { data: null, timestamp: Date.now() };
    return null;
  }

  const data = normaliseEntry(entry);
  cache = { data, timestamp: Date.now() };

  return data;
}
