/**
 * runtime/systems/ScriptSystem.js
 *
 * Compiles and runs user scripts attached via the Script component.
 * Scripts are compiled with `new Function()` — they never use eval()
 * and don't see the editor's lexical scope. IMPORTANT: this is NOT a
 * security sandbox. Scripts run in the page's own realm, so they can
 * still reach browser globals unless those are shadowed (see
 * SHADOWED_GLOBALS below, which only blocks the direct/obvious routes).
 * Treat any project's scripts as trusted code. See SECURITY.md. Each script's `this` is an EntityContext built
 * by ScriptAPI (see scripting/ScriptAPI.js), giving it safe access to
 * this.x, this.transform, this.sprite, find(), scene, physics, input,
 * mouse, touch, time, random, and global.
 *
 * Lifecycle events called automatically:
 *   onStart()          — once, before the first onUpdate
 *   onClone()          — once, ONLY on entities created by spawn()
 *                         (see ScriptAPI.spawn()), called right
 *                         BEFORE onStart() on that same instance. Never
 *                         fires for entities loaded from the scene file.
 *   onUpdate(dt)       — every render frame
 *   onClick()          — the frame the mouse/a finger is pressed while
 *                         over this entity's collider (needs Collider2D)
 *   onFixedUpdate(dt)  — at a fixed 60 Hz timestep (accumulator)
 *   onCollision(other)      — when this entity's collider touches another (enter)
 *   onCollisionEnter(other) — alias for onCollision; prefer this for clarity
 *   onCollisionStay(other)  — every physics step the collider is STILL
 *                             touching another, from the step after Enter
 *                             up to (not including) the step Exit fires
 *   onCollisionExit(other)  — when this entity's collider stops touching another
 *   onTriggerEnter(other)   — when entering a trigger collider
 *   onTriggerExit(other)    — when leaving a trigger collider
 *   onDestroy()       — once, when the entity is destroyed / scene ends
 *   onStateEnter()     — fired by this.state.change(name) right after
 *                         switching TO a new state (see fireStateChange()
 *                         and scripting/components/StateAPI.js). Needs
 *                         no component — this.state works on every
 *                         entity automatically.
 *   onStateUpdate(dt)  — every render frame, right after onUpdate,
 *                         regardless of whether this.state.change() was
 *                         ever called (this.state.current defaults to
 *                         "default"). Use this.state.current to branch.
 *   onStateExit()      — fired by this.state.change(name) right before
 *                         switching AWAY from the current state.
 *   onHearSound(source) — fired by AudioListenerSystem the frame a 3D
 *                         AudioSource enters this entity's Audio
 *                         Listener radius (needs an Audio Listener
 *                         component — see components/AudioListener.js).
 *   onLoseSound(source)  — the frame that source leaves range (or is
 *                         destroyed while in range).
 *
 * FAULT ISOLATION: a thrown error inside one lifecycle CALL is caught
 * right there and reported — it does NOT disable the whole script
 * instance anymore (except onStart, see below). A bug in onUpdate this
 * frame just means this entity's onUpdate is skipped THIS frame; next
 * frame it's called again like normal. One bad line doesn't stop the
 * rest of the game, and doesn't even stop the rest of THIS script.
 * The only lifecycle that still disables the instance after a failure
 * is onStart: it only ever runs once, so there's nothing to "retry
 * next frame", and letting onUpdate run against state onStart never
 * finished setting up would likely just throw again immediately anyway.
 *
 * ERROR CLASSIFICATION: scripting/components/*API.js tag thrown Errors
 * with a machine-readable `err.kind` —
 *   "missing-component"     this.rigidbody/.sprite/etc but the entity
 *                            doesn't have that component at all
 *   "unsupported-body-type" e.g. this.rigidbody.addForce() on a
 *                            Kinematic/Static body
 *   "unknown-api"            this.rigidbody.addFrce() — property/method
 *                            that doesn't exist at all (a typo)
 * Anything without a `kind` (a plain script bug — null deref, bad
 * logic, etc.) is reported as "script-error". _formatError() below
 * turns each kind into a specific, actionable one-line message rather
 * than a generic "X is not a function".
 *
 * REPEAT THROTTLING: the same error firing every frame (e.g. an
 * onUpdate bug) would otherwise spam the console 60x/second. Identical
 * (script, method, message) errors are reported immediately once, then
 * suppressed and finally summarized with a repeat count — see
 * _shouldReport().
 *
 * RUNTIME-ONLY FILE.
 */

import { SCRIPT } from "../components/Script.js";
import { stripCastSyntax } from "../scripting/CastSyntax.js";
import { resolveTweenEasing } from "../scripting/TweenEasing.js";

const FIXED_TIMESTEP = 1 / 60;

// After the first report, wait this many ms before reporting the same
// (script, method, message) combination again — as a "(x N times)"
// summary rather than a fresh spammy line every single frame.
const REPEAT_THROTTLE_MS = 3000;

// Converts a V8 stack trace line number (from a `new Function(...)`-
// compiled script's error) back to the user's OWN 1-indexed line
// number within their source text alone.
//
// FIX (was 2, should be 3): this used to be computed by reasoning
// about _compile()'s '"use strict";\n' + source string in isolation —
// "line 1 of the wrapped body is 'use strict', line 2 is the user's
// own line 1, so subtract 2" — which undercounts by exactly one line.
// `new Function(argNames..., body)` implicitly synthesizes a function
// SIGNATURE line ("function anonymous(argNames...) {") before the
// body even starts, and V8's line numbering for the generated function
// starts counting from THAT synthesized line, not from the body
// string's own line 1. Measured directly (see the test harness used
// to derive this — a script with a deliberate bug on a known source
// line, run through the exact real _compile() wrapping, comparing the
// thrown stack's line against the known line): a bug on the user's
// source line N consistently shows up as stack line N+3, not N+2.
// Verified stable across bug position, blank lines, and multiple
// functions before/after the bug — so this is one plain constant, not
// something that needs recomputing per script.
const WRAPPER_LINE_OFFSET = 3;

// this.<name> -> the component that has to be present for that
// sub-object to exist (see ScriptAPI.js's _buildSubObjects() — each
// one is `hasComponent(...) ? create...API(entity) : undefined`).
// Mirrors editor/scripting/ScriptIntelliSense.js's
// COMPONENT_DISPLAY_NAMES exactly, so a beginner sees the identical
// component name whether they hover this.<name> in the editor or hit
// this error at runtime. Used ONLY by _missingComponentHint() below —
// intentionally excludes "transform"/"state"/"myTouch" (need no
// component, never undefined — see _buildSubObjects()) and every
// non-per-entity global (scene, physics, nav, mouse, touch, ...),
// none of which can produce this error shape at all.
const COMPONENT_HINT_NAMES = new Map([
  ["sprite", { componentName: "Sprite Renderer" }],
  ["shape", { componentName: "Shape Renderer" }],
  ["text", { componentName: "Text" }],
  ["speechBubble", { componentName: "Speech Bubble" }],
  ["chat", { componentName: "Chat Log" }],
  ["textInput", { componentName: "Text Input" }],
  ["rigidbody", { componentName: "Rigidbody 2D" }],
  ["controller", { componentName: "Character Controller" }],
  ["animator", { componentName: "Sprite Animation" }],
  ["camera", { componentName: "Camera" }],
  ["audio", { componentName: "Audio Source" }],
  ["ear", { componentName: "Audio Listener" }],
  ["collider", { componentName: "Collider 2D" }],
  ["navAgent", { componentName: "Nav Agent 2D" }],
  ["light", { componentName: "Light" }],
]);

/**
 * Browser globals a game script has no reason to touch. Each name is
 * added as an extra (undefined) parameter of the compiled script
 * function, so a bare `localStorage` / `window` / `fetch` inside a
 * script resolves to `undefined` instead of the real global.
 *
 * WHAT THIS IS: defense-in-depth against accidents and casual snooping
 * (e.g. a shared project reading the editor's saved build-server keys
 * with a one-liner).
 *
 * WHAT THIS IS NOT: a sandbox. A determined script can still get the
 * real global object (for example through `(() => {}).constructor`),
 * so untrusted projects must be isolated at the origin level (separate
 * origin or sandboxed iframe) — see SECURITY.md.
 *
 * Not included on purpose: `eval` and `arguments` (strict-mode code may
 * not use them as parameter names).
 */
export const SHADOWED_GLOBALS = [
  "window", "document", "globalThis", "self", "top", "parent", "frames", "opener", "open",
  "localStorage", "sessionStorage", "indexedDB", "caches",
  "fetch", "XMLHttpRequest", "WebSocket", "Function",
];

/**
 * True if the script declares its own top-level binding called `name`
 * with let/const/class. A parameter with the same name would turn that
 * into a SyntaxError ("already declared"), so such names are left
 * un-shadowed — a game script using `const top = 10;` keeps working.
 */
function declaresOwnBinding(source, name) {
  return new RegExp("(?:^|[^.\\w$])(?:let|const|class)\\s+" + name + "(?![\\w$])").test(source);
}

