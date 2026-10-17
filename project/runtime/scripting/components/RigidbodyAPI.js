/**
 * runtime/scripting/components/RigidbodyAPI.js
 *
 * The `this.rigidbody` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the general rationale.
 *
 * IMPORTANT — body-type-aware API surface:
 * Unlike the old single-shape rigidbody object, this file builds a
 * DIFFERENT api shape depending on the entity's actual
 * Rigidbody2D.bodyType, matching Unity's own convention of hiding/
 * rejecting operations that don't make physical sense for a given body
 * type:
 *   - Dynamic:   full force/impulse/torque API (addForce, addImpulse,
 *                addTorque, addAngularImpulse) plus velocity + mass +
 *                gravityScale — Rapier's solver owns the body.
 *   - Kinematic: velocity (used to DRIVE the body via the character
 *                controller sweep) + move(dx, dy) for a one-shot swept
 *                nudge, + grounded/resolvedVelocity (read-only, real
 *                sweep results) — but NO addForce/addImpulse, since a
 *                kinematic body has infinite mass and Rapier never
 *                integrates forces into it (calling addForce on one is
 *                a silent no-op in raw Rapier, which is exactly the
 *                confusing footgun this file exists to prevent).
 *   - Static:    read-only stub — a static body never moves by
 *                definition, so every mutator throws a clear, actionable
 *                error instead of silently doing nothing.
 *
 * The one member that is WRITABLE on every body type is `type` itself:
 * `this.rigidbody.type = "Dynamic"` switches the body live (see
 * _setBodyType below for exactly what that does and doesn't preserve).
 * That's how a Static object gets made to move, or a Dynamic one gets
 * pinned in place, from a script.
 *
 * Calling a method the current body type doesn't support THROWS a
 * descriptive Error (rather than silently no-op-ing) so ScriptSystem's
 * existing per-lifecycle try/catch (see systems/ScriptSystem.js)
 * reports it to the editor console exactly like any other script bug —
 * "why isn't my kinematic enemy moving with addForce" becomes an
 * immediate, readable error instead of a silent mystery.
 *
 * IMPLEMENTATION NOTE — why the "unsupported on this body type" checks
 * live in the Proxy, not as throwing getters inside each body-type's
 * object literal: `Object.assign(target, { get x() { throw ... } })`
 * (or any object literal with a throwing getter) evaluates that getter
 * IMMEDIATELY while building the source object, not lazily when
 * something later reads `.x`. A throwing getter placed straight in one
 * of the _create*API object literals below would crash API
 * CONSTRUCTION itself, not just misuse of it. So instead, each body
 * type's object literal only defines what it actually supports, and
 * MEMBERS_BY_TYPE (below) records which extra names are valid on OTHER
 * body types — the Proxy consults that map to tell "wrong body type"
 * (throws unsupported-body-type) apart from "not a real member at all"
 * (throws unknown-api).
 *
 * RUNTIME-ONLY FILE.
 */

import { RIGIDBODY_2D, BodyType, bodyTypeSwitchHandled, clearPendingBodyRequests, queueForceAtPoint } from "../../components/Rigidbody2D.js";

function _rb(entity) {
  return entity.getComponent(RIGIDBODY_2D);
}

/** Tags an Error with a machine-readable `kind` so ScriptSystem can
 *  format a specific, actionable console message instead of a generic
 *  "X is not a function" — see ScriptSystem.js's _formatError(). */
function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _missingComponentError(entity, member) {
  return _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.rigidbody." + member +
    " but has no Rigidbody 2D. Add one in the Inspector (Add Component → Rigidbody 2D)."
  ), "missing-component");
}

function _unknownMemberError(entity, bodyType, member) {
  return _tag(new Error(
    "this.rigidbody." + member + " does not exist. Check the spelling — " +
    "see the autocomplete list for this.rigidbody on a " + bodyType + " body."
  ), "unknown-api");
}

const DYNAMIC_NO_PER_AXIS_CONTACT_WHY =
  "Dynamic bodies only track isGrounded (via their Character Controller, if any) — " +
  "Rapier's own solver handles wall/ceiling/slope contacts directly and this engine " +
  "does not track them per-axis for Dynamic. Use this.controller.isOnWall/isOnCeiling/" +
  "isOnSlope/groundAngle if you need this, or switch Body Type to Kinematic in the Inspector.";

