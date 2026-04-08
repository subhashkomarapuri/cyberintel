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

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const TAVILY_KEY    = process.env.TAVILY_API_KEY || '';
const FMP_KEY       = process.env.FMP_API_KEY || '';
const PORT          = process.env.PORT || 3000;

/* Max research context to inject into prompt (chars).
   Keep under ~40K chars (~10K tokens) to leave room for prompt + output */
const MAX_CONTEXT_CHARS = 25000;

/* ─── Portable HTTPS fetch (works reliably on Railway/Node 18) ─── */

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, body: raw });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out (30s)')); });
    req.write(body);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 15000
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, body: raw });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out (15s)')); });
    req.end();
  });
}

/* ─── Tavily ──────────────────────────────────────────── */

async function tavilySearch(query, maxResults) {
  const payload = {
    query:          query,
    search_depth:   'basic',
    max_results:    maxResults || 5,
    include_answer: true
  };
  const shortQuery = query.length > 70 ? query.slice(0, 70) + '…' : query;
  console.log(`  [Tavily] "${shortQuery}"`);

  try {
    const res = await httpsPost('https://api.tavily.com/search', {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + TAVILY_KEY
    }, JSON.stringify(payload));

    if (res.status !== 200) {
      console.error(`  [Tavily] HTTP ${res.status}: ${res.body.slice(0, 300)}`);
      return null;
    }

    const data = JSON.parse(res.body);
    console.log(`  [Tavily] → ${data.results?.length || 0} results`);
    return data;
  } catch (err) {
    console.error(`  [Tavily] NETWORK ERROR: ${err.message}`);
    return null;
  }
}

function formatTavily(label, data) {
  if (!data || !data.results || !data.results.length) return '';
  let out = `\n### ${label}\n`;
  if (data.answer) out += `Summary: ${data.answer}\n\n`;
  data.results.forEach((r, i) => {
    out += `[${i + 1}] ${r.title}\n`;
    out += `    URL: ${r.url}\n`;
    if (r.content) out += `    ${r.content.slice(0, 600)}\n`;
    out += '\n';
  });
  return out;
}

function companyQueries(company, domain, sector) {
  const s = sector || 'cybersecurity';
  return [
    { q: `${company} company founded CEO headquarters investors crunchbase`,     label: 'Company Profile & Leadership' },
    { q: `${company} funding rounds series valuation raised investors`,           label: 'Funding Rounds & Valuation' },
    { q: `${company} acquisitions mergers partnerships deals`,                    label: 'Acquisitions & Partnerships' },
    { q: `${company} revenue ARR growth customers ${s}`,                          label: 'Revenue & Growth Metrics' },
    { q: `${company} ${s} news product launch 2025 2026`,                         label: 'Recent News & Launches' },
    { q: `${company} competitors market position ${s}`,                           label: 'Competitive Position' }
  ];
}

function sectorQueries(company, domain, sector) {
  const s = sector || 'cybersecurity';
  return [
    { q: `${s} M&A acquisitions deals 2025 2026`,                                label: 'Sector M&A Activity' },
    { q: `${s} funding venture capital deals 2025 2026`,                          label: 'Sector VC & PE Activity' },
    { q: `${s} industry trends AI market outlook 2026`,                           label: 'Industry Trends' },
    { q: `${s} CISO executive moves leadership 2025 2026`,                        label: 'Executive Movements' },
    { q: `${s} conferences RSA Black Hat 2026`,                                   label: 'Conferences & Events' },
    { q: `${s} valuations multiples EV revenue 2025 2026`,                        label: 'Valuation Multiples' }
  ];
}

async function runTavily(queries) {
  if (!TAVILY_KEY) { console.log('  [Tavily] SKIPPED — no key'); return ''; }
  const results = await Promise.allSettled(
    queries.map(q => tavilySearch(q.q, 5))
  );
  let out = '';
  let successCount = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      const text = formatTavily(queries[i].label, r.value);
      out += text;
      if (text) successCount++;
    } else if (r.status === 'rejected') {
      console.error(`  [Tavily] Query "${queries[i].label}" REJECTED: ${r.reason}`);
    }
  });
  console.log(`  [Tavily] ${successCount}/${queries.length} queries returned data`);
  return out;
}

/* ─── FMP ─────────────────────────────────────────────── */

const PEERS = ['CRWD', 'PANW', 'S', 'ZS', 'FTNT', 'OKTA', 'NET'];

async function fmpGet(ep) {
  const sep = ep.includes('?') ? '&' : '?';
  const url = `https://financialmodelingprep.com/api/v3/${ep}${sep}apikey=${FMP_KEY}`;
  try {
    const res = await httpsGet(url);
    if (res.status !== 200) {
      console.error(`  [FMP] HTTP ${res.status} for ${ep}: ${res.body.slice(0, 200)}`);
      return null;
    }
    return JSON.parse(res.body);
  } catch (err) {
    console.error(`  [FMP] ERROR for ${ep}: ${err.message}`);
    return null;
  }
}

