// auth.js — Apocrita authentication layer
// Uses Supabase email/password auth with server-side email verification gate.

var SUPABASE_URL  = 'https://faiudaldfqmqlpyghgol.supabase.co';
var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhaXVkYWxkZnFtcWxweWdoZ29sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNzY0MzcsImV4cCI6MjA5NDc1MjQzN30.JsIrG8f57Gi58gupLstLiUt8whYxzbIHVsxpc5wYEjE';

// Lightweight Supabase REST helper — no SDK bundle needed
var _sb = {
  _headers: function (extra) {
    var h = { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON };
    if (extra) Object.assign(h, extra);
    return h;
  },

  // Sign up via Supabase Auth REST
  signUp: async function (email, password) {
    var r = await fetch(SUPABASE_URL + '/auth/v1/signup', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ email: email, password: password })
    });
    return { ok: r.ok, data: await r.json() };
  },

  // Sign in via Supabase Auth REST
  signIn: async function (email, password) {
    var r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ email: email, password: password })
    });
    return { ok: r.ok, status: r.status, data: await r.json() };
  },

  // Sign out
  signOut: async function (accessToken) {
    await fetch(SUPABASE_URL + '/auth/v1/logout', {
      method: 'POST',
      headers: this._headers({ 'Authorization': 'Bearer ' + accessToken })
    });
  },

  // Get profile row for the authenticated user
  getProfile: async function (userId, accessToken) {
    var r = await fetch(
      SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(userId) + '&select=email,email_verified',
      { headers: this._headers({ 'Authorization': 'Bearer ' + accessToken }) }
    );
    var rows = await r.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }
};

// ===== Internal helpers =====

function _showScreen(id) {
  var screens = ['login-screen', 'chat-screen', 'verification-screen'];
  screens.forEach(function (s) {
    var el = document.getElementById(s);
    if (!el) return;
    el.style.display = s === id ? (s === 'login-screen' ? 'flex' : 'flex') : 'none';
  });
}

function _setError(elId, msg) {
  var el = document.getElementById(elId);
  if (el) el.textContent = msg;
}

function _setBtnState(btn, loading, label) {
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? 'Please wait...' : label;
}

function _validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function _validatePassword(password) {
  return password && password.length >= 8;
}

// Persist minimal auth state to localStorage (email + token)
function _saveSession(email, accessToken, userId) {
  localStorage.setItem('Apocrita_user',  email || '');
  localStorage.setItem('Apocrita_token', accessToken || '');
  localStorage.setItem('Apocrita_uid',   userId || '');
}

function _clearSession() {
  localStorage.removeItem('Apocrita_user');
  localStorage.removeItem('Apocrita_token');
  localStorage.removeItem('Apocrita_uid');
  // Also clear any legacy verification state
  localStorage.removeItem('Apocrita_needs_verification');
  localStorage.removeItem('Apocrita_pending_email');
  localStorage.removeItem('Apocrita_pending_token');
}

// ===== Public auth functions =====

function continueAsGuest() {
  localStorage.setItem('Apocrita_user', 'guest');
  _showScreen('chat-screen');
  updateAccountDisplay();
}

async function signIn() {
  var email    = (document.getElementById('signin-email').value || '').trim().toLowerCase();
  var password = document.getElementById('signin-password').value || '';
  var errorEl  = document.getElementById('signin-error');
  var btn      = document.querySelector('#section-signin .submit-btn');

  _setError('signin-error', '');

  if (!email || !password) {
    _setError('signin-error', 'Please enter email and password.');
    return;
  }
  if (!_validateEmail(email)) {
    _setError('signin-error', 'Please enter a valid email address.');
    return;
  }

  _setBtnState(btn, true, 'Sign In');

  try {
    var result = await _sb.signIn(email, password);

    if (!result.ok) {
      var msg = (result.data && result.data.error_description)
        ? result.data.error_description
        : 'Invalid email or password.';
      // Map common Supabase error codes to friendly messages
      if (result.status === 400) msg = 'Invalid email or password.';
      if (result.status === 422) msg = 'Email not confirmed. Please verify your email first.';
      _setError('signin-error', msg);
      _setBtnState(btn, false, 'Sign In');
      return;
    }

    var session = result.data;
    var userId  = session.user && session.user.id;

    // Check email_verified in our profiles table
    var profile = null;
    try {
      profile = await _sb.getProfile(userId, session.access_token);
    } catch (e) { /* non-fatal — profile may not exist yet */ }

    if (profile && profile.email_verified === false) {
      // Account exists but not verified — route to verification screen
      localStorage.setItem('Apocrita_pending_email', email);
      _showScreen('verification-screen');
      var disp = document.getElementById('verification-email-display');
      if (disp) disp.textContent = email;
      _setBtnState(btn, false, 'Sign In');
      return;
    }

    _saveSession(email, session.access_token, userId);
    _showScreen('chat-screen');
    updateAccountDisplay();
    if (typeof refreshPlanFromServer === 'function') refreshPlanFromServer(email);

  } catch (err) {
    _setError('signin-error', 'Network error. Please try again.');
    _setBtnState(btn, false, 'Sign In');
  }
}

function updateAccountDisplay() {
  var user       = localStorage.getItem('Apocrita_user');
  var label      = document.getElementById('account-label');
  var signoutBtn = document.getElementById('signoutBtn');

  if (label) {
    label.textContent = user === 'guest'
      ? 'Signed in as: Guest'
      : (user ? 'Signed in as: ' + user : '');
  }
  if (signoutBtn) {
    signoutBtn.style.display = user ? 'block' : 'none';
  }
}

async function signOut() {
  var token = localStorage.getItem('Apocrita_token');
  if (token) {
    try { await _sb.signOut(token); } catch (e) { /* ignore */ }
  }
  _clearSession();
  _showScreen('login-screen');
  if (typeof newChat === 'function') newChat();
  updateAccountDisplay();
}

window.onload = function () {
  var user = localStorage.getItem('Apocrita_user');
  if (user && user !== 'guest') {
    // Restore authenticated session
    _showScreen('chat-screen');
  } else if (user === 'guest') {
    _showScreen('chat-screen');
  } else {
    // Check for ?verify= token in URL (user clicking email link)
    if (typeof checkVerificationToken === 'function') checkVerificationToken();
    if (typeof checkVerificationState === 'function') checkVerificationState();
  }
  updateAccountDisplay();
};
