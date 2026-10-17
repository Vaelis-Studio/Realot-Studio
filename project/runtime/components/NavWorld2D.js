/**
 * runtime/components/NavWorld2D.js
 *
 * Serializable authoring data for a 2D grid-based navigation surface.
 * ONE NavWorld2D is the shared navigation dataset for a scene — any
 * number of NavAgent2D components (see components/NavAgent2D.js) query
 * it. This component does NOT know about agents, radii, or per-agent
 * settings at all; those live entirely on NavAgent2D, per the
 * architecture doc at the top of systems/NavWorldSystem.js.
 *
 * Runtime acceleration data (typed-array walkability, path caches,
 * per-radius derived layers) is deliberately kept outside the component
 * object so it is never serialized with scenes.
 */

export const NAV_WORLD_2D = "NavWorld2D";

// WeakMap keeps typed-array caches, path caches, per-radius layers and
// search scratch space completely outside serialized scene data. One
// cache bucket per NavWorld2D instance.
const RUNTIME = new WeakMap();

/**
 * Navigation areas/layers a NavWorld2D cell can be tagged with (Ground,
 * Water, Mud, Road, EnemyOnly, PlayerOnly, ...). Same slot-based design
 * as PhysicsLayers.js's 16 named physics layers — see
 * editor/state/NavAreas.js for the editor-side name registry and
 * NavAgent2D.area for how an agent selects which areas it may use.
 */
export const NAV_AREA_COUNT = 16;

export class NavWorld2D {
  constructor({
    boundsX = -400,
    boundsY = -400,
    boundsWidth = 800,
    boundsHeight = 800,
    cellSize = 32,
    cells = {},
    bakedCells = null,
    paintOverrides = {},
    // Per-cell navigation area bitmask (one bit per NAV_AREA_COUNT slot).
    // Missing entries default to area 0 (Ground) — see navCellArea().
    cellAreas = {},
    // Per-area traversal cost multiplier, index-aligned with the 16 area
    // slots (see editor/state/NavAreas.js) — same role as Unity's
    // NavMeshAgent.SetAreaCost(): a SOFT preference, not a hard block.
    // 1.0 (the default for every slot) means "no preference"; 3.0 means
    // "the pathfinder treats crossing this area as 3x the distance", so
    // a route will detour around a high-cost area if a similarly-short
    // alternative exists, but will still cross it rather than fail if
    // there's no other way through. Contrast with NavAgent2D.area, which
    // is a HARD mask — cost only ever applies to areas already allowed
    // by that mask.
    areaCosts = null,
    allowDiagonal = false,
    dynamic = false,
    // Smallest obstacle footprint (world units, along its narrower axis)
    // that is still allowed to block a cell during bakeNavWorld(). Any
    // static, non-trigger Collider2D narrower than this on BOTH axes is
    // skipped entirely during the bake — it never blocks a cell, no
    // matter how a cell's center happens to fall inside it. This exists
    // because a raw per-collider bake (see NavWorldBaker.js's header)
    // otherwise blocks a cell just because a small decorative prop (a
    // tuft of grass, a pebble, a sign post) happens to have a collider
    // sitting on it, even though nothing that size would meaningfully
    // stop a walking agent from crossing that space. 0 (the default)
    // disables this — every collider blocks, exactly like before this
    // field existed.
    minObstacleFootprint = 0,
  } = {}) {
    this.boundsX = boundsX;
    this.boundsY = boundsY;
    this.boundsWidth = boundsWidth;
    this.boundsHeight = boundsHeight;
    this.cellSize = Math.max(1, cellSize);
    this.minObstacleFootprint = Math.max(0, minObstacleFootprint);
    this.cells = { ...cells };
    // bakedCells is the last collider-derived topology, UNPADDED by any
    // agent radius — the base "is there a wall here" fact, before any
    // per-agent clearance is applied. Manual paint lives separately so
    // Erase can restore a cell to exactly what Bake produced instead of
    // permanently turning an erased cell into an implicit block.
    this.bakedCells = { ...(bakedCells || cells) };
    this.paintOverrides = { ...paintOverrides };
    for (const [key, value] of Object.entries(this.paintOverrides)) {
      this.cells[key] = !!value;
    }
    this.cellAreas = { ...cellAreas };
    this.areaCosts = areaCosts
      ? areaCosts.slice(0, NAV_AREA_COUNT)
      : new Array(NAV_AREA_COUNT).fill(1);
    while (this.areaCosts.length < NAV_AREA_COUNT) this.areaCosts.push(1);
    this.allowDiagonal = !!allowDiagonal;
    this.dynamic = !!dynamic;
  }
}

