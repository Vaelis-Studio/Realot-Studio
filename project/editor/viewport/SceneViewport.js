/**
 * editor/viewport/SceneViewport.js
 *
 * Composes the editor's Scene/Game viewport: creates a PIXI Application,
 * boots a real runtime game instance into it (via runtime/index.js), and
 * layers editor-only grid + gizmo + camera-frame on top. This is the
 * bridge between editor UI and the actual engine — it's the only
 * viewport file allowed to import from /runtime.
 *
 * Also owns:
 *  - drag-and-drop of a sprite asset from the Project panel into the
 *    scene (creates a new Entity with Transform + SpriteRenderer at the
 *    drop position)
 *  - pointer-driven translate/scale gizmo interaction (see
 *    TransformGizmo.js) and click-to-select on rendered sprites
 */

import { createGame } from "../../runtime/index.js";
import { ViewportCamera } from "./ViewportCamera.js";
import { drawSceneGrid } from "./SceneGrid.js";
import { drawCameraGizmo } from "./CameraGizmo.js";
import { drawColliderGizmo } from "./ColliderGizmo.js";
import { TriangleColliderGizmo } from "./TriangleColliderGizmo.js";
import { TriangleShapeGizmo } from "./TriangleShapeGizmo.js";
import { drawLightGizmo, hitTestLightGizmo } from "./LightGizmo.js";
import { drawAudioGizmo, hitTestAudioGizmo } from "./AudioGizmo.js";
import { drawAudioListenerGizmo, hitTestAudioListenerGizmo } from "./AudioListenerGizmo.js";
import { FreeformLightGizmo } from "./FreeformLightGizmo.js";
import { StrokePathGizmo } from "./StrokePathGizmo.js";
import { JointGizmo } from "./JointGizmo.js";
import { TransformGizmo } from "./TransformGizmo.js";
import { editorState, pushLog } from "../state/EditorState.js";
import { attachPixiDiagnostics } from "../state/ConsoleCapture.js";
import { isGameWindowFocused, onFocusPriorityChange } from "../state/FocusScheduler.js";
import { getEngineSettings } from "../state/EngineSettings.js";
import { TRANSFORM, Transform } from "../../runtime/components/Transform.js";
import { COLLIDER_2D } from "../../runtime/components/Collider2D.js";
import { LIGHT, LightType } from "../../runtime/components/Light.js";
import { SPRITE_RENDERER, SpriteRenderer } from "../../runtime/components/SpriteRenderer.js";
import { SHAPE_RENDERER } from "../../runtime/components/ShapeRenderer.js";
import { STROKE_PATH } from "../../runtime/components/StrokePath.js";
import { JOINT_2D } from "../../runtime/components/Joint2D.js";
import { SPRITE_ANIMATION, SpriteAnimation, generateClipId } from "../../runtime/components/SpriteAnimation.js";
import { CAMERA } from "../../runtime/components/Camera.js";
import { RenderSystem } from "../../runtime/systems/RenderSystem.js";
import { AnimationSystem } from "../../runtime/systems/AnimationSystem.js";
import { getSpriteAsset, getAudioAsset } from "../../runtime/assets/AssetRegistry.js";
import { AUDIO_SOURCE, AudioSource } from "../../runtime/components/AudioSource.js";
import { instantiatePrefab, getPrefab } from "../../runtime/prefabs/PrefabRegistry.js";
import { TILEMAP } from "../../runtime/components/Tilemap.js";
import { TILESET } from "../../runtime/components/Tileset.js";
import { NAV_WORLD_2D, navCellKey, setNavCellOverride, clearNavCellOverride, setNavCellArea, clearNavCellArea } from "../../runtime/components/NavWorld2D.js";
import { NAV_AGENT_2D } from "../../runtime/components/NavAgent2D.js";
import { drawNavWorldGizmo } from "./NavWorldGizmo.js";
import { beginEdit, commitEdit, snapshotNow, resetHistory } from "../state/UndoManager.js";
import { loadProjectSnapshot, applySnapshot, getProjectIdentityFromUrl } from "../state/ProjectStorage.js";
import { getSafeRendererResolution } from "../../runtime/core/MobileViewport.js";

// Click/box-select hit-box half-size (world units) for an "empty"
// entity — Transform only, no Sprite/Shape Renderer, so there's no
// real visual bounds to hit-test against. 24 matches the approximate
// on-screen size of the small icon these entities are represented by
// in the Hierarchy/viewport at 1x zoom, so the clickable area roughly
// matches what's visible instead of being either invisible-small or
// implausibly huge.
const EMPTY_ENTITY_HIT_HALF_EXTENT = 24;

let pixiApp = null;
let viewportCamera = null;
let gridContainer = null;
let gizmoContainer = null;
let selectionOutlineGfx = null;
let boxSelectGfx = null; // marquee rectangle drawn during a box-select drag, see _boxSelectState
let cameraGizmoContainer = null;
let colliderGizmoContainer = null;
let navWorldGizmoContainer = null;
let lightGizmoContainer = null;
let audioGizmoContainer = null;
let audioListenerGizmoContainer = null;
let transformGizmo = null;
let triangleColliderGizmo = null;
let triangleShapeGizmo = null;
let freeformLightGizmo = null;
let strokePathGizmo = null;
let jointGizmo = null;
let game = null;
let pixiCanvasHold = null;
let renderFn = null;
let renderSystem = null;
let lightingSystem = null;
let animationSystem = null;
let tilemapSystem = null;
let _unsubscribeFocus = null; // set by createViewport(), see _applyEditorFpsCap
let _viewportResizeRaf = 0;
let _viewportResizeSettleRaf = 0;

/**
 * Snapshot of every OTHER selected entity's Transform at the moment a
 * transform-gizmo drag begins on the primary (editorState.selectedId).
 * On each pointermove, the primary's delta since ITS OWN start (computed
 * from transformGizmo's own bookkeeping) is re-applied on top of these
 * snapshots — so translate/scale/rotate move the whole multi-selection
 * together, in lockstep with whatever the gizmo does to the primary.
 * @type {Array<{entity:object, start:{x:number,y:number,scaleX:number,scaleY:number,rotation:number}}>}
 */
let _multiDragSnapshots = [];

/**
 * Left-click + drag on empty space (no gizmo handle, no entity/light/
 * audio icon hit) draws a marquee rectangle; on release, every entity
 * whose bounds intersect it becomes selected. World-space corners so
 * the rectangle tracks correctly if the view pans/zooms mid-drag (drag
 * itself never pans, but keeps this robust either way).
 * @type {null | { startWorldX:number, startWorldY:number, curWorldX:number, curWorldY:number, additive:boolean }}
 */
let _boxSelectState = null;
let _markViewportDirty = null;
let _pixiInitFailed = false; // set true when no renderer is available; stops retrying

/**
 * True from the moment PIXI's "webglcontextlost" event fires until the
 * matching "webglcontextrestored" — see createViewport()'s
 * attachPixiDiagnostics() call below. Previously a context loss (most
 * often triggered by the browser reclaiming GPU memory under pressure —
 * many open tabs, a memory-heavy project, low system RAM) was ONLY
 * logged to the Console tab: the scene would create/open fine (that's
 * pure editor-state bookkeeping, no GPU involved) but the canvas would
 * render nothing from that point on — UI intact, zoom/pan still working
 * (camera math needs no GPU), sprites just gone, with no visible
 * indication anything was wrong unless you happened to have the Console
 * tab open. Viewport.js reads this via isViewportRendererLost() to show
 * a real banner over the canvas instead.
 * @type {boolean}
 */
let _rendererContextLost = false;

export function isViewportRendererLost() {
  return _rendererContextLost;
}

/**
 * True after syncSpriteRender() catches a thrown error from the render/
 * animation/tilemap/lighting update pass — distinct from
 * _rendererContextLost above (that's specifically the WebGL
 * "webglcontextlost" event; this covers everything else that can make
 * a frame silently fail to draw, e.g. a texture allocation throwing
 * under memory pressure WITHOUT the browser going as far as tearing
 * down the whole context). Cleared the next time a sync succeeds, so a
 * one-off transient failure doesn't leave a stale banner up forever.
 * @type {boolean}
 */
let _renderSyncFailed = false;

export function isViewportRenderSyncFailed() {
  return _renderSyncFailed;
}

export function getGame() {
  return game;
}

/**
 * Detaches the live PixiJS canvas from its current DOM parent WITHOUT
 * destroying the PIXI app/view. The editor's render() (main.js)
 * rebuilds the entire app shell via `app.innerHTML = html`, which would
 * otherwise try to remove the canvas from a mount it's about to
 * overwrite — and PIXI's canvas sometimes gets reparented/synced by
 * the renderer mid-frame, producing a "node to be removed is no
 * longer a child" DOM error (especially while dragging a numeric
 * Inspector field that fires render() on every `input` event). Calling
 * this immediately before `innerHTML` safely unhooks the canvas so the
 * old mount can be replaced cleanly; mountOrUpdateSceneViewport() then
 * re-attaches it to the fresh mount right after.
 */
export function detachViewportCanvas() {
  if (!pixiApp || !pixiApp.view) return;
  // Park the live canvas in a hidden holder instead of just removing it.
  // If the canvas has no parent, PIXI's internal ResizeObserver / RAF
  // callbacks can re-parent it between this call and the `innerHTML`
  // replacement in render(), producing a "node to be removed is no
  // longer a child" DOM error. Keeping it parked in a stable (hidden)
  // parent means innerHTML never tries to remove it and PIXI's observers
  // always see a valid parentNode.
  if (!pixiCanvasHold) {
    pixiCanvasHold = document.createElement("div");
    pixiCanvasHold.id = "_pixi-canvas-hold";
    pixiCanvasHold.style.cssText =
      "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";
    document.body.appendChild(pixiCanvasHold);
  }
  if (pixiApp.view.parentNode !== pixiCanvasHold) {
    pixiCanvasHold.appendChild(pixiApp.view);
  }
}

/**
 * Resizes only after layout has settled. Fullscreen transitions briefly
 * report a zero-sized mount in Chromium; handing that value to PIXI leaves
 * the render target black until another unrelated editor render happens.
 */
