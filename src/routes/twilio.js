/**
 * routes/twilio.js
 * Handles all Twilio call flow, smart call ending, and AI transcript analysis.
 */

const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const callStore = require('../callStore');
const hubspotService = require('../services/hubspot');
const { analyzeTranscript } = require('../services/ai');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// How many seconds of silence after content before we end the call
const SILENCE_TIMEOUT_SECONDS = 8;

// Maximum call duration in seconds — safety net (3 minutes)
const MAX_CALL_DURATION = 180;
/**
 * isBusinessHours()
 * Checks if the current time is within calling hours (9am-2pm) for a timezone.
 * Returns true if it's safe to call.
 */
function isBusinessHours(timezone = 'America/New_York') {
  try {
    const now = new Date();
    const options = { timeZone: timezone, hour: 'numeric', hour12: false };
    const hourStr = new Intl.DateTimeFormat('en-US', options).format(now);
    const hour = parseInt(hourStr, 10);

    const dayOptions = { timeZone: timezone, weekday: 'short' };
    const day = new Intl.DateTimeFormat('en-US', dayOptions).format(now);

    if (day === 'Sat' || day === 'Sun') return false;

    return hour >= 9 && hour < 14;
  } catch (err) {
    console.error('[BusinessHours] Invalid timezone:', timezone, err.message);
    return true;
  }
}
 /**
 * Retry Queue — in-memory queue for calls that need retrying.
 */
const retryQueue = [];
const MAX_RETRIES = 3;

function addToRetryQueue(companyId, companyName, phone, reason) {
  const existing = retryQueue.find(item => item.companyId === companyId);
  if (existing) {
    existing.retryCount++;
    existing.lastReason = reason;
    return;
  }
  retryQueue.push({
    companyId,
    companyName,
    phone,
    reason,
    retryCount: 0,
    addedAt: new Date(),
  });
  console.log(`[Retry] Queued ${companyName} — reason: ${reason}`);
}

