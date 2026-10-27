/**
 * QuickShare Automated Integration Test
 * Verifies multi-device discovery, handshake, rejection/acceptance, signaling relay, and disconnect cleanup.
 */
const { io } = require("socket.io-client");
const assert = require("assert");
const { rewriteMdnsHost, rewriteIceCandidate, rewriteDescription } = require("./server");

const SERVER_URL = "http://localhost:3000";

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

async function runTests() {
  console.log("=== QuickShare Automated Integration Test Suite ===");
  testMdnsRewrite();

  // 1. Connect Client A (Laptop) and Client B (Phone)
  console.log("[Test 1] Connecting Client A and Client B...");
  const clientA = io(SERVER_URL);
  const clientB = io(SERVER_URL);

  await new Promise((resolve) => clientA.once("connect", resolve));
  await new Promise((resolve) => clientB.once("connect", resolve));

  assert(clientA.id && clientB.id, "Both clients must have valid socket IDs");
  assert.notStrictEqual(clientA.id, clientB.id, "Client IDs must be unique");
  console.log(`✓ Both clients connected: Client A (${clientA.id}) & Client B (${clientB.id})`);

  // 2. Register device names
  console.log("[Test 2] Registering device names...");
  clientA.emit("register-device", "Alice's Laptop");
  clientB.emit("register-device", "Bob's Phone");

  // Wait for presence updates
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Request devices on client A
  const devicesForA = await new Promise((resolve) => {
    clientA.once("devices-updated", resolve);
    clientA.emit("request-devices");
  });

  console.log("Devices reported by server:", devicesForA);
  assert(devicesForA.some((d) => d.id === clientA.id && d.name === "Alice's Laptop"), "Client A must be in device list");
  assert(devicesForA.some((d) => d.id === clientB.id && d.name === "Bob's Phone"), "Client B must be in device list");
  console.log("✓ Device registration and presence broadcast verified");

  // 3. Test Connection Request and Rejection
  console.log("[Test 3] Testing Connection Request -> Rejection...");
  const filesMetadata = [
    { name: "test-document.pdf", size: 1048576, type: "application/pdf" },
    { name: "empty-file.txt", size: 0, type: "text/plain" }
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
  assert.strictEqual(incomingRequest.filesInfo[0].name, "test-document.pdf");
  assert.strictEqual(incomingRequest.filesInfo[1].size, 0);
  console.log("✓ Receiver received connection-request with accurate file metadata");

  // Client B declines
  const rejectResponsePromise = new Promise((resolve) => {
    clientA.once("connection-response", resolve);
  });

  clientB.emit("connection-response", {
    targetId: clientA.id,
    accepted: false,
    reason: "Receiver declined"
  });

  const rejectResponse = await rejectResponsePromise;
  assert.strictEqual(rejectResponse.fromId, clientB.id);
  assert.strictEqual(rejectResponse.accepted, false);
  assert.strictEqual(rejectResponse.reason, "Receiver declined");
  console.log("✓ Sender received rejection response cleanly");

  // 4. Test Connection Request -> Acceptance
  console.log("[Test 4] Testing Connection Request -> Acceptance...");
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

  // 5. Test WebRTC Signaling Exchange (Offer, Answer, ICE candidate)
  console.log("[Test 5] Testing WebRTC Offer / Answer / ICE Candidate exchange...");
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

  // 6. Test Transfer Cancellation
  console.log("[Test 6] Testing Transfer Cancel event...");
  const cancelReceivedPromise = new Promise((resolve) => clientB.once("transfer-cancel", resolve));
  clientA.emit("transfer-cancel", { targetId: clientB.id, reason: "Cancelled by Alice" });
  const receivedCancel = await cancelReceivedPromise;
  assert.strictEqual(receivedCancel.reason, "Cancelled by Alice");
  console.log("✓ Transfer cancel relayed cleanly");

  // 7. Test Disconnect & Cleanup
  console.log("[Test 7] Testing Client Disconnect and Presence Cleanup...");
  const updateAfterDisconnectPromise = new Promise((resolve) => clientA.once("devices-updated", resolve));
  clientB.disconnect();

  const remainingDevices = await updateAfterDisconnectPromise;
  assert(!remainingDevices.some((d) => d.id === clientB.id), "Client B must be removed after disconnect");
  assert(remainingDevices.some((d) => d.id === clientA.id), "Client A must remain after Client B disconnects");
  console.log("✓ Client B disconnect handled: presence updated cleanly");

  clientA.disconnect();
  console.log("\n========================================================");
  console.log("ALL AUTOMATED SIGNALING & PROTOCOL TESTS PASSED (7/7)");
  console.log("========================================================");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