function _resizeViewportToCurrentMount() {
  if (!pixiApp || !pixiApp.renderer) return false;
  const mount = document.getElementById("pixi-viewport-canvas");
  if (!mount) return false;
  const width = Math.round(mount.clientWidth);
  const height = Math.round(mount.clientHeight);
  if (width < 1 || height < 1) return false;

  const renderer = pixiApp.renderer;
  const previousWidth = renderer.screen ? renderer.screen.width : width;
  const previousHeight = renderer.screen ? renderer.screen.height : height;
  if (previousWidth === width && previousHeight === height) return true;

  renderer.resize(width, height);
  // The stage is the editor's world origin. Shift it by half the viewport
  // delta so entering/leaving fullscreen preserves the user's view rather
  // than presenting an apparently empty/black scene at a different origin.
  if (pixiApp.stage) {
    pixiApp.stage.x += (width - previousWidth) * 0.5;
    pixiApp.stage.y += (height - previousHeight) * 0.5;
  }
  if (_markViewportDirty) _markViewportDirty();
  return true;
}

/** Schedules a primary resize plus a next-frame settle pass for browser
 * fullscreen/window transitions, without allocating a new PIXI renderer. */
export function scheduleSceneViewportResize() {
  if (_viewportResizeRaf) return;
  _viewportResizeRaf = requestAnimationFrame(() => {
    _viewportResizeRaf = 0;
    _resizeViewportToCurrentMount();
    if (_viewportResizeSettleRaf) cancelAnimationFrame(_viewportResizeSettleRaf);
    _viewportResizeSettleRaf = requestAnimationFrame(() => {
      _viewportResizeSettleRaf = 0;
      _resizeViewportToCurrentMount();
    });
  });
}

/**
 * Switches the live World over to a different scene (see
 * runtime/scene/SceneManager.js): saves the current scene's edits into
 * its slot, loads the target scene's data in, then resets editor
 * selection/gizmos so nothing stale from the old scene lingers (e.g. a
 * selected entity id that no longer exists once ids are reset).
 * @param {string} sceneId
 */
export function switchScene(sceneId) {
  if (!game) return false;
  const switched = game.switchToScene(sceneId);
  if (!switched) return false;
  syncAfterExternalSceneChange();
  return true;
}

/**
 * Re-syncs editor selection + the viewport's visual state after
 * something OTHER than switchScene() above replaced the live World's
 * contents wholesale — currently just game.deleteScene() when it
 * deletes the currently-active scene (SceneManager.deleteScene()
 * calls deserializeScene() directly in that case, the same underlying
 * operation switchScene() itself wraps, but without any of THIS
 * bookkeeping — see EditorEvents.js's "delete-scene-file" case, the
 * only other caller). Factored out of switchScene() itself so both
 * paths share one implementation instead of two copies that could
 * silently drift apart.
 */
export function syncAfterExternalSceneChange() {
  if (!game) return;

  // A new/different scene means a different set of entities/ids
  // entirely — undo history built against the PREVIOUS scene can't
  // meaningfully apply here (see UndoManager.resetHistory's own doc
  // comment), so wipe both stacks rather than let a stale entry
  // silently do nothing or restore the wrong scene's objects on a
  // later Ctrl+Z. Wrapped defensively: whatever already-successful
  // scene change triggered this call must never be left half-synced
  // just because history bookkeeping hit a snag — that would make the
  // World correctly hold the new scene while the UI silently kept
  // showing stale selection/gizmos, which is worse than just skipping
  // the history wipe for once.
  try {
    resetHistory();
  } catch (err) {
    console.error("[syncAfterExternalSceneChange] resetHistory failed (non-fatal):", err);
  }

  editorState.selectedId = null;
  editorState.selectedIds = [];
  const mainCamera = game.world.findFirstByName("Main Camera");
  editorState.selectedId = mainCamera ? mainCamera.id : null;
  if (editorState.selectedId) editorState.selectedIds = [editorState.selectedId];

  syncSpriteRender();
  refreshGizmos();
  syncBackgroundColor();
}

/** Set once loadInitialProject() resolves (success OR "nothing to load"), so
 *  autosave (started from main.js) never overwrites a project's saved
 *  snapshot with the blank starter scene by racing ahead of the load. */
let _initialLoadDone = false;
export function isInitialProjectLoadDone() {
  return _initialLoadDone;
}

/**
 * Loads this project's own saved snapshot (if the editor was opened
 * from the launcher with ?project=<id> and that project has been saved
 * at least once before — see ProjectStorage.js) and replaces the blank
 * starter scene createViewport() just built with it. A brand-new
 * project that has never been saved has no snapshot yet, which is
 * expected and not an error — loadProjectSnapshot() still resets the
 * shared scripts/layers/tags registries to clean defaults in that
 * case (see its own doc comment).
 *
 * TEMPLATE SEEDING: when there's no saved snapshot AND the launcher
 * opened this project with a `template` id (see getProjectIdentityFromUrl()
 * — only set for templates with real bundled data, e.g. js/data/templates/
 * platformer-starter.data.js), that bundled data is applied via
 * applySnapshot() here instead of leaving the blank starter scene
 * initScenes() already loaded. This runs exactly once: the FIRST time
 * that project is opened. Every open after that has its own real saved
 * snapshot (autosave writes one within a minute — see
 * ProjectStorage.js's startAutosave()), so loadProjectSnapshot() finds
 * it on every later visit and this branch is never reached again, even
 * though the URL's `template` param may still be present (bookmarked/
 * reloaded links keep whatever query string they were opened with).
 *
 * @param {() => void} render editor's root render(), to refresh the UI
 *   once the (async) load finishes
 */
async function loadInitialProject(render) {
  const identity = getProjectIdentityFromUrl();
  if (!identity.isLauncherProject || !game) {
    _initialLoadDone = true;
    return;
  }
  try {
    let snapshot = await loadProjectSnapshot(identity.id, game);
    let seededFromTemplate = false;
    if (!snapshot && identity.templateId && window.RealotTemplateData && window.RealotTemplateData[identity.templateId]) {
      snapshot = window.RealotTemplateData[identity.templateId];
      await applySnapshot(game, snapshot);
      seededFromTemplate = true;
    }
    if (snapshot) {
      editorState.projectName = seededFromTemplate
        ? (identity.name || snapshot.projectName || editorState.projectName)
        : (snapshot.projectName || identity.name || editorState.projectName);
      // applySnapshot() (inside loadProjectSnapshot, or the direct call
      // above for a template seed) already restored
      // editorState.selectedId/selectedIds/projectFolder from the
      // snapshot's own `ui` block — but syncAfterExternalSceneChange()
      // below unconditionally resets selection to the scene's Main
      // Camera (correct for an actual in-editor scene SWITCH, which is
      // its other caller). Capture the snapshot's real selection here
      // and re-apply it after, so a project load restores exactly what
      // was selected/scrolled-to rather than always snapping back to
      // the Main Camera on every reload. A template's bundled snapshot
      // has no `ui` block (see platformer-starter.data.js), so this is
      // simply a no-op fallback to the Main Camera in that case.
      const restoredSelectedId = editorState.selectedId;
      const restoredSelectedIds = editorState.selectedIds;
      syncAfterExternalSceneChange();
      if (restoredSelectedId && game.world.entities.has(restoredSelectedId)) {
        editorState.selectedId = restoredSelectedId;
        editorState.selectedIds = restoredSelectedIds;
      }
      pushLog("log", seededFromTemplate
        ? "Started '" + (identity.name || snapshot.projectName || "project") + "' from the " + snapshot.projectName + " template."
        : "Loaded '" + (snapshot.projectName || identity.name || "project") + "' from your last session.");
    } else if (identity.name) {
      editorState.projectName = identity.name;
    }
  } catch (err) {
    console.error("[loadInitialProject] Failed to load saved project snapshot:", err);
    pushLog("error", "Couldn't load your saved project — starting from a blank scene instead.");
  } finally {
    _initialLoadDone = true;
    if (typeof render === "function") render();
  }
}

/**
 * Lightweight, DOM-safe live update: re-applies the Main Camera's
 * current backgroundColor to the Scene viewport's canvas. Exported
 * specifically so EditorEvents.js can call it on every "input" tick of
 * the background color picker WITHOUT going through the full editor
 * render() — render() replaces the entire app innerHTML, which would
 * destroy/reopen a live native <input type="color"> popover mid-drag.
 * This function touches only pixiApp.renderer, never the DOM tree.
 */
export function syncBackgroundColorLive() {
  syncBackgroundColor();
}

/**
 * Reads the current focus state + EngineSettings and applies the
 * matching FPS cap to pixiApp.ticker.maxFPS. Called once at viewport
 * creation and again on every focus-priority transition (see
 * onFocusPriorityChange in createViewport above) so the change is
 * instant — never waiting on the next dirty-check tick, which itself
 * might not even fire again soon once maxFPS has been lowered.
 */
function _applyEditorFpsCap() {
  if (!pixiApp || !pixiApp.ticker) return;
  const s = getEngineSettings();
  const targetFps = isGameWindowFocused() ? s.editorFpsUnfocused : s.editorFpsFocused;
  // ticker.maxFPS: 0 means uncapped (PIXI's own convention — matches
  // EngineSettings' gameFps "Unlimited" option using 0 the same way).
  pixiApp.ticker.maxFPS = targetFps > 0 ? targetFps : 0;
}

