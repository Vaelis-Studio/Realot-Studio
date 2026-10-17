/**
 * editor/state/EditorEvents.js
 *
 * Single delegated click/input listener for the whole editor. Reads
 * data-action/data-field/data-axis attributes set by the panel renderers
 * and applies changes either to editorState (UI-only) or to live
 * components on editorState.world (real scene data).
 */

import { editorState, pushLog, markDirty } from "./EditorState.js";
import { getEngineSettings, setEngineSettings } from "./EngineSettings.js";
import { beginAndroidBuild, cancelAndroidBuild, endAndroidBuild, isAndroidBuildActive, wasAndroidBuildCancelled } from "./AndroidBuildSession.js";
import { PANEL_IDS, defaultPanelVisibility, savePanelVisibility } from "./PanelVisibility.js";
import { APK_SERVICE_URL } from "./ServerConfig.js";
import { androidExportEndpoint, androidExportHeaders, pollAndroidBuildJob, checkAndroidServerAwake, getActiveAndroidServer, listAndroidServers, setActiveAndroidServer, saveAndroidServer, deleteAndroidServer, uploadWebExportForAndroid, confirmAndroidDelivery } from "./ServerConfig.js";
import { Transform, TRANSFORM } from "../../runtime/components/Transform.js";
import { CAMERA } from "../../runtime/components/Camera.js";
import { SPRITE_RENDERER, SpriteRenderer } from "../../runtime/components/SpriteRenderer.js";
import { SHAPE_RENDERER, ShapeRenderer, ShapeType } from "../../runtime/components/ShapeRenderer.js";
import { STROKE_PATH, StrokePath } from "../../runtime/components/StrokePath.js";
import { TEXT_RENDERER, TextRenderer } from "../../runtime/components/TextRenderer.js";
import { SPEECH_BUBBLE, SpeechBubble } from "../../runtime/components/SpeechBubble.js";
import { CHAT_LOG, ChatLog } from "../../runtime/components/ChatLog.js";
import { TEXT_INPUT, TextInput } from "../../runtime/components/TextInput.js";
import { JOYSTICK, Joystick } from "../../runtime/components/Joystick.js";
import { RIGIDBODY_2D, Rigidbody2D } from "../../runtime/components/Rigidbody2D.js";
import { JOINT_2D, Joint2D } from "../../runtime/components/Joint2D.js";
import { COLLIDER_2D, Collider2D, ColliderShape } from "../../runtime/components/Collider2D.js";
import { CHARACTER_CONTROLLER, CharacterController } from "../../runtime/components/CharacterController.js";
import { LIGHT, Light, LightType } from "../../runtime/components/Light.js";
import { SHADOW_CASTER, ShadowCaster } from "../../runtime/components/ShadowCaster.js";
import { LIGHTING_SETTINGS, LightingSettings } from "../../runtime/components/LightingSettings.js";
import { SPRITE_ANIMATION, SpriteAnimation } from "../../runtime/components/SpriteAnimation.js";
import { AUDIO_SOURCE, AudioSource } from "../../runtime/components/AudioSource.js";
import { AUDIO_LISTENER, AudioListener } from "../../runtime/components/AudioListener.js";
import { TILESET, Tileset, TILE_ROLE_ORDER } from "../../runtime/components/Tileset.js";
import { TILEMAP, Tilemap, cellKey } from "../../runtime/components/Tilemap.js";
import { NAV_WORLD_2D, NavWorld2D, setNavAreaCost } from "../../runtime/components/NavWorld2D.js";
import { NAV_AGENT_2D, NavAgent2D, setNavAgentAreaCost } from "../../runtime/components/NavAgent2D.js";
import { bakeNavWorld } from "../../runtime/pathfinding/NavWorldBaker.js";
import { getColliderWorldGeometry } from "../../runtime/physics/ColliderGeometry.js";
import { sliceTilesetImageIntoRoles, loadSingleTileImage } from "../tileset/TilesetImport.js";
import { createEmptyClip } from "../panels/AnimationWindow.js";
import {
  importStandaloneImageFrames,
  importZipImageFrames,
  importSpriteSheetFrames,
  importGifFrames,
} from "../animation/AnimationImport.js";
import { importSpriteFiles, getSpriteAsset, importAudioFiles, registerSpriteAsset, deleteSpriteAsset, deleteAudioAsset } from "../../runtime/assets/AssetRegistry.js";
import { syncBackgroundColorLive, switchScene, syncAfterExternalSceneChange } from "../viewport/SceneViewport.js";
import { setPlayWindowPaused } from "../viewport/PlayWindow.js";
import { serializeEntity, instantiateEntity } from "../../runtime/scene/SceneSerializer.js";
import { SCRIPT, Script } from "../../runtime/components/Script.js";
import { createScript, getScriptSource } from "../scripting/ScriptStorage.js";
import { renameScriptEverywhere, deleteScriptEverywhere } from "../panels/ScriptEditorWindow.js";
import { openScriptEditor, handleScriptEditorAction } from "../panels/ScriptEditorWindow.js";
import { setLayerName } from "./PhysicsLayers.js";
import { setNavAreaName } from "./NavAreas.js";
import { addTag, deleteTag } from "./Tags.js";
import { snapshotNow, beginEdit, commitEdit, performUndoRedo } from "./UndoManager.js";
import { exportProject, importProject, downloadBlob } from "./ProjectIO.js";
import { buildExport, slugifyForFilename } from "../export/ExportGame.js";
import { applySnapshot } from "./ProjectStorage.js";
import { createPrefabFromEntity, getPrefab, getAllPrefabs, deletePrefab, renamePrefab } from "../../runtime/prefabs/PrefabRegistry.js";
import {
  snapshotEntityComponents,
  diffEntityAndRecordOverrides,
  updatePrefabFromEntity,
  revertInstanceToPrefab,
  unlinkFromPrefab,
} from "../../runtime/prefabs/PrefabPropagation.js";

// Live reachability of the Android build server for the Export popup badge.
// Checks once, and if the server isn't answering yet (e.g. a Replit host
// that is still waking up) keeps retrying every few seconds while the popup
// is open, so the badge flips to "awake" by itself instead of sticking on
// "asleep" until the popup is reopened. A newer call cancels older loops.
let _androidWatchToken = 0;
function refreshAndroidServerStatus(render) {
  const token = ++_androidWatchToken;
  editorState.androidServerStatus = "checking";
  const attempt = async (n) => {
    const awake = await checkAndroidServerAwake(getActiveAndroidServer());
    if (token !== _androidWatchToken || !editorState.exportOpen) return;
    const next = awake ? "awake" : "asleep";
    if (editorState.androidServerStatus !== next) {
      editorState.androidServerStatus = next;
      render();
    }
    if (!awake && n < 40) {
      await new Promise((r) => setTimeout(r, 4000));
      if (token === _androidWatchToken && editorState.exportOpen) attempt(n + 1);
    }
  };
  attempt(0);
}

// GameObject -> UI menu — maps each UI menu action to the entity name
// and component-add call it should perform. Mirrors the exact same 5
// components + labels AddComponentWindow.js's _computeAvailableToAdd
// already lists (Text/Speech Bubble/Chat Log/Text Input/Joystick) —
// this table exists only so Toolbar.js's UI_MENU_ITEMS data-ui-component
// value can look up "which addComponent call do I run", not to define
// any new component behavior.
const UI_COMPONENT_CREATORS = {
  TextRenderer: {
    label: "Text",
    entityName: "Text",
    addComponent: (entity) => entity.addComponent(TEXT_RENDERER, new TextRenderer()),
  },
  SpeechBubble: {
    label: "Speech Bubble",
    entityName: "Speech Bubble",
    addComponent: (entity) => entity.addComponent(SPEECH_BUBBLE, new SpeechBubble()),
  },
  ChatLog: {
    label: "Chat Log",
    entityName: "Chat Log",
    addComponent: (entity) => entity.addComponent(CHAT_LOG, new ChatLog()),
  },
  TextInput: {
    label: "Message Input",
    entityName: "Message Input",
    addComponent: (entity) => entity.addComponent(TEXT_INPUT, new TextInput()),
  },
  Joystick: {
    label: "Joystick",
    entityName: "Joystick",
    addComponent: (entity) => entity.addComponent(JOYSTICK, new Joystick()),
  },
};

const COMPONENT_TYPE_MAP = {
  Transform: TRANSFORM,
  Camera: CAMERA,
  SpriteRenderer: SPRITE_RENDERER,
  ShapeRenderer: SHAPE_RENDERER,
  StrokePath: STROKE_PATH,
  TextRenderer: TEXT_RENDERER,
  SpeechBubble: SPEECH_BUBBLE,
  ChatLog: CHAT_LOG,
  TextInput: TEXT_INPUT,
  Joystick: JOYSTICK,
  Rigidbody2D: RIGIDBODY_2D,
  Joint2D: JOINT_2D,
  Collider2D: COLLIDER_2D,
  CharacterController: CHARACTER_CONTROLLER,
  Light: LIGHT,
  ShadowCaster: SHADOW_CASTER,
  LightingSettings: LIGHTING_SETTINGS,
  SpriteAnimation: SPRITE_ANIMATION,
  AudioSource: AUDIO_SOURCE,
  AudioListener: AUDIO_LISTENER,
  Tileset: TILESET,
  Tilemap: TILEMAP,
  NavWorld2D: NAV_WORLD_2D,
  NavAgent2D: NAV_AGENT_2D,
  Script: SCRIPT,
};

// A scene may have at most this many Camera components across all its
// entities. Currently fixed at 1 (SceneLoader.js enforces the same rule
// at load-time — see its validateScene()). To support multiple cameras
// in a future version, raise this constant and remove/relax the
// blocking checks that reference it below (search for MAX_CAMERAS) —
// everything here reads from this single constant, so nothing else
// needs to change.
const MAX_CAMERAS = 1;

function _cameraCount(world) {
  if (!world) return 0;
  return world.query(CAMERA).length;
}

const LIGHT_ENTITY_NAMES = {
  [LightType.DIRECTIONAL]: "Directional Light",
  [LightType.POINT]: "Point Light",
  [LightType.SPOT]: "Spot Light",
  [LightType.AREA]: "Area Light",
  [LightType.GOD_RAYS]: "God Rays",
  [LightType.FREEFORM]: "Freeform Light",
};

// Freeform's `radius` field doubles as its edge FEATHER width (see
// LightTextureShaderSource.js's freeformFalloff), not a reach distance
// like every other light type — Light's own constructor default (200)
// is tuned for Point/Spot/GodRays reach and is far larger than
// DEFAULT_FREEFORM_POINTS' ~80px shape, which would feather the entire
// interior down to near-zero brightness instead of a crisp shape with
// a soft edge. Used only when creating/switching TO Freeform.
const FREEFORM_DEFAULT_FEATHER = 16;

/**
 * Builds sensible starting field overrides for a BRAND NEW Collider2D so
 * it roughly matches the entity's own sprite size instead of always
 * being Collider2D's raw default (width=1, height=1, radius=0.5,
 * trianglePoints ±0.5 — all sized for Rapier's ~1-unit "human scale"
 * assumption, see PhysicsWorld.js's LENGTH_UNIT_PX_PER_METER comment).
 * Since this engine treats collider width/height/radius as PIXELS
 * directly (that constant is just Rapier's internal solver rescaling,
 * it isn't a units-per-pixel conversion the user ever sees), a fresh
 * 1px collider next to a 64-256px sprite is invisible in both the
 * Scene view gizmo and the Animation panel's preview overlay — this is
 * what produces a collider outline too small to see ("can't even see
 * the dots" when set to Triangle, since ±0.5 points are ~1px wide).
 *
 * Reads the entity's SpriteRenderer.spriteKey (if any) to find its
 * actual pixel size via the asset registry, and returns override fields
 * sized to roughly fill that sprite — same "fit the frame" spirit as
 * the Animation panel's preview-stage scaling, just applied once at
 * creation time instead of every render. Returns {} (no overrides,
 * falls back to Collider2D's own defaults) if the entity has no sprite
 * yet, since there's nothing to size against.
 */
/**
 * Sizes a new/re-shaped Collider2D to match whatever's actually visible
 * on this entity, instead of leaving it at Collider2D's raw constructor
 * defaults (a 1x1 box / 0.5 radius) — those are meant as safe fallbacks
 * for an empty entity, not real sizes, and silently mismatching the
 * visible sprite/shape is a common "why doesn't my collider line up"
 * confusion.
 *
 * Prefers SpriteRenderer (an actual image has real pixel dimensions),
 * and falls back to ShapeRenderer when there's no sprite — e.g. a
 * GameObject created via GameObject -> Shape (see Toolbar.js's
 * SHAPE_MENU_ITEMS / EditorEvents.js's "create-shape" case), which has
 * a ShapeRenderer but never a SpriteRenderer. ShapeRenderer and
 * Collider2D intentionally use the same field names (width/height/
 * radius/capsuleHalfHeight/capsuleRadius/trianglePoints — see
 * ShapeRenderer.js's header comment), so the shape branch below is a
 * near-direct copy rather than a conversion. Also returns `shape`,
 * mapped from the ShapeRenderer's shapeType (SQUARE -> BOX, everything
 * else 1:1) — callers that don't want the shape touched (e.g. the
 * shape-switch re-seed logic above/below, which decides shape itself)
 * simply don't read that key off the returned object.
 *
 * Returns {} (no sizing) if the entity has neither a sized sprite nor a
 * ShapeRenderer — callers merge this into `new Collider2D(...)`, whose
 * own constructor defaults apply for any key left out.
 */
function _sizedColliderDefaults(entity) {
  const renderer = entity.getComponent(SPRITE_RENDERER);
  if (renderer && renderer.spriteKey) {
    const asset = getSpriteAsset(renderer.spriteKey);
    if (asset && asset.width && asset.height) {
      const w = asset.width;
      const h = asset.height;
      const shortSide = Math.min(w, h);
      return {
        width: w,
        height: h,
        radius: shortSide / 2,
        capsuleRadius: shortSide / 4,
        capsuleHalfHeight: Math.max(1, h / 2 - shortSide / 4),
        trianglePoints: [
          { x: -w / 2, y: h / 2 },
          { x: w / 2, y: h / 2 },
          { x: 0, y: -h / 2 },
        ],
      };
    }
  }

  const shapeRenderer = entity.getComponent(SHAPE_RENDERER);
  if (shapeRenderer) {
    return {
      shape: shapeRenderer.shapeType === ShapeType.SQUARE ? ColliderShape.BOX : shapeRenderer.shapeType,
      width: shapeRenderer.width,
      height: shapeRenderer.height,
      radius: shapeRenderer.radius,
      capsuleRadius: shapeRenderer.capsuleRadius,
      capsuleHalfHeight: shapeRenderer.capsuleHalfHeight,
      trianglePoints: shapeRenderer.trianglePoints.map((p) => ({ x: p.x, y: p.y })),
    };
  }

  return {};
}

/**
 * @param {() => void} render call this to re-render the editor after a
 *   state change
 * @param {() => void} onTogglePlay called when play/pause toggles, so
 *   main.js can start/stop the GameLoop
 */
