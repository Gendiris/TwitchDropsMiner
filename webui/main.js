const ui = {
  startBtn: document.getElementById("startBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  actionStatus: document.getElementById("actionStatus"),
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
  uptimeDisplay: document.getElementById("uptimeDisplay"),
  loadDisplay: document.getElementById("loadDisplay"),
  filterPriorityBtn: document.getElementById("filterPriorityBtn"),
  searchInput: document.getElementById("searchInput"),
  filterChips: document.querySelectorAll(".filter-chip"),
  sortSelect: document.getElementById("sortSelect"),
  dropsCounter: document.getElementById("dropsCounter")
};

let startTime = null;
let lastRuntime = null;
let currentPriority = [];
let filterMode = 'all';
let filterSearch = '';
let sortMode = 'priority';

// --- API ---
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

// --- URL HANDLING ---
function applyUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab');
    if (tabParam) {
        const btn = document.querySelector(`.nav-btn[data-tab="${tabParam}"]`);
        if (btn) btn.click();
    }
    const searchParam = params.get('search');
    if (searchParam) { ui.searchInput.value = searchParam; filterSearch = searchParam.toLowerCase(); }
    const filterParam = params.get('filter');
    if (filterParam) {
        const chip = document.querySelector(`.filter-chip[data-filter="${filterParam}"]`);
        if (chip) {
            ui.filterChips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            filterMode = filterParam;
        }
    }
    if (params.get('sort')) { ui.sortSelect.value = params.get('sort'); sortMode = params.get('sort'); }
    if (params.get('prio') === 'true') ui.filterPriorityBtn.checked = true;
}

