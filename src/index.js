require('dotenv').config();
const freeRoutes = require('./routes/free');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
 
const callStore = require('./callStore');
const hubspotRoutes = require('./routes/hubspot');
const twilioRoutes = require('./routes/twilio');

const app = express();
const server = http.createServer(app);
// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });
 
wss.on('connection', (ws, req) => {
  const urlParams = new URL(req.url, `http://localhost`);
  const callSid = urlParams.searchParams.get('callSid');
  console.log(`[WS] Client connected for callSid: ${callSid}`);
 
  if (callSid) {
    callStore.addClient(callSid, ws);
  }
 
  ws.on('close', () => {
    if (callSid) callStore.removeClient(callSid, ws);
    console.log(`[WS] Client disconnected: ${callSid}`);
  });
});
 
// Make wss available to routes
app.set('wss', wss);
 
// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));
 
// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/twilio', twilioRoutes);
app.use('/hubspot', hubspotRoutes);
 
// Dashboard page (served for /dashboard?callSid=xxx)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});
 
// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));
 
// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
// ── Auto-Map Cron Job ─────────────────────────────────────────────────────────
async function checkNewCompanies() {
  console.log('[Cron] Checking for new companies to map...');

  try {
    const axios = require('axios');

    // Get companies created in the last hour that have a phone number
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const searchRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/companies/search',
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'createdate',
                operator: 'GTE',
                value: oneHourAgo,
              },
              {
                propertyName: 'phone',
                operator: 'HAS_PROPERTY',
              },
              {
                propertyName: 'last_phone_tree_mapping',
                operator: 'NOT_HAS_PROPERTY',
              },
            ],
          },
        ],
        properties: ['name', 'phone', 'timezone'],
        limit: 50,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const companies = searchRes.data.results;
    console.log(`[Cron] Found ${companies.length} new companies to map`);

    for (const company of companies) {
      const companyId = company.id;
      const companyName = company.properties.name || 'Unknown';
      const phone = company.properties.phone;
      const timezone = company.properties.timezone || 'America/New_York';

      // Dynamically require to avoid circular deps
      const { isBusinessHours, addToRetryQueue } = require('./routes/twilio');

      if (!isBusinessHours(timezone)) {
        addToRetryQueue(companyId, companyName, phone, 'outside_hours');
        console.log(`[Cron] Outside hours for ${companyName} — queued`);
        continue;
      }

      // Fire the call via the auto-map endpoint internally
      await axios.post(
        `${process.env.BASE_URL}/twilio/auto-map`,
        { companyId },
        { headers: { 'Content-Type': 'application/json' } }
      );

      console.log(`[Cron] Triggered auto-map for ${companyName}`);

      // Small delay between companies to not hammer Twilio
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

  } catch (err) {
    console.error('[Cron] Error checking new companies:', err.message);
  }
}

// Run every hour
setInterval(checkNewCompanies, 60 * 60 * 1000);
// ── 90-Day Re-Map Cron Job ────────────────────────────────────────────────────
async function checkStaleCompanies() {
  console.log('[Cron] Checking for companies needing re-map...');

  try {
    const axios = require('axios');

    // 90 days ago in milliseconds
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const searchRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/companies/search',
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'phone',
                operator: 'HAS_PROPERTY',
              },
              {
                propertyName: 'last_phone_tree_mapping',
                operator: 'LT',
                value: ninetyDaysAgo,
              },
            ],
          },
        ],
        properties: ['name', 'phone', 'timezone'],
        limit: 50,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const companies = searchRes.data.results;
    console.log(`[Cron] Found ${companies.length} stale companies to re-map`);

    for (const company of companies) {
      const companyId = company.id;
      const companyName = company.properties.name || 'Unknown';
      const phone = company.properties.phone;
      const timezone = company.properties.timezone || 'America/New_York';

      const { isBusinessHours, addToRetryQueue } = require('./routes/twilio');

      if (!isBusinessHours(timezone)) {
        addToRetryQueue(companyId, companyName, phone, 'outside_hours');
        console.log(`[Cron] Outside hours for ${companyName} — queued`);
        continue;
      }

      await axios.post(
        `${process.env.BASE_URL}/twilio/auto-map`,
        { companyId },
        { headers: { 'Content-Type': 'application/json' } }
      );

      console.log(`[Cron] Triggered re-map for ${companyName}`);

      await new Promise(resolve => setTimeout(resolve, 3000));
    }

  } catch (err) {
    console.error('[Cron] Error checking stale companies:', err.message);
  }
}

// Run once a day
setInterval(checkStaleCompanies, 24 * 60 * 60 * 1000);
server.listen(PORT, () => {
  console.log(`\n🚀 Phone Tree Scout running on port ${PORT}`);
  console.log(`   Dashboard: ${process.env.BASE_URL}/dashboard`);
  console.log(`   HubSpot CRM Card URL: ${process.env.BASE_URL}/hubspot/crm-card\n`);
});