/**
 * editor/scripting/ScriptStorage.js
 *
 * Persists user script source code to localStorage so scripts survive
 * editor reloads. Scripts are keyed by name. The Script component on
 * each entity also stores its own copy of the source (so the scene
 * serializes with the code), but this storage is the "master" that
 * the Monaco editor's tabbed UI reads/writes against.
 *
 * EDITOR-ONLY FILE.
 */

const STORAGE_KEY = "realot_scripts";

/** @type {Map<string, string>} scriptName -> source */
let _cache = null;

function _load() {
  if (_cache) return _cache;
  _cache = new Map();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      for (const [name, source] of Object.entries(obj)) {
        _cache.set(name, source);
      }
    }
  } catch (err) {
    // localStorage may be unavailable or corrupted — start empty
  }
  return _cache;
}

function _save() {
  try {
    const obj = {};
    for (const [name, source] of _cache) {
      obj[name] = source;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (err) {
    // storage full or unavailable — silently ignore
  }
}

export function getAllScripts() {
  const cache = _load();
  return Array.from(cache.keys()).sort();
}

export function getScriptSource(name) {
  const cache = _load();
  return cache.get(name) || "";
}

export function saveScript(name, source) {
  const cache = _load();
  cache.set(name, source);
  _save();
}

export function deleteScript(name) {
  const cache = _load();
  if (cache.delete(name)) {
    _save();
  }
}

export function renameScript(oldName, newName) {
  const cache = _load();
  const source = cache.get(oldName);
  if (source === undefined) return;
  cache.delete(oldName);
  cache.set(newName, source);
  _save();
}

export function scriptExists(name) {
  return _load().has(name);
}

/**
 * Wipes every stored script. Used by project import (see
 * editor/state/ProjectIO.js) so loading a project always starts from a
 * clean script set instead of merging with whatever scripts were
 * already in localStorage from a previous project/session — without
 * this, a stale script from before the import would keep showing up
 * in the Scripts folder even though it isn't part of the project just
 * loaded (same reasoning as AssetRegistry.clearAllAssets()).
 */
export function clearAllScripts() {
  _clearQuiet();
  _notifyReplaced();
}

function _clearQuiet() {
  const cache = _load();
  cache.clear();
  _save();
}

// Listeners told whenever the WHOLE script set is swapped out (project
// import, snapshot load, new project). The script editor uses this to drop
// its cached Monaco models and open tabs — otherwise it keeps showing (and
// auto-saving back!) the previous project's code under the same names.
const _replaceListeners = new Set();
export function onScriptsReplaced(fn) {
  _replaceListeners.add(fn);
  return () => _replaceListeners.delete(fn);
}
function _notifyReplaced() {
  for (const fn of _replaceListeners) {
    try { fn(); } catch (_) { /* a listener must never break loading a project */ }
  }
}

/**
 * Replaces the ENTIRE script set with the given name -> source map in
 * one call — the counterpart to getAllScripts()+getScriptSource() used
 * when exporting a project. Used exclusively by project import.
 * @param {Record<string,string>} scriptsByName
 */
export function replaceAllScripts(scriptsByName) {
  _clearQuiet();
  const cache = _load();
  for (const [name, source] of Object.entries(scriptsByName || {})) {
    cache.set(name, source);
  }
  _save();
  _notifyReplaced();
}

const DEFAULT_TEMPLATE =
  '// ' + 'Called once when the game starts\n' +
  'function onStart() {\n\n' +
  '}\n\n' +
  '// ' + 'Called every frame\n' +
  'function onUpdate() {\n' +
  '  // this.x, this.y — position\n' +
  '  // this.rigidbody.velocity — velocity (needs a Rigidbody 2D)\n' +
  '  // input.keyDown("Space") — check input\n' +
  '}\n';

export function createScript(name) {
  name = name || ("Script" + (getAllScripts().length + 1));
  if (scriptExists(name)) return name;
  saveScript(name, DEFAULT_TEMPLATE);
  return name;
}
