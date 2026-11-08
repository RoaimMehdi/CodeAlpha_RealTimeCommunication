'use strict';

/**
 * MeetRoom — Signup Controller (`/signup`)
 */
(function () {
  const form = $('signupForm');
  const nameInput = $('fullName');
  const emailInput = $('regEmail');
  const passwordInput = $('regPassword');

  const nameErr = $('nameErr');
  const emailErr = $('emailErr');
  const pwErr = $('pwErr');
  const okBox = $('authOk');

  const signupBtn = $('signupBtn');
  const signupSpinner = $('signupSpinner');
  const signupLabel = $('signupLabel');

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
  /* Redirect & Form Submission                                         */
  /* ------------------------------------------------------------------ */
  function goNext() {
    const next = nextPath();
    location.href = next || '/home';
  }

  if (!form) return;

  togglePassword('regPassword', 'togglePw');

  nameInput?.addEventListener('input', () => {
    nameErr.textContent = '';
    nameInput.classList.remove('has-error');
  });
  emailInput?.addEventListener('input', () => {
    emailErr.textContent = '';
    emailInput.classList.remove('has-error');
  });
  passwordInput?.addEventListener('input', () => {
    pwErr.textContent = '';
    passwordInput.classList.remove('has-error');
  });

  form.onsubmit = async (event) => {
    event.preventDefault();
    nameErr.textContent = '';
    emailErr.textContent = '';
    pwErr.textContent = '';
    show(okBox, false);

    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    let hasError = false;

    if (name.length < 2) {
      nameErr.textContent = 'Please enter your full name.';
      nameInput.classList.add('has-error');
      hasError = true;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      emailErr.textContent = 'Enter a valid email address.';
      emailInput.classList.add('has-error');
      hasError = true;
    }
    if (password.length < 6) {
      pwErr.textContent = 'Password must be at least 6 characters.';
      passwordInput.classList.add('has-error');
      hasError = true;
    }
    if (hasError) return;

    signupBtn.disabled = true;
    show(signupSpinner, true);
    signupLabel.textContent = 'Creating account…';

    try {
      const result = await api('/api/register', 'POST', { name, email, password });
      saveSession(result, true);
      show(okBox, true);
      setTimeout(() => goNext(), 700);
    } catch (error) {
      pwErr.textContent = error.message;
      passwordInput.classList.add('has-error');
    } finally {
      signupBtn.disabled = false;
      show(signupSpinner, false);
      signupLabel.textContent = 'Create account';
    }
  };
})();
