import { Collider2D, ColliderShape } from "../../runtime/components/Collider2D.js";
import { clearNavCellArea, clearNavCellOverride, invalidateNavWorldRuntime, setNavCellArea, setNavCellOverride } from "../../runtime/components/NavWorld2D.js";
import { SpriteAnimation } from "../../runtime/components/SpriteAnimation.js";
import { cellKey } from "../../runtime/components/Tilemap.js";
import { TILE_ROLE_ORDER } from "../../runtime/components/Tileset.js";
import { getSpriteAsset } from "../../runtime/assets/AssetRegistry.js";
import { getNavAreaNames, setNavAreaName } from "../state/NavAreas.js";
import { getLayerNames, setLayerName } from "../state/PhysicsLayers.js";
import { createEmptyClip } from "../panels/AnimationWindow.js";
import { editorState, markDirty, pushLog } from "../state/EditorState.js";
import { snapshotNow } from "../state/UndoManager.js";

const MAX_EDIT_CELLS = 5000;

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function world() {
  if (!editorState.world) throw new Error("Open a Realot project in the editor first.");
  return editorState.world;
}

function entity(id) {
  if (typeof id !== "string" || !id.trim()) throw new Error("entity_id is required.");
  const found = world().getEntity(id);
  if (!found) throw new Error("No entity with id '" + id + "' in the active scene.");
  return found;
}

function changed(message) {
  markDirty();
  pushLog("log", "MCP: " + message);
  if (typeof editorState.renderFn === "function") editorState.renderFn();
}

function selectEntity(target) {
  editorState.selectedId = target.id;
  editorState.selectedIds = [target.id];
}

function validCell(cell) {
  return cell && Number.isInteger(cell.col) && Number.isInteger(cell.row) &&
    Math.abs(cell.col) <= 1_000_000 && Math.abs(cell.row) <= 1_000_000;
}

function cellsInput(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_EDIT_CELLS) {
    throw new Error("cells must contain between 1 and " + MAX_EDIT_CELLS + " grid coordinates.");
  }
  if (value.some((cell) => !validCell(cell))) throw new Error("Each cell needs integer col and row values within ±1,000,000.");
  return value;
}

function animationFor(entityId, clipId) {
  const target = entity(entityId);
  const animation = target.getComponent("SpriteAnimation");
  if (!animation) throw new Error("Entity '" + target.name + "' has no SpriteAnimation component.");
  const clip = animation.clips.find((item) => item.id === clipId);
  if (!clip) throw new Error("Animation clip not found. Call list_animations to see valid clip ids.");
  return { target, animation, clip };
}

