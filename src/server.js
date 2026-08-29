import http from 'node:http';
import dotenv from "dotenv";
//require("dotenv").config();

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const BUSINESS_CENTRAL_URL = process.env.BUSINESS_CENTRAL_URL || '';
const ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID || '';
const ENTRA_CLIENT_ID = process.env.ENTRA_CLIENT_ID || '';
const ENTRA_CLIENT_SECRET = process.env.ENTRA_CLIENT_SECRET || '';
const ENTRA_SCOPE = process.env.ENTRA_SCOPE || 'https://api.businesscentral.dynamics.com/.default';

let tokenCache = {
  accessToken: '',
  expiresAt: 0,
};

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validatePing(ping) {
  return (
    ping &&
    isString(ping.id) &&
    isString(ping.tripId) &&
    isString(ping.driverId) &&
    isNumber(ping.latitude) &&
    isNumber(ping.longitude) &&
    isString(ping.capturedAt)
  );
}

function requireConfiguredBusinessCentral() {
  if (!BUSINESS_CENTRAL_URL) {
    throw new Error('BUSINESS_CENTRAL_URL is not configured.');
  }
  if (!ENTRA_TENANT_ID || !ENTRA_CLIENT_ID || !ENTRA_CLIENT_SECRET) {
    throw new Error('ENTRA_TENANT_ID, ENTRA_CLIENT_ID, and ENTRA_CLIENT_SECRET are required.');
  }
}

async function getBusinessCentralToken() {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.accessToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: ENTRA_CLIENT_ID,
    client_secret: ENTRA_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: ENTRA_SCOPE,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`Entra token request failed with HTTP ${response.status}${message ? `: ${message}` : ''}`);
  }

  const data = await response.json();
  if (!data.access_token || typeof data.access_token !== 'string') {
    throw new Error('Entra token response did not include access_token.');
  }

  const expiresIn = Number(data.expires_in || 3600);
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + Math.max(0, expiresIn) * 1000,
  };

  return tokenCache.accessToken;
}

//gemini fix
async function forwardToBusinessCentral(batch) {
  requireConfiguredBusinessCentral();
  const accessToken = await getBusinessCentralToken();

  // Wrap and stringify the incoming clean batch object to match BC's parameter expectations
  const bcPayload = {
    inputJson: JSON.stringify(batch)
  };

  const response = await fetch(BUSINESS_CENTRAL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(bcPayload),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`Business Central forward failed with HTTP ${response.status}${message ? `: ${message}` : ''}`);
  }

  return { skipped: false };
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/location-batches') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  let rawBody = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    rawBody += chunk;
    if (rawBody.length > 1_000_000) {
      req.destroy();
    }
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(rawBody || '{}');
      const pings = Array.isArray(payload.pings) ? payload.pings : null;

      if (!pings || pings.length === 0) {
        sendJson(res, 400, { error: 'Request body must include a non-empty pings array.' });
        return;
      }

      const invalidIndex = pings.findIndex((ping) => !validatePing(ping));
      if (invalidIndex !== -1) {
        sendJson(res, 400, { error: `Invalid ping at index ${invalidIndex}.` });
        return;
      }

      // In a real deployment, persist these pings first, then forward a normalized
      // summary or event to Business Central. This keeps GPS telemetry durable even
      // if the downstream ERP is temporarily unavailable.
      const forwardResult = await forwardToBusinessCentral(payload);

      sendJson(res, 202, {
        accepted: pings.length,
        businessCentral: forwardResult,
      });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : 'Unexpected server error',
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Driver tracker backend listening on http://localhost:${PORT}`);
});