function createViewport(mount, render) {
  renderFn = render;
  const w = Math.max(1, mount.clientWidth);
  const h = Math.max(1, mount.clientHeight);

  // Renderer init with three-stage fallback so the editor never crashes
  // regardless of GPU/WebGL availability (headless CI, sandboxed iframes,
  // software-only Chromium all reach the Canvas 2D path without throwing):
  //   1. Try WebGL (preferred: GPU-accelerated, PixiJS default).
  //   2. Try forceCanvas: true — bypasses WebGL detection entirely.
  //   3. Null-app stub — editor UI stays alive, viewport stays dark.
  // Each attempt is wrapped independently so a throw in the fallback
  // never escapes createViewport and crashes the whole editor module.
  (function _initPixiApp() {
    const _base = {
      width: w, height: h,
      backgroundColor: 0x282828,
      // Prefer the performance GPU when the browser exposes more than one
      // adapter. This changes neither render resolution nor light quality.
      powerPreference: "high-performance",
      autoDensity: true,
      // Match the runtime renderer's normal high-DPI policy so the editor
      // preview is visually representative of Play Mode/exported games.
      resolution: getSafeRendererResolution(w, h),
    };
    // Stage 1: WebGL
    if (PIXI.utils.isWebGLSupported()) {
      try { pixiApp = new PIXI.Application(Object.assign({}, _base, { antialias: true })); return; }
      catch (_) { /* fall through to Canvas */ }
    }
    // Stage 2: Canvas 2D
    try { pixiApp = new PIXI.Application(Object.assign({}, _base, { forceCanvas: true })); return; }
    catch (_) { /* fall through to null stub */ }
    // Stage 3: No renderer available — log and leave pixiApp null.
    _pixiInitFailed = true;
    console.warn("[Realot] No PIXI renderer available (no WebGL or Canvas 2D). Scene viewport will be disabled.");
  })();

  if (!pixiApp) return; // bail out gracefully — editor UI still works
  mount.appendChild(pixiApp.view);
  // Browser fullscreen changes and OS window resizes can produce an
  // intermediate 0x0 layout. Use the guarded, two-frame resize path above
  // instead of resizing the renderer directly from a transient value.
  window.addEventListener("resize", scheduleSceneViewportResize, { passive: true });
  window.addEventListener("fullscreenchange", scheduleSceneViewportResize, { passive: true });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", scheduleSceneViewportResize, { passive: true });
  attachPixiDiagnostics(pixiApp, {
    onContextLost: () => {
      _rendererContextLost = true;
      // Re-render the editor shell so Viewport.js's banner (see
      // isViewportRendererLost()) appears immediately rather than
      // waiting for whatever the next UNRELATED render() happens to be
      // — this could otherwise be many seconds away if the person's
      // last action before losing the context was, say, panning the
      // camera, which doesn't trigger a full render().
      if (renderFn) renderFn();
    },
    onContextRestored: () => {
      _rendererContextLost = false;
      // A restored WebGL context comes back as a blank slate — PIXI
      // itself re-uploads its own GPU resources, but the actual scene
      // contents only reappear once something re-runs the render
      // pipeline against the live World. Without this, the context
      // is technically "restored" (per PIXI/the browser) yet the
      // canvas stays visually empty until the next unrelated edit
      // happens to trigger a sync — same silent-blank symptom as the
      // context-lost case itself, just one step later.
      try {
        syncSpriteRender();
        refreshGizmos();
      } catch (err) {
        pushLog("error", "Failed to resume rendering after context restore: " + (err && err.message ? err.message : err));
      }
      if (renderFn) renderFn();
    },
  });

  // Game Window Performance & FPS Priority: cap the Scene Viewport's
  // own render rate to whatever the editor's current focus state calls
  // for (60 focused / 20-30 when the Play window has focus — see
  // FocusScheduler.js + EngineSettings.js). ticker.maxFPS is a real
  // PIXI throttle — it skips the update/render invocation entirely
  // below the cap, not just the gizmo/lighting work inside our own
  // ticker.add() callback further down (that dirty-check only avoids
  // redundant CPU work on frames that DO run; this is what actually
  // reduces GPU work by skipping frames outright). 0 means uncapped.
  _applyEditorFpsCap();
  _unsubscribeFocus = onFocusPriorityChange(_applyEditorFpsCap);

  game = createGame({ pixiApp });
  game.initScenes(); // synchronous blank/default scene so the viewport is never left with no World at all, even for the instant before a saved project snapshot (if any) finishes loading below
  editorState.world = game.world;
  editorState.game = game;
  // NOTE: game.loop is intentionally never started here — that would run
  // PhysicsSystem every frame and things would fall/drift while just
  // editing. Instead we sync ONLY the RenderSystem below (via
  // syncSpriteRender(), called from mountOrUpdateSceneViewport on every
  // editor render), so sprites show up immediately without simulating.
  renderSystem = game.world.systems.find((s) => s.constructor.name === "RenderSystem") || null;
  lightingSystem = game.world.systems.find((s) => s.constructor.name === "LightingSystem") || null;
  animationSystem = game.world.systems.find((s) => s.constructor.name === "AnimationSystem") || null;
  tilemapSystem = game.world.systems.find((s) => s.constructor.name === "TilemapSystem") || null;
  syncSpriteRender();
  if (!editorState.selectedId) {
    const mainCamera = game.world.findFirstByName("Main Camera");
    editorState.selectedId = mainCamera ? mainCamera.id : null;
    if (editorState.selectedId) editorState.selectedIds = [editorState.selectedId];
  }

  // Load-project-from-launcher: replace the just-built blank scene with
  // whatever this project's own last-saved snapshot contains (assets,
  // scenes, scripts, layers, tags — see ProjectStorage.js), so opening
  // a project from the launcher's recent-projects list reproduces it
  // exactly as it was left, not the engine's blank starter scene. Fire-
  // and-forget from here (createViewport itself stays synchronous, same
  // as before) — loadInitialProject() re-syncs selection/gizmos/render
  // once the async storage read resolves.
  loadInitialProject(render);

  // editor-only chrome containers, drawn around the runtime's own stage content
  gridContainer = new PIXI.Container();
  cameraGizmoContainer = new PIXI.Container();
  colliderGizmoContainer = new PIXI.Container();
  navWorldGizmoContainer = new PIXI.Container();
  lightGizmoContainer = new PIXI.Container();
  audioGizmoContainer = new PIXI.Container();
  audioListenerGizmoContainer = new PIXI.Container();
  gizmoContainer = new PIXI.Container();
  selectionOutlineGfx = new PIXI.Graphics();
  gizmoContainer.addChild(selectionOutlineGfx);
  boxSelectGfx = new PIXI.Graphics();
  gizmoContainer.addChild(boxSelectGfx);
  // LightingSystem's GPU lighting filter (see runtime/systems/
  // LightingSystem.js) is applied to createGame's internal
  // gameContentContainer — a child of pixiApp.stage that holds ONLY
  // RenderSystem's sprites — NOT to pixiApp.stage itself, specifically
  // so it can never darken/shadow this editor-only chrome (grid,
  // gizmos, camera frame) which lives as separate sibling containers
  // directly on pixiApp.stage (see runtime/index.js for the full
  // rationale). These chrome layers still get their own explicit
  // zIndex values so they stay drawn above gameContentContainer
  // (sortableChildren is on for pixiApp.stage too) regardless of add
  // order. lightGizmoContainer specifically needs to be ABOVE the lit
  // scene so a light's bulb icon and range circle stay
  // visible/clickable even in a fully darkened area of the scene —
  // otherwise you couldn't click a light to select it from inside its
  // own shadow.
  gridContainer.zIndex = -1; // grid stays behind everything, including darkness
  cameraGizmoContainer.zIndex = 200000;
  navWorldGizmoContainer.zIndex = 200000.5; // above the camera frame, below collider outlines/gizmos
  colliderGizmoContainer.zIndex = 200001;
  lightGizmoContainer.zIndex = 200002;
  audioGizmoContainer.zIndex = 200002;
  audioListenerGizmoContainer.zIndex = 200002;
  gizmoContainer.zIndex = 200003;
  pixiApp.stage.addChildAt(gridContainer, 0); // grid behind everything
  pixiApp.stage.addChild(cameraGizmoContainer); // camera frame above scene content
  pixiApp.stage.addChild(navWorldGizmoContainer); // baked cell grid above camera frame, below collider outlines
  pixiApp.stage.addChild(colliderGizmoContainer); // collider outlines above camera frame dimming
  pixiApp.stage.addChild(lightGizmoContainer); // light icons/range above the darkness overlay
  pixiApp.stage.addChild(audioGizmoContainer); // audio icons/range, same layer as light gizmos
  pixiApp.stage.addChild(audioListenerGizmoContainer); // ear icons/hearing radius, same layer
  pixiApp.stage.addChild(gizmoContainer); // selection/transform gizmo above everything
  pixiApp.stage.sortableChildren = true;
  drawSceneGrid(gridContainer);

  transformGizmo = new TransformGizmo(gizmoContainer);
  triangleColliderGizmo = new TriangleColliderGizmo(gizmoContainer);
  triangleShapeGizmo = new TriangleShapeGizmo(gizmoContainer);
  freeformLightGizmo = new FreeformLightGizmo(gizmoContainer);
  strokePathGizmo = new StrokePathGizmo(gizmoContainer);
  jointGizmo = new JointGizmo(gizmoContainer);

  viewportCamera = new ViewportCamera(pixiApp, pixiApp.stage);
  viewportCamera.onZoomChange((percent) => {
    const el = document.getElementById("zoom-label");
    if (el) el.textContent = percent + "%";
  });
  viewportCamera.attach(mount);
  _attachFocusShortcut(mount);

  // Keep lighting (and the light gizmo's screen-constant bulb icon)
  // synced on EVERY rendered frame, not just whenever the DOM-driven
  // render() cycle happens to run. Sprites/gizmos are real children of
  // pixiApp.stage, so PIXI's own ticker already re-transforms them
  // instantly on every frame during a live pan/zoom gesture (wheel
  // events never call render()). LightingSystem.update() previously
  // only ran from inside render()'s syncSpriteRender() call, so its
  // uStageOffset/uStageScale uniforms stayed frozen on whatever value
  // was current the last time some UNRELATED editor event fired a
  // render() — during an active zoom-out/in gesture this showed up as
  // the rendered light glow visibly lagging behind/detaching from its
  // own gizmo until the gesture ended and some other event finally
  // re-synced it. Ticking it here guarantees the light texture is
  // recomputed with THIS frame's real stage transform every single
  // frame, so it can never drift out of alignment with its gizmo.
  // Dirty/transform-change tracking so the per-frame ticker work
  // only runs when something actually needs redrawing (see comment below).
  let _vpDirty = true; // start dirty so the first frame renders
  let _lastStageX = NaN;
  let _lastStageY = NaN;
  let _lastStageScale = NaN;
  let _lastSelectedId = null;

  // Exposed so syncSpriteRender() (called on every editor render cycle)
  // can flag the viewport as dirty — any state change that triggers a
  // render() also needs the lighting/gizmos refreshed once.
  _markViewportDirty = function () { _vpDirty = true; };

  pixiApp.ticker.add(() => {
    // Determine whether anything actually changed since the last frame:
    //   1. Stage pan/zoom moved (lighting uniforms depend on it)
    //   2. A render()/syncSpriteRender cycle flagged us dirty
    //   3. The selection changed (gizmos follow the selection)
    //   4. Play mode is active (physics/animation may be moving things)
    const stage = pixiApp.stage;
    const stageChanged =
      stage.x !== _lastStageX || stage.y !== _lastStageY || stage.scale.x !== _lastStageScale;
    const selChanged = editorState.selectedId !== _lastSelectedId;

    if (!stageChanged && !_vpDirty && !selChanged && !editorState.isPlaying) {
      // Idle: skip all per-frame gizmo/lighting work. PIXI still
      // re-transforms existing display objects internally, but we
      // avoid the expensive lighting-system uniform pass and the
      // full gizmo Graphics redraws that were burning cycles for
      // identical output frame after frame.
      return;
    }

    _lastStageX = stage.x;
    _lastStageY = stage.y;
    _lastStageScale = stage.scale.x;
    _lastSelectedId = editorState.selectedId;
    _vpDirty = false;

    if (lightingSystem && editorState.world) {
      try {
        lightingSystem.update(editorState.world, 0);
      } catch (err) {
        pushLog("error", "Lighting sync failed: " + (err && err.message ? err.message : err));
      }
    }
    if (lightGizmoContainer) {
      drawLightGizmo(lightGizmoContainer, editorState.world, editorState.selectedId, _worldPerPixel());
    }
    if (audioGizmoContainer) {
      drawAudioGizmo(audioGizmoContainer, editorState.world, editorState.selectedId, _worldPerPixel());
    }
    if (audioListenerGizmoContainer) {
      drawAudioListenerGizmo(audioListenerGizmoContainer, editorState.world, editorState.selectedId, _worldPerPixel());
    }
    if (freeformLightGizmo) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const light = selected ? selected.getComponent(LIGHT) : null;
      freeformLightGizmo.draw(selected, light, _worldPerPixel());
    }
    if (strokePathGizmo) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const strokePath = selected ? selected.getComponent(STROKE_PATH) : null;
      strokePathGizmo.draw(selected, strokePath, _worldPerPixel());
    }
    if (jointGizmo) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const joint = selected ? selected.getComponent(JOINT_2D) : null;
      jointGizmo.draw(selected, joint, editorState.world, _worldPerPixel());
    }
    // Keep the translate/scale/rotate gizmo's constant-SCREEN size in
    // sync live during an active zoom gesture too — same reasoning as
    // the light/audio gizmos just above (wheel-zoom never calls the
    // DOM-driven render() cycle on its own, and stageChanged already
    // covers zoom, so this only actually redraws on frames where the
    // stage transform or selection genuinely changed, same as them).
    if (transformGizmo) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      transformGizmo.draw(selected, _worldPerPixel());
    }
  });

  // center the world container like the original mockup did
  pixiApp.stage.x = w / 2;
  pixiApp.stage.y = h / 2;

  attachGizmoPointerEvents(mount);
  attachDropTarget(mount);
}

