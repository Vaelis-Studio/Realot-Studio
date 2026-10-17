/**
 * StrokePathGeometry.js
 *
 * Robust polyline stroke tessellation used by StrokePath rendering and the
 * editor preview. The previous implementation built one large silhouette
 * polygon and then assumed that its two sides had identical vertex counts.
 * That assumption breaks as soon as a round cap/join inserts extra vertices,
 * which can produce crossed triangles, disappearing strips and broken UVs.
 *
 * This version tessellates the stroke as an indexed triangle list directly:
 *   - every source segment is its own quad;
 *   - sharp/bevel turns are closed with deterministic join triangles;
 *   - round turns use an outer arc fan and an inner bridge;
 *   - round caps use true semicircle fans;
 *   - every vertex carries an arc-length `u` for stable texture mapping.
 *
 * Runtime-only, renderer-agnostic geometry.
 */

import { StrokePathJointMode, StrokePathCapMode } from "./StrokePath.js";

const EPS = 1e-6;
// <= 6 degrees per round sample (was 18) — a round joint/cap at typical
// road/river thickness was visibly faceted ("circle thingy" made of flat
// sides instead of a true curve). 6 degrees keeps every round arc looking
// like a real circle at any reasonable radius while MAX_ROUND_STEPS still
// bounds the worst case (a near-180-degree hairpin) to a sane triangle count.
const ARC_STEP_ANGLE = Math.PI / 30;
const MAX_ROUND_STEPS = 32;
const MITER_LIMIT = 4;

function finitePoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * Resamples an authored point list into a smooth Catmull-Rom spline, so a
 * StrokePath drawn as a hand-placed polyline (the only way points are ever
 * created — see StrokePathGizmo.js) can still read as a continuous curve
 * instead of a sequence of straight segments glued together at each
 * clicked point. This is what actually fixes texture pinching/warping on a
 * turn: the joint math in buildStrokePathMesh only ever has to bridge a
 * gentle bend between consecutive SAMPLE points now, never the original
 * sharp author-time corner.
 *
 * `amount` is 0-1 (StrokePath.smoothing): 0 returns `points` untouched
 * (existing paths keep their exact original shape); higher values pull the
 * spline tighter to true Catmull-Rom (amount=1) versus blending toward the
 * original straight polyline at lower amounts, so a user can dial in
 * anything from "just take the edge off" to "full smooth curve" rather
 * than only having on/off.
 *
 * Every ORIGINAL point remains a pass-through point on the resulting
 * curve — this is a curve THROUGH the authored points, not an approximation
 * that drifts away from them, so dragging a handle in the editor still
 * means "the curve passes through here" exactly like the unsmoothed path
 * does today.
 */
function resampleSmoothPoints(points, amount) {
  if (!Array.isArray(points) || points.length < 3) return points;
  const t = Math.max(0, Math.min(1, Number(amount) || 0));
  if (t <= EPS) return points;

  // Open-path Catmull-Rom: clamp the virtual control points before the
  // first and after the last sample by reflecting the adjacent segment,
  // so the curve doesn't overshoot past the path's own endpoints (a
  // StrokePath's start/end must stay exactly where authored).
  const p = points;
  const n = p.length;
  const get = (i) => p[Math.max(0, Math.min(n - 1, i))];

  // Sample density scales with amount so a light touch (t small) adds only
  // a few in-between points per segment (cheap, nearly-straight-but-eased),
  // while a full curve (t near 1) samples densely enough to look genuinely
  // round even on a tight turn.
  const stepsPerSegment = Math.max(1, Math.round(2 + t * 10));

  const out = [get(0)];
  for (let i = 0; i < n - 1; i++) {
    const p0 = i === 0 ? { x: get(0).x * 2 - get(1).x, y: get(0).y * 2 - get(1).y } : get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = i + 2 >= n ? { x: get(n - 1).x * 2 - get(n - 2).x, y: get(n - 1).y * 2 - get(n - 2).y } : get(i + 2);

    for (let s = 1; s <= stepsPerSegment; s++) {
      const u = s / stepsPerSegment;
      const u2 = u * u;
      const u3 = u2 * u;
      // Catmull-Rom basis (tau=0.5, the standard "centripetal-adjacent"
      // uniform variant) — smooth C1-continuous curve through p1..p2.
      const cx =
        0.5 *
        ((2 * p1.x) +
          (-p0.x + p2.x) * u +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3);
      const cy =
        0.5 *
        ((2 * p1.y) +
          (-p0.y + p2.y) * u +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3);
      // Blend the spline sample toward the straight-line point at this same
      // `u` so partial `amount` values ease the curve in rather than
      // snapping straight from 0 (raw polyline) to full spline the instant
      // smoothing becomes nonzero.
      const lx = p1.x + (p2.x - p1.x) * u;
      const ly = p1.y + (p2.y - p1.y) * u;
      out.push({ x: lx + (cx - lx) * t, y: ly + (cy - ly) * t });
    }
  }
  return out;
}

