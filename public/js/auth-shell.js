'use strict';

/**
 * Shared behaviour for the three entry screens: sign in, create account and
 * join a meeting. Every helper is null-safe because each page only renders
 * the pieces it needs.
 */
(function () {
  let slide = 0;
  let timer = null;

  function paintSlides() {
    const lays = document.querySelectorAll('[data-slide]');
    const captions = document.querySelectorAll('[data-caption]');
    const dots = document.querySelectorAll('[data-dot]');
    const count = lays.length || 1;

    lays.forEach((el, i) => {
      const on = i === slide;
      el.style.opacity = on ? '1' : '0';
      el.style.pointerEvents = on ? 'auto' : 'none';
      el.style.transform = on ? 'scale(1.06)' : 'scale(1)';
    });
    captions.forEach((el, i) => {
      const on = i === slide;
      el.style.opacity = on ? '1' : '0';
      el.style.transform = on ? 'translateY(0)' : 'translateY(8px)';
      el.style.pointerEvents = on ? 'auto' : 'none';
    });
    dots.forEach((el, i) => {
      const on = i === slide;
      el.style.width = on ? '28px' : '6px';
      el.style.opacity = on ? '1' : '0.4';
    });

    const label = $('slideCount');
    if (label) label.textContent = '0' + (slide + 1) + ' / 0' + count;
  }

  function startSlideshow() {
    clearInterval(timer);
    if (document.querySelectorAll('[data-slide]').length < 2) return;
    timer = setInterval(() => {
      slide = (slide + 1) % document.querySelectorAll('[data-slide]').length;
      paintSlides();
    }, 5200);
  }

  function bindDots() {
    document.querySelectorAll('[data-dot]').forEach((el, i) => {
      el.onclick = () => {
        slide = i;
        paintSlides();
        startSlideshow();
      };
    });
  }

  function busy(btn, on, idle) {
    if (!btn) return;
    btn.disabled = on;
    btn.innerHTML = on
      ? '<span class="spin"></span><span>Please wait…</span>'
      : '<span>' + idle + '</span>';
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

  async function pingHealth() {
    const label = $('healthLabel');
    if (!label) return;
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      label.textContent = response.ok ? 'All systems operational' : 'Server unavailable';
      label.parentElement.style.color = response.ok ? '#4B5F55' : '#B42318';
    } catch {
      label.textContent = 'Server unreachable';
      label.parentElement.style.color = '#B42318';
    }
  }

  /** Only allow same-origin redirects coming from ?next=/… */
  function nextPath() {
    const next = new URLSearchParams(location.search).get('next');
    if (next && next.startsWith('/') && !next.startsWith('//')) return next;
    return '';
  }

  /** Room code from a pending call redirect, e.g. next=/call?code=a1b2c3d4 */
  function pendingRoomCode() {
    const match = nextPath().match(/[?&]code=([a-zA-Z0-9]+)/);
    return match ? match[1].toLowerCase() : '';
  }

  /** Keep a pending room code when the visitor switches to the join screen. */
  function carryRoomCode() {
    const code = pendingRoomCode();
    if (!code) return;
    document.querySelectorAll('a[href="/join"]').forEach((link) => {
      link.href = '/join?code=' + encodeURIComponent(code);
    });
  }

  window.MRAuth = {
    paintSlides,
    startSlideshow,
    bindDots,
    busy,
    togglePassword,
    pingHealth,
    nextPath,
    pendingRoomCode,
    carryRoomCode,
  };

  document.addEventListener('DOMContentLoaded', () => {
    paintSlides();
    startSlideshow();
    bindDots();
    carryRoomCode();
    pingHealth();
  });
})();
