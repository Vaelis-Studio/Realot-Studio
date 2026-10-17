/**
 * runtime/index.js
 *
 * PUBLIC ENTRY POINT of the runtime. This is the only module that
 * /editor code or the standalone player (player/main.js) should import
 * from. It wires together World + systems + render + scene loading into
 * one `createGame()` call.
 *
 * The runtime never imports anything from /editor. That's what makes the
 * game standalone — see /RULES.txt.
 */

import { World } from "./core/World.js";
import { GameLoop } from "./core/GameLoop.js";
import { ControllerSystem } from "./systems/ControllerSystem.js";
import { PhysicsSystem } from "./systems/PhysicsSystem.js";
import { AnimationSystem } from "./systems/AnimationSystem.js";
import { SpeechBubbleSystem } from "./systems/SpeechBubbleSystem.js";
import { TextInputSystem } from "./systems/TextInputSystem.js";
import { JoystickSystem } from "./systems/JoystickSystem.js";
import { RenderSystem } from "./systems/RenderSystem.js";
import { CameraRenderSystem } from "./systems/CameraRenderSystem.js";
import { LightingSystem } from "./systems/LightingSystem.js";
import { AudioSystem } from "./systems/AudioSystem.js";
import { AudioListenerSystem } from "./systems/AudioListenerSystem.js";
import { TilemapSystem } from "./systems/TilemapSystem.js";
import { NavWorldSystem } from "./systems/NavWorldSystem.js";
import { ScriptSystem } from "./systems/ScriptSystem.js";
import { loadSceneFromUrl, loadDefaultScene, validateScene } from "./scene/SceneLoader.js";
import { serializeScene, deserializeScene } from "./scene/SceneSerializer.js";
import {
  initSceneManager,
  getSceneList,
  getAllScenesData,
  getActiveSceneId,
  createScene,
  saveActiveScene,
  switchToScene,
  renameScene,
  deleteScene,
  duplicateScene,
  loadAllScenesData,
  replaceAllScenesAndLoad,
} from "./scene/SceneManager.js";
import { ScriptAPI } from "./scripting/ScriptAPI.js";
import { importSpriteFiles, getAllSpriteAssets, getAllFrameAssets, getSpriteAsset, importAudioFiles, getAllAudioAssets, getAudioAsset, deleteSpriteAsset, deleteAudioAsset, renameSpriteAsset, renameAudioAsset, clearAllAssets, restoreProjectAssets } from "./assets/AssetRegistry.js";
import { getAllPrefabs, clearAllPrefabs, restoreProjectPrefabs } from "./prefabs/PrefabRegistry.js";
import { getCameraResolution, getCameraWorldRect } from "./core/CameraUtils.js";
import { CAMERA } from "./components/Camera.js";
import { TRANSFORM } from "./components/Transform.js";

/**
 * Creates a fully wired game instance against a PIXI Application that the
 * caller owns (editor viewport, or the standalone player's own canvas).
 *
 * @param {object} opts
 * @param {PIXI.Application} opts.pixiApp an already-created PIXI Application
 * @param {boolean} [opts.followMainCamera=false] pass true when pixiApp's
 *   stage IS the actual game screen (play-mode popup, standalone player)
 *   so RenderSystem offsets the world by the Main Camera's position.
 * @param {boolean} [opts.editorPreview=false] legacy option retained for
 *   compatibility. Editor, Play Mode, and exported games use the same
 *   rendering-quality path; this flag no longer reduces visual quality.
 * @returns {{
 *   world: World,
 *   loop: GameLoop,
 *   scriptApi: ScriptAPI,
 *   loadScene: (url: string) => Promise<void>,
 *   loadDefault: () => void,
 *   loadFromData: (sceneData: object) => void,
 *   getSceneData: () => object,
 *   validate: () => { ok: boolean, errors: string[] },
 * }}
 */