export function navCellKey(col, row) {
  return col + "," + row;
}

export function parseNavCellKey(key) {
  const [col, row] = key.split(",").map(Number);
  return { col, row };
}

/**
 * Area SLOT INDEX (0-15, not a bitmask) that one cell belongs to — a
 * cell is tagged with exactly ONE area at a time, same as a Tilemap
 * cell holding one tile (see setNavCellArea below). Unset cells default
 * to slot 0 (Ground). To test whether an AGENT may enter this cell,
 * combine with its mask: `(1 << navCellArea(...)) & agent.area`. See
 * NavAgent2D.area's header for the mask side of this, and
 * NavWorld2D.areaCosts for the separate per-slot cost multiplier.
 */
export function navCellArea(navWorld, col, row) {
  const key = navCellKey(col, row);
  const value = navWorld.cellAreas[key];
  return value === undefined ? 0 : value;
}

/** Set the area SLOT INDEX (0-15) for one cell — a single slot, not a
 *  combined mask; a cell belongs to exactly one area at a time, same as
 *  a Tilemap cell holding one tile. Painted via the Nav tool's area
 *  picker in the Scene view (see SceneViewport.js's Nav paint handling)
 *  — pick the active area there before painting cells with that area. */
export function setNavCellArea(navWorld, col, row, areaIndex) {
  if (!navWorld || !Number.isInteger(col) || !Number.isInteger(row)) return false;
  const key = navCellKey(col, row);
  const value = Math.max(0, Math.min(NAV_AREA_COUNT - 1, areaIndex | 0));
  if (navWorld.cellAreas[key] === value) return false;
  navWorld.cellAreas[key] = value;
  invalidateNavWorldRuntime(navWorld);
  return true;
}

/** Erase one cell's area TAG, reverting it to slot 0 (Ground) — the
 *  Area-tool counterpart to clearNavCellOverride() above, but for the
 *  area property instead of the walkable/blocked property. Deletes the
 *  cellAreas entry entirely (rather than writing 0) so navCellArea()'s
 *  "missing entry defaults to 0" rule is what actually produces the
 *  Ground result, same "erase = remove the override, don't just set a
 *  value that happens to match the default" reasoning
 *  clearNavCellOverride() follows for walkable/blocked. Deliberately
 *  does NOT touch cells/paintOverrides — area and walkable/blocked are
 *  orthogonal properties (see _paintNavCellAtClientPos's header in
 *  SceneViewport.js), so erasing one never affects the other. */
export function clearNavCellArea(navWorld, col, row) {
  if (!navWorld || !Number.isInteger(col) || !Number.isInteger(row)) return false;
  const key = navCellKey(col, row);
  if (!Object.prototype.hasOwnProperty.call(navWorld.cellAreas, key)) return false;
  delete navWorld.cellAreas[key];
  invalidateNavWorldRuntime(navWorld);
  return true;
}

/** Traversal cost multiplier for one area SLOT (not a cell) — see
 *  NavWorld2D's areaCosts field header for the mask-vs-cost distinction.
 *  Defaults to 1.0 (no preference) for any slot never explicitly set.
 *  @param {number[]|null} [agentAreaCosts] optional per-agent override
 *    array (NavAgent2D.areaCosts) — index-aligned with the same 16
 *    slots. A finite entry > 0 at this slot wins over the world's cost
 *    for THIS lookup only; a null/missing entry falls through to the
 *    world's cost — same "override just what you need" behavior
 *    NavAgent2D.areaCosts's own header describes. */
export function getNavAreaCost(navWorld, areaIndex, agentAreaCosts = null) {
  if (areaIndex < 0 || areaIndex >= NAV_AREA_COUNT) return 1;
  if (Array.isArray(agentAreaCosts)) {
    const av = agentAreaCosts[areaIndex];
    if (typeof av === "number" && av > 0) return av;
  }
  if (!navWorld) return 1;
  const v = navWorld.areaCosts[areaIndex];
  return typeof v === "number" && v > 0 ? v : 1;
}

/** Sets the traversal cost multiplier for one area slot — same
 *  scripting-reference role as Unity's NavMeshAgent.SetAreaCost(),
 *  applied per-world here since cost is a property of the AREA, not of
 *  any one agent (every agent that's allowed into an area sees the same
 *  cost; what differs per-agent is only whether they're allowed in at
 *  all — see NavAgent2D.area). Costs below 0.01 are clamped up to avoid
 *  a division/zero-cost edge case in pathfinding. */