async function processRetryQueue() {
  if (retryQueue.length === 0) return;
  console.log(`[Retry] Processing queue — ${retryQueue.length} items`);

  const toProcess = [...retryQueue];

  for (const item of toProcess) {
    if (item.retryCount >= MAX_RETRIES) {
      const idx = retryQueue.indexOf(item);
      if (idx > -1) retryQueue.splice(idx, 1);
      console.log(`[Retry] Max retries reached for ${item.companyName} — removing`);
      continue;
    }

    if (!isBusinessHours('America/New_York')) continue;

    try {
      let cleanPhone = item.phone.replace(/[^0-9+]/g, '');
      if (!cleanPhone.startsWith('+')) cleanPhone = '+1' + cleanPhone;

      const call = await client.calls.create({
        to: cleanPhone,
        from: process.env.TWILIO_PHONE_NUMBER,
        machineDetection: 'DetectMessageEnd',
        machineDetectionTimeout: 30,
        asyncAmd: 'true',
        asyncAmdStatusCallback: `${process.env.BASE_URL}/twilio/amd-status`,
        asyncAmdStatusCallbackMethod: 'POST',
        url: `${process.env.BASE_URL}/twilio/twiml?companyId=${encodeURIComponent(item.companyId)}&companyName=${encodeURIComponent(item.companyName)}`,
        statusCallback: `${process.env.BASE_URL}/twilio/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
      });

      callStore.initCall(call.sid, {
        companyId: item.companyId,
        companyName: item.companyName,
        toNumber: cleanPhone,
      });

      const idx = retryQueue.indexOf(item);
      if (idx > -1) retryQueue.splice(idx, 1);
      console.log(`[Retry] Retried ${item.companyName} — SID: ${call.sid}`);

      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (err) {
      console.error(`[Retry] Failed for ${item.companyName}:`, err.message);
      item.retryCount++;
    }
  }
}

// Check retry queue every 15 minutes
setInterval(processRetryQueue, 15 * 60 * 1000);
/**
 * POST /twilio/call
 * Initiates an outbound call with answering machine detection.
 */
router.post('/call', async (req, res) => {
  const { toNumber, companyId, companyName } = req.body;

  if (!toNumber || !companyId) {
    return res.status(400).json({ error: 'toNumber and companyId are required' });
  }

  try {
    const call = await client.calls.create({
      to: toNumber,
      from: process.env.TWILIO_PHONE_NUMBER,

      // Answering machine detection — used to classify call type
      machineDetection: 'DetectMessageEnd',
      machineDetectionTimeout: 30,
      asyncAmd: 'true',
      asyncAmdStatusCallback: `${process.env.BASE_URL}/twilio/amd-status`,
      asyncAmdStatusCallbackMethod: 'POST',

      url: `${process.env.BASE_URL}/twilio/twiml?companyId=${encodeURIComponent(companyId)}&companyName=${encodeURIComponent(companyName || '')}`,
      statusCallback: `${process.env.BASE_URL}/twilio/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });

    callStore.initCall(call.sid, { companyId, companyName, toNumber });

    const dashboardUrl = `${process.env.BASE_URL}/dashboard?callSid=${call.sid}&companyId=${companyId}`;
    res.json({ callSid: call.sid, dashboardUrl });

  } catch (err) {
    console.error('[Twilio] Error creating call:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /twilio/amd-status
 * Async Answering Machine Detection callback.
 * 
 * AnsweredBy values:
 *   human         → could be a real person OR an AI voice system. Log it, keep listening.
 *   machine_start → voicemail/automated system. Keep listening — this is a phone tree.
 *   fax           → hang up immediately.
 *   unknown       → keep listening, silence timeout will handle it.
 */
router.post('/amd-status', async (req, res) => {
  const { CallSid, AnsweredBy } = req.body;
  console.log(`[AMD] ${CallSid} answered by: ${AnsweredBy}`);

  if (AnsweredBy === 'fax') {
    // Fax machine — hang up immediately, no note needed
    console.log(`[AMD] Fax detected for ${CallSid} — hanging up`);
    try {
      await client.calls(CallSid).update({ status: 'completed' });
    } catch (err) {
      console.error('[AMD] Failed to hang up fax:', err.message);
    }
  } else if (AnsweredBy === 'human') {
    // Log it but DON'T hang up — many AI voice systems and IVRs
    // sound human to Twilio's detector. Let the call keep listening
    // and the silence timeout will end it naturally.
    console.log(`[AMD] Human detected for ${CallSid} — keeping call alive to capture any IVR`);
    callStore.addTranscriptLine(CallSid, '[AMD: Human or AI voice detected — listening for phone tree]');
  }
  // machine_start and unknown — do nothing, let the TwiML flow continue

  res.sendStatus(204);
});

/**
 * POST/GET /twilio/twiml
 * TwiML instructions for the call.
 * Uses Gather with speech recognition to capture phone tree audio.
 */
router.all('/twiml', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  // Primary gather — listen for speech with silence detection
  const gather = response.gather({
    input: 'speech dtmf',
    timeout: SILENCE_TIMEOUT_SECONDS,
    speechTimeout: 'auto',
    action: `${process.env.BASE_URL}/twilio/gather`,
    method: 'POST',
    profanityFilter: false,
  });

  // Silent — don't announce ourselves, just listen
  gather.pause({ length: 1 });

  // If gather completes (silence timeout hit) → redirect to /twiml-end
  response.redirect({ method: 'POST' }, `${process.env.BASE_URL}/twilio/twiml-end`);

  res.type('text/xml');
  res.send(response.toString());
});

/**
 * POST /twilio/twiml-end
 * Called when gather silence timeout fires — meaning the menu has finished.
 * Hangs up the call cleanly.
 */
router.post('/twiml-end', (req, res) => {
  const { CallSid } = req.body;
  console.log(`[TwiML] Silence timeout fired for ${CallSid} — ending call`);

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  response.hangup();

  res.type('text/xml');
  res.send(response.toString());
});

/**
 * POST /twilio/gather
 * Receives speech/DTMF from Gather, stores transcript lines.
 * Checks for hold music / transfer phrases to end call gracefully.
 */
router.post('/gather', (req, res) => {
  const { CallSid, SpeechResult, Digits, Confidence } = req.body;
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  if (SpeechResult) {
    const text = SpeechResult.trim();
    console.log(`[Gather] ${CallSid} speech: "${text}" (confidence: ${Confidence})`);
    callStore.addTranscriptLine(CallSid, text);

    // Check for hold music / transfer indicators — end the call gracefully
    const holdIndicators = [
      'please hold',
      'your call is being transferred',
      'transferring your call',
      'one moment please',
      'please wait',
      'connecting you now',
      'thank you for holding',
    ];

    const lowerText = text.toLowerCase();
    const isHoldDetected = holdIndicators.some(phrase => lowerText.includes(phrase));

    if (isHoldDetected) {
      console.log(`[Gather] Hold music indicator detected for ${CallSid} — ending call`);
      callStore.addTranscriptLine(CallSid, '[Hold/transfer detected — Scout ending call]');
      response.hangup();
      res.type('text/xml');
      res.send(response.toString());
      return;
    }
  }

  if (Digits) {
    callStore.addTranscriptLine(CallSid, `[DTMF] Pressed: ${Digits}`);
  }

  // Continue listening with silence timeout
  const gather = response.gather({
    input: 'speech dtmf',
    timeout: SILENCE_TIMEOUT_SECONDS,
    speechTimeout: 'auto',
    action: `${process.env.BASE_URL}/twilio/gather`,
    method: 'POST',
    profanityFilter: false,
  });

  gather.pause({ length: 1 });

  // If gather times out (silence) → end the call
  response.redirect({ method: 'POST' }, `${process.env.BASE_URL}/twilio/twiml-end`);

  res.type('text/xml');
  res.send(response.toString());
});

/**
 * POST /twilio/status
 * Handles call status callbacks.
 * On 'completed' → runs AI analysis → saves structured note to HubSpot.
 */
router.post('/status', async (req, res) => {
  const { CallSid, CallStatus, Duration } = req.body;
  console.log(`[Status] ${CallSid} → ${CallStatus}`);

  callStore.setStatus(CallSid, CallStatus);

  if (CallStatus === 'completed') {
    const call = callStore.getCall(CallSid);

    if (call && !call.noteLogged) {
      // Mark as logged immediately to prevent duplicate notes
      call.noteLogged = true;

      const transcript = callStore.getTranscript(CallSid);
      const rawTranscript = transcript.map((l) => l.text).join('\n');

      console.log(`[Status] Running AI analysis for ${call.meta.companyName}...`);

      const structuredNote = await analyzeTranscript(rawTranscript, call.meta.companyName);
      // Simple retry detection from raw transcript
      const lowerTranscript = rawTranscript.toLowerCase();
      const retrySignals = [
        'office is closed',
        'office is currently closed',
        'our hours are',
        'call back during',
        'call us back',
        'business hours',
        'currently unavailable',
        'leave a message',
        'no one is available',
      ];
      const needsRetry = retrySignals.some(signal => lowerTranscript.includes(signal));

      if (needsRetry) {
        console.log(`[Status] Retry signal detected for ${call.meta.companyName}`);
        addToRetryQueue(
          call.meta.companyId,
          call.meta.companyName,
          call.meta.toNumber,
          'closed_or_unavailable'
        );
      }

      // Broadcast the AI result to the dashboard
      callStore.broadcast(CallSid, {
        type: 'ai_note',
        data: { note: structuredNote }
      });

      try {
        await hubspotService.logCallNote({
          companyId: call.meta.companyId,
          companyName: call.meta.companyName,
          toNumber: call.meta.toNumber,
          structuredNote,
          rawTranscript,
          duration: Duration,
          callSid: CallSid,
        });
        console.log(`[HubSpot] Structured note logged for company ${call.meta.companyId}`);// Check if call needs retry (closed office, voicemail, etc.)
        const lowerTranscript = rawTranscript.toLowerCase();
        const retrySignals = [
          'office is closed', 'office is currently closed',
          'our hours are', 'call back during', 'call us back',
          'business hours', 'currently unavailable',
          'leave a message', 'no one is available',
        ];
        const needsRetry = retrySignals.some(signal => lowerTranscript.includes(signal));
        if (needsRetry) {
          console.log(`[Status] Retry signal detected for ${call.meta.companyName}`);
          addToRetryQueue(call.meta.companyId, call.meta.companyName, call.meta.toNumber, 'closed_or_unavailable');
        }
      } catch (err) {
        console.error('[HubSpot] Failed to log note:', err.message);
      }
    }
  }

  res.sendStatus(204);
});

/**
 * POST /twilio/hangup
 * Manual hang up a call by SID (from dashboard button).
 */
router.post('/hangup', async (req, res) => {
  const { callSid } = req.body;
  if (!callSid) return res.status(400).json({ error: 'callSid required' });

  try {
    await client.calls(callSid).update({ status: 'completed' });
    callStore.setStatus(callSid, 'completed');
    res.json({ success: true });
  } catch (err) {
    console.error('[Hangup] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
/**
 * POST /twilio/auto-map
 * Called by HubSpot workflow when a new company is added.
 * Checks business hours, then fires a Scout call.
 */
router.post('/auto-map', async (req, res) => {
  const { companyId } = req.body;

  if (!companyId) {
    return res.status(400).json({ error: 'companyId required' });
  }

  try {
    const axios = require('axios');
    const hsResponse = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name,phone,timezone`,
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
        },
      }
    );

    const company = hsResponse.data;
    const companyName = company.properties.name || 'Unknown';
    const phone = company.properties.phone;
    const timezone = company.properties.timezone || 'America/New_York';

    if (!phone) {
      console.log(`[Auto-Map] No phone for company ${companyId} — skipping`);
      return res.json({ status: 'skipped', reason: 'no_phone' });
    }

    if (!isBusinessHours(timezone)) {
      addToRetryQueue(companyId, companyName, phone, 'outside_hours');
      console.log(`[Auto-Map] Outside business hours for ${companyName} — queued`);
      return res.json({ status: 'queued', reason: 'outside_hours' });
    }

    let cleanPhone = phone.replace(/[^0-9+]/g, '');
    if (!cleanPhone.startsWith('+')) cleanPhone = '+1' + cleanPhone;

    const call = await client.calls.create({
      to: cleanPhone,
      from: process.env.TWILIO_PHONE_NUMBER,
      machineDetection: 'DetectMessageEnd',
      machineDetectionTimeout: 30,
      asyncAmd: 'true',
      asyncAmdStatusCallback: `${process.env.BASE_URL}/twilio/amd-status`,
      asyncAmdStatusCallbackMethod: 'POST',
      url: `${process.env.BASE_URL}/twilio/twiml?companyId=${encodeURIComponent(companyId)}&companyName=${encodeURIComponent(companyName)}`,
      statusCallback: `${process.env.BASE_URL}/twilio/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });

    callStore.initCall(call.sid, { companyId, companyName, toNumber: cleanPhone });
    console.log(`[Auto-Map] Call initiated for ${companyName} (${cleanPhone}) — SID: ${call.sid}`);

    res.json({ status: 'calling', callSid: call.sid });

  } catch (err) {
    console.error('[Auto-Map] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;
module.exports.isBusinessHours = isBusinessHours;
module.exports.addToRetryQueue = addToRetryQueue;
