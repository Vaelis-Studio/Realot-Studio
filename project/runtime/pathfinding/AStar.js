/**
 * runtime/pathfinding/AStar.js
 *
 * Allocation-light A* over a NavWorld2D's per-agent-radius derived layer
 * (see components/NavWorld2D.js's getAgentNavLayer). The algorithm keeps
 * the same route correctness the original single-mesh implementation
 * had, but now searches whichever radius layer the calling agent needs
 * instead of one mesh-wide grid with a single baked-in radius — many
 * agents with the SAME radius share one layer's scratch space and path
 * cache; agents with a DIFFERENT radius get their own layer, computed
 * once and cached, never a full re-bake.
 *
 * The layer owns its own cache lifetime; a bake/paint invalidates the
 * whole NavWorld2D runtime (see invalidateNavWorldRuntime), which drops
 * every radius layer so a topology change can't leave a stale layer's
 * erosion out of sync with the new obstacles.
 */

import {
  getAgentNavLayer,
  readNavPath,
  rememberNavPath,
} from "../components/NavWorld2D.js";

const ORTHO_NEIGHBORS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
];
const DIAG_NEIGHBORS = [
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

class IndexMinHeap {
  constructor(layer) {
    this.index = layer.heapIndex;
    this.score = layer.heapScore;
    this.index.length = 0;
    this.score.length = 0;
  }
  get size() { return this.index.length; }
  push(idx, score) {
    const a = this.index;
    const s = this.score;
    let i = a.length;
    a.push(idx);
    s.push(score);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (s[p] < score || (s[p] === score && a[p] <= idx)) break;
      a[i] = a[p]; s[i] = s[p];
      i = p;
    }
    a[i] = idx; s[i] = score;
  }
  pop() {
    const a = this.index;
    const s = this.score;
    const root = a[0];
    const lastIdx = a.pop();
    const lastScore = s.pop();
    if (a.length) {
      let i = 0;
      while (true) {
        const l = i * 2 + 1;
        if (l >= a.length) break;
        const r = l + 1;
        let child = l;
        if (r < a.length && (s[r] < s[l] || (s[r] === s[l] && a[r] < a[l]))) child = r;
        if (s[child] > lastScore || (s[child] === lastScore && a[child] >= lastIdx)) break;
        a[i] = a[child]; s[i] = s[child];
        i = child;
      }
      a[i] = lastIdx; s[i] = lastScore;
    }
    return root;
  }
}

function indexOf(rt, col, row) {
  if (col < 0 || row < 0 || col >= rt.cols || row >= rt.rows) return -1;
  return row * rt.cols + col;
}

function colOf(rt, index) { return index % rt.cols; }
function rowOf(rt, index) { return Math.floor(index / rt.cols); }
function isWalkable(rt, layer, col, row) {
  const idx = indexOf(rt, col, row);
  return idx >= 0 && layer.walkable[idx] === 1;
}

