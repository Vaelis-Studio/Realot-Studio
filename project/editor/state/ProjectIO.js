/**
 * editor/state/ProjectIO.js
 *
 * "Save Project" / "Load Project" (File menu — see Toolbar.js's
 * renderFileMenu() and EditorEvents.js's "save-project"/"load-project"
 * actions). Packages EVERYTHING that makes up a project into a single
 * .zip so re-loading it reproduces the project exactly as it was left:
 *
 *   manifest.json     — engine version, project name, saved-at time,
 *                        active scene id (see buildManifest() below)
 *   scenes/*.json      — one file per scene, straight from
 *                        game.getAllScenesData() (SceneSerializer's own
 *                        format — entities, components, positions,
 *                        which script/animation/etc is attached to what)
 *   assets/sprites.json — sprite asset catalogue (dataUrl + metadata)
 *   assets/frames.json  — animation-frame / tileset-slice sprite assets
 *   assets/audio.json   — audio asset catalogue
 *   prefabs.json         — prefab catalogue (see runtime/prefabs/PrefabRegistry.js)
 *   scripts.json        — every user script, name -> source
 *   layers.json          — the 16 physics layer names
 *
 * Assets are catalogued in assets/sprites.json, assets/frames.json,
 * and assets/audio.json (key, name, width/height/duration, etc), but
 * each entry's actual pixel/audio bytes are NOT embedded as base64
 * text inside that JSON. AssetRegistry.js's in-memory model keeps
 * dataUrl as its canonical form (rendering/thumbnails throughout the
 * editor depend on that), but base64 text inflates binary data by
 * ~33% AND compresses far worse inside a zip than the equivalent raw
 * bytes do — text encoding of binary data defeats DEFLATE's byte-
 * pattern matching. So at export time, dataUrlToBinaryEntry() below
 * strips each record's dataUrl down to a `file` pointer (e.g.
 * "assets/bin/sprite_3_player.png") and the decoded raw bytes are
 * written as their own binary zip entry; import reverses this via
 * binaryEntryToDataUrl(), reconstructing the exact same in-memory
 * dataUrl shape AssetRegistry.js expects. Net effect: smaller
 * in-memory JSON, smaller zip, better compression, same round-trip
 * fidelity — see exportProject()/importProject() below.
 *
 * OPTIONAL optimize-on-save pass: see optimizeProjectAssets() and the
 * `optimizeAssets` option on exportProject() — off by default, toggled
 * via editorState.optimizeAssetsOnSave (Toolbar.js's File menu). When
 * on, every PNG is re-encoded losslessly through UPNG.js and every WAV
 * is losslessly container-repacked, BEFORE the (always-on) steps
 * above run. This is a genuinely separate, skippable size win on top
 * of the base64/DEFLATE/dedup steps that always happen — those shrink
 * how assets are PACKAGED, this shrinks the assets' OWN bytes.
 *
 * This file orchestrates existing runtime/editor APIs — it does not
 * invent its own scene, asset, or script storage format (per
 * RULES.txt #6). Scene data flows through game.getAllScenesData()/
 * game.replaceAllScenesAndLoad(), which are themselves backed by
 * SceneSerializer.js.
 *
 * EDITOR-ONLY FILE.
 */

import { ENGINE_VERSION } from "../../runtime/EngineVersion.js";
import { getAllScripts, getScriptSource, replaceAllScripts } from "../scripting/ScriptStorage.js";
import { syncScriptSourcesInScenes, seedScriptStorageFromScenes } from "../scripting/ScriptSync.js";
import { getLayerNames, replaceAllLayerNames } from "./PhysicsLayers.js";
import { getNavAreaNames, replaceAllNavAreaNames } from "./NavAreas.js";
import { getTagNames, replaceAllTagNames } from "./Tags.js";

const MANIFEST_FILENAME = "manifest.json";

/**
 * Compares two "x.y.z" version strings.
 * @returns {number} negative if a<b, 0 if equal, positive if a>b
 */
function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * @param {string} projectName
 * @param {string|null} activeSceneId
 * @returns {object} plain JSON-serializable manifest
 */
function buildManifest(projectName, activeSceneId) {
  return {
    manifestVersion: 1, // format of THIS manifest file itself, separate from engineVersion below
    engineVersion: ENGINE_VERSION,
    projectName: projectName || "Untitled Project",
    savedAt: new Date().toISOString(),
    activeSceneId: activeSceneId || null,
  };
}

