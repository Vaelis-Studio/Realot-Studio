/**
 * runtime/assets/AssetManager.js
 *
 * Maps a logical spriteKey (string) to a PIXI.Texture. Built-in
 * placeholder shapes ("square", "capsule") are generated procedurally so
 * the engine runs with zero external image files. Loaded image assets
 * register themselves here too via registerTexture().
 *
 * RUNTIME-ONLY FILE.
 */

const _textureCache = new Map();

/**
 * Loads an image File (e.g. from an <input type="file"> or a drag-drop
 * event) into a PIXI.Texture and registers it under `key`. Returns a
 * data: URL alongside the texture so callers (the editor's asset
 * browser) can render a thumbnail without touching PIXI at all.
 *
 * @param {string} key logical spriteKey to register the texture under
 * @param {File} file
 * @returns {Promise<{ key: string, dataUrl: string, width: number, height: number }>}
 */
export function loadImageAssetFromFile(key, file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onload = () => {
      loadImageAssetFromDataUrl(key, reader.result).then(resolve, reject);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Same as loadImageAssetFromFile, but starting from an already-decoded
 * data: URL string instead of a File — used by project import (see
 * editor/state/ProjectIO.js) to restore a texture from a saved
 * project's manifest.json without re-round-tripping through a File/
 * FileReader, since the zip entry is already read as a string. Shares
 * the exact same decode -> PIXI.Texture -> registerTexture() path as
 * the File-based version above, so a re-imported project's textures
 * are indistinguishable from ones imported fresh in this session.
 * @param {string} key logical spriteKey to register the texture under
 * @param {string} dataUrl a "data:image/...;base64,..." string
 * @returns {Promise<{ key: string, dataUrl: string, width: number, height: number }>}
 */
export function loadImageAssetFromDataUrl(key, dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("Failed to decode image for key: " + key));
    img.onload = () => {
      try {
        const baseTexture = PIXI.BaseTexture.from(img);
        const texture = new PIXI.Texture(baseTexture);
        registerTexture(key, texture);
        resolve({ key, dataUrl, width: img.naturalWidth, height: img.naturalHeight });
      } catch (err) {
        reject(err);
      }
    };
    img.src = dataUrl;
  });
}

/**
 * Builds the "missing texture" placeholder: a magenta/black checker
 * square, the standard game-engine convention for "no texture assigned"
 * (same idea as Unity/Unreal's pink checker). Using this instead of a
 * plain white texture means a missing/null spriteKey is immediately
 * obvious in the viewport rather than silently rendering as a blank
 * white square that's easy to mistake for "the engine is broken".
 */
function buildMissingTexture() {
  const g = new PIXI.Graphics();
  const half = 16;
  g.beginFill(0x000000);
  g.drawRect(-half, -half, half, half);
  g.drawRect(0, 0, half, half);
  g.endFill();
  g.beginFill(0xff00ff);
  g.drawRect(0, -half, half, half);
  g.drawRect(-half, 0, half, half);
  g.endFill();
  return g;
}

function generateTextureFromGraphics(graphics, fallback) {
  try {
    if (!window.__realotPixiApp) return fallback;
    const generated = window.__realotPixiApp.renderer.generateTexture(graphics);
    return generated || fallback;
  } catch (err) {
    return fallback;
  }
}

function buildPlaceholderTexture(key) {
  const g = new PIXI.Graphics();
  g.beginFill(0xffffff);
  if (key === "capsule") {
    g.drawRoundedRect(-16, -32, 32, 64, 16);
  } else {
    // default: square
    g.drawRect(-16, -16, 32, 32);
  }
  g.endFill();
  return g;
}

/**
 * Register a real loaded texture under a logical key.
 * @param {string} key
 * @param {PIXI.Texture} texture
 */
export function registerTexture(key, texture) {
  _textureCache.set(key, texture);
}