async function fetchPeers() {
  if (!FMP_KEY) { console.log('  [FMP] SKIPPED — no key'); return ''; }
  console.log('  [FMP] Fetching:', PEERS.join(', '));

  const data = await Promise.all(PEERS.map(async (t) => {
    const [prof, inc] = await Promise.all([
      fmpGet(`profile/${t}`).catch(() => null),
      fmpGet(`income-statement/${t}?limit=2&period=annual`).catch(() => null)
    ]);
    return { t, p: prof?.[0] || null, inc: inc || null };
  }));

  let out = '\n### PUBLIC PEER FINANCIALS (real-time from financialmodelingprep.com)\n';
  out += 'Use these EXACT numbers in the peer table. Source: https://financialmodelingprep.com\n\n';
  let n = 0;

  data.forEach(({ t, p, inc }) => {
    if (!p) return;
    n++;
    const r0 = inc?.[0]?.revenue;
    const r1 = inc?.[1]?.revenue;
    const gm = inc?.[0]?.grossProfitRatio;
    const eb = inc?.[0]?.ebitda;
    const gr = (r0 && r1) ? ((r0 - r1) / r1 * 100) : null;
    const evr = (p.mktCap && r0) ? (p.mktCap / r0) : null;

    out += `${t} (${p.companyName})\n`;
    out += `  Price: $${p.price} | Mkt Cap: $${(p.mktCap / 1e9).toFixed(1)}B\n`;
    if (r0)         out += `  Revenue: $${(r0 / 1e6).toFixed(0)}M\n`;
    if (gr !== null) out += `  Rev Growth: ${gr.toFixed(1)}%\n`;
    if (gm !== null) out += `  Gross Margin: ${(gm * 100).toFixed(1)}%\n`;
    if (evr)         out += `  EV/Rev: ${evr.toFixed(1)}x\n`;
    if (eb)          out += `  EBITDA: $${(eb / 1e6).toFixed(0)}M\n`;
    out += `  CEO: ${p.ceo || 'N/A'} | Employees: ${p.fullTimeEmployees || 'N/A'}\n\n`;
  });
  console.log(`  [FMP] Loaded ${n}/${PEERS.length} peers`);
  return out;
}

/* ─── Health Check — tests both APIs ─────────────────── */

async function healthCheck() {
  const results = {
    tavily: { configured: !!TAVILY_KEY, keyPrefix: TAVILY_KEY ? TAVILY_KEY.slice(0, 8) + '...' : '(not set)', status: 'untested', detail: '' },
    fmp:    { configured: !!FMP_KEY,    keyPrefix: FMP_KEY ? FMP_KEY.slice(0, 6) + '...' : '(not set)', status: 'untested', detail: '' },
    anthropic: { configured: !!ANTHROPIC_KEY, keyPrefix: ANTHROPIC_KEY ? ANTHROPIC_KEY.slice(0, 8) + '...' : '(not set)', status: 'configured' }
  };

  /* Test Tavily */
  if (TAVILY_KEY) {
    try {
      const payload = JSON.stringify({ query: 'cybersecurity market 2026', search_depth: 'basic', max_results: 1, include_answer: false });
      const res = await httpsPost('https://api.tavily.com/search', {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TAVILY_KEY
      }, payload);
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        results.tavily.status = 'ok';
        results.tavily.detail = `${data.results?.length || 0} results returned`;
      } else {
        results.tavily.status = 'error';
        results.tavily.detail = `HTTP ${res.status}: ${res.body.slice(0, 300)}`;
      }
    } catch (err) {
      results.tavily.status = 'error';
      results.tavily.detail = `Network error: ${err.message}`;
    }
  }

  /* Test FMP */
  if (FMP_KEY) {
    try {
      const res = await httpsGet(`https://financialmodelingprep.com/api/v3/profile/AAPL?apikey=${FMP_KEY}`);
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (Array.isArray(data) && data.length > 0 && data[0].companyName) {
          results.fmp.status = 'ok';
          results.fmp.detail = `Got ${data[0].companyName}, price=$${data[0].price}`;
        } else {
          results.fmp.status = 'error';
          results.fmp.detail = `Unexpected response: ${res.body.slice(0, 200)}`;
        }
      } else {
        results.fmp.status = 'error';
        results.fmp.detail = `HTTP ${res.status}: ${res.body.slice(0, 300)}`;
      }
    } catch (err) {
      results.fmp.status = 'error';
      results.fmp.detail = `Network error: ${err.message}`;
    }
  }

  return results;
}

/* ─── Research orchestrator ───────────────────────────── */