/**
 * Splits a "data:<mime>;base64,<data>" string into its mime type and
 * raw decoded bytes. Returns null if the string isn't a base64 dataUrl
 * (defensive — callers should only ever see well-formed dataUrls from
 * AssetManager.js, but a malformed/legacy record shouldn't crash export).
 * @param {string} dataUrl
 * @returns {{mime: string, bytes: Uint8Array}|null}
 */
function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const binaryStr = atob(m[2]);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return { mime, bytes };
}

/**
 * Re-encodes raw bytes back into a "data:<mime>;base64,..." string —
 * the exact shape AssetRegistry.js's records need in memory. Chunked
 * String.fromCharCode.apply calls avoid blowing the engine's max
 * argument count on large files (some browsers cap around ~65k args).
 * @param {Uint8Array} bytes
 * @param {string} mime
 * @returns {string}
 */
function encodeDataUrl(bytes, mime) {
  const CHUNK = 0x8000;
  let binaryStr = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binaryStr += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return "data:" + mime + ";base64," + btoa(binaryStr);
}

/**
 * Guesses a filesystem-safe extension for a binary zip entry name from
 * a dataUrl's mime type. Falls back to .bin for anything unrecognized
 * so an unusual mime type still produces a valid, distinct filename
 * rather than throwing.
 * @param {string} mime
 * @returns {string}
 */
function extensionForMime(mime) {
  const map = {
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif",
    "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp",
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/wave": "wav",
    "audio/ogg": "ogg", "audio/webm": "webm", "audio/aac": "aac", "audio/flac": "flac",
  };
  return map[mime] || "bin";
}

/**
 * Fast, dependency-free content hash (FNV-1a, 32-bit) used purely to
 * detect byte-identical assets for dedup at export time — see
 * dataUrlToBinaryEntry()'s hashIndex param below. NOT a security hash
 * and doesn't need to be: a false-positive collision only risks two
 * genuinely-different assets sharing one zip entry, so every dedup hit
 * is also verified with a byte-length + full byte-equality check
 * before it's trusted (see dedupeOrStore()) — the hash is just a fast
 * way to narrow candidates instead of comparing every asset to every
 * other one.
 * @param {Uint8Array} bytes
 * @returns {string} hex string
 */