/**
 * Resolve a spriteKey to a PIXI.Texture, generating a placeholder shape
 * texture the first time an unknown built-in key is requested. A null
 * key or any key that isn't a known built-in / imported asset resolves
 * to a visible magenta "missing texture" marker rather than a blank
 * white square, so gaps are obvious instead of silently invisible.
 *
 * Also defends against a DESTROYED cached texture — this is what fixes
 * the "engine freezes when a texture in use gets deleted" bug. Deleting
 * a sprite asset (AssetRegistry.deleteSpriteAsset -> clearTextureAsset)
 * removes the cache entry AND calls texture.destroy(true) in the same
 * synchronous step, so under normal timing a deleted key's very next
 * resolveTexture() call is already a cache miss and falls through to
 * the missing-texture marker below with no special-casing needed.
 * This extra check exists for every OTHER path that could still hand
 * back a dead texture: a caller (RenderSystem's StrokePath block, any
 * future renderer) holding onto a texture reference from a previous
 * tick across an editor-triggered delete that lands between ticks, a
 * WebGL context loss, or any future code path that destroys a texture
 * without going through clearTextureAsset. A destroyed BaseTexture has
 * null internal GL resources, and PIXI throws when code (a Sprite's or
 * SimpleMesh's `.texture` setter, geometry/UV recompute, etc.) touches
 * certain properties on it — with no try/catch anywhere up the call
 * chain to GameLoop's requestAnimationFrame tick, that throw stops the
 * frame loop from ever rescheduling itself, which is the actual freeze.
 * Checking `.destroyed` here, evicting the stale cache entry, and
 * falling back to the (always-valid, never-user-deletable)
 * missing-texture marker means EVERY situation that could hand a
 * caller a dead texture degrades to a visible magenta placeholder
 * instead of a frozen game, regardless of which code path caused it.
 * @param {string|null} key
 * @returns {PIXI.Texture}
 */
export function resolveTexture(key) {
  if (!key) return resolveMissingTexture();

  if (_textureCache.has(key)) {
    const cached = _textureCache.get(key);
    const isDestroyed = !cached || cached.destroyed || (cached.baseTexture && cached.baseTexture.destroyed);
    if (!isDestroyed) return cached;
    // Stale/dead entry — evict it so nothing else can hand it out again,
    // then fall through exactly as if this had been a cache miss.
    _textureCache.delete(key);
  }

  if (key === "square" || key === "capsule") {
    const graphics = buildPlaceholderTexture(key);
    const generated = generateTextureFromGraphics(graphics, PIXI.Texture.WHITE);
    _textureCache.set(key, generated);
    return generated;
  }

  // Unknown key: not a built-in placeholder and not a registered
  // imported asset (e.g. scene references a sprite that hasn't loaded
  // yet, was deleted, or its cached texture was just evicted above as
  // destroyed). Show the missing-texture marker rather than failing
  // silently — or, in the pre-fix behavior, handing back a dead texture
  // that would freeze the engine the moment something tried to use it.
  return resolveMissingTexture();
}

let _missingTextureCache = null;
function resolveMissingTexture() {
  // The missing-texture marker itself must never be handed back
  // destroyed — generateTextureFromGraphics() falls back to
  // PIXI.Texture.WHITE on failure (see its own try/catch), and
  // PIXI.Texture.WHITE is a shared PIXI singleton that's never destroyed
  // by this engine (clearTextureAsset explicitly skips it), so this
  // cache can't itself become the thing that needs defending against.
  if (_missingTextureCache && !_missingTextureCache.destroyed &&
      !(_missingTextureCache.baseTexture && _missingTextureCache.baseTexture.destroyed)) {
    return _missingTextureCache;
  }
  const graphics = buildMissingTexture();
  _missingTextureCache = generateTextureFromGraphics(graphics, PIXI.Texture.WHITE);
  return _missingTextureCache;
}

export function clearTextureCache() {
  _textureCache.clear();
  _missingTextureCache = null;
}

/**
 * Evicts ONLY the procedurally-generated placeholder textures this
 * engine builds itself — the missing-texture marker and the "square"/
 * "capsule" built-in shapes — leaving every REAL imported sprite/frame
 * texture in _textureCache completely untouched. Used by
 * MemoryWatchdog.js's automatic high-memory reclaim pass: unlike
 * clearTextureCache() (which wipes everything, including textures a
 * live scene is actively displaying, and would make on-screen sprites
 * pop to "missing" until something re-touches them) or clearTextureAsset
 * (which permanently deletes ONE real user asset), this is completely
 * safe to call at any time during live gameplay — it can only ever
 * affect generated placeholders, which regenerate for free the instant
 * resolveTexture() is asked for "square", "capsule", or a null/unknown
 * key again. Destroys the underlying PIXI resources for each evicted
 * placeholder (matching clearTextureAsset's own reasoning) so the
 * actual GPU/CPU memory is freed, not just the cache reference.
 */
export function clearGeneratedPlaceholderTextures() {
  for (const generatedKey of ["square", "capsule"]) {
    const texture = _textureCache.get(generatedKey);
    if (!texture) continue;
    _textureCache.delete(generatedKey);
    if (texture === PIXI.Texture.WHITE) continue; // shared singleton, never destroy
    try { texture.destroy(true); } catch (err) { /* already gone */ }
  }
  if (_missingTextureCache && _missingTextureCache !== PIXI.Texture.WHITE) {
    try { _missingTextureCache.destroy(true); } catch (err) { /* already gone */ }
  }
  _missingTextureCache = null;
}

