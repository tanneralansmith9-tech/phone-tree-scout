const express = require('express');
const router = express.Router();

// GET /hubspot/crm-card — serves data to the HubSpot CRM sidebar card
router.get('/crm-card', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.json({ results: [] });

  // Placeholder — return empty card for now
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
// OAuth callback — just shows success message
router.get('/oauth-callback', (req, res) => {
    res.send('<h1>Phone Tree Scout installed successfully!</h1><p>You can close this tab and return to HubSpot.</p>');
  });
module.exports = router;