function fnv1aHash(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Registers `bytes` as a pending binary entry named `entryName` UNLESS
 * an already-registered entry has identical content (checked via a
 * fast hash first, then a real byte comparison to rule out hash
 * collisions — see fnv1aHash()'s doc comment), in which case the
 * existing entry's name is reused instead. This is what lets e.g.
 * eight walk-cycle frames that happen to include two identical "idle"
 * frames, or a sprite re-imported under a new name, collapse to ONE
 * binary entry in the zip rather than one each — a real (if
 * project-dependent) size win on top of the base64 removal and
 * DEFLATE compression, since duplicate assets are common in sliced
 * sheets and frame-by-frame animation imports.
 *
 * Entries are collected into `pending` (not written straight to the
 * zip) so the optional optimize pass (see optimizeProjectAssets())
 * gets a chance to shrink each entry's bytes losslessly BEFORE
 * anything is actually added to the JSZip instance — see
 * exportProject() below, which writes `pending` into the zip itself
 * only after that optional step has run (or been skipped).
 * @param {Uint8Array} bytes
 * @param {string} entryName candidate name if this content is new
 * @param {string} mime
 * @param {Array<{name:string, bytes:Uint8Array, mime:string}>} pending
 * @param {Map<string, Array<{name:string, bytes:Uint8Array}>>} hashIndex
 *   hash -> list of {name, bytes} already registered under that hash
 *   (a list, not a single entry, to correctly handle hash collisions
 *   between genuinely different content)
 * @returns {string} the entry name actually used (new or reused)
 */
function dedupeOrStore(bytes, entryName, mime, pending, hashIndex) {
  const hash = fnv1aHash(bytes);
  const candidates = hashIndex.get(hash);
  if (candidates) {
    const match = candidates.find((c) => bytesEqual(c.bytes, bytes));
    if (match) return match.name;
  }
  pending.push({ name: entryName, bytes, mime });
  if (!candidates) hashIndex.set(hash, [{ name: entryName, bytes }]);
  else candidates.push({ name: entryName, bytes });
  return entryName;
}

/**
 * Strips one asset record's dataUrl out to a pending binary entry (see
 * dedupeOrStore()) and returns the slimmed record (dataUrl replaced
 * with a `file` pointer + the `mime` needed to reconstruct it on
 * import). Records without a decodable dataUrl (defensive — see
 * decodeDataUrl()) are passed through unchanged so a corrupt single
 * asset can't fail the whole export. Byte-identical content across
 * different records (see dedupeOrStore()) becomes one pending entry.
 * @param {object} record
 * @param {Array<{name:string, bytes:Uint8Array, mime:string}>} pending
 * @param {Set<string>} usedNames de-dupes entry NAMES across the whole
 *   export — sprites/frames/audio share one `assets/bin/` folder, and
 *   two different keys could otherwise sanitize to the same filename.
 * @param {Map<string, Array<{name:string, bytes:Uint8Array}>>} hashIndex
 *   see dedupeOrStore() — shared across the whole export so a sprite
 *   and a frame with identical bytes still dedupe against each other.
 * @returns {object} slimmed record for the JSON catalogue
 */
function dataUrlToBinaryEntry(record, pending, usedNames, hashIndex) {
  const decoded = decodeDataUrl(record.dataUrl);
  if (!decoded) return record; // pass through unchanged, defensively
  let entryName = record.key + "." + extensionForMime(decoded.mime);
  let n = 1;
  while (usedNames.has(entryName)) {
    entryName = record.key + "_" + n++ + "." + extensionForMime(decoded.mime);
  }
  const finalName = dedupeOrStore(decoded.bytes, entryName, decoded.mime, pending, hashIndex);
  usedNames.add(finalName);
  const { dataUrl, ...rest } = record;
  return { ...rest, file: "bin/" + finalName, mime: decoded.mime };
}

/**
 * Reverses dataUrlToBinaryEntry(): reads a slimmed record's binary zip
 * entry back out and reconstructs the dataUrl AssetRegistry.js expects
 * in memory. Records that already carry a dataUrl (older project zips
 * saved before this change, or a defensively-passed-through record —
 * see dataUrlToBinaryEntry()) are returned unchanged so old saves keep
 * importing correctly.
 * @param {object} record
 * @param {JSZip} zip full archive (entry paths are "assets/bin/...")
 * @returns {Promise<object>}
 */
async function binaryEntryToDataUrl(record, zip) {
  if (record.dataUrl || !record.file) return record;
  const entry = zip.file("assets/" + record.file);
  if (!entry) return record; // missing binary — leave as-is rather than throw
  const bytes = await entry.async("uint8array");
  const { file, mime, ...rest } = record;
  return { ...rest, dataUrl: encodeDataUrl(bytes, mime || "application/octet-stream") };
}

/**
 * Lazily loads UPNG.js (a small, dependency-free PNG encoder/decoder —
 * https://github.com/photopea/UPNG.js) from the packaged vendor files,
 * using the same on-demand pattern ScriptEditorWindow.js uses for Monaco:
 * only fetched the first time it's actually needed (the optional
 * "Optimize Assets on Save" pass below), not on every editor boot,
 * since most saves won't use it. Cached so a second optimize pass in
 * the same session doesn't re-fetch. UPNG's own encode() with a
 * quantization count of 0 (see optimizePngBytes() below) is genuinely
 * lossless — it decodes the PNG to raw pixels and re-encodes with a
 * stronger DEFLATE pass than whatever originally produced the file
 * (often a browser's own canvas.toDataURL(), which uses weak/fast
 * compression), not a recompression of the existing compressed bytes.
 * @returns {Promise<object>} resolves to the global UPNG object
 */
let _upngPromise = null;
function loadUPNG() {
  if (typeof window !== "undefined" && window.UPNG) return Promise.resolve(window.UPNG);
  if (_upngPromise) return _upngPromise;
  _upngPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "../vendor/upng/UPNG.min.js";
    script.onload = () => {
      if (window.UPNG) resolve(window.UPNG);
      else reject(new Error("UPNG.js loaded but window.UPNG is missing."));
    };
    script.onerror = () => {
      _upngPromise = null; // allow a retry on the next optimize pass
      reject(new Error("Failed to load UPNG.js — check your network connection."));
    };
    document.head.appendChild(script);
  });
  return _upngPromise;
}

/**
 * Re-encodes one PNG's raw bytes through UPNG.js losslessly (cnum=0 —
 * see UPNG's own docs: 0 means no color quantization, i.e. pixel-
 * perfect). Falls back to returning the ORIGINAL bytes unchanged if
 * UPNG's re-encode doesn't actually come out smaller (can happen on
 * PNGs already optimally compressed, e.g. previously run through
 * pngcrush/oxipng externally) or if decoding/encoding throws for any
 * reason (unusual color type, corrupt file, etc) — optimization is a
 * pure size bonus and must never be able to make export fail or
 * change what a sprite looks like.
 * @param {Uint8Array} bytes original PNG file bytes
 * @param {object} UPNG the loaded UPNG.js module (see loadUPNG())
 * @returns {{bytes: Uint8Array, saved: number}} saved is bytes
 *   removed (0 if the original was kept)
 */
