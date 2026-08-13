const refreshMs = 3000;
const reloadEnabledStates = [
  'IDLE',
  'INVENTORY_FETCH',
  'GAMES_UPDATE',
  'CHANNELS_FETCH',
  'CHANNELS_CLEANUP',
  'CHANNEL_SWITCH',
];

const ui = {
  settingsForm: document.getElementById("settingsForm"),
  settingsStatus: document.getElementById("settingsStatus"),
  stateText: document.getElementById("stateText"),
  statusDot: document.getElementById("statusDot"),
  watchingText: document.getElementById("watchingText"),
  pendingSwitchText: document.getElementById("pendingSwitchText"),
  timelineList: document.getElementById("timelineList"),
  channelsTable: document.querySelector("#channelsTable tbody"),
  campaignsTable: document.querySelector("#campaignsTable tbody"),
  tabButtons: document.querySelectorAll('.nav-btn'),
  navPanel: document.getElementById("navPanel"),
  navOverlay: document.getElementById("navOverlay"),
  menuToggle: document.getElementById("menuToggle"),
  uptimeDisplay: document.getElementById("uptimeDisplay"),
  loadDisplay: document.getElementById("loadDisplay"),
  lastReloadDisplay: document.getElementById("lastReloadDisplay"),
  reloadButton: document.getElementById("reloadButton"),
  filterPriorityBtn: document.getElementById("filterPriorityBtn"),
  searchInput: document.getElementById("searchInput"),
  filterChips: document.querySelectorAll(".filter-chip"),
  sortSelect: document.getElementById("sortSelect"),
  dropsCounter: document.getElementById("dropsCounter"),
  watchdogList: document.getElementById("watchdogList"),
  connectionStatus: document.getElementById("connectionStatus"),
  lastEventText: document.getElementById("lastEventText"),
};

let startTime = null;
let lastRuntime = null;
let currentPriority = [];
let filterMode = 'all';
let filterSearch = '';
let sortMode = 'priority';
let navOpen = false;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Escape user-supplied strings for safe innerHTML insertion. */
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function showToast(msg, type = 'error') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

async function apiCall(path, method = "GET", payload = null) {
  const options = { method, headers: { "Content-Type": "application/json" } };
  if (payload) options.body = JSON.stringify(payload);
  const resp = await fetch(path, options);
  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData.error || `Error ${resp.status}`);
  }
  return resp.json();
}

function updateConnectionStatus(online) {
  if (!ui.connectionStatus) return;
  ui.connectionStatus.textContent = online ? '\u25CF Online' : '\u25CF Offline';
  ui.connectionStatus.className = `connection-status ${online ? 'online' : 'offline'}`;
}

// ── URL state ──────────────────────────────────────────────────────────────

function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const tabParam = params.get('tab');
  if (tabParam) activateTab(tabParam);

  const searchParam = params.get('search');
  if (searchParam && ui.searchInput) {
    ui.searchInput.value = searchParam;
    filterSearch = searchParam.toLowerCase();
  }

  const filterParam = params.get('filter');
  if (filterParam) {
    const chip = document.querySelector(`.filter-chip[data-filter="${filterParam}"]`);
    if (chip) {
      ui.filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filterMode = filterParam;
    }
  }
  if (params.get('sort') && ui.sortSelect) { ui.sortSelect.value = params.get('sort'); sortMode = params.get('sort'); }
  if (params.get('prio') === 'true' && ui.filterPriorityBtn) ui.filterPriorityBtn.checked = true;
}