export class ScriptSystem {
  /**
   * @param {import('../scripting/ScriptAPI.js').ScriptAPI} scriptApi
   */
  constructor(scriptApi) {
    this.scriptApi = scriptApi;
    /** @type {Map<string, Array<{handlers:object, context:object, scriptName:string, enabled:boolean, started:boolean}>>} */
    this.instances = new Map();
    this._started = false;
    this._fixedAccumulator = 0;
    /** Real (unscaled) frame time pushed in by GameLoop — see time.unscaledDeltaTime. */
    this._unscaledDt = null;
    /** @type {function|null} set by the play popup to receive error reports */
    this._errorCallback = null;
    /** @type {Map<string, {count:number, lastReportedAt:number}>} throttle state, keyed by "scriptName|method|message" */
    this._errorThrottle = new Map();
    /**
     * scriptName -> raw source text, kept ONLY so _formatError() can look
     * up the actual failing line's text when it needs to tell a missing-
     * component sub-object access (this.rigidbody.velocity with no
     * Rigidbody2D) apart from an ordinary undefined-property bug — see
     * _missingComponentHint() below for why the error message alone
     * can't distinguish those. Set in _compile(), never cleared per-
     * script (harmless to keep a stale entry if a script's since been
     * removed — it just won't be looked up again).
     * @type {Map<string, string>}
     */
    this._scriptSources = new Map();
    /** @type {import('../core/World.js').World|null} current world, stashed at the top of update() */
    this._world = null;
    /** EntityContext of the lifecycle callback currently executing. */
    this._activeContext = null;
    /**
     * Pending wait() timers, keyed by the id of the entity that
     * SCHEDULED them (not necessarily the entity the callback touches —
     * scripts can close over `this` from another entity, same as any
     * other JS closure). One entity can have many timers in flight at
     * once (e.g. several wait() calls from different onUpdate frames),
     * so each entry is an array.
     * @type {Map<string, Array<{remaining:number, callback:function, context:object, id:number, cancelled:boolean}>>}
     */
    this._timers = new Map();
    /** Monotonically increasing id handed out by wait(), so scripts can
     *  cancelWait(id) a specific pending timer if they need to. Never
     *  reused within a single play session, even across restarts —
     *  simpler and safer than trying to recycle ids, and the numbers
     *  themselves carry no meaning scripts should rely on beyond
     *  uniqueness. */
    this._nextTimerId = 1;
    /** @type {Map<number, object>} Active property tweens, advanced once per game frame. */
    this._tweens = new Map();
    this._nextTweenId = 1;

    // Wire sendMessage / broadcastMessage into ScriptAPI's globals so
    // user scripts can call sendMessage(tag, msg, data) and
    // broadcastMessage(msg, data) without needing a direct reference to
    // ScriptSystem. The callbacks are set here (constructor) so they're
    // available the first time getGlobals() is called from _initScripts.
    const self = this;
    // sendMessage's first argument accepts EITHER a tag string (the
    // original form — messages EVERY entity with that tag, which is
    // often exactly what you want for a group broadcast) OR an
    // EntityContext directly, which messages that ONE exact entity
    // and nothing else — for when you specifically mean "tell THIS
    // entity", not "tell everyone tagged like it":
    //   sendMessage("Enemy", "takeDamage", { amount: 10 })   // every entity tagged "Enemy"
    //   sendMessage(specificEnemy, "takeDamage", { amount: 10 })  // just that one, e.g. from findById()/spawn()
    scriptApi._sendMessageFn = function(tagOrEntity, message, data) {
      if (!self._world) return;
      if (tagOrEntity && tagOrEntity._entity) {
        self.fireMessage(tagOrEntity._entity.id, message, self._activeContext, data);
        return;
      }
      const entities = self._world.findByTag ? self._world.findByTag(tagOrEntity) : [];
      if (!entities) return;
      for (const e of entities) self.fireMessage(e.id, message, self._activeContext, data);
    };
    scriptApi._broadcastMessageFn = function(message, data) {
      if (!self._world) return;
      const entities = self._world.getAllEntities ? self._world.getAllEntities() :
        (self._world.entities ? [...self._world.entities.values()] : []);
      for (const e of entities) self.fireMessage(e.id, message, self._activeContext, data);
    };

    // Wire wait() / cancelWait() the same way — see _scheduleWait() and
    // _cancelWait() below for the full behavior (per-entity ownership,
    // auto-cancel on destroy/restart/scene-switch).
    scriptApi._waitFn = function(seconds, callback) {
      return self._scheduleWait(seconds, callback);
    };
    scriptApi._cancelWaitFn = function(timerId) {
      self._cancelWait(timerId);
    };
    // repeat() / cancelRepeat() — same timer mechanism as wait(), just
    // re-armed instead of removed each time it fires. See
    // _scheduleRepeat()'s doc comment below.
    scriptApi._repeatFn = function(seconds, callback) {
      return self._scheduleRepeat(seconds, callback);
    };
    scriptApi._cancelRepeatFn = function(timerId) {
      self._cancelRepeat(timerId);
    };
    // Property tweens share the ScriptSystem's scaled frame clock and
    // context ownership, so they pause with gameplay and are cancelled
    // when the calling entity or scene goes away.
    scriptApi._tweenFn = function(target, properties, duration, easing, onComplete) {
      return self._scheduleTween(target, properties, duration, easing, onComplete);
    };
    scriptApi._cancelTweenFn = function(tweenId) {
      return self._cancelTween(tweenId);
    };

    // Wire this.state.change(name) (StateAPI.js) the same way — see
    // fireStateChange()'s doc comment below for the full onStateExit/
    // onStateEnter behavior.
    scriptApi._fireStateChangeFn = function(entityId, name, ctx) {
      self.fireStateChange(entityId, name, ctx);
    };
  }

  /**
   * Sets a callback that receives { scriptName, message, line, method, kind }.
   * The play popup wires this to postMessage back to the editor.
   */
  onError(cb) {
    this._errorCallback = cb;
  }

  /**
   * Turns a raw Error (possibly tagged with `.kind` by one of the
   * scripting/components/*API.js files) into a specific, actionable
   * message. Falls back to the error's own message for plain script
   * bugs (null deref, bad logic, etc.) that have no special kind.
   */
  _formatError(err, methodName, scriptName) {
    const raw = err && err.message ? err.message : String(err);
    const kind = (err && err.kind) || "script-error";
    // The *API.js files already write a complete, specific sentence for
    // missing-component / unsupported-body-type / unknown-api — they
    // know exactly which object, which member, and why. Nothing to add.
    if (kind === "script-error") {
      if (methodName === "init") {
        const hint = this._topLevelThisHint(raw);
        if (hint) return { kind, message: raw + " " + hint };
      }
      // Runs for every OTHER lifecycle method too (onUpdate, onClick,
      // ...), unlike _topLevelThisHint above which only makes sense for
      // "init" specifically (top-level code only ever runs once, during
      // init). A missing-component sub-object access can happen from
      // inside any lifecycle function.
      const missingHint = this._missingComponentHint(raw, err, scriptName);
      if (missingHint) return { kind, message: raw + " " + missingHint };
    }
    return { kind, message: raw };
  }

  /**
   * Detects the most common beginner mistake that surfaces as an
   * "init" error: reading `this.<prop>` (this.x, this.sprite, etc.)
   * in top-level script code instead of inside a lifecycle function
   * like onStart/onUpdate.
   *
   * Top-level code runs once, immediately, when the script factory is
   * compiled and invoked to collect the lifecycle handlers — BEFORE
   * any handler is ever called with `.call(entityContext, ...)`. At
   * that point there is no entity `this` yet, so `this` is undefined
   * (scripts run in strict mode), and `this.x` throws exactly the
   * "Cannot read properties of undefined (reading 'x')" message this
   * matches on. Reported with method "init" by _initScripts() below,
   * since it happens outside any lifecycle call.
   *
   * Returns a one-line actionable hint, or null if the message doesn't
   * match this pattern (callers fall back to the raw message alone).
   */
  _topLevelThisHint(message) {
    const m = message.match(/Cannot read propert(?:y|ies) of undefined \(reading '([^']+)'\)/);
    if (!m) return null;
    const prop = m[1];
    const capProp = prop.charAt(0).toUpperCase() + prop.slice(1);
    return (
      "Hint: it looks like you're using \"this." + prop + "\" outside a " +
      "lifecycle function. \"this\" only refers to the entity INSIDE " +
      "functions like onStart() or onUpdate(dt) — not in code that runs " +
      "at the top of the script. Move \"this." + prop + "\" into onStart() " +
      "(runs once, before the first onUpdate) or onUpdate(), e.g.: " +
      "var start" + capProp + "; function onStart() { start" + capProp +
      " = this." + prop + "; }"
    );
  }

