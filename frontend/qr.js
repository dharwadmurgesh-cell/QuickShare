"use strict";

/**
 * QuickShare — Offline QR Code Generator (ISO/IEC 18004)
 * 100% Client-side, zero external dependencies or internet connection required.
 */
window.QuickShareQR = (() => {
  // Galois Field GF(256) tables
  const EXP_TABLE = new Uint8Array(256);
  const LOG_TABLE = new Uint8Array(256);
  for (let i = 0, x = 1; i < 256; i++) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d; // Primitive polynomial: x^8 + x^4 + x^3 + x^2 + 1
  }

  function glog(n) {
    if (n < 1) throw new Error("glog(" + n + ")");
    return LOG_TABLE[n];
  }
  function gexp(n) {
    while (n < 0) n += 255;
    while (n >= 256) n -= 255;
    return EXP_TABLE[n];
  }

  function polyMul(p1, p2) {
    const res = new Uint8Array(p1.length + p2.length - 1);
    for (let i = 0; i < p1.length; i++) {
      for (let j = 0; j < p2.length; j++) {
        if (p1[i] !== 0 && p2[j] !== 0) {
          res[i + j] ^= gexp(glog(p1[i]) + glog(p2[j]));
        }
      }
    }
    return res;
  }

  function getGeneratorPoly(ecLength) {
    let poly = new Uint8Array([1]);
    for (let i = 0; i < ecLength; i++) {
      poly = polyMul(poly, new Uint8Array([1, gexp(i)]));
    }
    return poly;
  }

  function calculateRS(data, ecLength) {
    const gen = getGeneratorPoly(ecLength);
    const result = new Uint8Array(data.length + ecLength);
    result.set(data, 0);

    for (let i = 0; i < data.length; i++) {
      const coef = result[i];
      if (coef !== 0) {
        const logC = glog(coef);
        for (let j = 0; j < gen.length; j++) {
          result[i + j] ^= gexp(logC + glog(gen[j]));
        }
      }
    }
    return result.slice(data.length);
  }

  const MODE_BYTE = 0x4;

  // Version specs for ECC Level M:
  const VERSION_SPECS = [
    null,
    { version: 1, size: 21, totalCW: 26, ecCW: 10, blocks: [[1, 16]] },
    { version: 2, size: 25, totalCW: 44, ecCW: 16, blocks: [[1, 28]], align: [6, 18] },
    { version: 3, size: 29, totalCW: 70, ecCW: 26, blocks: [[1, 44]], align: [6, 22] },
    { version: 4, size: 33, totalCW: 100, ecCW: 36, blocks: [[2, 32]], align: [6, 26] },
    { version: 5, size: 37, totalCW: 134, ecCW: 48, blocks: [[2, 43]], align: [6, 30] },
    { version: 6, size: 41, totalCW: 172, ecCW: 64, blocks: [[4, 27]], align: [6, 34] },
    { version: 7, size: 45, totalCW: 196, ecCW: 72, blocks: [[4, 31]], align: [6, 22, 38] },
    { version: 8, size: 49, totalCW: 242, ecCW: 88, blocks: [[2, 38], [2, 39]], align: [6, 24, 42] }
  ];

  function selectVersion(dataLength) {
    for (let v = 1; v < VERSION_SPECS.length; v++) {
      const spec = VERSION_SPECS[v];
      let capacityDataBytes = 0;
      for (const [count, dcw] of spec.blocks) {
        capacityDataBytes += count * dcw;
      }
      const charCountBits = 8;
      const totalBitsNeeded = 4 + charCountBits + (dataLength * 8);
      if (totalBitsNeeded <= capacityDataBytes * 8) {
        return { spec, capacityDataBytes };
      }
    }
    throw new Error("URL is too long for local QR code pairing.");
  }

  class BitBuffer {
    constructor() {
      this.buffer = [];
      this.length = 0;
    }
    put(num, length) {
      for (let i = 0; i < length; i++) {
        this.putBit(((num >>> (length - i - 1)) & 1) === 1);
      }
    }
    putBit(bit) {
      const bufIndex = Math.floor(this.length / 8);
      if (this.buffer.length <= bufIndex) {
        this.buffer.push(0);
      }
      if (bit) {
        this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
      }
      this.length++;
    }
  }

  function encodeData(text, spec, capacityDataBytes) {
    const utf8 = new TextEncoder().encode(text);
    const bb = new BitBuffer();

    bb.put(MODE_BYTE, 4);
    bb.put(utf8.length, 8);
    for (let i = 0; i < utf8.length; i++) {
      bb.put(utf8[i], 8);
    }

    const totalDataBits = capacityDataBytes * 8;
    const paddingCount = Math.min(4, totalDataBits - bb.length);
    for (let i = 0; i < paddingCount; i++) bb.putBit(false);

    while (bb.length % 8 !== 0) bb.putBit(false);

    const padBytes = [0xEC, 0x11];
    let padIndex = 0;
    while (bb.length < totalDataBits) {
      bb.put(padBytes[padIndex % 2], 8);
      padIndex++;
    }

    return new Uint8Array(bb.buffer);
  }

  const FORMAT_INFO_M = [
    0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0
  ];

  function createMatrix(spec) {
    const size = spec.size;
    const matrix = Array.from({ length: size }, () => new Int8Array(size).fill(-1));

    function placeFinder(row, col) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const nr = row + r;
          const nc = col + c;
          if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
          if (r >= 0 && r <= 6 && (c === 0 || c === 6) ||
              c >= 0 && c <= 6 && (r === 0 || r === 6) ||
              r >= 2 && r <= 4 && c >= 2 && c <= 4) {
            matrix[nr][nc] = 1;
          } else {
            matrix[nr][nc] = 0;
          }
        }
      }
    }
    placeFinder(0, 0);
    placeFinder(0, size - 7);
    placeFinder(size - 7, 0);

    if (spec.align) {
      const coords = spec.align;
      for (let i = 0; i < coords.length; i++) {
        for (let j = 0; j < coords.length; j++) {
          const r = coords[i];
          const c = coords[j];
          if (matrix[r][c] !== -1) continue;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              if (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) {
                matrix[r + dr][c + dc] = 1;
              } else {
                matrix[r + dr][c + dc] = 0;
              }
            }
          }
        }
      }
    }

    for (let i = 8; i < size - 8; i++) {
      if (matrix[6][i] === -1) matrix[6][i] = (i % 2 === 0) ? 1 : 0;
      if (matrix[i][6] === -1) matrix[i][6] = (i % 2 === 0) ? 1 : 0;
    }

    matrix[4 * spec.version + 9][8] = 1;

    for (let i = 0; i < 9; i++) {
      if (matrix[8][i] === -1) matrix[8][i] = -2;
      if (matrix[i][8] === -1) matrix[i][8] = -2;
    }
    for (let i = size - 8; i < size; i++) {
      if (matrix[8][i] === -1) matrix[8][i] = -2;
      if (matrix[i][8] === -1) matrix[i][8] = -2;
    }

    return matrix;
  }

  function interleaveData(dataBytes, spec) {
    const blocksData = [];
    const blocksEC = [];
    let offset = 0;

    const ecPerBlock = spec.ecCW / spec.blocks.reduce((acc, b) => acc + b[0], 0);

    for (const [blockCount, dataCW] of spec.blocks) {
      for (let b = 0; b < blockCount; b++) {
        const d = dataBytes.slice(offset, offset + dataCW);
        offset += dataCW;
        blocksData.push(d);
        blocksEC.push(calculateRS(d, ecPerBlock));
      }
    }

    const interleaved = [];
    const maxDataLen = Math.max(...blocksData.map((b) => b.length));
    for (let i = 0; i < maxDataLen; i++) {
      for (const b of blocksData) {
        if (i < b.length) interleaved.push(b[i]);
      }
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (const ec of blocksEC) {
        if (i < ec.length) interleaved.push(ec[i]);
      }
    }
    return new Uint8Array(interleaved);
  }

  function placeDataBits(matrix, interleavedBytes, maskPattern) {
    const size = matrix.length;
    let byteIdx = 0;
    let bitIdx = 7;

    let up = true;
    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right--;

      const rows = [];
      if (up) {
        for (let r = size - 1; r >= 0; r--) rows.push(r);
      } else {
        for (let r = 0; r < size; r++) rows.push(r);
      }
      up = !up;

      for (const r of rows) {
        for (let c = right; c > right - 2; c--) {
          if (matrix[r][c] === -1) {
            let bit = false;
            if (byteIdx < interleavedBytes.length) {
              bit = ((interleavedBytes[byteIdx] >>> bitIdx) & 1) === 1;
              bitIdx--;
              if (bitIdx < 0) {
                bitIdx = 7;
                byteIdx++;
              }
            }
            const mask = ((r + c) % 2 === 0);
            matrix[r][c] = (bit ^ mask) ? 1 : 0;
          }
        }
      }
    }
  }

  function placeFormatInfo(matrix, mask) {
    const size = matrix.length;
    const formatBits = FORMAT_INFO_M[mask];

    for (let i = 0; i < 15; i++) {
      const bit = ((formatBits >>> (14 - i)) & 1);
      if (i <= 5) matrix[8][i] = bit;
      else if (i === 6) matrix[8][7] = bit;
      else if (i === 7) matrix[8][8] = bit;
      else if (i === 8) matrix[7][8] = bit;
      else matrix[14 - i][8] = bit;

      if (i < 8) {
        matrix[size - 1 - i][8] = bit;
      } else {
        matrix[8][size - (15 - i)] = bit;
      }
    }
  }

  function generateSvg(text, sizePx = 200, margin = 4) {
    const { spec, capacityDataBytes } = selectVersion(text.length);
    const dataBytes = encodeData(text, spec, capacityDataBytes);
    const interleaved = interleaveData(dataBytes, spec);

    const mask = 0;
    const matrix = createMatrix(spec);
    placeDataBits(matrix, interleaved, mask);
    placeFormatInfo(matrix, mask);

    const modules = matrix.length;
    const fullSize = modules + (margin * 2);

    let path = "";
    for (let r = 0; r < modules; r++) {
      for (let c = 0; c < modules; c++) {
        if (matrix[r][c] === 1) {
          path += `M${c + margin},${r + margin}h1v1h-1z `;
        }
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fullSize} ${fullSize}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges" aria-label="QR Code for ${text}" role="img">
  <rect width="100%" height="100%" fill="#ffffff" rx="4"/>
  <path d="${path}" fill="#0b0e19"/>
</svg>`;
  }

  return { generateSvg };
})();
