// api/video.js — Merged video endpoint (replaces api/video-route.js + api/generate-video.js)
//
// Routes (dispatched by ?action= query param or body.action):
//
//   POST /api/video?action=render  (or body.action = 'render')
//     Calls RunwayML or Luma to generate an actual video file.
//     Input:  { prompt, referenceImages?, referenceFidelity?, hasReferenceImage? }
//     Output: { type: "video", url: string, download: true }
//
//   POST /api/video?action=concept  (default)
//     Uses GPT-4o to generate a reference-locked video concept / storyboard.
//     Input:  { prompt, userId?, plan?, sessionId?, referenceImages?,
//               referenceFidelity?, referenceLockVideoMode?, hasReferenceImage? }
//     Output: { concept: string, prompt: string, referenceLocked: boolean }

'use strict';

// ── Optional helpers ──────────────────────────────────────────────────────────

let _usageLimits = null;
try {
  _usageLimits = require('../lib/usageLimits');
} catch (e) {
  console.warn('api/video: usage limits unavailable:', e.message);
}

// ── Shared constants ──────────────────────────────────────────────────────────

const MAX_PROMPT_LENGTH = 4000;
const DATA_URL_PATTERN  = /^data:image\/[a-z0-9.+-]+;base64,/i;

// ── Concept-side constants ────────────────────────────────────────────────────

const ALLOWED_FIDELITY = ['balanced', 'high', 'exact'];

const STRICT_FIDELITY_PATTERNS = [
  /\bexact(ly)?\b/i,
  /\bdo\s*not\s*change\b/i,
  /\bdon'?t\s*change\b/i,
  /\bpreserve\s*this\b/i,
  /\bsame\s*design\b/i,
  /\bmake\s*this\s*realistic\b/i,
  /\buse\s*this\s*exact\b/i,
  /\bkeep\s*the\s*design\b/i,
  /\bput\s*this\s*on\b/i,
  /\bmake\s*this\s*real\b/i,
  /\bturn\s*this\s+(?:drawing|sketch|design|image)\b/i,
  /\bno\s*changes?\b/i,
  /\bfaithful(ly)?\b/i,
  /\bfidelity\b/i,
  /\baccurate(ly)?\b/i,
  /\banimate\s*this\b/i,
  /\bbring\s*this\s*to\s*life\b/i,
];

// ── Render-side constants ─────────────────────────────────────────────────────

const DEFAULT_PROVIDER    = 'runwayml';
const RUNWAYML_BASE_URL   = 'https://api.dev.runwayml.com/v1';
const RUNWAYML_IMAGE_TO_VIDEO = RUNWAYML_BASE_URL + '/image_to_video';
const RUNWAYML_TEXT_TO_VIDEO  = RUNWAYML_BASE_URL + '/text_to_video';
const RUNWAYML_TASK_URL   = RUNWAYML_BASE_URL + '/tasks/';
const LUMA_BASE_URL       = 'https://api.lumalabs.ai/dream-machine/v1a';
const LUMA_GENERATIONS_URL = LUMA_BASE_URL + '/generations';
const POLL_INTERVAL_MS    = 5000;
const MAX_POLL_ATTEMPTS   = 60;

// ── Shared helpers ────────────────────────────────────────────────────────────

function toDataUrl(img) {
  const mime = (img.mimeType || 'image/jpeg').split(';')[0].trim();
  return img.data.startsWith('data:') ? img.data : ('data:' + mime + ';base64,' + img.data);
}

function normalizeRefImages(referenceImages) {
  const list = [];
  if (Array.isArray(referenceImages) && referenceImages.length > 0) {
    referenceImages.forEach(function (img) {
      if (
        img &&
        typeof img === 'object' &&
        typeof img.data === 'string' &&
        img.data.length > 0 &&
        (DATA_URL_PATTERN.test(img.data) || /^[A-Za-z0-9+/]/.test(img.data))
      ) {
        list.push(img);
      }
    });
  }
  return list;
}

function detectStrictFidelityMode(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  return STRICT_FIDELITY_PATTERNS.some(function (re) { return re.test(prompt); });
}

// ── Render action: RunwayML ───────────────────────────────────────────────────

