const express = require('express');
const router = express.Router();

// GET /hubspot/crm-card — serves data to the HubSpot CRM sidebar card
router.get('/crm-card', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.json({ results: [] });

  res.json({
    results: [
      {
        objectId: 1,
        title: 'Phone Tree Scout',
        properties: [
          { label: 'Status', dataType: 'STRING', value: 'Ready' }
        ]
      }
    ]
  });
});

// OAuth callback — exchanges code for token to complete app install
router.get('/oauth-callback', async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.send('<h1>Error</h1><p>No authorization code received.</p>');
  }

  try {
    const response = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.HUBSPOT_APP_CLIENT_ID,
        client_secret: process.env.HUBSPOT_APP_CLIENT_SECRET,
        redirect_uri: 'https://phone-tree-scout.onrender.com/hubspot/oauth-callback',
        code: code,
      }).toString(),
    });

    const data = await response.json();

    if (data.access_token) {
      console.log('[OAuth] App installed successfully. Token received.');
      res.send('<h1>Phone Tree Scout installed successfully!</h1><p>You can close this tab and return to HubSpot.</p>');
    } else {
      console.error('[OAuth] Token exchange failed:', data);
      res.send('<h1>Installation Error</h1><p>' + (data.message || 'Token exchange failed.') + '</p>');
    }
  } catch (err) {
    console.error('[OAuth] Error:', err.message);
    res.send('<h1>Installation Error</h1><p>' + err.message + '</p>');
  }
});

module.exports = router;