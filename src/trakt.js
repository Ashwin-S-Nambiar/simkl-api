import fetch from 'node-fetch';
import { getToken, saveToken, getAccessToken, saveAccessToken, withAdvisoryLock } from './db.js';

const CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;
const TRAKT_API_BASE = 'https://api.trakt.tv';
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const USER_AGENT = 'TraktWatchHistory/1.0 (+https://ashwin.co.in)';

// In-memory cache with 5 minute TTL
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 300000; // 5 minutes in milliseconds

// Refresh lock to prevent concurrent refresh attempts (race condition fix)
let isRefreshing = false;
let refreshPromise = null;

// In-memory access token cache (backup if DB fails)
let accessTokenCache = { token: null, expiresAt: 0 };

// Refresh tokens Trakt has already rejected. Retrying one is guaranteed to fail
// and only burns rate limit, so short-circuit until a different token appears.
const rejectedRefreshTokens = new Set();

// Serialises refreshes across processes/instances, not just within one process.
// Trakt refresh tokens are single-use, so two concurrent refreshes with the same
// token leave one caller holding a token that was invalidated on arrival.
const REFRESH_LOCK_ID = 4827301;

export class ReauthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReauthRequiredError';
    this.code = 'REAUTH_REQUIRED';
  }
}

// Initialize and verify Trakt API credentials
export async function initialize() {
  console.log('[INFO] Initializing Trakt API...');

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing TRAKT_CLIENT_ID or TRAKT_CLIENT_SECRET');
  }

  if (!TMDB_API_KEY) {
    console.warn('[WARN] TMDB_API_KEY not found - poster images will not be available');
  }

  console.log('[INFO] Trakt API credentials verified');
}

/**
 * Get a valid access token, refreshing if necessary
 * Uses locking to prevent concurrent refresh attempts (race condition fix)
 * @returns {Promise<string>} Valid access token
 */
async function getValidAccessToken() {
  const now = Date.now();

  // First, try to get cached access token from DB
  const cachedToken = await getAccessToken();
  if (cachedToken && cachedToken.expiresAt > now + 60000) { // 1 min buffer
    console.log('[INFO] Using cached access token from database');
    return cachedToken.token;
  }

  // Check in-memory cache as backup
  if (accessTokenCache.token && accessTokenCache.expiresAt > now + 60000) {
    console.log('[INFO] Using cached access token from memory');
    return accessTokenCache.token;
  }

  // Need to refresh - use lock to prevent concurrent refreshes
  if (isRefreshing) {
    console.log('[INFO] Token refresh already in progress, waiting...');
    return refreshPromise;
  }

  isRefreshing = true;
  refreshPromise = doRefreshAccessToken()
    .finally(() => {
      isRefreshing = false;
      refreshPromise = null;
    });

  return refreshPromise;
}

/**
 * Actually perform the token refresh (internal function)
 * @returns {Promise<string>} New access token
 */
async function doRefreshAccessToken(rejectedAccessToken = null) {
  return withAdvisoryLock(REFRESH_LOCK_ID, () => refreshUnderLock(rejectedAccessToken));
}

/**
 * Refresh body, executed while holding the cross-process lock
 * @param {string|null} rejectedAccessToken - Access token Trakt just rejected, if any
 * @returns {Promise<string>} New access token
 */
