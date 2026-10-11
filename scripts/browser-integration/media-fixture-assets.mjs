import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { clipboardPNG } from "./clipboard-fixture.mjs";

export const embeddedLimit = 8 * 1024 * 1024;
export const embeddedPNG = clipboardPNG();
export const embeddedBoundaryPNG = Buffer.alloc(embeddedLimit);
embeddedPNG.copy(embeddedBoundaryPNG);

// Deterministic mono PCM16: 800 samples at 8 kHz, a 400 Hz square wave. No
// encoder or downloaded media is needed to build or run this fixture.
export const embeddedWAV = (() => {
  const bytes = Buffer.alloc(44 + 800 * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(1600, 40);
  for (let n = 0; n < 800; n++) bytes.writeInt16LE(n % 20 < 10 ? 2048 : -2048, 44 + n * 2);
  return bytes;
})();

// Generated once with ffmpeg 8.1.2: -f lavfi -i color=c=red:s=16x16:r=10:d=0.2
// -an -c:v libvpx -deadline best -cpu-used 0 -threads 1 -fflags +bitexact
// -flags:v +bitexact -map_metadata -1. VP8, two 16x16 frames, 0.2 seconds.
// Native-browser loadedmetadata/loadeddata evidence is separately required.
export const embeddedWebM = Buffer.from("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHcEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTDZ1OsggETTbuMU6uEHFO7a1OsggHG7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBNgIRMYXZmV0GETGF2ZkSJiEBpAAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYgAAAAAAAAAAZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAX14QDgkLCBELqBEJqBAlWwhFW5gQESVMNn0HNzzWPAi2PFiAAAAAAAAAABZ8iYRaOHRU5DT0RFUkSHi0xhdmMgbGlidnB4Z8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMC4yMDAwMDAwMDAAH0O2ddnngQCjvYEAAIDwAgCdASoQABAAAEcIhYWIhYSIAgICdaoD+AP6Ag1NGAD+/W7z/+OZNzDE/45t//FhPA4oyP/xUQCjlYEAZACxAQAFEKwAGAAYWC/0AAgAABxTu2uRu4+zgQC3iveBAfGCAWjwgQM=", "base64");

export const mediaAssetHash = bytes => createHash("sha256").update(bytes).digest("hex");
export const mediaAssetIdentity = Object.freeze(Object.fromEntries([
  ["png", embeddedPNG], ["wav", embeddedWAV], ["webm", embeddedWebM], ["boundaryPNG", embeddedBoundaryPNG]
].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: mediaAssetHash(bytes) }])));

export function verifyRedGreenPNG(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8, channels, ended = false;
  const idat = [];
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length);
    const length = bytes.readUInt32BE(offset), name = bytes.toString("ascii", offset + 4, offset + 8);
    assert.ok(offset + length + 12 <= bytes.length);
    let crc = 0xffffffff;
    for (const value of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    assert.equal(bytes.readUInt32BE(offset + 8 + length), (crc ^ 0xffffffff) >>> 0, `PNG ${name} CRC`);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (name === "IHDR") {
      assert.equal(offset, 8); assert.equal(length, 13);
      assert.equal(data.readUInt32BE(), 2); assert.equal(data.readUInt32BE(4), 1);
      assert.equal(data[8], 8); assert.ok([2, 6].includes(data[9]));
      assert.deepEqual([...data.subarray(10)], [0, 0, 0]); channels = data[9] === 6 ? 4 : 3;
    }
    if (name === "IDAT") idat.push(data);
    offset += length + 12;
    if (name === "IEND") { assert.equal(length, 0); ended = true; break; }
  }
  assert.ok(ended && channels && idat.length); assert.equal(offset, bytes.length);
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: 64 });
  assert.equal(raw.length, 1 + 2 * channels); assert.ok(raw[0] <= 4);
  const row = Buffer.alloc(2 * channels);
  for (let index = 0; index < row.length; index++) {
    const left = index >= channels ? row[index - channels] : 0;
    // One row: up/upper-left are zero; Paeth therefore chooses left.
    const predictor = raw[0] === 1 || raw[0] === 4 ? left : raw[0] === 3 ? Math.floor(left / 2) : 0;
    row[index] = (raw[index + 1] + predictor) & 255;
  }
  const pixels = [];
  for (let x = 0; x < 2; x++) pixels.push([...row.subarray(x * channels, x * channels + 3), channels === 4 ? row[x * channels + 3] : 255]);
  assert.deepEqual(pixels, [[255, 0, 0, 255], [0, 255, 0, 255]]);
  return { width: 2, height: 1, pixels };
}