export function setNavAreaCost(navWorld, areaIndex, cost) {
  if (!navWorld || areaIndex < 0 || areaIndex >= NAV_AREA_COUNT) return false;
  const numericCost = Number(cost);
  const clamped = Number.isFinite(numericCost) ? Math.max(0.01, numericCost) : 1;
  if (navWorld.areaCosts[areaIndex] === clamped) return false;
  navWorld.areaCosts[areaIndex] = clamped;
  invalidateNavWorldRuntime(navWorld);
  return true;
}

/**
 * Invalidates every derived runtime structure for this NavWorld2D. Call
 * this whenever its cells/areas change (bake, paint, procedural edit).
 * The next path query lazily rebuilds the compact typed-array
 * representation, and every per-radius derived layer (see
 * getAgentNavLayer below) is thrown away and rebuilt on next use.
 */
export function invalidateNavWorldRuntime(navWorld) {
  if (navWorld) RUNTIME.delete(navWorld);
}

/**
 * Returns the compact BASE runtime representation used by pathfinding —
 * unpadded by any agent radius. This is the "Baked Navigation" +
 * "User Overrides" stage of the pipeline described in
 * systems/NavWorldSystem.js's header; "Navigation Area/Layer" and
 * "Agent Radius / Size" are applied afterward, per agent, by
 * getAgentNavLayer().
 *
 * - Uint8Array walkability instead of string-keyed objects
 * - typed-array scratch buffers reused between path requests
 * - bounded LRU path cache PER RADIUS LAYER (see getAgentNavLayer),
 *   shared by every agent that uses that radius
 *
 * This is the main reason hundreds of agents can query the same shared
 * NavWorld2D without allocating Maps/Sets/objects for every search, and
 * without baking a separate complete grid per agent.
 */
export function getNavWorldRuntime(navWorld) {
  let rt = RUNTIME.get(navWorld);
  const cols = Math.max(1, Math.ceil(navWorld.boundsWidth / navWorld.cellSize));
  const rows = Math.max(1, Math.ceil(navWorld.boundsHeight / navWorld.cellSize));

  if (rt && rt.cols === cols && rt.rows === rows && rt.cellSize === navWorld.cellSize) {
    return rt;
  }

  const count = cols * rows;
  const walkable = new Uint8Array(count);
  const area = new Uint8Array(count);
  for (let row = 0; row < rows; row++) {
    const rowOffset = row * cols;
    for (let col = 0; col < cols; col++) {
      const idx = rowOffset + col;
      walkable[idx] = navWorld.cells[navCellKey(col, row)] === true ? 1 : 0;
      area[idx] = navCellArea(navWorld, col, row) & 0xff;
    }
  }

  rt = {
    cols,
    rows,
    cellSize: navWorld.cellSize,
    walkable,
    area,
    // Per-radius derived layers — see getAgentNavLayer(). Keyed by a
    // quantized radius string so agents that share a radius (the common
    // case: "Small"/"Medium"/"Large" archetypes) share one erosion pass
    // and one path cache instead of each agent paying its own cost.
    radiusLayers: new Map(),
  };
  RUNTIME.set(navWorld, rt);
  return rt;
}

/**
 * Quantizes an agent radius + area mask + per-agent cost override to a
 * single cache key. Radii within 1/16 cell-unit of each other collapse
 * onto the same derived layer — real-world agent tuning uses a handful
 * of discrete sizes (Small/Medium/Large), not a continuum — and the
 * area mask is folded in directly (it's already a 16-bit integer, so no
 * quantization is needed) so two agents sharing a radius AND a mask
 * share one derived layer, while two agents with the same radius but
 * DIFFERENT masks correctly get their own — since the mask changes
 * which cells even count as walkable, one radius can't serve both.
 * A per-agent areaCosts override (see NavAgent2D.areaCosts) is folded
 * in the same way as the mask: two agents with the same radius+mask but
 * DIFFERENT cost overrides must NOT share a layer, since layer.cost is
 * baked per-layer (see below) — an agent with no override (the common
 * case) uses the plain radius+mask key so it still shares layers with
 * every other override-free agent of that radius+mask, unaffected by
 * this feature.
 */
function radiusCacheKey(radius, areaMask, agentAreaCosts = null) {
  const base = Math.round(Math.max(0, radius) * 16) + ":" + (areaMask & 0xffff);
  if (!Array.isArray(agentAreaCosts)) return base;
  return base + ":ac" + agentAreaCosts.map((v) => (typeof v === "number" && v > 0 ? v : "")).join(",");
}

