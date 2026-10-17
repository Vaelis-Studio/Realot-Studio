/**
 * runtime/core/GameLoop.js
 *
 * Drives World.update() every frame via requestAnimationFrame. This is
 * what makes the game "standalone" — play.html only needs a World and a
 * GameLoop, nothing from /editor.
 *
 * RUNTIME-ONLY FILE.
 */

import { MemoryWatchdog } from "./MemoryWatchdog.js";

// Largest slice of GAME time one rendered frame may simulate. Without a cap,
// time.scale = 100 on a slow frame would ask physics/scripts for many seconds
// at once. At 60 FPS this still allows ~30x.
const MAX_SCALED_FRAME_SECONDS = 0.5;

export class GameLoop {
  /**
   * @param {import('./World.js').World} world
   * @param {object} [opts]
   * @param {() => void} [opts.onTick] called after world.update each frame
   * @param {() => void} [opts.onAfterUpdate] called after world.update and
   *   before the host's onTick callback; scene transitions use this point
   *   so they never mutate the physics world during a Rapier step.
   * @param {import('../systems/ScriptSystem.js').ScriptSystem} [opts.scriptSystem]
   *   kept running (with dt=0) even while paused — see the pause() note below.
   * @param {number} [opts.targetFps] caps the game's own simulation rate —
   *   30, 60, 120, or 0/omitted for unlimited. See setTargetFps() below for
   *   the full rationale (Game Window Performance & FPS Priority spec).
   * @param {PIXI.Application} [opts.pixiApp] enables the automatic memory
   *   watchdog (see MemoryWatchdog.js) — without it, high heap usage is
   *   never checked or reclaimed. Optional so a headless/test World
   *   (no PIXI app at all) can still construct a GameLoop.
   */
  constructor(world, opts) {
    this.world = world;
    this.onTick = (opts && opts.onTick) || null;
    this.scriptSystem = (opts && opts.scriptSystem) || null;

    this._running = false;
    this._lastTime = 0;
    this._rafHandle = null;
    this._tickFn = this._tick.bind(this);
    this.onAfterUpdate = (opts && opts.onAfterUpdate) || null;

    // Automatic memory reclaim: as the game runs (repeated scene loads,
    // spawned/destroyed entities, imported textures, etc.) JS heap usage
    // can climb over a long session. Rather than letting it climb
    // unchecked toward a browser out-of-memory tab crash, this watchdog
    // periodically checks usage against the browser's OWN reported
    // ceiling and, once usage gets high, runs a reclaim pass so memory
    // comes back down — see MemoryWatchdog.js for exactly what it does
    // and doesn't touch (nothing currently on screen is ever affected).
    // pixiApp is optional: with no PIXI app (e.g. a headless/test World)
    // the watchdog simply has nothing to do and update() no-ops.
    this.memoryWatchdog = new MemoryWatchdog({ pixiApp: (opts && opts.pixiApp) || null });

    // Game Window Performance & FPS Priority: the game's own FPS
    // target — completely independent from (and never limited by) the
    // editor's. Kept as milliseconds-between-frames (_minFrameMs)
    // rather than storing the raw FPS number, since that's what _tick
    // actually compares elapsed time against every rAF callback.
    // Deliberately still scheduled via requestAnimationFrame rather
    // than switching to setTimeout/setInterval for lower targets: rAF
    // is what keeps the game glitch-free and un-throttled by the
    // browser's background-tab timer clamping, and skipping ticks
    // below the target (see _tick) achieves the cap just as precisely
    // without giving that up. A target above the display's actual
    // refresh rate (e.g. 120 on a 60Hz monitor) is naturally capped by
    // rAF itself, same as every rAF-based game loop in a browser — the
    // engine cannot render faster than the display refreshes.
    this._minFrameMs = 0; // 0 = unlimited (every rAF tick runs)
    this.setTargetFps((opts && opts.targetFps) || 0);


    // Gameplay pause (see scene.pause()/scene.resume() in ScriptAPI.js,
    // wired through here by createGame() in runtime/index.js). Distinct
    // from start()/stop(): stop() fully tears down the rAF loop (used
    // when leaving Play mode entirely), while pause() keeps the loop
    // alive — rAF keeps firing, _lastTime keeps advancing, so resuming
    // is instant with no dt spike.
    //
    // While paused, world.update() itself is skipped (so physics,
    // animation, audio, etc all freeze — same as Unity's Time.timeScale
    // = 0), but ScriptSystem is ticked separately with dt=0. This
    // matters because scene.resume() is only ever reachable FROM a
    // script's onUpdate()/input check; if scripts stopped running
    // entirely during pause (as world.update() skipping used to imply),
    // scene.resume() could never be called again once scene.pause() ran
    // — the exact reason Unity keeps MonoBehaviour.Update() alive under
    // Time.timeScale = 0 instead of freezing the whole engine. dt=0
    // keeps time.deltaTime/onFixedUpdate/physics motion frozen for that
    // tick while onUpdate/onClick/input polling keep working normally.
    this._paused = false;
  }

