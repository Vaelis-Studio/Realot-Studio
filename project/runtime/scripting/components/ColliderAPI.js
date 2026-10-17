/**
 * runtime/scripting/components/ColliderAPI.js
 *
 * The `this.collider` sub-object exposed to user scripts. Collider settings
 * remain plain component data; this file provides a safe live view of the
 * settings that are useful to gameplay scripts.
 *
 * Everything is read-only EXCEPT `isTrigger`, which a script can flip at
 * any time to make its collider solid or non-solid mid-game:
 *
 *   this.collider.isTrigger = true;   // pass-through; onTriggerEnter/Exit fire
 *   this.collider.isTrigger = false;  // solid again; onCollisionEnter/Exit fire
 *
 * That is safe because PhysicsWorld._syncCollider already re-checks
 * isTrigger every frame and rebuilds the Rapier collider (as a sensor
 * or a solid) when it changes — the same path the Inspector's checkbox
 * takes — so the flip takes effect at the next physics step. Note that a
 * trigger is not "no collision at all": overlaps still raise
 * onTriggerEnter/onTriggerExit, they just don't push anything apart.
 *
 * RUNTIME-ONLY FILE.
 */

import { COLLIDER_2D } from "../../components/Collider2D.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _requireCollider(entity) {
  const collider = entity.getComponent(COLLIDER_2D);
  if (!collider) {
    throw _tag(new Error(
      "'" + (entity.name || "Entity") + "' called this.collider but has no Collider 2D. " +
      "Add one in the Inspector (Add Component → Collider 2D)."
    ), "missing-component");
  }
  return collider;
}

// The only members a script may assign. Everything else in
// COLLIDER_MEMBERS is read-only (change it in the Inspector).
const COLLIDER_WRITABLE = new Set(["isTrigger"]);

const COLLIDER_MEMBERS = new Set([
  "shape", "width", "height", "radius", "capsuleHalfHeight",
  "capsuleRadius", "offset", "isTrigger", "isOneWayPlatform", "friction", "restitution",
  "density", "layer", "mask", "isColliding",
]);

export function createColliderAPI(entity, scriptApi) {
  const target = {
    get shape() { return _requireCollider(entity).shape; },
    get width() { return _requireCollider(entity).width; },
    get height() { return _requireCollider(entity).height; },
    get radius() { return _requireCollider(entity).radius; },
    get capsuleHalfHeight() { return _requireCollider(entity).capsuleHalfHeight; },
    get capsuleRadius() { return _requireCollider(entity).capsuleRadius; },
    get offset() {
      const c = _requireCollider(entity);
      return { x: c.offsetX, y: c.offsetY };
    },
    get isTrigger() { return !!_requireCollider(entity).isTrigger; },
    // Must be a real boolean: a string like "false" is truthy in JS, so
    // silently coercing it would turn `isTrigger = "false"` into true —
    // a hard-to-spot bug, so it throws instead.
    set isTrigger(v) {
      if (typeof v !== "boolean") {
        throw new Error(
          "this.collider.isTrigger must be true or false (got " +
          (typeof v === "string" ? JSON.stringify(v) : typeof v + " " + String(v)) + ")."
        );
      }
      _requireCollider(entity).isTrigger = v;
    },
    // Read-only, like every other member here except isTrigger —
    // PhysicsWorld.js's _syncCollider does pick up a live change to it
    // (it's a real Collider2D field the Inspector can set), scripts just
    // aren't given a setter for it.
    get isOneWayPlatform() { return !!_requireCollider(entity).isOneWayPlatform; },
    get friction() { return _requireCollider(entity).friction; },
    get restitution() { return _requireCollider(entity).restitution; },
    get density() { return _requireCollider(entity).density; },
    get layer() { return _requireCollider(entity).layer; },
    get mask() { return _requireCollider(entity).mask; },
    /**
     * True if this entity's collider is CURRENTLY touching a SOLID
     * collider — same "still in contact right now" state
     * onCollisionStay fires from, just readable on demand instead of
     * waiting for the next Stay callback. Two forms:
     *   this.collider.isColliding()        // touching ANYTHING right now?
     *   this.collider.isColliding(other)   // touching THIS specific entity?
     * ('other' is an EntityContext, e.g. from onCollisionEnter(other) or
     * findFirst(...) — same object every other collision-related API
     * hands you.) Only reflects SOLID collisions, same as onCollision*
     * — a pure trigger overlap always reads false here; check
     * onTriggerEnter/onTriggerExit for those instead.
     */
    isColliding(other) {
      if (!scriptApi || !scriptApi._isCollidingFn) return false;
      var otherId = other && other._entity ? other._entity.id : undefined;
      return scriptApi._isCollidingFn(entity.id, otherId);
    },
  };

  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      const key = String(prop);
      if (!(key in t) && !COLLIDER_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.collider." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(COLLIDER_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      const v = t[key];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set(t, prop, value) {
      const key = String(prop);
      if (COLLIDER_WRITABLE.has(key)) {
        t[key] = value; // goes through the validating setter above
        return true;
      }
      // A misspelled name is a different mistake from assigning to a real
      // read-only member — say which, instead of calling a typo "read-only".
      if (!COLLIDER_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.collider." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(COLLIDER_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      throw _tag(new Error(
        "this.collider." + key + " is read-only — only isTrigger can be changed from a script. " +
        "Change other Collider 2D settings in the Inspector."
      ), "unsupported-body-type");
    },
  });
}
