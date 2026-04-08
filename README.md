# CyberIntel — M&A Intelligence Platform

AI-powered M&A intelligence reports for any cybersecurity company, with live web search.

## Setup (one time)

```bash
# 1. Make sure Node.js is installed (nodejs.org)
node --version   # must be v18 or higher

# 2. No npm install needed — server.js uses only Node built-ins
```

## Run

```bash
node server.js
```

Then open **http://localhost:3000** in your browser.

## Usage

1. Paste your Anthropic API key (`sk-ant-...`) into the key field
   - Get one at https://console.anthropic.com/settings/keys
   - Top up credits at https://console.anthropic.com/settings/billing ($5 minimum = ~50 reports)
2. Enter the target company name (e.g. CrowdStrike, Wiz, SentinelOne)
3. Optionally enter a sector focus (e.g. Endpoint Security, SIEM, IAM)
4. Click **GENERATE** — takes ~2 minutes while Claude searches the web live
5. Download the report as **HTML** or **TXT**

## Why a local server?

Browsers block direct calls to `api.anthropic.com` (CORS policy). The `server.js` proxy
runs on your machine at `localhost:3000`, forwards requests to Anthropic, and serves the
`index.html` frontend. Your API key is never stored — it's passed through on each request.

## Files

| File | Purpose |
|---|---|
| `server.js` | Local proxy server — run this |
| `index.html` | The CyberIntel app |
| `README.md` | This file |

## Cost

Each report costs ~$0.05–0.10 via the Anthropic API (Claude Sonnet 4 + web search).
A $5 credit top-up gives you 50–100 full reports.
