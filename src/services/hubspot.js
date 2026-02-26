const axios = require('axios');

const BASE = 'https://api.hubapi.com';

const headers = () => ({
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
});

/**
 * Fetch a company record by ID.
 */
async function getCompany(companyId) {
  const url = `${BASE}/crm/v3/objects/companies/${companyId}?properties=name,phone,last_phone_tree_mapping`;
  const res = await axios.get(url, { headers: headers() });
  return res.data;
}

/**
 * Create a Note engagement on a Company record
 * and update the last_phone_tree_mapping custom property.
 */
async function logCallNote({ companyId, companyName, toNumber, transcriptText, duration, callSid }) {
  const timestamp = new Date().toISOString();
  const durationStr = duration ? `Duration: ${duration}s` : '';

  const noteBody = [
    `📞 Phone Tree Mapping Call`,
    `Company: ${companyName}`,
    `Number Dialed: ${toNumber}`,
    `Call SID: ${callSid}`,
    durationStr,
    ``,
    `── TRANSCRIPT ──`,
    transcriptText || '(no transcript captured)',
  ]
    .filter(Boolean)
    .join('\n');

  // 1. Create the Note engagement
  const engagementPayload = {
    properties: {
      hs_note_body: noteBody,
      hs_timestamp: Date.now().toString(),
    },
    associations: [
      {
        to: { id: companyId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: 190, // Note → Company
          },
        ],
      },
    ],
  };

  const noteRes = await axios.post(
    `${BASE}/crm/v3/objects/notes`,
    engagementPayload,
    { headers: headers() }
  );

  console.log(`[HubSpot] Note created: ${noteRes.data.id}`);

  // 2. Update the custom property on the company
  try {
    await axios.patch(
      `${BASE}/crm/v3/objects/companies/${companyId}`,
      {
        properties: {
          last_phone_tree_mapping: timestamp,
        },
      },
      { headers: headers() }
    );
    console.log(`[HubSpot] Company ${companyId} property updated`);
  } catch (propErr) {
    // Property may not exist yet — that's okay, log and continue
    console.warn(`[HubSpot] Could not update last_phone_tree_mapping property: ${propErr.message}`);
    console.warn(`  → Create this property in HubSpot: Company > Custom Properties > last_phone_tree_mapping (DateTime or Single-line text)`);
  }

  return noteRes.data;
}

module.exports = { getCompany, logCallNote };
