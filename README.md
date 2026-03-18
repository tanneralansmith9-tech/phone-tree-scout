# 📞 Phone Tree Scout

An internal tool that maps company phone trees by triggering a Twilio call, displaying a live transcript in a web dashboard, and logging results back to HubSpot as a Note.

---

## Architecture Overview

```
HubSpot CRM Card
  └─► "Map Phone Tree" button
        └─► GET /hubspot/launch (iFrame)
              └─► POST /twilio/call
                    └─► Twilio dials out
                          └─► TwiML: <Gather speech + DTMF>
                                └─► POST /twilio/gather  (each speech/DTMF segment)
                                      └─► callStore → WebSocket broadcast
                                            └─► Dashboard (live transcript)
                    └─► POST /twilio/status (completed)
                          └─► HubSpot API: create Note + update property
```

---

## Project Structure

```
phone-tree-scout/
├── src/
│   ├── index.js              # Express + WebSocket server
│   ├── callStore.js          # In-memory call/transcript state
│   ├── routes/
│   │   ├── twilio.js         # /twilio/* endpoints
│   │   └── hubspot.js        # /hubspot/* endpoints
│   └── services/
│       └── hubspot.js        # HubSpot API helpers
├── public/
│   └── dashboard.html        # Live transcript UI
├── .env.example
├── render.yaml
├── railway.toml
└── package.json
```

---

## Prerequisites

- Node.js 18+
- A **Twilio** account with a phone number
- A **HubSpot** account with a Private App token
- A public HTTPS URL for your server (Render/Railway in production; ngrok for local dev)

---

## Step 1 — Install Dependencies

```bash
npm install
```

---

## Step 2 — Configure Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Where to get it |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio Console → Account Info |
| `TWILIO_AUTH_TOKEN` | Twilio Console → Account Info |
| `TWILIO_PHONE_NUMBER` | Twilio Console → Phone Numbers (must be E.164 format, e.g. `+15550001234`) |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot → Settings → Private Apps (see Step 4) |
| `BASE_URL` | Your public server URL — **no trailing slash** |
| `PORT` | Default `3000` |

---

## Step 3 — Create HubSpot Private App

1. In HubSpot, go to **Settings → Integrations → Private Apps**
2. Click **Create a private app**
3. Name it: `Phone Tree Scout`
4. Under **Scopes**, select:
   - `crm.objects.companies.read`
   - `crm.objects.companies.write`
   - `crm.objects.notes.write`
   - `crm.objects.engagements.write`
5. Click **Create app** → copy the **Access Token**
6. Paste it into `.env` as `HUBSPOT_ACCESS_TOKEN`

---

## Step 4 — Create the HubSpot Custom Company Property

This property stores the date/time of the last phone tree mapping.

1. In HubSpot go to **Settings → Properties → Company Properties**
2. Click **Create property**
3. Set:
   - **Label**: `Last Phone Tree Mapping`
   - **Internal name**: `last_phone_tree_mapping`
   - **Field type**: Single-line text (or Date/time)
4. Save

> If you skip this step, the tool still works — the Note will still be logged. You'll just see a warning in the server logs.

---

## Step 5 — Create the HubSpot CRM Card

This adds the "Map Phone Tree" button to every Company record.

1. In HubSpot, go to **Settings → Integrations → Private Apps** → open your app
2. Click **CRM Cards** tab → **Create CRM card**
3. Configure:
   - **Card label**: `Phone Tree Scout`
   - **Object type**: `Company`
   - **Data fetch URL**: `https://YOUR_BASE_URL/hubspot/crm-card`
   - **Request type**: `GET`
4. Click **Save**
5. Go to any Company record — you should see the card with the **📞 Map Phone Tree** button

---

## Step 6 — Local Development with ngrok

Twilio needs a public HTTPS URL to send webhooks. Use ngrok for local dev:

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3000
```

Copy the `https://xxxx.ngrok.io` URL and set it as `BASE_URL` in your `.env`.

Then start the server:

```bash
npm run dev
```

---

## Deploying to Render