export function attachEditorEvents(render, onTogglePlay) {
  // Coming back to this tab (typically after opening the server's page to
  // wake it) re-checks the build server right away.
  const recheckAndroidServerOnReturn = () => {
    if (document.visibilityState === "hidden") return;
    if (editorState.exportOpen && editorState.androidServerStatus !== "awake") {
      refreshAndroidServerStatus(render);
      render();
    }
  };
  window.addEventListener("focus", recheckAndroidServerOnReturn);
  document.addEventListener("visibilitychange", recheckAndroidServerOnReturn);
let _lastSceneClick = { id: null, time: 0 };

  // Generic touchpad-safe double-click tracker for every [data-dblclick-action]
  // element (script rename, scene rename label, and any future one). The
  // native "dblclick" event this used to rely on is unreliable on laptop
  // trackpads (the OS double-click distance/timing threshold can differ
  // from the browser's, so dblclick sometimes just never fires) and
  // doesn't survive a DOM rebuild between the two clicks (render()
  // replaces app.innerHTML, so the second click lands on a brand-new
  // element even though it looks like the same one). Tracking timestamp +
  // the identifying data-* value ourselves on the regular "click" event
  // sidesteps both problems — same approach already proven for scene-file
  // switching (_lastSceneClick above) and freeform light vertex insertion
  // (SceneViewport.js's _lastFreeformClick).
  let _lastDblClickTarget = { key: null, time: 0 };
  const DBLCLICK_MS = 500;
  // Tracks the single Hierarchy row (folder or scene-root) currently
  // showing the drag-over highlight (see the "dragover" listener
  // below), so it can be cleared the instant the pointer moves off it
  // — without this, the highlight class could get left stuck on an
  // element after the pointer moves past it faster than dragover fires.
  let _lastHierDropHighlight = null;
  /**
   * Call from inside the delegated click handler with the raw e.target
   * (NOT `t`, the element matched by closest("[data-action]")) — a
   * [data-dblclick-action] element (e.g. an asset's rename label) is
   * typically a DESCENDANT of the [data-action] tile that wraps it
   * (e.g. the sprite/audio/script asset-item, whose data-action opens
   * or drags it), never the same element or an ancestor of it. Starting
   * the closest() search from `t` instead of the real event target was
   * a bug: closest() only walks up the tree, so it could never find a
   * data-dblclick-action span nested *inside* the already-matched `t`,
   * silently making rename-on-label unreachable for every asset kind
   * (only scenes worked, via their own separate _lastSceneClick
   * tracker below). Returns true (and fires the dblclick action) if
   * this click is the second half of a double click on the same
   * [data-dblclick-action] element; false otherwise (including:
   * element has no data-dblclick-action ancestor at all).
   */
  function _checkDblClick(eventTarget) {
    const dblTarget = eventTarget.closest("[data-dblclick-action]");
    if (!dblTarget) return false;
    const action = dblTarget.dataset.dblclickAction;
    // Key on the action plus every data-* attribute the element carries
    // besides dblclickAction/action itself (sceneId, script, etc.) so two
    // different rows with the same action never get confused for one
    // double click across a re-render.
    const key = action + "|" + JSON.stringify(dblTarget.dataset);
    const now = Date.now();
    if (_lastDblClickTarget.key === key && now - _lastDblClickTarget.time < DBLCLICK_MS) {
      _lastDblClickTarget = { key: null, time: 0 };
      if (action === "rename-scene-start") {
        editorState.renamingSceneId = dblTarget.dataset.sceneId;
        render();
      } else if (action === "rename-folder-start") {
        editorState.renamingFolderId = dblTarget.dataset.folderId;
        render();
      } else if (action === "rename-asset-start") {
        editorState.renamingAsset = { kind: dblTarget.dataset.assetKind, key: dblTarget.dataset.assetKey };
        render();
      } else if (action === "script-rename") {
        handleScriptEditorAction("script-rename", dblTarget);
      }
      return true;
    }
    _lastDblClickTarget = { key, time: now };
    // This is only the FIRST half of a double click, but it still landed
    // on a rename label — e.g. clicking a script's label the first time.
    // Without this, the click would fall through to the enclosing tile's
    // single-click action (open-script-from-folder, etc.) before the
    // second click ever arrives, so a script's editor would flash open
    // on every rename attempt. Swallow single clicks on the label itself
    // so only a genuine double-click has any effect there; clicking
    // elsewhere on the same tile (the thumbnail, empty tile space) still
    // reaches the normal single-click action untouched.
    return true;
  }

  function _handleAction(e, t) {
    // Second half of a double click on a [data-dblclick-action] element
    // (script rename / scene rename label) — handled and consumed here,
    // BEFORE the single-click data-action below runs, so double-clicking
    // never also triggers whatever the single click on that same element
    // would otherwise do (e.g. script-folder-open).
    if (_checkDblClick(e.target)) return;
    const action = t.dataset.action;

    // Any click on a real action target OTHER than the menu/submenu
    // toggles themselves (or a light/entity creation, which already
    // closes the menu above) should also close a stray open dropdown —
    // e.g. clicking a tool button while GameObject menu happens to be
    // open. Handled here rather than per-case so it's automatic for
    // every current and future action.
    if (editorState.openMenu && action !== "toggle-menu" && action !== "toggle-submenu" && action !== "create-light" && action !== "add-entity" && action !== "open-physics-layers" && action !== "open-nav-areas" && action !== "toggle-panel" && action !== "reset-panels") {
      editorState.openMenu = null;
      editorState.openSubmenu = null;
    }

    // Script editor overlay actions — delegated to ScriptEditorWindow.
    // NOTE: "script-picker-choose" and "open-script-picker" / "close-script-picker"
    // are handled by the switch below (they belong to ScriptPickerWindow, not
    // ScriptEditorWindow) and must be excluded here, or this prefix check
    // swallows them before they ever reach their real case, silently doing
    // nothing on click.
    if (
      action &&
      action.indexOf("script-") === 0 &&
      action !== "script-picker-choose"
    ) {
      handleScriptEditorAction(action, t);
      return;
    }

    switch (action) {
      case "set-tool": {
        const requested = t.dataset.tool;
        const world = editorState.world;
        const hasTilemap = !!world && world.query(TILEMAP).length > 0;
        const hasTileset = !!world && world.query(TILESET).length > 0;
        const hasNavWorld = !!world && world.query(NAV_WORLD_2D).length > 0;
        const hasStrokePath = !!world && world.query(STROKE_PATH).length > 0;
        const allowed =
          requested === "pan" || requested === "translate" || requested === "rotate" || requested === "scale" ||
          ((requested === "path") && hasStrokePath) ||
          ((requested === "tile") && (hasTilemap || hasTileset)) ||
          ((requested === "erase") && (hasTilemap || hasNavWorld)) ||
          ((requested === "nav") && hasNavWorld) ||
          ((requested === "nav-block") && hasNavWorld) ||
          ((requested === "nav-area") && hasNavWorld);
        if (allowed) editorState.activeTool = requested;
        else editorState.activeTool = "translate";
        render();
        break;
      }
      case "set-navworld-view": {
        const mode = t.dataset.view === "cells" ? "cells" : "bounds";
        editorState.navWorldViewMode = mode;
        editorState.showNavWorld = true;
        render();
        break;
      }
      case "nav-brush-decrease":
        editorState.navBrushRadius = Math.max(0, editorState.navBrushRadius - 1);
        render();
        break;
      case "nav-brush-increase":
        editorState.navBrushRadius = Math.min(32, editorState.navBrushRadius + 1);
        render();
        break;
      case "toggle-play":
        editorState.isPlaying = !editorState.isPlaying;
        editorState.isPaused = false;
        onTogglePlay(editorState.isPlaying);
        render();
        break;
      case "toggle-pause":
        if (editorState.isPlaying) {
          editorState.isPaused = !editorState.isPaused;
          // Actually freeze/resume the popup's running game (see
          // GameLoop.pause()/resume()) — previously this only flipped
          // the toolbar's own cosmetic state and never touched the
          // live game loop at all, so the Pause button visually looked
          // pressed but gameplay kept right on running underneath it.
          setPlayWindowPaused(editorState.isPaused);
          render();
        }
        break;
      case "select-entity": {
        const id = t.dataset.id;
        if (e.shiftKey) {
          // Shift+click toggles membership for multi-select.
          const idx = editorState.selectedIds.indexOf(id);
          if (idx >= 0) editorState.selectedIds.splice(idx, 1);
          else editorState.selectedIds.push(id);
          editorState.selectedId = editorState.selectedIds.length
            ? editorState.selectedIds[editorState.selectedIds.length - 1]
            : null;
        } else {
          editorState.selectedId = id;
          editorState.selectedIds = [id];
        }
        render();
        break;
      }
      case "toggle-section": {
        const k = t.dataset.key;
        editorState.sectionsOpen[k] = !(editorState.sectionsOpen[k] !== false);
        render();
        break;
      }
      case "open-anim":
        editorState.animOpen = true;
        // Reset panel-local UI state (not the actual clip DATA, which
        // lives on the component) so re-opening the panel — possibly
        // for a DIFFERENT entity than last time — doesn't show a stale
        // "editing clip" id or preview frame from a previous session.
        editorState.anim.editingClipId = null;
        editorState.anim.previewFrameIndex = 0;
        editorState.anim.previewPlaying = false;
        editorState.anim.renamingClipId = null;
        render();
        break;
      case "open-script-editor": {
        var scriptEntity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (scriptEntity) {
          var scriptComp = scriptEntity.getComponent(SCRIPT);
          if (scriptComp) {
            openScriptEditor(scriptComp.scriptName, scriptComp.source, editorState.selectedId);
          }
        }
        break;
      }
      case "open-script-from-folder": {
        var folderScriptName = t.dataset.script;
        if (folderScriptName) {
          openScriptEditor(folderScriptName, getScriptSource(folderScriptName), null);
        }
        break;
      }
      case "inspector-create-script": {
        var newEnt = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (newEnt) {
          var existingScriptComp = newEnt.getComponent(SCRIPT);
          // Entity may already carry a Script component with no
          // scriptName (its previous script was deleted — see
          // ScriptEditorWindow.js's _clearScriptOnEntities). In that
          // case fill it in rather than addComponent()'ing a second
          // one, which Entity likely just silently no-ops or replaces
          // anyway but isn't the intent here.
          if (existingScriptComp && !existingScriptComp.scriptName) {
            snapshotNow("scene");
            var filledScriptName = createScript(null);
            existingScriptComp.scriptName = filledScriptName;
            existingScriptComp.source = getScriptSource(filledScriptName);
            existingScriptComp.enabled = true;
            pushLog("log", "Created and attached script '" + filledScriptName + "' to '" + newEnt.name + "'.");
            openScriptEditor(filledScriptName, getScriptSource(filledScriptName), editorState.selectedId);
          } else if (!existingScriptComp) {
            snapshotNow("scene");
            var newScriptName = createScript(null);
            newEnt.addComponent(SCRIPT, new Script({ scriptName: newScriptName, source: getScriptSource(newScriptName) }));
            pushLog("log", "Created and attached script '" + newScriptName + "' to '" + newEnt.name + "'.");
            openScriptEditor(newScriptName, getScriptSource(newScriptName), editorState.selectedId);
          }
        }
        break;
      }
      case "toggle-script-enabled": {
        var scriptEntity2 = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (scriptEntity2) {
          var scriptComp2 = scriptEntity2.getComponent(SCRIPT);
          if (scriptComp2) {
            snapshotNow("scene");
            scriptComp2.enabled = !scriptComp2.enabled;
            render();
          }
        }
        break;
      }
      case "close-anim":
        editorState.animOpen = false;
        editorState.anim.previewPlaying = false;
        render();
        break;
      case "open-physics-layers":
        editorState.physicsLayersOpen = true;
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      case "close-physics-layers":
        editorState.physicsLayersOpen = false;
        render();
        break;
      case "open-nav-areas":
        editorState.navAreasOpen = true;
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      case "close-nav-areas":
        editorState.navAreasOpen = false;
        render();
        break;
      case "open-script-picker":
        editorState.scriptPickerOpen = true;
        render();
        break;
      case "close-script-picker":
        editorState.scriptPickerOpen = false;
        render();
        break;
      case "script-picker-choose": {
        var pickedName = t.dataset.script;
        var pickerEnt = editorState.world && editorState.world.getEntity(editorState.selectedId);
        var _openedEditor = false;
        if (pickerEnt && pickedName) {
          var existingPickComp = pickerEnt.getComponent(SCRIPT);
          // Same "empty Script component left behind by a deleted
          // script" case as inspector-create-script above: fill it in
          // instead of trying (and failing) to add a second component.
          if (existingPickComp && !existingPickComp.scriptName) {
            snapshotNow("scene");
            existingPickComp.scriptName = pickedName;
            existingPickComp.source = getScriptSource(pickedName);
            existingPickComp.enabled = true;
            pushLog("log", "Attached script '" + pickedName + "' to '" + pickerEnt.name + "'.");
            openScriptEditor(pickedName, getScriptSource(pickedName), editorState.selectedId);
            _openedEditor = true;
          } else if (!existingPickComp) {
            snapshotNow("scene");
            pickerEnt.addComponent(SCRIPT, new Script({ scriptName: pickedName, source: getScriptSource(pickedName) }));
            pushLog("log", "Attached script '" + pickedName + "' to '" + pickerEnt.name + "'.");
            openScriptEditor(pickedName, getScriptSource(pickedName), editorState.selectedId);
            _openedEditor = true;
          }
        }
        editorState.scriptPickerOpen = false;
        // openScriptEditor() (when it ran) already triggered a full
        // render — a second synchronous render right after would
        // regenerate #se-monaco-container again while Monaco may still
         // be mid-load from local vendor files, which is unnecessary churn. But if
        // neither branch above ran (entity already had a named script,
        // or nothing was selected), nothing has rendered the picker
        // closing yet, so we still need this render for that case.
        if (!_openedEditor) render();
        break;
      }
      case "open-sprite-picker":
        // data-target lets a caller other than the SpriteRenderer
        // section (e.g. StrokePath's texture-pick button — see
        // Inspector.js) specify which component the pick should land
        // on; omitted, it defaults back to SpriteRenderer so every
        // existing call site (which never set data-target) keeps
        // behaving exactly as before.
        editorState.spritePickerTarget = t.dataset.target || "SpriteRenderer";
        editorState.spritePickerOpen = true;
        render();
        break;
      case "close-sprite-picker":
        editorState.spritePickerOpen = false;
        render();
        break;
      case "sprite-picker-choose": {
        // Opened from either the Sprite Renderer section's "sprite-pick"
        // button or the StrokePath section's texture-pick button (see
        // Inspector.js) — editorState.spritePickerTarget (set when the
        // picker was opened, just above) decides which one this
        // particular pick applies to, since both share this same modal.
        var pickedSpriteKey = t.dataset.spriteKey;
        var spritePickEnt = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (editorState.spritePickerTarget === "StrokePath") {
          var strokePathForPick = spritePickEnt && spritePickEnt.getComponent(STROKE_PATH);
          if (strokePathForPick && pickedSpriteKey) {
            snapshotNow("scene");
            strokePathForPick.textureKey = pickedSpriteKey;
            var pickedTextureAsset = getSpriteAsset(pickedSpriteKey);
            pushLog("log", "Set Stroke Path texture to '" + (pickedTextureAsset ? pickedTextureAsset.name : pickedSpriteKey) + "' on '" + spritePickEnt.name + "'.");
          }
        } else if (editorState.spritePickerTarget === "Joint2D") {
          var jointForPick = spritePickEnt && spritePickEnt.getComponent(JOINT_2D);
          if (jointForPick && pickedSpriteKey) {
            snapshotNow("scene");
            jointForPick.textureKey = pickedSpriteKey;
            var pickedJointTextureAsset = getSpriteAsset(pickedSpriteKey);
            pushLog("log", "Set Joint 2D texture to '" + (pickedJointTextureAsset ? pickedJointTextureAsset.name : pickedSpriteKey) + "' on '" + spritePickEnt.name + "'.");
          }
        } else {
          var spritePickRenderer = spritePickEnt && spritePickEnt.getComponent(SPRITE_RENDERER);
          if (spritePickRenderer && pickedSpriteKey) {
            snapshotNow("scene");
            spritePickRenderer.spriteKey = pickedSpriteKey;
            var pickedAsset = getSpriteAsset(pickedSpriteKey);
            pushLog("log", "Set sprite to '" + (pickedAsset ? pickedAsset.name : pickedSpriteKey) + "' on '" + spritePickEnt.name + "'.");
          }
        }
        editorState.spritePickerOpen = false;
        render();
        break;
      }
      case "open-tileset-editor":
        editorState.tilesetPanel.open = true;
        editorState.tilesetPanel.entityId = t.dataset.entity || editorState.selectedId;
        editorState.tilesetPanel.draggingRole = null;
        render();
        break;
      case "close-tileset-editor":
        editorState.tilesetPanel.open = false;
        editorState.tilesetPanel.draggingRole = null;
        render();
        break;
      case "anim-new-clip": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (!entity) break;
        snapshotNow("anim");
        let anim = entity.getComponent(SPRITE_ANIMATION);
        if (!anim) {
          anim = new SpriteAnimation();
          entity.addComponent(SPRITE_ANIMATION, anim);
        }
        const clip = createEmptyClip(anim.clips.map((c) => c.name));
        anim.clips.push(clip);
        if (!anim.currentClipId) anim.currentClipId = clip.id;
        editorState.anim.editingClipId = clip.id;
        editorState.anim.previewFrameIndex = 0;
        editorState.anim.previewPlaying = false;
        pushLog("log", "Created animation clip '" + clip.name + "' on '" + entity.name + "'.");
        render();
        break;
      }
      case "anim-rename-clip": {
        editorState.anim.renamingClipId = t.dataset.clipId;
        render();
        break;
      }
      case "anim-toggle-show-collider": {
        editorState.anim.showColliderInPreview = !editorState.anim.showColliderInPreview;
        render();
        break;
      }
      case "anim-delete-clip": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const anim = entity && entity.getComponent(SPRITE_ANIMATION);
        if (!anim) break;
        snapshotNow("anim");
        const clipId = t.dataset.clipId;
        const clip = anim.clips.find((c) => c.id === clipId);
        anim.clips = anim.clips.filter((c) => c.id !== clipId);
        if (anim.currentClipId === clipId) {
          anim.currentClipId = anim.clips.length ? anim.clips[0].id : null;
          anim.currentFrameIndex = 0;
          anim.frameElapsed = 0;
        }
        if (editorState.anim.editingClipId === clipId) {
          editorState.anim.editingClipId = null; // re-picked to the new first clip on next render
          editorState.anim.previewFrameIndex = 0;
        }
        if (clip) pushLog("log", "Deleted animation clip '" + clip.name + "'.");
        render();
        break;
      }
      case "anim-preview-step": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const anim = entity && entity.getComponent(SPRITE_ANIMATION);
        const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
        if (!clip || clip.frames.length === 0) break;
        const dir = parseInt(t.dataset.dir, 10) || 1;
        editorState.anim.previewFrameIndex =
          (editorState.anim.previewFrameIndex + dir + clip.frames.length) % clip.frames.length;
        render();
        break;
      }
      case "anim-preview-toggle-play": {
        editorState.anim.previewPlaying = !editorState.anim.previewPlaying;
        render();
        break;
      }
      case "anim-toggle-loop": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const anim = entity && entity.getComponent(SPRITE_ANIMATION);
        const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
        if (clip) {
          snapshotNow("anim");
          clip.loop = t.checked;
        }
        render();
        break;
      }
      case "anim-toggle-collider-override": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const anim = entity && entity.getComponent(SPRITE_ANIMATION);
        const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
        if (!clip) break;
        snapshotNow("anim");
        if (t.checked) {
          // Seed from the entity's OWN current Collider2D (if any) so
          // the toggle starts from something visible/sensible, same
          // reasoning as the Inspector's identical toggle in the
          // "toggle-clip-collider-override" case above — kept as two
          // separate cases (rather than merged) because this one reads
          // editorState.anim.editingClipId (the panel's own concept of
          // "which clip is open") while the Inspector's reads a
          // data-clip-id straight off the clicked element; unifying
          // them would require threading one convention into the
          // other's caller for no real benefit.
          const collider = entity.getComponent(COLLIDER_2D);
          const seed = collider ? new Collider2D({ ...collider }) : new Collider2D(_sizedColliderDefaults(entity));
          clip.colliderOverride = { ...seed };
        } else {
          clip.colliderOverride = null;
        }
        render();
        break;
      }
      case "anim-delete-frame": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const anim = entity && entity.getComponent(SPRITE_ANIMATION);
        const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
        if (!clip) break;
        snapshotNow("anim");
        const idx = parseInt(t.dataset.frameIndex, 10);
        clip.frames.splice(idx, 1);
        if (editorState.anim.previewFrameIndex >= clip.frames.length) {
          editorState.anim.previewFrameIndex = Math.max(0, clip.frames.length - 1);
        }
        render();
        break;
      }
      case "tab-project":
        editorState.bottomTab = "project";
        render();
        break;
      case "tab-console":
        editorState.bottomTab = "console";
        render();
        break;
      case "clear-console":
        editorState.logs = [];
        render();
        break;
      case "copy-console": {
        const text = editorState.logs.map((l) => "[" + l.type.toUpperCase() + "] " + l.msg).join("\n");
        const onCopied = () => pushLog("log", "Copied " + editorState.logs.length + " console line(s) to clipboard.");
        const onFailed = (err) => pushLog("error", "Failed to copy console to clipboard: " + err.message);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(onCopied, onFailed);
        } else {
          // Fallback for contexts without the async Clipboard API
          // (e.g. non-HTTPS/local file preview): a hidden textarea +
          // execCommand("copy") still works in every browser.
          try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            onCopied();
          } catch (err) {
            onFailed(err);
          }
        }
        render();
        break;
      }
      case "add-entity": {
        if (!editorState.world) break;
        snapshotNow("scene");
        const entity = editorState.world.createEntity("GameObject");
        entity.addComponent(TRANSFORM, new Transform());
        editorState.selectedId = entity.id;
        editorState.selectedIds = [entity.id];
        pushLog("log", "Created GameObject '" + entity.name + "'.");
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "add-hierarchy-folder": {
        if (!editorState.world) break;
        snapshotNow("scene");
        const folder = editorState.world.createHierarchyFolder("New Folder");
        editorState.renamingFolderId = folder.id;
        pushLog("log", "Created folder '" + folder.name + "'.");
        render();
        break;
      }
      case "toggle-hierarchy-folder": {
        if (!editorState.world) break;
        const folder = editorState.world.getHierarchyFolder(t.dataset.folderId);
        // Purely a view-state flip (which rows are visible), not scene
        // data being edited — deliberately NOT wrapped in snapshotNow,
        // matching sectionsOpen's "toggle-section" case just above,
        // which is the same kind of expand/collapse UI toggle. Folder
        // expanded state IS still saved with the scene (it lives on
        // World.hierarchyFolders, see SceneSerializer.js), it just
        // isn't its own separate undo step.
        if (folder) folder.expanded = folder.expanded === false;
        render();
        break;
      }
      case "delete-hierarchy-folder": {
        if (!editorState.world) break;
        const folderId = t.dataset.folderId;
        const folder = editorState.world.getHierarchyFolder(folderId);
        if (!folder) break;
        // No confirm() dialog here, unlike delete-sprite-asset/delete-
        // audio-asset/delete-script-asset above: those permanently
        // destroy content every object referencing them would then be
        // missing. Deleting a folder is non-destructive to scene
        // content — deleteHierarchyFolder() reparents everything inside
        // it up one level (see World.js) rather than deleting it — so
        // it's undo-able the same lightweight way any other Hierarchy
        // edit is, without an extra confirmation click.
        snapshotNow("scene");
        editorState.world.deleteHierarchyFolder(folderId);
        pushLog("log", "Deleted folder '" + folder.name + "'.");
        render();
        break;
      }
      case "create-prefab": {
        // "Create Prefab" on the currently-selected entity: snapshots its
        // CURRENT component data into a brand-new catalogue entry (see
        // PrefabRegistry.createPrefabFromEntity), then links the source
        // entity itself to it — so the entity you just made a prefab
        // FROM immediately behaves like any other instance (has a Prefab
        // strip in the Inspector, tracks overrides, can push updates),
        // exactly like Unity dragging an object into the Project window.
        if (!editorState.world) break;
        const entity = editorState.world.getEntity(editorState.selectedId);
        if (!entity) break;
        if (entity.prefabId && getPrefab(entity.prefabId)) {
          pushLog("warn", "'" + entity.name + "' is already a prefab instance.");
          break;
        }
        snapshotNow("scene");
        const record = createPrefabFromEntity(entity);
        entity.prefabId = record.id;
        entity.prefabOverrides = {};
        pushLog("log", "Created prefab '" + record.name + "' from '" + entity.name + "'.");
        render();
        break;
      }
      case "update-prefab": {
        // "Update Prefab": pushes the SELECTED instance's current data
        // out as the prefab's new canonical template, propagating every
        // non-overridden field to every other instance across every
        // scene — see PrefabPropagation.updatePrefabFromEntity's own doc
        // comment for the full mechanism (override-respecting, reaches
        // both the live World and every other stored-but-not-loaded
        // scene). This is a much bigger edit than a normal field tweak
        // (it can touch entities in scenes that aren't even open), but
        // still goes through the same "scene" undo stack as everything
        // else — snapshotNow() here captures the WHOLE live World before
        // the push, so undo can restore this scene's instances; the
        // other (inactive) scenes' propagated changes are NOT covered by
        // this undo step (undo only ever round-trips through the live
        // World's own serializeScene/deserializeScene, see UndoManager.js's
        // own doc comment on scope) — acceptable here since propagating
        // to scenes you aren't looking at is meant to be a deliberate,
        // rarely-undone action, not a per-keystroke edit.
        if (!editorState.world) break;
        const entity = editorState.world.getEntity(editorState.selectedId);
        if (!entity || !entity.prefabId) break;
        snapshotNow("scene");
        const applyPosition = !!document.querySelector('[data-action="prefab-update-apply-position"]')?.checked;
        const applyRotation = !!document.querySelector('[data-action="prefab-update-apply-rotation"]')?.checked;
        const applyScale = !!document.querySelector('[data-action="prefab-update-apply-scale"]')?.checked;
        const result = updatePrefabFromEntity(editorState.world, entity, { applyPosition, applyRotation, applyScale });
        if (!result) {
          pushLog("error", "Couldn't update prefab — it may have been deleted from the project.");
        } else {
          const prefab = getPrefab(entity.prefabId);
          pushLog(
            "log",
            "Updated prefab '" + (prefab ? prefab.name : entity.name) + "' — " +
              result.updatedInstanceCount + " other instance(s) updated."
          );
        }
        render();
        break;
      }
      case "revert-prefab": {
        if (!editorState.world) break;
        const entity = editorState.world.getEntity(editorState.selectedId);
        if (!entity || !entity.prefabId) break;
        snapshotNow("scene");
        const changed = revertInstanceToPrefab(entity);
        pushLog("log", changed ? "Reverted '" + entity.name + "' to its prefab." : "'" + entity.name + "' already matches its prefab.");
        render();
        break;
      }
      case "unpack-prefab": {
        if (!editorState.world) break;
        const entity = editorState.world.getEntity(editorState.selectedId);
        if (!entity || !entity.prefabId) break;
        snapshotNow("scene");
        unlinkFromPrefab(entity);
        pushLog("log", "Unpacked '" + entity.name + "' from its prefab.");
        render();
        break;
      }
      case "cancel-android-build": {
        if (!isAndroidBuildActive()) break;
        editorState.exportStatus = { phase: "running", message: "Cancelling build\u2026" };
        render();
        // Aborts our requests + tells the server to stop the job and move
        // on to the next one in its queue. The running export chain then
        // lands in its .catch() above, which resets the popup.
        cancelAndroidBuild();
        break;
      }
      case "toggle-panel": {
        const id = t.dataset.panel;
        if (!PANEL_IDS.includes(id)) break;
        editorState.panelVisible = { ...editorState.panelVisible, [id]: !editorState.panelVisible[id] };
        savePanelVisibility(editorState.panelVisible);
        render();
        break;
      }
      case "reset-panels": {
        editorState.panelVisible = defaultPanelVisibility();
        savePanelVisibility(editorState.panelVisible);
        render();
        break;
      }
      case "toggle-menu": {
        const menu = t.dataset.menu;
        editorState.openMenu = editorState.openMenu === menu ? null : menu;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "toggle-submenu": {
        const submenu = t.dataset.submenu;
        editorState.openSubmenu = editorState.openSubmenu === submenu ? null : submenu;
        render();
        break;
      }
      case "create-light": {
        if (!editorState.world) break;
        snapshotNow("scene");
        const lightType = t.dataset.lightType || LightType.POINT;
        const name = LIGHT_ENTITY_NAMES[lightType] || "Light";
        const entity = editorState.world.createEntity(name);
        entity.addComponent(TRANSFORM, new Transform());
        entity.addComponent(
          LIGHT,
          new Light(
            lightType === LightType.FREEFORM ? { type: lightType, radius: FREEFORM_DEFAULT_FEATHER } : { type: lightType }
          )
        );
        editorState.selectedId = entity.id;
        editorState.selectedIds = [entity.id];
        pushLog("log", "Created " + name + ".");
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "create-tileset": {
        if (!editorState.world) break;
        snapshotNow("scene");
        const entity = editorState.world.createEntity("Tileset");
        entity.addComponent(TRANSFORM, new Transform());
        entity.addComponent(TILESET, new Tileset());
        editorState.selectedId = entity.id;
        editorState.selectedIds = [entity.id];
        pushLog("log", "Created Tileset.");
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "create-tilemap": {
        if (!editorState.world) break;
        snapshotNow("scene");
        const entity = editorState.world.createEntity("Tilemap");
        entity.addComponent(TRANSFORM, new Transform());
        entity.addComponent(TILEMAP, new Tilemap());
        editorState.selectedId = entity.id;
        editorState.selectedIds = [entity.id];
        pushLog("log", "Created Tilemap. Assign a Tileset in the Inspector, then use the Tile tool (T) to paint.");
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "create-navworld": {
        if (!editorState.world) break;
        snapshotNow("scene");
        const entity = editorState.world.createEntity("NavWorld2D");
        entity.addComponent(TRANSFORM, new Transform());
        entity.addComponent(NAV_WORLD_2D, new NavWorld2D());
        editorState.selectedId = entity.id;
        editorState.selectedIds = [entity.id];
        editorState.showNavWorld = true;
        editorState.navWorldViewMode = "bounds";
        pushLog("log", "Created Nav World 2D. Click \"Bake Nav World\" in the Inspector to auto-fill it from colliders, then fine-tune with the Nav tool (U). Add a Nav Agent 2D component to any entity that should move over it.");
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "create-strokepath": {
        if (!editorState.world) break;
        snapshotNow("scene");
        const entity = editorState.world.createEntity("Stroke Path");
        entity.addComponent(TRANSFORM, new Transform());
        entity.addComponent(STROKE_PATH, new StrokePath());
        editorState.selectedId = entity.id;
        editorState.selectedIds = [entity.id];
        editorState.activeTool = "path";
        pushLog("log", "Created Stroke Path with 2 starting points. Use the Path tool (P) to click and add more points, drag any point to adjust it, or click a segment to insert one between two points.");
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "create-shape": {
        // GameObject -> Shape -> (Square/Circle/Capsule/Triangle).
        // Creates a plain GameObject with a ShapeRenderer (so it's
        // visible) AND a matching Collider2D (so it collides/falls
        // like any other physics object) both set to the chosen shape
        // — ShapeRenderer's ShapeType and Collider2D's ColliderShape
        // are the same 4-value enum (BOX is just called SQUARE on the
        // renderer side, see ShapeRenderer.js's own header comment),
        // so the two stay visually matched from the moment of
        // creation. No new component types — both already exist and
        // are constructed exactly the way AddComponentWindow.js's
        // "ShapeRenderer"/"Collider2D" add-component cases do.
        if (!editorState.world) break;
        snapshotNow("scene");
        const shapeType = t.dataset.shapeType || ShapeType.SQUARE;
        const entity = editorState.world.createEntity(shapeType);
        entity.addComponent(TRANSFORM, new Transform());
        entity.addComponent(SHAPE_RENDERER, new ShapeRenderer({ shapeType }));
        // Size the Collider2D off the ShapeRenderer that was just added
        // (_sizedColliderDefaults reads width/height/radius/etc straight
        // off it and also derives `shape` from shapeType) instead of
        // passing only `shape` — Collider2D's own constructor defaults
        // are a 1x1 box / 0.5 radius, which silently mismatched every
        // shape created this way (e.g. a 100x100 Square got a 1x1
        // collider) until this used the sized defaults like every other
        // Collider2D creation path does.
        entity.addComponent(COLLIDER_2D, new Collider2D(_sizedColliderDefaults(entity)));
        editorState.selectedId = entity.id;
        editorState.selectedIds = [entity.id];
        pushLog("log", "Created " + shapeType + " (Shape Renderer + Collider 2D).");
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "create-ui": {
        // UI menu shortcuts (Text / Speech Bubble / Chat Log / Message
        // Input / Joystick) — each just creates an empty GameObject and
        // attaches the ONE matching component, same shortcut pattern as
        // "create-light" above (plain entity + a single component).
        // Component names/labels/defaults are the exact same ones
        // AddComponentWindow.js already exposes via its own Add
        // Component list — nothing new is defined here.
        if (!editorState.world) break;
        const componentName = t.dataset.uiComponent;
        const item = UI_COMPONENT_CREATORS[componentName];
        if (!item) break;
        snapshotNow("scene");
        const entity = editorState.world.createEntity(item.entityName);
        entity.addComponent(TRANSFORM, new Transform());
        item.addComponent(entity);
        editorState.selectedId = entity.id;
        editorState.selectedIds = [entity.id];
        pushLog("log", "Created " + item.entityName + " (" + item.label + ").");
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "toggle-entity-active": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (entity) {
          snapshotNow("scene");
          entity.active = !entity.active;
        }
        render();
        break;
      }
      case "toggle-navworld-view": {
        editorState.showNavWorld = !editorState.showNavWorld;
        render();
        break;
      }
      case "toggle-component-notes": {
        const nowOn = !document.body.classList.contains("show-component-notes");
        setEngineSettings({ showComponentNotes: nowOn });
        // Note visibility is a pure CSS gate rather than re-rendering
        // every Inspector string, so it applies instantly across every
        // open section.
        document.body.classList.toggle("show-component-notes", nowOn);
        render();
        break;
      }
      case "bake-navworld": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const navWorld = entity && entity.getComponent(NAV_WORLD_2D);
        if (!entity || !navWorld) break;
        snapshotNow("scene");
        const navTransform = entity.getComponent(TRANSFORM);
        const { walkable, blocked } = bakeNavWorld(navWorld, editorState.world, navTransform);
        editorState.showNavWorld = true;
        editorState.navWorldViewMode = "bounds";
        pushLog("log", "Baked Nav World 2D on '" + entity.name + "': " + walkable + " walkable, " + blocked + " blocked cells.");
        render();
        break;
      }
      // "Show Agent Navigation" — Inspector.js's NavAgent2D section.
      // Pins editorState.navAgentPreviewEntityId to the currently
      // selected agent so NavWorldGizmo.js draws THAT agent's radius-
      // eroded layer instead of the plain base cell grid — this is the
      // "when a NavAgent2D is selected, allow the developer to preview
      // the navigation from that agent's perspective" requirement.
      // Toggles off (back to the normal showNavWorld view) if the same
      // agent is clicked again while already previewed.
      case "toggle-nav-agent-preview": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (!entity || !entity.hasComponent(NAV_AGENT_2D)) break;
        editorState.navAgentPreviewEntityId =
          editorState.navAgentPreviewEntityId === entity.id ? null : entity.id;
        render();
        break;
      }
      // "Match Collider" — Inspector.js's NavAgent2D section. Sets
      // NavAgent2D.radius from this entity's OWN Collider2D (in world
      // units, after Transform.scale) instead of leaving it at whatever
      // fixed number the field happened to start at. A default 100x100
      // box collider needs a NavAgent2D.radius of roughly 60-80 to keep
      // the agent's own body clear of a same-sized obstacle standing
      // next to it — see the bounding-radius math below — but the field
      // itself has no way to know an entity's actual size, so this
      // button is the fix rather than trying to guess a better constant
      // default. Uses the collider's bounding CIRCLE (half-diagonal for
      // a box/triangle, not half-width), so a corner clipping into
      // geometry is accounted for even when approaching at an angle.
      case "match-navagent-radius": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const navAgent = entity && entity.getComponent(NAV_AGENT_2D);
        const collider = entity && entity.getComponent(COLLIDER_2D);
        const transform = entity && entity.getComponent(TRANSFORM);
        if (!entity || !navAgent || !collider || !transform) {
          pushLog("error", "Match Collider needs both a Collider2D and a Nav Agent 2D on '" + (entity ? entity.name : "?") + "'.");
          break;
        }
        const geo = getColliderWorldGeometry(collider, transform);
        let boundingRadius;
        if (geo.shape === ColliderShape.CIRCLE) {
          boundingRadius = geo.radius;
        } else if (geo.shape === ColliderShape.BOX) {
          boundingRadius = Math.hypot(geo.halfWidth, geo.halfHeight);
        } else if (geo.shape === ColliderShape.CAPSULE) {
          boundingRadius = geo.halfHeight + geo.radius;
        } else if (geo.worldPoints && geo.worldPoints.length) {
          boundingRadius = geo.worldPoints.reduce(
            (max, p) => Math.max(max, Math.hypot(p.x - geo.centerX, p.y - geo.centerY)),
            0
          );
        } else {
          boundingRadius = navAgent.radius;
        }
        snapshotNow("scene");
        navAgent.radius = Math.round(boundingRadius * 10) / 10;
        pushLog("log", "Set '" + entity.name + "' Nav Agent 2D radius to " + navAgent.radius + " to match its Collider2D.");
        render();
        break;
      }
      case "add-component": {
        editorState.addComponentMenuOpen = true;
        editorState.addComponentFilter = "";
        render();
        break;
      }
      case "close-add-component": {
        editorState.addComponentMenuOpen = false;
        editorState.addComponentFilter = "";
        render();
        break;
      }
      case "add-component-choice": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        editorState.addComponentMenuOpen = false;
        editorState.addComponentFilter = "";
        if (!entity) break;
        snapshotNow("scene");

        const componentName = t.dataset.component;
        const scrollTargets = {
          Rigidbody2D: "rigidbody",
          Collider2D: "collider",
          Joint2D: "joint2d",
          CharacterController: "movement",
          Light: "light",
          ShadowCaster: "shadowcaster",
          LightingSettings: "lightingsettings",
          SpriteRenderer: "sprite",
          SpriteAnimation: "spriteanimation",
          ShapeRenderer: "shaperenderer",
          AudioSource: "audiosource",
          AudioListener: "audiolistener",
          Tileset: "tileset",
          Tilemap: "tilemap",
          NavWorld2D: "navworld2d",
          NavAgent2D: "navagent2d",
          Script: "script",
          TextRenderer: "textrenderer",
          SpeechBubble: "speechbubble",
          ChatLog: "chatlog",
          TextInput: "textinput",
          Joystick: "joystick",
        };
        editorState.inspectorScrollTo = scrollTargets[componentName] || null;
        if (editorState.inspectorScrollTo) {
          editorState.sectionsOpen[editorState.inspectorScrollTo] = true;
        }
        if (componentName === "Rigidbody2D") {
          if (!entity.hasComponent(RIGIDBODY_2D)) {
            entity.addComponent(RIGIDBODY_2D, new Rigidbody2D());
            pushLog("log", "Added Rigidbody2D to '" + entity.name + "'.");
            // A Rigidbody with no Collider2D passes through everything —
            // confusing for new users and rarely intentional (unlike
            // Joint2D/CharacterController below, a bare Rigidbody with no
            // collider isn't a normal setup on its own), so auto-add a
            // matching Collider2D too, sized off whatever's already
            // visible on the entity (see _sizedColliderDefaults) instead
            // of leaving it at Collider2D's raw 1x1 constructor default.
            if (!entity.hasComponent(COLLIDER_2D)) {
              entity.addComponent(COLLIDER_2D, new Collider2D(_sizedColliderDefaults(entity)));
              pushLog("log", "Also added a matching Collider2D — a Rigidbody needs one to actually collide with anything.");
            }
          }
        } else if (componentName === "Collider2D") {
          if (!entity.hasComponent(COLLIDER_2D)) {
            entity.addComponent(COLLIDER_2D, new Collider2D(_sizedColliderDefaults(entity)));
            pushLog("log", "Added Collider2D to '" + entity.name + "'.");
          }
        } else if (componentName === "Joint2D") {
          if (!entity.hasComponent(JOINT_2D)) {
            entity.addComponent(JOINT_2D, new Joint2D());
            pushLog("log", "Added Joint2D to '" + entity.name + "'.");
            // PhysicsWorld._syncJoints skips any Joint2D whose entity has
            // no live physics body (it looks the entity up in its body
            // handles, which only exist for entities with a Rigidbody2D),
            // so a joint on a body-less entity silently does nothing.
            // Auto-add the Rigidbody2D (and, via that branch above, a
            // matching Collider2D too) instead of just warning — same
            // reasoning as CharacterController below: without it the
            // component the user just added does literally nothing.
            if (!entity.hasComponent(RIGIDBODY_2D)) {
              entity.addComponent(RIGIDBODY_2D, new Rigidbody2D());
              pushLog("log", "Also added a Rigidbody2D — a joint needs one to attach to.");
              if (!entity.hasComponent(COLLIDER_2D)) {
                entity.addComponent(COLLIDER_2D, new Collider2D(_sizedColliderDefaults(entity)));
                pushLog("log", "Also added a matching Collider2D — the Rigidbody needs one to actually collide with anything.");
              }
            }
          }
        } else if (componentName === "CharacterController") {
          if (!entity.hasComponent(CHARACTER_CONTROLLER)) {
            entity.addComponent(CHARACTER_CONTROLLER, new CharacterController());
            pushLog("log", "Added Movement Type (CharacterController) to '" + entity.name + "'.");
            // ControllerSystem.js queries (TRANSFORM, CHARACTER_CONTROLLER,
            // RIGIDBODY_2D) — a CharacterController with no Rigidbody2D is
            // never even picked up by the system, so it silently does
            // nothing. Same auto-add reasoning as Joint2D just above.
            if (!entity.hasComponent(RIGIDBODY_2D)) {
              entity.addComponent(RIGIDBODY_2D, new Rigidbody2D());
              pushLog("log", "Also added a Rigidbody2D — a Movement Type needs one to move the object.");
              if (!entity.hasComponent(COLLIDER_2D)) {
                entity.addComponent(COLLIDER_2D, new Collider2D(_sizedColliderDefaults(entity)));
                pushLog("log", "Also added a matching Collider2D — the Rigidbody needs one to actually collide with anything.");
              }
            }
          }
        } else if (componentName === "Light") {
          if (!entity.hasComponent(LIGHT)) {
            entity.addComponent(LIGHT, new Light());
            pushLog("log", "Added Light to '" + entity.name + "'.");
          }
        } else if (componentName === "ShadowCaster") {
          if (!entity.hasComponent(SHADOW_CASTER)) {
            entity.addComponent(SHADOW_CASTER, new ShadowCaster());
            pushLog("log", "Added Shadow Caster to '" + entity.name + "'.");
          }
        } else if (componentName === "LightingSettings") {
          if (!entity.hasComponent(LIGHTING_SETTINGS)) {
            entity.addComponent(LIGHTING_SETTINGS, new LightingSettings());
            pushLog("log", "Added Lighting Settings to '" + entity.name + "'.");
          }
        } else if (componentName === "SpriteRenderer") {
          if (!entity.hasComponent(SPRITE_RENDERER)) {
            entity.addComponent(SPRITE_RENDERER, new SpriteRenderer());
            pushLog("log", "Added Sprite Renderer to '" + entity.name + "'.");
          }
        } else if (componentName === "SpriteAnimation") {
          if (!entity.hasComponent(SPRITE_ANIMATION)) {
            entity.addComponent(SPRITE_ANIMATION, new SpriteAnimation());
            pushLog("log", "Added Sprite Animation to '" + entity.name + "'.");
            // Sprite Animation has nothing to draw itself — every frame
            // it writes is read back off the entity's SpriteRenderer
            // (see AnimationSystem.js's spriteRenderer.spriteKey =
            // frame.spriteKey). Without one, the animation still plays
            // (clip advances, events still fire) but nothing ever
            // appears on screen, which looks exactly like a broken
            // feature rather than a missing, easily-added component.
            // Safe to auto-add: SpriteRenderer's constructor takes no
            // required fields (spriteKey starts null, same "nothing
            // shows yet" state as a manually-added one), so this can
            // never clobber or conflict with anything already on the
            // entity.
            if (!entity.hasComponent(SPRITE_RENDERER)) {
              entity.addComponent(SPRITE_RENDERER, new SpriteRenderer());
              pushLog("log", "Also added Sprite Renderer to '" + entity.name + "' — Sprite Animation needs one to actually display its frames.");
            }
          }
        } else if (componentName === "ShapeRenderer") {
          if (!entity.hasComponent(SHAPE_RENDERER)) {
            entity.addComponent(SHAPE_RENDERER, new ShapeRenderer());
            pushLog("log", "Added Shape Renderer to '" + entity.name + "'.");
          }
        } else if (componentName === "StrokePath") {
          if (!entity.hasComponent(STROKE_PATH)) {
            entity.addComponent(STROKE_PATH, new StrokePath());
            pushLog("log", "Added Stroke Path to '" + entity.name + "'.");
          }
        } else if (componentName === "AudioSource") {
          if (!entity.hasComponent(AUDIO_SOURCE)) {
            entity.addComponent(AUDIO_SOURCE, new AudioSource());
            pushLog("log", "Added Audio Source to '" + entity.name + "'.");
          }
        } else if (componentName === "AudioListener") {
          if (!entity.hasComponent(AUDIO_LISTENER)) {
            entity.addComponent(AUDIO_LISTENER, new AudioListener());
            pushLog("log", "Added Audio Listener to '" + entity.name + "'.");
          }
        } else if (componentName === "Tileset") {
          if (!entity.hasComponent(TILESET)) {
            entity.addComponent(TILESET, new Tileset());
            pushLog("log", "Added Tileset to '" + entity.name + "'.");
          }
        } else if (componentName === "Tilemap") {
          if (!entity.hasComponent(TILEMAP)) {
            entity.addComponent(TILEMAP, new Tilemap());
            pushLog("log", "Added Tilemap to '" + entity.name + "'.");
          }
        } else if (componentName === "NavWorld2D") {
          if (!entity.hasComponent(NAV_WORLD_2D)) {
            entity.addComponent(NAV_WORLD_2D, new NavWorld2D());
            pushLog("log", "Added Nav World 2D to '" + entity.name + "'. Click \"Bake Nav World\" in the Inspector to auto-fill it from colliders.");
          }
        } else if (componentName === "NavAgent2D") {
          // Deliberately per-entity, opt-in only — this is the "click Add
          // Component, no automatic add on every object" NavAgent2D
          // requirement. Any number of entities can each get their own
          // NavAgent2D pointed at the SAME shared NavWorld2D; adding one
          // here never creates or touches any NavWorld2D.
          if (!entity.hasComponent(NAV_AGENT_2D)) {
            entity.addComponent(NAV_AGENT_2D, new NavAgent2D());
            pushLog("log", "Added Nav Agent 2D to '" + entity.name + "'.");
          }
        } else if (componentName === "Script") {
          if (!entity.hasComponent(SCRIPT)) {
            var sn = createScript(null);
            entity.addComponent(SCRIPT, new Script({ scriptName: sn, source: getScriptSource(sn) }));
            pushLog("log", "Added Script to '" + entity.name + "'.");
          }
        } else if (componentName === "TextRenderer") {
          if (!entity.hasComponent(TEXT_RENDERER)) {
            entity.addComponent(TEXT_RENDERER, new TextRenderer());
            pushLog("log", "Added Text to '" + entity.name + "'.");
          }
        } else if (componentName === "SpeechBubble") {
          if (!entity.hasComponent(SPEECH_BUBBLE)) {
            entity.addComponent(SPEECH_BUBBLE, new SpeechBubble());
            pushLog("log", "Added Speech Bubble to '" + entity.name + "'.");
          }
        } else if (componentName === "ChatLog") {
          if (!entity.hasComponent(CHAT_LOG)) {
            entity.addComponent(CHAT_LOG, new ChatLog());
            pushLog("log", "Added Chat Log to '" + entity.name + "'.");
          }
        } else if (componentName === "TextInput") {
          if (!entity.hasComponent(TEXT_INPUT)) {
            entity.addComponent(TEXT_INPUT, new TextInput());
            pushLog("log", "Added Text Input to '" + entity.name + "'.");
          }
        } else if (componentName === "Joystick") {
          if (!entity.hasComponent(JOYSTICK)) {
            entity.addComponent(JOYSTICK, new Joystick());
            pushLog("log", "Added Joystick to '" + entity.name + "'.");
          }
        }
        render();
        break;
      }
      case "delete-tag": {
        const tagToDelete = t.dataset.tag;
        if (tagToDelete && tagToDelete !== "Untagged") {
          deleteTag(tagToDelete);
          // If the currently selected entity carries this tag, reset it
          // to "Untagged" so its tag field stays valid in the dropdown.
          const tagEntity = editorState.world && editorState.world.getEntity(editorState.selectedId);
          if (tagEntity && tagEntity.tag === tagToDelete) tagEntity.tag = "Untagged";
          render();
        }
        break;
      }
      case "remove-component": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (!entity) break;
        const componentType = COMPONENT_TYPE_MAP[t.dataset.component];
        if (componentType === CAMERA && _cameraCount(editorState.world) <= MAX_CAMERAS) {
          // Every scene must keep at least one Camera (see SceneLoader.js's
          // validateScene()) — block stripping the only one off its entity.
          // Raise MAX_CAMERAS above to lift this once multi-camera scenes
          // are supported.
          pushLog("warn", "⚠️ Can't remove the only Camera in the scene. A scene needs at least one.");
          break;
        }
        if (componentType) {
          snapshotNow("scene");
          entity.removeComponent(componentType);
          // Removing NavAgent2D while its "Show Agent Navigation" preview
          // is active would otherwise leave navAgentPreviewEntityId
          // pointing at a component that no longer exists — refreshGizmos
          // in SceneViewport.js already guards against this defensively,
          // but clearing it here immediately avoids even one stale frame.
          if (t.dataset.component === "NavAgent2D" && editorState.navAgentPreviewEntityId === entity.id) {
            editorState.navAgentPreviewEntityId = null;
          }
        }
        render();
        break;
      }
      case "toggle-clip-collider-override": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (!entity) break;
        const anim = entity.getComponent(SPRITE_ANIMATION);
        const clip = anim && anim.clips.find((c) => c.id === t.dataset.clipId);
        if (!clip) break;
        snapshotNow("scene");
        if (t.checked) {
          // Seed the override from the entity's OWN current Collider2D
          // (if any) so turning the toggle on starts from something
          // sensible/visible rather than a jarring default — falls back
          // to a plain Box if the entity has no Collider2D at all yet.
          const collider = entity.getComponent(COLLIDER_2D);
          const seed = collider ? new Collider2D({ ...collider }) : new Collider2D(_sizedColliderDefaults(entity));
          clip.colliderOverride = { ...seed };
        } else {
          clip.colliderOverride = null;
        }
        render();
        break;
      }
      case "add-scene": {
        if (!editorState.game) break;
        const created = editorState.game.createScene();
        editorState.projectFolder = "scenes";
        switchScene(created.id);
        editorState.renamingSceneId = created.id;
        pushLog("log", "Created scene '" + created.name + "'.");
        render();
        break;
      }
      case "select-project-folder": {
        editorState.projectFolder = t.dataset.folder;
        render();
        break;
      }
      case "save-now": {
        // Manual, immediate save to this project's autosave slot (see
        // ProjectStorage.js's startAutosave/saveNow) — distinct from
        // "save-project" above, which downloads a .rs. Guarded the
        // same way that action is: no-op with nothing to do if there's
        // no game loaded or no autosave loop running for this project
        // (editorState.saveNow is only set for a launcher project —
        // see main.js).
        if (!editorState.saveNow) break;
        pushLog("log", "Saving…");
        render(); // reflect "Saving…" immediately rather than waiting for the async result
        editorState.saveNow().then((result) => {
          if (result && result.ok) {
            pushLog("log", "Saved.");
          } else {
            // Structural, not a one-line toast: exactly what failed,
            // why it most likely happened, and the two concrete things
            // to do about it right now — matching the same guidance
            // the autosave-failure dialog (see main.js's onSaved
            // callback) gives after 2 consecutive failures, but
            // available immediately on demand instead of waiting for
            // that threshold.
            pushLog(
              "error",
              "Save failed — your changes are NOT saved yet and are only kept in this browser tab." +
                (result && result.error && result.error.message ? " (" + result.error.message + ")" : "") +
                " This usually means the project has grown too large for this browser's storage. " +
                "To avoid losing work: File > Save Project to download a backup now, or File > Enable Extra Backup Storage to mirror auto-saves to a folder on your real disk."
            );
          }
          render();
        });
        break;
      }
      case "save-project": {
        if (!editorState.game) break;
        const projectName = window.prompt("Project name?", editorState.projectName || "Untitled Project");
        if (projectName === null) break; // cancelled
        editorState.projectName = projectName;
        pushLog("log", "Saving project…");
        exportProject(editorState.game, projectName, {
          optimizeAssets: editorState.optimizeAssetsOnSave,
          // Live progress specifically for the optimize pass — the
          // rest of export (scene serialization, zipping) is fast
          // enough not to need its own progress line, but re-encoding
          // every PNG through UPNG.js on a project with a lot of art
          // can take a few seconds, so this keeps the log from going
          // silent during that stretch.
          onProgress: (msg) => pushLog("log", msg),
        })
          .then((result) => {
            const stats = result && result.optimizeStats;
            if (stats) {
              const parts = [];
              if (stats.pngCount) parts.push(stats.pngCount + " PNG" + (stats.pngCount === 1 ? "" : "s"));
              if (stats.wavCount) parts.push(stats.wavCount + " WAV" + (stats.wavCount === 1 ? "" : "s"));
              const savedKb = (stats.bytesSaved / 1024).toFixed(1);
              pushLog(
                "log",
                parts.length
                  ? "Project saved — optimized " + parts.join(" + ") + " (saved ~" + savedKb + " KB)."
                  : "Project saved — nothing to optimize (assets already minimal, or all in formats that can't be losslessly shrunk further)."
              );
            } else {
              pushLog("log", "Project saved.");
            }
          })
          .catch((err) => pushLog("error", "Failed to save project: " + err.message));
        break;
      }
      case "toggle-optimize-assets-on-save": {
        editorState.optimizeAssetsOnSave = !editorState.optimizeAssetsOnSave;
        render();
        break;
      }
      case "enable-fsa-backup": {
        // Called directly from this click handler (not through any
        // async gap first) — showDirectoryPicker() requires an
        // in-progress user gesture, so this must stay a synchronous
        // continuation of the click. See RealotPersistence.js's FSA
        // section doc comment for the full explanation of why this
        // can't just happen automatically the first time autosave
        // runs.
        if (!editorState.projectId) {
          pushLog("error", "Extra backup storage needs a project opened from the launcher.");
          break;
        }
        if (!window.RealotPersistence || typeof window.RealotPersistence.enableFsaBackup !== "function") {
          pushLog("error", "Extra backup storage isn't available in this browser.");
          break;
        }
        window.RealotPersistence.enableFsaBackup(editorState.projectId).then((result) => {
          if (result.ok) {
            editorState.fsaBackupEnabled = true;
            pushLog("log", "Extra backup storage enabled — auto-saves will also be mirrored to \u201c" + result.name + "\u201d.");
          } else {
            pushLog("error", "Couldn't enable extra backup storage" + (result.error && result.error.message ? ": " + result.error.message : "."));
          }
          render();
        });
        break;
      }
      case "disable-fsa-backup": {
        // Turning OFF is always safe to run immediately, no user-gesture
        // constraint like enable-fsa-backup has (no picker involved) —
        // see RealotPersistence.js's disableFsaBackup doc comment. This
        // only stops future mirror writes; it never touches the folder
        // on disk or the project's IndexedDB/localStorage copy, which
        // remains the source of truth exactly as it was while backup
        // was on.
        if (!editorState.projectId) break;
        if (!window.RealotPersistence || typeof window.RealotPersistence.disableFsaBackup !== "function") {
          pushLog("error", "Extra backup storage isn't available in this browser.");
          break;
        }
        window.RealotPersistence.disableFsaBackup(editorState.projectId).then(() => {
          editorState.fsaBackupEnabled = false;
          pushLog("log", "Extra backup storage turned off. Nothing already saved was deleted \u2014 this only stops mirroring future auto-saves.");
          render();
        });
        break;
      }
      case "restore-fsa-backup": {
        if (!editorState.projectId || !editorState.game) break;
        if (!window.RealotPersistence || typeof window.RealotPersistence.readFsaBackup !== "function") {
          pushLog("error", "Extra backup storage isn't available in this browser.");
          break;
        }
        window.RealotPersistence.readFsaBackup(editorState.projectId).then((result) => {
          if (!result.ok) {
            pushLog(
              "error",
              "No backup found in the folder for this project" +
                (result.error && result.error.message ? ": " + result.error.message : ".")
            );
            return;
          }
          // Destructive (applySnapshot clears + replaces every scene,
          // asset, prefab, script, and layer/tag currently loaded — see
          // its own doc comment in ProjectStorage.js) so this must be
          // confirmed before touching anything, same as the
          // autosave-failure dialog in main.js.
          const proceed = window.confirm(
            "Restore this project from its backup folder?\n\n" +
            "This will REPLACE everything currently in the editor (all scenes, assets, scripts) " +
            "with whatever was last mirrored to the backup folder. This cannot be undone.\n\n" +
            "Click OK to restore, or Cancel to keep what's currently open."
          );
          if (!proceed) return;
          applySnapshot(editorState.game, result.snapshot).then(() => {
            // Same post-load bookkeeping loadInitialProject() does after
            // restoring a snapshot on boot (see SceneViewport.js): wipe
            // undo history (it was built against the entities that just
            // got replaced), re-sync sprite rendering/gizmos/background
            // color to the newly-loaded scene, and settle selection on
            // something valid. Without this, the underlying World data
            // is correct but the viewport keeps showing stale gizmos/
            // selection/camera framing from whatever was open a moment
            // ago — restoring "worked" but visibly looked wrong.
            syncAfterExternalSceneChange();
            pushLog("log", "Project restored from backup folder.");
            render();
          }).catch((err) => {
            pushLog("error", "Failed to restore from backup: " + err.message);
          });
        });
        break;
      }
      case "load-project": {
        // Forward the click to the real hidden <input type="file"> that
        // sits right next to this button in the File dropdown (see
        // Toolbar.js's renderFileMenu()) — same indirection BottomPanel's
        // "Import Sprite"/"Import Audio" buttons use for their own
        // hidden inputs, since a styled <button> can't itself open a
        // native file picker.
        const input = document.querySelector('[data-action="load-project-input"]');
        if (input) input.click();
        break;
      }
      case "open-export-window": {
        if (!editorState.game) break;
        editorState.exportOpen = true;
        // Re-opening the popup while an Android build is still running
        // must show that build (with its Cancel button), not a blank form
        // that would let the user start a second one on top of it.
        if (!isAndroidBuildActive()) editorState.exportStatus = null;
        if (editorState.exportGameTitle == null) {
          // First time opening the popup this session — seed the title
          // field from the project name as a starting point the user
          // can then freely override (see EditorState.js's own doc
          // comment on exportGameTitle for why these are kept separate).
          editorState.exportGameTitle = editorState.projectName || "";
        }
        editorState.openMenu = null; // close the File dropdown, if that's where this was clicked from
        // Kick off a background check of the currently-selected Android
        // build server so the card can show "Server awake" / "Server
        // asleep" instead of the user finding out only after clicking
        // Export and waiting.
        editorState.androidServers = listAndroidServers();
        editorState.androidActiveServerId = getActiveAndroidServer() ? getActiveAndroidServer().id : null;
        refreshAndroidServerStatus(render);
        render();
        break;
      }
      case "close-export-window": {
        editorState.exportOpen = false;
        if (!isAndroidBuildActive()) editorState.exportStatus = null;
        editorState.androidServerStatus = null;
        editorState.androidServerFormOpen = false;
        render();
        break;
      }
      case "export-window-reset": {
        editorState.exportStatus = null;
        render();
        break;
      }
      case "export-favicon-clear": {
        editorState.exportFavicon = null;
        render();
        break;
      }
      case "android-server-select": {
        const id = t.dataset.serverId;
        setActiveAndroidServer(id);
        editorState.androidServers = listAndroidServers();
        editorState.androidActiveServerId = id;
        // Re-check reachability for the newly-selected server.
        refreshAndroidServerStatus(render);
        render();
        break;
      }
      case "android-server-add-open": {
        editorState.androidServerFormOpen = true;
        editorState.androidServerFormEditingId = null;
        editorState.androidServerFormLabel = "";
        editorState.androidServerFormUrl = APK_SERVICE_URL.replace(/\/$/, ""); // prefilled with the Realot APK service; editable
        editorState.androidServerFormKey = "";
        editorState.androidServerFormError = "";
        render();
        break;
      }
      case "android-server-edit-open": {
        const id = t.dataset.serverId;
        const server = listAndroidServers().find((s) => s.id === id);
        if (!server) break;
        editorState.androidServerFormOpen = true;
        editorState.androidServerFormEditingId = id;
        editorState.androidServerFormLabel = server.label;
        editorState.androidServerFormUrl = server.serverUrl;
        editorState.androidServerFormKey = server.apiKey;
        editorState.androidServerFormError = "";
        render();
        break;
      }
      case "android-server-form-cancel": {
        editorState.androidServerFormOpen = false;
        editorState.androidServerFormError = "";
        render();
        break;
      }
      case "android-server-form-save": {
        const url = (editorState.androidServerFormUrl || "").trim();
        const key = (editorState.androidServerFormKey || "").trim();
        if (!url || !key) {
          // The button is always clickable (typing never re-renders, so a render-time
          // "disabled" state could never switch on). Validate here and say what is missing.
          editorState.androidServerFormError = !url && !key ? "Enter the server URL and your API key." : !url ? "Enter the server URL." : "Enter your API key.";
          render();
          break;
        }
        editorState.androidServerFormError = "";
        const id = saveAndroidServer(
          { label: editorState.androidServerFormLabel, serverUrl: url, apiKey: key },
          editorState.androidServerFormEditingId
        );
        setActiveAndroidServer(id);
        editorState.androidServers = listAndroidServers();
        editorState.androidActiveServerId = id;
        editorState.androidServerFormOpen = false;
        refreshAndroidServerStatus(render);
        render();
        break;
      }
      case "android-server-delete": {
        const id = t.dataset.serverId;
        deleteAndroidServer(id);
        editorState.androidServers = listAndroidServers();
        const active = getActiveAndroidServer();
        editorState.androidActiveServerId = active ? active.id : null;
        render();
        break;
      }
      case "start-export": {
        if (!editorState.game) break;
        const format = t.dataset.format;
        const gameTitle = (editorState.exportGameTitle || editorState.projectName || "Untitled Project").trim() || "Untitled Project";
        if (isAndroidBuildActive()) break; // one Android build at a time — cancel the running one first
        editorState.exportStatus = { phase: "running", message: "Starting\u2026" };
        render();
        if (format === "android") {
          const server = getActiveAndroidServer();
          if (!server) {
            editorState.exportStatus = {
              phase: "error",
              error: "No Android build server set up yet. Add one below \u2014 you'll need your build server's URL and API key.",
            };
            render();
            break;
          }
          // From here until the build ends, Cancel / the restart warning apply.
          const buildSignal = beginAndroidBuild(server);
          buildExport(editorState.game, {
            projectName: gameTitle,
            faviconDataUrl: editorState.exportFavicon ? editorState.exportFavicon.dataUrl : null,
            format: "html",
            onProgress: (message) => {
              if (!isAndroidBuildActive()) return; // cancelled while packaging — keep "Cancelling…"
              editorState.exportStatus = { phase: "running", message };
              render();
            },
          })
            .then(({ zip, stats }) => {
              if (!isAndroidBuildActive()) throw new DOMException("Build cancelled.", "AbortError");
              editorState.exportStatus = { phase: "running", message: "Preparing Android build\u2026" };
              render();
              return zip
                .generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 9 } })
                .then((blob) => {
                  if (!isAndroidBuildActive()) throw new DOMException("Build cancelled.", "AbortError");
                  editorState.exportStatus = { phase: "running", message: "Building APK on the server\u2026" };
                  render();
                  return fetch(androidExportEndpoint(gameTitle, server), {
                    method: "POST",
                    headers: androidExportHeaders(server, {
                      "Content-Type": "application/zip",
                    }),
                    body: blob,
                    signal: buildSignal,
                  }).then(async (response) => {
                    if (!response.ok) {
                        let message = "Android export failed (" + response.status + ").";
                        if (response.status === 405) {
                          message =
                            "The configured Android build server does not accept APK builds at this route. " +
                            "Check the server URL and make sure it exposes POST /api/v1/build.";
                        }
                        if (response.status === 404) {
                          message =
                            "Android build server not found at that URL/route (404). Double-check the server URL " +
                            "you saved for \u201C" + server.label + "\u201D (edit it in the Export popup) and that it " +
                            "exposes POST /api/v1/build.";
                        }
                        if (response.status === 401 || response.status === 403) {
                          message = "Android export server rejected the request: missing or wrong API key for \u201C" + server.label + "\u201D.";
                        }
                        if (response.status === 429) {
                          message = "Too many Android export requests. Wait a bit and try again.";
                        }
                      try {
                        const data = await response.json();
                        if (data && data.error) message = data.error;
                      } catch (_) {}
                      throw new Error(message);
                    }
                    // The build server is async: this response is a small
                    // JSON job ticket ({ job: { status: "queued", ... },
                    // statusUrl, downloadUrl }), NOT the APK. Poll until
                    // the build finishes, then fetch the real binary from
                    // its download URL. (Fixes: downloaded "APK" being a
                    // few hundred bytes of JSON instead of a real build.)
                    const jobTicket = await response.json();
                    editorState.exportStatus = { phase: "running", message: "Build queued\u2026" };
                    render();
                    const downloadUrl = await pollAndroidBuildJob(jobTicket, server, {
                      signal: buildSignal,
                      onProgress: (message) => {
                        // Don't let a late progress tick overwrite the
                        // "Cancelling\u2026" message after Cancel was pressed.
                        if (!isAndroidBuildActive()) return;
                        editorState.exportStatus = { phase: "running", message };
                        render();
                      },
                    });
                    if (!downloadUrl) {
                      throw new Error("Android build finished but the server didn't provide a download URL.");
                    }
                    editorState.exportStatus = { phase: "running", message: "Downloading APK\u2026" };
                    render();
                    const apkResponse = await fetch(downloadUrl, { headers: androidExportHeaders(server), signal: buildSignal });
                    if (!apkResponse.ok) {
                      // The build server hands out the APK exactly once
                      // (its copy is deleted right after a successful
                      // download, to avoid piling up files on disk), so
                      // these specific statuses have known meanings —
                      // surface them instead of a bare status code.
                      let message = "Failed to download the built APK (" + apkResponse.status + ").";
                      if (apkResponse.status === 410) {
                        message = "This APK was already downloaded once and the server's copy was deleted. Export again to build a new one.";
                      } else if (apkResponse.status === 202) {
                        message = "Server says the build isn't finished yet \u2014 try again in a moment.";
                      } else if (apkResponse.status === 422) {
                        try {
                          const data = await apkResponse.json();
                          message = data && data.error ? data.error : "Build failed on the server.";
                        } catch (_) {
                          message = "Build failed on the server.";
                        }
                      } else if (apkResponse.status === 404) {
                        message = "Build job not found on the server (it may have restarted since this build started).";
                      }
                      throw new Error(message);
                    }
                    const apkBlob = await apkResponse.blob();
                    confirmAndroidDelivery(downloadUrl, server);
                    return { apk: apkBlob, stats };
                  });
                });
            })
            .then(({ apk, stats }) => {
              endAndroidBuild();
              const base = slugifyForFilename(gameTitle);
              downloadBlob(apk, base + "-android.apk");
              editorState.exportStatus = {
                phase: "done",
                stats: { ...stats, format: "android", apkBytes: apk.size },
              };
              pushLog("log", "Exported Android APK.");
              render();
            })
            .catch((err) => {
              // User pressed Cancel (or left the editor): not a failure.
              // Back to the format picker, with a note in the console.
              if (wasAndroidBuildCancelled() || (err && err.name === "AbortError")) {
                endAndroidBuild();
                editorState.exportStatus = null;
                pushLog("log", "Android build cancelled.");
                render();
                return;
              }
              // Any other failure (timeout, lost connection, ...): make sure
              // the server isn't left building a job nobody is waiting for.
              endAndroidBuild();
              let message = err && err.message ? err.message : String(err);
              // A sleeping/cold free-tier server (Replit free, Render free, etc.)
              // makes fetch() throw a generic network error rather than
              // returning a proper HTTP status — give a more useful hint here.
              if (err instanceof TypeError) {
                message =
                  "The browser couldn't complete the request to \u201C" + server.label + "\u201D (" + server.serverUrl + "). " +
                  "The server being up isn't enough \u2014 this exact error also happens when the server blocks the editor " +
                  "(CORS: it must allow POST/GET/DELETE/OPTIONS and the headers Content-Type, X-Api-Key), when the URL is http:// while the editor is https://, " +
                  "or when it's a free-tier host that is still waking up. Check the server's logs for an OPTIONS/POST request " +
                  "to /api/v1/build when you press Export.";
              }
              editorState.exportStatus = { phase: "error", error: message };
              pushLog("error", "Android export failed: " + message);
              render();
            });
          break;
        }
        buildExport(editorState.game, {
          projectName: gameTitle,
          faviconDataUrl: editorState.exportFavicon ? editorState.exportFavicon.dataUrl : null,
          format,
          onProgress: (message) => {
            editorState.exportStatus = { phase: "running", message };
            render();
          },
        })
          .then(({ zip, stats }) => {
            editorState.exportStatus = { phase: "running", message: "Compressing archive\u2026" };
            render();
            return zip
              .generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 9 } })
              .then((blob) => {
                const base = slugifyForFilename(gameTitle);
                downloadBlob(blob, base + "-" + format + ".zip");
                editorState.lastWebExport = { blob, format, title: gameTitle };
                editorState.exportStatus = { phase: "done", stats };
                pushLog("log", "Exported " + (format === "pwa" ? "PWA" : "HTML5") + " build.");
                render();
              });
          })
          .catch((err) => {
            editorState.exportStatus = { phase: "error", error: err && err.message ? err.message : String(err) };
            pushLog("error", "Export failed: " + (err && err.message ? err.message : String(err)));
            render();
          });
        break;
      }
