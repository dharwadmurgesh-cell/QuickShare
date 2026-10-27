# QuickShare — Local Network P2P File Transfer MVP

QuickShare is a SHAREit-style web application for transferring files directly between devices (laptops, phones, tablets) connected to the same Wi-Fi network or mobile hotspot.

It uses **Socket.IO** solely for device discovery, connection negotiation, and WebRTC signaling. **File contents are never sent to or stored on the server**; they travel directly peer-to-peer over an encrypted **WebRTC DataChannel** using chunked binary streaming.

---

## Architecture Overview

```
 [ Device A: Sender ]                           [ Device B: Receiver ]
          |                                               |
          | ----- 1. Register Device / Discover Peers ----|----> [ Server: Express + Socket.IO ]
          |                                               |              |
          | ----- 2. Connection Request (File Info) ----->| (Relayed by server)
          |<----- 3. Connection Response (Accept/Reject) -| (Relayed by server)
          |                                               |
          | <==== 4. WebRTC Signaling (Offer/Answer/ICE)==> (Relayed by server)
          |                                               |
  =================================================================
             DIRECT PEER-TO-PEER WEBRTC DATACHANNEL (P2P)
  =================================================================
          |                                               |
          | ===== 5. 64 KB Binary Chunks Streaming =====>| (Direct P2P, no server)
          | ===== 6. File Completion & Byte Verification=>| (Receiver verifies bytes)
          |                                               | (Receiver clicks Download)
```

- **Frontend**: Vanilla HTML5, CSS3, JavaScript (no bundlers or heavy frameworks required).
  - Testing Interface: Located in `/public` (default interface served at `/`).
  - Classic Styled UI: Located in `/frontend` (preserved and accessible at `/classic`).
- **Backend**: Node.js, Express, Socket.IO.
- **Data Transfer**: WebRTC DataChannel (`binaryType = "arraybuffer"`, 64 KB chunk size, backpressure threshold control via `bufferedAmount` & `onbufferedamountlow`).
- **Integrity**: Exact byte-count validation before marking a transfer completed.
- **Storage & State**: In-memory ephemeral presence; zero disk storage or databases.

---

## Getting Started

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (version 18 or newer recommended).

### 2. Installation
Open a terminal in the project folder and install dependencies:
```bash
npm install
```

### 3. Start the Server
```bash
npm start
```
The server will start and print the available URLs:
```
QuickShare is running at http://localhost:3000
On your network: http://192.168.1.100:3000
```

### 4. Port Configuration & Troubleshooting (EADDRINUSE)
If port 3000 is already in use by another application, configure a different port using the `PORT` environment variable:
- **Windows PowerShell**:
  ```powershell
  $env:PORT="3001"; npm start
  ```
- **Windows Command Prompt (CMD)**:
  ```cmd
  set PORT=3001 && npm start
  ```
- **Linux / macOS**:
  ```bash
  PORT=3001 npm start
  ```

---

## How to Transfer Files

1. **Open Device 1 (e.g. Laptop)**:
   - Navigate to `http://localhost:3000` (or `http://127.0.0.1:3000`).
2. **Open Device 2 (e.g. Mobile Phone or Second Laptop)**:
   - Connect to the **same Wi-Fi network or mobile hotspot**.
   - In your mobile browser, navigate to the network address displayed in the terminal (e.g. `http://192.168.1.100:3000`).
3. **Device Discovery**:
   - Both devices will register and appear in each other’s **Available Devices** list in real-time.
   - Click **Save** to customize your device name at any time.
4. **Select Files**:
   - On the sender device, click **Choose files** or drag and drop files (multiple files and empty 0-byte files supported).
5. **Initiate Transfer**:
   - Select the target device and click **Send Files**.
6. **Accept on Receiver**:
   - An in-page notification banner will appear on the receiving device showing the sender's name and file details.
   - Click **Accept** (or **Reject** to decline).
7. **Progress & Download**:
   - The transfer progress bar updates in real time with percentage and transferred bytes.
   - Once all chunks arrive, the receiver verifies that received bytes match expected bytes.
   - A verified file entry appears with a green badge and an explicit **Download [filename]** button to save the file.
