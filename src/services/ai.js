/**
 * services/ai.js
 * GPT-powered transcript analysis for Phone Tree Scout.
 * Turns a raw transcript into a clean structured phone tree map.
 */

const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * analyzeTranscript()
 * Sends raw transcript to GPT and returns a clean structured note.
 *
 * @param {string} rawTranscript - Raw text from the call
 * @param {string} companyName - Name of the company called
 * @returns {Promise<string>} - Formatted phone tree map as a string
 */
async function analyzeTranscript(rawTranscript, companyName = 'Unknown Company') {
  if (!rawTranscript || rawTranscript.trim().length < 10) {
    return buildFallbackNote(companyName, 'No transcript captured — call may have ended before audio was received.');
  }

  const prompt = `
You are analyzing a phone call transcript from an automated phone tree mapping tool called Phone Tree Scout.
The call was made to: ${companyName}

Your job is to extract and structure the phone tree options from the transcript below into a clean, useful note for a B2B sales rep.

RAW TRANSCRIPT:
${rawTranscript}

Return your response in EXACTLY this format (fill in what you find, omit sections with no data):

📞 PHONE TREE MAP — ${companyName.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 FASTEST PATH TO HUMAN
[The quickest way to reach a live person — e.g. "Press 0 at any time for operator"]

📋 MAIN MENU OPTIONS
[List each option clearly — e.g.]
• Press 1 — Administration
• Press 2 — Facilities  
• Press 3 — Procurement / Purchasing
• Press 0 — Operator

🔑 KEY SHORTCUTS
[Any shortcuts mentioned — e.g. "Press 0 at any menu level for operator"]

🕐 OFFICE HOURS
[Any hours mentioned — e.g. "Monday–Friday 8am–5pm"]

📝 NOTES
[Anything else useful — hold times, callback options, direct extensions mentioned, departments, etc.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mapped by Phone Tree Scout
`.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // cheap and fast, perfect for this
      messages: [
        {
          role: 'system',
          content: 'You are a precise assistant that extracts and structures phone tree information for sales teams. Be concise and accurate. Only include information actually present in the transcript.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: 600,
      temperature: 0.2, // low temperature = consistent structured output
    });

    const result = completion.choices[0]?.message?.content?.trim();

    if (!result) {
      return buildFallbackNote(companyName, 'AI analysis returned empty response.');
    }

    console.log(`[AI] Transcript analyzed for ${companyName} — ${result.length} chars`);
    return result;

  } catch (err) {
    console.error('[AI] GPT analysis failed:', err.message);
    // Don't throw — return raw transcript as fallback so HubSpot note still saves
    return buildFallbackNote(companyName, `AI analysis failed: ${err.message}\n\nRAW TRANSCRIPT:\n${rawTranscript}`);
  }
}

/**
 * buildFallbackNote()
 * Returns a clean fallback note when AI fails or transcript is empty.
 */
function buildFallbackNote(companyName, message) {
  return `📞 PHONE TREE MAP — ${companyName.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ NOTE
${message}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mapped by Phone Tree Scout`;
}

module.exports = { analyzeTranscript };
