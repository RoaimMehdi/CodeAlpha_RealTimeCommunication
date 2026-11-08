// CamKnock Portal — Shared Utilities (loaded on every portal page)
// v20261108_v1

(function () {
  'use strict';

  // ── Clock ──────────────────────────────────────────────────────
  setInterval(() => {
    const el = document.getElementById('liveClock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }, 1000);

  // ── Auth helpers ───────────────────────────────────────────────
  window.getAuthHeaders = function () {
    const token = localStorage.getItem('portalToken') || localStorage.getItem('token');
    return {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': 'Bearer ' + token } : {})
    };
  };

  window.ensurePortalSession = async function () {
    let token = localStorage.getItem('portalToken') || localStorage.getItem('token');

    if (!token) {
      try {
        const res = await fetch('/api/portal/session');
        if (res.ok) {
          const data = await res.json();
          token = data.token;
          window._currentPortalUser = data.user;
          localStorage.setItem('portalToken', token);
        }
      } catch (e) {
        console.warn('Auto-session:', e);
      }
    } else {
      try {
        const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
        if (res.ok) {
          window._currentPortalUser = await res.json();
        } else {
          // renew
          const r2 = await fetch('/api/portal/session');
          if (r2.ok) {
            const d2 = await r2.json();
            token = d2.token;
            window._currentPortalUser = d2.user;
            localStorage.setItem('portalToken', token);
          }
        }
      } catch (e) {
        console.warn('Session verification:', e);
      }
    }

    // Update avatar + role badge
    const u = window._currentPortalUser;
    if (u) {
      const av = document.getElementById('userAvatar');
      if (av && u.name) av.textContent = u.name.slice(0, 2).toUpperCase();
      const ri = document.getElementById('roleIndicator');
      if (ri) {
        const r = (u.role || 'admin').toUpperCase();
        ri.textContent = r + ' ACCESS';
        ri.className = 'role-badge role-' + (u.role || 'admin');
      }
    }
  };

  window.portalSignOut = function () {
    localStorage.removeItem('portalToken');
    localStorage.removeItem('token');
    window.location.href = '/portal/login';
  };

  window.escapeHtml = function (v) {
    return String(v || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  };

  // Live rooms pill count — updated by overview/live-calls pages
  window.updateLivePill = function (count) {
    const p = document.getElementById('livePill');
    if (p) p.textContent = count + ' LIVE';
  };

  // Shared sidebar nav HTML builder (called per page with the active page key)
  // Not used directly — each page has its own HTML sidebar for speed.
})();

