// api/chat.js — Vercel serverless handler for /api/chat

// Accepts POST { messages: [...], agent, systemPrompt, model }.
// messages contains the full conversation history (user + assistant turns).
// The system prompt is prepended so the agent persona is applied on every request.
// Streams the OpenAI Chat Completions response back as Server-Sent Events (SSE).
// Each SSE event is forwarded directly from OpenAI.
// On early errors (before streaming begins): returns JSON { error: { message } }.

// All OpenAI requests are routed through the queue/worker layer so that at most
// MAX_CONCURRENT_REQUESTS are in-flight at once, improving scalability under load.
const { processRequest: _workerProcessRequest } = require('../server/worker');

// Redis-backed worker is loaded lazily so that a missing lib/ directory or
// misconfigured Redis credentials never break the existing request flow.
let _redisProcessWithRedis = null;
try { _redisProcessWithRedis = require('../lib/aiWorker').processWithRedis; } catch (e) { console.warn('api/chat: Redis worker unavailable, using in-memory queue:', e.message); }

// Conversation memory helper is loaded lazily for the same reason.
let _conversationMemory = null;
try { _conversationMemory = require('../lib/conversationMemory'); } catch (e) { console.warn('api/chat: conversation memory unavailable:', e.message); }

// Usage limits helper is loaded lazily so a missing or misconfigured module
// never breaks the core chat flow.
let _usageLimits = null;
try { _usageLimits = require('../lib/usageLimits'); } catch (e) { console.warn('api/chat: usage limits unavailable:', e.message); }

/**
 * Route an AI request through the Redis queue when available, with automatic
 * fallback to the existing in-memory concurrency queue if Redis is unavailable
 * or returns an error.
 */
async function processRequest(params) {
  if (_redisProcessWithRedis) {
    try {
      return await _redisProcessWithRedis(params);
    } catch (e) {
      // Redis path failed (unavailable, at capacity, network error, etc.) —
      // fall through to the reliable in-memory queue below.
    }
  }
  return _workerProcessRequest(params);
}

