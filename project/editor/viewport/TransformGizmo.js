/**
 * editor/viewport/TransformGizmo.js
 *
 * Interactive translate + scale gizmo drawn around the currently
 * selected entity in the Scene viewport. Purely editor-only chrome —
 * hit-testing and dragging happen here, but the actual value writes go
 * through the entity's real Transform component (runtime data), so
 * changes are identical to typing into the Inspector fields.
 *
 * Constant SCREEN size regardless of zoom: every arm length/handle/ring
 * size below is a target size in screen PIXELS, scaled by the current
 * worldPerPixel (1 world unit per screen px at 100% zoom; grows as you
 * zoom OUT) into the actual world-unit size to draw/hit-test at — same
 * convention LightGizmo.js/AudioGizmo.js already use for their icons.
 * Without this, the gizmo used to be drawn at a fixed WORLD size, so it
 * visually shrank right along with the rest of the scene when zooming
 * out — easy to lose track of, and its handles could shrink to just a
 * couple of screen pixels, too small to reliably click.
 *
 * This file does not touch PIXI Application/stage creation — it's handed
 * a gizmoContainer to draw into and pointer events forwarded to it by
 * SceneViewport.js.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { editorState } from "../state/EditorState.js";

const AXIS_X_COLOR = 0xe25555;
const AXIS_Y_COLOR = 0x569ce4;
// All of these are SCREEN-pixel target sizes now, not world units — see
// the class doc comment below for why. Multiply by the current
// worldPerPixel (same constant-screen-size convention LightGizmo.js /
// AudioGizmo.js already use) to get the actual world-unit size to draw
// at for the current zoom level.
const ARM_LENGTH = 70;
const HANDLE_SIZE = 9;
const HIT_PADDING = 6;
const ROTATE_RADIUS = 55;
const ROTATE_RING_HIT_BAND = 8; // how close to the ring counts as a hit, in SCREEN px

/**
 * Rotates a point (lx, ly) — expressed relative to the object's own
 * origin, in its UNROTATED local space — by the object's rotation
 * (degrees) and translates it to world space around (cx, cy). Used by
 * every gizmo drawing/hit-test below so the translate/scale gizmo and
 * the plain selection box visually rotate along with the object, the
 * same way the rotate ring's knob already tracked rotation.
 */
function _localToWorld(cx, cy, rotationDeg, lx, ly) {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos,
  };
}

export class TransformGizmo {
  /**
   * @param {PIXI.Container} gizmoContainer editor-only chrome layer
   */
  constructor(gizmoContainer) {
    this.gizmoContainer = gizmoContainer;
    this.graphics = new PIXI.Graphics();
    this.gizmoContainer.addChild(this.graphics);

    /** @type {null | { handle: string, startWorldX:number, startWorldY:number, startTransform:object, startAngle?:number }} */
    this._drag = null;

    /** current RECTANGULAR handle hitboxes in WORLD space, recomputed every draw() (translate/scale tools) */
    this._handles = [];

    /** current CIRCULAR handle (rotate tool), or null when not the active tool */
    this._rotateHandle = null;

    /**
     * Last worldPerPixel passed to draw() — stashed so hitTest() (called
     * on every pointer move, not just after a fresh draw()) always
     * checks against the SAME scale the gizmo was actually last drawn
     * at, rather than potentially drifting out of sync with it.
     */
    this._worldPerPixel = 1;
  }

  /**
   * @param {import('../../runtime/core/Entity.js').Entity|null} entity
   * @param {number} [worldPerPixel] world units per screen pixel at the
   *   viewport's current zoom (1 at 100% zoom, grows when zoomed out) —
   *   see the class doc comment above. Defaults to 1 (behaves like the
   *   old fixed-world-size gizmo) if the caller doesn't pass one.
   */
  draw(entity, worldPerPixel) {
    this.graphics.clear();
    this._handles = [];
    this._rotateHandle = null;
    this._worldPerPixel = worldPerPixel || 1;

    if (!entity) return;
    const transform = entity.getComponent(TRANSFORM);
    if (!transform) return;

    const tool = editorState.activeTool;
    if (tool === "translate") {
      this._drawTranslateGizmo(transform);
    } else if (tool === "scale") {
      this._drawScaleGizmo(transform);
    } else if (tool === "rotate") {
      this._drawRotateGizmo(transform);
    } else {
      this._drawSelectionBox(transform);
    }
  }