  /**
   * Detects the OTHER extremely common beginner mistake that produces
   * the exact same generic "Cannot read properties of undefined
   * (reading 'X')" message as _topLevelThisHint above, but from inside
   * a real lifecycle function: reading a component-gated sub-object
   * (this.rigidbody, this.sprite, this.collider, this.navAgent, ...)
   * that's undefined because the entity doesn't actually have that
   * component (see ScriptAPI.js's _buildSubObjects() — every one of
   * these is `hasComponent(...) ? create...API(entity) : undefined`,
   * by design, so `if (this.rigidbody)` guards keep working). The raw
   * V8 message only ever names the LAST property read on undefined
   * ("velocity" in `this.rigidbody.velocity`), never "rigidbody" —
   * so unlike _topLevelThisHint, which can build its whole hint out of
   * the message alone, this needs the actual source LINE text to
   * recover which sub-object was being accessed. That's what
   * _scriptSources + the stack's line number (same extraction
   * _reportError does for display) are for.
   *
   * Deliberately conservative: only fires when the recovered line
   * contains a real `this.<knownSubObject>.` chain — a plain
   * `this.someTypo.x` (not one of the known component names) or a
   * message with no recoverable line at all just falls through to the
   * raw message, same as any other undefined-property bug.
   *
   * Returns a one-line actionable hint, or null.
   */
  _missingComponentHint(message, err, scriptName) {
    if (!/^Cannot read propert(?:y|ies) of undefined/.test(message)) return null;
    if (!scriptName || !err || !err.stack) return null;
    const source = this._scriptSources.get(scriptName);
    if (!source) return null;

    const m = err.stack.match(/<anonymous>:(\d+):(\d+)/);
    if (!m) return null;
    // WRAPPER_LINE_OFFSET (module-level const) converts the raw stack
    // line to the user's own source line — see its definition for the
    // measured, tested derivation. Kept as one shared constant so this
    // and _reportError's display-line calculation can never drift out
    // of sync with each other again (they used to duplicate a stale
    // "-2" independently — see WRAPPER_LINE_OFFSET's comment).
    const lineNum = parseInt(m[1], 10) - WRAPPER_LINE_OFFSET;
    const lines = source.split("\n");
    const lineText = lines[lineNum - 1]; // 1-indexed -> 0-indexed
    if (!lineText) return null;

    // Look for this.<subObject>. immediately followed by the property
    // name the engine error actually named — i.e. the exact chain that
    // would produce this exact message.
    const propName = message.match(/reading '([^']+)'\)/);
    if (!propName) return null;
    const chainRx = new RegExp(
      "\\bthis\\s*\\.\\s*(" + Array.from(COMPONENT_HINT_NAMES.keys()).join("|") + ")\\s*\\.\\s*" +
      propName[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b"
    );
    const chainMatch = lineText.match(chainRx);
    if (!chainMatch) return null;

    const subObj = chainMatch[1];
    const info = COMPONENT_HINT_NAMES.get(subObj);
    return (
      "Hint: \"this." + subObj + "\" is undefined here because this entity " +
      "doesn't have a " + info.componentName + " component. Add a " +
      info.componentName + " to this entity in the Inspector, or guard the " +
      "access first: if (this." + subObj + ") { ... this." + subObj + "." +
      propName[1] + " ... }."
    );
  }

  _reportError(scriptName, err, methodName) {
    const { kind, message } = this._formatError(err, methodName, scriptName);

    // Try to extract a line number from the error stack (only
    // meaningful for plain script-error bugs thrown from the user's
    // own compiled source — API errors point at engine code instead,
    // so their line is intentionally left as "?").
    let line = "?";
    if (kind === "script-error" && err && err.stack) {
      const m = err.stack.match(/<anonymous>:(\d+):(\d+)/);
      if (m) line = String(parseInt(m[1], 10) - WRAPPER_LINE_OFFSET);
    }

    const throttleKey = scriptName + "|" + (methodName || "?") + "|" + message;
    if (!this._shouldReport(throttleKey)) return;

    if (this._errorCallback) {
      this._errorCallback({ scriptName, message, line, method: methodName || "?", kind });
    }
    if (typeof console !== "undefined") {
      const where = "'" + scriptName + "'" + (line !== "?" ? " line " + line : "") + " (" + (methodName || "?") + "())";
      console.error("[Script] " + where + ": " + message);
    }
  }

  /**
   * Returns true if this exact (script, method, message) should be
   * reported now — true the first time, then throttled to at most once
   * per REPEAT_THROTTLE_MS while it keeps recurring (e.g. an onUpdate
   * bug firing every frame), with a "(repeated Nx)" note so repeats
   * aren't silently lost, just decluttered.
   */
  _shouldReport(key) {
    const now = Date.now();
    const entry = this._errorThrottle.get(key);
    if (!entry) {
      this._errorThrottle.set(key, { count: 1, lastReportedAt: now });
      return true;
    }
    entry.count++;
    if (now - entry.lastReportedAt >= REPEAT_THROTTLE_MS) {
      const repeats = entry.count - 1;
      entry.lastReportedAt = now;
      entry.count = 0;
      if (repeats > 0 && typeof console !== "undefined") {
        console.warn("[Script] (previous error above repeated " + repeats + " more time" + (repeats === 1 ? "" : "s") + " in the last " + Math.round(REPEAT_THROTTLE_MS / 1000) + "s)");
      }
      return true;
    }
    return false;
  }

  /**
   * Compiles user source into a factory function. The factory is called
   * with Realot globals as parameters, and returns an object with
   * whichever lifecycle handlers the user declared, PLUS every other
   * top-level function they wrote (see "CUSTOM FUNCTIONS" below).
   *
   * CUSTOM FUNCTIONS AND `this`:
   * A user's own helper function — e.g. `function chase() { ... }`
   * called as a bare `chase()` from inside onUpdate() — is NOT one of
   * the fixed lifecycle hooks the engine calls directly, so without
   * help it never gets `this` bound to the entity the way onStart/
   * onUpdate/etc. do (that binding happens via `handler.call(context,
   * ...)` in _initEntityScripts()/_invoke(), which only ever touches
   * the fixed lifecycle-hook names below). Left alone, `chase()`
   * called bare runs with `this === undefined` (scripts execute in
   * strict mode — see the "use strict" prologue below), so `this.x`
   * inside it throws — a confusing trap for anyone who reasonably
   * expects a function declared right next to onUpdate() to behave
   * the same way.
   *
   * Fixed with a lightweight pre-scan (_extractTopLevelFunctionNames,
   * below) that finds every `function name(...) { ... }` declared at
   * the top level of the user's source — same shallow, indentation-
   * agnostic scan already used for the fixed lifecycle names, just
   * generalized to catch arbitrary ones too. The generated wrapper
   * then REBINDS each of those local function bindings to the entity
   * context right inside the sandboxed source itself (a top-level
   * `function foo(){}` declaration is an ordinary reassignable local
   * binding, same as `var foo`, so `foo = foo.bind(__ctx);` works) —
   * this has to happen inside the generated code, not from outside
   * after factory() returns, because a bare call like `chase()`
   * resolves to whatever the LOCAL `chase` binding currently points
   * to; handing a bound copy back out in a side object wouldn't
   * change what the bare identifier inside the script itself refers
   * to. `__ctx` is a real parameter now (see the factory() call in
   * _initEntityScripts(), which creates the entity context BEFORE
   * calling factory() specifically to make this possible), so a plain
   * top-level `function chase() { this.x }` just works when called
   * bare, exactly like onUpdate() does. No `this.chase()`, no
   * manually stashing `this` into a variable in onStart() required.
   */
  _compile(scriptName, source) {
    try {
      // Stashed for _formatError()'s missing-component hint lookup — see
      // _scriptSources' doc comment in the constructor. Stored on EVERY
      // compile (including ones that go on to fail below) so the hint
      // still works even if a later edit briefly breaks compilation.
      this._scriptSources.set(scriptName, source);

      // Realot scripts support an editor-only `x as Type` / `x as
      // (A, B)` cast hint (see runtime/scripting/CastSyntax.js) that's
      // valid Realot script syntax but NOT valid JavaScript — `as`
      // isn't a JS keyword, so passing it straight to `new Function()`
      // below would throw a real SyntaxError the instant a script using
      // a cast actually ran. Blanking it out here (before any of the
      // regex scans below, which don't need to understand casts either)
      // is the one place every script passes through on its way to
      // compiling, so this is the only place that needs to know casts
      // exist at all.
      source = stripCastSyntax(source);
      const lifecycleNames = [
        "onStart", "onUpdate", "onClick", "onFixedUpdate", "onCollision",
        "onCollisionEnter", "onCollisionStay", "onCollisionExit", "onTriggerEnter", "onTriggerExit",
        "onMessage", "onClone", "onDestroy",
        "onStateEnter", "onStateUpdate", "onStateExit", "onHearSound", "onLoseSound",
      ];
      const customNames = this._extractTopLevelFunctionNames(source, lifecycleNames);
      const risky = this._extractRiskyAssignedFunctionNames(
        source,
        lifecycleNames.concat(customNames)
      );
      // A function EXPRESSION (`var chase = function () {}`) rebinds
      // exactly like a declaration does — same reassignable local
      // binding, just spelled differently — so fold it into the same
      // rebind pass as customNames rather than a separate one.
      const allBindable = customNames.concat(risky.expressions);

      // Arrow functions (`var chase = () => {}`) CANNOT be rebound —
      // .bind() is a documented no-op on arrows, they permanently keep
      // whatever `this` was in scope where they were written (here,
      // the compiled script's own top level — `undefined`, since
      // scripts run in strict mode). Surface this as a real compile
      // warning rather than letting it fail silently and confusingly
      // the first time the arrow reads `this` — same spirit as the
      // "called outside a lifecycle function" warning wait()/repeat()
      // already give for a different beginner trap.
      if (risky.arrows.length > 0 && typeof console !== "undefined") {
        for (const name of risky.arrows) {
          console.warn(
            "[Script] '" + scriptName + "': " + name + " is an arrow function " +
            "(" + name + " = (...) => {...}). Arrow functions can't use `this` to " +
            "refer to the entity — `this` inside one is always undefined here, even " +
            "when called from onUpdate() or another lifecycle function. Use " +
            "`function " + name + "(...) { ... }` instead if it needs `this`."
          );
        }
      }

      const returnLines = [];
      for (const name of lifecycleNames) {
        returnLines.push("  " + name + ": typeof " + name + " !== 'undefined' ? " + name + " : null,");
      }
      // Rebind every custom top-level function's OWN local binding to
      // the entity context, in place, before the return object is
      // built — see the class-level doc comment above for why this
      // has to happen here rather than after factory() returns.
      // Guarded with typeof so a name the pre-scan found (a `function`
      // declaration always hoists, so this guard never actually skips
      // a real one — it's defense-in-depth against the regex scan and
      // actual parse ever disagreeing) can't throw a ReferenceError.
      const rebindLines = allBindable.map(function (name) {
        return "if (typeof " + name + " !== 'undefined') { " + name + " = " + name + ".bind(__ctx); }";
      });

      // Extra trailing parameters that are never passed a value, so the
      // names resolve to `undefined` inside the script (see SHADOWED_GLOBALS).
      const shadowed = SHADOWED_GLOBALS.filter((n) => !declaresOwnBinding(source, n));

      const factory = new Function(
        "findFirst", "findAll", "findWithTag", "findFirstWithTag", "findAllWithTag", "findById", "findInRadius",
        "scene", "physics", "input", "mouse", "touch", "time", "random", "mathx", "smoothstep", "global", "save", "debug",
        "sendMessage", "broadcastMessage", "spawn", "wait", "cancelWait", "repeat", "cancelRepeat", "tween", "cancelTween", "nav",
        "console", "Math", "__ctx",
        ...shadowed,
        '"use strict";\n' + source + '\n' +
        rebindLines.join("\n") + "\n" +
        "return {\n" +
        returnLines.join("\n") + "\n" +
        "};\n"
      );
      return factory;
    } catch (err) {
      this._reportError(scriptName, err, "compile");
      return null;
    }
  }

