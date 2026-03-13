// ── Constants ───────────────────────────────────────────────────────────────

const REFRESH_MS = 3000;

const RELOAD_ENABLED_STATES = [
  'IDLE', 'INVENTORY_FETCH', 'GAMES_UPDATE',
  'CHANNELS_FETCH', 'CHANNELS_CLEANUP', 'CHANNEL_SWITCH',
];

const WATCHDOG_ACTION_MAP = {
  within_threshold: { icon: '✓', cls: 'wd-ok'    },
  inactive:         { icon: '—', cls: 'wd-ok'    },
  no_timestamp:     { icon: '—', cls: 'wd-ok'    },
  hysteresis:       { icon: '⚠', cls: 'wd-warn'  },
  exceeded:         { icon: '⚠', cls: 'wd-warn'  },
  reload:           { icon: '↺', cls: 'wd-reload' },
};

// ── State ────────────────────────────────────────────────────────────────────

let startTime    = null;
let lastRuntime  = null;
let lastSettings = null;
let filterMode   = 'all';
let filterSearch = '';
let sortMode     = 'last_seen';
let currentTab   = 'overview';
let currentPriority = [];

// ── DOM refs ─────────────────────────────────────────────────────────────────

const el = id => document.getElementById(id);
const qs = sel => document.querySelector(sel);
const qsa = sel => document.querySelectorAll(sel);

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function showToast(msg, type = 'error') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

async function apiCall(path, method = 'GET', payload = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (payload) opts.body = JSON.stringify(payload);
  const r = await fetch(path, opts);
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `Error ${r.status}`);
  }
  return r.json();
}

function formatTimelineDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return t;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}. ${t}`;
}

function formatEndDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Connection status ─────────────────────────────────────────────────────────

function updateConnectionStatus(online) {
  const el_ = el('connectionStatus');
  if (!el_) return;
  el_.textContent = online ? '\u25CF Online' : '\u25CF Offline';
  el_.className = `conn-status ${online ? 'online' : 'offline'}`;
}

// ── URL state ─────────────────────────────────────────────────────────────────

function updateUrl(params = {}) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || v === false) p.delete(k);
    else p.set(k, v);
  }
  window.history.replaceState({}, '', `${window.location.pathname}?${p}`);
}

function applyUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const tab = p.get('tab');
  if (tab) activateTab(tab);

  const s = p.get('search');
  if (s) {
    const inp = el('searchInput');
    if (inp) inp.value = s;
    filterSearch = s.toLowerCase();
  }

  const f = p.get('filter');
  if (f) {
    const chip = qs(`.chip[data-filter="${f}"]`);
    if (chip) {
      qsa('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filterMode = f;
    }
  }

  const sort = p.get('sort');
  if (sort) {
    const sel = el('sortSelect');
    if (sel) sel.value = sort;
    sortMode = sort;
  }

  if (p.get('prio') === 'true') {
    const cb = el('filterPriorityBtn');
    if (cb) cb.checked = true;
  }
}

// ── Tab system ────────────────────────────────────────────────────────────────

function activateTab(name) {
  currentTab = name;
  qsa('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  qsa('.nav-tab, .mobile-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name)
  );
  updateUrl({ tab: name === 'overview' ? null : name });
  if (name === 'settings') fetchWatchdog();
}

qsa('.nav-tab, .mobile-tab').forEach(btn =>
  btn.addEventListener('click', () => activateTab(btn.dataset.tab))
);

// ── findActiveDrop ────────────────────────────────────────────────────────────

function findActiveDrop(runtime) {
  if (!runtime || !runtime.watching) return null;
  const game = runtime.watching.game;
  const candidates = (runtime.campaigns || [])
    .filter(c => c.game === game && c.active && c.eligible)
    .sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));

  for (const campaign of candidates) {
    const unclaimed = (campaign.drops || []).filter(d => !d.claimed);
    const inProgress = unclaimed.filter(d => d.current_minutes > 0);
    const drop = inProgress[0] ?? unclaimed[0] ?? null;
    if (drop) return { campaign, drop };
  }
  return null;
}

function findNextDrop(runtime, activeResult) {
  if (!activeResult) return null;
  const { campaign, drop } = activeResult;
  const drops = campaign.drops || [];
  const idx = drops.indexOf(drop);
  const remaining = drops.slice(idx + 1).filter(d => !d.claimed);
  if (remaining.length) return { campaign, drop: remaining[0] };

  // check next campaign
  const game = runtime.watching?.game;
  const candidates = (runtime.campaigns || [])
    .filter(c => c.game === game && c.active && c.eligible)
    .sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));
  const cIdx = candidates.indexOf(campaign);
  for (let i = cIdx + 1; i < candidates.length; i++) {
    const unclaimed = (candidates[i].drops || []).filter(d => !d.claimed);
    if (unclaimed.length) return { campaign: candidates[i], drop: unclaimed[0] };
  }
  return null;
}

// ── renderMiningCard ──────────────────────────────────────────────────────────

function renderMiningCard(runtime) {
  const state = runtime.state || '';
  const isActive = state === 'MINING' || RELOAD_ENABLED_STATES.includes(state);
  const isMining = state === 'MINING';

  // State dot + text
  const dot = el('statusDot');
  const stateText = el('stateText');
  if (dot) dot.classList.toggle('active', isActive);
  if (stateText) stateText.textContent = state || '–';

  // Start/Stop buttons
  const stopBtn = el('stopButton');
  const startBtn = el('startButton');
  if (stopBtn) stopBtn.style.display = isMining ? 'flex' : 'none';
  if (startBtn) startBtn.style.display = (!isMining && !isActive) ? 'flex' : 'none';



  // Watching row
  const watchingText = el('watchingText');
  const watchingGame = el('watchingGame');
  if (watchingText) {
    watchingText.textContent = runtime.watching ? runtime.watching.display_name : 'Warten…';
  }
  if (watchingGame) {
    watchingGame.textContent = runtime.watching ? `(${runtime.watching.game || '?'})` : '';
  }

  // Active drop
  const activeResult = findActiveDrop(runtime);
  const nextResult = findNextDrop(runtime, activeResult);
  const activeSection = el('activeDropSection');
  const nextSection = el('nextDropSection');
  const idleMsg = el('idleMessage');

  if (activeResult) {
    const { campaign, drop } = activeResult;
    const pct = Math.min(100, drop.required_minutes > 0
      ? (drop.current_minutes / drop.required_minutes) * 100 : 0);

    if (el('activeDropName')) el('activeDropName').textContent = drop.name;
    if (el('activeDropBar'))  el('activeDropBar').style.width = `${pct.toFixed(1)}%`;
    if (el('activeDropTime')) el('activeDropTime').textContent =
      `${drop.current_minutes} / ${drop.required_minutes} min`;
    if (el('activeDropPct')) el('activeDropPct').textContent = `${Math.round(pct)}%`;

    const campEl = el('activeDropCampaign');
    if (campEl) {
      campEl.innerHTML = `<span>${esc(campaign.game)}</span> · ${esc(campaign.name)}`;
      if (campaign.ends_at) {
        campEl.innerHTML += ` · Endet: ${esc(formatEndDate(campaign.ends_at))}`;
      }
    }

    if (activeSection) activeSection.style.display = 'block';
    if (idleMsg) idleMsg.style.display = 'none';
  } else {
    if (activeSection) activeSection.style.display = 'none';
    if (idleMsg) {
      idleMsg.style.display = runtime.watching ? 'none' : 'flex';
      const idleText = el('idleText');
      if (idleText) idleText.textContent = 'Suche nach Kanälen…';
    }
  }

  if (nextResult) {
    const { drop } = nextResult;
    const pct = Math.min(100, drop.required_minutes > 0
      ? (drop.current_minutes / drop.required_minutes) * 100 : 0);

    if (el('nextDropName')) el('nextDropName').textContent = drop.name;
    if (el('nextDropBar'))  el('nextDropBar').style.width = `${pct.toFixed(1)}%`;
    if (el('nextDropTime')) el('nextDropTime').textContent =
      `${drop.current_minutes} / ${drop.required_minutes} min`;

    if (nextSection) nextSection.style.display = 'block';
  } else {
    if (nextSection) nextSection.style.display = 'none';
  }

  // Pending switch chip
  const pendingEl = el('pendingSwitchText');
  if (pendingEl) {
    if (runtime.pending_switch) {
      pendingEl.textContent = `Wechsel: ${runtime.pending_switch}`;
      pendingEl.style.display = 'inline-block';
    } else {
      pendingEl.style.display = 'none';
    }
  }

  // Footer chips
  if (el('loadDisplay') && runtime.sys_load) {
    el('loadDisplay').textContent = `Load: ${runtime.sys_load}`;
  }
  updateReloadTimestamp(runtime.last_reload);

  if (runtime.started_at) startTime = new Date(runtime.started_at);
}

// ── renderTimeline ────────────────────────────────────────────────────────────

function renderTimeline(journal) {
  const list = el('timelineList');
  if (!list) return;
  list.innerHTML = '';

  if (!journal || !journal.length) {
    list.innerHTML = '<li class="timeline-empty">Keine Aktivität seit Neustart</li>';
    return;
  }

  journal.forEach((entry, i) => {
    const li = document.createElement('li');
    li.className = 'timeline-entry' + (i === 0 ? ' timeline-entry--latest' : '');
    li.innerHTML = `<span class="t-time">${esc(formatTimelineDate(entry.time))}</span>`
                 + `<span class="t-msg">${esc(entry.msg)}</span>`;
    list.appendChild(li);
  });
}

// ── renderWatchdogTimeline ────────────────────────────────────────────────────

function renderWatchdogTimeline(watchdogLog) {
  const list = el('watchdogList');
  if (!list) return;
  list.innerHTML = '';

  if (!watchdogLog || !watchdogLog.length) {
    list.innerHTML = '<li class="timeline-empty">Keine Watchdog-Daten</li>';
    return;
  }

  watchdogLog.forEach(entry => {
    const { icon, cls } = WATCHDOG_ACTION_MAP[entry.action] || { icon: '?', cls: 'wd-ok' };
    const idleStr = entry.idle_min != null
      ? `${entry.idle_min}m / ${entry.threshold_min}m` : '—';
    const li = document.createElement('li');
    li.className = 'timeline-entry watchdog-entry';
    li.innerHTML = `<span class="t-time">${esc(formatTimelineDate(entry.time))}</span>`
      + `<span class="t-msg ${esc(cls)}">${icon} ${esc(entry.state || '?')} (${esc(idleStr)})</span>`;
    list.appendChild(li);
  });
}

// ── renderChannelList ─────────────────────────────────────────────────────────

function renderChannelList(channels) {
  const list = el('channelsList');
  const countEl = el('channelCount');
  if (!list) return;
  list.innerHTML = '';
  if (countEl) countEl.textContent = (channels || []).length;

  if (!channels || !channels.length) {
    list.innerHTML = '<li class="timeline-empty">Keine Kanäle</li>';
    return;
  }

  channels.forEach(ch => {
    const online = ch.status === 'online' || ch.status === 'pending_online';
    const dropsIcon = ch.drops_enabled
      ? '<i class="fa-solid fa-check channel-drops-icon" title="Drops aktiv"></i>'
      : '';

    const li = document.createElement('li');
    li.className = 'channel-item';
    li.innerHTML = `
      <span class="channel-dot ${online ? 'online' : 'offline'}"></span>
      <span class="channel-name">${esc(ch.login)}</span>
      ${dropsIcon}
      <span class="channel-status">${esc(ch.status)}</span>
      <button class="btn-switch" data-login="${esc(ch.login)}" title="Zu diesem Kanal wechseln">&#8617;</button>
    `;
    list.appendChild(li);
  });
}

// Channel switch via event delegation
el('channelsList')?.addEventListener('click', async e => {
  const btn = e.target.closest('.btn-switch');
  if (!btn) return;
  const login = btn.dataset.login;
  try {
    await apiCall('/api/actions/switch-channel', 'POST', { channel: login });
    showToast(`Wechsle zu ${login}`, 'success');
  } catch (err) {
    showToast(`Fehler: ${err.message}`);
  }
});

// ── renderCampaigns ───────────────────────────────────────────────────────────

function getCampaignProgress(c) {
  let total = 0, current = 0;
  (c.drops || []).forEach(d => {
    total   += d.required_minutes;
    current += d.current_minutes;
  });
  return total === 0 ? 0 : (current / total) * 100;
}

function buildCampaignCard(c) {
  const div = document.createElement('div');
  div.className = 'campaign-card' + (c.active ? ' is-active' : '');

  const claimed = c.claimed_drops ?? 0;
  const total   = c.total_drops   ?? (c.drops || []).length;
  const endStr  = c.ends_at ? `Endet ${formatEndDate(c.ends_at)}` : '';

  div.innerHTML = `
    <div class="campaign-header">
      <span class="campaign-game">${esc(c.game)}</span>
      <span class="campaign-name">${esc(c.name)}</span>
      ${endStr ? `<span class="campaign-end">${esc(endStr)}</span>` : ''}
      <span class="campaign-progress-summary">${claimed} / ${total}</span>
    </div>
  `;

  (c.drops || []).forEach(d => {
    const pct = Math.min(100, d.required_minutes > 0
      ? (d.current_minutes / d.required_minutes) * 100 : 0);

    let iconClass, iconChar;
    if (d.claimed)                { iconClass = 'claimed'; iconChar = '✓'; }
    else if (d.current_minutes > 0){ iconClass = 'active';  iconChar = '◉'; }
    else                           { iconClass = 'pending'; iconChar = '○'; }

    const row = document.createElement('div');
    row.className = 'drop-row' + (d.claimed ? ' claimed' : '');
    row.innerHTML = `
      <span class="drop-row-icon ${iconClass}">${iconChar}</span>
      <span class="drop-row-name">${esc(d.name)}</span>
      <div class="drop-row-bar progress-track" style="margin:0">
        <div class="progress-fill" style="width:${pct.toFixed(1)}%"></div>
      </div>
      <span class="drop-row-time">${d.current_minutes}/${d.required_minutes}m</span>
    `;
    div.appendChild(row);
  });

  return div;
}

function renderCampaigns(runtime) {
  const container = el('campaignsList');
  if (!container) return;

  let campaigns = [...(runtime.campaigns || [])];

  // Sort
  campaigns.sort((a, b) => {
    if (sortMode === 'last_seen') {
      const tA = a.last_seen ? new Date(a.last_seen).getTime() : 0;
      const tB = b.last_seen ? new Date(b.last_seen).getTime() : 0;
      return (tB - tA) || a.game.localeCompare(b.game);
    }
    if (sortMode === 'name')     return a.game.localeCompare(b.game);
    if (sortMode === 'progress') return getCampaignProgress(b) - getCampaignProgress(a);
    // priority: active first
    return (b.active - a.active) || a.game.localeCompare(b.game);
  });

  // Filter
  const prioFilter = el('filterPriorityBtn')?.checked ?? false;
  campaigns = campaigns.filter(c => {
    if (filterSearch && !c.game.toLowerCase().includes(filterSearch)
        && !c.name.toLowerCase().includes(filterSearch)) return false;
    if (prioFilter && !currentPriority.some(p => p.toLowerCase() === c.game.toLowerCase())) return false;

    const hasProgress = (c.drops || []).some(d => d.current_minutes > 0 && !d.claimed);
    if (filterMode === 'active'      && !c.active) return false;
    if (filterMode === 'progressing' && !hasProgress) return false;
    if (filterMode === 'claimed'     && (c.claimed_drops ?? 0) === 0) return false;
    return true;
  });

  container.innerHTML = '';

  if (!campaigns.length) {
    container.innerHTML = '<div class="empty-state">Keine Campaigns gefunden</div>';
    return;
  }

  campaigns.forEach(c => container.appendChild(buildCampaignCard(c)));
}

// ── renderClaimsList ──────────────────────────────────────────────────────────

function renderClaimsList(claims) {
  const list = el('claimsList');
  if (!list) return;
  list.innerHTML = '';

  if (!claims || !claims.length) {
    list.innerHTML = '<li class="timeline-empty">Noch keine Claims</li>';
    return;
  }

  claims.forEach((entry, i) => {
    const li = document.createElement('li');
    li.className = 'timeline-entry' + (i === 0 ? ' timeline-entry--latest' : '');
    li.innerHTML = `<span class="t-time">${esc(formatTimelineDate(entry.time))}</span>`
                 + `<span class="t-msg">${esc(entry.msg)}</span>`;
    list.appendChild(li);
  });
}

// ── renderSidePanel ───────────────────────────────────────────────────────────

function renderSidePanel(runtime) {
  renderTimeline(runtime.journal || []);
  renderClaimsList(runtime.claims || []);
}

// ── fetchWatchdog ─────────────────────────────────────────────────────────────

async function fetchWatchdog() {
  try {
    const data = await apiCall('/api/watchdog');
    renderWatchdogTimeline(data);
  } catch { /* silent */ }
}

// ── Main render dispatcher ────────────────────────────────────────────────────

function renderRuntime(runtime, settings) {
  renderMiningCard(runtime);
  renderSidePanel(runtime);
  renderChannelList(runtime.channels || []);
  renderCampaigns(runtime);
}

// ── Uptime + reload timestamp ─────────────────────────────────────────────────

function updateUptime() {
  if (!startTime) return;
  const diff = Date.now() - startTime.getTime();
  if (diff < 0) return;
  const hh = String(Math.floor(diff / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
  const ss = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
  const up = el('uptimeDisplay');
  if (up) up.textContent = `${hh}:${mm}:${ss}`;
}

function updateReloadTimestamp(value) {
  const el_ = el('lastReloadDisplay');
  if (!el_) return;
  if (!value) { el_.textContent = 'Reload: --'; return; }
  const d = new Date(value);
  if (isNaN(d.getTime())) { el_.textContent = 'Reload: --'; return; }
  el_.textContent = `Reload: ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}


