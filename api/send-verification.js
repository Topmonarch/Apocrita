// api/send-verification.js
//
// Stores a verification token in Supabase, then sends the verification email.
//
// POST body: { email: string, token: string }
// Response 200: { ok: true }
// Response 4xx/5xx: { error: string }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM_EMAIL
//   SMTP_FROM_NAME (optional, default "Apocrita")
//   PRODUCTION_URL or VERCEL_URL

'use strict';

const RATE_LIMIT_MAX  = 3;
const RATE_WINDOW_MS  = 60 * 1000;
const _rateLimitStore = {};

function isRateLimited(email) {
  const now   = Date.now();
  const entry = _rateLimitStore[email];
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    _rateLimitStore[email] = { count: 1, windowStart: now };
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) return true;
  entry.count++;
  return false;
}

function buildVerificationUrl(req, token) {
  let base = process.env.PRODUCTION_URL;
  if (!base && process.env.VERCEL_URL) base = 'https://' + process.env.VERCEL_URL;
  if (!base) {
    const origin = req.headers['origin'] ||
      (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host']
        ? req.headers['x-forwarded-proto'] + '://' + req.headers['x-forwarded-host']
        : null);
    base = origin || 'https://Apocrita-ai.vercel.app';
  }
  return base.replace(/\/$/, '') + '/?verify=' + encodeURIComponent(token);
}

// Persist token to Supabase verification_tokens table via service role REST
async function storeToken(email, token) {
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not configured');

  const headers = {
    'Content-Type':  'application/json',
    'apikey':        key,
    'Authorization': 'Bearer ' + key,
    'Prefer':        'return=minimal'
  };

  // Delete any existing unused tokens for this email first (one active token per email)
  await fetch(
    url + '/rest/v1/verification_tokens?email=eq.' + encodeURIComponent(email) + '&used=eq.false',
    { method: 'DELETE', headers }
  );

  // Insert the new token
  const res = await fetch(url + '/rest/v1/verification_tokens', {
    method:  'POST',
    headers,
    body: JSON.stringify({ email, token })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error('Failed to store token: ' + body);
  }
}

async function sendVerificationEmail(toEmail, verifyUrl) {
  const nodemailer = require('nodemailer');
  const host       = process.env.SMTP_HOST;
  const port       = parseInt(process.env.SMTP_PORT || '587', 10);
  const user       = process.env.SMTP_USER;
  const pass       = process.env.SMTP_PASS;
  const fromEmail  = process.env.SMTP_FROM_EMAIL;
  const fromName   = process.env.SMTP_FROM_NAME || 'Apocrita';

  if (!host || !user || !pass || !fromEmail) {
    const missing = [!host && 'SMTP_HOST', !user && 'SMTP_USER', !pass && 'SMTP_PASS', !fromEmail && 'SMTP_FROM_EMAIL'].filter(Boolean);
    throw new Error('SMTP not configured — missing: ' + missing.join(', '));
  }

  const transporter = nodemailer.createTransport({
    host, port, secure: port === 465, auth: { user, pass }
  });

  const html = `
    <div style="font-family:Tahoma,Arial,sans-serif;max-width:520px;margin:0 auto;
                background:#0b0f14;color:#fff;border-radius:10px;padding:32px;
                border:1px solid #1e2530;">
      <div style="text-align:center;margin-bottom:24px;">
        <h1 style="color:#2D8CFF;letter-spacing:3px;font-size:22px;margin:0;">Apocrita</h1>
      </div>
      <h2 style="font-size:18px;margin:0 0 16px;color:#fff;">Verify your email address</h2>
      <p style="color:#aaa;font-size:14px;line-height:1.6;margin:0 0 24px;">
        Thank you for creating a Apocrita account. Click the button below to verify
        your email address and activate your account. This link expires in 24 hours.
      </p>
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${verifyUrl}"
           style="background:#2D8CFF;color:#fff;text-decoration:none;padding:12px 28px;
                  border-radius:6px;font-weight:700;font-size:15px;display:inline-block;">
          Verify Email Address
        </a>
      </div>
      <p style="color:#666;font-size:12px;line-height:1.6;margin:0 0 8px;">
        If the button doesn't work, copy and paste this link into your browser:
      </p>
      <p style="color:#2D8CFF;font-size:12px;word-break:break-all;margin:0 0 24px;">
        ${verifyUrl}
      </p>
      <p style="color:#555;font-size:12px;margin:0;">
        If you did not create this account, you can safely ignore this email.
      </p>
    </div>`;

  const text = `Apocrita — Verify your email\n\n` +
    `Click the link below to verify your email address:\n${verifyUrl}\n\n` +
    `This link expires in 24 hours.\n\n` +
    `If you did not create this account, you can safely ignore this email.`;

  return transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: toEmail,
    subject: 'Verify your Apocrita account',
    text, html
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, token } = req.body || {};

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (!token || typeof token !== 'string' || token.length < 32) {
    return res.status(400).json({ error: 'A valid verification token is required.' });
  }

  const normalized = email.trim().toLowerCase();

  if (isRateLimited(normalized)) {
    return res.status(429).json({ error: 'Too many verification emails requested. Please wait before trying again.' });
  }

  // Store token in Supabase (replaces any previous unused token for this email)
  try {
    await storeToken(normalized, token);
  } catch (err) {
    console.error('[send-verification] Token storage failed:', err.message);
    return res.status(500).json({ error: 'Could not prepare verification. Please try again.' });
  }

  const verifyUrl = buildVerificationUrl(req, token);

  try {
    const info = await sendVerificationEmail(normalized, verifyUrl);
    console.log('[send-verification] Sent to', normalized, info && info.messageId ? info.messageId : '');
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[send-verification] Email send failed:', err.message);
    return res.status(500).json({
      error: 'Your account was created, but we could not send the verification email. Please use the resend button.'
    });
  }
};
