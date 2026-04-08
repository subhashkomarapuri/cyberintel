/**
 * CyberIntel — Local Proxy Server
 * Runs Tavily web searches + Financial Modeling Prep peer data
 * to ground M&A intelligence reports in real, credible data.
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
  console.log(`  [Tavily] Searching: "${query.slice(0, 80)}..."`);
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
    console.error(`  [Tavily] ERROR ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`Tavily ${res.status}: ${text}`);
  }
  const data = await res.json();
  console.log(`  [Tavily] Got ${data.results?.length || 0} results, answer: ${data.answer ? 'yes' : 'no'}`);
  return data;
}

function formatTavilyResults(label, data) {
  if (!data || !data.results || !data.results.length) return '';
  let out = `\n### ${label}\n`;
  if (data.answer) out += `ANSWER: ${data.answer}\n\n`;
  data.results.forEach((r, i) => {
    out += `[${i + 1}] ${r.title}\n`;
    out += `    URL: ${r.url}\n`;
    if (r.content) out += `    SNIPPET: ${r.content}\n`;
    /* Full page text for top 3 results — this is where real numbers live */
    if (i < 3 && r.raw_content) {
      out += `    FULL PAGE CONTENT:\n    ${r.raw_content.slice(0, 2500)}\n`;
    }
    out += '\n';
  });
  return out;
}

async function tavilyResearchCompany(company, domain, sector) {
  if (!TAVILY_KEY) { console.log('  [Tavily] SKIPPED — no API key'); return ''; }
  const s = sector || 'cybersecurity';
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
  let totalResults = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      totalResults += r.value.results?.length || 0;
      ctx += formatTavilyResults(queries[i].label, r.value);
    } else {
      console.error(`  [Tavily] Query ${i} FAILED: ${r.reason}`);
    }
  });
  console.log(`  [Tavily] Company research complete: ${totalResults} total results`);
  return ctx;
}

async function tavilyResearchSector(company, domain, sector) {
  if (!TAVILY_KEY) { console.log('  [Tavily] SKIPPED — no API key'); return ''; }
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
  let totalResults = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      totalResults += r.value.results?.length || 0;
      ctx += formatTavilyResults(queries[i].label, r.value);
    } else {
      console.error(`  [Tavily] Query ${i} FAILED: ${r.reason}`);
    }
  });
  console.log(`  [Tavily] Sector research complete: ${totalResults} total results`);
  return ctx;
}

/* ═══════════════════════════════════════════════════════
   FINANCIAL MODELING PREP — real public peer comp data
   ═══════════════════════════════════════════════════════ */

const CYBER_PEERS = ['CRWD', 'PANW', 'S', 'ZS', 'FTNT', 'OKTA', 'NET'];

