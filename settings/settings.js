// ===== SETTINGS MODULE =====
// Apocrita Settings - Profile, Preferences, Security, Billing

var currentView = 'chat';

function setCurrentView(view) {
  currentView = view;
  var chatContainer = document.getElementById('chat-screen');
  var settingsContainer = document.getElementById('settings-screen');
  if (view === 'chat') {
    if (chatContainer) chatContainer.style.display = 'flex';
    if (settingsContainer) settingsContainer.style.display = 'none';
  } else if (view === 'settings') {
    if (chatContainer) chatContainer.style.display = 'none';
    if (settingsContainer) settingsContainer.style.display = 'flex';
  }
}

function openSettings() {
  setCurrentView('settings');
  loadSettingsData();
}

function closeSettings() {
  setCurrentView('chat');
}

function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-nav-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.settings-panel').forEach(function(el) {
    el.classList.toggle('active', el.id === 'settings-' + tab);
  });
  clearSettingsMessages();
}

function loadSettingsData() {
  loadProfileData();
  loadBillingData();
  loadPreferencesData();
}

// ===== PROFILE =====

function loadProfileData() {
  var user = localStorage.getItem('apocrita_user') || '';
  var profileKey = 'apocrita_profile_' + user;
  var profile = {};
  try {
    profile = JSON.parse(localStorage.getItem(profileKey) || '{}');
  } catch(e) {}

  var emailEl = document.getElementById('profile-email');
  var nameEl = document.getElementById('profile-name');
  var countryEl = document.getElementById('profile-country');
  var langEl = document.getElementById('profile-language');
  var dobEl = document.getElementById('profile-dob');

  if (emailEl) emailEl.value = (user === 'guest') ? '' : user;
  if (nameEl) nameEl.value = profile.name || '';
  if (countryEl) countryEl.value = profile.country || '';
  if (langEl) langEl.value = profile.language || '';
  if (dobEl) dobEl.value = profile.dob || '';
}

function saveProfile() {
  var user = localStorage.getItem('apocrita_user');
  if (!user || user === 'guest') {
    showSettingsMessage('profile-message', 'Please sign in to save profile data.', 'error');
    return;
  }

  var name = (document.getElementById('profile-name').value || '').trim();
  var country = document.getElementById('profile-country').value;
  var language = document.getElementById('profile-language').value;
  var dob = document.getElementById('profile-dob').value;

  var profileKey = 'apocrita_profile_' + user;
  localStorage.setItem(profileKey, JSON.stringify({
    name: name,
    country: country,
    language: language,
    dob: dob
  }));

  showSettingsMessage('profile-message', 'Profile saved successfully.', 'success');
}

// ===== PREFERENCES =====

var prefDefaults = {
  compactMode: false,
  autoScroll: true,
  soundNotifications: false
};

function loadPreferencesData() {
  var stored = {};
  try {
    stored = JSON.parse(localStorage.getItem('apocrita_preferences') || '{}');
  } catch(e) {}

  var prefs = Object.assign({}, prefDefaults, stored);

  var compactEl = document.getElementById('pref-compact');
  var scrollEl = document.getElementById('pref-autoscroll');
  var soundEl = document.getElementById('pref-sound');

  if (compactEl) compactEl.checked = !!prefs.compactMode;
  if (scrollEl) scrollEl.checked = !!prefs.autoScroll;
  if (soundEl) soundEl.checked = !!prefs.soundNotifications;
}

function savePreferences() {
  var compactEl = document.getElementById('pref-compact');
  var scrollEl = document.getElementById('pref-autoscroll');
  var soundEl = document.getElementById('pref-sound');

  var prefs = {
    compactMode: compactEl ? compactEl.checked : false,
    autoScroll: scrollEl ? scrollEl.checked : true,
    soundNotifications: soundEl ? soundEl.checked : false
  };

  localStorage.setItem('apocrita_preferences', JSON.stringify(prefs));
  showSettingsMessage('preferences-message', 'Preferences saved.', 'success');
}

// ===== SECURITY =====

function changePassword() {
  var user = localStorage.getItem('apocrita_user');
  if (!user || user === 'guest') {
    showSettingsMessage('security-message', 'Please sign in to change your password.', 'error');
    return;
  }

  var currentPass = (document.getElementById('current-password').value || '');
  var newPass = (document.getElementById('new-password').value || '');
  var confirmPass = (document.getElementById('confirm-new-password').value || '');

  if (!currentPass || !newPass || !confirmPass) {
    showSettingsMessage('security-message', 'All password fields are required.', 'error');
    return;
  }

  if (newPass.length < 6) {
    showSettingsMessage('security-message', 'New password must be at least 6 characters.', 'error');
    return;
  }

  if (newPass !== confirmPass) {
    showSettingsMessage('security-message', 'New passwords do not match.', 'error');
    return;
  }

  localStorage.setItem('apocrita_password_' + user, newPass);

  document.getElementById('current-password').value = '';
  document.getElementById('new-password').value = '';
  document.getElementById('confirm-new-password').value = '';

  showSettingsMessage('security-message', 'Password updated successfully.', 'success');
}