// Area costs are editable scene data. Keep a tiny value signature beside
// each derived layer so a restored/loaded world cannot accidentally keep a
// layer whose cost array was changed in-place (for example by an editor
// migration or an older saved scene). The normal setter still invalidates
// the whole runtime immediately; this is the defensive check for direct
// data restoration/mutation paths. Includes the per-agent override array
// (if any) so an in-place mutation of NavAgent2D.areaCosts is caught the
// same way an in-place mutation of NavWorld2D.areaCosts already is.
function areaCostsSignature(navWorld, agentAreaCosts = null) {
  const costs = navWorld && Array.isArray(navWorld.areaCosts) ? navWorld.areaCosts : [];
  const agentPart = Array.isArray(agentAreaCosts) ? "|" + agentAreaCosts.join(",") : "";
  return costs.join(",") + agentPart;
}

/**
 * Returns the derived per-agent navigation layer: a walkable mask
 * ERODED by `radius` (cells too close to an obstacle for an agent of
 * that size to fit become unwalkable) AND masked by `areaMask` (cells
 * whose area bit isn't in the mask become unwalkable, exactly like
 * Unity's NavMeshAgent.areaMask — see NavAgent2D.area's header), plus
 * its own typed-array search scratch space, its own bounded path
 * cache, and a per-cell COST multiplier array (see NavWorld2D's
 * areaCosts field) that A* reads to prefer cheaper areas without
 * treating them as impassable.
 *
 * This is computed ONCE per unique (radius, areaMask, agentAreaCosts)
 * COMBINATION and shared by every NavAgent2D using that exact
 * combination — never once per agent instance, and never by re-baking
 * the whole NavWorld2D. Agents with no per-agent cost override (the
 * common case, and the only case before this parameter existed) keep
 * sharing one layer per (radius, areaMask) exactly as before; only
 * agents that actually set NavAgent2D.areaCosts get their own layer.
 * See NavWorldSystem.js's pipeline diagram: "Navigation Area/Layer" and
 * "Agent Radius / Size" are the last two transforms before "Final
 * Walkable Navigation", both applied here on top of the shared base
 * layer.
 * @param {number} radius agent clearance in world units
 * @param {number} [areaMask] bitmask of allowed area slots, default
 *   0xffff (every area allowed) so existing radius-only callers are
 *   unaffected.
 * @param {number[]|null} [agentAreaCosts] optional per-agent cost
 *   override (NavAgent2D.areaCosts) — see getNavAreaCost's header.
 *   null (default) means "use NavWorld2D.areaCosts for every area",
 *   so existing callers that never pass this are unaffected.
 */
