/**
 * runtime/scripting/components/StrokePathAPI.js
 *
 * The `this.strokePath` sub-object exposed to user scripts on any
 * entity that has a StrokePath component. Lets scripts read the
 * strip's current shape/appearance and, unlike this.collider (which
 * is read-only — see ColliderAPI.js), actually EDIT it at runtime:
 * push/move/remove points, retint, swap textures, tween the texture
 * offset for a flowing-river/conveyor-belt look, etc.
 *
 * `points` is handed out and accepted as a plain array of {x,y}
 * (local space, same convention as StrokePath.js itself — see that
 * file's header) — reading it returns a fresh deep copy so a script
 * mutating the array it got back can never silently corrupt the live
 * component data behind Proxy's back; writing it (or calling any of
 * the point-editing methods below) replaces the component's own
 * array with a fresh deep copy the other direction, for the same
 * reason. RenderSystem.js and the editor's StrokePathGizmo.js both
 * rebuild their geometry from this.points fresh via
 * StrokePathGeometry.js's buildStrokePathPolygon/buildStrokePathMesh
 * every time they draw, so any change here is visible on the very
 * next rendered frame with no extra "dirty" flag to set.
 *
 * Only offered to entities that actually have a StrokePath component;
 * accessing this.strokePath on an entity without one throws a clear
 * "missing component" error with an Inspector hint, same pattern as
 * this.light / this.collider.
 *
 * RUNTIME-ONLY FILE.
 */

import { STROKE_PATH } from "../../components/StrokePath.js";
import { TRANSFORM } from "../../components/Transform.js";
import { getStrokePathLength } from "../../components/StrokePathGeometry.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

/** Throws a descriptive error when a script calls this.strokePath on an
 *  entity without a StrokePath component. */
function _requireStrokePath(entity) {
  var sp = entity.getComponent(STROKE_PATH);
  if (!sp) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.strokePath but has no Stroke Path component. " +
    "Add one in the Inspector (Add Component → Stroke Path)."
  ), "missing-component");
  return sp;
}

function _copyPoints(points) {
  return points.map(function (p) { return { x: p.x, y: p.y }; });
}

function _validatePoint(p, methodName) {
  if (!p || typeof p.x !== "number" || typeof p.y !== "number") {
    throw _tag(new Error(
      "this.strokePath." + methodName + " expects a point like { x, y }, got " + JSON.stringify(p) + "."
    ), "bad-argument");
  }
}

const STROKE_PATH_READONLY = new Set(["pointCount", "firstPoint", "lastPoint"]);

const STROKE_PATH_MEMBERS = new Set([
  "points", "thickness", "color", "opacity", "useTexture", "textureKey",
  "textureMode", "textureTiling", "textureScale", "textureOffset",
  "textureFlip", "textureRotation", "jointMode", "capMode",
  "getPoint", "setPoint", "addPoint", "insertPoint", "removePoint",
  "pointCount", "getLength", "firstPoint", "lastPoint",
  "worldToLocal", "localToWorld",
]);