async function refreshUnderLock(rejectedAccessToken) {
  // Another process may have refreshed while we waited for the lock. Reuse its
  // result rather than spending our single-use refresh token on a second refresh.
  const cachedToken = await getAccessToken();
  if (
    cachedToken &&
    cachedToken.expiresAt > Date.now() + 60000 &&
    cachedToken.token !== rejectedAccessToken
  ) {
    console.log('[INFO] Another process already refreshed the token, reusing it');
    accessTokenCache = { token: cachedToken.token, expiresAt: cachedToken.expiresAt };
    return cachedToken.token;
  }

  const refreshToken = await getToken();

  if (!refreshToken) {
    throw new ReauthRequiredError('No refresh token found in database or environment. Please run get-token.js to generate a new token.');
  }

  if (rejectedRefreshTokens.has(refreshToken)) {
    throw new ReauthRequiredError('Refresh token was already rejected by Trakt - please re-authenticate using get-token.js');
  }

  console.log('[INFO] Refreshing access token...');

  const response = await fetch(`${TRAKT_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  if (!response.ok) {
    const errorText = await response.text();

    // Parse the error for better messaging
    try {
      const errorData = JSON.parse(errorText);
      if (errorData.error === 'invalid_grant') {
        // Remember it so every later request fails fast instead of hammering Trakt
        rejectedRefreshTokens.add(refreshToken);
        console.error('[ERROR] Refresh token is invalid or expired.');
        console.error('[ERROR] This can happen if:');
        console.error('[ERROR]   1. A rotated refresh token was never persisted (crash/failed DB write)');
        console.error('[ERROR]   2. Two instances refreshed at once, invalidating one copy');
        console.error('[ERROR]   3. The token was revoked, or expired after 6 months of inactivity');
        console.error('[ERROR] Please run: node get-token.js to generate a new token');
        throw new ReauthRequiredError('Refresh token invalid - please re-authenticate using get-token.js');
      }
    } catch (parseError) {
      // Preserve the typed error; only fall through when the body was not JSON
      if (parseError instanceof ReauthRequiredError) {
        throw parseError;
      }
    }

    throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  // Calculate expiry time (use expires_in from response, default to 24 hours)
  const expiresIn = data.expires_in || 86400; // 24 hours in seconds
  const expiresAt = Date.now() + (expiresIn * 1000);

  // Persist the rotated refresh token FIRST. Trakt invalidated the old one the
  // moment it answered, so if the process dies before this write lands there is
  // no way back in without re-authenticating by hand.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.log('[INFO] New refresh token received, updating database...');
    await saveToken(data.refresh_token);
  }

  // Save new access token to database and memory
  await saveAccessToken(data.access_token, expiresAt);
  accessTokenCache = { token: data.access_token, expiresAt };

  console.log('[INFO] Access token refreshed successfully');
  console.log(`[INFO] Token expires at: ${new Date(expiresAt).toISOString()}`);
  return data.access_token;
}

/**
 * Fetch poster image from TMDB
 * @param {string} type - 'movie' or 'tv'
 * @param {number} tmdbId - TMDB ID
 * @returns {Promise<string|null>} Poster URL or null
 */
async function fetchPosterFromTMDB(type, tmdbId) {
  if (!TMDB_API_KEY || !tmdbId) {
    return null;
  }

  try {
    const endpoint = type === 'movie'
      ? `${TMDB_API_BASE}/movie/${tmdbId}`
      : `${TMDB_API_BASE}/tv/${tmdbId}`;

    const response = await fetch(`${endpoint}?api_key=${TMDB_API_KEY}`, {
      headers: { 'User-Agent': USER_AGENT }
    });

    if (!response.ok) {
      console.warn(`[WARN] Failed to fetch TMDB data for ${type} ${tmdbId}`);
      return null;
    }

    const data = await response.json();

    if (data.poster_path) {
      return `${TMDB_IMAGE_BASE}${data.poster_path}`;
    }

    return null;
  } catch (error) {
    console.error(`[ERROR] TMDB fetch failed: ${error.message}`);
    return null;
  }
}

/**
 * Fetch watch history from Trakt API
 * @param {string} accessToken - Valid access token
 * @returns {Promise<Object|null>} Last watched item or null
 */
async function fetchHistory(accessToken) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'trakt-api-version': '2',
    'trakt-api-key': CLIENT_ID,
    'Authorization': `Bearer ${accessToken}`
  };

  console.log('[INFO] Fetching watch history from Trakt...');

  const [moviesRes, episodesRes] = await Promise.all([
    fetch(`${TRAKT_API_BASE}/sync/history/movies?limit=1`, { headers }),
    fetch(`${TRAKT_API_BASE}/sync/history/episodes?limit=1`, { headers })
  ]);

  if (!moviesRes.ok) {
    const body = await moviesRes.text().catch(() => '');
    console.error(`[ERROR] Movies history failed: ${moviesRes.status} ${moviesRes.statusText} - ${body}`);
  }
  if (!episodesRes.ok) {
    const body = await episodesRes.text().catch(() => '');
    console.error(`[ERROR] Episodes history failed: ${episodesRes.status} ${episodesRes.statusText} - ${body}`);
  }

  if (!moviesRes.ok && !episodesRes.ok) {
    const status = moviesRes.status;
    if (status === 401 || status === 403) {
      throw new Error(`AUTH_FAILED:${status}`);
    }
    throw new Error(`Failed to fetch history from Trakt API (movies: ${moviesRes.status}, episodes: ${episodesRes.status})`);
  }

  const movies = moviesRes.ok ? await moviesRes.json() : [];
  const episodes = episodesRes.ok ? await episodesRes.json() : [];

  const items = [];

  if (movies.length) {
    items.push({
      watched_at: movies[0].watched_at,
      payload: movies[0],
      kind: 'movie'
    });
  }

  if (episodes.length) {
    items.push({
      watched_at: episodes[0].watched_at,
      payload: episodes[0],
      kind: 'episode'
    });
  }

  if (!items.length) {
    console.log('[INFO] No watch history found');
    return null;
  }

  // Sort by most recent
  items.sort((a, b) =>
    new Date(b.watched_at).getTime() - new Date(a.watched_at).getTime()
  );

  const latest = items[0];

  if (latest.kind === 'movie') {
    const movie = latest.payload.movie;
    console.log(`[INFO] Last watched: ${movie.title} (${movie.year})`);

    // Fetch poster from TMDB if available
    const posterUrl = await fetchPosterFromTMDB('movie', movie.ids?.tmdb);

    return {
      type: 'movie',
      title: movie.title,
      year: movie.year,
      poster_url: posterUrl,
      trakt_url: movie.ids?.slug
        ? `https://trakt.tv/movies/${movie.ids.slug}`
        : null,
      watched_at: latest.watched_at
    };
  } else {
    const ep = latest.payload.episode;
    const show = latest.payload.show || {};
    const title = ep.title || `${show.title || 'Episode'} S${ep.season}E${ep.number}`;
    const url = show.ids?.slug
      ? `https://trakt.tv/shows/${show.ids.slug}/seasons/${ep.season}/episodes/${ep.number}`
      : null;

    console.log(`[INFO] Last watched: ${show.title} S${ep.season}E${ep.number}`);

    // Fetch show poster from TMDB if available
    const posterUrl = await fetchPosterFromTMDB('tv', show.ids?.tmdb);

    return {
      type: 'episode',
      title,
      show_title: show.title,
      season: ep.season,
      episode: ep.number,
      year: show.year,
      poster_url: posterUrl,
      trakt_url: url,
      watched_at: latest.watched_at
    };
  }
}

/**
 * Force a fresh access token by clearing caches and refreshing
 * @returns {Promise<string>} New access token
 */
async function forceTokenRefresh(rejectedAccessToken) {
  console.log('[INFO] Forcing token refresh due to auth failure...');
  accessTokenCache = { token: null, expiresAt: 0 };
  return doRefreshAccessToken(rejectedAccessToken);
}

/**
 * Get last watched item with caching
 * @returns {Promise<Object|null>} Last watched item
 */
export async function getLastWatched() {
  const now = Date.now();

  // Return cached data if still valid
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    console.log('[INFO] Returning cached data');
    return cache.data;
  }

  console.log('[INFO] Cache expired or empty, fetching fresh data...');
  const accessToken = await getValidAccessToken();

  let data;
  try {
    data = await fetchHistory(accessToken);
  } catch (error) {
    if (error.message.startsWith('AUTH_FAILED:')) {
      console.log('[WARN] Access token rejected by Trakt, forcing refresh and retrying...');
      const freshToken = await forceTokenRefresh(accessToken);
      data = await fetchHistory(freshToken);
    } else {
      throw error;
    }
  }

  // Update cache
  cache = { data, timestamp: Date.now() };

  return data;
}
