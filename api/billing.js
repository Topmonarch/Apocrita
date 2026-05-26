// api/billing.js
//
// Consolidated Stripe billing endpoint. Replaces create-checkout.js and billing-portal.js.
//
// POST ?action=checkout  { email, plan }   → create Stripe Checkout session
// POST ?action=portal    { email }         → create Stripe Billing Portal session
//
// Response 200: { url: string }
// Response 4xx/5xx: { error: string }

'use strict';

const VALID_PLANS = ['basic', 'premium', 'ultimate'];

function getBaseUrl(req) {
  if (process.env.PRODUCTION_URL) return process.env.PRODUCTION_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL)     return 'https://' + process.env.VERCEL_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.headers['host'] || 'apocrita-ai.vercel.app';
  return proto + '://' + host;
}

async function getCustomerIdFromSupabase(email) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const r = await fetch(
      url + '/rest/v1/subscriptions?email=eq.' + encodeURIComponent(email) +
      '&select=stripe_customer_id&limit=1',
      {
        headers: {
          'Content-Type':  'application/json',
          'apikey':        key,
          'Authorization': 'Bearer ' + key,
          'Prefer':        'return=representation'
        }
      }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return (Array.isArray(rows) && rows.length > 0 && rows[0].stripe_customer_id) || null;
  } catch (e) {
    console.warn('[billing] Supabase lookup failed:', e.message);
    return null;
  }
}

// ── action=checkout ──────────────────────────────────────────────────────────
async function handleCheckout(req, res) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Payment system not configured.' });

  const { email, plan } = req.body || {};

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (!plan || !VALID_PLANS.includes(plan)) {
    return res.status(400).json({ error: 'A valid plan (basic, premium, ultimate) is required.' });
  }

  const priceEnvMap = {
    basic:    process.env.STRIPE_PRICE_BASIC,
    premium:  process.env.STRIPE_PRICE_PREMIUM,
    ultimate: process.env.STRIPE_PRICE_ULTIMATE
  };
  const priceId = priceEnvMap[plan];
  if (!priceId) {
    console.error(`[billing/checkout] STRIPE_PRICE_${plan.toUpperCase()} not configured`);
    return res.status(500).json({ error: 'This plan is not currently available. Please try again later.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const base = getBaseUrl(req);

  try {
    const Stripe = require('stripe');
    const stripe = Stripe(stripeKey, { apiVersion: '2024-06-20' });

    let existingCustomerId = null;
    try {
      const existing = await stripe.customers.list({ email: normalizedEmail, limit: 1 });
      if (existing.data && existing.data.length > 0) existingCustomerId = existing.data[0].id;
    } catch (e) { /* non-fatal */ }

    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: existingCustomerId ? undefined : normalizedEmail,
      customer:       existingCustomerId || undefined,
      metadata: { plan, email: normalizedEmail },
      subscription_data: { metadata: { plan, email: normalizedEmail } },
      success_url: base + '/?upgrade_success=1&plan=' + encodeURIComponent(plan),
      cancel_url:  base + '/?upgrade_cancel=1',
      allow_promotion_codes: true,
      billing_address_collection: 'auto'
    };

    if (!existingCustomerId) delete sessionParams.customer;
    else delete sessionParams.customer_email;

    const session = await stripe.checkout.sessions.create(sessionParams);
    console.log(`[billing/checkout] session created for ${normalizedEmail} plan=${plan}`);
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[billing/checkout] Stripe error:', err.message);
    return res.status(500).json({ error: 'Could not initiate checkout. Please try again.' });
  }
}

// ── action=portal ────────────────────────────────────────────────────────────
async function handlePortal(req, res) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Stripe not configured' });

  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const customerId = await getCustomerIdFromSupabase(normalizedEmail);
  if (!customerId) {
    console.warn('[billing/portal] no Stripe customer found for', normalizedEmail);
    return res.status(404).json({
      error: 'No billing account found for this email. Please upgrade to a paid plan first.'
    });
  }

  try {
    const Stripe = require('stripe');
    const stripe = Stripe(stripeKey, { apiVersion: '2024-06-20' });
    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: getBaseUrl(req) + '/?portal=return'
    });
    console.log('[billing/portal] portal session created for', normalizedEmail);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[billing/portal] Stripe error:', err.message);
    return res.status(500).json({ error: 'Failed to open billing portal. Please try again.' });
  }
}

// ── Router ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = (req.query && req.query.action) || '';

  if (action === 'checkout') return handleCheckout(req, res);
  if (action === 'portal')   return handlePortal(req, res);

  return res.status(400).json({ error: 'Invalid action. Use ?action=checkout or ?action=portal' });
};
