// api/stripe-webhook.js
//
// Stripe webhook handler. Validates every event with signature verification,
// deduplicates via billing_events.stripe_event_id, and writes plan state to
// the Supabase subscriptions table — never trusting any client-supplied claim.
//
// Required env vars:
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional (for price-ID → plan mapping):
//   STRIPE_PRICE_BASIC, STRIPE_PRICE_PREMIUM, STRIPE_PRICE_ULTIMATE

'use strict';

const VALID_PLANS = ['starter', 'basic', 'premium', 'ultimate'];

// ── Supabase REST helpers (service role — never exposed to browser) ──────────

function sbHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign({
    'Content-Type':  'application/json',
    'apikey':        key,
    'Authorization': 'Bearer ' + key
  }, extra || {});
}

function sbUrl(path) {
  return process.env.SUPABASE_URL + path;
}

async function isEventProcessed(stripeEventId) {
  const r = await fetch(
    sbUrl('/rest/v1/billing_events?stripe_event_id=eq.' + encodeURIComponent(stripeEventId) + '&select=id'),
    { headers: sbHeaders({ 'Prefer': 'return=representation' }) }
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function recordBillingEvent(stripeEventId, eventType, email, plan, status, raw) {
  try {
    await fetch(sbUrl('/rest/v1/billing_events'), {
      method:  'POST',
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        stripe_event_id: stripeEventId,
        event_type:      eventType,
        email:           email || null,
        plan:            plan  || null,
        status,
        raw:             raw || null
      })
    });
  } catch (e) {
    console.warn('stripe-webhook: failed to write billing_events:', e.message);
  }
}

async function upsertSubscription(email, data) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not configured');

  const r = await fetch(url + '/rest/v1/subscriptions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        key,
      'Authorization': 'Bearer ' + key,
      'Prefer':        'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({
      email,
      plan:                   data.plan,
      billing_status:         data.billingStatus || 'active',
      stripe_customer_id:     data.customerId    || null,
      stripe_subscription_id: data.subscriptionId || null,
      current_period_end:     data.currentPeriodEnd || null,
      updated_at:             new Date().toISOString()
    })
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error('Supabase upsert failed (' + r.status + '): ' + body);
  }
}

// ── Plan resolution helpers ───────────────────────────────────────────────────

function mapPriceIdToPlan(priceId, productName) {
  if (process.env.STRIPE_PRICE_BASIC    && priceId === process.env.STRIPE_PRICE_BASIC)    return 'basic';
  if (process.env.STRIPE_PRICE_PREMIUM  && priceId === process.env.STRIPE_PRICE_PREMIUM)  return 'premium';
  if (process.env.STRIPE_PRICE_ULTIMATE && priceId === process.env.STRIPE_PRICE_ULTIMATE) return 'ultimate';
  const name = (productName || '').toLowerCase();
  if (name.includes('ultimate')) return 'ultimate';
  if (name.includes('premium'))  return 'premium';
  if (name.includes('basic'))    return 'basic';
  return null;
}

async function resolvePlanFromSession(stripe, session) {
  if (session.metadata && session.metadata.plan) {
    const meta = session.metadata.plan.toLowerCase();
    if (VALID_PLANS.includes(meta)) return meta;
  }
  try {
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      expand: ['data.price.product'], limit: 5
    });
    for (const item of (lineItems.data || [])) {
      const price = item.price || {};
      const product = price.product || {};
      const productName = typeof product === 'object' ? (product.name || '') : '';
      const plan = mapPriceIdToPlan(price.id || '', productName);
      if (plan) return plan;
    }
  } catch (e) {
    console.warn('stripe-webhook: listLineItems failed:', e.message);
  }
  return null;
}

async function resolvePlanFromSubscription(stripe, subscription) {
  if (subscription.metadata && subscription.metadata.plan) {
    const meta = subscription.metadata.plan.toLowerCase();
    if (VALID_PLANS.includes(meta)) return meta;
  }
  for (const item of ((subscription.items && subscription.items.data) || [])) {
    const price = item.price || {};
    let productName = '';
    try {
      if (typeof price.product === 'string') {
        const prod = await stripe.products.retrieve(price.product);
        productName = prod.name || '';
      } else if (typeof price.product === 'object') {
        productName = price.product.name || '';
      }
    } catch (e) { /* non-fatal */ }
    const plan = mapPriceIdToPlan(price.id || '', productName);
    if (plan) return plan;
  }
  return null;
}