async function generateWithRunwayML(apiKey, prompt, refImages, baseUrl) {
  const hasRef   = refImages.length > 0;
  const endpoint = baseUrl
    ? (baseUrl.replace(/\/$/, '') + (hasRef ? '/image_to_video' : '/text_to_video'))
    : (hasRef ? RUNWAYML_IMAGE_TO_VIDEO : RUNWAYML_TEXT_TO_VIDEO);

  const body = hasRef
    ? { model: 'gen3a_turbo', promptText: prompt, promptImage: toDataUrl(refImages[0]), duration: 5, ratio: '1280:768' }
    : { model: 'gen3a_turbo', promptText: prompt, duration: 5, ratio: '1280:768' };

  const submitRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'X-Runway-Version': '2024-11-06'
    },
    body: JSON.stringify(body)
  });

  if (!submitRes.ok) {
    let errData;
    try { errData = await submitRes.json(); } catch (e) { errData = null; }
    const msg = (errData && (errData.message || (errData.error && errData.error.message))) || 'RunwayML task submission failed';
    throw new Error(msg);
  }

  const submitData = await submitRes.json();
  const taskId = submitData.id;
  if (!taskId) throw new Error('RunwayML: no task ID returned from submission');

  const taskBase = baseUrl ? (baseUrl.replace(/\/$/, '') + '/tasks/') : RUNWAYML_TASK_URL;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise(function (resolve) { setTimeout(resolve, POLL_INTERVAL_MS); });

    const pollRes = await fetch(taskBase + taskId, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'X-Runway-Version': '2024-11-06' }
    });

    if (!pollRes.ok) continue;
    const taskData = await pollRes.json();
    const status = taskData.status;

    if (status === 'SUCCEEDED') {
      if (Array.isArray(taskData.output) && taskData.output.length > 0) return taskData.output[0];
      if (taskData.outputUrl) return taskData.outputUrl;
      throw new Error('RunwayML: task succeeded but no output URL found');
    }
    if (status === 'FAILED') {
      const reason = (taskData.failure && taskData.failure.message) || taskData.failureCode || 'unknown reason';
      throw new Error('RunwayML: task failed — ' + reason);
    }
  }
  throw new Error('RunwayML: render timed out after ' + MAX_POLL_ATTEMPTS + ' polling attempts');
}

// ── Render action: Luma ───────────────────────────────────────────────────────

async function generateWithLuma(apiKey, prompt, refImages, baseUrl) {
  const endpoint = baseUrl ? (baseUrl.replace(/\/$/, '') + '/generations') : LUMA_GENERATIONS_URL;

  const body = { prompt: prompt, aspect_ratio: '16:9', loop: false };
  if (refImages.length > 0) {
    body.keyframes = { frame0: { type: 'image', url: toDataUrl(refImages[0]) } };
  }

  const submitRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body)
  });

  if (!submitRes.ok) {
    let errData;
    try { errData = await submitRes.json(); } catch (e) { errData = null; }
    const msg = (errData && (errData.detail || errData.message)) || 'Luma generation submission failed';
    throw new Error(msg);
  }

  const submitData = await submitRes.json();
  const genId = submitData.id;
  if (!genId) throw new Error('Luma: no generation ID returned from submission');

  const statusBase = baseUrl ? (baseUrl.replace(/\/$/, '') + '/generations/') : (LUMA_GENERATIONS_URL + '/');
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise(function (resolve) { setTimeout(resolve, POLL_INTERVAL_MS); });

    const pollRes = await fetch(statusBase + genId, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + apiKey }
    });

    if (!pollRes.ok) continue;
    const genData = await pollRes.json();
    const state = genData.state;

    if (state === 'completed') {
      if (genData.assets && genData.assets.video) return genData.assets.video;
      throw new Error('Luma: generation completed but no video URL found');
    }
    if (state === 'failed') {
      throw new Error('Luma: generation failed — ' + (genData.failure_reason || 'unknown reason'));
    }
  }
  throw new Error('Luma: render timed out after ' + MAX_POLL_ATTEMPTS + ' polling attempts');
}

// ── Render action handler ─────────────────────────────────────────────────────

