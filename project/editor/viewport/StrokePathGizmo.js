/**
 * editor/viewport/StrokePathGizmo.js
 *
 * Draggable point handles for a selected StrokePath (see
 * runtime/components/StrokePath.js), letting the user draw and adjust
 * the strip's centerline directly in the Scene viewport instead of
 * only editing numbers in the Inspector.
 *
 * Same interaction convention as FreeformLightGizmo.js
 * (hitTest/beginDrag/updateDrag/endDrag, click-an-edge-to-insert,
 * right-click-a-handle-to-remove) with two differences that follow
 * directly from a StrokePath being an OPEN path rather than a closed
 * light-shape loop:
 *   - the outline/edge list never wraps the last point back to the
 *     first (see draw()/hitTestEdge() below — FreeformLightGizmo's
 *     edge loop includes points.length-1 -> 0, this one stops one
 *     short of that)
 *   - appendPoint() lets the dedicated Path tool (see
 *     SceneViewport.js's "path" tool branch and Toolbar.js's P
 *     shortcut) grow the path by clicking empty space, which a closed
 *     light shape has no equivalent for (Freeform Lights are only
 *     ever reshaped, never lengthened, since a closed loop has no
 *     "end" to extend)
 * The always-on parts (drag a handle, click a segment to insert a
 * point, right-click a handle to remove one) work identically whether
 * or not the Path tool is the active tool — same as
 * FreeformLightGizmo's handles always being live regardless of
 * activeTool, so a StrokePath stays adjustable even while, say, the
 * Translate tool is selected to reposition the whole entity.
 *
 * Editor-only chrome: never imported by /runtime, /player, or the
 * play-mode popup.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { STROKE_PATH } from "../../runtime/components/StrokePath.js";
import { buildStrokePathMesh } from "../../runtime/components/StrokePathGeometry.js";

const HANDLE_RADIUS = 6; // px-ish world-space hit radius, scaled by worldPerPixel — same basis as FreeformLightGizmo's handles
const HANDLE_COLOR = 0x8fe36a; // distinct green so a selected StrokePath's handles read as a different editable layer from Freeform Light's blue handles
const HANDLE_COLOR_HOVER = 0xffffff;
const HANDLE_COLOR_END = 0xffd15c; // the two path ENDPOINTS get a distinct color so it's visually obvious where clicking with the Path tool will extend the path from
const OUTLINE_COLOR = 0x8fe36a;
const STRIP_PREVIEW_ALPHA = 0.22; // faint fill so the actual strip width reads at a glance without competing with the handle/outline chrome on top of it
const MIN_POINTS = 2; // a path needs at least a start and an end — below this there's no strip left to draw at all

function pointsToLocal(worldPts, transform) {
  return worldPts.map((p) => ({ x: p.x - transform.x, y: p.y - transform.y }));
}

export class StrokePathGizmo {
  /**
   * @param {PIXI.Container} gizmoContainer editor-only chrome layer
   */
  constructor(gizmoContainer) {
    this.gizmoContainer = gizmoContainer;
    this.graphics = new PIXI.Graphics();
    this.gizmoContainer.addChild(this.graphics);

    /** current handle hit-circles in WORLD space, recomputed every draw() */
    this._handles = []; // { index, cx, cy }
    /** segment endpoints for click-on-line-to-insert, recomputed every draw() — OPEN path, so this never wraps last->first */
    this._edges = []; // { afterIndex, ax, ay, bx, by }

    /** @type {null | { index: number, transform: object }} */
    this._drag = null;
  }

  /**
   * @param {import('../../runtime/core/Entity.js').Entity|null} entity
   * @param {import('../../runtime/components/StrokePath.js').StrokePath|null} strokePath
   * @param {number} worldPerPixel same constant-screen-size basis as every other gizmo in this file's family
   */
  draw(entity, strokePath, worldPerPixel) {
    this.graphics.clear();
    this._handles = [];
    this._edges = [];

    if (!entity || !strokePath) return;
    const transform = entity.getComponent(TRANSFORM);
    const points = strokePath.points;
    if (!transform || !points || points.length < 1) return;

    const handleRadius = HANDLE_RADIUS * (worldPerPixel || 1);
    const worldPts = points.map((p) => ({ x: transform.x + p.x, y: transform.y + p.y }));

    const g = this.graphics;

    // Faint strip-width preview: draw the exact same triangle tessellation
    // that runtime rendering uses. This keeps edit-mode shape and play-mode
    // shape identical and avoids concave-polygon triangulation artifacts.
    if (worldPts.length >= 2) {
      const previewMesh = buildStrokePathMesh(
        pointsToLocal(worldPts, transform),
        strokePath.thickness,
        strokePath.jointMode,
        strokePath.capMode,
        "stretch",
        1,
        1,
        0,
        false,
        0,
        strokePath.smoothing
      );
      if (previewMesh) {
        g.lineStyle(0);
        g.beginFill(OUTLINE_COLOR, STRIP_PREVIEW_ALPHA);
        for (let i = 0; i < previewMesh.indices.length; i += 3) {
          const ia = previewMesh.indices[i] * 2;
          const ib = previewMesh.indices[i + 1] * 2;
          const ic = previewMesh.indices[i + 2] * 2;
          g.drawPolygon([
            previewMesh.vertices[ia], previewMesh.vertices[ia + 1],
            previewMesh.vertices[ib], previewMesh.vertices[ib + 1],
            previewMesh.vertices[ic], previewMesh.vertices[ic + 1],
          ]);
        }
        g.endFill();
      }
    }

    // Centerline, so the actual click-path (not just the wide strip
    // silhouette) is always visible too.
    if (worldPts.length >= 2) {
      g.lineStyle(1.5, OUTLINE_COLOR, 0.9);
      g.moveTo(worldPts[0].x, worldPts[0].y);
      for (let i = 1; i < worldPts.length; i++) g.lineTo(worldPts[i].x, worldPts[i].y);
    }

    for (let i = 0; i < worldPts.length; i++) {
      const p = worldPts[i];
      const isDragging = this._drag && this._drag.index === i;
      const isEndpoint = i === 0 || i === worldPts.length - 1;
      g.lineStyle(1, 0x1c1c1c, 0.6);
      g.beginFill(isDragging ? HANDLE_COLOR_HOVER : isEndpoint ? HANDLE_COLOR_END : HANDLE_COLOR, 1);
      g.drawCircle(p.x, p.y, handleRadius);
      g.endFill();
      this._handles.push({ index: i, cx: p.x, cy: p.y });
    }

    // OPEN path: segments only run 0->1, 1->2, ... (length-2)->(length-1) —
    // deliberately NOT wrapping the last point back to the first the
    // way FreeformLightGizmo's closed-loop edge list does.
    for (let i = 0; i < worldPts.length - 1; i++) {
      const a = worldPts[i];
      const b = worldPts[i + 1];
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
   * Finds the path segment nearest a world point, testing the ENTIRE
   * segment via point-to-segment projection/clamping — identical
   * approach to FreeformLightGizmo.hitTestEdge, just over the open
   * (non-wrapping) edge list built in draw() above.
   * @returns {{afterIndex:number, x:number, y:number}|null}
   */
  hitTestEdge(worldX, worldY, worldPerPixel) {
    const r = HANDLE_RADIUS * (worldPerPixel || 1) + 6 * (worldPerPixel || 1);
    let best = null;
    let bestDist = Infinity;
    for (const e of this._edges) {
      const dx = e.bx - e.ax;
      const dy = e.by - e.ay;
      const lenSq = dx * dx + dy * dy;
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
   * Converts the world-space pointer position back into the path's
   * LOCAL space (offsets from the entity's own Transform position —
   * see StrokePath.js's file header) and writes it directly onto the
   * live component, same convention as
   * FreeformLightGizmo.updateDrag.
   * @param {import('../../runtime/components/StrokePath.js').StrokePath} strokePath live component being edited
   */
  updateDrag(worldX, worldY, strokePath) {
    if (!this._drag || !strokePath.points) return;
    const transform = this._drag.transform;
    strokePath.points[this._drag.index] = { x: worldX - transform.x, y: worldY - transform.y };
  }

  endDrag() {
    this._drag = null;
  }

  /**
   * Inserts a new point at `worldX/worldY` right after `afterIndex`
   * (a single click landing on a segment — see hitTestEdge). No
   * authoring-time point cap the way Freeform Light has: a StrokePath
   * has no per-light shader uniform array to overflow, its geometry is
   * plain CPU-side polygon math (buildStrokePathPolygon) with no
   * device-dependent ceiling to protect.
   * @returns {boolean} whether a point was actually inserted
   */
  insertPoint(strokePath, afterIndex, worldX, worldY, transform) {
    if (!strokePath.points) return false;
    strokePath.points.splice(afterIndex + 1, 0, { x: worldX - transform.x, y: worldY - transform.y });
    return true;
  }

  /**
   * Appends a new point at the very END of the path — the Path tool's
   * click-on-empty-space action (see SceneViewport.js's "path" tool
   * branch), letting the user extend the path by clicking further
   * along, one point at a time. Has no FreeformLightGizmo equivalent:
   * a closed loop has no "end" to extend from, only vertices to
   * reshape.
   */
  appendPoint(strokePath, worldX, worldY, transform) {
    if (!strokePath.points) return false;
    strokePath.points.push({ x: worldX - transform.x, y: worldY - transform.y });
    return true;
  }

  /**
   * Removes the point at `index` (right-click/alt-click of a handle),
   * refusing to drop below MIN_POINTS so the path can never collapse
   * to a single dangling point with no strip left to draw.
   * @returns {boolean} whether a point was actually removed
   */
  removePoint(strokePath, index) {
    if (!strokePath.points || strokePath.points.length <= MIN_POINTS) return false;
    strokePath.points.splice(index, 1);
    return true;
  }
}