function uniqueClipName(animation, requested) {
  let name;
  if (requested !== undefined && typeof requested !== "string") throw new Error("name must be a string.");
  if (typeof requested === "string" && requested.trim()) {
    if (requested.length > 120) throw new Error("name must be 120 characters or fewer.");
    name = requested.trim();
  } else {
    name = "New Animation";
    let suffix = 1;
    while (animation.clips.some((clip) => clip.name.toLowerCase() === name.toLowerCase())) {
      suffix++;
      name = "New Animation " + suffix;
    }
  }
  if (animation.clips.some((clip) => clip.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("A clip named '" + name + "' already exists on this entity.");
  }
  return name;
}

function assetInfo(key) {
  if (!key) return null;
  const asset = getSpriteAsset(key);
  return asset ? { key: asset.key, name: asset.name } : { key, missing: true };
}

function panelOpen(panel, params) {
  if (panel === "animation") {
    const target = entity(params.entity_id);
    const animation = target.getComponent("SpriteAnimation");
    const clip = animation && (
      (params.clip_id && animation.clips.find((item) => item.id === params.clip_id)) ||
      animation.clips.find((item) => item.id === editorState.anim.editingClipId) ||
      animation.clips.find((item) => item.id === animation.currentClipId) ||
      animation.clips[0]
    );
    if (params.clip_id && !clip) throw new Error("clip_id does not belong to this entity.");
    selectEntity(target);
    editorState.animOpen = true;
    editorState.anim.previewPlaying = false;
    editorState.anim.editingClipId = clip ? clip.id : null;
    if (!clip) editorState.anim.previewFrameIndex = 0;
    if (typeof editorState.renderFn === "function") editorState.renderFn();
    return text({ opened: true, panel, entityId: target.id, clipId: clip ? clip.id : null, hasAnimation: !!animation });
  }
  if (panel === "tileset") {
    const target = entity(params.entity_id);
    const tileset = target.getComponent("Tileset");
    if (!tileset) throw new Error("entity_id must identify an entity with a Tileset component.");
    selectEntity(target);
    editorState.tilesetPanel.open = true;
    editorState.tilesetPanel.entityId = target.id;
    editorState.tilesetPanel.draggingRole = null;
  } else if (panel === "physics_layers") {
    editorState.physicsLayersOpen = true;
  } else if (panel === "navigation_areas") {
    editorState.navAreasOpen = true;
  } else {
    throw new Error("panel must be animation, tileset, physics_layers, or navigation_areas.");
  }
  if (typeof editorState.renderFn === "function") editorState.renderFn();
  return text({ opened: true, panel, entityId: params.entity_id || null });
}

function listAnimations() {
  return text({
    animations: world().getAllEntities().flatMap((target) => {
      const animation = target.getComponent("SpriteAnimation");
      if (!animation) return [];
      return [{
        entityId: target.id,
        entityName: target.name,
        currentClipId: animation.currentClipId || null,
        clips: animation.clips.map((clip) => ({
          id: clip.id,
          name: clip.name,
          fps: clip.fps,
          loop: clip.loop,
          frameCount: clip.frames.length,
          frames: clip.frames.map((frame) => ({ spriteKey: frame.spriteKey, sourceAssetKey: frame.sourceAssetKey || null })),
        })),
      }];
    }),
  });
}

function updateAnimationClip(params) {
  const { target, animation, clip } = animationFor(params.entity_id, params.clip_id);
  const fields = params.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) {
    throw new Error("fields must be a non-empty object.");
  }
  const allowed = new Set(["name", "fps", "loop", "collider_override"]);
  const unknown = Object.keys(fields).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error("Unsupported clip field(s): " + unknown.join(", "));
  const next = { ...fields };
  if (next.name !== undefined) {
    if (typeof next.name !== "string" || !next.name.trim() || next.name.length > 120) throw new Error("name must be between 1 and 120 characters.");
    if (animation.clips.some((other) => other.id !== clip.id && other.name.toLowerCase() === next.name.trim().toLowerCase())) {
      throw new Error("Another clip on this entity already has that name.");
    }
    next.name = next.name.trim();
  }
  if (next.fps !== undefined && (!Number.isFinite(next.fps) || next.fps < 0.1 || next.fps > 120)) {
    throw new Error("fps must be between 0.1 and 120.");
  }
  if (next.loop !== undefined && typeof next.loop !== "boolean") throw new Error("loop must be true or false.");
  if (next.collider_override !== undefined) {
    if (next.collider_override === null) {
      next.colliderOverride = null;
    } else {
      const override = next.collider_override;
      if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error("collider_override must be an object or null.");
      const defaults = new Collider2D();
      const unknownFields = Object.keys(override).filter((key) => !(key in defaults));
      if (unknownFields.length) throw new Error("Unknown collider override field(s): " + unknownFields.join(", "));
      for (const [key, value] of Object.entries(override)) {
        const defaultValue = defaults[key];
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Prohibited collider override property: " + key);
        if (typeof defaultValue === "number" && (!Number.isFinite(value) || Math.abs(value) > 1_000_000)) {
          throw new Error("collider_override." + key + " must be a finite number.");
        }
        if (typeof defaultValue === "boolean" && typeof value !== "boolean") throw new Error("collider_override." + key + " must be true or false.");
        if (key === "shape" && !Object.values(ColliderShape).includes(value)) throw new Error("collider_override.shape is not a supported collider shape.");
        if (key === "trianglePoints") {
          if (!Array.isArray(value) || value.length !== 3 || value.some((point) =>
            !point || typeof point !== "object" || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
            throw new Error("collider_override.trianglePoints must contain exactly three finite {x, y} points.");
          }
        }
      }
      next.colliderOverride = JSON.parse(JSON.stringify({ ...defaults, ...override }));
    }
    delete next.collider_override;
  }
  snapshotNow("anim");
  Object.assign(clip, next);
  if (editorState.anim.editingClipId === clip.id) editorState.anim.previewPlaying = false;
  changed("updated animation clip '" + clip.name + "' on '" + target.name + "'");
  return text({ entityId: target.id, clip: { ...clip } });
}

function listTilesets() {
  return text({
    tilesets: world().getAllEntities().flatMap((target) => {
      const tileset = target.getComponent("Tileset");
      if (!tileset) return [];
      return [{
        entityId: target.id,
        name: tileset.name,
        tileWidth: tileset.tileWidth,
        tileHeight: tileset.tileHeight,
        roles: TILE_ROLE_ORDER.map((role) => ({ role, sprite: assetInfo(tileset.slots[role]) })),
      }];
    }),
  });
}

function updateTileset(params) {
  const target = entity(params.entity_id);
  const tileset = target.getComponent("Tileset");
  if (!tileset) throw new Error("Entity has no Tileset component.");
  const patch = params.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) {
    throw new Error("patch must be a non-empty object.");
  }
  const allowed = new Set(["name", "tileWidth", "tileHeight", "slots"]);
  const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error("Unsupported Tileset field(s): " + unknown.join(", "));
  if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 120)) {
    throw new Error("name must be between 1 and 120 characters.");
  }
  for (const key of ["tileWidth", "tileHeight"]) {
    if (patch[key] !== undefined && (!Number.isInteger(patch[key]) || patch[key] < 1 || patch[key] > 4096)) {
      throw new Error(key + " must be an integer from 1 to 4096.");
    }
  }
  const slots = patch.slots;
  if (slots !== undefined) {
    if (!slots || typeof slots !== "object" || Array.isArray(slots)) throw new Error("slots must map tile roles to sprite keys or null.");
    for (const [role, key] of Object.entries(slots)) {
      if (!TILE_ROLE_ORDER.includes(role)) throw new Error("Unknown tile role '" + role + "'.");
      if (key !== null && (typeof key !== "string" || !getSpriteAsset(key))) throw new Error("slots." + role + " must be an existing sprite key or null.");
    }
  }
  snapshotNow("scene");
  if (patch.name !== undefined) tileset.name = patch.name.trim();
  if (patch.tileWidth !== undefined) tileset.tileWidth = patch.tileWidth;
  if (patch.tileHeight !== undefined) tileset.tileHeight = patch.tileHeight;
  if (slots) Object.assign(tileset.slots, slots);
  changed("updated Tileset '" + tileset.name + "'");
  return text({ entityId: target.id, tileset: { name: tileset.name, tileWidth: tileset.tileWidth, tileHeight: tileset.tileHeight, slots: { ...tileset.slots } } });
}

