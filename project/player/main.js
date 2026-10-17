/**
 * player/main.js
 *
 * Standalone game bootstrap. Imports ONLY from /runtime — never from
 * /editor. This file + play.html is the entire "shipped game"; deleting
 * the /editor folder entirely must not break this file.
 */

import { createGame } from "../runtime/index.js";
import { getSafeRendererResolution, prepareGameCanvas } from "../runtime/core/MobileViewport.js";
import { RenderSystem } from "../runtime/systems/RenderSystem.js";
import { CAMERA } from "../runtime/components/Camera.js";
import { TRANSFORM } from "../runtime/components/Transform.js";

/**
 * Same debug HUD as the editor's play popup (see
 * editor/viewport/play-popup.js for the full explanation) — kept as a
 * separate, small copy here rather than a shared import because this
 * file must import ONLY from /runtime (see file header); the HUD
 * itself only reads runtime state (scriptApi.debugState), so
 * duplicating these ~30 lines keeps that boundary intact.
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
  // Per-system frame breakdown — populated by World.js only while
  // profiling is on (debug.show() enables it as a side effect — see
  // ScriptAPI.js's debug.show()). Reads the ROLLING AVERAGE
  // (avgFrameSystemTimes), not the raw per-frame numbers
  // (lastFrameSystemTimes) — a live HUD redrawing every frame makes
  // single-frame timings impossible to actually read (they jitter
  // faster than a human can track), so World.js recomputes this
  // average every ~30 frames instead, giving a number that holds
  // still long enough to note down. See World.js's
  // avgFrameSystemTimes doc comment for the exact windowing.
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
 * physics.raycast(x1,y1,x2,y2,{debug:true}) — see ScriptAPI._raycast().
 * `graphics` is a PIXI.Graphics parented under the SAME world-space
 * container sprites render into (gameContentContainer, via
 * game.getDebugLayer() below), so a debug line drawn in world
 * coordinates automatically pans/zooms with the camera exactly like
 * everything else in the scene — no manual camera-transform math here.
 *
 * Runs unconditionally (not gated by debugState.enabled — matches
 * Unity's Debug.DrawLine, which draws regardless of a separate on/off
 * toggle; debug.show() only controls the text HUD). Drawing is cheap
 * when debugLines is empty (a single .clear() call), so this costs
 * nothing for games that never call raycast with debug:true.
 *
 * IMPORTANT: clears debugState.debugLines itself, once, right after
 * drawing — this is intentionally NOT done by ScriptSystem's per-frame
 * cleanup (_clearFrameKeys). Scripts run inside world.update(), which
 * happens BEFORE this function's caller (game.loop.onTick) on the very
 * same frame — clearing any earlier would wipe a line before it ever
 * got drawn once.
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

/**
 * Touch Test overlay — a no-devtools-required way to confirm finger
 * input actually works, for players/developers on a device (or a
 * locked-down Chromebook) where opening devtools isn't an option.
 *
 * Tap the 🖐 button (bottom-right) to toggle it on. While on, it shows:
 *   - whether Hammer.js loaded at all (the local vendor script play.html loads)
 *   - RAW browser event counts, from a listener completely independent
 *     of the engine's own input code — proves the browser/OS is
 *     actually sending touch events to this page at all
 *   - the engine's live finger count/positions/swipe/pinch state, read
 *     through `touchRef` below — captured ONCE, exactly the way a
 *     compiled game script receives its `touch` parameter (see
 *     ScriptSystem._initEntityScripts / ScriptAPI.getGlobals). If the
 *     numbers below update as you touch the screen using this SAME
 *     one-time-captured reference, a game script reading `touch` the
 *     normal way will see the same live data — that's the point of
 *     putting this test here instead of a separate synthetic page.
 *   - a green ring drawn at each active finger's actual screen position
 *
 * Self-contained: doesn't touch any other game state, and does nothing
 * at all unless the button is tapped.
 *
 * @param {ReturnType<typeof import('../runtime/index.js').createGame>} game
 * @param {PIXI.Application} pixiApp
 */
