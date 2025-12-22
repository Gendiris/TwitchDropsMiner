const refreshMs = 2500;
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const reloadBtn = document.getElementById("reloadBtn");
const switchBtn = document.getElementById("switchBtn");
const channelInput = document.getElementById("channelInput");
const actionStatus = document.getElementById("actionStatus");
const settingsForm = document.getElementById("settingsForm");
const settingsStatus = document.getElementById("settingsStatus");
const stateText = document.getElementById("stateText");
const statusDot = document.getElementById("statusDot");
const watchingText = document.getElementById("watchingText");
const pendingSwitchText = document.getElementById("pendingSwitchText");
const errorsList = document.getElementById("errorsList");
const channelsTable = document.querySelector("#channelsTable tbody");
const campaignsTable = document.querySelector("#campaignsTable tbody");

const tabButtons = document.querySelectorAll('.nav-btn');
const tabContents = document.querySelectorAll('.tab-content');

let pollHandle;

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    const tabId = `tab-${btn.dataset.tab}`;
    document.getElementById(tabId).classList.add('active');
  });
});

function setActionStatus(message, ok = true) {
  actionStatus.textContent = message || "";
  actionStatus.style.color = ok ? "#adadb8" : "#ff4f4d";
  if(message) setTimeout(() => { actionStatus.textContent = ''; }, 3000);
}

function setSettingsStatus(message, ok = true) {
  settingsStatus.textContent = message || "";
  settingsStatus.style.color = ok ? "#00f593" : "#ff4f4d";
  if(message) setTimeout(() => { settingsStatus.textContent = ''; }, 3000);
}

async function apiPost(path, payload) {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!resp.ok) throw new Error(`Request failed: ${resp.status}`);
  return resp.json();
}

async function apiGet(path) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`Request failed: ${resp.status}`);
  return resp.json();
}

async function apiPut(path, payload) {
  const resp = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
    throw new Error(err || `Request failed: ${resp.status}`);
  }
  return data;
}

function serializeSettings(formData) {
  const toList = (value) => value.split(",").map((v) => v.trim()).filter(Boolean);

  return {
    language: formData.get("language") || undefined,
    proxy: formData.get("proxy") || undefined,
    priority: toList(formData.get("priority") || ""),
    exclude: toList(formData.get("exclude") || ""),
    priority_mode: formData.get("priority_mode"),
    available_drops_check: formData.get("available_drops_check") === "on",
    enable_badges_emotes: formData.get("enable_badges_emotes") === "on",
    connection_quality: Number(formData.get("connection_quality")) || 0,
    tray_notifications: formData.get("tray_notifications") === "on",
    autostart_tray: formData.get("autostart_tray") === "on",
  };
}

function fillSettings(settings) {
  settingsForm.language.value = settings.language ?? "";
  settingsForm.proxy.value = settings.proxy ?? "";
  settingsForm.priority.value = (settings.priority || []).join(", ");
  settingsForm.exclude.value = (settings.exclude || []).join(", ");
  settingsForm.priority_mode.value = settings.priority_mode || "PRIORITY_ONLY";
  settingsForm.available_drops_check.checked = Boolean(settings.available_drops_check);
  settingsForm.enable_badges_emotes.checked = Boolean(settings.enable_badges_emotes);
  settingsForm.connection_quality.value = settings.connection_quality ?? 0;
  settingsForm.tray_notifications.checked = Boolean(settings.tray_notifications);
  settingsForm.autostart_tray.checked = Boolean(settings.autostart_tray);
}

function renderChannels(channels = []) {
  channelsTable.innerHTML = "";
  if(channels.length === 0) {
    channelsTable.innerHTML = "<tr><td colspan='7' style='text-align:center'>Keine Kanäle gefunden</td></tr>";
    return;
  }
  channels.forEach((ch) => {
    const tr = document.createElement("tr");

    let statusColor = '#adadb8';
    if(ch.status === 'online') statusColor = 'var(--success)';
    if(ch.status === 'offline') statusColor = '#444';

    tr.innerHTML = `
      <td style="font-family:monospace; color: #666;">${ch.id ?? "-"}</td>
      <td><strong>${ch.login ?? "-"}</strong></td>
      <td>${ch.display_name ?? "-"}</td>
      <td><span style="color:${statusColor}">● ${ch.status ?? "-"}</span></td>
      <td>${ch.game ?? "-"}</td>
      <td>${ch.viewers ?? "-"}</td>
      <td>${ch.drops_enabled ? "<i class='fa-solid fa-check' style='color:var(--success)'></i>" : "<i class='fa-solid fa-xmark'></i>"}</td>
    `;
    channelsTable.appendChild(tr);
  });
}

