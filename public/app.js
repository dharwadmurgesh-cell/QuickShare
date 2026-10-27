/**
 * QuickShare — Testing Frontend Application Logic (Offline & Local-Only Capable)
 *
 * Key features:
 * 1. Local-Only Mode (STUN-free) for offline Wi-Fi and mobile hotspot transfers
 * 2. Guaranteed early ICE candidate queuing (prevents lost host candidates)
 * 3. 16 KB SCTP chunking with resilient, non-deadlocking backpressure handling
 * 4. Comprehensive diagnostics capturing real failure exceptions
 * 5. Full delivery acknowledgement before DataChannel shutdown
 */

"use strict";

// --- Configuration & Constants ---
const CHUNK_SIZE = 16 * 1024; // 16 KB per chunk for maximum SCTP cross-browser compatibility
const MAX_BUFFER = 1024 * 1024; // 1 MB buffer limit
const MAX_SAFE_FILE_SIZE = 500 * 1024 * 1024; // 500 MB memory advisory limit

// --- DOM Element References ---
const $ = (id) => document.getElementById(id);
const statusDot = $("statusDot");
const connectionStateText = $("connectionStateText");
const mySocketIdDisplay = $("mySocketIdDisplay");
const deviceNameInput = $("deviceNameInput");
const saveNameBtn = $("saveNameBtn");
const localOnlyModeCheckbox = $("localOnlyMode");
const refreshDevicesBtn = $("refreshDevicesBtn");
const deviceList = $("deviceList");
const targetDeviceBanner = $("targetDeviceBanner");
const targetDeviceName = $("targetDeviceName");
const fileInput = $("fileInput");
const selectedFilesList = $("selectedFilesList");
const sendFilesBtn = $("sendFilesBtn");
const cancelTransferBtn = $("cancelTransferBtn");
const transferStatusBadge = $("transferStatusBadge");
const transferStatusText = $("transferStatusText");
const progressBar = $("progressBar");
const progressPercent = $("progressPercent");
const transferDetails = $("transferDetails");
const receivedFilesList = $("receivedFilesList");

// Incoming request banner
const incomingModal = $("incomingRequestModal");
const incomingMessage = $("incomingMessage");
const incomingFilesList = $("incomingFilesList");
const acceptRequestBtn = $("acceptRequestBtn");
const rejectRequestBtn = $("rejectRequestBtn");

// Diagnostics
const diagSocket = $("diagSocket");
const diagSocketId = $("diagSocketId");
const diagMode = $("diagMode");
const diagPeer = $("diagPeer");
const diagIce = $("diagIce");
const diagGather = $("diagGather");
const diagChannel = $("diagChannel");
const diagBuffered = $("diagBuffered");
const diagChunkInfo = $("diagChunkInfo");
const diagCandidateTypes = $("diagCandidateTypes");
const diagLastError = $("diagLastError");
const diagSignalLog = $("diagSignalLog");

// --- Application State ---
let socket = null;
let devices = [];
let targetDevice = null;
let selectedFiles = [];
let receivedBlobs = []; // { name, size, type, blob, url }
let peerConnection = null;
let dataChannel = null;
let pendingIncomingRequest = null; // { fromId, fromName, filesInfo }
let isTransferBusy = false;
let isCancelled = false;
let observedCandidateTypes = new Set();
const earlyCandidatesMap = new Map(); // targetId -> Array of RTCIceCandidateInit
let signalingLocalIp = "";
let iceWatchdogTimer = null;
let signalingPeerId = null;
const signalLogLines = [];
const gatheredCandidateSummaries = [];

// --- Helper Functions ---
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
  return `${platform} (${Math.floor(100 + Math.random() * 900)})`;
}

function isLocalOnly() {
  return localOnlyModeCheckbox ? localOnlyModeCheckbox.checked : true;
}

function getRtcConfig() {
  if (isLocalOnly()) {
    // Local-only mode: NO external STUN servers.
    // Instant ICE gathering without DNS timeouts on offline Wi-Fi or mobile hotspot.
    return {
      iceServers: []
    };
  }
  return {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  };
}

function recordCandidateType(candidateStr) {
  if (!candidateStr || typeof candidateStr !== "string") return;
  const match = candidateStr.match(/typ\s+(\w+)/i);
  if (match && match[1]) {
    observedCandidateTypes.add(match[1].toLowerCase());
    diagCandidateTypes.textContent = Array.from(observedCandidateTypes).join(", ") || "None";
  }
}

function setTransferStatus(state, message = "") {
  // state: "waiting" | "connecting" | "transferring" | "completed" | "failed" | "cancelled" | "idle"
  const normalizedState = state.toLowerCase();
  transferStatusBadge.className = `badge badge-${normalizedState}`;
  transferStatusBadge.textContent = normalizedState;
  transferStatusText.textContent = message;
}

