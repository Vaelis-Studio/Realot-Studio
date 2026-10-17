/**
 * editor/animation/AnimationImport.js
 *
 * Turns raw user input (standalone image Files, a .zip File full of
 * images, or a single sprite-sheet image File) into an ordered array of
 * { spriteKey, dataUrl, width, height } frames ready to drop into an
 * AnimationClip's frames array (see runtime/components/SpriteAnimation.js).
 *
 * Every produced frame is registered as its own real texture via
 * runtime/assets/AssetManager.js's registerTexture() (same underlying
 * texture cache SpriteRenderer.spriteKey already resolves through), so
 * playback needs zero special-casing at runtime — an animation frame
 * IS just a spriteKey, exactly like a static sprite.
 *
 * EDITOR-ONLY FILE: this does DOM/Image/Canvas work and JSZip parsing
 * that has no business inside /runtime. runtime/components/
 * SpriteAnimation.js and runtime/systems/AnimationSystem.js never call
 * into this file — they just consume the spriteKeys this file produces.
 */

import { registerTexture, loadImageAssetFromFile } from "../../runtime/assets/AssetManager.js";
import { registerFrameAsset } from "../../runtime/assets/AssetRegistry.js";
import { generateFrameSourceId } from "../../runtime/components/SpriteAnimation.js";
import { decodeGif } from "./GifDecoder.js";

let _nextFrameKeyId = 1;

/**
 * @param {File[]|FileList} files one or more standalone image files —
 *   each becomes exactly one frame, in the order given.
 * @returns {Promise<Array<{spriteKey:string,dataUrl:string,width:number,height:number,sourceAssetKey:string}>>}
 */
export async function importStandaloneImageFrames(files) {
  const sourceAssetKey = generateFrameSourceId();
  const frames = [];
  for (const file of Array.from(files)) {
    if (!file.type || !file.type.startsWith("image/")) continue;
    const key = "animframe_" + _nextFrameKeyId++;
    // loadImageAssetFromFile already does exactly the read-file ->
    // decode-image -> register-texture pipeline a frame needs (it's
    // the same helper the static-sprite import button in BottomPanel.js
    // uses) — reused here rather than reimplemented so both import
    // paths stay in sync if that helper ever changes.
    const { dataUrl, width, height } = await loadImageAssetFromFile(key, file);
    registerFrameAsset({ key, name: _stripExtension(file.name), dataUrl, width, height });
    frames.push({ spriteKey: key, dataUrl, width, height, sourceAssetKey });
  }
  return frames;
}

/**
 * @param {File} zipFile a .zip containing only images (per the user's
 *   own description of their workflow) — every image entry becomes one
 *   frame, in the zip's own internal listing order (which for a zip
 *   built from a numerically-named image sequence, e.g. "walk_01.png",
 *   "walk_02.png", is normally already the intended playback order).
 * @returns {Promise<Array<{spriteKey:string,dataUrl:string,width:number,height:number,sourceAssetKey:string}>>}
 */
export async function importZipImageFrames(zipFile) {
  if (typeof JSZip === "undefined") {
    throw new Error("JSZip failed to load — check your network connection and reload the editor.");
  }
  const sourceAssetKey = generateFrameSourceId();
  const zip = await JSZip.loadAsync(zipFile);

  // Sort entries by filename so a naturally-numbered sequence
  // (frame_01, frame_02, ... frame_10) comes out in the RIGHT order —
  // a plain string sort alone would put "frame_10" before "frame_2".
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && /\.(png|jpe?g|webp|gif|bmp)$/i.test(entry.name))
    .sort((a, b) => _naturalCompare(a.name, b.name));

  const frames = [];
  for (const entry of entries) {
    const blob = await entry.async("blob");
    const filename = entry.name.split("/").pop();
    const file = new File([blob], filename, { type: blob.type || _guessMimeFromName(entry.name) });
    const key = "animframe_" + _nextFrameKeyId++;
    const { dataUrl, width, height } = await loadImageAssetFromFile(key, file);
    registerFrameAsset({ key, name: _stripExtension(filename), dataUrl, width, height });
    frames.push({ spriteKey: key, dataUrl, width, height, sourceAssetKey });
  }
  return frames;
}

/**
 * Slices a single sprite-sheet image into multiple frames.
 *
 * @param {File} file the sheet image
 * @param {object} [gridOverride] if provided, slices on a FIXED grid
 *   instead of auto-detecting: { cols: number, rows: number }. Omit to
 *   auto-detect frames by scanning for fully-transparent gutter
 *   rows/columns between sprites (the common convention for sheets
 *   exported with padding between frames).
 * @returns {Promise<Array<{spriteKey:string,dataUrl:string,width:number,height:number,sourceAssetKey:string}>>}
 */
