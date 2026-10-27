"use strict";

/**
 * QuickShare — Complete Local P2P & Local HTTP Client
 * Dual-Mode Architecture:
 * 1. Local Network Mode (HTTP Streaming): 100% reliable for same Wi-Fi, hotspot, phone, and TV. Zero timeouts.
 * 2. Online P2P Mode (WebRTC DataChannel): Direct encrypted peer-to-peer using Google STUN for internet networks.
 */

// --- Constants & Configuration ---
const CHUNK_SIZE = 16 * 1024; // 16 KB per WebRTC SCTP chunk
const MAX_BUFFER = 1024 * 1024; // 1 MB backpressure ceiling
const DRAIN_THRESHOLD = 64 * 1024; // 64 KB low buffer threshold

const ONLINE_RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

// --- DOM References ---
const $ = (id) => document.getElementById(id);

const connectionDot = $("connectionDot");
const connectionText = $("connectionText");
const myDevice = $("myDevice");
const nameInput = $("deviceName");
const saveNameBtn = $("saveName");

// Mode selector
const modeLocalRadio = $("modeLocal");
const modeWebRTCRadio = $("modeWebRTC");
const localModeLabel = $("localModeLabel");
const webrtcModeLabel = $("webrtcModeLabel");
const currentModeBadge = $("currentModeBadge");

// Device & Files
const deviceCount = $("deviceCount");
const deviceList = $("deviceList");
const fileCount = $("fileCount");
const fileInput = $("fileInput");
const dropZone = $("dropZone");
const fileList = $("fileList");

// Transfer & Progress
const transferStatus = $("transferStatus");
const progressWrap = $("progressWrap");
const progressBar = $("progressBar");
const progressPercent = $("progressPercent");
const transferSpeed = $("transferSpeed");
const transferDetails = $("transferDetails");
const sendButton = $("sendButton");
const cancelButton = $("cancelButton");

// Modals
const incomingModal = $("incomingModal");
const incomingTitle = $("incomingTitle");
const incomingDesc = $("incomingDesc");
const incomingFilesList = $("incomingFilesList");
const acceptRequestBtn = $("acceptRequestBtn");
const rejectRequestBtn = $("rejectRequestBtn");

const showQrBtn = $("showQrBtn");
const qrModal = $("qrModal");
const closeQrModalBtn = $("closeQrModalBtn");
const qrSvgContainer = $("qrSvgContainer");
const qrUrlDisplay = $("qrUrlDisplay");
const copyUrlBtn = $("copyUrlBtn");
const copyStatusText = $("copyStatusText");

// Received Files
const receivedCard = $("receivedCard");
const receivedBadge = $("receivedBadge");
const receivedList = $("receivedList");

// Diagnostics
const toggleDiagBtn = $("toggleDiagBtn");
const diagDrawer = $("diagDrawer");
const diagChevron = $("diagChevron");
const diagStatusSummary = $("diagStatusSummary");
const clearDiagBtn = $("clearDiagBtn");
const diagLogBox = $("diagLogBox");

// --- Application State ---
const socket = io();
let devices = [];
let selectedDevice = null;
let selectedFiles = [];
let receivedFiles = []; // { id, name, size, type, blob, url }

let peer = null;
let channel = null;
let currentXhr = null; // for local HTTP abort
let currentStreamReader = null;
let isTransferBusy = false;
let isCancelled = false;
let activeTransferSessionId = null;

let pendingIncoming = null; // { fromId, fromName, filesInfo, mode }
let incomingSafetyTimer = null;
const earlyCandidatesQueue = new Map(); // targetId -> Array of candidate
let serverNetworkUrls = [];
let iceWatchdogTimer = null;

// Speed tracking state
let speedTrackingInterval = null;
let lastProgressBytes = 0;
let lastProgressTime = Date.now();
const diagLogs = [];

// --- Diagnostic Logging ---
function logDiag(category, message, isError = false) {
  const ts = new Date().toTimeString().split(" ")[0];
  const logLine = `[${ts}] [${category}] ${message}`;
  diagLogs.push(logLine);
  if (diagLogs.length > 200) diagLogs.shift();
  if (diagLogBox) {
    diagLogBox.textContent = diagLogs.join("\n");
    diagLogBox.scrollTop = diagLogBox.scrollHeight;
  }
  if (diagStatusSummary) {
    diagStatusSummary.textContent = `${category}: ${message.slice(0, 50)}`;
  }
  if (isError) {
    console.error("[QuickShare]", logLine);
  } else {
    console.log("[QuickShare]", logLine);
  }
}

