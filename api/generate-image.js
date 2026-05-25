// api/generate-image.js — Vercel serverless handler for /api/generate-image
//
// Accepts POST {
//   prompt           : text description (string, required)
//   referenceImages  : array of { data: string, mimeType: string } (optional)
//   referenceFidelity: 'balanced' | 'high' | 'exact' (optional)
//   hasReferenceImage: boolean (optional convenience flag)
// }
//
// Returns { image: "<base64 PNG string>", revisedPrompt?: string }
// on success, or { error: { message: string } } on failure.

'use strict';

const MAX_PROMPT_LENGTH = 4000;

// Pattern for validating data URLs containing base64-encoded images.
const DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i;

// Timeout for the OpenAI image generation request (ms).
// gpt-image-1 can be slow; 120 s gives it a reasonable window.
const REQUEST_TIMEOUT_MS = 120000;

/**
 * Normalise a reference image entry into a fully-qualified data URL.
 *
 * @param {{ data: string, mimeType: string }} img
 * @returns {string}
 */
function toDataUrl(img) {
  const mime = (img.mimeType || 'image/jpeg').split(';')[0].trim();
  return img.data.startsWith('data:') ? img.data : ('data:' + mime + ';base64,' + img.data);
}

/**
 * Convert a data URL string to a Buffer of the raw binary bytes.
 * Used when the OpenAI edit endpoint requires a Buffer / Blob input.
 *
 * @param {string} dataUrl
 * @returns {Buffer}
 */
