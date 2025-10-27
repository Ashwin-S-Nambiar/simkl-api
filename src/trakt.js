import fetch from 'node-fetch';
import { getToken, saveToken } from './db.js';

const CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;
const TRAKT_API_BASE = 'https://api.trakt.tv';

// In-memory cache with 5 minute TTL
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 300000; // 5 minutes in milliseconds

/**
 * Initialize and verify Trakt API credentials
 */
export async function initialize() {
  console.log('[INFO] Initializing Trakt API...');
  
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing TRAKT_CLIENT_ID or TRAKT_CLIENT_SECRET');
  }
  
  console.log('[INFO] Trakt API credentials verified');
}

/**
 * Refresh the Trakt access token using the stored refresh token
 * @returns {Promise<string>} New access token
 */
async function refreshAccessToken() {
  const refreshToken = await getToken();
  
  if (!refreshToken) {
    throw new Error('No refresh token found in database or environment');
  }

  console.log('[INFO] Refreshing access token...');
  
  const response = await fetch(`${TRAKT_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  
  // Save new refresh token if it was rotated
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.log('[INFO] New refresh token received, updating database...');
    await saveToken(data.refresh_token);
  }

  console.log('[INFO] Access token refreshed successfully');
  return data.access_token;
}

/**
 * Fetch watch history from Trakt API
 * @param {string} accessToken - Valid access token
 * @returns {Promise<Object|null>} Last watched item or null
 */
async function fetchHistory(accessToken) {
  const headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': CLIENT_ID,
    'Authorization': `Bearer ${accessToken}`
  };

  console.log('[INFO] Fetching watch history from Trakt...');

  const [moviesRes, episodesRes] = await Promise.all([
    fetch(`${TRAKT_API_BASE}/sync/history/movies?limit=1`, { headers }),
    fetch(`${TRAKT_API_BASE}/sync/history/episodes?limit=1`, { headers })
  ]);

  if (!moviesRes.ok && !episodesRes.ok) {
    throw new Error('Failed to fetch history from Trakt API');
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
    
    return {
      type: 'movie',
      title: movie.title,
      year: movie.year,
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
    
    return {
      type: 'episode',
      title,
      show_title: show.title,
      season: ep.season,
      episode: ep.number,
      year: show.year,
      trakt_url: url,
      watched_at: latest.watched_at
    };
  }
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
  const accessToken = await refreshAccessToken();
  const data = await fetchHistory(accessToken);
  
  // Update cache
  cache = { data, timestamp: Date.now() };
  
  return data;
}