function optimizePngBytes(bytes, UPNG) {
  try {
    const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const rgba = UPNG.toRGBA8(decoded)[0]; // first (only, for non-APNG) frame as a flat RGBA ArrayBuffer
    const reencoded = new Uint8Array(UPNG.encode([rgba], decoded.width, decoded.height, 0)); // 0 = lossless
    if (reencoded.length > 0 && reencoded.length < bytes.length) {
      return { bytes: reencoded, saved: bytes.length - reencoded.length };
    }
  } catch (err) {
    console.warn("[ProjectIO] PNG optimize skipped for one asset (kept original):", err);
  }
  return { bytes, saved: 0 };
}

/**
 * Losslessly repacks a WAV/RIFF file: strips non-essential chunks
 * (junk padding, unrecognized metadata chunks some tools pad files
 * with) and rebuilds a minimal canonical RIFF/WAVE container around
 * the SAME fmt and data chunks — the actual PCM sample bytes are
 * copied verbatim, never decoded/re-quantized/resampled, so playback
 * is bit-for-bit identical audio. This is NOT audio compression in
 * the codec sense (PCM stays PCM, same size per sample) — it only
 * removes container overhead some export tools leave behind. Real
 * lossless audio compression would mean re-encoding to FLAC (a real
 * codec dependency this project deliberately skips — see
 * optimizeProjectAssets()'s doc comment for why) — this is the
 * honest, safe subset of "lossless audio optimization" achievable
 * without pulling in a large new WASM codec.
 * @param {Uint8Array} bytes
 * @returns {{bytes: Uint8Array, saved: number}}
 */
function repackWav(bytes) {
  try {
    if (bytes.length < 12) return { bytes, saved: 0 };
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const riff = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    const wave = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
    if (riff !== "RIFF" || wave !== "WAVE") return { bytes, saved: 0 }; // not a WAV — leave untouched

    let offset = 12;
    let fmtChunk = null;
    let dataChunk = null;
    // Walk every chunk once, keeping only fmt/data — anything else
    // (LIST/INFO metadata, JUNK/PAD padding chunks, cue points, etc)
    // is dropped since it has zero effect on how the audio sounds.
    while (offset + 8 <= bytes.length) {
      const id = String.fromCharCode(dv.getUint8(offset), dv.getUint8(offset + 1), dv.getUint8(offset + 2), dv.getUint8(offset + 3));
      const size = dv.getUint32(offset + 4, true);
      const bodyStart = offset + 8;
      const bodyEnd = Math.min(bodyStart + size, bytes.length); // clamp — a truncated/corrupt size shouldn't read past the buffer
      if (id === "fmt ") fmtChunk = bytes.subarray(bodyStart, bodyEnd);
      else if (id === "data") dataChunk = bytes.subarray(bodyStart, bodyEnd);
      offset = bodyStart + size + (size % 2); // chunks are word-aligned — a trailing pad byte on odd sizes
    }
    if (!fmtChunk || !dataChunk) return { bytes, saved: 0 }; // malformed — leave untouched rather than risk a broken file

    // Pad bytes only ever sit BETWEEN chunks (RIFF word alignment) —
    // never appended after the final chunk. data is always written
    // last here, so only fmt (which is followed by data) needs its
    // padded length counted toward the total; data contributes its
    // own true (possibly odd) length, with nothing after it to align.
    const fmtPadded = fmtChunk.length + (fmtChunk.length % 2);
    const totalSize = 4 /*WAVE*/ + 8 + fmtPadded + 8 + dataChunk.length;
    const out = new Uint8Array(8 + totalSize);
    const outDv = new DataView(out.buffer);
    let p = 0;
    const writeStr = (s) => { for (let i = 0; i < s.length; i++) out[p++] = s.charCodeAt(i); };
    writeStr("RIFF");
    outDv.setUint32(p, totalSize, true); p += 4;
    writeStr("WAVE");
    writeStr("fmt ");
    outDv.setUint32(p, fmtChunk.length, true); p += 4;
    out.set(fmtChunk, p); p += fmtChunk.length;
    if (fmtChunk.length % 2) p += 1; // pad byte between fmt and data (left as 0)
    writeStr("data");
    outDv.setUint32(p, dataChunk.length, true); p += 4;
    out.set(dataChunk, p); p += dataChunk.length;

    if (out.length < bytes.length) return { bytes: out, saved: bytes.length - out.length };
  } catch (err) {
    console.warn("[ProjectIO] WAV repack skipped for one asset (kept original):", err);
  }
  return { bytes, saved: 0 };
}

