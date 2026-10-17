/**
 * runtime/scripting/components/TransformAPI.js
 *
 * The `this.transform` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component so each
 * can grow independently without turning ScriptAPI.js into a huge
 * grab-bag file (RULES.txt scripting/ folder convention).
 *
 * All property access reads/writes the entity's LIVE Transform
 * component data via closures over `entity` — there is no caching or
 * snapshotting, so `this.transform.position = {x, y}` takes effect
 * immediately.
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../../components/Transform.js";
import { markScriptPositionTarget } from "../../components/Rigidbody2D.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

const TRANSFORM_MEMBERS = new Set(["position", "rotation", "scale", "translate", "lookAt"]);

/**
 * Builds the `this.transform` object for a given entity.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createTransformAPI(entity) {
  const target = {
    get position() {
      var t = entity.getComponent(TRANSFORM);
      return t ? { x: t.x, y: t.y } : { x: 0, y: 0 };
    },
    set position(v) {
      var t = entity.getComponent(TRANSFORM);
      if (t) {
        t.x = v.x;
        t.y = v.y;
        // See Rigidbody2D.js's markScriptPositionTarget doc comment: a
        // Dynamic/Kinematic body owns its own position once created
        // (PhysicsWorld never re-syncs Transform->Rapier for those two
        // body types except through this flag), so without this a
        // script's this.transform.position = {...} would visibly
        // teleport for exactly one frame and then snap right back as
        // soon as the next physics step writes Rapier's real simulated
        // position back onto Transform.
        markScriptPositionTarget(entity, t.x, t.y);
      }
    },
    get rotation() {
      var t = entity.getComponent(TRANSFORM);
      return t ? t.rotation : 0;
    },
    set rotation(v) {
      var t = entity.getComponent(TRANSFORM);
      if (t) t.rotation = v;
    },
    get scale() {
      var t = entity.getComponent(TRANSFORM);
      return t ? { x: t.scaleX, y: t.scaleY } : { x: 1, y: 1 };
    },
    set scale(v) {
      var t = entity.getComponent(TRANSFORM);
      if (t) { t.scaleX = v.x; t.scaleY = v.y; }
    },
    translate: function (dx, dy) {
      var t = entity.getComponent(TRANSFORM);
      if (t) {
        t.translate(dx, dy);
        markScriptPositionTarget(entity, t.x, t.y);
      }
    },
    lookAt: function (x, y) {
      var t = entity.getComponent(TRANSFORM);
      if (t) t.rotation = Math.atan2(y - t.y, x - t.x) * 180 / Math.PI;
    },
  };
  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !TRANSFORM_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.transform." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(TRANSFORM_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var v = t[prop];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !TRANSFORM_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.transform." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(TRANSFORM_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      // Without this file having had a set trap at all before, writing
      // to this.transform.translate or .lookAt (methods, not settable
      // properties) would fall through to JS's own raw, untagged
      // TypeError. See AnimatorAPI.js's set trap for the same pattern.
      if (typeof t[key] === "function") {
        throw _tag(new Error(
          "this.transform." + key + " is a method, not a settable property — call it as this.transform." + key + "(...) instead of assigning to it."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