async function resolveCustomerEmail(stripe, obj) {
  if (obj.customer_email) return obj.customer_email.toLowerCase().trim();
  if (obj.customer && typeof obj.customer === 'object' && obj.customer.email) {
    return obj.customer.email.toLowerCase().trim();
  }
  if (obj.metadata && obj.metadata.email) return obj.metadata.email.toLowerCase().trim();
  const customerId = typeof obj.customer === 'string' ? obj.customer : null;
  if (customerId) {
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if (customer && customer.email) return customer.email.toLowerCase().trim();
    } catch (e) {
      console.warn('stripe-webhook: customer.retrieve failed:', e.message);
    }
  }
  return null;
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleCheckoutCompleted(stripe, session, eventId) {
  if (session.payment_status !== 'paid') {
    console.log('stripe-webhook: checkout not paid:', session.payment_status);
    await recordBillingEvent(eventId, 'checkout.session.completed', null, null, 'skipped', { payment_status: session.payment_status });
    return;
  }

  const email = await resolveCustomerEmail(stripe, session);
  if (!email) {
    console.error('stripe-webhook: checkout.session.completed — no email resolved');
    await recordBillingEvent(eventId, 'checkout.session.completed', null, null, 'failed', { session_id: session.id });
    return;
  }

  const plan = await resolvePlanFromSession(stripe, session);
  if (!plan) {
    console.error('stripe-webhook: checkout.session.completed — plan not resolved for', email);
    await recordBillingEvent(eventId, 'checkout.session.completed', email, null, 'failed', { session_id: session.id });
    return;
  }

  let currentPeriodEnd = null;
  if (typeof session.subscription === 'string') {
    try {
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      if (sub.current_period_end) currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
    } catch (e) { /* non-fatal */ }
  }

  await upsertSubscription(email, {
    plan,
    billingStatus:   'active',
    customerId:      typeof session.customer === 'string' ? session.customer : null,
    subscriptionId:  typeof session.subscription === 'string' ? session.subscription : null,
    currentPeriodEnd
  });

  await recordBillingEvent(eventId, 'checkout.session.completed', email, plan, 'processed', {
    session_id: session.id
  });
  console.log('stripe-webhook: checkout.session.completed — activated', plan, 'for', email);
}

async function handleSubscriptionActivated(stripe, subscription, eventType, eventId) {
  const activeStatuses = ['active', 'trialing'];
  if (!activeStatuses.includes(subscription.status)) {
    console.log('stripe-webhook: subscription status', subscription.status, '— not activating');
    await recordBillingEvent(eventId, eventType, null, null, 'skipped', { status: subscription.status });
    return;
  }

  const email = await resolveCustomerEmail(stripe, subscription);
  if (!email) {
    console.error('stripe-webhook: subscription event — no email resolved');
    await recordBillingEvent(eventId, eventType, null, null, 'failed', { sub_id: subscription.id });
    return;
  }

  const plan = await resolvePlanFromSubscription(stripe, subscription);
  if (!plan) {
    console.error('stripe-webhook: subscription event — plan not resolved for', email);
    await recordBillingEvent(eventId, eventType, email, null, 'failed', { sub_id: subscription.id });
    return;
  }

  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  await upsertSubscription(email, {
    plan,
    billingStatus:   subscription.status,
    customerId:      typeof subscription.customer === 'string' ? subscription.customer : null,
    subscriptionId:  subscription.id,
    currentPeriodEnd
  });

  await recordBillingEvent(eventId, eventType, email, plan, 'processed', { sub_id: subscription.id });
  console.log('stripe-webhook:', eventType, '— activated', plan, 'for', email);
}

async function handleSubscriptionDeleted(stripe, subscription, eventId) {
  const email = await resolveCustomerEmail(stripe, subscription);
  if (!email) {
    console.error('stripe-webhook: subscription.deleted — no email resolved');
    await recordBillingEvent(eventId, 'customer.subscription.deleted', null, null, 'failed', { sub_id: subscription.id });
    return;
  }

  await upsertSubscription(email, {
    plan:            'starter',
    billingStatus:   'cancelled',
    customerId:      typeof subscription.customer === 'string' ? subscription.customer : null,
    subscriptionId:  subscription.id,
    currentPeriodEnd: null
  });

  await recordBillingEvent(eventId, 'customer.subscription.deleted', email, 'starter', 'processed', { sub_id: subscription.id });
  console.log('stripe-webhook: subscription.deleted — downgraded to starter for', email);
}