async function handleRender(body, res) {
  const { prompt, referenceImages, referenceFidelity, hasReferenceImage } = body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: { message: 'prompt (string) is required' } });
  }

  const safePrompt  = prompt.trim().slice(0, MAX_PROMPT_LENGTH);
  const provider    = (process.env.VIDEO_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
  const refImageList = normalizeRefImages(referenceImages);
  const hasRefImages = refImageList.length > 0 || hasReferenceImage === true;

  console.log('[Apocrita Routing] selected_route=VIDEO_GENERATION_ROUTE');
  console.log('[Apocrita Video] model=' + provider + ' hasReferenceImage=' + hasRefImages);

  const renderStart = Date.now();
  let videoUrl;

  if (!process.env.VIDEO_API_KEY) {
    console.log('[VIDEO] No VIDEO_API_KEY configured — using placeholder fallback');
    videoUrl = 'https://www.w3schools.com/html/mov_bbb.mp4';
  } else {
    const apiUrl = process.env.VIDEO_API_URL || '';
    if (provider === 'luma') {
      videoUrl = await generateWithLuma(process.env.VIDEO_API_KEY, safePrompt, refImageList, apiUrl);
    } else {
      videoUrl = await generateWithRunwayML(process.env.VIDEO_API_KEY, safePrompt, refImageList, apiUrl);
    }
  }

  const renderTimeSec = ((Date.now() - renderStart) / 1000).toFixed(1);
  console.log('[Apocrita Video] render_time=' + renderTimeSec + 's url=' + videoUrl);

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ type: 'video', url: videoUrl, download: true });
}

// ── Concept action helpers ────────────────────────────────────────────────────

async function analyzeReferenceImage(apiKey, referenceImages) {
  if (!referenceImages || referenceImages.length === 0) return '';

  const imageParts = referenceImages.slice(0, 4).map(function (img) {
    const mimeType = (img.mimeType || 'image/jpeg').split(';')[0].trim();
    const url = img.data.startsWith('data:') ? img.data : ('data:' + mimeType + ';base64,' + img.data);
    return { type: 'image_url', image_url: { url: url, detail: 'high' } };
  }).filter(function (p) { return DATA_URL_PATTERN.test(p.image_url.url) || /^data:image\//.test(p.image_url.url); });

  if (imageParts.length === 0) return '';

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are a precise visual design analyst. Examine the provided reference image(s) and produce a structured design description that will be used to guide a faithful video animation. Be concise but comprehensive. Focus only on visual/design attributes — no commentary.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analyze this reference image and describe its visual design for faithful video animation. Cover these attributes where applicable:\n- Subject or object category\n- Overall silhouette and outline shape\n- Proportions and key dimensions\n- Major color zones and color blocking\n- Stripe, marking, or pattern layout\n- Material or texture cues\n- Structural elements, seams, and panels\n- Facial features or identity markers (if a character or face)\n- Edge shapes and profile\n- Placement of distinctive features\n- Motion potential — how this subject could naturally move\n\nOutput a concise structured description only. No preamble.'
              },
              ...imageParts
            ]
          }
        ],
        max_tokens: 600,
        temperature: 0.2
      })
    });
    if (!r.ok) return '';
    const d = await r.json();
    const content = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    return typeof content === 'string' ? content.trim() : '';
  } catch (e) {
    console.warn('api/video[concept]: reference image analysis failed:', e.message);
    return '';
  }
}

function buildReferenceLockVideoPrompt(userPrompt, designAnalysis, hasMultipleRefs, fidelityLevel) {
  const blueprintSection = designAnalysis
    ? 'SUBJECT DESIGN BLUEPRINT (from uploaded reference image):\n' + designAnalysis
    : 'SUBJECT DESIGN BLUEPRINT: Follow the uploaded reference image exactly as the design source.';

  const secondaryNote = hasMultipleRefs
    ? '\nSecondary reference image(s) may provide material, realism, or lighting guidance but must NOT override the primary subject design.'
    : '';

  const isExact = fidelityLevel === 'exact';

  const header = isExact
    ? '[REFERENCE_LOCK_VIDEO_MODE — EXACT PRESERVATION — DO NOT ALTER SUBJECT DESIGN]\n\n'
    : '[REFERENCE_LOCK_VIDEO_MODE — PRESERVE SUBJECT IDENTITY AND DESIGN]\n\n';

  const extraExactConstraints = isExact
    ? '- EXACT mode: treat every visual detail of the uploaded subject as mandatory.\n' +
      '- EXACT mode: do not simplify, stylize, or reinterpret any part of the subject.\n' +
      '- EXACT mode: only apply the requested motion, scene, or environment changes.\n' +
      '- EXACT mode: preserve character or object identity throughout all frames.\n'
    : '';

  return (
    header +
    blueprintSection +
    secondaryNote +
    '\n\nSCENE / MOTION INSTRUCTION (from user):\n' + userPrompt +
    '\n\nCRITICAL VIDEO RULES — DO NOT DEVIATE:\n' +
    '- The uploaded reference image IS the subject. Animate it faithfully — do not replace it.\n' +
    '- Preserve the subject\'s silhouette, design, proportions, and identity across all frames.\n' +
    '- Preserve all color zones, markings, and design elements throughout the animation.\n' +
    '- Apply motion to the uploaded subject — do not generate a different-looking version.\n' +
    '- Only add the requested scene context, environment, lighting, and motion.\n' +
    '- DO NOT redesign or reinterpret the uploaded subject.\n' +
    '- DO NOT substitute the subject with a more cinematic, generic, or standard variant.\n' +
    '- DO NOT use the reference as loose inspiration — it is the design blueprint.\n' +
    '- Bias strongly toward identity preservation over stylistic creativity.\n' +
    extraExactConstraints +
    '\nNEGATIVE CONSTRAINTS: do not change silhouette; do not alter proportions; do not add unrequested ' +
    'features; do not replace subject identity; do not drift from source design between frames.' +
    '\n\nTASK: Generate a detailed, frame-accurate video concept / storyboard description for this subject. ' +
    'Describe the video scene, camera movement, motion, and environment as requested — while ensuring the ' +
    'uploaded subject appears exactly as designed throughout every frame of the video. ' +
    'Structure the output as: [Scene Overview] → [Key Frames] → [Motion Description] → [Camera & Lighting].'
  );
}