case "build-apk-from-last-export": {
        const webExport = editorState.lastWebExport;
        const server = getActiveAndroidServer();
        if (!webExport || !server) break;
        if (isAndroidBuildActive()) break;
        const buildSignal = beginAndroidBuild(server);
        editorState.exportStatus = { phase: "running", message: "Uploading the exact " + (webExport.format === "pwa" ? "PWA" : "HTML5") + " export…" };
        render();
        uploadWebExportForAndroid(webExport.blob, webExport.title, webExport.format, server, buildSignal)
          .then(async (jobTicket) => {
            editorState.exportStatus = { phase: "running", message: "Build queued…" };
            render();
            const downloadUrl = await pollAndroidBuildJob(jobTicket, server, {
              signal: buildSignal,
              onProgress: (message) => {
                if (!isAndroidBuildActive()) return; // don't overwrite "Cancelling…"
                editorState.exportStatus = { phase: "running", message };
                render();
              },
            });
            if (!downloadUrl) throw new Error("Android build finished but the server didn't provide a download URL.");
            editorState.exportStatus = { phase: "running", message: "Downloading APK…" };
            render();
            const apkResponse = await fetch(downloadUrl, { headers: androidExportHeaders(server), signal: buildSignal });
            if (!apkResponse.ok) throw new Error("Failed to download the built APK (" + apkResponse.status + ").");
            const apkBlob = await apkResponse.blob();
            confirmAndroidDelivery(downloadUrl, server);
            return apkBlob;
          })
          .then((apk) => {
            endAndroidBuild();
            const base = slugifyForFilename(webExport.title);
            downloadBlob(apk, base + "-android.apk");
            editorState.exportStatus = { phase: "done", stats: { format: "android", sourceFormat: webExport.format, apkBytes: apk.size } };
            pushLog("log", "Built Android APK from the exact " + webExport.format.toUpperCase() + " export package.");
            render();
          })
          .catch((err) => {
            if (wasAndroidBuildCancelled() || (err && err.name === "AbortError")) {
              endAndroidBuild();
              editorState.exportStatus = null;
              pushLog("log", "Android build cancelled.");
              render();
              return;
            }
            endAndroidBuild(); // timeout / lost connection: don't leave the server job running
            const message = err && err.message ? err.message : String(err);
            editorState.exportStatus = { phase: "error", error: message };
            pushLog("error", "Android build from export failed: " + message);
            render();
          });
        break;
      }
