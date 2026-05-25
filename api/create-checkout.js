// api/create-checkout.js
//
// Creates a server-side Stripe Checkout Session for plan upgrades.
// The session embeds the plan name and user email in metadata so the
// webhook handler can reliably activate the correct plan without any
// client-side claim being trusted.
//
// POST body: { email: string, plan: 'basic' | 'premium' | 'ultimate' }
// Response 200: { url: string }   — redirect user to this Stripe-hosted URL
// Response 4xx/5xx: { error: string }
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_PRICE_BASIC, STRIPE_PRICE_PREMIUM, STRIPE_PRICE_ULTIMATE
//   PRODUCTION_URL or VERCEL_URL  (for success/cancel redirect URLs)

'use strict';

const VALID_PLANS = ['basic', 'premium', 'ultimate'];

function getBaseUrl(req) {
  if (process.env.PRODUCTION_URL) return process.env.PRODUCTION_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL)     return 'https://' + process.env.VERCEL_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.headers['host'] || 'Apocrita-ai.vercel.app';
  return proto + '://' + host;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Payment system not configured.' });

  const { email, plan } = req.body || {};

  // --- Input validation ---
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (!plan || !VALID_PLANS.includes(plan)) {
    return res.status(400).json({ error: 'A valid plan (basic, premium, ultimate) is required.' });
  }

  // Map plan to Stripe price ID from env vars
  const priceEnvMap = {
    basic:    process.env.STRIPE_PRICE_BASIC,
    premium:  process.env.STRIPE_PRICE_PREMIUM,
    ultimate: process.env.STRIPE_PRICE_ULTIMATE
  };
  const priceId = priceEnvMap[plan];
  if (!priceId) {
    console.error(`create-checkout: STRIPE_PRICE_${plan.toUpperCase()} not configured`);
    return res.status(500).json({ error: 'This plan is not currently available. Please try again later.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const base = getBaseUrl(req);

  try {
    const Stripe = require('stripe');
    const stripe = Stripe(stripeKey, { apiVersion: '2024-06-20' });

    // Check if a Stripe customer already exists for this email to avoid duplicates
    let existingCustomerId = null;
    try {
      const existing = await stripe.customers.list({ email: normalizedEmail, limit: 1 });
      if (existing.data && existing.data.length > 0) {
        existingCustomerId = existing.data[0].id;
      }
    } catch (e) {
      // Non-fatal — proceed without pre-existing customer
    }

    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      // Pre-fill email and link to existing customer if possible
      customer_email: existingCustomerId ? undefined : normalizedEmail,
      customer:       existingCustomerId || undefined,
      // Embed plan + email in metadata — webhook reads this as authoritative source of plan
      metadata: { plan, email: normalizedEmail },
      subscription_data: {
        metadata: { plan, email: normalizedEmail }
      },
      // Redirect URLs
      success_url: base + '/?upgrade_success=1&plan=' + encodeURIComponent(plan),
      cancel_url:  base + '/?upgrade_cancel=1',
      // Allow promo codes on the hosted page
      allow_promotion_codes: true,
      // Collect billing address for tax compliance
      billing_address_collection: 'auto',
    };

    // Remove undefined keys (Stripe SDK rejects them)
    if (!existingCustomerId) delete sessionParams.customer;
    else delete sessionParams.customer_email;

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(`create-checkout: session created for ${normalizedEmail} plan=${plan} session=${session.id}`);
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('create-checkout: Stripe error:', err.message);
    return res.status(500).json({ error: 'Could not initiate checkout. Please try again.' });
  }
};
