/**
 * runtime/pathfinding/NavWorldBaker.js
 *
 * Accurate grid bake with spatially indexed collider tests. Tests every
 * cell against only the colliders whose world-space bounds could
 * plausibly cover it, instead of every cell against every collider.
 * Large obstacles are kept in a small separate list to avoid giant
 * bucket arrays.
 *
 * IMPORTANT — this bake is RAW obstacle geometry only. It no longer
 * pads by any agent radius (that used to be NavMesh.agentRadius, a
 * mesh-wide property — see the navigation architecture doc atop
 * systems/NavWorldSystem.js for why that was wrong: radius belongs to
 * each NavAgent2D, and the same shared world must support agents of
 * different sizes). Per-agent clearance is now applied AFTER this bake,
 * lazily and per unique radius, by NavWorld2D's getAgentNavLayer() —
 * this file only ever answers "is a collider physically here", never
 * "can an agent of size X stand here".
 *
 * One exception to "every collider blocks": NavWorld2D.minObstacleFootprint
 * lets small decorative colliders (grass, pebbles, litter) opt out of
 * blocking entirely, so a scene doesn't end up with walkable-looking
 * ground that's secretly unwalkable because of a tiny prop's collider.
 * See geometryFootprint() below and that field's own doc comment.
 */

import { COLLIDER_2D, ColliderShape } from "../components/Collider2D.js";
import { TRANSFORM } from "../components/Transform.js";
import { RIGIDBODY_2D, BodyType } from "../components/Rigidbody2D.js";
import { getColliderWorldGeometry } from "../physics/ColliderGeometry.js";
import { navCellKey, invalidateNavWorldRuntime } from "../components/NavWorld2D.js";

function pointSegmentDistanceSquared(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 <= 1e-12) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
  const qx = ax + abx * t;
  const qy = ay + aby * t;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

function pointInTriangle(px, py, a, b, c) {
  const d1 = (px - b.x) * (a.y - b.y) - (a.x - b.x) * (py - b.y);
  const d2 = (px - c.x) * (b.y - c.y) - (b.x - c.x) * (py - c.y);
  const d3 = (px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y);
  const hasNeg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
  const hasPos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
  return !(hasNeg && hasPos);
}

/**
 * The obstacle's own footprint along its NARROWER axis, in world units —
 * used to decide whether it's big enough to matter for walking (see
 * NavWorld2D.minObstacleFootprint). Deliberately the narrow axis, not the
 * diagonal or the wide axis: a long thin fence is still a real obstacle
 * along its short side even though it's very long, and a small round
 * prop should compare on its actual width, not get inflated by picking
 * the larger dimension.
 */
function geometryFootprint(geo) {
  if (geo.shape === ColliderShape.CIRCLE) return geo.radius * 2;
  if (geo.shape === ColliderShape.BOX) return Math.min(geo.halfWidth, geo.halfHeight) * 2;
  if (geo.shape === ColliderShape.CAPSULE) return geo.radius * 2;

  // Triangle: narrowest of its three edge lengths is a reasonable stand-in
  // for "how substantial is this shape", same spirit as the box case.
  const points = geo.worldPoints || [];
  if (points.length >= 3) {
    const edge = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    return Math.min(edge(points[0], points[1]), edge(points[1], points[2]), edge(points[2], points[0]));
  }
  return Infinity; // unknown shape — never filtered out by size
}

