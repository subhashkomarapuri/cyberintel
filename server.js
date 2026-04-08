/**
 * CyberIntel — Local Proxy Server
 * Sits between the browser and Anthropic API to bypass CORS.
 *
 * Usage (local):
 *   1. node server.js
 *   2. Open http://localhost:3000 in your browser
 *
 * Deployment (Railway):
 *   Set ANTHROPIC_API_KEY environment variable in Railway dashboard.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT    = process.env.PORT || 3000;

http.createServer(async (req, res) => {

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

  if (req.method === 'POST' && req.url === '/api/messages') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         API_KEY,
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
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();

}).listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
