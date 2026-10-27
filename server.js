"use strict";

const express = require("express");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Server } = require("socket.io");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_DEVICES = Number.parseInt(process.env.MAX_DEVICES || "100", 10);
const PUBLIC_DIR = path.join(__dirname, "public");
const FRONTEND_DIR = path.join(__dirname, "frontend");
const SIGNAL_MAX_LENGTH = 100_000;
const CANDIDATE_MAX_LENGTH = 4_096;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error("PORT must be a valid TCP port from 1 to 65535.");
}
if (!Number.isInteger(MAX_DEVICES) || MAX_DEVICES < 1) {
  throw new Error("MAX_DEVICES must be a positive whole number.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 256 * 1024,
  pingInterval: 25_000,
  pingTimeout: 20_000,
  serveClient: true
});

// Presence exists only in memory. A restart clears the device list.
const devices = new Map();

app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; " +
      "img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  next();
});

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);
app.get("/api/devices", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ devices: listDevices() });
});

// Serve the testing UI from /public if present, and keep /frontend accessible at /classic
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
}
app.use("/classic", express.static(FRONTEND_DIR, { extensions: ["html"] }));
app.use(express.static(FRONTEND_DIR, {
  extensions: ["html"],
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});
app.use((err, _req, res, _next) => {
  console.error("HTTP request error:", err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
});

function healthHandler(_req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: "ok",
    service: "quickshare",
    uptimeSeconds: Math.floor(process.uptime()),
    connectedDevices: devices.size
  });
}

function listDevices() {
  return [...devices].map(([id, device]) => ({ id, name: device.name }));
}

function broadcastDevices() {
  io.emit("devices-updated", listDevices());
}

function cleanDeviceName(value) {
  if (typeof value !== "string") return "Unnamed device";
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return name.slice(0, 40) || "Unnamed device";
}

function consumeRateLimit(socket, eventName, limit, intervalMs) {
  const now = Date.now();
  const current = socket.data.rateLimits.get(eventName) || { count: 0, resetAt: now + intervalMs };
  if (now >= current.resetAt) {
    current.count = 0;
    current.resetAt = now + intervalMs;
  }
  current.count += 1;
  socket.data.rateLimits.set(eventName, current);
  return current.count <= limit;
}

function rejectEvent(socket, message) {
  socket.emit("server-error", { message });
}

function canSignal(socket, targetId, rateKey, maxPerMinute) {
  if (!consumeRateLimit(socket, rateKey, maxPerMinute, 60_000)) {
    rejectEvent(socket, "Too many connection messages. Wait a moment and try again.");
    return false;
  }
  if (!devices.has(socket.id)) {
    rejectEvent(socket, "Register this device before starting a transfer.");
    return false;
  }
  if (typeof targetId !== "string" || targetId === socket.id || !devices.has(targetId)) {
    rejectEvent(socket, "That device is no longer available.");
    return false;
  }
  return true;
}

function isDescription(value, expectedType) {
  return value && typeof value === "object" && value.type === expectedType &&
    typeof value.sdp === "string" && value.sdp.length > 0 && value.sdp.length <= SIGNAL_MAX_LENGTH;
}

