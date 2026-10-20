/**
 * McpProjectTools.js — MCP tools for the project-level areas the core bridge
 * did not cover: entity metadata (name / tag / active / folder), the scene list,
 * the tag registry, and prefabs. Dispatched from ClaudeBridge.js after the
 * asset and editor tool modules. Returns null for tool names it does not own.
 */
import { editorState, markDirty, pushLog } from "../state/EditorState.js";
import { snapshotNow } from "../state/UndoManager.js";
import { getTagNames, addTag, deleteTag } from "../state/Tags.js";
import { switchScene, syncAfterExternalSceneChange } from "../viewport/SceneViewport.js";
import {
  createPrefabFromEntity, getPrefab, getAllPrefabs, renamePrefab, deletePrefab, instantiatePrefab,
} from "../../runtime/prefabs/PrefabRegistry.js";

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

function world() {
  if (!editorState.world) throw new Error("Open a Realot project in the editor first.");
  return editorState.world;
}
function game() {
  if (!editorState.game) throw new Error("The editor's game instance is not ready yet.");
  return editorState.game;
}
function entity(id) {
  if (typeof id !== "string" || !id.trim()) throw new Error("id is required.");
  const found = world().getEntity(id);
  if (!found) throw new Error("No entity with id '" + id + "' in the active scene. Use list_entities.");
  return found;
}
function changed(message) {
  markDirty();
  pushLog("log", "Claude: " + message);
  if (typeof editorState.renderFn === "function") editorState.renderFn();
}
function requireString(value, label, max = 160) {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + " must be a non-empty string.");
  if (value.trim().length > max) throw new Error(label + " must be " + max + " characters or fewer.");
  return value.trim();
}
function sceneList() {
  const g = game();
  const active = g.getActiveSceneId();
  return g.getSceneList().map((s) => ({ id: s.id, name: s.name, active: s.id === active }));
}
function prefabInfo(record) {
  return { id: record.id, name: record.name, entityName: record.sceneData && record.sceneData.name, components: Object.keys((record.sceneData && record.sceneData.components) || {}) };
}