function geometryAABB(geo, pad) {
  if (geo.shape === ColliderShape.CIRCLE) {
    return {
      minX: geo.centerX - geo.radius - pad,
      maxX: geo.centerX + geo.radius + pad,
      minY: geo.centerY - geo.radius - pad,
      maxY: geo.centerY + geo.radius + pad,
    };
  }

  if (geo.shape === ColliderShape.BOX) {
    const rad = (geo.rotationDeg || 0) * Math.PI / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const hx = Math.abs(c) * geo.halfWidth + Math.abs(s) * geo.halfHeight + pad;
    const hy = Math.abs(s) * geo.halfWidth + Math.abs(c) * geo.halfHeight + pad;
    return { minX: geo.centerX - hx, maxX: geo.centerX + hx, minY: geo.centerY - hy, maxY: geo.centerY + hy };
  }

  if (geo.shape === ColliderShape.CAPSULE) {
    // Local Y capsule axis rotated into world. Its half-extent along X/Y is
    // the projection of the segment plus the circular end radius.
    const rad = (geo.rotationDeg || 0) * Math.PI / 180;
    const axisX = -Math.sin(rad) * geo.halfHeight;
    const axisY = Math.cos(rad) * geo.halfHeight;
    return {
      minX: Math.min(geo.centerX - axisX, geo.centerX + axisX) - geo.radius - pad,
      maxX: Math.max(geo.centerX - axisX, geo.centerX + axisX) + geo.radius + pad,
      minY: Math.min(geo.centerY - axisY, geo.centerY + axisY) - geo.radius - pad,
      maxY: Math.max(geo.centerY - axisY, geo.centerY + axisY) + geo.radius + pad,
    };
  }

  const points = geo.worldPoints || [];
  if (!points.length) {
    return { minX: geo.centerX - pad, maxX: geo.centerX + pad, minY: geo.centerY - pad, maxY: geo.centerY + pad };
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x - pad);
    maxX = Math.max(maxX, p.x + pad);
    minY = Math.min(minY, p.y - pad);
    maxY = Math.max(maxY, p.y + pad);
  }
  return { minX, maxX, minY, maxY };
}

/** Exact/shape-aware point test. `pad` is always 0 from bakeNavWorld now —
 *  kept as a parameter (rather than removed) because it is also reused
 *  unpadded by geometryAABB's bucket-assignment pass below. */
function pointInPaddedShape(px, py, geo, pad) {
  const dx = px - geo.centerX;
  const dy = py - geo.centerY;

  if (geo.shape === ColliderShape.CIRCLE) {
    const r = geo.radius + pad;
    return dx * dx + dy * dy <= r * r;
  }

  if (geo.shape === ColliderShape.BOX) {
    const angleRad = (-(geo.rotationDeg || 0) * Math.PI) / 180;
    const localX = dx * Math.cos(angleRad) - dy * Math.sin(angleRad);
    const localY = dx * Math.sin(angleRad) + dy * Math.cos(angleRad);
    return Math.abs(localX) <= geo.halfWidth + pad && Math.abs(localY) <= geo.halfHeight + pad;
  }

  if (geo.shape === ColliderShape.CAPSULE) {
    const rad = (geo.rotationDeg || 0) * Math.PI / 180;
    const ax = geo.centerX - Math.sin(rad) * geo.halfHeight;
    const ay = geo.centerY + Math.cos(rad) * geo.halfHeight;
    const bx = geo.centerX + Math.sin(rad) * geo.halfHeight;
    const by = geo.centerY - Math.cos(rad) * geo.halfHeight;
    const r = geo.radius + pad;
    return pointSegmentDistanceSquared(px, py, ax, ay, bx, by) <= r * r;
  }

  const points = geo.worldPoints || [];
  if (points.length >= 3) {
    if (pointInTriangle(px, py, points[0], points[1], points[2])) return true;
    const r2 = pad * pad;
    return pointSegmentDistanceSquared(px, py, points[0].x, points[0].y, points[1].x, points[1].y) <= r2 ||
      pointSegmentDistanceSquared(px, py, points[1].x, points[1].y, points[2].x, points[2].y) <= r2 ||
      pointSegmentDistanceSquared(px, py, points[2].x, points[2].y, points[0].x, points[0].y) <= r2;
  }
  return false;
}

/**
 * Bakes navWorld's cells from every static, non-trigger Collider2D
 * currently in the world — RAW geometry, no agent-radius padding (see
 * this file's header). Any previously-derived per-radius agent layers
 * are invalidated so every agent picks up the new topology on its next
 * path query.
 */
