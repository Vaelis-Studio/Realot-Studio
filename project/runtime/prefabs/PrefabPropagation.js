/**
 * runtime/prefabs/PrefabPropagation.js
 *
 * The actual "Update Prefab pushes the change out to every existing
 * instance, in every scene, live scene included" behavior — kept
 * separate from PrefabRegistry.js (which only owns the catalogue
 * itself) because this is the one part of the whole prefab feature
 * that has to reach OUTSIDE the currently-loaded World and touch
 * scenes that aren't live right now (see SceneManager.
 * getInactiveScenesEntities()).
 *
 * THE OVERRIDE MODEL (why a prefab update doesn't clobber manual
 * per-instance tweaks): each Entity carries its own prefabOverrides
 * (see Entity.js) — a per-component list of property names that
 * instance has diverged on since it was last synced with its prefab.
 * snapshotEntityComponents() + diffEntityAndRecordOverrides() (a
 * before/after pair) is what populates that list — called from
 * EditorEvents.js around any Inspector field edit on an entity that
 * has a prefabId; updatePrefabFromEntity() is what reads a prefab's
 * new canonical data from one instance and pushes every NON-overridden
 * field out to every other instance; revertInstanceToPrefab() is the
 * inverse — wipes an instance's own overrides and re-syncs it fully
 * from the prefab.
 *
 * WHY DIFF-BASED RATHER THAN HAND-TRACKING EACH EDIT PATH: the
 * Inspector's applyFieldChange() (see EditorEvents.js) has a lot of
 * special-cased branches (SpriteAnimation clip overrides, Collider2D
 * shape-dependent re-seeding, checkbox vs number vs text inputs, etc.)
 * that don't map 1:1 onto "one data-field string = one component
 * property". Rather than duplicate/hook every one of those branches
 * individually (fragile — a future new field type added there could
 * easily forget to also mark itself as an override), the override
 * detector instead snapshots the affected entity's components BEFORE
 * applyFieldChange() runs and diffs them AFTER — any property whose
 * value changed gets marked as an override, regardless of which
 * special-case branch inside applyFieldChange() actually touched it.
 * See EditorEvents.js's two applyFieldChange() call sites for where
 * this snapshot/diff wraps around it.
 *
 * RUNTIME-ONLY FILE.
 */

import { getPrefab, resolveThumbnail } from "./PrefabRegistry.js";
import { serializeEntity, instantiateEntity } from "../scene/SceneSerializer.js";
import { getInactiveScenesEntities } from "../scene/SceneManager.js";
import { World } from "../core/World.js";

/**
 * Deep-clones a plain JSON-safe value. Component data is always plain
 * JSON (numbers/strings/booleans/arrays/plain objects — see every
 * component class's own doc comment / RULES.txt), so JSON round-trip
 * is a safe, simple deep clone here, same reasoning SceneSerializer.js
 * already relies on for component data.
 */
function _deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Shallow-diffs two plain component-data objects and returns the list
 * of top-level property names whose values differ. Deliberately a
 * DEEP equality check per-property (via JSON.stringify) rather than
 * `!==`, since a property can itself be an array/object (e.g.
 * Collider2D.trianglePoints, SpriteAnimation.clips) where a brand-new
 * array with identical contents must NOT register as changed — that
 * would mark something an override every time propagation itself just
 * wrote an identical value back through a code path that happens to
 * allocate a fresh array/object rather than mutate in place.
 * @param {object} before
 * @param {object} after
 * @returns {string[]}
 */
function _diffProps(before, after) {
  const changed = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(key);
  }
  return changed;
}

/**
 * Snapshots every component currently on `entity`, plain-data only
 * (via serializeEntity, which already deep-clones), for later
 * comparison by diffEntityAndRecordOverrides(). Call this BEFORE
 * making an edit.
 * @param {import('../core/Entity.js').Entity} entity
 * @returns {object} componentType -> plain component data
 */
export function snapshotEntityComponents(entity) {
  return serializeEntity(entity).components;
}

