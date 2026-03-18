/**
 * services/hubspot.js
 * HubSpot API interactions for Phone Tree Scout.
 * Includes duplicate note detection — never floods the CRM.
 */

const axios = require('axios');

const BASE = 'https://api.hubapi.com';

// How many days before a note is considered stale and can be replaced
const NOTE_EXPIRY_DAYS = 90;

const headers = () => ({
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
});

/**
 * getCompany()
 * Fetch a company record by ID.
 */
async function getCompany(companyId) {
  const url = `${BASE}/crm/v3/objects/companies/${companyId}?properties=name,phone,last_phone_tree_mapping`;
  const res = await axios.get(url, { headers: headers() });
  return res.data;
}

/**
 * getExistingScoutNote()
 * Checks if a Phone Tree Scout note already exists for this company
 * that was created within the last NOTE_EXPIRY_DAYS days.
 *
 * Returns the note object if found and fresh, null otherwise.
 */
async function getExistingScoutNote(companyId) {
  try {
    // Search for notes associated with this company
    const searchPayload = {
      filters: [
        {
          propertyName: 'associations.company',
          operator: 'EQ',
          value: companyId,
        },
      ],
      properties: ['hs_note_body', 'hs_timestamp', 'hs_createdate'],
      sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }],
      limit: 20,
    };

    const res = await axios.post(
      `${BASE}/crm/v3/objects/notes/search`,
      searchPayload,
      { headers: headers() }
    );

    const notes = res.data?.results || [];

    // Find the most recent Phone Tree Scout note
    const scoutNote = notes.find(note =>
      note.properties?.hs_note_body?.includes('Phone Tree Scout') ||
      note.properties?.hs_note_body?.includes('PHONE TREE MAP')
    );

    if (!scoutNote) return null;

    // Check if it's still fresh (within expiry window)
    const createdAt = new Date(scoutNote.properties.hs_createdate);
    const ageInDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

    if (ageInDays < NOTE_EXPIRY_DAYS) {
      console.log(`[HubSpot] Found fresh Scout note for company ${companyId} (${Math.round(ageInDays)} days old)`);
      return scoutNote;
    }

    console.log(`[HubSpot] Existing Scout note is stale (${Math.round(ageInDays)} days old) — will replace`);
    return null;

  } catch (err) {
    // If search fails don't block the save — just log and continue
    console.warn('[HubSpot] Could not check for existing notes:', err.message);
    return null;
  }
}

/**
 * archiveNote()
 * Archives (soft deletes) an existing note by ID.
 * This keeps CRM clean — old Scout notes are replaced, not stacked.
 */
async function archiveNote(noteId) {
  try {
    await axios.delete(
      `${BASE}/crm/v3/objects/notes/${noteId}`,
      { headers: headers() }
    );
    console.log(`[HubSpot] Archived old Scout note: ${noteId}`);
  } catch (err) {
    console.warn(`[HubSpot] Could not archive note ${noteId}:`, err.message);
  }
}

/**
 * logCallNote()
 * Main function called after every completed call.
 *
 * Flow:
 * 1. Check for existing fresh Scout note → archive it if found
 * 2. Save the new AI structured note
 * 3. Update the last_phone_tree_mapping property on the company
 */
async function logCallNote({
  companyId,
  companyName,
  toNumber,
  structuredNote,   // AI generated structured note (primary)
  rawTranscript,    // kept for debugging only
  duration,
  callSid,
}) {
  const timestamp = new Date().toISOString();
  const durationStr = duration ? `\nCall Duration: ${duration}s` : '';
  const callMeta = `\nNumber Dialed: ${toNumber} | Call SID: ${callSid}${durationStr}`;

  // Build the final note body — AI structured note + metadata footer
  const noteBody = `${structuredNote}\n${callMeta}`;

  // Step 1 — Check for and archive existing Scout note
  const existingNote = await getExistingScoutNote(companyId);
  if (existingNote) {
    await archiveNote(existingNote.id);
  }

  // Step 2 — Create the new structured note
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

  console.log(`[HubSpot] Structured note created: ${noteRes.data.id}`);

  // Step 3 — Update last_phone_tree_mapping property on company
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
    console.log(`[HubSpot] Company ${companyId} last_phone_tree_mapping updated`);
  } catch (propErr) {
    console.warn(`[HubSpot] Could not update last_phone_tree_mapping: ${propErr.message}`);
    console.warn(`  → Create this in HubSpot: Company > Custom Properties > last_phone_tree_mapping`);
  }

  return noteRes.data;
}

module.exports = { getCompany, logCallNote, getExistingScoutNote };