function _unsupportedError(bodyType, member) {
  var isPerAxisContactMember = bodyType === BodyType.DYNAMIC &&
    (member === "isOnWall" || member === "isOnCeiling" || member === "isOnSlope" || member === "groundAngle");
  return _tag(new Error(
    "rigidbody." + member + " is not available on a " + bodyType +
    " body. " +
    (isPerAxisContactMember
      ? DYNAMIC_NO_PER_AXIS_CONTACT_WHY
      : bodyType === BodyType.STATIC
      ? "Static bodies never move — change the Body Type to Dynamic or Kinematic in the Inspector if this object needs to move."
      : bodyType === BodyType.KINEMATIC
      ? "Kinematic bodies are moved directly (use rigidbody.velocity or rigidbody.move(dx, dy)), not by forces — Rapier never applies forces/impulses to a kinematic body. Use Dynamic if you want physics-driven forces."
      : "This body type does not support that operation.")
  ), "unsupported-body-type");
}

/**
 * `this.rigidbody.type = "Dynamic" | "Kinematic" | "Static"` — switches
 * the body's type live, mid-game. The three per-type API objects below
 * all route their `type` setter here so the rules live in one place.
 *
 * What is safe about it: PhysicsWorld._syncEntity already rebuilds the
 * Rapier body (and re-attaches the collider) whenever it sees a
 * different Rigidbody2D.bodyType from the one it built — the exact same
 * path the Inspector's Body Type dropdown takes. And this file's Proxy
 * re-reads bodyType on every access, so right after the switch
 * `this.rigidbody` already exposes the NEW type's members. (For
 * autocomplete after a switch, cast: `(this.rigidbody as DynamicBody)`.)
 *
 * What a script needs to know (documented in the autocomplete text too):
 *   - The switch takes effect at the next physics step, not instantly.
 *   - Velocity is NOT reset. Dynamic -> Kinematic keeps drifting at the
 *     old velocity (kinematic velocity is sticky), so set
 *     `this.rigidbody.velocity = { x: 0, y: 0 }` to freeze it.
 *     Kinematic -> Dynamic starts from rest (a new Rapier body has none).
 *   - Force/impulse/move requests queued BEFORE the switch are dropped;
 *     ones queued AFTER it (same frame is fine) apply to the new body.
 *
 * Accepts the exact BodyType strings, case-insensitively. Anything else
 * throws instead of being stored — an unrecognized bodyType would leave
 * the body in a state no API object exists for.
 */
function _setBodyType(entity, value) {
  var r = _rb(entity);
  if (!r) throw _missingComponentError(entity, "type");

  var next = null;
  if (typeof value === "string") {
    var wanted = value.trim().toLowerCase();
    var known = Object.keys(BodyType);
    for (var i = 0; i < known.length; i++) {
      if (BodyType[known[i]].toLowerCase() === wanted) { next = BodyType[known[i]]; break; }
    }
  }
  if (!next) {
    throw new Error(
      "this.rigidbody.type must be \"Dynamic\", \"Kinematic\" or \"Static\" (got " +
      (typeof value === "string" ? JSON.stringify(value) : typeof value + " " + String(value)) + ")."
    );
  }
  if (next === r.bodyType) return; // already that type — nothing to rebuild

  // Drop requests queued for the OLD type now, then tell PhysicsWorld
  // it doesn't need to (and mustn't) do it again at rebuild time — see
  // Rigidbody2D.js's bodyTypeSwitchHandled for why.
  clearPendingBodyRequests(r);
  r.bodyType = next;
  bodyTypeSwitchHandled.add(r);
}

