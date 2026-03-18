require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
 
let twilioRoutes, hubspotRoutes, callStore;
 
try {
  callStore = require('./callStore');
  console.log('[Boot] callStore loaded:', typeof callStore);
} catch (e) { console.error('[Boot] callStore FAILED:', e.message); }
 
try {
  hubspotRoutes = require('./routes/hubspot');
  console.log('[Boot] hubspotRoutes loaded:', typeof hubspotRoutes);
} catch (e) { console.error('[Boot] hubspotRoutes FAILED:', e.message); }
 
try {
  twilioRoutes = require('./routes/twilio');
  console.log('[Boot] twilioRoutes loaded:', typeof twilioRoutes);
} catch (e) { console.error('[Boot] twilioRoutes FAILED:', e.message); }
 
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
if (typeof twilioRoutes === 'function') {
  app.use('/twilio', twilioRoutes);
} else {
  console.error('[Boot] WARNING: twilioRoutes is not a function, skipping');
}

if (typeof hubspotRoutes === 'function') {
  app.use('/hubspot', hubspotRoutes);
} else {
  console.error('[Boot] WARNING: hubspotRoutes is not a function, skipping');
}
 
// Dashboard page (served for /dashboard?callSid=xxx)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});
 
// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));
 
// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Phone Tree Scout running on port ${PORT}`);
  console.log(`   Dashboard: ${process.env.BASE_URL}/dashboard`);
  console.log(`   HubSpot CRM Card URL: ${process.env.BASE_URL}/hubspot/crm-card\n`);
});