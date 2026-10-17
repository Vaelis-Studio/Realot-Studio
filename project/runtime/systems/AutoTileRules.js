/**
 * runtime/systems/AutoTileRules.js
 *
 * Pure function: given which of a cell's 4 orthogonal neighbors are also
 * filled tiles, decide which of the 16 Tileset roles (see
 * components/Tileset.js) that cell should display. This is the same
 * fundamental idea as Unity's 2D Tilemap Extras "Rule Tile" — the tile
 * that appears is DERIVED from the pattern of surrounding tiles as you
 * paint, not chosen by hand per-cell — using the classic 16-role set
 * (9-slice + 2 lines + 4 end-caps + 1 single) that fully disambiguates
 * every one of the 16 orthogonal-neighbor bitmasks one-to-one with no
 * fallback.
 *
 * Kept as its own file (not inlined into TilemapSystem.js) because it's
 * pure data-in/data-out logic with zero PIXI/World dependency — trivial
 * to unit-test in isolation, and reusable later by an editor-side
 * "preview how this tileset looks" feature without dragging in the
 * whole rendering system.
 *
 * RUNTIME-ONLY FILE (no dependencies at all, in fact — plain JS).
 */

import { TileRole } from "../components/Tileset.js";

// Bit flags for the 4 orthogonal neighbor directions. Only orthogonal
// neighbors are considered (not diagonals) — 4 bits give exactly 16
// masks, which the 16-role tileset covers one-to-one, keeping authoring
// down to a 4x4 grid instead of needing a 47-tile Wang-style set.
export const N = 1 << 0;
export const E = 1 << 1;
export const S = 1 << 2;
export const W = 1 << 3;

/**
 * @param {number} mask bitwise-OR of N/E/S/W for which orthogonal
 *   neighbors are also filled tiles (same tilemap layer)
 * @returns {string} one of the TileRole values
 */
export function resolveRoleForNeighborMask(mask) {
  const n = !!(mask & N);
  const e = !!(mask & E);
  const s = !!(mask & S);
  const w = !!(mask & W);
  const filled = (n ? 1 : 0) + (e ? 1 : 0) + (s ? 1 : 0) + (w ? 1 : 0);

  // 0 neighbors filled: isolated single tile.
  if (filled === 0) return TileRole.SINGLE;

  // 1 neighbor filled: line end-cap (stub). The cap points AWAY from the
  // filled neighbor — e.g. only the north neighbor is filled, so this
  // tile is the BOTTOM end of a vertical run => STUB_B.
  if (filled === 1) {
    if (n) return TileRole.STUB_B;
    if (s) return TileRole.STUB_T;
    if (e) return TileRole.STUB_L;
    if (w) return TileRole.STUB_R;
  }

  // 2 neighbors filled.
  if (filled === 2) {
    // Opposite pair => straight 1-wide strip through this cell.
    if (n && s) return TileRole.LINE_V;
    if (e && w) return TileRole.LINE_H;
    // Adjacent pair => outward corner (the two open sides face outward).
    if (!n && !w && e && s) return TileRole.CORNER_TL;
    if (!n && !e && s && w) return TileRole.CORNER_TR;
    if (!s && !w && n && e) return TileRole.CORNER_BL;
    if (!s && !e && n && w) return TileRole.CORNER_BR;
  }

  // 3 neighbors filled: edge tile facing the one open side.
  if (!n && e && s && w) return TileRole.EDGE_T;
  if (n && !e && s && w) return TileRole.EDGE_R;
  if (n && e && !s && w) return TileRole.EDGE_B;
  if (n && e && s && !w) return TileRole.EDGE_L;

  // 4 neighbors filled: plain interior center tile.
  return TileRole.CENTER;
}

/**
 * Computes the orthogonal-neighbor bitmask for a given cell against a
 * Set of "cellKey" strings (see Tilemap.js's cellKey()) representing
 * every filled cell on the SAME layer. Kept generic over "what counts
 * as filled" via the Set so TilemapSystem can build that set once per
 * update rather than this function needing to know about Tilemap's
 * internal storage shape at all.
 * @param {number} col
 * @param {number} row
 * @param {Set<string>} filledCellKeys
 * @param {(col:number,row:number)=>string} cellKey
 * @returns {number} bitmask of N|E|S|W
 */
export function computeNeighborMask(col, row, filledCellKeys, cellKey) {
  let mask = 0;
  if (filledCellKeys.has(cellKey(col, row - 1))) mask |= N;
  if (filledCellKeys.has(cellKey(col + 1, row))) mask |= E;
  if (filledCellKeys.has(cellKey(col, row + 1))) mask |= S;
  if (filledCellKeys.has(cellKey(col - 1, row))) mask |= W;
  return mask;
}