/**
 * Converts a browser client (screen) coordinate to world-space
 * coordinates inside the viewport's stage, accounting for pan/zoom.
 */
function clientToWorld(clientX, clientY) {
  const rect = pixiApp.view.getBoundingClientRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const stage = pixiApp.stage;
  return {
    x: (localX - stage.x) / stage.scale.x,
    y: (localY - stage.y) / stage.scale.y,
  };
}

// Tile tool drag-paint state (see attachGizmoPointerEvents' pointerdown/
// pointermove/endDrag branches for "tool === 'tile'"). Module-level like
// _markViewportDirty above rather than local to attachGizmoPointerEvents,
// since it must survive across the separate pointerdown/pointermove/
// pointerup event listener callbacks registered in that function.
let _isPaintingTile = false;
// Same module-level-for-cross-callback-survival reasoning as
// _isPaintingTile just above, kept as its OWN separate flag (not a
// shared "_isPainting" with a mode field) so the pointermove/endDrag
// branches below stay simple boolean checks matching the existing
// _isPaintingTile branches right next to them, rather than introducing
// a different shape of state only this one pair of tools would use.
let _isPaintingNav = false;

/**
 * Paints (or, with altKey, erases) the Tilemap cell under a client
 * (screen) position on the given entity's Tilemap component. Cell
 * coordinates are computed relative to the ENTITY's own Transform
 * position (matching TilemapSystem.js, which positions its per-tilemap
 * layer container at transform.x/y and places tiles at
 * (col+0.5)*tileWidth/(row+0.5)*tileHeight WITHIN that layer) rather
 * than raw world space, so a Tilemap entity can be moved around the
 * scene without every previously-painted cell shifting to a different
 * col/row. Falls back to a default 32x32 cell size if no Tileset is
 * assigned yet (so painting still works before the user picks one; the
 * cells just won't render any art until TilemapSystem.js has a Tileset
 * to resolve spriteKeys from).
 * @param {import('../../runtime/core/World.js').Entity} entity
 * @param {import('../../runtime/components/Tilemap.js').Tilemap} tilemap
 * @param {number} clientX
 * @param {number} clientY
 * @param {boolean} erase
 */
function _paintTileAtClientPos(entity, tilemap, clientX, clientY, erase) {
  const transform = entity.getComponent(TRANSFORM);
  if (!transform) return;

  const tilesetEntity = tilemap.tilesetEntityId ? editorState.world.getEntity(tilemap.tilesetEntityId) : null;
  const tileset = tilesetEntity ? tilesetEntity.getComponent(TILESET) : null;
  const tileWidth = tileset ? tileset.tileWidth : 32;
  const tileHeight = tileset ? tileset.tileHeight : 32;

  const world = clientToWorld(clientX, clientY);
  const localX = world.x - transform.x;
  const localY = world.y - transform.y;
  const col = Math.floor(localX / tileWidth);
  const row = Math.floor(localY / tileHeight);
  const key = col + "," + row;

  if (erase) {
    if (tilemap.cells[key]) {
      delete tilemap.cells[key];
      syncSpriteRender();
    }
  } else if (!tilemap.cells[key]) {
    tilemap.cells[key] = true;
    syncSpriteRender();
  }
}

/**
 * Paints one of FOUR effects onto the NavWorld2D cell(s) under a client
 * (screen) position, depending on `mode` — same "col/row relative to
 * the entity's own Transform" convention _paintTileAtClientPos uses
 * above, and the same relationship NavWorldSystem.worldToCell has to
 * boundsX/boundsY (see that file's header comment):
 *
 *   "walkable" — force this cell walkable (the U / Nav Walk tool)
 *   "blocked"  — force this cell blocked (the I / Nav Block tool)
 *   "area"     — tag this cell with editorState.activeNavAreaIndex,
 *                the area picked in the Toolbar's dropdown while the
 *                O / Nav Area tool is active (see Toolbar.js's
 *                renderNavAreaPicker). Does NOT touch walkable/blocked
 *                at all — a cell can be walkable AND tagged "Water" at
 *                the same time; area is an orthogonal property, not a
 *                4th walkable state.
 *   "erase-area" — clears this cell's area TAG only, reverting it to
 *                slot 0 (Ground) — the Alt+click counterpart to "area"
 *                painting, same relationship "erase" below has to
 *                "walkable"/"blocked". Does NOT touch walkable/blocked
 *                at all, for the same orthogonality reason "area" above
 *                doesn't either.
 *   otherwise  — erase (the Y / Erase tool): clears the manual walkable/
 *                blocked override on this cell, restoring whatever Bake
 *                last produced for it. Does NOT clear the cell's area
 *                tag — erasing a cell's walkable override and clearing
 *                its area are two different actions on purpose, same
 *                as a Tilemap's Erase tool not touching a cell's
 *                collision flag. To clear an area tag, Alt+click with
 *                the Area tool active (see "erase-area" above) instead.
 *
 * Unlike Tilemap's cells (present = filled, absent = empty), a
 * NavWorld2D cell's walkable state has THREE meaningful values —
 * unset/blocked/walkable (see NavWorld2D.js's header) — so "walkable"/
 * "blocked" always write an explicit true/false rather than deleting
 * the key, which would silently fall back to "blocked" per that same
 * convention and could look like erasing did nothing if the cell was
 * already blocked going in.
 * @param {import('../../runtime/core/World.js').Entity} entity
 * @param {import('../../runtime/components/NavWorld2D.js').NavWorld2D} navWorld
 * @param {number} clientX
 * @param {number} clientY
 * @param {"walkable"|"blocked"|"area"|"erase-area"|"erase"} mode
 */
function _paintNavCellAtClientPos(entity, navWorld, clientX, clientY, mode) {
  const transform = entity.getComponent(TRANSFORM);
  if (!transform) return;

  const world = clientToWorld(clientX, clientY);
  const localX = world.x - transform.x - navWorld.boundsX;
  const localY = world.y - transform.y - navWorld.boundsY;
  const centerCol = Math.floor(localX / navWorld.cellSize);
  const centerRow = Math.floor(localY / navWorld.cellSize);
  const brushRadius = Math.max(0, editorState.navBrushRadius | 0);
  const r2 = (brushRadius + 0.35) * (brushRadius + 0.35);
  let changed = false;

  for (let dr = -brushRadius; dr <= brushRadius; dr++) {
    for (let dc = -brushRadius; dc <= brushRadius; dc++) {
      if (dc * dc + dr * dr > r2) continue;
      const col = centerCol + dc;
      const row = centerRow + dr;
      if (mode === "walkable") changed = setNavCellOverride(navWorld, col, row, true) || changed;
      else if (mode === "blocked") changed = setNavCellOverride(navWorld, col, row, false) || changed;
      else if (mode === "area") changed = setNavCellArea(navWorld, col, row, editorState.activeNavAreaIndex) || changed;
      else if (mode === "erase-area") changed = clearNavCellArea(navWorld, col, row) || changed;
      else changed = clearNavCellOverride(navWorld, col, row) || changed;
    }
  }


  if (changed) refreshGizmos();
}

