# Deploying Trakt API to Render

This guide walks you through deploying your Trakt API to Render with PostgreSQL.

## Prerequisites

- GitHub account
- Render account (free) - https://render.com
- Trakt API credentials (Client ID, Client Secret, Refresh Token)

## Step 1: Prepare Your Repository

1. **Initialize Git repository** (if not already done)
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```

2. **Create GitHub repository**
   - Go to https://github.com/new
   - Create a new repository (e.g., `trakt-api`)
   - Don't initialize with README (you already have one)

3. **Push to GitHub**
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/trakt-api.git
   git branch -M main
   git push -u origin main
   ```

## Step 2: Create PostgreSQL Database on Render

1. **Sign in to Render**
   - Go to https://dashboard.render.com

2. **Create PostgreSQL Database**
   - Click **"New +"** button
   - Select **"PostgreSQL"**
   - Configure:
     - **Name**: `trakt-db` (or any name you prefer)
     - **Database**: `trakt_db`
     - **User**: (auto-generated)
     - **Region**: Choose closest to your users
     - **PostgreSQL Version**: 16 (or latest)
     - **Plan**: **Free** (256 MB RAM, 1 GB storage)
   
3. **Create Database**
   - Click **"Create Database"**
   - Wait for provisioning (takes 1-2 minutes)

4. **Copy Database Connection String**
   - Once created, scroll down to **"Connections"**
   - Copy the **"Internal Database URL"** (starts with `postgresql://`)
   - Format: `postgresql://user:password@dpg-xxx-a.oregon-postgres.render.com/dbname`
   - **Important**: Use "Internal Database URL" for better performance

## Step 3: Deploy Web Service

1. **Create Web Service**
   - In Render dashboard, click **"New +"**
   - Select **"Web Service"**

2. **Connect GitHub Repository**
   - Click **"Connect account"** if not already connected
   - Find and select your `trakt-api` repository
   - Click **"Connect"**

3. **Configure Web Service**
   
   **Basic Settings:**
   - **Name**: `trakt-api` (this will be part of your URL)
   - **Region**: Same as your database
   - **Branch**: `main`
   - **Root Directory**: (leave empty)
   - **Runtime**: `Node`
   
   **Build & Deploy:**
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   
   **Instance Type:**
   - **Plan**: **Free** (512 MB RAM, 0.1 CPU)

4. **Add Environment Variables**
   
   Scroll down to **"Environment Variables"** and click **"Add Environment Variable"**:
   
   | Key | Value | Notes |
   |-----|-------|-------|
   | `NODE_ENV` | `production` | |
   | `TRAKT_CLIENT_ID` | `your_client_id` | From Trakt.tv |
   | `TRAKT_CLIENT_SECRET` | `your_client_secret` | From Trakt.tv |
   | `TRAKT_REFRESH_TOKEN` | `your_refresh_token` | From token script |
   | `DATABASE_URL` | `postgresql://...` | Internal URL from Step 2 |
   | `FRONTEND_URL` | `https://ashwin.co.in` | Your frontend domain |
   
   **Important**: Use the **Internal Database URL** from Step 2 for `DATABASE_URL`

5. **Advanced Settings** (Optional)
   - **Auto-Deploy**: `Yes` (deploys automatically on git push)
   - **Health Check Path**: `/health`

6. **Create Web Service**
   - Click **"Create Web Service"**
   - Render will start building and deploying

## Step 4: Verify Deployment

1. **Wait for Deployment**
   - First deploy takes 2-3 minutes
   - Watch the logs for any errors
   - Look for: `[INFO] Trakt API server running on port 3001`

2. **Test Health Endpoint**
   - Your service URL: `https://trakt-api.onrender.com` (or similar)
   - Visit: `https://trakt-api.onrender.com/health`
   - Should return: `{"status":"ok","timestamp":"..."}`

3. **Test Trakt Endpoint**
   - Visit: `https://trakt-api.onrender.com/api/trakt/last`
   - Should return your last watched item

4. **Check Logs**
   - In Render dashboard, click on your service
   - Go to **"Logs"** tab
   - Verify you see:
     ```
     [INFO] Initializing Trakt API...
     [INFO] Trakt API credentials verified
     [INFO] Database connection established
     [INFO] Tokens table ready
     [INFO] Trakt API server running on port 3001
     ```