/**
 * Optional pass (see editorState.optimizeAssetsOnSave, toggled from
 * Toolbar.js's File menu) that shrinks every already-collected binary
 * zip entry losslessly BEFORE they're written into the archive:
 *   - image/png entries → re-encoded via UPNG.js (optimizePngBytes())
 *   - audio/wav (and audio/wave) entries → container-repacked
 *     (repackWav()) — the PCM samples themselves are untouched
 *   - everything else (jpg, already-lossy audio like mp3/ogg/aac,
 *     etc) is passed through completely unmodified — there IS no
 *     lossless way to shrink an already-lossy-compressed file further
 *     without decoding and re-encoding it, which would be a real
 *     (if perhaps small) quality loss, not "lossless" — so this
 *     function deliberately does not attempt it and reports these as
 *     skipped rather than silently leaving the user to assume
 *     everything got optimized.
 *
 * Runs against the `entries` collected during dataUrlToBinaryEntry()
 * (see its `pending` param) rather than against dataUrls directly, so
 * this stays a separate, skippable pass layered on top of the
 * always-on binary-entry + dedup step, not a rewrite of it. Also
 * covers why real lossless audio codec compression (WAV → FLAC) is
 * NOT attempted here: it's a genuine option (FLAC decodes back to
 * bit-exact PCM), but every JS/WASM FLAC encoder available is a much
 * larger, heavier dependency (worker setup, multi-file WASM build)
  * than this project's existing self-contained vendor pattern
  * (JSZip, Monaco, UPNG.js) — not worth that weight for a win that
 * only applies to WAV assets specifically, when repackWav() already
 * captures the safe, lightweight subset of that win.
 *
 * @param {Array<{name:string, bytes:Uint8Array, mime:string}>} entries
 *   mutated in place — each entry's `bytes` is replaced if optimized
 * @param {(msg:string)=>void} [onProgress] optional progress callback,
 *   called once per asset processed (e.g. "Optimizing 3/12…")
 * @returns {Promise<{pngCount:number, wavCount:number, skippedCount:number, bytesSaved:number}>}
 */
export async function optimizeProjectAssets(entries, onProgress) {
  const stats = { pngCount: 0, wavCount: 0, skippedCount: 0, bytesSaved: 0 };
  const pngEntries = entries.filter((e) => e.mime === "image/png");
  let UPNG = null;
  if (pngEntries.length) {
    try {
      UPNG = await loadUPNG();
    } catch (err) {
      // PNG optimization unavailable this session (missing or damaged
      // local vendor file, etc) — fall through and still do the WAV pass below;
      // PNGs simply pass through unmodified rather than failing the
      // whole export over an optional step.
      console.warn("[ProjectIO] UPNG.js unavailable — PNGs will not be optimized:", err);
    }
  }

  let done = 0;
  for (const entry of entries) {
    done++;
    if (onProgress) onProgress("Optimizing assets… (" + done + "/" + entries.length + ")");
    if (entry.mime === "image/png" && UPNG) {
      const { bytes, saved } = optimizePngBytes(entry.bytes, UPNG);
      entry.bytes = bytes;
      if (saved > 0) { stats.pngCount++; stats.bytesSaved += saved; }
    } else if (entry.mime === "audio/wav" || entry.mime === "audio/wave") {
      const { bytes, saved } = repackWav(entry.bytes);
      entry.bytes = bytes;
      if (saved > 0) { stats.wavCount++; stats.bytesSaved += saved; }
    } else {
      stats.skippedCount++;
    }
  }
  return stats;
}

