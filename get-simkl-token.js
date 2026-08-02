import fetch from 'node-fetch';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const CLIENT_ID = process.env.SIMKL_CLIENT_ID;
const SIMKL_API_BASE = 'https://api.simkl.com';

if (!CLIENT_ID) {
  console.error('[ERROR] Missing SIMKL_CLIENT_ID in .env file');
  console.error('[ERROR] Create an app at https://simkl.com/settings/developer/new/');
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

console.log('='.repeat(70));
console.log('SIMKL ACCESS TOKEN GENERATOR');
console.log('='.repeat(70));

try {
  console.log('\n[INFO] Requesting a PIN from Simkl...');

  const pinResponse = await fetch(
    `${SIMKL_API_BASE}/oauth/pin?client_id=${encodeURIComponent(CLIENT_ID)}`
  );

  if (!pinResponse.ok) {
    console.error(`\n[ERROR] Failed to request PIN: ${pinResponse.status}`);
    console.error(await pinResponse.text());
    process.exit(1);
  }

  const pin = await pinResponse.json();

  if (pin.result !== 'OK' || !pin.user_code) {
    console.error('\n[ERROR] Unexpected PIN response:', JSON.stringify(pin));
    process.exit(1);
  }

  const verificationUrl = pin.verification_url || pin.verification_uri || 'https://simkl.com/pin';
  const intervalSeconds = pin.interval || 5;
  const expiresIn = pin.expires_in || 900;

  console.log('\n' + '='.repeat(70));
  console.log(`STEP 1: Open ${verificationUrl} in your browser`);
  console.log(`STEP 2: Enter this code:   ${pin.user_code}`);
  console.log('='.repeat(70));
  console.log(`\n[INFO] Waiting for authorization (expires in ${Math.floor(expiresIn / 60)} minutes)...`);

  const deadline = Date.now() + expiresIn * 1000;
  let accessToken = null;

  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);

    const pollResponse = await fetch(
      `${SIMKL_API_BASE}/oauth/pin/${encodeURIComponent(pin.user_code)}?client_id=${encodeURIComponent(CLIENT_ID)}`
    );

    if (!pollResponse.ok) {
      console.warn(`[WARN] Poll returned ${pollResponse.status}, retrying...`);
      continue;
    }

    const poll = await pollResponse.json();

    if (poll.access_token) {
      accessToken = poll.access_token;
      break;
    }

    // A device_code in the poll response means Simkl issued a fresh code
    // because we kept polling past authorization - stop rather than loop forever
    if (poll.device_code) {
      console.error('\n[ERROR] Simkl issued a new code. Re-run this script.');
      process.exit(1);
    }

    process.stdout.write('.');
  }

  if (!accessToken) {
    console.error('\n\n[ERROR] Timed out waiting for authorization. Re-run this script.');
    process.exit(1);
  }

  console.log('\n\n' + '='.repeat(70));
  console.log('SUCCESS! Your Simkl access token:');
  console.log('='.repeat(70));
  console.log('\n' + accessToken);
  console.log('\nThis token does not expire (Simkl advertises ~5 years) and there is');
  console.log('no refresh token to rotate. It stays valid until you revoke the app at');
  console.log('https://simkl.com/settings/connected-apps/');
  console.log('\n' + '='.repeat(70));
  console.log('NEXT STEP: Add this to your .env file and to Render:');
  console.log('SIMKL_ACCESS_TOKEN=' + accessToken);
  console.log('='.repeat(70));
} catch (error) {
  console.error('\n[ERROR]', error.message);
  process.exit(1);
}
