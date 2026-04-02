const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// GHL OAuth Config
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID;
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

if (!GHL_CLIENT_ID || !GHL_CLIENT_SECRET) {
  console.error('ERROR: GHL_CLIENT_ID and GHL_CLIENT_SECRET env vars are required');
  process.exit(1);
}
const REDIRECT_URI = `${BASE_URL}/oauth/callback`;
const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_AUTH = 'https://marketplace.gohighlevel.com/oauth/chooselocation';

// Token storage (file-based for simplicity)
const TOKENS_FILE = path.join(__dirname, 'data', 'tokens.json');

function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveTokens(tokens) {
  ensureDataDir();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// Get valid access token for a location (refresh if needed)
async function getAccessToken(locationId) {
  const tokens = loadTokens();
  const loc = tokens[locationId];
  if (!loc) return null;

  // Check if token is expired (with 5 min buffer)
  const now = Date.now();
  if (loc.expires_at && now > loc.expires_at - 300000) {
    // Refresh token
    try {
      const res = await fetch(`${GHL_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GHL_CLIENT_ID,
          client_secret: GHL_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: loc.refresh_token
        })
      });
      const data = await res.json();
      if (data.access_token) {
        tokens[locationId] = {
          access_token: data.access_token,
          refresh_token: data.refresh_token || loc.refresh_token,
          expires_at: now + (data.expires_in || 86400) * 1000,
          locationId,
          companyId: loc.companyId
        };
        saveTokens(tokens);
        return data.access_token;
      }
    } catch (e) {
      console.error('Token refresh failed:', e.message);
    }
    return null;
  }

  return loc.access_token;
}

// Get access token for agency-level calls
async function getAnyAccessToken() {
  const tokens = loadTokens();
  const locationIds = Object.keys(tokens);
  if (locationIds.length === 0) return null;
  return getAccessToken(locationIds[0]);
}

app.use(express.static('public'));
app.use(express.json());

// ─── OAuth Flow ───

app.get('/oauth/start', (req, res) => {
  const scopes = [
    'locations.readonly',
    'opportunities.readonly',
    'opportunities/pipelines.readonly',
    'contacts.readonly'
  ].join(' ');

  const url = `${GHL_AUTH}?response_type=code&client_id=${GHL_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
  res.redirect(url);
});

app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code provided');

  try {
    const tokenRes = await fetch(`${GHL_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GHL_CLIENT_ID,
        client_secret: GHL_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });

    const data = await tokenRes.json();

    if (data.access_token) {
      const locationId = data.locationId;
      const tokens = loadTokens();
      tokens[locationId] = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in || 86400) * 1000,
        locationId,
        companyId: data.companyId
      };
      saveTokens(tokens);
      res.redirect('/?connected=1');
    } else {
      console.error('OAuth error:', data);
      res.status(400).send('OAuth failed: ' + JSON.stringify(data));
    }
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.status(500).send('OAuth error: ' + e.message);
  }
});

// ─── API Status ───

app.get('/api/status', (req, res) => {
  const tokens = loadTokens();
  const locations = Object.keys(tokens).map(id => ({
    locationId: id,
    connected: true
  }));
  res.json({ connected: locations.length > 0, locations });
});

// ─── GHL API Proxy ───

// List all connected locations with their details
app.get('/api/locations', async (req, res) => {
  const tokens = loadTokens();
  const locationIds = Object.keys(tokens);

  if (locationIds.length === 0) {
    return res.json({ locations: [] });
  }

  const locations = [];
  for (const locId of locationIds) {
    const token = await getAccessToken(locId);
    if (!token) continue;

    try {
      const r = await fetch(`${GHL_API}/locations/${locId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '2021-07-28',
          'Accept': 'application/json'
        }
      });
      const data = await r.json();
      if (data.location) {
        locations.push({
          id: data.location.id,
          name: data.location.name,
          address: data.location.address,
          timezone: data.location.timezone
        });
      }
    } catch (e) {
      console.error(`Error fetching location ${locId}:`, e.message);
    }
  }

  res.json({ locations });
});

