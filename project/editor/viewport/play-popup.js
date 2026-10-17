/**
 * editor/viewport/play-popup.js
 *
 * Boots inside the play-mode popup window (play-popup.html). This is
 * editor tooling, NOT part of /player — but it imports ONLY from
 * /runtime for the actual game (same rule as /player: what you see here
 * must be identical to a real exported build, no editor-only rendering
 * path). Reads the scene JSON + target resolution handed to it by
 * PlayWindow.js by postMessage (ready -> payload handshake), then:
 *   1. Creates a PIXI Application sized to the REAL popup window (not
 *      the camera's reference resolution) — runtime/core/CameraUtils.js's
 *      computeScreenFit() is the single source of truth for fitting the
 *      Main Camera's reference resolution into that real window size,
 *      the same function the editor's CameraGizmo uses to preview it.
 *   2. Loads the current in-editor scene data into a brand new World.
 *   3. Starts the GameLoop. No grid, no gizmos — game time.
 * Resizing: the popup window is fully resizable (see PlayWindow.js's
 * window.open features string), and on every resize the PIXI renderer
 * itself is resized to match the real window size, same pattern as
 * player/main.js. That feeds computeScreenFit() (via
 * RenderSystem._applyMainCameraOffset, since this popup boots with
 * followMainCamera:true) real, live device dimensions to react to, so
 * scalingMode/letterboxing/etc. actually do their job as you resize
 * the window, exactly as they will in a real export. There is
 * deliberately NO separate CSS-transform scaler here, since that would
 * be a second, competing "fit" happening on top of the engine's own,
 * and would make every scalingMode look like Fit regardless of what
 * it's actually set to.
 */

import { createGame } from "../../runtime/index.js";
import { registerTexture, registerAudio } from "../../runtime/assets/AssetManager.js";
import { RenderSystem } from "../../runtime/systems/RenderSystem.js";
import { CAMERA } from "../../runtime/components/Camera.js";
import { TRANSFORM } from "../../runtime/components/Transform.js";

/**
 * The editor window's origin, given by PlayWindow.js as ?editor=<origin>.
 * Messages are only ever sent to it, and only accepted from it, so this page
 * works the same whether it runs on the editor's origin or (recommended) on a
 * separate play origin that holds none of the editor's data.
 */
const EDITOR_ORIGIN = (function () {
  try {
    const v = new URLSearchParams(window.location.search).get("editor");
    if (v) {
      const u = new URL(v);
      if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    }
  } catch (_) { /* fall through */ }
  return window.location.origin;
})();

function postToEditor(msg) {
  try {
    if (window.opener && !window.opener.closed) window.opener.postMessage(msg, EDITOR_ORIGIN);
  } catch (_) { /* editor navigated away or closed */ }
}

function fromEditor(e) {
  return e.source === window.opener && e.origin === EDITOR_ORIGIN && e.data && typeof e.data === "object";
}

let _game = null;          // set once the game is running
let _pendingPaused = null; // pause state requested before the game finished booting

window.addEventListener("message", function (e) {
  if (!fromEditor(e) || e.data.type !== "realot_play_pause") return;
  _pendingPaused = !!e.data.paused;
  if (_game && _game.loop) {
    if (_pendingPaused) _game.loop.pause(); else _game.loop.resume();
  }
});

// Tell the editor when this window gains/loses focus; a cross-origin editor
// can't read document.hasFocus() on us (it throttles itself while we're focused).
window.addEventListener("focus", function () { postToEditor({ type: "realot_play_focus", focused: true }); });
window.addEventListener("blur", function () { postToEditor({ type: "realot_play_focus", focused: false }); });

/** Asks the editor for the scene payload and waits for it (10 s). */
function requestPayload() {
  return new Promise(function (resolve) {
    const timer = setTimeout(function () { window.removeEventListener("message", onMsg); resolve(null); }, 10000);
    function onMsg(e) {
      if (!fromEditor(e) || e.data.type !== "realot_play_payload") return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(e.data.payload || null);
    }
    window.addEventListener("message", onMsg);
    postToEditor({ type: "realot_play_ready" });
  });
}

