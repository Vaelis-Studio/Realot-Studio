/**
 * runtime/components/Tilemap.js
 *
 * Plain data for a painted tile grid on one entity. Holds ONLY which
 * cells are filled (col,row -> true) plus a reference to the Tileset
 * component (by entity id) supplying the actual tile art — no PIXI
 * objects, no per-cell resolved sprite, no autotile decision baked in.
 * Which tile art actually shows at a given cell is computed fresh every
 * update by TilemapSystem.js + AutoTileRules.js from the live neighbor
 * pattern, exactly like Unity's Rule Tile: the DATA here is just "is
 * this cell filled", the tile that's drawn is a derived/computed value,
 * never stored.
 *
 * A Tilemap entity references its Tileset by a separate entity's id
 * (tilesetEntityId) rather than embedding the Tileset inline, so one
 * authored Tileset can be reused by multiple Tilemap entities/layers —
 * same "reference by id, not by copy" relationship Light/ShadowCaster
 * already use elsewhere in this codebase.
 *
 * RUNTIME-ONLY FILE.
 */

export const TILEMAP = "Tilemap";

export class Tilemap {
  constructor({
    /** @type {string|null} entity id of the Tileset-holding entity this
     *  tilemap paints with. null until the user assigns one in the
     *  Inspector. */
    tilesetEntityId = null,
    /** @type {Record<string, true>} sparse map of "col,row" -> true for
     *  every painted cell. Sparse (not a 2D array) because tilemaps are
     *  usually mostly-empty and can extend in any direction from
     *  (0,0), including negative coordinates, with no fixed bounds. */
    cells = {},
  } = {}) {
    this.tilesetEntityId = tilesetEntityId;
    this.cells = { ...cells };
  }
}

/**
 * Canonical string key for a grid cell — the single place this format
 * is defined, so every consumer (TilemapSystem, AutoTileRules,
 * EditorEvents' paint handler) stays in agreement.
 * @param {number} col
 * @param {number} row
 */
export function cellKey(col, row) {
  return col + "," + row;
}

/**
 * @param {string} key produced by cellKey()
 * @returns {{col:number,row:number}}
 */
export function parseCellKey(key) {
  const [col, row] = key.split(",").map(Number);
  return { col, row };
}
