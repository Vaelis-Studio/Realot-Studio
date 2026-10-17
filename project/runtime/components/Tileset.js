/**
 * runtime/components/Tileset.js
 *
 * Plain data describing an authored autotile tileset: a named set of
 * "roles" each mapped to a spriteKey, plus tile size in pixels.
 *
 * Authoring model (the editor's TilesetPanel.js): the user either
 * imports ONE image and it's auto-sliced into a 4x4 grid, or imports up
 * to 16 separate images and drags each into a role slot — and can drag
 * between slots afterward to reassign. Either way, the END RESULT
 * stored here is identical: sixteen independent spriteKeys keyed by
 * role name. Runtime code (TilemapSystem.js) never knows or cares
 * which authoring path produced them.
 *
 * Painting-time tile selection is NOT decided here — that's
 * TilemapSystem.js's job, using AutoTileRules.js to turn "which of my 4
 * orthogonal neighbors are filled" into one of these 16 roles (Unity
 * Rule Tile style: matched by neighbor bitmask, not drawn by hand
 * per-cell). This keeps the same separation of concerns as
 * SpriteRenderer (data) vs RenderSystem (behavior) — see RULES.txt #4.
 *
 * RUNTIME-ONLY FILE.
 */

export const TILESET = "Tileset";

/**
 * The 16 canonical autotile roles, arranged as the editor's 4x4
 * authoring grid (row-major, top-left to bottom-right):
 *
 *   CORNER_TL  EDGE_T    CORNER_TR  STUB_T
 *   EDGE_L     CENTER    EDGE_R     LINE_V
 *   CORNER_BL  EDGE_B    CORNER_BR  STUB_B
 *   STUB_L     LINE_H    STUB_R     SINGLE
 *
 * The top-left 3x3 is the classic 9-slice (4 corners, 4 edges, 1
 * center). The right column adds the vertical-oriented end tiles
 * (STUB_T / LINE_V / STUB_B), the bottom row adds the horizontal-
 * oriented end tiles (STUB_L / LINE_H / STUB_R), and the bottom-right
 * corner is SINGLE — an isolated tile with no neighbors.
 *
 * CENTER is used whenever all 4 orthogonal neighbors are filled (a tile
 * fully surrounded). Each EDGE_* role is used when that one side is
 * "open" (no matching neighbor) with the other three sides filled.
 * Each CORNER_* role is used for an outward-facing corner (two adjacent
 * open sides). LINE_V / LINE_H cover straight 1-wide strips (two
 * opposite neighbors filled), STUB_* are line end-caps (one neighbor
 * filled), and SINGLE is an isolated tile (no neighbors). This 16-role
 * set is a complete bijection over all 16 orthogonal-neighbor bitmasks,
 * so AutoTileRules.js maps each mask to exactly one role with no
 * fallback.
 */
export const TileRole = Object.freeze({
  CORNER_TL: "cornerTL",
  EDGE_T: "edgeT",
  CORNER_TR: "cornerTR",
  EDGE_L: "edgeL",
  CENTER: "center",
  EDGE_R: "edgeR",
  CORNER_BL: "cornerBL",
  EDGE_B: "edgeB",
  CORNER_BR: "cornerBR",
  STUB_T: "stubT",
  LINE_V: "lineV",
  STUB_B: "stubB",
  STUB_L: "stubL",
  LINE_H: "lineH",
  STUB_R: "stubR",
  SINGLE: "single",
});

/** Row-major role order — the exact order the 4x4 authoring grid and a
 *  single-image auto-slice both use, so slot index <-> role name is
 *  always this one fixed mapping everywhere in the codebase. */
export const TILE_ROLE_ORDER = [
  TileRole.CORNER_TL, TileRole.EDGE_T, TileRole.CORNER_TR, TileRole.STUB_T,
  TileRole.EDGE_L, TileRole.CENTER, TileRole.EDGE_R, TileRole.LINE_V,
  TileRole.CORNER_BL, TileRole.EDGE_B, TileRole.CORNER_BR, TileRole.STUB_B,
  TileRole.STUB_L, TileRole.LINE_H, TileRole.STUB_R, TileRole.SINGLE,
];

export class Tileset {
  constructor({
    name = "New Tileset",
    tileWidth = 32,
    tileHeight = 32,
    /** @type {Record<string, string|null>} role name -> spriteKey (or
     *  null if that slot hasn't been filled in yet). Always has all 16
     *  TILE_ROLE_ORDER keys present (missing ones default to null) so
     *  every consumer can do `slots[role]` without an existence check. */
    slots = {},
  } = {}) {
    this.name = name;
    this.tileWidth = tileWidth;
    this.tileHeight = tileHeight;

    this.slots = {};
    for (const role of TILE_ROLE_ORDER) {
      this.slots[role] = slots[role] !== undefined ? slots[role] : null;
    }
  }
}
