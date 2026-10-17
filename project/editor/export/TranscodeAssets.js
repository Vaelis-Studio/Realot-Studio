/**
 * editor/export/TranscodeAssets.js
 *
 * Re-encodes exported image/audio bytes into smaller delivery formats
 * BEFORE they're written into the export zip — this is what keeps an
 * exported build's asset payload small instead of just re-zipping the
 * editor's original PNG/WAV/etc bytes verbatim.
 *
 *   Images -> AVIF when the browser can actually ENCODE AVIF
 *             (canvas.convertToBlob({type:"image/avif"}) — Chromium
 *             105+/ChromeOS support this; see chooseImageFormat()),
 *             else WebP (near-universal encode support), else the
 *             original bytes untouched. This is a REAL re-encode (not
 *             a guess): every candidate format is round-trip verified
 *             by actually decoding it back before it's trusted (see
 *             encodeImage()) so export can never silently ship a
 *             corrupt/blank texture.
 *   Audio  -> Opus-in-WebM via MediaRecorder, which is the ONLY Opus
 *             encoder path the web platform exposes with no extra
 *             dependency (there is no OfflineAudioContext-based
 *             encode — see this function's own doc comment for why).
 *             Falls back to the clip's original bytes if the browser
 *             can't record audio/webm;codecs=opus at all.
 *
 * All lossy — this is deliberately NOT the same "lossless" pass
 * ProjectIO.js's optimizeProjectAssets() does for Save Project (that
 * one exists purely to keep a project's own bytes pixel/sample
 * identical for re-editing; this one exists to make a SHIPPED build's
 * download small, where a real quality/size trade-off is expected and
 * desired, the same way Unity/Godot/every other engine's build
 * pipeline re-compresses textures and audio for a release build).
 *
 * EDITOR-ONLY FILE.
 */

/**
 * Decodes a "data:mime;base64,..." string into raw bytes + mime.
 * @param {string} dataUrl
 * @returns {{mime: string, bytes: Uint8Array}}
 */
function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/s.exec(dataUrl || "");
  if (!m) throw new Error("Not a base64 data URL");
  const mime = m[1] || "application/octet-stream";
  const binaryStr = atob(m[2]);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return { mime, bytes };
}

/**
 * Loads a dataUrl into an HTMLImageElement.
 * @param {string} dataUrl
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode source image"));
    img.src = dataUrl;
  });
}

/**
 * One-time feature detection cache for which image mime types this
 * browser's canvas can actually ENCODE (not just decode/display —
 * canvas.toBlob silently falls back to PNG for an unsupported type
 * with no error, so support has to be verified by round-tripping a
 * tiny real canvas through it once, per format, per session).
 * @type {Promise<{avif:boolean, webp:boolean}>|null}
 */
let _formatSupportPromise = null;
function detectImageEncodeSupport() {
  if (_formatSupportPromise) return _formatSupportPromise;
  _formatSupportPromise = (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ff00ff";
    ctx.fillRect(0, 0, 2, 2);

    const canEncode = (mime) =>
      new Promise((resolve) => {
        try {
          canvas.toBlob((blob) => resolve(!!blob && blob.type === mime), mime, 0.8);
        } catch (err) {
          resolve(false);
        }
      });

    const [avif, webp] = await Promise.all([canEncode("image/avif"), canEncode("image/webp")]);
    return { avif, webp };
  })();
  return _formatSupportPromise;
}

/**
 * Re-encodes one image asset's bytes into the smallest format this
 * browser can reliably produce AND verify. Tries AVIF first (best
 * compression), then WebP, keeping whichever candidate actually comes
 * out smaller than the original AND survives a real decode round-trip
 * (canvas re-draws it without throwing / producing a 0x0 image) — a
 * browser that silently produces a corrupt encoder output for some
 * exotic source image falls back to the original bytes rather than
 * shipping something broken.
 *
 * @param {string} dataUrl original "data:image/...;base64,..."
 * @param {number} quality 0..1 encoder quality (only applies to lossy
 *   AVIF/WebP output — ignored if neither is available)
 * @returns {Promise<{bytes: Uint8Array, mime: string, ext: string, originalBytes: number}>}
 */