function logoutAllSessions() {
  if (confirm('This will sign you out of the current session. Continue?')) {
    closeSettings();
    if (typeof signOut === 'function') signOut();
  }
}

function deleteAccount() {
  var user        = localStorage.getItem('apocrita_user');
  var accessToken = localStorage.getItem('apocrita_token');

  if (!user || user === 'guest') {
    showSettingsMessage('security-message', 'Please sign in to delete your account.', 'error');
    return;
  }

  if (!confirm('Are you sure you want to permanently delete your account?\n\nThis will:\n• Cancel any active subscription\n• Delete all your data\n• Sign you out immediately\n\nThis cannot be undone.')) return;

  var deleteBtn = document.getElementById('delete-account-btn');
  if (deleteBtn) { deleteBtn.disabled = true; deleteBtn.textContent = 'Deleting\u2026'; }
  showSettingsMessage('security-message', 'Deleting account\u2026', 'success');

  fetch('/api/account?action=delete', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: user, accessToken: accessToken || '' })
  })
  .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
  .then(function (result) {
    if (!result.ok && result.data && result.data.error) {
      showSettingsMessage('security-message', result.data.error, 'error');
      if (deleteBtn) { deleteBtn.disabled = false; deleteBtn.textContent = 'Delete Account'; }
      return;
    }
    // Clear all local state and return to login screen
    _clearLocalAccountData(user);
  })
  .catch(function () {
    // Server unreachable — still clear local state so user isn't stuck
    _clearLocalAccountData(user);
  });
}

function _clearLocalAccountData(user) {
  var keysToRemove = [
    'apocrita_user',
    'apocrita_token',
    'apocrita_uid',
    'apocrita_plan',
    'apocrita_billing_status',
    'apocrita_customer_id',
    'apocrita_period_end',
    'apocrita_msg_count',
    'apocrita_msg_date',
    'apocrita_conversations',
    'apocrita_projects',
    'apocrita_preferences',
    'apocrita_needs_verification',
    'apocrita_pending_email',
    'apocrita_pending_token',
    'apocrita_last_verification_sent'
  ];
  if (user) {
    keysToRemove.push('apocrita_verified_' + user);
    keysToRemove.push('apocrita_profile_' + user);
    keysToRemove.push('apocrita_password_' + user);
    keysToRemove.push('apocrita_stripe_customer_' + user);
  }
  keysToRemove.forEach(function (key) { localStorage.removeItem(key); });

  document.getElementById('settings-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  if (typeof updateAccountDisplay === 'function') updateAccountDisplay();
}

// ===== BILLING =====

var planLimitsDisplay = {
  starter:  '30 messages / day',
  basic:    '150 messages / day',
  premium:  '500 messages / day',
  ultimate: 'Unlimited messages'
};

var planStatusLabels = {
  active:    'Active',
  trialing:  'Trial Active',
  inactive:  'Free Plan',
  cancelled: 'Cancelled',
  past_due:  'Payment Required'
};

function loadBillingData() {
  var user = localStorage.getItem('apocrita_user');
  // Always re-fetch from server so plan reflects server state, not localStorage
  if (user && user !== 'guest') {
    _fetchAndDisplayPlan(user);
  } else {
    _applyPlanToUI('starter', 'inactive', null, null);
  }
}

function _fetchAndDisplayPlan(email) {
  fetch('/api/account?action=plan&email=' + encodeURIComponent(email))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) return;
      // Update localStorage so the rest of the app (usage limits etc.) stays in sync
      localStorage.setItem('apocrita_plan', data.plan || 'starter');
      if (data.customerId) {
        localStorage.setItem('apocrita_stripe_customer_' + email, data.customerId);
      }
      _applyPlanToUI(data.plan, data.billingStatus, data.customerId, data.currentPeriodEnd);
    })
    .catch(function () {
      var cached = localStorage.getItem('apocrita_plan') || 'starter';
      _applyPlanToUI(cached, 'inactive', null, null);
    });
}