function setupTouchTestOverlay(game, pixiApp) {
  const btn = document.getElementById("touch-test-btn");
  const panel = document.getElementById("touch-test-panel");
  if (!btn || !panel) return;

  // Captured ONCE — see the big doc comment above. Do not re-fetch this
  // every frame; the whole point is proving the reference a script
  // binds one time at compile-time stays live on its own.
  const touchRef = game.scriptApi.getGlobals().touch;

  // Raw counters, wired independently of anything the engine does, so
  // this overlay can tell "the browser never sent us a touch event" (a
  // device/OS/CSS problem) apart from "the browser sent one but the
  // engine didn't pick it up" (an engine problem). passive + no
  // preventDefault anywhere here — this must never change how the game
  // itself behaves, only observe.
  const raw = { touchstart: 0, touchmove: 0, touchend: 0, pointerdownTouch: 0 };
  window.addEventListener("touchstart", () => { raw.touchstart++; }, { passive: true });
  window.addEventListener("touchmove", () => { raw.touchmove++; }, { passive: true });
  window.addEventListener("touchend", () => { raw.touchend++; }, { passive: true });
  window.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch") raw.pointerdownTouch++; }, { passive: true });

  let active = false;
  const dotPool = []; // reused <div> elements, one per concurrently-active finger

  function setDotCount(n) {
    while (dotPool.length < n) {
      const el = document.createElement("div");
      el.className = "touch-test-dot";
      document.body.appendChild(el);
      dotPool.push(el);
    }
    while (dotPool.length > n) {
      dotPool.pop().remove();
    }
  }

  btn.addEventListener("click", () => {
    active = !active;
    btn.classList.toggle("active", active);
    panel.classList.toggle("open", active);
    if (!active) setDotCount(0);
  });

  /** Called every frame from game.loop.onTick, but only does any real
   *  work while the panel is toggled on. */
  function tick() {
    if (!active) return;

    const canvas = pixiApp.view;
    const rect = canvas.getBoundingClientRect();
    // Inverts the same screen-pixel <-> canvas-backing-buffer math
    // ScriptAPI's attachPointerInput/toCoords() uses, so a dot lands
    // exactly under the finger that produced its screenX/screenY.
    const logicalW = pixiApp.screen ? pixiApp.screen.width : (canvas.clientWidth || rect.width);
    const logicalH = pixiApp.screen ? pixiApp.screen.height : (canvas.clientHeight || rect.height);
    const sx = logicalW > 0 ? rect.width / logicalW : 1;
    const sy = logicalH > 0 ? rect.height / logicalH : 1;

    setDotCount(touchRef.length);
    for (let i = 0; i < touchRef.length; i++) {
      const t = touchRef[i];
      const el = dotPool[i];
      el.style.left = (rect.left + t.screenX * sx) + "px";
      el.style.top = (rect.top + t.screenY * sy) + "px";
      el.style.borderColor = t.justEnded ? "#f87171" : "#4ade80";
      el.textContent = String(t.id);
    }

    const hammerLoaded = typeof Hammer !== "undefined";
    const lines = [
      "<b>TOUCH TEST</b>  (tap 🖐 again to hide)",
      "Hammer.js loaded: " + (hammerLoaded ? "<span class=\"ok\">yes</span>" : "<span class=\"bad\">no — using raw-touch fallback</span>"),
      "",
      "Raw browser events seen (independent of the engine):",
      "  touchstart=" + raw.touchstart + "  touchmove=" + raw.touchmove + "  touchend=" + raw.touchend + "  pointerdown(touch)=" + raw.pointerdownTouch,
      "",
      "Engine `touch` global (exact same object a script reads):",
      "  touch.count=" + touchRef.count + "  anyJustStarted=" + touchRef.anyJustStarted + "  anyJustEnded=" + touchRef.anyJustEnded,
      "  touch.swipe: active=" + touchRef.swipe.active + " direction=" + touchRef.swipe.direction,
      "  touch.pinch: active=" + touchRef.pinch.active + " scale=" + touchRef.pinch.scale.toFixed(2),
    ];
    for (let i = 0; i < touchRef.length; i++) {
      const t = touchRef[i];
      lines.push("  finger " + t.id + ": x=" + t.x.toFixed(0) + " y=" + t.y.toFixed(0) +
        " screenX=" + t.screenX.toFixed(0) + " screenY=" + t.screenY.toFixed(0) +
        (t.justStarted ? "  [justStarted]" : "") + (t.justEnded ? "  [justEnded]" : ""));
    }
    if (touchRef.length === 0) {
      lines.push("");
      lines.push(raw.touchstart === 0
        ? "No touch reached the page yet — put a finger on the screen above."
        : "Browser sent touch events but no active finger right now — that's expected between touches.");
    }
    panel.innerHTML = lines.join("\n");
  }

  return tick;
}

