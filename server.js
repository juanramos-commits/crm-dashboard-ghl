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

// Token storage — persistent volume or env var fallback
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadTokens() {
  // Try file first
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  // Fallback: env var GHL_TOKENS (JSON string)
  if (process.env.GHL_TOKENS) {
    try { return JSON.parse(process.env.GHL_TOKENS); } catch(e) {}
  }
  return {};
}

function saveTokens(tokens) {
  ensureDataDir();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  // Log tokens so they can be saved as env var if needed
  console.log('TOKENS_SAVED:', JSON.stringify(tokens));
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

// ─── Users cache ───
const usersCache = {};

app.get('/api/locations/:locationId/users', async (req, res) => {
  const { locationId } = req.params;
  const token = await getAccessToken(locationId);
  if (!token) return res.status(401).json({ error: 'Location not connected' });

  if (usersCache[locationId]) return res.json({ users: usersCache[locationId] });

  try {
    const r = await fetch(`${GHL_API}/users/search?companyId=${loadTokens()[locationId]?.companyId || ''}&locationId=${locationId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });
    const data = await r.json();
    const users = {};
    (data.users || []).forEach(u => {
      users[u.id] = u.name || u.firstName + ' ' + (u.lastName || '');
    });
    usersCache[locationId] = users;
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  const token = await getAccessToken(locationId);
  if (!token) return res.status(401).json({ error: 'Location not connected' });

  try {
    const allOpportunities = await fetchAllOpportunities(token, locationId, pipelineId);

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
      const allOpps = await fetchAllOpportunities(token, locationId, pip.id);
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

// Helper: fetch all opportunities for a pipeline with pagination
async function fetchAllOpportunities(token, locId, pipelineId, dateFrom, dateTo) {
  const seen = new Set();
  let allOpps = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      location_id: locId,
      pipeline_id: pipelineId,
      limit: '100',
      page: String(page)
    });
    if (dateFrom) params.set('date', dateFrom);
    if (dateTo) params.set('endDate', dateTo);

    const r = await fetch(`${GHL_API}/opportunities/search?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });
    const data = await r.json();
    const opps = data.opportunities || [];
    const total = data.meta?.total || 0;

    // Deduplicate
    let newCount = 0;
    for (const opp of opps) {
      if (!seen.has(opp.id)) {
        seen.add(opp.id);
        allOpps.push(opp);
        newCount++;
      }
    }

    console.log(`Pipeline ${pipelineId} page ${page}: got ${opps.length}, new ${newCount}, total unique ${allOpps.length}/${total}`);

    if (opps.length < 100 || newCount === 0 || !data.meta?.nextPage) {
      hasMore = false;
    } else {
      page = data.meta.nextPage;
      // Safety: max 200 pages
      if (page > 200) hasMore = false;
    }
  }

  console.log(`Pipeline ${pipelineId} DONE: ${allOpps.length} unique opportunities`);
  return allOpps;
}

// Debug: check pagination meta
app.get('/api/debug/pagination/:locationId/:pipelineId', async (req, res) => {
  const { locationId, pipelineId } = req.params;
  const token = await getAccessToken(locationId);
  if (!token) return res.status(401).json({ error: 'No token' });

  const params = new URLSearchParams({
    location_id: locationId,
    pipeline_id: pipelineId,
    limit: '5'
  });

  const r = await fetch(`${GHL_API}/opportunities/search?${params}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Version': '2021-07-28',
      'Accept': 'application/json'
    }
  });
  const data = await r.json();
  const opps = data.opportunities || [];

  // Page 2 with page param
  let page2 = null;
  {
    const params2 = new URLSearchParams({
      location_id: locationId,
      pipeline_id: pipelineId,
      limit: '5',
      page: '2'
    });
    const r2 = await fetch(`${GHL_API}/opportunities/search?${params2}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });
    const d2 = await r2.json();
    page2 = {
      method: 'page=2',
      count: (d2.opportunities || []).length,
      meta: d2.meta,
      firstId: d2.opportunities?.[0]?.id,
      lastId: d2.opportunities?.[d2.opportunities?.length - 1]?.id
    };
  }

  // Page 2 with startAfter (timestamp) + startAfterId
  let page3 = null;
  const meta1 = data.meta || {};
  if (meta1.startAfter && meta1.startAfterId) {
    const params3 = new URLSearchParams({
      location_id: locationId,
      pipeline_id: pipelineId,
      limit: '5',
      startAfter: String(meta1.startAfter),
      startAfterId: meta1.startAfterId
    });
    const r3 = await fetch(`${GHL_API}/opportunities/search?${params3}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });
    const d3 = await r3.json();
    page3 = {
      method: 'startAfter+startAfterId from meta',
      count: (d3.opportunities || []).length,
      meta: d3.meta,
      firstId: d3.opportunities?.[0]?.id,
      lastId: d3.opportunities?.[d3.opportunities?.length - 1]?.id
    };
  }

  res.json({
    page1: {
      count: opps.length,
      meta: data.meta,
      firstId: opps[0]?.id,
      lastId: opps[opps.length - 1]?.id
    },
    page2_with_page_param: page2,
    page2_with_startAfter: page3
  });
});

// Aggregate: all locations dashboard data
app.get('/api/dashboard', async (req, res) => {
  const { dateFrom, dateTo } = req.query;
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
        const allOpps = await fetchAllOpportunities(token, locId, pip.id, dateFrom, dateTo);

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