8. **Cancellation**:
   - Either device can click **Cancel Transfer** at any time to abort the transfer cleanly.

---

## Automated Testing

An automated integration test suite is provided to verify multi-device presence, handshake, rejection/acceptance, WebRTC signaling relay, and disconnect cleanup.

Run the test suite:
```bash
npm test
```

### Test Results Breakdown

| Test Area | Status | Verification Method |
| :--- | :---: | :--- |
| **Server startup without errors** | **VERIFIED** | Server starts on `0.0.0.0:3000`, logs local network IPs. |
| **`/health` endpoint** | **VERIFIED** | Returns `{ status: "ok", service: "quickshare", uptimeSeconds, connectedDevices }`. |
| **`/api/devices` endpoint** | **VERIFIED** | Returns `{ devices: [...] }` matching in-memory state. |
| **Two sessions appear as separate devices** | **VERIFIED** | Automated test connects Client A and Client B; both obtain unique IDs. |
| **Device list updates on disconnect** | **VERIFIED** | Tested in `test_signaling.js`; device count updates from 2 to 1 immediately. |
| **Connection request & in-page accept/reject** | **VERIFIED** | Tested in `test_signaling.js`; rejection and acceptance events cleanly forwarded. |
| **WebRTC offer, answer, and ICE candidate exchange** | **VERIFIED** | Tested in `test_signaling.js`; SDP and candidate payloads verified. |
| **DataChannel chunking & backpressure control** | **IMPLEMENTED** | 64 KB chunk slicing with `waitForBuffer` monitoring `bufferedAmount`. |
| **Integrity verification (expected vs received bytes)** | **IMPLEMENTED** | Receiver checks `fileBytesReceived === currentFile.size` before creating Blob. |
| **Download button for mobile pop-up safety** | **IMPLEMENTED** | User-triggered download button avoids mobile pop-up blocker issues. |
| **Empty file (0 bytes) transfer** | **IMPLEMENTED** | Special case sends immediate `file-end` with 0-byte checksum; verified Blob created. |
| **Multi-device Wi-Fi / Hotspot test** | **MANUAL CHECK** | Ready for manual verification across physical laptop and phone on local Wi-Fi/hotspot. |

---

## Network Requirements & Troubleshooting

1. **Same Local Network / Hotspot**:
   - Both devices must be on the same subnet (e.g., connected to the same Wi-Fi router or mobile hotspot).
2. **Access Point (AP) Isolation / Guest Networks**:
   - Many public Wi-Fi networks (hotels, cafes, guest networks) enable **AP Isolation**, which blocks devices on the same Wi-Fi from talking to each other directly.
   - If devices cannot connect, test using a **Mobile Hotspot** from a phone.
3. **STUN and TURN Servers**:
   - QuickShare uses Google's public STUN servers (`stun:stun.l.google.com:19302`) to find local reflexive ICE candidates.
   - STUN works for direct and NAT traversal. However, if devices are behind **symmetric NATs** or strict enterprise firewalls, a **TURN relay** server is required to relay peer traffic.
4. **Browser Memory for Large Files**:
   - This MVP reassembles received chunks in browser memory (`Blob`). For transfers above 500 MB, device RAM constraints (especially on mobile devices) may apply. Future versions can use the FileSystem Access API / Streams API to stream directly to disk.

---

## Project Structure

```
QuickShare/
├── .gitignore               # Ignores node_modules and OS artifacts
├── package.json             # Express, Socket.IO, and test scripts
├── server.js                # Express server, Socket.IO signaling, health endpoint
├── test_signaling.js        # Automated integration tests for signaling & handshake
├── public/                  # Temporary testing frontend (served at /)
│   ├── index.html           # 16-point functional testing UI
│   ├── style.css            # Responsive styles, badges, progress bar, diagnostics
│   └── app.js               # WebRTC peer connection, chunk streaming, verification
├── frontend/                # Classic styled frontend (preserved & accessible at /classic)
│   ├── index.html
│   ├── style.css
│   └── script.js
└── README.md                # Documentation, guide, and testing results
```
