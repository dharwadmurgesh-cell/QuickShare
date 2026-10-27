"use strict";

/**
 * QuickShare — Complete Local P2P Client
 * Fully offline-capable WebRTC data-transfer with in-page handshake,
 * byte-accurate verification, safe manual downloads, and local QR pairing.
 */

// --- Constants & Configuration ---
const CHUNK_SIZE = 16 * 1024; // 16 KB per SCTP chunk
const MAX_BUFFER = 1024 * 1024; // 1 MB backpressure ceiling
const DRAIN_THRESHOLD = 64 * 1024; // 64 KB low buffer threshold

// --- DOM References ---
const $ = (id) => document.getElementById(id);

const connectionDot = $("connectionDot");
const connectionText = $("connectionText");
const myDevice = $("myDevice");
const nameInput = $("deviceName");
const saveNameBtn = $("saveName");
const localOnlyMode = $("localOnlyMode");
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

// --- Application State ---
const socket = io();
let devices = [];
let selectedDevice = null;
let selectedFiles = [];
let receivedFiles = []; // { id, name, size, type, blob, url }

let peer = null;
let channel = null;
let isTransferBusy = false;
let isCancelled = false;
let pendingIncoming = null; // { fromId, fromName, filesInfo }
let incomingSafetyTimer = null;
const earlyCandidatesQueue = new Map(); // targetId -> Array of candidate
let localSignalingIp = "";
let serverNetworkUrls = [];
let iceWatchdogTimer = null;

// Speed calculation state
let speedTrackingInterval = null;
let lastProgressBytes = 0;
let lastProgressTime = Date.now();

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

function isLocalOnly() {
  return localOnlyMode ? localOnlyMode.checked : true;
}

function getRtcConfig() {
  if (isLocalOnly()) {
    // Local-only mode: No external STUN DNS queries.
    // Gathers local host candidates instantly on offline Wi-Fi and mobile hotspots.
    return { iceServers: [] };
  }
  return {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }
    ]
  };
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
        renderDevices();
        updateButton();
      });

      deviceList.append(button);
    }
  }
  updateButton();
}

// --- Files UI ---
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
function addReceivedFile(name, size, type, blob) {
  const url = URL.createObjectURL(blob);
  const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  receivedFiles.unshift({ id, name, size, type, blob, url });
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
      try { URL.revokeObjectURL(item.url); } catch (_) {}
      receivedFiles.splice(index, 1);
      renderReceivedFiles();
    });

    actions.append(dlBtn, removeBtn);
    row.append(info, actions);
    receivedList.append(row);
  });
}

// --- PeerConnection & Backpressure ---
function clearWatchdogs() {
  if (iceWatchdogTimer) {
    clearTimeout(iceWatchdogTimer);
    iceWatchdogTimer = null;
  }
}

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

function armIceWatchdog(targetName, timeoutMs = 10000) {
  clearWatchdogs();
  iceWatchdogTimer = setTimeout(() => {
    if (!peer || ["connected", "completed"].includes(peer.iceConnectionState) || channel?.readyState === "open") {
      return;
    }
    const state = peer.iceConnectionState || "unknown";
    const msg = `Connection to ${targetName} timed out (ICE state: ${state}). Ensure both devices are on the exact same Wi-Fi/hotspot and AP client isolation is disabled.`;
    setStatus(msg, "error");
    if (isTransferBusy) abortTransfer(msg);
  }, timeoutMs);
}

function waitForBuffer(dataChannel, timeoutMs = 15000) {
  if (!dataChannel || dataChannel.readyState !== "open") {
    return Promise.reject(new Error("DataChannel is closed or not open."));
  }
  if (dataChannel.bufferedAmount <= MAX_BUFFER / 2) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      cleanup();
      if (dataChannel && dataChannel.bufferedAmount <= MAX_BUFFER) resolve();
      else reject(new Error("Buffer drain timed out. Connection may be stalled."));
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

function waitForChannelOpen(dataChannel, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (dataChannel.readyState === "open") return resolve();
    let timer = setTimeout(() => {
      reject(new Error("Timed out waiting for direct WebRTC channel to open."));
    }, timeoutMs);

    dataChannel.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    dataChannel.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`DataChannel error: ${e?.message || "Failed to open channel"}`));
    };
  });
}