function updateProgress(percent, detailText = "") {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  progressBar.style.width = `${clamped}%`;
  progressPercent.textContent = `${clamped}%`;
  if (detailText) transferDetails.textContent = detailText;
}

function resetProgress() {
  updateProgress(0, "0 B / 0 B");
  diagChunkInfo.textContent = "Idle";
}

function recordError(errorMessage, exceptionObj = null) {
  const fullMsg = exceptionObj?.message ? `${errorMessage} (${exceptionObj.message})` : errorMessage;
  console.error("[QuickShare Diagnostic Error]", fullMsg, exceptionObj || "");
  diagLastError.textContent = fullMsg;
  signalLog("error", fullMsg);
}

function signalLog(event, detail = "") {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${event}${detail ? ` — ${detail}` : ""}`;
  signalLogLines.push(line);
  if (signalLogLines.length > 100) signalLogLines.shift();
  if (diagSignalLog) diagSignalLog.textContent = signalLogLines.join("\n");
  console.log("[QuickShare]", line);
}

function isPrivateOrLocalIp(ip) {
  if (!ip || typeof ip !== "string") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(ip)) return true;
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

function rewriteMdnsHost(text, ip) {
  if (typeof text !== "string" || !ip || !isPrivateOrLocalIp(ip)) return text;
  return text.replace(/[A-Za-z0-9-]+\.local\b/gi, ip);
}

function serializeCandidate(candidate) {
  if (!candidate) return null;
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment || undefined
  };
}

function rewriteCandidateInit(candidate, ip) {
  const init = serializeCandidate(candidate) || (candidate && typeof candidate === "object" ? { ...candidate } : null);
  if (!init || typeof init.candidate !== "string") return init;
  init.candidate = rewriteMdnsHost(init.candidate, ip);
  return init;
}

function rewriteSessionDescription(desc, ip) {
  if (!desc) return desc;
  const sdp = rewriteMdnsHost(desc.sdp, ip);
  return { type: desc.type, sdp };
}

function summarizeCandidate(candidateStr) {
  if (!candidateStr || typeof candidateStr !== "string") return "invalid";
  const typeMatch = candidateStr.match(/typ\s+(\w+)/i);
  const parts = candidateStr.split(" ").filter(Boolean);
  const address = parts[4] || "?";
  const port = parts[5] || "?";
  return `${typeMatch ? typeMatch[1] : "unknown"} ${address}:${port}`;
}

function attachReceiverDataChannelHandler(pc, fromName) {
  pc.ondatachannel = ({ channel }) => {
    signalLog("datachannel-received", `label=${channel.label} state=${channel.readyState}`);
    dataChannel = channel;
    dataChannel.binaryType = "arraybuffer";
    setupReceiverDataChannel(dataChannel, fromName || "nearby device");
  };
}

function clearIceWatchdog() {
  if (iceWatchdogTimer) {
    clearTimeout(iceWatchdogTimer);
    iceWatchdogTimer = null;
  }
}

function armIceWatchdog(timeoutMs = 8000) {
  clearIceWatchdog();
  iceWatchdogTimer = setTimeout(async () => {
    const iceState = peerConnection?.iceConnectionState;
    const peerState = peerConnection?.connectionState;
    const channelState = dataChannel?.readyState || "none";
    if (!peerConnection || ["connected", "completed"].includes(iceState) || channelState === "open") {
      return;
    }
    let remoteCandidates = [];
    try {
      const stats = await peerConnection.getStats();
      stats.forEach((report) => {
        if (report.type === "remote-candidate") {
          remoteCandidates.push(`${report.candidateType || "?"} ${report.address}:${report.port}`);
        }
      });
    } catch (_) {}
    const gathered = gatheredCandidateSummaries.join(", ") || "none";
    const remote = remoteCandidates.join(", ") || "none observed";
    const mdnsHint = gathered.includes(".local") || remote.includes(".local")
      ? " Remote host names still use mDNS (.local), which often fails on Windows, hotspots, and AP-isolated Wi-Fi."
      : "";
    const reason = `ICE stuck (${iceState || "unknown"} / peer ${peerState || "unknown"}; DataChannel ${channelState}). Local candidates: ${gathered}. Remote candidates: ${remote}.${mdnsHint} Confirm both devices use the same Wi-Fi/hotspot and that client isolation is off.`;
    recordError(reason);
    if (isTransferBusy) handleTransferFailure(reason);
  }, timeoutMs);
}

async function waitForIceGathering(pc, timeoutMs = 2500) {
  if (!pc || pc.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    onChange();
  });
}

async function flushQueuedCandidates(peerId) {
  const queued = earlyCandidatesMap.get(peerId) || [];
  earlyCandidatesMap.delete(peerId);
  if (!peerConnection || !queued.length) return;
  signalLog("ice-queue-flush", `${queued.length} queued candidate(s) for ${peerId}`);
  for (const c of queued) {
    try {
      recordCandidateType(c.candidate);
      await peerConnection.addIceCandidate(new RTCIceCandidate(c));
      signalLog("ice-candidate-added", summarizeCandidate(c.candidate));
    } catch (err) {
      recordError("Failed to add queued ICE candidate", err);
    }
  }
}

function updateDiagnostics() {
  diagSocket.textContent = socket?.connected ? "Connected" : "Disconnected";
  diagSocket.className = `badge ${socket?.connected ? "badge-completed" : "badge-failed"}`;
  diagSocketId.textContent = socket?.id || "-";

  diagMode.textContent = isLocalOnly() ? "Local-Only (No STUN)" : "STUN Enabled";
  diagMode.className = `badge ${isLocalOnly() ? "badge-completed" : "badge-waiting"}`;

  const peerState = peerConnection?.connectionState || "none";
  diagPeer.textContent = peerState;
  diagPeer.className = `badge ${peerState === "connected" ? "badge-completed" : (peerState === "failed" ? "badge-failed" : "badge-idle")}`;

  const iceState = peerConnection?.iceConnectionState || "none";
  diagIce.textContent = iceState;
  diagIce.className = `badge ${iceState === "connected" || iceState === "completed" ? "badge-completed" : (iceState === "failed" ? "badge-failed" : "badge-idle")}`;

  const gatherState = peerConnection?.iceGatheringState || "none";
  diagGather.textContent = gatherState;

  const channelState = dataChannel?.readyState || "none";
  diagChannel.textContent = channelState;
  diagChannel.className = `badge ${channelState === "open" ? "badge-completed" : "badge-idle"}`;

  const buffered = dataChannel?.bufferedAmount || 0;
  diagBuffered.textContent = formatBytes(buffered);
}

// --- Device Discovery & Presence ---
function renderDeviceList() {
  const myId = socket?.id;
  const others = devices.filter((d) => d.id !== myId);

  deviceList.replaceChildren();

  if (others.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No other devices found on the local network. Open QuickShare on another phone or computer to begin.";
    deviceList.appendChild(empty);
    return;
  }

  others.forEach((device) => {
    const item = document.createElement("div");
    item.className = `device-item ${targetDevice?.id === device.id ? "selected" : ""}`;

    const info = document.createElement("div");
    info.className = "device-info";

    const name = document.createElement("span");
    name.className = "device-name";
    name.textContent = device.name;

    const id = document.createElement("span");
    id.className = "device-id";
    id.textContent = `ID: ${device.id.slice(0, 8)}…`;

    info.appendChild(name);
    info.appendChild(id);

    const connectBtn = document.createElement("button");
    connectBtn.type = "button";
    connectBtn.className = "btn btn-sm btn-primary";
    connectBtn.textContent = targetDevice?.id === device.id ? "Selected ✓" : "Connect";
    connectBtn.disabled = isTransferBusy;

    connectBtn.addEventListener("click", () => {
      selectTargetDevice(device);
    });

    item.appendChild(info);
    item.appendChild(connectBtn);
    deviceList.appendChild(item);
  });
}

function selectTargetDevice(device) {
  targetDevice = device;
  targetDeviceName.textContent = device.name;
  renderDeviceList();
  updateActionButtons();
}

function updateActionButtons() {
  const hasTarget = Boolean(targetDevice);
  const hasFiles = selectedFiles.length > 0;

  sendFilesBtn.disabled = !hasTarget || !hasFiles || isTransferBusy;
  cancelTransferBtn.disabled = !isTransferBusy;

  if (isTransferBusy) {
    sendFilesBtn.textContent = "Transferring…";
  } else if (!hasTarget) {
    sendFilesBtn.textContent = "Select a Device to Send";
  } else if (!hasFiles) {
    sendFilesBtn.textContent = "Select Files to Send";
  } else {
    sendFilesBtn.textContent = `Send ${selectedFiles.length} ${selectedFiles.length === 1 ? "File" : "Files"} to ${targetDevice.name}`;
  }
}

// --- File Selection & UI ---
fileInput.addEventListener("change", () => {
  const newFiles = Array.from(fileInput.files || []);
  selectedFiles = [...selectedFiles, ...newFiles];
  fileInput.value = "";
  renderSelectedFiles();
});

function renderSelectedFiles() {
  selectedFilesList.replaceChildren();

  let totalSize = 0;
  selectedFiles.forEach((file, index) => {
    totalSize += file.size;
    const li = document.createElement("li");

    const info = document.createElement("span");
    info.textContent = `${file.name} (${formatBytes(file.size)})`;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove file";
    removeBtn.disabled = isTransferBusy;
    removeBtn.addEventListener("click", () => {
      selectedFiles.splice(index, 1);
      renderSelectedFiles();
    });

    li.appendChild(info);
    li.appendChild(removeBtn);
    selectedFilesList.appendChild(li);
  });

  if (totalSize > MAX_SAFE_FILE_SIZE) {
    const warningLi = document.createElement("li");
    warningLi.style.color = "var(--warning)";
    warningLi.textContent = `⚠️ Total selected (${formatBytes(totalSize)}) is large. Browser memory may be constrained.`;
    selectedFilesList.appendChild(warningLi);
  }

  updateActionButtons();
}

// --- Received Files UI ---
function addReceivedFile(name, size, type, blob) {
  const url = URL.createObjectURL(blob);
  receivedBlobs.push({ name, size, type, blob, url });
  renderReceivedFiles();
}

function renderReceivedFiles() {
  receivedFilesList.replaceChildren();

  if (receivedBlobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No files received yet.";
    receivedFilesList.appendChild(empty);
    return;
  }

  receivedBlobs.forEach((item) => {
    const div = document.createElement("div");
    div.className = "received-item";

    const info = document.createElement("div");
    info.className = "received-item-info";

    const name = document.createElement("span");
    name.className = "received-name";
    name.textContent = item.name;

    const meta = document.createElement("span");
    meta.className = "received-meta";
    meta.textContent = `${formatBytes(item.size)} · ${item.type || "file"} · Verified ✓`;

    info.appendChild(name);
    info.appendChild(meta);

    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "btn btn-sm btn-success";
    dlBtn.textContent = `Download ${item.name}`;
    dlBtn.addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = item.url;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    div.appendChild(info);
    div.appendChild(dlBtn);
    receivedFilesList.appendChild(div);
  });
}

// --- WebRTC PeerConnection Management ---
function cleanupWebRTC() {
  clearIceWatchdog();
  signalingPeerId = null;
  if (dataChannel) {
    try { dataChannel.close(); } catch (_) {}
    dataChannel = null;
  }
  if (peerConnection) {
    try { peerConnection.close(); } catch (_) {}
    peerConnection = null;
  }
  updateDiagnostics();
}

function createPeerConnection(targetId) {
  cleanupWebRTC();
  observedCandidateTypes.clear();
  gatheredCandidateSummaries.length = 0;
  diagCandidateTypes.textContent = "-";
  signalingPeerId = targetId;

  const config = getRtcConfig();
  signalLog("peerconnection-created", `target=${targetId} mode=${isLocalOnly() ? "local-only" : "stun"} iceServers=${config.iceServers.length}`);
  peerConnection = new RTCPeerConnection(config);

  peerConnection.onicecandidate = ({ candidate }) => {
    if (!candidate) {
      signalLog("ice-gathering-end", "null candidate");
      return;
    }
    recordCandidateType(candidate.candidate);
    const rewritten = rewriteCandidateInit(candidate, signalingLocalIp);
    gatheredCandidateSummaries.push(summarizeCandidate(rewritten.candidate));
    diagCandidateTypes.textContent = Array.from(observedCandidateTypes).join(", ") || "None";
    signalLog("ice-candidate-gathered", summarizeCandidate(rewritten.candidate));
    if (socket?.connected) {
      socket.emit("webrtc-ice-candidate", { targetId, candidate: rewritten });
      signalLog("ice-candidate-sent", summarizeCandidate(rewritten.candidate));
    }
  };

  peerConnection.onicecandidateerror = (event) => {
    const detail = `${event.errorText || "ICE candidate error"} (code ${event.errorCode || "?"}) ${event.url || ""}`.trim();
    signalLog("ice-candidate-error", detail);
    if (event.errorCode && event.errorCode !== 701) {
      recordError(detail);
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState;
    updateDiagnostics();
    signalLog("peer-state", state);

    if (state === "connected") {
      clearIceWatchdog();
    } else if (state === "failed") {
      const reason = isLocalOnly()
        ? "PeerConnection failed. Host candidates were not reachable. Verify both devices are on the exact same Wi-Fi or mobile hotspot and that AP/client isolation is disabled."
        : "PeerConnection failed. STUN server may be unreachable offline. Check 'Local-Only Mode' and retry.";
      recordError(reason);
      if (isTransferBusy) handleTransferFailure(reason);
    } else if (["disconnected", "closed"].includes(state) && isTransferBusy) {
      handleTransferFailure("WebRTC connection lost or closed.");
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    const iceState = peerConnection?.iceConnectionState;
    updateDiagnostics();
    signalLog("ice-state", iceState);

    if (iceState === "connected" || iceState === "completed") {
      clearIceWatchdog();
    } else if (iceState === "failed") {
      const reason = isLocalOnly()
        ? "ICE failed: no direct local route between host candidates. Devices may be on different subnets or the hotspot may block peer-to-peer UDP."
        : "ICE failed: External STUN was unreachable while offline. Use Local-Only Mode.";
      recordError(reason);
      if (isTransferBusy) handleTransferFailure(reason);
    }
  };

  peerConnection.onicegatheringstatechange = () => {
    updateDiagnostics();
    signalLog("ice-gathering", peerConnection?.iceGatheringState);
  };

  return peerConnection;
}

// Resilient backpressure control with safety timeout
function waitForBuffer(channel, timeoutMs = 12000) {
  if (!channel || channel.readyState !== "open") {
    return Promise.reject(new Error("DataChannel is closed or not open."));
  }
  if (channel.bufferedAmount <= MAX_BUFFER / 2) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let timer = null;

    const onLow = () => {
      cleanup();
      resolve();
    };

    const onError = (e) => {
      cleanup();
      reject(new Error(`DataChannel error while waiting for buffer: ${e?.message || "Unknown error"}`));
    };

    const onClose = () => {
      cleanup();
      reject(new Error("DataChannel closed unexpectedly while waiting for buffer to drain."));
    };

    const onTimeout = () => {
      cleanup();
      if (channel && channel.bufferedAmount <= MAX_BUFFER) {
        resolve();
      } else {
        reject(new Error(`Buffer drain timeout after ${timeoutMs}ms (buffered: ${channel?.bufferedAmount} B). Connection may be stalled.`));
      }
    };

    function cleanup() {
      if (timer) clearTimeout(timer);
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("error", onError);
      channel.removeEventListener("close", onClose);
    }

    timer = setTimeout(onTimeout, timeoutMs);
    channel.bufferedAmountLowThreshold = Math.min(MAX_BUFFER / 2, 64 * 1024);
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("error", onError);
    channel.addEventListener("close", onClose);
  });
}

// --- Sender Workflow ---
sendFilesBtn.addEventListener("click", initiateTransferRequest);

function initiateTransferRequest() {
  if (!targetDevice || selectedFiles.length === 0 || isTransferBusy) return;

  isTransferBusy = true;
  isCancelled = false;
  earlyCandidatesMap.clear();
  diagLastError.textContent = "None";
  updateActionButtons();
  resetProgress();
  setTransferStatus("waiting", `Requesting permission from ${targetDevice.name}…`);

  const filesInfo = selectedFiles.map((f) => ({
    name: f.name,
    size: f.size,
    type: f.type
  }));

  signalLog("connection-request-sent", `to ${targetDevice.name} (${targetDevice.id}) files=${filesInfo.length}`);
  socket.emit("connection-request", {
    targetId: targetDevice.id,
    filesInfo
  });
}

async function startSendingFiles() {
  setTransferStatus("connecting", "Handshake accepted. Establishing WebRTC channel…");

  try {
    const pc = createPeerConnection(targetDevice.id);
    dataChannel = pc.createDataChannel("quickshare-files");
    dataChannel.binaryType = "arraybuffer";
    signalLog("datachannel-created", `label=${dataChannel.label} state=${dataChannel.readyState}`);

    setupSenderDataChannel(dataChannel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signalLog("offer-created", `type=${offer.type} sdpBytes=${(offer.sdp || "").length}`);

    if (isLocalOnly()) {
      await waitForIceGathering(pc);
    }

    const payload = rewriteSessionDescription(pc.localDescription, signalingLocalIp);
    socket.emit("webrtc-offer", {
      targetId: targetDevice.id,
      offer: payload
    });
    signalLog("offer-sent", `to ${targetDevice.id}`);
    armIceWatchdog(isLocalOnly() ? 8000 : 20000);
  } catch (err) {
    recordError("Failed to create offer", err);
    handleTransferFailure(`Failed to establish connection: ${err.message}`);
  }
}

function setupSenderDataChannel(dc) {
  let isBatchAcknowledged = false;

  dc.onerror = (event) => {
    const err = event?.error?.message || event?.message || "DataChannel error occurred.";
    recordError("Sender DataChannel error", event?.error);
    signalLog("datachannel-error", err);
    if (isTransferBusy) handleTransferFailure(`DataChannel error: ${err}`);
  };

  dc.onopen = async () => {
    clearIceWatchdog();
    updateDiagnostics();
    signalLog("datachannel-open", dc.label);
    setTransferStatus("transferring", `Sending ${selectedFiles.length} file(s) to ${targetDevice.name}…`);

    try {
      const totalBatchBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
      let cumulativeBytesSent = 0;

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

        // Announce file start
        dc.send(JSON.stringify({
          type: "file-start",
          id: fileId,
          name: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          totalChunks
        }));

        let fileSent = 0;
        let chunkIndex = 0;

        // If file is 0-byte (empty file)
        if (file.size === 0) {
          dc.send(JSON.stringify({
            type: "file-end",
            id: fileId,
            checksumBytes: 0,
            totalChunks: 0
          }));
          diagChunkInfo.textContent = `File ${i + 1}/${selectedFiles.length}: Empty file (0 B)`;
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
          chunkIndex++;

          diagChunkInfo.textContent = `File ${i + 1}/${selectedFiles.length}: Chunk ${chunkIndex}/${totalChunks}`;
          const percent = totalBatchBytes > 0 ? (cumulativeBytesSent / totalBatchBytes) * 100 : 100;
          updateProgress(
            percent,
            `${formatBytes(cumulativeBytesSent)} / ${formatBytes(totalBatchBytes)} (${file.name} - ${Math.round((fileSent / file.size) * 100)}%)`
          );
          updateDiagnostics();
        }

        if (isCancelled) break;

        // Announce file end with verified bytes
        dc.send(JSON.stringify({
          type: "file-end",
          id: fileId,
          checksumBytes: fileSent,
          totalChunks
        }));
      }

      if (!isCancelled) {
        dc.send(JSON.stringify({ type: "batch-end" }));
        setTransferStatus("transferring", "Awaiting receiver verification…");
      }
    } catch (err) {
      if (!isCancelled) {
        recordError("Sender streaming failed", err);
        handleTransferFailure(`Transfer error: ${err.message}`);
      }
    }
  };

  dc.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "batch-complete") {
        isBatchAcknowledged = true;
        setTransferStatus("completed", `Successfully sent ${selectedFiles.length} file(s) to ${targetDevice.name}.`);
        updateProgress(100, `Done: All bytes verified by receiver.`);
        diagChunkInfo.textContent = "Complete ✓";
        isTransferBusy = false;
        updateActionButtons();
      } else if (msg.type === "transfer-cancel") {
        handleTransferCancelled(msg.reason || "Receiver cancelled the transfer.");
      }
    } catch (_) {}
  };

  dc.onclose = () => {
    updateDiagnostics();
    signalLog("datachannel-closed", dc.label || "quickshare-files");
    if (isTransferBusy && !isCancelled && !isBatchAcknowledged) {
      const reason = "DataChannel closed before receiver acknowledged transfer completion.";
      recordError(reason);
      handleTransferFailure(reason);
    }
  };
}

// --- Receiver Workflow ---
function handleIncomingRequest(payload) {
  pendingIncomingRequest = payload;

  incomingMessage.textContent = `${payload.fromName} wants to send you ${payload.filesInfo.length} file(s):`;
  incomingFilesList.replaceChildren();

  payload.filesInfo.forEach((f) => {
    const li = document.createElement("li");
    li.textContent = `${f.name} (${formatBytes(f.size)})`;
    incomingFilesList.appendChild(li);
  });

  incomingModal.classList.remove("hidden");
}

acceptRequestBtn.addEventListener("click", () => {
  if (!pendingIncomingRequest) return;
  const { fromId, fromName } = pendingIncomingRequest;
  incomingModal.classList.add("hidden");

  isTransferBusy = true;
  isCancelled = false;
  earlyCandidatesMap.clear();
  diagLastError.textContent = "None";
  updateActionButtons();
  resetProgress();
  setTransferStatus("connecting", `Accepted request from ${fromName}. Waiting for connection…`);

  const pc = createPeerConnection(fromId);
  attachReceiverDataChannelHandler(pc, fromName);
  signalLog("connection-request-accepted", `from ${fromName} (${fromId})`);

  socket.emit("connection-response", {
    targetId: fromId,
    accepted: true
  });
});

rejectRequestBtn.addEventListener("click", () => {
  if (!pendingIncomingRequest) return;
  const { fromId } = pendingIncomingRequest;
  incomingModal.classList.add("hidden");

  signalLog("connection-request-rejected", `from ${fromId}`);
  socket.emit("connection-response", {
    targetId: fromId,
    accepted: false,
    reason: "Receiver declined the connection request."
  });

  pendingIncomingRequest = null;
});

function setupReceiverDataChannel(dc, senderName) {
  let currentFileMeta = null;
  let receivedChunks = [];
  let fileBytesReceived = 0;
  let batchTotalBytes = 0;
  let batchCumulativeReceived = 0;
  let chunkCount = 0;

  dc.onerror = (event) => {
    const err = event?.error?.message || event?.message || "DataChannel error occurred.";
    recordError("Receiver DataChannel error", event?.error);
    signalLog("datachannel-error", err);
    if (isTransferBusy) handleTransferFailure(`DataChannel error: ${err}`);
  };

  dc.onopen = () => {
    clearIceWatchdog();
    updateDiagnostics();
    signalLog("datachannel-open", dc.label);
    setTransferStatus("transferring", `Receiving files from ${senderName}…`);
  };

  dc.onmessage = ({ data }) => {
    if (typeof data === "string") {
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }

      if (msg.type === "batch-start") {
        batchTotalBytes = msg.totalBytes || 0;
        batchCumulativeReceived = 0;
      } else if (msg.type === "file-start") {
        currentFileMeta = {
          id: msg.id,
          name: msg.name || "download",
          size: Number(msg.size) || 0,
          mime: msg.mime || "application/octet-stream",
          totalChunks: Number(msg.totalChunks) || 0
        };
        receivedChunks = [];
        fileBytesReceived = 0;
        chunkCount = 0;
        setTransferStatus("transferring", `Receiving ${currentFileMeta.name} from ${senderName}…`);
      } else if (msg.type === "file-end" && currentFileMeta) {
        // VERIFY BYTE COUNT
        const expectedSize = currentFileMeta.size;
        const verifiedSent = Number(msg.checksumBytes) || 0;

        if (fileBytesReceived !== expectedSize || verifiedSent !== expectedSize) {
          const errDetail = `Integrity check failed for ${currentFileMeta.name}: Expected ${expectedSize} B, received ${fileBytesReceived} B.`;
          recordError(errDetail);
          handleTransferFailure(errDetail);
          return;
        }

        // Construct verified blob
        const blob = new Blob(receivedChunks, { type: currentFileMeta.mime });
        addReceivedFile(currentFileMeta.name, blob.size, currentFileMeta.mime, blob);

        setTransferStatus("completed", `Received and verified ${currentFileMeta.name}.`);
        currentFileMeta = null;
        receivedChunks = [];
      } else if (msg.type === "batch-end") {
        // Acknowledge completion back to sender so sender knows all bytes were verified
        if (dc.readyState === "open") {
          try {
            dc.send(JSON.stringify({ type: "batch-complete", verifiedBytes: batchCumulativeReceived }));
          } catch (_) {}
        }
        setTransferStatus("completed", `All files successfully received from ${senderName}!`);
        updateProgress(100, `Complete: ${formatBytes(batchTotalBytes)} verified.`);
        diagChunkInfo.textContent = "Complete ✓";
        isTransferBusy = false;
        updateActionButtons();
      } else if (msg.type === "transfer-cancel") {
        handleTransferCancelled(msg.reason || "Sender cancelled the transfer.");
      }
    } else {
      // Binary chunk
      if (currentFileMeta) {
        receivedChunks.push(data);
        fileBytesReceived += data.byteLength;
        batchCumulativeReceived += data.byteLength;
        chunkCount++;

        diagChunkInfo.textContent = `Receiving ${currentFileMeta.name}: Chunk ${chunkCount}/${currentFileMeta.totalChunks || "?"}`;
        const percent = batchTotalBytes > 0 ? (batchCumulativeReceived / batchTotalBytes) * 100 : 100;
        updateProgress(
          percent,
          `${formatBytes(batchCumulativeReceived)} / ${formatBytes(batchTotalBytes)} (${currentFileMeta.name})`
        );
      }
    }
  };

  dc.onclose = () => {
    updateDiagnostics();
    signalLog("datachannel-closed", dc.label || "quickshare-files");
    if (isTransferBusy && currentFileMeta) {
      const reason = "Transfer interrupted: DataChannel closed before file finished.";
      recordError(reason);
      handleTransferFailure(reason);
    }
  };
}

// --- Cancellation & Error Handling ---
cancelTransferBtn.addEventListener("click", () => {
  if (!isTransferBusy) return;

  isCancelled = true;
  const reason = "Transfer cancelled by local user.";

  if (dataChannel && dataChannel.readyState === "open") {
    try {
      dataChannel.send(JSON.stringify({ type: "transfer-cancel", reason }));
    } catch (_) {}
  } else if (targetDevice && socket?.connected) {
    socket.emit("transfer-cancel", { targetId: targetDevice.id, reason });
  }

  handleTransferCancelled(reason);
});

function handleTransferCancelled(reason) {
  isCancelled = true;
  isTransferBusy = false;
  cleanupWebRTC();
  updateActionButtons();
  setTransferStatus("cancelled", reason);
  diagChunkInfo.textContent = "Cancelled";
}

function handleTransferFailure(errorMessage) {
  isTransferBusy = false;
  cleanupWebRTC();
  updateActionButtons();
  setTransferStatus("failed", errorMessage);
  diagChunkInfo.textContent = "Failed";
}

// --- Socket.IO Event Handlers ---
function initSocket() {
  socket = io();

  socket.on("connect", () => {
    statusDot.className = "status-dot online";
    connectionStateText.textContent = "Connected to server";
    mySocketIdDisplay.textContent = `ID: ${socket.id}`;
    updateDiagnostics();
    signalLog("socket-connected", socket.id);

    if (isTransferBusy) {
      const reason = "Socket.IO reconnected with a new ID. The previous peer handshake is stale. Retry the transfer.";
      recordError(reason);
      handleTransferFailure(reason);
    }

    const myName = getStoredDeviceName();
    deviceNameInput.value = myName;
    socket.emit("register-device", myName);
  });

  socket.on("session-info", ({ clientIp } = {}) => {
    signalingLocalIp = typeof clientIp === "string" ? clientIp : "";
    signalLog("session-info", `lanIp=${signalingLocalIp || "unknown"}`);
  });

  socket.on("disconnect", () => {
    statusDot.className = "status-dot offline";
    connectionStateText.textContent = "Disconnected from server";
    mySocketIdDisplay.textContent = "";
    updateDiagnostics();
    signalLog("socket-disconnected");
  });

  socket.on("devices-updated", (deviceListArray) => {
    devices = Array.isArray(deviceListArray) ? deviceListArray : [];
    renderDeviceList();
  });

  socket.on("server-error", ({ message }) => {
    recordError("Server error", { message });
    setTransferStatus("failed", message || "Server error.");
  });

  // Handshake events
  socket.on("connection-request", (payload) => {
    signalLog("connection-request-received", `from ${payload?.fromName || "device"} (${payload?.fromId})`);
    handleIncomingRequest(payload);
  });

  socket.on("connection-response", async (payload) => {
    if (!isTransferBusy) return;

    if (!payload.accepted) {
      signalLog("connection-request-declined", payload.reason || "declined");
      isTransferBusy = false;
      updateActionButtons();
      setTransferStatus("cancelled", payload.reason || "Connection request was declined.");
      return;
    }

    signalLog("connection-request-accepted-remote", `from ${payload.fromId}`);
    await startSendingFiles();
  });

  socket.on("transfer-cancel", (payload) => {
    handleTransferCancelled(payload?.reason || "Peer cancelled the transfer.");
  });

  // WebRTC signaling events
  socket.on("webrtc-offer", async ({ fromId, fromIp, offer }) => {
    signalLog("offer-received", `from ${fromId} ip=${fromIp || "?"}`);
    try {
      if (!peerConnection) {
        const pc = createPeerConnection(fromId);
        attachReceiverDataChannelHandler(pc, pendingIncomingRequest?.fromName);
      }
      const rewrittenOffer = rewriteSessionDescription(offer, fromIp);
      await peerConnection.setRemoteDescription(new RTCSessionDescription(rewrittenOffer));
      signalLog("offer-applied", `signalingState=${peerConnection.signalingState}`);
      await flushQueuedCandidates(fromId);

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      if (isLocalOnly()) {
        await waitForIceGathering(peerConnection);
      }
      const payload = rewriteSessionDescription(peerConnection.localDescription, signalingLocalIp);
      socket.emit("webrtc-answer", {
        targetId: fromId,
        answer: payload
      });
      signalLog("answer-sent", `to ${fromId}`);
      armIceWatchdog(isLocalOnly() ? 8000 : 20000);
    } catch (err) {
      recordError("Failed to handle offer", err);
      handleTransferFailure(`Failed to answer offer: ${err.message}`);
    }
  });

  socket.on("webrtc-answer", async ({ fromId, fromIp, answer }) => {
    signalLog("answer-received", `from ${fromId} ip=${fromIp || "?"}`);
    if (!peerConnection) {
      recordError("Answer received before PeerConnection existed.");
      return;
    }
    try {
      const rewrittenAnswer = rewriteSessionDescription(answer, fromIp);
      await peerConnection.setRemoteDescription(new RTCSessionDescription(rewrittenAnswer));
      signalLog("answer-applied", `signalingState=${peerConnection.signalingState}`);
      await flushQueuedCandidates(fromId || targetDevice?.id);
    } catch (err) {
      recordError("Failed to handle answer", err);
      handleTransferFailure(`Failed to handle answer: ${err.message}`);
    }
  });

  socket.on("webrtc-ice-candidate", async ({ fromId, fromIp, candidate }) => {
    if (!candidate || !candidate.candidate) return;
    const rewritten = rewriteCandidateInit(candidate, fromIp);
    recordCandidateType(rewritten.candidate);
    signalLog("ice-candidate-received", summarizeCandidate(rewritten.candidate));

    const peerId = fromId || targetDevice?.id || signalingPeerId;

    if (!peerConnection || !peerConnection.remoteDescription) {
      if (!earlyCandidatesMap.has(peerId)) {
        earlyCandidatesMap.set(peerId, []);
      }
      earlyCandidatesMap.get(peerId).push(rewritten);
      signalLog("ice-candidate-queued", `waiting for remote description (${peerId})`);
      return;
    }

    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(rewritten));
      signalLog("ice-candidate-added", summarizeCandidate(rewritten.candidate));
    } catch (err) {
      recordError("Failed to add ICE candidate", err);
    }
  });
}

// --- User Controls ---
saveNameBtn.addEventListener("click", () => {
  const name = deviceNameInput.value.trim().slice(0, 40) || "My Device";
  deviceNameInput.value = name;
  localStorage.setItem("quickshare-device-name", name);
  if (socket?.connected) {
    socket.emit("register-device", name);
  }
});

refreshDevicesBtn.addEventListener("click", () => {
  if (socket?.connected) {
    socket.emit("request-devices");
  }
});

if (localOnlyModeCheckbox) {
  localOnlyModeCheckbox.addEventListener("change", () => {
    updateDiagnostics();
  });
}

// Periodic diagnostic refresher
setInterval(updateDiagnostics, 1000);

// --- Initialization ---
initSocket();
setTransferStatus("idle", "Ready to transfer");
