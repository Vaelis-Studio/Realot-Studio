/**
 * Realot Studio MCP editor bridge.
 *
 * This module is intentionally editor-only. It runs a small UI in the editor
 * and pairs with either the optional local MCP companion or the hosted relay.
 * MCP requests are routed to a narrow, validated set of existing editor APIs.
 */
import { ENGINE_VERSION } from "../../runtime/EngineVersion.js";
import { Transform } from "../../runtime/components/Transform.js";
import { Camera } from "../../runtime/components/Camera.js";
import { SpriteRenderer } from "../../runtime/components/SpriteRenderer.js";
import { ShapeRenderer } from "../../runtime/components/ShapeRenderer.js";
import { StrokePath } from "../../runtime/components/StrokePath.js";
import { TextRenderer } from "../../runtime/components/TextRenderer.js";
import { SpeechBubble } from "../../runtime/components/SpeechBubble.js";
import { ChatLog } from "../../runtime/components/ChatLog.js";
import { TextInput } from "../../runtime/components/TextInput.js";
import { Joystick } from "../../runtime/components/Joystick.js";
import { Rigidbody2D } from "../../runtime/components/Rigidbody2D.js";
import { Collider2D } from "../../runtime/components/Collider2D.js";
import { Joint2D } from "../../runtime/components/Joint2D.js";
import { Light } from "../../runtime/components/Light.js";
import { ShadowCaster } from "../../runtime/components/ShadowCaster.js";
import { CharacterController } from "../../runtime/components/CharacterController.js";
import { LightingSettings } from "../../runtime/components/LightingSettings.js";
import { SpriteAnimation } from "../../runtime/components/SpriteAnimation.js";
import { AudioSource } from "../../runtime/components/AudioSource.js";
import { AudioListener } from "../../runtime/components/AudioListener.js";
import { Tileset } from "../../runtime/components/Tileset.js";
import { Tilemap } from "../../runtime/components/Tilemap.js";
import { NavWorld2D } from "../../runtime/components/NavWorld2D.js";
import { NavAgent2D } from "../../runtime/components/NavAgent2D.js";
import { Script } from "../../runtime/components/Script.js";
import { getAllScripts, getScriptSource, createScript } from "../scripting/ScriptStorage.js";
import { applyExternalScriptSource } from "../panels/ScriptEditorWindow.js";
import { editorState, markDirty, pushLog } from "../state/EditorState.js";
import { snapshotNow } from "../state/UndoManager.js";

const COMPONENTS = Object.freeze({
  Transform, Camera, SpriteRenderer, ShapeRenderer, StrokePath, TextRenderer,
  SpeechBubble, ChatLog, TextInput, Joystick, Rigidbody2D, Collider2D, Joint2D,
  Light, ShadowCaster, CharacterController, LightingSettings, SpriteAnimation,
  AudioSource, AudioListener, Tileset, Tilemap, NavWorld2D, NavAgent2D, Script,
});
const SAFE_COMPONENT_FIELDS = new Set([
  "Transform", "Camera", "SpriteRenderer", "ShapeRenderer", "StrokePath",
  "TextRenderer", "SpeechBubble", "ChatLog", "TextInput", "Joystick",
  "Rigidbody2D", "Collider2D", "Joint2D", "Light", "ShadowCaster",
  "CharacterController", "LightingSettings", "SpriteAnimation", "AudioSource",
  "AudioListener", "Tileset", "Tilemap", "NavWorld2D", "NavAgent2D", "Script",
]);
const MAX_SCRIPT_LENGTH = 250_000;
const MAX_COMPONENT_JSON_LENGTH = 80_000;
const BRIDGE_PORT = 43182;
let socket = null;
let reconnectToken = null;
let statusTimer = null;
let api = null;
let host = null;
let shadow = null;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertSafeJson(value, label, maxLength = MAX_COMPONENT_JSON_LENGTH) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch (_) { throw new Error(`${label} must be JSON-compatible data.`); }
  if (typeof encoded !== "string" || encoded.length > maxLength) {
    throw new Error(`${label} is too large (limit ${maxLength.toLocaleString()} characters).`);
  }
  const walk = (item, depth = 0) => {
    if (depth > 16) throw new Error(`${label} is nested too deeply.`);
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry, depth + 1);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const key of Object.keys(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new Error(`${label} contains a prohibited property: ${key}.`);
      }
      walk(item[key], depth + 1);
    }
  };
  walk(value);
  return JSON.parse(encoded);
}

function getGame() {
  const game = api && typeof api.getGame === "function" ? api.getGame() : null;
  if (!game || !game.world) throw new Error("Open a Realot project in the editor first.");
  return game;
}