function flushQueuedCandidates(targetId) {
  const queued = earlyCandidatesQueue.get(targetId) || [];
  earlyCandidatesQueue.delete(targetId);
  if (!peer || !queued.length) return;
  queued.forEach(async (cand) => {
    try { await peer.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
  });
}

function createPeer(targetId, targetName) {
  closePeer();
  peer = new RTCPeerConnection(getRtcConfig());

  peer.onicecandidate = ({ candidate }) => {
    if (candidate && socket.connected) {
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
    if (peer?.iceConnectionState === "connected" || peer?.iceConnectionState === "completed") {
      clearWatchdogs();
    } else if (peer?.iceConnectionState === "failed" && isTransferBusy) {
      abortTransfer("Direct ICE connection failed. Confirm both devices are connected to the same Wi-Fi/hotspot.");
    }
  };

  peer.onconnectionstatechange = () => {
    if (peer?.connectionState === "connected") {
      clearWatchdogs();
    } else if (["failed", "disconnected", "closed"].includes(peer?.connectionState) && isTransferBusy) {
      abortTransfer("WebRTC connection lost.");
    }
  };

  return peer;
}

// --- Sender Workflow ---
sendButton.addEventListener("click", () => {
  if (!selectedDevice || !selectedFiles.length || isTransferBusy) return;

  isTransferBusy = true;
  isCancelled = false;
  earlyCandidatesQueue.clear();
  updateButton();
  showProgress(true);
  setStatus(`Requesting permission from ${selectedDevice.name}…`);

  const filesInfo = selectedFiles.map((f) => ({
    name: f.name,
    size: f.size,
    type: f.type || "application/octet-stream"
  }));

  socket.emit("connection-request", {
    targetId: selectedDevice.id,
    filesInfo
  });
});

async function startSendingFiles(targetId, targetName) {
  setStatus(`Connecting to ${targetName}…`);
  armIceWatchdog(targetName, isLocalOnly() ? 8000 : 20000);

  try {
    const connection = createPeer(targetId, targetName);
    channel = connection.createDataChannel("quickshare-files");
    channel.binaryType = "arraybuffer";

    setupSenderChannel(channel, targetName);

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);

    socket.emit("webrtc-offer", {
      targetId,
      offer: { type: connection.localDescription.type, sdp: connection.localDescription.sdp }
    });

    await waitForChannelOpen(channel);
  } catch (err) {
    abortTransfer(`Could not establish connection: ${err.message}`);
  }
}

function setupSenderChannel(dc, targetName) {
  let isBatchAcknowledged = false;

  dc.onerror = (e) => {
    if (isTransferBusy) abortTransfer(`DataChannel error: ${e?.message || "Unknown error"}`);
  };

  dc.onclose = () => {
    if (isTransferBusy && !isCancelled && !isBatchAcknowledged) {
      abortTransfer("Transfer interrupted: Channel closed prematurely.");
    }
  };

  dc.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "batch-complete") {
        isBatchAcknowledged = true;
        isTransferBusy = false;
        showProgress(false);
        updateButton();
        setStatus(`Successfully sent ${selectedFiles.length} ${selectedFiles.length === 1 ? "file" : "files"} to ${targetName}!`, "success");
        closePeer();
      } else if (msg.type === "transfer-cancel") {
        handleTransferCancelled(msg.reason || "Receiver cancelled the transfer.");
      }
    } catch (_) {}
  };

  dc.onopen = async () => {
    clearWatchdogs();
    setStatus(`Sending files to ${targetName}…`);

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
      }
    } catch (err) {
      if (!isCancelled) abortTransfer(`Transfer failed: ${err.message}`);
    }
  };
}