export function createGame({ pixiApp, followMainCamera = false, editorPreview = false, gameId, navAreaNames = null }) {
  window.__realotPixiApp = pixiApp; // used by AssetManager for placeholder texture generation

  const world = new World();

  // gameContentContainer holds ONLY actual game content (sprites drawn
  // by RenderSystem) as a child of pixiApp.stage, rather than using
  // pixiApp.stage directly. This matters specifically for
  // LightingSystem: it applies a real PIXI.Filter (a GPU shader) to
  // whatever container it's given (see systems/LightingSystem.js), and
  // a Filter affects EVERY pixel of its target INCLUDING children added
  // by other code. In the standalone player and the play-mode popup,
  // pixiApp.stage holds nothing but game content anyway, so this would
  // make no visible difference there — but the editor's Scene viewport
  // (editor/viewport/SceneViewport.js) adds its OWN sibling containers
  // directly onto pixiApp.stage for the grid, selection gizmo, camera
  // frame, collider outlines, and light gizmos. Those are editor-only
  // chrome that must stay visible/undimmed/unshadowed regardless of
  // scene lighting (e.g. a light's range gizmo must still be clickable
  // from inside its own shadow) — if LightingSystem's filter were
  // applied straight to pixiApp.stage, it would darken/relight/shadow
  // that chrome right along with the sprites, which is wrong. Routing
  // both RenderSystem's sprites AND LightingSystem's filter through
  // this dedicated sub-container keeps the filter's reach exactly
  // scoped to real game content in every host (editor, player, popup)
  // without the editor needing any special-case code of its own.
  const gameContentContainer = new PIXI.Container();
  pixiApp.stage.addChild(gameContentContainer);

  // Screen-space UI layer for TextRenderer entities with screenSpace:true
  // (see components/TextRenderer.js). Added as a SIBLING of
  // gameContentContainer directly on pixiApp.stage — NOT a child of it —
  // specifically so it never receives the Main Camera's OWN pan/zoom
  // (_applyMainCameraOffset below only ever applies the camera's zoom/
  // rotation/pan to gameContentContainer/RenderSystem.worldContainer).
  // It DOES still receive the device-fit scale/offset computed by
  // computeScreenFit() (see CameraUtils.js) — same transform, just
  // without the camera's own movement layered on top — so a screen-
  // space Text's Transform.x/y are expressed in REFERENCE-RESOLUTION
  // pixels (consistent across every device) rather than raw physical
  // screen pixels (which would put UI in different relative spots on
  // different screen sizes) — exactly Unity's Canvas Scaler behavior
  // for a UI Canvas. That's what makes a screen-space Text's position
  // stay put on the HUD regardless of camera movement, while still
  // scaling/positioning consistently across devices.
  // Added AFTER gameContentContainer so UI text always draws on top of
  // world content, the ordinary expectation for a HUD.
  const uiContainer = new PIXI.Container();
  pixiApp.stage.addChild(uiContainer);

  // Letterbox/pillarbox bars (see Camera.js's scalingMode settings and
  // computeScreenFit() in CameraUtils.js) — added LAST/topmost on
  // pixiApp.stage so the bars are always painted over anything that
  // might otherwise show through the unused screen space, regardless
  // of what's in gameContentContainer or uiContainer.
  const barsContainer = new PIXI.Graphics();
  pixiApp.stage.addChild(barsContainer);

  // Dedicated child container for physics.raycast(...,{debug:true})
  // lines (see ScriptAPI._raycast / player/main.js's renderDebugLines).
  // Parented under gameContentContainer (not pixiApp.stage directly) so
  // it inherits the exact same camera pan/zoom transform every sprite
  // does — a debug line drawn in world coordinates lines up with the
  // colliders it's testing without any manual transform math in the
  // host (play-popup.js / player/main.js) that actually draws into it.
  // Added AFTER RenderSystem/TilemapSystem/LightingSystem below so it
  // stacks visually on top of sprites and tiles, matching how a debug
  // overlay is expected to always be visible rather than hidden behind
  // scene content.
  const debugGraphicsLayer = new PIXI.Graphics();

  const renderSystem = new RenderSystem(gameContentContainer, { followMainCamera, uiContainer, barsContainer, pixiApp });
  const controllerSystem = new ControllerSystem();
  world.addSystem(controllerSystem);
  const physicsSystem = new PhysicsSystem();
  world.addSystem(physicsSystem);
  renderSystem.physicsWorld = physicsSystem.physicsWorld;
  // Gives movement behaviors access to the previous step's real Rapier
  // contact state (ground/wall/ceiling) without replacing the rigid body.
  controllerSystem.physicsWorld = physicsSystem.physicsWorld;
  // AnimationSystem runs AFTER physics (so a clip switch driven by a
  // script reacting to this frame's physics state — e.g. "landed" —
  // takes effect the same tick) but BEFORE RenderSystem, so the frame
  // it just picked is what actually gets drawn this tick rather than
  // lagging one frame behind.
  world.addSystem(new AnimationSystem());
  world.addSystem(new SpeechBubbleSystem());
  const textInputSystem = new TextInputSystem(pixiApp.view, pixiApp, uiContainer);
  world.addSystem(textInputSystem);
  // JoystickSystem needs its own real pointer/touch listeners attached
  // to the actual canvas (see that file's header for why it tracks
  // input independently of ScriptAPI's shared touch list) — same
  // two-step construct-then-attach split scriptApi.attachPointerInput
  // uses below, for the same reason: nothing here has the real canvas
  // yet at this exact point other than pixiApp.view, which IS already
  // available (unlike renderSystem, which attachPointerInput also
  // needs and isn't constructed until a few lines down) — so this one
  // can attach immediately rather than waiting.
  const joystickSystem = new JoystickSystem(pixiApp.view, pixiApp);
  joystickSystem.attachInput(pixiApp.view, uiContainer);
  world.addSystem(joystickSystem);
  // NOTE: RenderSystem/TilemapSystem/NavWorldSystem/LightingSystem/
  // CameraRenderSystem are constructed here (so gameContentContainer
  // wiring stays grouped and readable) but are NOT added to the world
  // yet — see the "one-frame-late follow" fix below, right after
  // ScriptSystem is added. Constructing early and adding late is safe:
  // World.addSystem only affects update() ORDER, and nothing else in
  // this file calls these systems' update() directly.
  //
  // TilemapSystem shares gameContentContainer with renderSystem so
  // painted tiles live in the same world space and are affected by
  // LightingSystem's filter identically to regular sprites (see
  // gameContentContainer's own comment above for why that container
  // exists at all).
  const tilemapSystem = new TilemapSystem(gameContentContainer);
  // NavWorldSystem does no per-frame PIXI work of its own (see its file
  // header) — findPath/bake are on-demand, not driven by update() order
  // against any other system, so where it's added barely matters, but
  // it's grouped with the other render-adjacent systems for readability.
  const navWorldSystem = new NavWorldSystem();
  // LightingSystem shares the exact same container (gameContentContainer)
  // so its GPU lighting filter updates every frame right alongside
  // sprites, staying visually locked to them (same pan/zoom/camera-follow
  // offset) instead of drifting. renderSystem is also passed in directly
  // so LightingSystem can read each ShadowCaster entity's real rendered
  // sprite bounds for dynamic shadow casting (see
  // LightingSystem.`_collectOccluders`) — always available here since
  // renderSystem is constructed just above.
  const lightingSystem = new LightingSystem(gameContentContainer, renderSystem, pixiApp, { editorPreview });
  // CameraRenderSystem must run AFTER RenderSystem + LightingSystem so
  // the worldContainer is fully synced and lit before capture. It
  // renders any camera with renderToSpriteEntityId set (set via
  // this.camera.renderToSprite(spriteEntity) in a script) into a
  // RenderTexture and assigns it to the target sprite — minimaps.
  const cameraRenderSystem = new CameraRenderSystem(gameContentContainer, renderSystem, pixiApp);

  // Add the debug-ray layer to the container now (a display-list add,
  // not a system add — independent of update() ordering) so it paints
  // on top of every sprite, tile, and lighting effect already in
  // gameContentContainer — a debug line hidden behind scene content
  // would defeat the point of it.
  gameContentContainer.addChild(debugGraphicsLayer);

  // AudioSystem doesn't touch gameContentContainer at all (it drives
  // plain HTMLAudioElements, not PIXI display objects) so its place in
  // the system order relative to rendering/lighting doesn't matter —
  // added here for clarity only.
  const audioSystem = new AudioSystem();
  audioSystem.attachInput(pixiApp.view);
  world.addSystem(audioSystem);

  // AudioListenerSystem also doesn't touch gameContentContainer (pure
  // detection bookkeeping, no PIXI display objects) — added right after
  // AudioSystem for the same "audio-ish systems grouped together"
  // readability reason. Must run BEFORE ScriptSystem (added below) so a
  // script's onUpdate()/onHearSound() this frame already sees this
  // frame's detection results — world.addSystem() runs systems in the
  // order they were added (see core/World.js's update()), so this only
  // needs to be listed before scriptSystem, not wired specially.
  const audioListenerSystem = new AudioListenerSystem();
  world.addSystem(audioListenerSystem);

  const scriptApi = new ScriptAPI(world);
  // Backs nav.areaIndex()/nav.areaMask() (see ScriptAPI.js's nav.* doc
  // comments and NavAPI.js's resolveNavAreaIndex/resolveNavAreaMask) —
  // the caller's Edit → Nav Areas… name registry, or null if this host
  // never wired it through (area name lookups then just always miss,
  // same as an empty project with no named areas).
  scriptApi._navAreaNames = navAreaNames;
  // `save` (see scripting/components/SaveAPI.js) persists to an
  // IndexedDB database namespaced by gameId, so two different
   // Realot games in the same browser never see each other's save
  // data. gameId is the caller's identity for the SHIPPED game (set
  // it in player/main.js's createGame() call when exporting) — the
  // editor's own Play popup and Scene viewport calls intentionally
  // leave it unset, since "the game currently open in the editor" has
  // no stable identity across edits and isn't meant to accumulate its
  // own separate save data long-term.
  scriptApi.saveStore.gameId = gameId || "default";
  // Kick off loading the default slot immediately — most scripts'
  // onStart() will want save.get(...) to already have real data the
  // FIRST time it's called, not just from the second frame onward.
  // This can't be awaited here without making createGame() itself
  // async (a breaking change for its three existing sync call sites —
  // player/main.js, editor/viewport/SceneViewport.js, and
  // editor/viewport/play-popup.js), so instead: fire the load now,
  // and also expose the resulting Promise as game.saveReady below so
  // any caller that DOES want to wait (e.g. showing a loading spinner
  // until save data is available) can `await game.saveReady`. Scripts
  // that don't await it are simply in the same position they'd be in
  // for the very first frame or two regardless: save.get() briefly
  // returns undefined for keys that do exist on disk, exactly like
  // any other "loading" state, and save.isReady reflects this.
  const saveReady = scriptApi.saveStore.load("default");
  // Wires up mouse.x/y, mouse.down()/pressed(), touch, this.isClicked,
  // this.isPointerOver, etc. against the ACTUAL game canvas — must run
  // here (not inside ScriptAPI's own constructor) because it needs both
  // pixiApp.view (the canvas) and renderSystem (for correct screen-to-
  // world coordinate conversion through the live camera transform),
  // neither of which exists yet when `new ScriptAPI(world)` runs above.
  scriptApi.attachPointerInput(pixiApp.view, renderSystem);
  // Backs mouse.isOver()/clickedOn() and this.isPointerOver/isClicked
  // with REAL Rapier shape queries (PhysicsWorld.entityAtPoint) rather
  // than a bounding-box guess — same reasoning as every other physics-
  // backed API wired in below (setScriptSystem, etc.): PhysicsWorld
  // already tracks every Collider2D's true shape for the physics
  // simulation itself, so click hit-testing reuses that instead of
  // re-deriving box/circle/capsule/triangle math a second time here.
  scriptApi._physicsHitTestFn = function (x, y) {
    return physicsSystem.physicsWorld.entityAtPoint(x, y);
  };
  // Backs physics.raycast() with REAL Rapier shape-accurate ray queries
  // (PhysicsWorld.castRay — see runtime/physics/PhysicsWorld.js). castRay
  // already accepts { layerMask } and returns the closest hit
  // (entityId/point/normal/distance) or null; ScriptAPI._raycast just
  // forwards opts.layerMask through and resolves entityId back to a
  // live EntityContext for the calling script. Declared but left
  // unassigned before this line (see the constructor doc comment on
  // _physicsRaycastFn) is what made physics.raycast() throw/no-op
  // previously — this is the missing wiring. The old AABB-only fallback
  // (EntityContext._getColliderAABB) has been removed from ScriptAPI.js
  // entirely — it was dead code once this wiring landed.
  scriptApi._physicsRaycastFn = function (x1, y1, x2, y2, opts) {
    return physicsSystem.physicsWorld.castRay(x1, y1, x2, y2, opts);
  };
  // Preserve the exact support point when a grounded Kinematic script snaps
  // its rotation. This runs in the script phase so rendering never displays
  // a one-frame gap before the physics step can re-seat the collider.
  scriptApi._kinematicRotationFn = function (entity, rotationDeg) {
    physicsSystem.physicsWorld.syncScriptKinematicRotation(entity, rotationDeg);
  };
  // Backs nav.findPath()/nav.isWalkable()/nav.bake() — see
  // NavWorldSystem.js for the real pathfinding/baking logic these
  // forward to. Uses the first NavWorld2D entity in the scene (see
  // NavWorldSystem._firstNavWorld), matching how physics.raycast() above
  // never asks a script to name which PhysicsWorld to use either.
  // `radius`/`area` (from nav.findPath's opts, or a calling NavAgent2D
  // via this.navMoveToward) are forwarded straight through to
  // NavWorldSystem.findPath, which applies the per-agent-radius erosion
  // layer AND the area mask — see components/NavWorld2D.js's
  // getAgentNavLayer. `areaCosts` is the calling NavAgent2D's own
  // per-area cost override (see NavAgent2D.areaCosts) — undefined/null
  // when there's no calling agent (a raw nav.findPath() script call) or
  // the agent has no override set, in which case NavWorldSystem.findPath
  // falls back to the shared NavWorld2D costs exactly as before this
  // parameter existed.
  scriptApi._navFindPathFn = function (x1, y1, x2, y2, radius, area, areaCosts) {
    const navWorldEntity = navWorldSystem._firstNavWorld();
    if (!navWorldEntity) return null;
    return navWorldSystem.findPath(navWorldEntity, x1, y1, x2, y2, radius, area, areaCosts);
  };
  scriptApi._navIsWalkableFn = function (x, y) {
    const navWorldEntity = navWorldSystem._firstNavWorld();
    if (!navWorldEntity) return false;
    return navWorldSystem.isWalkable(navWorldEntity, x, y);
  };
  // Per-agent (radius+area) walkability check — used by
  // EntityContext._escapeDisallowedArea() (see ScriptAPI.js) to tell
  // "this agent's own current spot is illegal for ITS radius/area" apart
  // from "the goal is unreachable but I'm standing somewhere fine" —
  // nav.isWalkable() above only answers the base-layer (radius 0, every
  // area allowed) question, which isn't the same thing.
  scriptApi._navIsWalkableForAgentFn = function (x, y, radius, area, areaCosts) {
    const navWorldEntity = navWorldSystem._firstNavWorld();
    if (!navWorldEntity) return true; // no NavWorld2D baked yet — don't
    // treat "no data" as "agent is illegally placed"; that would trigger
    // escape behavior in every scene that simply hasn't baked yet.
    return navWorldSystem.isWalkableForAgent(navWorldEntity, x, y, radius, area, areaCosts);
  };
  // Backs the "stuck inside a disallowed area" recovery in
  // navMoveToward()/navDriveToward() (see ScriptAPI.js) — finds the
  // nearest point this specific agent (its radius+area) COULD stand,
  // so a script can nudge it back onto walkable ground instead of
  // freezing in place forever inside a zone its own area mask excludes.
  scriptApi._navNearestWalkableFn = function (x, y, radius, area, areaCosts) {
    const navWorldEntity = navWorldSystem._firstNavWorld();
    if (!navWorldEntity) return null;
    return navWorldSystem.nearestWalkablePointForAgent(navWorldEntity, x, y, radius, area, 24, areaCosts);
  };
  scriptApi._navBakeFn = function () {
    const navWorldEntity = navWorldSystem._firstNavWorld();
    if (!navWorldEntity) return null;
    return navWorldSystem.bake(navWorldEntity);
  };
  // Backs this.collider.isColliding()/isColliding(other) — see
  // ColliderAPI.js and PhysicsWorld.isColliding's doc comment for what
  // "colliding" means here (solid contacts only, same set
  // onCollisionStay's per-frame dispatch already reads).
  scriptApi._isCollidingFn = function (entityId, otherEntityId) {
    return physicsSystem.physicsWorld.isColliding(entityId, otherEntityId);
  };
  // ScriptSystem runs user-attached scripts ONLY during the game loop
  // (play-mode popup / standalone player) — never in the editor, which
  // only calls syncSpriteRender() selectively, never game.loop.start().
  const scriptSystem = new ScriptSystem(scriptApi);
  world.addSystem(scriptSystem);

  // Script-driven Car input (this.controller.simulateDrive(throttle,
  // steer) — see ControllerAPI.js) needs to run AFTER ScriptSystem for
  // the same reason the render group below does: whatever a script
  // just set THIS frame needs to be what actually drives the car THIS
  // frame, not next frame. Car specifically (not the rest of
  // ControllerSystem) is what moves here — the walk family/Patrol/
  // Follow are deliberately left in ControllerSystem's original early
  // slot (still added further up, before PhysicsSystem) so scripts
  // keep seeing THIS frame's fresh isGrounded/isOnWall/etc. state (see
  // ControllerAPI.js), exactly as before this fix. See
  // ControllerSystem.updateLateCarInput's own doc comment for the full
  // story of why Car alone needs this split. A tiny inline wrapper
  // object (rather than a whole new file) since it's a one-line
  // delegation with no state of its own.
  world.addSystem({ update: (w, dt) => controllerSystem.updateLateCarInput(w, dt) });

  // RenderSystem (+ the rest of the render-adjacent group) is added
  // HERE — AFTER ScriptSystem — rather than earlier alongside Physics/
  // Animation. This fixes a one-frame-late lag/jitter on anything a
  // script moves: a follow script (`this.transform.x = target.x`, or
  // camera.followMainCamera-style code) or a script driving Transform
  // directly was writing the new position AFTER RenderSystem had
  // already read the OLD position for this frame — so every script-
  // driven movement (including the Main Camera, since RenderSystem's
  // _applyMainCameraOffset() reads the Main Camera's Transform at the
  // top of its own update()) was always drawn one whole frame stale.
  // At 60fps that reads as visible shakiness/lag that gets worse the
  // faster the followed object moves, exactly matching "the background
  // is shaky when the camera moves" / "follows with a delay" reports.
  // Physics/Controller/Animation still run BEFORE ScriptSystem (so
  // scripts see this frame's fresh physics/animation state — e.g.
  // "landed" this tick — same as before), and Audio/AudioListener still
  // feed ScriptSystem's onHearSound dispatch before it runs. Only the
  // PURELY VISUAL group (RenderSystem, TilemapSystem, NavWorldSystem,
  // LightingSystem, CameraRenderSystem) moves to run after scripts, so
  // whatever a script just set this frame is what actually gets drawn
  // this frame instead of next frame.
  world.addSystem(renderSystem);
  world.addSystem(tilemapSystem);
  world.addSystem(navWorldSystem);
  world.addSystem(lightingSystem);
  world.addSystem(cameraRenderSystem);

  // Wire ScriptSystem into PhysicsSystem so collision and trigger events
  // dispatched by Rapier's EventQueue are forwarded to user script handlers
  // (onCollision, onTriggerEnter, onTriggerExit) every physics step.
  physicsSystem.setScriptSystem(scriptSystem);

  // Wire AudioListenerSystem's per-frame detection into ScriptSystem's
  // onHearSound/onLoseSound dispatch (same bind-a-callback pattern as
  // physicsSystem.setScriptSystem above, just two callbacks instead of
  // a single setter since AudioListenerSystem has no other reason to
  // hold a ScriptSystem reference). Also backs this.ear.sourcesInRange/
  // canHear() (see AudioListenerAPI.js) with the same system's live
  // per-listener detection Sets via getInRange().
  audioListenerSystem.onHearSound = function (listenerId, sourceId, w) {
    scriptSystem.fireHearSound(listenerId, sourceId, w);
  };
  audioListenerSystem.onLoseSound = function (listenerId, sourceId, w) {
    scriptSystem.fireLoseSound(listenerId, sourceId, w);
  };
  scriptApi._audioListenerRangeFn = function (listenerEntityId) {
    return audioListenerSystem.getInRange(listenerEntityId);
  };
  const loop = new GameLoop(world, { scriptSystem: scriptSystem, pixiApp: pixiApp });

  // Remember the initial scene data so scene.restart() can reload it.
  // Stored as a deep-clone so in-flight mutations to the original object
  // (component properties updated during play, etc.) never corrupt the
  // restart snapshot — deserializeScene reads the clone unchanged each time.
  let _initialSceneData = null;
  // Scene APIs can be called from collision callbacks while Rapier is
  // draining its event queue. Never mutate World or Rapier from that call
  // stack: retain the first requested transition and apply it after the
  // current GameLoop update has completely finished.
  let _pendingSceneChange = null;
  let _applyingSceneChange = false;

  /**
   * Full teardown before swapping in new scene data — matches Unity's
   * own scene-reload behavior: every currently-running script instance
   * is properly destroyed (onDestroy fires, exactly like a real Unity
   * object being torn down when a scene unloads) BEFORE the new scene's
   * entities/scripts exist, so nothing from the old scene keeps running
   * or leaks into the new one. Previously this only cleared
   * scriptSystem.instances directly (skipping onDestroy entirely) and
   * never touched Rapier's physics bodies or ScriptAPI's cached
   * EntityContexts, which is what caused "restart doesn't really stop
   * old scripts" — the old script objects/handlers were dropped, but
   * their physics bodies and any EntityContext a still-live closure
   * held onto were not, so the scene didn't actually reset the way
   * Unity's Restart Scene does.
   */
  function _teardownForSceneChange() {
    // 1. Destroy every running script instance NOW (calls onDestroy),
    //    while the old scene's entities still exist — same order Unity
    //    fires OnDestroy in when a scene unloads.
    scriptSystem.destroy();
    // 2. Remove every Rapier body/collider the old scene created — a
    //    fresh scene must start with a physically empty Rapier world,
    //    not one still full of the previous scene's now-orphaned bodies.
    physicsSystem.clear();
    controllerSystem.resetScene();
    renderSystem.destroy();
    tilemapSystem.destroy();
    navWorldSystem.destroy();
    lightingSystem.resetScene();
    audioSystem.destroy();
    // Clears every listener's in-range Set — entity ids are about to be
    // reused by World.clear() just like scriptApi.clearContexts() below
    // guards against; without this a listener that reappears (or a new
    // one reusing an old id) would incorrectly fire onLoseSound for
    // sources that were only ever in range in the OLD scene.
    audioListenerSystem.destroy();
    // Real DOM <input> elements (see TextInputSystem.js) are keyed by
    // entity id, and entity ids get reused after World.clear() below —
    // without this, a leftover invisible-but-focusable input from the
    // OLD scene would still be sitting on the page, now silently
    // misattributed to whatever new entity happens to reuse that id.
    textInputSystem.destroy();
    // Claimed pointer/touch ids (see JoystickSystem.js) are also keyed
    // by entity id, and entity ids get reused after World.clear() below
    // — without this, a joystick claim from the OLD scene could stay
    // locked to a pointer id forever, or get silently misattributed to
    // whatever new entity happens to reuse that id.
    joystickSystem.destroy();
    // 3. Drop every cached EntityContext — entity ids are about to be
    //    reused by World.clear() (see core/World.js), and without this
    //    a stale context from a destroyed entity would get handed back
    //    to the new scene's scripts (see ScriptAPI.clearContexts()'s
    //    own doc comment for the full reasoning).
    scriptApi.clearContexts();
  }

  function _queueSceneChange(change) {
    if (_applyingSceneChange || _pendingSceneChange) return;
    _pendingSceneChange = change;
  }

  function _applyPendingSceneChange() {
    const change = _pendingSceneChange;
    if (!change) return;
    _pendingSceneChange = null;
    _applyingSceneChange = true;
    try {
      if (change.kind === "restart") {
        if (_initialSceneData) {
          _teardownForSceneChange();
          cameraRenderSystem.clear();
          deserializeScene(world, JSON.parse(JSON.stringify(_initialSceneData)));
          scriptSystem._started = false;
          _applySceneCamera();
        }
      } else {
        let found = getAllScenesData().find(function (s) {
          return s.name === change.sceneName;
        });
        if (found) {
          // SceneManager represents the active scene with data=null. Capture
          // that scene before teardown, because teardown clears the World and
          // saving afterward would overwrite the active scene with an empty
          // payload. Loading the active scene is also a valid request: like
          // Unity, it should reload the scene rather than become a no-op.
          if (!found.data) {
            saveActiveScene(world);
            // getAllScenesData() returns fresh list entries, so re-read the
            // saved active entry instead of mutating the temporary `found`
            // object whose data was null.
            found = getAllScenesData().find(function (s) {
              return s.name === change.sceneName;
            });
          }
          if (!found || !found.data) return;
          const targetSceneData = JSON.parse(JSON.stringify(found.data));
          // Restart always means "restart the scene that is currently
          // loaded", not "return to the scene Play mode originally opened".
          // Advance the immutable restart snapshot with every successful
          // scene.load() transition.
          _initialSceneData = JSON.parse(JSON.stringify(targetSceneData));
          _teardownForSceneChange();
          cameraRenderSystem.clear();
          deserializeScene(world, targetSceneData);
          scriptSystem._started = false;
          _applySceneCamera();
        } else if (typeof console !== "undefined") {
          console.log("[ScriptAPI] scene.load('" + change.sceneName + "') — no scene found with that name. Available scenes: " +
            (getAllScenesData().map(function(s){ return s.name; }).join(", ") || "(none)"));
        }
      }
    } finally {
      _applyingSceneChange = false;
    }
  }

  // Host hook (play popup) notified when a scene load/restart changes the
  // Main Camera — used to resize the canvas when the new scene's camera
  // has a different orientation/dimension than the one the window booted
  // with. null in the editor (no resize needed there).
  let _onSceneCameraChanged = null;

  // Re-applies the newly-loaded scene's Main Camera background color to
  // the renderer. RenderSystem already re-applies camera position/zoom
  // every frame (followMainCamera), but the clear color is only set once
  // at boot by the player/editor — so after a scene.load()/restart it
  // would otherwise keep showing the previous scene's background. This
  // is a no-op when there's no Main Camera yet (just-loaded empty scene).
  // Also notifies the host hook of the new resolution so the play popup
  // can resize its canvas/mount when the camera orientation/dimensions
  // changed (e.g. scene.load() into a Portrait scene from a Landscape one).
  function _applySceneCamera() {
    const camEntity = world.query(TRANSFORM, CAMERA).find(function (e) {
      const c = e.getComponent(CAMERA);
      return c && c.isMain;
    });
    if (camEntity) {
      const cam = camEntity.getComponent(CAMERA);
      RenderSystem.applyBackgroundColor(pixiApp, cam.backgroundColor);
      if (_onSceneCameraChanged) {
        const res = getCameraResolution(cam);
        _onSceneCameraChanged(res.width, res.height, cam.backgroundColor);
      }
    }
  }

  // Wire up scene management callbacks on the ScriptAPI.
  scriptApi._restartFn = function () {
    _queueSceneChange({ kind: "restart" });
  };
  scriptApi._loadSceneFn = function (sceneName) {
    _queueSceneChange({ kind: "load", sceneName: sceneName });
  };
  // scene.pause()/scene.resume()/scene.isPaused — see ScriptAPI.js and
  // GameLoop.pause()/resume(). Freezes every System (physics, scripts,
  // animation, audio, etc — anything World.update() drives) without
  // tearing down the loop itself, so resuming is instant.
  scriptApi._pauseFn = function () {
    loop.pause();
  };
  scriptApi._resumeFn = function () {
    loop.resume();
  };
  scriptApi._isPausedFn = function () {
    return loop.isPaused;
  };

  loop.onAfterUpdate = _applyPendingSceneChange;

  return {
    world,
    loop,
    scriptApi,
    /**
     * Resolves once the `save` global's default slot has finished its
     * first load from IndexedDB (see scriptApi.saveStore.load() above).
     * Optional to await — save.get()/set()/has() all work immediately
     * either way (see SaveAPI.js), this is only for a caller that
     * wants to gate something (e.g. a loading screen) on save data
     * specifically being ready before the game becomes interactive:
     *   const game = createGame({ pixiApp, gameId: "my-game" });
     *   await game.saveReady;
     */
    saveReady,
    loadScene: (url) => loadSceneFromUrl(world, url),
    loadDefault: () => loadDefaultScene(world),
    loadFromData: (sceneData) => {
      // Deep-clone immediately so mutations during play never corrupt the
      // restart snapshot — same reason _restartFn clones before passing
      // to deserializeScene (see comment there).
      _initialSceneData = JSON.parse(JSON.stringify(sceneData));
      deserializeScene(world, sceneData);
    },
    getSceneData: () => serializeScene(world),
    validate: () => validateScene(world),
    destroyRenderer: () => renderSystem.destroy(),
    destroyLighting: () => lightingSystem.destroy(),
    destroyCameraRenders: () => cameraRenderSystem.destroy(),
    destroyControllers: () => controllerSystem.destroy(),
    destroyTextInputs: () => textInputSystem.destroy(),
    destroyJoysticks: () => joystickSystem.destroy(),
    /** Register a callback fired when a scene load/restart changes the
     *  Main Camera (resolution + background). The play popup uses this
     *  to resize its canvas + aspect-fit when scene.load() switches to
     *  a scene whose camera has a different orientation/dimension. */
    onSceneCameraChanged: (fn) => { _onSceneCameraChanged = fn; },
    destroyAudio: () => audioSystem.destroy(),
    destroyAudioListeners: () => audioListenerSystem.destroy(),
    destroyTilemaps: () => tilemapSystem.destroy(),
    destroyNavWorld: () => navWorldSystem.destroy(),

    /** ScriptSystem instance — the play popup uses this to wire the
     *  onError callback so script errors are sent back to the editor. */
    scriptSystem,

    /**
     * PIXI.Graphics layer for physics.raycast(...,{debug:true}) lines —
     * see runtime/scripting/ScriptAPI.js's debugState.debugLines and
     * player/main.js / editor/viewport/play-popup.js's renderDebugLines().
     * Already parented under gameContentContainer (so it tracks the
     * camera automatically) and drawn on top of every sprite/tile —
     * hosts just need to .clear()/redraw it once per onTick.
     */
    getDebugLayer: () => debugGraphicsLayer,

    // Multi-scene project management (see scene/SceneManager.js). Sprite
    // assets are NOT scoped per-scene — AssetRegistry.js is one shared
    // catalogue for the whole project, same as loadFromData/getSceneData
    // above never touch it.
    initScenes: () => initSceneManager(world),
    getSceneList: () => getSceneList(),
    getAllScenesData: () => getAllScenesData(),
    getActiveSceneId: () => getActiveSceneId(),
    createScene: (name) => createScene(name),
    saveActiveScene: () => saveActiveScene(world),
    switchToScene: (sceneId) => switchToScene(world, sceneId),
    renameScene: (sceneId, name) => renameScene(world, sceneId, name),
    deleteScene: (sceneId) => deleteScene(world, sceneId),
    duplicateScene: (sceneId) => duplicateScene(world, sceneId),

    // Sprite/audio asset catalogue deletion — see AssetRegistry.js's
    // own doc comments for why removing a key here is safe even while
    // entities in the live scene still reference it (they just render/
    // play as "missing" from that point on, same as any other never-
    // assigned key).
    deleteSpriteAsset: (key) => deleteSpriteAsset(key),
    deleteAudioAsset: (key) => deleteAudioAsset(key),
    renameSpriteAsset: (key, name) => renameSpriteAsset(key, name),
    renameAudioAsset: (key, name) => renameAudioAsset(key, name),

    // Full asset catalogue read/write for project export+import (see
    // editor/state/ProjectIO.js). getAllFrameAssets() covers
    // animation-frame/tileset-slice sprites (kept out of
    // getAllSpriteAssets()'s Project-panel listing — see
    // AssetRegistry.js — but still part of the project and must round-
    // trip through save/load like any other asset). getAllSpriteAssets/
    // getAllAudioAssets are also available as plain module exports
    // below (existing convention), but are exposed here on `game` too
    // so ProjectIO.js can read the entire catalogue through the same
    // `game` handle it already has, without a second import.
    getAllSpriteAssets: () => getAllSpriteAssets(),
    getAllAudioAssets: () => getAllAudioAssets(),
    getAllFrameAssets: () => getAllFrameAssets(),
    clearAllAssets: () => clearAllAssets(),
    restoreProjectAssets: (data) => restoreProjectAssets(data),

    // Prefab catalogue read/write for project save/load+export/import —
    // the exact same three-method shape as the asset catalogue just
    // above (getAll.../clearAll.../restoreProject...), so ProjectStorage.js
    // and ProjectIO.js can treat "prefabs" as just one more catalogue
    // to snapshot/restore alongside sprites/audio, with no special-casing.
    getAllPrefabs: () => getAllPrefabs(),
    clearAllPrefabs: () => clearAllPrefabs(),
    restoreProjectPrefabs: (data) => restoreProjectPrefabs(data),

    /**
     * Populates SceneManager with a full set of scene payloads passed
     * from the editor (via PlayWindow.js → the play-window payload).
     * This is what makes scene.load('Name') work in the play popup —
     * without it SceneManager's _scenes list is empty and every load()
     * call fails with "no scene found", even when the name is exact.
     * @param {Array<{id:string,name:string,data:object}>} allScenes
     */
    loadAllScenes: (allScenes) => loadAllScenesData(allScenes),

    /**
     * Project import's scene-side counterpart to loadAllScenes — see
     * SceneManager.replaceAllScenesAndLoad()'s own doc comment. Used
     * exclusively by editor/state/ProjectIO.js when loading a saved
     * project: replaces every scene in the current project AND loads
     * one of them into the live World in one step.
     * @param {Array<{id:string,name:string,data:object}>} allScenes
     * @param {string} [activeSceneId]
     * @returns {boolean}
     */
    replaceAllScenesAndLoad: (allScenes, activeSceneId) => replaceAllScenesAndLoad(world, allScenes, activeSceneId),
  };
}

export {
  World,
  GameLoop,
  ScriptAPI,
  importSpriteFiles,
  getAllSpriteAssets,
  getSpriteAsset,
  importAudioFiles,
  getAllAudioAssets,
  getAudioAsset,
  getCameraResolution,
  getCameraWorldRect,
  getAllPrefabs,
};
