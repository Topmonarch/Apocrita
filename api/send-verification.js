// api/send-verification.js — Serverless handler for /api/send-verification
//
// Sends a verification email to a newly registered user.
// Requires SMTP environment variables:
//   SMTP_HOST       — SMTP server hostname (e.g. smtp.mailgun.org)
//   SMTP_PORT       — SMTP server port (e.g. 587)
//   SMTP_USER       — SMTP username / login
//   SMTP_PASS       — SMTP password / secret
//   SMTP_FROM_EMAIL — Verified sender email address
//   SMTP_FROM_NAME  — Display name for the sender (optional, defaults to "Hymenoptera")
//   PRODUCTION_URL  — Production domain (e.g. https://hymenoptera-ai.vercel.app)
//                     Falls back to VERCEL_URL if not set.
//
// POST body: { email: string, token: string }
// Response 200: { ok: true }
// Response 4xx/5xx: { error: string }

'use strict';

// In-memory rate-limit store: email -> { count, windowStart }
// Resets every RATE_WINDOW_MS per email.
const _rateLimitStore = {};
const RATE_LIMIT_MAX = 3;        // max sends per window per email
const RATE_WINDOW_MS = 60 * 1000; // 1 minute window

function isRateLimited(email) {
  const now = Date.now();
  const entry = _rateLimitStore[email];

  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    _rateLimitStore[email] = { count: 1, windowStart: now };
    return false;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return true;
  }

  entry.count++;
  return false;
}

/**
 * Build the production verification URL.
 * Priority: PRODUCTION_URL env var > VERCEL_URL env var > request Origin header.
 *
 * @param {object} req  - Incoming HTTP request
 * @param {string} token - Verification token to embed
 * @returns {string} Full verification URL
 */
function buildVerificationUrl(req, token) {
  let base = process.env.PRODUCTION_URL;

  if (!base && process.env.VERCEL_URL) {
    base = 'https://' + process.env.VERCEL_URL;
  }

  if (!base) {
    // Fall back to request origin so the link at least points to the same host
    const origin = req.headers['origin'] ||
      (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host']
        ? req.headers['x-forwarded-proto'] + '://' + req.headers['x-forwarded-host']
        : null);
    base = origin || 'https://hymenoptera-ai.vercel.app';
  }

  // Strip trailing slash
  base = base.replace(/\/$/, '');

  return `${base}/?verify=${encodeURIComponent(token)}`;
}

/**
 * Send a verification email using SMTP via Nodemailer.
 *
 * @param {string} toEmail      - Recipient email address
 * @param {string} verifyUrl    - Full verification URL to embed in the email
 * @returns {Promise<void>}     - Resolves on success, throws on failure
 */
async function sendVerificationEmail(toEmail, verifyUrl) {
  const nodemailer = require('nodemailer');

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const fromEmail = process.env.SMTP_FROM_EMAIL;
  const fromName = process.env.SMTP_FROM_NAME || 'Hymenoptera';

  if (!host || !user || !pass || !fromEmail) {
    const missing = [];
    if (!host) missing.push('SMTP_HOST');
    if (!user) missing.push('SMTP_USER');
    if (!pass) missing.push('SMTP_PASS');
    if (!fromEmail) missing.push('SMTP_FROM_EMAIL');
    throw new Error(`SMTP not configured — missing: ${missing.join(', ')}`);
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  const htmlBody = `
    <div style="font-family:Tahoma,Arial,sans-serif;max-width:520px;margin:0 auto;background:#0b0f14;color:#fff;border-radius:10px;padding:32px;border:1px solid #1e2530;">
      <div style="text-align:center;margin-bottom:24px;">
        <h1 style="color:#2D8CFF;letter-spacing:3px;font-size:22px;margin:0;">HYMENOPTERA</h1>
      </div>
      <h2 style="font-size:18px;margin:0 0 16px;color:#fff;">Verify your email address</h2>
      <p style="color:#aaa;font-size:14px;line-height:1.6;margin:0 0 24px;">
        Thank you for creating a Hymenoptera account. Click the button below to verify your email address and activate your account.
      </p>
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${verifyUrl}" style="background:#2D8CFF;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:700;font-size:15px;display:inline-block;">
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
    </div>
  `;

  const textBody = `Hymenoptera — Verify your email\n\nClick the link below to verify your email address:\n${verifyUrl}\n\nIf you did not create this account, you can safely ignore this email.`;

  const info = await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: toEmail,
    subject: 'Verify your Hymenoptera account',
    text: textBody,
    html: htmlBody
  });

  return info;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, token } = req.body || {};

  // --- Input validation ---
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    console.warn('[send-verification] Invalid email in request body');
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  if (!token || typeof token !== 'string' || token.length < 8) {
    console.warn('[send-verification] Invalid or missing token in request body');
    return res.status(400).json({ error: 'A valid verification token is required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  console.log(`[send-verification] Signup request received for: ${normalizedEmail}`);

  // --- Rate limiting ---
  if (isRateLimited(normalizedEmail)) {
    console.warn(`[send-verification] Rate limit exceeded for: ${normalizedEmail}`);
    return res.status(429).json({ error: 'Too many verification emails requested. Please wait a moment before trying again.' });
  }

  // --- Build verification URL ---
  const verifyUrl = buildVerificationUrl(req, token);
  console.log(`[send-verification] Verification URL generated: ${verifyUrl}`);

  // --- Send email ---
  console.log(`[send-verification] Sending verification email to: ${normalizedEmail}`);

  try {
    const info = await sendVerificationEmail(normalizedEmail, verifyUrl);
    console.log(`[send-verification] Email sent successfully to: ${normalizedEmail}`, info && info.messageId ? `messageId=${info.messageId}` : '');
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[send-verification] Failed to send verification email to: ${normalizedEmail} — ${err.message}`);
    return res.status(500).json({
      error: 'Your account was created, but we could not send the verification email. Please try again or use the resend option.'
    });
  }
};
