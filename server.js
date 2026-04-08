/**
 * CyberIntel — Local Proxy Server
 * Sits between the browser and Anthropic API to bypass CORS.
 * Runs Tavily web searches + Financial Modeling Prep peer data
 * to ground reports in real, credible data.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY  — required
 *   TAVILY_API_KEY     — required for web research
 *   FMP_API_KEY        — optional, enables real-time public peer comps
 *   PORT               — optional, defaults to 3000
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const TAVILY_KEY    = process.env.TAVILY_API_KEY || '';
const FMP_KEY       = process.env.FMP_API_KEY || '';
const PORT          = process.env.PORT || 3000;

/* ═══════════════════════════════════════════════════════
   TAVILY — broad web search with full page content
   ═══════════════════════════════════════════════════════ */

async function tavilySearch(query, opts) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key:             TAVILY_KEY,
      query:               query,
      search_depth:        'advanced',
      max_results:         opts.maxResults || 8,
      include_raw_content: true,
      include_answer:      true
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily ${res.status}: ${text}`);
  }
  return res.json();
}

function formatTavilyResults(label, data) {
  if (!data || !data.results || !data.results.length) return '';
  let out = `\n### ${label}\n`;
  if (data.answer) out += `ANSWER: ${data.answer}\n\n`;
  data.results.forEach((r, i) => {
    out += `[${i + 1}] ${r.title}\n`;
    out += `    URL: ${r.url}\n`;
    if (r.content) out += `    SNIPPET: ${r.content}\n`;
    /* Include full page text for top 2 results per query — this is where the real data lives */
    if (i < 2 && r.raw_content) {
      out += `    FULL PAGE CONTENT:\n    ${r.raw_content.slice(0, 2000)}\n`;
    }
    out += '\n';
  });
  return out;
}

async function tavilyResearchCompany(company, domain, sector) {
  if (!TAVILY_KEY) return '';
  const s = sector || 'cybersecurity';
  /* Targeted queries — quotes force exact match, source-specific terms pull richer pages */
  const queries = [
    { q: `"${company}" company profile founded headquarters CEO executives investors crunchbase`,  label: 'Company Profile & Leadership' },
    { q: `"${company}" funding rounds series raised million valuation investors`,                   label: 'Funding Rounds & Valuation' },
    { q: `"${company}" acquisition acquired merger deal partnership strategic`,                     label: 'Acquisitions & Partnerships' },
    { q: `"${company}" revenue ARR annual recurring growth customers ${s}`,                         label: 'Revenue & Financial Metrics' },
    { q: `"${company}" ${s} news product launch announcement 2025 2026`,                            label: 'Recent News & Product Launches' },
    { q: `"${company}" competitors comparison market share ${s} analysis`,                          label: 'Competitive Position' }
  ];
  const results = await Promise.allSettled(
    queries.map(q => tavilySearch(q.q, { maxResults: 8 }))
  );
  let ctx = '';
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ctx += formatTavilyResults(queries[i].label, r.value);
  });
  return ctx;
}

async function tavilyResearchSector(company, domain, sector) {
  if (!TAVILY_KEY) return '';
  const s = sector || 'cybersecurity';
  const queries = [
    { q: `${s} sector M&A acquisitions deals 2025 2026 total volume`,                              label: 'Sector M&A Activity' },
    { q: `${s} funding venture capital private equity deals 2025 2026`,                             label: 'Sector Financing & VC Activity' },
    { q: `${s} industry trends AI zero-trust cloud security market outlook 2026`,                   label: 'Industry Trends & Technology Shifts' },
    { q: `${s} CISO CTO executive moves leadership changes 2025 2026`,                             label: 'Executive Movements' },
    { q: `${s} conferences events RSA Black Hat RSAC 2026 dates location`,                         label: 'Conferences & Events 2026' },
    { q: `${s} company valuations multiples EV revenue ARR SaaS 2025 2026`,                        label: 'Valuation Multiples & Market Data' }
  ];
  const results = await Promise.allSettled(
    queries.map(q => tavilySearch(q.q, { maxResults: 8 }))
  );
  let ctx = '';
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ctx += formatTavilyResults(queries[i].label, r.value);
  });
  return ctx;
}

/* ═══════════════════════════════════════════════════════
   FINANCIAL MODELING PREP — real public peer comp data
   ═══════════════════════════════════════════════════════ */

const CYBER_PEERS = ['CRWD', 'PANW', 'S', 'ZS', 'FTNT', 'OKTA', 'NET'];

async function fmpGet(endpoint) {
  const url = `https://financialmodelingprep.com/api/v3/${endpoint}${endpoint.includes('?') ? '&' : '?'}apikey=${FMP_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status}`);
  return res.json();
}

