# CyberIntel — M&A Intelligence Platform

AI-powered M&A intelligence reports for cybersecurity companies, grounded in **real-time web data** via Tavily search and Financial Modeling Prep market data.

## Architecture

```
Browser (cyber_intel.html)
   │
   ├── POST /api/research ──→ Tavily (6 parallel web searches)
   │                       ──→ FMP (7 public peer financials)
   │                       ←── streams real-time progress events
   │
   └── POST /api/messages ──→ Anthropic Claude (report generation)
                           ←── grounded report with source citations
```

**Claude does NOT have internet access.** Tavily and FMP scrape the web, then their results are injected into Claude's prompt so the report is based on real, cited data — not hallucinations.

## Setup

### 1. Prerequisites

```bash
node --version   # must be v18 or higher (nodejs.org)
# No npm install needed — zero dependencies, Node built-ins only
```

### 2. Set API Keys

**Option A — `.env` file (local development):**

```bash
cp .env.example .env
# Edit .env and paste your actual keys
```

**Option B — Environment variables (Railway, Render, etc.):**

Set these in your platform's dashboard:

| Variable | Required | Get it from |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| `TAVILY_API_KEY` | Yes | [tavily.com](https://tavily.com) — free tier: 1,000 searches/month |
| `FMP_API_KEY` | Recommended | [financialmodelingprep.com](https://site.financialmodelingprep.com/developer/docs) — free tier: 250 calls/day |

### 3. Run

```bash
node server.js
```

Open **http://localhost:3000** — click **"Test API Keys"** to verify all three are working.

## Usage

1. Enter the target company website URL (e.g. `https://crowdstrike.com`)
2. Optionally enter a sector focus (e.g. Endpoint Security, Cloud Security, IAM)
3. Click **Company Report** or **Sector Report**
4. Watch real-time progress as each web search completes
5. Download the report as HTML, TXT, PDF, or DOCX

## Files

| File | Purpose |
|------|---------|
| `server.js` | Proxy server — routes Tavily, FMP, and Anthropic API calls |
| `cyber_intel.html` | Single-file frontend (HTML + CSS + JS) |
| `.env.example` | Template for API keys |
| `.gitignore` | Prevents `.env` from being committed |

## Deploy on Railway

1. Push this repo to GitHub
2. Create a new project on [railway.app](https://railway.app)
3. Connect your GitHub repo
4. Add the three environment variables in the **Variables** tab
5. Railway auto-deploys on every push

## Cost

| Service | Cost |
|---------|------|
| Anthropic (Claude Sonnet 4.5) | ~$0.08–0.15 per report |
| Tavily (web search) | Free tier: 1,000/month |
| FMP (financial data) | Free tier: 250/day |