/**
 * Triggers a browser download of a Blob under the given filename —
 * shared by exportProject() below (no existing download helper
 * elsewhere in the editor to reuse).
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on a delay rather than immediately — some browsers cancel
  // the download if the object URL is revoked synchronously right
  // after click().
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Builds and downloads the full project .zip.
 *
 * @param {ReturnType<import('../../runtime/index.js').createGame>} game
 * @param {string} [projectName] used for the manifest + the downloaded
 *   filename; defaults to "Untitled Project" / "untitled-project.zip"
 * @param {object} [options]
 * @param {boolean} [options.optimizeAssets] when true, runs the
 *   optional lossless optimize pass (see optimizeProjectAssets())
 *   over every binary asset before it's added to the zip — re-encodes
 *   PNGs through UPNG.js and losslessly repacks WAV audio. Off by
 *   default: it adds real time to the save (fetching UPNG.js the
 *   first time, then decoding+re-encoding every PNG) for a size win
 *   that's only worth it once a project has accumulated real amounts
 *   of art/audio. See Toolbar.js's "Optimize Assets on Save" toggle.
 * @param {(msg:string)=>void} [options.onProgress] forwarded to
 *   optimizeProjectAssets() so the caller can show live progress
 *   (pushLog in EditorEvents.js) during the optimize pass specifically,
 *   since that's the one part of export that can take a few seconds
 *   on a project with a lot of sprites.
 * @returns {Promise<{optimizeStats: object|null}>} optimizeStats is
 *   whatever optimizeProjectAssets() returned, or null if
 *   options.optimizeAssets was false — the caller (EditorEvents.js)
 *   uses this to report how much the optional pass actually saved.
 */
export async function exportProject(game, projectName, options) {
  if (typeof JSZip === "undefined") {
    throw new Error("JSZip failed to load — check your network connection and reload the editor.");
  }
  if (!game) throw new Error("No active game/world to save.");
  const { optimizeAssets = false, onProgress = null } = options || {};

  // Flush the live World's current contents into the active scene's
  // slot BEFORE reading getAllScenesData(), or the scene the user is
  // actually looking at right now would be saved stale (see
  // SceneManager.saveActiveScene()'s own doc comment — every other
  // scene switch/duplicate/delete path already does this same call
  // first for the same reason).
  game.saveActiveScene();

  const allScenes = game.getAllScenesData(); // [{id,name,data}]
  syncScriptSourcesInScenes(allScenes); // saved scene copies must match the script editor (ScriptSync.js)
  const activeSceneId = game.getActiveSceneId();

  const zip = new JSZip();
  zip.file(MANIFEST_FILENAME, JSON.stringify(buildManifest(projectName, activeSceneId), null, 2));

  const scenesFolder = zip.folder("scenes");
  // sceneIndex.json lists every scene's id/name/file so import doesn't
  // have to guess filenames back into ids — each scene's own filename
  // is derived from its id, which is stable and filename-safe (unlike
  // its display name, which the user can rename to anything, including
  // characters that aren't safe in a zip entry name).
  const sceneIndex = allScenes.map((s) => ({ id: s.id, name: s.name, file: s.id + ".json" }));
  // Compact JSON (no pretty-print indentation) for everything written
  // into the zip — indentation is pure whitespace bytes that DEFLATE
  // only partially recovers, and nothing reads these files by hand;
  // ProjectIO.js is the only reader/writer on both ends. Applies to
  // every JSON.stringify call below, not just this one.
  scenesFolder.file("index.json", JSON.stringify(sceneIndex));
  for (const scene of allScenes) {
    scenesFolder.file(scene.id + ".json", JSON.stringify(scene.data));
  }

  const assetsFolder = zip.folder("assets");
  const binFolder = assetsFolder.folder("bin");
  const usedBinNames = new Set();
  // Shared across sprites/frames/audio so byte-identical content
  // anywhere in the project (e.g. two animation frames that happen to
  // be identical, or a sprite re-imported under a different name)
  // collapses to one zip entry — see dedupeOrStore()'s doc comment.
  const hashIndex = new Map();
  // Collected here (not written straight into binFolder) so the
  // optional optimize pass below gets one shot at every entry's bytes
  // before anything is actually added to the JSZip instance.
  const pendingEntries = [];
  const slimSprites = game.getAllSpriteAssets().map((r) => dataUrlToBinaryEntry(r, pendingEntries, usedBinNames, hashIndex));
  const slimFrames = game.getAllFrameAssets().map((r) => dataUrlToBinaryEntry(r, pendingEntries, usedBinNames, hashIndex));
  const slimAudio = game.getAllAudioAssets().map((r) => dataUrlToBinaryEntry(r, pendingEntries, usedBinNames, hashIndex));
  assetsFolder.file("sprites.json", JSON.stringify(slimSprites));
  assetsFolder.file("frames.json", JSON.stringify(slimFrames));
  assetsFolder.file("audio.json", JSON.stringify(slimAudio));

  let optimizeStats = null;
  if (optimizeAssets && pendingEntries.length) {
    optimizeStats = await optimizeProjectAssets(pendingEntries, onProgress);
  }
  // Now that any optimize pass has had its chance to shrink them,
  // actually add every pending entry to the zip. Each entry's `name`
  // is already final/deduped from dataUrlToBinaryEntry() above and
  // does NOT change here — optimizing only rewrites `bytes`, never
  // the entry's identity, so the `file:` pointers already baked into
  // slimSprites/slimFrames/slimAudio above stay correct.
  for (const entry of pendingEntries) {
    binFolder.file(entry.name, entry.bytes);
  }

  // Prefab catalogue (see runtime/prefabs/PrefabRegistry.js) — its own
  // top-level file rather than folded into assets/, matching the same
  // "own top-level key" choice ProjectStorage.js's buildSnapshot() makes
  // for the exact same reason (a prefab is derived scene data, not an
  // imported binary asset).
  zip.file("prefabs.json", JSON.stringify(game.getAllPrefabs()));

  const scriptsByName = {};
  for (const name of getAllScripts()) {
    scriptsByName[name] = getScriptSource(name);
  }
  // Scripts are the one exception left un-minified: they're user-
  // authored JS source, not editor-internal data, and DEFLATE already
  // compresses source text well on its own — reformatting someone's
  // code just to save bytes isn't worth the risk of it reading
  // differently than what they wrote.
  zip.file("scripts.json", JSON.stringify(scriptsByName, null, 2));

  zip.file("layers.json", JSON.stringify(getLayerNames()));
  zip.file("navAreas.json", JSON.stringify(getNavAreaNames()));
  zip.file("tags.json", JSON.stringify(getTagNames()));

  // DEFLATE, not JSZip's default STORE (no compression) — this is the
  // other half of shrinking the save alongside dropping base64 above.
  // Level 9 (max) rather than the zlib-default 6: "Save Project" is a
  // one-shot user action, not a hot loop, so the extra compression
  // time (still well under a second for typical project sizes) is
  // worth spending to buy a few extra percent of size.
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  const safeName = (projectName || "untitled-project").trim().replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase() || "untitled-project";
  // .rs is Realot's own project file extension — the archive itself
  // is still a completely ordinary zip (JSZip.generateAsync above
  // never changes), just saved under a different extension so a
  // project save reads as a distinct file type rather than a generic
  // .zip. JSZip.loadAsync() in importProject() below reads by binary
  // content, not filename, so this rename has zero effect on load —
  // see the accept=".rs,.zip" input in Toolbar.js for the load side
  // (.zip kept there too, so projects saved before this change still
  // open normally).
  downloadBlob(blob, safeName + ".rs");
  return { optimizeStats };
}