function _applyPlanToUI(plan, billingStatus, customerId, currentPeriodEnd) {
  var safePlan  = plan || 'starter';
  var planName  = safePlan.charAt(0).toUpperCase() + safePlan.slice(1);
  var statusLabel = planStatusLabels[billingStatus] || billingStatus || 'Free Plan';

  var nameEl    = document.getElementById('billing-plan-name');
  var limitEl   = document.getElementById('billing-plan-limit');
  var statusEl  = document.getElementById('billing-status-label');
  var renewEl   = document.getElementById('billing-renew-date');
  var portalBtn = document.getElementById('billing-portal-btn');

  if (nameEl)   nameEl.textContent   = planName;
  if (limitEl)  limitEl.textContent  = planLimitsDisplay[safePlan] || '30 messages / day';
  if (statusEl) statusEl.textContent = statusLabel;

  if (renewEl) {
    if (currentPeriodEnd) {
      var d = new Date(currentPeriodEnd);
      renewEl.textContent = 'Renews: ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      renewEl.style.display = '';
    } else {
      renewEl.style.display = 'none';
    }
  }

  // Show portal button only when user has a paid Stripe customer record
  if (portalBtn) {
    portalBtn.style.display = (customerId && safePlan !== 'starter') ? '' : 'none';
  }

  // Show a security badge in the billing panel
  var badgeEl = document.getElementById('billing-secure-badge');
  if (badgeEl) {
    badgeEl.textContent = (safePlan !== 'starter' && billingStatus === 'active')
      ? 'Subscription Active — Secured by Stripe'
      : 'Payments secured by Stripe';
  }
}

function openBillingPortal() {
  var user = localStorage.getItem('apocrita_user');
  if (!user || user === 'guest') {
    showSettingsMessage('billing-message', 'Please sign in to manage billing.', 'error');
    return;
  }

  showSettingsMessage('billing-message', 'Connecting to billing portal...', 'success');

  // Send email to server — it validates the customer ID from Supabase, not client
  fetch('/api/billing?action=portal', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: user })
  })
  .then(function (r) { return r.json(); })
  .then(function (data) {
    if (data.url) {
      window.location.href = data.url;
    } else {
      showSettingsMessage('billing-message', data.error || 'Could not open billing portal. Please try again.', 'error');
    }
  })
  .catch(function () {
    showSettingsMessage('billing-message', 'Could not connect to billing portal. Please try again.', 'error');
  });
}

// ===== HELPERS =====

function showSettingsMessage(elementId, message, type) {
  var el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.className = 'settings-message ' + (type || 'success');
  clearTimeout(el._msgTimeout);
  el._msgTimeout = setTimeout(function() {
    el.textContent = '';
    el.className = 'settings-message';
  }, 4000);
}

function clearSettingsMessages() {
  document.querySelectorAll('.settings-message').forEach(function(el) {
    el.textContent = '';
    el.className = 'settings-message';
  });
}

// ===== EMAIL VERIFICATION =====

function _generateVerificationToken() {
  var arr = new Uint8Array(32);
  window.crypto.getRandomValues(arr);
  return Array.from(arr).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function _sendVerificationEmailRequest(email, token) {
  return fetch('/api/verify?action=send', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: email, token: token })
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) throw new Error(data.error || 'Failed to send verification email.');
      return data;
    });
  });
}

function _setVerifMsg(text, color) {
  // Update whichever message container is currently visible
  ['verification-message', 'verification-expired-message'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) { el.textContent = text; el.className = 'verification-message ' + (color || ''); }
  });
}

function _showVerificationScreen(email) {
  var loginEl  = document.getElementById('login-screen');
  var verifEl  = document.getElementById('verification-screen');
  var expireEl = document.getElementById('verification-expired-screen');
  if (loginEl)  loginEl.style.display  = 'none';
  if (verifEl)  verifEl.style.display  = 'flex';
  if (expireEl) expireEl.style.display = 'none';
  var disp = document.getElementById('verification-email-display');
  if (disp && email) disp.textContent = email;
}

function _showExpiredScreen(email) {
  var loginEl  = document.getElementById('login-screen');
  var verifEl  = document.getElementById('verification-screen');
  var expireEl = document.getElementById('verification-expired-screen');
  if (loginEl)  loginEl.style.display  = 'none';
  if (verifEl)  verifEl.style.display  = 'none';
  if (expireEl) expireEl.style.display = 'flex';
  var disp = document.getElementById('verification-expired-email');
  if (disp && email) disp.textContent = email;
}

