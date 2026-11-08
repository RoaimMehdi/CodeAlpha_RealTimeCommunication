'use strict';

(function () {
  if (!requireAuth('/home')) return;

  let cam = getPrefs().cam;
  let mic = getPrefs().mic;
  let currentRoomCode = '';
  let starting = false;

  const $clock = $('clock');
  const $avatar = $('avatar');
  const $camBtn = $('camBtn');
  const $micBtn = $('micBtn');
  const $startBtn = $('startBtn');
  const $homeErr = $('homeErr');
  const $roomLiveBanner = $('roomLiveBanner');
  const $liveRoomCode = $('liveRoomCode');
  const $copyLiveBtn = $('copyLiveBtn');
  const $joinForm = $('joinForm');
  const $joinCode = $('joinCode');
  const $joinBtn = $('joinBtn');
  const $joinErr = $('joinErr');
  const $signOut = $('signOut');

  if ($avatar) $avatar.textContent = initials(userName()) || 'AK';

  function updateClock() {
    if (!$clock) return;
    const now = new Date();
    const clockStr =
      now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
      ' · ' +
      now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    $clock.textContent = clockStr;
  }

  function paintMedia() {
    if ($camBtn) {
      $camBtn.textContent = cam ? 'Video on' : 'Video off';
      $camBtn.style.background = cam ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.22)';
    }
    if ($micBtn) {
      $micBtn.textContent = mic ? 'Mic on' : 'Mic off';
      $micBtn.style.background = mic ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.22)';
    }
    setPrefs(cam, mic);
  }

  function goCall(code) {
    location.href = `/call?mode=start&room=${encodeURIComponent(code)}&code=${encodeURIComponent(code)}&cam=${cam ? '1' : '0'}&mic=${mic ? '1' : '0'}`;
  }

  if ($camBtn) {
    $camBtn.onclick = () => {
      cam = !cam;
      paintMedia();
    };
  }

  if ($micBtn) {
    $micBtn.onclick = () => {
      mic = !mic;
      paintMedia();
    };
  }

  if ($signOut) {
    $signOut.onclick = (e) => {
      e.preventDefault();
      logout();
    };
  }

  if ($startBtn) {
    $startBtn.onclick = async () => {
      if (starting) return;
      starting = true;
      if ($homeErr) $homeErr.textContent = '';
      $startBtn.disabled = true;
      $startBtn.innerHTML = '<span class="spin"></span>Starting…';

      try {
        const room = await api('/api/rooms', 'POST', { name: `${userName() || 'My'} Room` });
        currentRoomCode = room.code;
        if ($liveRoomCode) $liveRoomCode.textContent = formatCode(room.code);
        show($roomLiveBanner, true);
        $startBtn.textContent = 'Start another room';
        $startBtn.disabled = false;
        starting = false;

        // Auto-navigate to call after brief delay, just like design spec
        setTimeout(() => {
          goCall(room.code);
        }, 600);
      } catch (err) {
        if ($homeErr) $homeErr.textContent = err.message;
        $startBtn.textContent = 'Start now';
        $startBtn.disabled = false;
        starting = false;
      }
    };
  }

  if ($copyLiveBtn) {
    $copyLiveBtn.onclick = async () => {
      if (!currentRoomCode) return;
      try {
        await navigator.clipboard.writeText(`${location.origin}/r/${currentRoomCode.replace(/\s/g, '')}`);
        $copyLiveBtn.textContent = 'Copied';
        setTimeout(() => {
          $copyLiveBtn.textContent = 'Copy link';
        }, 2000);
      } catch {
        $copyLiveBtn.textContent = 'Failed';
      }
    };
  }

  if ($joinForm) {
    $joinForm.onsubmit = async (e) => {
      e.preventDefault();
      if ($joinErr) $joinErr.textContent = '';
      const raw = $joinCode ? $joinCode.value : '';
      const code = parseRoomCode(raw);

      if (!code || code.length < 6) {
        if ($joinErr) $joinErr.textContent = 'Enter a valid room code or link.';
        if ($joinCode) $joinCode.classList.add('field-error');
        return;
      }
      if ($joinCode) $joinCode.classList.remove('field-error');

      if ($joinBtn) {
        $joinBtn.disabled = true;
        $joinBtn.textContent = 'Joining…';
      }

      try {
        await api('/api/rooms/' + encodeURIComponent(code));
        location.href = `/call?mode=join&room=${encodeURIComponent(code)}&code=${encodeURIComponent(code)}&cam=${cam ? '1' : '0'}&mic=${mic ? '1' : '0'}`;
      } catch (err) {
        if ($joinErr) $joinErr.textContent = err.message;
        if ($joinBtn) {
          $joinBtn.disabled = false;
          $joinBtn.textContent = 'Join room';
        }
      }
    };
  }

  updateClock();
  setInterval(updateClock, 10000);
  paintMedia();

  // Calendar & Scheduled Meetings logic
  async function loadHomeMeetings() {
    const list = $('homeMeetingsList');
    if (!list) return;
    try {
      const meetings = await api('/api/meetings/scheduled');
      if (!meetings || !meetings.length) {
        list.innerHTML = `
          <div style="text-align:center;padding:24px;border:1.5px dashed #DCE6E0;border-radius:14px;color:#7A9185;font-size:14px">
            No upcoming scheduled meetings yet. Click <strong>Schedule Meeting</strong> to book your next session.
          </div>
        `;
        return;
      }
      list.innerHTML = meetings.map(m => `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:16px 20px;border-radius:14px;background:#F2F8F4;border:1px solid #DCE6E0">
          <div style="display:flex;align-items:center;gap:14px">
            <div style="width:44px;height:44px;border-radius:12px;background:#0E7A4B;color:#fff;display:grid;place-items:center;font-weight:800;font-size:14px">
              ${new Date(m.scheduled_date).getDate() || '📅'}
            </div>
            <div>
              <div style="font-size:16px;font-weight:800;color:#0A3D27">${escapeHtml(m.title)}</div>
              <div style="font-size:13px;color:#4B5F55;margin-top:2px">
                📅 ${m.scheduled_date} at ${m.scheduled_time} · ${m.duration_mins} mins · Room: <strong style="color:#0E7A4B">${m.room_code}</strong>
              </div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <button type="button" onclick="navigator.clipboard.writeText('${location.origin}/r/${m.room_code}').then(()=>alert('Invite link copied: ' + '${location.origin}/r/${m.room_code}'))" style="height:36px;padding:0 12px;border:1px solid #DCE6E0;background:#fff;border-radius:8px;font-size:12px;font-weight:700;color:#0A3D27;cursor:pointer">Copy link</button>
            <a href="/call?mode=join&room=${encodeURIComponent(m.room_code)}&code=${encodeURIComponent(m.room_code)}" style="display:inline-flex;align-items:center;height:36px;padding:0 16px;background:#0E7A4B;color:#fff;border-radius:8px;font-size:13px;font-weight:800;text-decoration:none">Start / Join &rarr;</a>
          </div>
        </div>
      `).join('');
    } catch (e) {
      list.innerHTML = `<div style="text-align:center;padding:16px;color:#DC2626">Could not load scheduled meetings.</div>`;
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  if ($('openSchedBtn')) {
    $('openSchedBtn').onclick = () => {
      show($('homeSchedModal'), true);
      const d = $('hSchedDate');
      if (d && !d.value) d.value = new Date().toISOString().split('T')[0];
    };
  }

  if ($('homeSchedForm')) {
    $('homeSchedForm').onsubmit = async (e) => {
      e.preventDefault();
      const title = $('hSchedTitle').value.trim();
      const scheduled_date = $('hSchedDate').value;
      const scheduled_time = $('hSchedTime').value;
      const duration_mins = $('hSchedDuration').value;

      try {
        await api('/api/meetings/schedule', 'POST', {
          title, scheduled_date, scheduled_time, duration_mins
        });
        show($('homeSchedModal'), false);
        alert('Meeting scheduled successfully!');
        loadHomeMeetings();
      } catch (err) {
        alert('Error scheduling: ' + err.message);
      }
    };
  }

  loadHomeMeetings();
})();