/**
 * Reads a saved project .zip and fully restores it: asset catalogue,
 * scripts, physics layer names, and every scene — replacing whatever
 * is currently loaded (a project load is NOT a merge — see
 * clearAllAssets()/clearAllScripts()'s own doc comments for why).
 *
 * Order matters: assets and scripts are restored BEFORE scenes, since
 * scene entities reference sprite/audio keys, prefab ids, and script
 * names by string — restoring scenes first would briefly show every
 * sprite as the missing-texture marker until assets caught up.
 *
 * @param {ReturnType<import('../../runtime/index.js').createGame>} game
 * @param {File} zipFile
 * @returns {Promise<{manifest: object, versionWarning: string|null}>}
 *   versionWarning is a human-readable message when the project's
 *   saved engineVersion is NEWER than this build's ENGINE_VERSION —
 *   the load still proceeds (older engines opening newer projects is
 *   a "best effort, some things may not work" situation, not a hard
 *   failure), the caller decides whether/how to surface the warning.
 */
/**
 * Counts script components that actually contain code, in one scene's raw
 * JSON text. Used to warn before loading a project, because scripts run
 * as ordinary page code (they are NOT sandboxed — see SECURITY.md).
 * @param {string} sceneJson
 * @returns {number}
 */
export function countScriptsInSceneJson(sceneJson) {
  const m = String(sceneJson).match(/"Script":\{[^}]*?"source":"(?:[^"\\]|\\.)+"/g);
  return m ? m.length : 0;
}

