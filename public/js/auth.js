'use strict';

/**
 * MeetRoom — Auth & Quick Join Controller (`/`)
 * Matches MeetRoom Login v2 design logic and styling
 */
(function () {
  const tabSignin = $('tabSignin');
  const tabJoin = $('tabJoin');
  const signinSection = $('signinSection');
  const joinSection = $('joinSection');
  const toSigninLink = $('toSigninLink');

  const signinForm = $('signinForm');
  const emailInput = $('email');
  const passwordInput = $('password');
  const emailErr = $('emailErr');
  const pwErr = $('pwErr');
  const authOk = $('authOk');
  const signinBtn = $('signinBtn');
  const signinSpinner = $('signinSpinner');
  const signinLabel = $('signinLabel');

  const joinForm = $('joinMeetingForm');
  const quickCodeInput = $('quickCode');
  const quickNameInput = $('quickName');
  const quickCodeErr = $('quickCodeErr');
  const quickNameErr = $('quickNameErr');
  const quickJoinOk = $('quickJoinOk');
  const quickJoinBtn = $('quickJoinBtn');
  const quickJoinSpinner = $('quickJoinSpinner');
  const quickJoinLabel = $('quickJoinLabel');

  /* ------------------------------------------------------------------ */
  /* Art Slideshow Controller                                           */
  /* ------------------------------------------------------------------ */
  let currentSlide = 0;
  let slideTimer = null;
  const slideCount = 3;

  function setSlide(index) {
    currentSlide = (index + slideCount) % slideCount;
    for (let i = 0; i < slideCount; i++) {
      const slideEl = $('slide' + i);
      const capEl = $('caption' + i);
      const dotEl = $('dot' + i);
      const isCur = i === currentSlide;

      if (slideEl) {
        slideEl.style.opacity = isCur ? '1' : '0';
        slideEl.style.pointerEvents = isCur ? 'auto' : 'none';
        slideEl.style.transform = isCur ? 'scale(1.06)' : 'scale(1)';
      }
      if (capEl) {
        capEl.style.opacity = isCur ? '1' : '0';
        capEl.style.pointerEvents = isCur ? 'auto' : 'none';
        capEl.style.transform = isCur ? 'translateY(0)' : 'translateY(8px)';
      }
      if (dotEl) {
        dotEl.style.width = isCur ? '28px' : '6px';
        dotEl.style.opacity = isCur ? '1' : '0.4';
      }
    }
    const countEl = $('slideCount');
    if (countEl) countEl.textContent = `0${currentSlide + 1} / 03`;
  }

  function startSlideshow() {
    clearInterval(slideTimer);
    slideTimer = setInterval(() => {
      setSlide(currentSlide + 1);
    }, 5000);
  }

  for (let i = 0; i < slideCount; i++) {
    const dot = $('dot' + i);
    if (dot) {
      dot.onclick = () => {
        setSlide(i);
        startSlideshow();
      };
    }
  }
  startSlideshow();

  /* ------------------------------------------------------------------ */
  /* Redirection & Session Check                                        */
  /* ------------------------------------------------------------------ */
  const params = new URLSearchParams(location.search);
  const pendingCode = parseRoomCode(params.get('code') || params.get('room') || pendingRoomCode() || '');
  const mode = params.get('mode');

  function goNext() {
    const next = nextPath();
    location.href = next || '/home';
  }

  if (token() && !isGuest()) {
    if (pendingCode) {
      location.href = `/call?code=${encodeURIComponent(pendingCode)}`;
      return;
    }
    if (location.pathname === '/signin' || location.pathname === '/login' || mode === 'signin') {
      goNext();
      return;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tab Switching                                                      */
  /* ------------------------------------------------------------------ */
  function setTab(mode) {
    if (tabJoin && tabSignin) {
      if (mode === 'join') {
        tabJoin.style.background = '#fff';
        tabJoin.style.color = '#0A5E39';
        tabJoin.style.boxShadow = '0 1px 3px rgba(10,61,39,0.15)';

        tabSignin.style.background = 'transparent';
        tabSignin.style.color = '#4B5F55';
        tabSignin.style.boxShadow = 'none';
      } else {
        tabSignin.style.background = '#fff';
        tabSignin.style.color = '#0A5E39';
        tabSignin.style.boxShadow = '0 1px 3px rgba(10,61,39,0.15)';

        tabJoin.style.background = 'transparent';
        tabJoin.style.color = '#4B5F55';
        tabJoin.style.boxShadow = 'none';
      }
    }

    if (joinSection) show(joinSection, mode === 'join' || !signinSection);
    if (signinSection) show(signinSection, mode !== 'join');
    if (mode === 'join') quickCodeInput?.focus();
    else emailInput?.focus();
  }

  if (tabSignin) tabSignin.onclick = () => setTab('signin');
  if (tabJoin) tabJoin.onclick = () => setTab('join');
  if (toSigninLink) {
    toSigninLink.onclick = (e) => {
      e.preventDefault();
      setTab('signin');
    };
  }

  // Pre-fill parameters if present
  if (pendingCode) {
    if (quickCodeInput) quickCodeInput.value = formatCode(pendingCode);
    setTab('join');
  } else if (mode === 'join') {
    setTab('join');
  }

  if (userName() && quickNameInput) {
    quickNameInput.value = userName();
  }

  togglePassword('password', 'togglePw');

  const fillDemoBtn = $('fillDemoBtn');
  if (fillDemoBtn) {
    fillDemoBtn.onclick = () => {
      if (emailInput) emailInput.value = 'demo@camknock.app';
      if (passwordInput) passwordInput.value = 'password123';
      if (emailErr) emailErr.textContent = '';
      if (pwErr) pwErr.textContent = '';
    };
  }

  /* ------------------------------------------------------------------ */
  /* Sign In Submission                                                 */
  /* ------------------------------------------------------------------ */
  if (signinForm) {
    emailInput?.addEventListener('input', () => {
      emailErr.textContent = '';
      emailInput.classList.remove('has-error');
    });
    passwordInput?.addEventListener('input', () => {
      pwErr.textContent = '';
      passwordInput.classList.remove('has-error');
    });

    signinForm.onsubmit = async (event) => {
      event.preventDefault();
      emailErr.textContent = '';
      pwErr.textContent = '';
      show(authOk, false);

      const email = emailInput.value.trim();
      const password = passwordInput.value;
      let hasError = false;

      if (!/^\S+@\S+\.\S+$/.test(email)) {
        emailErr.textContent = 'Enter a valid email address.';
        emailInput.classList.add('has-error');
        hasError = true;
      }
      if (!password) {
        pwErr.textContent = 'Please enter your password.';
        passwordInput.classList.add('has-error');
        hasError = true;
      }
      if (hasError) return;

      signinBtn.disabled = true;
      show(signinSpinner, true);
      signinLabel.textContent = 'Signing in…';

      try {
        const result = await api('/api/login', 'POST', { email, password });
        saveSession(result, $('remember').checked);
        show(authOk, true);
        setTimeout(() => goNext(), 600);
      } catch (error) {
        pwErr.textContent = error.message;
        passwordInput.classList.add('has-error');
      } finally {
        signinBtn.disabled = false;
        show(signinSpinner, false);
        signinLabel.textContent = 'Sign in';
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Quick Join Submission                                              */
  /* ------------------------------------------------------------------ */
  if (joinForm) {
    quickCodeInput?.addEventListener('input', () => {
      quickCodeErr.textContent = '';
      quickCodeInput.classList.remove('has-error');
    });
    quickNameInput?.addEventListener('input', () => {
      quickNameErr.textContent = '';
      quickNameInput.classList.remove('has-error');
    });

    joinForm.onsubmit = async (event) => {
      event.preventDefault();
      quickCodeErr.textContent = '';
      quickNameErr.textContent = '';
      show(quickJoinOk, false);

      const rawCode = quickCodeInput.value;
      const code = parseRoomCode(rawCode);
      const displayName = quickNameInput.value.trim() || userName() || 'Guest';
      let hasError = false;

      if (!code || code.length < 6) {
        quickCodeErr.textContent = 'Enter a valid room code (at least 6 characters).';
        quickCodeInput.classList.add('has-error');
        hasError = true;
      }
      if (!displayName || displayName.length < 2) {
        quickNameErr.textContent = 'Please enter your name.';
        quickNameInput.classList.add('has-error');
        hasError = true;
      }
      if (hasError) return;

      const camOn = !$('quickCamOff').checked;
      const micOn = !$('quickMicOff').checked;
      setPrefs(camOn, micOn);

      quickJoinBtn.disabled = true;
      show(quickJoinSpinner, true);
      quickJoinLabel.textContent = 'Joining…';

      try {
        if (!token() || (isGuest() && displayName !== userName())) {
          const guest = await api('/api/guest', 'POST', { name: displayName });
          saveSession(guest, false);
        }
        await api('/api/rooms/' + encodeURIComponent(code));
        show(quickJoinOk, true);
        setTimeout(() => {
          location.href = `/call?code=${encodeURIComponent(code)}&cam=${camOn ? '1' : '0'}&mic=${micOn ? '1' : '0'}`;
        }, 500);
      } catch (error) {
        quickCodeErr.textContent = error.message;
        quickCodeInput.classList.add('has-error');
      } finally {
        quickJoinBtn.disabled = false;
        show(quickJoinSpinner, false);
        quickJoinLabel.textContent = 'Join meeting';
      }
    };
  }
})();