// Called by the Create Account button
function createAccountWithVerification() {
  var email    = (document.getElementById('signup-email').value    || '').trim().toLowerCase();
  var password = document.getElementById('signup-password').value  || '';
  var confirm  = document.getElementById('signup-confirm').value   || '';
  var errorEl  = document.getElementById('signup-error');
  var btn      = document.querySelector('#section-signup .submit-btn');

  errorEl.textContent = '';

  if (!email || !password) { errorEl.textContent = 'Please enter email and password.'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errorEl.textContent = 'Please enter a valid email address.'; return; }
  if (password.length < 8) { errorEl.textContent = 'Password must be at least 8 characters.'; return; }
  if (password !== confirm) { errorEl.textContent = 'Passwords do not match.'; return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Creating account...'; }

  var SUPABASE_URL  = 'https://faiudaldfqmqlpyghgol.supabase.co';
  var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhaXVkYWxkZnFtcWxweWdoZ29sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNzY0MzcsImV4cCI6MjA5NDc1MjQzN30.JsIrG8f57Gi58gupLstLiUt8whYxzbIHVsxpc5wYEjE';

  // Step 1: Register with Supabase Auth (email confirmation disabled — we handle it ourselves)
  fetch(SUPABASE_URL + '/auth/v1/signup', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
    body:    JSON.stringify({ email: email, password: password })
  })
  .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
  .then(function (result) {
    if (!result.ok) {
      var msg = (result.data && result.data.msg) || 'Account could not be created. Please try again.';
      if (msg.toLowerCase().includes('already')) msg = 'An account with this email already exists. Please sign in.';
      errorEl.textContent = msg;
      if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
      return;
    }

    // Step 2: Generate and send verification token
    var token = _generateVerificationToken();
    localStorage.setItem('apocrita_pending_email', email);
    localStorage.setItem('apocrita_pending_token', token);
    localStorage.setItem('apocrita_needs_verification', 'true');

    _showVerificationScreen(email);
    _setVerifMsg('Sending verification email\u2026', 'verif-pending');
    if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }

    _sendVerificationEmailRequest(email, token)
      .then(function () {
        _setVerifMsg('Verification email sent. Please check your inbox and spam folder.', 'verif-ok');
        localStorage.setItem('apocrita_last_verification_sent', Date.now().toString());
      })
      .catch(function (err) {
        _setVerifMsg((err && err.message) || 'Could not send verification email. Please use the resend button.', 'verif-err');
      });
  })
  .catch(function () {
    errorEl.textContent = 'Network error. Please check your connection and try again.';
    if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
  });
}

function cancelVerification() {
  localStorage.removeItem('apocrita_needs_verification');
  localStorage.removeItem('apocrita_pending_email');
  localStorage.removeItem('apocrita_pending_token');
  localStorage.removeItem('apocrita_last_verification_sent');
  var verifEl  = document.getElementById('verification-screen');
  var expireEl = document.getElementById('verification-expired-screen');
  var loginEl  = document.getElementById('login-screen');
  if (verifEl)  verifEl.style.display  = 'none';
  if (expireEl) expireEl.style.display = 'none';
  if (loginEl)  loginEl.style.display  = 'flex';
}

function resendVerificationEmail() {
  var email = localStorage.getItem('apocrita_pending_email');
  var token = localStorage.getItem('apocrita_pending_token');

  if (!email) {
    // Try to read email from the expired screen display
    var expDisp = document.getElementById('verification-expired-email');
    if (expDisp) email = expDisp.textContent.trim();
  }

  if (!email) {
    _setVerifMsg('No pending verification found. Please sign up again.', 'verif-err');
    return;
  }

  // Enforce 60s client-side cooldown
  var lastSent   = parseInt(localStorage.getItem('apocrita_last_verification_sent') || '0', 10);
  var elapsed    = Date.now() - lastSent;
  var cooldownMs = 60 * 1000;
  if (elapsed < cooldownMs) {
    var remaining = Math.ceil((cooldownMs - elapsed) / 1000);
    _setVerifMsg('Please wait ' + remaining + ' second' + (remaining !== 1 ? 's' : '') + ' before resending.', 'verif-warn');
    return;
  }

  // Generate a fresh token for the resend (old one may be expired in DB)
  token = _generateVerificationToken();
  localStorage.setItem('apocrita_pending_token', token);
  localStorage.setItem('apocrita_pending_email', email);
  localStorage.setItem('apocrita_needs_verification', 'true');

  _setVerifMsg('Sending verification email\u2026', 'verif-pending');

  _sendVerificationEmailRequest(email, token)
    .then(function () {
      _setVerifMsg('Verification email sent. Please check your inbox and spam folder.', 'verif-ok');
      localStorage.setItem('apocrita_last_verification_sent', Date.now().toString());
      // If we were on the expired screen, switch back to normal verification screen
      _showVerificationScreen(email);
    })
    .catch(function (err) {
      _setVerifMsg((err && err.message) || 'Could not send verification email. Please try again later.', 'verif-err');
    });
}

