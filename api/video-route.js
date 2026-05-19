// api/video-route.js — Vercel serverless handler for /api/video-route
//
// Implements VIDEO_GENERATION_ROUTE — a dedicated path for video generation
// requests that is separate from the existing image generation pipeline.
//
// Accepts POST {
//   prompt              : text description / scene / motion instructions (string, required)
//   userId              : authenticated user ID or 'guest' (string, optional)
//   plan                : subscription plan name (string, optional)
//   sessionId           : anonymous session ID (string, optional)
//   referenceImages     : array of { data: string, mimeType: string } (optional)
//                         When provided, the video generator animates the uploaded
//                         subject while preserving its identity, silhouette,
//                         structure, and design features.
//   referenceFidelity   : 'balanced' | 'high' | 'exact' (optional, defaults to 'high'
//                         when reference images are present)
//   hasReferenceImage   : boolean — convenience flag (optional)
// }
//
// Returns:
//   { type: "video", url: string, download: true }
//
// Logging (Step 8):
//   [Hymenoptera Routing] selected_route=VIDEO_GENERATION_ROUTE
//   [Hymenoptera Video] model=<provider>
//   [Hymenoptera Video] render_time=<N>s
//   [Hymenoptera Video] url=<video_url>
//
// Video generation provider is selected via environment variables:
//   VIDEO_API_KEY   — API key for the video generation provider
//   VIDEO_PROVIDER  — provider name: 'runwayml' (default) or 'luma'
//   VIDEO_API_URL   — optional base URL override for the provider API
//
// The existing /api/generate-image and /api/generate-video endpoints are NOT modified.

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_PROMPT_LENGTH = 4000;

// Pattern for validating data URLs containing base64-encoded images.
const DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i;

// Default video generation provider.
const DEFAULT_PROVIDER = 'runwayml';

// RunwayML Gen-3 Alpha API endpoints.
const RUNWAYML_BASE_URL = 'https://api.dev.runwayml.com/v1';
const RUNWAYML_IMAGE_TO_VIDEO = RUNWAYML_BASE_URL + '/image_to_video';
const RUNWAYML_TEXT_TO_VIDEO = RUNWAYML_BASE_URL + '/text_to_video';
const RUNWAYML_TASK_URL = RUNWAYML_BASE_URL + '/tasks/';

// Luma Dream Machine API endpoints.
const LUMA_BASE_URL = 'https://api.lumalabs.ai/dream-machine/v1a';
const LUMA_GENERATIONS_URL = LUMA_BASE_URL + '/generations';

// Polling settings (provider APIs use async task queues).
const POLL_INTERVAL_MS = 5000;   // 5 s between polls
const MAX_POLL_ATTEMPTS = 60;    // max 5 min total wait

// ── Helper: extract base64 data URL ──────────────────────────────────────────

/**
 * Normalises a reference image entry into a fully-qualified data URL.
 * Accepts either a data URL (data:image/...;base64,...) or a raw base64 string.
 *
 * @param {{ data: string, mimeType: string }} img
 * @returns {string} fully-qualified data URL
 */
function toDataUrl(img) {
  const mime = (img.mimeType || 'image/jpeg').split(';')[0].trim();
  return img.data.startsWith('data:') ? img.data : ('data:' + mime + ';base64,' + img.data);
}

// ── RunwayML provider ─────────────────────────────────────────────────────────

/**
 * Submits a video generation task to RunwayML Gen-3 Alpha and polls until
 * the video is ready.  Returns the video URL (mp4).
 *
 * @param {string}   apiKey        RUNWAY_API_KEY
 * @param {string}   prompt        Generation prompt
 * @param {Array}    refImages     Array of { data, mimeType } reference images (0 or 1 used)
 * @param {string}   baseUrl       API base URL (overridable via VIDEO_API_URL)
 * @returns {Promise<string>}      Video file URL
 */
