// api/plan.js — Read-only plan status endpoint
//
// Reads from the Supabase subscriptions table (server-authoritative),
// with Redis as a fast-path cache. Never trusts any client-side claim.
//
// GET  /api/plan?email=user@example.com
// POST /api/plan { email }
//
// Response: { plan, billingStatus, customerId, currentPeriodEnd,
//             messageLimit, imageLimit, videoLimit }

'use strict';

let _redis = null;
try {
  _redis = require('../lib/redis').redis;
} catch (e) {
  console.warn('api/plan: Redis unavailable:', e.message);
}

const PLAN_LIMITS = {
  starter:  { messageLimit: 30,   imageLimit: 10,   videoLimit: 10   },
  basic:    { messageLimit: 150,  imageLimit: 50,   videoLimit: 20   },
  premium:  { messageLimit: 500,  imageLimit: 75,   videoLimit: 30   },
  ultimate: { messageLimit: null, imageLimit: null, videoLimit: null  }
};
const VALID_PLANS     = Object.keys(PLAN_LIMITS);
const CACHE_TTL       = 300;
const PLAN_KEY_PREFIX = 'user_plan:';

function planKey(email) {
  return PLAN_KEY_PREFIX + email.toLowerCase().trim();
}

async function getSubscriptionFromSupabase(email) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const r = await fetch(
      url + '/rest/v1/subscriptions?email=eq.' + encodeURIComponent(email) +
      '&select=plan,billing_status,stripe_customer_id,current_period_end&limit=1',
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
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (e) {
    console.warn('api/plan: Supabase fetch failed:', e.message);
    return null;
  }
}

async function getFromRedisCache(email) {
  if (!_redis) return null;
  try {
    const raw = await _redis.command('GET', planKey(email));
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { return null; }
}

async function writeToRedisCache(email, record) {
  if (!_redis) return;
  try {
    await _redis.command('SET', planKey(email), JSON.stringify(record), 'EX', String(CACHE_TTL));
  } catch (e) { /* non-fatal */ }
}

function buildResponse(plan, billingStatus, customerId, currentPeriodEnd) {
  const safePlan = VALID_PLANS.includes(plan) ? plan : 'starter';
  const limits   = PLAN_LIMITS[safePlan];
  return {
    plan:             safePlan,
    billingStatus:    billingStatus    || 'inactive',
    customerId:       customerId       || null,
    currentPeriodEnd: currentPeriodEnd || null,
    messageLimit:     limits.messageLimit,
    imageLimit:       limits.imageLimit,
    videoLimit:       limits.videoLimit
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const params = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const { email } = params;

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(200).json(buildResponse('starter', 'inactive', null, null));
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // 1. Supabase — authoritative source of truth
    const row = await getSubscriptionFromSupabase(normalizedEmail);
    if (row) {
      await writeToRedisCache(normalizedEmail, {
        plan:            row.plan,
        billingStatus:   row.billing_status,
        customerId:      row.stripe_customer_id,
        currentPeriodEnd: row.current_period_end
      });
      console.log('api/plan: [supabase]', normalizedEmail, '->', row.plan, row.billing_status);
      return res.status(200).json(
        buildResponse(row.plan, row.billing_status, row.stripe_customer_id, row.current_period_end)
      );
    }

    // 2. Redis cache fallback
    const cached = await getFromRedisCache(normalizedEmail);
    if (cached) {
      console.log('api/plan: [redis]', normalizedEmail, '->', cached.plan);
      return res.status(200).json(
        buildResponse(cached.plan, cached.billingStatus, cached.customerId, cached.currentPeriodEnd || null)
      );
    }

    // 3. Default starter plan
    console.log('api/plan: [default]', normalizedEmail, '-> starter');
    return res.status(200).json(buildResponse('starter', 'inactive', null, null));

  } catch (err) {
    console.warn('api/plan: error:', err.message);
    return res.status(200).json(buildResponse('starter', 'inactive', null, null));
  }
};
