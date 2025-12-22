const refreshMs = 2500;

const ui = {
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  actionStatus: document.getElementById("actionStatus"),
  settingsForm: document.getElementById("settingsForm"),
  settingsStatus: document.getElementById("settingsStatus"),
  stateText: document.getElementById("stateText"),
  statusDot: document.getElementById("statusDot"),
  watchingText: document.getElementById("watchingText"),
  pendingSwitchText: document.getElementById("pendingSwitchText"),
  errorsList: document.getElementById("errorsList"),
  channelsTable: document.querySelector("#channelsTable tbody"),
  campaignsTable: document.querySelector("#campaignsTable tbody"),
  tabButtons: document.querySelectorAll('.nav-btn'),
  uptimeDisplay: document.getElementById("uptimeDisplay"),
  loadDisplay: document.getElementById("loadDisplay"), // NEU

  // Filter elements
  filterPriorityBtn: document.getElementById("filterPriorityBtn"),
  searchInput: document.getElementById("searchInput"),
  filterChips: document.querySelectorAll(".filter-chip"),
  sortSelect: document.getElementById("sortSelect"),
  dropsCounter: document.getElementById("dropsCounter")
};

let pollHandle;
let startTime = null;
let lastRuntime = null;
let currentPriority = [];

// Status Variablen
let filterMode = 'all';
let filterSearch = '';
let sortMode = 'priority'; // priority, progress, name

// --- URL HANDLING ---
function applyUrlParams() {
    const params = new URLSearchParams(window.location.search);

    const tabParam = params.get('tab');
    if (tabParam) {
        const btn = document.querySelector(`.nav-btn[data-tab="${tabParam}"]`);
        if (btn) btn.click();
    }

    const searchParam = params.get('search');
    if (searchParam) {
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

    const sortParam = params.get('sort');
    if (sortParam) {
        ui.sortSelect.value = sortParam;
        sortMode = sortParam;
    }

    const prioParam = params.get('prio');
    if (prioParam === 'true' || prioParam === '1') {
        ui.filterPriorityBtn.checked = true;
    }
}

function updateUrl() {
    const params = new URLSearchParams();

    const activeTab = document.querySelector('.nav-btn.active');
    if(activeTab && activeTab.dataset.tab !== 'dashboard') params.set('tab', activeTab.dataset.tab);

    if(filterSearch) params.set('search', filterSearch);
    if(filterMode !== 'all') params.set('filter', filterMode);
    if(sortMode !== 'priority') params.set('sort', sortMode);
    if(ui.filterPriorityBtn.checked) params.set('prio', 'true');

    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
}

// --- TABS & EVENTS ---
ui.tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    ui.tabButtons.forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    updateUrl();
  });
});

ui.filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
        ui.filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        filterMode = chip.dataset.filter;
        updateUrl();
        if(lastRuntime) renderTables(lastRuntime);
    });
});

ui.searchInput.addEventListener('input', (e) => {
    filterSearch = e.target.value.toLowerCase();
    updateUrl();
    if(lastRuntime) renderTables(lastRuntime);
});

ui.filterPriorityBtn.addEventListener('change', () => {
    updateUrl();
    if(lastRuntime) renderTables(lastRuntime);
});

ui.sortSelect.addEventListener('change', (e) => {
    sortMode = e.target.value;
    updateUrl();
    if(lastRuntime) renderTables(lastRuntime);
});


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

// --- RENDER ---
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

  ui.errorsList.innerHTML = "";
  if(!runtime.errors || runtime.errors.length === 0) {
      ui.errorsList.innerHTML = "<li style='color:#666; list-style:none'>Keine Fehler (Log sauber)</li>";
  } else {
    runtime.errors.slice(0, 5).forEach(err => {
      const li = document.createElement("li");
      li.textContent = `[ERR] ${err}`;
      li.style.color = "var(--danger)";
      ui.errorsList.appendChild(li);
    });
  }

  if(runtime.started_at && !startTime) {
    startTime = new Date(runtime.started_at);
  }

  // LOAD DISPLAY UPDATE
  if (runtime.sys_load) {
      ui.loadDisplay.innerHTML = `<i class="fa-solid fa-microchip"></i> ${runtime.sys_load}`;
  }

  renderTables(runtime);
}

function getCampaignProgress(c) {
    let totalMin = 0;
    let currentMin = 0;
    (c.drops || []).forEach(d => {
        totalMin += d.required_minutes;
        currentMin += d.current_minutes;
    });
    if(totalMin === 0) return 0;
    return (currentMin / totalMin) * 100;
}