/**
 * Call AFTER an edit: diffs `entity`'s current component data against
 * a snapshot taken beforehand (see snapshotEntityComponents()) and
 * merges any changed property names into entity.prefabOverrides. A
 * no-op (including not touching prefabOverrides at all) when the
 * entity isn't linked to a prefab — override-tracking is meaningless
 * for a plain, never-prefabbed entity, and this function is cheap to
 * call unconditionally from every edit path without every call site
 * needing to check prefabId itself first.
 * @param {import('../core/Entity.js').Entity} entity
 * @param {object} beforeComponents snapshot from snapshotEntityComponents()
 */
export function diffEntityAndRecordOverrides(entity, beforeComponents) {
  if (!entity.prefabId) return;
  const afterComponents = serializeEntity(entity).components;
  const allTypes = new Set([...Object.keys(beforeComponents || {}), ...Object.keys(afterComponents)]);
  if (!entity.prefabOverrides) entity.prefabOverrides = {};
  for (const type of allTypes) {
    const changedProps = _diffProps(beforeComponents ? beforeComponents[type] : undefined, afterComponents[type]);
    if (!changedProps.length) continue;
    const existing = new Set(entity.prefabOverrides[type] || []);
    for (const p of changedProps) existing.add(p);
    entity.prefabOverrides[type] = Array.from(existing);
  }
}

/**
 * Applies a prefab's current template data onto ONE instance's plain
 * entity-data object, skipping any property that instance has
 * overridden (per its own prefabOverrides). Works identically whether
 * `instanceData` is a live Entity-shaped serialized snapshot (from the
 * active World) or a plain JSON entity record from an inactive scene's
 * stored data (see SceneManager.getInactiveScenesEntities()) — both
 * shapes match what SceneSerializer produces/consumes, which is the
 * whole point of keeping scene data plain JSON everywhere (RULES.txt).
 *
 * Mutates `instanceData.components` IN PLACE (adds/updates matching
 * component types; a component type the prefab has that the instance
 * doesn't get gets added fresh, minus any overridden props — though an
 * instance can't yet have overrides for a component it never had in
 * the first place, so that case is just "copy the whole thing"). Never
 * removes a component the instance has that the prefab doesn't — an
 * instance-only component (e.g. one manually added on top of the
 * prefab) is left alone, matching Unity's own instance-can-have-extra-
 * components-the-prefab-lacks behavior.
 *
 * @param {object} prefabComponents prefab's current serializeEntity().components
 * @param {object} instanceData a plain entity-data object (has .components and .prefabOverrides)
 * @returns {boolean} whether anything was actually changed
 */