  /**
   * Finds every `function name(...) { ... }` declared at the top
   * level (column 0 indentation is NOT required — this matches
   * leading whitespace too, just not one already nested inside
   * another function/block) of a script's source, excluding the fixed
   * lifecycle names (those are already handled explicitly in
   * _compile() and don't need rediscovering here).
   *
   * DELIBERATELY SIMPLE: this is a regex scan, not a real parser —
   * matches Realot's existing approach to source analysis (see
   * ScriptHighlighting.js's comment on why a lexical scan was chosen
   * over a full parser). It only needs to catch the common, intended
   * case — a plain named function declaration at the top level of a
   * script, which is the shape a script author reaches for first and
   * the one that reads most like a "real" function.
   *
   * WHAT THIS DOESN'T CATCH — see _extractRiskyAssignedFunctionNames
   * just below for the other two shapes a user might write instead:
   *   var chase = function () { this.x }   // function EXPRESSION
   *   var chase = () => { this.x }         // arrow function
   * Both are handled separately because they need DIFFERENT fixes: a
   * function expression assigned to a var CAN be rebound the same way
   * (var bindings are reassignable, same as function declarations),
   * but an arrow function fundamentally can't — .bind() is a no-op on
   * arrows, they permanently close over whatever `this` was in scope
   * where they were written, which for a top-level script arrow is
   * the compiled script's own factory call — `undefined`, since
   * scripts run in strict mode. Silently rebinding would be
   * impossible for that form, and silently doing nothing would leave
   * the exact confusing "why is this undefined" trap this whole
   * mechanism exists to remove — so arrows get a clear compile-time
   * warning instead (see _compile()).
   * @param {string} source
   * @param {string[]} lifecycleNames names to exclude (already handled)
   * @returns {string[]}
   */
  _extractTopLevelFunctionNames(source, lifecycleNames) {
    const names = [];
    const seen = new Set(lifecycleNames);
    // Matches `function foo(` only when NOT preceded by another
    // identifier character (so `myfunction(` isn't mistaken for a
    // declaration) — a top-level declaration always starts a
    // statement, so the character before "function" is whitespace,
    // start-of-string, `;`, `}`, or a newline in practice; \b already
    // covers the identifier-boundary case adequately for this
    // best-effort scan.
    const re = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    let m;
    while ((m = re.exec(source))) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return names;
  }