export async function runMcpProjectTool(name, params = {}) {
  switch (name) {
    case "update_entity": {
      const target = entity(params.id);
      const patch = params.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) throw new Error("patch must be a non-empty object.");
      const allowed = new Set(["name", "tag", "active", "folderId"]);
      const unknown = Object.keys(patch).filter((k) => !allowed.has(k));
      if (unknown.length) throw new Error("Unsupported field(s): " + unknown.join(", ") + ". Allowed: name, tag, active, folderId. Use update_component for Transform and other components.");
      const next = {};
      if (patch.name !== undefined) next.name = requireString(patch.name, "name");
      if (patch.tag !== undefined) next.tag = requireString(patch.tag, "tag", 120);
      if (patch.active !== undefined) {
        if (typeof patch.active !== "boolean") throw new Error("active must be true or false.");
        next.active = patch.active;
      }
      if (patch.folderId !== undefined) {
        if (patch.folderId !== null && (typeof patch.folderId !== "string" || !world().getHierarchyFolder(patch.folderId))) {
          throw new Error("folderId must be null or the id of an existing hierarchy folder.");
        }
        next.folderId = patch.folderId;
      }
      snapshotNow("scene");
      if (next.tag !== undefined && !getTagNames().includes(next.tag)) addTag(next.tag);
      Object.assign(target, next);
      changed("updated '" + target.name + "'");
      return text({ id: target.id, name: target.name, tag: target.tag, active: target.active !== false, folderId: target.folderId || null });
    }

    case "list_scenes":
      game().saveActiveScene && game().saveActiveScene();
      return text({ scenes: sceneList() });

    case "create_scene": {
      const created = game().createScene(params.name === undefined ? undefined : requireString(params.name, "name"));
      if (params.switch !== false) switchScene(created.id);
      changed("created scene '" + created.name + "'");
      return text({ created, scenes: sceneList() });
    }

    case "switch_scene": {
      requireString(params.scene_id, "scene_id", 100);
      if (!game().getSceneList().some((s) => s.id === params.scene_id)) throw new Error("No scene '" + params.scene_id + "'. Use list_scenes.");
      if (params.scene_id !== game().getActiveSceneId() && !switchScene(params.scene_id)) throw new Error("Could not switch scenes.");
      if (typeof editorState.renderFn === "function") editorState.renderFn();
      return text({ scenes: sceneList() });
    }

    case "rename_scene": {
      requireString(params.scene_id, "scene_id", 100);
      const newName = requireString(params.name, "name");
      if (!game().renameScene(params.scene_id, newName)) throw new Error("Could not rename scene '" + params.scene_id + "'.");
      changed("renamed scene to '" + newName + "'");
      return text({ scenes: sceneList() });
    }

    case "delete_scene": {
      requireString(params.scene_id, "scene_id", 100);
      const list = game().getSceneList();
      const scene = list.find((s) => s.id === params.scene_id);
      if (!scene) throw new Error("No scene '" + params.scene_id + "'. Use list_scenes.");
      if (list.length <= 1) throw new Error("A project must keep at least one scene.");
      if (params.confirm !== true) {
        return text({ deleted: false, confirmation_required: true, scene, note: "Deleting a scene cannot be undone. Call again with confirm=true to proceed." });
      }
      const wasActive = scene.id === game().getActiveSceneId();
      if (!game().deleteScene(scene.id)) throw new Error("Could not delete the scene.");
      if (wasActive) syncAfterExternalSceneChange();
      changed("deleted scene '" + scene.name + "'");
      return text({ deleted: true, scenes: sceneList() });
    }

    case "list_tags":
      return text({ tags: getTagNames() });

    case "add_tag": {
      const tag = requireString(params.tag, "tag", 120);
      addTag(tag);
      changed("added tag '" + tag + "'");
      return text({ tags: getTagNames() });
    }

    case "delete_tag": {
      const tag = requireString(params.tag, "tag", 120);
      if (tag === "Untagged") throw new Error("'Untagged' is built in and cannot be deleted.");
      if (!getTagNames().includes(tag)) throw new Error("No tag '" + tag + "'.");
      deleteTag(tag);
      changed("deleted tag '" + tag + "'");
      return text({ tags: getTagNames() });
    }

    case "list_prefabs":
      return text({ prefabs: getAllPrefabs().map(prefabInfo) });

    case "create_prefab": {
      const target = entity(params.id);
      if (target.prefabId && getPrefab(target.prefabId)) throw new Error("'" + target.name + "' is already a prefab instance.");
      snapshotNow("scene");
      const record = createPrefabFromEntity(target, params.name === undefined ? undefined : requireString(params.name, "name"));
      target.prefabId = record.id;
      target.prefabOverrides = {};
      changed("created prefab '" + record.name + "'");
      return text({ prefab: prefabInfo(record) });
    }

    case "instantiate_prefab": {
      requireString(params.prefab_id, "prefab_id", 100);
      if (!getPrefab(params.prefab_id)) throw new Error("No prefab '" + params.prefab_id + "'. Use list_prefabs.");
      for (const key of ["x", "y"]) {
        if (params[key] !== undefined && (!Number.isFinite(params[key]) || Math.abs(params[key]) > 10_000_000)) throw new Error(key + " must be a finite number.");
      }
      snapshotNow("scene");
      const created = instantiatePrefab(world(), params.prefab_id, params.name === undefined ? undefined : requireString(params.name, "name"));
      if (!created) throw new Error("Could not instantiate the prefab.");
      const transform = created.getComponent("Transform");
      if (transform) {
        if (params.x !== undefined) transform.x = params.x;
        if (params.y !== undefined) transform.y = params.y;
      }
      editorState.selectedId = created.id;
      editorState.selectedIds = [created.id];
      changed("instantiated prefab '" + params.prefab_id + "'");
      return text({ created: { id: created.id, name: created.name, x: transform ? transform.x : undefined, y: transform ? transform.y : undefined } });
    }

    case "rename_prefab": {
      requireString(params.prefab_id, "prefab_id", 100);
      if (!renamePrefab(params.prefab_id, requireString(params.name, "name"))) throw new Error("No such prefab.");
      changed("renamed prefab");
      return text({ prefabs: getAllPrefabs().map(prefabInfo) });
    }

    case "delete_prefab": {
      requireString(params.prefab_id, "prefab_id", 100);
      const record = getPrefab(params.prefab_id);
      if (!record) throw new Error("No prefab '" + params.prefab_id + "'. Use list_prefabs.");
      if (params.confirm !== true) {
        return text({ deleted: false, confirmation_required: true, prefab: prefabInfo(record), note: "Existing instances become unlinked. Call again with confirm=true to proceed." });
      }
      deletePrefab(record.id);
      changed("deleted prefab '" + record.name + "'");
      return text({ deleted: true, prefabs: getAllPrefabs().map(prefabInfo) });
    }

    default:
      return null;
  }
}
