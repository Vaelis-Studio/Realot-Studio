/**
 * runtime/core/MemoryWatchdog.js
 *
 * Watches JS heap usage while the game runs and, once usage climbs past
 * a high threshold, triggers a SAFE reclaim pass so memory comes back
 * down instead of climbing indefinitely toward an out-of-memory tab
 * crash. This is deliberately NOT a full asset-cache wipe: textures and
 * audio clips currently in use by a live scene are left completely
 * alone (destroying those would make on-screen sprites/paths pop to
 * the magenta "missing texture" marker mid-game, trading a memory
 * problem for a visible-breakage problem). What gets reclaimed is
 * exactly the memory that's safe to drop because everything that needs
 * it can regenerate/re-resolve it on demand:
 *
 *   1. PIXI's own GPU texture garbage collector (renderer.textureGC),
 *      which already knows how to find and evict GPU-side textures no
 *      display object has touched in a while — this engine just never
 *      forced a manual run of it before.
 *   2. The generated placeholder textures this engine builds itself
 *      (missing-texture marker, "square"/"capsule" built-ins) — see
 *      AssetManager.js's resolveTexture(). These are pure procedural
 *      PIXI.Graphics -> generateTexture() output with zero dependence
 *      on any imported asset, so evicting them is free: the very next
 *      resolveTexture() call for "square"/null just regenerates one.
 *   3. Any per-entity render-cache entries (RenderSystem's internal
 *      Maps) left behind for entities that no longer exist in the
 *      World — normally cleaned up every frame already (see the
 *      "seen" Set sweep in RenderSystem.js), but this is a second,
 *      explicit sweep as a safety net in case any future render path
 *      is ever added that forgets to participate in that sweep.
 *
 * RUNTIME-ONLY FILE.
 */

import { clearGeneratedPlaceholderTextures } from "../assets/AssetManager.js";

export class MemoryWatchdog {
  /**
   * @param {object} opts
   * @param {PIXI.Application} opts.pixiApp used to force a textureGC run
   *   and to read renderer.gl for a GPU-side sanity check.
   * @param {() => void} [opts.onReclaim] called after a reclaim pass
   *   actually runs (for logging/telemetry/HUD display) — optional.
   * @param {number} [opts.highWaterFraction=0.85] fraction of
   *   performance.memory.jsHeapSizeLimit that counts as "too high".
   *   Deliberately a FRACTION of the actual browser-reported ceiling
   *   rather than a fixed MB number: the real limit varies a lot by
   *   device/browser (mobile vs desktop, 32-bit vs 64-bit builds), so a
   *   hardcoded threshold would trigger far too early on constrained
   *   devices and never at all on generous ones.
   * @param {number} [opts.checkIntervalMs=4000] how often to actually
   *   read performance.memory and consider reclaiming. Checking every
   *   single frame would be wasted work — heap usage doesn't meaningfully
   *   change frame-to-frame, and performance.memory reads themselves are
   *   not free.
   * @param {number} [opts.reclaimCooldownMs=15000] minimum time between
   *   two reclaim passes, even if usage is still high right after one —
   *   PIXI's textureGC and JS's own GC both need a little time to
   *   actually take effect and for performance.memory to reflect it;
   *   without a cooldown a still-high reading immediately after a
   *   reclaim would trigger another one every single check tick.
   */
  constructor(opts) {
    const o = opts || {};
    this.pixiApp = o.pixiApp || null;
    this.onReclaim = typeof o.onReclaim === "function" ? o.onReclaim : null;
    this.highWaterFraction = typeof o.highWaterFraction === "number" ? o.highWaterFraction : 0.85;
    this.checkIntervalMs = typeof o.checkIntervalMs === "number" ? o.checkIntervalMs : 4000;
    this.reclaimCooldownMs = typeof o.reclaimCooldownMs === "number" ? o.reclaimCooldownMs : 15000;

    this._msSinceLastCheck = 0;
    this._msSinceLastReclaim = Infinity; // allow an immediate reclaim on first high reading
    this._lastUsedMB = 0;
    this._lastLimitMB = 0;
    this._supported = _detectSupport();
  }