function attachGizmoPointerEvents(mount) {
  const el = pixiApp.view;

  el.addEventListener("contextmenu", (e) => {
    // Right-click delete for a Freeform Light vertex — handled via the
    // browser's own contextmenu event rather than pointerdown, since
    // pointerdown's e.button!==0 guard below intentionally ignores
    // non-left clicks for every other gizmo interaction. preventDefault
    // suppresses the native right-click menu ONLY when we actually hit
    // a vertex, so right-clicking empty canvas still gets the browser
    // menu as normal.
    const world = clientToWorld(e.clientX, e.clientY);
    const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
    const light = selected ? selected.getComponent(LIGHT) : null;
    if (!light || light.type !== LightType.FREEFORM) return;
    const vertexIndex = freeformLightGizmo.hitTest(world.x, world.y, _worldPerPixel());
    if (vertexIndex !== null) {
      e.preventDefault();
      snapshotNow("scene");
      freeformLightGizmo.removePoint(light, vertexIndex);
      if (renderFn) renderFn();
    }
  });

  el.addEventListener("pointerdown", (e) => {
    const tool = editorState.activeTool;
    if (e.button !== 0) return; // selection/gizmo only responds to left click

    // Tile tool owns the pointer entirely while active — paints the
    // cell under the cursor on the CURRENTLY SELECTED entity's Tilemap
    // (if it has one), rather than falling through to gizmo/selection
    // logic below. Dragging continues painting cell-by-cell (see
    // pointermove's mirrored "tool === 'tile'" branch further down);
    // painting itself just writes true into Tilemap.cells — the actual
    // tile ART shown at each cell is computed fresh every frame by
    // runtime/systems/TilemapSystem.js from the live neighbor pattern
    // (see that file + AutoTileRules.js), never decided here.
    // The erase tool owns the pointer exactly like the tile paint
    // tool, except every painted (or dragged-over) cell is removed
    // instead of added — see _paintTileAtClientPos's erase branch.
    // Alt+click still inverts either tool (paint-while-erase-tool, or
    // erase-while-tile-tool), matching the existing Alt-erase behavior.
    if (tool === "tile" || tool === "erase") {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const tilemap = selected ? selected.getComponent(TILEMAP) : null;
      const navWorld = selected ? selected.getComponent(NAV_WORLD_2D) : null;
      if (tilemap) {
        _isPaintingTile = true;
        beginEdit("scene");
        _paintTileAtClientPos(selected, tilemap, e.clientX, e.clientY, tool === "erase" || e.altKey);
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
      } else if (navWorld) {
        // The erase tool doubles for both Tilemap AND NavWorld2D painting,
        // same "one eraser, works on whichever paintable component the
        // selected entity actually has" reasoning that already lets it
        // share a slot with the tile tool above — a selected entity is
        // realistically either a Tilemap or a NavWorld2D, never both, so
        // there's no ambiguity about which one a bare "erase" click
        // should target.
        _isPaintingNav = true;
        beginEdit("scene");
        _paintNavCellAtClientPos(selected, navWorld, e.clientX, e.clientY, tool === "erase" ? "erase" : (e.altKey ? "erase" : "blocked"));
        // NavWorld2D cells have no live scene-render representation of
        // their own (unlike Tilemap cells, which TilemapSystem.update()
        // inside _paintNavCellAtClientPos -> syncSpriteRender() already
        // turns into real tile sprites) — the ONLY visual is the
        // editor-only grid overlay NavWorldGizmo.js draws, which only
        // redraws inside refreshGizmos(). Without this call the very
        // first painted cell wouldn't appear until some unrelated full
        // render() happened to run later (e.g. toggling the tool).
        refreshGizmos();
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Nav tool owns the pointer exactly like the tile tool above —
    // paints (or, with Alt/erase, blocks) the NavWorld2D cell under the
    // cursor on the currently selected entity's NavWorld2D, dragging to
    // continue cell-by-cell (see pointermove's mirrored branch below).
    // Area tool follows the same pointer-ownership shape but writes
    // editorState.activeNavAreaIndex instead of a walkable/blocked
    // value — Shift doesn't apply to it (there's no "opposite" area to
    // paint the way blocked is walkable's opposite), but Alt DOES apply,
    // same "modifier inverts paint into erase" convention nav/nav-block
    // already follow: Alt+click clears the cell's area tag back to
    // Ground instead of tagging it with the picked area (see
    // "erase-area" in _paintNavCellAtClientPos's header above).
    if (tool === "nav" || tool === "nav-block" || tool === "nav-area") {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const navWorld = selected ? selected.getComponent(NAV_WORLD_2D) : null;
      if (navWorld) {
        _isPaintingNav = true;
        beginEdit("scene");
        const mode = tool === "nav-area"
          ? (e.altKey ? "erase-area" : "area")
          : (tool === "nav-block" ? (e.altKey ? "erase" : "blocked") : (e.shiftKey ? "blocked" : (e.altKey ? "erase" : "walkable")));
        _paintNavCellAtClientPos(selected, navWorld, e.clientX, e.clientY, mode);
        // See the matching comment on the erase-tool branch above — the
        // grid overlay only redraws inside refreshGizmos().
        refreshGizmos();
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Triangle collider vertex handles take priority over the
    // translate/scale/rotate gizmo when both are visually present —
    // they're small, precise targets that would otherwise often lose
    // to the bigger transform gizmo's hit region at the same spot.
    // Checked regardless of activeTool (same as the transform gizmo's
    // own translate/scale/rotate gating below still applies to IT, but
    // reshaping a collider is its own direct-manipulation mode, not
    // tied to a toolbar tool).
    {
      const world = clientToWorld(e.clientX, e.clientY);
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const transform = selected ? selected.getComponent(TRANSFORM) : null;
      const collider = selected ? selected.getComponent(COLLIDER_2D) : null;
      if (transform && collider) {
        const vertexIndex = triangleColliderGizmo.hitTest(world.x, world.y);
        if (vertexIndex !== null) {
          beginEdit("scene");
          triangleColliderGizmo.beginDrag(vertexIndex, transform);
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }

    // Triangle SHAPE vertex handles — same priority tier as the
    // collider handles just above, checked separately since an entity
    // could in principle carry both a Collider2D and a ShapeRenderer;
    // the collider check above already `return`ed if it hit, so this
    // only runs when that one didn't.
    {
      const world = clientToWorld(e.clientX, e.clientY);
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const transform = selected ? selected.getComponent(TRANSFORM) : null;
      const shapeRenderer = selected ? selected.getComponent(SHAPE_RENDERER) : null;
      if (transform && shapeRenderer) {
        const vertexIndex = triangleShapeGizmo.hitTest(world.x, world.y);
        if (vertexIndex !== null) {
          beginEdit("scene");
          triangleShapeGizmo.beginDrag(vertexIndex, transform);
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }

    // Freeform Light polygon vertex handles — same priority tier as
    // the triangle collider handles above (checked before the generic
    // translate/scale/rotate gizmo and before click-to-select), only
    // when the currently selected entity actually is a Freeform light.
    // Right-click/alt-click a vertex to delete it; a plain single
    // click directly on an EDGE LINE (not a vertex) inserts a new
    // vertex there immediately — see the comment on hitTestEdge below
    // for why this replaced an earlier double-click-based version.
    {
      const world = clientToWorld(e.clientX, e.clientY);
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const transform = selected ? selected.getComponent(TRANSFORM) : null;
      const light = selected ? selected.getComponent(LIGHT) : null;
      if (transform && light && light.type === LightType.FREEFORM) {
        const vertexIndex = freeformLightGizmo.hitTest(world.x, world.y, _worldPerPixel());
        if (vertexIndex !== null) {
          if (e.altKey) {
            // Alt-click as a left-button-only alternative to the
            // right-click contextmenu handler above (some trackpads/
            // browsers make right-click awkward).
            snapshotNow("scene");
            freeformLightGizmo.removePoint(light, vertexIndex);
            e.preventDefault();
            e.stopPropagation();
            if (renderFn) renderFn();
            return;
          }
          beginEdit("scene");
          freeformLightGizmo.beginDrag(vertexIndex, transform);
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // Single click directly on an edge LINE (anywhere along it, not
        // just near a vertex — see hitTestEdge's own doc comment for
        // the whole-segment hit test) inserts a new vertex right there.
        // This replaced an earlier double-click-to-insert design: manual
        // double-click timing/distance tracking (see the removed
        // _lastFreeformClick var) turned out to be unreliable on
        // trackpads and touchscreens — a single unambiguous click on a
        // line that ISN'T a vertex needs no timing window at all, and
        // reads more naturally too (click a vertex to grab it, click
        // the line between two vertices to add one there).
        const edgeHit = freeformLightGizmo.hitTestEdge(world.x, world.y, _worldPerPixel());
        if (edgeHit) {
          snapshotNow("scene");
          freeformLightGizmo.insertPoint(light, edgeHit.afterIndex, edgeHit.x, edgeHit.y, transform);
          e.preventDefault();
          e.stopPropagation();
          if (renderFn) renderFn();
          return;
        }
      }
    }

    // Joint2D anchor handles — same priority tier as the StrokePath
    // handles just below (stay live regardless of which tool is
    // active, checked before the general gizmo-dragging/select logic
    // further down), so you can always grab and reposition anchor1/
    // anchor2 by dragging the green dots instead of typing numbers.
    {
      const world = clientToWorld(e.clientX, e.clientY);
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const joint = selected ? selected.getComponent(JOINT_2D) : null;
      if (selected && joint) {
        const anchorHit = jointGizmo.hitTest(world.x, world.y, _worldPerPixel());
        if (anchorHit) {
          beginEdit("scene");
          jointGizmo.beginDrag(anchorHit);
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }

    // StrokePath point handles — same priority tier and interaction
    // convention as the Freeform Light handles just above (drag a
    // point, alt-click/right-click to remove, click a segment to
    // insert), but these stay live regardless of which tool is
    // active — including the dedicated "path" tool below, whose own
    // click-to-APPEND behavior only kicks in once none of these
    // "adjust an existing point" hits land first. That ordering
    // matters: with the Path tool active, clicking an existing handle
    // should still grab it to reposition, not append a duplicate
    // point on top of it.
    {
      const world = clientToWorld(e.clientX, e.clientY);
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const transform = selected ? selected.getComponent(TRANSFORM) : null;
      const strokePath = selected ? selected.getComponent(STROKE_PATH) : null;
      if (transform && strokePath) {
        const vertexIndex = strokePathGizmo.hitTest(world.x, world.y, _worldPerPixel());
        if (vertexIndex !== null) {
          if (e.altKey) {
            snapshotNow("scene");
            strokePathGizmo.removePoint(strokePath, vertexIndex);
            e.preventDefault();
            e.stopPropagation();
            if (renderFn) renderFn();
            return;
          }
          beginEdit("scene");
          strokePathGizmo.beginDrag(vertexIndex, transform);
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const edgeHit = strokePathGizmo.hitTestEdge(world.x, world.y, _worldPerPixel());
        if (edgeHit) {
          snapshotNow("scene");
          strokePathGizmo.insertPoint(strokePath, edgeHit.afterIndex, edgeHit.x, edgeHit.y, transform);
          e.preventDefault();
          e.stopPropagation();
          if (renderFn) renderFn();
          return;
        }
        // Path tool: a click that landed on neither an existing point
        // nor a segment (both handled above) appends a brand new point
        // at the END of the path instead — this is what actually lets
        // the user "draw" the path by clicking a sequence of spots,
        // same tool-gated pattern as the Tile/Erase/Nav paint tools
        // elsewhere in this file (only fires while THIS tool is
        // active, so clicking around with Translate/Rotate/Scale
        // selected never accidentally grows the path).
        if (editorState.activeTool === "path") {
          snapshotNow("scene");
          strokePathGizmo.appendPoint(strokePath, world.x, world.y, transform);
          e.preventDefault();
          e.stopPropagation();
          if (renderFn) renderFn();
          return;
        }
      }
    }

    // Gizmo dragging is exclusive to translate/scale/rotate — but
    // click-to-select on a sprite should work no matter which tool is
    // active (including "pan"), same as every other editor. This used
    // to bail out entirely for any other tool, which made clicking a
    // sprite do nothing while the pan tool was selected.
    if (tool === "translate" || tool === "scale" || tool === "rotate") {
      const world = clientToWorld(e.clientX, e.clientY);
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const transform = selected ? selected.getComponent(TRANSFORM) : null;

      if (transform) {
        const handle = transformGizmo.hitTest(world.x, world.y);
        if (handle) {
          beginEdit("scene");
          transformGizmo.beginDrag(handle, world.x, world.y, transform);
          // Snapshot every OTHER selected entity's starting Transform so
          // the same relative move/scale/rotate the gizmo applies to the
          // primary can be replayed onto the rest of the multi-selection
          // in pointermove below (see _multiDragSnapshots' doc comment).
          _multiDragSnapshots = [];
          if (editorState.world) {
            for (const id of editorState.selectedIds) {
              if (id === editorState.selectedId) continue;
              const ent = editorState.world.getEntity(id);
              const t = ent ? ent.getComponent(TRANSFORM) : null;
              if (!ent || !t) continue;
              _multiDragSnapshots.push({
                entity: ent,
                start: { x: t.x, y: t.y, scaleX: t.scaleX, scaleY: t.scaleY, rotation: t.rotation },
              });
            }
          }
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }

    // Not on a gizmo handle (or gizmo tool isn't active): try selecting
    // a different entity. Runs for every tool (including "pan") so
    // clicking always selects it. Light gizmo icons are checked FIRST
    // and take priority over sprite hit-testing — a light's clickable
    // icon is deliberately small and would otherwise often be "covered"
    // by whatever bigger sprite sits at/near the same position (a lamp
    // sprite with a Point light entity centered on it, for example).
    const world = clientToWorld(e.clientX, e.clientY);
    const lightHit = hitTestLightGizmo(editorState.world, world.x, world.y, _worldPerPixel());
    const audioHit = hitTestAudioGizmo(editorState.world, world.x, world.y, _worldPerPixel());
    const audioListenerHit = hitTestAudioListenerGizmo(editorState.world, world.x, world.y, _worldPerPixel());
    const spriteHit = hitTestEntities(world.x, world.y);
    const hitId = lightHit ? lightHit.id : audioHit ? audioHit.id : audioListenerHit ? audioListenerHit.id : (spriteHit ? spriteHit.id : null);
    if (hitId) {
      if (e.shiftKey) {
        const i = editorState.selectedIds.indexOf(hitId);
        if (i >= 0) editorState.selectedIds.splice(i, 1);
        else editorState.selectedIds.push(hitId);
        editorState.selectedId = editorState.selectedIds.length
          ? editorState.selectedIds[editorState.selectedIds.length - 1]
          : null;
      } else {
        editorState.selectedId = hitId;
        editorState.selectedIds = [hitId];
      }
      if (renderFn) renderFn();
      return;
    }

    // Clicked empty space with nothing else claiming the drag (tile/
    // erase/nav/pan tools already returned earlier, and this only runs
    // when no gizmo handle/entity/light/audio icon was hit): start a
    // box-select marquee instead of clearing the selection immediately.
    // The actual clear-vs-select decision happens on release in endDrag
    // below — a plain click with no real drag distance still clears
    // (Shift+click keeps the existing selection either way).
    _boxSelectState = {
      startWorldX: world.x,
      startWorldY: world.y,
      curWorldX: world.x,
      curWorldY: world.y,
      additive: e.shiftKey,
    };
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });

  el.addEventListener("pointermove", (e) => {
    if (_boxSelectState) {
      const world = clientToWorld(e.clientX, e.clientY);
      _boxSelectState.curWorldX = world.x;
      _boxSelectState.curWorldY = world.y;
      _drawBoxSelectRect();
      return;
    }
    if (_isPaintingTile) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const tilemap = selected ? selected.getComponent(TILEMAP) : null;
      if (tilemap) _paintTileAtClientPos(selected, tilemap, e.clientX, e.clientY, editorState.activeTool === "erase" || e.altKey);
      return;
    }
    if (_isPaintingNav) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const navWorld = selected ? selected.getComponent(NAV_WORLD_2D) : null;
      if (navWorld) {
        const mode = editorState.activeTool === "erase"
          ? "erase"
          : (editorState.activeTool === "nav-area"
              ? (e.altKey ? "erase-area" : "area")
              : (e.altKey ? "erase" : (editorState.activeTool === "nav-block" ? "blocked" : "walkable")));
        _paintNavCellAtClientPos(selected, navWorld, e.clientX, e.clientY, mode);
        // Same reasoning as the pointerdown branches above — without
        // this, dragging paints real cells but the grid overlay only
        // catches up on the NEXT unrelated full render (e.g. toggling
        // the tool off/on), so a drag visually shows nothing changing
        // until you let go and something else happens to redraw.
        refreshGizmos();
      }
      return;
    }
    if (freeformLightGizmo.isDragging()) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const light = selected ? selected.getComponent(LIGHT) : null;
      if (!light) return;
      const world = clientToWorld(e.clientX, e.clientY);
      freeformLightGizmo.updateDrag(world.x, world.y, light);
      syncSpriteRender();
      refreshGizmos();
      return;
    }
    if (strokePathGizmo.isDragging()) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const strokePath = selected ? selected.getComponent(STROKE_PATH) : null;
      if (!strokePath) return;
      const world = clientToWorld(e.clientX, e.clientY);
      strokePathGizmo.updateDrag(world.x, world.y, strokePath);
      syncSpriteRender();
      refreshGizmos();
      return;
    }
    if (jointGizmo.isDragging()) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const joint = selected ? selected.getComponent(JOINT_2D) : null;
      if (!joint) return;
      const world = clientToWorld(e.clientX, e.clientY);
      jointGizmo.updateDrag(world.x, world.y, joint);
      refreshGizmos();
      return;
    }

    if (triangleColliderGizmo.isDragging()) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const collider = selected ? selected.getComponent(COLLIDER_2D) : null;
      if (!collider) return;
      const world = clientToWorld(e.clientX, e.clientY);
      triangleColliderGizmo.updateDrag(world.x, world.y, collider);
      syncSpriteRender();
      refreshGizmos();
      return;
    }

    if (triangleShapeGizmo.isDragging()) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const shapeRenderer = selected ? selected.getComponent(SHAPE_RENDERER) : null;
      if (!shapeRenderer) return;
      const world = clientToWorld(e.clientX, e.clientY);
      triangleShapeGizmo.updateDrag(world.x, world.y, shapeRenderer);
      syncSpriteRender();
      refreshGizmos();
      return;
    }

    if (!transformGizmo.isDragging()) return;
    const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
    const transform = selected ? selected.getComponent(TRANSFORM) : null;
    if (!transform) return;

    const world = clientToWorld(e.clientX, e.clientY);
    const dragStart = transformGizmo.getDragStart();
    transformGizmo.updateDrag(world.x, world.y, transform);

    // Replay the primary's net change since drag-start onto every other
    // selected entity's own starting Transform, so translate/scale/
    // rotate move the whole multi-selection together in lockstep — see
    // _multiDragSnapshots' doc comment above.
    if (dragStart && _multiDragSnapshots.length) {
      const dx = transform.x - dragStart.x;
      const dy = transform.y - dragStart.y;
      const dScaleX = transform.scaleX - dragStart.scaleX;
      const dScaleY = transform.scaleY - dragStart.scaleY;
      const dRotation = transform.rotation - dragStart.rotation;
      for (const snap of _multiDragSnapshots) {
        const t = snap.entity.getComponent(TRANSFORM);
        if (!t) continue;
        t.x = snap.start.x + dx;
        t.y = snap.start.y + dy;
        t.scaleX = snap.start.scaleX + dScaleX;
        t.scaleY = snap.start.scaleY + dScaleY;
        t.rotation = snap.start.rotation + dRotation;
      }
    }

    syncSpriteRender();
    refreshGizmos();
  });

  const endDrag = (e) => {
    if (_boxSelectState) {
      const state = _boxSelectState;
      _boxSelectState = null;
      if (boxSelectGfx) boxSelectGfx.clear();
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}

      const minX = Math.min(state.startWorldX, state.curWorldX);
      const maxX = Math.max(state.startWorldX, state.curWorldX);
      const minY = Math.min(state.startWorldY, state.curWorldY);
      const maxY = Math.max(state.startWorldY, state.curWorldY);
      // Distinguish a real marquee drag from a plain click that barely
      // moved (in SCREEN px, so it feels consistent regardless of
      // zoom level) — a tiny/no drag just clears the selection like a
      // normal empty-space click always has.
      const screenDx = (maxX - minX) * pixiApp.stage.scale.x;
      const screenDy = (maxY - minY) * pixiApp.stage.scale.y;
      const isRealDrag = Math.hypot(screenDx, screenDy) > 4;

      if (isRealDrag && editorState.world) {
        const hitIds = _entitiesIntersectingBox(minX, minY, maxX, maxY);
        if (state.additive) {
          for (const id of hitIds) {
            if (!editorState.selectedIds.includes(id)) editorState.selectedIds.push(id);
          }
        } else {
          editorState.selectedIds = hitIds;
        }
        editorState.selectedId = editorState.selectedIds.length
          ? editorState.selectedIds[editorState.selectedIds.length - 1]
          : null;
      } else if (!state.additive) {
        // Plain click on empty space (no real drag, no shift): clear
        // the selection, matching the previous single-click behavior.
        editorState.selectedId = null;
        editorState.selectedIds = [];
      }
      if (renderFn) renderFn();
      return;
    }
    if (_isPaintingTile) {
      _isPaintingTile = false;
      commitEdit("scene");
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      return;
    }
    if (_isPaintingNav) {
      _isPaintingNav = false;
      commitEdit("scene");
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      return;
    }
    if (freeformLightGizmo.isDragging()) {
      freeformLightGizmo.endDrag();
      commitEdit("scene");
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      if (renderFn) renderFn();
      return;
    }
    if (strokePathGizmo.isDragging()) {
      strokePathGizmo.endDrag();
      commitEdit("scene");
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      if (renderFn) renderFn();
      return;
    }
    if (jointGizmo.isDragging()) {
      jointGizmo.endDrag();
      commitEdit("scene");
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      if (renderFn) renderFn(); // sync Inspector's anchor X/Y fields with the final value
      return;
    }
    if (triangleColliderGizmo.isDragging()) {
      triangleColliderGizmo.endDrag();
      commitEdit("scene");
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      if (renderFn) renderFn();
      return;
    }
    if (triangleShapeGizmo.isDragging()) {
      triangleShapeGizmo.endDrag();
      commitEdit("scene");
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      if (renderFn) renderFn();
      return;
    }
    if (!transformGizmo.isDragging()) return;
    transformGizmo.endDrag();
    _multiDragSnapshots = [];
    commitEdit("scene");
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}
    if (renderFn) renderFn(); // sync Inspector fields with the final value
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
}

/**
 * Bounding-box hit test against every entity that has a Transform +
 * (SpriteRenderer or ShapeRenderer), used for click-to-select in the
 * viewport. Uses each object's REAL rendered world-space size (via
 * RenderSystem's live PIXI sprite/graphics — see
 * getSpriteWorldHalfExtents/getShapeWorldHalfExtents above) so clicks
 * land correctly regardless of how big or small a given object
 * actually is; falls back to a reasonable 40px half-extent only for
 * the rare case an object hasn't been rendered yet (e.g. a sprite
 * whose texture is still loading), so a click still hits something
 * close instead of never registering.
 */
function hitTestEntities(worldX, worldY) {
  if (!editorState.world) return null;
  const spriteEntities = editorState.world.query(TRANSFORM, SPRITE_RENDERER);
  const shapeEntities = editorState.world.query(TRANSFORM, SHAPE_RENDERER);
  // "Empty" entities — Transform only, no Sprite/Shape Renderer (e.g. a
  // plain GameObject created via Add Object -> Empty, or an organizing
  // folder-style parent) — used to be completely absent from this hit
  // test, so clicking exactly on one could never select it; the click
  // just silently hit nothing and deselected instead. They have no
  // visual bounds to hit-test against (nothing renders), so they get
  // the same small fixed-size box the Hierarchy/viewport already draws
  // their gizmo icon at — see EMPTY_ENTITY_HIT_HALF_EXTENT below.
  const emptyEntities = editorState.world
    .query(TRANSFORM)
    .filter((e) => !e.getComponent(SPRITE_RENDERER) && !e.getComponent(SHAPE_RENDERER));
  // Combine both sets and re-sort by Transform.z so topmost-drawn wins
  // the hit test regardless of which component it carries — same
  // draw-order rule RenderSystem itself uses (see its file header).
  // Entities carrying both components (sprite used as a placeholder
  // plus a shape on top, or vice versa) appear once per component,
  // which is fine here since either match returns the same entity.
  const candidates = spriteEntities.concat(shapeEntities, emptyEntities).sort((a, b) => {
    const za = a.getComponent(TRANSFORM).z;
    const zb = b.getComponent(TRANSFORM).z;
    return za - zb;
  });
  // iterate back-to-front (topmost first) by reversing
  for (let i = candidates.length - 1; i >= 0; i--) {
    const entity = candidates[i];
    const t = entity.getComponent(TRANSFORM);
    const isShape = !!entity.getComponent(SHAPE_RENDERER);
    const isSprite = !!entity.getComponent(SPRITE_RENDERER);
    const real = renderSystem && (isShape || isSprite)
      ? (isShape ? renderSystem.getShapeWorldHalfExtents(entity.id) : renderSystem.getSpriteWorldHalfExtents(entity.id))
      : null;
    const halfWidth = real
      ? real.halfWidth
      : (isShape || isSprite)
        ? 40 * Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY), 0.2)
        : EMPTY_ENTITY_HIT_HALF_EXTENT;
    const halfHeight = real ? real.halfHeight : halfWidth;
    if (worldX >= t.x - halfWidth && worldX <= t.x + halfWidth && worldY >= t.y - halfHeight && worldY <= t.y + halfHeight) {
      return entity;
    }
  }
  return null;
}

/**
 * Returns ids of every sprite/shape entity whose world-space bounding
 * box intersects the given rectangle (AABB overlap, not full containment
 * — an object partly inside the marquee still counts, matching the
 * standard "drag a box, anything it touches gets selected" convention).
 * Same half-extent lookup as hitTestEntities above, so results are
 * consistent with ordinary click-select.
 */
function _entitiesIntersectingBox(minX, minY, maxX, maxY) {
  if (!editorState.world) return [];
  const spriteEntities = editorState.world.query(TRANSFORM, SPRITE_RENDERER);
  const shapeEntities = editorState.world.query(TRANSFORM, SHAPE_RENDERER);
  const emptyEntities = editorState.world
    .query(TRANSFORM)
    .filter((e) => !e.getComponent(SPRITE_RENDERER) && !e.getComponent(SHAPE_RENDERER));
  const seen = new Set();
  const result = [];
  for (const entity of spriteEntities.concat(shapeEntities, emptyEntities)) {
    if (seen.has(entity.id)) continue; // entity carrying both components would otherwise appear twice
    seen.add(entity.id);
    const t = entity.getComponent(TRANSFORM);
    const isShape = !!entity.getComponent(SHAPE_RENDERER);
    const isSprite = !!entity.getComponent(SPRITE_RENDERER);
    const real = renderSystem && (isShape || isSprite)
      ? (isShape ? renderSystem.getShapeWorldHalfExtents(entity.id) : renderSystem.getSpriteWorldHalfExtents(entity.id))
      : null;
    const halfWidth = real
      ? real.halfWidth
      : (isShape || isSprite)
        ? 40 * Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY), 0.2)
        : EMPTY_ENTITY_HIT_HALF_EXTENT;
    const halfHeight = real ? real.halfHeight : halfWidth;
    const entMinX = t.x - halfWidth, entMaxX = t.x + halfWidth;
    const entMinY = t.y - halfHeight, entMaxY = t.y + halfHeight;
    // Standard AABB overlap test: NOT (separated on any axis).
    const intersects = entMinX <= maxX && entMaxX >= minX && entMinY <= maxY && entMaxY >= minY;
    if (intersects) result.push(entity.id);
  }
  return result;
}

/**
 * Draws the live marquee rectangle for an in-progress box-select drag
 * into boxSelectGfx (a child of gizmoContainer, so it renders above
 * scene content like every other editor-only gizmo). World-space
 * coordinates, same as selectionOutlineGfx — see _boxSelectState's doc
 * comment for why that's fine even though it means the 1px outline
 * visually scales with zoom.
 */
function _drawBoxSelectRect() {
  if (!boxSelectGfx || !_boxSelectState) return;
  const { startWorldX, startWorldY, curWorldX, curWorldY } = _boxSelectState;
  const x = Math.min(startWorldX, curWorldX);
  const y = Math.min(startWorldY, curWorldY);
  const w = Math.abs(curWorldX - startWorldX);
  const h = Math.abs(curWorldY - startWorldY);
  boxSelectGfx.clear();
  boxSelectGfx.lineStyle(1.5, 0x4f9eff, 1);
  boxSelectGfx.beginFill(0x4f9eff, 0.12);
  boxSelectGfx.drawRect(x, y, w, h);
  boxSelectGfx.endFill();
}

/**
 * Uploaded sprite images can be any native pixel size (a phone photo
 * might be 3000x4000). Placing them at scale 1:1 would make them cover
 * the entire scene and read as a giant black/blown-out rectangle rather
 * than a sprite. This computes a proportional scale so the sprite's
 * longest side lands at SPRITE_FIT_SIZE px in world space by default —
 * small enough to see the whole scene around it, still clearly visible.
 * Small source images (icons, pixel art) are left at 1:1 or upscaled
 * only up to a modest ceiling, so tiny art doesn't get shrunk further.
 */
const SPRITE_FIT_SIZE = 96;
const SPRITE_MAX_UPSCALE = 2;

function fitSpriteScale(width, height) {
  if (!width || !height) return { scaleX: 1, scaleY: 1 };
  const longest = Math.max(width, height);
  let scale = SPRITE_FIT_SIZE / longest;
  scale = Math.min(scale, SPRITE_MAX_UPSCALE);
  scale = Math.round(scale * 1000) / 1000; // avoid ugly float noise in Inspector fields
  return { scaleX: scale, scaleY: scale };
}

function attachDropTarget(mount) {
  const el = pixiApp.view;
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  // Each branch below calls snapshotNow("scene") right before its
  // mutation — same choke point every other instantaneous scene edit
  // uses (see UndoManager.js's snapshotNow doc comment: delete, add
  // entity, add/remove component, paste, duplicate, etc). Placing a
  // sprite/audio clip/prefab via drag-and-drop creates a new entity
  // exactly like those other actions do, so it needs the same undo
  // step + dirty-flag as any of them — previously this whole handler
  // mutated editorState.world directly with neither, so a drag-and-
  // drop placement was both un-undoable AND invisible to the "unsaved
  // changes" indicator/reload guard.
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const spriteKey = e.dataTransfer.getData("application/x-realot-sprite-key");
    const audioKey = e.dataTransfer.getData("application/x-realot-audio-key");
    const prefabId = e.dataTransfer.getData("application/x-realot-prefab-id");

    if (prefabId && editorState.world) {
      const prefab = getPrefab(prefabId);
      if (!prefab) return;
      snapshotNow("scene");
      const world = clientToWorld(e.clientX, e.clientY);
      const entity = instantiatePrefab(editorState.world, prefabId, prefab.name);
      if (!entity) return;
      // Place at the drop position — instantiatePrefab() reconstructs
      // the prefab's own template Transform verbatim (see
      // PrefabRegistry.instantiatePrefab -> SceneSerializer.
      // instantiateEntity), so without this every dragged-in instance
      // would stack on top of wherever the prefab's SOURCE object
      // happened to be positioned, rather than where it was actually
      // dropped — same "drop lands where you dropped it" expectation
      // sprite/audio drops just below already give.
      const t = entity.getComponent(TRANSFORM);
      if (t) {
        t.x = Math.round(world.x);
        t.y = Math.round(world.y);
      }
      editorState.selectedId = entity.id;
      editorState.selectedIds = [entity.id];
      pushLog("log", "Placed prefab '" + prefab.name + "' in scene.");
      syncSpriteRender();
      if (renderFn) renderFn();
      return;
    }

    if (audioKey && editorState.world) {
      const asset = getAudioAsset(audioKey);
      if (!asset) return;
      snapshotNow("scene");
      const world = clientToWorld(e.clientX, e.clientY);
      const entity = editorState.world.createEntity(asset.name || "Audio");
      entity.addComponent(TRANSFORM, new Transform({ x: Math.round(world.x), y: Math.round(world.y) }));
      entity.addComponent(AUDIO_SOURCE, new AudioSource({ audioKey: asset.key }));
      editorState.selectedId = entity.id;
      editorState.selectedIds = [entity.id];
      pushLog("log", "Placed audio '" + asset.name + "' in scene.");
      syncSpriteRender();
      if (renderFn) renderFn();
      return;
    }

    if (!spriteKey || !editorState.world) return;

    const asset = getSpriteAsset(spriteKey);
    if (!asset) return;

    snapshotNow("scene");
    const world = clientToWorld(e.clientX, e.clientY);
    const { scaleX, scaleY } = fitSpriteScale(asset.width, asset.height);
    const entity = editorState.world.createEntity(asset.name || "Sprite");
    entity.addComponent(
      TRANSFORM,
      new Transform({ x: Math.round(world.x), y: Math.round(world.y), scaleX, scaleY })
    );
    entity.addComponent(
      SPRITE_RENDERER,
      new SpriteRenderer({ spriteKey: asset.key, referenceWidth: asset.width, referenceHeight: asset.height })
    );

    if (asset.gifFrames && asset.gifFrames.length > 1) {
      var clip = {
        id: generateClipId(),
        name: asset.name || "Animation",
        frames: asset.gifFrames.map(function (k) { return { spriteKey: k, sourceAssetKey: null }; }),
        fps: asset.gifFps || 10,
        loop: true,
        colliderOverride: null,
      };
      entity.addComponent(SPRITE_ANIMATION, new SpriteAnimation({ clips: [clip], currentClipId: clip.id, playing: true }));
      pushLog("log", "Placed animated GIF '" + asset.name + "' (" + asset.gifFrames.length + " frames) in scene.");
    } else {
      pushLog("log", "Placed sprite '" + asset.name + "' in scene.");
    }

    editorState.selectedId = entity.id;
    editorState.selectedIds = [entity.id];
    syncSpriteRender();
    if (renderFn) renderFn();
  });
}