async function research(company, domain, sector, mode) {
  console.log(`\n[Research] ${company} (${domain}), mode=${mode}`);
  const queries = mode === 'sector'
    ? sectorQueries(company, domain, sector)
    : companyQueries(company, domain, sector);

  const [tavily, fmp] = await Promise.all([
    runTavily(queries).catch(e => { console.error('[Tavily] FAIL:', e.message); return ''; }),
    fetchPeers().catch(e => { console.error('[FMP] FAIL:', e.message); return ''; })
  ]);

  let ctx = '=== LIVE WEB RESEARCH DATA ===\n';
  ctx += 'Scraped from real web pages and financial APIs. Use exact numbers and cite URLs.\n\n';
  if (tavily) ctx += tavily;
  if (fmp)    ctx += fmp;
  if (!tavily && !fmp) ctx += '(No data retrieved — use training knowledge.)\n';
  ctx += '\n=== END RESEARCH DATA ===\n';

  /* Truncate if too large */
  if (ctx.length > MAX_CONTEXT_CHARS) {
    console.log(`[Research] Truncating context from ${ctx.length} to ${MAX_CONTEXT_CHARS}`);
    ctx = ctx.slice(0, MAX_CONTEXT_CHARS) + '\n… (truncated)\n=== END RESEARCH DATA ===\n';
  }

  console.log(`[Research] Done — tavily: ${tavily.length} chars, fmp: ${fmp.length} chars, total: ${ctx.length} chars`);
  return {
    context: ctx,
    stats: { tavilyChars: tavily.length, fmpChars: fmp.length, totalChars: ctx.length }
  };
}

/* ─── HTTP Server ─────────────────────────────────────── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  /* CORS */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  /* Health check */
  if (req.method === 'GET' && req.url === '/api/health') {
    try {
      const result = await healthCheck();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(result, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  /* Static files */
  if (req.method === 'GET') {
    const fp = path.join(__dirname, req.url === '/' ? 'cyber_intel.html' : req.url);
    try {
      const data = fs.readFileSync(fp);
      const ext = path.extname(fp);
      const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': ct });
      return res.end(data);
    } catch { res.writeHead(404); return res.end('Not found'); }
  }

  /* Research */
  if (req.method === 'POST' && req.url === '/api/research') {
    try {
      const body = JSON.parse(await readBody(req));
      const result = await research(body.company || '', body.domain || '', body.sector || '', body.mode || 'company');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[Research] ERROR:', err.message);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ context: '', stats: { tavilyChars: 0, fmpChars: 0, totalChars: 0 }, error: err.message }));
    }
  }

  /* Anthropic proxy — uses native https.request for reliability */
  if (req.method === 'POST' && req.url === '/api/messages') {
    const body = await readBody(req);
    console.log(`[Claude] Prompt size: ${body.length} chars`);

    const opts = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(body)
      },
      timeout: 600000 /* 10 min */
    };

    const proxy = https.request(opts, (upstream) => {
      const chunks = [];
      upstream.on('data', c => chunks.push(c));
      upstream.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const data = JSON.parse(raw);
          console.log(`[Claude] Status: ${upstream.statusCode}, tokens: ${data.usage?.input_tokens || '?'}in/${data.usage?.output_tokens || '?'}out`);
        } catch(e) { console.log(`[Claude] Status: ${upstream.statusCode}, raw: ${raw.slice(0, 200)}`); }
        res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(raw);
      });
    });

    proxy.on('error', (err) => {
      console.error('[Claude] NETWORK ERROR:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: { message: 'Anthropic API unreachable: ' + err.message } }));
    });

    proxy.on('timeout', () => {
      console.error('[Claude] TIMEOUT after 10min');
      proxy.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: { message: 'Anthropic API timed out (10 min). Try a shorter prompt or smaller company.' } }));
    });

    proxy.write(body);
    proxy.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, async () => {
  console.log(`\nCyberIntel → http://localhost:${PORT}`);
  console.log(`  Anthropic: ${ANTHROPIC_KEY ? 'OK (' + ANTHROPIC_KEY.slice(0, 8) + '...)' : 'MISSING'}`);
  console.log(`  Tavily:    ${TAVILY_KEY ? 'OK (' + TAVILY_KEY.slice(0, 8) + '...)' : 'MISSING'}`);
  console.log(`  FMP:       ${FMP_KEY ? 'OK (' + FMP_KEY.slice(0, 6) + '...)' : 'MISSING'}`);

  /* Startup API validation */
  console.log('\n  Running startup API checks...');
  try {
    const health = await healthCheck();
    console.log(`  Tavily:  ${health.tavily.status} — ${health.tavily.detail || '(not configured)'}`);
    console.log(`  FMP:     ${health.fmp.status} — ${health.fmp.detail || '(not configured)'}`);
    if (health.tavily.status === 'error') console.log(`  ⚠ Tavily key may be invalid or expired. Check TAVILY_API_KEY env var.`);
    if (health.fmp.status === 'error')    console.log(`  ⚠ FMP key may be invalid or expired. Check FMP_API_KEY env var.`);
  } catch (err) {
    console.error('  Health check failed:', err.message);
  }
  console.log('');
});