  /**
   * Finds top-level `var/let/const name = function (...) {...}` and
   * `var/let/const name = (...) => {...}` assignments — the two other
   * shapes (besides a plain `function name(){}` declaration, handled
   * by _extractTopLevelFunctionNames above) a script author might
   * reach for to write a helper. Returns them split by kind, since
   * _compile() treats them differently: a function EXPRESSION can be
   * rebound the same way a declaration can (the var/let/const name is
   * just as reassignable), but an arrow function can't be — see
   * _extractTopLevelFunctionNames's doc comment for why — so those
   * get a compile-time warning instead of a silent (impossible) fix.
   * @param {string} source
   * @param {string[]} excludeNames names already handled elsewhere (skip re-flagging)
   * @returns {{ expressions: string[], arrows: string[] }}
   */
  _extractRiskyAssignedFunctionNames(source, excludeNames) {
    const seen = new Set(excludeNames);
    const expressions = [];
    const arrows = [];
    // `name = function (` — the `function` keyword here has no name
    // of its own (that's what distinguishes an expression from a
    // declaration), so this pattern requires the `=` first.
    const exprRe = /\b(?:var|let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*function\s*\(/g;
    let m;
    while ((m = exprRe.exec(source))) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      expressions.push(name);
    }
    // `name = (` ... `) =>` or `name = x =>` — covers both the
    // parenthesized-params and single-bare-param arrow forms. Doesn't
    // attempt to handle a multi-line parameter list spanning a
    // newline before `=>` (rare for a script-sized helper function,
    // and a false negative here just means no warning is shown for
    // that one case — never a false rebind, since arrows are never
    // added to `expressions`).
    const arrowRe = /\b(?:var|let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g;
    while ((m = arrowRe.exec(source))) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      arrows.push(name);
    }
    return { expressions, arrows };
  }

  /**
   * Compiles + starts every Script instance on ONE entity. Shared by:
   *  - _initScripts() — the once-per-scene full pass over every SCRIPT
   *    entity present when the scene first starts.
   *  - _initNewInstances() — the lightweight per-frame pass that picks
   *    up any entity that DIDN'T exist yet at that first pass, i.e. one
   *    spawned at runtime via spawn() (see ScriptAPI.spawn),
   *    or any other Script-bearing entity created by engine code later.
   *
   * @param {import('../core/Entity.js').Entity} entity
   * @param {boolean} isClone true if this entity was created via
   *   spawn() — passed through so onClone() fires (and
   *   this.isClone reads true) for exactly those instances, matching
   *   Unity's convention that a runtime Instantiate()'d object's own
   *   scripts know they're a clone from their very first onStart().
   */
  _initEntityScripts(entity, isClone) {
    const script = entity.getComponent(SCRIPT);
    if (!script || !script.enabled || !script.source) return;

    const factory = this._compile(script.scriptName, script.source);
    if (!factory) return;

    try {
      const g = this.scriptApi.getGlobals();
      // Created BEFORE factory() runs — the generated source rebinds
      // each custom top-level function to this context inline (see
      // _compile()'s doc comment), which requires the context to
      // already exist as the __ctx argument, not something bolted on
      // to the returned handlers afterward.
      const context = this.scriptApi.createEntityContext(entity);
      if (isClone) context._isClone = true;
      const handlers = factory(
        g.findFirst, g.findAll, g.findWithTag, g.findFirstWithTag, g.findAllWithTag, g.findById, g.findInRadius,
        g.scene, g.physics, g.input, g.mouse, g.touch, g.time, g.random, g.mathx, g.smoothstep, g.global, g.save, g.debug,
        g.sendMessage, g.broadcastMessage, g.spawn, g.wait, g.cancelWait, g.repeat, g.cancelRepeat, g.tween, g.cancelTween, g.nav,
        console, Math, context
      );

      if (!this.instances.has(entity.id)) {
        this.instances.set(entity.id, []);
      }
      const inst = {
        handlers,
        context,
        scriptName: script.scriptName,
        enabled: true,
        started: false,
      };
      this.instances.get(entity.id).push(inst);

      // onClone fires ONCE, right before onStart, and ONLY for clones —
      // same try/catch/disable behavior as onStart below, since like
      // onStart it only ever runs once and there's no "next frame" to
      // retry a botched onClone on.
      if (isClone && inst.handlers.onClone) {
        try {
          this._invoke(inst, inst.handlers.onClone);
        } catch (err) {
          this._reportError(script.scriptName, err, "onClone");
          inst.enabled = false;
        }
      }

      if (inst.enabled && inst.handlers.onStart) {
        try {
          this._invoke(inst, inst.handlers.onStart);
          inst.started = true;
        } catch (err) {
          // onStart only ever runs once — there's no "next frame" to
          // retry it on, and letting onUpdate run against state
          // onStart never got to set up would likely just throw
          // again immediately. This is the one case that still
          // disables the instance; every other lifecycle call below
          // recovers on its own next frame instead.
          this._reportError(script.scriptName, err, "onStart");
          inst.enabled = false;
        }
      } else if (inst.enabled) {
        inst.started = true;
      }
    } catch (err) {
      this._reportError(script.scriptName, err, "init");
    }
  }

  _initScripts(world) {
    const entities = world.query(SCRIPT);
    for (const entity of entities) {
      this._initEntityScripts(entity, false);
    }
  }

  /**
   * Runs every frame (cheap: world.query(SCRIPT) is already an O(n)
   * active-entity scan RenderSystem/PhysicsWorld both also do every
   * frame — no extra bookkeeping needed) and compiles/starts scripts
   * for any SCRIPT entity that isn't in `this.instances` yet. This is
   * what makes a clone's onClone()/onStart() actually fire: spawn()
   * only creates the Entity + components (see SceneSerializer.cloneEntity)
   * — it never touches ScriptSystem directly — so without this pass a
   * clone's Script component would sit there compiled-but-never-run
   * forever, since the one-time _initScripts() pass already happened
   * before the clone existed.
   *
   * Also naturally covers any OTHER runtime-created Script entity
   * (e.g. a future spawn path that doesn't go through spawn() at all) —
   * "not in this.instances yet" is the only condition that matters,
   * not how the entity came to exist.
   */
  _initNewInstances(world) {
    const entities = world.query(SCRIPT);
    for (const entity of entities) {
      if (this.instances.has(entity.id)) continue;
      this._initEntityScripts(entity, !!entity.__isClone);
    }
  }

  _invoke(inst, handler, ...args) {
    const previous = this._activeContext;
    this._activeContext = inst.context;
    try {
      return handler.call(inst.context, ...args);
    } finally {
      this._activeContext = previous;
    }
  }

  /**
   * Starts a numeric-property tween for the active script context.
   *
   * `target` can be an EntityContext (`this` or findFirst(...)) or a
   * scripting component object (`this.sprite`, `this.transform`, etc.).
   * Only numeric properties that already exist and have numeric values
   * are animated. The owner context is captured so onComplete callbacks
   * use the same `this` as the script that started the tween.
   */
  _scheduleTween(target, properties, duration, easingName, onComplete) {
    const context = this._activeContext;
    if (!context) {
      if (typeof console !== "undefined") console.warn("[tween] Call tween() from onStart(), onUpdate(), onClick(), or another lifecycle callback.");
      return -1;
    }
    if (!target || (typeof target !== "object" && typeof target !== "function")) {
      if (typeof console !== "undefined") console.warn("[tween] target must be an entity context or a scripting component object.");
      return -1;
    }
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      if (typeof console !== "undefined") console.warn("[tween] properties must be an object, for example { x: 400, y: 240 }.");
      return -1;
    }
    if (onComplete != null && typeof onComplete !== "function") {
      if (typeof console !== "undefined") console.warn("[tween] onComplete must be a function when provided.");
      return -1;
    }

    const easingLabel = easingName == null || easingName === "" ? "linear" : String(easingName);
    const ease = resolveTweenEasing(easingLabel);
    if (!ease) {
      if (typeof console !== "undefined") {
        console.warn("[tween] Unknown easing '" + easingLabel + "'. Choose a supported value such as linear, easeOutCubic, easeInOutSine, easeOutBounce, or easeOutElastic.");
      }
      return -1;
    }

    const entries = [];
    for (const key of Object.keys(properties)) {
      // Avoid writing through prototype-sensitive property names.
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      const end = properties[key];
      if (typeof end !== "number" || !Number.isFinite(end)) continue;
      try {
        const start = target[key];
        if (typeof start !== "number" || !Number.isFinite(start)) continue;
        entries.push({ key, start, end });
      } catch (err) {
        if (typeof console !== "undefined") {
          console.warn("[tween] Skipping '" + key + "': " + (err && err.message ? err.message : String(err)));
        }
      }
    }
    if (entries.length === 0) {
      if (typeof console !== "undefined") console.warn("[tween] No tweenable numeric properties found. Check the target and property names.");
      return -1;
    }

    const time = Number(duration);
    const targetEntityId = (() => {
      try { return target._entity && target._entity.id ? target._entity.id : null; }
      catch (_) { return null; }
    })();
    const id = this._nextTweenId++;
    this._tweens.set(id, {
      id,
      target,
      targetEntityId,
      entries,
      duration: Number.isFinite(time) ? Math.max(0, time) : 0,
      elapsed: 0,
      easingName: easingLabel,
      ease,
      onComplete: onComplete || null,
      context,
      ownerEntityId: context._entity.id,
      ownerName: context._entity.name || "Entity",
    });
    return id;
  }

  /** Cancel one active tween. Returns true only when an active tween existed. */
  _cancelTween(tweenId) {
    const id = Number(tweenId);
    if (!Number.isFinite(id) || !this._tweens.has(id)) return false;
    this._tweens.delete(id);
    return true;
  }

  /** Cancel tweens owned by or directly targeting a destroyed entity. */
  _cancelTweensForEntity(entityId) {
    for (const [id, tween] of this._tweens) {
      if (tween.ownerEntityId === entityId || tween.targetEntityId === entityId) {
        this._tweens.delete(id);
      }
    }
  }

  /** Advance tweens once per frame, after user onUpdate callbacks. */
  _tickTweens(dt) {
    if (this._tweens.size === 0) return;
    const step = Number.isFinite(Number(dt)) ? Math.max(0, Number(dt)) : 0;
    for (const tween of [...this._tweens.values()]) {
      // Completion callbacks can create/cancel tweens; don't process an
      // entry that was removed since this snapshot was taken.
      if (this._tweens.get(tween.id) !== tween) continue;
      if (tween.ownerEntityId && this._world && !this._world.getEntity(tween.ownerEntityId)) {
        this._tweens.delete(tween.id);
        continue;
      }
      if (tween.targetEntityId && this._world && !this._world.getEntity(tween.targetEntityId)) {
        this._tweens.delete(tween.id);
        continue;
      }

      tween.elapsed += step;
      const progress = tween.duration <= 0 ? 1 : Math.min(1, tween.elapsed / tween.duration);
      let eased;
      try {
        eased = tween.ease(progress);
        if (!Number.isFinite(eased)) throw new Error("easing '" + tween.easingName + "' returned a non-finite value");
        for (const entry of tween.entries) {
          const value = progress >= 1 ? entry.end : entry.start + (entry.end - entry.start) * eased;
          tween.target[entry.key] = value;
        }
      } catch (err) {
        this._tweens.delete(tween.id);
        this._reportError(tween.ownerName, err, "tween");
        continue;
      }

      if (progress < 1) continue;
      this._tweens.delete(tween.id);
      if (!tween.onComplete) continue;

      const previousContext = this._activeContext;
      this._activeContext = tween.context;
      try {
        tween.onComplete.call(tween.context);
      } catch (err) {
        this._reportError(tween.ownerName, err, "tween onComplete");
      } finally {
        this._activeContext = previousContext;
      }
    }
  }