function listTilemaps() {
  return text({
    tilemaps: world().getAllEntities().flatMap((target) => {
      const tilemap = target.getComponent("Tilemap");
      if (!tilemap) return [];
      const cellKeys = Object.keys(tilemap.cells);
      return [{
        entityId: target.id,
        name: target.name,
        tilesetEntityId: tilemap.tilesetEntityId || null,
        cellCount: cellKeys.length,
        cells: cellKeys.slice(0, 500),
        truncated: cellKeys.length > 500,
      }];
    }),
  });
}

function paintTilemap(params) {
  const target = entity(params.entity_id);
  const tilemap = target.getComponent("Tilemap");
  if (!tilemap) throw new Error("Entity has no Tilemap component.");
  if (params.mode !== "paint" && params.mode !== "erase") throw new Error("mode must be paint or erase.");
  const cells = cellsInput(params.cells);
  snapshotNow("scene");
  for (const cell of cells) {
    const key = cellKey(cell.col, cell.row);
    if (params.mode === "paint") tilemap.cells[key] = true;
    else delete tilemap.cells[key];
  }
  selectEntity(target);
  editorState.activeTool = params.mode === "paint" ? "tile" : "erase";
  changed(params.mode + "ed " + cells.length + " tilemap cell(s) on '" + target.name + "'");
  return text({ entityId: target.id, mode: params.mode, cellsChanged: cells.length, cellCount: Object.keys(tilemap.cells).length });
}

