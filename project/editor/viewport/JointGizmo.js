/**
 * editor/viewport/JointGizmo.js
 *
 * Draggable anchor handles for a selected entity's Joint2D, letting you
 * place anchor1/anchor2 by dragging circles in the Scene viewport
 * instead of guessing numbers in the Inspector — same idea as Unity's
 * joint anchor gizmos. Same interaction convention as
 * TriangleColliderGizmo.js/StrokePathGizmo.js (hitTest/beginDrag/
 * updateDrag/endDrag, called from SceneViewport.js's own pointer
 * handlers).
 *
 * Two independent handles are drawn, matching Joint2D.js's own anchor
 * split, colored differently so it's obvious which is which at a
 * glance:
 *  - anchor1 ("this"), GREEN — local to the entity the Joint2D is
 *    attached to. World position = own Transform + anchor1.
 *  - anchor2 ("other"), RED — local to connectedEntityId's Transform,
 *    OR, if connectedEntityId is null, an offset from the world origin
 *    (see Joint2D.js's own doc comment: no connected entity effectively
 *    means "world-space", since the hidden world-anchor body never
 *    rotates or moves). World position = connected Transform (or
 *    (0,0)) + anchor2.
 * Both handles stay live and draggable regardless of jointType, since
 * every joint type uses anchor1/anchor2 (Joint2D.js's own field
 * comment). A thin neutral-gray dashed line is drawn between them so
 * the "distance" a Rope/Spring/Prismatic axis is relative to reads
 * clearly at a glance, same spirit as Unity drawing a line between a
 * joint's two connected bodies.
 *
 * Editor-only chrome: never imported by /runtime, /player, or the
 * play-mode popup.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";

const HANDLE_RADIUS = 7; // px-ish world-space hit radius, scaled by worldPerPixel — same basis as every other gizmo in this family
const ANCHOR1_COLOR = 0x4dff6e; // green — anchor1 ("this" body)
const ANCHOR2_COLOR = 0xff4d4d; // red — anchor2 ("other"/world body), distinct from anchor1 so it's obvious at a glance which handle is which
const HANDLE_COLOR_HOVER = 0xffffff;
const LINE_COLOR = 0xd8d8d8; // neutral gray — the connector doesn't belong to either side, so it doesn't borrow either handle's color
const LINE_ALPHA = 0.5;

export class JointGizmo {
  /**
   * @param {PIXI.Container} gizmoContainer editor-only chrome layer
   */
  constructor(gizmoContainer) {
    this.gizmoContainer = gizmoContainer;
    this.graphics = new PIXI.Graphics();
    this.gizmoContainer.addChild(this.graphics);

    /** current handle hit-circles in WORLD space, recomputed every draw() — { key: "anchor1"|"anchor2", cx, cy, originX, originY } */
    this._handles = [];

    /** @type {null | { key: "anchor1"|"anchor2", originX: number, originY: number }} */
    this._drag = null;
  }

  /**
   * @param {import('../../runtime/core/Entity.js').Entity|null} entity the entity the Joint2D is attached to
   * @param {import('../../runtime/components/Joint2D.js').Joint2D|null} joint
   * @param {import('../../runtime/core/World.js').World|null} world needed to resolve connectedEntityId's own Transform for anchor2
   * @param {number} worldPerPixel constant-screen-size basis, same as every other gizmo in this file's family
   */
  draw(entity, joint, world, worldPerPixel) {
    this.graphics.clear();
    this._handles = [];

    if (!entity || !joint) return;
    const transform = entity.getComponent(TRANSFORM);
    if (!transform) return;

    const handleRadius = HANDLE_RADIUS * (worldPerPixel || 1);
    const g = this.graphics;

    // anchor1 is local to THIS entity. Apply the same rotation/scale transform
    // the physics body uses so gizmo placement matches the actual constraint.
    const a1 = _localToWorld(transform, joint.anchor1X, joint.anchor1Y);
    const a1x = a1.x;
    const a1y = a1.y;

    // anchor2 is local to the connected entity's Transform if there is
    // one, otherwise effectively world-space (offset from the origin) —
    // see this file's header and Joint2D.js's own doc comment.
    let connectedTransform = null;
    let originX = 0;
    let originY = 0;
    if (joint.connectedEntityId && world) {
      const connected = world.getEntity(joint.connectedEntityId);
      connectedTransform = connected ? connected.getComponent(TRANSFORM) : null;
      if (connectedTransform) {
        originX = connectedTransform.x;
        originY = connectedTransform.y;
      }
    }
    const a2 = connectedTransform
      ? _localToWorld(connectedTransform, joint.anchor2X, joint.anchor2Y)
      : { x: joint.anchor2X, y: joint.anchor2Y };
    const a2x = a2.x;
    const a2y = a2.y;

    // Dashed connector line so the span the joint actually measures
    // (Rope/Spring length, Prismatic axis, etc) reads clearly, drawn
    // first so both handles sit visually on top of it.
    g.lineStyle(1.5, LINE_COLOR, LINE_ALPHA);
    _drawDashedLine(g, a1x, a1y, a2x, a2y);

    this._handles.push({ key: "anchor1", cx: a1x, cy: a1y, transform, originX: transform.x, originY: transform.y });
    this._handles.push({ key: "anchor2", cx: a2x, cy: a2y, transform: connectedTransform, originX, originY });

    _drawHandle(g, a1x, a1y, handleRadius, this._drag && this._drag.key === "anchor1", ANCHOR1_COLOR);
    _drawHandle(g, a2x, a2y, handleRadius, this._drag && this._drag.key === "anchor2", ANCHOR2_COLOR);
  }

  /** @returns {"anchor1"|"anchor2"|null} which handle is under this world point, or null */
  hitTest(worldX, worldY, worldPerPixel) {
    const r = HANDLE_RADIUS * (worldPerPixel || 1) + 3 * (worldPerPixel || 1);
    // Iterate in reverse so anchor2 (drawn/added last) wins a tie when
    // the two handles happen to overlap — matches the "topmost drawn
    // wins" convention every other multi-handle gizmo in this family
    // uses (StrokePathGizmo, TriangleColliderGizmo).
    for (let i = this._handles.length - 1; i >= 0; i--) {
      const h = this._handles[i];
      if (Math.hypot(worldX - h.cx, worldY - h.cy) <= r) return h.key;
    }
    return null;
  }

  /**
   * @param {"anchor1"|"anchor2"} key
   */
  beginDrag(key) {
    const h = this._handles.find((it) => it.key === key);
    if (!h) return;
    this._drag = { key, originX: h.originX, originY: h.originY, transform: h.transform };
  }

  isDragging() {
    return !!this._drag;
  }

  /**
   * Converts the world-space pointer position back into the dragged
   * anchor's own local space (offset from its own body's Transform, or
   * from the world origin for an anchor2 with no connected entity — see
   * draw()'s originX/originY) and writes it directly onto the live
   * component, same convention as StrokePathGizmo.updateDrag /
   * TriangleColliderGizmo.updateDrag.
   * @param {import('../../runtime/components/Joint2D.js').Joint2D} joint live component being edited
   */
  updateDrag(worldX, worldY, joint) {
    if (!this._drag) return;
    let localX = worldX - this._drag.originX;
    let localY = worldY - this._drag.originY;
    const t = this._drag.transform;
    if (t) {
      localX = _worldToLocal(t, worldX, worldY).x;
      localY = _worldToLocal(t, worldX, worldY).y;
    }
    if (this._drag.key === "anchor1") {
      joint.anchor1X = localX;
      joint.anchor1Y = localY;
    } else {
      joint.anchor2X = localX;
      joint.anchor2Y = localY;
    }
  }

  endDrag() {
    this._drag = null;
  }
}