  _drawSelectionBox(transform) {
    const g = this.graphics;
    const { x, y, rotation } = transform;
    const s = this._worldPerPixel;
    const half = 40 * s;
    g.lineStyle(1, 0x8fc153, 1);
    const corners = [
      _localToWorld(x, y, rotation, -half, -half),
      _localToWorld(x, y, rotation, half, -half),
      _localToWorld(x, y, rotation, half, half),
      _localToWorld(x, y, rotation, -half, half),
    ];
    g.drawPolygon(corners.flatMap((p) => [p.x, p.y]));
  }

  _drawTranslateGizmo(transform) {
    const g = this.graphics;
    const { x, y, rotation } = transform;
    const toWorld = (lx, ly) => _localToWorld(x, y, rotation, lx, ly);
    const s = this._worldPerPixel;
    const armLength = ARM_LENGTH * s;
    const hitPadding = HIT_PADDING * s;
    const headHalf = 6 * s;
    const headTip = 12 * s;
    const centerHalf = 6 * s;
    const centerHitHalf = 10 * s;
    const boundHalf = 40 * s;

    // X axis arm (red) — drawn along the object's own rotated +X, not
    // world +X, so the whole gizmo turns together with the object.
    const xTip = toWorld(armLength, 0);
    g.lineStyle(2, AXIS_X_COLOR, 1);
    g.moveTo(x, y);
    g.lineTo(xTip.x, xTip.y);
    g.beginFill(AXIS_X_COLOR, 1);
    const xHead = [toWorld(armLength, -headHalf), toWorld(armLength, headHalf), toWorld(armLength + headTip, 0)];
    g.drawPolygon(xHead.flatMap((p) => [p.x, p.y]));
    g.endFill();
    this._handles.push({
      id: "move-x",
      shape: "rotated-rect",
      cx: x,
      cy: y,
      rotation,
      // local-space rect spanning the arm + arrowhead, padded perpendicular to the axis
      localMinX: 20 * s,
      localMaxX: armLength + headTip,
      localMinY: -hitPadding,
      localMaxY: hitPadding,
    });

    // Y axis arm (blue) — object's rotated +Y (screen "up" from the
    // object's own perspective, matching the pre-rotation behavior).
    const yTip = toWorld(0, -armLength);
    g.lineStyle(2, AXIS_Y_COLOR, 1);
    g.moveTo(x, y);
    g.lineTo(yTip.x, yTip.y);
    g.beginFill(AXIS_Y_COLOR, 1);
    const yHead = [toWorld(-headHalf, -armLength), toWorld(headHalf, -armLength), toWorld(0, -armLength - headTip)];
    g.drawPolygon(yHead.flatMap((p) => [p.x, p.y]));
    g.endFill();
    this._handles.push({
      id: "move-y",
      shape: "rotated-rect",
      cx: x,
      cy: y,
      rotation,
      localMinX: -hitPadding,
      localMaxX: hitPadding,
      localMinY: -armLength - headTip,
      localMaxY: -20 * s,
    });

    g.lineStyle(1, 0xffffff, 0.9);
    g.beginFill(0xdddddd, 1);
    const centerSq = [toWorld(-centerHalf, -centerHalf), toWorld(centerHalf, -centerHalf), toWorld(centerHalf, centerHalf), toWorld(-centerHalf, centerHalf)];
    g.drawPolygon(centerSq.flatMap((p) => [p.x, p.y]));
    g.endFill();
    this._handles.push({
      id: "move-xy",
      shape: "rotated-rect",
      cx: x,
      cy: y,
      rotation,
      localMinX: -centerHitHalf,
      localMaxX: centerHitHalf,
      localMinY: -centerHitHalf,
      localMaxY: centerHitHalf,
    });

    g.lineStyle(1, 0x8fc153, 0.9);
    const boundBox = [toWorld(-boundHalf, -boundHalf), toWorld(boundHalf, -boundHalf), toWorld(boundHalf, boundHalf), toWorld(-boundHalf, boundHalf)];
    g.drawPolygon(boundBox.flatMap((p) => [p.x, p.y]));
  }