/**
 * Runs ONLY RenderSystem.update() against the current world so any
 * Transform/SpriteRenderer changes (placing a sprite, dragging it,
 * editing Inspector fields) show up in the Scene view immediately —
 * without calling game.loop.start(), which would also run PhysicsSystem
 * and cause objects to fall/drift while just editing.
 */
function syncSpriteRender() {
  if (!renderSystem || !editorState.world) return;
  try {
    if (animationSystem) animationSystem.update(editorState.world, 0);
    renderSystem.update(editorState.world, 0);
    // TilemapSystem builds/refreshes tile sprites from Tilemap.cells,
    // so it must tick here too — otherwise painted cells never render
    // (the game loop is intentionally never started in the editor).
    if (tilemapSystem) tilemapSystem.update(editorState.world, 0);
    if (_markViewportDirty) _markViewportDirty();
    // Runs right after RenderSystem so any Light component edits (color,
    // intensity, radius, type, or moving a light's Transform) preview
    // live in the Scene view exactly like sprite edits do — matching
    // how Play mode will actually look, same reasoning as calling
    // renderSystem.update() here instead of only during a real game
    // loop tick.
    if (lightingSystem) lightingSystem.update(editorState.world, 0);
    _renderSyncFailed = false;
  } catch (err) {
    pushLog("error", "Render sync failed: " + (err && err.message ? err.message : err));
    // Surface this beyond the Console tab — see isViewportRenderSyncFailed()
    // doc comment. A failed sync commonly means a frame's worth of
    // sprites/tiles/lights just silently didn't draw (UI and camera
    // controls keep working fine since neither touches the renderer),
    // which otherwise looks exactly like "nothing renders but I can
    // still zoom" with no visible explanation anywhere in the viewport
    // itself.
    _renderSyncFailed = true;
    if (renderFn) renderFn();
  }
  syncBackgroundColor();
}

