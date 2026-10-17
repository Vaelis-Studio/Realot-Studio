/**
 * editor/state/NavAreas.js
 *
 * Dynamic navigation-area name registry — same slot-based design as
 * PhysicsLayers.js's 16 named physics layers, applied to NavWorld2D
 * cell areas instead (Ground, Water, Mud, Road, EnemyOnly, PlayerOnly,
 * ...). A NavAgent2D's `area` field is a bitmask of which of these
 * slots it may path through — see components/NavAgent2D.js and
 * components/NavWorld2D.js's NAV_AREA_COUNT/navCellArea.
 *
 * There are always NAV_AREA_COUNT fixed slot indices (0-15). Each slot
 * can either have a name (the area is "active" and appears in Nav tool
 * dropdowns/Inspector checklists) or be empty (unused).
 *
 * Rules mirror PhysicsLayers.js exactly:
 *   - Slot 0 is always "Ground"; its name can be changed but the slot
 *     cannot be cleared to empty.
 *   - Any other slot can be named or cleared freely.
 *   - Area numbers (0-15) are what NavWorld2D cell data and
 *     NavAgent2D.area actually use; names are editor-only labels.
 *
 * Persistence: stored as a JSON array of 16 strings in localStorage.
 * Empty string = unused slot.
 *
 * Area names are bundled into the project snapshot the same way
 * PhysicsLayers.js's layer names are — setNavAreaName() below calls
 * markDirty() for the same reason; see PhysicsLayers.js's doc comment
 * for the full reasoning, including why replaceAllNavAreaNames() (the
 * bulk load path) deliberately does NOT.
 *
 * EDITOR-ONLY FILE.
 */

import { NAV_AREA_COUNT } from "../../runtime/components/NavWorld2D.js";
import { markDirty } from "./EditorState.js";

const STORAGE_KEY = "realot_nav_areas";

/** Returns the default NAV_AREA_COUNT-element name array. Pre-seeded
 *  with just the two most common areas (Ground/Water) so a new
 *  project's Area Costs list starts small and uncluttered — the other
 *  14 slots stay empty/unused until the user names them via Edit ->
 *  Nav Areas..., same as any other unused slot. */
function _defaults() {
  const names = ["Ground", "Water"];
  return Array.from({ length: NAV_AREA_COUNT }, (_, i) => names[i] || "");
}

/** Public counterpart to _defaults() — used by ProjectStorage.js to reset
 *  the area registry to a clean slate when opening a project that has
 *  no saved snapshot yet. */
export function getDefaultNavAreaNames() {
  return _defaults();
}

/**
 * Load the full NAV_AREA_COUNT-name array from localStorage.
 * Always returns a well-formed array of exactly NAV_AREA_COUNT strings.
 * @returns {string[]}
 */
export function getNavAreaNames() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const names = Array.from({ length: NAV_AREA_COUNT }, (_, i) =>
          typeof arr[i] === "string" ? arr[i] : ""
        );
        if (!names[0].trim()) names[0] = "Ground";
        return names;
      }
    }
  } catch (_) {
    // localStorage unavailable/blocked (sandboxed preview iframes). Fall
    // back to the in-memory session cache so renaming still works for
    // the rest of this session even though it won't survive reload.
    if (_sessionCache) return _sessionCache;
  }
  return _sessionCache || _defaults();
}

/**
 * Set the name of a specific area slot and persist.
 * Clearing slot 0 is ignored (it will stay "Ground").
 * @param {number} index 0-(NAV_AREA_COUNT-1)
 * @param {string} name
 */
export function setNavAreaName(index, name) {
  if (index < 0 || index >= NAV_AREA_COUNT) return;
  const names = getNavAreaNames();
  const trimmed = name.trim();
  if (index === 0 && !trimmed) return; // slot 0 can't be cleared
  names[index] = trimmed;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch (_) { /* ignore: storage unavailable in this environment */ }
  _sessionCache = names;
  markDirty();
}

let _sessionCache = null;

/**
 * Returns only the named (non-empty) areas as { index, name } objects,
 * sorted by index. Useful for the Nav tool's area picker and
 * NavAgent2D's Inspector area checklist.
 * @returns {{ index: number, name: string }[]}
 */
export function getNamedNavAreas() {
  return getNavAreaNames()
    .map((name, index) => ({ index, name }))
    .filter(({ name }) => name.trim() !== "");
}

/**
 * Replaces the entire NAV_AREA_COUNT-slot area name array in one write —
 * the bulk counterpart to setNavAreaName() used by project import. See
 * PhysicsLayers.js's replaceAllLayerNames() for the identical reasoning.
 * @param {string[]} names
 */
export function replaceAllNavAreaNames(names) {
  const normalized = Array.from({ length: NAV_AREA_COUNT }, (_, i) =>
    typeof names[i] === "string" ? names[i] : ""
  );
  if (!normalized[0].trim()) normalized[0] = "Ground";
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch (_) { /* ignore: storage unavailable in this environment */ }
  _sessionCache = normalized;
}