function renderTables(runtime) {
  ui.campaignsTable.innerHTML = "";

  let campaigns = [...(runtime.campaigns || [])];

  campaigns.sort((a, b) => {
      if (sortMode === 'name') {
          return a.game.localeCompare(b.game);
      } else if (sortMode === 'progress') {
          return getCampaignProgress(b) - getCampaignProgress(a);
      } else {
          return (b.active - a.active) || a.game.localeCompare(b.game);
      }
  });

  const filterPrio = ui.filterPriorityBtn.checked;
  let visibleCount = 0;

  campaigns.forEach(c => {
    if (filterSearch && !c.game.toLowerCase().includes(filterSearch) && !c.name.toLowerCase().includes(filterSearch)) return;
    if (filterPrio) {
        const isPrio = currentPriority.some(p => p.toLowerCase() === c.game.toLowerCase());
        if (!isPrio) return;
    }
    if (filterMode === 'active' && !c.active) return;
    const hasProgress = (c.drops || []).some(d => d.current_minutes > 0 && !d.claimed);
    if (filterMode === 'progressing' && !hasProgress) return;
    if (filterMode === 'claimed' && c.claimed_drops === 0) return;

    visibleCount++;

    let dropsHtml = '<div class="drops-list">';
    (c.drops || []).forEach(d => {
        let pct = 0;
        if (d.required_minutes > 0) {
            pct = (d.current_minutes / d.required_minutes) * 100;
        }
        if (pct > 100) pct = 100;

        const isClaimed = d.claimed;
        const barColor = isClaimed ? 'var(--success)' : 'var(--accent)';
        const statusIcon = isClaimed ? '<i class="fa-solid fa-check"></i>' : '';

        dropsHtml += `
            <div class="drop-item">
                <div class="drop-header">
                    <span class="drop-name">${d.name} ${statusIcon}</span>
                    <span class="drop-mins">${d.current_minutes} / ${d.required_minutes} m</span>
                </div>
                <div class="progress-container">
                    <div class="progress-fill" style="width:${pct}%; background-color: ${barColor}"></div>
                </div>
            </div>
        `;
    });
    dropsHtml += '</div>';

    const statusBadge = c.active
        ? "<span class='badge badge-active'>Aktiv</span>"
        : "<span class='badge badge-inactive'>Inaktiv</span>";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="vertical-align:top">
        <div style="font-weight:bold; color:white; font-size:0.95rem;">${c.game}</div>
        <div style="font-size:0.75rem; color:#888; margin-top:2px; margin-bottom:5px;">${c.name}</div>
        <div>${statusBadge}</div>
      </td>
      <td style="vertical-align:top">
        ${dropsHtml}
      </td>
      <td style="vertical-align:top; text-align:right; font-weight:bold; color:#ddd;">
        ${c.claimed_drops} <span style="font-size:0.8rem; color:#666; font-weight:normal">/ ${c.total_drops}</span>
      </td>
    `;
    ui.campaignsTable.appendChild(tr);
  });

  ui.dropsCounter.textContent = `${visibleCount} Kampagnen`;

  if (visibleCount === 0) {
      ui.campaignsTable.innerHTML = `<tr><td colspan='3' style='text-align:center; padding:20px; color:#666'>Keine Kampagnen für diesen Filter</td></tr>`;
  }

  // Kanäle
  ui.channelsTable.innerHTML = "";
  (runtime.channels || []).forEach(ch => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${ch.login}</strong></td>
      <td style="color:${ch.status === 'online' ? 'var(--success)' : '#555'}">${ch.status}</td>
      <td>${ch.drops_enabled ? '✅' : '❌'}</td>
    `;
    ui.channelsTable.appendChild(tr);
  });
}

function updateUptime() {
    if(!startTime) return;
    const now = new Date();
    const diff = now - startTime;
    const hh = Math.floor(diff / 3600000).toString().padStart(2, '0');
    const mm = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
    const ss = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
    ui.uptimeDisplay.innerHTML = `<i class="fa-regular fa-clock"></i> ${hh}:${mm}:${ss}`;
}

// --- SETTINGS ---
function fillSettings(s) {
  const f = ui.settingsForm;
  f.language.value = s.language ?? "";
  f.proxy.value = s.proxy ?? "";
  f.priority.value = (s.priority || []).join(", ");
  f.exclude.value = (s.exclude || []).join(", ");
  f.priority_mode.value = s.priority_mode || "PRIORITY_ONLY";
  f.connection_quality.value = s.connection_quality ?? 0;

  f.available_drops_check.checked = !!s.available_drops_check;
  f.enable_badges_emotes.checked = !!s.enable_badges_emotes;
  f.tray_notifications.checked = !!s.tray_notifications;
  f.autostart_tray.checked = !!s.autostart_tray;
}

function readSettings() {
  const f = new FormData(ui.settingsForm);
  const list = (k) => f.get(k).split(",").map(x => x.trim()).filter(Boolean);
  return {
    language: f.get("language"),
    proxy: f.get("proxy"),
    priority: list("priority"),
    exclude: list("exclude"),
    priority_mode: f.get("priority_mode"),
    connection_quality: Number(f.get("connection_quality")),
    available_drops_check: f.get("available_drops_check") === "on",
    enable_badges_emotes: f.get("enable_badges_emotes") === "on",
    tray_notifications: f.get("tray_notifications") === "on",
    autostart_tray: f.get("autostart_tray") === "on",
  };
}

// --- INIT ---
ui.startBtn.onclick = () => apiCall("/api/actions/start").then(r => ui.actionStatus.textContent = "Gestartet").catch(e => alert(e));
ui.stopBtn.onclick = () => apiCall("/api/actions/stop").then(r => ui.actionStatus.textContent = "Gestoppt").catch(e => alert(e));
ui.reloadBtn.onclick = () => apiCall("/api/actions/reload").then(r => ui.actionStatus.textContent = "Reloading...").catch(e => alert(e));

ui.settingsForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
        await apiCall("/api/settings", "PUT", readSettings());
        ui.settingsStatus.textContent = "Gespeichert!";
        ui.settingsStatus.style.color = "var(--success)";
        setTimeout(() => ui.settingsStatus.textContent = "", 3000);
    } catch(err) {
        ui.settingsStatus.textContent = "Fehler!";
        ui.settingsStatus.style.color = "var(--danger)";
    }
};

async function pollSnapshot() {
  try {
    const data = await apiCall("/api/snapshot");
    const isEditing = ui.settingsForm.contains(document.activeElement);
    if (data.settings) {
        currentPriority = data.settings.priority || [];
        if (!isEditing) fillSettings(data.settings);
    }
    if (data.runtime) {
      lastRuntime = data.runtime;
      renderRuntime(data.runtime);
    }
  } catch (err) {
    console.warn("Poll Error:", err);
  }
}

applyUrlParams();
setInterval(pollSnapshot, refreshMs);
setInterval(updateUptime, 1000);
pollSnapshot();