case "select-scene-file": {
        // Manual double-click detection: the native dblclick event
        // doesn't survive the full DOM rebuild (app.innerHTML = html)
        // that happens on the first click's render() — the recreated
        // element is a different DOM node, so the browser never fires
        // dblclick. Tracking timestamp + sceneId ourselves works
        // regardless of DOM replacement, and is more reliable on
        // laptop touchpads where the OS double-click threshold may
        // differ from the browser's.
        const sceneId = t.dataset.sceneId;
        const now = Date.now();
        if (_lastSceneClick.id === sceneId && now - _lastSceneClick.time < 500) {
          // Double-click: start rename (takes priority over switching)
          editorState.renamingSceneId = sceneId;
          _lastSceneClick = { id: null, time: 0 };
          render();
          break;
        }
        _lastSceneClick = { id: sceneId, time: now };
        editorState.selectedSceneFileId = sceneId;
        if (sceneId && editorState.game && sceneId !== editorState.game.getActiveSceneId()) {
          switchScene(sceneId);
        }
        render();
        break;
      }
      case "duplicate-scene-file": {
        if (!editorState.game) break;
        const sceneId = t.dataset.sceneId;
        const created = editorState.game.duplicateScene(sceneId);
        if (created) {
          pushLog("log", "Duplicated scene as '" + created.name + "'.");
        }
        render();
        break;
      }
      case "delete-scene-file": {
        if (!editorState.game) break;
        const sceneId = t.dataset.sceneId;
        const name = t.dataset.displayName || "this scene";
        // window.confirm rather than an in-app modal — matches the
        // existing pattern for a destructive, irreversible action
        // elsewhere in this codebase (see the "Create an object tag"
        // window.prompt in applyFieldChange further down); a whole
        // custom confirm-dialog component would be a lot of new UI
        // just for five delete actions that all need the exact same
        // yes/no gate. Deleting a scene is NOT covered by the
        // scene/anim undo system (see UndoManager.js's own doc
        // comment — its snapshots are entities within ONE scene, not
        // the project's whole scene LIST), so an explicit confirm here
        // matters more than for, say, deleting a single entity.
        if (!window.confirm('Delete scene "' + name + '"? This can\'t be undone.')) break;
        const wasActive = sceneId === editorState.game.getActiveSceneId();
        const deleted = editorState.game.deleteScene(sceneId);
        if (deleted) {
          pushLog("log", "Deleted scene '" + name + "'.");
          if (editorState.selectedSceneFileId === sceneId) editorState.selectedSceneFileId = null;
          // SceneManager.deleteScene() only actually reloads the World
          // (and switches to the first remaining scene) when the
          // DELETED scene was the currently active one — see its own
          // doc comment. Only THEN does the live World's contents
          // change under us, so only then does the editor's own
          // selection/undo-history/viewport need re-syncing; deleting
          // some other, inactive scene from the list leaves the
          // person's current selection in the still-active scene
          // completely untouched, same as it would if they'd never
          // opened the Scenes folder at all.
          if (wasActive) syncAfterExternalSceneChange();
        } else {
          pushLog("warn", "Can't delete the only scene in a project.");
        }
        render();
        break;
      }
      case "delete-sprite-asset": {
        const key = t.dataset.spriteKey;
        const name = t.dataset.displayName || "this sprite";
        if (!window.confirm('Delete sprite "' + name + '"? Any object still using it will show a missing-texture marker. This can\'t be undone.')) break;
        if (deleteSpriteAsset(key)) {
          pushLog("log", "Deleted sprite asset '" + name + "'.");
          render();
        }
        break;
      }
      case "delete-audio-asset": {
        const key = t.dataset.audioKey;
        const name = t.dataset.displayName || "this audio clip";
        if (!window.confirm('Delete audio clip "' + name + '"? Any object still using it will simply stop playing it. This can\'t be undone.')) break;
        if (deleteAudioAsset(key)) {
          pushLog("log", "Deleted audio asset '" + name + "'.");
          render();
        }
        break;
      }
      case "delete-script-asset": {
        const name = t.dataset.script;
        if (!window.confirm('Delete script "' + name + '"? Any object still using it will lose its script reference. This can\'t be undone.')) break;
        if (deleteScriptEverywhere(name)) {
          pushLog("log", "Deleted script '" + name + "'.");
          render();
        }
        break;
      }
      case "delete-prefab-asset": {
        const prefabId = t.dataset.prefabId;
        const name = t.dataset.displayName || "this prefab";
        // Same "existing instances are left alone, just unlinked" note
        // as PrefabRegistry.deletePrefab()'s own doc comment — worth
        // spelling out in the confirm dialog itself since it's the one
        // place a person decides whether to actually do this.
        if (!window.confirm('Delete prefab "' + name + '"? Objects already placed from it will keep their current appearance but will no longer be linked to it (Update Prefab will no longer reach them). This can\'t be undone.')) break;
        if (deletePrefab(prefabId)) {
          pushLog("log", "Deleted prefab '" + name + "'.");
          render();
        }
        break;
      }
    }
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-action]");
    if (!t) {
      // Clicked somewhere with no data-action at all: close any open
      // menu-bar dropdown (standard menu UX — clicking outside closes
      // it), same as toggle-menu on the SAME menu button does.
      if (editorState.openMenu) {
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
      }
      return;
    }
    _handleAction(e, t);
  });

  // --- Multi-select + clipboard for Delete / Copy / Paste / Duplicate ---
  // _clipboard holds serialized entity data (SceneSerializer.serializeEntity)
  // between a Copy and a Paste. Kept in this closure (not editorState)
  // because it is not UI state that needs to trigger a re-render.
  let _clipboard = [];

  function _liveSelectionIds() {
    if (!editorState.world) return [];
    const ids = editorState.selectedIds.filter((id) => editorState.world.getEntity(id));
    return ids.length ? ids : (editorState.selectedId ? [editorState.selectedId] : []);
  }

  function _setSelection(ids) {
    editorState.selectedIds = ids.slice();
    editorState.selectedId = ids.length ? ids[ids.length - 1] : null;
  }

  function _deleteSelection() {
    const ids = _liveSelectionIds();
    if (!ids.length) return;
    const world = editorState.world;

    // Block deleting the scene's only Camera (see MAX_CAMERAS above) —
    // if every camera currently in the scene is among the entities being
    // deleted, and that would drop the count below the minimum of 1,
    // refuse the whole delete rather than silently leaving the scene
    // camera-less. Entities NOT carrying a Camera still get through
    // untouched by this check.
    const camerasBeingDeleted = ids.filter((id) => {
      const ent = world.getEntity(id);
      return ent && ent.hasComponent(CAMERA);
    }).length;
    if (camerasBeingDeleted > 0 && _cameraCount(world) - camerasBeingDeleted < 1) {
      pushLog("warn", "⚠️ Can't delete the only Camera in the scene. A scene needs at least one.");
      return;
    }

    snapshotNow("scene");
    for (const id of ids) editorState.world.destroyEntity(id);
    pushLog("log", "Deleted " + ids.length + " object" + (ids.length > 1 ? "s" : "") + ".");
    _setSelection([]);
  }

  function _copySelection() {
    const ids = _liveSelectionIds();
    _clipboard = ids
      .map((id) => {
        const ent = editorState.world.getEntity(id);
        return ent ? serializeEntity(ent) : null;
      })
      .filter(Boolean);
    if (_clipboard.length) pushLog("log", "Copied " + _clipboard.length + " object" + (_clipboard.length > 1 ? "s" : "") + ".");
  }

  function _pasteSelection() {
    if (!_clipboard.length || !editorState.world) return;
    const world = editorState.world;

    // Block pasting/duplicating (Ctrl+D routes through here too) any
    // clipboard entity carrying a Camera once the scene is already at
    // MAX_CAMERAS — same one-camera rule as delete and remove-component
    // above. Non-camera entities in the same paste still go through;
    // only the camera copies are skipped.
    const pastingCameras = _clipboard.some((data) => data.components && data.components[CAMERA]);
    let cameraBudget = MAX_CAMERAS - _cameraCount(world);
    if (pastingCameras && cameraBudget <= 0) {
      pushLog("warn", "⚠️ Can't paste another Camera — a scene can only have " + MAX_CAMERAS + ".");
    }

    snapshotNow("scene");
    const OFFSET = 24;
    const newIds = [];
    for (const data of _clipboard) {
      const isCamera = !!(data.components && data.components[CAMERA]);
      if (isCamera) {
        if (cameraBudget <= 0) continue;
        cameraBudget -= 1;
      }
      const ent = instantiateEntity(editorState.world, data, data.name + " (Copy)");
      const t = ent.getComponent(TRANSFORM);
      if (t) { t.x += OFFSET; t.y += OFFSET; }
      newIds.push(ent.id);
    }
    pushLog("log", "Pasted " + newIds.length + " object" + (newIds.length > 1 ? "s" : "") + ".");
    _setSelection(newIds);
  }

  document.addEventListener("keydown", (e) => {
    if (e.target.dataset && e.target.dataset.action === "rename-scene-input") {
      if (e.key === "Enter") {
        e.target.blur(); // triggers the focusout handler below, which commits + re-renders
      } else if (e.key === "Escape") {
        editorState.renamingSceneId = null;
        render();
      }
    }
    if (e.target.dataset && e.target.dataset.action === "rename-folder-input") {
      if (e.key === "Enter") {
        e.target.blur(); // triggers the focusout handler below, which commits + re-renders
      } else if (e.key === "Escape") {
        editorState.renamingFolderId = null;
        render();
      }
    }
    if (e.target.dataset && e.target.dataset.action === "rename-asset-input") {
      if (e.key === "Enter") {
        e.target.blur(); // triggers the focusout handler below, which commits + re-renders
      } else if (e.key === "Escape") {
        editorState.renamingAsset = null;
        render();
      }
    }
    if (e.target.dataset && e.target.dataset.action === "anim-rename-clip-input") {
      if (e.key === "Enter") {
        e.target.blur(); // triggers the focusout handler below, which commits + re-renders
      } else if (e.key === "Escape") {
        editorState.anim.renamingClipId = null;
        render();
      }
    }

    // Selection keyboard shortcuts — Delete/Backspace, Copy (Ctrl/Cmd+C),
    // Paste (Ctrl/Cmd+V), Duplicate (Ctrl/Cmd+D). Skipped while typing in a
    // field so Backspace and Ctrl+C keep their normal text-editing meaning.
    // Also skipped when the script editor overlay is open: Monaco captures
    // its own keyboard events (WASD, Space, etc.) internally, but the global
    // listener fires too and re-interprets those keys as editor shortcuts
    // (W→translate tool, Space→play), making it impossible to type them.
    // Belt-and-suspenders: check both the state flag AND whether the event
    // physically came from inside the overlay DOM (handles timing edge-cases
    // where the flag might lag a frame, and Monaco's hidden textarea which
    // some browsers don't surface as tagName "TEXTAREA" in e.target).
    const _typing = /^(input|textarea)$/i.test(e.target.tagName) || e.target.isContentEditable;
    const _inScriptEditor = editorState.scriptEditor.open ||
      !!(e.target.closest && e.target.closest(".script-editor-overlay"));
    // Also back off for Ctrl/Cmd+C specifically when the user has an actual
    // text selection (e.g. selecting an error message in the Export popup
    // to copy it). Without this, this handler's preventDefault() on "c"
    // below hijacks the browser's normal text copy and replaces it with
    // "copy the selected scene entities" — which is a no-op with nothing
    // selected in the scene, so Ctrl+C silently did nothing outside the
    // canvas. Only Ctrl+C is loosened this way; Delete/Backspace/Paste/
    // Duplicate keep the modal-aware checks below since they don't have
    // an equivalent "let the browser handle it" fallback.
    const _hasTextSelection = !!(window.getSelection && String(window.getSelection()).length > 0);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && _hasTextSelection) return;
    if (_typing || _inScriptEditor || editorState.exportOpen || !editorState.world) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault(); // stop Backspace navigating back / Delete scrolling
      if (_liveSelectionIds().length === 0) return;
      _deleteSelection();
      render();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "c") { e.preventDefault(); _copySelection(); return; }
      if (k === "v") { e.preventDefault(); _pasteSelection(); render(); return; }
      if (k === "d") { e.preventDefault(); _copySelection(); _pasteSelection(); render(); return; }
      // Undo / Redo — Ctrl/Cmd+Z for undo, Ctrl/Cmd+Shift+Z OR Ctrl+Y for
      // redo (covers both the Mac/Linux convention and the Windows-only
      // Ctrl+Y convention some users expect). Routed through
      // performUndoRedo(), which picks the "scene" or "anim" history
      // stack automatically based on whether the Animation editor is
      // currently open (see UndoManager.getActiveScope()) — so undo
      // inside the Animation editor never touches main-editor history
      // and vice versa, exactly like Delete/Copy/Paste above already
      // only ever act on the main editor's own selection.
      if (k === "z" && e.shiftKey) { e.preventDefault(); if (performUndoRedo("redo")) render(); return; }
      if (k === "z") { e.preventDefault(); if (performUndoRedo("undo")) render(); return; }
      if (k === "y") { e.preventDefault(); if (performUndoRedo("redo")) render(); return; }
    }

    // Tool shortcuts (Unity-style): Q=Pan, W=Translate, E=Rotate,
    // R=Scale. Space toggles Play/Pause. These fire only when NOT
    // typing in an input/textarea (guarded by _typing above).
    const key = e.key.toLowerCase();
    if (key === "q") { editorState.activeTool = "pan"; render(); return; }
    if (key === "w") { editorState.activeTool = "translate"; render(); return; }
    if (key === "e") { editorState.activeTool = "rotate"; render(); return; }
    if (key === "r") { editorState.activeTool = "scale"; render(); return; }
    if (key === "t") {
      const hasTile = editorState.world && (editorState.world.query(TILEMAP).length || editorState.world.query(TILESET).length);
      if (hasTile) editorState.activeTool = "tile";
      render(); return;
    }
    if (key === "y") {
      const hasPaintable = editorState.world && (editorState.world.query(TILEMAP).length || editorState.world.query(NAV_WORLD_2D).length);
      if (hasPaintable) editorState.activeTool = "erase";
      render(); return;
    }
    if (key === "u") {
      const hasNav = editorState.world && editorState.world.query(NAV_WORLD_2D).length;
      if (hasNav) editorState.activeTool = "nav";
      render(); return;
    }
    if (key === "i") {
      const hasNav = editorState.world && editorState.world.query(NAV_WORLD_2D).length;
      if (hasNav) editorState.activeTool = "nav-block";
      render(); return;
    }
    if (key === "o") {
      const hasNav = editorState.world && editorState.world.query(NAV_WORLD_2D).length;
      if (hasNav) editorState.activeTool = "nav-area";
      render(); return;
    }
    if (key === "p") {
      const hasStrokePath = editorState.world && editorState.world.query(STROKE_PATH).length;
      if (hasStrokePath) editorState.activeTool = "path";
      render(); return;
    }
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      editorState.isPlaying = !editorState.isPlaying;
      editorState.isPaused = false;
      onTogglePlay(editorState.isPlaying);
      render();
      return;
    }
  });

  document.addEventListener("focusout", (e) => {
    if (e.target.dataset && e.target.dataset.action === "rename-entity") {
      commitEdit("scene");
    }
    if (e.target.dataset && e.target.dataset.action === "rename-scene-input") {
      const sceneId = e.target.dataset.sceneId;
      const value = e.target.dataset.pendingValue !== undefined ? e.target.dataset.pendingValue : e.target.value;
      if (editorState.game && sceneId) editorState.game.renameScene(sceneId, value);
      editorState.renamingSceneId = null;
      render();
    }
    if (e.target.dataset && e.target.dataset.action === "rename-folder-input") {
      const folderId = e.target.dataset.folderId;
      const value = e.target.dataset.pendingValue !== undefined ? e.target.dataset.pendingValue : e.target.value;
      if (editorState.world && folderId && value && value.trim()) {
        snapshotNow("scene");
        editorState.world.renameHierarchyFolder(folderId, value);
      }
      editorState.renamingFolderId = null;
      render();
    }
    if (e.target.dataset && e.target.dataset.action === "rename-asset-input") {
      const kind = e.target.dataset.assetKind;
      const key = e.target.dataset.assetKey;
      const value = e.target.dataset.pendingValue !== undefined ? e.target.dataset.pendingValue : e.target.value;
      if (kind === "sprite" && editorState.game) {
        editorState.game.renameSpriteAsset(key, value);
      } else if (kind === "audio" && editorState.game) {
        editorState.game.renameAudioAsset(key, value);
      } else if (kind === "script") {
        // Scripts are identified BY name (see ScriptStorage.js), so a
        // script "rename" is a real key change, not just a display
        // label — unlike sprite/audio assets, where a script's name IS
        // its reference. renameScriptEverywhere() (the same function
        // the Script Editor's own tab-rename uses) already handles
        // updating every entity's Script.scriptName in the live World
        // plus Monaco's open tabs/models — see its own doc comment in
        // ScriptEditorWindow.js for exactly why that has to happen in
        // one place rather than each caller touching storage directly.
        // It silently no-ops (returns false) if the trimmed new name is
        // empty, unchanged, or already taken by another script, so a
        // failed rename just leaves the original name in place rather
        // than losing the script or clobbering a different one.
        renameScriptEverywhere(key, value);
      } else if (kind === "prefab") {
        // Prefabs are identified by a stable generated id (like sprite/
        // audio keys, NOT like scripts) — see PrefabRegistry.js — so
        // renamePrefab() only ever touches the display name, same
        // "id is stable, name is just a label" split as renameSpriteAsset.
        renamePrefab(key, value);
      }
      editorState.renamingAsset = null;
      render();
    }
    if (e.target.dataset && e.target.dataset.action === "anim-rename-clip-input") {
      const clipId = e.target.dataset.clipId;
      const value = e.target.dataset.pendingValue !== undefined ? e.target.dataset.pendingValue : e.target.value;
      const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
      const anim = entity && entity.getComponent(SPRITE_ANIMATION);
      const clip = anim && anim.clips.find((c) => c.id === clipId);
      if (clip && value.trim()) clip.name = value.trim();
      editorState.anim.renamingClipId = null;
      render();
    }
  });

  document.addEventListener("dragstart", (e) => {
    const spriteAssetTarget = e.target.closest('[data-action="drag-sprite-asset"]');
    if (spriteAssetTarget) {
      const key = spriteAssetTarget.dataset.spriteKey;
      if (!key) return;
      e.dataTransfer.setData("application/x-realot-sprite-key", key);
      e.dataTransfer.effectAllowed = "copy";
      return;
    }

    const audioAssetTarget = e.target.closest('[data-action="drag-audio-asset"]');
    if (audioAssetTarget) {
      const key = audioAssetTarget.dataset.audioKey;
      if (!key) return;
      e.dataTransfer.setData("application/x-realot-audio-key", key);
      e.dataTransfer.effectAllowed = "copy";
      return;
    }

    const prefabAssetTarget = e.target.closest('[data-action="drag-prefab-asset"]');
    if (prefabAssetTarget) {
      const prefabId = prefabAssetTarget.dataset.prefabId;
      if (!prefabId) return;
      e.dataTransfer.setData("application/x-realot-prefab-id", prefabId);
      e.dataTransfer.effectAllowed = "copy";
      return;
    }

    const frameTarget = e.target.closest('[data-action="anim-frame-thumb"]');
    if (frameTarget) {
      const index = parseInt(frameTarget.dataset.frameIndex, 10);
      editorState.anim.draggingFrameIndex = index;
      e.dataTransfer.effectAllowed = "move";
      // Firefox requires setData to be called for drag to actually
      // start at all — the value itself isn't read on drop (the
      // reorder reads editorState.anim.draggingFrameIndex instead,
      // since that survives across the render() a full HTML rebuild
      // would otherwise lose track of).
      e.dataTransfer.setData("text/plain", String(index));
      return;
    }

    const tilesetSlotTarget = e.target.closest('[data-action="tileset-slot"]');
    if (tilesetSlotTarget && tilesetSlotTarget.draggable) {
      const role = tilesetSlotTarget.dataset.role;
      editorState.tilesetPanel.draggingRole = role;
      e.dataTransfer.effectAllowed = "move";
      // Same Firefox-compatibility reasoning as the anim-frame-thumb
      // case just above: the actual swap reads
      // editorState.tilesetPanel.draggingRole on drop, not this value.
      e.dataTransfer.setData("text/plain", role);
      return;
    }

    // HIERARCHY FOLDERS: dragging an entity row or a folder row to file
    // it into (or out of) a folder. Checked in this order — entity row
    // before folder row — because a folder row's own draggable="true"
    // only applies to itself, not its descendants, so there's no
    // overlap to worry about; kept as two separate checks (rather than
    // one combined data-drag-role selector) so each can set its own
    // dataTransfer type string, same convention as sprite vs audio
    // assets above.
    const hierEntityTarget = e.target.closest('[data-drag-role="hierarchy-entity-row"]');
    if (hierEntityTarget) {
      const id = hierEntityTarget.dataset.id;
      if (!id) return;
      editorState.draggingEntityId = id;
      // If the grabbed row is part of the current multi-selection, drag
      // the WHOLE selection together (matches dragging a multi-selected
      // group of files in a normal file manager). A row that isn't part
      // of the selection just drags itself, same as before.
      editorState.draggingEntityIds =
        editorState.selectedIds.length > 1 && editorState.selectedIds.includes(id)
          ? editorState.selectedIds.slice()
          : [id];
      e.dataTransfer.effectAllowed = "move";
      // Firefox compatibility, same reasoning as anim-frame-thumb/
      // tileset-slot above — the real move reads editorState.
      // draggingEntityId on drop, not this value.
      e.dataTransfer.setData("text/plain", id);
      return;
    }

    const hierFolderTarget = e.target.closest('[data-drag-role="hierarchy-folder-row"]');
    if (hierFolderTarget) {
      const folderId = hierFolderTarget.dataset.folderId;
      if (!folderId) return;
      editorState.draggingFolderId = folderId;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", folderId);
    }
  });

  document.addEventListener("dragover", (e) => {
    if (e.target.closest('[data-action="anim-frame-thumb"]')) {
      e.preventDefault(); // required for drop to fire on this target at all
      e.dataTransfer.dropEffect = "move";
    }
    if (e.target.closest('[data-action="tileset-slot"]')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
    // A folder row accepts either an entity or another folder being
    // dragged onto it; the scene-root header accepts the same, as the
    // "move back to top level" target. Only preventDefault() (which is
    // what makes the element a valid drop target at all) while an
    // actual Hierarchy drag is in progress, so ordinary clicks/other
    // drags passing over these elements aren't affected. The
    // "drop-target" class gives a clear highlight distinct from plain
    // :hover (which browsers already keep live during a drag, but reads
    // the same as a normal mouseover with no indication a drop would
    // actually do anything there).
    if (_lastHierDropHighlight) {
      _lastHierDropHighlight.classList.remove("drop-target");
      _lastHierDropHighlight = null;
    }
    const overFolder = e.target.closest('[data-drag-role="hierarchy-folder-row"]');
    const overRoot = e.target.closest('[data-drag-role="hierarchy-root"]');
    if ((overFolder || overRoot) && (editorState.draggingEntityId || editorState.draggingFolderId)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const highlightTarget = overFolder || overRoot;
      highlightTarget.classList.add("drop-target");
      _lastHierDropHighlight = highlightTarget;
    }
  });

  document.addEventListener("drop", (e) => {
    const target = e.target.closest('[data-action="anim-frame-thumb"]');
    if (target) {
      e.preventDefault();
      const from = editorState.anim.draggingFrameIndex;
      const to = parseInt(target.dataset.frameIndex, 10);
      editorState.anim.draggingFrameIndex = null;
      if (from === null || from === undefined || from === to) {
        render();
        return;
      }
      const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
      const anim = entity && entity.getComponent(SPRITE_ANIMATION);
      const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
      if (clip) {
        snapshotNow("anim");
        const [moved] = clip.frames.splice(from, 1);
        clip.frames.splice(to, 0, moved);
      }
      render();
      return;
    }

    const tilesetTarget = e.target.closest('[data-action="tileset-slot"]');
    if (tilesetTarget) {
      e.preventDefault();
      const fromRole = editorState.tilesetPanel.draggingRole;
      const toRole = tilesetTarget.dataset.role;
      editorState.tilesetPanel.draggingRole = null;
      if (!fromRole || fromRole === toRole) {
        render();
        return;
      }
      const entity = editorState.world && editorState.world.getEntity(editorState.tilesetPanel.entityId);
      const tileset = entity && entity.getComponent(TILESET);
      if (tileset) {
        // Swap, not move-and-clear — dragging box A onto box B trades
        // their contents, matching the drag-to-"switch position"
        // behavior described for this feature (as opposed to the
        // frame-reorder case above, which shifts everything between
        // the two indices along a 1D list — a 4x4 grid of independent
        // roles has no equivalent "shift" to do instead of swapping).
        const temp = tileset.slots[toRole];
        tileset.slots[toRole] = tileset.slots[fromRole];
        tileset.slots[fromRole] = temp;
      }
      render();
      return;
    }

    // HIERARCHY FOLDERS: drop onto a folder row files the dragged
    // entity/folder into it; drop onto the scene-root header moves it
    // back to the top level. Checked in this order (folder target
    // before root target) since a folder row's own drop area doesn't
    // overlap the root header at all, but keeping the same order as
    // dragover above for consistency.
    const hierFolderDropTarget = e.target.closest('[data-drag-role="hierarchy-folder-row"]');
    if (hierFolderDropTarget && (editorState.draggingEntityId || editorState.draggingFolderId)) {
      e.preventDefault();
      if (_lastHierDropHighlight) {
        _lastHierDropHighlight.classList.remove("drop-target");
        _lastHierDropHighlight = null;
      }
      const targetFolderId = hierFolderDropTarget.dataset.folderId;
      if (editorState.draggingEntityId && editorState.world) {
        snapshotNow("scene");
        const ids = editorState.draggingEntityIds.length ? editorState.draggingEntityIds : [editorState.draggingEntityId];
        for (const id of ids) editorState.world.moveEntityToFolder(id, targetFolderId);
      } else if (editorState.draggingFolderId && editorState.world) {
        snapshotNow("scene");
        editorState.world.moveHierarchyFolder(editorState.draggingFolderId, targetFolderId);
      }
      editorState.draggingEntityId = null;
      editorState.draggingEntityIds = [];
      editorState.draggingFolderId = null;
      render();
      return;
    }

    const hierRootDropTarget = e.target.closest('[data-drag-role="hierarchy-root"]');
    if (hierRootDropTarget && (editorState.draggingEntityId || editorState.draggingFolderId)) {
      e.preventDefault();
      if (_lastHierDropHighlight) {
        _lastHierDropHighlight.classList.remove("drop-target");
        _lastHierDropHighlight = null;
      }
      if (editorState.draggingEntityId && editorState.world) {
        snapshotNow("scene");
        const ids = editorState.draggingEntityIds.length ? editorState.draggingEntityIds : [editorState.draggingEntityId];
        for (const id of ids) editorState.world.moveEntityToFolder(id, null);
      } else if (editorState.draggingFolderId && editorState.world) {
        snapshotNow("scene");
        editorState.world.moveHierarchyFolder(editorState.draggingFolderId, null);
      }
      editorState.draggingEntityId = null;
      editorState.draggingEntityIds = [];
      editorState.draggingFolderId = null;
      render();
    }
  });

  document.addEventListener("dragend", (e) => {
    if (e.target.closest('[data-action="anim-frame-thumb"]') && editorState.anim.draggingFrameIndex !== null) {
      // Drop landed somewhere that wasn't a valid frame-thumb target
      // (e.g. released outside the grid entirely) — clear the
      // in-progress drag state so the panel doesn't get stuck showing
      // a stale "dragging" highlight on the next render.
      editorState.anim.draggingFrameIndex = null;
      render();
    }
    if (e.target.closest('[data-action="tileset-slot"]') && editorState.tilesetPanel.draggingRole !== null) {
      editorState.tilesetPanel.draggingRole = null;
      render();
    }
    if (editorState.draggingEntityId !== null || editorState.draggingFolderId !== null) {
      // Same "clear stale drag state" reasoning as the two cases above —
      // release happened somewhere that isn't a valid Hierarchy drop
      // target (e.g. outside the panel entirely). The drop handler
      // already clears these on a SUCCESSFUL drop and re-renders, so
      // this only ever fires for an unsuccessful one.
      editorState.draggingEntityId = null;
      editorState.draggingEntityIds = [];
      editorState.draggingFolderId = null;
      if (_lastHierDropHighlight) {
        _lastHierDropHighlight.classList.remove("drop-target");
        _lastHierDropHighlight = null;
      }
      render();
    }
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "hierarchy-search-input") {
      editorState.hierarchyFilter = e.target.value;
      render();
      return;
    }

    if (e.target.id === "addcomp-search-input") {
      editorState.addComponentFilter = e.target.value;
      render();
      return;
    }

    if (e.target.dataset.action === "export-title-input") {
      // Live-buffer only, no render() — same reasoning as
      // rename-scene-input above: a full re-render mid-keystroke would
      // destroy this input's focus/caret position. The typed value is
      // already what's on screen; editorState is updated directly so
      // "start-export" (which reads editorState.exportGameTitle, not
      // the DOM) always has the latest value even without a render.
      editorState.exportGameTitle = e.target.value;
      return;
    }

    if (e.target.dataset.action === "android-server-label-input") {
      editorState.androidServerFormLabel = e.target.value; // same live-buffer reasoning as export-title-input above
      return;
    }
    if (e.target.dataset.action === "android-server-url-input") {
      editorState.androidServerFormUrl = e.target.value;
      editorState.androidServerFormError = "";
      return;
    }
    if (e.target.dataset.action === "android-server-key-input") {
      editorState.androidServerFormKey = e.target.value;
      editorState.androidServerFormError = "";
      return;
    }

    if (e.target.dataset.action === "rename-entity") {
      const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
      if (entity) {
        beginEdit("scene"); // no-op after the first keystroke; committed on blur below
        entity.name = e.target.value;
      }
      return; // don't re-render mid-keystroke; avoids losing caret position
    }

    if (e.target.dataset.action === "rename-scene-input") {
      // live-buffer only; committed on blur/Enter (see below) so a
      // full render() doesn't blow away the input mid-keystroke
      e.target.dataset.pendingValue = e.target.value;
      return;
    }

    if (e.target.dataset.action === "rename-folder-input") {
      // Same live-buffer pattern as rename-scene-input just above.
      e.target.dataset.pendingValue = e.target.value;
      return;
    }

    if (e.target.dataset.action === "rename-asset-input") {
      // Same live-buffer pattern as rename-scene-input just above.
      e.target.dataset.pendingValue = e.target.value;
      return;
    }

    if (e.target.dataset.action === "anim-rename-clip-input") {
      e.target.dataset.pendingValue = e.target.value;
      return;
    }

    // Physics layer rename — committed live on each keystroke so changes
    // are persisted immediately (no blur/Enter required, mirrors Unity's
    // inline rename UX). Does NOT trigger a full render() to avoid
    // destroying the focused input mid-typing; the next click or panel
    // switch will naturally pick up the new names from localStorage.
    if (e.target.dataset.action === "pl-rename") {
      const idx = parseInt(e.target.dataset.layerIndex, 10);
      if (!isNaN(idx)) setLayerName(idx, e.target.value);
      return;
    }

    // Nav area rename — same live-commit-on-keystroke behavior as
    // pl-rename above, applied to editor/state/NavAreas.js instead of
    // PhysicsLayers.js.
    if (e.target.dataset.action === "na-rename") {
      const idx = parseInt(e.target.dataset.areaIndex, 10);
      if (!isNaN(idx)) setNavAreaName(idx, e.target.value);
      return;
    }

    const field = e.target.dataset.field;
    if (field) {
      // Begin one undo step for this whole edit gesture (a slider/number
      // drag firing many "input" ticks, or a text field being typed into
      // keystroke by keystroke) — beginEdit() is a no-op if one is
      // already open for this scope, so repeated ticks don't reset the
      // "before" snapshot back to a mid-edit state. The matching
      // commitEdit() on "change" below (fired once on blur/Enter/drag-
      // release) is what actually pushes the step.
      beginEdit("scene");
      applyFieldChange(field, e.target);
      // Color inputs: update the Scene viewport's rendered background
      // live on every drag tick, WITHOUT a full render() — render()
      // rebuilds the entire DOM tree, which would destroy/reopen the
      // native color picker popover mid-drag. A full render() still
      // happens on "change" (picker closed) to refresh the swatch's own
      // displayed value and any other UI that reflects the color.
      if (e.target.type === "color") syncBackgroundColorLive();
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.dataset.action === "set-active-nav-area") {
      const idx = parseInt(e.target.value, 10);
      if (!isNaN(idx)) editorState.activeNavAreaIndex = idx;
      return;
    }
    if (e.target.dataset.action === "export-favicon-input") {
      const file = e.target.files && e.target.files[0];
      e.target.value = ""; // allow re-selecting the same filename later
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        editorState.exportFavicon = { dataUrl: reader.result, name: file.name };
        render();
      };
      reader.onerror = () => {
        pushLog("error", "Failed to read favicon image '" + file.name + "'.");
        render();
      };
      reader.readAsDataURL(file);
      return;
    }
    if (e.target.dataset.action === "load-project-input") {
      const file = e.target.files && e.target.files[0];
      e.target.value = ""; // allow re-selecting the same filename later
      loadProjectFromFile(file);
      return;
    }
    if (e.target.dataset.action === "import-sprite-input") {
      const files = e.target.files;
      if (files && files.length) {
        const gifFiles = [];
        const imageFiles = [];
        for (const file of Array.from(files)) {
          if (file.type === "image/gif" || /\.gif$/i.test(file.name)) gifFiles.push(file);
          else imageFiles.push(file);
        }
        const promises = [];
        if (imageFiles.length) {
          promises.push(
            importSpriteFiles(imageFiles).then((imported) => {
              for (const asset of imported) {
                pushLog("log", "Imported sprite '" + asset.name + "' (" + asset.width + "x" + asset.height + ").");
              }
            })
          );
        }
        for (const gifFile of gifFiles) {
          promises.push(
            importGifFrames(gifFile)
              .then(({ frames, fps }) => {
                if (frames.length === 0) return;
                const name = gifFile.name.replace(/\.[^.]+$/, "");
                const record = {
                  key: frames[0].spriteKey,
                  name,
                  dataUrl: frames[0].dataUrl,
                  width: frames[0].width,
                  height: frames[0].height,
                  gifFrames: frames.map((f) => f.spriteKey),
                  gifFps: fps,
                };
                registerSpriteAsset(record);
                pushLog("log", "Imported animated GIF '" + name + "' (" + frames.length + " frames, " + fps + " fps).");
              })
          );
        }
        Promise.all(promises)
          .then(() => render())
          .catch((err) => {
            pushLog("error", "Failed to import sprite: " + err.message);
            render();
          });
      }
      e.target.value = ""; // allow re-importing the same filename later
      return;
    }

    if (e.target.dataset.action === "import-audio-input") {
      const files = e.target.files;
      if (files && files.length) {
        importAudioFiles(files)
          .then((imported) => {
            for (const asset of imported) {
              pushLog("log", "Imported audio '" + asset.name + "'.");
            }
            render();
          })
          .catch((err) => {
            pushLog("error", "Failed to import audio: " + err.message);
            render();
          });
      }
      e.target.value = "";
      return;
    }

    if (e.target.dataset.action === "anim-import-images" || e.target.dataset.action === "anim-import-zip") {
      const files = e.target.files;
      const isZip = e.target.dataset.action === "anim-import-zip";
      const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
      const anim = entity && entity.getComponent(SPRITE_ANIMATION);
      const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
      if (files && files.length && clip) {
        const importPromise = isZip ? importZipImageFrames(files[0]) : importStandaloneImageFrames(files);
        importPromise
          .then((frames) => {
            clip.frames.push(...frames);
            pushLog("log", "Added " + frames.length + " frame(s) to '" + clip.name + "'.");
            render();
          })
          .catch((err) => {
            pushLog("error", "Failed to import animation frames: " + err.message);
            render();
          });
      }
      e.target.value = "";
      return;
    }

    if (e.target.dataset.action === "anim-import-gif") {
      const file = e.target.files && e.target.files[0];
      const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
      const anim = entity && entity.getComponent(SPRITE_ANIMATION);
      const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
      if (file && clip) {
        importGifFrames(file)
          .then(({ frames, fps }) => {
            clip.frames.push(...frames);
            if (fps > 0) clip.fps = fps;
            pushLog("log", "Extracted " + frames.length + " frame(s) from GIF '" + file.name + "' (fps set to " + fps + ").");
            render();
          })
          .catch((err) => {
            pushLog("error", "Failed to import GIF: " + err.message);
            render();
          });
      }
      e.target.value = "";
      return;
    }

    if (e.target.dataset.action === "tileset-import-single") {
      const file = e.target.files && e.target.files[0];
      const entity = editorState.world && editorState.world.getEntity(editorState.tilesetPanel.entityId);
      const tileset = entity && entity.getComponent(TILESET);
      if (file && tileset) {
        sliceTilesetImageIntoRoles(file)
          .then((roleMap) => {
            for (const role of TILE_ROLE_ORDER) {
              const produced = roleMap[role];
              if (!produced) continue;
              tileset.slots[role] = produced.spriteKey;
              registerSpriteAsset({ key: produced.spriteKey, name: tileset.name + "_" + role, dataUrl: produced.dataUrl, width: tileset.tileWidth, height: tileset.tileHeight });
            }
            pushLog("log", "Sliced '" + file.name + "' into all 16 tileset slots.");
            render();
          })
          .catch((err) => {
            pushLog("error", "Failed to slice tileset image: " + err.message);
            render();
          });
      }
      e.target.value = "";
      return;
    }

    if (e.target.dataset.action === "tileset-import-multi") {
      const files = e.target.files;
      const entity = editorState.world && editorState.world.getEntity(editorState.tilesetPanel.entityId);
      const tileset = entity && entity.getComponent(TILESET);
      if (files && files.length && tileset) {
        // Fill EMPTY slots first, in TILE_ROLE_ORDER (the same row-major
        // order the 4x4 grid displays), so importing several images at
        // once lands them in a predictable order without the user
        // having to drag each one individually — they can still
        // drag-swap afterward to fix up placement (see the "drop"
        // handler's tileset-slot swap case above).
        const emptyRoles = TILE_ROLE_ORDER.filter((role) => !tileset.slots[role]);
        const importList = Array.from(files).slice(0, emptyRoles.length);
        Promise.all(importList.map((file) => loadSingleTileImage(file)))
          .then((results) => {
            results.forEach((produced, i) => {
              const role = emptyRoles[i];
              tileset.slots[role] = produced.spriteKey;
              registerSpriteAsset({ key: produced.spriteKey, name: tileset.name + "_" + role, dataUrl: produced.dataUrl, width: tileset.tileWidth, height: tileset.tileHeight });
            });
            pushLog("log", "Imported " + results.length + " tile image(s).");
            render();
          })
          .catch((err) => {
            pushLog("error", "Failed to import tile images: " + err.message);
            render();
          });
      }
      e.target.value = "";
      return;
    }

    if (e.target.dataset.action === "tileset-import-slot") {
      const file = e.target.files && e.target.files[0];
      const role = e.target.dataset.role;
      const entity = editorState.world && editorState.world.getEntity(editorState.tilesetPanel.entityId);
      const tileset = entity && entity.getComponent(TILESET);
      if (file && tileset && role) {
        loadSingleTileImage(file)
          .then((produced) => {
            tileset.slots[role] = produced.spriteKey;
            registerSpriteAsset({ key: produced.spriteKey, name: tileset.name + "_" + role, dataUrl: produced.dataUrl, width: tileset.tileWidth, height: tileset.tileHeight });
            render();
          })
          .catch((err) => {
            pushLog("error", "Failed to import tile image: " + err.message);
            render();
          });
      }
      e.target.value = "";
      return;
    }

    if (e.target.dataset.action === "anim-import-sheet") {
      const file = e.target.files && e.target.files[0];
      const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
      const anim = entity && entity.getComponent(SPRITE_ANIMATION);
      const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
      if (file && clip) {
        // Auto-detect first (see AnimationImport.js's _autoDetectSpriteRects
        // doc) — the manual-grid override path is offered separately via
        // the "Slice with custom grid…" prompt below rather than asked
        // for up front every time, since auto-detect correctly handles
        // the common padded-sheet case with zero extra input from the
        // user, matching the "auto-detect as default, manual grid as
        // override" behavior this feature was specifically built for.
        importSpriteSheetFrames(file)
          .then((frames) => {
            if (frames.length <= 1) {
              // Auto-detect found only a single region — almost
              // certainly means the sheet has no transparent gutters
              // for it to detect against, so offer the manual grid
              // override immediately rather than silently importing
              // what's very likely a wrong single-frame result.
              const cols = parseInt(window.prompt("Auto-detect found only 1 frame. Enter number of COLUMNS for a manual grid slice (Cancel to keep 1 frame):", "4") || "", 10);
              if (cols) {
                const rowsInput = window.prompt("Number of ROWS:", "1");
                const rows = parseInt(rowsInput || "1", 10) || 1;
                importSpriteSheetFrames(file, { cols, rows })
                  .then((gridFrames) => {
                    clip.frames.push(...gridFrames);
                    pushLog("log", "Sliced sheet into " + gridFrames.length + " frame(s) (" + cols + "x" + rows + " grid) for '" + clip.name + "'.");
                    render();
                  })
                  .catch((err) => {
                    pushLog("error", "Failed to slice sprite sheet: " + err.message);
                    render();
                  });
                return;
              }
            }
            clip.frames.push(...frames);
            pushLog("log", "Sliced sheet into " + frames.length + " frame(s) (auto-detected) for '" + clip.name + "'.");
            render();
          })
          .catch((err) => {
            pushLog("error", "Failed to slice sprite sheet: " + err.message);
            render();
          });
      }
      e.target.value = "";
      return;
    }

    const field = e.target.dataset.field;
    if (field) {
      // Checkbox/select fields fire ONLY "change" (no "input"), so there
      // may be no beginEdit() open yet for those — beginEdit() is safe
      // to call again here regardless (no-op if one's already pending
      // from the input handler above; captures the correct "before"
      // snapshot on its own if not). Either way this commits the whole
      // gesture as exactly one undo step.
      beginEdit("scene");
      // Prefab override tracking: snapshot this entity's components
      // BEFORE the edit and diff AFTER (see PrefabPropagation.js's own
      // doc comment for why this is diff-based rather than hooking
      // every one of applyFieldChange()'s many special-case branches
      // individually). Only meaningful once per gesture, so this lives
      // here on "change" rather than the "input" handler above, which
      // fires many times per drag/keystroke — diffing there would keep
      // re-deriving the same result on every tick for no benefit.
      // snapshotEntityComponents()/diffEntityAndRecordOverrides() are
      // both no-ops (cheap) for an entity that isn't a prefab instance,
      // so this is safe to call unconditionally without checking
      // prefabId here first.
      const prefabEditEntity = editorState.world && editorState.world.getEntity(editorState.selectedId);
      const prefabEditBefore = prefabEditEntity ? snapshotEntityComponents(prefabEditEntity) : null;
      applyFieldChange(field, e.target);
      if (prefabEditEntity) diffEntityAndRecordOverrides(prefabEditEntity, prefabEditBefore);
      commitEdit("scene");
      render();
    }
  });

  // Animation panel preview playback: a small independent ticker (NOT
  // tied to the game's own GameLoop/AnimationSystem — the panel needs
  // to preview a clip's frames even while the game itself isn't
  // running) that advances editorState.anim.previewFrameIndex at the
  // EDITING clip's own fps whenever the panel is open and its preview
  // "play" toggle is on. Mirrors the existing isPlaying/isPaused
  // polling interval in main.js's boot(), same reasoning: something
  // needs to keep calling render() on a timer for state that changes
  // without any user input in between frames.
  let _lastPreviewTick = performance.now();
  setInterval(() => {
    if (!editorState.animOpen || !editorState.anim.previewPlaying) {
      _lastPreviewTick = performance.now();
      return;
    }
    const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
    const anim = entity && entity.getComponent(SPRITE_ANIMATION);
    const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
    if (!clip || clip.frames.length === 0) return;

    const now = performance.now();
    const elapsedSec = (now - _lastPreviewTick) / 1000;
    const secondsPerFrame = 1 / Math.max(0.1, clip.fps);
    if (elapsedSec < secondsPerFrame) return;
    _lastPreviewTick = now;

    editorState.anim.previewFrameIndex = (editorState.anim.previewFrameIndex + 1) % clip.frames.length;
    if (editorState.anim.previewFrameIndex === 0 && !clip.loop) {
      // Reached the end of a non-looping clip — hold on the last
      // frame and stop, matching AnimationSystem's own real-playback
      // behavior for a non-looping clip (see AnimationSystem._advance).
      editorState.anim.previewFrameIndex = clip.frames.length - 1;
      editorState.anim.previewPlaying = false;
    }
    render();
  }, 33); // ~30Hz poll is plenty for a UI preview; the fps gate above is what actually paces frame advances
}