/** DYNAMIC: full force/impulse/torque API. Rapier's solver owns everything. */
function _createDynamicAPI(entity) {
  return {
    get type() { var r = _rb(entity); return r ? r.bodyType : null; },
    set type(v) { _setBodyType(entity, v); },

    // IMPORTANT #1: for a Dynamic body, rb.velocityX/Y is READ-BACK-ONLY —
    // PhysicsWorld.js overwrites it every step with whatever Rapier's
    // solver actually computed (gravity, collisions, etc), so writing
    // to it here would just get silently clobbered next frame and the
    // object would never actually move. Setting velocity on a Dynamic
    // body instead writes rb.driveVelocityX/Y — the same one-shot
    // "seed Rapier's setLinvel this step" field ControllerSystem uses
    // (see components/Rigidbody2D.js's doc comment and
    // PhysicsWorld.js's driveVelocityX handling) — so a script setting
    // this.rigidbody.velocity actually moves the body, same as a
    // Character Controller does.
    //
    // IMPORTANT #2: unlike Kinematic (where velocity is STICKY — set it
    // once and it keeps applying every frame until changed), Dynamic's
    // driveVelocityX/Y is deliberately ONE-SHOT: PhysicsWorld.js resets
    // it to null right after applying it each physics step, then lets
    // Rapier's own solver take back over (gravity, drag, collisions).
    // So `this.rigidbody.velocity = {x:5,y:0}` in onStart() only takes
    // effect for a single step on a Dynamic body — call it every frame
    // (e.g. in onUpdate) if you want it to keep holding that speed, the
    // same way addForce() needs to be called every frame to sustain a
    // push. If you want truly persistent, code-driven velocity that
    // doesn't fight gravity/collisions between updates, use a Kinematic
    // body instead.
    get velocity() { var r = _rb(entity); return r ? { x: r.velocityX, y: r.velocityY } : { x: 0, y: 0 }; },
    set velocity(v) {
      var r = _rb(entity);
      if (r) { r.driveVelocityX = v.x; r.driveVelocityY = v.y; }
    },
    get velocityX() { var r = _rb(entity); return r ? r.velocityX : 0; },
    set velocityX(v) { var r = _rb(entity); if (r) r.driveVelocityX = v; },
    get velocityY() { var r = _rb(entity); return r ? r.velocityY : 0; },
    set velocityY(v) { var r = _rb(entity); if (r) r.driveVelocityY = v; },

    get mass() { var r = _rb(entity); return r ? r.mass : 1; },
    set mass(v) { var r = _rb(entity); if (r) r.mass = v; },
    get gravityScale() { var r = _rb(entity); return r ? r.gravityScale : 1; },
    set gravityScale(v) { var r = _rb(entity); if (r) r.gravityScale = v; },
    get linearDamping() { var r = _rb(entity); return r ? r.linearDamping : 0; },
    set linearDamping(v) { var r = _rb(entity); if (r) r.linearDamping = v; },
    get angularDamping() { var r = _rb(entity); return r ? r.angularDamping : 0; },
    set angularDamping(v) { var r = _rb(entity); if (r) r.angularDamping = v; },

    /** Continuous force (Newtons-equivalent) — call every frame to sustain a push, like Unity's Rigidbody2D.AddForce. */
    addForce: function (x, y) {
      var r = _rb(entity);
      if (!r) return;
      r.pendingForceX += Number(x) || 0;
      r.pendingForceY += Number(y) || 0;
    },
    /**
     * Applies a force at a world-space point. Unlike addForce(), which acts
     * through the center of mass, this can also create the physically correct
     * torque when the point is offset from the body. Multiple point forces in
     * one frame are supported and are accumulated outside the serializable
     * Rigidbody2D component.
     */
    addForceAtPoint: function (x, y, pointX, pointY) {
      var r = _rb(entity);
      if (!r) return;
      queueForceAtPoint(
        r,
        Number(x) || 0, Number(y) || 0,
        Number(pointX) || 0, Number(pointY) || 0
      );
    },
    /** Instantaneous velocity change (impulse = mass * delta-v), applied once. */
    addImpulse: function (x, y) {
      var r = _rb(entity);
      if (!r) return;
      r.pendingImpulseX += x;
      r.pendingImpulseY += y;
    },
    /** Continuous rotational force — call every frame to sustain a spin. */
    addTorque: function (t) {
      var r = _rb(entity);
      if (!r) return;
      r.pendingTorque += t;
    },
    /** Instantaneous angular velocity change, applied once. */
    addAngularImpulse: function (t) {
      var r = _rb(entity);
      if (!r) return;
      r.pendingAngularImpulse += t;
    },

    /**
     * True when this Dynamic body's own CharacterController (if any) has
     * computed it as grounded this frame — see ControllerSystem.js's
     * _applyDynamic(), which is the only thing that ever writes
     * Rigidbody2D.grounded for a Dynamic body. A plain Dynamic body with
     * NO CharacterController component has nothing computing this at
     * all, so it correctly reads false (there is no ground-contact
     * concept for physics-only bodies bumping around under gravity —
     * only a Character Controller has "am I standing on something"
     * semantics). Previously this getter was hardcoded to always return
     * false even WITH a CharacterController attached, so scripts using
     * this.rigidbody.grounded (rather than the equivalent
     * this.controller.isGrounded) on a Dynamic Character Controller
     * silently always read not-grounded — reading the live field here
     * fixes that without changing behavior for bodies that have nothing
     * populating it.
     *
     * isGrounded is the SAME value under the canonical name used
     * everywhere else in the API (this.controller.isGrounded, Kinematic's
     * this.rigidbody.isGrounded) — grounded is kept only as a deprecated
     * alias for old scripts. Prefer isGrounded in new code.
     *
     * NOTE: unlike Kinematic, Dynamic has NO isOnWall/isOnCeiling/
     * isOnSlope/groundAngle equivalent — Rapier's own solver handles
     * those contacts directly for Dynamic bodies and this engine does
     * not track them per-axis, so those members are deliberately absent
     * here rather than added with a fake/stale value. Use
     * this.controller.isOnSlope etc. instead, which throws a clear
     * "Dynamic has no per-axis contact tracking" style error consistent
     * with the rest of this API rather than silently lying.
     */
    get isGrounded() { var r = _rb(entity); return r ? r.grounded : false; },
    /** Deprecated alias for isGrounded — kept for compatibility with existing scripts. */
    get grounded() { var r = _rb(entity); return r ? r.grounded : false; },
  };
}

