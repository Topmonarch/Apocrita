// chat.js
// Frontend chat handler: POST to /api/chat (SSE stream), manage empty-state.
// Maintains conversation memory in messages array.

// Preserves hymAuth checks and saveMessageToHistory behavior.


(function () {
  'use strict';

  var messagesEl = document.getElementById('messages');
  var messageInput = document.getElementById('message-input');
  var emptyState = document.getElementById('empty-state');

  // Conversation memory: each chat stores its full message history in conversations[id].messages.
  // When a message is sent, the entire history is forwarded to the backend so the AI maintains context.
  var conversations = {};
  var currentChatId = null;

  // Current agent selection
  var currentAgent = 'general';

  // Current model selection
  var DEFAULT_MODEL = 'smart';
  var currentModel = DEFAULT_MODEL;

  // Hive Mode toggle
  var hiveMode = false;

  // Web research toggle
  var webAccess = false;

  // Stores uploaded document text
  var uploadedFileContent = "";

  // Stores captured or uploaded image (base64 data URL)
  var uploadedImageData = "";

  // Pending image attachments: array of {id, dataUrl, mimeType, name}
  // Images stay here until the user presses Send.
  var pendingImageAttachments = [];
  var _attachmentIdCounter = 0;

  // Reference fidelity level for image generation when reference images are attached.
  // 'balanced' | 'high' | 'exact'
  // Defaults to 'balanced'; automatically set to 'high' when the first image is attached.
  var referenceFidelity = 'balanced';

  // Keywords that trigger VIDEO_GENERATION_ROUTE regardless of the active model.
  // When any of these words appear in the prompt, the request is routed to
  // /api/video-route instead of the image generation pipeline.
  var VIDEO_KEYWORDS = ['video', 'animate', 'animation', 'clip', 'motion', 'cinematic', 'make this move'];

  /**
   * Returns true when the prompt text contains at least one video keyword.
   * Case-insensitive whole-word match (except the multi-word phrase).
   *
   * @param {string} text
   * @returns {boolean}
   */
  function promptContainsVideoKeywords(text) {
    if (!text || typeof text !== 'string') return false;
    var lower = text.toLowerCase();
    for (var k = 0; k < VIDEO_KEYWORDS.length; k++) {
      var kw = VIDEO_KEYWORDS[k];
      if (kw === 'make this move') {
        if (lower.indexOf('make this move') !== -1) return true;
      } else {
        // whole-word check
        var re = new RegExp('\\b' + kw.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '\\b', 'i');
        if (re.test(text)) return true;
      }
    }
    return false;
  }

  // Render the attachment tray with thumbnails and remove buttons.
  // Also shows/hides the Reference Fidelity control based on whether
  // images are pending, and syncs the active button state.
  function renderAttachmentTray() {
    var tray = document.getElementById('attachment-tray');
    var fidelityRow = document.getElementById('reference-fidelity-row');
    if (!tray) return;
    if (pendingImageAttachments.length === 0) {
      tray.style.display = 'none';
      tray.innerHTML = '';
      // Hide fidelity row and reset to balanced when all images are removed
      if (fidelityRow) {
        fidelityRow.style.display = 'none';
        var resetBtns = fidelityRow.querySelectorAll('.fidelity-btn');
        for (var j = 0; j < resetBtns.length; j++) {
          resetBtns[j].classList.remove('active');
        }
      }
      referenceFidelity = 'balanced';
      return;
    }
    tray.style.display = 'flex';
    tray.innerHTML = '';
    pendingImageAttachments.forEach(function (att) {
      var item = document.createElement('div');
      item.className = 'attachment-item';
      var img = document.createElement('img');
      img.src = att.dataUrl;
      img.alt = att.name;
      img.className = 'attachment-thumb';
      var removeBtn = document.createElement('button');
      removeBtn.className = 'attachment-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remove ' + att.name;
      // Remove by unique ID so indices never mismatch after a prior deletion
      (function (id) {
        removeBtn.addEventListener('click', function () {
          pendingImageAttachments = pendingImageAttachments.filter(function (a) { return a.id !== id; });
          renderAttachmentTray();
        });
      }(att.id));
      item.appendChild(img);
      item.appendChild(removeBtn);
      tray.appendChild(item);
    });
    // Show fidelity row and sync active button state
    if (fidelityRow) {
      fidelityRow.style.display = 'flex';
      var btns = fidelityRow.querySelectorAll('.fidelity-btn');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].getAttribute('data-fidelity') === referenceFidelity) {
          btns[i].classList.add('active');
        } else {
          btns[i].classList.remove('active');
        }
      }
    }
  }

  // Add an image to pending attachments.
  // dataUrl: full data URL (data:image/...;base64,...)
  // When the first image is added the referenceFidelity is defaulted to 'high'
  // so the reference is used as the design blueprint unless the user overrides it.
  function addImageAttachment(dataUrl, mimeType, name) {
    if (pendingImageAttachments.length >= 20) {
      alert('Maximum 20 images per message.');
      return;
    }
    var isFirstImage = pendingImageAttachments.length === 0;
    pendingImageAttachments.push({
      id: ++_attachmentIdCounter,
      dataUrl: dataUrl,
      mimeType: mimeType || 'image/jpeg',
      name: name || 'image'
    });
    // Default to 'high' fidelity when the first image is attached
    if (isFirstImage && referenceFidelity === 'balanced') {
      referenceFidelity = 'high';
    }
    renderAttachmentTray();
    if (messageInput) messageInput.focus();
  }

  // Projects: containers for chats and files
  var projects = {};
  var currentProject = 'Default';

  // Subscription plan limits per action type (null = unlimited)
  var planLimits = {
    starter: { messages: 30,   images: 10,  videos: 10  },
    basic:   { messages: 150,  images: 50,  videos: 20  },
    premium: { messages: 500,  images: 75,  videos: 30  },
    ultimate:{ messages: null, images: null, videos: null }
  };

  // Current user plan — defaults to 'starter' for all new users
  var userPlan = localStorage.getItem('hymenoptera_plan') || 'starter';

  // Returns today's date as a stable YYYY-MM-DD string in the Pacific/Auckland timezone.
  // Using a fixed timezone and date-only format keeps the reset boundary consistent and
  // avoids locale-dependent output from Date.prototype.toDateString().
  function getTodayDateString() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Auckland',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  }

  // Daily message usage tracking
  var messagesToday = Number(localStorage.getItem('messagesToday')) || 0;
  var imagesToday   = Number(localStorage.getItem('imagesToday'))   || 0;
  var videosToday   = Number(localStorage.getItem('videosToday'))   || 0;
  var lastResetDate = localStorage.getItem('lastResetDate') || getTodayDateString();

  // Daily reset check on page load: if the calendar day has changed, reset the counter
  (function () {
    var today = getTodayDateString();
    if (lastResetDate !== today) {
      messagesToday = 0;
      imagesToday   = 0;
      videosToday   = 0;
      lastResetDate = today;
      localStorage.setItem('messagesToday', '0');
      localStorage.setItem('imagesToday',   '0');
      localStorage.setItem('videosToday',   '0');
      localStorage.setItem('lastResetDate', today);
    }
  }());

  var modelLabels = {
    fast: 'Fast',
    smart: 'Smart',
    coding: 'Coding',
    vision: 'Vision',
    'image-generator': 'Image Creator',
    'video-generator': 'Video Generator'
  };

  var identityBlock = '\n\nYou are Hymenoptera, an advanced AI assistant. Your name is Hymenoptera. If a user asks who you are or asks if you are Hymenoptera, you must respond that you are Hymenoptera. You assist users with: conversations, coding, research, image generation, file analysis, business insights, and general knowledge. Always speak confidently as Hymenoptera and represent the Hymenoptera AI platform.';

  var agents = {
    general: {
      name: 'General AI',
      systemPrompt: 'You are a helpful AI assistant.' + identityBlock,
      tools: []
    },
    coding: {
      name: 'Coding Agent',
      systemPrompt: 'You are a professional software engineer who writes clean, correct code and explains programming clearly.' + identityBlock,
      tools: []
    },
    research: {
      name: 'Research Agent',
      systemPrompt: 'You specialize in research, summarizing topics, and explaining complex subjects clearly.' + identityBlock,
      tools: []
    },
    business: {
      name: 'Business Agent',
      systemPrompt: 'You provide startup ideas, business strategies, and market analysis.' + identityBlock,
      tools: []
    },
    robotics: {
      name: 'Robotics Agent',
      systemPrompt: 'You assist with robotics engineering, automation, sensors, and control systems.' + identityBlock,
      tools: []
    }
  };

  var NO_RESPONSE_MSG = 'No response received from server';

  var WELCOME_MESSAGE = 'Hello, I\'m Hymenoptera \uD83D\uDC1D\nYour AI assistant and agent platform.\n\nYou can ask questions, generate images, analyze files, or switch to specialized agents like Coding, Research, Business, and Robotics.\n\nHow can I help today?';

  function updateAgentIndicator() {
    var indicator = document.getElementById('agent-indicator');
    if (indicator) {
      indicator.textContent = 'Agent: ' + (agents[currentAgent] ? agents[currentAgent].name : 'General AI');
    }
    document.querySelectorAll('.agent-item').forEach(function (item) {
      item.classList.toggle('active', item.dataset.agent === currentAgent);
    });
  }

  function updateModelIndicator() {
    var btn = document.getElementById('model-button');
    if (btn) {
      btn.textContent = modelLabels[currentModel] || 'Smart';
    }
    document.querySelectorAll('.model-option').forEach(function (opt) {
      opt.classList.toggle('active', opt.dataset.model === currentModel);
    });
  }

  function setStatus(text) {
    var indicator = document.getElementById('status-indicator');
    if (indicator) {
      indicator.textContent = 'Status: ' + text;
    }
  }

  function updateHiveIndicator() {
    var indicator = document.getElementById('hive-indicator');
    if (indicator) {
      indicator.textContent = 'Hive Mode: ' + (hiveMode ? 'ON' : 'OFF');
      indicator.style.color = hiveMode ? '#2d8cff' : '#888';
    }
  }

  function updateMessageCounter() {
    var counter = document.getElementById('message-counter');
    if (!counter) return;
    var limits = planLimits[userPlan] || planLimits.starter;
    var msgLimit = limits.messages;
    counter.textContent = msgLimit === null
      ? 'Messages: Unlimited'
      : 'Messages Today: ' + messagesToday + ' / ' + msgLimit;
  }

  function updateImageCounter() {
    var counter = document.getElementById('image-counter');
    if (!counter) return;
    var limits = planLimits[userPlan] || planLimits.starter;
    var imgLimit = limits.images;
    counter.textContent = imgLimit === null
      ? 'Images: Unlimited'
      : 'Images Today: ' + imagesToday + ' / ' + imgLimit;
  }

  function updateVideoCounter() {
    var counter = document.getElementById('video-counter');
    if (!counter) return;
    var limits = planLimits[userPlan] || planLimits.starter;
    var vidLimit = limits.videos;
    counter.textContent = vidLimit === null
      ? 'Videos: Unlimited'
      : 'Videos Today: ' + videosToday + ' / ' + vidLimit;
  }

  function updateResetLabel() {
    var label = document.getElementById('reset-label');
    if (!label) return;
    var limits = planLimits[userPlan] || planLimits.starter;
    var isUnlimited = limits.messages === null && limits.images === null && limits.videos === null;
    label.textContent = isUnlimited ? 'Unlimited Access' : 'Resets at 12:00 AM';
  }

  function updateAllCounters() {
    updateMessageCounter();
    updateImageCounter();
    updateVideoCounter();
    updateResetLabel();
  }

  // Fetch the authoritative usage count from the backend and update the local
  // counter. Called on page load, new chat, and when a day boundary is crossed
  // so the displayed counter always reflects the backend source of truth.
  function fetchUsageFromBackend() {
    try {
      var hymenAuth = window.hymAuth && window.hymAuth.currentUser;
      var userId = hymenAuth ? hymenAuth.uid : 'guest';
      var sessionId = currentChatId || '';
      var url = '/api/usage?plan=' + encodeURIComponent(userPlan) +
        '&userId=' + encodeURIComponent(userId) +
        '&sessionId=' + encodeURIComponent(sessionId);
      fetch(url).then(function (response) {
        if (!response.ok) {
          console.warn('fetchUsageFromBackend: unexpected status', response.status);
          return;
        }
        return response.json();
      }).then(function (data) {
        if (data && typeof data.messages_used === 'number') {
          messagesToday = data.messages_used;
          localStorage.setItem('messagesToday', messagesToday);
        }
        if (data && typeof data.images_used === 'number') {
          imagesToday = data.images_used;
          localStorage.setItem('imagesToday', imagesToday);
        }
        if (data && typeof data.videos_used === 'number') {
          videosToday = data.videos_used;
          localStorage.setItem('videosToday', videosToday);
        }
        if (data && (typeof data.messages_used === 'number' || typeof data.images_used === 'number' || typeof data.videos_used === 'number')) {
          updateAllCounters();
        }
      }).catch(function () {
        // Non-fatal: fall back to locally tracked counter
      });
    } catch (e) {
      // Non-fatal: ignore errors in the refresh path
    }
  }

  // Fetch the authoritative plan from the server and apply it if it differs
  // from the locally cached value.  Called on page load and after returning
  // from a Stripe payment or billing-portal session so the UI always reflects
  // the server-side source of truth without requiring a sign-out/sign-in cycle.
  function fetchPlanFromServer(onComplete) {
    try {
      var user = localStorage.getItem('hymenoptera_user');
      if (!user || user === 'guest') {
        if (typeof onComplete === 'function') onComplete();
        return;
      }
      fetch('/api/plan?email=' + encodeURIComponent(user))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.plan) {
            var serverPlan = data.plan;
            if (serverPlan !== userPlan) {
              console.log('fetchPlanFromServer: applying server plan', serverPlan, '(was', userPlan + ')');
              userPlan = serverPlan;
              localStorage.setItem('hymenoptera_plan', serverPlan);
              updateAllCounters();
              updatePlanDisplay();
            }
            // Persist customerId for billing-portal access
            if (data.customerId) {
              localStorage.setItem('hymenoptera_stripe_customer_' + user, data.customerId);
            }
          }
          if (typeof onComplete === 'function') onComplete();
        })
        .catch(function () {
          // Non-fatal: keep existing local plan
          if (typeof onComplete === 'function') onComplete();
        });
    } catch (e) {
      if (typeof onComplete === 'function') onComplete();
    }
  }

  function updateWebIndicator() {
    var indicator = document.getElementById('web-indicator');
    if (indicator) {
      indicator.textContent = 'Web: ' + (webAccess ? 'ON' : 'OFF');
      indicator.style.color = webAccess ? '#2d8cff' : '#888';
    }
  }

  window.toggleHiveMode = function () {
    hiveMode = !hiveMode;
    updateHiveIndicator();
  };

  window.toggleWebAccess = function () {
    webAccess = !webAccess;
    updateWebIndicator();
  };

  // Model dropdown toggle
  document.addEventListener('click', function (e) {
    var btn = document.getElementById('model-button');
    var dropdown = document.getElementById('model-dropdown');
    if (!dropdown) return;
    if (btn && btn.contains(e.target)) {
      dropdown.classList.toggle('open');
    } else {
      dropdown.classList.remove('open');
    }
  });

  // Model option selection
  document.querySelectorAll('.model-option').forEach(function (opt) {
    opt.addEventListener('click', function (e) {
      e.stopPropagation();
      var selected = opt.dataset.model;
      currentModel = selected;
      if (currentChatId && conversations[currentChatId]) {
        conversations[currentChatId].model = selected;
        saveConversations();
      }
      updateModelIndicator();
      var dropdown = document.getElementById('model-dropdown');
      if (dropdown) dropdown.classList.remove('open');
    });
  });

  document.querySelectorAll('.agent-item').forEach(function (item) {
    item.onclick = function () {
      currentAgent = item.dataset.agent;
      if (currentChatId && conversations[currentChatId]) {
        conversations[currentChatId].agent = currentAgent;
        saveConversations();
      }
      updateAgentIndicator();
      if (typeof closeSidebarOnMobile === 'function') closeSidebarOnMobile();
    };
  });

  // Load saved conversations from localStorage
  try {
    conversations = JSON.parse(localStorage.getItem('hymenoptera_conversations')) || {};
  } catch (e) {
    conversations = {};
  }

  // Load saved projects from localStorage
  try {
    projects = JSON.parse(localStorage.getItem('hymenoptera_projects')) || { 'Default': { files: [] } };
  } catch (e) {
    projects = { 'Default': { files: [] } };
  }
  if (!projects[currentProject]) {
    projects[currentProject] = { files: [] };
  }

  // Migrate old array-based conversations to the new metadata object format
  (function migrateConversations() {
    var ids = Object.keys(conversations).sort(function (a, b) {
      var ta = parseInt(a.split('_')[1], 10) || 0;
      var tb = parseInt(b.split('_')[1], 10) || 0;
      return ta - tb;
    });
    ids.forEach(function (id, index) {
      if (Array.isArray(conversations[id])) {
        conversations[id] = {
          title: 'Chat ' + (index + 1),
          pinned: false,
          archived: false,
          agent: 'general',
          model: DEFAULT_MODEL,
          project: 'Default',
          messages: conversations[id]
        };
      } else {
        if (!conversations[id].title) conversations[id].title = 'Chat ' + (index + 1);
        if (conversations[id].pinned === undefined) conversations[id].pinned = false;
        if (conversations[id].archived === undefined) conversations[id].archived = false;
        if (!conversations[id].messages) conversations[id].messages = [];
        if (!conversations[id].model) conversations[id].model = DEFAULT_MODEL;
        if (!conversations[id].agent) conversations[id].agent = 'general';
        if (!conversations[id].project) conversations[id].project = 'Default';
      }
    });
  }());

  function generateChatId() {
    var rand = Math.random().toString(36).slice(2, 7);
    return 'chat_' + Date.now() + '_' + rand;
  }

  function hideEmptyState() {
    if (emptyState) {
      emptyState.classList.add('hidden');
    }
  }

  function showEmptyState() {
    if (emptyState) {
      emptyState.classList.remove('hidden');
    }
  }

  function saveConversations() {
    try {
      localStorage.setItem('hymenoptera_conversations', JSON.stringify(conversations));
      localStorage.setItem('hymenoptera_projects', JSON.stringify(projects));
    } catch (e) {
      console.warn('saveConversations error', e);
    }
  }

  function renderProjectList() {
    var list = document.getElementById('project-list');
    if (!list) return;
    list.innerHTML = '';
    Object.keys(projects).forEach(function (name) {
      var item = document.createElement('div');
      item.className = 'project-item' + (name === currentProject ? ' active' : '');
      item.textContent = name;
      item.onclick = function () { switchProject(name); };
      list.appendChild(item);
    });
  }

  function createAndSwitchProject(projectName) {
    if (!projectName || !projectName.trim()) return;
    projectName = projectName.trim();
    if (projects[projectName]) {
      alert('A project named "' + projectName + '" already exists. Switching to it.');
    } else {
      projects[projectName] = { files: [] };
    }
    currentProject = projectName;
    saveConversations();
    renderProjectList();
    currentChatId = null;
    clearChatUI();
    renderChatHistory();
  }

  function switchProject(projectName) {
    currentProject = projectName;
    if (!projects[currentProject]) {
      projects[currentProject] = { files: [] };
    }
    currentChatId = null;
    clearChatUI();
    renderChatHistory();
    renderProjectList();
    if (typeof closeSidebarOnMobile === 'function') closeSidebarOnMobile();
  }

  // Track the currently open chat options menu
  var activeChatMenu = null;

  function closeChatMenu() {
    if (activeChatMenu) {
      activeChatMenu.remove();
      activeChatMenu = null;
    }
  }

  function openChatMenu(chatId, anchorEl) {
    closeChatMenu();
    var menu = document.createElement('div');
    menu.className = 'chat-menu';

    var conv = conversations[chatId];
    var menuItems = [
      { label: 'Rename', action: function () { renameChat(chatId); } },
      { label: conv && conv.pinned ? 'Unpin' : 'Pin', action: function () { pinChat(chatId); } },
      { label: 'Archive', action: function () { archiveChat(chatId); } },
      { label: 'Delete', action: function () { deleteChat(chatId); }, cls: 'delete' }
    ];

    menuItems.forEach(function (mi) {
      var div = document.createElement('div');
      div.className = 'menu-item' + (mi.cls ? ' ' + mi.cls : '');
      div.textContent = mi.label;
      div.onclick = function (e) {
        e.stopPropagation();
        closeChatMenu();
        mi.action();
      };
      menu.appendChild(div);
    });

    document.body.appendChild(menu);
    var rect = anchorEl.getBoundingClientRect();
    var menuWidth = menu.offsetWidth;
    var left = rect.right - menuWidth;
    if (left < 0) left = 0;
    menu.style.left = left + 'px';
    menu.style.top = rect.bottom + 'px';
    activeChatMenu = menu;
  }

  document.addEventListener('click', function () { closeChatMenu(); });

  function renameChat(chatId) {
    if (!conversations[chatId]) return;
    var current = conversations[chatId].title || '';
    var newTitle = prompt('Rename chat:', current);
    if (newTitle !== null && newTitle.trim() !== '') {
      conversations[chatId].title = newTitle.trim();
      saveConversations();
      renderChatHistory();
    }
  }

  function pinChat(chatId) {
    if (!conversations[chatId]) return;
    conversations[chatId].pinned = !conversations[chatId].pinned;
    saveConversations();
    renderChatHistory();
  }

  function archiveChat(chatId) {
    if (!conversations[chatId]) return;
    conversations[chatId].archived = true;
    if (currentChatId === chatId) {
      currentChatId = null;
      clearChatUI();
    }
    saveConversations();
    renderChatHistory();
  }

  function deleteChat(chatId) {
    if (!confirm('Are you sure you want to delete this chat?')) return;
    delete conversations[chatId];
    if (currentChatId === chatId) {
      currentChatId = null;
      clearChatUI();
    }
    saveConversations();
    renderChatHistory();
  }

  function renderChatHistory() {
    var history = document.getElementById('chat-history');
    if (!history) return;
    history.innerHTML = '';

    // Exclude archived chats and chats not in the current project; sort pinned to top, then by timestamp descending
    var ids = Object.keys(conversations).filter(function (id) {
      return !conversations[id].archived && conversations[id].project === currentProject;
    });
    ids.sort(function (a, b) {
      var pa = conversations[a].pinned ? 1 : 0;
      var pb = conversations[b].pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      var ta = parseInt(a.split('_')[1], 10) || 0;
      var tb = parseInt(b.split('_')[1], 10) || 0;
      return tb - ta;
    });

    ids.forEach(function (id) {
      var conv = conversations[id];
      var item = document.createElement('div');
      item.className = 'chat-item';
      if (id === currentChatId) item.classList.add('active');

      var titleSpan = document.createElement('span');
      titleSpan.className = 'chat-title';
      titleSpan.textContent = conv.title || 'Chat';

      var optBtn = document.createElement('button');
      optBtn.className = 'chat-options';
      optBtn.textContent = '⋯';
      optBtn.title = 'Options';
      optBtn.onclick = function (e) {
        e.stopPropagation();
        openChatMenu(id, optBtn);
      };

      item.appendChild(titleSpan);
      item.appendChild(optBtn);
      item.onclick = function () { loadChat(id); };
      history.appendChild(item);
    });
  }

  function clearChatUI() {
    if (messagesEl) messagesEl.innerHTML = '';
    showEmptyState();
  }

  function loadChat(chatId) {
    if (typeof setCurrentView === 'function' && window.currentView === 'settings') {
      setCurrentView('chat');
    }
    currentChatId = chatId;
    var conv = conversations[chatId];
    currentModel = (conv && conv.model) ? conv.model : DEFAULT_MODEL;
    currentAgent = (conv && conv.agent) ? conv.agent : 'general';
    updateModelIndicator();
    updateAgentIndicator();
    var chatMessages = (conv && conv.messages) ? conv.messages : (Array.isArray(conv) ? conv : []);

    // Clear any pending image attachments when switching conversations
    pendingImageAttachments = [];
    renderAttachmentTray();

    if (typeof closeSidebarOnMobile === 'function') closeSidebarOnMobile();

    // Fade out, swap content, fade back in
    if (messagesEl) {
      messagesEl.classList.add('fading');
    }
    setTimeout(function () {
      clearChatUI();
      chatMessages.forEach(function (msg) {
        // Pass full object for structured messages so addMessage can reconstruct
        // image bubbles and user thumbnail rows from stored data.
        if (msg.type === 'generated-image' || (msg.role === 'user' && msg.images && msg.images.length > 0)) {
          addMessage(msg.role, msg);
        } else {
          addMessage(msg.role, msg.content);
        }
      });
      // Show welcome message for empty conversations
      if (chatMessages.length === 0) {
        addMessage('assistant', WELCOME_MESSAGE);
      }
      renderChatHistory();
      if (messagesEl) {
        messagesEl.classList.remove('fading');
      }
    }, 150);
  }


  // Save a message to local history only if allowed (logged-in, non-guest users)
  function saveMessageToHistory(msg) {
    try {
      if (window.hymAuth) {
        // If hymAuth is present, respect its canSaveHistory gate
        if (!window.hymAuth.canSaveHistory || !window.hymAuth.canSaveHistory()) return;
      } else {
        // Fallback: only save for authenticated (non-guest) users
        var user = localStorage.getItem('hymenoptera_user');
        if (!user || user === 'guest') return;
      }
      var key = 'hym_messages';
      var raw = localStorage.getItem(key);
      var arr = raw ? JSON.parse(raw) : [];
      arr.push(msg);
      localStorage.setItem(key, JSON.stringify(arr));
    } catch (e) {
      console.warn('saveMessageToHistory error', e);
    }
  }



  // Fallback copy for browsers without Clipboard API
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    try {
      ta.focus();
      ta.select();
      document.execCommand('copy');
    } catch (e) {
      /* ignore */
    } finally {
      document.body.removeChild(ta);
    }
  }

  // Create a copy button; getTextFn() returns the text to copy when clicked
  function makeCopyBtn(getTextFn) {
    var btn = document.createElement('button');
    btn.className = 'msg-copy-btn';
    btn.title = 'Copy message';
    btn.innerHTML = '<img src="public/icons/Copy.png" class="copy-icon" alt="Copy" />';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var text = getTextFn();
      var doFeedback = function () {
        btn.innerHTML = '<span class="copy-feedback">&#10003;</span>';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.innerHTML = '<img src="public/icons/Copy.png" class="copy-icon" alt="Copy" />';
          btn.classList.remove('copied');
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(doFeedback, function () {
          fallbackCopy(text);
          doFeedback();
        });
      } else {
        fallbackCopy(text);
        doFeedback();
      }
    });
    return btn;
  }

  // Convert a plain streaming bubble (text-only innerText) into the
  // text-span + copy-button structure once the content is finalised.
  function convertToCopyableBubble(bubble) {
    if (!bubble || bubble.querySelector('.msg-copy-btn')) return;
    var text = bubble.innerText;
    bubble.innerHTML = '';
    var textSpan = document.createElement('span');
    textSpan.className = 'msg-text';
    textSpan.innerText = text;
    bubble.appendChild(textSpan);
    bubble.appendChild(makeCopyBtn(function () { return textSpan.innerText; }));
  }

  // Render a user bubble that contains optional text and image thumbnails.
  // attachments is an array of { dataUrl, name }.
  function renderUserBubbleWithImages(text, attachments) {
    if (!messagesEl) return;
    hideEmptyState();
    var userBubble = document.createElement('div');
    userBubble.className = 'message user';
    if (text) {
      var textNode = document.createElement('div');
      textNode.style.marginBottom = '6px';
      textNode.innerText = text;
      userBubble.appendChild(textNode);
    }
    if (attachments && attachments.length > 0) {
      var thumbRow = document.createElement('div');
      thumbRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;';
      attachments.forEach(function (att) {
        var tImg = document.createElement('img');
        tImg.src = att.dataUrl;
        tImg.alt = att.name || 'image';
        tImg.style.cssText = 'width:60px;height:60px;object-fit:cover;border-radius:4px;cursor:pointer;';
        tImg.title = att.name || 'image';
        tImg.addEventListener('click', function () {
          var win = window.open('', '_blank');
          if (win) { win.document.write('<img src="' + att.dataUrl + '" style="max-width:100%;max-height:100vh;">'); }
        });
        thumbRow.appendChild(tImg);
      });
      userBubble.appendChild(thumbRow);
    }
    messagesEl.appendChild(userBubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Build and return a fully-formed image result bubble (image + download + recreate).
  // Used both immediately after generation and when replaying history.
  function buildImageBubble(imageSrc, prompt, revisedPrompt) {
    var bubble = document.createElement('div');
    bubble.className = 'message assistant';

    var imgEl = document.createElement('img');
    imgEl.src = imageSrc;
    imgEl.alt = 'Generated image';
    imgEl.style.cssText = 'max-width:100%;border-radius:8px;display:block;margin-bottom:8px;';
    bubble.appendChild(imgEl);

    if (revisedPrompt && revisedPrompt !== prompt) {
      var captionEl = document.createElement('div');
      captionEl.style.cssText = 'font-size:11px;color:#888;margin-bottom:8px;';
      captionEl.textContent = 'Prompt: ' + revisedPrompt;
      bubble.appendChild(captionEl);
    }

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

    var dlBtn = document.createElement('a');
    dlBtn.href = imageSrc;
    dlBtn.download = 'hymenoptera-image.png';
    dlBtn.target = '_blank';
    dlBtn.rel = 'noopener noreferrer';
    dlBtn.innerHTML = '<img src="public/icons/Open.png" style="width:14px;height:14px;object-fit:contain;vertical-align:middle;margin-right:4px;"> Download';
    dlBtn.style.cssText = 'font-family:Tahoma,Verdana,sans-serif;font-size:12px;color:#2D8CFF;cursor:pointer;text-decoration:none;padding:4px 10px;border:1px solid #2D8CFF;border-radius:4px;display:inline-flex;align-items:center;';
    btnRow.appendChild(dlBtn);

    var recreateBtn = document.createElement('button');
    recreateBtn.innerHTML = '<img src="public/icons/Redo.png" style="width:14px;height:14px;object-fit:contain;vertical-align:middle;margin-right:4px;"> Recreate';
    recreateBtn.style.cssText = 'font-family:Tahoma,Verdana,sans-serif;font-size:12px;color:#2D8CFF;cursor:pointer;background:none;border:1px solid #2D8CFF;border-radius:4px;padding:4px 10px;display:inline-flex;align-items:center;';
    (function (p) {
      recreateBtn.addEventListener('click', function () {
        if (messageInput) messageInput.value = p;
        sendMessage();
      });
    }(prompt));
    btnRow.appendChild(recreateBtn);
    bubble.appendChild(btnRow);

    var copyPrompt = revisedPrompt || prompt;
    bubble.appendChild(makeCopyBtn(function () { return copyPrompt; }));

    return bubble;
  }

  function addMessage(type, text) {
    if (!messagesEl) return;
    hideEmptyState();

    // Structured generated-image message — rebuild the full image bubble
    if (type === 'assistant' && text && typeof text === 'object' && text.type === 'generated-image') {
      var imgBubble = buildImageBubble(text.imageSrc, text.prompt, text.revisedPrompt);
      messagesEl.appendChild(imgBubble);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (messageInput) messageInput.focus();
      return;
    }

    // Structured user message with image thumbnails (from reloaded history)
    if (type === 'user' && text && typeof text === 'object' && text.content) {
      var imgs = text.images || null;
      var textContent = (text.content || '').replace(/\n?\uD83D\uDDBC\uFE0F\s*\d*\s*image[s]?\s*attached\s*$/i, '').trim();
      renderUserBubbleWithImages(textContent, imgs);
      return;
    }

    var div = document.createElement('div');
    div.className = 'message ' + type;
    var textSpan = document.createElement('span');
    textSpan.className = 'msg-text';
    textSpan.innerText = typeof text === 'string' ? text : (text && text.content ? text.content : String(text));
    div.appendChild(textSpan);
    div.appendChild(makeCopyBtn(function () { return textSpan.innerText; }));
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    if (type === 'assistant' && messageInput) {
      messageInput.focus();
    }
  }

  // Expose addMessage globally for any callers
  window.addMessage = addMessage;

  // Create an empty streaming assistant bubble and return the element.
  // The bubble starts as plain text (no copy button) so the streaming
  // innerText updates work unobstructed; call convertToCopyableBubble()
  // once streaming is complete to add the copy button.
  function createStreamingBubble() {
    if (!messagesEl) return null;
    hideEmptyState();
    var div = document.createElement('div');
    div.className = 'message assistant';
    div.innerText = '';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) { resolve(e.target.result); };
      reader.onerror = function () { reject(new Error('Failed to read file: ' + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  async function sendMessage() {
    if (!messageInput) return;
    var message = (messageInput.value || '').trim();
    // Allow send when there is text OR pending image attachments
    if (!message && pendingImageAttachments.length === 0) return;

    // Daily reset: if the date has changed since last use, reset the counter
    // and re-fetch usage from the backend to get the authoritative value.
    var today = getTodayDateString();
    if (today !== lastResetDate) {
      messagesToday = 0;
      imagesToday   = 0;
      videosToday   = 0;
      lastResetDate = today;
      localStorage.setItem('messagesToday', '0');
      localStorage.setItem('imagesToday',   '0');
      localStorage.setItem('videosToday',   '0');
      localStorage.setItem('lastResetDate', today);
      updateAllCounters();
      // Refresh counter from backend asynchronously (non-blocking)
      fetchUsageFromBackend();
    }

    // Check plan limit before sending
    var limits = planLimits[userPlan] || planLimits.starter;
    var limit = limits.messages;
    if (limit !== null && messagesToday >= limit) {
      alert('Daily message limit reached. Upgrade your plan or wait until tomorrow.');
      return;
    }

    // Ensure we have an active chat
    if (!currentChatId) {
      currentChatId = generateChatId();
      var chatCount = Object.keys(conversations).filter(function (id) {
        return !conversations[id].archived && conversations[id].project === currentProject;
      }).length + 1;
      conversations[currentChatId] = {
        title: 'Chat ' + chatCount,
        pinned: false,
        archived: false,
        agent: currentAgent,
        model: currentModel,
        project: currentProject,
        messages: []
      };
      renderChatHistory();
    }

    // Append user message to conversation memory before sending.
    // The full history (all prior messages + this new one) will be sent to the backend.
    // When images are attached, store them with the message so thumbnails persist in history.
    var attachmentsCopy = pendingImageAttachments.slice(); // snapshot before clearing
    var historyContent = message;
    var historyImages = null;
    if (attachmentsCopy.length > 0) {
      var imgLabel = attachmentsCopy.length === 1
        ? '\uD83D\uDDBC\uFE0F 1 image attached'
        : '\uD83D\uDDBC\uFE0F ' + attachmentsCopy.length + ' images attached';
      historyContent = message ? message + '\n' + imgLabel : imgLabel;
      // Store the data URLs so thumbnails can be re-rendered when the chat is reloaded
      historyImages = attachmentsCopy.map(function (a) { return { dataUrl: a.dataUrl, name: a.name }; });
    }
    var historyMsg = { role: 'user', content: historyContent };
    if (historyImages) historyMsg.images = historyImages;
    conversations[currentChatId].messages.push(historyMsg);
    // Show the user bubble with optional image thumbnails
    if (attachmentsCopy.length > 0) {
      renderUserBubbleWithImages(message, attachmentsCopy);
    } else {
      addMessage('user', message);
    }
    saveMessageToHistory(historyMsg);
    saveConversations();
    messageInput.value = '';
    // Clear pending attachments after capturing them
    pendingImageAttachments = [];
    renderAttachmentTray();

    // Show thinking status and create a typing indicator bubble
    setStatus('Thinking...');
    var typingIndicator = createStreamingBubble();
    if (typingIndicator) {
      typingIndicator.innerText = 'Hymenoptera is thinking.';
      typingIndicator.classList.add('typing-indicator');
    }
    // Animate the dots: cycle through 1, 2, 3 dots every 500ms
    var dotCount = 1;
    var dotInterval = null;
    if (typingIndicator) {
      dotInterval = setInterval(function () {
        dotCount = (dotCount % 3) + 1;
        if (typingIndicator && typingIndicator.parentNode) {
          typingIndicator.innerText = 'Hymenoptera is thinking' + '.'.repeat(dotCount);
        } else {
          clearInterval(dotInterval);
        }
      }, 500);
    }
    var assistantBubble = null;
    var assistantText = '';

    try {
      var convAgent = conversations[currentChatId].agent || currentAgent;
      var convModel = conversations[currentChatId].model || currentModel;

      // Increment message count before sending the AI request
      messagesToday++;
      localStorage.setItem('messagesToday', messagesToday);
      updateMessageCounter();

      // ── VIDEO_GENERATION_ROUTE — keyword-based auto-routing ──────────────────
      // If the prompt contains video keywords (video, animate, animation, clip,
      // motion, cinematic, make this move), route to /api/video-route regardless
      // of the active model, UNLESS the model is already 'video-generator'
      // (that mode uses its own dedicated pipeline below).
      // This check runs before the image-generator mode so keyword matches in
      // image mode are automatically redirected to video generation.
      if (convModel !== 'video-generator' && promptContainsVideoKeywords(message)) {
        var vrHymenAuth = window.hymAuth && window.hymAuth.currentUser;
        var vrUserId = vrHymenAuth ? vrHymenAuth.uid : 'guest';

        // Build reference images from any pending attachments.
        var vrRefImages = attachmentsCopy.map(function (a) {
          return { data: a.dataUrl, mimeType: a.mimeType };
        });

        console.log('[Hymenoptera Routing] start');
        console.log('[Hymenoptera Routing] hasReferenceImages=' + (vrRefImages.length > 0));
        console.log('[Hymenoptera Routing] outputType=video');
        console.log('[Hymenoptera Routing] referenceImageCount=' + vrRefImages.length);
        console.log('[Hymenoptera Routing] promptLength=' + message.length);
        console.log('[Hymenoptera Routing] selected_route=VIDEO_GENERATION_ROUTE');

        var vrPayload = {
          prompt: message,
          plan: userPlan,
          userId: vrUserId,
          sessionId: currentChatId,
          hasReferenceImage: vrRefImages.length > 0
        };
        if (vrRefImages.length > 0) {
          vrPayload.referenceImages = vrRefImages;
          vrPayload.referenceFidelity = referenceFidelity;
        }

        var vrResponse = await fetch('/api/video-route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(vrPayload)
        });
        clearInterval(dotInterval);

        if (!vrResponse.ok) {
          var vrErr = null;
          try { vrErr = await vrResponse.json(); } catch (e) { /* ignore */ }
          var vrErrMsg = (vrErr && vrErr.error && vrErr.error.message) || 'Video generation failed';
          if (typingIndicator) {
            typingIndicator.classList.remove('typing-indicator');
            typingIndicator.innerText = vrErrMsg;
            convertToCopyableBubble(typingIndicator);
          }
          assistantText = vrErrMsg;
        } else {
          var vrData = await vrResponse.json();
          if (typingIndicator) typingIndicator.remove();

          if (vrData.type === 'video' && vrData.url) {
            // Build a video player bubble with download and regenerate controls
            var vrBubble = document.createElement('div');
            vrBubble.className = 'message assistant';

            var videoEl = document.createElement('video');
            videoEl.src = vrData.url;
            videoEl.controls = true;
            videoEl.style.cssText = 'max-width:100%;border-radius:8px;display:block;margin-bottom:8px;';
            videoEl.setAttribute('playsinline', '');
            vrBubble.appendChild(videoEl);

            var vrBtnRow = document.createElement('div');
            vrBtnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

            var vrDlBtn = document.createElement('a');
            vrDlBtn.href = vrData.url;
            vrDlBtn.download = 'hymenoptera-video-' + Date.now() + '.mp4';
            vrDlBtn.target = '_blank';
            vrDlBtn.rel = 'noopener noreferrer';
            vrDlBtn.innerHTML = '<img src="public/icons/Open.png" style="width:14px;height:14px;object-fit:contain;vertical-align:middle;margin-right:4px;"> Download Video';
            vrDlBtn.style.cssText = 'font-family:Tahoma,Verdana,sans-serif;font-size:12px;color:#2D8CFF;cursor:pointer;text-decoration:none;padding:4px 10px;border:1px solid #2D8CFF;border-radius:4px;display:inline-flex;align-items:center;';
            vrBtnRow.appendChild(vrDlBtn);

            var vrRegenBtn = document.createElement('button');
            vrRegenBtn.innerHTML = '<img src="public/icons/Redo.png" style="width:14px;height:14px;object-fit:contain;vertical-align:middle;margin-right:4px;"> Recreate';
            vrRegenBtn.style.cssText = 'font-family:Tahoma,Verdana,sans-serif;font-size:12px;color:#2D8CFF;cursor:pointer;background:none;border:1px solid #2D8CFF;border-radius:4px;padding:4px 10px;display:inline-flex;align-items:center;';
            vrRegenBtn.addEventListener('click', function () {
              if (messageInput) messageInput.value = message;
              sendMessage();
            });
            vrBtnRow.appendChild(vrRegenBtn);
            vrBubble.appendChild(vrBtnRow);

            if (messagesEl) {
              messagesEl.appendChild(vrBubble);
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            assistantText = '[Video generated] ' + message;
            assistantBubble = vrBubble;
            vrBubble.appendChild(makeCopyBtn(function () { return vrData.url; }));
            // Increment video counter on successful generation
            videosToday++;
            localStorage.setItem('videosToday', videosToday);
            updateVideoCounter();
          } else {
            // Unexpected response format — display as text
            var vrFallbackText = JSON.stringify(vrData);
            if (typingIndicator) {
              typingIndicator.classList.remove('typing-indicator');
              typingIndicator.innerText = vrFallbackText;
              convertToCopyableBubble(typingIndicator);
            }
            assistantText = vrFallbackText;
          }
        }
        conversations[currentChatId].messages.push({ role: 'assistant', content: assistantText });
        saveMessageToHistory({ role: 'assistant', content: assistantText });
        saveConversations();
        setStatus('Ready');
        if (messageInput) messageInput.focus();
        return;
      }

      // Image Generator mode: route to /api/generate-image instead of /api/chat
      if (convModel === 'image-generator') {
        var imgHymenAuth = window.hymAuth && window.hymAuth.currentUser;
        var imgUserId = imgHymenAuth ? imgHymenAuth.uid : 'guest';

        // Build reference images list from any pending attachments that were
        // captured before clearing the tray.
        var imgRefImages = attachmentsCopy.map(function (a) {
          return { data: a.dataUrl, mimeType: a.mimeType };
        });

        // ── Generation routing ──────────────────────────────────────────────
        // Select explicit route based on reference image presence and output type.
        //   no reference image + image output => text_to_image_route
        //   reference image(s) + image output => image_to_image_route
        console.log('[Hymenoptera Routing] start');
        console.log('[Hymenoptera Routing] hasReferenceImages=' + (imgRefImages.length > 0));
        console.log('[Hymenoptera Routing] outputType=image');
        console.log('[Hymenoptera Routing] referenceImageCount=' + imgRefImages.length);
        console.log('[Hymenoptera Routing] promptLength=' + message.length);
        var imgRoute = imgRefImages.length > 0 ? 'image_to_image_route' : 'text_to_image_route';
        console.log('[Hymenoptera Routing] selected=' + imgRoute);
        console.log('[Hymenoptera Route] ' + imgRoute);

        // Determine the effective fidelity level to send to the backend.
        // If reference images are present and the prompt contains strong fidelity
        // language, upgrade to 'exact' automatically (mirrors STRICT_FIDELITY_PATTERNS
        // in api/generate-image.js — both copies must stay in sync).
        var imgEffectiveFidelity = referenceFidelity;
        if (imgRefImages.length > 0 && imgEffectiveFidelity !== 'exact') {
          var strictPatterns = [
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
            /\baccurate(ly)?\b/i
          ];
          if (strictPatterns.some(function (re) { return re.test(message); })) {
            imgEffectiveFidelity = 'exact';
          }
        }

        var imgPayload = {
          prompt: message,
          plan: userPlan,
          userId: imgUserId,
          sessionId: currentChatId,
          hasReferenceImage: imgRefImages.length > 0
        };
        if (imgRefImages.length > 0) {
          imgPayload.referenceImages = imgRefImages;
          imgPayload.referenceFidelity = imgEffectiveFidelity;
          // Keep legacy flag for backward compatibility with any cached server versions
          imgPayload.strictReferenceMode = imgEffectiveFidelity !== 'balanced';
        }

        var imageInputEl = document.getElementById('imageInput');
        if (imageInputEl && imageInputEl.files && imageInputEl.files[0]) {
          imgPayload.image = await fileToBase64(imageInputEl.files[0]);
          imageInputEl.value = '';
        }

        // Update typing indicator to show image-specific generating message
        if (typingIndicator && typingIndicator.parentNode) {
          typingIndicator.innerText = 'Creating image\u2026';
        }
        clearInterval(dotInterval);

        var imgResponse;
        try {
          imgResponse = await fetch('/api/generate-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(imgPayload)
          });
        } catch (fetchErr) {
          console.error('[Image Generation] fetch error:', fetchErr);
          var netErrMsg = 'Image generation failed: could not reach the server. Check your connection.';
          if (typingIndicator) {
            typingIndicator.classList.remove('typing-indicator');
            typingIndicator.innerText = netErrMsg;
            convertToCopyableBubble(typingIndicator);
          }
          assistantText = netErrMsg;
          conversations[currentChatId].messages.push({ role: 'assistant', content: assistantText });
          saveMessageToHistory({ role: 'assistant', content: assistantText });
          saveConversations();
          setStatus('Ready');
          if (messageInput) messageInput.focus();
          return;
        }

        if (!imgResponse.ok) {
          var imgErr = null;
          try { imgErr = await imgResponse.json(); } catch (e) { /* ignore */ }
          var errMsg = (imgErr && imgErr.error && imgErr.error.message)
            || (imgErr && typeof imgErr.error === 'string' ? imgErr.error : null)
            || 'Image generation failed (HTTP ' + imgResponse.status + ')';
          console.error('[Image Generation] API error:', imgResponse.status, errMsg, imgErr);
          if (typingIndicator) {
            typingIndicator.classList.remove('typing-indicator');
            typingIndicator.innerText = errMsg;
            convertToCopyableBubble(typingIndicator);
          }
          assistantText = errMsg;
        } else {
          var imgData = await imgResponse.json();
          var imageSrc = 'data:image/png;base64,' + imgData.image;
          var revisedPrompt = imgData.revisedPrompt || null;
          if (typingIndicator) typingIndicator.remove();

          // Build the image bubble via the shared helper so it is identical to
          // what gets reconstructed when the message is replayed from history.
          var imgBubble = buildImageBubble(imageSrc, message, revisedPrompt);
          if (messagesEl) {
            messagesEl.appendChild(imgBubble);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          assistantBubble = imgBubble;

          // Persist the structured message so the image survives reloads.
          var imgHistoryMsg = {
            role: 'assistant',
            type: 'generated-image',
            imageSrc: imageSrc,
            prompt: message,
            revisedPrompt: revisedPrompt || null,
            content: '[Image created] ' + (revisedPrompt || message)
          };
          assistantText = imgHistoryMsg.content;

          // Increment image counter on successful generation
          imagesToday++;
          localStorage.setItem('imagesToday', imagesToday);
          updateImageCounter();

          conversations[currentChatId].messages.push(imgHistoryMsg);
          saveMessageToHistory(imgHistoryMsg);
          saveConversations();
          setStatus('Ready');
          if (messageInput) messageInput.focus();
          return;
        }
        conversations[currentChatId].messages.push({ role: 'assistant', content: assistantText });
        saveMessageToHistory({ role: 'assistant', content: assistantText });
        saveConversations();
        setStatus('Ready');
        if (messageInput) messageInput.focus();
        return;
      }

      // Video Generator mode: route to /api/generate-video instead of /api/chat.
      // REFERENCE_LOCK_VIDEO_MODE is activated automatically when reference images
      // are present, preserving the uploaded subject's identity and design.
      if (convModel === 'video-generator') {
        var vidHymenAuth = window.hymAuth && window.hymAuth.currentUser;
        var vidUserId = vidHymenAuth ? vidHymenAuth.uid : 'guest';

        // Build reference images list from any pending attachments.
        var vidRefImages = attachmentsCopy.map(function (a) {
          return { data: a.dataUrl, mimeType: a.mimeType };
        });

        // ── Generation routing ──────────────────────────────────────────────
        // Route to VIDEO_GENERATION_ROUTE (/api/video-route) to return a real
        // video file instead of a text concept.
        console.log('[DEBUG] Prompt:', message);
        console.log('[Hymenoptera Routing] start');
        console.log('[Hymenoptera Routing] hasReferenceImages=' + (vidRefImages.length > 0));
        console.log('[Hymenoptera Routing] outputType=video');
        console.log('[Hymenoptera Routing] referenceImageCount=' + vidRefImages.length);
        console.log('[Hymenoptera Routing] promptLength=' + message.length);
        console.log('[ROUTE] VIDEO_GENERATION_ROUTE');
        console.log('[Hymenoptera Routing] selected_route=VIDEO_GENERATION_ROUTE');

        var vidPayload = {
          prompt: message,
          plan: userPlan,
          userId: vidUserId,
          sessionId: currentChatId,
          hasReferenceImage: vidRefImages.length > 0
        };
        if (vidRefImages.length > 0) {
          vidPayload.referenceImages = vidRefImages;
          vidPayload.referenceFidelity = referenceFidelity;
        }

        var vidResponse = await fetch('/api/video-route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(vidPayload)
        });
        clearInterval(dotInterval);
        if (!vidResponse.ok) {
          var vidErr = null;
          try { vidErr = await vidResponse.json(); } catch (e) { /* ignore */ }
          var vidErrMsg = (vidErr && vidErr.error && vidErr.error.message) || 'Video generation failed';
          if (typingIndicator) {
            typingIndicator.classList.remove('typing-indicator');
            typingIndicator.innerText = vidErrMsg;
            convertToCopyableBubble(typingIndicator);
          }
          assistantText = vidErrMsg;
        } else {
          var vidData = await vidResponse.json();
          if (typingIndicator) typingIndicator.remove();

          if (vidData.type === 'video' && vidData.url) {
            // Build a video player bubble with download and regenerate controls
            console.log('[VIDEO] URL:', vidData.url);
            var vidBubble = document.createElement('div');
            vidBubble.className = 'message assistant';

            var vidEl = document.createElement('video');
            vidEl.src = vidData.url;
            vidEl.controls = true;
            vidEl.style.cssText = 'max-width:100%;border-radius:8px;display:block;margin-bottom:8px;';
            vidEl.setAttribute('playsinline', '');
            vidBubble.appendChild(vidEl);

            var vidBtnRow = document.createElement('div');
            vidBtnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

            var vidDlBtn = document.createElement('a');
            vidDlBtn.href = vidData.url;
            vidDlBtn.download = 'hymenoptera-video-' + Date.now() + '.mp4';
            vidDlBtn.target = '_blank';
            vidDlBtn.rel = 'noopener noreferrer';
            vidDlBtn.innerHTML = '<img src="public/icons/Open.png" style="width:14px;height:14px;object-fit:contain;vertical-align:middle;margin-right:4px;"> Download Video';
            vidDlBtn.style.cssText = 'font-family:Tahoma,Verdana,sans-serif;font-size:12px;color:#2D8CFF;cursor:pointer;text-decoration:none;padding:4px 10px;border:1px solid #2D8CFF;border-radius:4px;display:inline-flex;align-items:center;';
            vidBtnRow.appendChild(vidDlBtn);

            var vidRegenBtn = document.createElement('button');
            vidRegenBtn.innerHTML = '<img src="public/icons/Redo.png" style="width:14px;height:14px;object-fit:contain;vertical-align:middle;margin-right:4px;"> Recreate';
            vidRegenBtn.style.cssText = 'font-family:Tahoma,Verdana,sans-serif;font-size:12px;color:#2D8CFF;cursor:pointer;background:none;border:1px solid #2D8CFF;border-radius:4px;padding:4px 10px;display:inline-flex;align-items:center;';
            vidRegenBtn.addEventListener('click', function () {
              if (messageInput) messageInput.value = message;
              sendMessage();
            });
            vidBtnRow.appendChild(vidRegenBtn);
            vidBubble.appendChild(vidBtnRow);

            if (messagesEl) {
              messagesEl.appendChild(vidBubble);
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            assistantText = '[Video generated] ' + message;
            assistantBubble = vidBubble;
            vidBubble.appendChild(makeCopyBtn(function () { return vidData.url; }));
            // Increment video counter on successful generation
            videosToday++;
            localStorage.setItem('videosToday', videosToday);
            updateVideoCounter();
          } else {
            // Unexpected response format — display as text
            var vidFallbackText = JSON.stringify(vidData);
            if (typingIndicator) {
              typingIndicator.classList.remove('typing-indicator');
              typingIndicator.innerText = vidFallbackText;
              convertToCopyableBubble(typingIndicator);
            }
            assistantText = vidFallbackText;
          }
        }
        conversations[currentChatId].messages.push({ role: 'assistant', content: assistantText });
        saveMessageToHistory({ role: 'assistant', content: assistantText });
        saveConversations();
        setStatus('Ready');
        if (messageInput) messageInput.focus();
        return;
      }

      // Send the full conversation history to the backend so the AI remembers all prior messages.
      var response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: conversations[currentChatId].messages, agent: convAgent, systemPrompt: agents[convAgent].systemPrompt, model: convModel, hiveMode: hiveMode, fileContext: uploadedFileContent, image: uploadedImageData, images: attachmentsCopy.map(function (a) { return { data: a.dataUrl, mimeType: a.mimeType }; }), webAccess: webAccess })
      });

      if (!response.ok) {
        clearInterval(dotInterval);
        if (typingIndicator) {
          typingIndicator.classList.remove('typing-indicator');
          typingIndicator.innerText = 'Error contacting AI server';
          convertToCopyableBubble(typingIndicator);
        }
        setStatus('Ready');
        return;
      }

      if (hiveMode) {
        // Hive mode returns a JSON response with the combined agent outputs
        var data = await response.json();
        assistantText = (data && data.content) ? data.content : NO_RESPONSE_MSG;
        // Replace typing indicator with the actual response
        if (typingIndicator) {
          clearInterval(dotInterval);
          typingIndicator.classList.remove('typing-indicator');
          typingIndicator.innerText = assistantText;
          assistantBubble = typingIndicator;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      } else {
        // Read SSE stream
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var typingRemoved = false;

        while (true) {
          var result = await reader.read();
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });

          // Process complete SSE lines
          var lines = buffer.split('\n');
          buffer = lines.pop(); // hold incomplete last line

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line === 'data: [DONE]') continue;
            if (line.startsWith('data: ')) {
              try {
                var parsed = JSON.parse(line.slice(6));
                var delta = parsed.choices &&
                            parsed.choices[0] &&
                            parsed.choices[0].delta &&
                            parsed.choices[0].delta.content;
                if (delta) {
                  // On first token: remove typing indicator and create the real assistant bubble
                  if (!typingRemoved) {
                    typingRemoved = true;
                    clearInterval(dotInterval);
                    if (typingIndicator) typingIndicator.remove();
                    assistantBubble = createStreamingBubble();
                  }
                  assistantText += delta;
                  if (assistantBubble) {
                    assistantBubble.innerText = assistantText;
                    messagesEl.scrollTop = messagesEl.scrollHeight;
                  }
                }
              } catch (e) {
                // ignore malformed SSE chunks
              }
            }
          }
        }

        // If no streaming content was captured, show fallback
        if (!assistantText) {
          if (!typingRemoved && typingIndicator) {
            clearInterval(dotInterval);
            typingIndicator.classList.remove('typing-indicator');
            typingIndicator.innerText = NO_RESPONSE_MSG;
            assistantBubble = typingIndicator;
          } else if (assistantBubble) {
            assistantBubble.innerText = NO_RESPONSE_MSG;
          }
          assistantText = NO_RESPONSE_MSG;
        }
      }

      // Append assistant reply to conversation memory so future messages retain full context.
      if (assistantBubble) convertToCopyableBubble(assistantBubble);
      conversations[currentChatId].messages.push({ role: 'assistant', content: assistantText });
      saveMessageToHistory({ role: 'assistant', content: assistantText });
      saveConversations();
    } catch (err) {
      console.error('sendMessage error:', err);
      clearInterval(dotInterval);
      // Show error in whichever bubble is currently visible
      var errorBubble = assistantBubble || typingIndicator;
      if (errorBubble) {
        errorBubble.classList.remove('typing-indicator');
        errorBubble.innerText = 'Error contacting AI server';
        convertToCopyableBubble(errorBubble);
      }
    }

    setStatus('Ready');
    if (messageInput) messageInput.focus();
  }

  // Expose sendMessage globally so onclick="sendMessage()" works
  window.sendMessage = sendMessage;

  // Expose clearMessages for legacy callers (resets the current conversation)
  window.clearMessages = function () {
    if (currentChatId && conversations[currentChatId]) {
      conversations[currentChatId].messages = [];
    }
  };

  // New chat: create a fresh conversation and update the sidebar.
  // Resets conversation memory by starting a new messages array for the new chat.
  window.newChat = function () {
    if (typeof setCurrentView === 'function' && window.currentView === 'settings') {
      setCurrentView('chat');
    }
    var user = localStorage.getItem('hymenoptera_user');
    if (!user) return;
    currentChatId = generateChatId();
    var chatCount = Object.keys(conversations).filter(function (id) {
      return !conversations[id].archived && conversations[id].project === currentProject;
    }).length + 1;
    conversations[currentChatId] = {
      title: 'Chat ' + chatCount,
      pinned: false,
      archived: false,
      agent: currentAgent,
      model: currentModel,
      project: currentProject,
      messages: [] // Fresh memory: no prior messages for the new conversation
    };
    saveConversations();
    clearChatUI();
    addMessage('assistant', WELCOME_MESSAGE);
    renderChatHistory();
    // Clear uploaded file context for the new conversation
    uploadedFileContent = '';
    var fileInput = document.getElementById('file-upload');
    if (fileInput) fileInput.value = '';
    // Clear uploaded image for the new conversation
    uploadedImageData = '';
    // Clear any pending image attachments for the new conversation
    pendingImageAttachments = [];
    renderAttachmentTray();
    // Refresh usage counter from backend for the new chat session
    fetchUsageFromBackend();
    if (typeof closeSidebarOnMobile === 'function') closeSidebarOnMobile();
  };

  // Also wire up the send button via event listener
  var sendBtn = document.querySelector('.send-btn');
  if (sendBtn) {
    sendBtn.addEventListener('click', function (e) {
      e.preventDefault();
      sendMessage();
    });
  }

  // Enter key sends (Shift+Enter allows newline)
  if (messageInput) {
    messageInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  // Supported MIME type categories — mirrors the server-side fileProcessor logic.
  var fileTypeCategories = {
    image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
    pdf:   ['application/pdf'],
    video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/ogg']
  };
  var fileExtCategories = {
    '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image',
    '.pdf': 'pdf',
    '.mp4': 'video', '.mov': 'video', '.avi': 'video', '.webm': 'video', '.mkv': 'video', '.ogv': 'video'
  };

  function detectUploadCategory(file) {
    var mime = (file.type || '').toLowerCase().split(';')[0].trim();
    for (var cat in fileTypeCategories) {
      if (fileTypeCategories[cat].indexOf(mime) !== -1) return cat;
    }
    var ext = (file.name || '').toLowerCase().match(/(\.[^.]+)$/);
    if (ext && fileExtCategories[ext[1]]) return fileExtCategories[ext[1]];
    return 'text'; // default: treat as text/code
  }

  /**
   * Send a file to /api/upload-file and display the AI analysis in the chat.
   * For text and code files the existing text-extraction path is also kept
   * so the content can be used as context in subsequent chat messages.
   */
  async function processUploadedFile(file, base64Data, category) {
    // Ensure there is an active chat to display the analysis in.
    if (!currentChatId) {
      currentChatId = generateChatId();
      var chatCount = Object.keys(conversations).filter(function (id) {
        return !conversations[id].archived && conversations[id].project === currentProject;
      }).length + 1;
      conversations[currentChatId] = {
        title: 'Chat ' + chatCount,
        messages: [],
        agent: currentAgent,
        model: currentModel,
        project: currentProject
      };
      renderChatList();
    }
    if (emptyState) emptyState.style.display = 'none';

    // Show a user message indicating the upload.
    var userMsg = '📎 Uploaded file: ' + file.name;
    addMessage('user', userMsg);
    saveMessageToHistory({ role: 'user', content: userMsg });
    saveConversations();

    // Show a loading indicator.
    setStatus('Analyzing file...');
    var thinkingBubble = createStreamingBubble();
    if (thinkingBubble) {
      thinkingBubble.innerText = 'Analyzing file...';
      thinkingBubble.classList.add('typing-indicator');
    }

    try {
      var hymenAuth = window.hymAuth && window.hymAuth.currentUser;
      var userId = hymenAuth ? hymenAuth.uid : 'guest';

      var response = await fetch('/api/upload-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileData: base64Data,
          fileName: file.name,
          mimeType: file.type || '',
          fileSize: file.size || 0,
          userId: userId,
          plan: userPlan,
          sessionId: currentChatId
        })
      });

      var data = await response.json();

      if (thinkingBubble) {
        thinkingBubble.classList.remove('typing-indicator');
        thinkingBubble.remove();
      }

      if (!response.ok) {
        var errMsg = (data && data.error && data.error.message) || 'File analysis failed.';
        addMessage('assistant', errMsg);
        saveMessageToHistory({ role: 'assistant', content: errMsg });
        setStatus('Ready');
        if (fileUploadBtn) fileUploadBtn.title = 'Upload file';
        return;
      }

      var analysis = data.analysis || 'No analysis returned.';
      addMessage('assistant', analysis);
      saveMessageToHistory({ role: 'assistant', content: analysis });
      saveConversations();
      if (fileUploadBtn) fileUploadBtn.title = 'File analyzed: ' + file.name;
    } catch (err) {
      if (thinkingBubble) {
        thinkingBubble.classList.remove('typing-indicator');
        thinkingBubble.remove();
      }
      addMessage('assistant', 'Error analyzing file: ' + (err.message || 'Unknown error'));
      if (fileUploadBtn) fileUploadBtn.title = 'File upload failed';
    }
    setStatus('Ready');
  }

  // File upload: detect file type and route accordingly.
  // • Text / code files: read as text for use as chat context (existing behaviour) AND
  //   send to /api/upload-file for AI analysis.
  // • Images: add to pending attachment tray so user can compose text before sending.
  // • PDFs, videos: read as base64 and send to /api/upload-file for immediate analysis.
  var fileUploadInput = document.getElementById('file-upload');
  if (fileUploadInput) {
    fileUploadInput.addEventListener('change', function (event) {
      var files = Array.prototype.slice.call(event.target.files);
      if (!files.length) return;
      files.forEach(function (file) {
        var category = detectUploadCategory(file);

        if (category === 'image') {
          // Images: store in pending tray instead of auto-sending.
          var reader = new FileReader();
          reader.onload = function (e) {
            addImageAttachment(e.target.result, file.type, file.name);
          };
          reader.readAsDataURL(file);
        } else if (category === 'text') {
          // Original behaviour: read as UTF-8 text and store as context.
          var textReader = new FileReader();
          textReader.onload = function (e) {
            uploadedFileContent = e.target.result;
            if (!projects[currentProject]) projects[currentProject] = { files: [] };
            if (!projects[currentProject].files) projects[currentProject].files = [];
            projects[currentProject].files.push(uploadedFileContent);
            saveConversations();

            // Also send to upload endpoint for inline AI analysis.
            var b64Reader = new FileReader();
            b64Reader.onload = function (ev) {
              var dataUrl = ev.target.result || '';
              var base64 = dataUrl.indexOf(',') !== -1 ? dataUrl.split(',')[1] : dataUrl;
              processUploadedFile(file, base64, category);
            };
            b64Reader.readAsDataURL(file);
          };
          textReader.readAsText(file);
        } else {
          // PDF, video: read as base64 DataURL, strip the prefix, send to endpoint.
          var b64Reader = new FileReader();
          b64Reader.onload = function (ev) {
            var dataUrl = ev.target.result || '';
            var base64 = dataUrl.indexOf(',') !== -1 ? dataUrl.split(',')[1] : dataUrl;
            processUploadedFile(file, base64, category);
          };
          b64Reader.readAsDataURL(file);
        }
      });

      // Reset the input so the same file can be re-selected.
      event.target.value = '';
    });
  }

  // Mobile detection: returns true for phones and tablets
  function isMobileDevice() {
    return /Android|iPhone|iPad|iPod|Tablet/i.test(navigator.userAgent);
  }

  // ===== ADD MENU =====
  var addMenuWrap  = document.getElementById('add-menu-wrap');
  var addMenuBtn   = document.getElementById('add-menu-btn');
  var addMenuPopup = document.getElementById('add-menu-popup');

  function closeAddMenu() {
    if (addMenuPopup) addMenuPopup.hidden = true;
  }

  if (addMenuBtn && addMenuPopup) {
    addMenuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      addMenuPopup.hidden = !addMenuPopup.hidden;
    });
  }

  // Close menu when clicking anywhere outside
  document.addEventListener('click', function (e) {
    if (addMenuWrap && !addMenuWrap.contains(e.target)) {
      closeAddMenu();
    }
  });

  // Camera / image input: file picker on desktop, native camera on mobile
  var menuCameraBtn = document.getElementById('menu-camera-btn');
  if (menuCameraBtn) {
    menuCameraBtn.addEventListener('click', function () {
      closeAddMenu();
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      if (isMobileDevice()) {
        // Opens the rear-facing camera on phones/tablets
        input.capture = 'environment';
      }
      // On desktop: no capture attribute — opens the standard file picker
      // so users can browse screenshots and image files from disk
      input.onchange = function (event) {
        var file = event.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function (e) {
          addImageAttachment(e.target.result, file.type, file.name);
        };
        reader.readAsDataURL(file);
      };
      input.click();
    });
  }

  // Attach File: trigger the existing hidden file input
  var menuAttachBtn = document.getElementById('menu-attach-btn');
  if (menuAttachBtn) {
    menuAttachBtn.addEventListener('click', function () {
      closeAddMenu();
      var fileUpload = document.getElementById('file-upload');
      if (fileUpload) fileUpload.click();
    });
  }

  // Reference Fidelity buttons: update referenceFidelity state and sync active styling.
  var fidelityRow = document.getElementById('reference-fidelity-row');
  if (fidelityRow) {
    fidelityRow.addEventListener('click', function (e) {
      var btn = e.target.closest('.fidelity-btn');
      if (!btn) return;
      var level = btn.getAttribute('data-fidelity');
      if (!level) return;
      referenceFidelity = level;
      var btns = fidelityRow.querySelectorAll('.fidelity-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i] === btn);
      }
    });
  }

  // Paste handler: intercept pasted images and add to pending attachment tray.
  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var hasImage = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        hasImage = true;
        var file = items[i].getAsFile();
        if (!file) continue;
        (function (f) {
          var reader = new FileReader();
          reader.onload = function (ev) {
            addImageAttachment(ev.target.result, f.type, 'pasted-image.png');
          };
          reader.readAsDataURL(f);
        }(file));
      }
    }
    // If an image was pasted, prevent default paste into the text input
    if (hasImage) e.preventDefault();
  });

  // Drag-and-drop handler on the messages/input area: add dropped images to pending tray.
  var chatMain = document.getElementById('chat-main') || document.body;
  chatMain.addEventListener('dragover', function (e) {
    var hasFiles = false;
    if (e.dataTransfer && e.dataTransfer.types) {
      for (var i = 0; i < e.dataTransfer.types.length; i++) {
        if (e.dataTransfer.types[i] === 'Files') { hasFiles = true; break; }
      }
    }
    if (hasFiles) e.preventDefault();
  });
  chatMain.addEventListener('drop', function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    var hasImage = false;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.type.indexOf('image/') === 0) {
        hasImage = true;
        (function (file) {
          var reader = new FileReader();
          reader.onload = function (ev) {
            addImageAttachment(ev.target.result, file.type, file.name);
          };
          reader.readAsDataURL(file);
        }(f));
      }
    }
    if (hasImage) e.preventDefault();
  });

  // Voice input: use Web Speech API to fill the chat input with spoken text
  var recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    ? new (window.SpeechRecognition || window.webkitSpeechRecognition)()
    : null;

  var isListening = false;
  var voiceCancelled = false;

  if (recognition) {
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = function (event) {
      if (!voiceCancelled) {
        var transcript = event.results[0][0].transcript;
        if (messageInput) messageInput.value += (messageInput.value ? ' ' : '') + transcript;
      }
    };

    recognition.onerror = function () {
      isListening = false;
      updateVoiceIndicator(false);
    };

    recognition.onend = function () {
      isListening = false;
      updateVoiceIndicator(false);
    };
  }

  function updateVoiceIndicator(active) {
    var btn = document.getElementById('menu-voice-btn');
    if (!btn) return;
    var iconImg = '<img src="public/icons/Speech.png" class="xp-menu-icon" alt="" />';
    if (active) {
      btn.innerHTML = iconImg + '<span class="voice-listening-label">Listening...</span>';
      btn.classList.add('listening');
    } else {
      btn.innerHTML = iconImg + '<span>Speech to Text</span>';
      btn.classList.remove('listening');
    }
  }

  var menuVoiceBtn = document.getElementById('menu-voice-btn');
  if (menuVoiceBtn) {
    menuVoiceBtn.addEventListener('click', function () {
      if (!recognition) {
        alert('Speech recognition is not supported in this browser.');
        closeAddMenu();
        return;
      }
      if (isListening) {
        voiceCancelled = true;
        recognition.stop();
        isListening = false;
        updateVoiceIndicator(false);
        closeAddMenu();
      } else {
        voiceCancelled = false;
        try {
          recognition.start();
          isListening = true;
          updateVoiceIndicator(true);
          // Keep menu open so user can see Listening... state; they close it or click again
        } catch (e) {
          // recognition may already be running; ignore
        }
      }
    });
  }

  // ===== LIVE TALK ENGINE =====
  (function () {
    var overlay       = document.getElementById('livetalk-overlay');
    var waveCanvas    = document.getElementById('lt-waveform');
    var waveFrame     = waveCanvas ? waveCanvas.parentElement : null;
    var statusText    = document.getElementById('lt-status-text');
    var talkBtn       = document.getElementById('lt-talk-btn');
    var stopBtn       = document.getElementById('lt-stop-btn');
    var endBtn        = document.getElementById('lt-end-btn');
    var transcript    = document.getElementById('lt-transcript');
    var closeBtn      = document.getElementById('lt-close-btn');
    var menuLiveTalkBtn = document.getElementById('menu-livetalk-btn');

    if (!overlay || !waveCanvas) return;

    var ltCtx = waveCanvas.getContext('2d');

    // --- State ---
    var ltOpen        = false;
    var ltState       = 'idle';   // 'idle' | 'user' | 'ai'
    var ltRecog       = null;
    var ltSynth       = window.speechSynthesis || null;
    var ltUtterance   = null;
    var ltAnimFrame   = null;
    var ltAudioCtx    = null;
    var ltAnalyser    = null;
    var ltMicStream   = null;
    var ltHistory     = [];       // [{role, content}] for the AI

    // Waveform animation phase (for idle idle line)
    var ltWavePhase   = 0;
    // Simulated amplitude for AI speech (no analyser, use random+envelope)
    var ltAiAmp       = 0;
    var ltAiAmpTarget = 0;
    var ltAiAmpTimer  = 0;

    // --- Waveform draw ---
    function drawWaveform() {
      var W = waveCanvas.width;
      var H = waveCanvas.height;
      ltCtx.fillStyle = '#0a0a0a';
      ltCtx.fillRect(0, 0, W, H);

      ltCtx.lineWidth = 1.5;
      ltCtx.beginPath();

      if (ltState === 'user' && ltAnalyser) {
        // Real microphone frequency data
        var bufLen = ltAnalyser.frequencyBinCount;
        var dataArr = new Uint8Array(bufLen);
        ltAnalyser.getByteTimeDomainData(dataArr);
        ltCtx.strokeStyle = '#3a9fef';
        for (var i = 0; i < bufLen; i++) {
          var x = (i / bufLen) * W;
          var v = (dataArr[i] / 128.0) - 1.0;
          var y = H / 2 + v * (H / 2 - 4);
          if (i === 0) ltCtx.moveTo(x, y);
          else ltCtx.lineTo(x, y);
        }
      } else if (ltState === 'ai') {
        // Simulated speech envelope for AI responses — green
        ltAiAmpTimer--;
        if (ltAiAmpTimer <= 0) {
          ltAiAmpTarget = 0.15 + Math.random() * 0.55;
          ltAiAmpTimer  = 4 + Math.floor(Math.random() * 6);
        }
        ltAiAmp += (ltAiAmpTarget - ltAiAmp) * 0.18;
        ltCtx.strokeStyle = '#28c828';
        var pts = 120;
        for (var i = 0; i < pts; i++) {
          var x = (i / (pts - 1)) * W;
          var freq1 = 2.5, freq2 = 7.3;
          var y = H / 2
            + Math.sin(i * freq1 * 0.08 + ltWavePhase * 2.1) * ltAiAmp * (H / 2 - 5)
            + Math.sin(i * freq2 * 0.08 + ltWavePhase * 3.7) * ltAiAmp * 0.35 * (H / 2 - 5);
          if (i === 0) ltCtx.moveTo(x, y);
          else ltCtx.lineTo(x, y);
        }
        ltWavePhase += 0.07;
      } else {
        // Idle — thin dim green flat line with micro noise
        ltCtx.strokeStyle = '#1a5a1a';
        var pts = 80;
        for (var i = 0; i < pts; i++) {
          var x = (i / (pts - 1)) * W;
          var noise = (Math.random() - 0.5) * 2;
          var y = H / 2 + noise;
          if (i === 0) ltCtx.moveTo(x, y);
          else ltCtx.lineTo(x, y);
        }
      }
      ltCtx.stroke();
      ltAnimFrame = requestAnimationFrame(drawWaveform);
    }

    function setState(s) {
      ltState = s;
      if (waveFrame) waveFrame.setAttribute('data-state', s === 'idle' ? '' : s);
      if (talkBtn) talkBtn.classList.toggle('active', s === 'user');
      if (stopBtn) stopBtn.disabled = s !== 'ai';
      if (statusText) {
        statusText.textContent =
          s === 'user' ? 'Listening...' :
          s === 'ai'   ? 'Hymenoptera is speaking...' :
                         'Ready — click Talk to speak';
      }
    }

    function addLine(role, text) {
      if (!transcript) return;
      var div = document.createElement('div');
      div.className = role === 'user' ? 'lt-line-user' : 'lt-line-ai';
      div.textContent = (role === 'user' ? 'You: ' : 'Hymenoptera: ') + text;
      transcript.appendChild(div);
      transcript.scrollTop = transcript.scrollHeight;
    }

    // --- Mic setup via Web Audio for real waveform ---
    async function setupMic() {
      try {
        if (!ltAudioCtx) {
          ltAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (ltAudioCtx.state === 'suspended') await ltAudioCtx.resume();
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        ltMicStream = stream;
        var source = ltAudioCtx.createMediaStreamSource(stream);
        ltAnalyser = ltAudioCtx.createAnalyser();
        ltAnalyser.fftSize = 256;
        source.connect(ltAnalyser);
      } catch (e) {
        // No mic permission — waveform will stay idle, voice capture still works
      }
    }

    function stopMic() {
      if (ltMicStream) {
        ltMicStream.getTracks().forEach(function (t) { t.stop(); });
        ltMicStream = null;
      }
      ltAnalyser = null;
    }

    // --- Speech recognition ---
    var LTRecogClass = window.SpeechRecognition || window.webkitSpeechRecognition;

    function startListening() {
      if (!LTRecogClass) {
        addLine('ai', '(Speech recognition is not supported in this browser.)');
        return;
      }
      ltRecog = new LTRecogClass();
      ltRecog.lang = navigator.language || 'en-US';
      ltRecog.continuous = false;
      ltRecog.interimResults = false;

      ltRecog.onresult = function (e) {
        var text = e.results[0][0].transcript.trim();
        if (!text) return;
        addLine('user', text);
        ltHistory.push({ role: 'user', content: text });
        setState('idle');
        askAI(text);
      };

      ltRecog.onerror = function () {
        setState('idle');
      };

      ltRecog.onend = function () {
        if (ltState === 'user') setState('idle');
      };

      setState('user');
      ltRecog.start();
    }

    function stopListening() {
      if (ltRecog) { try { ltRecog.stop(); } catch (e) {} ltRecog = null; }
      setState('idle');
    }

    // --- AI request (non-streaming for voice — we speak after we have full text) ---
    async function askAI(userText) {
      if (statusText) statusText.textContent = 'Thinking...';

      // Build messages array for /api/chat — last 10 turns to stay concise
      var msgs = ltHistory.slice(-10);

      try {
        var resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: msgs,
            agent: (typeof currentAgent !== 'undefined' ? currentAgent : 'general'),
            systemPrompt: (typeof agents !== 'undefined' && agents[currentAgent]
              ? agents[currentAgent].systemPrompt
              : 'You are a helpful assistant. Keep answers concise for voice conversation.'),
            model: (typeof currentModel !== 'undefined' ? currentModel : 'fast'),
            hiveMode: false,
            fileContext: '',
            images: []
          })
        });

        if (!resp.ok) {
          addLine('ai', 'Sorry, I could not reach the server.');
          setState('idle');
          return;
        }

        // Consume the SSE stream and collect full text
        var reader = resp.body.getReader();
        var dec    = new TextDecoder();
        var buf    = '';
        var full   = '';

        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].trim();
            if (!ln || ln === 'data: [DONE]') continue;
            if (ln.startsWith('data: ')) {
              try {
                var p = JSON.parse(ln.slice(6));
                var d = p.choices && p.choices[0] && p.choices[0].delta && p.choices[0].delta.content;
                if (d) full += d;
              } catch (ex) {}
            }
          }
        }

        if (!full) full = 'I did not get a response. Please try again.';
        ltHistory.push({ role: 'assistant', content: full });
        addLine('ai', full);
        speakAI(full);

      } catch (err) {
        addLine('ai', 'Error: ' + (err.message || 'unknown'));
        setState('idle');
      }
    }

    // --- TTS via Web Speech Synthesis ---
    function speakAI(text) {
      if (!ltSynth) {
        setState('idle');
        return;
      }
      ltSynth.cancel();
      ltUtterance = new SpeechSynthesisUtterance(text);
      ltUtterance.lang = navigator.language || 'en-US';
      ltUtterance.rate = 1.0;
      ltUtterance.pitch = 1.0;

      ltUtterance.onstart = function () { setState('ai'); };
      ltUtterance.onend   = function () { setState('idle'); };
      ltUtterance.onerror = function () { setState('idle'); };

      setState('ai');
      ltSynth.speak(ltUtterance);
    }

    function stopSpeaking() {
      if (ltSynth) ltSynth.cancel();
      setState('idle');
    }

    // --- Open / close ---
    function openLiveTalk() {
      ltHistory = [];
      if (transcript) transcript.innerHTML = '';
      overlay.hidden = false;
      ltOpen = true;
      setState('idle');
      if (!ltAnimFrame) drawWaveform();
      setupMic();
      closeAddMenu();
    }

    function closeLiveTalk() {
      stopListening();
      stopSpeaking();
      stopMic();
      overlay.hidden = true;
      ltOpen = false;
      if (ltAnimFrame) { cancelAnimationFrame(ltAnimFrame); ltAnimFrame = null; }
    }

    // --- Button wiring ---
    if (menuLiveTalkBtn) {
      menuLiveTalkBtn.addEventListener('click', openLiveTalk);
    }

    if (closeBtn) closeBtn.addEventListener('click', closeLiveTalk);
    if (endBtn)   endBtn.addEventListener('click', closeLiveTalk);

    if (talkBtn) {
      talkBtn.addEventListener('click', function () {
        if (ltState === 'ai') stopSpeaking();
        if (ltState === 'user') { stopListening(); return; }
        startListening();
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', function () {
        stopSpeaking();
      });
    }

    // Close on backdrop click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeLiveTalk();
    });

    // Escape key closes Live Talk
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ltOpen) closeLiveTalk();
    });
  }());

  // New Project button
  var newProjectBtn = document.getElementById('new-project-btn');
  if (newProjectBtn) {
    newProjectBtn.addEventListener('click', function () {
      var projectName = prompt('Enter project name');
      createAndSwitchProject(projectName);
    });
  }

  // ===== COMMAND PALETTE =====

  function makeSwitchAgentCmd(agentKey) {
    return {
      label: 'Switch Agent: ' + agents[agentKey].name,
      action: function () { currentAgent = agentKey; updateAgentIndicator(); }
    };
  }

  var COMMANDS = [
    { label: 'New Chat',     action: function () { window.newChat(); } },
    { label: 'New Project',  action: function () {
      var name = prompt('Enter project name');
      createAndSwitchProject(name);
    }},
    makeSwitchAgentCmd('general'),
    makeSwitchAgentCmd('coding'),
    makeSwitchAgentCmd('research'),
    makeSwitchAgentCmd('business'),
    makeSwitchAgentCmd('robotics'),
    { label: 'Rename Chat',  action: function () { if (currentChatId) renameChat(currentChatId); } },
    { label: 'Archive Chat', action: function () { if (currentChatId) archiveChat(currentChatId); } },
    { label: 'Delete Chat',  action: function () { if (currentChatId) deleteChat(currentChatId); } }
  ];

  function renderCommandList(filter) {
    var list = document.getElementById('command-list');
    if (!list) return;
    list.innerHTML = '';
    var filtered = filter
      ? COMMANDS.filter(function (c) { return c.label.toLowerCase().indexOf(filter.toLowerCase()) !== -1; })
      : COMMANDS;
    filtered.forEach(function (cmd) {
      var div = document.createElement('div');
      div.className = 'command-item';
      div.textContent = cmd.label;
      div.onclick = function () {
        closeCommandPalette();
        cmd.action();
      };
      list.appendChild(div);
    });
  }

  function openCommandPalette() {
    var palette = document.getElementById('command-palette');
    if (!palette) return;
    palette.classList.remove('hidden');
    var input = document.getElementById('command-input');
    if (input) {
      input.value = '';
      renderCommandList('');
      input.focus();
    }
  }

  function closeCommandPalette() {
    var palette = document.getElementById('command-palette');
    if (palette) palette.classList.add('hidden');
  }

  // Command input filtering
  var commandInputEl = document.getElementById('command-input');
  if (commandInputEl) {
    commandInputEl.addEventListener('input', function () {
      renderCommandList(this.value);
    });
    commandInputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeCommandPalette();
      }
    });
  }

  // Close palette when clicking the backdrop
  var paletteEl = document.getElementById('command-palette');
  if (paletteEl) {
    paletteEl.addEventListener('click', function (e) {
      if (e.target === paletteEl || e.target.classList.contains('command-palette-backdrop')) {
        closeCommandPalette();
      }
    });
  }

  // Ctrl+K opens command palette; Escape closes it
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault();
      openCommandPalette();
    } else if (e.key === 'Escape') {
      closeCommandPalette();
    }
  });

  // Expose openCommandPalette globally if needed
  window.openCommandPalette = openCommandPalette;

  // On page load: render project list and chat history, restore the most recent non-archived conversation
  window.addEventListener('load', function () {
    renderProjectList();
    renderChatHistory();
    var ids = Object.keys(conversations)
      .filter(function (id) { return !conversations[id].archived && conversations[id].project === currentProject; })
      .sort(function (a, b) {
        // IDs are 'chat_TIMESTAMP_random'; sort by numeric timestamp portion
        var ta = parseInt(a.split('_')[1], 10) || 0;
        var tb = parseInt(b.split('_')[1], 10) || 0;
        return ta - tb;
      });
    if (ids.length > 0) {
      loadChat(ids[ids.length - 1]);
    }
  });

  // Show empty-state on initial load (if chat-screen is visible and no messages)
  showEmptyState();

  // Initialize the message counter display and refresh from backend
  updateAllCounters();
  // Sync plan from server first, then refresh usage so counters use the
  // correct (server-authoritative) plan limits.
  fetchPlanFromServer(function () {
    fetchUsageFromBackend();
  });

  // Check if the user is returning from a Stripe payment or billing portal.
  // ?upgrade_success=1  — returned from a successful payment link checkout
  // ?portal=return      — returned from the Stripe billing portal
  (function () {
    var params = new URLSearchParams(window.location.search);
    var isUpgradeSuccess = params.get('upgrade_success') === '1';
    var isPortalReturn   = params.get('portal') === 'return';

    if (isUpgradeSuccess || isPortalReturn) {
      // Clean the URL immediately so a refresh doesn't re-trigger this
      history.replaceState(null, '', window.location.pathname);
      if (isUpgradeSuccess) {
        // Show a temporary processing indicator while the webhook may still be arriving
        var planDisplayEl = document.getElementById('plan-display');
        if (planDisplayEl) planDisplayEl.textContent = 'Plan: Processing upgrade…';
      }
      // Poll up to 5 times (every 2 s) until the server returns the upgraded plan
      var pollCount = 0;
      var MAX_PLAN_POLL_ATTEMPTS = 5;
      var POLL_INTERVAL_MS       = 2000;
      var INITIAL_POLL_DELAY_MS  = 1500;
      var prevPlan  = userPlan;
      function pollPlan() {
        fetchPlanFromServer(function () {
          pollCount++;
          if (userPlan !== prevPlan) {
            // Plan changed — stop polling
            fetchUsageFromBackend();
          } else if (pollCount < MAX_PLAN_POLL_ATTEMPTS) {
            setTimeout(pollPlan, POLL_INTERVAL_MS);
          } else {
            // Polling exhausted — still refresh usage with current plan
            fetchUsageFromBackend();
          }
        });
      }
      setTimeout(pollPlan, INITIAL_POLL_DELAY_MS);
    }
  })();

  // Plan display
  function updatePlanDisplay() {
    var planDisplay = document.getElementById('plan-display');
    var upgradeBtnEl = document.getElementById('upgrade-btn');
    if (!planDisplay || !upgradeBtnEl) { return; }
    var plan = userPlan || 'starter';

    planDisplay.textContent = 'Plan: ' + plan.charAt(0).toUpperCase() + plan.slice(1);

    if (plan === 'starter') {
      upgradeBtnEl.style.display = 'block';
      upgradeBtnEl.textContent = 'Upgrade Plan';
    } else {
      upgradeBtnEl.style.display = 'none';
    }
  }

  var upgradeBtn = document.getElementById('upgrade-btn');
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', function () {
      document.getElementById('upgrade-modal').classList.remove('hidden');
    });
  }

  // Stripe payment links
  var stripeLinks = {
    basic: "https://buy.stripe.com/dRm3co30K4Nra70b8ld7q00",
    premium: "https://buy.stripe.com/aFa6oA6cWcfT2Ey7W9d7q01",
    ultimate: "https://buy.stripe.com/4gM00catc7ZDengccpd7q02"
  };

  function openStripeCheckout(plan) {
    var url = stripeLinks[plan];
    if (!url) {
      console.error("Stripe link not configured for plan:", plan);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  var upgradeBasic = document.getElementById('upgrade-basic');
  if (upgradeBasic) {
    upgradeBasic.addEventListener('click', function () { openStripeCheckout('basic'); });
  }

  var upgradePremium = document.getElementById('upgrade-premium');
  if (upgradePremium) {
    upgradePremium.addEventListener('click', function () { openStripeCheckout('premium'); });
  }

  var upgradeUltimate = document.getElementById('upgrade-ultimate');
  if (upgradeUltimate) {
    upgradeUltimate.addEventListener('click', function () { openStripeCheckout('ultimate'); });
  }

  updatePlanDisplay();
})();
