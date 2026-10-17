/**
 * runtime/scripting/components/ShapeAPI.js
 *
 * The `this.shape` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the rationale.
 *
 * Mirrors ShapeRenderer's fields except `trianglePoints`, which (like
 * Light's polygon points) is edited via draggable gizmo handles in the
 * Scene view and stays editor-only.
 *
 * RUNTIME-ONLY FILE.
 */

import { SHAPE_RENDERER } from "../../components/ShapeRenderer.js";

/** Tags an Error with a machine-readable `kind` so ScriptSystem can
 *  format a specific, actionable console message. */
function _tag(err, kind) {
  err.kind = kind;
  return err;
}

/** Throws a descriptive error when a script calls this.shape on an
 *  entity that has no ShapeRenderer. The error propagates through
 *  ScriptSystem's per-lifecycle try/catch and is reported to the editor
 *  console — same path as any other script runtime error. */
function _requireShape(entity) {
  var s = entity.getComponent(SHAPE_RENDERER);
  if (!s) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.shape but has no Shape Renderer. " +
    "Add one in the Inspector (Add Component → Shape Renderer)."
  ), "missing-component");
  return s;
}

const SHAPE_MEMBERS = new Set([
  "shapeType", "width", "height", "radius", "capsuleHalfHeight", "capsuleRadius",
  "fillColor", "opacity", "outlineEnabled", "outlineColor", "outlineWidth",
]);

/**
 * Builds the `this.shape` object for a given entity.
 * Accessing any property throws a clear error if the entity has no
 * ShapeRenderer, so the editor console shows exactly what is missing
 * instead of silently returning a default value. Accessing an unknown
 * property (typo) throws a distinct "does not exist" error rather than
 * silently returning undefined.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createShapeAPI(entity) {
  const target = {
    /** 'Square' | 'Circle' | 'Capsule' | 'Triangle' */
    get shapeType() { return _requireShape(entity).shapeType; },
    set shapeType(v) { _requireShape(entity).shapeType = v; },
    /** Square width in world units. */
    get width() { return _requireShape(entity).width; },
    set width(v) { _requireShape(entity).width = v; },
    /** Square height in world units. */
    get height() { return _requireShape(entity).height; },
    set height(v) { _requireShape(entity).height = v; },
    /** Circle radius in world units. */
    get radius() { return _requireShape(entity).radius; },
    set radius(v) { _requireShape(entity).radius = v; },
    /** Capsule half-height (principal axis is Y — a vertical pill). */
    get capsuleHalfHeight() { return _requireShape(entity).capsuleHalfHeight; },
    set capsuleHalfHeight(v) { _requireShape(entity).capsuleHalfHeight = v; },
    /** Capsule radius. */
    get capsuleRadius() { return _requireShape(entity).capsuleRadius; },
    set capsuleRadius(v) { _requireShape(entity).capsuleRadius = v; },
    /** Fill color as hex string, e.g. "#3a8ede". */
    get fillColor() { return _requireShape(entity).fillColor; },
    set fillColor(v) { _requireShape(entity).fillColor = v; },
    /** 0.0-1.0 transparency. */
    get opacity() { return _requireShape(entity).opacity; },
    set opacity(v) {
      const n = Number(v);
      _requireShape(entity).opacity = (Number.isFinite(n) ? n : 1);
    },
    /** Whether the outline stroke is drawn around the shape. */
    get outlineEnabled() { return !!_requireShape(entity).outlineEnabled; },
    set outlineEnabled(v) { _requireShape(entity).outlineEnabled = !!v; },
    /** Outline stroke color as hex string. */
    get outlineColor() { return _requireShape(entity).outlineColor; },
    set outlineColor(v) { _requireShape(entity).outlineColor = v; },
    /** Outline stroke width in px. */
    get outlineWidth() { return _requireShape(entity).outlineWidth; },
    set outlineWidth(v) { _requireShape(entity).outlineWidth = v; },
  };
  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !SHAPE_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.shape." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(SHAPE_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      return t[prop];
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !SHAPE_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.shape." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(SHAPE_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      // Read-only guard (none of SHAPE_MEMBERS are read-only today, but
      // this keeps the file self-maintaining if one becomes read-only
      // later — see SpriteAPI.js's identical set trap for the pattern).
      var descriptor = Object.getOwnPropertyDescriptor(t, key);
      if (descriptor && descriptor.get && !descriptor.set) {
        throw _tag(new Error(
          "this.shape." + key + " is read-only and can't be set directly."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
