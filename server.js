/**
 * CyberIntel — Local Proxy Server
 * Sits between the browser and Anthropic API to bypass CORS.
 * Also runs Tavily web searches to ground reports in real data.
 *
 * Usage (local):
 *   1. node server.js
 *   2. Open http://localhost:3000 in your browser
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY  — required
 *   TAVILY_API_KEY     — required for web research
 *   PORT               — optional, defaults to 3000
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const TAVILY_KEY    = process.env.TAVILY_API_KEY || '';
const PORT          = process.env.PORT || 3000;

/* ── Tavily search helper ──────────────────────────── */
async function tavilySearch(query, opts) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key:             TAVILY_KEY,
      query:               query,
      search_depth:        opts.depth || 'advanced',
      max_results:         opts.maxResults || 5,
      include_raw_content: false,
      include_answer:      true
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily ${res.status}: ${text}`);
  }
  return res.json();
}

/* Format Tavily results into a text block for the prompt */
function formatResults(label, data) {
  if (!data || !data.results || !data.results.length) return '';
  let out = `\n### ${label}\n`;
  if (data.answer) out += `Summary: ${data.answer}\n`;
  data.results.forEach((r, i) => {
    out += `[${i + 1}] ${r.title}\n`;
    out += `    URL: ${r.url}\n`;
    if (r.content) out += `    ${r.content.slice(0, 500)}\n`;
  });
  return out;
}

/* Run all searches for a company report */
async function researchCompany(company, domain, sector) {
  const sectorTag = sector || 'cybersecurity';
  const queries = [
    { q: `${company} ${domain} company overview founded CEO executives investors`,        label: 'Company Overview & Leadership' },
    { q: `${company} funding rounds series valuation crunchbase ${sectorTag}`,             label: 'Funding & Valuation History' },
    { q: `${company} acquisitions M&A deals partnerships ${sectorTag}`,                    label: 'Acquisitions & Partnerships' },
    { q: `${company} revenue ARR growth customers ${sectorTag} 2025 2026`,                 label: 'Revenue & Growth Metrics' },
    { q: `${company} ${sectorTag} news product launches 2025 2026`,                        label: 'Recent News & Product Launches' },
    { q: `${company} competitors market position vs CrowdStrike Palo Alto ${sectorTag}`,   label: 'Competitive Landscape & Peer Benchmarking' }
  ];
  const results = await Promise.allSettled(
    queries.map(q => tavilySearch(q.q, { depth: 'advanced', maxResults: 5 }))
  );
  let context = '=== LIVE WEB RESEARCH DATA (sourced via Tavily search, grounded in real web pages) ===\n';
  context += 'Use the URLs below as citation sources. Only cite URLs that appear in this data.\n';
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      context += formatResults(queries[i].label, r.value);
    }
  });
  context += '\n=== END OF WEB RESEARCH DATA ===\n';
  return context;
}

/* Run all searches for a sector report */
async function researchSector(company, domain, sector) {
  const sectorTag = sector || 'cybersecurity';
  const queries = [
    { q: `${sectorTag} sector M&A deals acquisitions 2025 2026 YTD`,                      label: 'Sector M&A Activity 2025-2026' },
    { q: `${sectorTag} funding rounds venture capital PE deals 2025 2026`,                 label: 'Sector Financing & VC Activity' },
    { q: `${sectorTag} industry trends AI zero-trust market outlook 2026`,                 label: 'Industry Trends & Technology Shifts' },
    { q: `${sectorTag} executive moves CISO CTO leadership changes 2025 2026`,             label: 'Executive Movements' },
    { q: `${sectorTag} conferences events RSA Black Hat 2026`,                             label: 'Conferences & Events 2026' },
    { q: `${sectorTag} valuations multiples EV revenue ARR 2025 2026`,                     label: 'Valuation Multiples & Market Data' }
  ];
  const results = await Promise.allSettled(
    queries.map(q => tavilySearch(q.q, { depth: 'advanced', maxResults: 5 }))
  );
  let context = '=== LIVE WEB RESEARCH DATA (sourced via Tavily search, grounded in real web pages) ===\n';
  context += 'Use the URLs below as citation sources. Only cite URLs that appear in this data.\n';
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      context += formatResults(queries[i].label, r.value);
    }
  });
  context += '\n=== END OF WEB RESEARCH DATA ===\n';
  return context;
}

/* ── Helper: read full request body ────────────────── */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/* ── HTTP Server ───────────────────────────────────── */
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

  /* ── Research endpoint: runs Tavily searches ────── */
  if (req.method === 'POST' && req.url === '/api/research') {
    try {
      const raw  = await readBody(req);
      const body = JSON.parse(raw);
      const { company, domain, sector, mode } = body;

      if (!TAVILY_KEY) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ context: '', warning: 'TAVILY_API_KEY not set — skipping web research' }));
        return;
      }

      const context = mode === 'sector'
        ? await researchSector(company, domain, sector)
        : await researchCompany(company, domain, sector);

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ context }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message, context: '' }));
    }
    return;
  }

  /* ── Anthropic proxy ────────────────────────────── */
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
  console.log(`  Tavily API key:    ${TAVILY_KEY ? 'set' : 'MISSING (web research disabled)'}`);
});