// Called on page load — checks for ?verify=<token> in URL and validates it server-side
function checkVerificationToken() {
  var params = new URLSearchParams(window.location.search);
  var token  = params.get('verify');
  if (!token) return;

  // Clean the URL immediately so a page refresh doesn't re-process the token
  history.replaceState(null, '', window.location.pathname);

  // Show a brief "Verifying..." state while we call the server
  var loginEl = document.getElementById('login-screen');
  var verifEl = document.getElementById('verification-screen');
  if (loginEl) loginEl.style.display = 'none';
  if (verifEl) verifEl.style.display = 'flex';
  _setVerifMsg('Verifying your email\u2026', 'verif-pending');

  fetch('/api/verify?action=confirm', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ token: token })
  })
  .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
  .then(function (result) {
    if (result.ok && result.data.ok) {
      // Success — save email, redirect to chat
      var email = result.data.email || localStorage.getItem('apocrita_pending_email') || '';
      localStorage.removeItem('apocrita_needs_verification');
      localStorage.removeItem('apocrita_pending_token');
      localStorage.removeItem('apocrita_pending_email');
      localStorage.setItem('apocrita_user', email);

      // Show success flash then open chat
      _setVerifMsg('Email verified successfully! Opening Apocrita\u2026', 'verif-ok');
      setTimeout(function () {
        if (verifEl) verifEl.style.display = 'none';
        var chatEl = document.getElementById('chat-screen');
        if (chatEl) chatEl.style.display = 'flex';
        if (typeof updateAccountDisplay === 'function') updateAccountDisplay();
        if (typeof refreshPlanFromServer === 'function') refreshPlanFromServer(email);
      }, 1200);

    } else if (result.data && result.data.expired) {
      // Token expired — show expired screen with resend option
      var pendingEmail = localStorage.getItem('apocrita_pending_email') || '';
      _showExpiredScreen(pendingEmail);

    } else {
      var msg = (result.data && result.data.error) || 'Verification failed. The link may be invalid.';
      _setVerifMsg(msg, 'verif-err');
    }
  })
  .catch(function () {
    _setVerifMsg('Network error while verifying. Please try again.', 'verif-err');
  });
}

function checkVerificationState() {
  var needsVerification = localStorage.getItem('apocrita_needs_verification');
  var user = localStorage.getItem('apocrita_user');
  if (needsVerification === 'true' && !user) {
    var email = localStorage.getItem('apocrita_pending_email') || '';
    _showVerificationScreen(email);
  }
}

// ===== INIT =====

// Fetch the authoritative plan from the server and sync localStorage + UI.
// This is the canonical way to refresh plan state — never trust client claims.
function refreshPlanFromServer(email) {
  if (!email || email === 'guest') return;
  fetch('/api/account?action=plan&email=' + encodeURIComponent(email))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.plan) return;
      localStorage.setItem('apocrita_plan', data.plan);
      if (data.customerId) {
        localStorage.setItem('apocrita_stripe_customer_' + email, data.customerId);
      }
      _applyPlanToUI(data.plan, data.billingStatus, data.customerId, data.currentPeriodEnd || null);
      // Propagate to chat.js if it's loaded
      if (typeof userPlan !== 'undefined') {
        try { window._apocrita_plan = data.plan; } catch (e) { /* ignore */ }
      }
    })
    .catch(function () {
      // Non-fatal: keep existing local plan
    });
}

document.addEventListener('DOMContentLoaded', function() {
  checkVerificationToken();
  checkVerificationState();

  var params = new URLSearchParams(window.location.search);
  var isUpgradeSuccess = params.get('upgrade_success') === '1';
  var isPortalReturn   = params.get('portal') === 'return';

  if (isPortalReturn || isUpgradeSuccess) {
    history.replaceState(null, '', window.location.pathname);
    var user = localStorage.getItem('apocrita_user');
    if (user) {
      openSettings();
      switchSettingsTab('billing');
      // Fetch and apply the latest plan from the server
      refreshPlanFromServer(user);
    }
  }

  // On every load, sync the plan from the server so it persists after re-login
  var currentUser = localStorage.getItem('apocrita_user');
  if (currentUser && currentUser !== 'guest') {
    refreshPlanFromServer(currentUser);
  }
});