export async function importSpriteSheetFrames(file, gridOverride) {
  const sourceAssetKey = generateFrameSourceId();
  const { img, width, height } = await _readImageFile(file);
  const baseName = _stripExtension(file.name);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);

  const rects = gridOverride
    ? _sliceByGrid(width, height, gridOverride.cols, gridOverride.rows)
    : _autoDetectSpriteRects(imageData, width, height);

  const frames = [];
  let frameNumber = 1;
  for (const rect of rects) {
    if (rect.w <= 0 || rect.h <= 0) continue;
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = rect.w;
    frameCanvas.height = rect.h;
    frameCanvas.getContext("2d").drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    const dataUrl = frameCanvas.toDataURL("image/png");
    const key = "animframe_" + _nextFrameKeyId++;
    const texture = new PIXI.Texture(PIXI.BaseTexture.from(frameCanvas));
    registerTexture(key, texture);
    const name = baseName + "_" + frameNumber++;
    registerFrameAsset({ key, name, dataUrl, width: rect.w, height: rect.h });
    frames.push({ spriteKey: key, dataUrl, width: rect.w, height: rect.h, sourceAssetKey });
  }
  return frames;
}

/**
 * Extracts every frame from an animated GIF as individual sprite frames.
 * Delegates raw GIF89a parsing (LZW decompression, color tables,
 * disposal/transparency metadata) to GifDecoder.js, then composites each
 * frame onto a full-screen canvas exactly the way a browser GIF decoder
 * would (respecting disposal methods so frames don't bleed into each
 * other), captures each composite as its own PNG, and registers it as a
 * texture — identical to the sprite-sheet path.
 *
 * Returns a suggested fps derived from the GIF's shortest frame delay
 * (GIF delays are in 1/100 second), so callers can set the clip's fps to
 * match the original animation speed.
 *
 * @param {File} file a .gif file (animated or static)
 * @returns {Promise<{frames: Array<{spriteKey:string,dataUrl:string,width:number,height:number,sourceAssetKey:string}>, fps: number}>}
 */
export async function importGifFrames(file) {
  const sourceAssetKey = generateFrameSourceId();
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const { screenW, screenH, frames: rawFrames } = decodeGif(bytes);
  const baseName = _stripExtension(file.name);

  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = screenW;
  fullCanvas.height = screenH;
  const fullCtx = fullCanvas.getContext("2d");

  const frames = [];
  let prevDisposal = 0;
  let prevRect = null;
  let savedState = null;
  let minDelay = Infinity;

  for (const raw of rawFrames) {
    const w = raw.width;
    const h = raw.height;
    if (raw.delay > 0 && raw.delay < minDelay) minDelay = raw.delay;

    // Apply the PREVIOUS frame's disposal before drawing this one.
    if (prevDisposal === 2 && prevRect) {
      fullCtx.clearRect(prevRect.left, prevRect.top, prevRect.w, prevRect.h);
    } else if (prevDisposal === 3 && savedState) {
      fullCtx.putImageData(savedState, 0, 0);
    }

    // For disposal 3 (restore-to-previous), snapshot BEFORE drawing.
    if (raw.disposal === 3) {
      savedState = fullCtx.getImageData(0, 0, screenW, screenH);
    } else {
      savedState = null;
    }

    // Decode this frame's pixels into a temp canvas, then composite
    // with drawImage (source-over) so transparent pixels show through
    // to whatever the canvas already holds — matching browser compositing.
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext("2d");
    const imgData = tempCtx.createImageData(w, h);
    for (let i = 0; i < raw.indices.length; i++) {
      const idx = raw.indices[i];
      const pi = i * 4;
      if (raw.transparent && idx === raw.transparentIndex) {
        imgData.data[pi + 3] = 0;
      } else if (idx * 3 + 2 < raw.colors.length) {
        imgData.data[pi] = raw.colors[idx * 3];
        imgData.data[pi + 1] = raw.colors[idx * 3 + 1];
        imgData.data[pi + 2] = raw.colors[idx * 3 + 2];
        imgData.data[pi + 3] = 255;
      }
    }
    tempCtx.putImageData(imgData, 0, 0);
    fullCtx.drawImage(tempCanvas, raw.left, raw.top);

    // Capture the composited frame as its own image.
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = screenW;
    frameCanvas.height = screenH;
    frameCanvas.getContext("2d").drawImage(fullCanvas, 0, 0);
    const dataUrl = frameCanvas.toDataURL("image/png");
    const key = "animframe_" + _nextFrameKeyId++;
    const texture = new PIXI.Texture(PIXI.BaseTexture.from(frameCanvas));
    registerTexture(key, texture);
    const name = baseName + "_" + (frames.length + 1);
    registerFrameAsset({ key, name, dataUrl, width: screenW, height: screenH });
    frames.push({ spriteKey: key, dataUrl, width: screenW, height: screenH, sourceAssetKey });

    prevDisposal = raw.disposal;
    prevRect = { left: raw.left, top: raw.top, w, h };
  }

  // Suggested fps from the shortest frame delay (GIF delays are in
  // 1/100 second → fps = 100 / delay). Default 10 fps if no delays.
  let fps = 10;
  if (minDelay !== Infinity && minDelay > 0) {
    fps = Math.round(100 / minDelay);
    if (fps < 1) fps = 1;
  }

  return { frames, fps };
}

