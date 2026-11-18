// Local development server. On Vercel this file is not used: the functions in
// api/ handle requests instead. Both share lib/location-batches.js.
import http from 'node:http';
import dotenv from 'dotenv';
import { handleLocationBatch } from '../lib/location-batches.js';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/location-batches') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  let rawBody = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    rawBody += chunk;
    if (rawBody.length > 1_000_000) {
      sendJson(res, 413, { error: 'Payload too large' });
      req.destroy();
    }
  });

  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(rawBody || '{}');
    } catch {
      sendJson(res, 400, { error: 'Request body must be valid JSON.' });
      return;
    }
    const { status, body } = await handleLocationBatch(payload);
    sendJson(res, status, body);
  });
});

server.listen(PORT, () => {
  console.log(`Driver tracker backend listening on http://localhost:${PORT}`);
});
