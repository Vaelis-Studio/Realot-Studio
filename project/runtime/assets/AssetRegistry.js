/**
 * runtime/assets/AssetRegistry.js
 *
 * Plain-data catalogue of imported sprite assets: { key, name, dataUrl,
 * width, height }. This is what backs the editor's "Sprites" folder in
 * the Project panel and the drag source for placing sprites in a scene.
 *
 * Separate from AssetManager.js on purpose: AssetManager resolves a
 * spriteKey -> PIXI.Texture (rendering concern), while AssetRegistry is
 * just the catalogue of what's been imported (asset-browser concern).
 * Keeping the record plain data (no PIXI objects) means it can be
 * listed/rendered by editor UI without ever importing PIXI logic.
 *
 * RUNTIME-ONLY FILE.
 */

import { loadImageAssetFromFile, loadAudioAssetFromFile, loadImageAssetFromDataUrl, loadAudioAssetFromDataUrl, clearTextureAsset, clearAudioAssetCache } from "./AssetManager.js";

/** @type {Map<string, { key: string, name: string, dataUrl: string, width: number, height: number }>} */
const _assets = new Map();

/**
 * Separate catalogue for imported audio clips — backs the Project
 * panel's "Audio" folder and the drag source for placing an AudioSource
 * entity in a scene. Kept apart from _assets (sprites) for the same
 * asset-browser-grouping reason _frameAssets is kept apart below: each
 * folder in BottomPanel.js reads exactly one catalogue.
 * @type {Map<string, { key: string, name: string, dataUrl: string, duration: number }>}
 */
const _audioAssets = new Map();

/**
 * Separate catalogue for animation-frame textures (see
 * registerFrameAsset() below). Kept apart from _assets so the Project
 * panel's Sprites folder — which lists getAllSpriteAssets() — only ever
 * shows sprites the user explicitly imported as standalone assets, not
 * the (often dozens of) per-frame images that come out of slicing a
 * sheet or unzipping a walk-cycle. getSpriteAsset() below still checks
 * BOTH maps, so thumbnail lookups (used by the Animation panel and by
 * anything resolving a spriteKey generically) keep working exactly as
 * before regardless of which catalogue a given key lives in.
 * @type {Map<string, { key: string, name: string, dataUrl: string, width: number, height: number }>}
 */
const _frameAssets = new Map();

let _nextAssetId = 1;

/**
 * Imports one or more image Files as sprite assets: loads each into the
 * texture cache (via AssetManager) and records a plain-data entry here.
 * @param {File[]|FileList} files
 * @returns {Promise<Array<{key:string,name:string,dataUrl:string,width:number,height:number}>>}
 */
export async function importSpriteFiles(files) {
  const imported = [];
  for (const file of Array.from(files)) {
    if (!file.type || !file.type.startsWith("image/")) continue;
    const key = "sprite_" + _nextAssetId++ + "_" + sanitizeName(file.name);
    const { dataUrl, width, height } = await loadImageAssetFromFile(key, file);
    const record = { key, name: stripExtension(file.name), dataUrl, width, height };
    _assets.set(key, record);
    imported.push(record);
  }
  return imported;
}

/**
 * Imports one or more audio Files as audio assets, mirroring
 * importSpriteFiles() exactly: loads each into AssetManager's audio
 * cache and records a plain-data catalogue entry here.
 * @param {File[]|FileList} files
 * @returns {Promise<Array<{key:string,name:string,dataUrl:string,duration:number}>>}
 */
export async function importAudioFiles(files) {
  const imported = [];
  for (const file of Array.from(files)) {
    if (!file.type || !file.type.startsWith("audio/")) continue;
    const key = "audio_" + _nextAssetId++ + "_" + sanitizeName(file.name);
    const { dataUrl, duration } = await loadAudioAssetFromFile(key, file);
    const record = { key, name: stripExtension(file.name), dataUrl, duration };
    _audioAssets.set(key, record);
    imported.push(record);
  }
  return imported;
}

export function getAllAudioAssets() {
  return Array.from(_audioAssets.values());
}

export function getAudioAsset(key) {
  return _audioAssets.get(key) || null;
}

export function getAllSpriteAssets() {
  return Array.from(_assets.values());
}

export function getAllFrameAssets() {
  return Array.from(_frameAssets.values());
}

export function getSpriteAsset(key) {
  return _assets.get(key) || _frameAssets.get(key) || null;
}