async function webSearch(query) {
  const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_redirect=1&no_html=1';
  const response = await fetch(url);
  if (!response.ok) {
    return '';
  }
  let data;
  try {
    data = await response.json();
  } catch (e) {
    return '';
  }
  return (data && data.AbstractText) || '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  try {
    const { messages, systemPrompt, agent, model, hiveMode, fileContext, image, images, video, webAccess, sessionId, userId, plan } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(400).json({ error: { message: 'messages array required' } });
    }

    // Normalise images: accept both the legacy single `image` field and the new `images` array.
    // Each entry in imageList is { data, mimeType } where data is a valid data URL or base64 string.
    const DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i;
    const imageList = [];
    if (images && Array.isArray(images) && images.length > 0) {
      images.forEach(function (img) {
        if (
          img &&
          typeof img === 'object' &&
          typeof img.data === 'string' &&
          img.data.length > 0 &&
          (DATA_URL_PATTERN.test(img.data) || /^[A-Za-z0-9+/]/.test(img.data))
        ) {
          imageList.push(img);
        }
      });
    } else if (image && typeof image === 'string' && image.length > 0) {
      imageList.push({ data: image, mimeType: 'image/jpeg' });
    }
    const hasImages = imageList.length > 0;

    // Enforce daily usage limits when the helper module is available.
    // The user is identified by userId (if provided) or sessionId as a fallback.
    // Guests and sessions without any identifier skip enforcement gracefully.
    if (_usageLimits) {
      const trackingId = (userId && userId !== 'guest') ? userId : sessionId;
      if (trackingId) {
        try {
          // Detect the action type from the request fields.
          // video flag → 'video', attached images → 'image', everything else → 'message'
          let actionType = 'message';
          if (video) {
            actionType = 'video';
          } else if (hasImages) {
            actionType = 'image';
          }

          const KNOWN_PLANS = Object.keys(_usageLimits.PLAN_LIMITS);
          const rawPlan = typeof plan === 'string' ? plan.toLowerCase() : '';
          const userPlan = KNOWN_PLANS.includes(rawPlan) ? rawPlan : 'starter';
          const result = await _usageLimits.checkAndTrack(trackingId, userPlan, actionType);
          if (!result.allowed) {
            res.setHeader('Content-Type', 'application/json');
            return res.status(429).json({ error: { message: result.error || 'Daily limit reached. Upgrade your plan or wait for the reset.' } });
          }
        } catch (e) {
          // Usage limit check failure is non-fatal — let the request proceed
          console.warn('api/chat: usage limit check failed:', e.message);
        }
      }
    }

    const identityBlock = '\n\nYou are Apocrita, an advanced AI assistant. Your name is Apocrita. If a user asks who you are or asks if you are Apocrita, you must respond that you are Apocrita. You assist users with: conversations, coding, research, image generation, file analysis, business insights, and general knowledge. Always speak confidently as Apocrita and represent the Apocrita AI platform.';

    const fallbackPrompts = {
      general: 'You are a helpful AI assistant.' + identityBlock,
      coding: 'You are a professional software engineer that writes and explains code clearly.' + identityBlock,
      research: 'You are an academic researcher who explains complex topics clearly.' + identityBlock,
      business: 'You are a startup strategist and marketing advisor.' + identityBlock,
      robotics: 'You are a robotics and automation engineering expert.' + identityBlock
    };

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: { message: 'API key not configured' } });
    }

    const modelMap = {
      fast: 'gpt-4o-mini',
      smart: 'gpt-4o',
      coding: 'gpt-4o',
      vision: 'gpt-4o',
      // image-generator and video-generator route to dedicated endpoints in the
      // frontend; this mapping is a fallback so any chat requests that do reach
      // this handler still use a capable model.
      'image-generator': 'gpt-4o',
      'video-generator': 'gpt-4o'
    };
    const selectedModel = modelMap[model] || 'gpt-4o';

    if (!hiveMode) {
      const resolvedSystemPrompt = systemPrompt || fallbackPrompts[agent] || fallbackPrompts.general;

      // Perform web search if webAccess is enabled and the Research Agent is active.
      let webResults = '';
      if (webAccess && agent === 'research') {
        const latestUserMessage = messages[messages.length - 1] && messages[messages.length - 1].content;
        if (latestUserMessage) {
          try {
            webResults = await webSearch(latestUserMessage);
          } catch (e) {
            // Web search failure is non-fatal; proceed without results
          }
        }
      }

      // Build the full message list: system prompt first, then the complete conversation history.
      // Placing the system prompt at position 0 ensures the agent persona is always in effect.
      // The spread of messages sends every prior user + assistant turn so the AI remembers context.

      // When a sessionId is provided, load the stored conversation from Redis and append
      // the latest user message before sending to OpenAI.  This is entirely opt-in:
      // if sessionId is absent (or Redis is unavailable) the behaviour is unchanged.
      let chatMessages = messages;
      if (sessionId && _conversationMemory) {
        try {
          const existingHistory = await _conversationMemory.getConversation(sessionId);
          if (existingHistory.length === 0) {
            // First request for this session — seed Redis with the full incoming history
            await _conversationMemory.saveConversation(sessionId, messages);
            chatMessages = messages;
          } else {
            // Subsequent request — append only the new user message to the stored history
            const newUserMessage = messages[messages.length - 1];
            chatMessages = await _conversationMemory.appendMessage(sessionId, newUserMessage);
          }
        } catch (e) {
          // Redis failure is non-fatal — fall back to the original messages array
          chatMessages = messages;
        }
      }

      // When images are attached, transform the last user message into a multimodal
      // content array so the vision model can analyse the images in context.
      let finalChatMessages = chatMessages;
      if (hasImages) {
        const lastMsg = chatMessages[chatMessages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          const contentParts = [];
          // Include any text the user typed
          if (lastMsg.content && typeof lastMsg.content === 'string') {
            // Strip any image-label suffix appended by the frontend
            const textOnly = lastMsg.content.replace(/\n?[\uD83D\uDDBC\uFE0F]+\s*\d*\s*image[s]?\s*attached\s*$/i, '').trim();
            if (textOnly) contentParts.push({ type: 'text', text: textOnly });
          }
          // Append each image as an image_url content part
          imageList.forEach(function (img) {
            const mimeType = (img.mimeType || 'image/jpeg').split(';')[0].trim();
            const dataUrl = img.data;
            // dataUrl may already be a full data URL or raw base64
            const url = dataUrl.startsWith('data:') ? dataUrl : `data:${mimeType};base64,${dataUrl}`;
            contentParts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
          });
          if (contentParts.length > 0) {
            finalChatMessages = [
              ...chatMessages.slice(0, -1),
              { role: 'user', content: contentParts }
            ];
          }
        }
      }

      const apiMessages = [
        { role: 'system', content: resolvedSystemPrompt },
        ...(fileContext && fileContext.length > 0 ? [{ role: 'system', content: 'The following document was uploaded by the user. Use it as reference when answering:\n\n' + fileContext }] : []),
        ...(webResults ? [{ role: 'system', content: 'WEB SEARCH RESULTS:\n' + webResults }] : []),
        ...finalChatMessages
      ];

      // Send the full conversation history (system prompt + all prior turns) to OpenAI.
      // This gives the model the complete context it needs to produce a coherent reply.
      // The call is routed through the worker queue to limit concurrent OpenAI requests.
      const upstream = await processRequest({
        apiMessages,
        apiKey,
        selectedModel,
        stream: true,
        agentType: agent
      });

      if (!upstream.ok) {
        let errorData;
        try {
          errorData = await upstream.json();
        } catch (e) {
          errorData = { error: { message: 'Upstream error' } };
        }
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({ error: (errorData && errorData.error) || { message: 'Upstream error' } });
      }

      // Stream SSE events from OpenAI directly to the client.
      // When a sessionId is present, accumulate the assistant text from each SSE
      // delta chunk so the full reply can be persisted to Redis after streaming ends.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      const captureMemory = !!(sessionId && _conversationMemory);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);

        // Parse SSE delta chunks to reconstruct the full assistant reply
        if (captureMemory) {
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const json = JSON.parse(line.slice(6));
                const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
                if (delta) assistantContent += delta;
              } catch (e) {
                // Malformed chunk — skip
              }
            }
          }
        }
      }

      // Save the assistant reply to Redis so the next request can include it
      if (captureMemory && assistantContent) {
        try {
          await _conversationMemory.appendMessage(sessionId, { role: 'assistant', content: assistantContent });
        } catch (e) {
          // Non-fatal — the response has already been sent to the client
        }
      }

      res.end();
    } else {
      // Hive Mode: run multiple agents and combine their responses
      const hiveAgents = {
        research: 'You are a research specialist providing analytical insights.',
        business: 'You are a business strategist providing startup and market advice.',
        coding: 'You are a senior software engineer providing technical implementation.',
        robotics: 'You are a robotics engineer providing automation and hardware ideas.'
      };

      const hiveAgentLabels = {
        research: 'Research Agent',
        business: 'Business Agent',
        coding: 'Coding Agent',
        robotics: 'Robotics Agent'
      };

      // When webAccess is enabled, have the Research Agent gather live web data
      // and share those results with all hive agents.
      let hiveWebResults = '';
      if (webAccess) {
        const latestUserMessage = messages[messages.length - 1] && messages[messages.length - 1].content;
        if (latestUserMessage) {
          try {
            hiveWebResults = await webSearch(latestUserMessage);
          } catch (e) {
            // Web search failure is non-fatal; proceed without results
          }
        }
      }

      async function callAgent(agentName) {
        // Build the hive messages; if images were attached, add them to the last user message.
        let hiveMessages = messages;
        if (hasImages) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.role === 'user') {
            const contentParts = [];
            if (lastMsg.content && typeof lastMsg.content === 'string') {
              const textOnly = lastMsg.content.replace(/\n?[\uD83D\uDDBC\uFE0F]+\s*\d*\s*image[s]?\s*attached\s*$/i, '').trim();
              if (textOnly) contentParts.push({ type: 'text', text: textOnly });
            }
            imageList.forEach(function (img) {
              const mimeType = (img.mimeType || 'image/jpeg').split(';')[0].trim();
              const dataUrl = img.data;
              const url = dataUrl.startsWith('data:') ? dataUrl : `data:${mimeType};base64,${dataUrl}`;
              contentParts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
            });
            if (contentParts.length > 0) {
              hiveMessages = [...messages.slice(0, -1), { role: 'user', content: contentParts }];
            }
          }
        }
        const agentMessages = [
          { role: 'system', content: hiveAgents[agentName] },
          ...(fileContext && fileContext.length > 0 ? [{ role: 'system', content: 'The following document was uploaded by the user. Use it as reference when answering:\n\n' + fileContext }] : []),
          ...(hiveWebResults ? [{ role: 'system', content: 'The following web research results are available:\n' + hiveWebResults }] : []),
          ...hiveMessages
        ];
        // Route hive-mode agent calls through the worker queue to limit concurrency.
        const upstream = await processRequest({
          apiMessages: agentMessages,
          apiKey,
          selectedModel,
          stream: false,
          agentType: agentName
        });
        if (!upstream.ok) {
          return '[Error from ' + hiveAgentLabels[agentName] + ': HTTP ' + upstream.status + ']';
        }
        const data = await upstream.json();
        return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '[No response]';
      }

      const agentKeys = ['research', 'business', 'coding', 'robotics'];
      const results = await Promise.allSettled(agentKeys.map(callAgent));

      const combined = agentKeys.map(function (key, i) {
        const result = results[i];
        const text = result.status === 'fulfilled' ? result.value : '[Error from ' + hiveAgentLabels[key] + ']';
        return hiveAgentLabels[key] + ':\n' + text;
      }).join('\n\n');

      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({ content: combined });
    }
  } catch (err) {
    console.error('api/chat error:', err);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      const isNetworkError = err.cause || err.code || (err.message && err.message.includes('fetch'));
      const message = isNetworkError
        ? 'Failed to reach upstream AI service: ' + (err.message || 'network error')
        : (err.message || 'Internal server error');
      return res.status(500).json({ error: { message } });
    }
    res.end();
  }
};
