// Pure Node.js PNG generator for fox icons - no dependencies needed
// Uses raw PNG encoding with zlib for compression
const fs = require('fs');
const zlib = require('zlib');

function createPNG(width, height, pixels) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // IDAT chunk - raw image data with filter bytes
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      rawData[dstIdx] = pixels[srcIdx];     // R
      rawData[dstIdx + 1] = pixels[srcIdx + 1]; // G
      rawData[dstIdx + 2] = pixels[srcIdx + 2]; // B
      rawData[dstIdx + 3] = pixels[srcIdx + 3]; // A
    }
  }
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

// CRC32 implementation
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Color helpers
function hexToRGBA(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b, Math.round((alpha !== undefined ? alpha : 1) * 255)];
}

function lerpColor(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
    Math.round(c1[3] + (c2[3] - c1[3]) * t),
  ];
}

function drawFoxIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const s = size;
  const f = s / 128;

  const bg = hexToRGBA('#0a0a14');
  const orange1 = hexToRGBA('#fb923c');
  const orange2 = hexToRGBA('#f97316');
  const darkOrange = hexToRGBA('#ea580c');
  const cream = hexToRGBA('#fff5e0');
  const darkEye = hexToRGBA('#1a1a2e');
  const white = [255, 255, 255, 255];

  function setPixel(x, y, color) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= s || y < 0 || y >= s) return;
    const idx = (y * s + x) * 4;
    const srcA = color[3] / 255;
    const dstA = pixels[idx + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) return;
    pixels[idx] = Math.round((color[0] * srcA + pixels[idx] * dstA * (1 - srcA)) / outA);
    pixels[idx + 1] = Math.round((color[1] * srcA + pixels[idx + 1] * dstA * (1 - srcA)) / outA);
    pixels[idx + 2] = Math.round((color[2] * srcA + pixels[idx + 2] * dstA * (1 - srcA)) / outA);
    pixels[idx + 3] = Math.round(outA * 255);
  }

  function dist(x1, y1, x2, y2) {
    return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
  }

  function pointInTriangle(px, py, x1, y1, x2, y2, x3, y3) {
    const d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
    const d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3);
    const d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
  }

  // Rounded rect background
  const rr = 19 * f;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let inside = false;
      if (x >= rr && x < s - rr) inside = true;
      else if (y >= rr && y < s - rr) inside = true;
      else {
        // Check corner circles
        const corners = [[rr, rr], [s - rr, rr], [rr, s - rr], [s - rr, s - rr]];
        for (const [cx, cy] of corners) {
          if (dist(x, y, cx, cy) <= rr) { inside = true; break; }
        }
      }
      if (inside) setPixel(x, y, bg);
    }
  }

  // Draw ears (triangles)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // Left ear
      if (pointInTriangle(x, y, 25 * f, 85 * f, 18 * f, 22 * f, 50 * f, 52 * f)) {
        const t = (y - 22 * f) / (85 * f - 22 * f);
        setPixel(x, y, lerpColor(orange1, orange2, Math.max(0, Math.min(1, t))));
      }
      // Right ear
      if (pointInTriangle(x, y, 103 * f, 85 * f, 110 * f, 22 * f, 78 * f, 52 * f)) {
        const t = (y - 22 * f) / (85 * f - 22 * f);
        setPixel(x, y, lerpColor(orange1, orange2, Math.max(0, Math.min(1, t))));
      }
      // Inner left ear
      if (pointInTriangle(x, y, 30 * f, 75 * f, 26 * f, 38 * f, 47 * f, 57 * f)) {
        setPixel(x, y, darkOrange);
      }
      // Inner right ear
      if (pointInTriangle(x, y, 98 * f, 75 * f, 102 * f, 38 * f, 81 * f, 57 * f)) {
        setPixel(x, y, darkOrange);
      }
    }
  }

  // Draw face (ellipse-like shape)
  const faceCx = 64 * f;
  const faceCy = 82 * f;
  const faceRx = 39 * f;
  const faceRy = 30 * f;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = (x - faceCx) / faceRx;
      const dy = (y - faceCy) / faceRy;
      // Egg shape - wider at top
      const yBias = dy < 0 ? 0.85 : 1.15;
      if (dx * dx + (dy * yBias) * (dy * yBias) <= 1) {
        const t = (y - 48 * f) / (112 * f - 48 * f);
        setPixel(x, y, lerpColor(orange2, darkOrange, Math.max(0, Math.min(1, t))));
      }
    }
  }

  // Draw muzzle (smaller ellipse)
  const muzzleCx = 64 * f;
  const muzzleCy = 92 * f;
  const muzzleRx = 24 * f;
  const muzzleRy = 18 * f;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = (x - muzzleCx) / muzzleRx;
      const dy = (y - muzzleCy) / muzzleRy;
      const yBias = dy < 0 ? 0.8 : 1.2;
      if (dx * dx + (dy * yBias) * (dy * yBias) <= 1) {
        setPixel(x, y, cream);
      }
    }
  }

  // Draw eyes (ellipses)
  const eyeRx = 5 * f;
  const eyeRy = 6 * f;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // Left eye
      const ldx = (x - 48 * f) / eyeRx;
      const ldy = (y - 76 * f) / eyeRy;
      if (ldx * ldx + ldy * ldy <= 1) {
        setPixel(x, y, darkEye);
      }
      // Left eye shine
      const lsx = (x - 46.5 * f) / (1.5 * f);
      const lsy = (y - 74 * f) / (1.5 * f);
      if (lsx * lsx + lsy * lsy <= 1) {
        setPixel(x, y, white);
      }
      // Right eye
      const rdx = (x - 80 * f) / eyeRx;
      const rdy = (y - 76 * f) / eyeRy;
      if (rdx * rdx + rdy * rdy <= 1) {
        setPixel(x, y, darkEye);
      }
      // Right eye shine
      const rsx = (x - 78.5 * f) / (1.5 * f);
      const rsy = (y - 74 * f) / (1.5 * f);
      if (rsx * rsx + rsy * rsy <= 1) {
        setPixel(x, y, white);
      }
    }
  }

  // Draw nose (triangle)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (pointInTriangle(x, y, 60 * f, 88 * f, 68 * f, 88 * f, 64 * f, 93 * f)) {
        setPixel(x, y, darkEye);
      }
    }
  }

  return Buffer.from(pixels);
}

// Generate icons
[16, 48, 128].forEach(size => {
  const pixels = drawFoxIcon(size);
  const png = createPNG(size, size, pixels);
  const outPath = __dirname + '/icon' + size + '.png';
  fs.writeFileSync(outPath, png);
  console.log('Created ' + outPath + ' (' + png.length + ' bytes)');
});

console.log('Done! All fox icons generated.');