  _drawScaleGizmo(transform) {
    const g = this.graphics;
    const { x, y, rotation } = transform;
    const toWorld = (lx, ly) => _localToWorld(x, y, rotation, lx, ly);
    const s = this._worldPerPixel;
    const armLength = ARM_LENGTH * s;
    const handleSize = HANDLE_SIZE * s;
    const handleHalf = 5 * s;
    const centerHalf = 6 * s;
    const centerHitHalf = 10 * s;
    const boundHalf = 40 * s;

    const xTip = toWorld(armLength, 0);
    g.lineStyle(2, AXIS_X_COLOR, 1);
    g.moveTo(x, y);
    g.lineTo(xTip.x, xTip.y);
    g.lineStyle(1, AXIS_X_COLOR, 1);
    g.beginFill(AXIS_X_COLOR, 1);
    const xHandle = [toWorld(armLength - handleHalf, -handleHalf), toWorld(armLength + handleHalf, -handleHalf), toWorld(armLength + handleHalf, handleHalf), toWorld(armLength - handleHalf, handleHalf)];
    g.drawPolygon(xHandle.flatMap((p) => [p.x, p.y]));
    g.endFill();
    this._handles.push({
      id: "scale-x",
      shape: "rotated-rect",
      cx: x,
      cy: y,
      rotation,
      localMinX: armLength - handleSize,
      localMaxX: armLength + handleSize,
      localMinY: -handleSize,
      localMaxY: handleSize,
    });

    const yTip = toWorld(0, -armLength);
    g.lineStyle(2, AXIS_Y_COLOR, 1);
    g.moveTo(x, y);
    g.lineTo(yTip.x, yTip.y);
    g.lineStyle(1, AXIS_Y_COLOR, 1);
    g.beginFill(AXIS_Y_COLOR, 1);
    const yHandle = [toWorld(-handleHalf, -armLength - handleHalf), toWorld(handleHalf, -armLength - handleHalf), toWorld(handleHalf, -armLength + handleHalf), toWorld(-handleHalf, -armLength + handleHalf)];
    g.drawPolygon(yHandle.flatMap((p) => [p.x, p.y]));
    g.endFill();
    this._handles.push({
      id: "scale-y",
      shape: "rotated-rect",
      cx: x,
      cy: y,
      rotation,
      localMinX: -handleSize,
      localMaxX: handleSize,
      localMinY: -armLength - handleSize,
      localMaxY: -armLength + handleSize,
    });

    g.lineStyle(1, 0xffffff, 0.9);
    g.beginFill(0xdddddd, 1);
    const centerSq = [toWorld(-centerHalf, -centerHalf), toWorld(centerHalf, -centerHalf), toWorld(centerHalf, centerHalf), toWorld(-centerHalf, centerHalf)];
    g.drawPolygon(centerSq.flatMap((p) => [p.x, p.y]));
    g.endFill();
    this._handles.push({
      id: "scale-xy",
      shape: "rotated-rect",
      cx: x,
      cy: y,
      rotation,
      localMinX: -centerHitHalf,
      localMaxX: centerHitHalf,
      localMinY: -centerHitHalf,
      localMaxY: centerHitHalf,
    });

    g.lineStyle(1, 0x8fc153, 0.9);
    const boundBox = [toWorld(-boundHalf, -boundHalf), toWorld(boundHalf, -boundHalf), toWorld(boundHalf, boundHalf), toWorld(-boundHalf, boundHalf)];
    g.drawPolygon(boundBox.flatMap((p) => [p.x, p.y]));
  }