// --- Receiver Workflow ---
function handleIncomingRequest(payload) {
  pendingIncoming = payload;
  const { fromName, filesInfo } = payload;
  const count = filesInfo?.length || 0;
  const totalSize = (filesInfo || []).reduce((sum, f) => sum + (f.size || 0), 0);

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

  // Focus accept button for TV remote D-pad navigation
  setTimeout(() => acceptRequestBtn.focus(), 50);

  // 45s safety timeout for stale requests
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
  const { fromId, fromName } = pendingIncoming;
  incomingModal.classList.add("hidden");

  isTransferBusy = true;
  isCancelled = false;
  earlyCandidatesQueue.clear();
  updateButton();
  showProgress(true);
  setStatus(`Accepted request from ${fromName}. Connecting…`);
  armIceWatchdog(fromName, isLocalOnly() ? 8000 : 20000);

  const connection = createPeer(fromId, fromName);
  connection.ondatachannel = ({ channel: incoming }) => {
    channel = incoming;
    channel.binaryType = "arraybuffer";
    setupReceiverChannel(channel, fromName);
  };

  socket.emit("connection-response", {
    targetId: fromId,
    accepted: true
  });
});

rejectRequestBtn.addEventListener("click", () => {
  rejectIncoming("Receiver declined the transfer.");
});

function rejectIncoming(reason) {
  clearTimeout(incomingSafetyTimer);
  if (pendingIncoming) {
    socket.emit("connection-response", {
      targetId: pendingIncoming.fromId,
      accepted: false,
      reason
    });
    pendingIncoming = null;
  }
  incomingModal.classList.add("hidden");
}

