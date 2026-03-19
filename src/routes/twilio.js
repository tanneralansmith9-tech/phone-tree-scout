/**
 * routes/twilio.js
 * Handles all Twilio call flow, smart call ending, and AI transcript analysis.
 */

const express = require('express');
const router = express.Router();
console.log('[twilio.js] router created');
const twilio = require('twilio');
console.log('[twilio.js] twilio loaded');
const callStore = require('../callStore');
console.log('[twilio.js] callStore loaded');
const hubspotService = require('../services/hubspot');
console.log('[twilio.js] hubspotService loaded');
const { analyzeTranscript } = require('../services/ai');
console.log('[twilio.js] ai loaded');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
console.log('[twilio.js] client created');


// How many seconds of silence after content before we end the call
const SILENCE_TIMEOUT_SECONDS = 8;

// Maximum call duration in seconds — safety net (3 minutes)
const MAX_CALL_DURATION = 180;

/**
 * POST /twilio/call
 * Initiates an outbound call with smart answering machine detection.
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

      // Smart answering machine detection
      // Twilio will classify: human, machine_start, fax, unknown
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
 * Called by Twilio after it determines if the pickup was human or machine.
 *
 * AnsweredBy values:
 *   human              — live person picked up → this is what we want for a receptionist scenario
 *   machine_start      — voicemail/automated system → this is a phone tree, keep listening
 *   fax                → hang up immediately
 *   unknown            → keep listening, we'll rely on silence timeout
 */
router.post('/amd-status', async (req, res) => {
  const { CallSid, AnsweredBy } = req.body;
  console.log(`[AMD] ${CallSid} answered by: ${AnsweredBy}`);

  if (AnsweredBy === 'human') {
    // Live receptionist — log a clean note and hang up
    // We don't need to map a phone tree, this company has a direct human answer
    const call = callStore.getCall(CallSid);
    if (call) {
      callStore.addTranscriptLine(CallSid, '[Live receptionist detected — no phone tree present]');
      callStore.setStatus(CallSid, 'human_detected');

      // Hang up the call
      try {
        await client.calls(CallSid).update({ status: 'completed' });
      } catch (err) {
        console.error('[AMD] Failed to hang up on human detection:', err.message);
      }
    }
  } else if (AnsweredBy === 'fax') {
    // Fax machine — hang up immediately, no note needed
    console.log(`[AMD] Fax detected for ${CallSid} — hanging up`);
    try {
      await client.calls(CallSid).update({ status: 'completed' });
    } catch (err) {
      console.error('[AMD] Failed to hang up fax:', err.message);
    }
  }
  // machine_start and unknown — do nothing, let the TwiML flow continue listening

  res.sendStatus(204);
});

/**
 * POST/GET /twilio/twiml
 * TwiML instructions for the call.
 * Uses Gather with speech recognition to capture phone tree audio.
 * Includes a maximum call duration safety net.
 */
router.all('/twiml', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  // Safety net — hang up after MAX_CALL_DURATION seconds no matter what
  response.pause({ length: MAX_CALL_DURATION });
  response.hangup();

  // Primary gather — listen for speech with silence detection
  const gather = response.gather({
    input: 'speech dtmf',
    timeout: SILENCE_TIMEOUT_SECONDS,  // end gather after N seconds of silence
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
 * After each line checks if hold music pattern detected.
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
      callStore.addTranscriptLine(CallSid, '[Call transferred / hold detected — Scout ending call]');
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

    if (call) {
      const transcript = callStore.getTranscript(CallSid);
      const rawTranscript = transcript.map((l) => l.text).join('\n');

      console.log(`[Status] Running AI analysis for ${call.meta.companyName}...`);

      // Run AI analysis — always runs, falls back gracefully if GPT fails
      const structuredNote = await analyzeTranscript(rawTranscript, call.meta.companyName);

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
          structuredNote,   // AI structured note
          rawTranscript,    // kept for debugging, not shown in HubSpot
          duration: Duration,
          callSid: CallSid,
        });
        console.log(`[HubSpot] Structured note logged for company ${call.meta.companyId}`);
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

module.exports = router;