/**
 * Removes a sprite asset from the catalogue AND its cached PIXI texture
 * (see AssetManager.clearAsset below), so a freshly re-imported file
 * using the same generated key — unlikely given the counter in the key,
 * but possible for frame assets referenced by literal name — doesn't
 * silently reuse stale cached pixel data. Entities in the scene that
 * still reference this key are left untouched (they're plain string
 * spriteKeys, see components/SpriteRenderer.js's own doc comment) —
 * resolveTexture() already renders any unresolvable key as the
 * magenta "missing texture" marker, so nothing crashes; the object
 * just visibly needs a new sprite assigned, same as a fresh empty
 * SpriteRenderer.
 * @param {string} key
 * @returns {boolean} whether an asset with that key existed and was removed
 */
export function deleteSpriteAsset(key) {
  const existed = _assets.delete(key) || _frameAssets.delete(key);
  if (existed) clearTextureAsset(key);
  return existed;
}

/**
 * Same as deleteSpriteAsset() but for an audio clip — see its doc
 * comment for why entity references are deliberately left alone
 * (AudioSource.audioKey resolving to nothing just means "nothing to
 * play", see AssetManager.resolveAudioSrc()).
 * @param {string} key
 * @returns {boolean}
 */
export function deleteAudioAsset(key) {
  const existed = _audioAssets.delete(key);
  if (existed) clearAudioAssetCache(key);
  return existed;
}

/**
 * Renames a sprite asset's DISPLAY NAME only — never its key. This is
 * the critical distinction from a scene rename (SceneManager.
 * renameScene() also only touches .name, never .id, for the exact same
 * reason): the key is a stable identifier scripts read/write directly
 * via `sprite.texture` (see runtime/scripting/components/SpriteAPI.js's
 * texture getter/setter, which gets/sets spriteKey verbatim) and every
 * SpriteRenderer.spriteKey in the scene already points at by that same
 * string. If rename changed the key, any script doing
 * `sprite.texture = "player_walk"` would silently break the moment
 * someone renames "player_walk" to something else in the asset
 * browser — a purely cosmetic-looking action quietly breaking running
 * code. Only .name (what getSpriteAsset()/getAllSpriteAssets() expose
 * for DISPLAY, e.g. the Inspector's spriteDisplayName lookup) changes;
 * every existing reference by key keeps working exactly as before.
 * @param {string} key
 * @param {string} newName
 * @returns {boolean} whether an asset with that key existed
 */
export function renameSpriteAsset(key, newName) {
  const trimmed = (newName || "").trim();
  if (!trimmed) return false;
  const record = _assets.get(key) || _frameAssets.get(key);
  if (!record) return false;
  record.name = trimmed;
  return true;
}

/**
 * Same as renameSpriteAsset() but for an audio clip — see its doc
 * comment for why only .name changes, never the key AudioSource.
 * audioKey and scripts (via any future audio-key-reading API) rely on.
 * @param {string} key
 * @param {string} newName
 * @returns {boolean}
 */
export function renameAudioAsset(key, newName) {
  const trimmed = (newName || "").trim();
  if (!trimmed) return false;
  const record = _audioAssets.get(key);
  if (!record) return false;
  record.name = trimmed;
  return true;
}

/**
 * Records a sprite asset catalogue entry for a texture that was
 * registered some OTHER way than importSpriteFiles — specifically, used
 * by editor/animation/AnimationImport.js for frames produced by
 * slicing a sprite sheet or reading images out of a zip, where the
 * texture is registered directly via AssetManager.registerTexture()
 * (not loadImageAssetFromFile) because the pixel data comes from an
 * in-memory canvas, not a raw File.
 * @param {{key:string,name:string,dataUrl:string,width:number,height:number}} record
 */
export function registerSpriteAsset(record) {
  _assets.set(record.key, record);
}

/**
 * Same as registerSpriteAsset(), but for animation-frame textures —
 * files/slices imported through the Animation panel (standalone-images,
 * zip, or sprite-sheet import). Stored in _frameAssets instead of
 * _assets so these DON'T show up in the Project panel's Sprites folder
 * (getAllSpriteAssets() only reads _assets) while still being
 * resolvable by key via getSpriteAsset(), which checks both maps. This
 * is what keeps an imported walk-cycle's 8 frame images out of the
 * general sprite browser while the Animation panel's own frame grid
 * (which calls getSpriteAsset() directly by spriteKey) still finds
 * them fine.
 * @param {{key:string,name:string,dataUrl:string,width:number,height:number}} record
 */