  /**
   * Shared scheduling logic behind wait() and repeat() — the engine's
   * equivalent of a beginner-friendly setTimeout/setInterval, but one
   * that plays correctly with entities being destroyed and scenes
   * restarting/switching (a plain setTimeout/setInterval would happily
   * keep firing against an entity — or an entire scene — that no
   * longer exists).
   *
   * ONE-SHOT vs REPEATING: `interval === null` means wait()'s "run
   * once" behavior — the timer is removed after it fires. A number
   * means repeat()'s "run every N seconds forever" behavior — see
   * _tickTimers() below for how re-arming works.
   *
   * OWNERSHIP: a timer is tied to whichever entity's script called
   * wait()/repeat() — read from this._activeContext, the same "who's
   * currently running" tracking _invoke() already maintains for every
   * other lifecycle call. That entity is the timer's owner:
   *   - if the OWNER is destroyed (this.destroy()) before the timer
   *     fires (or fires again, for repeat()), the timer is cancelled —
   *     see _flushDestroyed()'s call into _cancelTimersForEntity()
   *     below.
   *   - if the SCENE restarts or switches, ALL timers are cancelled —
   *     see destroy() below, the same whole-scene teardown that
   *     already clears every script instance.
   * Either way the callback simply never runs again; nothing throws,
   * nothing needs to check this.destroyed inside the callback itself.
   *
   * The callback runs with `this` bound to the OWNER's own
   * EntityContext (via _invoke, same as onUpdate/onStart/etc.), so
   * `this.x`, this.destroy(), this.wait(...) all work naturally inside
   * it, exactly like any other lifecycle method:
   *   function onStart() {
   *     wait(2, function () { this.visible = false; });
   *   }
   *
   * A timer scheduled from OUTSIDE any lifecycle call (e.g. accidentally
   * at top-level script scope, where there's no "current" entity) is
   * silently ignored, with a console warning — the same "no active
   * entity" situation this.destroy() and other this.* calls already
   * guard against elsewhere in this file.
   *
   * @param {number} seconds must be >= 0; 0 fires on the very next update()
   * @param {function} callback
   * @param {number|null} interval seconds between repeats (repeat()), or null for a one-shot (wait())
   * @returns {number} a timer id you can pass to cancelWait()/cancelRepeat(),
   *   or -1 if there was no active entity to own the timer
   */
  _scheduleTimer(seconds, callback, interval) {
    if (typeof callback !== "function") {
      if (typeof console !== "undefined") {
        const fnName = interval == null ? "wait" : "repeat";
        console.warn(`[${fnName}] second argument must be a function, e.g. ${fnName}(2, function() { ... })`);
      }
      return -1;
    }
    const context = this._activeContext;
    if (!context) {
      if (typeof console !== "undefined") {
        const fnName = interval == null ? "wait" : "repeat";
        console.warn(`[${fnName}] called outside a lifecycle function (onStart/onUpdate/etc.) — ignored, there's no entity to run it on`);
      }
      return -1;
    }
    const entityId = context._entity.id;
    const timer = {
      remaining: Math.max(0, Number(seconds) || 0),
      interval: interval == null ? null : Math.max(0, Number(interval) || 0),
      callback,
      context,
      id: this._nextTimerId++,
      cancelled: false,
    };
    if (!this._timers.has(entityId)) this._timers.set(entityId, []);
    this._timers.get(entityId).push(timer);
    return timer.id;
  }

  /** One-shot form — see _scheduleTimer()'s doc comment above for the
   *  full ownership/cancellation contract shared with repeat(). */
  _scheduleWait(seconds, callback) {
    return this._scheduleTimer(seconds, callback, null);
  }

  /**
   * Schedules `callback` to run every `seconds`, starting `seconds`
   * from now (same beat as Unity's InvokeRepeating with equal delay
   * and interval) — the beginner-friendly way to do "spawn an enemy
   * every 2 seconds" without hand-writing a self-rescheduling wait():
   *   function onStart() {
   *     repeat(2, function () {
   *       spawn("Enemy", { x: random.int(0, 800), y: 0 });
   *     });
   *   }
   * Runs FOREVER until you call cancelRepeat(id)/this.cancelRepeat(id),
   * the owning entity is destroyed, or the scene restarts/switches —
   * exactly the same auto-cancellation rules as wait(), since this is
   * literally the same timer mechanism underneath, just re-armed
   * instead of removed each time it fires. There is deliberately no
   * separate "forever loop" construct in this engine beyond onUpdate()
   * and repeat() — a real infinite loop (while(true)) would freeze the
   * tab, since scripts run synchronously within a single frame with no
   * yield point for the engine to keep rendering.
   * @param {number} seconds interval between calls, and also the delay before the first one
   * @param {function} callback
   * @returns {number} timer id usable with cancelRepeat()
   */
  _scheduleRepeat(seconds, callback) {
    return this._scheduleTimer(seconds, callback, seconds);
  }

  /**
   * Cancels a single pending timer by the id wait()/repeat() returned.
   * Works on BOTH kinds — a one-shot wait() or an ongoing repeat() —
   * since they're the same underlying timer object. Safe to call with
   * an id that already fired (wait()) or was already cancelled — a
   * no-op in both cases, same as the DOM's clearTimeout/clearInterval.
   * @param {number} timerId
   */
  _cancelWait(timerId) {
    for (const list of this._timers.values()) {
      for (const timer of list) {
        if (timer.id === timerId) {
          timer.cancelled = true;
          return;
        }
      }
    }
  }

  /** Alias of _cancelWait — cancelRepeat() and cancelWait() are
   *  literally the same operation under the hood (both just flag the
   *  timer as cancelled), kept as two names purely so repeat()'s API
   *  reads symmetrically with wait()'s rather than mixing vocabulary. */
  _cancelRepeat(timerId) {
    this._cancelWait(timerId);
  }

  /**
   * Cancels every pending timer owned by ONE entity — called from
   * _flushDestroyed() when that entity's own this.destroy() goes
   * through, so a wait() scheduled by a script never fires against an
   * entity (or reads a `this`) that's already gone.
   * @param {string} entityId
   */
  _cancelTimersForEntity(entityId) {
    this._timers.delete(entityId);
  }

  /**
   * Advances every pending timer by dt and fires any whose time is up.
   * Called once per frame from update(), after the regular onUpdate
   * pass — matches Unity's Invoke()/coroutine timing, which also
   * resolve after that frame's Update() has run.
   *
   * A ONE-SHOT timer (wait(), timer.interval === null) is removed once
   * it fires. A REPEATING timer (repeat(), timer.interval is a number)
   * is instead RE-ARMED with `remaining = interval` and kept — same
   * timer object, same id, so a cancelRepeat(id) issued at any point
   * still finds and stops it. Re-arming happens AFTER the callback
   * runs, so if that callback itself calls cancelRepeat() on its own
   * timer (or this.destroy()s its own entity), we check `cancelled`
   * again — and that the entity's timer list still exists at all —
   * before putting it back, rather than resurrecting a timer someone
   * just asked to stop.
   *
   * A timer firing is allowed to schedule ANOTHER wait()/repeat()
   * (including from inside its own callback) — that new timer simply
   * lands in next frame's pass. Iterates over a COPY of each entity's
   * list before writing the surviving ones back, so a callback that
   * itself calls wait()/repeat() again doesn't mutate the array while
   * this loop is still reading it.
   */
  _tickTimers(dt) {
    if (this._timers.size === 0) return;
    for (const [entityId, list] of this._timers) {
      const stillPending = [];
      for (const timer of list) {
        if (timer.cancelled) continue;
        timer.remaining -= dt;
        if (timer.remaining > 0) {
          stillPending.push(timer);
          continue;
        }
        const fnName = timer.interval == null ? "wait" : "repeat";
        // Run the callback with _activeContext set to its OWNER, the
        // same way _invoke() does for onStart/onUpdate/etc. Without
        // this, a callback that itself calls wait()/repeat() (e.g.
        // scheduling the next tick of an interval loop from inside a
        // wait() callback) sees this._activeContext as whatever it
        // last was left at — usually null, once a frame's normal
        // lifecycle calls have finished — and _scheduleTimer() then
        // either rejects the nested call with "called outside a
        // lifecycle function" or, worse, attaches it to whatever
        // unrelated entity happened to run last. Saving/restoring the
        // previous value (rather than just setting it) mirrors
        // _invoke() exactly, so nested timers stay correctly
        // attributed even if this ever runs re-entrantly.
        const previousContext = this._activeContext;
        this._activeContext = timer.context;
        try {
          timer.callback.call(timer.context);
        } catch (err) {
          this._reportError(
            (timer.context && timer.context._entity && timer.context._entity.name) || fnName + "()",
            err,
            fnName
          );
          // An erroring repeat() callback would just throw again next
          // interval forever, spamming the error log — stop it here,
          // same call _initEntityScripts makes for a bad onStart.
          continue;
        } finally {
          this._activeContext = previousContext;
        }
        // Re-arm if this is a repeat() timer that wasn't cancelled (or
        // its owning entity destroyed) from inside the callback itself.
        if (timer.interval != null && !timer.cancelled && this._timers.has(entityId)) {
          timer.remaining = timer.interval;
          stillPending.push(timer);
        }
      }
      if (stillPending.length > 0) {
        this._timers.set(entityId, stillPending);
      } else {
        this._timers.delete(entityId);
      }
    }
  }

  /** Called by GameLoop each frame, before update(): the real, unscaled frame time. */
  setUnscaledDelta(seconds) {
    this._unscaledDt = seconds;
  }