// ── Start/Stop buttons ────────────────────────────────────────────────────────

el('stopButton')?.addEventListener('click', async () => {
  try {
    await apiCall('/api/actions/stop', 'POST');
    showToast('Mining gestoppt', 'success');
  } catch (err) {
    showToast(`Fehler: ${err.message}`);
  }
});

el('startButton')?.addEventListener('click', async () => {
  try {
    await apiCall('/api/actions/start', 'POST');
    showToast('Mining gestartet', 'success');
  } catch (err) {
    showToast(`Fehler: ${err.message}`);
  }
});

// ── Settings form ─────────────────────────────────────────────────────────────

el('settingsForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Speichere…'; }

  const f = new FormData(e.target);
  const payload = {
    language:             f.get('language'),
    proxy:                f.get('proxy'),
    priority:             (f.get('priority') || '').split(',').map(x => x.trim()).filter(Boolean),
    exclude:              (f.get('exclude') || '').split(',').map(x => x.trim()).filter(Boolean),
    priority_mode:        f.get('priority_mode'),
    connection_quality:   Number(f.get('connection_quality')),
    available_drops_check: f.get('available_drops_check') === 'on',
    enable_badges_emotes:  f.get('enable_badges_emotes') === 'on',
    tray_notifications:    f.get('tray_notifications') === 'on',
    autostart_tray:        f.get('autostart_tray') === 'on',
  };

  try {
    await apiCall('/api/settings', 'PUT', payload);
    const status = el('settingsStatus');
    if (status) {
      status.textContent = 'Gespeichert!';
      status.style.color = 'var(--success)';
      setTimeout(() => { status.textContent = ''; }, 3000);
    }
  } catch (err) {
    showToast(err.message);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Speichern'; }
  }
});

