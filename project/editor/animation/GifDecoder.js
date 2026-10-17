/**
 * editor/animation/GifDecoder.js
 *
 * Pure GIF89a decoder — parses raw GIF bytes into per-frame pixel
 * indices + metadata (disposal, transparency, delay) with NO DOM, PIXI,
 * or asset-registry dependencies. AnimationImport.js calls this and
 * does the canvas/texture/registration work the same way it does for
 * sprite sheets and zips.
 *
 * Handles: logical screen descriptor, global/local color tables,
 * LZW-compressed image data, graphics control extensions (disposal
 * method, transparency, per-frame delay), and interlacing.
 *
 * EDITOR-ONLY FILE.
 */

/**
 * @param {Uint8Array} bytes
 * @returns {{ screenW: number, screenH: number, frames: Array<{
 *   left:number, top:number, width:number, height:number,
 *   indices:number[], colors:Uint8Array,
 *   delay:number, disposal:number, transparent:boolean, transparentIndex:number
 * }> }}
 */
export function decodeGif(bytes) {
  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  if (sig !== "GIF") throw new Error("Not a valid GIF file");

  const screenW = bytes[6] | (bytes[7] << 8);
  const screenH = bytes[8] | (bytes[9] << 8);
  const packed = bytes[10];
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = 2 << (packed & 0x07);

  let offset = 13;
  let globalColors = null;
  if (gctFlag) {
    globalColors = new Uint8Array(bytes.subarray(offset, offset + gctSize * 3));
    offset += gctSize * 3;
  }

  const frames = [];
  let gce = null;

  while (offset < bytes.length) {
    const blockType = bytes[offset];

    if (blockType === 0x3b) break; // trailer

    if (blockType === 0x21) {
      // Extension
      offset++;
      const extLabel = bytes[offset++];
      if (extLabel === 0xf9) {
        // Graphics Control Extension
        offset++; // block size (4)
        const gcePacked = bytes[offset++];
        const delay = bytes[offset] | (bytes[offset + 1] << 8);
        offset += 2;
        const transparentIndex = bytes[offset++];
        offset++; // terminator
        gce = {
          disposal: (gcePacked >> 2) & 0x07,
          transparent: (gcePacked & 0x01) !== 0,
          transparentIndex,
          delay,
        };
      } else {
        offset = _skipSubBlocks(bytes, offset);
      }
    } else if (blockType === 0x2c) {
      // Image Descriptor
      offset++;
      const left = bytes[offset] | (bytes[offset + 1] << 8); offset += 2;
      const top = bytes[offset] | (bytes[offset + 1] << 8); offset += 2;
      const w = bytes[offset] | (bytes[offset + 1] << 8); offset += 2;
      const h = bytes[offset] | (bytes[offset + 1] << 8); offset += 2;
      const imgPacked = bytes[offset++];
      const lctFlag = (imgPacked & 0x80) !== 0;
      const lctSize = 2 << (imgPacked & 0x07);
      const interlaced = (imgPacked & 0x40) !== 0;

      let colors = globalColors;
      if (lctFlag) {
        colors = new Uint8Array(bytes.subarray(offset, offset + lctSize * 3));
        offset += lctSize * 3;
      }

      const lzwMin = bytes[offset++];
      const { data: compressed, nextOffset } = _readSubBlocks(bytes, offset);
      offset = nextOffset;

      let indices = _lzwDecode(compressed, lzwMin);
      if (interlaced) indices = _deinterlace(indices, w, h);

      frames.push({
        left, top, width: w, height: h,
        indices,
        colors: colors || new Uint8Array(0),
        delay: gce ? gce.delay : 0,
        disposal: gce ? gce.disposal : 0,
        transparent: gce ? gce.transparent : false,
        transparentIndex: gce ? gce.transparentIndex : -1,
      });
      gce = null;
    } else {
      offset++;
    }
  }

  return { screenW, screenH, frames };
}

function _skipSubBlocks(bytes, offset) {
  while (offset < bytes.length) {
    const len = bytes[offset++];
    if (len === 0) break;
    offset += len;
  }
  return offset;
}

function _readSubBlocks(bytes, offset) {
  const chunks = [];
  while (offset < bytes.length) {
    const len = bytes[offset++];
    if (len === 0) break;
    chunks.push(bytes.subarray(offset, offset + len));
    offset += len;
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const data = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { data.set(c, pos); pos += c.length; }
  return { data, nextOffset: offset };
}

function _lzwDecode(compressed, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = [];
  let dictSize = eoiCode + 1;

  function resetDict() {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict[i] = [i];
    codeSize = minCodeSize + 1;
    dictSize = eoiCode + 1;
  }
  resetDict();

  let bitBuffer = 0;
  let bitsInBuffer = 0;
  let bytePos = 0;
  const output = [];
  let prevCode = -1;

  function readCode() {
    while (bitsInBuffer < codeSize && bytePos < compressed.length) {
      bitBuffer |= compressed[bytePos++] << bitsInBuffer;
      bitsInBuffer += 8;
    }
    if (bitsInBuffer < codeSize) return eoiCode;
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitsInBuffer -= codeSize;
    return code;
  }

  while (true) {
    const code = readCode();
    if (code === eoiCode) break;
    if (code === clearCode) {
      resetDict();
      prevCode = -1;
      continue;
    }

    let entry;
    if (prevCode === -1) {
      // First code after a clear: output directly, NO dictionary
      // entry is added (there's no previous code to combine with).
      // The old code fell through to the dictionary-update block
      // below, which corrupted the dictionary from the first code
      // onward and garbled every subsequent frame.
      entry = dict[code];
      if (!entry) break;
      for (let i = 0; i < entry.length; i++) output.push(entry[i]);
      prevCode = code;
      continue;
    }

    if (code < dictSize) {
      entry = dict[code];
    } else if (code === dictSize) {
      const prev = dict[prevCode];
      entry = prev.concat([prev[0]]);
    } else {
      break;
    }

    if (!entry) break;
    for (let i = 0; i < entry.length; i++) output.push(entry[i]);

    if (dictSize < 4096) {
      dict[dictSize] = dict[prevCode].concat([entry[0]]);
      dictSize++;
      if (dictSize === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prevCode = code;
  }

  return output;
}

function _deinterlace(indices, w, h) {
  const out = new Array(w * h);
  const rowOrder = [];
  for (let y = 0; y < h; y += 8) rowOrder.push(y);
  for (let y = 4; y < h; y += 8) rowOrder.push(y);
  for (let y = 2; y < h; y += 4) rowOrder.push(y);
  for (let y = 1; y < h; y += 2) rowOrder.push(y);
  for (let srcRow = 0; srcRow < rowOrder.length; srcRow++) {
    const dstRow = rowOrder[srcRow];
    for (let x = 0; x < w; x++) {
      out[dstRow * w + x] = indices[srcRow * w + x];
    }
  }
  return out;
}
