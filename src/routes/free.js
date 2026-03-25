/**
 * routes/free.js
 * Handles the free phone tree mapping tool.
 * Rate limiting is handled on the frontend (8 maps per browser session).
 * Backend accepts any call and returns results for polling.
 */

const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const callStore = require('../callStore');
const { analyzeTranscript } = require('../services/ai');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// In-memory results store: { callSid: { status, note, reason } }
const freeResults = {};

/**
 * POST /api/free-call
 * Fire a Scout call for the free tool.
 */
router.post('/free-call', async (req, res) => {
  const { companyName, toNumber } = req.body;

  if (!toNumber || !companyName) {
    return res.status(400).json({ error: 'Organization name and phone number are required.' });
  }

  console.log(`[Free] Mapping: ${companyName} (${toNumber})`);

  try {
    let cleanPhone = toNumber.replace(/[^0-9+]/g, '');
    if (!cleanPhone.startsWith('+')) cleanPhone = '+1' + cleanPhone;

    const call = await client.calls.create({
      to: cleanPhone,
      from: process.env.TWILIO_PHONE_NUMBER,
      machineDetection: 'DetectMessageEnd',
      machineDetectionTimeout: 30,
      asyncAmd: 'true',
      asyncAmdStatusCallback: `${process.env.BASE_URL}/twilio/amd-status`,
      asyncAmdStatusCallbackMethod: 'POST',
      url: `${process.env.BASE_URL}/twilio/twiml?companyId=free&companyName=${encodeURIComponent(companyName)}`,
      statusCallback: `${process.env.BASE_URL}/api/free-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });

    // Init in callStore for transcript capture
    callStore.initCall(call.sid, {
      companyId: 'free',
      companyName: companyName,
      toNumber: cleanPhone,
    });

    // Init result tracker
    freeResults[call.sid] = { status: 'in_progress', note: null, reason: null };

    console.log(`[Free] Call initiated: ${call.sid} for ${companyName} (${cleanPhone})`);
    res.json({ callSid: call.sid });

  } catch (err) {
    console.error('[Free] Error creating call:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/free-status
 * Status callback for free tool calls.
 * On completed, runs AI analysis and stores result for polling.
 */
router.post('/free-status', async (req, res) => {
  const { CallSid, CallStatus, Duration } = req.body;
  console.log(`[Free Status] ${CallSid} → ${CallStatus}`);

  if (!freeResults[CallSid]) {
    return res.sendStatus(204);
  }

  if (CallStatus === 'completed') {
    const call = callStore.getCall(CallSid);

    if (call) {
      const transcript = callStore.getTranscript(CallSid);
      const rawTranscript = transcript.map((l) => l.text).join('\n');

      console.log(`[Free] Running AI analysis for ${call.meta.companyName}...`);

      const structuredNote = await analyzeTranscript(rawTranscript, call.meta.companyName);

      // Store result for polling (strip HTML for display)
      const cleanNote = structuredNote.replace(/<br>/g, '\n');
      freeResults[CallSid] = {
        status: 'completed',
        note: cleanNote,
        reason: null,
      };

      console.log(`[Free] Result ready for ${CallSid}`);

      // Clean up after 10 minutes
      setTimeout(() => {
        delete freeResults[CallSid];
      }, 10 * 60 * 1000);
    }
  } else if (CallStatus === 'failed' || CallStatus === 'busy' || CallStatus === 'no-answer') {
    freeResults[CallSid] = {
      status: 'failed',
      note: null,
      reason: CallStatus,
    };
  }

  res.sendStatus(204);
});

/**
 * GET /api/free-result/:callSid
 * Poll for the result of a free call.
 */
router.get('/free-result/:callSid', (req, res) => {
  const { callSid } = req.params;
  const result = freeResults[callSid];

  if (!result) {
    return res.json({ status: 'not_found' });
  }

  res.json(result);
});

module.exports = router;
