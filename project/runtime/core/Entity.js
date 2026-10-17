/**
 * runtime/core/Entity.js
 *
 * Plain entity record. An entity is just an id + name + tag + a bag of
 * components keyed by component type name. No rendering, no editor
 * concerns live here — this is pure data.
 *
 * RUNTIME-ONLY FILE. Do not import anything from /editor here.
 */

let _nextEntityId = 1;

export class Entity {
  /**
   * @param {string} name
   * @param {string} [tag]
   */
  constructor(name, tag) {
    this.id = "e" + (_nextEntityId++);
    this.name = name || "GameObject";
    this.tag = tag || "Untagged";
    this.active = true;

    /**
     * @type {string|null} id of the Hierarchy folder (see
     * World.hierarchyFolders) this entity is filed under in the
     * editor's Hierarchy panel, or null for "not in any folder" (shown
     * at the scene root). Purely an editor organizational concern —
     * exactly like `tag`, it is plain serializable data that the
     * running game itself never reads (no system queries by folderId),
     * but it still lives on Entity/World rather than in editor/state so
     * it round-trips through SceneSerializer.js and survives save/load
     * and undo/redo the same way every other piece of scene data does
     * (see RULES.txt section 6). Folders themselves are organizational
     * groupings only, not spatial/transform parenting — moving an
     * entity into a folder never changes its Transform.
     */
    this.folderId = null;

    /**
     * @type {string|null} id of the prefab (see PrefabRegistry.js) this
     * entity was instantiated from, or null if this entity has never
     * been linked to a prefab (a plain hand-placed entity), OR was once
     * linked but has since been explicitly "Unpack"ed (see
     * PrefabPropagation.js's unlinkFromPrefab()). A prefabId that no
     * longer resolves via PrefabRegistry.getPrefab() (the prefab was
     * deleted from the catalogue) is treated as "not linked" everywhere
     * that reads it — see PrefabRegistry.deletePrefab()'s doc comment.
     */
    this.prefabId = null;

    /**
     * @type {Object<string, string[]>} which of THIS instance's own
     * fields have been manually edited since it was created/last synced
     * from its prefab, keyed by component type name to an array of
     * property names on that component (e.g. { Transform: ["x","y"],
     * SpriteRenderer: ["color"] }). Meaningless/ignored when prefabId is
     * null. This is what makes propagation non-destructive: when
     * "Update Prefab" pushes a changed field out to every other
     * instance, an instance that already has that exact field listed
     * here keeps its own manually-tweaked value instead of being
     * silently overwritten (see PrefabPropagation.js's
     * applyPrefabToInstance()). "Revert to Prefab" clears this back to
     * {} and re-syncs every field from the prefab's current data.
     */
    this.prefabOverrides = {};

    /** @type {Map<string, object>} componentType -> component instance */
    this.components = new Map();
  }

  addComponent(typeName, component) {
    this.components.set(typeName, component);
    return component;
  }

  getComponent(typeName) {
    return this.components.get(typeName) || null;
  }

  hasComponent(typeName) {
    return this.components.has(typeName);
  }

  removeComponent(typeName) {
    return this.components.delete(typeName);
  }
}

/**
 * Reset the global id counter. Only ever used by scene loading when
 * starting a fresh scene, so ids stay predictable in a single run.
 */
export function resetEntityIdCounter() {
  _nextEntityId = 1;
}

/**
 * Bumps the global id counter to at least `minNext` (exclusive), so a
 * subsequently created entity never reuses an id that was explicitly
 * restored from a saved scene (see World.createEntity's optional id).
 * No-op when the counter is already ahead. Used only by scene loading.
 */
export function setEntityIdCounter(minNext) {
  if (_nextEntityId < minNext) _nextEntityId = minNext;
}
