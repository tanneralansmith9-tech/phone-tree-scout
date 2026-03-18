/**
 * callStore.js
 * In-memory store for active calls.
 * Maps callSid → { transcript: [], clients: Set<WebSocket>, meta: {} }
 */

const store = new Map();

function initCall(callSid, meta = {}) {
  store.set(callSid, {
    transcript: [],
    clients: new Set(),
    status: 'initiated',
    meta,
    startedAt: new Date().toISOString(),
  });
  console.log(`[Store] Call initiated: ${callSid}`);
}

function getCall(callSid) {
  return store.get(callSid);
}

function addTranscriptLine(callSid, text) {
  const call = store.get(callSid);
  if (!call) return;
  const line = { text, timestamp: new Date().toISOString() };
  call.transcript.push(line);
  broadcast(callSid, { type: 'transcript', data: line });
}

function setStatus(callSid, status) {
  const call = store.get(callSid);
  if (!call) return;
  call.status = status;
  broadcast(callSid, { type: 'status', data: { status } });
  console.log(`[Store] Call ${callSid} → ${status}`);
}

function addClient(callSid, ws) {
  if (!store.has(callSid)) {
    // Create placeholder if call hasn't been initiated yet
    store.set(callSid, { transcript: [], clients: new Set(), status: 'unknown', meta: {} });
  }
  const call = store.get(callSid);
  call.clients.add(ws);

  // Send current state to newly connected client
  ws.send(JSON.stringify({ type: 'init', data: { transcript: call.transcript, status: call.status } }));
}

function removeClient(callSid, ws) {
  const call = store.get(callSid);
  if (call) call.clients.delete(ws);
}

function broadcast(callSid, message) {
  const call = store.get(callSid);
  if (!call) return;
  const payload = JSON.stringify(message);
  call.clients.forEach((ws) => {
    if (ws.readyState === 1) { // OPEN
      ws.send(payload);
    }
  });
}

function deleteCall(callSid) {
  store.delete(callSid);
}

function getTranscript(callSid) {
  const call = store.get(callSid);
  return call ? call.transcript : [];
}

module.exports = { initCall, getCall, addTranscriptLine, setStatus, addClient, removeClient, broadcast, deleteCall, getTranscript };
