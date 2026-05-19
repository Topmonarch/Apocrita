// api/account.js
//
// Merged account-data endpoint. Replaces the former api/plan.js and api/usage.js
// to stay within Vercel Hobby's 12-function limit.
//
// Routes (dispatched by ?action= query param or request path suffix):
//
//   GET/POST /api/account?action=plan  (or POST { action: 'plan', email })
//     Returns the user's subscription plan from Supabase (authoritative) with
//     Redis cache fallback.
//     Response: { plan, billingStatus, customerId, currentPeriodEnd,
//                 messageLimit, imageLimit, videoLimit }
//
//   GET/POST /api/account?action=usage  (or POST { action: 'usage', userId, sessionId, plan })
//     Returns today's usage counters for a user/session.
//     Response: { messages_used, images_used, videos_used,
//                 messages_limit, images_limit, videos_limit }
//
// Callers that previously used /api/plan and /api/usage should now use
// /api/account?action=plan and /api/account?action=usage respectively.

'use strict';

// ── Redis cache (optional) ────────────────────────────────────────────────────
let _redis = null;
try {
  _redis = require('../lib/redis').redis;
} catch (e) {
  console.warn('api/account: Redis unavailable:', e.message);
}

// ── Usage limits (optional) ───────────────────────────────────────────────────
let _usageLimits = null;
try {
  _usageLimits = require('../lib/usageLimits');
} catch (e) {
  console.warn('api/account: usage limits unavailable:', e.message);
}

// ── Plan constants ────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  starter:  { messageLimit: 30,   imageLimit: 10,   videoLimit: 10   },
  basic:    { messageLimit: 150,  imageLimit: 50,   videoLimit: 20   },
  premium:  { messageLimit: 500,  imageLimit: 75,   videoLimit: 30   },
  ultimate: { messageLimit: null, imageLimit: null, videoLimit: null  }
};
const VALID_PLANS     = Object.keys(PLAN_LIMITS);
const CACHE_TTL       = 300; // 5-minute Redis plan cache
const PLAN_KEY_PREFIX = 'user_plan:';

// ── Plan helpers ──────────────────────────────────────────────────────────────

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
    console.warn('api/account: Supabase fetch failed:', e.message);
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

function buildPlanResponse(plan, billingStatus, customerId, currentPeriodEnd) {
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

async function handlePlan(params, res) {
  const { email } = params;
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(200).json(buildPlanResponse('starter', 'inactive', null, null));
  }
  const normalizedEmail = email.trim().toLowerCase();
  try {
    // 1. Supabase — authoritative source
    const row = await getSubscriptionFromSupabase(normalizedEmail);
    if (row) {
      await writeToRedisCache(normalizedEmail, {
        plan: row.plan, billingStatus: row.billing_status,
        customerId: row.stripe_customer_id, currentPeriodEnd: row.current_period_end
      });
      console.log('api/account[plan]: [supabase]', normalizedEmail, '->', row.plan);
      return res.status(200).json(
        buildPlanResponse(row.plan, row.billing_status, row.stripe_customer_id, row.current_period_end)
      );
    }
    // 2. Redis cache fallback
    const cached = await getFromRedisCache(normalizedEmail);
    if (cached) {
      console.log('api/account[plan]: [redis]', normalizedEmail, '->', cached.plan);
      return res.status(200).json(
        buildPlanResponse(cached.plan, cached.billingStatus, cached.customerId, cached.currentPeriodEnd || null)
      );
    }
    // 3. Default starter
    return res.status(200).json(buildPlanResponse('starter', 'inactive', null, null));
  } catch (err) {
    console.warn('api/account[plan]: error:', err.message);
    return res.status(200).json(buildPlanResponse('starter', 'inactive', null, null));
  }
}

async function handleUsage(params, res) {
  const { userId, sessionId, plan } = params;
  const trackingId = (userId && userId !== 'guest') ? userId : sessionId;

  if (!_usageLimits || !trackingId) {
    return res.status(200).json({ messages_used: 0, images_used: 0, videos_used: 0 });
  }

  try {
    const data = await _usageLimits.getUsage(trackingId);
    const KNOWN_PLANS = Object.keys(_usageLimits.PLAN_LIMITS);
    const rawPlan  = typeof plan === 'string' ? plan.toLowerCase() : '';
    const userPlan = KNOWN_PLANS.includes(rawPlan) ? rawPlan : 'starter';
    const limits   = _usageLimits.PLAN_LIMITS[userPlan];
    return res.status(200).json({
      messages_used:  data.messages_used,
      images_used:    data.images_used,
      videos_used:    data.videos_used,
      messages_limit: limits.messages_per_day,
      images_limit:   limits.images_per_day,
      videos_limit:   limits.videos_per_day
    });
  } catch (e) {
    console.warn('api/account[usage]: failed:', e.message);
    return res.status(200).json({ messages_used: 0, images_used: 0, videos_used: 0 });
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Content-Type', 'application/json');

  const params = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const action = params.action || 'plan';

  if (action === 'usage') return handleUsage(params, res);
  return handlePlan(params, res);
};