/** KINEMATIC: velocity drives the character-controller sweep; move()
 * is a one-shot swept nudge; grounded/resolvedVelocity are read-only
 * results of that sweep. No force/impulse/torque — Rapier never
 * integrates forces into a kinematic body. */
function _createKinematicAPI(entity) {
  return {
    get type() { var r = _rb(entity); return r ? r.bodyType : null; },
    set type(v) { _setBodyType(entity, v); },

    get velocity() { var r = _rb(entity); return r ? { x: r.velocityX, y: r.velocityY } : { x: 0, y: 0 }; },
    set velocity(v) {
      var r = _rb(entity);
      if (r) { r.velocityX = v.x; r.velocityY = v.y; }
    },
    get velocityX() { var r = _rb(entity); return r ? r.velocityX : 0; },
    set velocityX(v) { var r = _rb(entity); if (r) r.velocityX = v; },
    get velocityY() { var r = _rb(entity); return r ? r.velocityY : 0; },
    set velocityY(v) {
      var r = _rb(entity);
      if (r) {
        const nextVelocityY = Number(v) || 0;
        r.velocityY = nextVelocityY;
        // A Kinematic controller also owns its internal vertical-velocity
        // state. Mark direct script writes so ControllerSystem does not
        // overwrite a script-authored jump on the next Platformer tick.
        r._scriptVelocityY = nextVelocityY;

        // A freshly-authored upward velocity is a takeoff command. The
        // previous physics step may still have left a floor manifold alive
        // for this frame, so leaving `grounded` true here lets a custom
        // script such as `if (isGrounded) velocityY = 0;` immediately cancel
        // its own jump on the following update. Clear only for an explicit
        // upward command; landing/ordinary downward motion continues to be
        // determined by Rapier's real contact state. This is intentionally
        // independent of rotation, so Geometry-style mid-air spinning can
        // happen without changing the jump lifecycle.
        if (nextVelocityY < -0.001) r.grounded = false;
      }
    },

    /** One-shot swept move for this frame (in addition to any standing velocity), blocked/slid by obstacles just like velocity movement. */
    move: function (dx, dy) {
      var r = _rb(entity);
      if (!r) return;
      r.pendingMoveX = (r.pendingMoveX || 0) + dx;
      r.pendingMoveY = (r.pendingMoveY || 0) + dy;
    },

    /** True when the character controller's sweep says the body is on the ground. */
    get isGrounded() { var r = _rb(entity); return r ? r.grounded : false; },
    /** Deprecated alias for isGrounded — kept for compatibility with existing scripts. */
    get grounded() { var r = _rb(entity); return r ? r.grounded : false; },
    /** True when the controller has detected a ceiling contact above the body. */
    get isOnCeiling() { var r = _rb(entity); return r ? r.isOnCeiling : false; },
    /** True when the controller has detected a wall contact on either side. */
    get isOnWall() { var r = _rb(entity); return r ? r.isOnWall : false; },
    /** True when the body is grounded on a sloped surface (groundAngle >= slopeMinAngle). */
    get isOnSlope() { var r = _rb(entity); return r ? r.isOnSlope : false; },
    /**
     * The ACTUAL angle (degrees) of the steepest walkable ground/slope
     * contact this step, measured from flat horizontal (0 = flat floor,
     * up to groundAngleLimit = the steepest surface still classified as
     * ground rather than a wall). 0 when not touching any walkable
     * surface. This is the live, per-frame computed value — NOT a
     * setting; use groundAngleLimit/wallAngleLimit/slopeMinAngle below
     * to configure the thresholds that decide how this value gets
     * classified into isOnSlope/isOnWall.
     * Example: if (this.rigidbody.groundAngle > 20) { ...on a ramp... }
     */
    get groundAngle() { var r = _rb(entity); return r ? r.groundAngle : 0; },
    /** The ACTUAL (possibly blocked/slid) movement achieved last step — use this instead of velocity to check "did I really move?". */
    get resolvedVelocity() {
      var r = _rb(entity);
      return r ? { x: r.resolvedVelocityX, y: r.resolvedVelocityY } : { x: 0, y: 0 };
    },

    /**
     * Maximum angle from horizontal (degrees) that counts as walkable
     * ground for THIS body. Contacts steeper than this are walls or
     * unclimbable slopes. Default 45.
     * Example: this.rigidbody.groundAngleLimit = 60
     */
    get groundAngleLimit() { var r = _rb(entity); return r ? r.groundAngleLimit : 45; },
    set groundAngleLimit(v) { var r = _rb(entity); if (r) r.groundAngleLimit = v; },

    /**
     * Contacts between groundAngleLimit and this angle (degrees) are
     * "too steep" but NOT walls. Only contacts at or above this angle
     * (nearly vertical) set isOnWall. Default 70.
     * Example: this.rigidbody.wallAngleLimit = 80
     */
    get wallAngleLimit() { var r = _rb(entity); return r ? r.wallAngleLimit : 70; },
    set wallAngleLimit(v) { var r = _rb(entity); if (r) r.wallAngleLimit = v; },

    /**
     * Minimum groundAngle (degrees) before isOnSlope becomes true.
     * Contacts below this are treated as flat ground. Default 10.
     * Must not be higher than groundAngleLimit if you want a surface to be
     * able to report BOTH isGrounded and isOnSlope. Equality is inclusive,
     * so a surface exactly at both thresholds can report both states. A
     * higher slopeMinAngle leaves no overlap and logs a warning once.
     * Example: this.rigidbody.slopeMinAngle = 15
     */
    get slopeMinAngle() { var r = _rb(entity); return r ? r.slopeMinAngle : 10; },
    set slopeMinAngle(v) { var r = _rb(entity); if (r) r.slopeMinAngle = v; },

    get gravityScale() { return 0; },
  };
}

