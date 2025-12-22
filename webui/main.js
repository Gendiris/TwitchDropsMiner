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
  filterPriorityBtn: document.getElementById("filterPriorityBtn") // Neu
};

let pollHandle;
let startTime = null;
let lastRuntime = null; // Um sofortiges Neuzeichnen zu ermöglichen
let currentPriority = []; // Liste der prio spiele

// --- TABS ---
ui.tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    ui.tabButtons.forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
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
  ui.pendingSwitchText.textContent = runtime.pending_switch ? `(Switching to: ${runtime.pending_switch})` : "";

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

  renderTables(runtime);
}

function renderTables(runtime) {
  // --- KAMPAGNEN & DROPS ---
  ui.campaignsTable.innerHTML = "";

  // Sortiere aktive Kampagnen nach oben
  const sortedCampaigns = (runtime.campaigns || []).sort((a, b) => b.active - a.active);

  // Lese Filter Status
  const filterActive = ui.filterPriorityBtn.checked;

  let visibleCount = 0;

  sortedCampaigns.forEach(c => {
    // FILTER LOGIK
    if (filterActive) {
        // Prüfen, ob das Spiel in der Prio Liste ist (Case-Insensitive)
        const isPrio = currentPriority.some(p => p.toLowerCase() === c.game.toLowerCase());
        if (!isPrio) return; // Überspringen
    }

    visibleCount++;

    // HTML Generierung
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
                    <span class="drop-mins">${d.current_minutes} / ${d.required_minutes} min</span>
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
        <div style="font-size:1.1rem; font-weight:bold; color:white;">${c.game}</div>
        <div style="font-size:0.85rem; color:#aaa; margin-top:4px;">${c.name}</div>
        <div style="margin-top:8px;">${statusBadge}</div>
      </td>
      <td style="vertical-align:top">
        ${dropsHtml}
      </td>
      <td style="vertical-align:top; text-align:right; font-size:1.2rem; font-weight:bold;">
        ${c.claimed_drops} <span style="font-size:0.8rem; color:#666; font-weight:normal">/ ${c.total_drops}</span>
      </td>
    `;
    ui.campaignsTable.appendChild(tr);
  });

  if (visibleCount === 0) {
      const msg = filterActive ? "Keine Prio-Kampagnen aktiv" : "Keine Kampagnen gefunden";
      ui.campaignsTable.innerHTML = `<tr><td colspan='3' style='text-align:center; padding:20px; color:#666'>${msg}</td></tr>`;
  }

  // --- KANÄLE ---
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

// --- POLLING ---
async function pollSnapshot() {
  try {
    const data = await apiCall("/api/snapshot");
    const isEditing = ui.settingsForm.contains(document.activeElement);

    if (data.settings) {
        // Prio Liste aktualisieren
        currentPriority = data.settings.priority || [];

        if (!isEditing) {
            fillSettings(data.settings);
        }
    }

    if (data.runtime) {
      lastRuntime = data.runtime;
      renderRuntime(data.runtime);
    }
  } catch (err) {
    console.warn("Poll Error:", err);
  }
}

ui.startBtn.onclick = () => apiCall("/api/actions/start").then(r => ui.actionStatus.textContent = "Gestartet").catch(e => alert(e));
ui.stopBtn.onclick = () => apiCall("/api/actions/stop").then(r => ui.actionStatus.textContent = "Gestoppt").catch(e => alert(e));
ui.reloadBtn.onclick = () => apiCall("/api/actions/reload").then(r => ui.actionStatus.textContent = "Reloading...").catch(e => alert(e));

ui.filterPriorityBtn.onchange = () => {
    if(lastRuntime) renderTables(lastRuntime);
};

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

// Start
setInterval(pollSnapshot, refreshMs);
setInterval(updateUptime, 1000);
pollSnapshot();