export function bakeNavWorld(navWorld, world, navWorldTransform) {
  const originX = navWorld.boundsX + (navWorldTransform ? navWorldTransform.x : 0);
  const originY = navWorld.boundsY + (navWorldTransform ? navWorldTransform.y : 0);
  const cols = Math.max(1, Math.ceil(navWorld.boundsWidth / navWorld.cellSize));
  const rows = Math.max(1, Math.ceil(navWorld.boundsHeight / navWorld.cellSize));
  const cellCount = cols * rows;

  const minFootprint = navWorld.minObstacleFootprint || 0;
  const colliderGeos = [];
  for (const entity of world.getAllEntities()) {
    const collider = entity.getComponent(COLLIDER_2D);
    const transform = entity.getComponent(TRANSFORM);
    if (!collider || !transform || collider.isTrigger) continue;
    const rigidbody = entity.getComponent(RIGIDBODY_2D);
    if (rigidbody && rigidbody.bodyType !== BodyType.STATIC) continue;
    const geo = getColliderWorldGeometry(collider, transform);
    // Skip obstacles too small to matter for walking (see
    // NavWorld2D.minObstacleFootprint's header) — a small prop's
    // collider still exists for physics, it just never blocks a cell.
    if (minFootprint > 0 && geometryFootprint(geo) < minFootprint) continue;
    colliderGeos.push(geo);
  }

  // Spatial buckets: cell index -> compact obstacle-index list.
  const buckets = new Map();
  const large = [];
  const LARGE_COVERAGE_THRESHOLD = Math.max(128, Math.floor(cellCount * 0.12));
  const PAD = 0; // raw geometry — see this file's header

  for (let gi = 0; gi < colliderGeos.length; gi++) {
    const aabb = geometryAABB(colliderGeos[gi], PAD);
    let minCol = Math.floor((aabb.minX - originX) / navWorld.cellSize);
    let maxCol = Math.floor((aabb.maxX - originX) / navWorld.cellSize);
    let minRow = Math.floor((aabb.minY - originY) / navWorld.cellSize);
    let maxRow = Math.floor((aabb.maxY - originY) / navWorld.cellSize);
    minCol = Math.max(0, minCol); maxCol = Math.min(cols - 1, maxCol);
    minRow = Math.max(0, minRow); maxRow = Math.min(rows - 1, maxRow);
    if (minCol > maxCol || minRow > maxRow) continue;

    const covered = (maxCol - minCol + 1) * (maxRow - minRow + 1);
    if (covered > LARGE_COVERAGE_THRESHOLD) {
      large.push(gi);
      continue;
    }

    for (let row = minRow; row <= maxRow; row++) {
      const rowBase = row * cols;
      for (let col = minCol; col <= maxCol; col++) {
        const key = rowBase + col;
        let list = buckets.get(key);
        if (!list) buckets.set(key, (list = []));
        list.push(gi);
      }
    }
  }

  const bakedCells = {};
  let walkable = 0;
  let blocked = 0;

  for (let row = 0; row < rows; row++) {
    const rowBase = row * cols;
    const py = originY + (row + 0.5) * navWorld.cellSize;
    for (let col = 0; col < cols; col++) {
      const px = originX + (col + 0.5) * navWorld.cellSize;
      const candidates = buckets.get(rowBase + col);
      let isBlocked = false;

      for (let i = 0; i < large.length; i++) {
        if (pointInPaddedShape(px, py, colliderGeos[large[i]], PAD)) {
          isBlocked = true;
          break;
        }
      }
      if (!isBlocked && candidates) {
        for (let i = 0; i < candidates.length; i++) {
          if (pointInPaddedShape(px, py, colliderGeos[candidates[i]], PAD)) {
            isBlocked = true;
            break;
          }
        }
      }

      const key = navCellKey(col, row);
      bakedCells[key] = !isBlocked;
      if (isBlocked) blocked++;
      else walkable++;
    }
  }

  // Preserve explicit editor paint as overrides, but refresh the baked base so
  // Erase can restore the newest collider-derived result.
  navWorld.bakedCells = bakedCells;
  navWorld.cells = { ...bakedCells };
  for (const [key, value] of Object.entries(navWorld.paintOverrides || {})) {
    navWorld.cells[key] = !!value;
  }

  const finalWalkable = Object.values(navWorld.cells).filter(v => v === true).length;
  const finalBlocked = Object.values(navWorld.cells).filter(v => v === false).length;

  // A new bake changes topology, so no agent (of any radius) may reuse
  // an old route — invalidating the whole runtime drops every derived
  // per-radius layer, not just a single mesh-wide cache.
  invalidateNavWorldRuntime(navWorld);
  return { walkable: finalWalkable, blocked: finalBlocked };
}
