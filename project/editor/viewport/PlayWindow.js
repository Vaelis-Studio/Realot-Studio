/**
 * editor/viewport/PlayWindow.js
 *
 * "Play" opens a real, independent runtime instance in a separate
 * browser popup window (editor/viewport/play-popup.html +
 * play-popup.js), sized to the Main Camera's exact export resolution
 * via runtime/core/CameraUtils.js — the SAME function the editor's
 * CameraGizmo.js uses to draw the camera frame, so the gizmo's edges in
 * the Scene view are exactly what play mode (and a real export) shows.
 *
 * The popup boots its own PIXI Application + World + createGame() from
 * runtime/index.js and loads the CURRENT in-editor scene (read straight
 * off the live game instance via getSceneData(), which is backed by
 * runtime/scene/SceneSerializer.js — no duplicate serialization logic
 * here, per RULES.txt section 6). No editor grid, no gizmos — exactly
 * the game, as it will play/export.
 */

import { CAMERA } from "../../runtime/components/Camera.js";
import { TRANSFORM } from "../../runtime/components/Transform.js";
import { getCameraResolution } from "../../runtime/core/CameraUtils.js";
import { getAllSpriteAssets, getAllFrameAssets, getAllAudioAssets } from "../../runtime/assets/AssetRegistry.js";
import { syncScriptSourcesInSceneData, syncScriptSourcesInScenes } from "../scripting/ScriptSync.js";
import { editorState, pushLog } from "../state/EditorState.js";
import { getAllScenesData } from "../../runtime/scene/SceneManager.js";
import { notifyPlayWindowChanged } from "../state/FocusScheduler.js";
import { getEngineSettings } from "../state/EngineSettings.js";
import { getNavAreaNames } from "../state/NavAreas.js";

let playWin = null;
let pendingPayload = null;
let playOrigin = window.location.origin;

/**
 * Which origin the play window should run on.
 *
 * Game scripts are ordinary page code, so the safest place to run them is an
 * origin that holds none of the editor's data. Deploy the SAME static folder
 * on a second hostname and put it in <meta name="realot-play-origin"> in
 * editor/index.html. Empty (the default) = same-origin play, as before.
 * Offline there is no way to reach another host, so fall back to same-origin.
 */
function resolvePlayOrigin() {
  const meta = document.querySelector('meta[name="realot-play-origin"]');
  const raw = meta && meta.content ? meta.content.trim() : "";
  if (!raw) return window.location.origin;
  let url;
  try { url = new URL(raw); } catch (_) {
    pushLog("warn", "Ignoring invalid play origin '" + raw + "' (using same-origin play).");
    return window.location.origin;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    pushLog("warn", "Ignoring play origin '" + raw + "': must be http(s). Using same-origin play.");
    return window.location.origin;
  }
  if (navigator.onLine === false) {
    pushLog("warn", "Offline: using same-origin play instead of " + url.origin + ".");
    return window.location.origin;
  }
  return url.origin;
}

function buildPlayUrl() {
  const local = new URL("./viewport/play-popup.html", window.location.href);
  const target = playOrigin === window.location.origin ? local : new URL(local.pathname, playOrigin);
  // Tells the popup which origin it may talk to (and accept payloads from).
  target.searchParams.set("editor", window.location.origin);
  return target.toString();
}

/**
 * True only for a message that came from THIS play window, on the origin we
 * opened it on. Everything the popup sends is untrusted data (it is produced
 * by game scripts); this just stops other windows from injecting messages.
 * @param {MessageEvent} e
 */
export function isTrustedPlayMessage(e) {
  return !!(playWin && !playWin.closed && e.source === playWin && e.origin === playOrigin);
}

/** Answers the popup's "ready" message with the scene payload. */
export function sendPlayPayload() {
  if (!isPlayWindowOpen() || !pendingPayload) return;
  try {
    playWin.postMessage({ type: "realot_play_payload", payload: pendingPayload }, playOrigin);
  } catch (err) {
    pushLog("error", "Could not send the scene to the play window: " + (err && err.message ? err.message : err));
  }
}

export function isPlayWindowOpen() {
  return !!(playWin && !playWin.closed);
}

/**
 * Raw popup window reference, for FocusScheduler.js's focus polling.
 * A thin getter rather than exporting `playWin` directly so callers
 * always see the current value (a plain re-exported binding would work
 * too under ES modules' live-binding semantics, but a function makes
 * that intent explicit and matches the () => Window|null shape
 * initFocusScheduler() expects).
 * @returns {Window|null}
 */
export function getPlayWindow() {
  return playWin;
}

/**
 * Pauses/resumes the popup's live game loop. Safe to call whether or not the
 * popup is open — a no-op if it's closed. Sent as a message because the
 * popup may live on a different origin (see resolvePlayOrigin); a popup that
 * hasn't finished booting yet applies the last pause state once it has.
 * @param {boolean} paused
 */
export function setPlayWindowPaused(paused) {
  if (!isPlayWindowOpen()) return;
  try { playWin.postMessage({ type: "realot_play_pause", paused: !!paused }, playOrigin); } catch (_) { /* popup mid-navigation */ }
}

export function closePlayWindow() {
  if (playWin && !playWin.closed) playWin.close();
  playWin = null;
  notifyPlayWindowChanged();
}

/**
 * Opens (or refocuses) the play popup, sized exactly to the scene's
 * Main Camera resolution, and boots an independent runtime game inside
 * it running the current scene data.
 *
 * @param {ReturnType<import('../../runtime/index.js').createGame>} game
 *   the editor's live game instance (used only to read scene data via
 *   its public getSceneData() — never mutated).
 */