async function boot() {
  const mount = document.getElementById("game-canvas");

  const initialWidth = Math.max(1, mount.clientWidth || window.innerWidth || 800);
  const initialHeight = Math.max(1, mount.clientHeight || window.innerHeight || 600);
  const pixiApp = new PIXI.Application({
    width: initialWidth,
    height: initialHeight,
    backgroundColor: 0x282828,
    // Confirmed via debug.show()'s SYSTEM TIMES + a temporary
    // antialias:false test that the frame-rate ceiling on the
    // reporting device isn't coming from antialiasing/GPU compositing
    // (turning it off made no FPS difference) — restored to true so
    // sprite/shape edges render smooth instead of jagged.
    antialias: true,
    autoDensity: true,
    resolution: getSafeRendererResolution(initialWidth, initialHeight),
  });
  mount.appendChild(pixiApp.view);
  prepareGameCanvas(pixiApp.view);

  // gameId namespaces the `save` global's IndexedDB database (see
  // runtime/index.js and runtime/scripting/SaveStore.js) so this
  // exported game's save data never collides with any other
   // Realot game the player's browser has visited. document.title
  // is the simplest stable-per-export identity available here without
  // adding a new export-time config file — exporting under a
  // different page title starts a fresh save database, which matches
  // what most players would expect from "a different game".
  const game = createGame({
    pixiApp,
    followMainCamera: true,
     gameId: document.title || "realot-game",
  });

  // Load a scene shipped alongside the game, falling back to the default
  // starter scene if none is found (e.g. running this template directly).
  try {
    await game.loadScene("./scene.json");
  } catch (err) {
    console.warn("[player] No scene.json found, loading default scene.", err);
    game.loadDefault();
  }

  // Wait for the `save` global's default slot to finish its first
  // IndexedDB read before the game actually starts running scripts —
  // so onStart() on every entity sees real saved data (high scores,
  // unlocked levels, etc.) on frame one instead of momentarily seeing
  // save.get() return undefined while the read is still in flight.
  try {
    await game.saveReady;
  } catch (err) {
    console.warn("[player] Save data failed to load; starting with an empty save.", err);
  }

  const validation = game.validate();
  if (!validation.ok) {
    console.error("[player] Scene validation failed:", validation.errors);
  }

  const mainCameraEntity = game.world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
  if (mainCameraEntity) {
    RenderSystem.applyBackgroundColor(pixiApp, mainCameraEntity.getComponent(CAMERA).backgroundColor);
  }

  function resizeGameToMount() {
    const rect = mount.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || mount.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.round(rect.height || mount.clientHeight || window.innerHeight));
    pixiApp.renderer.resize(width, height);
  }

  window.addEventListener("resize", resizeGameToMount, { passive: true });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", resizeGameToMount, { passive: true });
  resizeGameToMount();

  game.loop.start();

  // Debug HUD — see createDebugOverlay() above / play-popup.js for the
  // full explanation. Hidden until a script calls debug.show().
  const debugOverlayEl = createDebugOverlay();
  const fpsTick = createFpsTracker();
  const debugLayer = game.getDebugLayer();

  // Touch Test overlay — see setupTouchTestOverlay() above. Does nothing
  // until the 🖐 button (bottom-right, from play.html) is tapped.
  const touchTestTick = setupTouchTestOverlay(game, pixiApp);

  game.loop.onTick = function (dt) {
    const fps = fpsTick(dt);
    updateDebugOverlay(debugOverlayEl, game.scriptApi, fps, game.world);
    renderDebugLines(debugLayer, game.scriptApi);
    if (touchTestTick) touchTestTick();
  };

  // Exposed for debugging from the browser console only; not used by any
  // editor code.
  window.__realotGame = game;
}

boot();