export function getAgentNavLayer(navWorld, radius, areaMask = 0xffff, agentAreaCosts = null) {
  const rt = getNavWorldRuntime(navWorld);
  const key = radiusCacheKey(radius, areaMask, agentAreaCosts);
  const currentCostSignature = areaCostsSignature(navWorld, agentAreaCosts);
  let layer = rt.radiusLayers.get(key);
  if (layer && layer.areaCostsSignature === currentCostSignature) return layer;
  if (layer) rt.radiusLayers.delete(key);

  const cols = rt.cols;
  const rows = rt.rows;
  const count = cols * rows;
  const eroded = new Uint8Array(count);
  const mask = areaMask & 0xffff;

  // Clearance in cells this radius needs on every side. radius===0 is
  // the fast/common path: no erosion, agent fits anywhere the base
  // layer already allows.
  const cellRadius = radius > 0 ? Math.ceil(radius / navWorld.cellSize) : 0;

  if (cellRadius === 0) {
    for (let i = 0; i < count; i++) {
      eroded[i] = rt.walkable[i] === 1 && (((1 << rt.area[i]) & mask) !== 0) ? 1 : 0;
    }
  } else {
    // Distance-to-nearest-blocked erosion: a cell is walkable for this
    // radius only if every cell within cellRadius (checked as a disc,
    // not a square, so a diagonal-adjacent wall correctly blocks a
    // large agent without over-blocking cells outside its real reach)
    // is itself walkable AND within the allowed area mask in the base
    // layer. This mirrors exactly what NavMeshBaker used to do by
    // padding obstacle SHAPES before the point-in-shape test — the
    // difference is it now runs once per (radius, areaMask) pair
    // against the already-baked grid instead of once per agent against
    // raw collider geometry, and it never touches bakedCells, so
    // re-running it for a new agent radius/mask costs nothing to every
    // OTHER combination already cached.
    const r2 = cellRadius * cellRadius;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        if (rt.walkable[idx] !== 1 || ((1 << rt.area[idx]) & mask) === 0) { eroded[idx] = 0; continue; }
        let blocked = false;
        for (let dr = -cellRadius; dr <= cellRadius && !blocked; dr++) {
          const nr = row + dr;
          for (let dc = -cellRadius; dc <= cellRadius; dc++) {
            if (dr * dr + dc * dc > r2) continue;
            const nc = col + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols ||
                rt.walkable[nr * cols + nc] !== 1 || ((1 << rt.area[nr * cols + nc]) & mask) === 0) {
              blocked = true;
              break;
            }
          }
        }
        eroded[idx] = blocked ? 0 : 1;
      }
    }
  }

  // Per-cell cost multiplier, resolved from the world's per-AREA-SLOT
  // costs (NavWorld2D.areaCosts) — a SOFT preference A* adds into a
  // move's g-score, unlike the mask above which is a HARD pass/fail.
  // Stored per radius+mask layer (not shared globally) since a cost
  // array is cheap to build and keeping it alongside `walkable` avoids
  // a second cross-reference back into rt.area on every A* step.
  const cost = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    cost[i] = getNavAreaCost(navWorld, rt.area[i], agentAreaCosts);
  }

  layer = {
    radius,
    areaMask: mask,
    areaCostsSignature: currentCostSignature,
    walkable: eroded,
    cost,
    searchStamp: new Uint32Array(count),
    closedStamp: new Uint32Array(count),
    gScore: new Float64Array(count),
    cameFrom: new Int32Array(count),
    searchId: 0,
    heapIndex: [],
    heapScore: [],
    pathCache: new Map(),
    pathCacheOrder: 0,
    maxCachedPaths: 384,
  };
  rt.radiusLayers.set(key, layer);
  return layer;
}

export function navRuntimeCacheStats(navWorld, radius = 0, areaMask = 0xffff, agentAreaCosts = null) {
  const rt = RUNTIME.get(navWorld);
  if (!rt) return { cachedPaths: 0, cells: 0, cols: 0, rows: 0, radiusLayers: 0 };
  const layer = rt.radiusLayers.get(radiusCacheKey(radius, areaMask, agentAreaCosts));
  return {
    cachedPaths: layer ? layer.pathCache.size : 0,
    cells: rt.cols * rt.rows,
    cols: rt.cols,
    rows: rt.rows,
    radiusLayers: rt.radiusLayers.size,
  };
}

export function rememberNavPath(layer, key, path) {
  layer.pathCache.set(key, { path, used: ++layer.pathCacheOrder });
  while (layer.pathCache.size > layer.maxCachedPaths) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [candidateKey, entry] of layer.pathCache) {
      if (entry.used < oldest) {
        oldest = entry.used;
        oldestKey = candidateKey;
      }
    }
    if (oldestKey === null) break;
    layer.pathCache.delete(oldestKey);
  }
}

export function readNavPath(layer, key) {
  const entry = layer.pathCache.get(key);
  if (!entry) return null;
  entry.used = ++layer.pathCacheOrder;
  return entry.path;
}


/** Apply an explicit manual walkability override to one cell. */
export function setNavCellOverride(navWorld, col, row, walkable) {
  if (!navWorld || !Number.isInteger(col) || !Number.isInteger(row)) return false;
  const key = navCellKey(col, row);
  const value = !!walkable;
  if (navWorld.paintOverrides[key] === value && navWorld.cells[key] === value) return false;
  navWorld.paintOverrides[key] = value;
  navWorld.cells[key] = value;
  invalidateNavWorldRuntime(navWorld);
  return true;
}

/** Erase manual paint and restore the last baked result for one cell. */
export function clearNavCellOverride(navWorld, col, row) {
  if (!navWorld || !Number.isInteger(col) || !Number.isInteger(row)) return false;
  const key = navCellKey(col, row);
  const hadOverride = Object.prototype.hasOwnProperty.call(navWorld.paintOverrides, key);
  if (!hadOverride) return false;
  delete navWorld.paintOverrides[key];
  if (Object.prototype.hasOwnProperty.call(navWorld.bakedCells, key)) navWorld.cells[key] = navWorld.bakedCells[key];
  else delete navWorld.cells[key];
  invalidateNavWorldRuntime(navWorld);
  return true;
}
