// Shared logic for accepting driver GPS ping batches and forwarding them to
// Business Central. Used by both the Vercel serverless function
// (api/location-batches.js) and the local dev server (src/server.js).
//
// Env vars are read at call time (not module load) so serverless cold starts
// and local dotenv loading both see the current values.

function config() {
  return {
    businessCentralUrl: process.env.BUSINESS_CENTRAL_URL || '',
    tenantId: process.env.ENTRA_TENANT_ID || '',
    clientId: process.env.ENTRA_CLIENT_ID || '',
    clientSecret: process.env.ENTRA_CLIENT_SECRET || '',
    scope: process.env.ENTRA_SCOPE || 'https://api.businesscentral.dynamics.com/.default',
  };
}

// Module-level cache survives between invocations while a serverless instance
// stays warm; a cold start simply fetches a fresh token.
let tokenCache = {
  accessToken: '',
  expiresAt: 0,
};

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

function requireConfiguredBusinessCentral(cfg) {
  if (!cfg.businessCentralUrl) {
    throw new Error('BUSINESS_CENTRAL_URL is not configured.');
  }
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) {
    throw new Error('ENTRA_TENANT_ID, ENTRA_CLIENT_ID, and ENTRA_CLIENT_SECRET are required.');
  }
}

async function getBusinessCentralToken(cfg) {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.accessToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'client_credentials',
    scope: cfg.scope,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

async function forwardToBusinessCentral(batch) {
  const cfg = config();
  requireConfiguredBusinessCentral(cfg);
  const accessToken = await getBusinessCentralToken(cfg);

  // BC's unbound action expects the batch as a JSON string in `inputJson`.
  const bcPayload = { inputJson: JSON.stringify(batch) };

  const response = await fetch(cfg.businessCentralUrl, {
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

/**
 * Validate and forward a parsed request payload.
 * Returns { status, body } so any HTTP layer can send it.
 */
export async function handleLocationBatch(payload) {
  const pings = payload && Array.isArray(payload.pings) ? payload.pings : null;

  if (!pings || pings.length === 0) {
    return { status: 400, body: { error: 'Request body must include a non-empty pings array.' } };
  }

  const invalidIndex = pings.findIndex((ping) => !validatePing(ping));
  if (invalidIndex !== -1) {
    return { status: 400, body: { error: `Invalid ping at index ${invalidIndex}.` } };
  }

  try {
    // In a real deployment, persist these pings first, then forward to BC, so
    // telemetry stays durable if the ERP is temporarily unavailable.
    const forwardResult = await forwardToBusinessCentral(payload);
    return { status: 202, body: { accepted: pings.length, businessCentral: forwardResult } };
  } catch (error) {
    console.error('[location-batches]', error);
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : 'Unexpected server error' },
    };
  }
}