/** STATIC: read-only stub. A static body never moves by definition —
 * every member below is read-only or a fixed zero value; anything
 * that would mutate it (or any Dynamic/Kinematic-only member) is
 * handled by the Proxy's unsupported-body-type check instead of being
 * defined here. */
function _createStaticAPI(entity) {
  return {
    get type() { var r = _rb(entity); return r ? r.bodyType : BodyType.STATIC; },
    set type(v) { _setBodyType(entity, v); },
    get velocity() { return { x: 0, y: 0 }; },
    get velocityX() { return 0; },
    get velocityY() { return 0; },
    get grounded() { return false; },
  };
}

// Every member name that exists on AT LEAST ONE body type. Used by the
// Proxy to tell "this doesn't exist anywhere" (unknown-api / a typo)
// apart from "this exists, but not for the CURRENT body type"
// (unsupported-body-type — e.g. addForce on Kinematic/Static).
const ALL_KNOWN_MEMBERS = new Set([
  "type", "velocity", "velocityX", "velocityY", "mass", "gravityScale",
  "linearDamping", "angularDamping", "addForce", "addForceAtPoint", "addImpulse",
  "addTorque", "addAngularImpulse", "move", "grounded", "isGrounded",
  "isOnCeiling", "isOnWall", "isOnSlope", "groundAngle",
  "resolvedVelocity",
  "groundAngleLimit", "wallAngleLimit", "slopeMinAngle",
]);

