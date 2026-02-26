const express = require('express');
const router = express.Router();
const hubspotService = require('../services/hubspot');

/**
 * GET /hubspot/crm-card
 * HubSpot CRM Card data fetch endpoint.
 * HubSpot passes: associatedObjectId, associatedObjectType, portalId, userId, userEmail
 */
router.get('/crm-card', async (req, res) => {
  const { associatedObjectId, portalId } = req.query;

  // Basic signature validation can be added here for production
  // See: https://developers.hubspot.com/docs/api/crm/extensions/cards

  try {
    let company = null;
    if (associatedObjectId) {
      company = await hubspotService.getCompany(associatedObjectId);
    }

    const phone = company?.properties?.phone || '';
    const companyName = company?.properties?.name || 'Unknown Company';

    res.json({
      results: [
        {
          objectId: associatedObjectId,
          title: companyName,
          properties: [
            {
              label: 'Phone',
              dataType: 'STRING',
              value: phone || 'Not set',
            },
            {
              label: 'Last Phone Tree Mapping',
              dataType: 'STRING',
              value: company?.properties?.last_phone_tree_mapping || 'Never',
            },
          ],
          actions: [
            {
              type: 'IFRAME',
              width: 890,
              height: 600,
              uri: `${process.env.BASE_URL}/hubspot/launch?companyId=${associatedObjectId}&phone=${encodeURIComponent(phone)}&companyName=${encodeURIComponent(companyName)}`,
              label: '📞 Map Phone Tree',
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('[CRM Card] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /hubspot/launch
 * iFrame page opened when the CRM Card button is clicked.
 * Initiates the call and redirects to the live dashboard.
 */
router.get('/launch', async (req, res) => {
  const { companyId, phone, companyName } = req.query;

  if (!companyId || !phone) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;padding:2rem">
        <h2>⚠️ Missing Data</h2>
        <p>Company ID or phone number not found. Please ensure the company record has a phone number.</p>
      </body></html>
    `);
  }

  try {
    // Initiate the call via internal API
    const axios = require('axios');
    const response = await axios.post(`${process.env.BASE_URL}/twilio/call`, {
      toNumber: phone,
      companyId,
      companyName,
    });

    const { callSid, dashboardUrl } = response.data;

    // Redirect iFrame to live dashboard
    res.redirect(dashboardUrl);
  } catch (err) {
    console.error('[Launch] Error:', err.message);
    res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:2rem">
        <h2>❌ Call Failed</h2>
        <p>${err.response?.data?.error || err.message}</p>
      </body></html>
    `);
  }
});

module.exports = router;