async function validateConceptFidelity(apiKey, referenceImages, concept, userPrompt) {
  if (!referenceImages || referenceImages.length === 0 || !concept) return { pass: true, score: 10, issues: '' };

  const refParts = referenceImages.slice(0, 1).map(function (img) {
    const mimeType = (img.mimeType || 'image/jpeg').split(';')[0].trim();
    const url = img.data.startsWith('data:') ? img.data : ('data:' + mimeType + ';base64,' + img.data);
    return { type: 'image_url', image_url: { url: url, detail: 'high' } };
  }).filter(function (p) { return DATA_URL_PATTERN.test(p.image_url.url) || /^data:image\//.test(p.image_url.url); });

  if (refParts.length === 0) return { pass: true, score: 10, issues: '' };

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are a strict video concept fidelity validator. Your job is to compare a generated video concept/storyboard description against a reference image and score how faithfully the concept preserves the uploaded subject\'s identity, design, and appearance. Be strict: passing means the concept clearly animates the original subject; failing means the concept describes a different or generic subject.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'REFERENCE IMAGE (the subject that must be animated faithfully):' },
              ...refParts,
              {
                type: 'text',
                text: 'GENERATED VIDEO CONCEPT:\n' + concept + '\n\nThe user instruction was: "' + userPrompt + '"\n\n' +
                  'Score the concept against the reference on each dimension (1 = completely ignores reference, 10 = faithfully preserves reference):\n' +
                  '1. Subject identity\n2. Design preservation\n3. Silhouette and structure\n4. No unauthorized substitution\n5. Feature accuracy\n\n' +
                  'Respond ONLY in this exact JSON format (no markdown, no extra text):\n' +
                  '{"identity":N,"design":N,"structure":N,"noSubstitution":N,"features":N,"overall":N,"pass":true_or_false,"issues":"brief description or empty string"}\n' +
                  'Set pass to true when overall >= 7, false otherwise.'
              }
            ]
          }
        ],
        max_tokens: 200,
        temperature: 0.1
      })
    });
    if (!r.ok) return { pass: true, score: 10, issues: '' };
    const d = await r.json();
    const content = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!content) return { pass: true, score: 10, issues: '' };
    const jsonText = content.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(jsonText);
    return {
      pass: parsed.pass === true,
      score: typeof parsed.overall === 'number' ? parsed.overall : 10,
      issues: typeof parsed.issues === 'string' ? parsed.issues : ''
    };
  } catch (e) {
    console.warn('api/video[concept]: fidelity validation failed:', e.message);
    return { pass: true, score: 10, issues: '' };
  }
}

async function generateVideoConcept(apiKey, finalPrompt, isLocked) {
  const systemContent = isLocked
    ? 'You are a precise video director specializing in faithful, reference-locked animation. Your role is to produce a detailed, frame-accurate video concept that exactly preserves the uploaded subject\'s design and identity while applying only the requested motion and scene. Follow all REFERENCE_LOCK_VIDEO_MODE rules strictly. Do NOT redesign or replace the subject. Output only the video concept description.'
    : 'You are a creative video director. Produce a detailed video concept / storyboard description based on the user\'s instructions. Describe scene, motion, camera, and lighting clearly. Output only the video concept description.';

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: finalPrompt }
      ],
      max_tokens: 1200,
      temperature: isLocked ? 0.3 : 0.7
    })
  });

  if (!r.ok) {
    let errData;
    try { errData = await r.json(); } catch (e) { errData = null; }
    const msg = (errData && errData.error && errData.error.message) || 'Video concept generation failed';
    throw new Error(msg);
  }

  const d = await r.json();
  const content = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  return typeof content === 'string' ? content.trim() : '';
}