/**
 * Removes ONE key's cached texture (used when the user deletes a
 * single sprite asset — see AssetRegistry.deleteSpriteAsset) without
 * wiping every other loaded/placeholder texture the way
 * clearTextureCache() does. Destroys the underlying PIXI resources too
 * (baseTexture + texture) so the freed image data doesn't linger in
 * GPU/CPU memory just because the catalogue entry is gone — a project
 * with many import/delete cycles would otherwise slowly leak texture
 * memory even though nothing visibly references the old key anymore.
 * @param {string} key
 */
export function clearTextureAsset(key) {
  const texture = _textureCache.get(key);
  if (!texture) return;
  _textureCache.delete(key);
  // Never destroy PIXI's own shared Texture.WHITE — imported sprite
  // assets always go through registerTexture() with a real decoded
  // image (see loadImageAssetFromFile above), so a real asset's key
  // should never actually resolve to this, but skip destroying it
  // regardless: it's a globally shared singleton PIXI itself owns, and
  // destroying it would break every OTHER unrelated thing using it as
  // a fallback texture, not just this one deleted asset.
  if (texture === PIXI.Texture.WHITE) return;
  try {
    // destroy(true) also destroys the underlying BaseTexture, matching
    // PIXI's own recommendation for "this image is gone for good"
    // (as opposed to just swapping which sprite displays it).
    texture.destroy(true);
  } catch (err) {
    // Already destroyed — non-fatal.
  }
}

/**
 * Loads an audio File into the audio cache and registers it under
 * `key`, mirroring loadImageAssetFromFile()'s shape. Audio has no PIXI
 * texture equivalent, so what's cached is just the dataUrl itself —
 * resolveAudioSrc() below hands that same string straight to an
 * <audio> element (see runtime/systems/AudioSystem.js). `duration` is
 * read once via a throwaway <audio> so the asset browser can show clip
 * length without every caller needing to load its own element.
 *
 * @param {string} key logical audioKey to register the clip under
 * @param {File} file
 * @returns {Promise<{ key: string, dataUrl: string, duration: number }>}
 */
export function loadAudioAssetFromFile(key, file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onload = () => {
      loadAudioAssetFromDataUrl(key, reader.result).then(resolve, reject);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Same as loadAudioAssetFromFile, but starting from an already-decoded
 * data: URL string — mirrors loadImageAssetFromDataUrl's role for
 * project import (see editor/state/ProjectIO.js).
 * @param {string} key logical audioKey to register the clip under
 * @param {string} dataUrl a "data:audio/...;base64,..." string
 * @returns {Promise<{ key: string, dataUrl: string, duration: number }>}
 */
export function loadAudioAssetFromDataUrl(key, dataUrl) {
  return new Promise((resolve) => {
    const probe = new Audio();
    const finish = (duration) => {
      registerAudio(key, dataUrl);
      resolve({ key, dataUrl, duration: duration || 0 });
    };
    probe.onerror = () => finish(0); // still usable even if duration can't be probed
    probe.onloadedmetadata = () => finish(probe.duration);
    probe.src = dataUrl;
  });
}

const _audioCache = new Map();

/**
 * Register a raw audio dataUrl under a logical key.
 * @param {string} key
 * @param {string} dataUrl
 */
export function registerAudio(key, dataUrl) {
  _audioCache.set(key, dataUrl);
}

/**
 * Resolve an audioKey to a playable src string (a data: URL), or null
 * if the key is unknown/missing — callers (AudioSystem.js) treat null
 * as "nothing to play" rather than failing.
 * @param {string|null} key
 * @returns {string|null}
 */
export function resolveAudioSrc(key) {
  if (!key) return null;
  return _audioCache.get(key) || null;
}

export function clearAudioCache() {
  _audioCache.clear();
}

/**
 * Removes ONE key's cached audio dataUrl (used when the user deletes a
 * single audio asset — see AssetRegistry.deleteAudioAsset), without
 * wiping every other loaded clip the way clearAudioCache() does.
 * Nothing further to "destroy" here the way clearTextureAsset() does
 * for PIXI resources — the cache only ever held a plain dataUrl
 * string, not a live audio element or decoded buffer — so any
 * currently-playing <audio> element (see runtime/systems/
 * AudioSystem.js) keeps playing to its natural end uninterrupted;
 * only a FUTURE resolveAudioSrc() call for this key starts returning
 * null (treated as "nothing to play" by AudioSystem, same as any
 * other missing/unassigned audioKey).
 * @param {string} key
 */
export function clearAudioAssetCache(key) {
  _audioCache.delete(key);
}