/**
 * Builds the `this.rigidbody` object for a given entity, LIVE-checking
 * the entity's current Rigidbody2D.bodyType on every property/method
 * access (via a Proxy) so the exposed API always matches reality even
 * if a script changes bodyType at runtime (e.g. switching an object
 * from Kinematic to Dynamic mid-game) — no stale API shape from the
 * moment the script started.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createRigidbodyAPI(entity) {
  var apis = {}; // built lazily, one object per body type, cached

  function _current() {
    var r = _rb(entity);
    var bodyType = r ? r.bodyType : BodyType.STATIC;
    if (!apis[bodyType]) {
      if (bodyType === BodyType.DYNAMIC) apis[bodyType] = _createDynamicAPI(entity);
      else if (bodyType === BodyType.KINEMATIC) apis[bodyType] = _createKinematicAPI(entity);
      else apis[bodyType] = _createStaticAPI(entity);
    }
    return apis[bodyType];
  }

  return new Proxy(
    {},
    {
      get: function (_target, prop) {
        if (typeof prop === "symbol") return undefined;
        var key = String(prop);
        if (key === "then") return undefined; // avoid Promise-like duck-typing false positives
        // No Rigidbody2D component at all — distinct from "wrong body
        // type", since adding ANY Rigidbody 2D fixes this, whereas
        // "wrong body type" needs a specific type change.
        if (!_rb(entity)) throw _missingComponentError(entity, key);

        var current = _current();
        if (key in current) {
          var value = current[key];
          // Re-bind methods so `this` inside them still resolves via
          // the real per-body-type object, not this Proxy wrapper.
          return typeof value === "function" ? value.bind(current) : value;
        }
        if (ALL_KNOWN_MEMBERS.has(key)) {
          throw _unsupportedError(current.type || "?", key);
        }
        throw _unknownMemberError(entity, current.type || "?", key);
      },
      set: function (_target, prop, value) {
        var key = String(prop);
        if (!_rb(entity)) throw _missingComponentError(entity, key);
        var current = _current();
        if (key in current) {
          // Generic read-only guard: ANY property defined with only a
          // getter (no setter) in _createDynamicAPI/_createKinematicAPI/
          // _createStaticAPI's object literals — e.g. type, isGrounded,
          // isOnCeiling, resolvedVelocity, Static's velocity, Kinematic's
          // gravityScale, etc. Without this check, `current[key] = value`
          // below would still run and throw JavaScript's own generic
          // "Cannot set property X ... which has only a getter"
          // TypeError — technically correct, but untagged (falls through
          // ScriptSystem as a bare "script-error" with no specific
          // explanation) and not written for a script author to read.
          // This catches it FIRST with a clear, tagged, actionable
          // message instead, and — because it reads the descriptor
          // dynamically rather than a hard-coded list of names — it
          // automatically covers any future read-only field added to
          // any body type's API without needing a matching list update.
          var descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (descriptor && descriptor.get && !descriptor.set) {
            throw _tag(new Error(
              "rigidbody." + key + " is read-only on a " + (current.type || "?") +
              " body — it reflects the body's real simulated state and can't be set directly."
            ), "unsupported-body-type");
          }
          current[key] = value;
          return true;
        }
        if (ALL_KNOWN_MEMBERS.has(key)) {
          throw _unsupportedError(current.type || "?", key);
        }
        throw _unknownMemberError(entity, current.type || "?", key);
      },
      has: function (_target, prop) {
        var key = String(prop);
        return _rb(entity) ? key in _current() : ALL_KNOWN_MEMBERS.has(key);
      },
    }
  );
}