  /**
   * Sets (or changes, live, mid-game) the game's FPS cap.
   * @param {number} fps 30, 60, 120, or 0/falsy for unlimited.
   */
  setTargetFps(fps) {
    this._minFrameMs = fps > 0 ? 1000 / fps : 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    this._rafHandle = requestAnimationFrame(this._tickFn);
  }

  stop() {
    this._running = false;
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
  }

  /** Freeze gameplay (World.update stops running) without stopping the
   *  rAF loop itself. Safe to call repeatedly / while already paused. */
  pause() {
    this._paused = true;
  }

  /** Resume gameplay after pause(). Resets _lastTime to now so the very
   *  next tick's dt is small (time spent paused is never counted as a
   *  single huge dt jump). Safe to call repeatedly / while not paused. */
  resume() {
    if (this._paused) this._lastTime = performance.now();
    this._paused = false;
  }

  /**
   * Current game speed multiplier (scripts set it via time.scale). 1 when no
   * script system is attached.
   * @returns {number}
   */
  _readTimeScale() {
    const api = this.scriptSystem && this.scriptSystem.scriptApi;
    const v = api && api.time ? api.time.scale : 1;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 1;
  }

  get isRunning() {
    return this._running;
  }

  get isPaused() {
    return this._paused;
  }

  _tick(now) {
    if (!this._running) return;

    // FPS cap: skip this tick's actual work (and don't advance
    // _lastTime) if not enough time has passed since the last one that
    // DID run. Still re-schedules via rAF below regardless — the loop
    // itself always wakes up every display refresh so it can react
    // instantly to a live setTargetFps() change or focus transition,
    // it just no-ops on ticks that arrive too soon. This is the same
    // "skip the frame, don't switch scheduler" approach
    // SceneViewport.js's PIXI ticker.maxFPS uses on the editor side —
    // see FocusScheduler.js's file-level comment for why rAF is kept
    // as the scheduler either way.
    if (this._minFrameMs > 0 && now - this._lastTime < this._minFrameMs) {
      this._rafHandle = requestAnimationFrame(this._tickFn);
      return;
    }

    // rawDt = real seconds since the last frame (clamped to avoid huge jumps
    // after tab-out). dt = GAME seconds: rawDt multiplied by time.scale.
    const rawDt = Math.min(0.1, (now - this._lastTime) / 1000);
    const timeScale = this._readTimeScale();
    const dt = Math.min(rawDt * timeScale, MAX_SCALED_FRAME_SECONDS);
    this._lastTime = now;
    // Systems that need to know (PhysicsWorld widens its catch-up limits when
    // the game runs faster than real time) read it from the world.
    this.world.timeScale = timeScale;
    if (this.scriptSystem && typeof this.scriptSystem.setUnscaledDelta === "function") {
      this.scriptSystem.setUnscaledDelta(rawDt);
    }

    // Runs regardless of pause state — heap usage doesn't stop growing
    // just because gameplay is paused (a paused menu can still be
    // sitting on a large heap from whatever ran before), and the
    // reclaim pass itself never touches gameplay state, so there's no
    // reason to gate it on _paused.
    this.memoryWatchdog.update(rawDt); // real time: heap growth has nothing to do with game speed

    if (!this._paused) {
      // world.update() runs every system (physics, scripts, rendering,
      // audio, ...) for this frame. Wrapped in try/catch as a last line
      // of defense: ANY uncaught exception in here — not just the
      // destroyed-texture case AssetManager.resolveTexture() now guards
      // against directly, but literally any other bug in a system or a
      // user script's onUpdate() — would otherwise propagate out of
      // _tick, which is the requestAnimationFrame callback itself. Since
      // the reschedule call (this._rafHandle = requestAnimationFrame(...)
      // below) never runs once an exception has unwound past this point,
      // the ENTIRE game freezes silently: no more frames, no more input
      // handling, nothing — with no error visible anywhere except the
      // browser console. Catching here means one bad frame logs an error
      // and the game keeps running (possibly with that one frame's
      // update skipped/partial) instead of the whole engine dying.
      try {
        this.world.update(dt);
      } catch (err) {
        console.error("[GameLoop] world.update() threw — frame skipped, engine kept running:", err);
      }
      if (this.onAfterUpdate) this.onAfterUpdate();
      if (this.onTick) this.onTick(rawDt); // hosts track real frame time (FPS counters etc.)
    } else if (this.scriptSystem) {
      // Keep scripts (and only scripts) ticking with dt=0 so onUpdate/
      // onClick/input-driven logic — including whatever calls
      // scene.resume() — still runs. dt=0 means time.deltaTime is 0 and
      // the onFixedUpdate accumulator never advances, so no gameplay
      // motion actually happens; see the constructor note above.
      this.scriptSystem.update(this.world, 0);
    }

    this._rafHandle = requestAnimationFrame(this._tickFn);
  }
}