// --- Utilities ---
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  if (!bytes || isNaN(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getStoredDeviceName() {
  const saved = localStorage.getItem("quickshare-device-name");
  if (saved && saved.trim()) return saved.trim();
  const platform = navigator.userAgentData?.platform || navigator.platform || "Device";
  const randomSuffix = Math.floor(100 + Math.random() * 900);
  return `${platform} (${randomSuffix})`;
}

function getTransferMode() {
  return modeWebRTCRadio && modeWebRTCRadio.checked ? "webrtc" : "local";
}

function updateModeUI() {
  const mode = getTransferMode();
  if (mode === "local") {
    localModeLabel.classList.add("selected");
    webrtcModeLabel.classList.remove("selected");
    currentModeBadge.textContent = "Local Network (HTTP)";
    currentModeBadge.className = "mode-badge mode-badge-local";
    logDiag("Config", "Selected Transfer Mode: Local Network (HTTP Streaming)");
  } else {
    localModeLabel.classList.remove("selected");
    webrtcModeLabel.classList.add("selected");
    currentModeBadge.textContent = "Online P2P (WebRTC)";
    currentModeBadge.className = "mode-badge mode-badge-webrtc";
    logDiag("Config", "Selected Transfer Mode: Online P2P (WebRTC DataChannel)");
  }
}

function setStatus(message, kind = "") {
  transferStatus.textContent = message;
  transferStatus.className = `transfer-status ${kind}`;
}

function showProgress(show = true) {
  if (show) {
    progressWrap.classList.remove("hidden");
    cancelButton.classList.remove("hidden");
  } else {
    progressWrap.classList.add("hidden");
    cancelButton.classList.add("hidden");
    progressBar.style.width = "0%";
    progressPercent.textContent = "0%";
    transferSpeed.textContent = "0 KB/s";
    transferDetails.textContent = "0 B / 0 B";
    stopSpeedTracking();
  }
}

function updateProgress(percent, details = "") {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  progressBar.style.width = `${clamped}%`;
  progressPercent.textContent = `${clamped}%`;
  if (details) transferDetails.textContent = details;
}

function startSpeedTracking(getCurrentBytes) {
  stopSpeedTracking();
  lastProgressBytes = getCurrentBytes();
  lastProgressTime = Date.now();
  speedTrackingInterval = setInterval(() => {
    const now = Date.now();
    const currentBytes = getCurrentBytes();
    const timeDelta = (now - lastProgressTime) / 1000;
    if (timeDelta >= 0.5) {
      const bytesDelta = currentBytes - lastProgressBytes;
      const bytesPerSec = bytesDelta / timeDelta;
      transferSpeed.textContent = `${formatBytes(bytesPerSec)}/s`;
      lastProgressBytes = currentBytes;
      lastProgressTime = now;
    }
  }, 500);
}

function stopSpeedTracking() {
  if (speedTrackingInterval) {
    clearInterval(speedTrackingInterval);
    speedTrackingInterval = null;
  }
}

function updateButton() {
  if (isTransferBusy) {
    sendButton.disabled = true;
    sendButton.textContent = "Transfer in progress…";
  } else if (!selectedDevice) {
    sendButton.disabled = true;
    sendButton.textContent = "Choose a device to send";
  } else if (!selectedFiles.length) {
    sendButton.disabled = true;
    sendButton.textContent = `Send to ${selectedDevice.name}`;
  } else {
    sendButton.disabled = false;
    sendButton.textContent = `Send ${selectedFiles.length} ${selectedFiles.length === 1 ? "file" : "files"} to ${selectedDevice.name}`;
  }
}

// --- Devices UI ---
function renderDevices() {
  const others = devices.filter((d) => d.id !== socket.id);
  deviceCount.textContent = `${others.length} ${others.length === 1 ? "found" : "found"}`;

  if (selectedDevice && !others.some((d) => d.id === selectedDevice.id)) {
    selectedDevice = null;
  }

  deviceList.replaceChildren();

  if (!others.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Looking for devices on your network… Open QuickShare on another phone, TV, or laptop.";
    deviceList.append(empty);
  } else {
    for (const device of others) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `device-row${selectedDevice?.id === device.id ? " selected" : ""}`;
      button.setAttribute("aria-pressed", String(selectedDevice?.id === device.id));

      const icon = document.createElement("span");
      icon.className = "device-icon small";
      icon.textContent = "▣";

      const label = document.createElement("span");
      label.className = "device-label";
      label.textContent = device.name;

      const arrow = document.createElement("span");
      arrow.className = "device-arrow";
      arrow.textContent = selectedDevice?.id === device.id ? "✓" : "›";

      button.append(icon, label, arrow);
      button.addEventListener("click", () => {
        if (isTransferBusy) return;
        selectedDevice = device;
        logDiag("Discovery", `Selected target peer: ${device.name} (${device.id})`);
        renderDevices();
        updateButton();
      });

      deviceList.append(button);
    }
  }
  updateButton();
}

// --- Files Selection UI ---
function renderFiles() {
  fileCount.textContent = `${selectedFiles.length} selected`;
  fileList.replaceChildren();

  selectedFiles.forEach((file, index) => {
    const item = document.createElement("li");

    const info = document.createElement("span");
    info.textContent = `${file.name} · ${formatBytes(file.size)}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-file";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.textContent = "×";
    remove.disabled = isTransferBusy;
    remove.addEventListener("click", () => {
      selectedFiles.splice(index, 1);
      renderFiles();
      updateButton();
    });

    item.append(info, remove);
    fileList.append(item);
  });
  updateButton();
}

// --- Received Files UI ---
function addReceivedFile(name, size, type, blob, directDownloadUrl = "") {
  const url = blob ? URL.createObjectURL(blob) : directDownloadUrl;
  const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  receivedFiles.unshift({ id, name, size, type, blob, url });
  logDiag("Receiver", `File verified and ready for download: ${name} (${formatBytes(size)})`);
  renderReceivedFiles();
}

function renderReceivedFiles() {
  receivedBadge.textContent = `${receivedFiles.length} ${receivedFiles.length === 1 ? "file" : "files"}`;
  receivedList.replaceChildren();

  if (receivedFiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Files sent to this device will appear here ready to download.";
    receivedList.append(empty);
    return;
  }

  receivedFiles.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "received-item";

    const info = document.createElement("div");
    info.className = "received-item-info";

    const nameEl = document.createElement("div");
    nameEl.className = "received-item-name";
    nameEl.textContent = item.name;
    nameEl.title = item.name;

    const metaEl = document.createElement("div");
    metaEl.className = "received-item-meta";
    metaEl.innerHTML = `<span>${formatBytes(item.size)}</span><span class="verified-badge">Verified ✓</span>`;

    info.append(nameEl, metaEl);

    const actions = document.createElement("div");
    actions.className = "received-item-actions";

    // Direct manual download button
    const dlBtn = document.createElement("a");
    dlBtn.className = "download-button";
    dlBtn.href = item.url;
    dlBtn.download = item.name;
    dlBtn.textContent = "Download";
    dlBtn.setAttribute("role", "button");
    dlBtn.setAttribute("aria-label", `Download ${item.name}`);

    // Remove / Revoke memory button
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "item-remove-btn";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove and free memory";
    removeBtn.setAttribute("aria-label", `Remove ${item.name}`);
    removeBtn.addEventListener("click", () => {
      try {
        if (item.blob) URL.revokeObjectURL(item.url);
      } catch (_) {}
      receivedFiles.splice(index, 1);
      renderReceivedFiles();
    });

    actions.append(dlBtn, removeBtn);
    row.append(info, actions);
    receivedList.append(row);
  });
}

// --- Sender Workflow Initiation ---
sendButton.addEventListener("click", () => {
  if (!selectedDevice || !selectedFiles.length || isTransferBusy) return;

  const mode = getTransferMode();
  isTransferBusy = true;
  isCancelled = false;
  earlyCandidatesQueue.clear();
  updateButton();
  showProgress(true);

  const modeName = mode === "local" ? "Local Network (HTTP)" : "Online P2P (WebRTC)";
  setStatus(`Requesting permission from ${selectedDevice.name} [${modeName}]…`);
  logDiag("Sender", `Initiating transfer to ${selectedDevice.name} (${selectedFiles.length} files) using ${modeName}`);

  const filesInfo = selectedFiles.map((f, i) => ({
    id: `f_${i}_${Date.now()}`,
    name: f.name,
    size: f.size,
    type: f.type || "application/octet-stream"
  }));

  socket.emit("connection-request", {
    targetId: selectedDevice.id,
    filesInfo,
    mode
  });
});

// --- Receiver Handshake UI ---
function handleIncomingRequest(payload) {
  pendingIncoming = payload;
  const { fromName, filesInfo, mode } = payload;
  const count = filesInfo?.length || 0;
  const totalSize = (filesInfo || []).reduce((sum, f) => sum + (f.size || 0), 0);
  const modeLabel = mode === "webrtc" ? "Online WebRTC P2P" : "Local Network";

  logDiag("Receiver", `Incoming transfer request from ${fromName} (${count} files, ${formatBytes(totalSize)}) via ${modeLabel}`);

  incomingTitle.textContent = `Incoming Transfer (${modeLabel})`;
  incomingDesc.textContent = `${fromName} wants to send ${count} ${count === 1 ? "file" : "files"} (${formatBytes(totalSize)}):`;
  incomingFilesList.replaceChildren();

  (filesInfo || []).forEach((f) => {
    const li = document.createElement("li");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = f.name;
    const sizeSpan = document.createElement("span");
    sizeSpan.textContent = formatBytes(f.size);
    li.append(nameSpan, sizeSpan);
    incomingFilesList.append(li);
  });

  incomingModal.classList.remove("hidden");
  setTimeout(() => acceptRequestBtn.focus(), 50);

  clearTimeout(incomingSafetyTimer);
  incomingSafetyTimer = setTimeout(() => {
    if (!incomingModal.classList.contains("hidden")) {
      rejectIncoming("Request timed out without a response.");
    }
  }, 45000);
}

acceptRequestBtn.addEventListener("click", () => {
  if (!pendingIncoming) return;
  clearTimeout(incomingSafetyTimer);
  const { fromId, fromName, mode, filesInfo } = pendingIncoming;
  incomingModal.classList.add("hidden");

  isTransferBusy = true;
  isCancelled = false;
  earlyCandidatesQueue.clear();
  updateButton();
  showProgress(true);
  setStatus(`Accepted request from ${fromName}. Connecting…`);
  logDiag("Receiver", `Accepted request from ${fromName}. Setting up ${mode} receiver.`);

  if (mode === "webrtc") {
    setupWebRTCReceiver(fromId, fromName);
  }

  socket.emit("connection-response", {
    targetId: fromId,
    accepted: true,
    mode
  });
});

rejectRequestBtn.addEventListener("click", () => {
  rejectIncoming("Receiver declined the transfer.");
});

function rejectIncoming(reason) {
  clearTimeout(incomingSafetyTimer);
  if (pendingIncoming) {
    logDiag("Receiver", `Declined transfer from ${pendingIncoming.fromName}: ${reason}`);
    socket.emit("connection-response", {
      targetId: pendingIncoming.fromId,
      accepted: false,
      reason
    });
    pendingIncoming = null;
  }
  incomingModal.classList.add("hidden");
}

// =========================================================================
// MODE 1: LOCAL NETWORK TRANSFER (HTTP STREAMING - 100% RELIABLE OFFLINE)
// =========================================================================

async function executeLocalHttpSender(targetId, targetName) {
  logDiag("Sender:Local", `Starting HTTP upload session for ${selectedFiles.length} files`);
  setStatus(`Initializing transfer with ${targetName}…`);

  const filesMeta = selectedFiles.map((f, i) => ({
    id: `file_${i}_${Date.now()}`,
    name: f.name,
    size: f.size,
    type: f.type || "application/octet-stream"
  }));

  try {
    const initRes = await fetch("/api/transfer/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        senderId: socket.id,
        targetId,
        files: filesMeta
      })
    });

    if (!initRes.ok) {
      throw new Error(`Failed to initialize transfer session (HTTP ${initRes.status})`);
    }

    const { transferId } = await initRes.json();
    activeTransferSessionId = transferId;
    logDiag("Sender:Local", `Transfer session created: ${transferId}`);

    const totalBatchBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
    let cumulativeBytesUploaded = 0;

    startSpeedTracking(() => cumulativeBytesUploaded);

    for (let i = 0; i < selectedFiles.length; i++) {
      if (isCancelled) break;
      const file = selectedFiles[i];
      const meta = filesMeta[i];

      logDiag("Sender:Local", `Uploading file ${i + 1}/${selectedFiles.length}: ${file.name} (${formatBytes(file.size)})`);
      setStatus(`Uploading ${file.name} to local transfer buffer (${i + 1}/${selectedFiles.length})…`);

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        currentXhr = xhr;

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const currentTotal = cumulativeBytesUploaded + e.loaded;
            const percent = totalBatchBytes > 0 ? (currentTotal / totalBatchBytes) * 100 : 100;
            updateProgress(
              percent,
              `${formatBytes(currentTotal)} / ${formatBytes(totalBatchBytes)} (${file.name})`
            );
          }
        };

        xhr.onload = () => {
          currentXhr = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            cumulativeBytesUploaded += file.size;
            logDiag("Sender:Local", `Uploaded: ${file.name} ✓`);
            resolve();
          } else {
            reject(new Error(`Server upload error: HTTP ${xhr.status}`));
          }
        };

        xhr.onerror = () => {
          currentXhr = null;
          reject(new Error("Network connection dropped during upload."));
        };

        xhr.onabort = () => {
          currentXhr = null;
          reject(new Error("Upload cancelled."));
        };

        xhr.open("POST", `/api/transfer/upload/${transferId}/${meta.id}`);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.send(file);
      });
    }

    if (!isCancelled) {
      logDiag("Sender:Local", "All files uploaded to local server. Waiting for receiver to download.");
      setStatus("Files delivered to local transfer buffer. Waiting for receiver…");
    }
  } catch (err) {
    if (!isCancelled) {
      logDiag("Sender:Local", `Transfer error: ${err.message}`, true);
      abortTransfer(`Transfer error: ${err.message}`);
    }
  }
}

// Receiver side for Local HTTP
socket.on("local-transfer-ready", ({ transferId, senderName, files }) => {
  logDiag("Receiver:Local", `Local transfer session ready: ${transferId} (${files.length} files) from ${senderName}`);
  activeTransferSessionId = transferId;
  setStatus(`Receiving files from ${senderName}…`);
  showProgress(true);
});

socket.on("local-file-available", async ({ transferId, fileId, name, size, type }) => {
  logDiag("Receiver:Local", `File available to download: ${name} (${formatBytes(size)})`);
  setStatus(`Downloading ${name}…`);

  try {
    const downloadUrl = `/api/transfer/download/${transferId}/${fileId}`;
    const response = await fetch(downloadUrl);

    if (!response.ok) {
      throw new Error(`Failed to download ${name} (HTTP ${response.status})`);
    }

    const reader = response.body.getReader();
    currentStreamReader = reader;
    const chunks = [];
    let receivedBytes = 0;

    startSpeedTracking(() => receivedBytes);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      receivedBytes += value.byteLength;
      const percent = size > 0 ? (receivedBytes / size) * 100 : 100;
      updateProgress(percent, `${formatBytes(receivedBytes)} / ${formatBytes(size)} (${name})`);
    }

    currentStreamReader = null;

    if (receivedBytes !== size) {
      throw new Error(`Byte verification mismatch: expected ${size} B, received ${receivedBytes} B`);
    }

    const blob = new Blob(chunks, { type: type || "application/octet-stream" });
    addReceivedFile(name, blob.size, type, blob, downloadUrl);
    logDiag("Receiver:Local", `Successfully received and verified ${name} (${formatBytes(blob.size)}) ✓`);

    // Acknowledge back to sender
    if (pendingIncoming) {
      socket.emit("transfer-batch-complete", {
        targetId: pendingIncoming.fromId,
        receivedCount: receivedFiles.length
      });
      isTransferBusy = false;
      showProgress(false);
      updateButton();
      setStatus(`Successfully received files from ${pendingIncoming.fromName}!`, "success");
      pendingIncoming = null;
    }
  } catch (err) {
    logDiag("Receiver:Local", `Download failed: ${err.message}`, true);
    abortTransfer(`Download error: ${err.message}`);
  }
});

socket.on("transfer-batch-complete", () => {
  logDiag("Sender", "Receiver acknowledged complete receipt and byte verification of all files ✓");
  isTransferBusy = false;
  showProgress(false);
  updateButton();
  setStatus(`Successfully sent files to ${selectedDevice?.name || "device"}!`, "success");
});

// =========================================================================
// MODE 2: ONLINE WEBRTC P2P TRANSFER (FIXED DATACHANNEL & EVENT LISTENERS)
// =========================================================================

function closePeer() {
  clearWatchdogs();
  stopSpeedTracking();
  if (channel) {
    try { channel.close(); } catch (_) {}
    channel = null;
  }
  if (peer) {
    try { peer.close(); } catch (_) {}
    peer = null;
  }
}

function clearWatchdogs() {
  if (iceWatchdogTimer) {
    clearTimeout(iceWatchdogTimer);
    iceWatchdogTimer = null;
  }
}

function armIceWatchdog(targetName, timeoutMs = 15000) {
  clearWatchdogs();
  iceWatchdogTimer = setTimeout(() => {
    if (!peer || ["connected", "completed"].includes(peer.iceConnectionState) || channel?.readyState === "open") {
      return;
    }
    const state = peer?.iceConnectionState || "unknown";
    const msg = `WebRTC direct connection to ${targetName} timed out (ICE state: ${state}). If on the same Wi-Fi or hotspot, switch to Local Network Mode.`;
    logDiag("WebRTC:Watchdog", msg, true);
    if (isTransferBusy) abortTransfer(msg, true);
  }, timeoutMs);
}

function createPeer(targetId, targetName) {
  closePeer();
  logDiag("WebRTC", `Creating RTCPeerConnection for ${targetName} (${targetId})`);
  peer = new RTCPeerConnection(ONLINE_RTC_CONFIG);

  peer.onicecandidate = ({ candidate }) => {
    if (candidate && socket.connected) {
      logDiag("WebRTC", `Gathered ICE candidate (${candidate.type || "host"})`);
      socket.emit("webrtc-ice-candidate", {
        targetId,
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          usernameFragment: candidate.usernameFragment || undefined
        }
      });
    }
  };

  peer.oniceconnectionstatechange = () => {
    const iceState = peer?.iceConnectionState;
    logDiag("WebRTC", `ICE state changed to: ${iceState}`);
    if (iceState === "connected" || iceState === "completed") {
      clearWatchdogs();
    } else if (iceState === "failed" && isTransferBusy) {
      abortTransfer("Direct ICE connection failed. Switch to Local Network Mode if on same Wi-Fi.", true);
    }
  };

  peer.onconnectionstatechange = () => {
    const connState = peer?.connectionState;
    logDiag("WebRTC", `Peer connection state: ${connState}`);
    if (connState === "connected") {
      clearWatchdogs();
    } else if (["failed", "disconnected", "closed"].includes(connState) && isTransferBusy) {
      abortTransfer("WebRTC peer connection lost.", true);
    }
  };

  return peer;
}

// Non-overwriting Channel Open Listener
function waitForChannelOpen(dataChannel, timeoutMs = 15000) {
  if (!dataChannel) return Promise.reject(new Error("No DataChannel provided"));
  if (dataChannel.readyState === "open") return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for direct WebRTC channel to open. Check network firewall or switch to Local Network Mode."));
    }, timeoutMs);

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (e) => {
      cleanup();
      reject(new Error(`DataChannel error: ${e?.message || "Channel failed to open"}`));
    };

    function cleanup() {
      clearTimeout(timer);
      dataChannel.removeEventListener("open", onOpen);
      dataChannel.removeEventListener("error", onError);
    }

    dataChannel.addEventListener("open", onOpen);
    dataChannel.addEventListener("error", onError);
  });
}

function waitForBuffer(dataChannel, timeoutMs = 15000) {
  if (!dataChannel || dataChannel.readyState !== "open") {
    return Promise.reject(new Error("DataChannel is closed."));
  }
  if (dataChannel.bufferedAmount <= MAX_BUFFER / 2) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      cleanup();
      if (dataChannel && dataChannel.bufferedAmount <= MAX_BUFFER) resolve();
      else reject(new Error("Buffer drain timed out. Connection stalled."));
    }, timeoutMs);

    const onLow = () => {
      cleanup();
      resolve();
    };

    function cleanup() {
      clearTimeout(timer);
      dataChannel.removeEventListener("bufferedamountlow", onLow);
    }

    dataChannel.bufferedAmountLowThreshold = DRAIN_THRESHOLD;
    dataChannel.addEventListener("bufferedamountlow", onLow);
  });
}

function flushQueuedCandidates(targetId) {
  const queued = earlyCandidatesQueue.get(targetId) || [];
  earlyCandidatesQueue.delete(targetId);
  if (!peer || !queued.length) return;
  logDiag("WebRTC", `Flushing ${queued.length} queued early ICE candidate(s)`);
  queued.forEach(async (cand) => {
    try { await peer.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
  });
}

async function executeWebRTCSender(targetId, targetName) {
  setStatus(`Establishing direct WebRTC channel to ${targetName}…`);
  logDiag("Sender:WebRTC", `Initiating WebRTC offer for ${targetName}`);
  armIceWatchdog(targetName, 15000);

  try {
    const connection = createPeer(targetId, targetName);
    channel = connection.createDataChannel("quickshare-files");
    channel.binaryType = "arraybuffer";

    // Setup channel message & close listeners
    setupSenderChannelListeners(channel, targetName);

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);

    logDiag("Sender:WebRTC", "Offer created and set as local description. Sending offer via signaling.");
    socket.emit("webrtc-offer", {
      targetId,
      offer: { type: connection.localDescription.type, sdp: connection.localDescription.sdp }
    });

    // Wait for channel to open without overwriting channel listeners
    await waitForChannelOpen(channel, 15000);
    clearWatchdogs();
    logDiag("Sender:WebRTC", "DataChannel is open! Streaming files directly P2P.");

    // Now stream the files over the opened channel
    await streamFilesOverDataChannel(channel, targetName);
  } catch (err) {
    logDiag("Sender:WebRTC", `WebRTC transfer failed: ${err.message}`, true);
    abortTransfer(err.message, true);
  }
}

function setupSenderChannelListeners(dc, targetName) {
  dc.addEventListener("error", (e) => {
    if (isTransferBusy) abortTransfer(`DataChannel error: ${e?.message || "Unknown error"}`);
  });

  dc.addEventListener("close", () => {
    logDiag("Sender:WebRTC", "DataChannel closed");
    if (isTransferBusy && !isCancelled) {
      abortTransfer("Transfer interrupted: WebRTC channel closed prematurely.", true);
    }
  });

  dc.addEventListener("message", ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "batch-complete") {
        logDiag("Sender:WebRTC", "Receiver acknowledged batch completion and byte verification ✓");
        isTransferBusy = false;
        showProgress(false);
        updateButton();
        setStatus(`Successfully sent ${selectedFiles.length} ${selectedFiles.length === 1 ? "file" : "files"} to ${targetName}!`, "success");
        closePeer();
      } else if (msg.type === "transfer-cancel") {
        handleTransferCancelled(msg.reason || "Receiver cancelled the transfer.");
      }
    } catch (_) {}
  });
}

async function streamFilesOverDataChannel(dc, targetName) {
  setStatus(`Sending files directly to ${targetName}…`);
  const totalBatchBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
  let cumulativeBytesSent = 0;

  startSpeedTracking(() => cumulativeBytesSent);

  try {
    // Announce batch
    dc.send(JSON.stringify({
      type: "batch-start",
      totalFiles: selectedFiles.length,
      totalBytes: totalBatchBytes
    }));

    for (let i = 0; i < selectedFiles.length; i++) {
      if (isCancelled) break;
      const file = selectedFiles[i];
      const fileId = `file-${i}-${Date.now()}`;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 0;

      logDiag("Sender:WebRTC", `Streaming file ${i + 1}/${selectedFiles.length}: ${file.name} (${formatBytes(file.size)})`);

      dc.send(JSON.stringify({
        type: "file-start",
        id: fileId,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        totalChunks
      }));

      let fileSent = 0;

      // Empty 0-byte file handling
      if (file.size === 0) {
        dc.send(JSON.stringify({
          type: "file-end",
          id: fileId,
          checksumBytes: 0,
          totalChunks: 0
        }));
        continue;
      }

      while (fileSent < file.size) {
        if (isCancelled) break;
        await waitForBuffer(dc);
        const sliceEnd = Math.min(fileSent + CHUNK_SIZE, file.size);
        const chunk = await file.slice(fileSent, sliceEnd).arrayBuffer();
        dc.send(chunk);
        fileSent += chunk.byteLength;
        cumulativeBytesSent += chunk.byteLength;

        const percent = totalBatchBytes > 0 ? (cumulativeBytesSent / totalBatchBytes) * 100 : 100;
        updateProgress(
          percent,
          `${formatBytes(cumulativeBytesSent)} / ${formatBytes(totalBatchBytes)} (${file.name})`
        );
      }

      if (isCancelled) break;

      dc.send(JSON.stringify({
        type: "file-end",
        id: fileId,
        checksumBytes: fileSent,
        totalChunks
      }));
    }

    if (!isCancelled) {
      dc.send(JSON.stringify({ type: "batch-end" }));
      setStatus("Verifying delivery with receiver…");
      logDiag("Sender:WebRTC", "Finished sending chunks. Waiting for receiver verification.");
    }
  } catch (err) {
    if (!isCancelled) abortTransfer(`WebRTC streaming error: ${err.message}`, true);
  }
}

function setupWebRTCReceiver(fromId, fromName) {
  logDiag("Receiver:WebRTC", `Preparing receiver peer connection for ${fromName}`);
  armIceWatchdog(fromName, 15000);

  const connection = createPeer(fromId, fromName);
  connection.ondatachannel = ({ channel: incoming }) => {
    logDiag("Receiver:WebRTC", "Received incoming DataChannel from peer!");
    channel = incoming;
    channel.binaryType = "arraybuffer";
    setupReceiverChannel(channel, fromName);
  };
}

function setupReceiverChannel(dc, senderName) {
  let currentFile = null;
  let receivedChunks = [];
  let fileBytesReceived = 0;
  let batchTotalBytes = 0;
  let batchCumulativeReceived = 0;

  startSpeedTracking(() => batchCumulativeReceived);

  dc.addEventListener("error", (e) => {
    if (isTransferBusy) abortTransfer(`DataChannel error: ${e?.message || "Unknown error"}`);
  });

  dc.addEventListener("open", () => {
    clearWatchdogs();
    logDiag("Receiver:WebRTC", "DataChannel is open and ready to receive chunks");
    setStatus(`Receiving files directly from ${senderName}…`);
  });

  dc.addEventListener("message", ({ data }) => {
    if (typeof data === "string") {
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }

      if (msg.type === "batch-start") {
        batchTotalBytes = msg.totalBytes || 0;
        batchCumulativeReceived = 0;
        logDiag("Receiver:WebRTC", `Batch started: ${msg.totalFiles} files, ${formatBytes(batchTotalBytes)}`);
      } else if (msg.type === "file-start") {
        currentFile = {
          id: msg.id,
          name: String(msg.name || "download").split(/[\\/]/).pop(),
          size: Number(msg.size) || 0,
          mime: msg.mime || "application/octet-stream",
          totalChunks: Number(msg.totalChunks) || 0
        };
        receivedChunks = [];
        fileBytesReceived = 0;
        logDiag("Receiver:WebRTC", `Receiving file: ${currentFile.name} (${formatBytes(currentFile.size)})`);
        setStatus(`Receiving ${currentFile.name} from ${senderName}…`);
      } else if (msg.type === "file-end" && currentFile) {
        // Integrity Byte Verification
        const expectedSize = currentFile.size;
        const verifiedSent = Number(msg.checksumBytes) || 0;

        if (fileBytesReceived !== expectedSize || verifiedSent !== expectedSize) {
          const err = `Integrity error for ${currentFile.name}: expected ${expectedSize} B, received ${fileBytesReceived} B.`;
          logDiag("Receiver:WebRTC", err, true);
          abortTransfer(err);
          return;
        }

        const blob = new Blob(receivedChunks, { type: currentFile.mime });
        addReceivedFile(currentFile.name, blob.size, currentFile.mime, blob);
        currentFile = null;
        receivedChunks = [];
      } else if (msg.type === "batch-end") {
        logDiag("Receiver:WebRTC", "Batch ended. Sending batch-complete acknowledgement to sender.");
        if (dc.readyState === "open") {
          try {
            dc.send(JSON.stringify({ type: "batch-complete", verifiedBytes: batchCumulativeReceived }));
          } catch (_) {}
        }
        isTransferBusy = false;
        showProgress(false);
        updateButton();
        setStatus(`Successfully received all files from ${senderName}!`, "success");
        closePeer();
      } else if (msg.type === "transfer-cancel") {
        handleTransferCancelled(msg.reason || "Sender cancelled the transfer.");
      }
    } else {
      // Binary chunk
      if (currentFile) {
        receivedChunks.push(data);
        fileBytesReceived += data.byteLength;
        batchCumulativeReceived += data.byteLength;

        const percent = batchTotalBytes > 0 ? (batchCumulativeReceived / batchTotalBytes) * 100 : 100;
        updateProgress(
          percent,
          `${formatBytes(batchCumulativeReceived)} / ${formatBytes(batchTotalBytes)} (${currentFile.name})`
        );
      }
    }
  });

  dc.addEventListener("close", () => {
    logDiag("Receiver:WebRTC", "DataChannel closed");
    if (isTransferBusy && currentFile) {
      abortTransfer("Transfer interrupted: Connection closed before completion.", true);
    }
  });
}

// --- Cancellation & Cleanup ---
cancelButton.addEventListener("click", () => {
  if (!isTransferBusy) return;
  const reason = "Transfer cancelled by user.";
  logDiag("Transfer", reason);

  // Cancel HTTP transfer if in progress
  if (currentXhr) {
    try { currentXhr.abort(); } catch (_) {}
    currentXhr = null;
  }
  if (currentStreamReader) {
    try { currentStreamReader.cancel(); } catch (_) {}
    currentStreamReader = null;
  }
  if (activeTransferSessionId) {
    fetch(`/api/transfer/cancel/${activeTransferSessionId}`, { method: "POST" }).catch(() => {});
  }

  // Cancel WebRTC channel
  if (channel && channel.readyState === "open") {
    try { channel.send(JSON.stringify({ type: "transfer-cancel", reason })); } catch (_) {}
  } else if (selectedDevice && socket.connected) {
    socket.emit("transfer-cancel", { targetId: selectedDevice.id, reason });
  }

  handleTransferCancelled(reason);
});

function abortTransfer(errorMessage, offerLocalFallback = false) {
  isTransferBusy = false;
  isCancelled = true;
  closePeer();
  showProgress(false);
  updateButton();

  if (offerLocalFallback && getTransferMode() === "webrtc") {
    transferStatus.innerHTML = `${errorMessage} <button id="switchToLocalBtn" class="quiet-button small" style="margin-left:8px;vertical-align:middle;">Switch to Local Mode & Retry</button>`;
    transferStatus.className = "transfer-status error";
    const switchBtn = $("switchToLocalBtn");
    if (switchBtn) {
      switchBtn.addEventListener("click", () => {
        modeLocalRadio.checked = true;
        updateModeUI();
        setStatus("Switched to Local Network Mode. Click Send Files to retry.", "success");
      });
    }
  } else {
    setStatus(errorMessage, "error");
  }
}

function handleTransferCancelled(reason) {
  isTransferBusy = false;
  isCancelled = true;
  closePeer();
  showProgress(false);
  updateButton();
  setStatus(reason, "error");
}

// --- Socket.IO Event Handlers ---
socket.on("connect", () => {
  connectionText.textContent = "Connected";
  connectionDot.classList.add("online");
  const name = getStoredDeviceName();
  nameInput.value = name;
  myDevice.textContent = name;
  logDiag("Socket", `Connected with socket ID: ${socket.id}`);
  socket.emit("register-device", name);
});

socket.on("session-info", ({ networkUrls } = {}) => {
  if (Array.isArray(networkUrls) && networkUrls.length > 0) {
    serverNetworkUrls = networkUrls;
    logDiag("Network", `Available server URLs: ${networkUrls.join(", ")}`);
  }
});

socket.on("disconnect", () => {
  connectionText.textContent = "Reconnecting…";
  connectionDot.classList.remove("online");
  logDiag("Socket", "Disconnected from server. Reconnecting…", true);
});

socket.on("devices-updated", (list) => {
  devices = Array.isArray(list) ? list : [];
  renderDevices();
});

socket.on("server-error", ({ message } = {}) => {
  logDiag("Server", `Server error: ${message}`, true);
  setStatus(typeof message === "string" ? message : "Server error.", "error");
});

socket.on("connection-request", (payload) => {
  handleIncomingRequest(payload);
});

socket.on("connection-response", async ({ fromId, accepted, reason, mode }) => {
  if (!isTransferBusy) return;
  if (!accepted) {
    isTransferBusy = false;
    showProgress(false);
    updateButton();
    const msg = reason || "Connection request was declined by receiver.";
    logDiag("Sender", msg, true);
    setStatus(msg, "error");
    return;
  }

  logDiag("Sender", `Transfer request accepted! Launching ${mode || "local"} transfer.`);

  if (mode === "webrtc") {
    await executeWebRTCSender(fromId, selectedDevice?.name || "device");
  } else {
    await executeLocalHttpSender(fromId, selectedDevice?.name || "device");
  }
});

socket.on("transfer-cancel", ({ reason } = {}) => {
  handleTransferCancelled(reason || "Peer cancelled the transfer.");
});

// WebRTC Signaling Events
socket.on("webrtc-offer", async ({ fromId, fromName, offer }) => {
  logDiag("WebRTC:Signaling", `Received WebRTC offer from ${fromName || fromId}`);
  try {
    if (!peer) {
      setupWebRTCReceiver(fromId, fromName || "nearby device");
    }
    await peer.setRemoteDescription(new RTCSessionDescription(offer));
    flushQueuedCandidates(fromId);

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    logDiag("WebRTC:Signaling", "Answer created. Emitting webrtc-answer to peer.");
    socket.emit("webrtc-answer", {
      targetId: fromId,
      answer: { type: peer.localDescription.type, sdp: peer.localDescription.sdp }
    });
  } catch (err) {
    logDiag("WebRTC:Signaling", `Error answering offer: ${err.message}`, true);
    abortTransfer(`Failed to answer connection offer: ${err.message}`, true);
  }
});

socket.on("webrtc-answer", async ({ fromId, answer }) => {
  logDiag("WebRTC:Signaling", `Received WebRTC answer from ${fromId}`);
  if (!peer) return;
  try {
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
    flushQueuedCandidates(fromId || selectedDevice?.id);
  } catch (err) {
    logDiag("WebRTC:Signaling", `Error handling answer: ${err.message}`, true);
    abortTransfer(`Failed to process connection answer: ${err.message}`, true);
  }
});

socket.on("webrtc-ice-candidate", async ({ fromId, candidate }) => {
  if (!candidate || !candidate.candidate) return;
  const peerId = fromId || selectedDevice?.id;

  if (!peer || !peer.remoteDescription) {
    if (!earlyCandidatesQueue.has(peerId)) {
      earlyCandidatesQueue.set(peerId, []);
    }
    earlyCandidatesQueue.get(peerId).push(candidate);
    return;
  }

  try {
    await peer.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (_) {}
});

// --- Profile & Inputs ---
saveNameBtn.addEventListener("click", () => {
  const name = nameInput.value.trim().slice(0, 40) || "My device";
  nameInput.value = name;
  localStorage.setItem("quickshare-device-name", name);
  myDevice.textContent = name;
  logDiag("Profile", `Device name saved as: ${name}`);
  if (socket.connected) {
    socket.emit("register-device", name);
  }
});

fileInput.addEventListener("change", () => {
  const incoming = Array.from(fileInput.files || []);
  selectedFiles = [...selectedFiles, ...incoming];
  fileInput.value = "";
  logDiag("Files", `Selected ${incoming.length} new file(s). Total: ${selectedFiles.length}`);
  renderFiles();
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragging");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragging");
  const incoming = Array.from(e.dataTransfer.files || []);
  selectedFiles = [...selectedFiles, ...incoming];
  logDiag("Files", `Dropped ${incoming.length} file(s). Total: ${selectedFiles.length}`);
  renderFiles();
});

// Transfer Mode Selection Listeners
modeLocalRadio.addEventListener("change", updateModeUI);
modeWebRTCRadio.addEventListener("change", updateModeUI);

// Diagnostics Drawer Toggle
toggleDiagBtn.addEventListener("click", () => {
  const isHidden = diagDrawer.classList.contains("hidden");
  if (isHidden) {
    diagDrawer.classList.remove("hidden");
    diagChevron.textContent = "▲";
    toggleDiagBtn.setAttribute("aria-expanded", "true");
  } else {
    diagDrawer.classList.add("hidden");
    diagChevron.textContent = "▼";
    toggleDiagBtn.setAttribute("aria-expanded", "false");
  }
});

clearDiagBtn.addEventListener("click", () => {
  diagLogs.length = 0;
  diagLogBox.textContent = "[Cleared] Activity log reset.";
});

// --- Offline QR Code Pairing Dialog ---
function getPairingUrl() {
  if (serverNetworkUrls.length > 0) {
    return serverNetworkUrls[0];
  }
  if (window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
    return window.location.origin;
  }
  return window.location.origin;
}

showQrBtn.addEventListener("click", () => {
  const url = getPairingUrl();
  qrUrlDisplay.textContent = url;
  copyStatusText.textContent = "";

  if (window.QuickShareQR) {
    try {
      const svg = window.QuickShareQR.generateSvg(url, 200);
      qrSvgContainer.innerHTML = svg;
    } catch (e) {
      qrSvgContainer.textContent = "Could not render QR code.";
    }
  }

  qrModal.classList.remove("hidden");
  closeQrModalBtn.focus();
});

closeQrModalBtn.addEventListener("click", () => {
  qrModal.classList.add("hidden");
  showQrBtn.focus();
});

qrModal.addEventListener("click", (e) => {
  if (e.target === qrModal) {
    qrModal.classList.add("hidden");
  }
});

copyUrlBtn.addEventListener("click", async () => {
  const url = qrUrlDisplay.textContent;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const input = document.createElement("input");
      input.value = url;
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    copyStatusText.textContent = "Copied to clipboard!";
    setTimeout(() => { copyStatusText.textContent = ""; }, 2500);
  } catch (_) {
    copyStatusText.textContent = "Please select and copy manually.";
  }
});

// Escape key to dismiss modals
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!incomingModal.classList.contains("hidden")) {
      rejectIncoming("Declined via Escape.");
    }
    if (!qrModal.classList.contains("hidden")) {
      qrModal.classList.add("hidden");
    }
  }
});

// Initialization
updateModeUI();
renderDevices();
renderFiles();
renderReceivedFiles();
logDiag("Init", "QuickShare ready for transfer.");
