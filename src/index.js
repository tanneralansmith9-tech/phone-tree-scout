require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const twilioRoutes = require('./routes/twilio');
const hubspotRoutes = require('./routes/hubspot');
const callStore = require('./callStore');

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
server.listen(PORT, () => {
  console.log(`\n🚀 Phone Tree Scout running on port ${PORT}`);
  console.log(`   Dashboard: ${process.env.BASE_URL}/dashboard`);
  console.log(`   HubSpot CRM Card URL: ${process.env.BASE_URL}/hubspot/crm-card\n`);
});