## Step 5: Verify Database Token Storage

1. **Check Database**
   - In Render dashboard, go to your PostgreSQL database
   - Click **"Shell"** tab
   - Run: `SELECT * FROM tokens;`
   - You should see your refresh token stored

2. **Test Token Refresh**
   - Make a request to `/api/trakt/last`
   - Check logs for: `[INFO] New refresh token received, updating database...`
   - This confirms token rotation is working

## Step 6: Update Your Frontend

Update your frontend to use the new API:

```typescript
// In your Next.js portfolio (last-watched.tsx or similar)
useEffect(() => {
  fetch('https://trakt-api.onrender.com/api/trakt/last')
    .then(r => r.json())
    .then(json => {
      if (json.ok && json.data) {
        setItem(json.data);
      }
    })
    .catch(console.error)
    .finally(() => setLoading(false));
}, []);
```

## Understanding Render Free Tier Limitations

### Spin-Down (Cold Starts)
- Free services spin down after **15 minutes of inactivity**
- First request after spin-down takes **30-60 seconds**
- Subsequent requests are fast

### Solutions for Cold Starts

**Option 1: Keep-Alive Ping** (Recommended)
Add to your frontend:
```typescript
// Ping every 10 minutes to keep service alive
useEffect(() => {
  const interval = setInterval(() => {
    fetch('https://trakt-api.onrender.com/health');
  }, 600000); // 10 minutes
  
  return () => clearInterval(interval);
}, []);
```

**Option 2: External Monitoring**
- Use UptimeRobot (free): https://uptimerobot.com
- Set up HTTP monitor for `/health`
- Ping every 5 minutes (free tier allows this)

**Option 3: Upgrade to Paid**
- $7/month for always-on instance
- No cold starts
- Better performance

## Troubleshooting

### "Missing TRAKT_CLIENT_ID or TRAKT_CLIENT_SECRET"
- Check environment variables in Render dashboard
- Make sure they're set correctly (no quotes, no extra spaces)

### "No refresh token found in database or environment"
- Verify `TRAKT_REFRESH_TOKEN` is set
- Check database connection
- Look for database errors in logs

### "Token refresh failed: 401"
- Your refresh token is invalid or expired
- Generate a new one using the script in README.md
- Update `TRAKT_REFRESH_TOKEN` in Render

### "Database connection failed"
- Verify `DATABASE_URL` is the **Internal Database URL**
- Check database is running in same region
- Ensure database firewall isn't blocking connections

### Service won't start
- Check **Logs** tab in Render
- Verify `npm start` script in package.json
- Ensure all dependencies are in `dependencies`, not `devDependencies`

## Custom Domain (Optional)

1. In Render dashboard, go to your web service
2. Click **"Settings"** tab
3. Scroll to **"Custom Domain"**
4. Add your domain (e.g., `api.ashwin.co.in`)
5. Add CNAME record in your DNS:
   ```
   Type: CNAME
   Name: api
   Value: trakt-api.onrender.com
   ```
6. Wait for DNS propagation (5-30 minutes)

## Monitoring & Maintenance

### View Logs
```
Render Dashboard → Your Service → Logs tab
```

### Restart Service
```
Render Dashboard → Your Service → Manual Deploy → "Deploy latest commit"
```

### Update Environment Variables
```
Render Dashboard → Your Service → Environment → Edit → Save Changes
```
Service will automatically redeploy.

### Monitor Database
```
Render Dashboard → Your Database → Metrics
```
Check disk usage, connections, query performance.

## Cost Summary

| Resource | Free Tier | Limits |
|----------|-----------|--------|
| Web Service | 750 hours/month | Spins down after 15 min |
| PostgreSQL | 1 GB storage | 256 MB RAM |
| Bandwidth | 100 GB/month | Shared across services |
| Build Minutes | 500 minutes/month | Usually sufficient |

**Total Cost**: $0/month (within free tier limits)

## Need Help?

- Render Status: https://status.render.com
- Render Community: https://community.render.com
- Render Docs: https://render.com/docs

## Next Steps

1. Set up monitoring (UptimeRobot or similar)
2. Configure custom domain if desired
3. Monitor logs for first few days
4. Test token refresh by waiting 24+ hours
5. Verify database persistence after service restarts

Your Trakt API is now live and ready to use!
