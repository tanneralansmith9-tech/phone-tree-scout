/**
 * services/ai.js
 * GPT-powered transcript analysis for Phone Tree Scout.
 * Turns a raw transcript into a clean structured phone tree map.
 */

const OpenAI = require('openai');

let openai;
function getClient() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

/**
 * analyzeTranscript()
 * Sends raw transcript to GPT and returns structured JSON,
 * then formats it into a clean readable note.
 */
async function analyzeTranscript(rawTranscript, companyName = 'Unknown Company') {
  if (!rawTranscript || rawTranscript.trim().length < 10) {
    return buildFallbackNote(companyName, 'No transcript captured — call may have ended before audio was received.');
  }

  const prompt = `You are analyzing a phone call transcript from a phone tree mapping tool.
Company called: ${companyName}

TRANSCRIPT:
${rawTranscript}

Analyze this transcript and return ONLY a JSON object with these fields. Use null for any field where info was not found:

{
  "call_type": "ivr" or "human" or "voicemail" or "closed" or "unknown",
  "fastest_path_to_human": "e.g. Press 0 at any time",
  "menu_options": [
    {"key": "1", "description": "Reservations"},
    {"key": "2", "description": "Flight Status"}
  ],
  "shortcuts": ["e.g. Press 0 for operator", "Say representative"],
  "office_hours": "e.g. Monday-Friday 8am-5pm",
  "notes": "any other useful info — hold times, departments, languages, etc."
}

Return ONLY valid JSON. No markdown, no backticks, no explanation.`;

  try {
    const completion = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You extract phone tree data from transcripts and return clean JSON. Be precise. Only include information actually present in the transcript.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: 600,
      temperature: 0.1,
    });

    const raw = completion.choices[0]?.message?.content?.trim();

    if (!raw) {
      return buildFallbackNote(companyName, 'AI analysis returned empty response.');
    }

    // Parse JSON from GPT
    let data;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      data = JSON.parse(cleaned);
    } catch (e) {
      console.error('[AI] Failed to parse JSON, using raw response');
      return buildFallbackNote(companyName, 'AI returned unstructured response.\n\n' + raw);
    }

    // Format into clean readable note
    const note = formatNote(companyName, data);
    console.log(`[AI] Transcript analyzed for ${companyName} — ${note.length} chars`);
    return note;

  } catch (err) {
    console.error('[AI] GPT analysis failed:', err.message);
    return buildFallbackNote(companyName, `AI analysis failed: ${err.message}\n\nRAW TRANSCRIPT:\n${rawTranscript}`);
  }
}

/**
 * formatNote()
 * Takes structured JSON data and formats it into a clean HubSpot note.
 */
function formatNote(companyName, data) {
  const lines = [];

  lines.push(`PHONE TREE MAP: ${companyName.toUpperCase()}`);
  lines.push('');

  // Call type
  if (data.call_type) {
    const typeLabels = {
      ivr: 'Automated Phone Tree (IVR)',
      human: 'Live Person Answered',
      voicemail: 'Voicemail / After Hours',
      closed: 'Office Closed',
      unknown: 'Unknown',
    };
    lines.push(`Type: ${typeLabels[data.call_type] || data.call_type}`);
    lines.push('');
  }

  // Fastest path to human
  if (data.fastest_path_to_human) {
    lines.push('FASTEST PATH TO HUMAN');
    lines.push(data.fastest_path_to_human);
    lines.push('');
  }

  // Menu options
  if (data.menu_options && data.menu_options.length > 0) {
    lines.push('MENU OPTIONS');
    for (const opt of data.menu_options) {
      lines.push(`  Press ${opt.key} - ${opt.description}`);
    }
    lines.push('');
  }

  // Shortcuts
  if (data.shortcuts && data.shortcuts.length > 0) {
    lines.push('SHORTCUTS');
    for (const shortcut of data.shortcuts) {
      lines.push(`  ${shortcut}`);
    }
    lines.push('');
  }

  // Office hours
  if (data.office_hours) {
    lines.push('OFFICE HOURS');
    lines.push(data.office_hours);
    lines.push('');
  }

  // Notes
  if (data.notes) {
    lines.push('NOTES');
    lines.push(data.notes);
    lines.push('');
  }

  lines.push('---');
  lines.push('Mapped by Phone Tree Scout');

  return lines.join('\n');
}

/**
 * buildFallbackNote()
 * Returns a clean fallback note when AI fails or transcript is empty.
 */
function buildFallbackNote(companyName, message) {
  return `PHONE TREE MAP: ${companyName.toUpperCase()}\n\nNOTE\n${message}\n\n---\nMapped by Phone Tree Scout`;
}

module.exports = { analyzeTranscript };
