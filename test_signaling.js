/**
 * QuickShare Automated Integration Test Suite
 * Tests:
 * 0. mDNS host candidate rewriting
 * 1. HTTP Endpoint Routing & Asset Integrity (/, /health, /api/devices, /api/network-urls, /style.css, /script.js, /qr.js, /testing)
 * 2. Standalone Offline QR Code generation
 * 3. Multi-device discovery and Socket.IO connection
 * 4. Device registration and presence broadcasting
 * 5. In-page Handshake: Connection Request -> Rejection
 * 6. In-page Handshake: Connection Request -> Acceptance
 * 7. WebRTC Offer / Answer / ICE candidate relaying
 * 8. Transfer cancellation relaying
 * 9. Peer disconnection and presence cleanup
 */
const { io } = require("socket.io-client");
const http = require("http");
const assert = require("assert");
const { server, rewriteMdnsHost, rewriteIceCandidate, rewriteDescription } = require("./server");

const SERVER_URL = "http://127.0.0.1:3000";
let serverStartedLocally = false;

function fetchUrl(path) {
  return new Promise((resolve, reject) => {
    http.get(`${SERVER_URL}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    }).on("error", reject);
  });
}

function testMdnsRewrite() {
  console.log("[Test 0] Rewriting Chrome mDNS host candidates to LAN IPs...");
  const mdnsLine = "candidate:842163049 1 udp 1677729535 abcdef12-3456-7890-abcd-ef1234567890.local 54123 typ host";
  const rewritten = rewriteMdnsHost(mdnsLine, "192.168.1.20");
  assert.ok(rewritten.includes("192.168.1.20"), "mDNS host name must be replaced with the signaling LAN IP");
  assert.ok(!rewritten.includes(".local"), "rewritten candidate must not keep the .local hostname");

  const candidate = rewriteIceCandidate({ candidate: mdnsLine, sdpMid: "0", sdpMLineIndex: 0 }, "10.0.0.8");
  assert.strictEqual(candidate.sdpMid, "0");
  assert.ok(candidate.candidate.includes("10.0.0.8"));

  const offer = rewriteDescription({
    type: "offer",
    sdp: "a=candidate:1 1 udp 1 uuid-name.local 9 typ host\r\n"
  }, "127.0.0.1");
  assert.ok(offer.sdp.includes("127.0.0.1"));
  assert.strictEqual(rewriteMdnsHost(mdnsLine, "8.8.8.8"), mdnsLine, "public IPs must not be used as host rewrites");
  console.log("✓ mDNS host candidates rewrite to private LAN IPs");
}

async function testHttpEndpoints() {
  console.log("[Test 1] Testing HTTP Endpoints & Asset Routing...");

  // 1. Root / must serve frontend/index.html (NOT public testing interface)
  const rootRes = await fetchUrl("/");
  assert.strictEqual(rootRes.statusCode, 200, "Root must return 200 OK");
  assert.ok(rootRes.body.includes("QuickShare"), "Root must include QuickShare");
  assert.ok(rootRes.body.includes("FAST. PRIVATE. NEARBY."), "Root must load the styled frontend/index.html");
  assert.ok(rootRes.body.includes("/qr.js"), "Root must include qr.js");
  assert.ok(rootRes.body.includes("receivedCard"), "Root must include received files card");
  assert.ok(rootRes.body.includes("incomingModal"), "Root must include in-page incoming transfer modal");
  console.log("✓ Root (/) serves frontend/index.html with all required components");

  // 2. /health endpoint
  const healthRes = await fetchUrl("/health");
  assert.strictEqual(healthRes.statusCode, 200);
  const healthJson = JSON.parse(healthRes.body);
  assert.strictEqual(healthJson.status, "ok");
  assert.strictEqual(healthJson.service, "quickshare");
  console.log("✓ /health returns 200 OK with service status");

  // 3. /api/devices endpoint
  const devRes = await fetchUrl("/api/devices");
  assert.strictEqual(devRes.statusCode, 200);
  const devJson = JSON.parse(devRes.body);
  assert.ok(Array.isArray(devJson.devices));
  console.log("✓ /api/devices returns 200 OK with device list array");

  // 4. /api/network-urls endpoint
  const netRes = await fetchUrl("/api/network-urls");
  assert.strictEqual(netRes.statusCode, 200);
  const netJson = JSON.parse(netRes.body);
  assert.ok(Array.isArray(netJson.urls));
  console.log("✓ /api/network-urls returns 200 OK with network URLs list");

  // 5. /style.css must serve frontend/style.css
  const cssRes = await fetchUrl("/style.css");
  assert.strictEqual(cssRes.statusCode, 200);
  assert.ok(cssRes.body.includes("--bg: #0b0e19"), "style.css must be frontend/style.css");
  assert.ok(cssRes.body.includes("modal-backdrop"), "style.css must include modal styles");
  console.log("✓ /style.css correctly serves frontend/style.css");

  // 6. /script.js must serve frontend/script.js
  const jsRes = await fetchUrl("/script.js");
  assert.strictEqual(jsRes.statusCode, 200);
  assert.ok(jsRes.body.includes("QuickShare"), "script.js must be frontend/script.js");
  assert.ok(jsRes.body.includes("connection-request"), "script.js must implement connection-request");
  console.log("✓ /script.js correctly serves frontend/script.js");

  // 7. /qr.js must serve frontend/qr.js
  const qrRes = await fetchUrl("/qr.js");
  assert.strictEqual(qrRes.statusCode, 200);
  assert.ok(qrRes.body.includes("QuickShareQR"), "qr.js must export QuickShareQR");
  console.log("✓ /qr.js correctly serves offline QR generator");

  // 8. /testing/ must serve the public diagnostic interface
  const testRes = await fetchUrl("/testing/");
  assert.strictEqual(testRes.statusCode, 200);
  assert.ok(testRes.body.includes("Testing Interface"), "/testing/ must serve public/index.html");
  console.log("✓ /testing/ correctly serves the diagnostic interface");
}

function testQrCodeGeneration() {
  console.log("[Test 2] Testing Standalone Offline QR Code Generation...");
  // Simulate browser window object for qr.js
  global.window = {};
  require("./frontend/qr.js");
  assert.ok(global.window.QuickShareQR, "QuickShareQR must be initialized on window");

  const svg = global.window.QuickShareQR.generateSvg("http://192.168.1.100:3000", 200);
  assert.ok(svg.startsWith("<svg"), "Must output valid SVG markup");
  assert.ok(svg.includes("viewBox="), "SVG must have viewBox");
  assert.ok(svg.includes("shape-rendering="), "SVG must have crispEdges shape-rendering");
  assert.ok(svg.includes("width=\"200\""), "SVG must respect custom sizePx");
  console.log(`✓ Offline QR code SVG generated successfully (${svg.length} bytes)`);
}

async function runTests() {
  console.log("========================================================");
  console.log("=== QuickShare Automated Comprehensive Test Suite ===");
  console.log("========================================================");

  // Auto-start server on port 3000 if not listening
  if (!server.listening) {
    await new Promise((resolve) => {
      server.listen(3000, "0.0.0.0", resolve);
    });
    serverStartedLocally = true;
    console.log("Started QuickShare server on port 3000 for test suite");
  }

  try {
    testMdnsRewrite();
    await testHttpEndpoints();
    testQrCodeGeneration();

    // 3. Connect Client A (Laptop) and Client B (Phone)
    console.log("[Test 3] Connecting Client A and Client B via Socket.IO...");
    const clientA = io(SERVER_URL);
    const clientB = io(SERVER_URL);

    await new Promise((resolve) => clientA.once("connect", resolve));
    await new Promise((resolve) => clientB.once("connect", resolve));

    assert(clientA.id && clientB.id, "Both clients must have valid socket IDs");
    assert.notStrictEqual(clientA.id, clientB.id, "Client IDs must be unique");
    console.log(`✓ Both clients connected: Client A (${clientA.id}) & Client B (${clientB.id})`);

    // 4. Register device names
    console.log("[Test 4] Registering device names...");
    clientA.emit("register-device", "Alice's Laptop");
    clientB.emit("register-device", "Bob's Phone");

    await new Promise((resolve) => setTimeout(resolve, 300));

    const devicesForA = await new Promise((resolve) => {
      clientA.once("devices-updated", resolve);
      clientA.emit("request-devices");
    });

    assert(devicesForA.some((d) => d.id === clientA.id && d.name === "Alice's Laptop"), "Client A must be in device list");
    assert(devicesForA.some((d) => d.id === clientB.id && d.name === "Bob's Phone"), "Client B must be in device list");
    console.log("✓ Device registration and presence broadcast verified");

    // 5. Test Connection Request and Rejection
    console.log("[Test 5] Testing Connection Request -> Rejection...");
    const filesMetadata = [
      { name: "trip-photo.jpg", size: 3145728, type: "image/jpeg" },
      { name: "empty-notes.txt", size: 0, type: "text/plain" }
    ];

    const requestReceivedPromise = new Promise((resolve) => {
      clientB.once("connection-request", resolve);
    });

    clientA.emit("connection-request", {
      targetId: clientB.id,
      filesInfo: filesMetadata
    });

    const incomingRequest = await requestReceivedPromise;
    assert.strictEqual(incomingRequest.fromId, clientA.id);
    assert.strictEqual(incomingRequest.fromName, "Alice's Laptop");
    assert.strictEqual(incomingRequest.filesInfo.length, 2);
    assert.strictEqual(incomingRequest.filesInfo[0].name, "trip-photo.jpg");
    assert.strictEqual(incomingRequest.filesInfo[1].size, 0);
    console.log("✓ Receiver received connection-request with accurate file metadata");

    const rejectResponsePromise = new Promise((resolve) => {
      clientA.once("connection-response", resolve);
    });

    clientB.emit("connection-response", {
      targetId: clientA.id,
      accepted: false,
      reason: "Receiver declined transfer"
    });

    const rejectResponse = await rejectResponsePromise;
    assert.strictEqual(rejectResponse.fromId, clientB.id);
    assert.strictEqual(rejectResponse.accepted, false);
    assert.strictEqual(rejectResponse.reason, "Receiver declined transfer");
    console.log("✓ Sender received rejection response cleanly");

    // 6. Test Connection Request -> Acceptance
    console.log("[Test 6] Testing Connection Request -> Acceptance...");
    const acceptRequestPromise = new Promise((resolve) => {
      clientB.once("connection-request", resolve);
    });

    clientA.emit("connection-request", {
      targetId: clientB.id,
      filesInfo: filesMetadata
    });

    await acceptRequestPromise;

    const acceptResponsePromise = new Promise((resolve) => {
      clientA.once("connection-response", resolve);
    });

    clientB.emit("connection-response", {
      targetId: clientA.id,
      accepted: true
    });

    const acceptResponse = await acceptResponsePromise;
    assert.strictEqual(acceptResponse.accepted, true);
    console.log("✓ Sender received acceptance response");

    // 7. Test WebRTC Signaling Exchange (Offer, Answer, ICE candidate)
    console.log("[Test 7] Testing WebRTC Offer / Answer / ICE Candidate exchange...");
    const dummyOffer = { type: "offer", sdp: "v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" };
    const dummyAnswer = { type: "answer", sdp: "v=0\r\no=- 67890 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" };
    const dummyCandidate = { candidate: "candidate:1 1 UDP 2122260223 127.0.0.1 50000 typ host", sdpMid: "0", sdpMLineIndex: 0 };

    const offerReceivedPromise = new Promise((resolve) => clientB.once("webrtc-offer", resolve));
    clientA.emit("webrtc-offer", { targetId: clientB.id, offer: dummyOffer });
    const receivedOffer = await offerReceivedPromise;
    assert.strictEqual(receivedOffer.offer.sdp, dummyOffer.sdp);
    console.log("✓ WebRTC offer relayed successfully to receiver");

    const answerReceivedPromise = new Promise((resolve) => clientA.once("webrtc-answer", resolve));
    clientB.emit("webrtc-answer", { targetId: clientA.id, answer: dummyAnswer });
    const receivedAnswer = await answerReceivedPromise;
    assert.strictEqual(receivedAnswer.answer.sdp, dummyAnswer.sdp);
    console.log("✓ WebRTC answer relayed successfully to sender");

    const candidateReceivedPromise = new Promise((resolve) => clientB.once("webrtc-ice-candidate", resolve));
    clientA.emit("webrtc-ice-candidate", { targetId: clientB.id, candidate: dummyCandidate });
    const receivedCandidate = await candidateReceivedPromise;
    assert.strictEqual(receivedCandidate.candidate.candidate, dummyCandidate.candidate);
    console.log("✓ ICE candidate relayed successfully");

    // 8. Test Transfer Cancellation
    console.log("[Test 8] Testing Transfer Cancel event...");
    const cancelReceivedPromise = new Promise((resolve) => clientB.once("transfer-cancel", resolve));
    clientA.emit("transfer-cancel", { targetId: clientB.id, reason: "Cancelled by Alice" });
    const receivedCancel = await cancelReceivedPromise;
    assert.strictEqual(receivedCancel.reason, "Cancelled by Alice");
    console.log("✓ Transfer cancel relayed cleanly");

    // 9. Test Disconnect & Cleanup
    console.log("[Test 9] Testing Client Disconnect and Presence Cleanup...");
    const updateAfterDisconnectPromise = new Promise((resolve) => clientA.once("devices-updated", resolve));
    clientB.disconnect();

    const remainingDevices = await updateAfterDisconnectPromise;
    assert(!remainingDevices.some((d) => d.id === clientB.id), "Client B must be removed after disconnect");
    assert(remainingDevices.some((d) => d.id === clientA.id), "Client A must remain after Client B disconnects");
    console.log("✓ Client B disconnect handled: presence updated cleanly");

    clientA.disconnect();

    console.log("\n========================================================");
    console.log("ALL AUTOMATED PROTOCOL & ROUTING TESTS PASSED (10/10)");
    console.log("========================================================");
  } finally {
    if (serverStartedLocally) {
      server.close();
    }
  }
  process.exit(0);
}

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  if (serverStartedLocally) {
    server.close();
  }
  process.exit(1);
});
