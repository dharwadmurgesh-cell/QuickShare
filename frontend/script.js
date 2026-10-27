const socket = io();
const $ = (id) => document.getElementById(id);
const nameInput = $("deviceName");
const deviceList = $("deviceList");
const fileInput = $("fileInput");
const sendButton = $("sendButton");
const statusBox = $("transferStatus");
const CHUNK_SIZE = 16 * 1024;
const MAX_BUFFER = 1024 * 1024;

function getRtcConfig() {
  if (navigator.onLine === false) {
    return { iceServers: [] };
  }
  return { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
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

function waitForIceGathering(pc, timeoutMs = 2500) {
  if (!pc || pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
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

let devices = [];
let selectedDevice = null;
let selectedFiles = [];
let peer = null;
let channel = null;
let transferBusy = false;
let incomingCandidates = [];

function getDeviceName() {
  return localStorage.getItem("quickshare-device-name") || `${navigator.platform || "My"} device`;
}

function setStatus(message, kind = "") {
  statusBox.textContent = message;
  statusBox.className = `transfer-status ${kind}`;
}

function updateButton() {
  if (transferBusy) {
    sendButton.disabled = true;
    sendButton.textContent = "Transferring…";
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

function renderDevices() {
  const others = devices.filter((device) => device.id !== socket.id);
  $("deviceCount").textContent = `${others.length} ${others.length === 1 ? "found" : "found"}`;
  if (selectedDevice && !others.some((device) => device.id === selectedDevice.id)) {
    selectedDevice = null;
  }
  deviceList.replaceChildren();
  if (!others.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No other devices yet. Open QuickShare on another device using the network address shown in the terminal.";
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
        selectedDevice = device;
        renderDevices();
        updateButton();
      });
      deviceList.append(button);
    }
  }
  updateButton();
}

function renderFiles() {
  $("fileCount").textContent = `${selectedFiles.length} selected`;
  const list = $("fileList");
  list.replaceChildren();
  selectedFiles.forEach((file, index) => {
    const item = document.createElement("li");
    const info = document.createElement("span");
    info.textContent = `${file.name} · ${formatBytes(file.size)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-file";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      selectedFiles.splice(index, 1);
      renderFiles();
      updateButton();
    });
    item.append(info, remove);
    list.append(item);
  });
  updateButton();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function closePeer() {
  if (channel) channel.close();
  if (peer) peer.close();
  channel = null;
  peer = null;
  incomingCandidates = [];
}

function createPeer(targetId, onDataChannel) {
  closePeer();
  peer = new RTCPeerConnection(getRtcConfig());
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit("webrtc-ice-candidate", { targetId, candidate: serializeCandidate(candidate) });
  };
  peer.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(peer?.connectionState) && transferBusy) {
      transferBusy = false;
      setStatus(`Connection ${peer?.connectionState || "lost"}. Ensure both devices are on the same local network.`, "error");
      updateButton();
    }
  };
  peer.oniceconnectionstatechange = () => {
    if (peer?.iceConnectionState === "failed" && transferBusy) {
      transferBusy = false;
      setStatus("Direct ICE connection failed. Make sure both devices are on the same local network.", "error");
      updateButton();
    }
  };
  peer.ondatachannel = ({ channel: incoming }) => {
    channel = incoming;
    channel.binaryType = "arraybuffer";
    onDataChannel(incoming);
  };
  return peer;
}

function waitForChannelOpen(dataChannel, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (dataChannel.readyState === "open") return resolve();
    let timer = setTimeout(() => {
      reject(new Error("Connection timed out waiting for direct channel to open."));
    }, timeoutMs);
    dataChannel.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    dataChannel.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`DataChannel error: ${e?.message || "Could not open channel"}`));
    };
  });
}

function waitForBuffer(dataChannel, timeoutMs = 12000) {
  if (!dataChannel || dataChannel.readyState !== "open") {
    return Promise.reject(new Error("DataChannel is closed or not open."));
  }
  if (dataChannel.bufferedAmount <= MAX_BUFFER / 2) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      dataChannel.removeEventListener("bufferedamountlow", onLow);
      if (dataChannel && dataChannel.bufferedAmount <= MAX_BUFFER) resolve();
      else reject(new Error("Buffer drain timeout"));
    }, timeoutMs);

    const onLow = () => {
      clearTimeout(timer);
      dataChannel.removeEventListener("bufferedamountlow", onLow);
      resolve();
    };

    dataChannel.bufferedAmountLowThreshold = Math.min(MAX_BUFFER / 2, 64 * 1024);
    dataChannel.addEventListener("bufferedamountlow", onLow);
  });
}

async function sendFiles() {
  if (!selectedDevice || !selectedFiles.length || transferBusy) return;
  if (!window.RTCPeerConnection) {
    setStatus("This browser does not support WebRTC file sharing.", "error");
    return;
  }
  transferBusy = true;
  updateButton();
  setStatus(`Connecting to ${selectedDevice.name}…`);
  try {
    const targetId = selectedDevice.id;
    const connection = createPeer(targetId, () => {});
    channel = connection.createDataChannel("quickshare-files");
    channel.binaryType = "arraybuffer";
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    if (!navigator.onLine) await waitForIceGathering(connection);
    socket.emit("webrtc-offer", { targetId, offer: connection.localDescription });
    await waitForChannelOpen(channel);

    let total = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    let sent = 0;
    for (const file of selectedFiles) {
      channel.send(JSON.stringify({ type: "file-start", name: file.name, size: file.size, mime: file.type }));
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        await waitForBuffer(channel);
        const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        channel.send(chunk);
        sent += chunk.byteLength;
        setStatus(`Sending ${file.name} · ${Math.round((sent / Math.max(total, 1)) * 100)}%`);
      }
      channel.send(JSON.stringify({ type: "file-end" }));
    }
    channel.send(JSON.stringify({ type: "transfer-end" }));
    setStatus(`Sent ${selectedFiles.length} ${selectedFiles.length === 1 ? "file" : "files"} to ${selectedDevice.name}.`, "success");
  } catch (error) {
    setStatus(error.message || "Transfer failed. Please try again.", "error");
  } finally {
    transferBusy = false;
    updateButton();
  }
}

function acceptDataChannel(dataChannel, fromName) {
  dataChannel.binaryType = "arraybuffer";
  let current = null;
  let chunks = [];
  let received = 0;
  dataChannel.onmessage = ({ data }) => {
    if (typeof data === "string") {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type === "file-start") {
        current = { name: String(message.name || "download").split(/[\\/]/).pop(), size: Number(message.size) || 0, mime: message.mime || "application/octet-stream" };
        chunks = [];
        received = 0;
        setStatus(`Receiving ${current.name} from ${fromName}…`);
      } else if (message.type === "file-end" && current) {
        if (received !== current.size) {
          setStatus(`Integrity failure: expected ${current.size} B, received ${received} B.`, "error");
          return;
        }
        const blob = new Blob(chunks, { type: current.mime });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = current.name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setStatus(`Received and verified ${current.name} (${formatBytes(blob.size)}).`, "success");
        current = null;
        chunks = [];
      } else if (message.type === "transfer-end") {
        setStatus("Transfer complete.", "success");
        dataChannel.close();
      }
    } else if (current) {
      chunks.push(data);
      received += data.byteLength;
      setStatus(`Receiving ${current.name} · ${Math.round((received / Math.max(current.size, 1)) * 100)}%`);
    }
  };
  dataChannel.onclose = () => {
    if (current) setStatus("Transfer ended before the file finished downloading.", "error");
  };
}

socket.on("connect", () => {
  $("connectionText").textContent = "Connected";
  $("connectionDot").classList.add("online");
  socket.emit("register-device", getDeviceName());
});
socket.on("disconnect", () => {
  $("connectionText").textContent = "Reconnecting…";
  $("connectionDot").classList.remove("online");
});
socket.on("devices-updated", (list) => {
  devices = Array.isArray(list) ? list : [];
  renderDevices();
});
socket.on("server-error", ({ message } = {}) => {
  setStatus(typeof message === "string" ? message : "The server could not process that request.", "error");
});
socket.on("webrtc-offer", async ({ fromId, fromName, offer }) => {
  const accepted = window.confirm(`${fromName || "A nearby device"} wants to send you files. Accept the transfer?`);
  if (!accepted) return;
  try {
    const connection = createPeer(fromId, (incoming) => acceptDataChannel(incoming, fromName || "nearby device"));
    await connection.setRemoteDescription(offer);
    for (const candidate of incomingCandidates.splice(0)) {
      try { await connection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
    }
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    if (!navigator.onLine) await waitForIceGathering(connection);
    socket.emit("webrtc-answer", { targetId: fromId, answer: connection.localDescription });
    setStatus(`Connecting to ${fromName || "device"}…`);
  } catch (err) {
    setStatus(`Could not accept the transfer: ${err.message}`, "error");
  }
});
socket.on("webrtc-answer", async ({ fromId, answer }) => {
  if (!peer) return;
  try {
    await peer.setRemoteDescription(answer);
    for (const candidate of incomingCandidates.splice(0)) {
      try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
    }
  } catch (err) {
    setStatus(`Could not establish the connection: ${err.message}`, "error");
  }
});
socket.on("webrtc-ice-candidate", async ({ fromId, candidate }) => {
  if (!candidate || !candidate.candidate) return;
  if (!peer || !peer.remoteDescription) {
    incomingCandidates.push(candidate);
    return;
  }
  try {
    await peer.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (_) { /* Late candidate can be safely ignored */ }
});

nameInput.value = getDeviceName();
$("myDevice").textContent = nameInput.value;
$("saveName").addEventListener("click", () => {
  const name = nameInput.value.trim().slice(0, 40) || "My device";
  nameInput.value = name;
  localStorage.setItem("quickshare-device-name", name);
  $("myDevice").textContent = name;
  socket.emit("register-device", name);
});
fileInput.addEventListener("change", () => {
  selectedFiles = [...selectedFiles, ...Array.from(fileInput.files || [])];
  fileInput.value = "";
  renderFiles();
});
sendButton.addEventListener("click", sendFiles);
const dropZone = $("dropZone");
dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  selectedFiles = [...selectedFiles, ...Array.from(event.dataTransfer.files || [])];
  renderFiles();
});
renderDevices();
renderFiles();