function refreshEditor() {
  if (api && typeof api.render === "function") api.render();
}

function sceneSummary(scene) {
  return { id: scene.id, name: scene.name, isActive: scene.id === getGame().getActiveSceneId() };
}

function activeSceneData(game) {
  game.saveActiveScene();
  const activeId = game.getActiveSceneId();
  const scenes = game.getAllScenesData();
  return scenes.find((scene) => scene.id === activeId) || null;
}

function entityToData(entity) {
  const components = {};
  for (const [type, component] of entity.components.entries()) {
    components[type] = cloneJson(component);
  }
  return {
    id: entity.id,
    name: entity.name,
    tag: entity.tag,
    active: entity.active !== false,
    folderId: entity.folderId || null,
    components,
  };
}

function requireEntity(game, entityId) {
  if (typeof entityId !== "string" || !entityId.trim() || entityId.length > 100) {
    throw new Error("entity_id must be a non-empty entity id.");
  }
  const entity = game.world.getEntity(entityId);
  if (!entity) throw new Error(`Entity '${entityId}' is not in the active scene.`);
  return entity;
}

function assertFieldShape(type, key, value, defaultValue) {
  if (value === null) {
    if (defaultValue !== null) throw new Error(`${type}.${key} cannot be null.`);
    return;
  }
  // Null defaults are used for optional references and values whose concrete
  // shape is chosen later (for example path/area-cost data). They are still
  // JSON-bounded by assertSafeJson and passed through the component constructor.
  if (defaultValue === null || defaultValue === undefined) return;
  if (Array.isArray(defaultValue)) {
    if (!Array.isArray(value)) throw new Error(`${type}.${key} must be an array.`);
    if (defaultValue.length && defaultValue[0] !== null && defaultValue[0] !== undefined) {
      const sample = defaultValue[0];
      for (const item of value) {
        if (Array.isArray(sample)) {
          if (!Array.isArray(item)) throw new Error(`Every item in ${type}.${key} must be an array.`);
        } else if (isPlainObject(sample)) {
          if (!isPlainObject(item)) throw new Error(`Every item in ${type}.${key} must be an object.`);
        } else if (typeof sample === "number") {
          if (typeof item !== "number" || !Number.isFinite(item)) throw new Error(`Every item in ${type}.${key} must be a finite number.`);
        } else if (typeof item !== typeof sample) {
          throw new Error(`Items in ${type}.${key} must match the component's expected data type.`);
        }
      }
    }
    return;
  }
  if (isPlainObject(defaultValue)) {
    if (!isPlainObject(value)) throw new Error(`${type}.${key} must be an object.`);
    return;
  }
  if (typeof defaultValue === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${type}.${key} must be a finite number.`);
    return;
  }
  if (typeof value !== typeof defaultValue) {
    throw new Error(`${type}.${key} must be a ${typeof defaultValue}.`);
  }
}

function validateComponentPayload(type, fields, { requireNonEmpty = false } = {}) {
  if (!isPlainObject(fields) || (requireNonEmpty && Object.keys(fields).length === 0)) {
    throw new Error(requireNonEmpty ? "fields must be a non-empty JSON object." : "fields must be a JSON object.");
  }
  const safeFields = assertSafeJson(fields, "fields");
  const defaults = new COMPONENTS[type]({});
  for (const [key, value] of Object.entries(safeFields)) {
    if (key.startsWith("_") || ["__proto__", "prototype", "constructor"].includes(key) ||
        !Object.prototype.hasOwnProperty.call(defaults, key)) {
      throw new Error(`'${key}' is not a supported editable field on ${type}.`);
    }
    if (type === "Transform") {
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000_000) {
        throw new Error(`Transform.${key} must be a finite number with magnitude no greater than 10,000,000.`);
      }
    } else {
      assertFieldShape(type, key, value, defaults[key]);
    }
  }
  // Build a throwaway instance before touching the live scene. This catches
  // component-specific constructor assumptions (for example arrays of points)
  // while leaving the user's current component untouched on invalid input.
  new COMPONENTS[type](safeFields);
  return safeFields;
}

function componentFields(component, fields, type) {
  if (!component) throw new Error(`This entity does not have a ${type} component.`);
  const safeFields = validateComponentPayload(type, fields, { requireNonEmpty: true });
  for (const key of Object.keys(safeFields)) {
    if (!Object.prototype.hasOwnProperty.call(component, key)) {
      throw new Error(`'${key}' is not a writable data field on this ${type} component.`);
    }
  }
  return safeFields;
}

function applyComponentFields(component, fields) {
  for (const [key, value] of Object.entries(fields)) component[key] = value;
}

function validateTransformFields(values) {
  const allowed = new Set(["x", "y", "z", "rotation", "scaleX", "scaleY"]);
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) throw new Error(`'${key}' is not a Transform field.`);
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000_000) {
      throw new Error(`Transform.${key} must be a finite number with magnitude no greater than 10,000,000.`);
    }
  }
}

function getStatus() {
  let game = null;
  try { game = getGame(); } catch (_) { /* status can still report whether the editor is booted */ }
  const activeId = game ? game.getActiveSceneId() : null;
  const sceneList = game ? game.getSceneList() : [];
  const active = sceneList.find((scene) => scene.id === activeId) || null;
  return {
    connected: !!socket && socket.readyState === WebSocket.OPEN,
    editorReady: !!game,
    engine: "Realot Studio",
    engineVersion: ENGINE_VERSION,
    projectName: editorState.projectName || new URLSearchParams(window.location.search).get("name") || "Untitled Project",
    activeSceneId: activeId,
    activeSceneName: active ? active.name : (game && game.world ? game.world.sceneName : null),
    entityCount: game ? game.world.getAllEntities().length : 0,
    isPlaying: editorState.isPlaying === true,
    isPaused: editorState.isPaused === true,
    scriptCount: getAllScripts().length,
    dirty: !!(window.__realotDirtyCheck && window.__realotDirtyCheck()),
    connectedAt: socket && socket.readyState === WebSocket.OPEN ? socket.__realotConnectedAt || null : null,
  };
}

function getScript(name) {
  if (typeof name !== "string" || !name.trim() || name.length > 240) throw new Error("name must be a valid script name.");
  if (!getAllScripts().includes(name)) throw new Error(`Script '${name}' does not exist.`);
  return { name, source: getScriptSource(name) };
}

async function handleEditorRequest(method, params = {}) {
  if (!isPlainObject(params)) throw new Error("Tool arguments must be a JSON object.");
  const game = getGame();
  const world = game.world;

  switch (method) {
    case "get_status":
      return getStatus();

    case "list_scenes": {
      game.saveActiveScene();
      return { activeSceneId: game.getActiveSceneId(), scenes: game.getSceneList().map(sceneSummary) };
    }

    case "list_entities": {
      const scene = activeSceneData(game);
      return {
        scene: scene ? { id: scene.id, name: scene.name } : null,
        entities: world.getAllEntities().map(entityToData),
      };
    }

    case "get_entity": {
      const entity = requireEntity(game, params.entity_id);
      return entityToData(entity);
    }

    case "create_entity": {
      const name = typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 160) : "GameObject";
      const tag = typeof params.tag === "string" && params.tag.trim() ? params.tag.trim().slice(0, 120) : "Untagged";
      const x = params.x === undefined ? 0 : Number(params.x);
      const y = params.y === undefined ? 0 : Number(params.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 10_000_000 || Math.abs(y) > 10_000_000) {
        throw new Error("x and y must be finite numbers between -10,000,000 and 10,000,000.");
      }
      const requestedComponents = params.components === undefined ? {} : assertSafeJson(params.components, "components");
      if (!isPlainObject(requestedComponents)) throw new Error("components must be a JSON object keyed by component type.");
      for (const type of Object.keys(requestedComponents)) {
        if (!SAFE_COMPONENT_FIELDS.has(type)) throw new Error(`Unsupported component type '${type}'.`);
      }
      if (requestedComponents.Transform === undefined) requestedComponents.Transform = { x, y };
      else {
        requestedComponents.Transform = { ...requestedComponents.Transform };
        if (requestedComponents.Transform.x === undefined) requestedComponents.Transform.x = x;
        if (requestedComponents.Transform.y === undefined) requestedComponents.Transform.y = y;
      }
      // Validate all component records before mutating the World.
      const built = {};
      for (const [type, values] of Object.entries(requestedComponents)) {
        if (!isPlainObject(values)) throw new Error(`components.${type} must be a JSON object.`);
        const safeValues = validateComponentPayload(type, values);
        built[type] = new COMPONENTS[type](safeValues);
      }
      snapshotNow("scene");
      const entity = world.createEntity(name, tag);
      for (const [type, component] of Object.entries(built)) entity.addComponent(type, component);
      editorState.selectedId = entity.id;
      editorState.selectedIds = [entity.id];
      refreshEditor();
      pushLog("log", `[MCP] Created ${entity.name} (${entity.id}).`);
      return entityToData(entity);
    }

    case "update_entity": {
      const entity = requireEntity(game, params.entity_id);
      const patch = params.patch;
      if (!isPlainObject(patch) || Object.keys(patch).length === 0) throw new Error("patch must be a non-empty JSON object.");
      const allowed = new Set(["name", "tag", "active", "x", "y", "z", "rotation", "scaleX", "scaleY", "folderId"]);
      const safePatch = assertSafeJson(patch, "patch");
      for (const key of Object.keys(safePatch)) {
        if (!allowed.has(key)) throw new Error(`'${key}' is not supported in patch. Use component_type + fields for component fields.`);
      }
      const transformFields = ["x", "y", "z", "rotation", "scaleX", "scaleY"];
      const hasTransform = transformFields.some((key) => Object.prototype.hasOwnProperty.call(safePatch, key));
      const transform = hasTransform ? entity.getComponent("Transform") : null;
      if (hasTransform && !transform) throw new Error("This entity has no Transform component.");
      if (safePatch.name !== undefined && (typeof safePatch.name !== "string" || !safePatch.name.trim())) throw new Error("name must be a non-empty string.");
      if (safePatch.name !== undefined && safePatch.name.length > 160) throw new Error("name must be 160 characters or fewer.");
      if (safePatch.tag !== undefined && (typeof safePatch.tag !== "string" || !safePatch.tag.trim())) throw new Error("tag must be a non-empty string.");
      if (safePatch.tag !== undefined && safePatch.tag.length > 120) throw new Error("tag must be 120 characters or fewer.");
      for (const key of transformFields) {
        if (safePatch[key] !== undefined && (!Number.isFinite(Number(safePatch[key])) || Math.abs(Number(safePatch[key])) > 10_000_000)) {
          throw new Error(`${key} must be a finite number with magnitude no greater than 10,000,000.`);
        }
      }
      if (safePatch.active !== undefined && typeof safePatch.active !== "boolean") throw new Error("active must be true or false.");
      if (safePatch.folderId !== undefined && safePatch.folderId !== null && typeof safePatch.folderId !== "string") throw new Error("folderId must be a string or null.");
      if (typeof safePatch.folderId === "string" && !world.getHierarchyFolder(safePatch.folderId)) throw new Error(`Folder '${safePatch.folderId}' does not exist in the active scene.`);
      snapshotNow("scene");
      for (const key of ["name", "tag", "active", "folderId"]) {
        if (Object.prototype.hasOwnProperty.call(safePatch, key)) {
          entity[key] = key === "folderId" ? (safePatch[key] || null) : (key === "name" || key === "tag" ? safePatch[key].trim() : safePatch[key]);
        }
      }
      if (transform) for (const key of transformFields) if (safePatch[key] !== undefined) transform[key] = Number(safePatch[key]);
      refreshEditor();
      pushLog("log", `[MCP] Updated ${entity.name} (${entity.id}).`);
      return entityToData(entity);
    }

    case "delete_entity": {
      const entity = requireEntity(game, params.entity_id);
      const removedName = entity.name;
      snapshotNow("scene");
      world.destroyEntity(entity.id);
      if (editorState.selectedId === entity.id) editorState.selectedId = null;
      editorState.selectedIds = (editorState.selectedIds || []).filter((id) => id !== entity.id);
      refreshEditor();
      pushLog("warn", `[MCP] Deleted ${removedName} (${params.entity_id}). Use Ctrl+Z to undo.`);
      return { deleted: true, entityId: params.entity_id, name: removedName, undoAvailable: true };
    }

    case "add_component": {
      const entity = requireEntity(game, params.entity_id);
      const type = params.component_type;
      if (typeof type !== "string" || !SAFE_COMPONENT_FIELDS.has(type)) throw new Error(`Unsupported component type '${String(type)}'.`);
      if (entity.hasComponent(type)) throw new Error(`Entity already has a ${type} component.`);
      const data = params.fields === undefined ? {} : assertSafeJson(params.fields, "fields");
      if (!isPlainObject(data)) throw new Error("fields must be a JSON object.");
      const safeData = validateComponentPayload(type, data);
      const component = new COMPONENTS[type](safeData);
      snapshotNow("scene");
      entity.addComponent(type, component);
      refreshEditor();
      pushLog("log", `[MCP] Added ${type} to ${entity.name}.`);
      return { entityId: entity.id, componentType: type, component: cloneJson(component) };
    }

    case "update_component": {
      const entity = requireEntity(game, params.entity_id);
      const type = params.component_type;
      if (typeof type !== "string" || !SAFE_COMPONENT_FIELDS.has(type)) throw new Error(`Unsupported component type '${String(type)}'.`);
      const component = entity.getComponent(type);
      if (!component) throw new Error(`Entity '${entity.id}' has no ${type} component.`);
      if (type === "Script") throw new Error("Use realot_set_script to keep script storage, Monaco, and attached Script components synchronized.");
      const safeFields = componentFields(component, params.fields, type);
      snapshotNow("scene");
      applyComponentFields(component, safeFields);
      refreshEditor();
      pushLog("log", `[MCP] Updated ${type} on ${entity.name}.`);
      return { entityId: entity.id, componentType: type, component: cloneJson(component) };
    }

    case "remove_component": {
      const entity = requireEntity(game, params.entity_id);
      const type = params.component_type;
      if (typeof type !== "string" || !SAFE_COMPONENT_FIELDS.has(type)) throw new Error(`Unsupported component type '${String(type)}'.`);
      if (type === "Transform") throw new Error("Transform cannot be removed because spatial entities require it.");
      if (!entity.hasComponent(type)) throw new Error(`Entity '${entity.id}' has no ${type} component.`);
      snapshotNow("scene");
      entity.removeComponent(type);
      refreshEditor();
      pushLog("log", `[MCP] Removed ${type} from ${entity.name}.`);
      return { entityId: entity.id, removedComponent: type };
    }

    case "list_scripts":
      return { scripts: getAllScripts().map((name) => ({ name, sourceLength: getScriptSource(name).length })) };

    case "get_script":
      return getScript(params.name);

    case "set_script": {
      if (typeof params.name !== "string" || !params.name.trim() || params.name.length > 240) throw new Error("name must be a valid script name.");
      if (typeof params.source !== "string") throw new Error("source must be a string.");
      if (params.source.length > MAX_SCRIPT_LENGTH) throw new Error(`source exceeds ${MAX_SCRIPT_LENGTH.toLocaleString()} characters.`);
      const name = params.name.trim();
      let created = false;
      if (!getAllScripts().includes(name)) {
        createScript(name);
        created = true;
      }
      applyExternalScriptSource(name, params.source);
      markDirty();
      refreshEditor();
      pushLog("log", `[MCP] ${created ? "Created" : "Updated"} script '${name}'.`);
      return { name, sourceLength: params.source.length, created, syntaxValid: syntaxCheck(params.source).valid };
    }

    case "validate_script": {
      const source = typeof params.source === "string" ? params.source : getScript(params.name).source;
      return syntaxCheck(source);
    }

    case "create_scene": {
      const name = typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 160) : "New Scene";
      const created = game.createScene(name);
      if (!created || !created.id) throw new Error("Realot could not create the scene.");
      const switched = api.switchScene(created.id);
      if (!switched) throw new Error(`Created ${created.id}, but could not switch to it.`);
      markDirty();
      refreshEditor();
      pushLog("log", `[MCP] Created scene '${created.name}'.`);
      return { ...created, active: true };
    }

    case "switch_scene": {
      if (typeof params.scene_id !== "string" || !params.scene_id) throw new Error("scene_id is required.");
      const switched = api.switchScene(params.scene_id);
      if (!switched && game.getActiveSceneId() !== params.scene_id) throw new Error(`Scene '${params.scene_id}' does not exist or could not be activated.`);
      if (switched) markDirty();
      refreshEditor();
      return { activeSceneId: game.getActiveSceneId(), scenes: game.getSceneList().map(sceneSummary) };
    }

    case "rename_scene": {
      if (typeof params.scene_id !== "string" || !params.scene_id) throw new Error("scene_id is required.");
      if (typeof params.name !== "string" || !params.name.trim()) throw new Error("name must be a non-empty string.");
      const ok = game.renameScene(params.scene_id, params.name.trim().slice(0, 160));
      if (!ok) throw new Error(`Could not rename scene '${params.scene_id}'.`);
      markDirty();
      refreshEditor();
      return { renamed: true, sceneId: params.scene_id, name: params.name.trim().slice(0, 160) };
    }

    case "delete_scene": {
      if (typeof params.scene_id !== "string" || !params.scene_id) throw new Error("scene_id is required.");
      if (game.getSceneList().length <= 1) throw new Error("Realot projects must keep at least one scene.");
      const oldScenes = game.getSceneList();
      const oldName = oldScenes.find((s) => s.id === params.scene_id)?.name || params.scene_id;
      const ok = game.deleteScene(params.scene_id);
      if (!ok) throw new Error(`Could not delete scene '${params.scene_id}'.`);
      api.syncAfterExternalSceneChange();
      markDirty();
      refreshEditor();
      pushLog("warn", `[MCP] Deleted scene '${oldName}'.`);
      return { deleted: true, sceneId: params.scene_id, scenes: game.getSceneList() };
    }

    case "validate_scene": {
      const validation = typeof game.validate === "function" ? game.validate() : { valid: true, message: "No scene validator is exposed by this engine build." };
      return validation;
    }

    case "set_play_mode": {
      const playing = params.playing === true;
      editorState.isPlaying = playing;
      if (!playing) editorState.isPaused = false;
      api.onTogglePlay(playing);
      refreshEditor();
      return { isPlaying: editorState.isPlaying === true, activeSceneId: game.getActiveSceneId() };
    }

    case "get_console":
      return { entries: (editorState.logs || []).slice(-100).map((entry) => ({ level: entry.type, message: entry.msg, count: entry.count || 1 })) };

    case "save_project": {
      game.saveActiveScene();
      if (typeof editorState.saveNow === "function") {
        const result = await editorState.saveNow();
        return { saved: !!(result && result.ok), tier: result && result.tier || "unknown", target: "Realot launcher autosave" };
      }
      // Standalone/file-based editors still use the native File > Save Project ZIP flow.
      // Never claim that data was persisted when this session has no launcher snapshot.
      return { saved: false, target: "manual project file", message: "Scene data was flushed in memory. This editor session has no launcher autosave target; use File > Save Project to download the project ZIP." };
    }

    default:
      throw new Error(`Unknown Realot editor operation '${method}'.`);
  }
}

function syntaxCheck(source) {
  if (typeof source !== "string") throw new Error("source must be a string.");
  try {
    // Match the engine's user-script compilation model without executing the code.
    // The function body is parsed, but onStart/onUpdate are never invoked here.
    new Function(source); // eslint-disable-line no-new-func
    return { valid: true, message: "JavaScript syntax is valid. Script runtime behavior has not been executed." };
  } catch (error) {
    return { valid: false, message: String(error && error.message || error).slice(0, 2000) };
  }
}

function setPanelStatus(message, connected = false) {
  if (!shadow) return;
  const status = shadow.getElementById("status");
  const dot = shadow.getElementById("status-dot");
  if (status) status.textContent = message;
  if (dot) {
    dot.style.background = connected ? "#27ae60" : "#9a9a9a";
    dot.setAttribute("aria-label", connected ? "Connected" : "Disconnected");
  }
  const badge = shadow.getElementById("toggle-panel");
  if (badge) badge.setAttribute("aria-pressed", String(!shadow.getElementById("panel").hidden));
}

function sendStatus() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try { socket.send(JSON.stringify({ type: "status", result: getStatus() })); } catch (_) { /* the close handler covers disconnects */ }
}

function disconnect(clearToken = false) {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  if (socket) {
    try { socket.close(1000, "Realot bridge disconnected"); } catch (_) { /* already closing */ }
  }
  socket = null;
  if (clearToken) {
    reconnectToken = null;
    try { sessionStorage.removeItem("realot.mcp.pairingToken"); } catch (_) { /* storage disabled */ }
  }
  setPanelStatus("Not connected. Start the Realot MCP server in Claude Desktop, then pair using its local token.", false);
}

function finishConnection(candidate, token, remote = false) {
  candidate.__realotRemote = remote;
  candidate.addEventListener("open", () => {
    if (remote) {
      setPanelStatus("Authenticating with the hosted relay…", false);
      candidate.send(JSON.stringify({ type: "auth", token }));
    } else {
      candidate.__realotConnectedAt = new Date().toISOString();
      setPanelStatus("Connected to the local Realot MCP bridge.", true);
      try { sessionStorage.setItem("realot.mcp.pairingToken", token); } catch (_) { /* optional convenience */ }
      sendStatus();
      statusTimer = setInterval(sendStatus, 2000);
    }
  });
  candidate.addEventListener("message", async (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch (_) { return; }
    if (remote && message && message.type === "auth_result") {
      if (!message.ok) { setPanelStatus(message.error || "Hosted relay authentication failed.", false); return; }
      candidate.__realotConnectedAt = new Date().toISOString();
      setPanelStatus("Connected to hosted Realot MCP relay. This project is available while this editor remains open.", true);
      sendStatus();
      statusTimer = setInterval(sendStatus, 2000);
      return;
    }
    if (!message || message.type !== "request" || typeof message.id !== "string" || typeof message.method !== "string") return;
    try {
      const result = await handleEditorRequest(message.method, message.params || {});
      if (candidate.readyState === WebSocket.OPEN) candidate.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
    } catch (error) {
      const failure = { type: "response", id: message.id, ok: false, error: String(error && error.message || error).slice(0, 3000) };
      if (candidate.readyState === WebSocket.OPEN) candidate.send(JSON.stringify(failure));
    }
    sendStatus();
  });
  candidate.addEventListener("error", () => {
    if (socket === candidate) setPanelStatus(remote ? "Hosted connection failed. Check the relay URL and deployment status." : "Connection failed. Check that the local Realot MCP server is running.", false);
  });
  candidate.addEventListener("close", () => {
    if (socket !== candidate) return;
    socket = null;
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    setPanelStatus(remote ? "Hosted relay disconnected. Claude can no longer access this editor." : "Disconnected. Restart or reconnect the local MCP bridge, then pair again if needed.", false);
  });
}

function connect(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) {
    setPanelStatus("That token does not look valid. Use the 64-character token printed by the local bridge.", false);
    return;
  }
  disconnect(false);
  reconnectToken = token;
  setPanelStatus("Connecting to the local bridge…", false);
  let candidate;
  try { candidate = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/realot-mcp?token=${encodeURIComponent(token)}`); }
  catch (_) { setPanelStatus("Could not open the local connection. Start/restart the MCP bridge and try again.", false); return; }
  socket = candidate;
  finishConnection(candidate, token, false);
}