function updateUrl() {
    const params = new URLSearchParams();
    const activeTab = document.querySelector('.nav-btn.active');
    if(activeTab && activeTab.dataset.tab !== 'dashboard') params.set('tab', activeTab.dataset.tab);
    if(filterSearch) params.set('search', filterSearch);
    if(filterMode !== 'all') params.set('filter', filterMode);
    if(sortMode !== 'priority') params.set('sort', sortMode);
    if(ui.filterPriorityBtn.checked) params.set('prio', 'true');
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

// --- RENDER FUNCTIONS ---
function renderRuntime(runtime) {
  ui.stateText.textContent = runtime.state || "Unbekannt";
  const isWorking = ['MINING', 'WORKING'].includes(runtime.state);

  const statusParent = ui.statusDot.parentElement.parentElement;
  if(isWorking) {
    statusParent.classList.add('status-mining');
    statusParent.classList.remove('status-stopped');
  } else {
    statusParent.classList.remove('status-mining');
    statusParent.classList.add('status-stopped');
  }

  if (runtime.watching) {
    ui.watchingText.innerHTML = `${runtime.watching.display_name} <small style='opacity:0.6'>(${runtime.watching.game || '?'})</small>`;
  } else {
    ui.watchingText.textContent = "Wartet / Idle";
  }

  ui.pendingSwitchText.textContent = runtime.pending_switch ? `(Wechselt zu: ${runtime.pending_switch})` : "";

  renderTimeline(runtime.journal || []);

  if (runtime.sys_load && ui.loadDisplay) {
      ui.loadDisplay.innerHTML = `<i class="fa-solid fa-microchip"></i> ${runtime.sys_load}`;
  }

  if(runtime.started_at) {
    startTime = new Date(runtime.started_at);
  }

  renderTables(runtime);
}

function renderTimeline(journal) {
    if (!journal || !ui.timelineList) return;
    ui.timelineList.innerHTML = "";
    journal.forEach(entry => {
        const li = document.createElement("li");
        li.className = "timeline-entry";
        let icon = entry.icon ? entry.icon.replace("fa-", "") : "info";
        li.innerHTML = `
            <div class="t-icon ${entry.type}">
                <i class="fa-solid fa-${icon}"></i>
            </div>
            <div class="t-content">
                <div class="t-msg">${entry.msg}</div>
                <div class="t-time">${new Date(entry.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
            </div>`;
        ui.timelineList.appendChild(li);
    });
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
  ui.campaignsTable.innerHTML = "";
  let campaigns = [...(runtime.campaigns || [])];

  campaigns.sort((a, b) => {
      if (sortMode === 'name') return a.game.localeCompare(b.game);
      if (sortMode === 'progress') return getCampaignProgress(b) - getCampaignProgress(a);
      return (b.active - a.active) || a.game.localeCompare(b.game);
  });

  let visibleCount = 0;
  campaigns.forEach(c => {
    if (filterSearch && !c.game.toLowerCase().includes(filterSearch) && !c.name.toLowerCase().includes(filterSearch)) return;
    if (ui.filterPriorityBtn.checked) {
        if (!currentPriority.some(p => p.toLowerCase() === c.game.toLowerCase())) return;
    }
    if (filterMode === 'active' && !c.active) return;
    const hasProgress = (c.drops || []).some(d => d.current_minutes > 0 && !d.claimed);
    if (filterMode === 'progressing' && !hasProgress) return;
    if (filterMode === 'claimed' && c.claimed_drops === 0) return;

    visibleCount++;
    let dropsHtml = '<div class="drops-list">';
    (c.drops || []).forEach(d => {
        let pct = Math.min(100, (d.current_minutes / d.required_minutes) * 100 || 0);
        dropsHtml += `
            <div class="drop-item">
                <div class="drop-header">
                    <span class="drop-name">${d.name} ${d.claimed ? '✅' : ''}</span>
                    <span class="drop-mins">${d.current_minutes}/${d.required_minutes}m</span>
                </div>
                <div class="progress-container"><div class="progress-fill" style="width:${pct}%; background:${d.claimed ? 'var(--success)':'var(--accent)'}"></div></div>
            </div>`;
    });
    dropsHtml += '</div>';

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><div style="font-weight:bold;">${c.game}</div><div style="font-size:0.75rem;color:#888;">${c.name}</div></td>
      <td>${dropsHtml}</td>
      <td style="text-align:right;">${c.claimed_drops}/${c.total_drops}</td>`;
    ui.campaignsTable.appendChild(tr);
  });
  ui.dropsCounter.textContent = visibleCount;

  ui.channelsTable.innerHTML = "";
  (runtime.channels || []).forEach(ch => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${ch.login}</td><td style="color:${ch.status === 'online' ? 'var(--success)' : '#555'}">${ch.status}</td><td>${ch.drops_enabled ? '✅' : '❌'}</td>`;
    ui.channelsTable.appendChild(tr);
  });
}

function updateUptime() {
    if(!startTime || !ui.uptimeDisplay) return;
    const diff = new Date() - startTime;
    if (diff < 0) return;
    const hh = Math.floor(diff / 3600000).toString().padStart(2, '0');
    const mm = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
    const ss = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
    ui.uptimeDisplay.innerHTML = `<i class="fa-regular fa-clock"></i> ${hh}:${mm}:${ss}`;
}

// --- EVENTS ---
ui.tabButtons.forEach(btn => btn.onclick = () => {
    ui.tabButtons.forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    updateUrl();
});

ui.filterChips.forEach(chip => chip.onclick = () => {
    ui.filterChips.forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    filterMode = chip.dataset.filter;
    updateUrl(); if(lastRuntime) renderTables(lastRuntime);
});

ui.searchInput.oninput = (e) => { filterSearch = e.target.value.toLowerCase(); updateUrl(); if(lastRuntime) renderTables(lastRuntime); };
ui.filterPriorityBtn.onchange = () => { updateUrl(); if(lastRuntime) renderTables(lastRuntime); };
ui.sortSelect.onchange = (e) => { sortMode = e.target.value; updateUrl(); if(lastRuntime) renderTables(lastRuntime); };

ui.startBtn.onclick = () => apiCall("/api/actions/start");
ui.reloadBtn.onclick = () => apiCall("/api/actions/reload");

ui.settingsForm.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(ui.settingsForm);
    const payload = {
        language: f.get("language"), proxy: f.get("proxy"),
        priority: f.get("priority").split(",").map(x => x.trim()).filter(Boolean),
        exclude: f.get("exclude").split(",").map(x => x.trim()).filter(Boolean),
        priority_mode: f.get("priority_mode"), connection_quality: Number(f.get("connection_quality")),
        available_drops_check: f.get("available_drops_check") === "on",
        enable_badges_emotes: f.get("enable_badges_emotes") === "on",
        tray_notifications: f.get("tray_notifications") === "on",
        autostart_tray: f.get("autostart_tray") === "on",
    };
    try {
        await apiCall("/api/settings", "PUT", payload);
        ui.settingsStatus.textContent = "Gespeichert!";
        setTimeout(() => ui.settingsStatus.textContent = "", 3000);
    } catch(err) { alert(err.message); }
};

async function pollSnapshot() {
  try {
    const data = await apiCall("/api/snapshot");
    if (data.settings && !ui.settingsForm.contains(document.activeElement)) {
        currentPriority = data.settings.priority || [];
        const s = data.settings; const f = ui.settingsForm;
        f.language.value = s.language; f.proxy.value = s.proxy;
        f.priority.value = (s.priority || []).join(", "); f.exclude.value = (s.exclude || []).join(", ");
        f.priority_mode.value = s.priority_mode; f.connection_quality.value = s.connection_quality;
        f.available_drops_check.checked = s.available_drops_check; f.enable_badges_emotes.checked = s.enable_badges_emotes;
        f.tray_notifications.checked = s.tray_notifications; f.autostart_tray.checked = s.autostart_tray;
    }
    if (data.runtime) { lastRuntime = data.runtime; renderRuntime(data.runtime); }
  } catch (err) { console.warn("Poll Error:", err); }
}

applyUrlParams();
setInterval(pollSnapshot, 1000);
setInterval(updateUptime, 1000);
pollSnapshot();