function updateUrl() {
  const params = new URLSearchParams();
  const activeTab = document.querySelector('.nav-btn.active');
  if (activeTab && activeTab.dataset.tab !== 'dashboard') params.set('tab', activeTab.dataset.tab);
  if (filterSearch) params.set('search', filterSearch);
  if (filterMode !== 'all') params.set('filter', filterMode);
  if (sortMode !== 'priority') params.set('sort', sortMode);
  if (ui.filterPriorityBtn && ui.filterPriorityBtn.checked) params.set('prio', 'true');
  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

// ── Rendering ──────────────────────────────────────────────────────────────

function formatTimelineDate(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  const now = new Date();
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return timeStr;
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}. ${timeStr}`;
}

function formatRelativeTime(isoString) {
  if (!isoString) return "";
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 60000) return "gerade eben";
  if (diff < 3600000) return `vor ${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `vor ${Math.floor(diff / 3600000)}h`;
  return `vor ${Math.floor(diff / 86400000)}d`;
}

function renderRuntime(runtime) {
  if (ui.stateText) ui.stateText.textContent = runtime.state || "Unbekannt";
  const isWorking = reloadEnabledStates.includes(runtime.state);

  if (ui.reloadButton) ui.reloadButton.disabled = !isWorking;

  if (ui.statusDot) {
    if (isWorking || runtime.state === 'MINING') {
      ui.statusDot.style.backgroundColor = 'var(--success)';
      ui.statusDot.style.boxShadow = '0 0 8px var(--success)';
    } else {
      ui.statusDot.style.backgroundColor = 'var(--danger)';
      ui.statusDot.style.boxShadow = '0 0 8px var(--danger)';
    }
  }

  if (ui.watchingText) {
    ui.watchingText.textContent = '';
    if (runtime.watching) {
      ui.watchingText.appendChild(document.createTextNode(runtime.watching.display_name));
      const gameSpan = document.createElement('span');
      gameSpan.className = 'watch-game';
      gameSpan.textContent = ` (${runtime.watching.game || '?'})`;
      ui.watchingText.appendChild(gameSpan);
    } else {
      ui.watchingText.textContent = "Wartet / Idle";
    }
  }

  if (ui.pendingSwitchText) {
    if (runtime.pending_switch) {
      ui.pendingSwitchText.textContent = `Wechsel: ${runtime.pending_switch}`;
      ui.pendingSwitchText.style.display = 'inline-block';
    } else {
      ui.pendingSwitchText.style.display = 'none';
    }
  }

  updateReloadTimestamp(runtime.last_reload);

  const journal = runtime.journal || [];
  renderTimeline(journal);
  renderWatchdogTimeline(runtime.watchdog_log || []);
  renderLastEvent(journal);

  if (runtime.sys_load && ui.loadDisplay) {
    ui.loadDisplay.textContent = `Load: ${runtime.sys_load}`;
  }

  if (runtime.started_at) {
    startTime = new Date(runtime.started_at);
  }

  renderTables(runtime);
}

function renderTimeline(journal) {
  if (!ui.timelineList) return;
  ui.timelineList.innerHTML = "";
  if (!journal || !journal.length) {
    const li = document.createElement("li");
    li.className = "timeline-empty";
    li.textContent = "Keine Aktivität seit Neustart";
    ui.timelineList.appendChild(li);
    return;
  }
  journal.forEach((entry, i) => {
    const li = document.createElement("li");
    li.className = "timeline-entry" + (i === 0 ? " timeline-entry--latest" : "");
    li.innerHTML = `
      <div class="t-time">${esc(formatTimelineDate(entry.time))}</div>
      <div class="t-msg">${esc(entry.msg)}</div>
    `;
    ui.timelineList.appendChild(li);
  });
}

const WATCHDOG_ACTION_MAP = {
  within_threshold: { icon: '✓', label: 'OK',               cls: 'wd-ok'   },
  inactive:         { icon: '—', label: 'Inaktiv',           cls: 'wd-ok'   },
  no_timestamp:     { icon: '—', label: 'Kein Timestamp',    cls: 'wd-ok'   },
  hysteresis:       { icon: '⚠', label: 'Überschritten',     cls: 'wd-warn' },
  exceeded:         { icon: '⚠', label: 'Grenzwert erreicht',cls: 'wd-warn' },
  reload:           { icon: '↺', label: 'Neustart ausgelöst',cls: 'wd-reload'},
};

function renderWatchdogTimeline(watchdogLog) {
  if (!ui.watchdogList) return;
  ui.watchdogList.innerHTML = "";
  if (!watchdogLog || !watchdogLog.length) {
    const li = document.createElement("li");
    li.className = "timeline-empty";
    li.textContent = "Keine Watchdog-Daten";
    ui.watchdogList.appendChild(li);
    return;
  }
  watchdogLog.forEach(entry => {
    const { icon, cls } = WATCHDOG_ACTION_MAP[entry.action] || { icon: '?', cls: 'wd-ok' };
    const idleStr = entry.idle_min != null
      ? `${entry.idle_min}m / ${entry.threshold_min}m`
      : '—';
    const li = document.createElement("li");
    li.className = "timeline-entry watchdog-entry";
    li.innerHTML = `
      <div class="t-time">${esc(formatTimelineDate(entry.time))}</div>
      <div class="t-msg ${esc(cls)}">${icon} ${esc(entry.state || '?')}  (${esc(idleStr)})</div>
    `;
    ui.watchdogList.appendChild(li);
  });
}

function renderLastEvent(journal) {
  if (!ui.lastEventText) return;
  const entry = (journal || []).find(e => e.type !== 'watchdog');
  if (!entry) { ui.lastEventText.style.display = 'none'; return; }
  const icons = { switch: '📺', claim: '🎁', info: 'ℹ', error: '⚠', restart: '↺' };
  const icon = icons[entry.type] || 'ℹ';
  const relTime = formatRelativeTime(entry.time);
  ui.lastEventText.textContent = `${icon} ${entry.msg} — ${relTime}`;
  ui.lastEventText.style.display = 'block';
}

function getCampaignProgress(c) {
  let totalMin = 0; let currentMin = 0;
  (c.drops || []).forEach(d => {
    totalMin += d.required_minutes;
    currentMin += d.current_minutes;
  });
  return totalMin === 0 ? 0 : (currentMin / totalMin) * 100;
}

function renderTables(runtime) {
  if (!ui.campaignsTable) return;
  ui.campaignsTable.innerHTML = "";
  let campaigns = [...(runtime.campaigns || [])];

  campaigns.sort((a, b) => {
    if (sortMode === 'last_seen') {
      const tA = a.last_seen ? new Date(a.last_seen).getTime() : 0;
      const tB = b.last_seen ? new Date(b.last_seen).getTime() : 0;
      return (tB - tA) || a.game.localeCompare(b.game);
    }
    if (sortMode === 'name') return a.game.localeCompare(b.game);
    if (sortMode === 'progress') return getCampaignProgress(b) - getCampaignProgress(a);
    return (b.active - a.active) || a.game.localeCompare(b.game);
  });

  let visibleCount = 0;
  campaigns.forEach(c => {
    if (filterSearch && !c.game.toLowerCase().includes(filterSearch) && !c.name.toLowerCase().includes(filterSearch)) return;
    if (ui.filterPriorityBtn && ui.filterPriorityBtn.checked) {
      if (!currentPriority.some(p => p.toLowerCase() === c.game.toLowerCase())) return;
    }
    const hasProgress = (c.drops || []).some(d => d.current_minutes > 0 && !d.claimed);
    if (filterMode === 'progressing' && !hasProgress) return;
    if (filterMode === 'claimed' && c.claimed_drops === 0) return;

    visibleCount++;
    let dropsHtml = '<div class="drops-list">';
    (c.drops || []).forEach(d => {
      const pct = Math.min(100, (d.current_minutes / d.required_minutes) * 100 || 0);
      const progressClass = d.claimed ? 'progress-bar claimed' : 'progress-bar';
      const checkMark = d.claimed ? '<i class="fa-solid fa-check claimed-icon"></i>' : '';
      dropsHtml += `
        <div class="drop-item">
          <div class="drop-item-header">
            <span class="drop-name">${esc(d.name)} ${checkMark}</span>
            <span class="drop-time">${d.current_minutes}/${d.required_minutes}m</span>
          </div>
          <div class="progress-container"><div class="${progressClass}" style="width:${pct}%;"></div></div>
        </div>`;
    });
    dropsHtml += '</div>';

    let timeInfo = "";
    if (c.last_seen) {
      const dateStr = formatTimelineDate(c.last_seen);
      timeInfo = `<div class="last-seen-info"><i class="fa-regular fa-eye"></i> ${esc(dateStr)}</div>`;
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="vertical-align:top">
        <div class="game-title">${esc(c.game)}</div>
        <div class="game-subtitle">${esc(c.name)}</div>
        ${timeInfo}
      </td>
      <td style="vertical-align:top">${dropsHtml}</td>
      <td style="text-align:right; vertical-align:top; font-family:monospace;">${c.claimed_drops}/${c.total_drops}</td>`;
    ui.campaignsTable.appendChild(tr);
  });

  if (ui.dropsCounter) ui.dropsCounter.textContent = visibleCount;

  if (ui.channelsTable) {
    ui.channelsTable.innerHTML = "";
    (runtime.channels || []).forEach(ch => {
      const tr = document.createElement("tr");
      const dropsIcon = ch.drops_enabled
        ? '<i class="fa-solid fa-check success-icon"></i>'
        : '<span class="muted-dash">-</span>';
      tr.innerHTML = `
        <td>${esc(ch.login)}</td>
        <td class="status-${esc(ch.status)}">${esc(ch.status)}</td>
        <td style="text-align:center;">${dropsIcon}</td>
        <td><button class="btn-switch" data-login="${esc(ch.login)}">&#8617;</button></td>`;
      ui.channelsTable.appendChild(tr);
    });
  }
}

// ── Channel switch via event delegation ───────────────────────────────────

if (ui.channelsTable) {
  ui.channelsTable.addEventListener('click', async (e) => {
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
}

// ── Uptime + reload timestamp ──────────────────────────────────────────────

function updateUptime() {
  if (!startTime || !ui.uptimeDisplay) return;
  const diff = new Date() - startTime;
  if (diff < 0) return;
  const hh = Math.floor(diff / 3600000).toString().padStart(2, '0');
  const mm = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
  const ss = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
  ui.uptimeDisplay.innerHTML = `<i class="fa-regular fa-clock"></i> ${hh}:${mm}:${ss}`;
}

function updateReloadTimestamp(value) {
  if (!ui.lastReloadDisplay) return;
  if (!value) { ui.lastReloadDisplay.textContent = 'Reload: --:--'; return; }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) { ui.lastReloadDisplay.textContent = 'Reload: --:--'; return; }
  ui.lastReloadDisplay.textContent = `Reload: ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function canReload() {
  return lastRuntime && reloadEnabledStates.includes(lastRuntime.state);
}

if (ui.reloadButton) ui.reloadButton.disabled = true;

// ── Navigation ─────────────────────────────────────────────────────────────

function setNavState(isOpen) {
  navOpen = isOpen;
  document.body.classList.toggle('nav-open', isOpen);
  if (ui.menuToggle) ui.menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function closeNavForMobile() {
  if (window.innerWidth <= 1023) setNavState(false);
}

if (ui.menuToggle) ui.menuToggle.onclick = () => setNavState(!navOpen);
if (ui.navOverlay) ui.navOverlay.onclick = () => setNavState(false);
window.addEventListener('resize', () => { if (window.innerWidth > 1023) setNavState(false); });

function activateTab(tabName) {
  const targetBtn = Array.from(ui.tabButtons).find(b => b.dataset.tab === tabName);
  ui.tabButtons.forEach(b => b.classList.toggle('active', b === targetBtn));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const tabContent = document.getElementById(`tab-${tabName}`);
  if (tabContent) tabContent.classList.add('active');
  closeNavForMobile();
  updateUrl();
}

ui.tabButtons.forEach(btn => btn.onclick = () => activateTab(btn.dataset.tab));

// ── Filter / sort controls ─────────────────────────────────────────────────

ui.filterChips.forEach(chip => chip.onclick = () => {
  ui.filterChips.forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  filterMode = chip.dataset.filter;
  updateUrl();
  if (lastRuntime) renderTables(lastRuntime);
});

if (ui.searchInput) ui.searchInput.oninput = (e) => {
  filterSearch = e.target.value.toLowerCase();
  updateUrl();
  if (lastRuntime) renderTables(lastRuntime);
};
if (ui.filterPriorityBtn) ui.filterPriorityBtn.onchange = () => { updateUrl(); if (lastRuntime) renderTables(lastRuntime); };
if (ui.sortSelect) ui.sortSelect.onchange = (e) => { sortMode = e.target.value; updateUrl(); if (lastRuntime) renderTables(lastRuntime); };

// ── Reload button ──────────────────────────────────────────────────────────

if (ui.reloadButton) ui.reloadButton.onclick = async () => {
  if (!canReload()) return;
  const icon = ui.reloadButton.querySelector('i');
  if (icon) icon.classList.add('fa-spin');
  try {
    await apiCall("/api/actions/reload", "POST");
    const now = new Date();
    lastRuntime = { ...(lastRuntime || {}), last_reload: now.toISOString() };
    updateReloadTimestamp(now);
  } catch (err) {
    showToast(`Reload fehlgeschlagen: ${err.message}`);
  } finally {
    setTimeout(() => { if (icon) icon.classList.remove('fa-spin'); }, 1000);
  }
};

// ── Settings form ──────────────────────────────────────────────────────────

if (ui.settingsForm) ui.settingsForm.onsubmit = async (e) => {
  e.preventDefault();
  const submitBtn = ui.settingsForm.querySelector('[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Speichere...'; }
  const f = new FormData(ui.settingsForm);
  const payload = {
    language: f.get("language"),
    proxy: f.get("proxy"),
    priority: f.get("priority").split(",").map(x => x.trim()).filter(Boolean),
    exclude: f.get("exclude").split(",").map(x => x.trim()).filter(Boolean),
    priority_mode: f.get("priority_mode"),
    connection_quality: Number(f.get("connection_quality")),
    available_drops_check: f.get("available_drops_check") === "on",
    enable_badges_emotes: f.get("enable_badges_emotes") === "on",
    tray_notifications: f.get("tray_notifications") === "on",
    autostart_tray: f.get("autostart_tray") === "on",
  };
  try {
    await apiCall("/api/settings", "PUT", payload);
    if (ui.settingsStatus) {
      ui.settingsStatus.textContent = "Gespeichert!";
      ui.settingsStatus.style.color = 'var(--success)';
      setTimeout(() => { ui.settingsStatus.textContent = ""; }, 3000);
    }
  } catch (err) {
    showToast(err.message);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Speichern'; }
  }
};

// ── Polling ────────────────────────────────────────────────────────────────

async function pollSnapshot() {
  try {
    const data = await apiCall("/api/snapshot");
    updateConnectionStatus(true);
    if (data.settings && ui.settingsForm && !ui.settingsForm.contains(document.activeElement)) {
      currentPriority = data.settings.priority || [];
      const s = data.settings;
      const f = ui.settingsForm;
      if (f.language) f.language.value = s.language;
      if (f.proxy) f.proxy.value = s.proxy;
      if (f.priority) f.priority.value = (s.priority || []).join(", ");
      if (f.exclude) f.exclude.value = (s.exclude || []).join(", ");
      if (f.priority_mode) f.priority_mode.value = s.priority_mode;
      if (f.connection_quality) f.connection_quality.value = s.connection_quality;
      if (f.available_drops_check) f.available_drops_check.checked = s.available_drops_check;
      if (f.enable_badges_emotes) f.enable_badges_emotes.checked = s.enable_badges_emotes;
      if (f.tray_notifications) f.tray_notifications.checked = s.tray_notifications;
      if (f.autostart_tray) f.autostart_tray.checked = s.autostart_tray;
    }
    if (data.runtime) { lastRuntime = data.runtime; renderRuntime(data.runtime); }
  } catch (err) {
    updateConnectionStatus(false);
  }
}

// ── Mobile info-column tabs ─────────────────────────────────────────────────

(function initInfoTabs() {
  const tabBtns = document.querySelectorAll('.info-tab-btn');
  const panels = document.querySelectorAll('.info-panel');
  if (!tabBtns.length) return;
  tabBtns.forEach(btn => {
    btn.onclick = () => {
      const panelName = btn.dataset.panel;
      tabBtns.forEach(b => b.classList.toggle('active', b === btn));
      panels.forEach(p => p.classList.toggle('active', p.dataset.panel === panelName));
    };
  });
})();

applyUrlParams();
setInterval(pollSnapshot, refreshMs);
setInterval(updateUptime, 1000);
pollSnapshot();
