'use strict';

const TOKEN_KEY = 'camknock_token';
const NAME_KEY = 'camknock_name';
const GUEST_KEY = 'camknock_guest';
const CAM_KEY = 'camknock_cam';
const MIC_KEY = 'camknock_mic';

const store = {
  get(key) {
    try {
      const val = sessionStorage.getItem(key) || localStorage.getItem(key);
      if (val) return val;
      // Smooth fallback to legacy meetroom keys
      const legacyKey = key.replace('camknock_', 'meetroom_');
      return sessionStorage.getItem(legacyKey) || localStorage.getItem(legacyKey);
    } catch {
      return null;
    }
  },
  set(key, value, remember) {
    const persistent = remember !== false;
    try {
      if (persistent) {
        localStorage.setItem(key, value);
        sessionStorage.removeItem(key);
      } else {
        sessionStorage.setItem(key, value);
        localStorage.removeItem(key);
      }
    } catch {
      /* ignore quota / private mode */
    }
  },
  clear() {
    [
      TOKEN_KEY, NAME_KEY, GUEST_KEY, CAM_KEY, MIC_KEY,
      'meetroom_token', 'meetroom_name', 'meetroom_guest', 'meetroom_cam', 'meetroom_mic'
    ].forEach((key) => {
      try {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    });
  },
};

function token() {
  return store.get(TOKEN_KEY);
}

function userName() {
  return store.get(NAME_KEY) || '';
}

function isGuest() {
  return store.get(GUEST_KEY) === '1';
}

function saveSession(data, remember) {
  store.set(TOKEN_KEY, data.token, remember);
  store.set(NAME_KEY, data.name, remember);
  if (data.guest) store.set(GUEST_KEY, '1', remember);
  else {
    try {
      localStorage.removeItem(GUEST_KEY);
      sessionStorage.removeItem(GUEST_KEY);
    } catch {
      /* ignore */
    }
  }
}

function logout() {
  store.clear();
  location.href = '/';
}

function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 'YO';
  const letters = (parts[0][0] || '') + (parts[1] ? parts[1][0] : parts[0][1] || '');
  return letters.toUpperCase();
}

function parseRoomCode(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const fromQuery = raw.match(/[?&]code=([a-zA-Z0-9]+)/i);
  if (fromQuery) return fromQuery[1].toLowerCase();
  const fromPath = raw.match(/\/(?:call|r)\/([a-zA-Z0-9]+)/i);
  if (fromPath) return fromPath[1].toLowerCase();
  return raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function formatCode(code) {
  const value = String(code || '').toLowerCase();
  if (value.length === 8) return value.slice(0, 4) + ' ' + value.slice(4);
  return value;
}

function setPrefs(camOn, micOn) {
  store.set(CAM_KEY, camOn ? '1' : '0', true);
  store.set(MIC_KEY, micOn ? '1' : '0', true);
}

function getPrefs() {
  return {
    cam: store.get(CAM_KEY) !== '0',
    mic: store.get(MIC_KEY) !== '0',
  };
}

function $(id) {
  return document.getElementById(id);
}

function show(el, on) {
  if (!el) return;
  el.classList.toggle('hidden', !on);
}

async function api(url, method, body, form) {
  const headers = {};
  const current = token();
  if (current) headers.Authorization = 'Bearer ' + current;
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: method || 'GET',
      headers,
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json')
      ? await response.json()
      : { error: await response.text() };
    if (!response.ok) {
      if (response.status === 401 && current && !url.includes('/login')) {
        store.clear();
        if (!location.pathname.endsWith('/') && location.pathname !== '/index.html') {
          location.href = '/';
        }
      }
      throw new Error(data.error || 'Request failed');
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Server did not respond. Check that CamKnock is running.');
    if (error instanceof TypeError) throw new Error('Could not reach the server. Open this app from the CamKnock URL.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requireAuth(page) {
  if (token()) return true;
  const next = page ? '?next=' + encodeURIComponent(page) : '';
  location.href = '/' + next;
  return false;
}

function nextPath() {
  try {
    const next = new URLSearchParams(location.search).get('next');
    if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  } catch {
    /* ignore */
  }
  return '';
}

function pendingRoomCode() {
  const match = nextPath().match(/[?&]code=([a-zA-Z0-9]+)/);
  return match ? match[1].toLowerCase() : '';
}

function togglePassword(inputId, btnId) {
  const input = $(inputId);
  const btn = $(btnId);
  if (!input || !btn) return;
  btn.onclick = () => {
    const showPw = input.type === 'password';
    input.type = showPw ? 'text' : 'password';
    btn.textContent = showPw ? 'Hide' : 'Show';
  };
}

window.MRAuth = {
  nextPath,
  pendingRoomCode,
  togglePassword,
};