  /**
   * Draws a Unity-style rotate ring: a full circle outline (the drag
   * surface — grab anywhere on it) plus a small knob + radial line at
   * the object's CURRENT rotation angle, so the current angle is always
   * visible at a glance, not just discoverable by dragging.
   */
  _drawRotateGizmo(transform) {
    const g = this.graphics;
    const { x, y, rotation } = transform;
    const angleRad = (rotation * Math.PI) / 180;
    const s = this._worldPerPixel;
    const rotateRadius = ROTATE_RADIUS * s;
    const knobRadius = 6 * s;
    const indicatorHalf = 4 * s;

    g.lineStyle(2, 0x8fc153, 0.9);
    g.drawCircle(x, y, rotateRadius);

    // radial indicator line + knob at the current angle, so you can see
    // exactly where "0 rotation" vs the live angle is without dragging
    const knobX = x + Math.cos(angleRad) * rotateRadius;
    const knobY = y + Math.sin(angleRad) * rotateRadius;
    g.lineStyle(2, 0xf2c14e, 1);
    g.moveTo(x, y);
    g.lineTo(knobX, knobY);
    g.lineStyle(1, 0xffffff, 0.9);
    g.beginFill(0xf2c14e, 1);
    g.drawCircle(knobX, knobY, knobRadius);
    g.endFill();

    g.lineStyle(1, 0xffffff, 0.9);
    g.beginFill(0xdddddd, 1);
    g.drawRect(x - indicatorHalf, y - indicatorHalf, indicatorHalf * 2, indicatorHalf * 2);
    g.endFill();

    // Circular hit region: dragging anywhere near the ring's
    // circumference rotates the object — matches Unity/most editors'
    // "grab the ring" convention, rather than requiring a pixel-precise
    // grab on the knob itself.
    this._rotateHandle = { cx: x, cy: y, radius: rotateRadius, band: ROTATE_RING_HIT_BAND * s };
  }

  /**
   * Hit-tests a world-space point against the current handles: the
   * rotated rectangular translate/scale handles (rotated into the
   * object's local space so a rotated object's gizmo still hit-tests
   * correctly), OR (rotate tool) the circular ring — a hit is anywhere
   * within `band` px of the ring's radius, not just exactly on the
   * knob, matching the "grab the ring" convention.
   * @returns {string|null} handle id or null
   */
  hitTest(worldX, worldY) {
    if (this._rotateHandle) {
      const { cx, cy, radius, band } = this._rotateHandle;
      const dist = Math.hypot(worldX - cx, worldY - cy);
      return Math.abs(dist - radius) <= band ? "rotate-z" : null;
    }

    for (const h of this._handles) {
      if (h.shape === "rotated-rect") {
        // Undo the object's rotation on the click point so it can be
        // compared against the handle's plain axis-aligned local bounds
        // — equivalent to testing in the object's own unrotated space.
        const rad = (-h.rotation * Math.PI) / 180;
        const dx = worldX - h.cx;
        const dy = worldY - h.cy;
        const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
        const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
        if (localX >= h.localMinX && localX <= h.localMaxX && localY >= h.localMinY && localY <= h.localMaxY) {
          return h.id;
        }
        continue;
      }
      if (worldX >= h.minX && worldX <= h.maxX && worldY >= h.minY && worldY <= h.maxY) {
        return h.id;
      }
    }
    return null;
  }