/**
 * Applies the scene's Main Camera backgroundColor to the Scene
 * viewport's own canvas, live — every editor render, so dragging the
 * color picker in the Inspector previews instantly here, exactly like
 * it will look in Play mode. This is the "live in the editor" half of
 * the background-color feature; the play popup applies the same color
 * only once, at the moment Play is pressed (see PlayWindow.js), never
 * tracking further edits while a game is actually running.
 */
function syncBackgroundColor() {
  if (!pixiApp || !editorState.world) return;
  const cameraEntity = editorState.world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
  const color = cameraEntity ? cameraEntity.getComponent(CAMERA).backgroundColor : "#282828";
  RenderSystem.applyBackgroundColor(pixiApp, color);
}

/**
 * Redraws just the gizmo layers (called during drag, every pointermove,
 * without going through the full editor render() for performance).
 */
function drawSelectionOutlines() {
  if (!selectionOutlineGfx || !editorState.world) return;
  selectionOutlineGfx.clear();
  for (const id of editorState.selectedIds) {
    if (id === editorState.selectedId) continue; // primary already framed by the transform gizmo
    const ent = editorState.world.getEntity(id);
    if (!ent) continue;
    const t = ent.getComponent(TRANSFORM);
    if (!t) continue;
    const real = renderSystem
      ? (ent.getComponent(SHAPE_RENDERER) ? renderSystem.getShapeWorldHalfExtents(ent.id) : renderSystem.getSpriteWorldHalfExtents(ent.id))
      : null;
    const hw = real ? real.halfWidth : 40 * Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY), 0.2);
    const hh = real ? real.halfHeight : hw;
    selectionOutlineGfx.lineStyle(1.5, 0x8fc153, 1);
    // Rotated outline, same as the primary's gizmo box — so a rotated
    // object's outline turns with it instead of staying axis-aligned.
    const rad = (t.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const corner = (lx, ly) => ({ x: t.x + lx * cos - ly * sin, y: t.y + lx * sin + ly * cos });
    const corners = [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)];
    selectionOutlineGfx.drawPolygon(corners.flatMap((p) => [p.x, p.y]));
  }
}