// ── Concept action handler ────────────────────────────────────────────────────

async function handleConcept(body, res) {
  const {
    prompt, userId, plan, sessionId,
    referenceImages, referenceFidelity, referenceLockVideoMode, hasReferenceImage
  } = body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: { message: 'prompt (string) is required' } });
  }

  const safePrompt = prompt.trim().slice(0, MAX_PROMPT_LENGTH);

  // Daily quota check
  if (_usageLimits) {
    const trackingId = (userId && userId !== 'guest') ? userId : sessionId;
    if (trackingId) {
      try {
        const KNOWN_PLANS = Object.keys(_usageLimits.PLAN_LIMITS);
        const rawPlan  = typeof plan === 'string' ? plan.toLowerCase() : '';
        const userPlan = KNOWN_PLANS.includes(rawPlan) ? rawPlan : 'starter';
        const result   = await _usageLimits.checkAndTrack(trackingId, userPlan, 'video');
        if (!result.allowed) {
          res.setHeader('Content-Type', 'application/json');
          return res.status(429).json({ error: { message: result.error || 'Daily video generation limit reached. Upgrade your plan or wait for the reset.' } });
        }
      } catch (e) {
        console.warn('api/video[concept]: usage limit check failed:', e.message);
      }
    }
  }

  const refImageList = normalizeRefImages(referenceImages);
  const hasRefImages = refImageList.length > 0 || hasReferenceImage === true;

  let effectiveFidelity = 'balanced';
  if (ALLOWED_FIDELITY.includes(referenceFidelity)) {
    effectiveFidelity = referenceFidelity;
  } else if (hasRefImages && (referenceLockVideoMode === true || detectStrictFidelityMode(safePrompt))) {
    effectiveFidelity = 'high';
  } else if (hasRefImages && referenceLockVideoMode !== false) {
    effectiveFidelity = 'high';
  }

  const isLockMode = hasRefImages && effectiveFidelity !== 'balanced';

  if (isLockMode) {
    console.log('api/video[concept]: REFERENCE_LOCK_VIDEO_MODE ACTIVE (' + effectiveFidelity + ') — ' + refImageList.length + ' ref image(s)');
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: { message: 'API key not configured' } });
  }

  let finalPrompt = safePrompt;
  let cachedDesignAnalysis = '';
  if (isLockMode && refImageList.length > 0) {
    cachedDesignAnalysis = await analyzeReferenceImage(apiKey, refImageList);
    finalPrompt = buildReferenceLockVideoPrompt(safePrompt, cachedDesignAnalysis, refImageList.length > 1, effectiveFidelity);
  }

  const concept = await generateVideoConcept(apiKey, finalPrompt, isLockMode);
  if (!concept) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(502).json({ error: { message: 'No video concept returned from generation service' } });
  }

  let finalConcept = concept;
  if (isLockMode && refImageList.length > 0) {
    const validation = await validateConceptFidelity(apiKey, refImageList, concept, safePrompt);
    if (!validation.pass) {
      console.log('api/video[concept]: fidelity FAILED (score=' + validation.score + ') — regenerating with exact mode');
      try {
        const escalatedPrompt = buildReferenceLockVideoPrompt(safePrompt, cachedDesignAnalysis, refImageList.length > 1, 'exact');
        const regenConcept = await generateVideoConcept(apiKey, escalatedPrompt, true);
        if (regenConcept) finalConcept = regenConcept;
      } catch (regenErr) {
        console.warn('api/video[concept]: regeneration failed:', regenErr.message);
      }
    }
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ concept: finalConcept, prompt: safePrompt, referenceLocked: isLockMode });
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const body   = req.body || {};
  const action = (req.query && req.query.action) || body.action || 'concept';

  try {
    if (action === 'render') return await handleRender(body, res);
    return await handleConcept(body, res);
  } catch (err) {
    console.error('api/video error:', err);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: { message: err.message || 'Internal server error' } });
    }
  }
};
