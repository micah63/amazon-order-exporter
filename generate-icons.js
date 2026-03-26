// Generate simple placeholder icons for the extension
// Run with: node generate-icons.js

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function createPNG(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // RGB color
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Pixel data: each row = filter byte + RGB * width
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const off = y * rowLen + 1 + x * 3;
      // Simple rounded-square shape with Amazon orange
      const cx = size / 2, cy = size / 2, radius = size * 0.38;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < radius) {
        raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
      } else {
        // Transparent-ish (light gray background for PNG without alpha)
        raw[off] = 240; raw[off + 1] = 240; raw[off + 2] = 240;
      }
    }
  }

  const compressed = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

// Amazon orange: #FF9900
[16, 48, 128].forEach(size => {
  const png = createPNG(size, 255, 153, 0);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), png);
});

console.log('Icons generated in icons/');