function normalize(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len < EPS) return null;
  return { x: dx / len, y: dy / len, len };
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

function dot(ax, ay, bx, by) {
  return ax * bx + ay * by;
}

function intersectLines(a, da, b, db) {
  const d = cross(da.x, da.y, db.x, db.y);
  if (Math.abs(d) < 1e-5) return null;
  const t = cross(b.x - a.x, b.y - a.y, db.x, db.y) / d;
  return { x: a.x + da.x * t, y: a.y + da.y * t };
}

function pushTri(state, a, b, c) {
  if (a === b || b === c || c === a) return;
  const ax = state.vertices[a * 2], ay = state.vertices[a * 2 + 1];
  const bx = state.vertices[b * 2], by = state.vertices[b * 2 + 1];
  const cx = state.vertices[c * 2], cy = state.vertices[c * 2 + 1];
  const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area2) < EPS) return;
  state.indices.push(a, b, c);
}

function makeUVRotator(textureRotation) {
  const rotRad = ((textureRotation || 0) * Math.PI) / 180;
  if (Math.abs(rotRad) < EPS) return (u, v) => [u, v];
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  return (u, v) => {
    const tileU = u - Math.floor(u);
    const du = tileU - 0.5;
    const dv = v - 0.5;
    const ru = du * cosR - dv * sinR;
    const rv = du * sinR + dv * cosR;
    return [u - tileU + 0.5 + ru, 0.5 + rv];
  };
}

/**
 * Builds a robust indexed mesh for a StrokePath.
 *
 * The returned vertices/indices are ordinary triangle-list geometry; there is
 * deliberately no assumption that the left and right sides contain the same
 * number of points. This makes round joins/caps safe.
 */