async function fmpGet(endpoint) {
  const url = `https://financialmodelingprep.com/api/v3/${endpoint}${endpoint.includes('?') ? '&' : '?'}apikey=${FMP_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    console.error(`  [FMP] ERROR ${res.status} for ${endpoint}: ${text.slice(0, 200)}`);
    throw new Error(`FMP ${res.status}`);
  }
  return res.json();
}

async function fetchPeerComps() {
  if (!FMP_KEY) { console.log('  [FMP] SKIPPED — no API key'); return ''; }

  console.log('  [FMP] Fetching peer comps for:', CYBER_PEERS.join(', '));

  const peerData = await Promise.all(CYBER_PEERS.map(async (ticker) => {
    try {
      const [prof, inc] = await Promise.all([
        fmpGet(`profile/${ticker}`).catch(e => { console.error(`  [FMP] profile/${ticker} failed:`, e.message); return null; }),
        fmpGet(`income-statement/${ticker}?limit=2&period=annual`).catch(e => { console.error(`  [FMP] income/${ticker} failed:`, e.message); return null; })
      ]);
      const p = prof?.[0];
      if (p) console.log(`  [FMP] ${ticker}: mktCap=$${(p.mktCap/1e9).toFixed(1)}B, price=$${p.price}`);
      return { ticker, prof: p, inc };
    } catch (e) {
      console.error(`  [FMP] ${ticker} FAILED:`, e.message);
      return { ticker, prof: null, inc: null };
    }
  }));

  let out = '\n### PUBLIC CYBERSECURITY PEER FINANCIALS (real-time from Financial Modeling Prep API)\n';
  out += 'IMPORTANT: These are REAL market data points. Use these EXACT numbers in the peer benchmarking table.\n';
  out += 'Source URL for all peer data: https://financialmodelingprep.com\n\n';

  let count = 0;
  peerData.forEach(({ ticker, prof, inc }) => {
    if (!prof) return;
    count++;
    const rev0   = inc?.[0]?.revenue;
    const rev1   = inc?.[1]?.revenue;
    const gm     = inc?.[0]?.grossProfitRatio;
    const ebitda = inc?.[0]?.ebitda;
    const growth = (rev0 && rev1) ? ((rev0 - rev1) / rev1 * 100) : null;
    const evApprox = prof.mktCap; /* simplified — most have low net debt */
    const evRev    = (evApprox && rev0) ? (evApprox / rev0) : null;
    const evEbitda = (evApprox && ebitda > 0) ? (evApprox / ebitda) : null;

    out += `${ticker} — ${prof.companyName}\n`;
    out += `  Status: Public (${prof.exchangeShortName})\n`;
    out += `  Stock Price: $${prof.price}\n`;
    out += `  Market Cap: $${(prof.mktCap / 1e9).toFixed(1)}B\n`;
    if (rev0)    out += `  Revenue (Annual): $${(rev0 / 1e6).toFixed(0)}M\n`;
    if (growth !== null) out += `  Revenue Growth YoY: ${growth.toFixed(1)}%\n`;
    if (gm !== null)     out += `  Gross Margin: ${(gm * 100).toFixed(1)}%\n`;
    if (evRev !== null)  out += `  EV/Revenue (approx): ${evRev.toFixed(1)}x\n`;
    if (evEbitda !== null) out += `  EV/EBITDA (approx): ${evEbitda.toFixed(1)}x\n`;
    if (ebitda)  out += `  EBITDA: $${(ebitda / 1e6).toFixed(0)}M\n`;
    out += `  CEO: ${prof.ceo || 'N/A'}\n`;
    out += `  Employees: ${prof.fullTimeEmployees || 'N/A'}\n`;
    out += `  Industry: ${prof.industry || 'N/A'}\n`;
    out += '\n';
  });

  console.log(`  [FMP] Peer comps complete: ${count}/${CYBER_PEERS.length} peers loaded`);
  return out;
}

/* ═══════════════════════════════════════════════════════
   RESEARCH ORCHESTRATOR
   ═══════════════════════════════════════════════════════ */

async function runResearch(company, domain, sector, mode) {
  console.log(`\n[Research] Starting for "${company}" (${domain}), mode=${mode}`);
  const isSector = mode === 'sector';

  const [tavilyCtx, peerCtx] = await Promise.all([
    (isSector
      ? tavilyResearchSector(company, domain, sector)
      : tavilyResearchCompany(company, domain, sector)
    ).catch(e => { console.error('[Research] Tavily failed:', e.message); return ''; }),
    fetchPeerComps().catch(e => { console.error('[Research] FMP failed:', e.message); return ''; })
  ]);

  const tavilyLen = tavilyCtx.length;
  const fmpLen = peerCtx.length;
  console.log(`[Research] Tavily context: ${tavilyLen} chars | FMP context: ${fmpLen} chars`);

  let context = '=== LIVE WEB RESEARCH DATA ===\n';
  context += 'This data was scraped from real web pages and financial APIs moments ago.\n\n';

  if (tavilyCtx) context += tavilyCtx;
  if (peerCtx)   context += peerCtx;

  if (!tavilyCtx && !peerCtx) {
    context += '(No research data was retrieved. All API calls failed or returned empty.)\n';
  }

  context += '\n=== END OF LIVE RESEARCH DATA ===\n';

  const stats = {
    tavilyChars: tavilyLen,
    fmpChars: fmpLen,
    totalChars: context.length
  };

  return { context, stats };
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

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'GET') {
    const filePath = path.join(__dirname, req.url === '/' ? 'cyber_intel.html' : req.url);
    try {
      const data = fs.readFileSync(filePath);
      const ext  = path.extname(filePath);
      const mime = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'text/plain';
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
        console.warn('[Research] No API keys set — returning empty');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ context: '', stats: {}, warning: 'No research API keys set' }));
        return;
      }

      const { context, stats } = await runResearch(company, domain, sector, mode);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ context, stats }));
    } catch (err) {
      console.error('[Research] FATAL:', err);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ context: '', stats: {}, error: err.message }));
    }
    return;
  }

  /* ── Anthropic proxy ───────────────────────────────── */
  if (req.method === 'POST' && req.url === '/api/messages') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      console.log(`[Claude] Calling ${parsed.model}, max_tokens=${parsed.max_tokens}, prompt length=${JSON.stringify(parsed.messages).length} chars`);

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
      console.log(`[Claude] Response: status=${response.status}, output tokens=${data.usage?.output_tokens || '?'}`);

      res.writeHead(response.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[Claude] ERROR:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404); res.end();

}).listen(PORT, () => {
  console.log(`\nCyberIntel running at http://localhost:${PORT}`);
  console.log(`  Anthropic API key: ${ANTHROPIC_KEY ? '✓ set' : '✗ MISSING'}`);
  console.log(`  Tavily API key:    ${TAVILY_KEY ? '✓ set' : '✗ MISSING'}`);
  console.log(`  FMP API key:       ${FMP_KEY ? '✓ set' : '✗ MISSING'}\n`);
});
