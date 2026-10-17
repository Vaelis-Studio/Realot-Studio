/**
 * Shared Nav API option metadata.
 *
 * This file is intentionally data-only so the runtime ScriptAPI and the
 * editor IntelliSense consume the exact same option definitions. Adding an
 * option here makes its existence visible to both the implementation docs
 * and `{ ... }` completion in the editor.
 */

/**
 * Resolves a named NavWorld2D area (as configured in editor Edit → Nav
 * Areas…) to its 0-15 slot index. `names` is the NAV_AREA_COUNT-length
 * array from editor/state/NavAreas.js's getNavAreaNames(), threaded
 * through to the running game the same way gameFps travels — see
 * PlayWindow.js/play-popup.js and runtime/index.js's createGame().
 *
 * Case-insensitive, trims whitespace. Returns -1 if no slot has that
 * name (including when `names` itself is missing, e.g. a standalone
 * exported build that hasn't wired area names through yet) — callers
 * treat -1 as "no match" the same way Array.indexOf does, rather than
 * throwing, so a typo'd area name degrades to "no bits set" instead of
 * crashing a script.
 *
 * @param {string[]|null|undefined} names
 * @param {string} name
 * @returns {number}
 */
export function resolveNavAreaIndex(names, name) {
  if (!Array.isArray(names) || typeof name !== "string") return -1;
  const target = name.trim().toLowerCase();
  if (!target) return -1;
  for (let i = 0; i < names.length; i++) {
    if (typeof names[i] === "string" && names[i].trim().toLowerCase() === target) return i;
  }
  return -1;
}

/**
 * Turns one or more named areas into the bitmask nav.findPath's `area`
 * option / NavAgent2D.area expects — the named-string counterpart to
 * writing the bitmask by hand, e.g.:
 *   nav.findPath(x1, y1, x2, y2, { area: nav.areaMask("Ground", "Road") })
 * Unknown names are silently skipped (see resolveNavAreaIndex) rather
 * than corrupting the whole mask over one typo; a call with no
 * recognized names returns 0 (nothing allowed), never the "allow
 * everything" default, so a typo fails closed (visibly stuck) instead
 * of silently reverting to unrestricted pathing.
 *
 * @param {string[]|null|undefined} names
 * @param {string[]} areaNames
 * @returns {number}
 */
export function resolveNavAreaMask(names, areaNames) {
  let mask = 0;
  for (const n of areaNames) {
    const idx = resolveNavAreaIndex(names, n);
    if (idx >= 0) mask |= (1 << idx);
  }
  return mask;
}

/**
 * Turns a named cost map into the 16-entry, index-aligned array that
 * nav.findPath's `areaCosts` option / NavAgent2D.areaCosts expect (see
 * NAV_API_OPTION_FIELDS.findPath's `areaCosts` field and
 * components/NavWorld2D.js's getNavAreaCost) — the named-string
 * counterpart to hand-building that array by index, e.g.:
 *   nav.findPath(x1, y1, x2, y2, {
 *     areaCosts: nav.areaCosts({ Water: 3, Mud: 5 })
 *   })
 * Every returned slot is either a finite cost > 0 or null — null means
 * "no override for this slot, fall back to NavWorld2D's own cost",
 * exactly what an unset array entry already means to getNavAreaCost.
 * A name that doesn't resolve (typo) is skipped rather than throwing —
 * that slot just stays null (world default), so a mistyped area name
 * quietly falls back to the world's cost instead of breaking pathing
 * for every other named entry in the same call. A non-finite or <= 0
 * cost value is likewise skipped/left null rather than silently
 * clamped, since a script author who wrote `0` or `-1` almost
 * certainly meant "block this area" — that's what nav.areaMask()
 * (leaving the area out of the mask entirely) is for, not areaCosts.
 *
 * @param {string[]|null|undefined} names
 * @param {Object<string, number>} costsByName
 * @returns {(number|null)[]} length-16 array
 */
