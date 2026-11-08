// CamKnock Admin Operations Portal Controller
// Full Real-Time Single-Page Application with Hash Routing (#overview, #live, #users, #meetings, #calendar, #support, #controls)
// Real MySQL connectivity, strict role=admin verification, and audit logging.

(function () {
  'use strict';

  let currentAdmin = null;
  let adminToken = null;
  let adminSocket = null;
  let calCurrentYear = new Date().getFullYear();
  let calCurrentMonth = new Date().getMonth(); // 0..11
  let calendarMeetingsCache = [];
  let selectedCalDate = null;
  let activeTicketId = null;
  let searchDebounceTimer = null;

  // ── Clock ───────────────────────────────────────────────────────
  setInterval(() => {
    const el = document.getElementById('liveClock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }, 1000);

  // ── Toast Notification System ──────────────────────────────────
  function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast-item ' + (type === 'error' ? 'error' : '');
    const icon = type === 'error' ? '⚠️' : '✅';
    toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      toast.style.transition = 'opacity 0.25s, transform 0.25s';
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }

  // ── Confirmation Dialog ────────────────────────────────────────
  let confirmCallback = null;
  window.confirmAction = function ({ title, message, onConfirm }) {
    document.getElementById('confirmTitle').textContent = title || 'Confirm Action';
    document.getElementById('confirmMsg').textContent = message || 'Are you sure you want to proceed?';
    confirmCallback = onConfirm;
    document.getElementById('confirmModal').classList.remove('hidden');
  };

  window.closeConfirmModal = function () {
    confirmCallback = null;
    document.getElementById('confirmModal').classList.add('hidden');
  };

  document.getElementById('confirmOkBtn')?.addEventListener('click', () => {
    if (typeof confirmCallback === 'function') confirmCallback();
    closeConfirmModal();
  });

  // ── Auth & Headers ─────────────────────────────────────────────
  function getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (adminToken || localStorage.getItem('token') || '')
    };
  }

  async function verifyAdminAccess() {
    adminToken = localStorage.getItem('token');

    // Dev helper fallback: if no token exists in local storage, obtain dev session
    if (!adminToken) {
      try {
        const sessRes = await fetch('/api/admin/session');
        if (sessRes.ok) {
          const sessData = await sessRes.json();
          adminToken = sessData.token;
          localStorage.setItem('token', adminToken);
        }
      } catch (e) {
        console.warn('Dev auto session error:', e);
      }
    }

    if (!adminToken) {
      window.location.href = '/';
      return false;
    }

    try {
      const res = await fetch('/api/admin/me', { headers: getHeaders() });
      if (!res.ok) {
        // Not admin or suspended -> redirect to public site per requirements
        localStorage.removeItem('token');
        window.location.href = '/';
        return false;
      }
      currentAdmin = await res.json();

      // Update avatar
      const av = document.getElementById('adminAvatar');
      if (av && currentAdmin.name) {
        av.textContent = currentAdmin.name.slice(0, 2).toUpperCase();
      }
      return true;
    } catch (e) {
      console.error('Admin verification error:', e);
      window.location.href = '/';
      return false;
    }
  }

  window.adminSignOut = function () {
    localStorage.removeItem('token');
    window.location.href = '/';
  };

  // ── Hash Routing ───────────────────────────────────────────────
  const ROUTES = ['overview', 'live', 'users', 'meetings', 'calendar', 'support', 'controls'];
  const ROUTE_TITLES = {
    overview: 'Executive Overview',
    live: 'Live WebRTC Calls Monitor',
    users: 'Hosts & Users Directory',
    meetings: 'Meetings & Attendee Logs',
    calendar: 'Scheduled Calendar',
    support: 'Support Desk & Helpline',
    controls: 'Website Controls & Settings'
  };

  function handleHashChange() {
    const rawHash = (window.location.hash || '').replace('#', '').trim().toLowerCase();
    const route = ROUTES.includes(rawHash) ? rawHash : 'overview';

    if (window.location.hash !== '#' + route) {
      window.location.hash = '#' + route;
      return;
    }

    // 1. Update navigation active state
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-hash') === route);
    });

    // 2. Switch page view
    document.querySelectorAll('.page-section').forEach(sec => {
      sec.classList.remove('active');
    });
    const target = document.getElementById('page-' + route);
    if (target) target.classList.add('active');

    // 3. Update Title
    const titleEl = document.getElementById('portalHeaderTitle');
    if (titleEl && ROUTE_TITLES[route]) {
      titleEl.textContent = ROUTE_TITLES[route];
    }

    // 4. Trigger Page Data Fetch
    switch (route) {
      case 'overview': loadOverviewData(); break;
      case 'live': loadLiveCalls(); break;
      case 'users': loadUsers(); break;
      case 'meetings': loadMeetings(); break;
      case 'calendar': loadCalendarMonth(); break;
      case 'support': loadTickets(); break;
      case 'controls': loadControls(); break;
    }
  }

  // ── 1. Overview Page (#overview) ───────────────────────────────
  window.loadOverviewData = async function () {
    const ids = ['statUsers', 'statHosts', 'statMeetings', 'statJoins', 'statLive', 'statTickets'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<span class="spinner"></span>';
    });

    try {
      const res = await fetch('/api/admin/overview', { headers: getHeaders() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const m = data.metrics || {};

      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val !== undefined && val !== null ? Number(val).toLocaleString() : 0;
      };
      setVal('statUsers', m.total_users);
      setVal('statHosts', m.active_hosts);
      setVal('statMeetings', m.total_meetings);
      setVal('statJoins', m.participants_joined);
      setVal('statLive', m.live_calls);
      setVal('statTickets', m.support_tickets);

      // Update badges
      updateLiveBadge(m.live_calls || 0);
      updateSupportBadge(m.open_tickets || 0);

      // Render Hosts Table
      renderOverviewHosts(Array.isArray(data.hosts) ? data.hosts : []);
    } catch (err) {
      console.error('Overview error:', err);
      ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = 'ERR';
      });
      const tbody = document.getElementById('overviewHostsBody');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:#FCA5A5">
          Failed to load telemetry. <button onclick="loadOverviewData()" class="portal-btn secondary" style="margin-left:8px;padding:3px 8px;font-size:11px">Retry</button>
        </td></tr>`;
      }
    }
  };

  function renderOverviewHosts(hosts) {
    const tbody = document.getElementById('overviewHostsBody');
    if (!tbody) return;
    if (!hosts.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:28px;color:#8CA395">No host activity recorded yet in MySQL.</td></tr>';
      return;
    }
    tbody.innerHTML = hosts.map(h => {
      const last = h.last_meeting_date ? new Date(h.last_meeting_date).toLocaleDateString() : (h.last_meeting_at ? new Date(h.last_meeting_at).toLocaleDateString() : '—');
      const isSuspended = h.status === 'suspended';
      return `<tr class="fade-in">
        <td>
          <div style="font-weight:700;color:#fff">${escapeHtml(h.name || 'Anonymous')}</div>
        </td>
        <td style="color:#A7BDB1">${escapeHtml(h.email || '')}</td>
        <td>
          <span class="role-badge role-${h.role || 'user'}">${(h.role || 'user').toUpperCase()}</span>
        </td>
        <td>
          <span style="font-size:11px;font-weight:700;color:${isSuspended ? '#FCA5A5' : '#4ADE80'}">
            ${(h.status || 'active').toUpperCase()}
          </span>
        </td>
        <td class="mono" style="font-weight:700;color:#fff">${h.rooms_created || 0}</td>
        <td>
          <span class="mono" style="color:#4ADE80;font-weight:800">${h.participants_added || 0}</span>
          <span style="font-size:11px;color:#8CA395">joined</span>
        </td>
        <td style="color:#8CA395">${last}</td>
      </tr>`;
    }).join('');
  }

  // ── 2. Live Calls Monitor (#live) ──────────────────────────────
  window.loadLiveCalls = async function () {
    const tbody = document.getElementById('liveCallsBody');
    const scanStatus = document.getElementById('liveScanStatus');
    if (scanStatus) scanStatus.textContent = 'Scanning...';

    try {
      const res = await fetch('/api/admin/live', { headers: getHeaders() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const calls = await res.json();
      updateLiveBadge(calls.length);
      if (scanStatus) scanStatus.textContent = 'Last scanned: ' + new Date().toLocaleTimeString();

      if (!calls.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:#8CA395">No live WebRTC calls currently running. When hosts start sessions, they appear here in real-time.</td></tr>';
        return;
      }

      tbody.innerHTML = calls.map(c => {
        const start = c.start_time ? new Date(c.start_time).toLocaleTimeString() : 'Just now';
        return `<tr class="fade-in">
          <td><span class="code-chip">${escapeHtml(c.code)}</span></td>
          <td style="font-weight:700;color:#fff">${escapeHtml(c.title || 'Live Call')}</td>
          <td style="color:#CFE3D7">${escapeHtml(c.host || 'Host')}</td>
          <td>
            <span class="mono" style="color:#4ADE80;font-weight:800">${c.participant_count || 1}</span>
            <span style="font-size:11px;color:#8CA395">connected</span>
          </td>
          <td style="color:#8CA395">${start}</td>
          <td>
            <div style="display:flex;gap:8px">
              <a href="/r/${encodeURIComponent(c.code)}" target="_blank" class="portal-btn" style="padding:4px 10px;font-size:11px">Join</a>
              <button onclick="endLiveCall('${escapeHtml(c.code)}')" class="portal-btn danger" style="padding:4px 10px;font-size:11px">End Call</button>
            </div>
          </td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:#FCA5A5">Error scanning live calls: ${e.message}</td></tr>`;
    }
  };

  window.endLiveCall = function (code) {
    confirmAction({
      title: 'Force End Call',
      message: `Are you sure you want to terminate live meeting "${code}"? All active participants will be immediately disconnected.`,
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/admin/live/${encodeURIComponent(code)}/end`, {
            method: 'POST',
            headers: getHeaders()
          });
          if (!res.ok) throw new Error('Failed to terminate');
          showToast(`Call ${code} terminated successfully`, 'success');
          loadLiveCalls();
        } catch (e) {
          showToast('Failed to end call: ' + e.message, 'error');
        }
      }
    });
  };

  // ── 3. Hosts & Users Management (#users) ───────────────────────
  window.loadUsers = async function () {
    const q = document.getElementById('userSearchInput')?.value.trim() || '';
    const role = document.getElementById('userRoleFilter')?.value || 'all';
    const tbody = document.getElementById('usersTableBody');
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:28px;color:#8CA395"><span class="spinner"></span> Loading users from MySQL...</td></tr>';

    try {
      const res = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}&role=${encodeURIComponent(role)}`, {
        headers: getHeaders()
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const users = await res.json();

      if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:28px;color:#8CA395">No matching users found.</td></tr>';
        return;
      }

      tbody.innerHTML = users.map(u => {
        const isSuspended = u.status === 'suspended';
        const created = u.created_at ? new Date(u.created_at).toLocaleDateString() : '—';
        return `<tr class="fade-in" id="user-row-${u.id}">
          <td class="mono" style="color:#8CA395">#${u.id}</td>
          <td style="font-weight:700;color:#fff">${escapeHtml(u.name || '—')}</td>
          <td style="color:#A7BDB1">${escapeHtml(u.email || '')}</td>
          <td>
            <select class="portal-select" onchange="changeUserRole(${u.id}, this.value)">
              <option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
            </select>
          </td>
          <td>
            <span class="status-badge" style="display:inline-flex;align-items:center;gap:4px;font-weight:800;font-size:11px;color:${isSuspended ? '#FCA5A5' : '#4ADE80'}">
              <span style="width:6px;height:6px;border-radius:50%;background:${isSuspended ? '#EF4444' : '#4ADE80'}"></span>
              ${(u.status || 'active').toUpperCase()}
            </span>
          </td>
          <td class="mono" style="font-weight:700;color:#fff">${u.meetings_count || 0}</td>
          <td style="color:#8CA395">${created}</td>
          <td>
            <div style="display:flex;gap:6px">
              <button onclick="toggleUserStatus(${u.id}, '${isSuspended ? 'active' : 'suspended'}')" class="portal-btn ${isSuspended ? '' : 'secondary'}" style="padding:4px 9px;font-size:11px">
                ${isSuspended ? 'Activate' : 'Suspend'}
              </button>
              <button onclick="deleteUserAccount(${u.id}, '${escapeHtml(u.name || 'User')}')" class="portal-btn danger" style="padding:4px 9px;font-size:11px">
                Delete
              </button>
            </div>
          </td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:#FCA5A5">Error: ${e.message}</td></tr>`;
    }
  };

  window.debounceUserSearch = function () {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadUsers, 300);
  };

  window.openAddUserModal = function () {
    document.getElementById('addUserForm').reset();
    document.getElementById('newUserPassword').value = 'password123';
    document.getElementById('addUserModal').classList.remove('hidden');
  };

  window.submitAddUser = async function (e) {
    e.preventDefault();
    const name = document.getElementById('newUserName').value.trim();
    const email = document.getElementById('newUserEmail').value.trim();
    const password = document.getElementById('newUserPassword').value;
    const role = document.getElementById('newUserRole').value;

    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ name, email, password, role })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create user');
      showToast(`User ${name} created successfully!`, 'success');
      document.getElementById('addUserModal').classList.add('hidden');
      loadUsers();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  window.changeUserRole = async function (id, role) {
    try {
      const res = await fetch(`/api/admin/users/${id}/role`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ role })
      });
      if (!res.ok) throw new Error('Role update failed');
      showToast(`Role updated to ${role.toUpperCase()}`, 'success');
    } catch (e) {
      showToast(e.message, 'error');
      loadUsers();
    }
  };

  window.toggleUserStatus = async function (id, newStatus) {
    try {
      const res = await fetch(`/api/admin/users/${id}/status`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ status: newStatus })
      });
      if (!res.ok) throw new Error('Status update failed');
      showToast(`User marked as ${newStatus.toUpperCase()}`, 'success');
      loadUsers();
    } catch (e) {
      showToast(e.message, 'error');
    }
  };

  window.deleteUserAccount = function (id, name) {
    confirmAction({
      title: 'Delete User Account',
      message: `Are you sure you want to delete user "${name}"? This action is permanent and will also delete all meetings created by this user.`,
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/admin/users/${id}`, {
            method: 'DELETE',
            headers: getHeaders()
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Delete failed');
          showToast(`User ${name} and their meetings deleted`, 'success');
          loadUsers();
        } catch (e) {
          showToast(e.message, 'error');
        }
      }
    });
  };

  // ── 4. Meetings & History (#meetings) ──────────────────────────
  window.loadMeetings = async function () {
    const q = document.getElementById('meetingSearchInput')?.value.trim() || '';
    const status = document.getElementById('meetingStatusFilter')?.value || 'all';
    const tbody = document.getElementById('meetingsTableBody');
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:28px;color:#8CA395"><span class="spinner"></span> Loading meetings from MySQL...</td></tr>';

    try {
      const res = await fetch(`/api/admin/meetings?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`, {
        headers: getHeaders()
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const meetings = await res.json();

      if (!meetings.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:28px;color:#8CA395">No meetings found.</td></tr>';
        return;
      }

      tbody.innerHTML = meetings.map(m => {
        const dt = m.date ? (m.date.slice(0, 10) + (m.time ? ' ' + m.time.slice(0, 5) : '')) : (m.created_at ? new Date(m.created_at).toLocaleString() : '—');
        const sColor = m.status === 'live' ? '#EF4444' : m.status === 'scheduled' ? '#4ADE80' : '#8CA395';
        return `<tr class="fade-in">
          <td><span class="code-chip">${escapeHtml(m.code)}</span></td>
          <td style="font-weight:700;color:#fff">${escapeHtml(m.title || 'CamKnock Meeting')}</td>
          <td style="color:#CFE3D7">${escapeHtml(m.host_name || 'Guest')}</td>
          <td class="mono" style="font-size:12px;color:#A7BDB1">${dt}</td>
          <td><strong class="mono" style="color:#4ADE80">${m.joined_count || 0}</strong> <span style="font-size:11px;color:#8CA395">attendees</span></td>
          <td style="color:#8CA395">${m.duration_min || 30} min</td>
          <td><span style="font-weight:800;font-size:11px;color:${sColor}">${(m.status || 'live').toUpperCase()}</span></td>
          <td>
            <div style="display:flex;gap:6px">
              <a href="/r/${encodeURIComponent(m.code)}" target="_blank" class="portal-btn" style="padding:4px 9px;font-size:11px">Join</a>
              <button onclick="deleteMeetingRecord('${escapeHtml(m.code)}')" class="portal-btn danger" style="padding:4px 9px;font-size:11px">Delete</button>
            </div>
          </td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:#FCA5A5">Error: ${e.message}</td></tr>`;
    }
  };

  window.debounceMeetingSearch = function () {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadMeetings, 300);
  };

  window.openCreateMeetingModal = function () {
    document.getElementById('createMeetingForm').reset();
    document.getElementById('meetDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('createMeetingModal').classList.remove('hidden');
  };

  window.submitCreateMeeting = async function (e) {
    e.preventDefault();
    const title = document.getElementById('meetTitle').value.trim();
    const date = document.getElementById('meetDate').value;
    const time = document.getElementById('meetTime').value;
    const duration_min = Number(document.getElementById('meetDuration').value);
    const status = document.getElementById('meetStatus').value;

    try {
      const res = await fetch('/api/admin/meetings', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ title, date, time, duration_min, status })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to schedule');
      showToast(`Meeting "${title}" scheduled! (Code: ${data.code})`, 'success');
      document.getElementById('createMeetingModal').classList.add('hidden');
      loadMeetings();
      loadCalendarMonth();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  window.deleteMeetingRecord = function (code) {
    confirmAction({
      title: 'Delete Meeting Record',
      message: `Are you sure you want to delete meeting session "${code}" and all associated join records?`,
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/admin/meetings/${encodeURIComponent(code)}`, {
            method: 'DELETE',
            headers: getHeaders()
          });
          if (!res.ok) throw new Error('Delete failed');
          showToast(`Meeting ${code} deleted`, 'success');
          loadMeetings();
          loadCalendarMonth();
        } catch (e) {
          showToast(e.message, 'error');
        }
      }
    });
  };

  // ── 5. Scheduled Calendar (#calendar) ──────────────────────────
  window.changeMonth = function (delta) {
    calCurrentMonth += delta;
    if (calCurrentMonth < 0) {
      calCurrentMonth = 11;
      calCurrentYear--;
    } else if (calCurrentMonth > 11) {
      calCurrentMonth = 0;
      calCurrentYear++;
    }
    loadCalendarMonth();
  };

  window.loadCalendarMonth = async function () {
    const monthStr = `${calCurrentYear}-${String(calCurrentMonth + 1).padStart(2, '0')}`;
    const dateObj = new Date(calCurrentYear, calCurrentMonth, 1);
    const label = dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    document.getElementById('calCurrentMonthLabel').textContent = label;

    try {
      const res = await fetch(`/api/admin/calendar?month=${monthStr}`, { headers: getHeaders() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      calendarMeetingsCache = Array.isArray(data.meetings) ? data.meetings : [];
      renderCalendarGrid();
    } catch (e) {
      console.error('Calendar error:', e);
      renderCalendarGrid();
    }
  };

  function renderCalendarGrid() {
    const grid = document.getElementById('calendarDaysGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const firstDayIndex = new Date(calCurrentYear, calCurrentMonth, 1).getDay(); // 0..6
    const totalDays = new Date(calCurrentYear, calCurrentMonth + 1, 0).getDate();
    const prevMonthDays = new Date(calCurrentYear, calCurrentMonth, 0).getDate();

    const todayStr = new Date().toISOString().split('T')[0];

    // Previous month filler days
    for (let x = firstDayIndex; x > 0; x--) {
      const dayNum = prevMonthDays - x + 1;
      const cell = document.createElement('div');
      cell.className = 'cal-cell other-month';
      cell.innerHTML = `<span class="cal-num">${dayNum}</span>`;
      grid.appendChild(cell);
    }

    // Current month days
    for (let i = 1; i <= totalDays; i++) {
      const cellDateStr = `${calCurrentYear}-${String(calCurrentMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      const dayMeetings = calendarMeetingsCache.filter(m => m.date && m.date.slice(0, 10) === cellDateStr);

      const cell = document.createElement('div');
      cell.className = 'cal-cell' + (cellDateStr === todayStr ? ' today' : '') + (cellDateStr === selectedCalDate ? ' selected' : '');
      cell.onclick = () => selectCalendarDay(cellDateStr, dayMeetings);

      let dotsHtml = '';
      if (dayMeetings.length > 0) {
        dotsHtml = `
          <div class="cal-dots">
            ${dayMeetings.slice(0, 3).map(() => '<span class="cal-dot"></span>').join('')}
          </div>
          <span class="cal-count-pill">${dayMeetings.length} meeting${dayMeetings.length > 1 ? 's' : ''}</span>
        `;
      }

      cell.innerHTML = `
        <span class="cal-num">${i}</span>
        ${dotsHtml}
      `;
      grid.appendChild(cell);
    }

    // If there is an active selection or meetings today, show them
    if (selectedCalDate) {
      const selectedMeetings = calendarMeetingsCache.filter(m => m.date && m.date.slice(0, 10) === selectedCalDate);
      selectCalendarDay(selectedCalDate, selectedMeetings);
    }
  }

  function selectCalendarDay(dateStr, meetings) {
    selectedCalDate = dateStr;
    document.querySelectorAll('.cal-cell').forEach(c => c.classList.remove('selected'));

    const panel = document.getElementById('selectedDayPanel');
    const heading = document.getElementById('selectedDayHeading');
    const list = document.getElementById('selectedDayList');

    panel.style.display = 'block';
    heading.textContent = `Meetings for ${dateStr} (${meetings.length})`;

    if (!meetings.length) {
      list.innerHTML = `<div style="font-size:13px;color:#8CA395">No meetings scheduled for this date. 
        <button class="portal-btn secondary" style="margin-left:8px;padding:3px 8px;font-size:11px" onclick="openCreateMeetingModal()">+ Schedule for ${dateStr}</button>
      </div>`;
      return;
    }

    list.innerHTML = meetings.map(m => `
      <div style="background:#091E14;border:1px solid rgba(74,222,128,0.2);border-radius:10px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>
          <div style="font-weight:700;color:#fff">${escapeHtml(m.title || 'Untitled Meeting')}</div>
          <div style="font-size:12px;color:#A7BDB1;margin-top:2px">
            Time: <strong class="mono" style="color:#4ADE80">${m.time ? m.time.slice(0,5) : '—'}</strong> (${m.duration_min || 30} mins) • Host: ${escapeHtml(m.host_name || 'Admin')}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="code-chip">${escapeHtml(m.code)}</span>
          <a href="/r/${encodeURIComponent(m.code)}" target="_blank" class="portal-btn" style="padding:4px 9px;font-size:11px">Join</a>
          <button onclick="deleteMeetingRecord('${escapeHtml(m.code)}')" class="portal-btn danger" style="padding:4px 9px;font-size:11px">Delete</button>
        </div>
      </div>
    `).join('');
  }

  // ── 6. Support Desk (#support) ──────────────────────────────────
  window.loadTickets = async function () {
    const status = document.getElementById('ticketStatusFilter')?.value || 'all';
    const tbody = document.getElementById('ticketsTableBody');
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:28px;color:#8CA395"><span class="spinner"></span> Loading support tickets...</td></tr>';

    try {
      const res = await fetch(`/api/admin/tickets?status=${encodeURIComponent(status)}`, {
        headers: getHeaders()
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const tickets = await res.json();

      updateSupportBadge(tickets.filter(t => t.status === 'open').length);

      if (!tickets.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:28px;color:#8CA395">No support tickets found in this category.</td></tr>';
        return;
      }

      tbody.innerHTML = tickets.map(t => {
        const sColor = { open: '#FCD34D', progress: '#93C5FD', resolved: '#4ADE80' }[t.status] || '#fff';
        const created = t.created_at ? new Date(t.created_at).toLocaleDateString() : '—';
        return `<tr class="fade-in">
          <td class="mono" style="color:#8CA395">#${t.id}</td>
          <td style="font-weight:700;color:#fff">${escapeHtml(t.user_email || 'User')}</td>
          <td style="color:#CFE3D7;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.subject || 'Inquiry')}</td>
          <td style="color:#8CA395;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.latest_message || 'No messages')}</td>
          <td><span style="font-weight:800;font-size:11px;color:${sColor}">${(t.status || 'open').toUpperCase()}</span></td>
          <td style="color:#8CA395">${created}</td>
          <td>
            <button onclick="openTicketThread(${t.id})" class="portal-btn" style="padding:4px 10px;font-size:11px">
              View Thread (${t.message_count || 0})
            </button>
          </td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:#FCA5A5">Error: ${e.message}</td></tr>`;
    }
  };

  window.openTicketThread = async function (id) {
    activeTicketId = id;
    const modal = document.getElementById('ticketThreadModal');
    const container = document.getElementById('ticketMessagesContainer');
    container.innerHTML = '<div style="text-align:center;color:#8CA395;padding:20px"><span class="spinner"></span> Loading conversation thread...</div>';
    modal.classList.remove('hidden');

    try {
      const res = await fetch(`/api/admin/tickets/${id}`, { headers: getHeaders() });
      if (!res.ok) throw new Error('Could not load ticket');
      const data = await res.json();
      const t = data.ticket;
      const msgs = data.messages || [];

      document.getElementById('tDialogSubject').textContent = t.subject || 'Support Ticket #' + t.id;
      document.getElementById('tDialogEmail').textContent = t.user_email || '';
      document.getElementById('tDialogDate').textContent = t.created_at ? new Date(t.created_at).toLocaleString() : '';
      document.getElementById('tDialogStatusSelect').value = t.status || 'open';

      if (!msgs.length) {
        container.innerHTML = '<div style="text-align:center;color:#8CA395;padding:16px">No messages in this thread yet. Send a reply below.</div>';
        return;
      }

      container.innerHTML = msgs.map(m => {
        const isAdmin = m.from === 'admin';
        const timeStr = m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        return `
          <div class="msg-bubble ${isAdmin ? 'msg-admin' : 'msg-user'}">
            <div style="font-weight:700;font-size:11px;color:${isAdmin ? '#fff' : '#4ADE80'}">${isAdmin ? '🛡️ CamKnock Admin' : '👤 Customer'}</div>
            <div>${escapeHtml(m.text)}</div>
            <div class="msg-meta">${timeStr}</div>
          </div>
        `;
      }).join('');
      container.scrollTop = container.scrollHeight;
    } catch (e) {
      container.innerHTML = `<div style="color:#FCA5A5;padding:16px">Failed to load thread: ${e.message}</div>`;
    }
  };

  window.submitTicketReply = async function (e) {
    e.preventDefault();
    if (!activeTicketId) return;
    const input = document.getElementById('ticketReplyText');
    const text = input.value.trim();
    if (!text) return;

    const btn = document.getElementById('sendReplyBtn');
    btn.disabled = true;

    try {
      const res = await fetch(`/api/admin/tickets/${activeTicketId}/messages`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ text })
      });
      if (!res.ok) throw new Error('Reply failed');
      input.value = '';
      showToast('Reply sent to customer', 'success');
      openTicketThread(activeTicketId);
      loadTickets();
    } catch (err) {
      showToast(err.message, 'error');
    }
    btn.disabled = false;
  };

  window.updateTicketStatusFromDialog = async function (status) {
    if (!activeTicketId) return;
    try {
      const res = await fetch(`/api/admin/tickets/${activeTicketId}/status`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ status })
      });
      if (!res.ok) throw new Error('Status update failed');
      showToast(`Ticket status updated to ${status.toUpperCase()}`, 'success');
      loadTickets();
    } catch (e) {
      showToast(e.message, 'error');
    }
  };

  window.deleteTicketFromDialog = function () {
    if (!activeTicketId) return;
    confirmAction({
      title: 'Delete Support Ticket',
      message: 'Delete this support ticket and all its threaded messages permanently?',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/admin/tickets/${activeTicketId}`, {
            method: 'DELETE',
            headers: getHeaders()
          });
          if (!res.ok) throw new Error('Delete failed');
          document.getElementById('ticketThreadModal').classList.add('hidden');
          showToast('Ticket deleted successfully', 'success');
          loadTickets();
        } catch (e) {
          showToast(e.message, 'error');
        }
      }
    });
  };

  // ── 7. Website Controls (#controls) ────────────────────────────
  window.loadControls = async function () {
    try {
      const res = await fetch('/api/admin/settings', { headers: getHeaders() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const s = await res.json();

      document.getElementById('ctrl_guest_join').checked = Boolean(Number(s.guest_join));
      document.getElementById('ctrl_host_login').checked = Boolean(Number(s.host_login));
      document.getElementById('ctrl_screen_share').checked = Boolean(Number(s.screen_share));
      document.getElementById('ctrl_chat').checked = Boolean(Number(s.chat));
      document.getElementById('ctrl_maintenance').checked = Boolean(Number(s.maintenance));
      document.getElementById('ctrl_max_participants').value = s.max_participants || 25;
      document.getElementById('ctrl_max_minutes').value = s.max_minutes || 60;
      document.getElementById('ctrl_banner').value = s.banner || '';
    } catch (e) {
      showToast('Could not load controls: ' + e.message, 'error');
    }
  };

  window.saveControls = async function () {
    const btn = document.getElementById('saveControlsBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving...';

    const payload = {
      guest_join: document.getElementById('ctrl_guest_join').checked ? 1 : 0,
      host_login: document.getElementById('ctrl_host_login').checked ? 1 : 0,
      screen_share: document.getElementById('ctrl_screen_share').checked ? 1 : 0,
      chat: document.getElementById('ctrl_chat').checked ? 1 : 0,
      maintenance: document.getElementById('ctrl_maintenance').checked ? 1 : 0,
      max_participants: parseInt(document.getElementById('ctrl_max_participants').value) || 25,
      max_minutes: parseInt(document.getElementById('ctrl_max_minutes').value) || 60,
      banner: document.getElementById('ctrl_banner').value.trim()
    };

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save settings');
      showToast('Settings saved & live across the platform!', 'success');
    } catch (e) {
      showToast(e.message, 'error');
    }
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Live Settings`;
  };

  // ── Badges & Socket Sync ───────────────────────────────────────
  function updateLiveBadge(count) {
    const el = document.getElementById('liveBadge');
    if (el) el.textContent = `${count} LIVE`;
  }

  function updateSupportBadge(count) {
    const el = document.getElementById('supportBadge');
    if (el) el.textContent = count;
  }

  function initAdminWebSocket() {
    if (typeof io === 'undefined') return;
    try {
      adminSocket = io('/ws/admin', {
        auth: { token: adminToken },
        transports: ['websocket', 'polling']
      });

      adminSocket.on('live-update', (liveCalls) => {
        updateLiveBadge(liveCalls.length);
        if (window.location.hash === '#live') {
          // If viewing live tab, auto-render
          const tbody = document.getElementById('liveCallsBody');
          if (tbody && !tbody.querySelector('.spinner')) {
            loadLiveCalls();
          }
        }
      });
    } catch (e) {
      console.warn('Socket connection error:', e);
    }
  }

  function escapeHtml(val) {
    return String(val || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Init on load ───────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', async () => {
    const ok = await verifyAdminAccess();
    if (!ok) return;

    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
    initAdminWebSocket();
  });

})();