function heuristic(dx, dy, diagonal, minStepCost = 1) {
  dx = Math.abs(dx);
  dy = Math.abs(dy);
  const distance = !diagonal
    ? dx + dy
    : (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
  // Area costs may be BELOW 1.0 as well as above it. Scaling the geometric
  // lower bound by the cheapest traversable area keeps the heuristic
  // admissible in both cases, so a changed Area Cost cannot be ignored or
  // produce a non-optimal cached route simply because the heuristic was
  // larger than the true weighted cost.
  return distance * Math.max(0.01, minStepCost);
}

function bumpSearchId(layer) {
  layer.searchId = (layer.searchId + 1) >>> 0;
  if (layer.searchId === 0) {
    layer.searchStamp.fill(0);
    layer.closedStamp.fill(0);
    layer.searchId = 1;
  }
  return layer.searchId;
}

export function nearestWalkable(rt, layer, col, row, maxRing = 4) {
  if (isWalkable(rt, layer, col, row)) return { col, row };
  for (let ring = 1; ring <= maxRing; ring++) {
    for (let dc = -ring; dc <= ring; dc++) {
      for (let dr = -ring; dr <= ring; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
        if (isWalkable(rt, layer, col + dc, row + dr)) return { col: col + dc, row: row + dr };
      }
    }
  }
  return null;
}

function reconstruct(rt, layer, goalIndex, stamp) {
  const reverse = [];
  let current = goalIndex;
  while (current >= 0) {
    reverse.push({ col: colOf(rt, current), row: rowOf(rt, current) });
    if (layer.searchStamp[current] !== stamp) break;
    current = layer.cameFrom[current];
    if (current < 0) break;
  }
  reverse.reverse();
  return reverse;
}

function cacheKey(start, goal, diagonal) {
  return start + "|" + goal + "|" + (diagonal ? "d" : "o");
}

/**
 * Finds a grid path for an agent of the given `radius` against
 * navWorld's shared baked topology. Shared per-radius cache + typed-
 * array scratch make repeated calls from many agents (of the same or
 * differing radii) substantially cheaper than constructing Maps/Sets/
 * objects for each search, and cheaper than re-baking per agent.
 *
 * @param {import('../components/NavWorld2D.js').NavWorld2D} navWorld
 * @param {number} radius agent clearance in world units (0 = use the
 *   base baked layer with no erosion — see getAgentNavLayer)
 * @param {number} [areaMask] bitmask of allowed NavWorld2D area slots
 *   (see NavAgent2D.area's header) — a route will never cross a cell
 *   whose area bit isn't in this mask, default 0xffff (every area
 *   allowed). Per-area COST (a soft preference, e.g. "prefer roads over
 *   mud" — see NavWorld2D.areaCosts) is applied automatically to every
 *   allowed cell and needs no separate parameter here, UNLESS the agent
 *   supplies its own override — see the next parameter.
 * @param {number[]|null} [agentAreaCosts] optional per-agent cost
 *   override (NavAgent2D.areaCosts) — index-aligned with the same 16
 *   area slots as areaMask/NavWorld2D.areaCosts. A finite entry > 0 at
 *   a slot wins over the world's cost for that slot for THIS search
 *   only; null (default) means "use the world's cost for every area",
 *   so existing callers are unaffected. See getNavAreaCost's header.
 */
export function findGridPath(navWorld, startCol, startRow, goalCol, goalRow, radius = 0, areaMask = 0xffff, agentAreaCosts = null) {
  const layer = getAgentNavLayer(navWorld, radius, areaMask, agentAreaCosts);
  // rt-shaped cols/rows come from the layer's own dimensions, which
  // always match the current bake (getAgentNavLayer derives from
  // getNavWorldRuntime, which rebuilds on any bounds/cellSize change).
  const rt = { cols: Math.max(1, Math.ceil(navWorld.boundsWidth / navWorld.cellSize)), rows: Math.max(1, Math.ceil(navWorld.boundsHeight / navWorld.cellSize)) };
  const start = nearestWalkable(rt, layer, startCol, startRow);
  const goal = nearestWalkable(rt, layer, goalCol, goalRow);
  if (!start || !goal) return null;

  const startIndex = indexOf(rt, start.col, start.row);
  const goalIndex = indexOf(rt, goal.col, goal.row);
  const diagonal = !!navWorld.allowDiagonal;
  const key = cacheKey(startIndex, goalIndex, diagonal);

  // The minimum cost among areas this agent is actually allowed to enter is
  // the safest global lower bound for the weighted A* heuristic. Include
  // only allowed area slots so an excluded cheap area cannot incorrectly
  // make the heuristic too small/large for this agent. Checks the
  // agent's own override FIRST per slot (same precedence as
  // getNavAreaCost), falling back to the world's cost for any slot the
  // agent hasn't overridden, so the heuristic never assumes a cheaper
  // cost than the search will actually use.
  let minStepCost = Infinity;
  const allowedMask = areaMask & 0xffff;
  const hasAgentCosts = Array.isArray(agentAreaCosts);
  for (let areaIndex = 0; areaIndex < 16; areaIndex++) {
    if ((allowedMask & (1 << areaIndex)) === 0) continue;
    let c = hasAgentCosts ? Number(agentAreaCosts[areaIndex]) : NaN;
    if (!Number.isFinite(c) || c <= 0) c = Number(navWorld.areaCosts?.[areaIndex]);
    if (Number.isFinite(c) && c > 0) minStepCost = Math.min(minStepCost, c);
  }
  if (!Number.isFinite(minStepCost)) minStepCost = 1;
  const cached = readNavPath(layer, key);
  if (cached) return cached;
  if (startIndex === goalIndex) {
    const path = [start];
    rememberNavPath(layer, key, path);
    return path;
  }

  const stamp = bumpSearchId(layer);
  const heap = new IndexMinHeap(layer);
  const neighbors = diagonal ? ORTHO_NEIGHBORS.concat(DIAG_NEIGHBORS) : ORTHO_NEIGHBORS;

  layer.searchStamp[startIndex] = stamp;
  layer.gScore[startIndex] = 0;
  layer.cameFrom[startIndex] = -1;
  const startH = heuristic(goal.col - start.col, goal.row - start.row, diagonal, minStepCost);
  heap.push(startIndex, startH);

  const MAX_EXPANSIONS = 200000;
  let expansions = 0;

  while (heap.size > 0 && expansions < MAX_EXPANSIONS) {
    const current = heap.pop();
    if (layer.closedStamp[current] === stamp) continue;
    layer.closedStamp[current] = stamp;
    expansions++;

    if (current === goalIndex) {
      const path = reconstruct(rt, layer, goalIndex, stamp);
      rememberNavPath(layer, key, path);
      return path;
    }

    const currentCol = colOf(rt, current);
    const currentRow = rowOf(rt, current);
    const currentG = layer.gScore[current];

    for (const [dc, dr, stepCost] of neighbors) {
      const nc = currentCol + dc;
      const nr = currentRow + dr;
      const next = indexOf(rt, nc, nr);
      if (next < 0 || layer.walkable[next] !== 1) continue;
      if (dc !== 0 && dr !== 0) {
        if (!isWalkable(rt, layer, currentCol + dc, currentRow) || !isWalkable(rt, layer, currentCol, currentRow + dr)) continue;
      }
      if (layer.closedStamp[next] === stamp) continue;

      // Distance cost (1 or sqrt(2) for a diagonal step) scaled by the
      // DESTINATION cell's area cost multiplier (NavWorld2D.areaCosts,
      // via layer.cost — see getAgentNavLayer's header). A cost of 3.0
      // makes stepping onto that cell count as 3x the distance, so the
      // pathfinder naturally detours around it when a similarly-short
      // alternative exists, without making the cell impassable — that's
      // areaMask's job above, not cost's.
      const tentativeG = currentG + stepCost * layer.cost[next];
      if (layer.searchStamp[next] !== stamp || tentativeG < layer.gScore[next]) {
        layer.searchStamp[next] = stamp;
        layer.gScore[next] = tentativeG;
        layer.cameFrom[next] = current;
        const h = heuristic(goal.col - nc, goal.row - nr, diagonal, minStepCost);
        heap.push(next, tentativeG + h);
      }
    }
  }

  return null;
}

export function simplifyGridPath(path) {
  if (path.length <= 2) return path.slice();
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = path[i];
    const next = path[i + 1];
    const dx1 = cur.col - prev.col;
    const dy1 = cur.row - prev.row;
    const dx2 = next.col - cur.col;
    const dy2 = next.row - cur.row;
    if (dx1 === dx2 && dy1 === dy2) continue;
    out.push(cur);
  }
  out.push(path[path.length - 1]);
  return out;
}

