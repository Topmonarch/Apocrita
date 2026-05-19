// api/verify-email.js
//
// Validates a verification token and marks the user's account as verified in Supabase.
//
// GET  /?token=<hex>
// POST { token: string }
//
// Response 200: { ok: true, email: string }
// Response 4xx/5xx: { error: string, expired?: true }

'use strict';

async function sbFetch(path, options) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not configured');

  const headers = Object.assign({
    'Content-Type':  'application/json',
    'apikey':        key,
    'Authorization': 'Bearer ' + key
  }, options.headers || {});

  return fetch(url + path, Object.assign({}, options, { headers }));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Accept token from query string (GET) or body (POST)
  const token = req.method === 'GET'
    ? (req.query && req.query.token)
    : (req.body && req.body.token);

  if (!token || typeof token !== 'string' || token.length < 32) {
    return res.status(400).json({ error: 'A valid verification token is required.' });
  }

  // Look up the token
  const lookupRes = await sbFetch(
    '/rest/v1/verification_tokens?token=eq.' + encodeURIComponent(token) +
    '&select=id,email,used,expires_at',
    { method: 'GET', headers: { 'Prefer': 'return=representation' } }
  );

  const rows = await lookupRes.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(404).json({ error: 'Verification link is invalid or has already been used.' });
  }

  const row = rows[0];

  if (row.used) {
    return res.status(409).json({ error: 'This verification link has already been used.' });
  }

  if (new Date(row.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Verification link expired.', expired: true });
  }

  const email = row.email;

  // Mark token as used
  await sbFetch(
    '/rest/v1/verification_tokens?id=eq.' + encodeURIComponent(row.id),
    {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ used: true })
    }
  );

  // Mark email_verified = true in profiles table
  // Use upsert so it works even if profile row was never created
  const upsertRes = await sbFetch('/rest/v1/profiles', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ email, email_verified: true, updated_at: new Date().toISOString() })
  });

  if (!upsertRes.ok) {
    console.warn('[verify-email] Profile upsert non-2xx for', email, upsertRes.status);
    // Non-fatal: token still marked used — account can still be accessed
  }

  console.log('[verify-email] Verified:', email);
  return res.status(200).json({ ok: true, email });
};
