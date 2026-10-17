/**
 * runtime/prefabs/PrefabRegistry.js
 *
 * Plain-data catalogue of prefabs: { id, name, sceneData, thumbnail },
 * where sceneData is one serialized entity (see
 * SceneSerializer.serializeEntity) — the prefab's own canonical
 * component data — and thumbnail is an optional dataUrl snapshot of
 * the source entity's sprite at creation time (null if it had none).
 * This is what backs the editor's "Prefabs" folder in the Project
 * panel and the drag source for placing prefab instances into a scene.
 *
 * Mirrors AssetRegistry.js's shape/conventions on purpose: a single
 * project-wide Map, shared by every scene, plain JSON only (so it can
 * be listed/rendered by editor UI without pulling in PIXI/Rapier), and
 * saved/restored as part of the whole-project snapshot the exact same
 * way sprites/audio are (see ProjectStorage.js's buildSnapshot()/
 * applySnapshot() and ProjectIO.js's exportProject()/importProject()).
 *
 * WHAT A PREFAB ACTUALLY IS: a template entity's components, nothing
 * else. Creating an instance clones that data onto a brand-new Entity
 * (see instantiatePrefab() below, which reuses SceneSerializer's own
 * instantiateEntity() so a prefab instance round-trips through save/
 * load identically to a hand-placed entity — the ONLY thing that marks
 * an entity as "a prefab instance" at all is its own Entity.prefabId
 * field, see Entity.js). Nested/child entities are NOT supported by
 * this engine's Entity model in the first place (see RULES.txt/
 * Entity.js — entities have no parent/child relationship, only
 * Hierarchy folders, which are a purely cosmetic editor grouping) so a
 * prefab here is always exactly one entity's worth of components, not
 * a multi-entity tree like Unity's.
 *
 * PROPAGATION ("Update Prefab" pushing a change out to every existing
 * instance, in every scene, live scene included) is NOT this file's
 * job — see runtime/prefabs/PrefabPropagation.js for that. This file
 * only owns the catalogue itself (create/read/rename/delete/list) plus
 * turning a catalogue entry into a fresh instance Entity.
 *
 * RUNTIME-ONLY FILE.
 */

import { serializeEntity, instantiateEntity } from "../scene/SceneSerializer.js";
import { getSpriteAsset } from "../assets/AssetRegistry.js";
import { SPRITE_RENDERER } from "../components/SpriteRenderer.js";

/** @type {Map<string, { id: string, name: string, sceneData: object, thumbnail: string|null }>} */
const _prefabs = new Map();

let _nextPrefabId = 1;

/**
 * Creates a new prefab catalogue entry from an existing entity's
 * current component data. The entity itself is NOT modified by this
 * call — callers that want the source entity to also become a linked
 * instance of the new prefab (the normal "Create Prefab" UX) set
 * entity.prefabId themselves afterward; this function only ever
 * creates the catalogue entry.
 * @param {import('../core/Entity.js').Entity} entity
 * @param {string} [name] display name; defaults to the entity's own name
 * @returns {{id:string, name:string, sceneData:object}}
 */
export function createPrefabFromEntity(entity, name) {
  const id = "prefab" + _nextPrefabId++;
  // serializeEntity() already deep-copies component data (object
  // spreads, see SceneSerializer.js), so later live edits to `entity`
  // can never reach back and corrupt this catalogue entry — same
  // "the catalogue owns an independent copy" guarantee AssetRegistry
  // gives sprite/audio records.
  const sceneData = serializeEntity(entity);
  // folderId is a Hierarchy-panel placement detail of the SOURCE
  // entity, not part of what the prefab actually represents — every
  // future instance should default to "not in any folder" rather than
  // inheriting wherever the original happened to be filed.
  sceneData.folderId = null;
  // The prefab's own template data must never itself claim to be
  // "an instance of" anything — if the source entity was ALREADY a
  // linked instance of some other prefab (e.g. "Create Prefab" run on
  // an existing instance to fork a variant), that linkage is a fact
  // about the SOURCE entity, not something a fresh prefab built from
  // its current data should carry forward. Every new instance created
  // from this record gets prefabId/prefabOverrides set explicitly by
  // instantiatePrefab() below instead.
  sceneData.prefabId = null;
  sceneData.prefabOverrides = {};
  // Thumbnail is a one-time snapshot of whatever sprite the source
  // entity was showing at creation time, NOT a live reference — a
  // prefab with no SpriteRenderer (or one whose spriteKey doesn't
  // resolve, e.g. a Light or Collider2D-only entity) simply gets no
  // thumbnail, and the editor falls back to the generic "box" icon for
  // it (see BottomPanel.js's Prefabs folder rendering). Resolved via
  // AssetRegistry's dataUrl the exact same way sprite assets already
  // supply their own thumbnail, so no new image-storage mechanism is
  // needed here.
  const thumbnail = resolveThumbnail(sceneData);
  const record = { id, name: (name || entity.name || "Prefab").trim() || "Prefab", sceneData, thumbnail };
  _prefabs.set(id, record);
  return record;
}