/**
 * Rebuilds this popup's own AssetManager texture cache from the
 * dataUrls handed over in the payload. Required because this popup is
 * a separate module realm from the editor: its import of
 * AssetManager.js gets a brand new, empty _textureCache, so any sprite
 * imported in the editor is otherwise unknown here and falls back to
 * the pink missing-texture marker.
 * @param {Array<{key:string,dataUrl:string}>} spriteAssets
 */
function loadSpriteAssets(spriteAssets) {
  const loads = (spriteAssets || []).map(
    ({ key, dataUrl }) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const baseTexture = PIXI.BaseTexture.from(img);
            registerTexture(key, new PIXI.Texture(baseTexture));
          } catch (err) {
            console.error("[play] Failed to register texture for", key, err);
          }
          resolve();
        };
        img.onerror = () => {
          console.error("[play] Failed to decode image asset for", key);
          resolve();
        };
        img.src = dataUrl;
      })
  );
  return Promise.all(loads);
}

/**
 * Same reasoning as loadSpriteAssets() above, for audio: this popup's
 * import of AssetManager.js gets a brand new, empty _audioCache, so
 * any imported audio clip is otherwise unknown here and every
 * AudioSource would silently resolve to nothing and never play.
 * @param {Array<{key:string,dataUrl:string}>} audioAssets
 */
function loadAudioAssets(audioAssets) {
  for (const { key, dataUrl } of audioAssets || []) {
    registerAudio(key, dataUrl);
  }
}

/**
 * Wraps this popup's console.log/warn/error so every call is ALSO
 * posted to the editor window as a "realot_console_log" message —
 * this is what makes a script's plain console.log("...") calls (not
 * just thrown errors) show up in the editor's Console panel while
 * Play mode is running in this separate popup window/document.
 */
function _wireConsoleForwarding() {
  function forwardLog(level, args) {
    if (!(window.opener && !window.opener.closed)) return;
    const text = args
      .map(function (a) {
        if (a instanceof Error) return a.message;
        if (typeof a === "object" && a !== null) {
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }
        return String(a);
      })
      .join(" ");
    postToEditor({
      type: "realot_console_log",
      level: level,
      message: text,
    });
  }

  const realLog = console.log.bind(console);
  const realWarn = console.warn.bind(console);
  const realError = console.error.bind(console);

  console.log = function (...args) {
    realLog(...args);
    forwardLog("log", args);
  };
  console.warn = function (...args) {
    realWarn(...args);
    forwardLog("warn", args);
  };
  console.error = function (...args) {
    realError(...args);
    forwardLog("error", args);
  };
}

/**
 * Creates the (initially hidden) debug HUD overlay element — a small
 * fixed-position monospace panel in the top-left corner of the game
 * window. Appended directly to document.body (a sibling of
 * #game-canvas), positioned with fixed/absolute CSS, so it always sits
 * on top of the PIXI canvas at a crisp, readable 1:1 text size — it is
 * NOT affected by the game's own in-canvas scalingMode/letterboxing,
 * since that only scales content drawn inside the PIXI canvas itself.
 */
function createDebugOverlay() {
  const el = document.createElement("div");
  el.id = "realot-debug-hud";
  el.style.cssText =
    "position:absolute; top:8px; left:8px; z-index:9999; " +
    "font:12px/1.5 'Consolas','Menlo',monospace; color:#0f0; " +
    "background:rgba(0,0,0,0.6); padding:6px 10px; border-radius:4px; " +
    "white-space:pre; pointer-events:none; display:none;";
  document.body.appendChild(el);
  return el;
}

/**
 * Tracks a rolling FPS estimate from raw frame delta-times. Uses a
 * short rolling window (averaged over ~0.5s) rather than the
 * instantaneous 1/dt so the HUD number doesn't flicker wildly frame to
 * frame — a single slow frame (e.g. a GC pause) shouldn't make the
 * counter jump from 60 to 12 and back on consecutive frames.
 */