function _applyPrefabComponentsToInstanceData(prefabComponents, instanceData, options = {}) {
  // Transform data is canonical in the prefab, but instance placement is
  // intentionally independent by default. Update Prefab can selectively
  // propagate Position, Rotation, and/or Scale. Keep the old aggregate
  // `applyTransform:true` option as a backwards-compatible shorthand.
  const applyTransform = options.applyTransform === true;
  const applyPosition = applyTransform || options.applyPosition === true;
  const applyRotation = applyTransform || options.applyRotation === true;
  const applyScale = applyTransform || options.applyScale === true;
  let changed = false;
  const overrides = instanceData.prefabOverrides || {};
  if (!instanceData.components) instanceData.components = {};

  for (const [type, prefabCompData] of Object.entries(prefabComponents)) {
    const overriddenProps = new Set(overrides[type] || []);
    const existingCompData = instanceData.components[type];

    if (!existingCompData) {
      // Instance never had this component at all (prefab gained one
      // since this instance was created/last synced) — add it fresh.
      // Nothing to skip: an instance can't have an override for a
      // property on a component it doesn't even have yet.
      instanceData.components[type] = _deepClone(prefabCompData);
      changed = true;
      continue;
    }

    for (const [prop, value] of Object.entries(prefabCompData)) {
      if (type === "Transform") {
        const transformGroup =
          prop === "x" || prop === "y" || prop === "z" ? "position" :
          prop === "rotation" ? "rotation" :
          prop === "scaleX" || prop === "scaleY" ? "scale" : null;
        if (transformGroup === "position" && !applyPosition) continue;
        if (transformGroup === "rotation" && !applyRotation) continue;
        if (transformGroup === "scale" && !applyScale) continue;
      }
      if (overriddenProps.has(prop)) continue; // this instance's own manual edit wins — don't clobber it
      const cloned = _deepClone(value);
      if (JSON.stringify(existingCompData[prop]) !== JSON.stringify(cloned)) {
        existingCompData[prop] = cloned;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Writes a plain instance-data object's components back onto a LIVE
 * Entity's real component instances — used only for the active scene's
 * World (see updatePrefabFromEntity() below), since that's the one
 * place propagation has to update objects something is actually
 * rendering/simulating with RIGHT NOW rather than just JSON sitting in
 * SceneManager. Reuses each component's own constructor (matching
 * every existing component-hydration path in SceneSerializer.js)
 * rather than a plain property copy, so any constructor-side
 * normalization a component class does (e.g. clamping, defaulting)
 * still runs.
 * @param {import('../core/Entity.js').Entity} entity
 * @param {object} componentsData
 */
function _writeComponentsDataToLiveEntity(entity, componentsData) {
  for (const [type, data] of Object.entries(componentsData)) {
    const existing = entity.getComponent(type);
    if (existing) {
      // In-place property copy rather than replacing the component
      // instance outright — swapping the instance would break any
      // OTHER system holding a reference to this exact object this
      // frame (e.g. PhysicsWorld's handle map keys off entity id, not
      // component identity, so it would survive either way, but
      // in-place is strictly safer and costs nothing extra here).
      Object.assign(existing, data);
    } else {
      // Prefab gained a component this instance doesn't have yet — add
      // it fresh via _hydrateComponent() below (goes through the real
      // component-registry construction path, not a raw object
      // literal, so any constructor-side normalization still runs).
      _hydrateComponent(entity, type, data);
    }
  }
}

// COMPONENT_REGISTRY itself is intentionally not exported from
// SceneSerializer.js (keeping it as an internal implementation detail
// of that file rather than a second public surface every caller now
// has to import) — instantiateEntity() is already the sanctioned
// "build/attach components from plain data" entry point every other
// caller in the codebase uses (copy/paste, prefab instantiation,
// scene load), so reuse it here too instead of either duplicating the
// registry or exporting it just for this one new/rare case (an
// instance missing a component the prefab has, which only happens
// right after someone removes a component from an instance and then
// updates its own prefab, or drags an old scene forward after adding
// a new component to the prefab elsewhere).
//
// Building one correctly-constructed component instance means going
// through instantiateEntity()'s registry lookup, which needs a World
// to attach to — a throwaway scratch World, built fresh per call and
// immediately discarded, is the least invasive way to reach that
// registry without duplicating it here. World.js has no import of
// this file (only Entity.js, see World.js's own imports), so importing
// it directly at module scope carries no circular-import risk.
function _hydrateComponent(entity, type, data) {
  const scratchWorld = new World();
  const scratchEntity = instantiateEntity(scratchWorld, { name: "_scratch", components: { [type]: data } });
  const built = scratchEntity.getComponent(type);
  if (built) entity.addComponent(type, built);
}

/**
 * THE "Update Prefab" action: reads `sourceEntity`'s current component
 * data as the prefab's new canonical template, saves it back onto the
 * prefab catalogue entry, then pushes every changed, non-overridden
 * field out to every OTHER instance of that same prefab — across the
 * live World (the currently-open scene) AND every other scene's stored
 * data (via SceneManager.getInactiveScenesEntities()).
 *
 * `sourceEntity` itself is left exactly as-is (it now simply IS the
 * prefab's new canonical data by definition, so there's nothing to
 * push onto it) and its own prefabOverrides are cleared — from the
 * prefab's perspective, whatever this instance had "overridden" just
 * became the new normal, so those fields are no longer divergent from
 * anything.
 *
 * @param {import('../core/World.js').World} world the LIVE world (active scene)
 * @param {import('../core/Entity.js').Entity} sourceEntity the instance being used as the new template
 * @returns {{updatedInstanceCount:number} | null} null if sourceEntity isn't a valid prefab instance
 */
export function updatePrefabFromEntity(world, sourceEntity, options = {}) {
  if (!sourceEntity.prefabId) return null;
  const prefab = getPrefab(sourceEntity.prefabId);
  if (!prefab) return null; // prefabId is dangling (prefab was deleted) — see PrefabRegistry.deletePrefab()'s doc comment

  const newTemplateData = serializeEntity(sourceEntity);
  // The template itself never claims to be an instance of anything —
  // same reasoning as PrefabRegistry.createPrefabFromEntity().
  newTemplateData.folderId = null;
  newTemplateData.prefabId = null;
  newTemplateData.prefabOverrides = {};
  prefab.sceneData = newTemplateData;
  // Thumbnail is derived FROM sceneData (see PrefabRegistry.js's
  // resolveThumbnail), so re-templating must re-resolve it too — 
  // otherwise "Update Prefab" after swapping the source entity's
  // sprite would silently leave the OLD image showing in the Prefabs
  // folder even though the template itself updated correctly.
  prefab.thumbnail = resolveThumbnail(newTemplateData);

  sourceEntity.prefabOverrides = {};

  let updatedInstanceCount = 0;

  // 1) Every OTHER entity in the currently-live World.
  for (const entity of world.getAllEntities()) {
    if (entity.id === sourceEntity.id) continue;
    if (entity.prefabId !== sourceEntity.prefabId) continue;
    const instanceData = { components: {}, prefabOverrides: entity.prefabOverrides || {} };
    // Seed instanceData.components with the entity's OWN current data
    // so _applyPrefabComponentsToInstanceData's "component type the
    // instance doesn't have yet" branch above only fires for genuinely
    // new component types, not every component this entity already has.
    instanceData.components = serializeEntity(entity).components;
    const changed = _applyPrefabComponentsToInstanceData(prefab.sceneData.components, instanceData, options);
    if (changed) {
      _writeComponentsDataToLiveEntity(entity, instanceData.components);
      updatedInstanceCount++;
    }
  }

  // 2) Every instance sitting in every OTHER (not currently loaded)
  // scene's plain stored data.
  for (const { entities } of getInactiveScenesEntities()) {
    for (const entityData of entities) {
      if (entityData.prefabId !== sourceEntity.prefabId) continue;
      const changed = _applyPrefabComponentsToInstanceData(prefab.sceneData.components, entityData, options);
      if (changed) updatedInstanceCount++;
    }
  }

  return { updatedInstanceCount };
}

/**
 * The inverse of an override — wipes `entity`'s own prefabOverrides
 * and re-syncs every one of its components fully from its prefab's
 * current template data ("Revert to Prefab" in the Inspector). No-op
 * if the entity isn't linked to a resolvable prefab.
 * @param {import('../core/Entity.js').Entity} entity
 * @returns {boolean} whether anything was actually changed
 */
export function revertInstanceToPrefab(entity) {
  if (!entity.prefabId) return false;
  const prefab = getPrefab(entity.prefabId);
  if (!prefab) return false;
  entity.prefabOverrides = {};
  const instanceData = { components: serializeEntity(entity).components, prefabOverrides: {} };
  const changed = _applyPrefabComponentsToInstanceData(prefab.sceneData.components, instanceData);
  if (changed) _writeComponentsDataToLiveEntity(entity, instanceData.components);
  return changed;
}

/**
 * "Unpack Prefab" — detaches an entity from its prefab entirely. The
 * entity's current component data is left exactly as it is (this is
 * NOT a revert); only the linkage itself is removed, so future edits
 * to this entity no longer track overrides and future prefab updates
 * no longer reach it. Matches Unity's "Unpack Prefab" on an instance.
 * @param {import('../core/Entity.js').Entity} entity
 */
export function unlinkFromPrefab(entity) {
  entity.prefabId = null;
  entity.prefabOverrides = {};
}
