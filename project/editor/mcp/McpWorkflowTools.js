/**
 * McpWorkflowTools.js — MCP tools for editor workflows that had no tool yet:
 * hierarchy folders, prefab propagation (update / revert / unpack), scene
 * duplication, script deletion and enable/disable, navigation baking, play
 * pause, and game / project export. Dispatched from ClaudeBridge.js after
 * McpProjectTools. Returns null for tool names it does not own.
 *
 * Exports can be both downloaded in the editor's browser (default) and read
 * back in base64 chunks with read_export_chunk, mirroring the asset upload
 * protocol in the other direction.
 */
import { editorState, markDirty, pushLog } from "../state/EditorState.js";
import { snapshotNow } from "../state/UndoManager.js";
import { bakeNavWorld } from "../../runtime/pathfinding/NavWorldBaker.js";
import { getPrefab } from "../../runtime/prefabs/PrefabRegistry.js";
import { updatePrefabFromEntity, revertInstanceToPrefab, unlinkFromPrefab } from "../../runtime/prefabs/PrefabPropagation.js";
import { getAllScripts, scriptExists } from "../scripting/ScriptStorage.js";
import { deleteScriptEverywhere } from "../panels/ScriptEditorWindow.js";
import { setPlayWindowPaused } from "../viewport/PlayWindow.js";
import { buildExport, slugifyForFilename } from "../export/ExportGame.js";
import { exportProject, downloadBlob } from "../state/ProjectIO.js";

const EXPORT_CHUNK_BYTES = 384 * 1024;
const EXPORT_TTL_MS = 15 * 60 * 1000;
let exportSession = null; // one export at a time keeps memory bounded

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
function str(value, label, max = 160) {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + " must be a non-empty string.");
  if (value.trim().length > max) throw new Error(label + " must be " + max + " characters or fewer.");
  return value.trim();
}
function folder(id) {
  const found = world().getHierarchyFolder(str(id, "folder_id", 100));
  if (!found) throw new Error("No hierarchy folder '" + id + "'. Use list_folders.");
  return found;
}
function folderList() {
  return world().hierarchyFolders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId || null, expanded: f.expanded !== false }));
}
function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function clearExport() { exportSession = null; }
function liveExport(id) {
  if (exportSession && Date.now() - exportSession.at > EXPORT_TTL_MS) clearExport();
  if (!exportSession || exportSession.id !== id) throw new Error("Unknown or expired export_id. Call export_game again.");
  exportSession.at = Date.now();
  return exportSession;
}
function scriptUsers(name) {
  return world().getAllEntities().filter((e) => {
    const s = e.getComponent("Script");
    return s && s.scriptName === name;
  }).map((e) => ({ id: e.id, name: e.name }));
}

