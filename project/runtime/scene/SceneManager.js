/**
 * runtime/scene/SceneManager.js
 *
 * Holds the project's list of scenes (each a plain serialized-scene
 * object, see SceneSerializer.js) and which one is currently active/
 * loaded into the live World. Sprite assets are NOT part of a scene's
 * data (see AssetRegistry.js) — they live in one project-wide registry
 * that every scene shares, exactly like Unity's shared asset database.
 * Only entities + hierarchy + each scene's own camera are per-scene.
 *
 * RUNTIME-ONLY FILE.
 */

import { serializeScene, deserializeScene } from "./SceneSerializer.js";
import { loadDefaultScene } from "./SceneLoader.js";

let _scenes = []; // [{ id, name, data }] — data is a serialized-scene object (null while it's the live/active one)
let _activeIndex = -1;
let _nextSceneId = 1;

/**
 * Sets up the scene list with a single default starter scene and loads
 * it into the given World. Call once at boot.
 * @param {import('../core/World.js').World} world
 */
export function initSceneManager(world) {
  _scenes = [{ id: "scene" + _nextSceneId++, name: "Main Scene", data: null }];
  _activeIndex = 0;
  loadDefaultScene(world);
  world.sceneName = _scenes[0].name;
}

/** @returns {Array<{id:string,name:string}>} lightweight list for UI (no full data payload) */
export function getSceneList() {
  return _scenes.map((s) => ({ id: s.id, name: s.name }));
}

/**
 * Returns the full scene list including serialized data payloads.
 * Used by the editor to pass all scenes to the play popup so
 * scene.load() can work there.
 * @returns {Array<{id:string,name:string,data:object|null}>}
 */
export function getAllScenesData() {
  return _scenes.map((s) => ({ id: s.id, name: s.name, data: s.data }));
}

/**
 * Populates the scene list from an external array (e.g. passed from
 * the editor to the play popup). Does NOT load any scene into the World
 * — call switchToScene() or deserializeScene() after this.
 * @param {Array<{id:string,name:string,data:object}>} scenesData
 */