/**
 * Writes a single input's value back onto the selected entity's
 * component. `field` looks like "Transform.position" (with data-axis)
 * or "SpriteRenderer.color".
 */
function applyFieldChange(field, inputEl) {
  const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
  if (!entity) return;

  if (field === "entity.tag") {
    if (inputEl.value === "Add Tag...") {
      const created = window.prompt("Create an object tag:", "");
      if (created && created.trim()) {
        const tag = addTag(created);
        if (tag) entity.tag = tag;
      }
    } else if (inputEl.value.trim()) {
      entity.tag = addTag(inputEl.value) || inputEl.value;
    }
    return;
  }

  // SpriteAnimation has two field shapes the generic componentName.propName
  // split below can't handle: "SpriteAnimation.currentClipName" (needs to
  // resolve a clip NAME back to its stable id) and
  // "SpriteAnimation.clipOverride.<clipId>.<prop>" (three dots, needs to
  // reach into a specific clip's colliderOverride object). Handle both
  // explicitly before falling through to the generic path everything else
  // uses.
  if (field.startsWith("SpriteAnimation.")) {
    const anim = entity.getComponent(SPRITE_ANIMATION);
    if (!anim) return;
    const rest = field.slice("SpriteAnimation.".length);

    if (rest === "currentClipName") {
      const clip = anim.clips.find((c) => c.name === inputEl.value);
      if (clip) anim.currentClipId = clip.id;
      anim.currentFrameIndex = 0;
      anim.frameElapsed = 0;
      return;
    }

    // Distinct from currentClipName above: this is the Animation
    // panel's OWN clip picker (editorState.anim.editingClipId) —
    // switching which clip you're EDITING/previewing in the panel must
    // NOT also change which clip is actually PLAYING in gameplay/the
    // Inspector; those are intentionally independent (see the doc
    // comment on editorState.anim.editingClipId in EditorState.js).
    if (rest === "editingClipName") {
      const clip = anim.clips.find((c) => c.name === inputEl.value);
      if (clip) {
        editorState.anim.editingClipId = clip.id;
        editorState.anim.previewFrameIndex = 0;
        editorState.anim.previewPlaying = false;
      }
      return;
    }

    if (rest === "speed") {
      anim.speed = parseFloat(inputEl.value) || 0;
      return;
    }

    const fpsMatch = rest.match(/^clipFps\.(.+)$/);
    if (fpsMatch) {
      const clip = anim.clips.find((c) => c.id === fpsMatch[1]);
      if (clip) clip.fps = Math.max(0.1, parseFloat(inputEl.value) || 12);
      return;
    }

    const overrideMatch = rest.match(/^clipOverride\.([^.]+)\.(.+)$/);
    if (overrideMatch) {
      const [, clipId, prop] = overrideMatch;
      const clip = anim.clips.find((c) => c.id === clipId);
      if (!clip || !clip.colliderOverride) return;
      const value =
        inputEl.type === "checkbox" ? inputEl.checked : inputEl.type === "number" ? parseFloat(inputEl.value) || 0 : inputEl.value;
      clip.colliderOverride[prop] = value;

      // Switching SHAPE via the dropdown only ever set this one prop —
      // it never touched the shape-specific size fields (radius,
      // capsuleRadius/HalfHeight, trianglePoints). Since colliderOverride
      // is a plain object spread from whatever the base Collider2D had
      // (not always a full `new Collider2D()`), those fields may be
      // stale from a PREVIOUS shape, or entirely missing if the base was
      // never that shape — e.g. a Box-only override switched to Triangle
      // has no trianglePoints at all, which _colliderLocalBounds() (the
      // Animation panel's preview overlay) reads as a zero-size box:
      // invisible outline, exactly the "can't see the dots" bug. Re-seed
      // the NEW shape's size fields from the entity's actual sprite
      // dimensions whenever shape itself changes, same sizing logic used
      // when a collider is first created (see _sizedColliderDefaults).
      if (prop === "shape") {
        const sized = _sizedColliderDefaults(entity);
        if (Object.keys(sized).length) {
          if (value === ColliderShape.CIRCLE) clip.colliderOverride.radius = sized.radius;
          else if (value === ColliderShape.CAPSULE) {
            clip.colliderOverride.capsuleRadius = sized.capsuleRadius;
            clip.colliderOverride.capsuleHalfHeight = sized.capsuleHalfHeight;
          } else if (value === ColliderShape.TRIANGLE) {
            clip.colliderOverride.trianglePoints = sized.trianglePoints;
          } else {
            clip.colliderOverride.width = sized.width;
            clip.colliderOverride.height = sized.height;
          }
        }
      }
      return;
    }
    return;
  }

  // Collision layer — stored as an integer 0-15, but dropdownInput emits
  // a string value; parse it explicitly before the generic path can
  // mishandle it (parseFloat("0") works, but parseFloat("Default (0)") = NaN).
  if (field === "Collider2D.layer") {
    const collider = entity.getComponent(COLLIDER_2D);
    if (collider) {
      const nextLayer = Math.max(0, Math.min(15, parseInt(inputEl.value, 10) || 0));
      if (collider.layer !== nextLayer) {
        collider.layer = nextLayer;
        markDirty();
      }
    }
    return;
  }

  // Collision mask — each layer is a checkbox that toggles one bit of
  // the 16-bit mask rather than replacing the whole value.
  if (field === "Collider2D.mask") {
    const collider = entity.getComponent(COLLIDER_2D);
    if (collider) {
      const bit = parseInt(inputEl.dataset.bit, 10);
      if (!isNaN(bit)) {
        const beforeMask = collider.mask;
        if (inputEl.checked) {
          collider.mask = (collider.mask | (1 << bit)) & 0xFFFF;
        } else {
          collider.mask = (collider.mask & ~(1 << bit)) & 0xFFFF;
        }
        if (collider.mask !== beforeMask) markDirty();
      }
    }
    return;
  }

  // Nav Agent 2D's Navigation > Area checklist — same one-checkbox-per-
  // bit convention as Collider2D.mask above, applied to which NavWorld2D
  // areas (Ground/Water/Mud/...) this agent may path through. See
  // components/NavAgent2D.js's `area` field and editor/state/NavAreas.js.
  // Deliberately no NavAgent2D.layer handler here — that field was
  // removed; Unity's NavMeshAgent has no equivalent concept either, and
  // physics layers (Collider2D.layer/mask) already cover "which physics
  // layer does this entity belong to" — folding a second, unused
  // "layer" into navigation was a design mistake, not a missing feature.
  if (field === "NavAgent2D.area") {
    const navAgent = entity.getComponent(NAV_AGENT_2D);
    if (navAgent) {
      const bit = parseInt(inputEl.dataset.bit, 10);
      if (!isNaN(bit)) {
        const beforeArea = navAgent.area;
        if (inputEl.checked) {
          navAgent.area = (navAgent.area | (1 << bit)) & 0xFFFF;
        } else {
          navAgent.area = (navAgent.area & ~(1 << bit)) & 0xFFFF;
        }
        if (navAgent.area !== beforeArea) markDirty();
      }
    }
    return;
  }

  // Nav Agent 2D's per-agent Area Costs list — the checkbox that turns
  // an override for one area slot on/off. Same data-area-index
  // indexed-array convention as NavWorld2D.areaCost below, applied to
  // NavAgent2D.areaCosts instead — see that field's header in
  // NavAgent2D.js for the "null until overridden, falls back to the
  // Nav World 2D otherwise" semantics.
  if (field === "NavAgent2D.areaCostOverrideEnabled") {
    const navAgent = entity.getComponent(NAV_AGENT_2D);
    if (navAgent) {
      const idx = parseInt(inputEl.dataset.areaIndex, 10);
      if (!isNaN(idx)) {
        if (inputEl.checked) {
          // Turning an override ON: seed it with whatever cost is
          // currently DISPLAYED for this slot (the world default, read
          // back off the paired number input in the same row) so
          // checking the box doesn't silently jump the value — the
          // agent starts out matching the world, then the number input
          // becomes editable to diverge from it.
          const row = inputEl.closest("div");
          const numberInput = row ? row.querySelector('input[type="number"][data-field="NavAgent2D.areaCost"]') : null;
          const seedValue = numberInput ? parseFloat(numberInput.value) : 1;
          if (setNavAgentAreaCost(navAgent, idx, Number.isFinite(seedValue) ? seedValue : 1)) markDirty();
        } else {
          if (setNavAgentAreaCost(navAgent, idx, null)) markDirty();
        }
      }
    }
    return;
  }

  // Nav Agent 2D's per-agent Area Costs list — the numeric input itself,
  // only live while its paired checkbox override is enabled (see the
  // Inspector's `disabled` attribute on this input when unchecked).
  if (field === "NavAgent2D.areaCost") {
    const navAgent = entity.getComponent(NAV_AGENT_2D);
    if (navAgent) {
      const idx = parseInt(inputEl.dataset.areaIndex, 10);
      if (!isNaN(idx) && setNavAgentAreaCost(navAgent, idx, parseFloat(inputEl.value))) {
        // Same reasoning as NavWorld2D.areaCost below: this is scene
        // data, not editor UI state, so autosave needs to see it.
        markDirty();
      }
    }
    return;
  }

  // Nav World 2D's Area Costs list — one numeric input per named area
  // slot, each tagged with which slot it edits via data-area-index
  // (can't use the generic componentName.propName path below since this
  // isn't a single scalar property but one entry in an indexed array).
  // See NavWorld2D.areaCosts's header for the mask-vs-cost distinction.
  if (field === "NavWorld2D.areaCost") {
    const navWorld = entity.getComponent(NAV_WORLD_2D);
    if (navWorld) {
      const idx = parseInt(inputEl.dataset.areaIndex, 10);
      if (!isNaN(idx) && setNavAreaCost(navWorld, idx, parseFloat(inputEl.value))) {
        // Area cost is scene data, not merely editor UI state. Without
        // marking the project dirty here, autosave can skip the edit, so
        // a browser refresh restores the old cost and makes the feature
        // appear to stop working.
        markDirty();
      }
    }
    return;
  }

  if (field === "Light.type") {
    const light = entity.getComponent(LIGHT);
    if (light) {
      const wasFreeform = light.type === LightType.FREEFORM;
      light.type = inputEl.value;
      // Switching INTO Freeform: re-seed radius to a sane feather width
      // (see FREEFORM_DEFAULT_FEATHER's doc comment) unless it's
      // already small enough to be a plausible feather rather than a
      // leftover Point/Spot/Area reach distance.
      if (light.type === LightType.FREEFORM && !wasFreeform && light.radius > 60) {
        light.radius = FREEFORM_DEFAULT_FEATHER;
      }
    }
    return;
  }

  if (field === "AudioSource.is3DLabel") {
    const audioSource = entity.getComponent(AUDIO_SOURCE);
    if (audioSource) audioSource.is3D = inputEl.value === "3D";
    return;
  }

  // Script.scriptName can't go through the generic component[propName] =
  // value path below: a script's source lives in ScriptStorage keyed by
  // name, and the SAME script can be attached to several entities. A
  // blind property write would only rename it on this one entity (every
  // other owner keeps pointing at the old name) and would leave the old
  // storage entry behind — so the next edit re-saves the source under a
  // brand-new key, effectively creating a duplicate script "file" instead
  // of renaming the original. renameScriptEverywhere() is the single
  // shared path (also used by the Script Editor's own tab-rename) that
  // moves the storage entry, updates every entity that references it, and
  // keeps any open Script Editor tab/model in sync.
  if (field === "Script.scriptName") {
    const oldName = entity.getComponent(SCRIPT) && entity.getComponent(SCRIPT).scriptName;
    if (oldName == null) return;
    const newName = inputEl.value;
    if (renameScriptEverywhere(oldName, newName) === false && newName.trim() && newName.trim() !== oldName) {
      pushLog("error", 'A script named "' + newName.trim() + '" already exists.');
      inputEl.value = oldName; // revert the input so the field doesn't show a name that didn't actually take
    }
    return;
  }

  const [componentName, propName] = field.split(".");
  const componentType = COMPONENT_TYPE_MAP[componentName];
  const component = componentType && entity.getComponent(componentType);
  if (!component) return;

  const axis = inputEl.dataset.axis;
  let value;
  if (inputEl.type === "checkbox") value = inputEl.checked;
  else if (inputEl.type === "number") {
    // ShadowCaster.width/height are an OPTIONAL override (null means
    // "use this object's real sprite bounds" — see components/
    // ShadowCaster.js) rather than a plain numeric field defaulting to
    // 0, so a blank input there must round-trip back to null, not 0
    // (0 would mean "zero-size occluder", a completely different and
    // surprising thing to type-blank-and-get).
    if (componentName === "ShadowCaster" && (propName === "width" || propName === "height") && inputEl.value.trim() === "") {
      value = null;
    } else {
      value = parseFloat(inputEl.value) || 0;
    }
    // StrokePath.smoothing is a 0-1 blend factor (see StrokePath.js's
    // constructor clamp) — clamp here too so a typed value like "5"
    // can't sneak past the Inspector into a component field the
    // geometry code assumes is already 0-1 (StrokePathGeometry.js's
    // resampleSmoothPoints re-clamps defensively, but doing it here as
    // well keeps the Inspector's own displayed value honest instead of
    // silently showing "5" while the curve behaves as if it were 1).
    if (componentName === "StrokePath" && propName === "smoothing") {
      value = Math.max(0, Math.min(1, value));
    }
  } else if (componentName === "Joint2D" && propName === "connectedEntityId") {
    // Joint2D.connectedEntityId uses null (not "") for "joint to a fixed
    // point in the world" (see components/Joint2D.js and JointAPI.js's
    // own null handling). The Inspector's <select> reports that choice
    // as an empty string, so map it back to null here so the saved
    // component data always matches what the component documents.
    value = inputEl.value === "" ? null : inputEl.value;
  } else value = inputEl.value;

  if (axis && propName === "position") {
    component.x = axis === "x" ? value : component.x;
    component.y = axis === "y" ? value : component.y;
    component.z = axis === "z" ? value : component.z;
  } else if (propName === "rotation") {
    // Transform.rotation is a single Z-axis degree value (2D engine —
    // see runtime/components/Transform.js) — no axis to disambiguate,
    // so this now writes directly instead of checking data-axis==="x"
    // (there's no more X/Y/Z rotation control in the Inspector to
    // produce that attribute; see vec2Input/numInput usage above).
    component.rotation = value;
  } else if (axis && propName === "scale") {
    component.scaleX = axis === "x" ? value : component.scaleX;
    component.scaleY = axis === "y" ? value : component.scaleY;
  } else {
    component[propName] = value;

    // Same reasoning as the clipOverride shape-switch handling above:
    // changing Collider2D.shape alone leaves whichever size field the
    // NEW shape needs at its old value, which — if this collider has
    // never been that shape before, or was itself created before sized
    // defaults existed — can be the tiny raw constructor default (a 1px
    // box, 0.5px radius, or ±0.5px triangle points; see
    // _sizedColliderDefaults' doc comment) rather than anything sized to
    // the entity's actual sprite. Re-seed the new shape's size fields
    // from the sprite whenever shape changes on the base Collider2D too.
    if (componentName === "ShapeRenderer" && propName === "shapeType") {
      // Re-seed the new shape type's size fields to sane defaults when
      // switching — same reasoning as Collider2D.shape just below:
      // without this, switching e.g. Square -> Circle leaves radius at
      // whatever the constructor default was, which can look wrong if
      // the user had already resized the square to something large.
      // A shape has no sprite to size against (unlike a Collider2D,
      // which sizes to the entity's SpriteRenderer via
      // _sizedColliderDefaults), so this seeds from a fresh
      // ShapeRenderer's own defaults instead.
      const fresh = new ShapeRenderer();
      if (value === ShapeType.CIRCLE) component.radius = fresh.radius;
      else if (value === ShapeType.CAPSULE) {
        component.capsuleHalfHeight = fresh.capsuleHalfHeight;
        component.capsuleRadius = fresh.capsuleRadius;
      } else if (value === ShapeType.TRIANGLE) {
        component.trianglePoints = fresh.trianglePoints;
      } else {
        component.width = fresh.width;
        component.height = fresh.height;
      }
    }

    if (componentName === "Collider2D" && propName === "shape") {
      const sized = _sizedColliderDefaults(entity);
      if (Object.keys(sized).length) {
        if (value === ColliderShape.CIRCLE) component.radius = sized.radius;
        else if (value === ColliderShape.CAPSULE) {
          component.capsuleRadius = sized.capsuleRadius;
          component.capsuleHalfHeight = sized.capsuleHalfHeight;
        } else if (value === ColliderShape.TRIANGLE) {
          component.trianglePoints = sized.trianglePoints;
        } else {
          component.width = sized.width;
          component.height = sized.height;
        }
      }
    }
  }
}