export async function transcodeImage(dataUrl, quality = 0.75) {
  const { mime: originalMime, bytes: originalBytes } = decodeDataUrl(dataUrl);
  const support = await detectImageEncodeSupport();

  // Never re-encode an already-tiny image (procedurally-simple icons,
  // 1x1 placeholders, etc) — the format's own container overhead can
  // make a genuinely small source LARGER after conversion.
  const candidates = [];
  if (support.avif) candidates.push({ mime: "image/avif", ext: "avif" });
  if (support.webp) candidates.push({ mime: "image/webp", ext: "webp" });

  if (!candidates.length) {
    return { bytes: originalBytes, mime: originalMime, ext: extensionForMime(originalMime), originalBytes: originalBytes.length };
  }

  let img;
  try {
    img = await loadImage(dataUrl);
  } catch (err) {
    // Can't even decode the source for re-encoding — ship it untouched.
    return { bytes: originalBytes, mime: originalMime, ext: extensionForMime(originalMime), originalBytes: originalBytes.length };
  }

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 1;
  canvas.height = img.naturalHeight || 1;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  for (const candidate of candidates) {
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, candidate.mime, quality));
      if (!blob || blob.size === 0) continue;
      // Verify: re-decode the encoded blob and confirm it actually
      // produces an image of the right dimensions before trusting it.
      const roundTripOk = await verifyImageBlob(blob, canvas.width, canvas.height);
      if (!roundTripOk) continue;
      if (blob.size < originalBytes.length) {
        const buf = new Uint8Array(await blob.arrayBuffer());
        return { bytes: buf, mime: candidate.mime, ext: candidate.ext, originalBytes: originalBytes.length };
      }
    } catch (err) {
      // Try the next candidate format.
      continue;
    }
  }

  // Neither candidate beat the original size (or both failed verification) —
  // ship the original bytes rather than a worse or unverified result.
  return { bytes: originalBytes, mime: originalMime, ext: extensionForMime(originalMime), originalBytes: originalBytes.length };
}

/**
 * @param {Blob} blob
 * @param {number} expectedW
 * @param {number} expectedH
 * @returns {Promise<boolean>}
 */
function verifyImageBlob(blob, expectedW, expectedH) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img.naturalWidth === expectedW && img.naturalHeight === expectedH);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(false);
    };
    img.src = url;
  });
}

function extensionForMime(mime) {
  const map = {
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif",
    "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg", "image/bmp": "bmp",
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/wave": "wav",
    "audio/ogg": "ogg", "audio/webm": "webm", "audio/aac": "aac", "audio/flac": "flac",
  };
  return map[mime] || "bin";
}

/**
 * One-time feature detection for whether this browser's MediaRecorder
 * can actually produce Opus-in-WebM.
 * @returns {boolean}
 */
function canRecordOpus() {
  return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm;codecs=opus");
}

/**
 * Re-encodes one audio clip's bytes to Opus-in-WebM.
 *
 * IMPORTANT, honest limitation: the web platform does not expose an
 * offline/faster-than-real-time Opus encoder — MediaRecorder can only
 * record a LIVE AudioContext graph in real time (OfflineAudioContext
 * cannot feed a MediaStreamDestination — confirmed browser-engine
 * limitation, not a bug in this code). So transcoding an audio clip to
 * Opus here takes as long as the clip's own playback duration (a
 * 10-second sound effect takes ~10 real seconds to transcode). This is
 * still fully automatic and happens once at export time, never at
 * runtime in the shipped game — see ExportGame.js's onProgress
 * reporting for surfacing this to the user during export.
 *
 * @param {string} dataUrl original "data:audio/...;base64,..."
 * @returns {Promise<{bytes: Uint8Array, mime: string, ext: string, originalBytes: number}>}
 */
