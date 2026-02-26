const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const callStore = require('../callStore');
const hubspotService = require('../services/hubspot');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/**
 * POST /twilio/call
 * Initiates an outbound call.
 * Body: { toNumber, companyId, companyName }
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
      url: `${process.env.BASE_URL}/twilio/twiml?companyId=${encodeURIComponent(companyId)}&companyName=${encodeURIComponent(companyName || '')}`,
      statusCallback: `${process.env.BASE_URL}/twilio/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: true,
      recordingStatusCallback: `${process.env.BASE_URL}/twilio/recording`,
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
 * POST/GET /twilio/twiml
 * Returns TwiML instructions for the outbound call.
 * Uses Twilio's built-in <Gather> with transcription.
 */
router.all('/twiml', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const gather = response.gather({
    input: 'speech dtmf',
    timeout: 60,
    speechTimeout: 'auto',
    action: `${process.env.BASE_URL}/twilio/gather`,
    method: 'POST',
    profanityFilter: false,
  });

  gather.say(
    { voice: 'alice' },
    'Connected. Listening for the phone tree. Press any key or speak to capture options.'
  );

  // If gather times out without input, loop
  response.redirect({ method: 'POST' }, `${req.originalUrl}`);

  res.type('text/xml');
  res.send(response.toString());
});

/**
 * POST /twilio/gather
 * Receives speech/DTMF input from Gather and stores as transcript line.
 */
router.post('/gather', (req, res) => {
  const { CallSid, SpeechResult, Digits, Confidence } = req.body;
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  if (SpeechResult) {
    const text = SpeechResult.trim();
    console.log(`[Gather] ${CallSid} speech: "${text}" (${Confidence})`);
    callStore.addTranscriptLine(CallSid, text);
  }

  if (Digits) {
    const text = `[DTMF] Pressed: ${Digits}`;
    console.log(`[Gather] ${CallSid} digits: ${Digits}`);
    callStore.addTranscriptLine(CallSid, text);
  }

  // Continue listening
  const gather = response.gather({
    input: 'speech dtmf',
    timeout: 60,
    speechTimeout: 'auto',
    action: `${process.env.BASE_URL}/twilio/gather`,
    method: 'POST',
    profanityFilter: false,
  });

  gather.pause({ length: 1 });

  res.type('text/xml');
  res.send(response.toString());
});

/**
 * POST /twilio/status
 * Handles call status callbacks. On 'completed', logs to HubSpot.
 */
router.post('/status', async (req, res) => {
  const { CallSid, CallStatus, Duration } = req.body;
  console.log(`[Status] ${CallSid} → ${CallStatus}`);

  callStore.setStatus(CallSid, CallStatus);

  if (CallStatus === 'completed') {
    const call = callStore.getCall(CallSid);
    if (call) {
      const transcript = callStore.getTranscript(CallSid);
      const transcriptText = transcript.map((l) => `[${l.timestamp}] ${l.text}`).join('\n');

      try {
        await hubspotService.logCallNote({
          companyId: call.meta.companyId,
          companyName: call.meta.companyName,
          toNumber: call.meta.toNumber,
          transcriptText,
          duration: Duration,
          callSid: CallSid,
        });
        console.log(`[HubSpot] Note logged for company ${call.meta.companyId}`);
      } catch (err) {
        console.error('[HubSpot] Failed to log note:', err.message);
      }
    }
  }

  res.sendStatus(204);
});

/**
 * POST /twilio/recording
 * Optional: receives recording status callback.
 */
router.post('/recording', (req, res) => {
  const { CallSid, RecordingUrl, RecordingStatus } = req.body;
  console.log(`[Recording] ${CallSid} → ${RecordingStatus}: ${RecordingUrl}`);

  if (RecordingUrl) {
    callStore.addTranscriptLine(CallSid, `[Recording available: ${RecordingUrl}]`);
  }

  res.sendStatus(204);
});

/**
 * POST /twilio/hangup
 * Hang up a call by SID.
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
