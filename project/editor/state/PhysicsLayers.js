/**
 * editor/state/PhysicsLayers.js
 *
 * Dynamic physics-layer name registry — mirrors Unity's Layer Manager
 * under Edit > Project Settings > Tags and Layers.
 *
 * There are always 16 fixed slot indices (0-15).  Each slot can either
 * have a name (the layer is "active" and appears in Inspector dropdowns)
 * or be empty (the slot is unused).
 *
 * Rules that match Unity's behaviour:
 *   - Slot 0 is always "Default"; its name can be changed but the slot
 *     cannot be cleared to empty.
 *   - Any other slot can be named or cleared freely.
 *   - Layer numbers (0-15) are what Rapier and the runtime actually use;
 *     names are editor-only labels.
 *
 * Persistence: stored as a JSON array of 16 strings in localStorage.
 * Empty string = unused slot.
 *
 * Layer names are bundled into the project snapshot (see
 * ProjectStorage.js's own doc comment: "manifest + scenes + assets +
 * scripts + layers"), so renaming one is project data changing, same
 * as a script edit — setLayerName() below calls markDirty() for
 * exactly the reason ScriptEditorWindow.js's _scheduleSave() does (see
 * EditorState.js's markDirty doc comment). replaceAllLayerNames()
 * deliberately does NOT: it's the bulk load path (project
 * open/import/restore — see its own doc comment below), and marking
 * dirty there would wrongly flag a project that was just loaded,
 * unedited, as having unsaved changes.
 *
 * EDITOR-ONLY FILE.
 */

import { markDirty } from "./EditorState.js";

export const LAYER_COUNT = 16;

const STORAGE_KEY = "realot_physics_layers";

/** Returns the default 16-element name array (only slot 0 is pre-named). */
function _defaults() {
  return Array.from({ length: LAYER_COUNT }, (_, i) => (i === 0 ? "Default" : ""));
}

/** Public counterpart to _defaults() — used by ProjectStorage.js to reset
 *  the layer registry to a clean slate when opening a project that has
 *  no saved snapshot yet, so it never inherits another project's layer
 *  names left over in this same browser's shared localStorage key. */
export function getDefaultLayerNames() {
  return _defaults();
}

/**
 * Load the full 16-name array from localStorage.
 * Always returns a well-formed array of exactly 16 strings.
 * @returns {string[]}
 */
export function getLayerNames() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        // Normalise: ensure exactly 16 string entries
        const names = Array.from({ length: LAYER_COUNT }, (_, i) =>
          typeof arr[i] === "string" ? arr[i] : ""
        );
        // Slot 0 must always have a name
        if (!names[0].trim()) names[0] = "Default";
        return names;
      }
    }
  } catch (_) {
    // localStorage is unavailable/blocked (common in sandboxed preview
    // iframes). Fall back to whatever was set in-memory this session
    // so renaming layers still works even though it won't survive reload.
    if (_sessionCache) return _sessionCache;
  }
  return _sessionCache || _defaults();
}

/**
 * Set the name of a specific layer slot and persist.
 * Clearing slot 0 is ignored (it will stay "Default").
 * @param {number} index  0-15
 * @param {string} name
 */
export function setLayerName(index, name) {
  if (index < 0 || index >= LAYER_COUNT) return;
  const names = getLayerNames();
  const trimmed = name.trim();
  if (index === 0 && !trimmed) return; // slot 0 can't be cleared
  names[index] = trimmed;
  // In sandboxed preview iframes (Codespaces/Replit webviews are the
  // common case) localStorage access can throw a SecurityError instead
  // of just failing quietly. Never let that escape and break the whole
  // editor render loop — worst case, the name just won't persist across
  // a reload, but the in-memory _sessionCache below keeps it working
  // for the rest of the current session.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch (_) { /* ignore: storage unavailable in this environment */ }
  _sessionCache = names;
  markDirty();
}

// In-memory fallback used whenever localStorage is unavailable/throws,
// so layer names still work for the duration of the current tab even
// if they can't be persisted across reloads.
let _sessionCache = null;

/**
 * Returns only the named (non-empty) layers as { index, name } objects,
 * sorted by index.  Useful for Inspector dropdowns and mask checklists.
 * @returns {{ index: number, name: string }[]}
 */
export function getNamedLayers() {
  return getLayerNames()
    .map((name, index) => ({ index, name }))
    .filter(({ name }) => name.trim() !== "");
}

/**
 * Replaces the entire 16-slot layer name array in one write — the bulk
 * counterpart to setLayerName() used by project import (see
 * editor/state/ProjectIO.js) so restoring a saved project's layer
 * names is one localStorage write instead of up to 16 individual
 * setLayerName() calls. Normalises the same way getLayerNames() does
 * (exactly 16 entries, slot 0 always non-empty) so a malformed or
 * truncated saved array can never leave the registry in a broken
 * state.
 * @param {string[]} names
 */
export function replaceAllLayerNames(names) {
  const normalized = Array.from({ length: LAYER_COUNT }, (_, i) =>
    typeof names[i] === "string" ? names[i] : ""
  );
  if (!normalized[0].trim()) normalized[0] = "Default";
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch (_) { /* ignore: storage unavailable in this environment */ }
  _sessionCache = normalized;
}