/**
 * Loads a project file (.rs, or an older .zip) into the editor, replacing the
 * current project. Used by File -> Load Project and by double-clicking a .rs
 * file in the OS (see the launchQueue consumer in main.js).
 *
 * @param {File} file
 * @param {{skipReplaceConfirm?: boolean}} [options]  A file the user just
 *   opened from their OS has already been confirmed by that action, so the
 *   "this replaces everything" prompt is skipped. The warning about scripts
 *   inside the project is never skipped.
 * @returns {Promise<boolean>} true if the project was loaded
 */
export function loadProjectFromFile(file, options) {
  const opts = options || {};
  // render() is a parameter of attachEditorEvents (not visible from here);
  // the editor publishes the same function as editorState.renderFn.
  const render = () => { if (editorState.renderFn) editorState.renderFn(); };
  if (!file || !editorState.game) return Promise.resolve(false);
  if (!opts.skipReplaceConfirm && !window.confirm(
    'Load project "' + file.name + '"? This replaces every scene, sprite, audio clip, script, and physics layer name currently in the editor with the ones from this file. This can\'t be undone.'
  )) return Promise.resolve(false);
  pushLog("log", "Loading project…");
  return importProject(editorState.game, file, {
    confirmScripts: (count) => window.confirm(
      "This project contains " + count + " script" + (count === 1 ? "" : "s") + ". " +
      "Scripts run as normal code with this editor's permissions, including access to " +
      "anything saved in this browser (such as Android build server keys).\n\n" +
      "Only load projects from people you trust. Load it anyway?"
    ),
  })
    .then(({ manifest, versionWarning }) => {
      editorState.projectName = manifest.projectName || editorState.projectName;
      editorState.projectFolder = "scenes";
      if (versionWarning) {
        pushLog("warn", versionWarning);
        window.alert(versionWarning);
      }
      pushLog("log", "Loaded project '" + (manifest.projectName || file.name) + "'.");
      syncAfterExternalSceneChange();
      render();
      return true;
    })
    .catch((err) => {
      if (err && err.cancelled) {
        pushLog("log", "Project load cancelled.");
      } else {
        pushLog("error", "Failed to load project: " + err.message);
      }
      render();
      return false;
    });
}