function setupReceiverChannel(dc, senderName) {
  let currentFile = null;
  let receivedChunks = [];
  let fileBytesReceived = 0;
  let batchTotalBytes = 0;
  let batchCumulativeReceived = 0;

  startSpeedTracking(() => batchCumulativeReceived);

  dc.onerror = (e) => {
    if (isTransferBusy) abortTransfer(`DataChannel error: ${e?.message || "Unknown error"}`);
  };

  dc.onopen = () => {
    clearWatchdogs();
    setStatus(`Receiving files from ${senderName}…`);
  };

  dc.onmessage = ({ data }) => {
    if (typeof data === "string") {
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }

      if (msg.type === "batch-start") {
        batchTotalBytes = msg.totalBytes || 0;
        batchCumulativeReceived = 0;
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
        setStatus(`Receiving ${currentFile.name} from ${senderName}…`);
      } else if (msg.type === "file-end" && currentFile) {
        // Integrity Byte Verification
        const expectedSize = currentFile.size;
        const verifiedSent = Number(msg.checksumBytes) || 0;

        if (fileBytesReceived !== expectedSize || verifiedSent !== expectedSize) {
          abortTransfer(`Integrity error for ${currentFile.name}: expected ${expectedSize} B, received ${fileBytesReceived} B.`);
          return;
        }

        const blob = new Blob(receivedChunks, { type: currentFile.mime });
        addReceivedFile(currentFile.name, blob.size, currentFile.mime, blob);
        currentFile = null;
        receivedChunks = [];
      } else if (msg.type === "batch-end") {
        // Acknowledge completion back to sender
        if (dc.readyState === "open") {
          try {
            dc.send(JSON.stringify({ type: "batch-complete", verifiedBytes: batchCumulativeReceived }));
          } catch (_) {}
        }
        isTransferBusy = false;
        showProgress(false);
        updateButton();
        setStatus(`Received all files from ${senderName}!`, "success");
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
  };

  dc.onclose = () => {
    if (isTransferBusy && currentFile) {
      abortTransfer("Transfer interrupted: Connection closed before completion.");
    }
  };
}

// --- Cancellation & Abort ---
cancelButton.addEventListener("click", () => {
  if (!isTransferBusy) return;
  const reason = "Transfer cancelled by user.";
  if (channel && channel.readyState === "open") {
    try { channel.send(JSON.stringify({ type: "transfer-cancel", reason })); } catch (_) {}
  } else if (selectedDevice && socket.connected) {
    socket.emit("transfer-cancel", { targetId: selectedDevice.id, reason });
  }
  handleTransferCancelled(reason);
});

function abortTransfer(errorMessage) {
  isTransferBusy = false;
  isCancelled = true;
  closePeer();
  showProgress(false);
  updateButton();
  setStatus(errorMessage, "error");
}

function handleTransferCancelled(reason) {
  isTransferBusy = false;
  isCancelled = true;
  closePeer();
  showProgress(false);
  updateButton();
  setStatus(reason, "error");
}

// --- Socket Events ---
socket.on("connect", () => {
  connectionText.textContent = "Connected";
  connectionDot.classList.add("online");
  const name = getStoredDeviceName();
  nameInput.value = name;
  myDevice.textContent = name;
  socket.emit("register-device", name);
});

socket.on("session-info", ({ clientIp, networkUrls } = {}) => {
  localSignalingIp = typeof clientIp === "string" ? clientIp : "";
  if (Array.isArray(networkUrls) && networkUrls.length > 0) {
    serverNetworkUrls = networkUrls;
  }
});

socket.on("disconnect", () => {
  connectionText.textContent = "Reconnecting…";
  connectionDot.classList.remove("online");
});

socket.on("devices-updated", (list) => {
  devices = Array.isArray(list) ? list : [];
  renderDevices();
});

socket.on("server-error", ({ message } = {}) => {
  setStatus(typeof message === "string" ? message : "Server error.", "error");
});

// Handshake events
socket.on("connection-request", (payload) => {
  handleIncomingRequest(payload);
});

socket.on("connection-response", async ({ fromId, accepted, reason }) => {
  if (!isTransferBusy) return;
  if (!accepted) {
    isTransferBusy = false;
    showProgress(false);
    updateButton();
    setStatus(reason || "Connection request declined by receiver.", "error");
    return;
  }
  await startSendingFiles(fromId, selectedDevice?.name || "device");
});

socket.on("transfer-cancel", ({ reason } = {}) => {
  handleTransferCancelled(reason || "Peer cancelled the transfer.");
});

// WebRTC Signaling
socket.on("webrtc-offer", async ({ fromId, fromName, offer }) => {
  try {
    if (!peer) {
      peer = createPeer(fromId, fromName || "nearby device");
      peer.ondatachannel = ({ channel: incoming }) => {
        channel = incoming;
        channel.binaryType = "arraybuffer";
        setupReceiverChannel(channel, fromName || "nearby device");
      };
    }
    await peer.setRemoteDescription(new RTCSessionDescription(offer));
    flushQueuedCandidates(fromId);

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    socket.emit("webrtc-answer", {
      targetId: fromId,
      answer: { type: peer.localDescription.type, sdp: peer.localDescription.sdp }
    });
  } catch (err) {
    abortTransfer(`Failed to answer connection offer: ${err.message}`);
  }
});

socket.on("webrtc-answer", async ({ fromId, answer }) => {
  if (!peer) return;
  try {
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
    flushQueuedCandidates(fromId || selectedDevice?.id);
  } catch (err) {
    abortTransfer(`Failed to process connection answer: ${err.message}`);
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

// --- User Profile & File Input Listeners ---
saveNameBtn.addEventListener("click", () => {
  const name = nameInput.value.trim().slice(0, 40) || "My device";
  nameInput.value = name;
  localStorage.setItem("quickshare-device-name", name);
  myDevice.textContent = name;
  if (socket.connected) {
    socket.emit("register-device", name);
  }
});

fileInput.addEventListener("change", () => {
  selectedFiles = [...selectedFiles, ...Array.from(fileInput.files || [])];
  fileInput.value = "";
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
  selectedFiles = [...selectedFiles, ...Array.from(e.dataTransfer.files || [])];
  renderFiles();
});

// --- Offline QR Code Pairing Dialog ---
function getPairingUrl() {
  // If server provided network URLs (e.g. http://192.168.1.50:3000), use the first non-localhost LAN URL
  if (serverNetworkUrls.length > 0) {
    return serverNetworkUrls[0];
  }
  // Otherwise if current window is already on a LAN IP, use current origin
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

// Initial render
renderDevices();
renderFiles();
renderReceivedFiles();