function randomHex(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRelayBase(value) {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use the HTTPS base URL supplied by the Realot deployment, without a path, query, or credentials.");
  }
  return url.origin;
}

async function connectHosted() {
  let relay;
  try { relay = normalizeRelayBase(shadow.getElementById("relay-url").value); }
  catch (error) { setPanelStatus(error.message, false); return; }
  disconnect(false);
  const sessionId = crypto.randomUUID();
  const token = randomHex(32);
  setPanelStatus("Creating a secure hosted session…", false);
  let response;
  try {
    response = await fetch(`${relay}/session/${sessionId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (_) { setPanelStatus("Could not reach the hosted relay. Confirm the deployment URL and try again.", false); return; }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    setPanelStatus(`Hosted session creation failed (${response.status}). ${detail.slice(0, 180)}`, false);
    return;
  }
  const mcpUrl = `${relay}/mcp/${sessionId}`;
  shadow.getElementById("mcp-url").value = mcpUrl;
  shadow.getElementById("mcp-token").value = token;
  shadow.getElementById("hosted-details").hidden = false;
  try { sessionStorage.setItem("realot.mcp.hostedSession", JSON.stringify({ relay, sessionId, token })); } catch (_) { /* optional */ }
  setPanelStatus("Session created. Connecting this open project…", false);
  const wsUrl = `${relay.replace(/^https:/, "wss:")}/editor?session=${encodeURIComponent(sessionId)}`;
  let candidate;
  try { candidate = new WebSocket(wsUrl); }
  catch (_) { setPanelStatus("Could not open the hosted WebSocket. Check that the relay supports WebSockets.", false); return; }
  socket = candidate;
  finishConnection(candidate, token, true);
}

function installPanel() {
  if (host || !document.body) return;
  host = document.createElement("div");
  host.id = "realot-mcp-bridge-widget";
  host.style.cssText = "position:fixed;right:14px;bottom:38px;z-index:2147483000;";
  shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host{font:12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e9edf2}
      *{box-sizing:border-box}
      .toggle{display:flex;align-items:center;gap:8px;border:1px solid #424a55;border-radius:999px;background:#1d232b;color:#eef3f8;padding:9px 13px;box-shadow:0 5px 18px #0005;cursor:pointer;font:600 12px system-ui}
      .toggle:hover{background:#2b333e}
      .dot{width:8px;height:8px;border-radius:50%;background:#9a9a9a;display:inline-block;flex:none}
      .panel{width:min(340px,calc(100vw - 28px));margin-bottom:8px;padding:14px;background:#171c23;border:1px solid #414a56;border-radius:12px;box-shadow:0 14px 36px #0007}
      .panel[hidden]{display:none}
      h2{font-size:14px;line-height:1.2;margin:0 0 8px;font-weight:700;color:#fff}
      p{margin:7px 0;color:#c3cbd5}
      label{display:block;margin:10px 0 5px;color:#e0e6ee;font-weight:600}
      input{width:100%;padding:9px;border-radius:7px;border:1px solid #4c5664;background:#0f1318;color:#fff;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;outline-offset:2px}
      .buttons{display:flex;gap:7px;margin-top:10px}
      .action{border:1px solid #4b5664;border-radius:7px;padding:8px 10px;background:#29323d;color:#fff;cursor:pointer;font:600 12px system-ui}
      .action.primary{background:#315c91;border-color:#4779b4}
      .action:hover{filter:brightness(1.13)}
      .fine{font-size:11px;color:#9ea9b7}
      #status{overflow-wrap:anywhere}
    </style>
    <div id="panel" class="panel" hidden>
      <h2>Realot AI Bridge</h2>
      <p id="status">Not connected. Connect a hosted relay to expose only this open project to Claude.</p>
      <label for="relay-url">Hosted relay URL</label>
      <input id="relay-url" type="url" autocomplete="url" placeholder="https://your-realot-relay.workers.dev">
      <div class="buttons"><button id="hosted-connect" class="action primary" type="button">Create session &amp; connect</button></div>
      <div id="hosted-details" hidden>
        <label for="mcp-url">MCP URL for Claude</label><input id="mcp-url" readonly>
        <div class="buttons"><button id="copy-url" class="action" type="button">Copy MCP URL</button></div>
        <label for="mcp-token">Bearer token for Claude</label><input id="mcp-token" type="password" readonly>
        <div class="buttons"><button id="reveal-token" class="action" type="button">Show token</button><button id="copy-token" class="action" type="button">Copy token</button></div>
        <p class="fine">In Claude, add a custom remote MCP connector using the URL above and Bearer token as its Authorization credential. Treat the token like a password.</p>
      </div>
      <details style="margin-top:12px"><summary style="cursor:pointer;color:#c3cbd5">Advanced: local Claude Desktop bridge</summary>
        <label for="pair-token">Local pairing token</label>
        <input id="pair-token" type="password" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the 64-character local token" maxlength="64">
        <div class="buttons"><button id="pair" class="action" type="button">Pair local bridge</button></div>
      </details>
      <div class="buttons"><button id="disconnect" class="action" type="button">Disconnect</button><button id="close" class="action" type="button">Close</button></div>
      <p class="fine">Hosted mode routes approved tool requests to this open editor. Project content is not stored as a cloud project, but tool inputs and requested results transit the relay and are shared with Claude. Disconnect when finished. The hosted relay must be deployed by Realot before this feature can connect.</p>
    </div>
    <button id="toggle-panel" class="toggle" type="button" aria-pressed="false"><span id="status-dot" class="dot" aria-label="Disconnected"></span>AI Bridge</button>
  `;
  document.body.appendChild(host);
  const panel = shadow.getElementById("panel");
  const toggle = shadow.getElementById("toggle-panel");
  toggle.addEventListener("click", () => { panel.hidden = !panel.hidden; toggle.setAttribute("aria-pressed", String(!panel.hidden)); });
  shadow.getElementById("close").addEventListener("click", () => { panel.hidden = true; toggle.setAttribute("aria-pressed", "false"); });
  shadow.getElementById("pair").addEventListener("click", () => connect(shadow.getElementById("pair-token").value.trim()));
  shadow.getElementById("hosted-connect").addEventListener("click", () => connectHosted());
  shadow.getElementById("disconnect").addEventListener("click", () => disconnect(true));
  shadow.getElementById("copy-url").addEventListener("click", async () => { try { await navigator.clipboard.writeText(shadow.getElementById("mcp-url").value); setPanelStatus("MCP URL copied.", !!socket); } catch (_) { setPanelStatus("Select and copy the MCP URL manually.", !!socket); } });
  shadow.getElementById("copy-token").addEventListener("click", async () => { try { await navigator.clipboard.writeText(shadow.getElementById("mcp-token").value); setPanelStatus("Bearer token copied. Keep it private.", !!socket); } catch (_) { setPanelStatus("Select and copy the bearer token manually.", !!socket); } });
  shadow.getElementById("reveal-token").addEventListener("click", () => { const input = shadow.getElementById("mcp-token"); input.type = input.type === "password" ? "text" : "password"; shadow.getElementById("reveal-token").textContent = input.type === "password" ? "Show token" : "Hide token"; });
  const configuredRelay = window.REALOT_MCP_RELAY_URL || new URLSearchParams(window.location.search).get("mcpRelay") || "";
  if (configuredRelay) shadow.getElementById("relay-url").value = configuredRelay;
  try {
    const saved = sessionStorage.getItem("realot.mcp.pairingToken");
    if (saved && /^[a-f0-9]{64}$/i.test(saved)) {
      shadow.getElementById("pair-token").value = saved;
      reconnectToken = saved;
      setPanelStatus("Saved local token loaded. Open Advanced to reconnect the local editor bridge.", false);
    }
  } catch (_) { /* session storage is an optional convenience */ }
}

export function installRealotMcpBridge(bridgeApi) {
  api = bridgeApi;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installPanel, { once: true });
  else installPanel();
}
