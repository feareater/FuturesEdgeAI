'use strict';
// scripts/gen-icons.js — generate PWA icons for FuturesEdge AI
// Run once:  node scripts/gen-icons.js
// Output:    public/icons/icon-192.png, icon-512.png, apple-touch-icon.png
// No npm dependencies — uses only Node built-ins (zlib, fs, path).

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Color constants (RGBA) ────────────────────────────────────────────────────
const BG      = [13,  15,  26,  255];   // #0d0f1a — dashboard background
const TEAL    = [38,  166, 154, 255];   // #26a69a — accent teal
const DIMLINE = [30,  35,  60,  255];   // #1e233c — subtle grid/baseline

// ── CRC32 (required for PNG chunk integrity) ──────────────────────────────────
function makeCrcTable() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let j = 0; j < 8; j++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1);
    t[i] = v;
  }
  return t;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf    = Buffer.alloc(4);   lenBuf.writeUInt32BE(data.length);
  const crcInput  = Buffer.concat([typeBytes, data]);
  const crcBuf    = Buffer.alloc(4);   crcBuf.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

// ── Pixel helpers ─────────────────────────────────────────────────────────────
function setPixel(pixels, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  pixels[i] = color[0]; pixels[i+1] = color[1]; pixels[i+2] = color[2]; pixels[i+3] = color[3];
}

function fillRect(pixels, size, x, y, w, h, color) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      setPixel(pixels, size, x + dx, y + dy, color);
}

function hLine(pixels, size, x1, x2, y, thickness, color) {
  for (let t = 0; t < thickness; t++)
    for (let x = x1; x <= x2; x++)
      setPixel(pixels, size, x, y + t, color);
}

function vLine(pixels, size, x, y1, y2, thickness, color) {
  for (let t = 0; t < thickness; t++)
    for (let y = y1; y <= y2; y++)
      setPixel(pixels, size, x + t, y, color);
}

// ── Build icon pixel data ─────────────────────────────────────────────────────
function buildPixels(size) {
  const pixels = new Uint8Array(size * size * 4);
  // Fill background
  for (let i = 0; i < size * size; i++) {
    pixels[i*4]   = BG[0]; pixels[i*4+1] = BG[1];
    pixels[i*4+2] = BG[2]; pixels[i*4+3] = BG[3];
  }

  // Scale factor — all coordinates designed for 192px
  const f = size / 192;
  const sc = (n) => Math.round(n * f);
  const t1 = Math.max(1, sc(1));   // 1-pixel thickness at 192
  const t2 = Math.max(1, sc(2));   // 2-pixel thickness

  // Baseline rule
  hLine(pixels, size, sc(23), sc(169), sc(134), t2, DIMLINE);

  // Three candles: [centerX, bodyTop, bodyBot, wickTop, wickBot]
  const candles = [
    [54,  100, 126, 92,  134],   // left — small
    [96,  81,  112, 73,  121],   // mid
    [138, 50,  105, 42,  111],   // right — tall bull
  ];
  const bodyHalf = Math.max(sc(7), 3);

  for (const [cx, bt, bb, wt, wb] of candles) {
    const x  = sc(cx);
    const bT = sc(bt); const bB = sc(bb);
    const wT = sc(wt); const wB = sc(wb);
    // wick (thin vertical line)
    vLine(pixels, size, x, wT, wB, t1, TEAL);
    // body (filled rect)
    fillRect(pixels, size, x - bodyHalf, bT, bodyHalf * 2 + t1, bB - bT, TEAL);
  }

  return pixels;
}

// ── Assemble PNG binary ───────────────────────────────────────────────────────
function makePNG(size) {
  const pixels = buildPixels(size);

  // Build raw scanlines: filter byte (0 = None) + RGBA row
  const rowBytes = 1 + size * 4;
  const raw = Buffer.alloc(size * rowBytes);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0x00; // filter: None
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * rowBytes + 1 + x * 4;
      raw[dst]   = pixels[src];
      raw[dst+1] = pixels[src+1];
      raw[dst+2] = pixels[src+2];
      raw[dst+3] = pixels[src+3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);  // width
  ihdr.writeUInt32BE(size, 4);  // height
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 6;  // colour type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace: none

  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Write files ───────────────────────────────────────────────────────────────
const outputs = [
  ['icon-192.png',          192],
  ['icon-512.png',          512],
  ['apple-touch-icon.png',  180],
];

for (const [filename, size] of outputs) {
  const outPath = path.join(OUT_DIR, filename);
  fs.writeFileSync(outPath, makePNG(size));
  console.log(`[gen-icons] Written ${size}×${size} → ${outPath}`);
}
console.log('[gen-icons] Done. Run once — icons are in public/icons/');