  /** Whether performance.memory is available in this browser at all —
   *  Chromium-only, non-standard. Exposed so a HUD can show "N/A"
   *  instead of silently never reclaiming with no explanation. */
  get supported() {
    return this._supported;
  }

  /** Most recently observed heap usage, in MB (0 if never checked or
   *  unsupported). */
  get lastUsedMB() {
    return this._lastUsedMB;
  }

  /** Most recently observed heap ceiling, in MB (0 if never checked or
   *  unsupported). */
  get lastLimitMB() {
    return this._lastLimitMB;
  }

  /**
   * Call once per frame from GameLoop with this frame's dt (seconds).
   * Cheap no-op on every call except the ones that land on/after
   * checkIntervalMs since the last actual check.
   */
  update(dtSeconds) {
    if (!this._supported) return;

    const dtMs = Math.max(0, dtSeconds) * 1000;
    this._msSinceLastCheck += dtMs;
    this._msSinceLastReclaim += dtMs;

    if (this._msSinceLastCheck < this.checkIntervalMs) return;
    this._msSinceLastCheck = 0;

    const mem = performance.memory;
    if (!mem || typeof mem.usedJSHeapSize !== "number" || typeof mem.jsHeapSizeLimit !== "number" || mem.jsHeapSizeLimit <= 0) {
      return;
    }

    this._lastUsedMB = mem.usedJSHeapSize / (1024 * 1024);
    this._lastLimitMB = mem.jsHeapSizeLimit / (1024 * 1024);

    const usageFraction = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
    if (usageFraction < this.highWaterFraction) return;
    if (this._msSinceLastReclaim < this.reclaimCooldownMs) return;

    this._reclaim(usageFraction);
  }

  /**
   * Runs the actual reclaim pass. Exposed as its own method (rather
   * than folded entirely into update()) so a host can also trigger it
   * manually — e.g. a "Free Memory" debug button, or right before
   * loading a big new scene where a caller wants headroom guaranteed
   * rather than waiting for the next automatic check.
   * @param {number} [usageFraction] only used for the console log's
   *   message; safe to omit when calling manually.
   */
  _reclaim(usageFraction) {
    console.warn(
      "[MemoryWatchdog] Heap usage high" +
      (typeof usageFraction === "number" ? ` (${Math.round(usageFraction * 100)}% of limit)` : "") +
      " — running a reclaim pass (GPU texture GC + placeholder cache eviction)."
    );

    // 1) Force PIXI's own texture garbage collector to run NOW instead
    // of waiting for its own internal idle-time heuristic. This evicts
    // GPU-side texture uploads for any BaseTexture PIXI hasn't seen
    // touched in a while — safe by construction: PIXI re-uploads from
    // the still-alive CPU-side image data the instant something
    // references that texture again, so nothing currently on screen is
    // actually affected, only genuinely idle GPU memory is freed.
    try {
      if (this.pixiApp && this.pixiApp.renderer && this.pixiApp.renderer.textureGC) {
        this.pixiApp.renderer.textureGC.run();
      }
    } catch (err) {
      console.error("[MemoryWatchdog] textureGC.run() failed (non-fatal):", err);
    }

    // 2) Drop this engine's own generated placeholder textures
    // (missing-texture marker, "square"/"capsule" built-ins). These
    // regenerate for free the next time anything asks for them — see
    // AssetManager.js's resolveTexture() — so evicting them cannot
    // break anything currently rendering; at worst one entity re-runs
    // a cheap PIXI.Graphics -> generateTexture() call on its very next
    // render tick.
    try {
      clearGeneratedPlaceholderTextures();
    } catch (err) {
      console.error("[MemoryWatchdog] clearGeneratedPlaceholderTextures() failed (non-fatal):", err);
    }

    this._msSinceLastReclaim = 0;
    if (this.onReclaim) {
      try { this.onReclaim(); } catch (err) { /* host callback's own problem */ }
    }
  }
}

function _detectSupport() {
  try {
    return typeof performance !== "undefined" &&
      !!performance.memory &&
      typeof performance.memory.usedJSHeapSize === "number" &&
      typeof performance.memory.jsHeapSizeLimit === "number";
  } catch (err) {
    return false;
  }
}