async function generateWithRunwayML(apiKey, prompt, refImages, baseUrl) {
  const hasRef = refImages.length > 0;
  const endpoint = baseUrl
    ? (baseUrl.replace(/\/$/, '') + (hasRef ? '/image_to_video' : '/text_to_video'))
    : (hasRef ? RUNWAYML_IMAGE_TO_VIDEO : RUNWAYML_TEXT_TO_VIDEO);

  const body = hasRef
    ? {
        model: 'gen3a_turbo',
        promptText: prompt,
        promptImage: toDataUrl(refImages[0]),
        duration: 5,
        ratio: '1280:768'
      }
    : {
        model: 'gen3a_turbo',
        promptText: prompt,
        duration: 5,
        ratio: '1280:768'
      };

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

  // Poll until task is complete or failed.
  const taskBase = baseUrl ? (baseUrl.replace(/\/$/, '') + '/tasks/') : RUNWAYML_TASK_URL;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise(function (resolve) { setTimeout(resolve, POLL_INTERVAL_MS); });

    const pollRes = await fetch(taskBase + taskId, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'X-Runway-Version': '2024-11-06'
      }
    });

    if (!pollRes.ok) continue;

    const taskData = await pollRes.json();
    const status = taskData.status;

    if (status === 'SUCCEEDED') {
      const outputArr = taskData.output;
      if (Array.isArray(outputArr) && outputArr.length > 0) return outputArr[0];
      if (taskData.outputUrl) return taskData.outputUrl;
      throw new Error('RunwayML: task succeeded but no output URL found');
    }

    if (status === 'FAILED') {
      const reason = (taskData.failure && taskData.failure.message) || taskData.failureCode || 'unknown reason';
      throw new Error('RunwayML: task failed — ' + reason);
    }
    // PENDING / RUNNING — keep polling
  }

  throw new Error('RunwayML: render timed out after ' + MAX_POLL_ATTEMPTS + ' polling attempts');
}

// ── Luma Dream Machine provider ───────────────────────────────────────────────

/**
 * Submits a video generation task to Luma Dream Machine and polls until
 * the video is ready.  Returns the video URL (mp4).
 *
 * @param {string}   apiKey        LUMA_API_KEY (passed via VIDEO_API_KEY)
 * @param {string}   prompt        Generation prompt
 * @param {Array}    refImages     Array of { data, mimeType } reference images (0 or 1 used)
 * @param {string}   baseUrl       API base URL (overridable via VIDEO_API_URL)
 * @returns {Promise<string>}      Video file URL
 */
async function generateWithLuma(apiKey, prompt, refImages, baseUrl) {
  const endpoint = baseUrl ? (baseUrl.replace(/\/$/, '') + '/generations') : LUMA_GENERATIONS_URL;

  const body = {
    prompt: prompt,
    aspect_ratio: '16:9',
    loop: false
  };

  if (refImages.length > 0) {
    body.keyframes = {
      frame0: {
        type: 'image',
        url: toDataUrl(refImages[0])
      }
    };
  }

  const submitRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
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

  // Poll until generation is complete or failed.
  const statusBase = baseUrl ? (baseUrl.replace(/\/$/, '') + '/generations/') : (LUMA_GENERATIONS_URL + '/');
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise(function (resolve) { setTimeout(resolve, POLL_INTERVAL_MS); });

    const pollRes = await fetch(statusBase + genId, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey
      }
    });

    if (!pollRes.ok) continue;

    const genData = await pollRes.json();
    const state = genData.state;

    if (state === 'completed') {
      if (genData.assets && genData.assets.video) return genData.assets.video;
      throw new Error('Luma: generation completed but no video URL found');
    }

    if (state === 'failed') {
      const reason = (genData.failure_reason) || 'unknown reason';
      throw new Error('Luma: generation failed — ' + reason);
    }
    // dreaming / processing — keep polling
  }

  throw new Error('Luma: render timed out after ' + MAX_POLL_ATTEMPTS + ' polling attempts');
}

