/**
 * runtime/systems/TilemapSystem.js
 *
 * Renders every Tilemap entity: for each painted cell, computes its
 * orthogonal-neighbor bitmask against the SAME tilemap's other painted
 * cells, resolves that to a Tileset role via AutoTileRules.js, and
 * draws the corresponding tile sprite at that cell's world position.
 *
 * This is a second PIXI-touching system alongside RenderSystem.js —
 * NOT a second general-purpose rendering path (RULES.txt #5 says
 * "extend RenderSystem.js or add a new System alongside it"); Tilemap
 * rendering is intentionally kept separate from RenderSystem's
 * per-entity single-sprite model because a tilemap entity draws
 * potentially hundreds of tile sprites from ONE entity's data, which is
 * a different enough shape of problem (grid of children keyed by
 * "col,row", rebuilt incrementally as cells are painted/erased) to
 * deserve its own tracked-children bookkeeping rather than being
 * shoehorned into RenderSystem's one-sprite-per-entity Map.
 *
 * Used by both the editor's viewport and the standalone player (both
 * go through runtime/index.js's createGame()), so a tilemap painted in
 * the editor renders identically in the shipped game.
 *
 * RUNTIME-ONLY FILE (depends on PIXI, not on the editor).
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { TILEMAP, cellKey, parseCellKey } from "../components/Tilemap.js";
import { TILESET } from "../components/Tileset.js";
import { resolveTexture } from "../assets/AssetManager.js";
import { computeNeighborMask, resolveRoleForNeighborMask } from "./AutoTileRules.js";

export class TilemapSystem extends System {
  /**
   * @param {PIXI.Container} worldContainer same container RenderSystem
   *   draws sprites into, so tilemaps sit in the same world space and
   *   pan/zoom/camera-follow exactly like every other entity.
   */
  constructor(worldContainer) {
    super();
    this.worldContainer = worldContainer;
    /** @type {Map<string, PIXI.Container>} tilemap entityId -> its own
     *  child container holding that tilemap's tile sprites */
    this._layers = new Map();
    /** @type {Map<string, Map<string, PIXI.Sprite>>} tilemap entityId ->
     *  (cellKey -> tile sprite) */
    this._tileSprites = new Map();
  }

  update(world) {
    const entities = world.query(TRANSFORM, TILEMAP);
    const seenEntities = new Set();

    for (const entity of entities) {
      seenEntities.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const tilemap = entity.getComponent(TILEMAP);

      let layer = this._layers.get(entity.id);
      if (!layer) {
        layer = new PIXI.Container();
        this.worldContainer.addChild(layer);
        this._layers.set(entity.id, layer);
        this._tileSprites.set(entity.id, new Map());
      }
      layer.x = transform.x;
      layer.y = transform.y;
      layer.zIndex = transform.z;

      const tilesetEntity = tilemap.tilesetEntityId ? world.getEntity(tilemap.tilesetEntityId) : null;
      const tileset = tilesetEntity ? tilesetEntity.getComponent(TILESET) : null;
      const tileSprites = this._tileSprites.get(entity.id);

      if (!tileset) {
        // No tileset assigned yet — nothing to draw, but keep any
        // existing sprites cleared so an entity that HAD a tileset
        // unassigned doesn't leave stale tiles on screen.
        this._clearAllTiles(layer, tileSprites);
        continue;
      }

      const filledCellKeys = new Set(Object.keys(tilemap.cells));
      const seenCells = new Set();

      for (const key of filledCellKeys) {
        seenCells.add(key);
        const { col, row } = parseCellKey(key);
        const mask = computeNeighborMask(col, row, filledCellKeys, cellKey);
        const role = resolveRoleForNeighborMask(mask);
        const spriteKey = tileset.slots[role];

        let sprite = tileSprites.get(key);
        if (!sprite) {
          sprite = new PIXI.Sprite();
          sprite.anchor.set(0.5);
          layer.addChild(sprite);
          tileSprites.set(key, sprite);
        }

        sprite.texture = resolveTexture(spriteKey);
        sprite.x = (col + 0.5) * tileset.tileWidth;
        sprite.y = (row + 0.5) * tileset.tileHeight;
        sprite.width = tileset.tileWidth;
        sprite.height = tileset.tileHeight;
      }

      // Remove sprites for cells that were erased since last update.
      for (const [key, sprite] of tileSprites) {
        if (!seenCells.has(key)) {
          layer.removeChild(sprite);
          sprite.destroy();
          tileSprites.delete(key);
        }
      }
    }

    // Remove whole layers for tilemap entities that no longer exist.
    for (const [entityId, layer] of this._layers) {
      if (!seenEntities.has(entityId)) {
        this.worldContainer.removeChild(layer);
        layer.destroy({ children: true });
        this._layers.delete(entityId);
        this._tileSprites.delete(entityId);
      }
    }
  }

  _clearAllTiles(layer, tileSprites) {
    for (const sprite of tileSprites.values()) {
      layer.removeChild(sprite);
      sprite.destroy();
    }
    tileSprites.clear();
  }

  destroy() {
    for (const [entityId, layer] of this._layers) {
      layer.destroy({ children: true });
      this.worldContainer.removeChild(layer);
    }
    this._layers.clear();
    this._tileSprites.clear();
  }
}