// ── Clear journal button ──────────────────────────────────────────────────────

el('clearJournalBtn')?.addEventListener('click', async () => {
  if (!confirm('Journal wirklich leeren?')) return;
  try {
    await apiCall('/api/actions/clear-journal', 'POST');
    showToast('Journal geleert', 'success');
  } catch (err) {
    showToast(`Fehler: ${err.message}`);
  }
});

// ── Restart service button ────────────────────────────────────────────────────

el('restartServiceBtn')?.addEventListener('click', async () => {
  if (!confirm('Service wirklich komplett neu starten?')) return;
  const btn = el('restartServiceBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Wird neugestartet…'; }
  try {
    await apiCall('/api/actions/restart', 'POST');
    showToast('Service wird neu gestartet…', 'success');
  } catch (err) {
    showToast(`Fehler: ${err.message}`);
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Service neu starten'; }
  }
});

// ── Filter / sort controls ────────────────────────────────────────────────────

qsa('.chip[data-filter]').forEach(chip => {
  chip.addEventListener('click', () => {
    qsa('.chip[data-filter]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    filterMode = chip.dataset.filter;
    updateUrl({ filter: filterMode === 'all' ? null : filterMode });
    if (lastRuntime) renderCampaigns(lastRuntime);
  });
});

el('searchInput')?.addEventListener('input', e => {
  filterSearch = e.target.value.toLowerCase();
  updateUrl({ search: filterSearch || null });
  if (lastRuntime) renderCampaigns(lastRuntime);
});

el('filterPriorityBtn')?.addEventListener('change', () => {
  updateUrl({ prio: el('filterPriorityBtn').checked ? 'true' : null });
  if (lastRuntime) renderCampaigns(lastRuntime);
});

el('sortSelect')?.addEventListener('change', e => {
  sortMode = e.target.value;
  updateUrl({ sort: sortMode === 'last_seen' ? null : sortMode });
  if (lastRuntime) renderCampaigns(lastRuntime);
});

// ── Polling ───────────────────────────────────────────────────────────────────

function applySettings(s) {
  if (!s) return;
  currentPriority = s.priority || [];
  const f = el('settingsForm');
  if (!f || f.contains(document.activeElement)) return;

  if (f.language)             f.language.value = s.language;
  if (f.proxy)                f.proxy.value = s.proxy || '';
  if (f.priority)             f.priority.value = (s.priority || []).join(', ');
  if (f.exclude)              f.exclude.value = (s.exclude || []).join(', ');
  if (f.priority_mode)        f.priority_mode.value = s.priority_mode;
  if (f.connection_quality)   f.connection_quality.value = s.connection_quality;
  if (f.available_drops_check) f.available_drops_check.checked = s.available_drops_check;
  if (f.enable_badges_emotes)  f.enable_badges_emotes.checked = s.enable_badges_emotes;
  if (f.tray_notifications)    f.tray_notifications.checked = s.tray_notifications;
  if (f.autostart_tray)        f.autostart_tray.checked = s.autostart_tray;
}

async function pollSnapshot() {
  try {
    const data = await apiCall('/api/snapshot');
    updateConnectionStatus(true);
    if (data.settings) {
      lastSettings = data.settings;
      applySettings(data.settings);
    }
    if (data.runtime) {
      lastRuntime = data.runtime;
      renderRuntime(data.runtime, data.settings);
    }
  } catch {
    updateConnectionStatus(false);
  }
}

// ── Page Visibility API ───────────────────────────────────────────────────────

let pollTimer = null;
let uptimeTimer = null;
let watchdogTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollSnapshot, REFRESH_MS);
  uptimeTimer = setInterval(updateUptime, 1000);
  watchdogTimer = setInterval(() => { if (currentTab === 'settings') fetchWatchdog(); }, REFRESH_MS);
  pollSnapshot();
}

function stopPolling() {
  clearInterval(pollTimer);   pollTimer = null;
  clearInterval(uptimeTimer); uptimeTimer = null;
  clearInterval(watchdogTimer); watchdogTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    startPolling();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

applyUrlParams();
startPolling();
