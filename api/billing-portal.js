// api/billing-portal.js
//
// Creates a Stripe Billing Portal session.
// The customer ID is validated server-side from the Supabase subscriptions table —
// never taken at face value from the client request.
//
// POST body: { email: string }
// Response 200: { url: string }
// Response 4xx/5xx: { error: string }
//
// Required env vars: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

'use strict';

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
    console.warn('billing-portal: Supabase lookup failed:', e.message);
    return null;
  }
}

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
  if (!stripeKey) return res.status(500).json({ error: 'Stripe not configured' });

  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Look up customer ID from Supabase — never trust the client-supplied value
  const customerId = await getCustomerIdFromSupabase(normalizedEmail);
  if (!customerId) {
    console.warn('billing-portal: no Stripe customer found for', normalizedEmail);
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

    console.log('billing-portal: portal session created for', normalizedEmail);
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('billing-portal: Stripe error:', err.message);
    return res.status(500).json({ error: 'Failed to open billing portal. Please try again.' });
  }
};