async function fetchPeerComps() {
  if (!FMP_KEY) return '';

  /* Fetch profile + income statement + enterprise value for each peer in parallel */
  const peerData = await Promise.all(CYBER_PEERS.map(async (ticker) => {
    const [prof, inc, ev] = await Promise.all([
      fmpGet(`profile/${ticker}`).catch(() => null),
      fmpGet(`income-statement/${ticker}?limit=2&period=annual`).catch(() => null),
      fmpGet(`enterprise-values/${ticker}?limit=1&period=annual`).catch(() => null)
    ]);
    return { ticker, prof: prof?.[0], inc, ev: ev?.[0] };
  }));

  let out = '\n### PUBLIC CYBERSECURITY PEER FINANCIALS (real-time data from Financial Modeling Prep API)\n';
  out += 'Source: https://financialmodelingprep.com — use these exact numbers in the peer benchmarking table.\n\n';

  peerData.forEach(({ ticker, prof, inc, ev }) => {
    if (!prof) return;
    const rev0     = inc?.[0]?.revenue;
    const rev1     = inc?.[1]?.revenue;
    const gm       = inc?.[0]?.grossProfitRatio;
    const ebitda   = inc?.[0]?.ebitda;
    const growth   = (rev0 && rev1) ? ((rev0 - rev1) / rev1 * 100) : null;
    const entVal   = ev?.enterpriseValue;
    const evRev    = (entVal && rev0) ? (entVal / rev0) : null;
    const evEbitda = (entVal && ebitda > 0) ? (entVal / ebitda) : null;

    out += `${ticker} — ${prof.companyName}\n`;
    out += `  Status: Public (${prof.exchangeShortName})\n`;
    out += `  Market Cap: $${(prof.mktCap / 1e9).toFixed(1)}B\n`;
    out += `  Stock Price: $${prof.price}\n`;
    if (entVal)  out += `  Enterprise Value: $${(entVal / 1e9).toFixed(1)}B\n`;
    if (rev0)    out += `  Revenue (Annual): $${(rev0 / 1e9).toFixed(2)}B\n`;
    if (growth !== null) out += `  Revenue Growth YoY: ${growth.toFixed(1)}%\n`;
    if (gm !== null)     out += `  Gross Margin: ${(gm * 100).toFixed(1)}%\n`;
    if (evRev !== null)  out += `  EV/Revenue: ${evRev.toFixed(1)}x\n`;
    if (evEbitda !== null) out += `  EV/EBITDA: ${evEbitda.toFixed(1)}x\n`;
    out += `  CEO: ${prof.ceo || 'N/A'}\n`;
    out += `  Employees: ${prof.fullTimeEmployees || 'N/A'}\n`;
    out += '\n';
  });

  return out;
}

/* ═══════════════════════════════════════════════════════
   RESEARCH ORCHESTRATOR — combines all sources
   ═══════════════════════════════════════════════════════ */

async function runResearch(company, domain, sector, mode) {
  const isSector = mode === 'sector';

  /* Run Tavily + FMP in parallel */
  const [tavilyCtx, peerCtx] = await Promise.all([
    isSector
      ? tavilyResearchSector(company, domain, sector)
      : tavilyResearchCompany(company, domain, sector),
    fetchPeerComps()
  ]);

  let context = '=== LIVE WEB RESEARCH DATA ===\n';
  context += 'This data was scraped from real web pages moments ago. It is current and authoritative.\n';
  context += 'RULES FOR USING THIS DATA:\n';
  context += '- Use exact numbers from this data instead of estimates whenever available.\n';
  context += '- Cite the actual URL for every fact using <a class="source-tag" href="URL" target="_blank">SOURCE</a>.\n';
  context += '- If this data gives a specific number, do NOT round it or turn it into a range — use the exact figure.\n';
  context += '- Only fall back to estimates when this data has no coverage. Mark those clearly as (Est.).\n';
  context += '\n';

  if (tavilyCtx) context += tavilyCtx;
  if (peerCtx)   context += peerCtx;

  context += '\n=== END OF LIVE RESEARCH DATA ===\n';
  return context;
}

/* ═══════════════════════════════════════════════════════
   HTTP SERVER
   ═══════════════════════════════════════════════════════ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {

  /* CORS preflight */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  /* Serve static files */
  if (req.method === 'GET') {
    const filePath = path.join(__dirname, req.url === '/' ? 'cyber_intel.html' : req.url);
    try {
      const data = fs.readFileSync(filePath);
      const ext  = path.extname(filePath);
      const mime = ext === '.html' ? 'text/html' : 'text/plain';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  /* ── Research endpoint ─────────────────────────────── */
  if (req.method === 'POST' && req.url === '/api/research') {
    try {
      const raw  = await readBody(req);
      const body = JSON.parse(raw);
      const { company, domain, sector, mode } = body;

      if (!TAVILY_KEY && !FMP_KEY) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ context: '', warning: 'No research API keys set' }));
        return;
      }

      const context = await runResearch(company, domain, sector, mode);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ context }));
    } catch (err) {
      console.error('Research error:', err.message);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ context: '', error: err.message }));
    }
    return;
  }

  /* ── Anthropic proxy ───────────────────────────────── */
  if (req.method === 'POST' && req.url === '/api/messages') {
    try {
      const body = await readBody(req);
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body
      });
      const data = await response.json();
      res.writeHead(response.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404); res.end();

}).listen(PORT, () => {
  console.log(`CyberIntel running at http://localhost:${PORT}`);
  console.log(`  Anthropic API key: ${ANTHROPIC_KEY ? 'set' : 'MISSING'}`);
  console.log(`  Tavily API key:    ${TAVILY_KEY ? 'set' : 'MISSING'}`);
  console.log(`  FMP API key:       ${FMP_KEY ? 'set' : 'MISSING (peer comps disabled)'}`);
});