1. Push your code to a GitHub repo
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your repo
4. Render auto-detects `render.yaml` — review and confirm
5. In the **Environment** tab, add all variables from `.env`
6. Deploy
7. Copy the `https://your-app.onrender.com` URL → set it as `BASE_URL` in Render env vars
8. Redeploy to apply

> **Important**: Render free tier spins down after 15 minutes of inactivity. The first request after sleep takes ~30 seconds. Use the Starter plan ($7/mo) for always-on uptime.

---

## Deploying to Railway

1. Install Railway CLI: `npm install -g @railway/cli`
2. Run `railway login`
3. From the project folder: `railway init` then `railway up`
4. In the Railway dashboard, add all environment variables
5. Copy your Railway URL → set it as `BASE_URL` → redeploy

---

## How It Works (End-to-End)

1. In HubSpot, open any **Company** record
2. Find the **Phone Tree Scout** card in the right sidebar
3. Click **📞 Map Phone Tree**
4. An iFrame opens — the server dials the company's phone number
5. The iFrame redirects to the live **Dashboard**
6. As the phone tree plays, Twilio's `<Gather>` captures speech and DTMF key presses
7. Each captured segment appears in the **Live Transcript** panel in real-time via WebSocket
8. Keywords (`operator`, `clerk`, `representative`, `press 0`, etc.) are highlighted in purple/gold
9. Click **⏹ Hang Up** or let the call end naturally
10. When the call completes, the full transcript is automatically posted to HubSpot as a **Note** on the Company record

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/hubspot/crm-card` | HubSpot CRM Card data fetch |
| `GET` | `/hubspot/launch` | Launches iFrame, initiates call |
| `POST` | `/twilio/call` | Initiates outbound Twilio call |
| `GET/POST` | `/twilio/twiml` | TwiML instructions for the call |
| `POST` | `/twilio/gather` | Receives speech/DTMF from Twilio |
| `POST` | `/twilio/status` | Call status callbacks |
| `POST` | `/twilio/hangup` | Hangs up active call |
| `GET` | `/dashboard` | Live transcript dashboard UI |
| `GET` | `/health` | Health check |
| `WS` | `/ws?callSid=xxx` | WebSocket for real-time transcript |

---

## Keyword Highlighting

The dashboard highlights these keywords in the transcript and tracks their count in the sidebar:

- `operator`
- `clerk`
- `representative`
- `press 0` / `press zero`
- `directory`
- `extension`

To add more keywords, edit the `KEYWORDS` array in `public/dashboard.html`.

---

## Troubleshooting

**Transcript is empty / no speech captured**
- Check that your `BASE_URL` is publicly reachable (Twilio can't call `localhost`)
- Verify `BASE_URL` has no trailing slash
- In the Twilio Console, check the Call logs for webhook errors

**"Map Phone Tree" button not appearing in HubSpot**
- The CRM Card data fetch URL must return valid JSON (check `/hubspot/crm-card` in your browser)
- Ensure `BASE_URL` is set correctly and the server is running

**HubSpot Note not being created**
- Check your Private App scopes include `crm.objects.notes.write`
- Check server logs for `[HubSpot]` lines after call completion

**Call connects but hangs up immediately**
- Verify `TWILIO_PHONE_NUMBER` is in E.164 format (e.g. `+15550001234`)
- Check that your Twilio account has sufficient balance

---

## Environment Variable Quick Reference

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_PHONE_NUMBER=+15550000000
HUBSPOT_ACCESS_TOKEN=pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
BASE_URL=https://your-app.onrender.com
PORT=3000
```

---

## Notes & Limitations

- **No auth system** — this is an internal tool; don't expose it publicly without adding authentication
- **In-memory transcript store** — transcripts are lost on server restart; they are persisted in HubSpot before the process exits on graceful shutdown, but if the server crashes mid-call the transcript may not be saved
- **Twilio Gather transcription** is near-real-time but not frame-by-frame streaming. Each `speechTimeout` triggers a segment. Expect 2–5 second lag per segment.
- **Free Twilio numbers** may have limitations on outbound calls in some regions
