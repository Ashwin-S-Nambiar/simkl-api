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

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' 
      ? { rejectUnauthorized: false } 
      : false
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
    
    // If no token in DB, try environment variable
    const envToken = process.env.TRAKT_REFRESH_TOKEN;
    if (envToken) {
      console.log('[INFO] No token in database, using environment variable');
      // Save to database for future use
      await saveToken(envToken);
      return envToken;
    }
    
    console.log('[WARN] No refresh token found in database or environment');
    return null;
  } catch (error) {
    console.error('[ERROR] Failed to retrieve token from database:', error.message);
    // Fallback to environment
    return process.env.TRAKT_REFRESH_TOKEN || null;
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
  } catch (error) {
    console.error('[ERROR] Failed to save token to database:', error.message);
  }
}

// Close database connection (for graceful shutdown)
export async function closeDatabase() {
  if (pool) {
    await pool.end();
    console.log('[INFO] Database connection closed');
  }
}