  update(world, dt) {
    // Stash world reference so sendMessage / broadcastMessage callbacks
    // (wired up in the constructor) can reach the entity list at call time.
    this._world = world;

    // BUG FIX: refresh the `touch` global's contents for this frame
    // BEFORE _initScripts()/_initNewInstances() (which compile new
    // scripts and call getGlobals() to hand each one its permanent
    // `touch` reference — see ScriptAPI's this._touchGlobal comment)
    // and BEFORE any onUpdate()/onFixedUpdate() below. Ordering this
    // first matters specifically for onStart(): a script that reads
    // touch.count during onStart() on the very first frame must see a
    // real 0/null baseline, not undefined fields on a brand-new,
    // never-yet-computed array. Running it once here (not once per
    // onFixedUpdate sub-step further down) also means every callback
    // that fires this frame — onStart, onFixedUpdate, and onUpdate —
    // sees the exact same touch snapshot, matching how keyPressed/
    // mouse.pressed pulses are likewise only cleared once per frame.
    if (this.scriptApi && this.scriptApi._recomputeTouchGlobal) {
      this.scriptApi._recomputeTouchGlobal();
    }

    if (!this._started) {
      this._started = true;
      this._initScripts(world);
    } else {
      // Picks up any Script entity that didn't exist during the pass
      // above — i.e. anything spawned at runtime via spawn()
      // since last frame. Skipped on the very first frame itself since
      // _initScripts() just did the identical work for the whole scene.
      this._initNewInstances(world);
    }

    // Update time
    this.scriptApi.time.deltaTime = dt;
    // Real frame time, unaffected by time.scale / pause (for menus and UI that
    // must keep animating while gameplay is frozen). Falls back to dt when no
    // GameLoop is driving this system (headless/tests).
    this.scriptApi.time.unscaledDeltaTime = this._unscaledDt != null ? this._unscaledDt : dt;
    this.scriptApi.time.elapsed += dt;

    // Fixed update accumulator
    this._fixedAccumulator += dt;
    while (this._fixedAccumulator >= FIXED_TIMESTEP) {
      this._tickFixed(world, FIXED_TIMESTEP);
      this._fixedAccumulator -= FIXED_TIMESTEP;
    }

    // Regular update
    for (const [entityId, instances] of this.instances) {
      const entity = world.getEntity(entityId);
      if (!entity || !entity.active) continue;
      for (const inst of instances) {
        if (!inst.enabled || !inst.handlers.onUpdate) continue;
        try {
          this._invoke(inst, inst.handlers.onUpdate, dt);
        } catch (err) {
          // Do NOT disable the instance — skip just this frame's call.
          // The rest of the game (and this entity's other lifecycle
          // methods) keeps running; onUpdate is tried again next frame.
          this._reportError(inst.scriptName, err, "onUpdate");
        }
      }
    }

    // onStateUpdate — runs every frame right after onUpdate, for EVERY
    // instance that declares it, regardless of whether this.state.change()
    // has ever been called on this entity: this.state.current defaults
    // to "default" (see StateAPI.js), so a script can branch on it from
    // frame one exactly like Unity's Animator starts in its default
    // state without an explicit transition. No gating beyond the usual
    // inst.enabled check — same error-isolation as onUpdate above (a
    // bad onStateUpdate this frame doesn't stop next frame's).
    for (const [entityId, instances] of this.instances) {
      const entity = world.getEntity(entityId);
      if (!entity || !entity.active) continue;
      for (const inst of instances) {
        if (!inst.enabled || !inst.handlers.onStateUpdate) continue;
        try {
          this._invoke(inst, inst.handlers.onStateUpdate, dt);
        } catch (err) {
          this._reportError(inst.scriptName, err, "onStateUpdate");
        }
      }
    }

    // onClick — fires on whichever entities were actually under the
    // pointer the SAME frame the (left) mouse button/a finger went
    // down. Only runs the real hit-test query when a click actually
    // happened this frame (mouse.pressed(0) is a one-frame pulse) —
    // no per-entity physics query on every ordinary frame, since a
    // click is a comparatively rare event next to onUpdate running
    // every single frame regardless.
    if (this.scriptApi) {
      // Collect every hit-test point that "went down" this frame:
      // the mouse's left button, PLUS every finger that just touched
      // down (there can be more than one in the same frame on a
      // multi-touch screen) — each is hit-tested and fires onClick
      // independently, same as the mouse case below.
      const downPoints = [];
      if (this.scriptApi._mouse && this.scriptApi._mouse.buttonsPressed.has(0)) {
        downPoints.push({ x: this.scriptApi._mouse.x, y: this.scriptApi._mouse.y });
      }
      if (this.scriptApi._touchesStarted && this.scriptApi._touchesStarted.size > 0) {
        for (const id of this.scriptApi._touchesStarted) {
          const t = this.scriptApi._touches.get(id);
          if (t) downPoints.push({ x: t.x, y: t.y });
        }
      }

      // Entities can end up hit more than once in the same frame (e.g.
      // two fingers down on the same entity) — onClick should still
      // only fire once per entity per frame, so track which instances
      // already ran.
      const firedInstances = new Set();
      for (const point of downPoints) {
        const clicked = this.scriptApi._entitiesAtPoint(point.x, point.y);
        for (const ctx of clicked) {
          const entityId = ctx._entity.id;
          const instances = this.instances.get(entityId);
          if (!instances) continue;
          for (const inst of instances) {
            if (!inst.enabled || !inst.handlers.onClick) continue;
            if (firedInstances.has(inst)) continue;
            firedInstances.add(inst);
            try {
              this._invoke(inst, inst.handlers.onClick);
            } catch (err) {
              this._reportError(inst.scriptName, err, "onClick");
            }
          }
        }
      }
    }

    // Fire any wait() timers whose time is up. Runs AFTER the regular
    // onUpdate pass (matches Unity's own Invoke()/coroutine timing) but
    // BEFORE _flushDestroyed() below, so a timer callback that calls
    // this.destroy() is picked up by the SAME frame's destroy flush
    // rather than sitting half-destroyed until next frame.
    this._tickTweens(dt);
    this._tickTimers(dt);

    // Clear per-frame input state (keyPressed only lasts one frame).
    //
    // BUG FIX — ORDERING: this used to run BEFORE the onUpdate loop
    // above (right after the fixed-update accumulator), which meant
    // input.keyPressed(key) was already wiped back to false by the time
    // ANY script's onUpdate() ran — the single most commonly used
    // per-frame callback. A script doing
    //   if (input.keyPressed("Space")) this.controller.simulateJump();
    // inside onUpdate would never see a true, because this line had
    // already cleared it moments earlier in the very same frame; only
    // onFixedUpdate (which runs BEFORE this point) ever had a chance to
    // observe a one-shot key press. Moved to the end of the frame — after
    // onUpdate — so BOTH onFixedUpdate and onUpdate observe the same
    // keyPressed state for the entire frame the key was actually pressed
    // on, and it's cleared only once every lifecycle callback has had
    // its turn.
    if (this.scriptApi && this.scriptApi._clearFrameKeys) {
      this.scriptApi._clearFrameKeys();
    }

    // Actually remove every entity queued this frame via this.destroy()
    // (see ScriptAPI.js's EntityContext.destroy()) — done LAST, after
    // every system (controller/physics/animation/render/this system's
    // own onUpdate above) has already had its pass for the frame, so
    // nothing reads a half-destroyed entity mid-frame. This is also
    // where onDestroy() actually fires for a per-entity destroy() call
    // (as opposed to a whole-scene teardown, which fires it via this
    // class's own destroy() method instead — see that method's doc
    // comment).
    this._flushDestroyed(world);
  }

  /**
   * Removes every entity queued via this.destroy() this frame: fires
   * onDestroy on that entity's own script instances (same try/catch/
   * report pattern as every other lifecycle call — a buggy onDestroy
   * doesn't stop the rest of cleanup), then drops its instances Map
   * entry and its cached EntityContext (scriptApi.clearContext), and
   * cancels any pending wait() timers it owns, so nothing keeps a stale
   * reference once World.flushDestroyed() below actually removes it —
   * the same reuse-safety clearContexts() exists
   * for on a whole-scene reload, just scoped to one entity here.
   * World.flushDestroyed() itself removes the entity from
   * world.entities; PhysicsWorld.step() and RenderSystem.update()
   * (next frame) then notice it's gone from their queries the same way
   * they already do for any entity removed via the editor's Delete —
   * no separate physics/render cleanup call is needed here.
   */
  _flushDestroyed(world) {
    const removedEntities = world.flushDestroyed();
    if (removedEntities.length === 0) return;
    for (const entity of removedEntities) {
      const instances = this.instances.get(entity.id);
      if (instances) {
        for (const inst of instances) {
          if (inst.enabled && inst.handlers.onDestroy) {
            try {
              this._invoke(inst, inst.handlers.onDestroy);
            } catch (err) {
              this._reportError(inst.scriptName, err, "onDestroy");
            }
          }
        }
        this.instances.delete(entity.id);
      }
      if (this.scriptApi && this.scriptApi.clearContext) {
        this.scriptApi.clearContext(entity.id);
      }
      // Any wait() this entity scheduled (and hasn't fired yet) dies
      // with it — see _scheduleWait()'s doc comment for why this
      // matters: without this, a timer started by an entity that gets
      // destroyed mid-countdown would still fire later against a
      // `this` that no longer exists in the world.
      this._cancelTimersForEntity(entity.id);
      this._cancelTweensForEntity(entity.id);
    }
  }

  _tickFixed(world, fixedDt) {
    for (const [entityId, instances] of this.instances) {
      const entity = world.getEntity(entityId);
      if (!entity || !entity.active) continue;
      for (const inst of instances) {
        if (!inst.enabled || !inst.handlers.onFixedUpdate) continue;
        try {
          this._invoke(inst, inst.handlers.onFixedUpdate, fixedDt);
        } catch (err) {
          this._reportError(inst.scriptName, err, "onFixedUpdate");
        }
      }
    }
  }

