// Vercel serverless function: GET /api/health
// Reports whether the required env vars are set, without exposing their values.
export default function handler(req, res) {
  const required = [
    'BUSINESS_CENTRAL_URL',
    'ENTRA_TENANT_ID',
    'ENTRA_CLIENT_ID',
    'ENTRA_CLIENT_SECRET',
  ];
  const missing = required.filter((name) => !process.env[name]);

  res.status(200).json({
    status: 'ok',
    configured: missing.length === 0,
    missing,
    timestamp: new Date().toISOString(),
  });
}
