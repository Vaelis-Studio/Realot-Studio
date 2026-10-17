/**
 * runtime/scripting/components/StateAPI.js
 *
 * The `this.state` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). Unlike every other this.<sub-object>
 * (sprite, rigidbody, audio, etc.) this one needs NO component —
 * every entity gets a state machine automatically, backed by a plain
 * object that lives on the EntityContext itself (see
 * `_stateBacking` below), not on a World component. There is
 * therefore no Inspector section, no Add Component entry, and nothing
 * saved into the scene file for this — state is pure runtime/script
 * bookkeeping, reset to its default ("default") every time the scene
 * (re)starts, exactly like a fresh EntityContext.
 *
 * API:
 *   this.state.current         — current state name (string, read-only)
 *   this.state.previous        — state name before the last change() (string|null, read-only)
 *   this.state.change(name)    — switches state. If `name` differs from
 *                                 the current state: fires this
 *                                 instance's onStateExit() (old state
 *                                 still current while it runs), updates
 *                                 current/previous, then fires
 *                                 onStateEnter() (new state now
 *                                 current). Calling change() with the
 *                                 SAME name as the current state is a
 *                                 no-op — it does NOT re-fire
 *                                 onStateExit/onStateEnter (mirrors
 *                                 Unity Animator's own "same state,
 *                                 no transition" behavior) — see
 *                                 ScriptSystem.js's fireStateChange().
 *
 * onStateEnter()/onStateUpdate()/onStateExit() are lifecycle functions
 * (like onStart/onUpdate) dispatched by ScriptSystem — see that file's
 * _compile() (added to the handler list), fireStateChange() (enter/exit),
 * and update()'s onUpdate loop (onStateUpdate, gated on state.current
 * having actually been set at least once — see the comment there).
 *
 * RUNTIME-ONLY FILE.
 */

const STATE_MEMBERS = new Set(["current", "previous", "change"]);

/**
 * Builds the `this.state` object for a given EntityContext. Reads and
 * writes `ctx._stateBacking` (created lazily here, once, the first
 * time this.state is touched) rather than a World component — state
 * needs no Inspector-visible data and no serialization, just a plain
 * object that survives for the entity's whole lifetime (same lifetime
 * as the EntityContext itself — see ScriptAPI.js's createEntityContext
 * caching and clearContexts()/clearContext()).
 *
 * @param {object} ctx   the EntityContext (`this`) this state belongs to
 * @param {function} changeFn  ScriptSystem's fireStateChange, bound to
 *   this entity — actually fires onStateExit/onStateEnter and updates
 *   ctx._stateBacking. Wired this way (instead of StateAPI reaching
 *   into ScriptSystem itself) so this file never needs to import
 *   ScriptSystem — same indirection AudioAPI/ControllerAPI use to stay
 *   decoupled from systems/ (see ScriptAPI.js's _sendMessageFn-style
 *   wiring for the general pattern).
 * @returns {object}
 */
export function createStateAPI(ctx, changeFn) {
  if (!ctx._stateBacking) {
    ctx._stateBacking = { current: "default", previous: null };
  }
  const backing = ctx._stateBacking;

  const target = {
    /** Current state name. Starts as "default" until change() is first called. */
    get current() { return backing.current; },
    /** State name before the last change(), or null if change() has never been called. */
    get previous() { return backing.previous; },
    /**
     * Switch to a new state by name. No-op if `name` is already the
     * current state (no onStateExit/onStateEnter re-fire). Otherwise:
     * fires onStateExit() for the OLD state, updates current/previous,
     * then fires onStateEnter() for the NEW state — see this file's
     * header comment and ScriptSystem.fireStateChange() for the exact
     * order and error-isolation behavior.
     *   this.state.change("chasing");
     */
    change: function (name) {
      changeFn(String(name));
    },
  };

  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !STATE_MEMBERS.has(String(prop))) {
        throw Object.assign(new Error(
          "this.state." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(STATE_MEMBERS).join(", ") + "."
        ), { kind: "unknown-api" });
      }
      const v = t[prop];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop, value) {
      const key = String(prop);
      throw Object.assign(new Error(
        "this.state." + key + " is read-only — use this.state.change(name) to switch states, " +
        "not direct assignment."
      ), { kind: "unknown-api" });
    },
  });
}
