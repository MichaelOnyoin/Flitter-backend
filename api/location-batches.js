// Vercel serverless function: POST /api/location-batches
// The file path under api/ is the route, so no vercel.json rewrite is needed.
import { handleLocationBatch } from '../lib/location-batches.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel's Node runtime parses JSON bodies into req.body, and the getter
  // throws on malformed JSON. A body sent without a JSON content type arrives
  // as a string or Buffer, so parse those by hand.
  let payload;
  try {
    payload = req.body;
    if (Buffer.isBuffer(payload)) payload = payload.toString('utf8');
    if (typeof payload === 'string') payload = JSON.parse(payload || '{}');
  } catch {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }

  const { status, body } = await handleLocationBatch(payload ?? {});
  return res.status(status).json(body);
}