function listNavigationWorlds() {
  return text({
    worlds: world().getAllEntities().flatMap((target) => {
      const nav = target.getComponent("NavWorld2D");
      if (!nav) return [];
      const walkableCells = Object.values(nav.cells).filter(Boolean).length;
      const areaCounts = {};
      for (const index of Object.values(nav.cellAreas)) areaCounts[index] = (areaCounts[index] || 0) + 1;
      return [{
        entityId: target.id,
        name: target.name,
        bounds: { x: nav.boundsX, y: nav.boundsY, width: nav.boundsWidth, height: nav.boundsHeight },
        cellSize: nav.cellSize,
        minObstacleFootprint: nav.minObstacleFootprint,
        allowDiagonal: nav.allowDiagonal,
        dynamic: nav.dynamic,
        walkableCellCount: walkableCells,
        paintedCellCount: Object.keys(nav.paintOverrides).length,
        areaCounts,
      }];
    }),
  });
}

function paintNavigationCells(params) {
  const target = entity(params.entity_id);
  const nav = target.getComponent("NavWorld2D");
  if (!nav) throw new Error("Entity has no NavWorld2D component.");
  const modes = new Set(["walkable", "blocked", "erase_walkability", "area", "clear_area"]);
  if (!modes.has(params.mode)) throw new Error("mode must be walkable, blocked, erase_walkability, area, or clear_area.");
  const cells = cellsInput(params.cells);
  if (params.mode === "area" && (!Number.isInteger(params.area_index) || params.area_index < 0 || params.area_index > 15)) {
    throw new Error("area_index must be an integer from 0 to 15.");
  }
  snapshotNow("scene");
  let changedCount = 0;
  for (const cell of cells) {
    let didChange = false;
    if (params.mode === "walkable") didChange = setNavCellOverride(nav, cell.col, cell.row, true);
    else if (params.mode === "blocked") didChange = setNavCellOverride(nav, cell.col, cell.row, false);
    else if (params.mode === "erase_walkability") didChange = clearNavCellOverride(nav, cell.col, cell.row);
    else if (params.mode === "area") didChange = setNavCellArea(nav, cell.col, cell.row, params.area_index);
    else didChange = clearNavCellArea(nav, cell.col, cell.row);
    if (didChange) changedCount++;
  }
  selectEntity(target);
  editorState.showNavWorld = true;
  editorState.activeTool = params.mode === "area" || params.mode === "clear_area" ? "nav-area" : params.mode === "blocked" ? "nav-block" : "nav";
  changed("edited " + changedCount + " navigation cell(s) on '" + target.name + "'");
  return text({ entityId: target.id, mode: params.mode, cellsChanged: changedCount });
}

function updateNavigationWorld(params) {
  const target = entity(params.entity_id);
  const nav = target.getComponent("NavWorld2D");
  if (!nav) throw new Error("Entity has no NavWorld2D component.");
  const patch = params.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) {
    throw new Error("patch must be a non-empty object.");
  }
  const allowed = new Set(["boundsX", "boundsY", "boundsWidth", "boundsHeight", "cellSize", "minObstacleFootprint", "allowDiagonal", "dynamic", "areaCosts"]);
  const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error("Unsupported NavWorld2D field(s): " + unknown.join(", "));
  for (const key of ["boundsX", "boundsY"]) {
    if (patch[key] !== undefined && (!Number.isFinite(patch[key]) || Math.abs(patch[key]) > 10_000_000)) throw new Error(key + " must be a finite world coordinate.");
  }
  for (const key of ["boundsWidth", "boundsHeight", "cellSize"]) {
    if (patch[key] !== undefined && (!Number.isFinite(patch[key]) || patch[key] <= 0 || patch[key] > 1_000_000)) throw new Error(key + " must be greater than 0 and no greater than 1,000,000.");
  }
  if (patch.minObstacleFootprint !== undefined && (!Number.isFinite(patch.minObstacleFootprint) || patch.minObstacleFootprint < 0 || patch.minObstacleFootprint > 1_000_000)) {
    throw new Error("minObstacleFootprint must be between 0 and 1,000,000.");
  }
  for (const key of ["allowDiagonal", "dynamic"]) if (patch[key] !== undefined && typeof patch[key] !== "boolean") throw new Error(key + " must be true or false.");
  if (patch.areaCosts !== undefined && (!Array.isArray(patch.areaCosts) || patch.areaCosts.length !== 16 ||
    patch.areaCosts.some((cost) => !Number.isFinite(cost) || cost < 0.01 || cost > 10_000))) {
    throw new Error("areaCosts must contain exactly 16 finite values from 0.01 to 10,000.");
  }
  snapshotNow("scene");
  Object.assign(nav, patch);
  invalidateNavWorldRuntime(nav);
  selectEntity(target);
  editorState.showNavWorld = true;
  changed("updated navigation world '" + target.name + "'");
  return text({ entityId: target.id, navWorld: { boundsX: nav.boundsX, boundsY: nav.boundsY, boundsWidth: nav.boundsWidth, boundsHeight: nav.boundsHeight, cellSize: nav.cellSize, minObstacleFootprint: nav.minObstacleFootprint, allowDiagonal: nav.allowDiagonal, dynamic: nav.dynamic, areaCosts: nav.areaCosts } });
}

