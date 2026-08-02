import pg from 'pg';
const { Pool } = pg;

let pool;

/**
 * Initialize PostgreSQL connection pool
 * Creates the tokens table if it doesn't exist
 */
function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log('[WARN] No DATABASE_URL found, tokens will not be persisted');
    console.log('[WARN] Using TRAKT_REFRESH_TOKEN from environment as fallback');
    return;
  }

  // Enable SSL for any non-local host so local scripts (get-token.js) can
  // reach a hosted database, not just the production deployment.
  const isLocalDatabase = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocalDatabase ? false : { rejectUnauthorized: false }
  });

  // Create table if not exists
  pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY DEFAULT 1,
      refresh_token TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT single_row CHECK (id = 1)
    )
  `)
    .then(() => {
      console.log('[INFO] Database connection established');
      console.log('[INFO] Tokens table ready');
    })
    .catch(err => {
      console.error('[ERROR] Database initialization failed:', err.message);
    });
}

// Initialize on module load
initializeDatabase();

/**
 * Get the refresh token from database or environment
 * @returns {Promise<string|null>} Refresh token or null
 */
export async function getToken() {
  if (!pool) {
    // Fallback to environment variable if no database
    return process.env.TRAKT_REFRESH_TOKEN || null;
  }

  try {
    const result = await pool.query(
      'SELECT refresh_token FROM tokens WHERE id = 1'
    );

    if (result.rows[0]?.refresh_token) {
      console.log('[INFO] Retrieved refresh token from database');
      return result.rows[0].refresh_token;
    }

    // If no token in DB, seed from the environment variable
    const envToken = process.env.TRAKT_REFRESH_TOKEN;
    if (envToken) {
      console.log('[INFO] No token in database, seeding from environment variable');
      await saveToken(envToken);
      return envToken;
    }

    console.log('[WARN] No refresh token found in database or environment');
    return null;
  } catch (error) {
    // Never fall back to TRAKT_REFRESH_TOKEN on a read failure. Refresh tokens
    // are single-use, so the env copy is almost always an already-rotated token;
    // spending it would invalidate the good token sitting in the database.
    console.error('[ERROR] Failed to retrieve token from database:', error.message);
    throw new Error(`Could not read refresh token from database: ${error.message}`);
  }
}

/**
 * Save a new refresh token to database
 * @param {string} newToken - New refresh token to save
 * @returns {Promise<void>}
 */
export async function saveToken(newToken) {
  if (!pool) {
    console.log('[WARN] No database connection, token not persisted');
    return;
  }

  // A failure here is unrecoverable: Trakt has already invalidated the previous
  // refresh token, so losing this one locks the app out until re-authentication.
  // Retry a few times, then surface the error instead of swallowing it.
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.query(`
        INSERT INTO tokens (id, refresh_token)
        VALUES (1, $1)
        ON CONFLICT (id)
        DO UPDATE SET
          refresh_token = $1,
          updated_at = CURRENT_TIMESTAMP
      `, [newToken]);

      console.log('[INFO] Refresh token saved to database');
      return;
    } catch (error) {
      lastError = error;
      console.error(`[ERROR] Failed to save token to database (attempt ${attempt}/3):`, error.message);
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  }

  console.error('[ERROR] Refresh token could not be persisted. Save it manually or re-run get-token.js:');
  console.error(`[ERROR] TRAKT_REFRESH_TOKEN=${newToken}`);
  throw new Error(`Failed to persist rotated refresh token: ${lastError.message}`);
}

/**
 * Remove the cached access token (used when seeding a brand new OAuth session)
 * @returns {Promise<void>}
 */
export async function clearAccessToken() {
  if (!pool) {
    return;
  }

  try {
    await pool.query('DELETE FROM access_tokens WHERE id = 1');
    console.log('[INFO] Cached access token cleared');
  } catch (error) {
    // The table may not exist yet on a fresh database; that is equivalent to cleared.
    console.log(`[INFO] No cached access token to clear (${error.message})`);
  }
}

/**
 * Run a callback while holding a database-wide advisory lock.
 * Serialises token refreshes across processes and Render instances, which an
 * in-memory lock cannot do. Falls through unlocked when there is no database.
 * @param {number} lockId - Arbitrary but stable lock identifier
 * @param {Function} fn - Callback to run under the lock
 */
export async function withAdvisoryLock(lockId, fn) {
  if (!pool) {
    return fn();
  }

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    return await fn();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    } catch (error) {
      console.error('[ERROR] Failed to release advisory lock:', error.message);
    }
    client.release();
  }
}

/**
 * Get the cached access token from database
 * @returns {Promise<{token: string, expiresAt: number}|null>} Access token info or null
 */
export async function getAccessToken() {
  if (!pool) {
    return null;
  }

  try {
    // First ensure the access_tokens table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS access_tokens (
        id INTEGER PRIMARY KEY DEFAULT 1,
        access_token TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT single_access_token CHECK (id = 1)
      )
    `);

    const result = await pool.query(
      'SELECT access_token, expires_at FROM access_tokens WHERE id = 1'
    );

    if (result.rows[0]?.access_token) {
      return {
        token: result.rows[0].access_token,
        expiresAt: parseInt(result.rows[0].expires_at, 10)
      };
    }

    return null;
  } catch (error) {
    console.error('[ERROR] Failed to retrieve access token from database:', error.message);
    return null;
  }
}

/**
 * Save a new access token to database
 * @param {string} accessToken - Access token to save
 * @param {number} expiresAt - Timestamp when the token expires
 * @returns {Promise<void>}
 */
export async function saveAccessToken(accessToken, expiresAt) {
  if (!pool) {
    console.log('[WARN] No database connection, access token not persisted');
    return;
  }

  try {
    await pool.query(`
      INSERT INTO access_tokens (id, access_token, expires_at) 
      VALUES (1, $1, $2) 
      ON CONFLICT (id) 
      DO UPDATE SET 
        access_token = $1, 
        expires_at = $2,
        updated_at = CURRENT_TIMESTAMP
    `, [accessToken, expiresAt]);

    console.log('[INFO] Access token saved to database');
  } catch (error) {
    console.error('[ERROR] Failed to save access token to database:', error.message);
  }
}

// Close database connection (for graceful shutdown)
export async function closeDatabase() {
  if (pool) {
    await pool.end();
    console.log('[INFO] Database connection closed');
  }
}