function renderCampaigns(campaigns = []) {
  campaignsTable.innerHTML = "";
  if(campaigns.length === 0) {
    campaignsTable.innerHTML = "<tr><td colspan='6' style='text-align:center'>Keine aktiven Kampagnen</td></tr>";
    return;
  }

  campaigns.forEach((c) => {
    const status = c.active ? "<span style='color:var(--success)'>Aktiv</span>" : c.upcoming ? "Bald" : "Inaktiv";
    const window = [c.starts_at, c.ends_at].filter(Boolean).map(d => new Date(d).toLocaleDateString()).join(" - ");

    let pct = 0;
    if(c.total_drops > 0) {
        pct = Math.round((c.claimed_drops / c.total_drops) * 100);
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${c.name}</td>
      <td>${c.game}</td>
      <td>${status}</td>
      <td>
        <div style="display:flex; align-items:center; gap:8px;">
            <div class="progress-container"><div class="progress-fill" style="width:${pct}%"></div></div>
            <small>${pct}%</small>
        </div>
      </td>
      <td>${c.claimed_drops} / ${c.total_drops}</td>
      <td style="font-size:0.8rem">${window || "-"}</td>
    `;
    campaignsTable.appendChild(tr);
  });
}

function renderRuntime(runtime) {
  stateText.textContent = runtime.state || "Unbekannt";

  const parent = document.querySelector('.status-indicator').parentElement;
  if(runtime.state === 'MINING' || runtime.state === 'WORKING') {
      parent.classList.add('status-mining');
      parent.classList.remove('status-stopped');
  } else {
      parent.classList.remove('status-mining');
      parent.classList.add('status-stopped');
  }

  const watching = runtime.watching;
  if (watching) {
    watchingText.innerHTML = `${watching.display_name || watching.login} <small style='color:var(--accent)'>(${watching.status})</small>`;
  } else {
    watchingText.textContent = "Wartet...";
  }

  if(runtime.pending_switch) {
      pendingSwitchText.textContent = `(Wechsel zu: ${runtime.pending_switch})`;
  } else {
      pendingSwitchText.textContent = "";
  }

  errorsList.innerHTML = "";
  if(!runtime.errors || runtime.errors.length === 0) {
      const li = document.createElement("li");
      li.textContent = "Keine Fehler protokolliert.";
      li.style.color = "#444";
      li.style.listStyle = "none";
      errorsList.appendChild(li);
  } else {
    (runtime.errors || []).forEach((err) => {
        const li = document.createElement("li");
        li.textContent = err;
        li.style.color = "var(--danger)";
        errorsList.appendChild(li);
    });
  }

  renderChannels(runtime.channels);
  renderCampaigns(runtime.campaigns);
}

async function loadSettings() {
  try {
    const settings = await apiGet("/api/settings");
    fillSettings(settings);
  } catch (err) {
    setSettingsStatus(`Laden fehlgeschlagen: ${err.message}`, false);
  }
}

async function pollSnapshot() {
  try {
    const data = await apiGet("/api/snapshot");

    const isUserEditing = settingsForm.contains(document.activeElement);

    if (data.settings && !isUserEditing) {
        fillSettings(data.settings);
    }

    if (data.runtime) renderRuntime(data.runtime);
  } catch (err) {
    console.error("Snapshot failed:", err);
  }
}

function startPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(pollSnapshot, refreshMs);
  pollSnapshot();
}

startBtn.addEventListener("click", async () => {
  try {
    const res = await apiPost("/api/actions/start");
    setActionStatus(`Start: ${res.status}`);
  } catch (err) { setActionStatus(err.message, false); }
});

stopBtn.addEventListener("click", async () => {
  try {
    const res = await apiPost("/api/actions/stop");
    setActionStatus(`Stop: ${res.status}`);
  } catch (err) { setActionStatus(err.message, false); }
});

reloadBtn.addEventListener("click", async () => {
  try {
    const res = await apiPost("/api/actions/reload");
    setActionStatus(`Reload: ${res.status}`);
  } catch (err) { setActionStatus(err.message, false); }
});

switchBtn.addEventListener("click", async () => {
  const value = channelInput.value.trim();
  const payload = { channel: value === "" ? null : isNaN(Number(value)) ? value : Number(value) };
  try {
    const res = await apiPost("/api/actions/switch-channel", payload);
    setActionStatus(`Switch: ${res.status} (${res.channel ?? "auto"})`);
  } catch (err) { setActionStatus(err.message, false); }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = serializeSettings(new FormData(settingsForm));
  try {
    await apiPut("/api/settings", payload);
    setSettingsStatus("Einstellungen gespeichert!");
  } catch (err) { setSettingsStatus(`Fehler: ${err.message}`, false); }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearInterval(pollHandle);
  else startPolling();
});

loadSettings();
startPolling();