function createFpsTracker() {
  let acc = 0;
  let frames = 0;
  let lastFps = 0;
  return function tick(dt) {
    acc += dt;
    frames++;
    if (acc >= 0.5) {
      lastFps = Math.round(frames / acc);
      acc = 0;
      frames = 0;
    }
    return lastFps;
  };
}

/**
 * Renders scriptApi.debugState into the HUD element. Called every
 * frame from game.loop's onTick (wired in boot() below) — cheap no-op
 * when debugState.enabled is false, so it costs nothing for games that
 * never call debug.show().
 */
function updateDebugOverlay(el, scriptApi, fps, world) {
  const state = scriptApi.debugState;
  if (!state || !state.enabled) {
    if (el.style.display !== "none") el.style.display = "none";
    return;
  }
  el.style.display = "block";
  const lines = [];
  if (state.showFps) lines.push("FPS: " + fps);
  for (const [label, value] of state.stats) {
    lines.push(label + ": " + value);
  }
  // Per-system frame breakdown — see player/main.js's identical block
  // for the full explanation (kept as a duplicate here for the same
  // /editor-vs-/runtime import-boundary reason as this whole function).
  // Reads the ~30-frame ROLLING AVERAGE, not raw per-frame numbers —
  // see World.js's avgFrameSystemTimes doc comment for why: a live
  // HUD redrawing every frame makes single-frame timings impossible
  // to actually read.
  if (world && world.avgFrameSystemTimes && world.avgFrameSystemTimes.length) {
    lines.push("");
    lines.push("SYSTEM TIMES (ms, avg/30 frames):");
    let total = 0;
    for (const t of world.avgFrameSystemTimes) {
      total += t.ms;
      lines.push("  " + t.name + ": " + t.ms.toFixed(2));
    }
    lines.push("  TOTAL: " + total.toFixed(2));
  }
  el.textContent = lines.join("\n") || "(debug on — no stats yet)";
}

/**
 * Draws every debug ray a script cast this frame via
 * physics.raycast(x1,y1,x2,y2,{debug:true}) — see ScriptAPI._raycast()
 * and player/main.js's identical renderDebugLines() (kept as a small
 * duplicate here rather than a shared import, same reasoning as
 * updateDebugOverlay above: this file lives under /editor and must not
 * become something player/main.js — which imports ONLY from /runtime —
 * ends up depending on).
 *
 * `graphics` is parented under gameContentContainer (via
 * game.getDebugLayer()), so it inherits the live camera transform
 * automatically — a line drawn in world coordinates lines up with the
 * colliders it's testing with zero manual transform math here.
 */
function renderDebugLines(graphics, scriptApi) {
  const state = scriptApi.debugState;
  graphics.clear();
  if (!state || !state.debugLines || state.debugLines.length === 0) return;

  for (const line of state.debugLines) {
    // Laser-beam style: line runs from origin to hit point (endX/endY),
    // so it visually cuts off at the surface instead of passing through it.
    // No separate dot — the tip of the beam is the hit indicator.
    graphics.lineStyle(2, line.color, 1);
    graphics.moveTo(line.x1, line.y1);
    graphics.lineTo(line.endX, line.endY);
  }
  state.debugLines.length = 0;
}