/**
 * Returns the weighted traversal cost of a straight grid segment, or
 * Infinity when the segment is not walkable. This deliberately uses the
 * SAME supercover traversal as hasGridLineOfSight() so path smoothing cannot
 * accidentally erase a cheaper detour around a high-cost Nav Area.
 *
 * Cost is charged to the destination cell, matching A* in findGridPath():
 *   stepCost * layer.cost[destination]
 */
function gridSegmentCost(layer, rt, startCol, startRow, endCol, endRow) {
  const isWalkableIdx = (col, row) => {
    if (col < 0 || row < 0 || col >= rt.cols) return false;
    const idx = row * rt.cols + col;
    return idx >= 0 && idx < layer.walkable.length && layer.walkable[idx] === 1;
  };
  const cellCost = (col, row) => layer.cost[row * rt.cols + col];

  if (!isWalkableIdx(startCol, startRow) || !isWalkableIdx(endCol, endRow)) return Infinity;

  const dx = endCol - startCol;
  const dy = endRow - startRow;
  const stepCol = Math.sign(dx);
  const stepRow = Math.sign(dy);
  const countCol = Math.abs(dx);
  const countRow = Math.abs(dy);
  let col = startCol;
  let row = startRow;
  let progressedCol = 0;
  let progressedRow = 0;
  let total = 0;

  if (countRow === 0) {
    while (progressedCol < countCol) {
      col += stepCol;
      progressedCol++;
      if (!isWalkableIdx(col, row)) return Infinity;
      total += cellCost(col, row);
    }
    return total;
  }
  if (countCol === 0) {
    while (progressedRow < countRow) {
      row += stepRow;
      progressedRow++;
      if (!isWalkableIdx(col, row)) return Infinity;
      total += cellCost(col, row);
    }
    return total;
  }

  while (progressedCol < countCol || progressedRow < countRow) {
    const crossCol = (1 + 2 * progressedCol) * countRow;
    const crossRow = (1 + 2 * progressedRow) * countCol;
    if (crossCol === crossRow) {
      // Same no-corner-cut rule used by A* and hasGridLineOfSight.
      if (!isWalkableIdx(col + stepCol, row) || !isWalkableIdx(col, row + stepRow)) return Infinity;
      col += stepCol;
      row += stepRow;
      progressedCol++;
      progressedRow++;
      if (!isWalkableIdx(col, row)) return Infinity;
      total += Math.SQRT2 * cellCost(col, row);
    } else if (crossCol < crossRow) {
      col += stepCol;
      progressedCol++;
      if (!isWalkableIdx(col, row)) return Infinity;
      total += cellCost(col, row);
    } else {
      row += stepRow;
      progressedRow++;
      if (!isWalkableIdx(col, row)) return Infinity;
      total += cellCost(col, row);
    }
  }
  return total;
}

