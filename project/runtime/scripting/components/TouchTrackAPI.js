/**
 * runtime/scripting/components/TouchTrackAPI.js
 *
 * The `this.myTouch` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). Like this.state, this needs NO component —
 * every entity gets one automatically. It locks onto ONE specific
 * finger by id and stays locked to that exact finger — ignoring every
 * other finger on screen — until it lifts. It is a general TOUCH
 * tracking tool, not tied to any one use: dragging, drawing a line,
 * steering a joystick knob, etc. are all just "read this.myTouch.x/.y
 * each frame and do something with it."
 *
 * Without this, a script has to hand-roll: (1) scan `touch` for a
 * justStarted finger over itself, (2) remember that finger's id in a
 * top-level variable, (3) each frame re-scan `touch` for that same id,
 * (4) detect when the id disappears (finger lifted) and clear the
 * variable. this.myTouch does exactly that bookkeeping so a beginner
 * script never has to write finger-id-tracking loops by hand.
 *
 * API:
 *   this.myTouch.active            — true while locked onto a finger (read-only)
 *   this.myTouch.enabled           — true unless disable() was called (read-only)
 *   this.myTouch.x / .y            — locked finger's current position, or null if not active
 *   this.myTouch.startTracking()   — locks onto the first finger that just
 *                                     touched down over THIS entity. No-op
 *                                     if already tracking a finger, if no
 *                                     finger just started on this entity
 *                                     this frame, or if disabled (see
 *                                     disable() below). Returns true if
 *                                     a finger was claimed.
 *   this.myTouch.stopTracking()    — releases the finger early (before it lifts).
 *   this.myTouch.disable()         — turns tracking OFF: releases the
 *                                     current finger (if any) immediately
 *                                     and makes startTracking() do nothing
 *                                     until enable() is called again. Use
 *                                     this to turn dragging on/off for an
 *                                     entity — e.g. only while a game is
 *                                     in a certain state.
 *   this.myTouch.enable()          — turns tracking back ON (this is the
 *                                     default state — only needed after
 *                                     a disable() call).
 *
 * Typical use — call startTracking() every onUpdate(); it only actually
 * claims a finger the one frame a tap lands on this entity, and is a
 * no-op every other frame:
 *   function onUpdate() {
 *     this.myTouch.startTracking();
 *     if (this.myTouch.active) {
 *       this.x = this.myTouch.x;
 *       this.y = this.myTouch.y;
 *     }
 *   }
 *
 * Turning tracking on/off — e.g. lock a piece in place once it's placed:
 *   function onPlaced() {
 *     this.myTouch.disable();
 *   }
 *
 * Auto-releases the moment the tracked finger lifts (it simply stops
 * appearing in `touch` the frame after justEnded) — no manual cleanup
 * needed.
 *
 * RUNTIME-ONLY FILE.
 */

const TOUCH_TRACK_MEMBERS = new Set([
  "active", "enabled", "x", "y",
  "startTracking", "stopTracking", "enable", "disable",
]);

/**
 * Builds the `this.myTouch` object for a given EntityContext.
 * @param {object} ctx  the EntityContext (`this`) this belongs to
 * @returns {object}
 */
export function createTouchTrackAPI(ctx) {
  if (!ctx._touchTrackBacking) {
    ctx._touchTrackBacking = { fingerId: null, enabled: true };
  }
  const backing = ctx._touchTrackBacking;

  function currentTouch() {
    if (backing.fingerId === null) return null;
    const touches = ctx._scriptApi._touches;
    return touches.has(backing.fingerId) ? touches.get(backing.fingerId) : null;
  }

  const target = {
    /** True while locked onto a finger that is still down. */
    get active() {
      return currentTouch() !== null;
    },
    /** True unless disable() has been called (without a matching enable() since). */
    get enabled() {
      return backing.enabled;
    },
    /** Tracked finger's current world x, or null if not active. */
    get x() {
      const t = currentTouch();
      return t ? t.x : null;
    },
    /** Tracked finger's current world y, or null if not active. */
    get y() {
      const t = currentTouch();
      return t ? t.y : null;
    },
    /**
     * Claims the first finger that just touched down over this exact
     * entity this frame. No-op (returns false) if already tracking a
     * finger, if no finger started on this entity this frame, or if
     * disabled via disable().
     *   this.myTouch.startTracking();
     * @returns {boolean} true if a finger was newly claimed
     */
    startTracking: function () {
      if (!backing.enabled) return false;
      const touches = ctx._scriptApi._touches;
      // A tracked finger that has lifted is no longer in `touches` —
      // clear the stale id here so a NEW tap can claim a finger again.
      // Without this, backing.fingerId stays set forever after the
      // first release (active correctly flips to false, but
      // startTracking() would keep bailing out below thinking it's
      // still tracking something).
      if (backing.fingerId !== null && !touches.has(backing.fingerId)) {
        backing.fingerId = null;
      }
      if (backing.fingerId !== null) return false; // already tracking one
      const started = ctx._scriptApi._touchesStarted;
      for (const t of touches.values()) {
        if (!started.has(t.id)) continue;
        const hits = ctx._scriptApi._entitiesAtPoint(t.x, t.y);
        for (let i = 0; i < hits.length; i++) {
          if (hits[i]._entity.id === ctx._entity.id) {
            backing.fingerId = t.id;
            return true;
          }
        }
      }
      return false;
    },
    /** Releases the tracked finger early, before it lifts on its own. */
    stopTracking: function () {
      backing.fingerId = null;
    },
    /**
     * Turns tracking OFF: releases whatever finger is currently
     * tracked (if any) right away, and makes startTracking() a no-op
     * until enable() is called.
     *   this.myTouch.disable();
     */
    disable: function () {
      backing.enabled = false;
      backing.fingerId = null;
    },
    /**
     * Turns tracking back ON after a disable() call. Tracking is
     * enabled by default, so this is only needed to undo a prior
     * disable().
     *   this.myTouch.enable();
     */
    enable: function () {
      backing.enabled = true;
    },
  };

  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !TOUCH_TRACK_MEMBERS.has(String(prop))) {
        throw Object.assign(new Error(
          "this.myTouch." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(TOUCH_TRACK_MEMBERS).join(", ") + "."
        ), { kind: "unknown-api" });
      }
      const v = t[prop];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop) {
      const key = String(prop);
      throw Object.assign(new Error(
        "this.myTouch." + key + " is read-only — use this.myTouch.startTracking()/" +
        ".stopTracking()/.enable()/.disable() to control it, not direct assignment."
      ), { kind: "unknown-api" });
    },
  });
}