export async function importProject(game, zipFile, options) {
  if (typeof JSZip === "undefined") {
    throw new Error("JSZip failed to load — check your network connection and reload the editor.");
  }
  if (!game) throw new Error("No active game/world to load into.");

  const zip = await JSZip.loadAsync(zipFile);

  const manifestEntry = zip.file(MANIFEST_FILENAME);
  if (!manifestEntry) {
    throw new Error("Not a valid Realot project — missing manifest.json.");
  }
  const manifest = JSON.parse(await manifestEntry.async("string"));

  let versionWarning = null;
  if (manifest.engineVersion && compareVersions(manifest.engineVersion, ENGINE_VERSION) > 0) {
    versionWarning =
      "This project was saved with Realot " + manifest.engineVersion +
      ", which is newer than the current engine (" + ENGINE_VERSION + "). " +
      "Some features may not load correctly. Consider updating the engine.";
  }

  const sceneIndexEntry = zip.file("scenes/index.json");
  if (!sceneIndexEntry) {
    throw new Error("Project archive is missing scenes/index.json — the file may be corrupted.");
  }
  const sceneIndex = JSON.parse(await sceneIndexEntry.async("string"));
  if (!sceneIndex.length) {
    throw new Error("Project archive contains no scenes.");
  }

  const allScenes = [];
  let scriptCount = 0;
  for (const entry of sceneIndex) {
    const sceneEntry = zip.file("scenes/" + entry.file);
    if (!sceneEntry) continue;
    const rawSceneJson = await sceneEntry.async("string");
    scriptCount += countScriptsInSceneJson(rawSceneJson);
    const data = JSON.parse(rawSceneJson);
    allScenes.push({ id: entry.id, name: entry.name, data });
  }
  if (!allScenes.length) {
    throw new Error("Project archive's scene files could not be read.");
  }

  // Scripts in an imported project run as normal page code with this
  // editor's permissions. Give the caller a chance to warn the user and
  // back out BEFORE anything in the editor is replaced.
  if (scriptCount > 0 && options && typeof options.confirmScripts === "function") {
    const proceed = await options.confirmScripts(scriptCount);
    if (!proceed) {
      const cancelled = new Error("Load cancelled.");
      cancelled.cancelled = true;
      throw cancelled;
    }
  }

  const spritesEntry = zip.file("assets/sprites.json");
  const framesEntry = zip.file("assets/frames.json");
  const audioEntry = zip.file("assets/audio.json");
  const rawSprites = spritesEntry ? JSON.parse(await spritesEntry.async("string")) : [];
  const rawFrames = framesEntry ? JSON.parse(await framesEntry.async("string")) : [];
  const rawAudio = audioEntry ? JSON.parse(await audioEntry.async("string")) : [];
  // Reconstruct dataUrl from each record's binary zip entry (new-format
  // saves) — or pass through unchanged if it already has one (older
  // saves from before this change). See binaryEntryToDataUrl() above.
  const sprites = await Promise.all(rawSprites.map((r) => binaryEntryToDataUrl(r, zip)));
  const frames = await Promise.all(rawFrames.map((r) => binaryEntryToDataUrl(r, zip)));
  const audio = await Promise.all(rawAudio.map((r) => binaryEntryToDataUrl(r, zip)));

  // Optional entry (same fallback-to-empty pattern as layers.json/
  // tags.json below) so a project zip saved by an older engine build
  // that predates prefabs still imports cleanly instead of throwing.
  const prefabsEntry = zip.file("prefabs.json");
  const prefabs = prefabsEntry ? JSON.parse(await prefabsEntry.async("string")) : [];

  const scriptsEntry = zip.file("scripts.json");
  const scriptsByName = scriptsEntry ? JSON.parse(await scriptsEntry.async("string")) : {};

  const layersEntry = zip.file("layers.json");
  const layerNames = layersEntry ? JSON.parse(await layersEntry.async("string")) : null;

  const navAreasEntry = zip.file("navAreas.json");
  const navAreaNames = navAreasEntry ? JSON.parse(await navAreasEntry.async("string")) : null;

  const tagsEntry = zip.file("tags.json");
  const tagNames = tagsEntry ? JSON.parse(await tagsEntry.async("string")) : null;

  // --- Everything parsed successfully — now actually apply it. ---
  // Assets first (real textures/audio need to exist before any scene
  // that references them is deserialized into the World).
  game.clearAllAssets();
  await game.restoreProjectAssets({ sprites, frames, audio });

  game.clearAllPrefabs();
  game.restoreProjectPrefabs(prefabs);

  replaceAllScripts(scriptsByName);
  // The script list is the truth; scene copies in the file can be stale.
  // (Very old project files have no script list: adopt the scene copies.)
  if (!scriptsEntry) seedScriptStorageFromScenes(allScenes);
  syncScriptSourcesInScenes(allScenes);

  if (layerNames) replaceAllLayerNames(layerNames);
  if (navAreaNames) replaceAllNavAreaNames(navAreaNames);
  if (tagNames) replaceAllTagNames(tagNames);

  game.replaceAllScenesAndLoad(allScenes, manifest.activeSceneId);

  return { manifest, versionWarning };
}
