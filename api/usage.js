// api/usage.js — Endpoint to fetch current daily usage for a user
//
// Accepts GET or POST with { userId, sessionId, plan }.
// Returns the user's current usage counters for today so the frontend can
// display accurate values after a day boundary has been crossed.
//
// Response: { messages_used, images_used, videos_used, messages_limit, images_limit, videos_limit }

'use strict';

let _usageLimits = null;
try {
  _usageLimits = require('../lib/usageLimits');
} catch (e) {
  console.warn('api/usage: usage limits unavailable:', e.message);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const params = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const { userId, sessionId, plan } = params;

  const trackingId = (userId && userId !== 'guest') ? userId : sessionId;

  if (!_usageLimits || !trackingId) {
    // Return zeros when usage limits are unavailable or no tracking ID is present
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ messages_used: 0, images_used: 0, videos_used: 0 });
  }

  try {
    const data = await _usageLimits.getUsage(trackingId);

    const KNOWN_PLANS = Object.keys(_usageLimits.PLAN_LIMITS);
    const rawPlan = typeof plan === 'string' ? plan.toLowerCase() : '';
    const userPlan = KNOWN_PLANS.includes(rawPlan) ? rawPlan : 'starter';
    const limits = _usageLimits.PLAN_LIMITS[userPlan];

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      messages_used:  data.messages_used,
      images_used:    data.images_used,
      videos_used:    data.videos_used,
      messages_limit: limits.messages_per_day,
      images_limit:   limits.images_per_day,
      videos_limit:   limits.videos_per_day
    });
  } catch (e) {
    console.warn('api/usage: failed to fetch usage:', e.message);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ messages_used: 0, images_used: 0, videos_used: 0 });
  }
};