/**
 * Unity-style anchor dot: a filled circle with a thin ring around it so
 * it reads clearly against both bright and dark backgrounds, brightening
 * to white while actively dragged (same hover/active convention as
 * TriangleColliderGizmo/StrokePathGizmo's handles). The ring uses the
 * handle's own color (not a shared constant) so anchor1's green ring
 * and anchor2's red ring stay visually tied to their dot even while
 * dragging turns the fill white.
 */
function _drawHandle(g, x, y, radius, isDragging, color) {
  g.lineStyle(1.5, 0x1c1c1c, 0.7);
  g.beginFill(isDragging ? HANDLE_COLOR_HOVER : color, 1);
  g.drawCircle(x, y, radius);
  g.endFill();
  // outer ring, slightly larger, unfilled — gives the dot a bit more
  // presence/visibility at typical zoom levels without needing a bigger
  // (harder to precisely place) hit target
  g.lineStyle(1, color, isDragging ? 1 : 0.5);
  g.drawCircle(x, y, radius * 1.6);
}


function _localToWorld(transform, localX, localY) {
  const angle = (Number(transform.rotation) || 0) * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const sx = Number(transform.scaleX) || 1;
  const sy = Number(transform.scaleY) || 1;
  const x = localX * sx;
  const y = localY * sy;
  return {
    x: transform.x + x * c - y * s,
    y: transform.y + x * s + y * c,
  };
}

function _worldToLocal(transform, worldX, worldY) {
  const angle = (Number(transform.rotation) || 0) * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const sx = Number(transform.scaleX) || 1;
  const sy = Number(transform.scaleY) || 1;
  const dx = worldX - transform.x;
  const dy = worldY - transform.y;
  return {
    x: (dx * c + dy * s) / sx,
    y: (-dx * s + dy * c) / sy,
  };
}

function _drawDashedLine(g, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.001) return;
  const dashLen = 6;
  const gapLen = 4;
  const step = dashLen + gapLen;
  const segments = Math.max(1, Math.floor(dist / step));
  const ux = dx / dist;
  const uy = dy / dist;
  for (let i = 0; i < segments; i++) {
    const start = i * step;
    const end = Math.min(start + dashLen, dist);
    g.moveTo(x0 + ux * start, y0 + uy * start);
    g.lineTo(x0 + ux * end, y0 + uy * end);
  }
}
