/**
 * runtime/systems/JointVisualSmoothing.js
 *
 * Visual-only stabilization for flexible Joint2D ropes/strings.
 *
 * PhysicsWorld remains the sole owner of the real rope simulation. This
 * helper receives the already-simulated link positions and produces a
 * renderer-friendly version that suppresses tiny solver jitter without
 * changing endpoint positions or feeding anything back into physics.
 *
 * The second half of the file turns the stabilized control points into a
 * dense cubic path. A centripetal-style Catmull-Rom construction keeps the
 * rope visually continuous, while each sample is clamped to the local four-
 * point bounds so a tight bend cannot create an exaggerated spline overshoot.
 *
 * RUNTIME-ONLY FILE.
 */

const EPS = 1e-6;
const DEFAULT_RESPONSE = 24;
const MAX_RESPONSE = 44;
const DEFAULT_DEAD_ZONE = 0.2;
const DEFAULT_SUBDIVISIONS = 4;

function finitePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function clonePoints(points) {
  return points.map((point) => ({ x: point.x, y: point.y }));
}

function averageSegmentLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y
    );
    if (length > EPS) {
      total += length;
      count++;
    }
  }
  return count ? total / count : 0;
}

function cubicPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function clampCurvePoint(point, p0, p1, p2, p3) {
  const minX = Math.min(p0.x, p1.x, p2.x, p3.x);
  const maxX = Math.max(p0.x, p1.x, p2.x, p3.x);
  const minY = Math.min(p0.y, p1.y, p2.y, p3.y);
  const maxY = Math.max(p0.y, p1.y, p2.y, p3.y);
  return {
    x: Math.max(minX, Math.min(maxX, point.x)),
    y: Math.max(minY, Math.min(maxY, point.y)),
  };
}

/**
 * Samples a smooth, overshoot-safe open path through the supplied control
 * points. The endpoints stay exact. Interior link positions define a
 * Catmull-Rom-style centerline, then each sample is kept inside the local
 * four-point bounds so the renderer cannot invent a large bulge outside the
 * simulated chain.
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {number} subdivisions samples per physical span
 * @returns {Array<{x:number,y:number}>}
 */
export function sampleSmoothJointPath(points, subdivisions = DEFAULT_SUBDIVISIONS) {
  if (!Array.isArray(points) || points.length < 2) return [];
  if (points.length === 2) return clonePoints(points);

  const steps = Math.max(2, Math.min(8, Math.round(Number(subdivisions) || DEFAULT_SUBDIVISIONS)));
  const n = points.length;
  const get = (index) => points[Math.max(0, Math.min(n - 1, index))];
  const out = [{ x: points[0].x, y: points[0].y }];

  for (let i = 0; i < n - 1; i++) {
    const p0 = i === 0
      ? { x: points[0].x * 2 - points[1].x, y: points[0].y * 2 - points[1].y }
      : get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = i + 2 >= n
      ? {
          x: points[n - 1].x * 2 - points[n - 2].x,
          y: points[n - 1].y * 2 - points[n - 2].y,
        }
      : get(i + 2);

    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      let sample = cubicPoint(p0, p1, p2, p3, t);
      sample = clampCurvePoint(sample, p0, p1, p2, p3);
      // Preserve exact physical control points at span boundaries.
      if (step === steps) sample = { x: p2.x, y: p2.y };
      out.push(sample);
    }
  }

  out[0] = { x: points[0].x, y: points[0].y };
  out[out.length - 1] = { x: points[n - 1].x, y: points[n - 1].y };
  return out;
}

export class JointVisualSmoothing {
  constructor({
    response = DEFAULT_RESPONSE,
    maxResponse = MAX_RESPONSE,
    deadZone = DEFAULT_DEAD_ZONE,
    subdivisions = DEFAULT_SUBDIVISIONS,
  } = {}) {
    this.response = Math.max(1, Number(response) || DEFAULT_RESPONSE);
    this.maxResponse = Math.max(this.response, Number(maxResponse) || MAX_RESPONSE);
    this.deadZone = Math.max(0, Number(deadZone) || DEFAULT_DEAD_ZONE);
    this.subdivisions = Math.max(2, Math.min(8, Math.round(Number(subdivisions) || DEFAULT_SUBDIVISIONS)));
    /** @type {Map<string, Array<{x:number,y:number}>>} */
    this._states = new Map();
  }

  /**
   * Smooth only the interior points. Endpoints always come directly from
   * PhysicsWorld so the drawn rope stays visually pinned to the exact joint
   * anchors even while the bodies are moving quickly.
   *
   * @param {string} entityId
   * @param {Array<{x:number,y:number}>} rawPoints
   * @param {number} dtSeconds
   * @returns {Array<{x:number,y:number}>}
   */
  smooth(entityId, rawPoints, dtSeconds) {
    if (!entityId || !Array.isArray(rawPoints) || rawPoints.length < 2) return [];
    if (!rawPoints.every(finitePoint)) return clonePoints(rawPoints.filter(finitePoint));

    const previous = this._states.get(entityId);
    if (!previous || previous.length !== rawPoints.length) {
      const initialized = clonePoints(rawPoints);
      this._states.set(entityId, initialized);
      return initialized.map((point) => ({ ...point }));
    }

    const dt = Math.max(1 / 240, Math.min(0.1, Number(dtSeconds) > 0 ? Number(dtSeconds) : 1 / 60));
    const segmentScale = averageSegmentLength(rawPoints);
    // Large jumps are scene resets/teleports much more often than they are
    // ordinary rope motion. Following them immediately avoids a long visual
    // tail while normal frame-to-frame solver noise still gets filtered.
    const snapDistance = Math.max(64, segmentScale * 3.5);
    const next = new Array(rawPoints.length);

    next[0] = { x: rawPoints[0].x, y: rawPoints[0].y };
    for (let i = 1; i < rawPoints.length - 1; i++) {
      const prev = previous[i];
      const raw = rawPoints[i];
      const dx = raw.x - prev.x;
      const dy = raw.y - prev.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= this.deadZone) {
        next[i] = { x: prev.x, y: prev.y };
        continue;
      }

      if (distance >= snapDistance) {
        next[i] = { x: raw.x, y: raw.y };
        continue;
      }

      // Track genuinely moving rope sections faster than tiny jitter. This
      // keeps fast swings responsive while leaving solver shimmer heavily
      // damped instead of making the visible line buzz with every link solve.
      const speed = distance / dt;
      const adaptiveResponse = Math.min(
        this.maxResponse,
        this.response + Math.min(this.maxResponse - this.response, speed / 180)
      );
      const alpha = 1 - Math.exp(-adaptiveResponse * dt);

      next[i] = {
        x: prev.x + dx * alpha,
        y: prev.y + dy * alpha,
      };
    }
    next[next.length - 1] = {
      x: rawPoints[rawPoints.length - 1].x,
      y: rawPoints[rawPoints.length - 1].y,
    };

    this._states.set(entityId, next);
    return next.map((point) => ({ ...point }));
  }

  /**
   * Turns stabilized physical controls into the dense centerline consumed by
   * both Graphics and the textured rope mesh.
   */
  smoothAndSample(entityId, rawPoints, dtSeconds) {
    return sampleSmoothJointPath(
      this.smooth(entityId, rawPoints, dtSeconds),
      this.subdivisions
    );
  }

  forgetMissing(activeIds) {
    for (const entityId of this._states.keys()) {
      if (!activeIds.has(entityId)) this._states.delete(entityId);
    }
  }

  clear() {
    this._states.clear();
  }
}