function getClientIp(socket) {
  let address = socket.handshake?.address || socket.conn?.remoteAddress || "";
  if (typeof address !== "string") return "";
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (address === "::1") address = "127.0.0.1";
  return address;
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

function rewriteDescription(description, ip) {
  if (!description || typeof description !== "object") return description;
  const sdp = rewriteMdnsHost(description.sdp, ip);
  if (sdp === description.sdp) return description;
  return { type: description.type, sdp };
}

function rewriteIceCandidate(candidate, ip) {
  if (!candidate || typeof candidate !== "object") return candidate;
  const line = rewriteMdnsHost(candidate.candidate, ip);
  if (line === candidate.candidate) return candidate;
  return {
    candidate: line,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment
  };
}

io.on("connection", (socket) => {
  socket.data.rateLimits = new Map();
  socket.emit("session-info", { socketId: socket.id, clientIp: getClientIp(socket) });
  socket.emit("devices-updated", listDevices());

  socket.on("register-device", (rawName) => {
    if (!consumeRateLimit(socket, "register-device", 10, 60_000)) {
      rejectEvent(socket, "Device name changes are temporarily limited.");
      return;
    }
    if (!devices.has(socket.id) && devices.size >= MAX_DEVICES) {
      rejectEvent(socket, "This QuickShare server has reached its device limit.");
      return;
    }
    devices.set(socket.id, { name: cleanDeviceName(rawName), connectedAt: Date.now() });
    broadcastDevices();
  });

  socket.on("request-devices", () => {
    if (!consumeRateLimit(socket, "request-devices", 60, 60_000)) return;
    socket.emit("devices-updated", listDevices());
  });

  // Validated Connection Handshake
  socket.on("connection-request", (rawPayload) => {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
    const { targetId, filesInfo } = payload;
    if (!canSignal(socket, targetId, "connection-request", 30)) return;
    const sender = devices.get(socket.id);
    io.to(targetId).emit("connection-request", {
      fromId: socket.id,
      fromName: sender ? sender.name : "Nearby device",
      filesInfo: Array.isArray(filesInfo) ? filesInfo.slice(0, 50).map((f) => ({
        name: cleanDeviceName(f?.name || "file"),
        size: Number(f?.size) || 0,
        type: typeof f?.type === "string" ? f.type.slice(0, 100) : ""
      })) : []
    });
  });

  socket.on("connection-response", (rawPayload) => {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
    const { targetId, accepted, reason } = payload;
    if (!canSignal(socket, targetId, "connection-response", 30)) return;
    const responder = devices.get(socket.id);
    io.to(targetId).emit("connection-response", {
      fromId: socket.id,
      fromName: responder ? responder.name : "Nearby device",
      accepted: Boolean(accepted),
      reason: typeof reason === "string" ? reason.slice(0, 100) : ""
    });
  });

  socket.on("transfer-cancel", (rawPayload) => {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
    const { targetId, reason } = payload;
    if (!canSignal(socket, targetId, "transfer-cancel", 60)) return;
    io.to(targetId).emit("transfer-cancel", {
      fromId: socket.id,
      reason: typeof reason === "string" ? reason.slice(0, 100) : "Transfer was cancelled."
    });
  });

  // Only WebRTC setup messages pass through the server. File contents remain
  // on the peers' encrypted data channel and are never uploaded here.
  socket.on("webrtc-offer", (rawPayload) => {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
    const { targetId, offer } = payload;
    if (!canSignal(socket, targetId, "webrtc-offer", 20)) return;
    if (!isDescription(offer, "offer")) {
      rejectEvent(socket, "Invalid connection offer.");
      return;
    }
    const fromIp = getClientIp(socket);
    io.to(targetId).emit("webrtc-offer", {
      fromId: socket.id,
      fromName: devices.get(socket.id).name,
      fromIp,
      offer: rewriteDescription(offer, fromIp)
    });
  });

  socket.on("webrtc-answer", (rawPayload) => {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
    const { targetId, answer } = payload;
    if (!canSignal(socket, targetId, "webrtc-answer", 20)) return;
    if (!isDescription(answer, "answer")) {
      rejectEvent(socket, "Invalid connection answer.");
      return;
    }
    const fromIp = getClientIp(socket);
    io.to(targetId).emit("webrtc-answer", {
      fromId: socket.id,
      fromIp,
      answer: rewriteDescription(answer, fromIp)
    });
  });

  socket.on("webrtc-ice-candidate", (rawPayload) => {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
    const { targetId, candidate } = payload;
    if (!canSignal(socket, targetId, "webrtc-ice-candidate", 300)) return;
    if (!candidate || typeof candidate !== "object" ||
        typeof candidate.candidate !== "string" ||
        candidate.candidate.length === 0 || candidate.candidate.length > CANDIDATE_MAX_LENGTH) {
      rejectEvent(socket, "Invalid network candidate.");
      return;
    }
    const fromIp = getClientIp(socket);
    io.to(targetId).emit("webrtc-ice-candidate", {
      fromId: socket.id,
      fromIp,
      candidate: rewriteIceCandidate(candidate, fromIp)
    });
  });

  socket.on("disconnect", () => {
    if (devices.delete(socket.id)) broadcastDevices();
  });
});

function getNetworkUrls() {
  const urls = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const network of interfaces || []) {
      if (network.family === "IPv4" && !network.internal) {
        urls.push(`http://${network.address}:${PORT}`);
      }
    }
  }
  return [...new Set(urls)];
}

function start() {
  server.listen(PORT, HOST, () => {
    console.log(`QuickShare is running at http://localhost:${PORT}`);
    for (const url of getNetworkUrls()) console.log(`On your network: ${url}`);
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`\n[ERROR] Port ${PORT} is already in use by another application.`);
      console.error(`To run QuickShare on a different port, set the PORT environment variable:`);
      console.error(`  PowerShell:  $env:PORT="3001"; npm start`);
      console.error(`  CMD:         set PORT=3001 && npm start`);
      console.error(`  Bash:        PORT=3001 npm start\n`);
    } else {
      console.error(`Could not start QuickShare: ${error.message}`);
    }
    process.exitCode = 1;
  });
}

function shutdown(signal) {
  console.log(`\n${signal} received. Closing QuickShare…`);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  io.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

if (require.main === module) {
  start();
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = {
  app,
  server,
  io,
  devices,
  start,
  getClientIp,
  rewriteMdnsHost,
  rewriteDescription,
  rewriteIceCandidate
};