  /**
   * @param {string} handle
   * @param {number} worldX
   * @param {number} worldY
   * @param {object} transform live Transform component to drag
   */
  beginDrag(handle, worldX, worldY, transform) {
    this._drag = {
      handle,
      startWorldX: worldX,
      startWorldY: worldY,
      startTransform: {
        x: transform.x,
        y: transform.y,
        scaleX: transform.scaleX,
        scaleY: transform.scaleY,
        rotation: transform.rotation,
      },
      // pointer angle relative to the object's center at drag start, in
      // degrees — used to compute how far the pointer has swept around
      // since, rather than snapping rotation straight to the pointer's
      // absolute angle (which would jump the object on grab).
      startPointerAngle: (Math.atan2(worldY - transform.y, worldX - transform.x) * 180) / Math.PI,
    };
  }

  isDragging() {
    return !!this._drag;
  }

  /**
   * The primary entity's Transform values at the moment the current drag
   * began (or null if not dragging) — used by SceneViewport to compute
   * how far translate/scale/rotate has moved the primary so far, so that
   * same delta can be replayed onto the rest of a multi-selection.
   * @returns {{x:number,y:number,scaleX:number,scaleY:number,rotation:number}|null}
   */
  getDragStart() {
    return this._drag ? this._drag.startTransform : null;
  }

  /**
   * @param {number} worldX
   * @param {number} worldY
   * @param {object} transform live Transform component being dragged
   */
  updateDrag(worldX, worldY, transform) {
    if (!this._drag) return;
    const dx = worldX - this._drag.startWorldX;
    const dy = worldY - this._drag.startWorldY;
    const start = this._drag.startTransform;

    // Single-axis handles (move-x/move-y, scale-x/scale-y) act along the
    // OBJECT's own rotated local axes, not world X/Y — so project the
    // world-space pointer delta onto those local axes first. Rotating
    // by -rotation turns "how far did the pointer move in world space"
    // into "how far did it move along the object's local X/Y", matching
    // how the gizmo arms themselves are now drawn rotated with the
    // object (see _localToWorld/_drawTranslateGizmo above).
    const rad = (-start.rotation * Math.PI) / 180;
    const localDx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const localDy = dx * Math.sin(rad) + dy * Math.cos(rad);

    switch (this._drag.handle) {
      case "move-x": {
        // Move localDx along the object's local +X, converted back to
        // world space so it lands correctly regardless of rotation.
        const rad2 = (start.rotation * Math.PI) / 180;
        transform.x = start.x + localDx * Math.cos(rad2);
        transform.y = start.y + localDx * Math.sin(rad2);
        break;
      }
      case "move-y": {
        const rad2 = (start.rotation * Math.PI) / 180;
        transform.x = start.x + localDy * -Math.sin(rad2);
        transform.y = start.y + localDy * Math.cos(rad2);
        break;
      }
      case "move-xy":
        // Free movement in both axes — world-space delta is correct as-
        // is, no rotation projection needed (dragging the center handle
        // isn't constrained to either local axis).
        transform.x = start.x + dx;
        transform.y = start.y + dy;
        break;
      case "scale-x": {
        const delta = localDx / ARM_LENGTH;
        transform.scaleX = Math.max(0.01, start.scaleX + delta * start.scaleX);
        break;
      }
      case "scale-y": {
        const delta = -localDy / ARM_LENGTH;
        transform.scaleY = Math.max(0.01, start.scaleY + delta * start.scaleY);
        break;
      }
      case "scale-xy": {
        const delta = (localDx - localDy) / (ARM_LENGTH * 2);
        transform.scaleX = Math.max(0.01, start.scaleX + delta * start.scaleX);
        transform.scaleY = Math.max(0.01, start.scaleY + delta * start.scaleY);
        break;
      }
      case "rotate-z": {
        // Current pointer angle relative to the object's center, minus
        // the angle it started at, gives exactly how far around the
        // pointer has swept — added onto the object's starting rotation
        // so grabbing the ring never causes a jump to the pointer's
        // absolute angle.
        const currentPointerAngle = (Math.atan2(worldY - start.y, worldX - start.x) * 180) / Math.PI;
        const sweep = currentPointerAngle - this._drag.startPointerAngle;
        transform.rotation = start.rotation + sweep;
        break;
      }
    }
  }

  endDrag() {
    this._drag = null;
  }
}