/**
 * Builds the `this.strokePath` object for a given entity. All reads and
 * writes go directly to the live StrokePath component data, so moving a
 * point or retinting the strip in onUpdate() takes effect immediately on
 * the next rendered frame.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createStrokePathAPI(entity) {
  const target = {
    /**
     * Centerline points, local space, in path order — array of {x,y}.
     * "Local space" means relative to THIS entity's own Transform
     * (position/rotation/scale) — the same convention as
     * this.collider's shape or this.sprite's own local geometry, NOT
     * world/mouse coordinates. If the entity isn't sitting at world
     * (0,0), passing mouse.x/mouse.y (which ARE world-space) straight
     * into addPoint/setPoint/points will land offset by however far
     * the entity is from the origin — run them through
     * this.strokePath.worldToLocal(x, y) first. Reading always
     * returns a fresh copy (safe to mutate freely without touching
     * the live path); to actually move/add/remove points either
     * assign a whole new array back to this.strokePath.points, or use
     * the point-editing methods below for single-point edits without
     * having to rebuild the entire array yourself.
     */
    get points() { return _copyPoints(_requireStrokePath(entity).points); },
    set points(v) {
      if (!Array.isArray(v)) {
        throw _tag(new Error("this.strokePath.points must be set to an array of { x, y } points."), "bad-argument");
      }
      v.forEach(function (p) { _validatePoint(p, "points"); });
      _requireStrokePath(entity).points = _copyPoints(v);
    },

    /** Full strip width (not half-width), world units. Clamped to >= 0. */
    get thickness() { return _requireStrokePath(entity).thickness; },
    set thickness(v) { _requireStrokePath(entity).thickness = Math.max(0, v); },

    /** Flat fill color as a hex string, e.g. "#8a8a8a". Ignored when useTexture is true. */
    get color() { return _requireStrokePath(entity).color; },
    set color(v) { _requireStrokePath(entity).color = v; },

    /** Overall strip opacity, 0-1. Clamped to [0, 1]. */
    get opacity() { return _requireStrokePath(entity).opacity; },
    set opacity(v) { _requireStrokePath(entity).opacity = Math.max(0, Math.min(1, v)); },

    /** When true, the strip is filled with textureKey's image instead of the flat color. */
    get useTexture() { return _requireStrokePath(entity).useTexture; },
    set useTexture(v) { _requireStrokePath(entity).useTexture = !!v; },

    /** Logical sprite/texture asset key painted along the strip when useTexture is true. */
    get textureKey() { return _requireStrokePath(entity).textureKey; },
    set textureKey(v) { _requireStrokePath(entity).textureKey = v; },

    /** 'stretch' | 'tile' — see StrokePathTextureMode in components/StrokePath.js. */
    get textureMode() { return _requireStrokePath(entity).textureMode; },
    set textureMode(v) { _requireStrokePath(entity).textureMode = v; },

    /** TILE mode only: world units of path length one full texture tile covers lengthwise. */
    get textureTiling() { return _requireStrokePath(entity).textureTiling; },
    set textureTiling(v) { _requireStrokePath(entity).textureTiling = v; },

    /** How many times the texture repeats ACROSS the strip's own thickness. 1 = no repeat. */
    get textureScale() { return _requireStrokePath(entity).textureScale; },
    set textureScale(v) { _requireStrokePath(entity).textureScale = v; },

    /**
     * World-unit shift applied along the path before texture mapping —
     * animate this over time for a flowing-river/conveyor-belt/marching-
     * dashes look without moving any point.
     */
    get textureOffset() { return _requireStrokePath(entity).textureOffset; },
    set textureOffset(v) { _requireStrokePath(entity).textureOffset = v; },

    /** Mirrors the texture across the path's own centerline. */
    get textureFlip() { return _requireStrokePath(entity).textureFlip; },
    set textureFlip(v) { _requireStrokePath(entity).textureFlip = !!v; },

    /** Texture rotation in degrees, around each tile's own center. */
    get textureRotation() { return _requireStrokePath(entity).textureRotation; },
    set textureRotation(v) { _requireStrokePath(entity).textureRotation = v; },

    /** 'sharp' | 'bevel' | 'round' — see StrokePathJointMode in components/StrokePath.js. */
    get jointMode() { return _requireStrokePath(entity).jointMode; },
    set jointMode(v) { _requireStrokePath(entity).jointMode = v; },

    /** 'none' | 'box' | 'round' — see StrokePathCapMode in components/StrokePath.js. Applies to both ends. */
    get capMode() { return _requireStrokePath(entity).capMode; },
    set capMode(v) { _requireStrokePath(entity).capMode = v; },

    /** Number of centerline points currently on the path (read-only). */
    get pointCount() { return _requireStrokePath(entity).points.length; },

    /**
     * { x, y } of the path's first point (read-only shortcut for
     * this.strokePath.getPoint(0)) — handy for spawning a new point
     * just before the current start, e.g. extending a path backward.
     */
    get firstPoint() {
      var pts = _requireStrokePath(entity).points;
      return { x: pts[0].x, y: pts[0].y };
    },

    /**
     * { x, y } of the path's last point (read-only shortcut for
     * this.strokePath.getPoint(this.strokePath.pointCount - 1)) —
     * handy for spawning a new point just ahead of the current end,
     * e.g. this.strokePath.addPoint(this.strokePath.lastPoint.x + 40, ...).
     */
    get lastPoint() {
      var pts = _requireStrokePath(entity).points;
      return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
    },

    /**
     * Total centerline length in world units, following every segment
     * (not straight-line start-to-end distance). Same value
     * StrokePathGeometry.js's texture-tiling math itself uses.
     */
    getLength() {
      return getStrokePathLength(_requireStrokePath(entity).points);
    },

    /** { x, y } of the point at `index`, or undefined if out of range. */
    getPoint(index) {
      var pts = _requireStrokePath(entity).points;
      var p = pts[index];
      return p ? { x: p.x, y: p.y } : undefined;
    },

    /** Moves the existing point at `index` to (x, y). No-op if index is out of range. */
    setPoint(index, x, y) {
      var sp = _requireStrokePath(entity);
      if (index < 0 || index >= sp.points.length) return;
      var pts = _copyPoints(sp.points);
      pts[index] = { x: x, y: y };
      sp.points = pts;
    },

    /** Appends a new point (x, y) to the end of the path. */
    addPoint(x, y) {
      var sp = _requireStrokePath(entity);
      var pts = _copyPoints(sp.points);
      pts.push({ x: x, y: y });
      sp.points = pts;
    },

    /**
     * Inserts a new point (x, y) at `index`, shifting every point from
     * `index` onward one slot later — same "insert a point mid-path"
     * gesture as clicking a segment with the Path tool in the editor
     * (see StrokePathGizmo.js), just callable from a script.
     */
    insertPoint(index, x, y) {
      var sp = _requireStrokePath(entity);
      var pts = _copyPoints(sp.points);
      var clamped = Math.max(0, Math.min(pts.length, index));
      pts.splice(clamped, 0, { x: x, y: y });
      sp.points = pts;
    },

    /**
     * Removes the point at `index`. Refuses to drop the path below 2
     * points (a StrokePath needs at least 2 to have any strip to draw —
     * see StrokePathGeometry.js's buildStrokePathPolygon), silently
     * no-op-ing rather than leaving a broken 0/1-point path behind.
     */
    removePoint(index) {
      var sp = _requireStrokePath(entity);
      if (sp.points.length <= 2) return;
      if (index < 0 || index >= sp.points.length) return;
      var pts = _copyPoints(sp.points);
      pts.splice(index, 1);
      sp.points = pts;
    },

    /**
     * Converts a WORLD-space (x, y) — e.g. mouse.x/mouse.y, or another
     * entity's this.transform.x/y — into this entity's LOCAL space, the
     * same space this.strokePath.points/addPoint/setPoint/insertPoint
     * all use. Accounts for the entity's full Transform: position,
     * rotation, AND scale — matching exactly how RenderSystem.js turns
     * points back into world space when it draws the strip, so a round
     * trip through worldToLocal() then localToWorld() returns the
     * original coordinates unchanged (up to floating-point rounding).
     *   // Drop a point at the mouse's current world position:
     *   var p = this.strokePath.worldToLocal(mouse.x, mouse.y);
     *   this.strokePath.addPoint(p.x, p.y);
     */
    worldToLocal(worldX, worldY) {
      var t = entity.getComponent(TRANSFORM);
      var dx = worldX - t.x;
      var dy = worldY - t.y;
      var rad = (-t.rotation * Math.PI) / 180;
      var cos = Math.cos(rad), sin = Math.sin(rad);
      var rx = dx * cos - dy * sin;
      var ry = dx * sin + dy * cos;
      var sx = t.scaleX !== 0 ? t.scaleX : 1;
      var sy = t.scaleY !== 0 ? t.scaleY : 1;
      return { x: rx / sx, y: ry / sy };
    },

    /**
     * The inverse of worldToLocal() above — converts one of this
     * entity's own LOCAL-space path points (or any local x/y) into
     * WORLD space, e.g. to compare a path point against mouse.x/
     * mouse.y, or to spawn another entity at a point's actual
     * on-screen position.
     *   var end = this.strokePath.lastPoint;
     *   var worldEnd = this.strokePath.localToWorld(end.x, end.y);
     */
    localToWorld(localX, localY) {
      var t = entity.getComponent(TRANSFORM);
      var sx = localX * t.scaleX;
      var sy = localY * t.scaleY;
      var rad = (t.rotation * Math.PI) / 180;
      var cos = Math.cos(rad), sin = Math.sin(rad);
      var rx = sx * cos - sy * sin;
      var ry = sx * sin + sy * cos;
      return { x: rx + t.x, y: ry + t.y };
    },
  };

  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      var key = String(prop);
      if (!(key in t) && !STROKE_PATH_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.strokePath." + key + " does not exist. " +
          "Valid members: " + Array.from(STROKE_PATH_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var v = t[key];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !STROKE_PATH_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.strokePath." + key + " does not exist. " +
          "Valid members: " + Array.from(STROKE_PATH_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      if (STROKE_PATH_READONLY.has(key)) {
        throw _tag(new Error(
          "this.strokePath." + key + " is read-only."
        ), "unsupported-body-type");
      }
      t[key] = value;
      return true;
    },
  });
}