/**
 * Looks up the dataUrl for whatever sprite (if any) a serialized
 * entity's SpriteRenderer component points at. Returns null rather than
 * throwing for entities with no SpriteRenderer, an empty spriteKey, or
 * a spriteKey that no longer resolves to anything in AssetRegistry.
 * @param {object} sceneData
 * @returns {string|null}
 */
export function resolveThumbnail(sceneData) {
  const spriteComp = sceneData.components && sceneData.components[SPRITE_RENDERER];
  const spriteKey = spriteComp && spriteComp.spriteKey;
  if (!spriteKey) return null;
  const asset = getSpriteAsset(spriteKey);
  return asset ? asset.dataUrl : null;
}

export function getPrefab(id) {
  return _prefabs.get(id) || null;
}

export function getAllPrefabs() {
  return Array.from(_prefabs.values());
}

/**
 * Renames a prefab's display name only. Nothing about existing
 * instances changes — same "id is the stable identifier, name is just
 * a label" split as renameSpriteAsset()/renameScene().
 * @param {string} id
 * @param {string} newName
 * @returns {boolean}
 */
export function renamePrefab(id, newName) {
  const trimmed = (newName || "").trim();
  if (!trimmed) return false;
  const record = _prefabs.get(id);
  if (!record) return false;
  record.name = trimmed;
  return true;
}

/**
 * Deletes a prefab from the catalogue. Existing instances are left
 * exactly as they are (same "deleting an asset doesn't touch entities
 * that already reference it" reasoning as deleteSpriteAsset()) — they
 * simply stop being linked to anything: their Entity.prefabId now
 * points at nothing, so "Update Prefab"/propagation silently has
 * nothing to find for them, and the Inspector's Prefab section should
 * treat a dangling prefabId the same as "not a prefab instance" (see
 * getPrefab() returning null for an unknown id).
 * @param {string} id
 * @returns {boolean}
 */
export function deletePrefab(id) {
  return _prefabs.delete(id);
}

/**
 * Creates a brand-new, fully independent Entity in `world` from a
 * prefab's current template data — the "drag a prefab into the scene"
 * action. Reuses SceneSerializer.instantiateEntity() so the new
 * entity is built through the exact same component-hydration path a
 * copy-pasted or loaded-from-disk entity goes through (COMPONENT_
 * REGISTRY lookups, etc.) rather than a second hand-rolled clone path
 * that could silently drift from it over time.
 * @param {import('../core/World.js').World} world
 * @param {string} prefabId
 * @param {string} [nameOverride]
 * @returns {import('../core/Entity.js').Entity|null}
 */
export function instantiatePrefab(world, prefabId, nameOverride) {
  const record = _prefabs.get(prefabId);
  if (!record) return null;
  const entity = instantiateEntity(world, record.sceneData, nameOverride);
  // instantiateEntity() doesn't know about prefabs at all (it's a
  // generic entity-from-serialized-data hydrator shared with copy/
  // paste) — linking is this call site's job, done AFTER hydration so
  // it can't be blown away by anything instantiateEntity() sets.
  entity.prefabId = prefabId;
  entity.prefabOverrides = {};
  return entity;
}

/**
 * Wipes every prefab from the catalogue. Used by project import (see
 * ProjectIO.js/ProjectStorage.js) so loading a different project
 * always starts from a clean prefab catalogue instead of merging with
 * whatever the previous project had — same reasoning/call sites as
 * AssetRegistry.clearAllAssets().
 */
export function clearAllPrefabs() {
  _prefabs.clear();
}

/**
 * Replaces the ENTIRE prefab catalogue from previously-saved project
 * data (see buildSnapshot()'s `prefabs` block / ProjectIO.js's
 * prefabs.json) — the prefab-catalogue counterpart to AssetRegistry's
 * restoreProjectAssets(). Also fast-forwards the auto-increment id
 * counter past every restored id so a NEW prefab created after loading
 * never collides with one just restored from disk (same reasoning as
 * World.deserializeScene's entity/folder id-counter bump).
 * @param {Array<{id:string,name:string,sceneData:object,thumbnail:(string|null)}>} records
 */
export function restoreProjectPrefabs(records) {
  _prefabs.clear();
  let maxId = 0;
  for (const r of records || []) {
    if (!r || !r.id) continue;
    _prefabs.set(r.id, { id: r.id, name: r.name || "Prefab", sceneData: r.sceneData || {}, thumbnail: r.thumbnail || null });
    const n = parseInt(String(r.id).replace("prefab", ""), 10);
    if (!Number.isNaN(n) && n > maxId) maxId = n;
  }
  _nextPrefabId = maxId + 1;
}