async function boot() {
  // Forward this popup's own console.log/warn/error to the editor's
  // Console panel FIRST, before anything else in boot() has a chance
  // to log — so asset load failures, scene validation errors, and
  // script console.log() calls are ALL visible in the editor Console
  // panel, not just crashes. Wrapping console itself (rather than only
  // catching thrown errors) is what makes plain console.log() calls
  // show up too, not just errors.
  _wireConsoleForwarding();

  // Belt-and-suspenders for keyboard focus: PlayWindow.js already calls
  // playWin.focus() right after window.open(), but that can still lose
  // to the OS/browser handing focus back to the opener (observed on
  // ChromeOS) — the popup then renders and runs fine, just silently
  // never receives keydown/keyup, so every input.keyDown()/keyPressed()
  // check in a script stays false forever with no visible error.
  // Re-asserting focus here (on load) and again on the very first click
  // anywhere in the popup guarantees the window has focus by the time
  // the player actually starts pressing movement keys.
  window.focus();
  window.addEventListener("pointerdown", function () { window.focus(); });

  const payload = await requestPayload();
  if (!payload) {
    document.body.innerHTML =
      '<div style="color:#eee;font:12px monospace;padding:16px;">No scene data received from the editor. Close this window and press Play again.</div>';
    return;
  }

  const { sceneData, spriteAssets, audioAssets, gameFps, navAreaNames } = payload;

  // Register real textures BEFORE the scene loads, so sprite entities
  // resolve to the actual imported images on their very first frame
  // instead of momentarily (or permanently) showing the missing marker.
  await loadSpriteAssets(spriteAssets);
  loadAudioAssets(audioAssets);

  const mount = document.getElementById("game-canvas");

  // Boot the renderer at the REAL popup window size (not the camera's
  // reference resolution) — computeScreenFit()/_applyMainCameraOffset
  // need the actual device size to fit the reference resolution into,
  // exactly like a real device screen. Same pattern as player/main.js.
  const pixiApp = new PIXI.Application({
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: 0x000000,
    // See player/main.js's identical setting — confirmed via testing
    // that antialiasing wasn't the FPS bottleneck, restored to true
    // for smooth edges.
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  mount.appendChild(pixiApp.view);

  const game = createGame({ pixiApp, followMainCamera: true, navAreaNames });

  // Game Window Performance & FPS Priority: the game's own FPS target
  // is completely independent from the editor's — set directly on the
  // loop here rather than passed through createGame(), so this is the
  // ONLY place that decides it (the editor's own Scene Viewport, which
  // also calls createGame(), is never affected). gameFps travels via
  // the same payload PlayWindow.js already uses for scene data — see
  // EngineSettings.js for where the value comes from and
  // GameLoop.setTargetFps() for how 30/60/120/Unlimited are enforced.
  game.loop.setTargetFps(gameFps || 0);

  // Register ALL scenes so scene.load('Name') can find them by name
  // during play. Without this the popup's SceneManager starts empty and
  // every scene.load() call logs "no scene found" even when the name is
  // spelled correctly. allScenes carries {id,name,data} for every scene
  // the editor has, captured by PlayWindow.js right before opening the
  // popup (with the active scene saved first so its data is current).
  if (payload.allScenes && payload.allScenes.length) {
    game.loadAllScenes(payload.allScenes);
  }

  game.loadFromData(sceneData);

  // Applied once, right here, at the moment Play was pressed — this
  // popup never re-reads editor state after boot, so there is no "live
  // tracking" of further Camera edits while the game is running, which
  // is exactly the requested "update in game mode only when play is
  // pressed" behavior (contrast with SceneViewport.js's syncBackgroundColor(),
  // which DOES re-apply live on every edit, because that's the editor
  // preview, not a running game).
  const mainCameraEntity = game.world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
  if (mainCameraEntity) {
    RenderSystem.applyBackgroundColor(pixiApp, mainCameraEntity.getComponent(CAMERA).backgroundColor);
  }

  const validation = game.validate();
  if (!validation.ok) {
    console.error("[play] Scene validation failed:", validation.errors);
  }

  // Wire script errors back to the editor's console via postMessage,
  // so script crashes are visible in the editor without the editor
  // itself ever executing user code. Deliberately does NOT also call
  // console.error() here — that would double-report the same error,
  // since console.error is itself forwarded as a realot_console_log
  // message by _wireConsoleForwarding() above. The real console.error
  // (bound before wrapping) still gets it for anyone with devtools open.
  if (game.scriptSystem) {
    game.scriptSystem.onError(function (err) {
      if (window.opener && !window.opener.closed) {
        postToEditor({
          type: "realot_script_error",
          scriptName: err.scriptName,
          message: err.message,
          line: err.line,
          method: err.method,
          kind: err.kind,
        });
      }
    });
  }

  // Also forward any OTHER error that happens inside the play popup —
  // an uncaught exception outside a script lifecycle call (e.g. a
  // runtime/engine bug, a bad asset, a rejected Promise) or a raw
  // console.error() call a script's own code triggers indirectly.
  // ScriptSystem.onError above only covers errors THROWN from inside
  // one of the six script lifecycle methods it calls directly; this
  // catches everything else in the same popup window so the editor's
  // console is a true mirror of what actually happened in the browser,
  // not just script-lifecycle crashes.
  _wireGlobalErrorForwarding();

  function _wireGlobalErrorForwarding() {
    function forward(message, line, scriptName, method) {
      if (window.opener && !window.opener.closed) {
        postToEditor({
          type: "realot_script_error",
          scriptName: scriptName || "(engine)",
          message: message,
          line: line != null ? String(line) : "?",
          method: method || "runtime",
        });
      }
    }

    window.addEventListener("error", function (e) {
      // Errors already reported via ScriptSystem.onError (thrown inside
      // a compiled script's own lifecycle call) still bubble up here as
      // a browser-level "error" event too — but ScriptSystem already
      // catches those with try/catch, so they never actually reach
      // window here uncaught. This listener only ever fires for errors
      // OUTSIDE that try/catch (engine code, asset loading, etc).
      forward(e.message, e.lineno, "(engine)", "runtime");
    });

    window.addEventListener("unhandledrejection", function (e) {
      var reason = e.reason;
      var message = reason && reason.message ? reason.message : String(reason);
      forward(message, "?", "(engine)", "promise");
    });
  }

  // Wait for the initial save-slot load from IndexedDB to finish before
  // starting the loop — otherwise onStart() (and any save.get()/set()
  // calls a script makes right away) can run while the load is still
  // in-flight, and the load finishing afterward wholesale-replaces
  // _data, silently discarding anything a script just saved. Same
  // pattern as player/main.js.
  await game.saveReady;

  game.loop.start();
  window.__realotGame = game;
  _game = game;
  if (_pendingPaused) game.loop.pause();
  postToEditor({ type: "realot_play_focus", focused: document.hasFocus() });

  // Debug HUD (FPS + any custom debug.log() stats a script has set) —
  // created hidden, shown only once a script calls debug.show(). Polls
  // scriptApi.debugState (see runtime/scripting/ScriptAPI.js) once per
  // rendered frame via GameLoop's onTick, same hook the loop already
  // exposes for host-side per-frame work.
  const debugOverlayEl = createDebugOverlay();
  const fpsTick = createFpsTracker();
  const debugLayer = game.getDebugLayer();
  game.loop.onTick = function (dt) {
    const fps = fpsTick(dt);
    updateDebugOverlay(debugOverlayEl, game.scriptApi, fps, game.world);
    renderDebugLines(debugLayer, game.scriptApi);
  };

  // No handling needed here for scene.load()/scene.restart() switching
  // to a Main Camera with a different reference resolution (e.g.
  // Landscape → Portrait) — computeScreenFit() (called every frame by
  // RenderSystem._applyMainCameraOffset via followMainCamera:true)
  // reads the CURRENT Main Camera's own getCameraResolution() directly,
  // so it already picks up a new reference resolution on its own. The
  // popup WINDOW/renderer must NOT resize on a scene-camera change —
  // that's the real device size the reference resolution gets fit
  // INTO, exactly like a real device screen doesn't resize itself when
  // your game switches scenes. applyBackgroundColor() for the new
  // camera is already handled inside runtime/index.js itself.

  // Renderer tracks the real popup window size — this is what feeds
  // computeScreenFit() live device dimensions to fit the reference
  // resolution into, so scalingMode/letterboxing/etc. actually react as
  // the window is resized, same as a real exported build (see
  // player/main.js's identical resize listener).
  window.addEventListener("resize", () => {
    pixiApp.renderer.resize(window.innerWidth, window.innerHeight);
  });
}

boot();
