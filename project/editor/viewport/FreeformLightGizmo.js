/**
 * editor/viewport/FreeformLightGizmo.js
 *
 * Draggable polygon-vertex handles for a selected Freeform Light (see
 * runtime/components/Light.js's LightType.FREEFORM and `points` field),
 * letting the user literally draw the light's shape in the Scene
 * viewport instead of only typing radius/angle numbers — Unity's own
 * 2D Freeform Light works the same way.
 *
 * Same interaction convention as TriangleColliderGizmo.js
 * (hitTest/beginDrag/updateDrag/endDrag driven by SceneViewport.js's
 * pointer handlers) plus two extras a fixed 3-point triangle doesn't
 * need: a single click directly on an EDGE LINE (not a vertex) inserts
 * a new vertex right there, and right-click/alt-click a vertex deletes
 * it (kept at a minimum of 3 points so the shape can never collapse to
 * a line or nothing).
 *
 * Editor-only chrome: never imported by /runtime, /player, or the
 * play-mode popup.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { LIGHT, LightType } from "../../runtime/components/Light.js";
import { DEFAULT_MAX_FREEFORM_POINTS } from "../../runtime/systems/LightTextureShaderSource.js";

const HANDLE_RADIUS = 6; // px-ish world-space hit radius, scaled by worldPerPixel like LightGizmo's icon
const HANDLE_COLOR = 0x5ad1ff; // distinct from LightGizmo's yellow so vertices read as a separate, editable layer
const HANDLE_COLOR_HOVER = 0xffffff;
const OUTLINE_COLOR = 0x5ad1ff;
const MIN_POINTS = 3;

export class FreeformLightGizmo {
  /**
   * @param {PIXI.Container} gizmoContainer editor-only chrome layer
   */
  constructor(gizmoContainer) {
    this.gizmoContainer = gizmoContainer;
    this.graphics = new PIXI.Graphics();
    this.gizmoContainer.addChild(this.graphics);

    /** current handle hit-circles in WORLD space, recomputed every draw() */
    this._handles = []; // { index, cx, cy }
    /** edge endpoints for click-on-line-to-insert, recomputed every draw() */
    this._edges = []; // { afterIndex, ax, ay, bx, by }

    /** @type {null | { index: number, transform: object }} */
    this._drag = null;
  }

  /**
   * @param {import('../../runtime/core/Entity.js').Entity|null} entity
   * @param {import('../../runtime/components/Light.js').Light|null} light
   * @param {number} worldPerPixel same constant-screen-size basis as LightGizmo.js
   */
  draw(entity, light, worldPerPixel) {
    this.graphics.clear();
    this._handles = [];
    this._edges = [];

    if (!entity || !light || light.type !== LightType.FREEFORM) return;
    const transform = entity.getComponent(TRANSFORM);
    const points = light.points;
    if (!transform || !points || points.length < 1) return;

    const handleRadius = HANDLE_RADIUS * (worldPerPixel || 1);
    const worldPts = points.map((p) => ({ x: transform.x + p.x, y: transform.y + p.y }));

    const g = this.graphics;
    if (worldPts.length >= 2) {
      g.lineStyle(1.5, OUTLINE_COLOR, 0.9);
      g.moveTo(worldPts[0].x, worldPts[0].y);
      for (let i = 1; i < worldPts.length; i++) g.lineTo(worldPts[i].x, worldPts[i].y);
      g.lineTo(worldPts[0].x, worldPts[0].y);
    }

    for (let i = 0; i < worldPts.length; i++) {
      const p = worldPts[i];
      const isDragging = this._drag && this._drag.index === i;
      g.lineStyle(1, 0x1c1c1c, 0.6);
      g.beginFill(isDragging ? HANDLE_COLOR_HOVER : HANDLE_COLOR, 1);
      g.drawCircle(p.x, p.y, handleRadius);
      g.endFill();
      this._handles.push({ index: i, cx: p.x, cy: p.y });
    }

    for (let i = 0; i < worldPts.length; i++) {
      const a = worldPts[i];
      const b = worldPts[(i + 1) % worldPts.length];
      // Store both endpoints (not just the midpoint) so hitTestEdge can
      // test the ENTIRE segment — hovering/clicking anywhere along the
      // polygon's edge, not only its exact center point.
      this._edges.push({ afterIndex: i, ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
  }

  /** @returns {number|null} index of the point handle under this world point, or null */
  hitTest(worldX, worldY, worldPerPixel) {
    const r = HANDLE_RADIUS * (worldPerPixel || 1) + 3 * (worldPerPixel || 1);
    for (const h of this._handles) {
      if (Math.hypot(worldX - h.cx, worldY - h.cy) <= r) return h.index;
    }
    return null;
  }

  /**
   * Finds the polygon edge nearest a world point, testing the ENTIRE
   * segment (via standard point-to-segment projection/clamping) rather
   * than only its midpoint — so hovering/clicking anywhere along a
   * line between two vertices works, not just one exact spot in the
   * middle of it.
   * @returns {{afterIndex:number, x:number, y:number}|null} the edge to
   *   insert AFTER (by point index) plus the closest point ON the
   *   segment to worldX/worldY — i.e. exactly where the new vertex
   *   should be placed so it lands under the cursor, not snapped to
   *   the segment's midpoint.
   */
  hitTestEdge(worldX, worldY, worldPerPixel) {
    const r = HANDLE_RADIUS * (worldPerPixel || 1) + 6 * (worldPerPixel || 1);
    let best = null;
    let bestDist = Infinity;
    for (const e of this._edges) {
      const dx = e.bx - e.ax;
      const dy = e.by - e.ay;
      const lenSq = dx * dx + dy * dy;
      // t = how far along the segment (0=a, 1=b) the projection of the
      // click falls; clamped to [0,1] so a click past either endpoint
      // still tests against that endpoint rather than the infinite line.
      let t = lenSq > 0 ? ((worldX - e.ax) * dx + (worldY - e.ay) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const px = e.ax + dx * t;
      const py = e.ay + dy * t;
      const dist = Math.hypot(worldX - px, worldY - py);
      if (dist <= r && dist < bestDist) {
        bestDist = dist;
        best = { afterIndex: e.afterIndex, x: px, y: py };
      }
    }
    return best;
  }

  beginDrag(index, transform) {
    this._drag = { index, transform };
  }

  isDragging() {
    return !!this._drag;
  }

  /**
   * Converts the world-space pointer position back into the light's
   * LOCAL space (offsets from the entity's own Transform position — see
   * components/Light.js's `points` doc comment, NOT rotated/scaled,
   * unlike TriangleColliderGizmo's collider points) and writes it
   * directly onto the live component.
   * @param {number} worldX
   * @param {number} worldY
   * @param {import('../../runtime/components/Light.js').Light} light live component being edited
   */
  updateDrag(worldX, worldY, light) {
    if (!this._drag || !light.points) return;
    const transform = this._drag.transform;
    light.points[this._drag.index] = { x: worldX - transform.x, y: worldY - transform.y };
  }

  endDrag() {
    this._drag = null;
  }

  /**
   * Inserts a new vertex at `worldX/worldY` right after `afterIndex`
   * (called on a single click landing on an edge line — see
   * hitTestEdge). Capped at DEFAULT_MAX_FREEFORM_POINTS (see
   * LightTextureShaderSource.js) — the authoring-time ceiling for how
   * many points a light can be drawn with in the editor. The RUNTIME
   * cap the shader actually honors at render time can be lower than
   * this on a lower-end device's GPU (see resolveCaps() in
   * LightTextureShaderSource.js, which scales the shader's uniform
   * arrays down to fit that device's real uniform budget) — any points
   * beyond THAT cap are silently dropped per-light at render time
   * regardless of what the editor allowed you to author, same as
   * before this cap was made device-dependent. This editor-side cap
   * intentionally stays at the fixed default rather than trying to
   * predict a specific player's device from inside the editor.
   * @returns {boolean} whether a point was actually inserted
   */
  insertPoint(light, afterIndex, worldX, worldY, transform) {
    if (!light.points) return false;
    if (light.points.length >= DEFAULT_MAX_FREEFORM_POINTS) return false;
    light.points.splice(afterIndex + 1, 0, { x: worldX - transform.x, y: worldY - transform.y });
    return true;
  }

  /**
   * Removes the vertex at `index` (called on right-click/alt-click of a
   * handle), refusing to drop below MIN_POINTS so the polygon can never
   * degenerate into a line or point.
   * @returns {boolean} whether a point was actually removed
   */
  removePoint(light, index) {
    if (!light.points || light.points.length <= MIN_POINTS) return false;
    light.points.splice(index, 1);
    return true;
  }
}