export function buildStrokePathMesh(
  points,
  thickness,
  jointMode,
  capMode,
  textureMode,
  textureTiling,
  textureScale,
  textureOffset,
  textureFlip,
  textureRotation,
  smoothing
) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const halfWidth = Math.max(0, Number(thickness) || 0) / 2;
  if (halfWidth <= EPS) return null;

  // Remove invalid points and collapse adjacent duplicates FIRST — the
  // spline resampler assumes clean, distinct control points, and this also
  // protects editor dragging (a mid-drag zero-length segment must not
  // create a NaN normal that poisons the whole mesh).
  const rawClean = [];
  for (const p of points) {
    if (!finitePoint(p)) continue;
    const q = { x: p.x, y: p.y };
    if (!rawClean.length || Math.hypot(q.x - rawClean[rawClean.length - 1].x, q.y - rawClean[rawClean.length - 1].y) >= EPS) {
      rawClean.push(q);
    }
  }
  if (rawClean.length < 2) return null;

  // Smooth the centerline into a spline BEFORE building segments, so every
  // downstream step (segment normals, joins, texture U) operates on the
  // already-curved sample points and never sees the original sharp corner.
  const smoothed = resampleSmoothPoints(rawClean, smoothing);
  const clean = [];
  for (const p of smoothed) {
    if (!finitePoint(p)) continue;
    if (!clean.length || Math.hypot(p.x - clean[clean.length - 1].x, p.y - clean[clean.length - 1].y) >= EPS) {
      clean.push(p);
    }
  }
  if (clean.length < 2) return null;

  const segments = [];
  let pathLength = 0;
  for (let i = 0; i < clean.length - 1; i++) {
    const a = clean[i];
    const b = clean[i + 1];
    const n = normalize(b.x - a.x, b.y - a.y);
    if (!n) continue;
    const nx = -n.y;
    const ny = n.x;
    segments.push({
      a,
      b,
      dx: n.x,
      dy: n.y,
      nx,
      ny,
      u0: pathLength,
      u1: pathLength + n.len,
    });
    pathLength += n.len;
  }
  if (!segments.length) return null;

  const joint = jointMode || StrokePathJointMode.SHARP;
  const cap = capMode || StrokePathCapMode.NONE;
  const textureIsTile = textureMode === "tile";
  const safeTiling = Math.max(EPS, Number(textureTiling) || 1);
  const safeScale = Math.max(0.001, Number(textureScale) || 1);
  const uScale = textureIsTile ? 1 / safeTiling : 1 / Math.max(EPS, pathLength);
  const uOffset = (Number(textureOffset) || 0) * uScale;
  const vLeft = textureFlip ? safeScale : 0;
  const vRight = textureFlip ? 0 : safeScale;
  const rotateUV = makeUVRotator(textureRotation);

  // Keep rotation isolated to UV creation so geometry remains reusable.
  const uvAdapter = (u, v) => {
    const [ru, rv] = rotateUV(u * uScale - uOffset, v);
    return { u: ru, v: rv };
  };

  const state = {
    vertices: [],
    uvs: [],
    indices: [],
    uScale,
    uOffset,
  };

  // Local vertex helper that performs texture-space rotation before writing.
  function vertex(p, sideV) {
    const uv = uvAdapter(p.u, sideV);
    const i = state.vertices.length / 2;
    state.vertices.push(p.x, p.y);
    state.uvs.push(uv.u, uv.v);
    return i;
  }

  function offset(seg, atStart, sign) {
    const p = atStart ? seg.a : seg.b;
    return {
      x: p.x + seg.nx * halfWidth * sign,
      y: p.y + seg.ny * halfWidth * sign,
      u: atStart ? seg.u0 : seg.u1,
    };
  }

  // Each segment is independently valid. This is the key invariant: a bad
  // join can never make the whole strip disappear because its base quad still
  // exists and is correctly bounded.
  const segmentVerts = segments.map((seg) => ({
    left0: vertex(offset(seg, true, +1), vLeft),
    right0: vertex(offset(seg, true, -1), vRight),
    left1: vertex(offset(seg, false, +1), vLeft),
    right1: vertex(offset(seg, false, -1), vRight),
  }));

  for (let i = 0; i < segments.length; i++) {
    const s = segmentVerts[i];
    pushTri(state, s.left0, s.right0, s.left1);
    pushTri(state, s.left1, s.right0, s.right1);
  }

  function addJoinBridge(i) {
    const seg = segments[i];
    const next = segments[i + 1];
    const cur = segmentVerts[i];
    const nxt = segmentVerts[i + 1];
    const center = { x: seg.b.x, y: seg.b.y, u: seg.u1 };

    const crossTurn = cross(seg.dx, seg.dy, next.dx, next.dy);
    if (Math.abs(crossTurn) < 1e-5 || dot(seg.dx, seg.dy, next.dx, next.dy) < -0.9999) {
      // Straight-back or nearly 180-degree joins are numerically hostile to
      // miter math. Two center triangles provide a stable continuous strip.
      const c = vertex(center, (vLeft + vRight) * 0.5);
      pushTri(state, cur.left1, c, nxt.left0);
      pushTri(state, cur.right1, nxt.right0, c);
      return;
    }

    if (joint === StrokePathJointMode.ROUND) {
      // The inner side is safely bridged through the joint center. The outer
      // side gets a sampled circular fan, which is the visually important
      // part of a round line join.
      const turningLeft = crossTurn > 0;
      const outerSign = turningLeft ? -1 : +1;
      const outerA = offset(seg, false, outerSign);
      const outerB = offset(next, true, outerSign);
      const startAngle = Math.atan2(outerA.y - center.y, outerA.x - center.x);
      let delta = Math.atan2(outerB.y - center.y, outerB.x - center.x) - startAngle;
      // Sweep the short arc in the direction that stays on the outside.
      if (turningLeft) {
        while (delta > 0) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
      } else {
        while (delta < 0) delta += Math.PI * 2;
        while (delta > Math.PI) delta -= Math.PI * 2;
      }
      const steps = Math.min(MAX_ROUND_STEPS, Math.max(2, Math.ceil(Math.abs(delta) / ARC_STEP_ANGLE)));
      const centerIdx = vertex(center, turningLeft ? vRight : vLeft);
      let prevIdx = vertex(outerA, turningLeft ? vRight : vLeft);
      // Do not give every point on the round arc the exact same U. That
      // collapses the entire outside of a bend onto one texture column,
      // which is the source of the "pinched/distorted" texture seen while
      // placing points on curves. Instead, let U follow the actual arc
      // length. The extra distance is only a few pixels for normal joins,
      // but it keeps stripes/roads/tiles flowing naturally around the bend.
      const arcLength = Math.abs(delta) * halfWidth;
      for (let sidx = 1; sidx <= steps; sidx++) {
        const t = sidx / steps;
        const a = startAngle + delta * t;
        const arcU = seg.u1 + (turningLeft ? -1 : +1) * arcLength * t;
        const arcP = { x: center.x + Math.cos(a) * halfWidth, y: center.y + Math.sin(a) * halfWidth, u: arcU };
        const curIdx = vertex(arcP, turningLeft ? vRight : vLeft);
        pushTri(state, centerIdx, prevIdx, curIdx);
        prevIdx = curIdx;
      }
      const innerPrev = turningLeft ? cur.left1 : cur.right1;
      const innerNext = turningLeft ? nxt.left0 : nxt.right0;
      pushTri(state, innerPrev, centerIdx, innerNext);
      return;
    }

    // Sharp uses a true miter where it is reasonable; bevel uses the raw
    // offset corners. Both are bounded so very acute turns cannot create a
    // giant spike across unrelated geometry.
    const leftA = offset(seg, false, +1);
    const leftB = offset(next, true, +1);
    const rightA = offset(seg, false, -1);
    const rightB = offset(next, true, -1);

    let leftJoin = leftA;
    let rightJoin = rightA;
    if (joint === StrokePathJointMode.SHARP) {
      const leftHit = intersectLines(leftA, { x: seg.dx, y: seg.dy }, leftB, { x: next.dx, y: next.dy });
      const rightHit = intersectLines(rightA, { x: seg.dx, y: seg.dy }, rightB, { x: next.dx, y: next.dy });
      if (leftHit && Math.hypot(leftHit.x - center.x, leftHit.y - center.y) <= halfWidth * MITER_LIMIT) {
        leftJoin = { ...leftHit, u: seg.u1 };
      }
      if (rightHit && Math.hypot(rightHit.x - center.x, rightHit.y - center.y) <= halfWidth * MITER_LIMIT) {
        rightJoin = { ...rightHit, u: seg.u1 };
      }
    }

    const leftIdx = vertex(leftJoin, vLeft);
    const rightIdx = vertex(rightJoin, vRight);
    pushTri(state, cur.left1, leftIdx, nxt.left0);
    pushTri(state, cur.right1, nxt.right0, rightIdx);

    if (joint === StrokePathJointMode.BEVEL) {
      // The central quad closes the bevel cut without relying on polygon
      // winding or a renderer's concave-polygon triangulator.
      const a = vertex(leftA, vLeft);
      const b = vertex(rightA, vRight);
      const c = vertex(leftB, vLeft);
      const d = vertex(rightB, vRight);
      pushTri(state, a, b, c);
      pushTri(state, c, b, d);
    } else {
      // For sharp/miter joints, fill the small interior wedge between the two
      // miter intersections. This prevents pinholes at obtuse turns.
      const c = vertex(center, (vLeft + vRight) * 0.5);
      pushTri(state, leftIdx, c, rightIdx);
    }
  }

  for (let i = 0; i < segments.length - 1; i++) addJoinBridge(i);

  function addCap(seg, atStart) {
    const p = atStart ? seg.a : seg.b;
    if (cap === StrokePathCapMode.NONE) return;

    // Build caps from the segment basis directly instead of deriving a sweep
    // from atan2 differences. The old approach could jump between equivalent
    // +/- PI representations while a point was being dragged, which made a
    // round endpoint visibly hitch/pop near straight-line orientations.
    const forwardSign = atStart ? -1 : +1;
    const dirX = seg.dx * forwardSign;
    const dirY = seg.dy * forwardSign;

    if (cap === StrokePathCapMode.BOX) {
      const extU = atStart ? seg.u0 - halfWidth : seg.u1 + halfWidth;
      const extLeft = {
        x: p.x + seg.nx * halfWidth + dirX * halfWidth,
        y: p.y + seg.ny * halfWidth + dirY * halfWidth,
        u: extU,
      };
      const extRight = {
        x: p.x - seg.nx * halfWidth + dirX * halfWidth,
        y: p.y - seg.ny * halfWidth + dirY * halfWidth,
        u: extU,
      };
      const edgeLeft = offset(seg, atStart, +1);
      const edgeRight = offset(seg, atStart, -1);
      if (atStart) {
        const a = vertex(extLeft, vLeft);
        const b = vertex(extRight, vRight);
        const c = vertex(edgeLeft, vLeft);
        const d = vertex(edgeRight, vRight);
        pushTri(state, a, b, c);
        pushTri(state, c, b, d);
      } else {
        const a = vertex(edgeLeft, vLeft);
        const b = vertex(edgeRight, vRight);
        const c = vertex(extLeft, vLeft);
        const d = vertex(extRight, vRight);
        pushTri(state, a, b, c);
        pushTri(state, c, b, d);
      }
      return;
    }

    // Stable semicircle: theta=0 starts at the left side of the segment and
    // theta=PI ends at the right side. The sign is encoded by the cap's
    // outward travel direction, so the arc never changes branch while the
    // endpoint is moved.
    const baseU = atStart ? seg.u0 : seg.u1;
    const steps = 10;
    const centerU = atStart ? baseU - halfWidth * Math.PI * 0.5 : baseU + halfWidth * Math.PI * 0.5;
    const centerIdx = vertex({ x: p.x, y: p.y, u: baseU }, (vLeft + vRight) * 0.5);
    let prevIdx = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const theta = Math.PI * t;
      const radialX = seg.nx * Math.cos(theta) + dirX * Math.sin(theta);
      const radialY = seg.ny * Math.cos(theta) + dirY * Math.sin(theta);
      const arcU = atStart
        ? baseU - halfWidth * theta
        : baseU + halfWidth * theta;
      const sideV = i <= steps * 0.5 ? vLeft : vRight;
      const idx = vertex({
        x: p.x + radialX * halfWidth,
        y: p.y + radialY * halfWidth,
        u: arcU,
      }, sideV);
      if (prevIdx !== null) pushTri(state, centerIdx, prevIdx, idx);
      prevIdx = idx;
    }
  }

  addCap(segments[0], true);
  addCap(segments[segments.length - 1], false);

  const vertexCount = state.vertices.length / 2;
  if (vertexCount < 3 || state.indices.length < 3) return null;

  // Rotate UVs were already baked into state. Use Uint16 while possible and
  // promote only very large paths to Uint32 so the mesh remains efficient.
  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
  return {
    vertices: new Float32Array(state.vertices),
    uvs: new Float32Array(state.uvs),
    indices: new IndexArray(state.indices),
  };
}

/**
 * Backwards-compatible outline helper. The renderer no longer relies on a
 * concave Graphics polygon for StrokePaths, but editor callers historically
 * imported this function. It now returns the clean centerline-offset bounds
 * generated from segment endpoints so those callers never receive the old
 * malformed round-cap polygon.
 */
export function buildStrokePathPolygon(points, thickness, jointMode, capMode, smoothing) {
  const mesh = buildStrokePathMesh(points, thickness, jointMode, capMode, "stretch", 1, 1, 0, false, 0, smoothing);
  if (!mesh) return [];
  const out = [];
  for (let i = 0; i < mesh.vertices.length; i += 2) {
    out.push({ x: mesh.vertices[i], y: mesh.vertices[i + 1], u: 0 });
  }
  return out;
}

export function getStrokePathLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    if (!finitePoint(points[i]) || !finitePoint(points[i + 1])) continue;
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return total;
}