export async function runMcpEditorTool(name, params = {}) {
  switch (name) {
    case "list_animations":
      return listAnimations();
    case "open_editor_panel":
      return panelOpen(params.panel, params);
    case "create_animation_clip": {
      const target = entity(params.entity_id);
      let animation = target.getComponent("SpriteAnimation");
      if (!animation) animation = new SpriteAnimation();
      const nameValue = uniqueClipName(animation, params.name);
      const clip = createEmptyClip(animation.clips.map((item) => item.name));
      clip.name = nameValue;
      if (params.fps !== undefined) {
        if (!Number.isFinite(params.fps) || params.fps < 0.1 || params.fps > 120) throw new Error("fps must be between 0.1 and 120.");
        clip.fps = params.fps;
      }
      if (params.loop !== undefined) {
        if (typeof params.loop !== "boolean") throw new Error("loop must be true or false.");
        clip.loop = params.loop;
      }
      snapshotNow("anim");
      if (!target.hasComponent("SpriteAnimation")) target.addComponent("SpriteAnimation", animation);
      animation.clips.push(clip);
      if (!animation.currentClipId) animation.currentClipId = clip.id;
      selectEntity(target);
      editorState.animOpen = true;
      editorState.anim.editingClipId = clip.id;
      editorState.anim.previewFrameIndex = 0;
      editorState.anim.previewPlaying = false;
      changed("created animation clip '" + clip.name + "' on '" + target.name + "'");
      return text({ entityId: target.id, clip });
    }
    case "update_animation_clip":
      return updateAnimationClip(params);
    case "delete_animation_clip": {
      const { target, animation, clip } = animationFor(params.entity_id, params.clip_id);
      snapshotNow("anim");
      animation.clips = animation.clips.filter((item) => item.id !== clip.id);
      if (animation.currentClipId === clip.id) {
        animation.currentClipId = animation.clips.length ? animation.clips[0].id : null;
        animation.currentFrameIndex = 0;
        animation.frameElapsed = 0;
      }
      if (editorState.anim.editingClipId === clip.id) {
        editorState.anim.editingClipId = animation.clips[0]?.id || null;
        editorState.anim.previewFrameIndex = 0;
        editorState.anim.previewPlaying = false;
      }
      changed("deleted animation clip '" + clip.name + "' from '" + target.name + "'");
      return text({ deleted: true, entityId: target.id, clipId: clip.id, remainingClips: animation.clips.length });
    }
    case "move_animation_frame": {
      const { target, clip } = animationFor(params.entity_id, params.clip_id);
      const from = params.from_index;
      const to = params.to_index;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= clip.frames.length || to < 0 || to >= clip.frames.length) {
        throw new Error("from_index and to_index must refer to existing frame positions.");
      }
      snapshotNow("anim");
      const [frame] = clip.frames.splice(from, 1);
      clip.frames.splice(to, 0, frame);
      if (editorState.anim.editingClipId === clip.id) editorState.anim.previewFrameIndex = to;
      changed("moved frame " + from + " to " + to + " in '" + clip.name + "'");
      return text({ entityId: target.id, clipId: clip.id, frames: clip.frames.map((item) => item.spriteKey) });
    }
    case "delete_animation_frame": {
      const { target, clip } = animationFor(params.entity_id, params.clip_id);
      if (!Number.isInteger(params.frame_index) || params.frame_index < 0 || params.frame_index >= clip.frames.length) {
        throw new Error("frame_index must refer to an existing frame.");
      }
      snapshotNow("anim");
      const [removed] = clip.frames.splice(params.frame_index, 1);
      if (editorState.anim.editingClipId === clip.id && editorState.anim.previewFrameIndex >= clip.frames.length) {
        editorState.anim.previewFrameIndex = Math.max(0, clip.frames.length - 1);
      }
      changed("deleted frame " + params.frame_index + " from '" + clip.name + "'");
      return text({ deleted: true, entityId: target.id, clipId: clip.id, frame: removed, remainingFrames: clip.frames.length });
    }
    case "list_tilesets":
      return listTilesets();
    case "update_tileset":
      return updateTileset(params);
    case "list_tilemaps":
      return listTilemaps();
    case "paint_tilemap":
      return paintTilemap(params);
    case "list_navigation_worlds":
      return listNavigationWorlds();
    case "paint_navigation_cells":
      return paintNavigationCells(params);
    case "update_navigation_world":
      return updateNavigationWorld(params);
    case "list_navigation_areas":
      return text({ areas: getNavAreaNames().map((name, index) => ({ index, name })) });
    case "set_navigation_area_name": {
      if (!Number.isInteger(params.index) || params.index < 0 || params.index > 15) throw new Error("index must be an integer from 0 to 15.");
      if (typeof params.name !== "string" || params.name.length > 80 || (params.index !== 0 && !params.name.trim())) {
        throw new Error("name must be 1 to 80 characters (slot 0 cannot be cleared).");
      }
      setNavAreaName(params.index, params.name);
      changed("renamed navigation area " + params.index);
      return text({ index: params.index, name: getNavAreaNames()[params.index] });
    }
    case "list_physics_layers":
      return text({ layers: getLayerNames().map((name, index) => ({ index, name })) });
    case "set_physics_layer_name": {
      if (!Number.isInteger(params.index) || params.index < 0 || params.index > 15) throw new Error("index must be an integer from 0 to 15.");
      if (typeof params.name !== "string" || params.name.length > 80 || (params.index !== 0 && !params.name.trim())) {
        throw new Error("name must be 1 to 80 characters (slot 0 cannot be cleared).");
      }
      setLayerName(params.index, params.name);
      changed("renamed physics layer " + params.index);
      return text({ index: params.index, name: getLayerNames()[params.index] });
    }
    case "set_collider_layer_filter": {
      const target = entity(params.entity_id);
      const collider = target.getComponent("Collider2D");
      if (!collider) throw new Error("Entity has no Collider2D component.");
      if (!Number.isInteger(params.layer) || params.layer < 0 || params.layer > 15) throw new Error("layer must be an integer from 0 to 15.");
      if (!Array.isArray(params.collides_with) || params.collides_with.some((index) => !Number.isInteger(index) || index < 0 || index > 15)) {
        throw new Error("collides_with must be an array of layer indices from 0 to 15.");
      }
      const unique = [...new Set(params.collides_with)];
      const mask = unique.reduce((value, index) => value | (1 << index), 0);
      snapshotNow("scene");
      collider.layer = params.layer;
      collider.mask = mask;
      changed("updated collision layer filter on '" + target.name + "'");
      return text({
        entityId: target.id,
        layer: { index: collider.layer, name: getLayerNames()[collider.layer] },
        collidesWith: unique.map((index) => ({ index, name: getLayerNames()[index] })),
        mask,
      });
    }
    case "set_editor_tool": {
      const allowed = new Set(["select", "translate", "rotate", "scale", "pan", "tile", "erase", "nav", "nav-block", "nav-area", "path"]);
      if (!allowed.has(params.tool)) throw new Error("Unsupported tool. Valid tools: " + [...allowed].join(", "));
      const target = params.entity_id ? entity(params.entity_id) : null;
      if (params.tool === "tile" && (!target || !target.getComponent("Tilemap"))) throw new Error("tile requires entity_id for an entity with a Tilemap component.");
      if (["nav", "nav-block", "nav-area"].includes(params.tool) && (!target || !target.getComponent("NavWorld2D"))) {
        throw new Error(params.tool + " requires entity_id for an entity with a NavWorld2D component.");
      }
      if (params.tool === "path" && (!target || !target.getComponent("StrokePath"))) throw new Error("path requires entity_id for an entity with a StrokePath component.");
      if (target) selectEntity(target);
      editorState.activeTool = params.tool;
      if (params.tool.startsWith("nav")) editorState.showNavWorld = true;
      if (typeof editorState.renderFn === "function") editorState.renderFn();
      return text({ activeTool: editorState.activeTool, selectedEntityId: editorState.selectedId });
    }
    default:
      return null;
  }
}