function refreshGizmos() {
  const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
  drawSelectionOutlines();
  transformGizmo.draw(selected, _worldPerPixel());
  const selectedCollider = selected ? selected.getComponent(COLLIDER_2D) : null;
  triangleColliderGizmo.draw(selected, selectedCollider);
  const selectedShapeRenderer = selected ? selected.getComponent(SHAPE_RENDERER) : null;
  triangleShapeGizmo.draw(selected, selectedShapeRenderer);
  const selectedJoint = selected ? selected.getComponent(JOINT_2D) : null;
  jointGizmo.draw(selected, selectedJoint, editorState.world, _worldPerPixel());
  drawCameraGizmo(cameraGizmoContainer, editorState.world);
  // "Show Agent Navigation" (Inspector.js's NavAgent2D section) pins a
  // specific agent entity's radius AND area mask for the preview —
  // resolve that id back to its live NavAgent2D fields here so
  // NavWorldGizmo always reflects the agent's CURRENT settings, even if
  // they were edited after the preview toggle was turned on.
  let previewRadius = null;
  let previewAreaMask = 0xffff;
  if (editorState.navAgentPreviewEntityId && editorState.world) {
    const previewEntity = editorState.world.getEntity(editorState.navAgentPreviewEntityId);
    const previewAgent = previewEntity ? previewEntity.getComponent(NAV_AGENT_2D) : null;
    if (previewAgent) {
      previewRadius = previewAgent.radius;
      previewAreaMask = previewAgent.area;
    } else {
      editorState.navAgentPreviewEntityId = null; // agent deleted/component removed — clear stale preview
    }
  }
  drawNavWorldGizmo(navWorldGizmoContainer, editorState.world, editorState.showNavWorld, editorState.navWorldViewMode, previewRadius, previewAreaMask);
  drawColliderGizmo(colliderGizmoContainer, editorState.world, editorState.selectedId);
  drawLightGizmo(lightGizmoContainer, editorState.world, editorState.selectedId, _worldPerPixel());
  drawAudioGizmo(audioGizmoContainer, editorState.world, editorState.selectedId, _worldPerPixel());
  drawAudioListenerGizmo(audioListenerGizmoContainer, editorState.world, editorState.selectedId, _worldPerPixel());
}

/**
 * "F to focus": centers + zooms the editor camera to frame the
 * currently selected entity, mirroring the drawSelectionOutlines()
 * bounds logic above so the framed box matches what's drawn on screen.
 * Ignored while typing in an input/textarea/contenteditable field.
 */
let _focusShortcutAttached = false;
function _attachFocusShortcut(mount) {
  if (_focusShortcutAttached) return;
  _focusShortcutAttached = true;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "f" && e.key !== "F") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    const isTyping =
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (isTyping) return;
    if (!editorState.world || !editorState.selectedId) return;
    const ent = editorState.world.getEntity(editorState.selectedId);
    if (!ent) return;
    const t = ent.getComponent(TRANSFORM);
    if (!t) return;
    const real = renderSystem
      ? (ent.getComponent(SHAPE_RENDERER) ? renderSystem.getShapeWorldHalfExtents(ent.id) : renderSystem.getSpriteWorldHalfExtents(ent.id))
      : null;
    const hw = real ? real.halfWidth : 40 * Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY), 0.2);
    const hh = real ? real.halfHeight : hw;
    viewportCamera.focusOn(t.x, t.y, hw, hh);
    e.preventDefault();
  });
}

/**
 * World units per screen pixel at the viewport's current zoom — the
 * inverse of pixiApp.stage.scale.x (same scale clientToWorld already
 * divides by). Used only to keep LightGizmo's bulb icon a constant
 * apparent screen size regardless of zoom (see LightGizmo.js).
 */
function _worldPerPixel() {
  if (!pixiApp || !pixiApp.stage.scale.x) return 1;
  return 1 / pixiApp.stage.scale.x;
}

/**
 * Called every editor render() to mount/resize the viewport and refresh
 * the selection gizmo to track the selected entity's live Transform.
 */
export function mountOrUpdateSceneViewport(render) {
  const mount = document.getElementById("pixi-viewport-canvas");
  if (!mount) return;

  if (!pixiApp) {
    if (!_pixiInitFailed) createViewport(mount, render);
    // If init already failed (no renderer available), skip silently —
    // the editor UI still works, only the scene canvas stays dark.
    if (!pixiApp) return;
  } else {
    renderFn = render || renderFn;
    mount.appendChild(pixiApp.view);
    _resizeViewportToCurrentMount();
    viewportCamera.updateZoomLabel();
    viewportCamera.updateCursor();
  }

  syncSpriteRender();
  refreshGizmos();
}

export function getZoomPercent() {
  return viewportCamera ? viewportCamera.zoomPercent : 100;
}
