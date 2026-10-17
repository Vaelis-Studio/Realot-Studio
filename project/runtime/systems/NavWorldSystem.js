/**
 * runtime/systems/NavWorldSystem.js
 *
 * ============================================================
 * 2D NAVIGATION ARCHITECTURE — read this before touching Nav code
 * ============================================================
 *
 * Goal: large open-world scenes with many NPCs, low CPU cost, without
 * sacrificing reasonable pathfinding accuracy. Concretely:
 *
 *  1. ONE shared NavWorld2D per scene (components/NavWorld2D.js) holds
 *     the baked navigation grid. NEVER a separate navigation world per
 *     agent — every NavAgent2D in the scene queries the SAME baked
 *     dataset.
 *
 *  2. Baking (pathfinding/NavWorldBaker.js) produces RAW, unpadded
 *     obstacle topology from every static Collider2D. It does not know
 *     about agent radius at all.
 *
 *  3. Agent radius lives on NavAgent2D (components/NavAgent2D.js), NOT
 *     on NavWorld2D. Different NavAgent2D instances — Small (0.25),
 *     Medium (0.5), Large (1.5) — can all query the same NavWorld2D; a
 *     narrow passage can be walkable for Small and blocked for Large,
 *     without the world itself changing. Radius clearance is applied
 *     LAZILY, once per unique radius value (not once per agent
 *     instance), by NavWorld2D.getAgentNavLayer() — see that function's
 *     doc comment for the erosion approach.
 *
 *  4. Final walkability pipeline, per the design brief:
 *
 *       Baked Navigation (NavWorldBaker, raw geometry)
 *             |
 *       User Overrides (paintOverrides -- hand-painted cells)
 *             |
 *       Navigation Area/Layer (NavWorld2D.cellAreas + NavAgent2D.area)
 *             |
 *       Agent Radius / Size (NavWorld2D.getAgentNavLayer)
 *             |
 *       Final Walkable Navigation  <-- what findPathForAgent() returns
 *
 *  5. Pathfinding and local avoidance are SEPARATE concerns. This
 *     system (+ AStar.js) only answers "how do I get there" against
 *     the shared, cached grid. "How do I avoid the NPC directly in
 *     front of me" is NavAgent2D.avoidanceEnabled/avoidancePriority,
 *     consumed by whichever movement code steers the agent each frame
 *     (see ScriptAPI.navMoveToward) -- it never touches the NavWorld2D
 *     or re-plans a path, so cheap per-frame steering and expensive
 *     A* search never compete for the same budget.
 *
 *  6. Performance discipline this system follows:
 *       - No per-frame pathfinding. A* runs on demand, and results are
 *         cached per (radius layer, start, goal) -- see AStar.js.
 *       - No per-frame full re-bake. `dynamic` NavWorld2D entities are
 *         checked via a cheap collider SIGNATURE string each frame
 *         (_checkAutoRebake/_colliderSignature below) and only actually
 *         re-baked when something with baking relevance changed.
 *       - Distant/rarely-moving agents are expected to stagger their
 *         own repath timing via NavAgent2D.repathInterval/autoRepath
 *         (consumed by ScriptAPI.navMoveToward) rather than this system
 *         forcing every agent to replan on the same frame.
 *
 * This system deliberately does NOT touch PIXI or draw anything -- a
 * NavWorld2D has no per-frame visual output of its own in the shipped
 * game (only the editor's NavWorldGizmo.js draws the cell grid, and
 * that's editor-only chrome, layered on top by SceneViewport rather
 * than by anything under runtime/). This system's whole job is the
 * same shape as PhysicsWorld.castRay's relationship to physics.raycast:
 * own the real query logic here, keep ScriptAPI/NavAPI.js as a thin
 * forwarding wrapper -- see runtime/index.js's `scriptApi._navFindPathFn`
 * wiring.
 *
 * update() only does bookkeeping -- no per-frame work is actually
 * required for pathfinding (A* runs on demand, not continuously), but
 * a System.update(world) is still implemented so this participates in
 * World's system list like every other System.
 *
 * RUNTIME-ONLY FILE.
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { COLLIDER_2D } from "../components/Collider2D.js";
import { RIGIDBODY_2D, BodyType } from "../components/Rigidbody2D.js";
import { NAV_WORLD_2D, navCellKey, getAgentNavLayer } from "../components/NavWorld2D.js";
import { NAV_AGENT_2D } from "../components/NavAgent2D.js";
import { findGridPath, smoothGridPath, nearestWalkable } from "../pathfinding/AStar.js";
import { bakeNavWorld } from "../pathfinding/NavWorldBaker.js";

export class NavWorldSystem extends System {
  constructor() {
    super();
    this._world = null;
    // entity.id -> last-seen signature string, one entry per NavWorld2D
    // entity currently marked `dynamic`. Used by _checkAutoRebake to
    // detect "something moved/spawned/was destroyed" WITHOUT actually
    // re-baking every frame -- see that method's doc comment.
    this._dynamicSignatures = new Map();
  }

  update(world) {
    // Keep a reference so find/bake helpers below don't need the
    // caller to pass `world` through every call.
    this._world = world;
    this._checkAutoRebake();
  }

  /**
   * Auto-rebake for every NavWorld2D entity whose `dynamic` flag is on.
   * Re-baking itself (bakeNavWorld) rescans every Collider2D in the
   * world, which is too expensive to simply run unconditionally every
   * frame -- so instead this builds a cheap SIGNATURE string each frame
   * (entity count + each Collider2D's id/shape/transform, all rounded
   * to whole pixels/degrees) and only calls bakeNavWorld when that
   * signature actually changed from last frame.
   */
  _checkAutoRebake() {
    if (!this._world) return;
    const navEntities = this._world.query(TRANSFORM, NAV_WORLD_2D);
    for (const navEntity of navEntities) {
      const navWorld = navEntity.getComponent(NAV_WORLD_2D);
      if (!navWorld.dynamic) {
        this._dynamicSignatures.delete(navEntity.id);
        continue;
      }
      const signature = this._colliderSignature();
      const prev = this._dynamicSignatures.get(navEntity.id);
      if (prev === undefined) {
        // First frame this NavWorld2D has been seen as dynamic -- record
        // the baseline WITHOUT baking, so toggling "Dynamic" on doesn't
        // itself force an immediate rebake of an already-correct world.
        this._dynamicSignatures.set(navEntity.id, signature);
        continue;
      }
      if (prev !== signature) {
        this._dynamicSignatures.set(navEntity.id, signature);
        bakeNavWorld(navWorld, this._world, navEntity.getComponent(TRANSFORM));
      }
    }
  }

  /**
   * Cheap per-frame fingerprint of every Collider2D in the world that
   * NavWorldBaker.bakeNavWorld() would actually bake as an obstacle:
   * entity id, shape, rounded position/rotation, rounded size fields.
   * Rounded (not raw floats) so a physics engine's sub-pixel jitter on
   * a resting body doesn't trigger a rebake every single frame -- only
   * a change big enough to plausibly affect which grid cell a collider
   * occupies does.
   *
   * MUST mirror bakeNavWorld's own inclusion rule exactly (trigger skip,
   * Dynamic/Kinematic rigidbody skip) -- otherwise a mover the baker
   * already ignores would still change this signature every frame just
   * by moving, forcing a rebake that changes nothing.
   */
  _colliderSignature() {
    const entities = this._world.query(TRANSFORM, COLLIDER_2D);
    let sig = "";
    for (const entity of entities) {
      const t = entity.getComponent(TRANSFORM);
      const c = entity.getComponent(COLLIDER_2D);
      if (c.isTrigger) continue;
      const rigidbody = entity.getComponent(RIGIDBODY_2D);
      if (rigidbody && rigidbody.bodyType !== BodyType.STATIC) continue;
      const q = (value) => Math.round((Number(value) || 0) * 10000) / 10000;
      const triangle = Array.isArray(c.trianglePoints)
        ? c.trianglePoints.map((p) => `${q(p.x)},${q(p.y)}`).join(";")
        : "";
      sig += entity.id + ":" + c.shape + ":" +
        q(t.x) + "," + q(t.y) + "," + q(t.rotation || 0) + "," + q(t.scaleX) + "," + q(t.scaleY) + ":" +
        q(c.width) + "," + q(c.height) + "," + q(c.radius) + "," +
        q(c.capsuleHalfHeight) + "," + q(c.capsuleRadius) + "," +
        q(c.offsetX) + "," + q(c.offsetY) + "," + triangle + "|";
    }
    return sig;
  }

  /**
   * Returns the first NavWorld2D entity in the scene, or null.
   * NavWorld2D entities are conventionally one-per-scene (same
   * convention Tilemap uses), so "first found" is the sensible default
   * for every API below that doesn't take an explicit target.
   */
  _firstNavWorld() {
    if (!this._world) return null;
    const entities = this._world.query(TRANSFORM, NAV_WORLD_2D);
    for (const entity of entities) return entity;
    return null;
  }

  /**
   * World-space (x,y) -> grid cell, relative to the NavWorld2D entity's
   * OWN bounds origin -- a NavWorld2D entity's Transform.x/y is treated
   * as an additional offset on top of boundsX/boundsY.
   */
  worldToCell(navWorldEntity, worldX, worldY) {
    const navWorld = navWorldEntity.getComponent(NAV_WORLD_2D);
    const transform = navWorldEntity.getComponent(TRANSFORM);
    const localX = worldX - transform.x - navWorld.boundsX;
    const localY = worldY - transform.y - navWorld.boundsY;
    return {
      col: Math.floor(localX / navWorld.cellSize),
      row: Math.floor(localY / navWorld.cellSize),
    };
  }

  cellToWorld(navWorldEntity, col, row) {
    const navWorld = navWorldEntity.getComponent(NAV_WORLD_2D);
    const transform = navWorldEntity.getComponent(TRANSFORM);
    return {
      x: transform.x + navWorld.boundsX + (col + 0.5) * navWorld.cellSize,
      y: transform.y + navWorld.boundsY + (row + 0.5) * navWorld.cellSize,
    };
  }

  /** Base walkability (radius 0, ignores per-agent area filtering). */
  isWalkable(navWorldEntity, worldX, worldY) {
    const navWorld = navWorldEntity.getComponent(NAV_WORLD_2D);
    const { col, row } = this.worldToCell(navWorldEntity, worldX, worldY);
    return navWorld.cells[navCellKey(col, row)] === true;
  }

  /**
   * @returns {{x:number,y:number}[]|null} world-space waypoints from
   *   (startX,startY) to (goalX,goalY) INCLUSIVE, or null if no path.
   *   Waypoints preserve the exact walkable start/goal positions and
   *   use collision-safe string-pulling to remove grid stair-steps.
   * @param {number} [radius] agent clearance in world units (default 0
   *   -- the base baked layer with no erosion). Pass a NavAgent2D's
   *   `radius` so the path actually respects that agent's size -- see
   *   findPathForAgent() below for the convenience wrapper that reads
   *   it off the component directly.
   * @param {number} [areaMask] bitmask of allowed NavWorld2D area slots
   *   (see NavAgent2D.area's header) -- default 0xffff (every area
   *   allowed). A route will never cross a cell whose area isn't in
   *   this mask, same as Unity's NavMeshAgent.areaMask.
   * @param {number[]|null} [agentAreaCosts] optional per-agent cost
   *   override (NavAgent2D.areaCosts) -- default null, meaning "use the
   *   NavWorld2D's own area costs for every area", so existing callers
   *   are unaffected. See getNavAreaCost's header for the fallback rule.
   */
  findPath(navWorldEntity, startX, startY, goalX, goalY, radius = 0, areaMask = 0xffff, agentAreaCosts = null) {
    const navWorld = navWorldEntity.getComponent(NAV_WORLD_2D);
    const start = this.worldToCell(navWorldEntity, startX, startY);
    const goal = this.worldToCell(navWorldEntity, goalX, goalY);
    const gridPath = findGridPath(navWorld, start.col, start.row, goal.col, goal.row, radius, areaMask, agentAreaCosts);
    if (!gridPath) return null;
    const smoothed = smoothGridPath(navWorld, gridPath, radius, areaMask, agentAreaCosts);
    const startWasWalkable = navWorld.cells[navCellKey(start.col, start.row)] === true;
    const goalWasWalkable = navWorld.cells[navCellKey(goal.col, goal.row)] === true;
    const firstCell = gridPath[0];
    const lastCell = gridPath[gridPath.length - 1];
    const startPoint = startWasWalkable
      ? { x: startX, y: startY }
      : this.cellToWorld(navWorldEntity, firstCell.col, firstCell.row);
    const goalPoint = goalWasWalkable
      ? { x: goalX, y: goalY }
      : this.cellToWorld(navWorldEntity, lastCell.col, lastCell.row);

    // Keep the exact start and goal in the public result. In particular,
    // a target in the same cell is a real short path instead of a
    // one-point path to that cell's center.
    const points = [startPoint];
    const append = (point) => {
      const previous = points[points.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0.0001) points.push(point);
    };

    // The regular smoothed route is safe center-to-center. If the exact
    // start lies near a cell edge, begin at its own cell center first;
    // this avoids assuming a center-to-center shortcut is safe from
    // every possible point inside that cell.
    if (smoothed.length > 1) {
      const firstCenter = this.cellToWorld(navWorldEntity, firstCell.col, firstCell.row);
      const nextCenter = this.cellToWorld(navWorldEntity, smoothed[1].col, smoothed[1].row);
      if (!this._isWorldSegmentWalkable(navWorldEntity, startPoint, nextCenter, radius, areaMask)) append(firstCenter);
    }

    for (let i = 1; i < smoothed.length; i++) {
      append(this.cellToWorld(navWorldEntity, smoothed[i].col, smoothed[i].row));
    }
    append(goalPoint);
    return points;
  }

  /**
   * Convenience wrapper: finds a path for a specific NavAgent2D entity,
   * reading its radius AND area mask straight off the component instead
   * of the caller having to thread them through by hand. Uses the
   * first NavWorld2D in the scene (see _firstNavWorld) -- one shared
   * world, many agents, per the architecture doc atop this file.
   * @returns {{x:number,y:number}[]|null}
   */
  findPathForAgent(agentEntity, goalX, goalY) {
    const navWorldEntity = this._firstNavWorld();
    if (!navWorldEntity) return null;
    const agent = agentEntity.getComponent(NAV_AGENT_2D);
    const transform = agentEntity.getComponent(TRANSFORM);
    if (!agent || !transform) return null;
    return this.findPath(navWorldEntity, transform.x, transform.y, goalX, goalY, agent.radius, agent.area, agent.areaCosts);
  }

  /**
   * True if the world-space point (x,y) is walkable for a given agent
   * radius AND area mask -- the full pipeline from this file's header
   * comment (Baked -> Overrides -> Area -> Radius), not just the base
   * layer isWalkable() above gives you. Delegates straight to the
   * cached (radius, areaMask) layer -- see getAgentNavLayer -- so this
   * always agrees with what findPath/findPathForAgent would actually
   * route through for the same radius+mask, rather than recomputing the
   * mask check separately here.
   */
  isWalkableForAgent(navWorldEntity, worldX, worldY, radius, areaMask = 0xffff, agentAreaCosts = null) {
    const navWorld = navWorldEntity.getComponent(NAV_WORLD_2D);
    const { col, row } = this.worldToCell(navWorldEntity, worldX, worldY);
    const layer = getAgentNavLayer(navWorld, radius, areaMask, agentAreaCosts);
    const cols = Math.max(1, Math.ceil(navWorld.boundsWidth / navWorld.cellSize));
    if (col < 0 || row < 0 || col >= cols) return false;
    const idx = row * cols + col;
    return idx < layer.walkable.length && layer.walkable[idx] === 1;
  }

  /**
   * Finds the nearest walkable world-space point for a given agent
   * radius+areaMask, expanding outward ring by ring from (worldX,worldY)
   * — same underlying search findPath()'s own start/goal snapping uses
   * (see AStar.js's nearestWalkable), just exposed directly and with a
   * wider default search ring, for RESCUING an agent that has ended up
   * standing somewhere its own area mask/radius disallows (see
   * ScriptAPI.js's navMoveToward()/navDriveToward() "stuck inside a
   * disallowed area" recovery — this is what they call to find which
   * way to nudge out). findPath()'s own snap only needs to bridge a
   * few cells (e.g. a start point that landed just off a path); escaping
   * a whole disallowed zone can need a much larger radius, hence the
   * bigger default maxRing here rather than reusing findPath()'s.
   * @returns {{x:number,y:number}|null} null if nothing walkable was
   *   found within maxRing cells (the zone is bigger than the search, or
   *   nothing on the map is walkable for this radius/area at all).
   */
  nearestWalkablePointForAgent(navWorldEntity, worldX, worldY, radius, areaMask = 0xffff, maxRing = 24, agentAreaCosts = null) {
    const navWorld = navWorldEntity.getComponent(NAV_WORLD_2D);
    const layer = getAgentNavLayer(navWorld, radius, areaMask, agentAreaCosts);
    const rt = {
      cols: Math.max(1, Math.ceil(navWorld.boundsWidth / navWorld.cellSize)),
      rows: Math.max(1, Math.ceil(navWorld.boundsHeight / navWorld.cellSize)),
    };
    const { col, row } = this.worldToCell(navWorldEntity, worldX, worldY);
    const found = nearestWalkable(rt, layer, col, row, maxRing);
    if (!found) return null;
    return this.cellToWorld(navWorldEntity, found.col, found.row);
  }

  /**
   * Conservative grid traversal for the one segment that starts at an
   * arbitrary world point instead of a cell center. Used only to decide
   * whether a safe route needs its starting cell-center anchor.
   */
  _isWorldSegmentWalkable(navWorldEntity, startPoint, endPoint, radius = 0, areaMask = 0xffff) {
    const navWorld = navWorldEntity.getComponent(NAV_WORLD_2D);
    const transform = navWorldEntity.getComponent(TRANSFORM);
    const layer = getAgentNavLayer(navWorld, radius, areaMask);
    const cols = Math.max(1, Math.ceil(navWorld.boundsWidth / navWorld.cellSize));
    const toGrid = (point) => ({
      x: (point.x - transform.x - navWorld.boundsX) / navWorld.cellSize,
      y: (point.y - transform.y - navWorld.boundsY) / navWorld.cellSize,
    });
    const a = toGrid(startPoint);
    const b = toGrid(endPoint);
    let col = Math.floor(a.x);
    let row = Math.floor(a.y);
    const endCol = Math.floor(b.x);
    const endRow = Math.floor(b.y);
    const isWalkable = (c, r) => {
      if (c < 0 || r < 0 || c >= cols) return false;
      const idx = r * cols + c;
      return idx >= 0 && idx < layer.walkable.length && layer.walkable[idx] === 1;
    };
    if (!isWalkable(col, row) || !isWalkable(endCol, endRow)) return false;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const stepCol = Math.sign(dx);
    const stepRow = Math.sign(dy);
    const deltaCol = dx === 0 ? Infinity : Math.abs(1 / dx);
    const deltaRow = dy === 0 ? Infinity : Math.abs(1 / dy);
    let nextCol = dx === 0 ? Infinity : (dx > 0
      ? (Math.floor(a.x) + 1 - a.x) * deltaCol
      : (a.x - Math.floor(a.x)) * deltaCol);
    let nextRow = dy === 0 ? Infinity : (dy > 0
      ? (Math.floor(a.y) + 1 - a.y) * deltaRow
      : (a.y - Math.floor(a.y)) * deltaRow);
    const EPSILON = 1e-10;

    while (col !== endCol || row !== endRow) {
      if (nextCol + EPSILON < nextRow) {
        col += stepCol;
        nextCol += deltaCol;
      } else if (nextRow + EPSILON < nextCol) {
        row += stepRow;
        nextRow += deltaRow;
      } else {
        // Crossing a grid corner: both side cells must be clear just as
        // they are for A*'s diagonal no-corner-cut rule.
        if (!isWalkable(col + stepCol, row) || !isWalkable(col, row + stepRow)) return false;
        col += stepCol;
        row += stepRow;
        nextCol += deltaCol;
        nextRow += deltaRow;
      }
      if (!isWalkable(col, row)) return false;
    }
    return true;
  }

  /**
   * Re-bakes navWorldEntity's cells from every Collider2D currently in
   * the world. Returns the same { walkable, blocked } summary
   * bakeNavWorld does, or null if navWorldEntity has no NavWorld2D/isn't
   * valid -- see EditorEvents.js's "bake-navworld" action and
   * NavAPI.js's nav.bake() for the two callers.
   */
  bake(navWorldEntity) {
    if (!this._world || !navWorldEntity) return null;
    const navWorld = navWorldEntity.getComponent(NAV_WORLD_2D);
    if (!navWorld) return null;
    return bakeNavWorld(navWorld, this._world, navWorldEntity.getComponent(TRANSFORM));
  }

  destroy() {
    this._world = null;
    this._dynamicSignatures.clear();
  }
}
