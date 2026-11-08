'use strict';

/**
 * MeetRoom — Join Page Controller (`/join`)
 * Works with new join.html (inline styles, no app.css dependency)
 */
(function () {
  /* ------------------------------------------------------------------ */
  /* Slideshow Controller                                               */
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
  /* Health Check                                                       */
  /* ------------------------------------------------------------------ */
  (async () => {
    const label = $('healthLabel');
    if (!label) return;
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (response.ok) {
        label.textContent = 'All systems operational';
      } else {
        label.textContent = 'Server unavailable';
        label.parentElement.style.color = '#B42318';
      }
    } catch {
      label.textContent = 'Server unreachable';
      label.parentElement.style.color = '#B42318';
    }
  })();

  /* ------------------------------------------------------------------ */
  /* Form Logic                                                         */
  /* ------------------------------------------------------------------ */
  const form = $('joinForm');
  const meetingIdInput = $('meetingId');
  const displayNameInput = $('displayName');
  const meetingIdErr = $('meetingIdErr');
  const displayNameErr = $('displayNameErr');
  const joinOk = $('joinOk');
  const joinBtn = $('joinBtn');
  const joinSpinner = $('joinSpinner');
  const joinLabel = $('joinLabel');

  if (!form) return;

  // Prefill from URL params
  const params = new URLSearchParams(location.search);
  const presetCode = parseRoomCode(params.get('code') || params.get('room') || '');
  if (presetCode && meetingIdInput) meetingIdInput.value = formatCode(presetCode);
  if (userName() && displayNameInput) displayNameInput.value = userName();

  // Clear errors on input
  meetingIdInput?.addEventListener('input', () => {
    meetingIdErr.textContent = '';
    meetingIdInput.classList.remove('has-error');
  });
  displayNameInput?.addEventListener('input', () => {
    displayNameErr.textContent = '';
    displayNameInput.classList.remove('has-error');
  });

  form.onsubmit = async (event) => {
    event.preventDefault();
    meetingIdErr.textContent = '';
    displayNameErr.textContent = '';
    show(joinOk, false);

    const code = parseRoomCode(meetingIdInput ? meetingIdInput.value : '');
    const displayName = displayNameInput ? displayNameInput.value.trim() : '';
    let hasError = false;

    if (!code || code.length < 6) {
      if (meetingIdErr) meetingIdErr.textContent = 'Enter a valid meeting ID or invite link.';
      if (meetingIdInput) meetingIdInput.classList.add('has-error');
      hasError = true;
    }
    if (!displayName || displayName.length < 2) {
      if (displayNameErr) displayNameErr.textContent = 'Enter the name others will see.';
      if (displayNameInput) displayNameInput.classList.add('has-error');
      hasError = true;
    }
    if (hasError) return;

    const camOn = !$('camOff').checked;
    const micOn = !$('micOff').checked;
    setPrefs(camOn, micOn);

    // Show spinner
    joinBtn.disabled = true;
    show(joinSpinner, true);
    joinLabel.textContent = 'Joining…';

    try {
      // Create guest session if needed (or name changed)
      if (!token() || (isGuest() && displayName !== userName())) {
        const guest = await api('/api/guest', 'POST', { name: displayName });
        saveSession(guest, false);
      }
      // Verify room exists
      await api('/api/rooms/' + encodeURIComponent(code));
      show(joinOk, true);
      setTimeout(() => {
        location.href = `/call?code=${encodeURIComponent(code)}&cam=${camOn ? '1' : '0'}&mic=${micOn ? '1' : '0'}`;
      }, 500);
    } catch (error) {
      if (meetingIdErr) meetingIdErr.textContent = error.message;
      if (meetingIdInput) meetingIdInput.classList.add('has-error');
    } finally {
      joinBtn.disabled = false;
      show(joinSpinner, false);
      joinLabel.textContent = 'Join meeting';
    }
  };
})();