// Get pipelines for a location
app.get('/api/locations/:locationId/pipelines', async (req, res) => {
  const { locationId } = req.params;
  const token = await getAccessToken(locationId);
  if (!token) return res.status(401).json({ error: 'Location not connected' });

  try {
    const r = await fetch(`${GHL_API}/opportunities/pipelines?locationId=${locationId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get opportunities for a pipeline
app.get('/api/locations/:locationId/pipelines/:pipelineId/opportunities', async (req, res) => {
  const { locationId, pipelineId } = req.params;
  const { startAfter, limit } = req.query;
  const token = await getAccessToken(locationId);
  if (!token) return res.status(401).json({ error: 'Location not connected' });

  try {
    let allOpportunities = [];
    let cursor = startAfter || '';
    let hasMore = true;
    const pageLimit = 100;

    // Paginate through all opportunities
    while (hasMore) {
      const params = new URLSearchParams({
        location_id: locationId,
        pipeline_id: pipelineId,
        limit: String(pageLimit)
      });
      if (cursor) params.set('startAfter', cursor);

      const r = await fetch(`${GHL_API}/opportunities/search?${params}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '2021-07-28',
          'Accept': 'application/json'
        }
      });
      const data = await r.json();
      const opps = data.opportunities || [];
      allOpportunities = allOpportunities.concat(opps);

      if (opps.length < pageLimit || allOpportunities.length >= 5000) {
        hasMore = false;
      } else {
        cursor = data.meta?.startAfter || '';
        if (!cursor) hasMore = false;
      }
    }

    res.json({ opportunities: allOpportunities, total: allOpportunities.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get contacts for a location
app.get('/api/locations/:locationId/contacts', async (req, res) => {
  const { locationId } = req.params;
  const { limit, startAfter } = req.query;
  const token = await getAccessToken(locationId);
  if (!token) return res.status(401).json({ error: 'Location not connected' });

  try {
    const params = new URLSearchParams({
      locationId,
      limit: limit || '100'
    });
    if (startAfter) params.set('startAfter', startAfter);

    const r = await fetch(`${GHL_API}/contacts/?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Aggregate: get all data for dashboard
app.get('/api/dashboard/:locationId', async (req, res) => {
  const { locationId } = req.params;
  const token = await getAccessToken(locationId);
  if (!token) return res.status(401).json({ error: 'Location not connected' });

  try {
    // Get pipelines
    const pipRes = await fetch(`${GHL_API}/opportunities/pipelines?locationId=${locationId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });
    const pipData = await pipRes.json();
    const pipelines = pipData.pipelines || [];

    // Get opportunities for each pipeline
    const pipelineData = [];
    for (const pip of pipelines) {
      let allOpps = [];
      let cursor = '';
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          location_id: locationId,
          pipeline_id: pip.id,
          limit: '100'
        });
        if (cursor) params.set('startAfter', cursor);

        const r = await fetch(`${GHL_API}/opportunities/search?${params}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Version': '2021-07-28',
            'Accept': 'application/json'
          }
        });
        const data = await r.json();
        const opps = data.opportunities || [];
        allOpps = allOpps.concat(opps);

        if (opps.length < 100 || allOpps.length >= 5000) {
          hasMore = false;
        } else {
          cursor = data.meta?.startAfter || '';
          if (!cursor) hasMore = false;
        }
      }

      pipelineData.push({
        pipeline: {
          id: pip.id,
          name: pip.name,
          stages: pip.stages || []
        },
        opportunities: allOpps
      });
    }

    res.json({ pipelines: pipelineData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Aggregate: all locations dashboard data
app.get('/api/dashboard', async (req, res) => {
  const tokens = loadTokens();
  const locationIds = Object.keys(tokens);

  if (locationIds.length === 0) {
    return res.json({ locations: [] });
  }

  const results = [];
  for (const locId of locationIds) {
    const token = await getAccessToken(locId);
    if (!token) continue;

    try {
      // Location info
      const locRes = await fetch(`${GHL_API}/locations/${locId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '2021-07-28',
          'Accept': 'application/json'
        }
      });
      const locData = await locRes.json();

      // Pipelines
      const pipRes = await fetch(`${GHL_API}/opportunities/pipelines?locationId=${locId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '2021-07-28',
          'Accept': 'application/json'
        }
      });
      const pipData = await pipRes.json();
      const pipelines = pipData.pipelines || [];

      const pipelineData = [];
      for (const pip of pipelines) {
        let allOpps = [];
        let cursor = '';
        let hasMore = true;

        while (hasMore) {
          const params = new URLSearchParams({
            location_id: locId,
            pipeline_id: pip.id,
            limit: '100'
          });
          if (cursor) params.set('startAfter', cursor);

          const r = await fetch(`${GHL_API}/opportunities/search?${params}`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Version': '2021-07-28',
              'Accept': 'application/json'
            }
          });
          const data = await r.json();
          const opps = data.opportunities || [];
          allOpps = allOpps.concat(opps);

          if (opps.length < 100 || allOpps.length >= 5000) {
            hasMore = false;
          } else {
            cursor = data.meta?.startAfter || '';
            if (!cursor) hasMore = false;
          }
        }

        pipelineData.push({
          pipeline: {
            id: pip.id,
            name: pip.name,
            stages: pip.stages || []
          },
          opportunities: allOpps
        });
      }

      results.push({
        location: {
          id: locData.location?.id || locId,
          name: locData.location?.name || locId
        },
        pipelines: pipelineData
      });
    } catch (e) {
      console.error(`Error fetching dashboard for ${locId}:`, e.message);
    }
  }

  res.json({ locations: results });
});

app.listen(PORT, () => {
  console.log(`CRM Dashboard running on port ${PORT}`);
  console.log(`OAuth redirect URI: ${REDIRECT_URI}`);
});
