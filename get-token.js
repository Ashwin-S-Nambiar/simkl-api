import fetch from 'node-fetch';
import readline from 'readline';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('[ERROR] Missing TRAKT_CLIENT_ID or TRAKT_CLIENT_SECRET in .env file');
  process.exit(1);
}

const authUrl = `https://trakt.tv/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=urn:ietf:wg:oauth:2.0:oob`;

console.log('='.repeat(70));
console.log('TRAKT API TOKEN GENERATOR');
console.log('='.repeat(70));
console.log('\nSTEP 1: Visit this URL in your browser to authorize the app:');
console.log('\n' + authUrl);
console.log('\nSTEP 2: Click "Authorize" on the Trakt website');
console.log('STEP 3: Trakt will display a CODE on the page');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('\nSTEP 4: Enter the code here: ', async (code) => {
  try {
    console.log('\n[INFO] Exchanging code for tokens...');
    
    const response = await fetch('https://api.trakt.tv/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code.trim(),
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'authorization_code'
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('\n[ERROR] Failed to get tokens:', error);
      rl.close();
      return;
    }
    
    const data = await response.json();

    console.log('\n' + '='.repeat(70));
    console.log('SUCCESS! Your tokens:');
    console.log('='.repeat(70));
    console.log('\nAccess Token (expires in ~3 months):');
    console.log(data.access_token);
    console.log('\nRefresh Token (use this in your .env file):');
    console.log(data.refresh_token);
    console.log('\nExpires in:', data.expires_in, 'seconds');
    console.log('Created at:', new Date(data.created_at * 1000).toLocaleString());
    console.log('\n' + '='.repeat(70));

    // The running server reads the database first and only falls back to the
    // environment when no row exists, so a stale row would shadow this new token.
    // Write it here (imported dynamically, after dotenv has populated DATABASE_URL).
    if (process.env.DATABASE_URL) {
      const { saveToken, clearAccessToken, closeDatabase } = await import('./src/db.js');
      console.log('\n[INFO] DATABASE_URL found - writing token to the database...');
      await saveToken(data.refresh_token);
      await clearAccessToken();
      await closeDatabase();
      console.log('[INFO] Database updated. Restart the service and it will pick this up.');
    } else {
      console.log('\n[WARN] No DATABASE_URL set, so the database was NOT updated.');
      console.log('[WARN] If your deployment uses a database, the old token there will');
      console.log('[WARN] override the env var below. Set DATABASE_URL and re-run this.');
    }

    console.log('\nAlso update your .env / Render environment variable:');
    console.log('TRAKT_REFRESH_TOKEN=' + data.refresh_token);
    console.log('='.repeat(70));

  } catch (error) {
    console.error('\n[ERROR]', error.message);
  }
  rl.close();
});