function dataUrlToBuffer(dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  try {
    const { prompt, referenceImages, referenceFidelity, hasReferenceImage } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(400).json({ error: { message: 'prompt (string) is required' } });
    }

    const safePrompt = prompt.trim().slice(0, MAX_PROMPT_LENGTH);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: { message: 'OpenAI API key not configured' } });
    }

    // Validate and collect reference images
    const refImageList = [];
    if (Array.isArray(referenceImages) && referenceImages.length > 0) {
      referenceImages.forEach(function (img) {
        if (
          img &&
          typeof img === 'object' &&
          typeof img.data === 'string' &&
          img.data.length > 0 &&
          (DATA_URL_PATTERN.test(img.data) || /^[A-Za-z0-9+/]/.test(img.data))
        ) {
          refImageList.push(img);
        }
      });
    }

    const hasRefImages = refImageList.length > 0 || hasReferenceImage === true;

    console.log('[Apocrita Image] prompt_length=' + safePrompt.length);
    console.log('[Apocrita Image] has_reference_images=' + hasRefImages);
    console.log('[Apocrita Image] reference_image_count=' + refImageList.length);
    console.log('[Apocrita Image] fidelity=' + (referenceFidelity || 'balanced'));

    const renderStart = Date.now();

    let imageBase64;
    let revisedPrompt;

    if (hasRefImages && refImageList.length > 0) {
      // ── IMAGE EDIT MODE (reference image provided) ────────────────────────
      // Use the Images Edit endpoint which accepts an image and a prompt.
      // We use the first reference image as the source.
      console.log('[Apocrita Image] mode=image_edit');

      const sourceDataUrl = toDataUrl(refImageList[0]);
      const sourceMime = (refImageList[0].mimeType || 'image/png').split(';')[0].trim();
      const sourceBuffer = dataUrlToBuffer(sourceDataUrl);

      // Build a fidelity-aware prompt prefix so the model knows how closely to
      // follow the reference image.
      let fidelityPrefix = '';
      if (referenceFidelity === 'exact') {
        fidelityPrefix = 'Maintain the exact composition, colors, and design of the reference image. ';
      } else if (referenceFidelity === 'high') {
        fidelityPrefix = 'Closely follow the reference image style and composition. ';
      }

      const editPrompt = (fidelityPrefix + safePrompt).slice(0, MAX_PROMPT_LENGTH);

      // Use native FormData + Blob (available in Node 18+ / Vercel runtime)
      // to build the multipart/form-data request required by the Images Edit endpoint.
      const form = new FormData();
      form.append('model', 'gpt-image-1');
      form.append('prompt', editPrompt);
      form.append('size', '1024x1024');
      form.append('n', '1');
      const imageBlob = new Blob([sourceBuffer], { type: sourceMime || 'image/png' });
      form.append('image', imageBlob, 'reference.png');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let editRes;
      try {
        editRes = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + apiKey
            // Content-Type is set automatically by fetch when body is FormData
          },
          body: form,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!editRes.ok) {
        let errData;
        try { errData = await editRes.json(); } catch (e) { errData = null; }
        const errMsg = (errData && errData.error && errData.error.message)
          || 'OpenAI image edit failed (HTTP ' + editRes.status + ')';
        console.error('[Apocrita Image] edit_error=' + errMsg);
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({ error: { message: errMsg } });
      }

      const editData = await editRes.json();
      const item = editData.data && editData.data[0];
      if (!item) {
        console.error('[Apocrita Image] edit_response_empty:', JSON.stringify(editData));
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({ error: { message: 'OpenAI returned an empty image edit response' } });
      }

      // gpt-image-1 always returns b64_json; dall-e-2/3 may return url
      imageBase64 = item.b64_json || null;
      revisedPrompt = item.revised_prompt || null;

      if (!imageBase64 && item.url) {
        // Fetch the image URL and convert to base64
        const imgFetch = await fetch(item.url);
        const imgBuf = Buffer.from(await imgFetch.arrayBuffer());
        imageBase64 = imgBuf.toString('base64');
      }

    } else {
      // ── TEXT-TO-IMAGE MODE ────────────────────────────────────────────────
      console.log('[Apocrita Image] mode=text_to_image');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let genRes;
      try {
        genRes = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
          },
          body: JSON.stringify({
            model: 'gpt-image-1',
            prompt: safePrompt,
            n: 1,
            size: '1024x1024'
          }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!genRes.ok) {
        let errData;
        try { errData = await genRes.json(); } catch (e) { errData = null; }
        const errMsg = (errData && errData.error && errData.error.message)
          || 'OpenAI image generation failed (HTTP ' + genRes.status + ')';
        console.error('[Apocrita Image] generation_error=' + errMsg);
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({ error: { message: errMsg } });
      }

      const genData = await genRes.json();
      const item = genData.data && genData.data[0];
      if (!item) {
        console.error('[Apocrita Image] generation_response_empty:', JSON.stringify(genData));
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({ error: { message: 'OpenAI returned an empty image generation response' } });
      }

      imageBase64 = item.b64_json || null;
      revisedPrompt = item.revised_prompt || null;

      if (!imageBase64 && item.url) {
        const imgFetch = await fetch(item.url);
        const imgBuf = Buffer.from(await imgFetch.arrayBuffer());
        imageBase64 = imgBuf.toString('base64');
      }
    }

    if (!imageBase64) {
      console.error('[Apocrita Image] no_image_data_in_response');
      res.setHeader('Content-Type', 'application/json');
      return res.status(502).json({ error: { message: 'No image data returned by OpenAI' } });
    }

    const renderTimeSec = ((Date.now() - renderStart) / 1000).toFixed(1);
    console.log('[Apocrita Image] render_time=' + renderTimeSec + 's');

    res.setHeader('Content-Type', 'application/json');
    const responseBody = { image: imageBase64 };
    if (revisedPrompt) responseBody.revisedPrompt = revisedPrompt;
    return res.status(200).json(responseBody);

  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[Apocrita Image] request_timed_out after ' + (REQUEST_TIMEOUT_MS / 1000) + 's');
      res.setHeader('Content-Type', 'application/json');
      return res.status(504).json({ error: { message: 'Image generation timed out. Please try again.' } });
    }
    console.error('[Apocrita Image] unhandled_error:', err);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: { message: err.message || 'Internal server error' } });
    }
  }
};