/**
 * Grid-based slicing: an even cols x rows split of the sheet — this is
 * the "manual override" path the user picks when auto-detect guesses
 * wrong (e.g. a sheet with no transparent padding between frames at
 * all, where there's no gutter to detect).
 */
function _sliceByGrid(sheetWidth, sheetHeight, cols, rows) {
  cols = Math.max(1, Math.floor(cols) || 1);
  rows = Math.max(1, Math.floor(rows) || 1);
  const cellW = sheetWidth / cols;
  const cellH = sheetHeight / rows;
  const rects = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rects.push({ x: Math.round(c * cellW), y: Math.round(r * cellH), w: Math.round(cellW), h: Math.round(cellH) });
    }
  }
  return rects;
}

/**
 * Auto-detects individual sprite bounding boxes by finding fully
 * transparent (alpha === 0) gutter rows/columns and treating each
 * contiguous non-empty region as one frame — a 2-pass approach: first
 * find non-empty ROWS to split the sheet into horizontal bands, then
 * within each band find non-empty COLUMNS to split into individual
 * frames. This correctly handles a sheet laid out as a regular grid of
 * padded sprites (by far the most common sprite-sheet convention)
 * without requiring the user to specify rows/cols at all.
 *
 * NOTE: this intentionally does NOT do full connected-component
 * flood-fill (which would also correctly handle irregular/packed
 * atlases) — that's substantially more complex for a case the user
 * described as "cuts them" from a regular sheet, and the row-then-
 * column band approach already covers the overwhelmingly common case
 * (a uniform grid, or a uniform-height single row/column strip) that
 * tools like Aseprite/TexturePacker's simple export produce.
 */
function _autoDetectSpriteRects(imageData, width, height) {
  const alphaAt = (x, y) => imageData.data[(y * width + x) * 4 + 3];

  const rowHasContent = new Array(height);
  for (let y = 0; y < height; y++) {
    let has = false;
    for (let x = 0; x < width; x++) {
      if (alphaAt(x, y) > 0) {
        has = true;
        break;
      }
    }
    rowHasContent[y] = has;
  }

  const bands = _findRuns(rowHasContent);
  if (bands.length === 0) return [{ x: 0, y: 0, w: width, h: height }]; // fully transparent/blank sheet — bail to whole-image

  const rects = [];
  for (const band of bands) {
    const colHasContent = new Array(width);
    for (let x = 0; x < width; x++) {
      let has = false;
      for (let y = band.start; y <= band.end; y++) {
        if (alphaAt(x, y) > 0) {
          has = true;
          break;
        }
      }
      colHasContent[x] = has;
    }
    const cols = _findRuns(colHasContent);
    for (const col of cols) {
      rects.push({
        x: col.start,
        y: band.start,
        w: col.end - col.start + 1,
        h: band.end - band.start + 1,
      });
    }
  }

  return rects;
}

/** Finds contiguous true-runs in a boolean array — used for both the
 * row pass and the column pass of auto-detection. */
function _findRuns(boolArray) {
  const runs = [];
  let start = null;
  for (let i = 0; i < boolArray.length; i++) {
    if (boolArray[i] && start === null) {
      start = i;
    } else if (!boolArray[i] && start !== null) {
      runs.push({ start, end: i - 1 });
      start = null;
    }
  }
  if (start !== null) runs.push({ start, end: boolArray.length - 1 });
  return runs;
}

/** Loads a File into both an HTMLImageElement and a dataUrl string. */
function _readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onload = () => {
      const dataUrl = reader.result;
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to decode image: " + file.name));
      img.onload = () => resolve({ img, dataUrl, width: img.naturalWidth, height: img.naturalHeight });
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

/** "frame_2" < "frame_10" (unlike a plain string compare). */
function _naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.match(re) || [];
  const bParts = b.match(re) || [];
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i] || "";
    const bp = bParts[i] || "";
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) {
      const diff = parseInt(ap, 10) - parseInt(bp, 10);
      if (diff !== 0) return diff;
    } else if (ap !== bp) {
      return ap < bp ? -1 : 1;
    }
  }
  return 0;
}

function _stripExtension(filename) {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(0, i) : filename;
}

function _guessMimeFromName(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "bmp") return "image/bmp";
  return "image/png";
}
