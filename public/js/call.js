'use strict';

/**
 * MeetRoom — Real-time Video Mesh Call, Audio Analysis, Chat & Files Controller
 * Exact design & interaction match for MeetRoom Call
 */
(function () {
  const params = new URLSearchParams(location.search);
  const roomCode = parseRoomCode(params.get('code') || params.get('room') || '');

  if (!roomCode) {
    location.replace('/home');
    return;
  }

  // If not logged in, redirect to index with prefilled code
  if (!token()) {
    location.replace('/?code=' + encodeURIComponent(roomCode));
    return;
  }

  /* ------------------------------------------------------------------ */
  /* State & Variables                                                  */
  /* ------------------------------------------------------------------ */

  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  const pcs = new Map();
  const peers = new Map();
  const seenMessages = new Set();
  const sharedFiles = new Map();

  let socket = null;
  let localStream = null;
  let shareStream = null;
  let isHost = false;
  let roomName = '';

  let camOn = params.get('cam') !== '0' && getPrefs().cam;
  let micOn = params.get('mic') !== '0' && getPrefs().mic;
  if (params.has('cam')) camOn = params.get('cam') !== '0';
  if (params.has('mic')) micOn = params.get('mic') !== '0';

  let sharing = false;
  let whiteboardOpen = false;
  let wbTool = 'pen';
  let wbColor = '#22C55E';
  let wbWidth = 5;
  let wbStrokes = [];
  let wbDrawing = false;
  let wbCurrentPoints = [];
  let wbLastX = 0;
  let wbLastY = 0;
  let hand = false;
  let recording = false;
  let recorder = null;
  let recChunks = [];
  let panel = null; // 'chat' | 'people' | 'files' | null
  let unread = 0;
  let started = Date.now();
  let selfSpeaking = false;
  let copyTimer = null;

  const $selfVideo = $('selfVideo');
  const $shareVideo = $('shareVideo');
  const $tiles = $('tiles');
  const $stage = $('stage');

  function leaveTo() {
    return isGuest() ? '/?code=' + encodeURIComponent(roomCode) : '/home';
  }

  function myUserId() {
    try {
      return JSON.parse(atob(token().split('.')[1])).id;
    } catch {
      return null;
    }
  }

  function cleanup() {
    pcs.forEach((pc) => pc.close());
    pcs.clear();
    [localStream, shareStream].forEach((stream) => {
      stream && stream.getTracks().forEach((track) => track.stop());
    });
    if (socket) socket.disconnect();
  }

  function elapsed() {
    const sec = Math.floor((Date.now() - started) / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const h = Math.floor(sec / 3600);
    return (h ? h + ':' : '') + pad(Math.floor(sec / 60) % 60) + ':' + pad(sec % 60);
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function btnBg(on) {
    return on ? '#24362C' : '#1A2820';
  }

  /* ------------------------------------------------------------------ */
  /* Chrome & UI Updater                                                */
  /* ------------------------------------------------------------------ */

  function updateLayout() {
    const totalTiles = peers.size + 1;
    let remoteSharer = null;
    for (const p of peers.values()) {
      if (p.state && p.state.sharing) {
        remoteSharer = p;
        break;
      }
    }
    const anySharing = sharing || !!remoteSharer;

    if (anySharing || whiteboardOpen) {
      $stage.style.gridTemplateColumns = 'minmax(0, 1fr) 260px';
      $tiles.style.gridTemplateColumns = 'minmax(0, 1fr)';
      $tiles.style.gridAutoRows = 'minmax(0, 1fr)';
    } else {
      $stage.style.gridTemplateColumns = 'minmax(0, 1fr)';
      $tiles.style.gridAutoRows = 'minmax(0, 1fr)';

      if (totalTiles <= 1) {
        $tiles.style.gridTemplateColumns = 'minmax(0, 1fr)';
      } else if (totalTiles <= 4) {
        $tiles.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
      } else {
        $tiles.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
      }
    }
  }

  function paintChrome() {
    $('roomTitle').textContent = roomName || (userName() ? `${userName()}’s Room` : 'CamKnock');
    $('roomCode').textContent = 'Room ' + formatCode(roomCode);
    $('elapsed').textContent = elapsed();

    show($('recBadge'), recording);

    // Mic
    $('micLabel').textContent = micOn ? 'Mute' : 'Unmute';
    $('micIconOn').classList.toggle('hidden', !micOn);
    $('micIconOff').classList.toggle('hidden', micOn);
    $('micBg').style.background = micOn ? btnBg(false) : '#DC2626';

    // Camera
    $('camLabel').textContent = camOn ? 'Stop video' : 'Start video';
    $('camIconOn').classList.toggle('hidden', !camOn);
    $('camIconOff').classList.toggle('hidden', camOn);
    $('camBg').style.background = camOn ? btnBg(false) : '#DC2626';

    // Screen Share Stage (Local or Remote)
    let remoteSharer = null;
    for (const p of peers.values()) {
      if (p.state && p.state.sharing) {
        remoteSharer = p;
        break;
      }
    }
    const anySharing = sharing || !!remoteSharer;

    $('shareLabel').textContent = sharing ? 'Stop share' : 'Share';
    $('shareBg').style.background = sharing ? '#16A34A' : btnBg(false);
    show($('shareStage'), anySharing);

    if (sharing) {
      if ($shareVideo.srcObject !== shareStream) {
        $shareVideo.srcObject = shareStream;
      }
      $shareVideo.muted = true;
      $('shareUserLabel').textContent = 'You are sharing your screen';
      show($('stopShareBtn'), true);
    } else if (remoteSharer) {
      const remoteTile = document.getElementById('tile-' + remoteSharer.id);
      const remoteVideo = remoteTile ? remoteTile.querySelector('video') : null;
      const remoteStream = remoteSharer.stream || (remoteVideo ? remoteVideo.srcObject : null);
      if (remoteStream && $shareVideo.srcObject !== remoteStream) {
        $shareVideo.srcObject = remoteStream;
      }
      $shareVideo.muted = false;
      $('shareUserLabel').textContent = `${remoteSharer.name || 'Participant'} is sharing their screen`;
      show($('stopShareBtn'), false);
    } else {
      if ($shareVideo.srcObject) {
        $shareVideo.srcObject = null;
      }
    }

    // Whiteboard
    if ($('boardLabel')) $('boardLabel').textContent = whiteboardOpen ? 'Close' : 'Board';
    if ($('boardBg')) $('boardBg').style.background = whiteboardOpen ? '#0E7A4B' : btnBg(false);
    show($('whiteboardStage'), whiteboardOpen);

    // Hand
    $('handLabel').textContent = hand ? 'Lower' : 'Raise';
    $('handBg').style.background = hand ? '#F59E0B' : btnBg(false);
    $('handBg').style.color = hand ? '#1F1300' : '#fff';
    show($('selfHand'), hand);

    // Recording
    $('recLabel').textContent = recording ? 'Stop rec' : 'Record';
    $('recBg').style.background = recording ? '#7F1D1D' : btnBg(false);

    // Sidebar panels
    show($('side'), !!panel);
    $('chatTab').style.background = panel === 'chat' ? '#24362C' : 'transparent';
    $('peopleTab').style.background = panel === 'people' ? '#24362C' : 'transparent';
    $('filesTab').style.background = panel === 'files' ? '#24362C' : 'transparent';

    show($('chatPane'), panel === 'chat');
    show($('peoplePane'), panel === 'people');
    show($('filesPane'), panel === 'files');

    $('chatBg').style.background = panel === 'chat' ? '#0E7A4B' : btnBg(false);
    $('peopleBg').style.background = panel === 'people' ? '#0E7A4B' : btnBg(false);

    // Badges
    show($('unread'), panel !== 'chat' && unread > 0);
    $('unread').textContent = String(unread);

    const fCount = sharedFiles.size;
    $('filesCount').textContent = String(fCount);

    const count = peers.size + 1;
    $('peopleCount').textContent = String(count);
    $('footNote').textContent = sharing
      ? 'Sharing your screen'
      : hand
        ? 'Your hand is raised'
        : `${count} in this room`;

    // Self info
    $('selfStatus').textContent = micOn ? 'Mic on' : 'Muted';
    show($('selfMute'), !micOn);
    $('selfName').textContent = 'You';
    $('selfAvatar').textContent = initials(userName());
    $('selfInitials').textContent = initials(userName());
    show($('hostBadge'), isHost);

    // Video display
    const showVideo = camOn && localStream && localStream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
    $selfVideo.style.display = showVideo ? 'block' : 'none';
    show($('selfPlaceholder'), !showVideo);
    $('camNote').textContent = showVideo ? '' : camOn ? 'Starting camera…' : 'Your camera is off';

    $('selfTile').classList.toggle('speaking', selfSpeaking && micOn);

    // Host leave buttons
    $('leaveCopy').textContent = isHost
      ? "You're the host. End the room for everyone, or leave and let the others carry on."
      : 'You will leave this room. Others can keep meeting.';
    show($('endAllBtn'), isHost);

    updateLayout();
  }

  function emitState() {
    if (!socket) return;
    socket.emit('peer-state', { mic: micOn, cam: camOn, sharing, hand });
  }

  /* ------------------------------------------------------------------ */
  /* Local Media & Tracks                                               */
  /* ------------------------------------------------------------------ */

  function applyLocalTracks() {
    if (!localStream) return;
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn && !sharing));
    if ($selfVideo.srcObject !== localStream) $selfVideo.srcObject = localStream;
  }

  async function ensureMedia() {
    if (localStream) {
      applyLocalTracks();
      paintChrome();
      return localStream;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      applyLocalTracks();
      watchSpeaking(localStream, (on) => {
        selfSpeaking = on;
        $('selfTile').classList.toggle('speaking', on && micOn);
      });
    } catch (err) {
      console.warn('Media permissions warning:', err.message);
      $('camNote').textContent = 'Camera unavailable — check browser permissions';
    }
    paintChrome();
    return localStream;
  }

  function watchSpeaking(stream, onChange) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let speaking = false;

      const loop = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        const next = avg > 16;
        if (next !== speaking) {
          speaking = next;
          onChange(speaking);
        }
        requestAnimationFrame(loop);
      };
      loop();
    } catch {
      /* AudioContext not allowed or unavailable */
    }
  }

  async function replaceVideo(newTrack) {
    for (const [peerId, pc] of pcs.entries()) {
      let sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (!sender) {
        sender = pc.getSenders().find((s) => s.track === null);
      }
      if (sender) {
        try {
          await sender.replaceTrack(newTrack || null);
        } catch (err) {
          console.warn('replaceTrack error:', err.message);
        }
      } else if (newTrack) {
        const streamToSend = (sharing && shareStream) ? shareStream : localStream;
        pc.addTrack(newTrack, streamToSend || new MediaStream([newTrack]));
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('signal', { to: peerId, data: { sdp: pc.localDescription } });
        } catch (err) {
          console.warn('Offer error on addTrack:', err.message);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Peer Video Tiles                                                   */
  /* ------------------------------------------------------------------ */

  function peerTile(peer) {
    let el = document.getElementById('tile-' + peer.id);
    if (el) return el;

    el = document.createElement('div');
    el.id = 'tile-' + peer.id;
    el.className = 'tile-outline';
    el.style.position = 'relative';
    el.style.minHeight = '0';
    el.style.borderRadius = '18px';
    el.style.overflow = 'hidden';
    el.style.background = '#15221B';

    const colors = ['#A7F3D0', '#D9F99D', '#BBF7D0', '#BAE6FD', '#FED7AA'];
    const avColor = colors[Math.abs(peer.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % colors.length];

    el.innerHTML = `
      <video autoplay playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none"></video>
      <div data-ph style="position:absolute;inset:0;display:grid;place-items:center">
        <div data-av style="width:84px;height:84px;border-radius:50%;background:${avColor};color:#0A3D27;display:grid;place-items:center;font-size:28px;font-weight:800">${initials(peer.name)}</div>
      </div>
      <div style="position:absolute;left:10px;bottom:10px;display:flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;background:rgba(10,18,14,0.72);font-size:12px;font-weight:700">
        <span data-mute class="hidden">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F87171" stroke-width="2.2" stroke-linecap="round"><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.7-1.3"></path><path d="M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 11.2 5.6M12 18v3M3 3l18 18"></path></svg>
        </span>
        <span data-name>${escapeHtml(peer.name || 'Guest')}</span>
        <span data-hand class="hidden" style="padding:2px 6px;border-radius:5px;background:#F59E0B;color:#1F1300;font-size:11px">Hand raised</span>
      </div>
    `;
    $tiles.appendChild(el);
    updateLayout();
    return el;
  }

  function paintPeer(peer) {
    const el = peerTile(peer);
    const state = peer.state || { mic: true, cam: true };

    el.querySelector('[data-name]').textContent = (peer.name || 'Guest') + (state.sharing ? ' (Sharing)' : '');
    el.querySelector('[data-av]').textContent = initials(peer.name);
    el.querySelector('[data-mute]').classList.toggle('hidden', state.mic !== false);
    el.querySelector('[data-hand]').classList.toggle('hidden', !state.hand);

    const video = el.querySelector('video');
    const hasVideo = !!video.srcObject && (state.sharing || state.cam !== false);
    video.style.display = hasVideo ? 'block' : 'none';
    el.querySelector('[data-ph]').style.display = hasVideo ? 'none' : 'grid';

    el.classList.toggle('speaking', !!peer.speaking && state.mic !== false);
  }

  function removePeer(id) {
    const pc = pcs.get(id);
    if (pc) pc.close();
    pcs.delete(id);
    peers.delete(id);
    const el = document.getElementById('tile-' + id);
    if (el) el.remove();
    paintPeople();
    paintChrome();
  }

  /* ------------------------------------------------------------------ */
  /* Sidebar: People List & Host Controls                               */
  /* ------------------------------------------------------------------ */

  function paintPeople() {
    const list = $('peopleList');
    list.innerHTML = '';

    const colors = ['#A7F3D0', '#D9F99D', '#BBF7D0', '#BAE6FD', '#FED7AA'];
    let idx = 0;

    peers.forEach((peer) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '12px';
      row.style.padding = '8px 10px';
      row.style.borderRadius = '10px';

      const state = peer.state || {};
      const statusText = state.mic === false ? 'Muted' : (peer.speaking ? 'Speaking' : 'Listening');
      const avColor = colors[idx % colors.length];
      idx++;

      row.innerHTML = `
        <div style="width:36px;height:36px;border-radius:50%;background:${avColor};color:#0A3D27;display:grid;place-items:center;font-size:13px;font-weight:800;flex:none">
          ${initials(peer.name)}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${escapeHtml(peer.name || 'Guest')}
          </div>
          ${state.hand ? '<span style="font-size:11px;color:#F59E0B">Hand raised</span>' : ''}
        </div>
        <div style="font-size:12px;color:#A7BDB1">${statusText}</div>
        ${
          isHost && peer.userId
            ? `<button type="button" class="remove-user-btn" data-uid="${peer.userId}" data-name="${escapeHtml(peer.name)}" style="color:#F87171;font-size:12px;padding:2px 8px;border:0;border-radius:6px;background:transparent;cursor:pointer">Remove</button>`
            : ''
        }
      `;
      list.appendChild(row);
    });

    list.querySelectorAll('.remove-user-btn').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(`Remove ${btn.dataset.name} from this meeting?`)) return;
        try {
          await api(`/api/rooms/${encodeURIComponent(roomCode)}/participants`, 'POST', {
            userId: btn.dataset.uid,
          });
        } catch (err) {
          alert('Could not remove participant: ' + err.message);
        }
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Sidebar: Chat Messages                                             */
  /* ------------------------------------------------------------------ */

  async function fetchTranslation(text, targetLang) {
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, target: targetLang || 'en' })
      });
      const data = await res.json();
      return data.translated || text;
    } catch (e) {
      return text;
    }
  }

  function addMessage(msg) {
    if (!msg || seenMessages.has(msg.id)) return;
    if (msg.id) seenMessages.add(msg.id);

    const mine = Number(msg.user_id) === Number(myUserId());
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '4px';
    wrap.style.alignItems = mine ? 'flex-end' : 'flex-start';
    wrap.className = 'chat-msg-row';

    const time = msg.created_at
      ? new Date(msg.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : '';

    const contentText = msg.content || msg.text || '';
    const msgId = msg.id || 'm_' + Math.random().toString(36).slice(2);

    wrap.innerHTML = `
      <div style="font-size:11px;font-weight:700;color:#A7BDB1;display:flex;align-items:center;gap:6px">
        <span>${escapeHtml(mine ? 'You' : msg.sender || 'Guest')}</span>
        ${time ? `<span style="font-weight:500;opacity:0.7">${time}</span>` : ''}
      </div>
      <div style="position:relative;max-width:260px;display:flex;flex-direction:column;gap:6px">
        <div style="padding:9px 12px;border-radius:12px;background:${mine ? '#0E7A4B' : '#1F2E26'};font-size:14px;line-height:1.45;color:#fff;word-break:break-word">${escapeHtml(contentText)}</div>
        
        <!-- Translated Box (Hidden by default, shown when translated) -->
        <div id="trans_${msgId}" class="hidden" style="padding:7px 10px;border-radius:10px;background:rgba(74,222,128,0.12);border:1px solid rgba(74,222,128,0.3);font-size:13px;line-height:1.4;color:#4ADE80;word-break:break-word">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:#86EFAC;margin-bottom:2px">Translated:</div>
          <div class="trans-body"></div>
        </div>

        <div style="display:flex;align-items:center;gap:8px;align-self:${mine ? 'flex-end' : 'flex-start'}">
          <button type="button" class="trans-btn" data-text="${escapeHtml(contentText)}" data-target="trans_${msgId}" style="border:0;background:transparent;color:#A7BDB1;font-size:11px;font-weight:600;cursor:pointer;padding:1px 4px;border-radius:4px;display:inline-flex;align-items:center;gap:3px;transition:color 0.15s">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            Translate
          </button>
        </div>
      </div>
    `;

    const transBtn = wrap.querySelector('.trans-btn');
    const transBox = wrap.querySelector(`#trans_${msgId}`);
    const transBody = transBox.querySelector('.trans-body');

    const doTranslate = async () => {
      const selectedLang = ($('chatLangSelect') ? $('chatLangSelect').value : 'en');
      transBtn.textContent = 'Translating…';
      const translated = await fetchTranslation(contentText, selectedLang);
      transBody.textContent = translated;
      show(transBox, true);
      transBtn.textContent = '✓ Translated (' + selectedLang.toUpperCase() + ')';
      $('chatList').scrollTop = $('chatList').scrollHeight;
    };

    transBtn.onclick = doTranslate;

    // Check if Auto-Translate is active on incoming messages
    if (!mine && $('autoTranslateToggle') && $('autoTranslateToggle').checked) {
      setTimeout(doTranslate, 50);
    }

    $('chatList').appendChild(wrap);
    $('chatList').scrollTop = $('chatList').scrollHeight;

    if (panel !== 'chat' && !mine) {
      unread += 1;
      paintChrome();
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ------------------------------------------------------------------ */
  /* Sidebar: Files Manager (Upload & Download)                         */
  /* ------------------------------------------------------------------ */

  function renderFileList() {
    const list = $('filesList');
    const emptyMsg = $('emptyFilesMsg');

    if (sharedFiles.size === 0) {
      show(emptyMsg, true);
      return;
    }
    show(emptyMsg, false);
    list.innerHTML = '';

    sharedFiles.forEach((f) => {
      const card = document.createElement('div');
      card.style.display = 'flex';
      card.style.alignItems = 'center';
      card.style.justifyContent = 'space-between';
      card.style.gap = '10px';
      card.style.padding = '10px 12px';
      card.style.borderRadius = '10px';
      card.style.background = '#15221B';
      card.style.border = '1px solid #1F2E26';

      const sizeStr = formatBytes(f.size);
      const downloadUrl = `/api/files/${f.id}?token=${encodeURIComponent(token())}`;

      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <div style="width:32px;height:32px;border-radius:8px;background:#1F2E26;color:#4ADE80;display:grid;place-items:center;flex:none">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
          </div>
          <div style="display:flex;flex-direction:column;min-width:0;gap:2px">
            <div style="font-size:13px;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
            <div style="font-size:11px;color:#A7BDB1">${sizeStr} · by ${escapeHtml(f.uploader || 'Member')}</div>
          </div>
        </div>
        <a href="${downloadUrl}" download="${escapeHtml(f.name)}" style="height:28px;padding:0 10px;border-radius:6px;background:#0E7A4B;color:#fff;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:4px;flex:none;text-decoration:none">
          Download
        </a>
      `;
      list.appendChild(card);
    });
  }

  function addFile(file) {
    if (!file || !file.id || sharedFiles.has(file.id)) return;
    sharedFiles.set(file.id, file);
    renderFileList();
    paintChrome();
  }

  async function uploadFile(fileObj) {
    if (!fileObj) return;
    if (fileObj.size > 25 * 1024 * 1024) {
      alert('File is larger than the 25 MB limit.');
      return;
    }

    const statusEl = $('uploadStatus');
    const statusText = $('uploadStatusText');
    show(statusEl, true);
    statusText.textContent = `Uploading "${fileObj.name}"…`;

    const formData = new FormData();
    formData.append('file', fileObj);

    try {
      const saved = await api(`/api/rooms/${encodeURIComponent(roomCode)}/files`, 'POST', formData, true);
      addFile(saved);
      show(statusEl, false);
    } catch (err) {
      statusText.textContent = 'Upload failed: ' + err.message;
      setTimeout(() => show(statusEl, false), 3500);
    }
  }

  const dropzone = $('fileDropzone');
  const filePicker = $('filePicker');

  if (dropzone && filePicker) {
    dropzone.onclick = () => filePicker.click();
    filePicker.onchange = () => {
      if (filePicker.files && filePicker.files[0]) {
        uploadFile(filePicker.files[0]);
        filePicker.value = '';
      }
    };
    dropzone.ondragover = (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '#22C55E';
      dropzone.style.background = 'rgba(14,122,75,0.15)';
    };
    dropzone.ondragleave = () => {
      dropzone.style.borderColor = '#24362C';
      dropzone.style.background = 'rgba(14,122,75,0.08)';
    };
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '#24362C';
      dropzone.style.background = 'rgba(14,122,75,0.08)';
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        uploadFile(e.dataTransfer.files[0]);
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* WebRTC Signaling & Peer Connections                                */
  /* ------------------------------------------------------------------ */

  function ensurePc(peer, isInitiator) {
    if (pcs.has(peer.id)) return pcs.get(peer.id);

    const pc = new RTCPeerConnection(ICE);
    pcs.set(peer.id, pc);

    const streamToSend = sharing && shareStream ? shareStream : localStream;
    if (streamToSend) {
      streamToSend.getTracks().forEach((track) => pc.addTrack(track, streamToSend));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('signal', { to: peer.id, data: { candidate: event.candidate } });
      }
    };

    pc.ontrack = (event) => {
      const tile = peerTile(peer);
      const video = tile.querySelector('video');
      let stream = event.streams && event.streams[0];
      if (!stream && event.track) {
        if (!peer.stream) peer.stream = new MediaStream();
        peer.stream.addTrack(event.track);
        stream = peer.stream;
      }
      if (stream) {
        peer.stream = stream;
        if (video.srcObject !== stream) video.srcObject = stream;
        watchSpeaking(stream, (speaking) => {
          peer.speaking = speaking;
          tile.classList.toggle('speaking', speaking && peer.state?.mic !== false);
          paintPeople();
        });
      }
      paintPeer(peer);
      paintChrome();
    };

    if (isInitiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('signal', { to: peer.id, data: { sdp: pc.localDescription } });
        } catch (err) {
          console.warn('Negotiation offer error:', err.message);
        }
      };
    }

    return pc;
  }

  async function onSignal({ from, name, data }) {
    // Server sends: { from: socketId, name: peerName, data: {sdp/candidate} }
    const peer = peers.get(from);
    if (!peer) return;

    const pc = ensurePc(peer, false);

    try {
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const streamToSend = sharing && shareStream ? shareStream : localStream;
          if (streamToSend) {
            streamToSend.getTracks().forEach((track) => {
              if (!pc.getSenders().some((s) => s.track === track)) {
                pc.addTrack(track, streamToSend);
              }
            });
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      console.warn('Signaling error:', err.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Socket.IO Connection & Sync                                        */
  /* ------------------------------------------------------------------ */

  function connectSocket() {
    socket = io({
      auth: { token: token() },
      reconnectionAttempts: 5,
    });

    socket.on('connect', () => {
      console.log('Connected to signaling server');
    });

    socket.on('connect_error', (err) => {
      console.warn('Socket connect error:', err.message);
    });

    socket.on('peer-joined', (peer) => {
      peers.set(peer.id, peer);
      ensurePc(peer, true);
      paintPeer(peer);
      paintPeople();
      paintChrome();
    });

    socket.on('peer-left', (id) => removePeer(id));

    socket.on('peer-state', ({ id, state }) => {
      const peer = peers.get(id);
      if (!peer) return;
      peer.state = state;
      paintPeer(peer);
      paintPeople();
      paintChrome();
    });

    socket.on('signal', onSignal);
    socket.on('message', addMessage);

    socket.on('file', (file) => {
      addFile(file);
    });

    socket.on('stroke', (s) => {
      wbStrokes.push(s);
      if (whiteboardOpen) drawStroke(s);
    });

    socket.on('clear-board', () => {
      wbStrokes = [];
      if (whiteboardOpen) redrawWhiteboard();
    });

    socket.on('room-ended', () => {
      alert('The meeting has been ended by the host.');
      cleanup();
      location.href = leaveTo();
    });

    socket.on('participant-removed', (payload) => {
      if (payload && Number(payload.userId) === Number(myUserId())) {
        alert('You have been removed from this meeting.');
        cleanup();
        location.href = leaveTo();
      }
    });

    socket.emit('join', { code: roomCode }, async (ack) => {
      if (!ack || ack.error) {
        alert(ack && ack.error ? ack.error : 'Could not join this room');
        location.href = leaveTo();
        return;
      }

      isHost = !!ack.isHost;
      roomName = ack.room && ack.room.name;

      (ack.peers || []).forEach((peer) => {
        peers.set(peer.id, peer);
        ensurePc(peer, true);
        paintPeer(peer);
      });

      (ack.messages || []).forEach(addMessage);
      (ack.files || []).forEach(addFile);
      (ack.strokes || []).forEach((raw) => {
        try {
          const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (s && Array.isArray(s.p)) wbStrokes.push(s);
        } catch {}
      });
      if (whiteboardOpen) redrawWhiteboard();

      paintPeople();
      paintChrome();
      emitState();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Toolbar & Buttons Click Handlers                                   */
  /* ------------------------------------------------------------------ */

  $('micBtn').onclick = () => {
    micOn = !micOn;
    applyLocalTracks();
    emitState();
    paintChrome();
  };

  $('camBtn').onclick = async () => {
    camOn = !camOn;
    await ensureMedia();
    applyLocalTracks();
    emitState();
    paintChrome();
  };

  $('shareBtn').onclick = async () => {
    if (sharing) {
      if (shareStream) {
        shareStream.getTracks().forEach((t) => t.stop());
        shareStream = null;
      }
      sharing = false;
      const cam = localStream && localStream.getVideoTracks()[0];
      await replaceVideo(cam || null);
      applyLocalTracks();
      emitState();
      paintChrome();
      return;
    }

    try {
      shareStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      sharing = true;
      if (whiteboardOpen) whiteboardOpen = false;
      $shareVideo.srcObject = shareStream;
      await replaceVideo(shareStream.getVideoTracks()[0]);

      shareStream.getVideoTracks()[0].addEventListener('ended', () => {
        if (sharing) $('shareBtn').click();
      });

      emitState();
      paintChrome();
    } catch {
      sharing = false;
      paintChrome();
    }
  };

  $('stopShareBtn').onclick = () => $('shareBtn').click();

  // Raise Hand
  $('handBtn').onclick = () => {
    hand = !hand;
    emitState();
    paintChrome();
  };

  // Recording
  $('recBtn').onclick = () => {
    if (recording) {
      recording = false;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      paintChrome();
      return;
    }

    const stream = sharing && shareStream ? shareStream : localStream;
    if (!stream || typeof MediaRecorder === 'undefined') {
      alert('Screen or webcam stream is needed to record.');
      return;
    }

    recChunks = [];
    try {
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size) recChunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(recChunks, { type: recorder.mimeType || 'video/webm' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `camknock-${roomCode}-${Date.now()}.webm`;
        a.click();
      };
      recorder.start();
      recording = true;
    } catch (e) {
      alert('Recording failed to start: ' + e.message);
    }
    paintChrome();
  };

  // Sidebar Panel Toggles
  $('chatBtn').onclick = () => {
    panel = panel === 'chat' ? null : 'chat';
    if (panel === 'chat') unread = 0;
    paintChrome();
  };
  $('peopleBtn').onclick = () => {
    panel = panel === 'people' ? null : 'people';
    paintChrome();
  };

  $('chatTab').onclick = () => {
    panel = 'chat';
    unread = 0;
    paintChrome();
  };
  $('peopleTab').onclick = () => {
    panel = 'people';
    paintChrome();
  };
  $('filesTab').onclick = () => {
    panel = 'files';
    paintChrome();
  };

  $('closePanel').onclick = () => {
    panel = null;
    paintChrome();
  };

  // Chat Submission
  $('chatForm').onsubmit = async (e) => {
    e.preventDefault();
    const content = $('draft').value.trim();
    if (!content) return;
    $('draft').value = '';
    if ($('transStatus')) $('transStatus').textContent = '';

    try {
      await api(`/api/rooms/${encodeURIComponent(roomCode)}/messages`, 'POST', { content });
    } catch (error) {
      $('draft').placeholder = error.message;
    }
  };

  // Convert draft message to selected language before sending
  if ($('convertDraftBtn')) {
    $('convertDraftBtn').onclick = async () => {
      const draft = $('draft').value.trim();
      if (!draft) return;
      const targetLang = ($('chatLangSelect') ? $('chatLangSelect').value : 'en');
      if ($('transStatus')) $('transStatus').textContent = 'Translating draft…';
      try {
        const translated = await fetchTranslation(draft, targetLang);
        $('draft').value = translated;
        if ($('transStatus')) $('transStatus').textContent = '✓ Converted to ' + targetLang.toUpperCase();
      } catch (err) {
        if ($('transStatus')) $('transStatus').textContent = 'Translation failed';
      }
    };
  }

  // Whiteboard Board Button Click
  if ($('boardBtn')) {
    $('boardBtn').onclick = () => {
      whiteboardOpen = !whiteboardOpen;
      if (whiteboardOpen && sharing) {
        $('shareBtn').click();
      }
      paintChrome();
      if (whiteboardOpen) {
        setTimeout(resizeCanvas, 50);
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Whiteboard Canvas & Drawing Controller                             */
  /* ------------------------------------------------------------------ */
  const $wbCanvas = $('wbCanvas');
  const $wbCanvasWrap = $('wbCanvasWrap');
  const wbCtx = $wbCanvas ? $wbCanvas.getContext('2d') : null;

  function resizeCanvas() {
    if (!$wbCanvas || !$wbCanvasWrap || !wbCtx) return;
    const rect = $wbCanvasWrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    $wbCanvas.width = rect.width * dpr;
    $wbCanvas.height = rect.height * dpr;
    $wbCanvas.style.width = rect.width + 'px';
    $wbCanvas.style.height = rect.height + 'px';
    wbCtx.setTransform(1, 0, 0, 1, 0, 0);
    wbCtx.scale(dpr, dpr);
    redrawWhiteboard();
  }

  function drawStroke(stroke) {
    if (!wbCtx || !$wbCanvasWrap) return;
    const rect = $wbCanvasWrap.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const pts = stroke.p;
    if (!pts || pts.length < 2) return;

    wbCtx.save();
    wbCtx.lineCap = 'round';
    wbCtx.lineJoin = 'round';
    wbCtx.strokeStyle = stroke.c || '#22C55E';
    wbCtx.lineWidth = Number(stroke.w) || 4;

    wbCtx.beginPath();
    wbCtx.moveTo(pts[0] * w, pts[1] * h);
    if (pts.length === 2) {
      wbCtx.lineTo(pts[0] * w + 0.1, pts[1] * h + 0.1);
    } else {
      for (let i = 2; i < pts.length; i += 2) {
        wbCtx.lineTo(pts[i] * w, pts[i + 1] * h);
      }
    }
    wbCtx.stroke();
    wbCtx.restore();
  }

  function redrawWhiteboard() {
    if (!wbCtx || !$wbCanvasWrap) return;
    const rect = $wbCanvasWrap.getBoundingClientRect();
    wbCtx.clearRect(0, 0, rect.width, rect.height);
    wbStrokes.forEach(drawStroke);
  }

  // Pointer drawing events
  if ($wbCanvas) {
    $wbCanvas.onpointerdown = (e) => {
      e.preventDefault();
      try { $wbCanvas.setPointerCapture(e.pointerId); } catch {}
      const rect = $wbCanvasWrap.getBoundingClientRect();
      wbDrawing = true;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      wbLastX = x;
      wbLastY = y;
      wbCurrentPoints = [
        Math.round((x / rect.width) * 100000) / 100000,
        Math.round((y / rect.height) * 100000) / 100000,
      ];
    };

    $wbCanvas.onpointermove = (e) => {
      if (!wbDrawing || !wbCtx) return;
      e.preventDefault();
      const rect = $wbCanvasWrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      wbCurrentPoints.push(
        Math.round((x / rect.width) * 100000) / 100000,
        Math.round((y / rect.height) * 100000) / 100000
      );

      wbCtx.save();
      wbCtx.lineCap = 'round';
      wbCtx.lineJoin = 'round';
      wbCtx.strokeStyle = wbTool === 'eraser' ? '#0D1812' : wbColor;
      wbCtx.lineWidth = wbTool === 'eraser' ? wbWidth * 3.5 : wbWidth;

      wbCtx.beginPath();
      wbCtx.moveTo(wbLastX, wbLastY);
      wbCtx.lineTo(x, y);
      wbCtx.stroke();
      wbCtx.restore();

      wbLastX = x;
      wbLastY = y;
    };

    const finishDrawing = (e) => {
      if (!wbDrawing) return;
      wbDrawing = false;
      try { $wbCanvas.releasePointerCapture(e.pointerId); } catch {}

      if (wbCurrentPoints.length >= 2) {
        const stroke = {
          p: wbCurrentPoints,
          c: wbTool === 'eraser' ? '#0D1812' : wbColor,
          w: wbTool === 'eraser' ? wbWidth * 3.5 : wbWidth,
        };
        wbStrokes.push(stroke);
        if (socket) {
          socket.emit('stroke', stroke);
        }
      }
      wbCurrentPoints = [];
    };

    $wbCanvas.onpointerup = finishDrawing;
    $wbCanvas.onpointercancel = finishDrawing;
  }

  // Whiteboard Toolbar Controls
  const wbPenBtn = $('wbPenBtn');
  const wbEraserBtn = $('wbEraserBtn');

  function setWbTool(tool) {
    wbTool = tool;
    if (wbPenBtn) {
      wbPenBtn.style.background = tool === 'pen' ? '#0E7A4B' : 'transparent';
      wbPenBtn.style.color = tool === 'pen' ? '#fff' : '#A7BDB1';
    }
    if (wbEraserBtn) {
      wbEraserBtn.style.background = tool === 'eraser' ? '#0E7A4B' : 'transparent';
      wbEraserBtn.style.color = tool === 'eraser' ? '#fff' : '#A7BDB1';
    }
  }

  if (wbPenBtn) wbPenBtn.onclick = () => setWbTool('pen');
  if (wbEraserBtn) wbEraserBtn.onclick = () => setWbTool('eraser');

  document.querySelectorAll('.wb-color').forEach((btn) => {
    btn.onclick = () => {
      wbColor = btn.dataset.color;
      setWbTool('pen');
      document.querySelectorAll('.wb-color').forEach((b) => {
        b.style.border = b === btn ? '2px solid #fff' : '1px solid rgba(255,255,255,0.4)';
        b.style.transform = b === btn ? 'scale(1.2)' : 'scale(1)';
      });
    };
  });

  document.querySelectorAll('.wb-size').forEach((btn) => {
    btn.onclick = () => {
      wbWidth = Number(btn.dataset.size) || 5;
      document.querySelectorAll('.wb-size').forEach((b) => {
        b.style.background = b === btn ? '#24362C' : 'transparent';
        b.style.color = b === btn ? '#fff' : '#A7BDB1';
      });
    };
  });

  const wbClearBtn = $('wbClearBtn');
  if (wbClearBtn) {
    wbClearBtn.onclick = () => {
      if (confirm('Clear the whiteboard for everyone in the room?')) {
        wbStrokes = [];
        redrawWhiteboard();
        if (socket) socket.emit('clear-board');
      }
    };
  }

  const wbSaveBtn = $('wbSaveBtn');
  if (wbSaveBtn && $wbCanvas) {
    wbSaveBtn.onclick = () => {
      const rect = $wbCanvasWrap.getBoundingClientRect();
      const offscreen = document.createElement('canvas');
      offscreen.width = rect.width * 2;
      offscreen.height = rect.height * 2;
      const octx = offscreen.getContext('2d');
      octx.scale(2, 2);
      octx.fillStyle = '#0D1812';
      octx.fillRect(0, 0, rect.width, rect.height);
      wbStrokes.forEach((s) => {
        const pts = s.p;
        if (!pts || pts.length < 2) return;
        octx.save();
        octx.lineCap = 'round';
        octx.lineJoin = 'round';
        octx.strokeStyle = s.c || '#22C55E';
        octx.lineWidth = Number(s.w) || 4;
        octx.beginPath();
        octx.moveTo(pts[0] * rect.width, pts[1] * rect.height);
        for (let i = 2; i < pts.length; i += 2) {
          octx.lineTo(pts[i] * rect.width, pts[i + 1] * rect.height);
        }
        octx.stroke();
        octx.restore();
      });
      const a = document.createElement('a');
      a.href = offscreen.toDataURL('image/png');
      a.download = `camknock-board-${roomCode}-${Date.now()}.png`;
      a.click();
    };
  }

  const wbCloseBtn = $('wbCloseBtn');
  if (wbCloseBtn) {
    wbCloseBtn.onclick = () => {
      whiteboardOpen = false;
      paintChrome();
    };
  }

  if (window.ResizeObserver && $wbCanvasWrap) {
    new ResizeObserver(() => {
      if (whiteboardOpen) resizeCanvas();
    }).observe($wbCanvasWrap);
  }

  // Copy invite
  const copyAction = async () => {
    try {
      const inviteUrl = `${location.origin}/call?code=${encodeURIComponent(roomCode)}`;
      await navigator.clipboard.writeText(inviteUrl);
      $('copyInvite').textContent = 'Link copied';
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        $('copyInvite').textContent = 'Copy invite';
      }, 1800);
    } catch {
      alert(`Meeting Link: ${location.origin}/call?code=${encodeURIComponent(roomCode)}`);
    }
  };
  $('copyInvite').onclick = copyAction;

  // Leave & End Room Modal
  $('leaveBtn').onclick = () => show($('leaveModal'), true);
  $('leaveModal').onclick = (e) => {
    if (e.target === $('leaveModal')) show($('leaveModal'), false);
  };
  $('cancelLeave').onclick = () => show($('leaveModal'), false);

  $('leaveOnly').onclick = () => {
    cleanup();
    location.href = leaveTo();
  };

  $('endAllBtn').onclick = async () => {
    try {
      await api(`/api/rooms/${encodeURIComponent(roomCode)}/end`, 'POST', {});
    } catch {
      /* ignore */
    }
    cleanup();
    location.href = leaveTo();
  };

  /* ------------------------------------------------------------------ */
  /* Initialization                                                     */
  /* ------------------------------------------------------------------ */

  window.addEventListener('beforeunload', cleanup);
  setInterval(() => {
    if ($('elapsed')) $('elapsed').textContent = elapsed();
  }, 1000);

  paintChrome();
  ensureMedia().then(connectSocket);
})();