export function registerFrameAsset(record) {
  _frameAssets.set(record.key, record);
}

/**
 * Wipes every sprite, frame, and audio asset — both the plain-data
 * catalogue AND the real PIXI textures / audio cache entries backing
 * them (via clearTextureAsset/clearAudioAssetCache, same per-key
 * teardown deleteSpriteAsset/deleteAudioAsset already use for a single
 * asset, just applied to everything at once). Used by project import
 * (see editor/state/ProjectIO.js) so loading a new project always
 * starts from a clean asset catalogue instead of merging with
 * whatever the previous project/session had loaded — a stale sprite
 * left behind from before the import would otherwise silently keep
 * showing up in the Sprites folder even though it isn't part of the
 * project just loaded.
 */
export function clearAllAssets() {
  for (const key of _assets.keys()) clearTextureAsset(key);
  for (const key of _frameAssets.keys()) clearTextureAsset(key);
  for (const key of _audioAssets.keys()) clearAudioAssetCache(key);
  _assets.clear();
  _frameAssets.clear();
  _audioAssets.clear();
}

/**
 * Rebuilds the full asset catalogue (sprites, frame assets, audio)
 * from saved project data — the counterpart to exporting via
 * getAllSpriteAssets()/getAllFrameAssets()/getAllAudioAssets(). Used
 * exclusively by project import (editor/state/ProjectIO.js).
 *
 * Each record's dataUrl is re-decoded into a REAL PIXI.Texture (for
 * sprites/frames) or registered into the audio cache (for audio),
 * exactly as if the user had just re-imported that file — not just a
 * catalogue entry with no backing texture, which would render as the
 * magenta "missing texture" marker despite showing up fine in the
 * asset browser. Every other field on the record (gifFrames, gifFps,
 * width, height, duration, etc.) is preserved verbatim since callers
 * may have stashed extra data on it (see e.g. the animated-GIF import
 * path in EditorEvents.js, which adds gifFrames/gifFps to a sprite
 * asset record).
 *
 * Also advances the internal _nextAssetId counter past every restored
 * key's own embedded counter (sprite_<n>_..., audio_<n>_...) so a
 * fresh import in THIS session after loading a project can never
 * generate a key that collides with one just restored.
 *
 * @param {{sprites?:object[], frames?:object[], audio?:object[]}} data
 * @returns {Promise<void>} resolves once every texture/audio clip has
 *   finished decoding and is registered
 */
export async function restoreProjectAssets(data) {
  const sprites = (data && data.sprites) || [];
  const frames = (data && data.frames) || [];
  const audio = (data && data.audio) || [];

  for (const record of [...sprites, ...frames, ...audio]) {
    _bumpNextAssetId(record.key);
  }

  await Promise.all(
    sprites.map((record) =>
      loadImageAssetFromDataUrl(record.key, record.dataUrl).then(() => {
        _assets.set(record.key, { ...record });
      })
    )
  );
  await Promise.all(
    frames.map((record) =>
      loadImageAssetFromDataUrl(record.key, record.dataUrl).then(() => {
        _frameAssets.set(record.key, { ...record });
      })
    )
  );
  await Promise.all(
    audio.map((record) =>
      loadAudioAssetFromDataUrl(record.key, record.dataUrl).then(() => {
        _audioAssets.set(record.key, { ...record });
      })
    )
  );
}

/**
 * Advances _nextAssetId past whatever numeric id is embedded in a
 * restored key (e.g. "sprite_7_player" -> 7), so newly-imported assets
 * in the current session never reuse a restored project's key. Safe to
 * call with any string — keys that don't match the sprite_N_/audio_N_
 * pattern (unlikely, but not guaranteed for hand-authored project
 * files) are simply ignored.
 * @param {string} key
 */
function _bumpNextAssetId(key) {
  const match = /^(?:sprite|audio)_(\d+)_/.exec(key || "");
  if (match) {
    const n = parseInt(match[1], 10);
    if (!isNaN(n) && n >= _nextAssetId) _nextAssetId = n + 1;
  }
}

function stripExtension(filename) {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(0, i) : filename;
}

function sanitizeName(filename) {
  return stripExtension(filename).replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}