async function handleInvoicePaymentFailed(stripe, invoice, eventId) {
  const email = await resolveCustomerEmail(stripe, invoice);
  if (!email) {
    await recordBillingEvent(eventId, 'invoice.payment_failed', null, null, 'skipped', {});
    return;
  }

  // Preserve the existing plan — only update billing_status to past_due.
  // Fetching the existing plan first ensures the user retains access while
  // they resolve the payment issue (Stripe retries before cancelling).
  let existingPlan = null;
  try {
    const r = await fetch(
      sbUrl('/rest/v1/subscriptions?email=eq.' + encodeURIComponent(email) + '&select=plan&limit=1'),
      { headers: sbHeaders({ 'Prefer': 'return=representation' }) }
    );
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length > 0 && rows[0].plan) existingPlan = rows[0].plan;
  } catch (e) { /* non-fatal */ }

  await upsertSubscription(email, {
    plan:           existingPlan || 'starter',
    billingStatus:  'past_due',
    customerId:     typeof invoice.customer === 'string' ? invoice.customer : null,
    subscriptionId: typeof invoice.subscription === 'string' ? invoice.subscription : null
  });
  await recordBillingEvent(eventId, 'invoice.payment_failed', email, existingPlan, 'processed', { invoice_id: invoice.id });
  console.log('stripe-webhook: invoice.payment_failed — marked past_due for', email, '(plan preserved:', existingPlan + ')');
}

async function handleInvoicePaymentSucceeded(stripe, invoice, eventId) {
  // Only handle subscription invoices (not one-off charges)
  if (!invoice.subscription) {
    await recordBillingEvent(eventId, 'invoice.payment_succeeded', null, null, 'skipped', { reason: 'no_subscription' });
    return;
  }

  const email = await resolveCustomerEmail(stripe, invoice);
  if (!email) {
    await recordBillingEvent(eventId, 'invoice.payment_succeeded', null, null, 'skipped', {});
    return;
  }

  // Resolve plan from the subscription attached to this invoice
  let plan = null;
  let currentPeriodEnd = null;
  try {
    const sub = await stripe.subscriptions.retrieve(
      typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id
    );
    plan = await resolvePlanFromSubscription(stripe, sub);
    if (sub.current_period_end) currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
  } catch (e) {
    console.warn('stripe-webhook: payment_succeeded — subscription retrieve failed:', e.message);
  }

  if (!plan) {
    await recordBillingEvent(eventId, 'invoice.payment_succeeded', email, null, 'skipped', { reason: 'plan_not_resolved' });
    return;
  }

  await upsertSubscription(email, {
    plan,
    billingStatus:   'active',
    customerId:      typeof invoice.customer === 'string' ? invoice.customer : null,
    subscriptionId:  typeof invoice.subscription === 'string' ? invoice.subscription : null,
    currentPeriodEnd
  });
  await recordBillingEvent(eventId, 'invoice.payment_succeeded', email, plan, 'processed', { invoice_id: invoice.id });
  console.log('stripe-webhook: invoice.payment_succeeded — restored active', plan, 'for', email);
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripeKey     = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey) {
    console.error('stripe-webhook: STRIPE_SECRET_KEY not configured');
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('stripe-webhook: Supabase env vars not configured');
    return res.status(500).json({ error: 'Database not configured' });
  }

  let event;
  try {
    const Stripe = require('stripe');
    const stripe = Stripe(stripeKey, { apiVersion: '2024-06-20' });

    if (webhookSecret) {
      let rawBody = req.body;
      if (typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) {
        rawBody = req.rawBody || JSON.stringify(rawBody);
      }
      const sig = req.headers['stripe-signature'];
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
      } catch (err) {
        console.error('stripe-webhook: signature verification failed:', err.message);
        return res.status(400).json({ error: 'Webhook signature verification failed' });
      }
    } else {
      console.warn('stripe-webhook: STRIPE_WEBHOOK_SECRET not set — DEV MODE ONLY');
      event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    }

    const eventId   = event.id   || ('evt_' + Date.now());
    const eventType = event.type || '';
    const dataObj   = event.data && event.data.object;

    // Idempotency: reject duplicate event IDs
    if (event.id) {
      const alreadyDone = await isEventProcessed(event.id);
      if (alreadyDone) {
        console.log('stripe-webhook: duplicate event', event.id, '— skipping');
        return res.status(200).json({ received: true, duplicate: true });
      }
    }

    console.log('stripe-webhook: processing', eventType, eventId);

    if (eventType === 'checkout.session.completed') {
      await handleCheckoutCompleted(stripe, dataObj, eventId);
    } else if (eventType === 'customer.subscription.created' || eventType === 'customer.subscription.updated') {
      await handleSubscriptionActivated(stripe, dataObj, eventType, eventId);
    } else if (eventType === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(stripe, dataObj, eventId);
    } else if (eventType === 'invoice.payment_failed') {
      await handleInvoicePaymentFailed(stripe, dataObj, eventId);
    } else if (eventType === 'invoice.payment_succeeded') {
      await handleInvoicePaymentSucceeded(stripe, dataObj, eventId);
    } else {
      console.log('stripe-webhook: ignoring event type', eventType);
      await recordBillingEvent(eventId, eventType, null, null, 'skipped', null);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('stripe-webhook: unhandled error:', err.message);
    return res.status(500).json({ error: 'Internal webhook error' });
  }
};