export function openPlayWindow(game) {
  const world = editorState.world;
  if (!world || !game) return;

  const mainCameraEntity = world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
  if (!mainCameraEntity) {
    pushLog("error", "Cannot enter Play mode: scene has no Main Camera.");
    return;
  }
  const camera = mainCameraEntity.getComponent(CAMERA);
  const { width, height } = getCameraResolution(camera);
  // Save the active scene first so its data slot in SceneManager is
  // current, then capture ALL scenes (with data) — the play popup needs
  // the full list so scene.load('Name') can find scenes by name.
  game.saveActiveScene();
  const sceneData = game.getSceneData();
  const allScenes = getAllScenesData(); // [{id,name,data}] — full payloads
  // Play must run exactly the code the script editor shows. Scripts live in
  // ScriptStorage; every scene carries a COPY that can be stale (edited while
  // another scene was active, imported from an older save...). Re-stamp them.
  syncScriptSourcesInSceneData(sceneData);
  syncScriptSourcesInScenes(allScenes);

  // The popup boots a completely separate JS module realm (its own
  // <script type="module"> import graph), so AssetManager.js's texture
  // cache there starts EMPTY — it never sees the textures the editor
  // registered. sceneData only carries spriteKey strings, not pixels,
  // so without this the popup falls back to the pink "missing texture"
  // marker for every imported sprite. Bundling the imported assets'
  // dataUrls here lets the popup rebuild real textures from the same
  // source bytes before it loads the scene.
  const spriteAssets = [...getAllSpriteAssets(), ...getAllFrameAssets()];

  // Same reasoning as spriteAssets above: the popup's AssetManager.js
  // module realm starts with an empty audio cache, so any imported
  // audio clip must be handed over as raw dataUrls here too, or every
  // AudioSource in the popup would silently resolve to nothing and
  // never play.
  const audioAssets = getAllAudioAssets();

  // The payload is handed over by postMessage when the popup says it is
  // ready (see sendPlayPayload) — NOT through a window global — so it works
  // across origins. gameFps travels the same way — see EngineSettings.js;
  // play-popup.js applies it to GameLoop's targetFps so the game's own frame
  // rate is never coupled to whatever the editor happens to be doing.
  // navAreaNames is the Edit → Nav Areas… name registry (see
  // editor/state/NavAreas.js) — passed through so nav.areaIndex()/
  // nav.areaMask() resolve the same names in Play mode that the editor shows.
  pendingPayload = { sceneData, allScenes, width, height, spriteAssets, audioAssets, gameFps: getEngineSettings().gameFps, navAreaNames: getNavAreaNames() };
  playOrigin = resolvePlayOrigin();

  if (isPlayWindowOpen()) {
    // Assigning location works across origins; location.reload() does not.
    playWin.location.href = buildPlayUrl();
    playWin.focus();
    // See the window.open() branch below for why a single synchronous
    // focus() call is unreliable on ChromeOS — same reasoning applies
    // to a reload of an already-open popup, so re-assert focus a beat
    // later too.
    setTimeout(() => { if (playWin && !playWin.closed) playWin.focus(); }, 150);
    notifyPlayWindowChanged();
    return;
  }

  const availW = Math.max(320, (window.screen.availWidth || 1280) - 80);
  const availH = Math.max(320, (window.screen.availHeight || 800) - 120);
  const fitScale = Math.min(1, availW / width, availH / height);
  const winW = Math.round(width * fitScale);
  const winH = Math.round(height * fitScale);

  const features =
    "width=" + winW + ",height=" + winH + ",resizable=yes,scrollbars=no,status=no,toolbar=no,menubar=no,location=no";

  playWin = window.open(buildPlayUrl(), "realot_play", features);
  if (!playWin) {
    pushLog("error", "Play window was blocked by the browser's popup blocker. Allow popups for this site and press Play again.");
    notifyPlayWindowChanged();
    return;
  }
  notifyPlayWindowChanged();
  // window.open() does NOT reliably hand keyboard focus to the new
  // window on every platform — on ChromeOS in particular the popup can
  // open fully rendered and running, but with focus silently left on
  // the editor window. Since ScriptAPI's keydown/keyup listeners are
  // attached to the popup's own `window`, an unfocused popup means
  // every key press is delivered to the editor instead, and scripts
  // see nothing — input.keyDown()/keyPressed() never go true even
  // though nothing is actually broken. Explicitly focus it here so
  // the very first Play press works, not just the reload path below.
  //
  // A single call right after window.open() can still lose the race on
  // ChromeOS: the OS sometimes finishes creating/painting the window
  // AFTER this synchronous call has already run, silently re-stealing
  // focus back to the editor once painting completes. play-popup.js's
  // own window.focus() call in its boot() (see BUG FIX comment there)
  // covers the case where its document finishes loading — but a
  // window can visibly render before its <script type="module"> has
  // finished importing and started executing (module fetch + top-level
  // work isn't instant), leaving a gap where neither the opener's
  // focus() nor the popup's own has landed yet. Re-asserting focus a
  // couple more times over the next second closes that gap without
  // waiting on any load event.
  playWin.focus();
  [150, 400, 800].forEach((delay) => {
    setTimeout(() => { if (playWin && !playWin.closed) playWin.focus(); }, delay);
  });

  pushLog("log", "Entered Play mode (" + camera.aspectMode + ", " + width + "x" + height + ").");
}
