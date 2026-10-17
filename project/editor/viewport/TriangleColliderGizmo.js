/**
 * editor/viewport/TriangleColliderGizmo.js
 *
 * Draws 3 draggable handle points over a selected entity's Triangle
 * Collider2D, letting the user reshape the collider directly in the
 * Scene viewport instead of only via numeric Inspector fields — same
 * interaction convention as TransformGizmo.js (hitTest/beginDrag/
 * updateDrag/endDrag, called from SceneViewport.js's own pointer
 * handlers), just dragging Collider2D.trianglePoints entries instead of
 * a Transform.
 *
 * Only ever drawn/active when the selected entity's Collider2D.shape is
 * ColliderShape.TRIANGLE — SceneViewport.js is responsible for that
 * gating, this file assumes it's already been checked.
 *
 * Editor-only chrome: never imported by /runtime, /player, or the
 * play-mode popup.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { ColliderShape } from "../../runtime/components/Collider2D.js";
import { getColliderWorldGeometry } from "../../runtime/physics/ColliderGeometry.js";

const HANDLE_RADIUS = 7; // px, screen-space-ish hit radius for grabbing a vertex
const HANDLE_COLOR = 0xffd23f;
const HANDLE_COLOR_HOVER = 0xffffff;

export class TriangleColliderGizmo {
  /**
   * @param {PIXI.Container} gizmoContainer editor-only chrome layer
   */
  constructor(gizmoContainer) {
    this.gizmoContainer = gizmoContainer;
    this.graphics = new PIXI.Graphics();
    this.gizmoContainer.addChild(this.graphics);

    /** current handle hit-circles in WORLD space, recomputed every draw() */
    this._handles = []; // { index: 0|1|2, cx, cy }

    /** @type {null | { index: number, transform: object }} */
    this._drag = null;
  }

  /**
   * @param {import('../../runtime/core/Entity.js').Entity|null} entity
   * @param {import('../../runtime/components/Collider2D.js').Collider2D|null} collider
   */
  draw(entity, collider) {
    this.graphics.clear();
    this._handles = [];

    if (!entity || !collider || collider.shape !== ColliderShape.TRIANGLE) return;
    const transform = entity.getComponent(TRANSFORM);
    if (!transform) return;

    const geo = getColliderWorldGeometry(collider, transform);
    const g = this.graphics;

    g.lineStyle(1, HANDLE_COLOR, 0.9);
    for (let i = 0; i < 3; i++) {
      const p = geo.worldPoints[i];
      const isHover = this._drag && this._drag.index === i;
      g.beginFill(isHover ? HANDLE_COLOR_HOVER : HANDLE_COLOR, 1);
      g.drawCircle(p.x, p.y, HANDLE_RADIUS);
      g.endFill();
      this._handles.push({ index: i, cx: p.x, cy: p.y });
    }
  }

  /** @returns {number|null} index (0/1/2) of the point handle under this world point, or null */
  hitTest(worldX, worldY) {
    for (const h of this._handles) {
      if (Math.hypot(worldX - h.cx, worldY - h.cy) <= HANDLE_RADIUS + 3) return h.index;
    }
    return null;
  }

  beginDrag(index, transform) {
    this._drag = { index, transform };
  }

  isDragging() {
    return !!this._drag;
  }

  /**
   * Converts the world-space pointer position back into the collider's
   * LOCAL, unscaled/unrotated space (the space Collider2D.trianglePoints
   * is defined in) and writes it directly onto the live component — the
   * inverse of the scale-then-rotate-then-translate chain
   * ColliderGeometry.js applies when computing worldPoints.
   * @param {number} worldX
   * @param {number} worldY
   * @param {import('../../runtime/components/Collider2D.js').Collider2D} collider live component being edited
   */
  updateDrag(worldX, worldY, collider) {
    if (!this._drag) return;
    const transform = this._drag.transform;

    // world -> world-relative-to-collider-center
    const dx = worldX - transform.x;
    const dy = worldY - transform.y;

    // undo rotation (rotate by -angle)
    const angleRad = (transform.rotation * Math.PI) / 180;
    const cos = Math.cos(-angleRad);
    const sin = Math.sin(-angleRad);
    const localScaledX = dx * cos - dy * sin;
    const localScaledY = dx * sin + dy * cos;

    // undo scale — guard against divide-by-zero on a squashed-flat entity
    const scaleX = Math.abs(transform.scaleX) < 0.0001 ? 0.0001 : transform.scaleX;
    const scaleY = Math.abs(transform.scaleY) < 0.0001 ? 0.0001 : transform.scaleY;
    const localX = localScaledX / scaleX;
    const localY = localScaledY / scaleY;

    collider.trianglePoints[this._drag.index] = { x: localX, y: localY };
  }

  endDrag() {
    this._drag = null;
  }
}
