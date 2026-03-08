/**
 * Generates PWA icons with a beer mug logo.
 * Run: node generate-icons.js
 */
const zlib = require('zlib');
const fs = require('fs');

// ── CRC32 ──────────────────────────────────────────────────
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

// ── Pixel helpers ──────────────────────────────────────────
function setPixel(px, size, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 3;
  px[i] = r; px[i + 1] = g; px[i + 2] = b;
}
function fillRect(px, size, x1, y1, x2, y2, r, g, b) {
  for (let y = Math.max(0, y1); y <= Math.min(size - 1, y2); y++)
    for (let x = Math.max(0, x1); x <= Math.min(size - 1, x2); x++)
      setPixel(px, size, x, y, r, g, b);
}
function fillCircle(px, size, cx, cy, radius, r, g, b) {
  const r2 = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y++)
    for (let x = cx - radius; x <= cx + radius; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2)
        setPixel(px, size, x, y, r, g, b);
}
function fillRoundRect(px, size, x1, y1, x2, y2, rad, r, g, b) {
  fillRect(px, size, x1 + rad, y1, x2 - rad, y2, r, g, b);
  fillRect(px, size, x1, y1 + rad, x2, y2 - rad, r, g, b);
  fillCircle(px, size, x1 + rad, y1 + rad, rad, r, g, b);
  fillCircle(px, size, x2 - rad, y1 + rad, rad, r, g, b);
  fillCircle(px, size, x1 + rad, y2 - rad, rad, r, g, b);
  fillCircle(px, size, x2 - rad, y2 - rad, rad, r, g, b);
}

// ── PNG encoder ────────────────────────────────────────────
function encodePNG(px, size) {
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rowBytes = 1 + size * 3;
  const raw = Buffer.allocUnsafe(size * rowBytes);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0;
    px.copy(raw, y * rowBytes + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Draw logo ──────────────────────────────────────────────
function drawLogo(size) {
  const px = Buffer.alloc(size * size * 3);
  const s = size / 512;

  // Background gradient: #1a1a2e (dark navy) → #6c63ff (purple)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (size * 2);
      setPixel(px, size, x, y,
        Math.round(26  + (108 - 26)  * t),  // R
        Math.round(26  + (99  - 26)  * t),  // G
        Math.round(46  + (255 - 46)  * t),  // B
      );
    }
  }

  // Rounded corner mask
  const cr = Math.round(90 * s);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cut = false;
      if (x < cr && y < cr)               cut = (x-cr)**2+(y-cr)**2 > cr**2;
      if (x > size-1-cr && y < cr)        cut = (x-(size-1-cr))**2+(y-cr)**2 > cr**2;
      if (x < cr && y > size-1-cr)        cut = (x-cr)**2+(y-(size-1-cr))**2 > cr**2;
      if (x > size-1-cr && y > size-1-cr) cut = (x-(size-1-cr))**2+(y-(size-1-cr))**2 > cr**2;
      if (cut) setPixel(px, size, x, y, 10, 10, 15);
    }
  }

  const W = 255, G = 255, B = 255; // white icon

  // ── Beer mug body ──────────────────────────────────────
  const bodyX1 = Math.round(100 * s);
  const bodyX2 = Math.round(345 * s);
  const bodyY1 = Math.round(210 * s);
  const bodyY2 = Math.round(405 * s);
  const bodyRad = Math.round(14 * s);
  fillRoundRect(px, size, bodyX1, bodyY1, bodyX2, bodyY2, bodyRad, W, G, B);

  // ── Handle (bracket shape: ⊏) ─────────────────────────
  const handleX1  = Math.round(345 * s);
  const handleX2  = Math.round(425 * s);
  const handleY1  = Math.round(235 * s);
  const handleY2  = Math.round(375 * s);
  const armH      = Math.round(34  * s);
  const sideW     = Math.round(28  * s);
  const handleRad = Math.round(10  * s);
  // Top arm
  fillRoundRect(px, size, handleX1, handleY1, handleX2, handleY1 + armH, handleRad, W, G, B);
  // Bottom arm
  fillRoundRect(px, size, handleX1, handleY2 - armH, handleX2, handleY2, handleRad, W, G, B);
  // Right side
  fillRect(px, size, handleX2 - sideW, handleY1, handleX2, handleY2, W, G, B);
  // Cut out inner gap to look hollow (draw bg color)
  const innerX1 = handleX1 + Math.round(6 * s);
  const innerX2 = handleX2 - sideW - Math.round(2 * s);
  const innerY1 = handleY1 + armH;
  const innerY2 = handleY2 - armH;
  // Sample background color from center of handle area and fill
  for (let y = innerY1; y <= innerY2; y++) {
    for (let x = innerX1; x <= innerX2; x++) {
      const t = (x + y) / (size * 2);
      setPixel(px, size, x, y,
        Math.round(26 + (108 - 26) * t),
        Math.round(26 + (99  - 26) * t),
        Math.round(46 + (255 - 46) * t),
      );
    }
  }

  // ── Foam (white bumps above body) ─────────────────────
  const foamY = Math.round(210 * s);
  // Foam base fills top of mug
  fillRect(px, size, bodyX1, Math.round(188 * s), bodyX2, foamY, W, G, B);
  // Foam bubbles (circles poking up)
  const bubbles = [
    { cx: 135, cy: 188, r: 26 },
    { cx: 178, cy: 176, r: 33 },
    { cx: 225, cy: 170, r: 37 },
    { cx: 274, cy: 176, r: 31 },
    { cx: 317, cy: 188, r: 24 },
  ];
  bubbles.forEach(({ cx, cy, r }) => {
    fillCircle(px, size,
      Math.round(cx * s), Math.round(cy * s), Math.round(r * s),
      W, G, B,
    );
  });

  // ── Beer liquid (amber) inside mug ────────────────────
  // Slightly inset from body walls
  const beerR = 210, beerG = 140, beerB = 30; // amber
  const inset = Math.round(10 * s);
  const beerY1 = Math.round(225 * s);
  const beerY2 = bodyY2 - inset;
  fillRect(px, size,
    bodyX1 + inset, beerY1,
    bodyX2 - inset, beerY2,
    beerR, beerG, beerB,
  );

  // ── Bubble dots in beer ────────────────────────────────
  const bubbleDots = [
    { cx: 160, cy: 310, r: 8 },
    { cx: 205, cy: 270, r: 6 },
    { cx: 250, cy: 340, r: 9 },
    { cx: 295, cy: 295, r: 7 },
    { cx: 180, cy: 370, r: 5 },
    { cx: 270, cy: 360, r: 6 },
  ];
  bubbleDots.forEach(({ cx, cy, r }) => {
    fillCircle(px, size,
      Math.round(cx * s), Math.round(cy * s), Math.round(r * s),
      255, 200, 100,
    );
  });

  return px;
}

// ── Generate all sizes ─────────────────────────────────────
const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
SIZES.forEach(size => {
  const buf = encodePNG(drawLogo(size), size);
  fs.writeFileSync(`icons/icon-${size}.png`, buf);
  console.log(`✅ icon-${size}.png`);
});
console.log('\n🍺 Done!');