export async function runMcpWorkflowTool(name, params = {}) {
  switch (name) {
    // ------------------------------------------------------------ hierarchy folders
    case "list_folders":
      return text({ folders: folderList() });

    case "create_folder": {
      if (params.parent_id !== undefined && params.parent_id !== null) folder(params.parent_id);
      snapshotNow("scene");
      const created = world().createHierarchyFolder(str(params.name, "name"), params.parent_id || null);
      changed("created folder '" + created.name + "'");
      return text({ created: { id: created.id, name: created.name, parentId: created.parentId }, folders: folderList() });
    }

    case "rename_folder": {
      const target = folder(params.folder_id);
      snapshotNow("scene");
      world().renameHierarchyFolder(target.id, str(params.name, "name"));
      changed("renamed folder");
      return text({ folders: folderList() });
    }

    case "move_folder": {
      const target = folder(params.folder_id);
      const parent = params.parent_id === undefined || params.parent_id === null ? null : folder(params.parent_id).id;
      snapshotNow("scene");
      world().moveHierarchyFolder(target.id, parent);
      changed("moved folder '" + target.name + "'");
      return text({ folders: folderList() });
    }

    case "delete_folder": {
      const target = folder(params.folder_id);
      snapshotNow("scene");
      world().deleteHierarchyFolder(target.id); // contents move up one level; nothing inside is deleted
      changed("deleted folder '" + target.name + "'");
      return text({ deleted: true, folders: folderList() });
    }

    // ------------------------------------------------------------ prefab propagation
    case "update_prefab": {
      const target = entity(params.id);
      if (!target.prefabId || !getPrefab(target.prefabId)) throw new Error("'" + target.name + "' is not linked to a prefab.");
      for (const key of ["apply_position", "apply_rotation", "apply_scale"]) {
        if (params[key] !== undefined && typeof params[key] !== "boolean") throw new Error(key + " must be true or false.");
      }
      snapshotNow("scene");
      const result = updatePrefabFromEntity(world(), target, {
        applyPosition: params.apply_position === true,
        applyRotation: params.apply_rotation === true,
        applyScale: params.apply_scale === true,
      });
      if (!result) throw new Error("Could not update the prefab; it may have been deleted.");
      changed("updated prefab from '" + target.name + "'");
      return text({ prefabId: target.prefabId, otherInstancesUpdated: result.updatedInstanceCount });
    }

    case "revert_prefab": {
      const target = entity(params.id);
      if (!target.prefabId || !getPrefab(target.prefabId)) throw new Error("'" + target.name + "' is not linked to a prefab.");
      snapshotNow("scene");
      const didChange = revertInstanceToPrefab(target);
      changed("reverted '" + target.name + "' to its prefab");
      return text({ id: target.id, changed: !!didChange });
    }

    case "unpack_prefab": {
      const target = entity(params.id);
      if (!target.prefabId) throw new Error("'" + target.name + "' is not a prefab instance.");
      snapshotNow("scene");
      unlinkFromPrefab(target);
      changed("unpacked '" + target.name + "' from its prefab");
      return text({ id: target.id, unpacked: true });
    }

    // ------------------------------------------------------------ scenes / scripts / nav / play
    case "duplicate_scene": {
      const created = game().duplicateScene(str(params.scene_id, "scene_id", 100));
      if (!created) throw new Error("No scene '" + params.scene_id + "'. Use list_scenes.");
      changed("duplicated scene as '" + created.name + "'");
      return text({ created: { id: created.id, name: created.name } });
    }

    case "delete_script": {
      const scriptName = str(params.name, "name", 240);
      if (!scriptExists(scriptName)) throw new Error("No script '" + scriptName + "'. Existing: " + getAllScripts().join(", "));
      const users = scriptUsers(scriptName);
      if (params.confirm !== true) {
        return text({ deleted: false, confirmation_required: true, script: scriptName, usedByEntitiesInActiveScene: users, note: "Deleting cannot be undone and clears the script from objects using it. Call again with confirm=true." });
      }
      if (!deleteScriptEverywhere(scriptName)) throw new Error("Could not delete the script.");
      changed("deleted script '" + scriptName + "'");
      return text({ deleted: true, script: scriptName, clearedFrom: users });
    }

    case "set_script_enabled": {
      const target = entity(params.id);
      const script = target.getComponent("Script");
      if (!script) throw new Error("'" + target.name + "' has no Script component.");
      if (typeof params.enabled !== "boolean") throw new Error("enabled must be true or false.");
      snapshotNow("scene");
      script.enabled = params.enabled;
      changed((params.enabled ? "enabled" : "disabled") + " script on '" + target.name + "'");
      return text({ id: target.id, scriptName: script.scriptName, enabled: script.enabled });
    }

    case "bake_navworld": {
      const target = entity(params.id);
      const nav = target.getComponent("NavWorld2D");
      if (!nav) throw new Error("'" + target.name + "' has no NavWorld2D component.");
      snapshotNow("scene");
      const { walkable, blocked } = bakeNavWorld(nav, world(), target.getComponent("Transform"));
      editorState.showNavWorld = true;
      changed("baked Nav World on '" + target.name + "'");
      return text({ id: target.id, walkableCells: walkable, blockedCells: blocked });
    }

    case "set_paused": {
      if (typeof params.paused !== "boolean") throw new Error("paused must be true or false.");
      if (!editorState.isPlaying) throw new Error("The game is not playing. Use set_playing first.");
      editorState.isPaused = params.paused;
      setPlayWindowPaused(params.paused);
      if (typeof editorState.renderFn === "function") editorState.renderFn();
      return text({ playing: true, paused: editorState.isPaused === true });
    }

    // ------------------------------------------------------------ exports
    case "export_game": {
      if (params.format !== "html" && params.format !== "pwa") throw new Error("format must be 'html' or 'pwa'. APK builds still run from the editor's Export window.");
      const title = (typeof params.title === "string" && params.title.trim()) || editorState.exportGameTitle || editorState.projectName || "Untitled Project";
      const { zip, stats } = await buildExport(game(), {
        projectName: title,
        faviconDataUrl: editorState.exportFavicon ? editorState.exportFavicon.dataUrl : null,
        format: params.format,
        onProgress: (message) => pushLog("log", message),
      });
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      const fileName = slugifyForFilename(title) + (params.format === "pwa" ? "-pwa" : "-html5") + ".zip";
      const download = params.download !== false;
      if (download) downloadBlob(blob, fileName);
      const id = crypto.randomUUID();
      exportSession = { id, blob, fileName, at: Date.now() };
      pushLog("log", "Claude: exported '" + title + "' as " + params.format + " (" + blob.size + " bytes).");
      return text({
        export_id: id,
        file_name: fileName,
        size_bytes: blob.size,
        chunk_size_bytes: EXPORT_CHUNK_BYTES,
        chunk_count: Math.ceil(blob.size / EXPORT_CHUNK_BYTES),
        downloaded_in_editor: download,
        stats,
        note: "Fetch the bytes with read_export_chunk (chunk_index 0..chunk_count-1), then call release_export. The export expires after 15 minutes.",
      });
    }

    case "read_export_chunk": {
      const session = liveExport(params.export_id);
      const total = Math.ceil(session.blob.size / EXPORT_CHUNK_BYTES);
      if (!Number.isInteger(params.chunk_index) || params.chunk_index < 0 || params.chunk_index >= total) {
        throw new Error("chunk_index must be an integer from 0 to " + (total - 1) + ".");
      }
      const start = params.chunk_index * EXPORT_CHUNK_BYTES;
      const bytes = new Uint8Array(await session.blob.slice(start, start + EXPORT_CHUNK_BYTES).arrayBuffer());
      return text({ chunk_index: params.chunk_index, chunk_count: total, byte_length: bytes.length, chunk_base64: toBase64(bytes), last: params.chunk_index === total - 1 });
    }

    case "release_export": {
      liveExport(params.export_id);
      clearExport();
      return text({ released: true });
    }

    case "download_project_zip": {
      const projectName = (typeof params.name === "string" && params.name.trim()) || editorState.projectName || "Untitled Project";
      const result = await exportProject(game(), projectName, { optimizeAssets: params.optimize_assets === true, onProgress: (m) => pushLog("log", m) });
      return text({ downloaded_in_editor: true, project_name: projectName, optimize_stats: (result && result.optimizeStats) || null, note: "The .realot project ZIP was sent to the editor browser's downloads." });
    }

    default:
      return null;
  }
}