function gridPathCost(path, fromIndex, toIndex, layer, rt) {
  let total = 0;
  for (let i = fromIndex + 1; i <= toIndex; i++) {
    const previous = path[i - 1];
    const current = path[i];
    const dc = current.col - previous.col;
    const dr = current.row - previous.row;
    if (Math.abs(dc) > 1 || Math.abs(dr) > 1 || (dc === 0 && dr === 0)) return Infinity;
    const step = dc !== 0 && dr !== 0 ? Math.SQRT2 : 1;
    const idx = current.row * rt.cols + current.col;
    if (idx < 0 || idx >= layer.cost.length || layer.walkable[idx] !== 1) return Infinity;
    total += step * layer.cost[idx];
  }
  return total;
}

export function hasGridLineOfSight(navWorld, startCol, startRow, endCol, endRow, radius = 0, areaMask = 0xffff, agentAreaCosts = null) {
  const layer = getAgentNavLayer(navWorld, radius, areaMask, agentAreaCosts);
  const rt = { cols: Math.max(1, Math.ceil(navWorld.boundsWidth / navWorld.cellSize)) };
  return Number.isFinite(gridSegmentCost(layer, rt, startCol, startRow, endCol, endRow));
}

/**
 * @param {import('../components/NavWorld2D.js').NavWorld2D} navWorld
 * @param {number} radius agent clearance — see findGridPath
 * @param {number} [areaMask] allowed area bitmask — see findGridPath.
 *   Passed straight through to hasGridLineOfSight's own mask check.
 * @param {number[]|null} [agentAreaCosts] optional per-agent cost
 *   override — see findGridPath. Passed straight through so smoothing
 *   reads from the same cached layer the path was found against.
 */
export function smoothGridPath(navWorld, path, radius = 0, areaMask = 0xffff, agentAreaCosts = null) {
  if (path.length <= 2) return path.slice();
  const layer = getAgentNavLayer(navWorld, radius, areaMask, agentAreaCosts);
  const rt = { cols: Math.max(1, Math.ceil(navWorld.boundsWidth / navWorld.cellSize)) };
  const out = [path[0]];
  let anchor = 0;
  const last = path.length - 1;

  while (anchor < last) {
    let next = last;
    while (next > anchor + 1) {
      const directCost = gridSegmentCost(
        layer, rt,
        path[anchor].col, path[anchor].row,
        path[next].col, path[next].row
      );
      if (Number.isFinite(directCost)) {
        const originalCost = gridPathCost(path, anchor, next, layer, rt);
        // Never smooth away a cheaper weighted route. Before this fix,
        // smoothing only checked geometry, so a direct line through an
        // expensive Road/Mud area could replace the A* detour and make
        // area costs appear to be completely ignored.
        if (directCost <= originalCost + 1e-6) break;
      }
      next--;
    }
    out.push(path[next]);
    anchor = next;
  }
  return out;
}
