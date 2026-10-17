/**
 * Project-wide object tag registry used by the Inspector and script
 * autocomplete. The tag stored on an entity remains part of the scene data;
 * this registry only remembers which tags are available to choose later.
 *
 * Tag names are bundled into the project snapshot (see
 * ProjectStorage.js's own doc comment), so adding/removing one is
 * project data changing — addTag()/deleteTag() below call markDirty()
 * for the same reason PhysicsLayers.js's setLayerName() does (see that
 * file's doc comment). replaceAllTagNames() deliberately does NOT: it's
 * the bulk load path (project open/import/restore), and marking dirty
 * there would wrongly flag a just-loaded, unedited project as having
 * unsaved changes.
 *
 * EDITOR-ONLY FILE.
 */

import { markDirty } from "./EditorState.js";

const STORAGE_KEY = "realot_object_tags";
const DEFAULT_TAGS = ["Untagged", "Player", "Enemy"];
let _sessionCache = null;

function _defaults() {
  return DEFAULT_TAGS.slice();
}

/** Public counterpart to _defaults() — used by ProjectStorage.js to reset
 *  the tag registry to a clean slate when opening a project that has no
 *  saved snapshot yet, so it never inherits another project's custom
 *  tags left over in this same browser's shared localStorage key. */
export function getDefaultTagNames() {
  return _defaults();
}

export function getTagNames() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const names = parsed.filter((tag) => typeof tag === "string" && tag.trim());
        return [...new Set(["Untagged", ...names])];
      }
    }
  } catch (_) {
    // Keep the in-memory registry usable in restricted preview frames.
  }
  return _sessionCache ? _sessionCache.slice() : _defaults();
}

export function addTag(tag) {
  const name = String(tag == null ? "" : tag).trim();
  if (!name) return null;
  const names = getTagNames();
  if (!names.includes(name)) names.push(name);
  _sessionCache = names;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch (_) {}
  markDirty();
  return name;
}

/**
 * Remove a custom tag from the project tag list.
 * "Untagged" cannot be removed — every entity needs a valid fallback
 * tag to fall back to. "Player" and "Enemy" are just pre-seeded
 * defaults (see DEFAULT_TAGS above), not special — deletable like any
 * other tag. Entities that already have this tag keep their current
 * tag value — it just disappears from the dropdown.
 * @param {string} tag
 */
export function deleteTag(tag) {
  const name = String(tag == null ? "" : tag).trim();
  if (!name || name === "Untagged") return;
  const names = getTagNames().filter((t) => t !== name);
  _sessionCache = names;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch (_) {}
  markDirty();
}

/**
 * Replaces the ENTIRE tag list in one write — the bulk counterpart to
 * addTag()/deleteTag() used by project load (see ProjectStorage.js and
 * ProjectIO.js) so restoring a saved project's tags is one write
 * instead of many, and so switching between two different projects
 * never leaves one project's custom tags bleeding into another's
 * dropdown. Always keeps "Untagged" present, same guarantee
 * getTagNames() gives every other caller.
 * @param {string[]} names
 */
export function replaceAllTagNames(names) {
  const list = Array.isArray(names) ? names : [];
  const cleaned = list.filter((tag) => typeof tag === "string" && tag.trim());
  const merged = [...new Set(["Untagged", ...cleaned])];
  _sessionCache = merged;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch (_) {}
}