export function loadAllScenesData(scenesData) {
  if (!scenesData || !scenesData.length) return;
  _scenes = scenesData.map((s) => ({ id: s.id, name: s.name, data: s.data }));
  // activeIndex stays -1 until switchToScene/initSceneManager is called.
  // Compute the max existing id number so createScene() doesn't collide.
  let maxId = 0;
  for (const s of _scenes) {
    const n = parseInt((s.id || "").replace("scene", ""), 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  }
  _nextSceneId = maxId + 1;
}

/**
 * Full project-load counterpart to loadAllScenesData(): replaces the
 * ENTIRE scene list with the given array (same as loadAllScenesData)
 * AND immediately loads one of them into the World, exactly like
 * initSceneManager() does for the single built-in starter scene. Used
 * exclusively by project import (see editor/state/ProjectIO.js) — the
 * play popup keeps using loadAllScenesData()+switchToScene() directly
 * since it already has its own "which scene is active" logic tied to
 * which scene Play mode was opened from.
 *
 * @param {import('../core/World.js').World} world
 * @param {Array<{id:string,name:string,data:object}>} scenesData
 * @param {string} [activeSceneId] which scene to load into the World —
 *   defaults to the first scene in the array if omitted or not found.
 * @returns {boolean} whether a scene was successfully loaded
 */
export function replaceAllScenesAndLoad(world, scenesData, activeSceneId) {
  if (!scenesData || !scenesData.length) return false;
  loadAllScenesData(scenesData);
  let targetIndex = activeSceneId ? _scenes.findIndex((s) => s.id === activeSceneId) : 0;
  if (targetIndex < 0) targetIndex = 0;
  const target = _scenes[targetIndex];
  deserializeScene(world, target.data);
  _activeIndex = targetIndex;
  world.sceneName = target.name;
  return true;
}

/**
 * Returns every scene's entity array EXCEPT the currently-active one,
 * for in-place patching by callers that need to reach into scenes that
 * aren't currently loaded into any live World — specifically
 * PrefabPropagation.js's "push an Update Prefab change out to every
 * instance in every scene" walk. The active scene is deliberately
 * excluded: its true live data is the World itself (this module's own
 * `data: null` convention for the active slot, see the `_scenes`
 * comment up top), so a caller patching "every scene" needs to handle
 * the live World separately and would double-patch (or patch stale,
 * about-to-be-overwritten data) if the active scene's slot were
 * included here too.
 *
 * Returns live references into each entity object, NOT copies — a
 * caller is expected to mutate fields on them directly (that's the
 * entire point: this is the one legitimate way to edit a scene that
 * isn't loaded, without loading/serializing/switching back). Nothing
 * else in this module reads these objects again until that scene is
 * actually switched into via switchToScene()/deserializeScene(), so an
 * in-place edit here is picked up correctly whenever that happens.
 *
 * @returns {Array<{sceneId:string, entities:object[]}>}
 */
export function getInactiveScenesEntities() {
  const out = [];
  _scenes.forEach((s, i) => {
    if (i === _activeIndex) return; // active scene's real data lives in the World, not here — see doc comment above
    if (!s.data || !Array.isArray(s.data.entities)) return;
    out.push({ sceneId: s.id, entities: s.data.entities });
  });
  return out;
}

export function getActiveSceneId() {
  return _activeIndex >= 0 ? _scenes[_activeIndex].id : null;
}

/**
 * Creates a new empty scene (just a Main Camera, like the default
 * starter scene) and appends it to the list. Does NOT switch to it —
 * call switchToScene() separately if the caller wants to jump into it.
 * @returns {{id:string,name:string}}
 */
export function createScene(name) {
  const id = "scene" + _nextSceneId++;
  const sceneName = name || "New Scene";
  const data = defaultSceneData(sceneName);
  _scenes.push({ id, name: sceneName, data });
  return { id, name: sceneName };
}

/**
 * @param {string} name
 * @returns {object} a fresh default-scene serialized payload (one Main Camera)
 */
function defaultSceneData(name) {
  return {
    sceneName: name,
    entities: [
      {
        name: "Main Camera",
        tag: "MainCamera",
        active: true,
        components: {
          Transform: { x: 0, y: 0 },
          Camera: { isMain: true },
        },
      },
    ],
  };
}

/**
 * Saves the World's current live contents back into the active scene's
 * slot in the list, so switching away doesn't lose edits.
 * @param {import('../core/World.js').World} world
 */
export function saveActiveScene(world) {
  if (_activeIndex < 0) return;
  _scenes[_activeIndex].data = serializeScene(world);
  _scenes[_activeIndex].name = world.sceneName;
}

/**
 * Persists the live World into its current slot, then loads a different
 * scene (by id) into the World.
 * @param {import('../core/World.js').World} world
 * @param {string} sceneId
 */
export function switchToScene(world, sceneId) {
  const targetIndex = _scenes.findIndex((s) => s.id === sceneId);
  if (targetIndex < 0 || targetIndex === _activeIndex) return false;

  saveActiveScene(world);

  const target = _scenes[targetIndex];
  deserializeScene(world, target.data);
  _activeIndex = targetIndex;
  return true;
}

/**
 * Renames a scene. If it's the active scene, also updates the live
 * World's sceneName so the Hierarchy header reflects it immediately.
 * @param {import('../core/World.js').World} world
 * @param {string} sceneId
 * @param {string} newName
 */
export function renameScene(world, sceneId, newName) {
  const trimmed = (newName || "").trim();
  if (!trimmed) return false;
  const entry = _scenes.find((s) => s.id === sceneId);
  if (!entry) return false;
  entry.name = trimmed;
  if (entry.id === getActiveSceneId()) world.sceneName = trimmed;
  return true;
}

/**
 * Duplicates a scene: deep-clones its serialized data (so editing the
 * copy can never mutate the original's entities/components — same
 * reasoning as SceneSerializer's own deep-copy of component data) under
 * a new name/id, and appends it right after the source scene in the
 * list. If the scene being duplicated is the currently active one, its
 * LIVE (possibly unsaved-to-the-list-yet) contents are cloned instead
 * of whatever stale data happens to be sitting in that scene's slot —
 * see saveActiveScene()'s own doc comment for why the active slot's
 * `data` can otherwise be behind what's actually in the World.
 * @param {import('../core/World.js').World} world
 * @param {string} sceneId
 * @returns {{id:string,name:string}|null} the new scene, or null if sceneId wasn't found
 */
export function duplicateScene(world, sceneId) {
  const index = _scenes.findIndex((s) => s.id === sceneId);
  if (index < 0) return null;

  const source = _scenes[index];
  const isActive = index === _activeIndex;
  const sourceData = isActive ? serializeScene(world) : source.data;

  const id = "scene" + _nextSceneId++;
  const name = _uniqueDuplicateName(source.name);
  // JSON round-trip is the simplest correct deep clone here since
  // sourceData is already guaranteed to be plain JSON-serializable data
  // (that's the whole point of the serialized-scene format — see
  // SceneSerializer.js's own doc comment), so there's no need for a
  // hand-written recursive clone just to avoid sharing nested
  // objects/arrays (points arrays, component objects, etc.) between
  // the original scene and its duplicate.
  const data = JSON.parse(JSON.stringify(sourceData));
  data.sceneName = name;

  _scenes.splice(index + 1, 0, { id, name, data });
  return { id, name };
}

/**
 * "Main Scene" -> "Main Scene Copy" -> "Main Scene Copy 2" -> ... —
 * mirrors the same "never silently collide" reasoning as
 * ScriptStorage's createScript()/scriptExists() pairing, just for scene
 * names instead of script names (scene NAMES aren't required to be
 * unique the way ids are, but a duplicate landing with the exact same
 * name as its source would be confusing in the Scenes folder listing).
 * @param {string} baseName
 * @returns {string}
 */
function _uniqueDuplicateName(baseName) {
  const existing = new Set(_scenes.map((s) => s.name));
  let candidate = baseName + " Copy";
  if (!existing.has(candidate)) return candidate;
  let n = 2;
  while (existing.has(baseName + " Copy " + n)) n++;
  return baseName + " Copy " + n;
}

/**
 * Deletes a scene. Refuses to delete the last remaining scene (a
 * project must always have at least one). If the active scene is
 * deleted, switches to the first remaining scene.
 * @param {import('../core/World.js').World} world
 * @param {string} sceneId
 */
export function deleteScene(world, sceneId) {
  if (_scenes.length <= 1) return false;
  const index = _scenes.findIndex((s) => s.id === sceneId);
  if (index < 0) return false;

  const deletingActive = index === _activeIndex;
  _scenes.splice(index, 1);

  if (deletingActive) {
    _activeIndex = -1; // nothing saved-over target now live
    const next = _scenes[0];
    deserializeScene(world, next.data);
    _activeIndex = 0;
  } else if (index < _activeIndex) {
    _activeIndex -= 1;
  }
  return true;
}
