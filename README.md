# Trakt API Server

Express.js API server for fetching Trakt.tv watch history data. Designed to be deployed on Render with PostgreSQL for persistent token storage.

## Features

- RESTful API for Trakt.tv integration
- Automatic OAuth token refresh
- PostgreSQL token persistence
- 5-minute response caching
- CORS support for frontend integration
- Professional logging (no emojis)

## Prerequisites

- Node.js 18+ 
- PostgreSQL database (provided by Render)
- Trakt.tv API credentials

## Getting Trakt API Credentials

1. Go to https://trakt.tv/oauth/applications
2. Create a new application
3. Set redirect URI to `urn:ietf:wg:oauth:2.0:oob` (for manual token generation)
4. Copy your **Client ID** and **Client Secret**

## Getting Your Initial Refresh Token

You need to get a refresh token once. Use this Node.js script:

```javascript
// get-token.js
import fetch from 'node-fetch';
import readline from 'readline';

const CLIENT_ID = 'YOUR_CLIENT_ID';
const CLIENT_SECRET = 'YOUR_CLIENT_SECRET';

const authUrl = `https://trakt.tv/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=urn:ietf:wg:oauth:2.0:oob`;

console.log('Visit this URL and authorize:\n', authUrl);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('\nEnter the code: ', async (code) => {
  const response = await fetch('https://api.trakt.tv/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'authorization_code'
    })
  });
  
  const data = await response.json();
  console.log('\nYour refresh token:', data.refresh_token);
  rl.close();
});
```

Run it:
```bash
node get-token.js
```

## Local Development

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd trakt-api
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and add your credentials:
   ```env
   TRAKT_CLIENT_ID=your_client_id
   TRAKT_CLIENT_SECRET=your_client_secret
   TRAKT_REFRESH_TOKEN=your_refresh_token
   DATABASE_URL=postgresql://localhost:5432/trakt_db
   FRONTEND_URL=http://localhost:3000
   ```

4. **Set up local PostgreSQL (optional)**
   
   If you want to test with PostgreSQL locally:
   ```bash
   # Install PostgreSQL, then:
   createdb trakt_db
   ```
   
   Or skip this and the app will use environment variables as fallback.

5. **Run the server**
   ```bash
   npm run dev
   ```
   
   Server will start at http://localhost:3001

## API Endpoints

### `GET /health`
Health check endpoint

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-10-27T12:00:00.000Z"
}
```

### `GET /api/trakt/last`
Get last watched movie or TV episode

**Response (Movie):**
```json
{
  "ok": true,
  "data": {
    "type": "movie",
    "title": "Inception",
    "year": 2010,
    "trakt_url": "https://trakt.tv/movies/inception-2010",
    "watched_at": "2025-10-27T10:30:00.000Z"
  }
}
```

**Response (TV Episode):**
```json
{
  "ok": true,
  "data": {
    "type": "episode",
    "title": "The One Where...",
    "show_title": "Friends",
    "season": 1,
    "episode": 5,
    "year": 1994,
    "trakt_url": "https://trakt.tv/shows/friends/seasons/1/episodes/5",
    "watched_at": "2025-10-27T10:30:00.000Z"
  }
}
```

**Error Response:**
```json
{
  "ok": false,
  "error": "Error message"
}
```

## Project Structure

```
trakt-api/
├── src/
│   ├── index.js     # Express server setup
│   ├── trakt.js     # Trakt API logic & caching
│   └── db.js        # PostgreSQL connection & token storage
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## How It Works

1. **Token Management**: Refresh tokens are stored in PostgreSQL and automatically refreshed when needed
2. **Caching**: API responses are cached for 5 minutes to reduce Trakt API calls
3. **Fallback**: If no database is available, uses `TRAKT_REFRESH_TOKEN` from environment

## Deployment

See [RENDER_DEPLOYMENT.md](./RENDER_DEPLOYMENT.md) for detailed deployment instructions to Render.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TRAKT_CLIENT_ID` | Trakt API Client ID | Yes |
| `TRAKT_CLIENT_SECRET` | Trakt API Client Secret | Yes |
| `TRAKT_REFRESH_TOKEN` | Initial refresh token | Yes* |
| `DATABASE_URL` | PostgreSQL connection string | No** |
| `FRONTEND_URL` | Frontend URL for CORS | No |
| `PORT` | Server port (default: 3001) | No |
| `NODE_ENV` | Environment (development/production) | No |

*Required initially, will be stored in database after first use  
**If not provided, tokens won't be persisted across restarts

## License

ISC
