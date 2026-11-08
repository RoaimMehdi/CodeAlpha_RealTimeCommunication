'use strict';

/* ================= DOM and configuration ================= */

const $ = (selector) => document.querySelector(selector);

const LIVEKIT_URL = 'https://your-livekit-domain.livekit.cloud';

let token = localStorage.getItem('token');
let userName = localStorage.getItem('name') || '';
let mode = 'login';

let room = null;
let socket = null;
let camStream = null;
let localStream = null;
let sharing = null;
let roomCode = '';

// LiveKit running state
let livekitRoom = null;
let livekitClient = null;
let livekitParticipants = new Map();
let livekitTrackSubs = new Map();
let livekitSpeakers = [];
let livekitReady = false;
let livekitJoinVersion = 0;
let livekitJoinBusy = false;

let socketVersion = 0;
let strokes = [];
let joining = false;
let joined = false;
let sharingBusy = false;

const fileIds = new Set();
const participantIds = new Set();

// Angular reporter reference; removed
let reporter = null;

function assertReached() { /* minimal guard: no-op in prod */ }
function trackRef() { return null; }

function setLocalReporter(report) {
  reporter = report;
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function showLobbyError(message) {
  setText('#lobbyErr', message);
}

function roomNotice(message) {
  let element = $('#meetingNotice');
  if (!element) {
    element = document.createElement('p');
    element.id = 'meetingNotice';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    const room = $('#room');
    if (room) room.prepend(element);
  }
  if (element) {
    element.textContent = message;
    element.hidden = !message;
  }
}

function showError(selector, message) {
  const element = element = $(selector);
  if (element) {
    element.textContent = message;
    element.hidden = !message;
  }
}

function setBusy(value) {
  joining = value;
  if ($('#createRoom')) {
    $('#createRoom').disabled = value;
    $('#createRoom').textContent = value ? 'Please wait...' : 'Create and join';
  }
  if ($('#joinRoom')) {
    $('#joinRoom').disabled = value;
    $('#joinRoom').textContent = value ? 'Connecting...' : 'Join room';
  }
}

function stopTracks(stream) {
  stream?.getTracks().forEach(track => {
    track.onended = null;
    track.stop();
  });
}

function getLiveKitUrl() {
  // Prefer signed LiveKit origin if present; otherwise fall back to the configured URL.
  const override = localStorage.getItem('lk_url');
  if (override) return override;
  return LIVEKIT_URL;
}

/* ================= API ================= */

async function api(url, method = 'GET', body, form = false) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      signal: controller.signal,
    });

    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      const text = await response.text().catch(() => '');
      throw new Error('Server ne JSON response nahi diya. npm start wale Express URL se kholo.');

    }
    const data = await response.json();
    if (!response.ok) {
      const message = data.error || `Request failed (${response.status}).`;
      if (response.status === 401 && token) {
        logout();
        setText('#authErr', message);
      }
      throw new Error(message);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Server ne 15 seconds mein response nahi diya. Terminal check karo.');
    }
    if (error instanceof TypeError) {
      throw new Error('Server se connection nahi hua. npm start aur app URL check karo.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ================= Authentication ================= */

document.querySelectorAll('#auth .tab').forEach(tab => {
  tab.onclick = (event) => {
    event.preventDefault();
    mode = tab.dataset.mode === 'register' ? 'register' : 'login';
    document.querySelectorAll('#auth .tab').forEach(item => {
      item.classList.toggle('on', item === tab);
    });
    if ($('#nameWrap')) $('#nameWrap').hidden = mode !== 'register';
    setText('#authBtn', mode === 'login' ? 'Log in' : 'Create account');
    setText('#authErr', '');
  };
});

$('#authBtn').onclick = async (event) => {
  event.preventDefault();
  const button = $('#authBtn');
  const name = $('#name')?.value.trim() || '';
  const email = $('#email')?.value.trim() || '';
  const password = $('#password')?.value || '';
  setText('#authErr', '');
  if (mode === 'register' && !name) {
    setText('#authErr', 'Apna name enter karo.');
    return;
  }
  if (!email || !password) {
    setText('#authErr', 'Email aur password enter karo.');
    return;
  }
  button.disabled = true;
  button.textContent = 'Please wait...';
  try {
    const result = await api('/api/' + mode, 'POST', { name, email, password });
    if (!result.token || !result.name) throw new Error('Login response mein token ya name missing hai.');
    token = result.token;
    userName = result.name;
    localStorage.setItem('token', token);
    localStorage.setItem('name', userName);
    if ($('#password')) $('#password').value = '';
    enterLobby();
  } catch (error) {
    setText('#authErr', error.message);
  } finally {
    button.disabled = false;
    button.textContent = mode === 'login' ? 'Log in' : 'Create account';
  }
};

function logout() {
  cleanupRoom();
  localStorage.removeItem('token');
  localStorage.removeItem('name');
  token = null;
  userName = '';
  setBusy(false);
  show('auth');
}

$('#logout').onclick = (event) => {
  event.preventDefault();
  logout();
};

function enterLobby(message = '') {
  setText('#who', userName);
  showLobbyError(message);
  show('lobby');
}

/* ================= Join room / LiveKit flow ================= */

function startLiveKitClient(version) {
  if (livekitClient) return Promise.resolve(livekitClient);

  const lkUrl = getLiveKitUrl();

  return new Promise((resolve, reject) => {
    const container = document.createElement('div');
    container.id = 'livekit-root';
    document.body.appendChild(container);

    const { LiveKitRoom } = window.LiveKit ? { LiveKitRoom: window.LiveKit.Room } : {};
    // The LiveKit JS SDK is fetched from the server; if not present, reject.
    if (!window.LiveKit || !window.LiveKit.Room) {
      // defer: window.LiveKit may load dynamically; keep trying next frame
      const attempt = setInterval(() => {
        if (window.LiveKit && window.LiveKit.Room) {
          clearInterval(attempt);
          startLiveKitClient(version).then(resolve).catch(reject);
        }
      }, 50);
      return;
    }

    const { Room, RemoteParticipant, LocalParticipant, TrackPublication, RoomAudioStats, RoomVideoStats } = window.LiveKit;

    const remoteParticipantMap = new Map();
    const trackPublicationMap = new Map();
    const localStreamRefs = [];
    let isReconnecting = false;

    const room = new Room();
    livekitClient = room;

    room.on('connectionStateChanged', (state) => {
      if (state === 'disconnected') {
        isReconnecting = false;
        if (joined && version === livejoinVersion) {
          roomNotice('LiveKit connection disconnected. Reconnecting...');
          connectLiveKit(version).catch(() => {});
        } else {
          cleanupLiveKit();
        }
      } else if (state === 'reconnecting') {
        isReconnecting = true;
      } else if (state === 'connected' && !isReconnecting) {
        isReconnecting = false;
        if (joined && version === livejoinVersion) {
          roomNotice('');
        }
      }
    });

    room.on('participantConnected', (participant) => {
      remoteParticipantMap.set(participant.identity, participant);
      const p = participant;
      const { displayName, metadata } = p;
      livekitParticipants.set(p.identity, {
        id: p.identity,
        name: displayName || 'Participant',
        isHost: false,
        metadata: metadata || '',
      });
      updateParticipantList();
      onParticipantUpdated();
    });

    room.on('participantDisconnected', (participant) => {
      remoteParticipantMap.delete(participant.identity);
      livekitParticipants.delete(participant.identity);
      updateParticipantList();
      onParticipantUpdated();
    });

    room.on('requestedPublish', (request) => {
      const track = request.track;
      const mode = request.mode;
      if (track.kind === 'audio') {
        // Auto-publish audio unless user disabled mic (belt and braces).
        request.accept();
      } else if (track.kind === 'video') {
        request.accept();
      } else {
        request.reject();
      }
    });

    room.on('trackPublished', (publication, participant) => {
      if (publication.kind === 'video' && publication.source === 'screen') {
        // Screen share: subscribe so remote sees it.
        publication.subscribe(() => {
          const track = publication.track;
          const tileId = 'lk-' + participant.identity + '-screen';
          if (document.getElementById(tileId)) return;
          addLiveKitTile(participant, publication, tileId);
        });
      }
    });

    room.on('trackSubscribed', (publication, participant) => {
      const tileId = 'lk-' + participant.identity + '-' + publication.sid;
      addLiveKitTile(participant, publication, tileId);
    });

    room.on('trackUnsubscribed', (publication) => {
      const el = document.getElementById('lk-' + publication.sid);
      if (el) el.remove();
    });

    room.on('activeSpeakerChanged', (speaker) => {
      livekitSpeakers = speaker ? [speaker] : [];
      onParticipantUpdated();
    });

    room.on('audioLevelChanged', (participant, audioLevel) => {
      // React to audio levels for active speaker and notifications.
      onParticipantUpdated();
    });

    room.connect(lkUrl, token, {
      // livekit options are passed via ws url (token) below
    });

    resolve(room);
  });
}

function connectLiveKit(version) {
  const token = localStorage.getItem('token');
  if (!token) return Promise.reject(new Error('Not logged in.'));
  const code = roomCode;
  if (!code) return Promise.reject(new Error('No room code.'));
  return new Promise((resolve, reject) => {
    // fetch LiveKit token from backend
    api('/api/livekit/token?code=' + encodeURIComponent(code), 'GET', null)
      .then((data) => {
        const lkUrl = getLiveKitUrl();
        const { LiveKitRoom } = window.LiveKit ? { LiveKitRoom: window.LiveKit.Room } : {};
        if (!window.LiveKit || !window.LiveKit.Room) {
          // defer: LiveKit SDK may load lazily
          const attempt = setInterval(() => {
            if (window.LiveKit && window.LiveKit.Room) {
              clearInterval(attempt);
              connectLiveKit(version).then(resolve).catch(reject);
            }
          }, 50);
          return;
        }
        const { Room, RemoteParticipant, LocalParticipant, TrackPublication, RoomAudioStats, RoomVideoStats } = window.LiveKit;
        const remoteParticipantMap = new Map();
        const trackPublicationMap = new Map();
        let isReconnecting = false;

        const room = new Room();
        livekitClient = room;
        livekitJoinVersion = version;
        livekitReady = false;
        livekitSpeakers = [];

        room.on('connectionStateChanged', (state) => {
          if (state === 'disconnected') {
            isReconnecting = false;
            if (joined && version === livejoinVersion) {
              roomNotice('LiveKit connection disconnected. Reconnecting...');
              connectLiveKit(version).catch(() => {});
            } else {
              cleanupLiveKit();
            }
          } else if (state === 'reconnecting') {
            isReconnecting = true;
          } else if (state === 'connected' && !isReconnecting && version === livejoinVersion) {
            isReconnecting = false;
            roomNotice('');
            livekitReady = true;
            resolve(room);
          }
        });

        room.on('participantConnected', (participant) => {
          const displayName = participant.identity || participant.name || 'Participant';
          const metadata = participant.metadata || '';
          const isHost = metadata && metadata.includes('isHost=true');
          remoteParticipantMap.set(participant.identity, participant);
          livekitParticipants.set(participant.identity, {
            id: participant.identity,
            name: displayName,
            isHost,
            metadata,
          });
          // Subscribe to all existing tracks for late-joining participant
          participant.tracks.forEach((pub, sid) => {
            if (pub.kind === 'video') {
              pub.subscribe(() => {
                const tileId = 'lk-' + participant.identity + '-' + sid;
                addLiveKitTile(participant, pub, tileId);
              });
            } else {
              pub.subscribe(() => {
                const tileId = 'lk-' + participant.identity + '-' + sid;
                addLiveKitTile(participant, pub, tileId);
              });
            }
          });
          onParticipantUpdated();
        });

        room.on('participantDisconnected', (participant) => {
          remoteParticipantMap.delete(participant.identity);
          livekitParticipants.delete(participant.identity);
          updateParticipantList();
          onParticipantUpdated();
        });

        room.on('trackPublished', (publication, participant) => {
          // Subscribe to screen shares published by others
          if (publication.kind === 'video' && publication.source === 'screen') {
            publication.subscribe(() => {
              const tileId = 'lk-' + participant.identity + '-screen';
              addLiveKitTile(participant, publication, tileId);
            });
          }
        });

        room.on('trackSubscribed', (publication, participant) => {
          const tileId = 'lk-' + participant.identity + '-' + publication.sid;
          addLiveKitTile(participant, publication, tileId);
          // Set active speaker on new track
          updateActiveSpeakers();
        });

        room.on('trackUnsubscribed', (publication) => {
          const el = document.getElementById('lk-' + publication.sid);
          if (el) el.remove();
        });

        room.on('activeSpeakerChanged', (speaker) => {
          livekitSpeakers = speaker ? [speaker] : [];
          updateActiveSpeakers();
        });

        room.on('audioLevelChanged', (participant, audioLevel) => {
          // audioLevel 0..1
          onParticipantUpdated();
        });

        room.connect(lkUrl, data.token, {});
      })
      .catch(reject);
  });
}

function addLiveKitTile(participant, publication, tileId) {
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.id = tileId;
  video.classList.add('lk-track');
  const container = document.getElementById('grid');
  if (!container) return;
  const tile = document.createElement('div');
  tile.className = 'tile lk-tile';
  tile.id = 'lk-' + participant.identity;
  const label = document.createElement('span');
  label.textContent = participant.name || 'Participant';
  tile.append(video, label);
  container.append(tile);

  // Subscribe track
  publication.subscribe((videoTrack) => {
    if (videoTrack && videoTrack.track) {
      video.srcObject = videoTrack.track;
      video.play().catch(() => {});
    }
  });

  // Handle screen share variant within tile
  if (publication.source === 'screen') {
    tile.classList.add('screen');
  }

  // Update active speaker / mute states
  updateParticipantList();
}

function updateParticipantList() {
  // Rearrange DOM tiles so active speaker is first, others follow
  const grid = $('#grid');
  if (!grid) return;
  const tiles = Array.from(grid.querySelectorAll('.tile'));
  const speakers = tiles.filter(t => t.classList.contains('lk-speaker'));
  const others = tiles.filter(t => !t.classList.contains('lk-speaker'));
  grid.innerHTML = '';
  speakers.forEach(t => grid.append(t));
  others.forEach(t => grid.append(t));
}

function updateActiveSpeakers() {
  const grid = $('#grid');
  if (!grid) return;
  const tiles = Array.from(grid.querySelectorAll('.tile'));
  tiles.forEach(t => t.classList.remove('lk-speaker'));
  livekitSpeakers.forEach(s => {
    const id = s?.identity;
    const t = grid.querySelector('#lk-' + id);
    if (t) t.classList.add('lk-speaker');
  });
}

function ctl() {
  // Control dock updates are handled in updateMediaButtons / handleLiveKitState
}

function handleLiveKitState() {
  if (livekitReady && roomCode && joined) {
    const count = livekitParticipants.size + 1;
    setText('#count', count + ' in this room');
  }
}

function addTile(id, name, stream, mine) {
  // Compatibility: keep existing WebRTC-style tile creation behind LiveKit
  // For LiveKit clients, tiles are added by addLiveKitTile; this is a fallback.
  let tile = document.getElementById('t-' + id);
  if (tile) return tile;
  tile = document.createElement('div');
  tile.id = 't-' + id;
  tile.className = 'tile' + (mine ? ' me' : '');
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = !!mine;
  if (stream) video.srcObject = stream;
  const label = document.createElement('span');
  label.textContent = name;
  tile.append(video, label);
  $('#grid').append(tile);
  tile.addEventListener('click', () => { video.play().catch(() => {}); });
  return tile;
}

function refreshLocalPreview() {
  const tile = $('#t-me');
  if (!tile) return;
  tile.classList.toggle('screen', !!sharing);
  const camera = camStream?.getVideoTracks()[0];
  tile.classList.toggle('camera-off', !sharing && (!camera || !camera.enabled));
  const video = tile.querySelector('video');
  video.srcObject = sharing || camStream;
  video.play().catch(() => {});
}

function updateCount() {
  const total = joined && livekitParticipants.size ? livekitParticipants.size + 1 : (joined ? participantIds.size + 1 : 0);
  setText('#count', total + ' in this room');
}

function updateMediaButtons() {
  const audio = camStream?.getAudioTracks()[0];
  const video = camStream?.getVideoTracks()[0];
  const mic = $('#mic');
  const cam = $('#cam');
  if (mic) {
    mic.textContent = audio ? (audio.enabled ? 'Mute' : 'Unmute') : 'No microphone';
    mic.classList.toggle('off', !audio?.enabled);
    mic.setAttribute('aria-pressed', String(!!audio?.enabled));
  }
  if (cam) {
    cam.textContent = video ? (video.enabled ? 'Camera off' : 'Camera on') : 'No camera';
    cam.classList.toggle('off', !video?.enabled);
    cam.setAttribute('aria-pressed', String(!!video?.enabled));
  }
  setText('#share', sharing ? 'Stop sharing' : 'Share screen');
  $('#share')?.classList.toggle('off', !!sharing);
}

/* ================= Meeting controls ================= */

$('#mic').onclick = (event) => {
  event.preventDefault();
  const track = camStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  updateMediaButtons();
};

$('#cam').onclick = (event) => {
  event.preventDefault();
  const track = camStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  updateMediaButtons();
  refreshLocalPreview();
};

$('#share').onclick = async (event) => {
  event.preventDefault();
  if (!joined || sharingBusy) return;
  if (sharing) {
    await stopShare();
    return;
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  sharing = stream;
  const track = stream.getVideoTracks()[0];
  track.onended = () => { stopShare().catch(console.error); };
  await replaceOutgoingTrack('video', track);
  refreshLocalPreview();
  updateMediaButtons();
};

async function stopShare() {
  if (!sharing) return;
  const stream = sharing;
  sharing = null;
  stopTracks(stream);
  await replaceOutgoingTrack('video', camStream?.getVideoTracks()[0] || null);
  refreshLocalPreview();
  updateMediaButtons();
}

$('#toggleSide').onclick = (event) => {
  event.preventDefault();
  const side = $('#side');
  side.hidden = !side.hidden;
  if (side.hidden) side.style.setProperty('display', 'none', 'important');
  else side.style.removeProperty('display');
  sizeCanvas();
};

$('#copyCode').onclick = async (event) => {
  event.preventDefault();
  try {
    await navigator.clipboard.writeText(roomCode);
    setText('#copyCode', 'Copied: ' + roomCode);
  } catch {
    roomNotice('Room code copy kar lo: ' + roomCode);
  }
};

document.querySelectorAll('#side .tab').forEach(tab => {
  tab.onclick = (event) => {
    event.preventDefault();
    document.querySelectorAll('#side .tab').forEach(item => {
      item.classList.toggle('on', item === tab);
    });
    ['board', 'files'].forEach(name => {
      const pane = document.getElementById(name);
      if (!pane) return;
      pane.hidden = tab.dataset.pane !== name;
      if (pane.hidden) pane.style.setProperty('display', 'none', 'important');
      else pane.style.removeProperty('display');
    });
    sizeCanvas();
  };
});

function cleanupRoom() {
  socketVersion++;
  joined = false;
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  Object.values(pcs || {}).forEach(({ pc }) => {
    pc.onnegotiationneeded = null;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.close();
  });
  pcs = {};
  stopTracks(sharing);
  stopTracks(camStream);
  sharing = null;
  camStream = null;
  localStream = null;
  sharingBusy = false;
  participantIds.clear();
  fileIds.clear();
  strokes = [];
  drawing = null;
  roomCode = '';
  livekitParticipants.clear();
  livekitTrackSubs.clear();
  cleanupLiveKit();
  $('#grid')?.replaceChildren();
  $('#fileList')?.replaceChildren();
  if ($('#side')) {
    $('#side').hidden = true;
    $('#side').style.setProperty('display', 'none', 'important');
  }
  roomNotice('');
  updateCount();
}

function cleanupLiveKit() {
  if (livekitClient) {
    try { livekitClient.close(); } catch (e) { /* ignore */ }
    livekitClient = null;
  }
  // remove LiveKit tiles
  document.querySelectorAll('#grid .lk-tile').forEach(el => el.remove());
  livekitReady = false;
  livekitSpeakers = [];
  livekitJoinVersion = 0;
}

function leave(message = '') {
  cleanupRoom();
  setBusy(false);
  if (token) enterLobby(message);
  else show('auth');
}

$('#leave').onclick = (event) => {
  event.preventDefault();
  leave();
};

window.addEventListener('pagehide', cleanupRoom);

/* ================= Whiteboard ================= */

const cv = $('#canvas');
const ctx = cv.getContext('2d');
let drawing = null;
let erasing = false;

cv.style.touchAction = 'none';

function normalizeStroke(value) {
  let stroke = value?.data || value;
  if (typeof stroke === 'string') {
    try { stroke = JSON.parse(stroke); } catch { return null; }
  }
  if (!stroke || !Array.isArray(stroke.p)) return null;
  const points = stroke.p.filter(point =>
    Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (!points.length) return null;
  return {
    p: points.map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]),
    c: /^#[0-9a-f]{6}$/i.test(stroke.c) ? stroke.c : '#000000',
    w: Math.max(1, Math.min(64, Number(stroke.w) || 3)),
  };
}

function sizeCanvas() {
  requestAnimationFrame(() => {
    const rect = cv.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = window.devicePixelRatio || 1;
    cv.width = Math.round(rect.width * ratio);
    cv.height = Math.round(rect.height * ratio);
    redraw();
  });
}

function drawStroke(stroke) {
  if (!stroke?.p?.length) return;
  const ratio = window.devicePixelRatio || 1;
  ctx.strokeStyle = stroke.c;
  ctx.lineWidth = stroke.w * ratio;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(stroke.p[0][0] * cv.width, stroke.p[0][1] * cv.height);
  stroke.p.slice(1).forEach(([x, y]) => { ctx.lineTo(x * cv.width, y * cv.height); });
  if (stroke.p.length === 1) {
    ctx.lineTo(stroke.p[0][0] * cv.width + 0.1, stroke.p[0][1] * cv.height);
  }
  ctx.stroke();
}

function redraw() {
  ctx.clearRect(0, 0, cv.width, cv.height);
  strokes.forEach(drawStroke);
  if (drawing) drawStroke(drawing);
}

function pointerPoint(event) {
  const rect = cv.getBoundingClientRect();
  return [
    Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  ];
}

cv.onpointerdown = (event) => {
  if (!joined) return;
  if (event.button !== 0) return;
  event.preventDefault();
  cv.setPointerCapture(event.pointerId);
  drawing = { p: [pointerPoint(event)], c: erasing ? '#ffffff' : $('#color').value, w: erasing ? 24 : Number($('#size').value) || 3 };
  redraw();
};

cv.onpointermove = (event) => {
  if (!drawing) return;
  if (drawing.p.length >= 4000) return;
  drawing.p.push(pointerPoint(event));
  redraw();
};

function finishDrawing(event) {
  if (!drawing) return;
  const stroke = drawing;
  drawing = null;
  if (event && cv.hasPointerCapture(event.pointerId)) {
    cv.releasePointerCapture(event.pointerId);
  }
  if (!joined) {
    redraw();
    return;
  }
  strokes.push(stroke);
  socket.emit('stroke', stroke);
  redraw();
}

cv.onpointerup = finishDrawing;
cv.onpointercancel = () => { drawing = null; redraw(); };

$('#eraser').onclick = (event) => {
  event.preventDefault();
  erasing = !erasing;
  event.currentTarget.classList.toggle('off', erasing);
  event.currentTarget.textContent = erasing ? 'Pen' : 'Eraser';
};

$('#clearBoard').onclick = (event) => {
  event.preventDefault();
  if (!joined) return;
  if (!window.confirm('Poora whiteboard clear karna hai?')) return;
  drawing = null;
  strokes = [];
  redraw();
  socket.emit('clear-board');
};

window.addEventListener('resize', sizeCanvas);

/* ================= File sharing ================= */

function formatSize(size) {
  const bytes = Number(size) || 0;
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.ceil(bytes / 1024) + ' KB';
}

function addFile(file) {
  if (!file || file.id == null) return;
  const key = String(file.id);
  if (fileIds.has(key)) return;
  fileIds.add(key);
  const item = document.createElement('li');
  const info = document.createElement('div');
  const title = document.createElement('span');
  const detail = document.createElement('small');
  const button = document.createElement('button');
  title.textContent = file.name || 'File';
  detail.textContent = formatSize(file.size) + ' from ' + (file.uploader || 'Participant');
  info.append(title, detail);
  button.type = 'button';
  button.className = 'btn small';
  button.textContent = 'Download';
  button.onclick = async () => {
    button.disabled = true;
    setText('#fileErr', '');
    try {
      const response = await fetch('/api/files/' + encodeURIComponent(file.id), {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Download failed (' + response.status + ').');
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = file.name || 'download';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setText('#fileErr', error.message);
    } finally {
      button.disabled = false;
    }
  };
  item.append(info, button);
  $('#fileList').append(item);
}

$('#fileInput').onchange = async (event) => {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) return;
  setText('#fileErr', '');
  if (!joined) {
    setText('#fileErr', 'File upload karne se pehle room join karo.');
    input.value = '';
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    setText('#fileErr', 'Maximum file size 25 MB hai.');
    input.value = '';
    return;
  }
  const form = new FormData();
  form.append('file', file);
  input.disabled = true;
  try {
    const uploaded = await api('/api/rooms/' + encodeURIComponent(roomCode) + '/files', 'POST', form, true);
    addFile(uploaded);
  } catch (error) {
    setText('#fileErr', error.message);
  } finally {
    input.disabled = false;
    input.value = '';
  }
};

/* ================= Start ================= */

setBusy(false);
if (token) {
  enterLobby();
} else {
  show('auth');
}