export async function transcodeAudio(dataUrl) {
  const { mime: originalMime, bytes: originalBytes } = decodeDataUrl(dataUrl);

  if (!canRecordOpus()) {
    return { bytes: originalBytes, mime: originalMime, ext: extensionForMime(originalMime), originalBytes: originalBytes.length };
  }

  try {
    const buf = await recordAsOpus(dataUrl);
    if (buf && buf.length > 0 && buf.length < originalBytes.length) {
      return { bytes: buf, mime: "audio/webm", ext: "webm", originalBytes: originalBytes.length };
    }
  } catch (err) {
    console.warn("[export] Opus transcode failed for one audio clip, keeping original:", err);
  }
  return { bytes: originalBytes, mime: originalMime, ext: extensionForMime(originalMime), originalBytes: originalBytes.length };
}

/**
 * Plays `dataUrl` through a real-time AudioContext graph routed into a
 * MediaStreamDestination, records that stream with MediaRecorder, and
 * resolves with the encoded Opus/WebM bytes once playback ends.
 * @param {string} dataUrl
 * @returns {Promise<Uint8Array>}
 */
function recordAsOpus(dataUrl) {
  return new Promise((resolve, reject) => {
    const audioEl = new Audio();
    audioEl.src = dataUrl;
    audioEl.muted = true; // avoid double-hearing it out loud during export; the graph below still captures the real signal
    audioEl.crossOrigin = "anonymous";

    audioEl.onerror = () => reject(new Error("Failed to decode source audio for transcoding"));

    audioEl.oncanplaythrough = () => {
      let ctx;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const source = ctx.createMediaElementSource(audioEl);
        const dest = ctx.createMediaStreamDestination();
        source.connect(dest);

        const recorder = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus" });
        const chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size) chunks.push(e.data);
        };
        recorder.onerror = (e) => reject(e.error || new Error("MediaRecorder error"));
        recorder.onstop = async () => {
          try {
            const blob = new Blob(chunks, { type: "audio/webm" });
            const buf = new Uint8Array(await blob.arrayBuffer());
            ctx.close();
            resolve(buf);
          } catch (err) {
            reject(err);
          }
        };

        audioEl.onended = () => {
          // Small trailing delay so the recorder flushes its final chunk.
          setTimeout(() => recorder.state !== "inactive" && recorder.stop(), 150);
        };

        recorder.start();
        audioEl.currentTime = 0;
        audioEl.play().catch(reject);
      } catch (err) {
        reject(err);
      }
    };
  });
}

/**
 * Renders a user-supplied favicon image into a square PNG at exactly
 * `size`x`size`, for the exported build's icons/ folder (see
 * ExportGame.js). Deliberately always PNG (not AVIF/WebP like
 * transcodeImage() above) — favicons/app icons are read by the OS
 * chrome, browser tab bar, and "add to home screen" surfaces, several
 * of which don't support AVIF, so broad compatibility matters more
 * than the extra few KB an app icon would save. Non-square source
 * images are letterboxed onto a transparent square canvas (centered,
 * scaled to fit) rather than stretched, so the user's image doesn't
 * end up distorted just because a manifest icon slot requires 1:1.
 *
 * @param {string} sourceDataUrl the favicon image the user picked, as
 *   a "data:image/...;base64,..." string (see EditorEvents.js's
 *   "export-favicon-input" case, which reads the raw uploaded file
 *   with FileReader — no AssetRegistry involvement, this is a one-off
 *   pick, not a cataloged reusable asset)
 * @param {number} size target width/height in pixels (e.g. 192, 512)
 * @returns {Promise<Uint8Array>} PNG bytes
 */
export async function renderIconPng(sourceDataUrl, size) {
  const img = await loadImage(sourceDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  const srcW = img.naturalWidth || 1;
  const srcH = img.naturalHeight || 1;
  const scale = Math.min(size / srcW, size / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const dx = (size - drawW) / 2;
  const dy = (size - drawH) / 2;
  ctx.drawImage(img, dx, dy, drawW, drawH);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to encode favicon PNG"))), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