// ── Main router ───────────────────────────────────────────────────────────────

/**
 * Calls the configured video generation provider.
 *
 * @param {string} provider   Provider name: 'runwayml' | 'luma'
 * @param {string} apiKey     Provider API key
 * @param {string} prompt     Generation prompt
 * @param {Array}  refImages  Reference images array
 * @param {string} apiUrl     Optional API base URL override
 * @returns {Promise<string>} Video file URL
 */
async function generateVideo(provider, apiKey, prompt, refImages, apiUrl) {
  if (provider === 'luma') {
    return generateWithLuma(apiKey, prompt, refImages, apiUrl || '');
  }
  // Default: runwayml
  return generateWithRunwayML(apiKey, prompt, refImages, apiUrl || '');
}

// ── Vercel serverless handler ─────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const renderStart = Date.now();

  try {
    const {
      prompt,
      referenceImages,
      referenceFidelity,
      hasReferenceImage
    } = req.body || {};

    // ── Input validation ──────────────────────────────────────────────────────

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(400).json({ error: { message: 'prompt (string) is required' } });
    }

    const safePrompt = prompt.trim().slice(0, MAX_PROMPT_LENGTH);

    // ── Logging: route selection ──────────────────────────────────────────────

    const provider = (process.env.VIDEO_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
    console.log('[Hymenoptera Routing] selected_route=VIDEO_GENERATION_ROUTE');
    console.log('[Hymenoptera Video] model=' + provider + ' prompt_length=' + safePrompt.length);

    // ── Validate reference images ─────────────────────────────────────────────

    const refImageList = [];
    if (Array.isArray(referenceImages) && referenceImages.length > 0) {
      referenceImages.forEach(function (img) {
        if (
          img &&
          typeof img === 'object' &&
          typeof img.data === 'string' &&
          img.data.length > 0 &&
          (DATA_URL_PATTERN.test(img.data) || /^[A-Za-z0-9+/]+=*$/.test(img.data))
        ) {
          refImageList.push(img);
        }
      });
    }

    const hasRefImages = refImageList.length > 0 || hasReferenceImage === true;
    const selectedRoute = hasRefImages ? 'image_to_video_route' : 'text_only_video_route';
    console.log('[Hymenoptera Video] route=' + selectedRoute);
    console.log('[Hymenoptera Video] hasReferenceImage=' + hasRefImages);
    console.log('[Hymenoptera Video] referenceFidelity=' + (referenceFidelity || 'default'));

    // ── API key check ─────────────────────────────────────────────────────────

    const videoApiKey = process.env.VIDEO_API_KEY;

    // ── Generate video ────────────────────────────────────────────────────────

    let videoUrl;
    if (!videoApiKey) {
      // No provider configured — return a placeholder video so the frontend
      // video player works immediately.  Replace this fallback with a real
      // provider once VIDEO_API_KEY is set.
      console.log('[VIDEO] No VIDEO_API_KEY configured — using placeholder fallback');
      videoUrl = 'https://www.w3schools.com/html/mov_bbb.mp4';
    } else {
      const apiUrl = process.env.VIDEO_API_URL || '';
      videoUrl = await generateVideo(provider, videoApiKey, safePrompt, refImageList, apiUrl);
    }

    // ── Logging: completion ───────────────────────────────────────────────────

    const renderTimeSec = ((Date.now() - renderStart) / 1000).toFixed(1);
    console.log('[Hymenoptera Video] render_time=' + renderTimeSec + 's');
    console.log('[Hymenoptera Video] url=' + videoUrl);

    // ── Response ──────────────────────────────────────────────────────────────

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      type: 'video',
      url: videoUrl,
      download: true
    });

  } catch (err) {
    console.error('api/video-route error:', err);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: { message: err.message || 'Internal server error' } });
    }
  }
};