export function resolveNavAreaCosts(names, costsByName) {
  const out = new Array(16).fill(null);
  if (!costsByName || typeof costsByName !== "object") return out;
  for (const key of Object.keys(costsByName)) {
    const idx = resolveNavAreaIndex(names, key);
    if (idx < 0) continue;
    const v = Number(costsByName[key]);
    if (Number.isFinite(v) && v > 0) out[idx] = v;
  }
  return out;
}

export const NAV_API_OPTION_FIELDS = Object.freeze({
  findPath: Object.freeze([
    Object.freeze({
      name: "debug",
      type: "boolean",
      defaultValue: false,
      detail: "If true, draws the current path as green debug segments for one frame."
    }),
    Object.freeze({
      name: "radius",
      type: "number",
      defaultValue: 0,
      detail: "Agent clearance in world units against the shared NavWorld2D. 0 uses the base unpadded layer; a larger radius can block narrow passages a smaller agent could use."
    }),
    Object.freeze({
      name: "area",
      type: "number",
      defaultValue: 65535,
      detail: "Bitmask of allowed NavWorld2D area slots (default 0xffff, every area allowed) — same model as Unity's NavMeshAgent.areaMask. A route never crosses a cell outside this mask. Build it from area NAMES (see Edit \u2192 Nav Areas\u2026) with nav.areaMask(\"Ground\", \"Road\") instead of hand-writing bit positions, or look up a single slot with nav.areaIndex(\"Water\")."
    }),
    Object.freeze({
      name: "areaCosts",
      type: "number[]",
      defaultValue: null,
      detail: "Optional per-call override of NavWorld2D's area cost table — a 16-entry array index-aligned with the same area slots as `area` (see editor Edit \u2192 Nav Areas\u2026 for slot names). A finite entry > 0 at a slot overrides the world's cost for that slot for THIS call only; leave a slot null/undefined to fall back to the world's cost for it. Default null uses the shared NavWorld2D costs unchanged — same as omitting this option entirely. this.navMoveToward()/this.navDriveToward() pass their NavAgent2D's own areaCosts automatically. Build it from area NAMES with nav.areaCosts({ Water: 3, Mud: 5 }) instead of hand-building the indexed array."
    }),
  ]),
  navMoveToward: Object.freeze([
    Object.freeze({
      name: "repathInterval",
      type: "number",
      defaultValue: 0.35,
      detail: "Seconds between path re-checks. Lower reacts faster to moving targets; higher is cheaper."
    }),
    Object.freeze({
      name: "arriveDist",
      type: "number",
      defaultValue: 4,
      detail: "Distance in world units at which an intermediate waypoint counts as reached."
    }),
    Object.freeze({
      name: "finalArriveDist",
      type: "number",
      defaultValue: 1,
      detail: "Distance from the exact final target that counts as arrived."
    }),
    Object.freeze({
      name: "targetChangeDistance",
      type: "number",
      defaultValue: 4,
      detail: "Minimum target movement that forces an immediate re-path. Default is max(4, arriveDist)."
    }),
    Object.freeze({
      name: "debug",
      type: "boolean",
      defaultValue: false,
      detail: "If true, draws the current path as green debug segments for one frame."
    }),
  ]),
  navDriveToward: Object.freeze([
    Object.freeze({
      name: "repathInterval",
      type: "number",
      defaultValue: 0.35,
      detail: "Seconds between path re-checks. Lower reacts faster to moving targets; higher is cheaper."
    }),
    Object.freeze({
      name: "arriveDist",
      type: "number",
      defaultValue: 4,
      detail: "Distance in world units at which an intermediate waypoint counts as reached."
    }),
    Object.freeze({
      name: "finalArriveDist",
      type: "number",
      defaultValue: 1,
      detail: "Distance from the exact final target that counts as arrived."
    }),
    Object.freeze({
      name: "targetChangeDistance",
      type: "number",
      defaultValue: 4,
      detail: "Minimum target movement that forces an immediate re-path. Default is max(4, arriveDist)."
    }),
    Object.freeze({
      name: "debug",
      type: "boolean",
      defaultValue: false,
      detail: "If true, draws the current path as green debug segments for one frame."
    }),
  ]),
});
