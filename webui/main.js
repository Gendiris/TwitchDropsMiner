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
const watchingText = document.getElementById("watchingText");
const pendingSwitchText = document.getElementById("pendingSwitchText");
const lastReloadText = document.getElementById("lastReloadText");
const errorsList = document.getElementById("errorsList");
const channelsTable = document.querySelector("#channelsTable tbody");
const campaignsTable = document.querySelector("#campaignsTable tbody");

let pollHandle;

function setActionStatus(message, ok = true) {
  actionStatus.textContent = message || "";
  actionStatus.style.color = ok ? "#9ea7b3" : "#f85149";
}

function setSettingsStatus(message, ok = true) {
  settingsStatus.textContent = message || "";
  settingsStatus.style.color = ok ? "#9ea7b3" : "#f85149";
}

async function apiPost(path, payload) {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!resp.ok) {
    throw new Error(`Request failed: ${resp.status}`);
  }
  return resp.json();
}

async function apiGet(path) {
  const resp = await fetch(path);
  if (!resp.ok) {
    throw new Error(`Request failed: ${resp.status}`);
  }
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
  const toList = (value) =>
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

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
  channels.forEach((ch) => {
    const tr = document.createElement("tr");
    const pillClass = `pill status-${ch.status || "offline"}`;
    tr.innerHTML = `
      <td>${ch.id ?? "-"}</td>
      <td>${ch.login ?? "-"}</td>
      <td>${ch.display_name ?? "-"}</td>
      <td><span class="${pillClass}">${ch.status ?? "-"}</span></td>
      <td>${ch.game ?? "-"}</td>
      <td>${ch.viewers ?? "-"}</td>
      <td>${ch.drops_enabled ? "Yes" : "No"}</td>
    `;
    channelsTable.appendChild(tr);
  });
}

function renderCampaigns(campaigns = []) {
  campaignsTable.innerHTML = "";
  campaigns.forEach((c) => {
    const status = c.active ? "Active" : c.upcoming ? "Upcoming" : c.eligible ? "Eligible" : "Inactive";
    const window = [c.starts_at, c.ends_at].filter(Boolean).join(" → ");
    const progress = c.total_drops ? Math.round((c.claimed_drops / c.total_drops) * 100) : 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${c.name}</td>
      <td>${c.game}</td>
      <td>${status}</td>
      <td>${progress}%</td>
      <td>${c.claimed_drops} / ${c.total_drops}</td>
      <td>${window || "-"}</td>
    `;
    campaignsTable.appendChild(tr);
  });
}

function renderRuntime(runtime) {
  stateText.textContent = runtime.state || "-";
  const watching = runtime.watching;
  if (watching) {
    watchingText.textContent = `${watching.display_name || watching.login || "Unknown"} (${watching.status})`;
  } else {
    watchingText.textContent = "-";
  }
  pendingSwitchText.textContent = runtime.pending_switch ?? "-";
  lastReloadText.textContent = runtime.last_reload ?? "-";
  errorsList.innerHTML = "";
  (runtime.errors || []).forEach((err) => {
    const li = document.createElement("li");
    li.textContent = err;
    errorsList.appendChild(li);
  });
  renderChannels(runtime.channels);
  renderCampaigns(runtime.campaigns);
}

async function loadSettings() {
  try {
    const settings = await apiGet("/api/settings");
    fillSettings(settings);
  } catch (err) {
    setSettingsStatus(`Failed to load settings: ${err.message}`, false);
  }
}

async function pollSnapshot() {
  try {
    const data = await apiGet("/api/snapshot");
    if (data.settings) {
      fillSettings(data.settings);
    }
    if (data.runtime) {
      renderRuntime(data.runtime);
    }
  } catch (err) {
    setActionStatus(`Snapshot error: ${err.message}`, false);
  }
}

function startPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
  }
  pollHandle = setInterval(pollSnapshot, refreshMs);
  pollSnapshot();
}

startBtn.addEventListener("click", async () => {
  try {
    const res = await apiPost("/api/actions/start");
    setActionStatus(`Start: ${res.status}`);
  } catch (err) {
    setActionStatus(err.message, false);
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    const res = await apiPost("/api/actions/stop");
    setActionStatus(`Stop: ${res.status}`);
  } catch (err) {
    setActionStatus(err.message, false);
  }
});

reloadBtn.addEventListener("click", async () => {
  try {
    const res = await apiPost("/api/actions/reload");
    setActionStatus(`Reload: ${res.status}`);
  } catch (err) {
    setActionStatus(err.message, false);
  }
});

switchBtn.addEventListener("click", async () => {
  const value = channelInput.value.trim();
  const payload = { channel: value === "" ? null : isNaN(Number(value)) ? value : Number(value) };
  try {
    const res = await apiPost("/api/actions/switch-channel", payload);
    setActionStatus(`Switch: ${res.status} (${res.channel ?? "auto"})`);
  } catch (err) {
    setActionStatus(err.message, false);
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = serializeSettings(new FormData(settingsForm));
  try {
    await apiPut("/api/settings", payload);
    setSettingsStatus("Settings saved");
  } catch (err) {
    setSettingsStatus(`Save failed: ${err.message}`, false);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(pollHandle);
  } else {
    startPolling();
  }
});

loadSettings();
startPolling();