  /**
   * Called by PhysicsSystem when two entities collide. The ScriptSystem
   * forwards the event to each entity's onCollision handler with an
   * EntityContext for the other entity.
   */
  fireCollision(entityId, otherEntity, world) {
    const instances = this.instances.get(entityId);
    if (!instances) return;
    const otherContext = otherEntity ? this.scriptApi.createEntityContext(otherEntity) : null;
    for (const inst of instances) {
      if (!inst.enabled) continue;
      // Fire onCollision (legacy) and onCollisionEnter (preferred alias)
      if (inst.handlers.onCollision) {
        try {
            this._invoke(inst, inst.handlers.onCollision, otherContext);
        } catch (err) {
          this._reportError(inst.scriptName, err, "onCollision");
        }
      }
      if (inst.handlers.onCollisionEnter) {
        try {
            this._invoke(inst, inst.handlers.onCollisionEnter, otherContext);
        } catch (err) {
          this._reportError(inst.scriptName, err, "onCollisionEnter");
        }
      }
    }
  }

  fireCollisionExit(entityId, otherEntity, world) {
    const instances = this.instances.get(entityId);
    if (!instances) return;
    const otherContext = otherEntity ? this.scriptApi.createEntityContext(otherEntity) : null;
    for (const inst of instances) {
      if (!inst.enabled || !inst.handlers.onCollisionExit) continue;
      try {
        this._invoke(inst, inst.handlers.onCollisionExit, otherContext);
      } catch (err) {
        this._reportError(inst.scriptName, err, "onCollisionExit");
      }
    }
  }

  /**
   * Called every physics step by PhysicsWorld._dispatchCollisionStay for
   * every pair that's CURRENTLY in contact, regardless of whether the
   * contact started this frame or has been ongoing for many frames —
   * unlike fireCollision (enter) / fireCollisionExit above, which only
   * fire once each, on the frame the contact starts/ends respectively.
   * Same shape as those two on purpose, for the same reason: keep every
   * onCollision* handler dispatch looking identical so nothing about how
   * Enter/Exit/Stay are invoked needs to be learned separately.
   */
  fireCollisionStay(entityId, otherEntity, world) {
    const instances = this.instances.get(entityId);
    if (!instances) return;
    const otherContext = otherEntity ? this.scriptApi.createEntityContext(otherEntity) : null;
    for (const inst of instances) {
      if (!inst.enabled || !inst.handlers.onCollisionStay) continue;
      try {
        this._invoke(inst, inst.handlers.onCollisionStay, otherContext);
      } catch (err) {
        this._reportError(inst.scriptName, err, "onCollisionStay");
      }
    }
  }

  /**
   * Delivers a message to all script instances on a single entity.
   * Called by sendMessage() / broadcastMessage() (wired via ScriptAPI).
   *
   * @param {string}      entityId      target entity
   * @param {string}      message       arbitrary message name
   * @param {object|null} senderContext EntityContext of the sending entity (or null for broadcast)
   * @param {*}           data          optional payload
   */
  fireMessage(entityId, message, senderContext, data) {
    const instances = this.instances.get(entityId);
    if (!instances) return;
    for (const inst of instances) {
      if (!inst.enabled || !inst.handlers.onMessage) continue;
      try {
        if (inst.handlers.onMessage.length >= 3) {
          this._invoke(inst, inst.handlers.onMessage, message, senderContext, data);
        } else if (inst.handlers.onMessage.length === 2) {
          this._invoke(inst, inst.handlers.onMessage, message, data);
        } else {
          this._invoke(inst, inst.handlers.onMessage, message);
        }
      } catch (err) {
        this._reportError(inst.scriptName, err, "onMessage");
      }
    }
  }

  /**
   * Called by StateAPI.js's this.state.change(name) (via the changeFn
   * closure ScriptAPI wires up — see ScriptAPI.js's createEntityContext/
   * _buildSubObjects). Fires for EVERY script instance on the entity
   * (an entity can have more than one Script component, same as every
   * other lifecycle dispatch here), in this order:
   *   1. onStateExit()  — old state is still ctx._stateBacking.current
   *      while this runs, so it can read "which state am I leaving".
   *   2. current/previous updated on the shared backing object.
   *   3. onStateEnter()  — new state is now current.
   * No-op entirely (no exit/enter, no current/previous change) if
   * `name` already equals the current state — see StateAPI.js's header
   * comment for why that matches Unity Animator's own "same state, no
   * transition" behavior.
   * @param {string} entityId
   * @param {string} name
   * @param {object} ctx   the EntityContext whose _stateBacking owns
   *   current/previous — passed straight through from StateAPI so this
   *   method never needs to look the entity back up by id.
   */
  fireStateChange(entityId, name, ctx) {
    const backing = ctx._stateBacking;
    if (!backing || backing.current === name) return;

    const instances = this.instances.get(entityId);

    if (instances) {
      for (const inst of instances) {
        if (!inst.enabled || !inst.handlers.onStateExit) continue;
        try {
          this._invoke(inst, inst.handlers.onStateExit);
        } catch (err) {
          this._reportError(inst.scriptName, err, "onStateExit");
        }
      }
    }

    backing.previous = backing.current;
    backing.current = name;

    if (instances) {
      for (const inst of instances) {
        if (!inst.enabled || !inst.handlers.onStateEnter) continue;
        try {
          this._invoke(inst, inst.handlers.onStateEnter);
        } catch (err) {
          this._reportError(inst.scriptName, err, "onStateEnter");
        }
      }
    }
  }

  /**
   * Called by AudioListenerSystem once per newly-in-range AudioSource,
   * per listener, per frame (see that file's update()). Fires
   * onHearSound(source) for every script instance on the LISTENER
   * entity, with `source` as an EntityContext for the AudioSource
   * entity that just came into range — same otherContext-building
   * pattern fireCollision/fireTrigger already use for their `other`
   * parameter.
   * @param {string} listenerEntityId
   * @param {string} sourceEntityId
   * @param {import('../core/World.js').World} world
   */
  fireHearSound(listenerEntityId, sourceEntityId, world) {
    const instances = this.instances.get(listenerEntityId);
    if (!instances) return;
    const sourceEntity = world.getEntity(sourceEntityId);
    const sourceContext = sourceEntity ? this.scriptApi.createEntityContext(sourceEntity) : null;
    for (const inst of instances) {
      if (!inst.enabled || !inst.handlers.onHearSound) continue;
      try {
        this._invoke(inst, inst.handlers.onHearSound, sourceContext);
      } catch (err) {
        this._reportError(inst.scriptName, err, "onHearSound");
      }
    }
  }

  /** Counterpart to fireHearSound — fired once per AudioSource entity
   *  that just left a listener's radius (or was destroyed/removed
   *  while in range). Same shape as fireHearSound; see its doc comment. */
  fireLoseSound(listenerEntityId, sourceEntityId, world) {
    const instances = this.instances.get(listenerEntityId);
    if (!instances) return;
    const sourceEntity = world.getEntity(sourceEntityId);
    const sourceContext = sourceEntity ? this.scriptApi.createEntityContext(sourceEntity) : null;
    for (const inst of instances) {
      if (!inst.enabled || !inst.handlers.onLoseSound) continue;
      try {
        this._invoke(inst, inst.handlers.onLoseSound, sourceContext);
      } catch (err) {
        this._reportError(inst.scriptName, err, "onLoseSound");
      }
    }
  }

  fireTrigger(entityId, otherEntity, world, isEnter) {
    const instances = this.instances.get(entityId);
    if (!instances) return;
    const otherContext = otherEntity ? this.scriptApi.createEntityContext(otherEntity) : null;
    const handlerName = isEnter ? "onTriggerEnter" : "onTriggerExit";
    for (const inst of instances) {
      if (!inst.enabled || !inst.handlers[handlerName]) continue;
      try {
        this._invoke(inst, inst.handlers[handlerName], otherContext);
      } catch (err) {
        this._reportError(inst.scriptName, err, handlerName);
      }
    }
  }

  /**
   * Whole-scene teardown, called by runtime/index.js on BOTH scene
   * restart and scene switch — fires onDestroy for every remaining
   * script instance (a restarting/switching scene still means every
   * entity in it is going away), then wipes every timer regardless of
   * which entity owns it: unlike the single-entity case in
   * _flushDestroyed(), there's no "still running" entity left to check
   * against here — the ENTIRE world is being torn down, so every
   * pending wait() everywhere is cancelled unconditionally. Without
   * this, a wait(10, ...) started just before a restart would still be
   * sitting in this._timers and fire 10 seconds later against a
   * `this` from the OLD scene, even though the player is now several
   * seconds into a brand new one.
   */
  destroy() {
    for (const [, instances] of this.instances) {
      for (const inst of instances) {
        if (inst.enabled && inst.handlers.onDestroy) {
          try {
            this._invoke(inst, inst.handlers.onDestroy);
          } catch (err) {
            this._reportError(inst.scriptName, err, "onDestroy");
          }
        }
      }
    }
    this.instances.clear();
    this._timers.clear();
    this._tweens.clear();
    this._started = false;
    this._fixedAccumulator = 0;
    this._activeContext = null;
    this._errorThrottle.clear();
  }
}
