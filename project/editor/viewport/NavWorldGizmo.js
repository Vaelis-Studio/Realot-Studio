/**
 * editor/viewport/NavWorldGizmo.js
 *
 * Draws every NavWorld2D entity's `cells` map as a grid overlay in the
 * Scene viewport — green fill for a walkable Ground cell, red fill for
 * explicitly blocked, a distinct per-area color (see AREA_COLORS) for
 * any cell painted with a non-Ground area via the O / Nav Area tool,
 * and nothing drawn for unset cells (see NavWorld2D.js's header for why
 * unset still behaves as blocked to a real pathfind, even though this
 * gizmo leaves it visually empty rather than also tinting it red — an
 * unset cell is usually just "outside the baked/painted area", and
 * painting the WHOLE plane red by default would bury the scene under an
 * overwhelming wash of color the first time this feature is used,
 * defeating the point of a quick visual sanity check). A blocked cell
 * always reads as red regardless of its area tag — "can anything path
 * through here" is a more urgent fact than "which area is this".
 *
 * Same "clear and fully redraw every call, no persistent per-cell PIXI
 * objects" shape as ColliderGizmo.js (see that file's header) — a
 * NavWorld2D's cell count changes far less often than a script/tool
 * edits it, and Graphics draw calls are cheap to batch, so there's no
 * real benefit to diffing individual cell add/remove here the way
 * TilemapSystem.js does for its (rendered-every-frame, in the actual
 * shipped game) tile sprites.
 *
 * AGENT PREVIEW ("Show Agent Navigation" — see Inspector.js's
 * NavAgent2D section): when previewRadius is a finite number instead
 * of null, the cell grid is drawn from THAT agent's derived nav layer
 * (components/NavWorld2D.js's getAgentNavLayer) instead of the base
 * cells map — this is the "editor should visually show which cells
 * are actually usable by that agent" requirement from the navigation
 * design brief, and it costs nothing extra to compute: it's the exact
 * same cached layer real pathfinding for that radius already uses.
 *
 * Editor-only chrome: never imported by /runtime or /player, so this
 * overlay only ever appears in the editor's Scene view — see
 * SceneViewport.js's navWorldGizmoContainer, gated behind
 * editorState.showNavWorld (the Toolbar's "Show Nav World Cells"
 * toggle) or editorState.navAgentPreviewEntityId (the Inspector's
 * per-agent preview toggle).
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { NAV_WORLD_2D, parseNavCellKey, getAgentNavLayer, navCellArea } from "../../runtime/components/NavWorld2D.js";

const WALKABLE_COLOR = 0x4ade80; // green — matches the walkable=true convention
const BLOCKED_COLOR = 0xff3b30; // red — matches the blocked=false convention
const AGENT_BLOCKED_COLOR = 0xff9f1c; // amber-orange — cells the base layer allows but
                                        // THIS agent's radius/area mask cannot fit
                                        // through; visually distinct from a true (red)
                                        // obstacle cell so a developer can immediately
                                        // tell "blocked by size/area" from "blocked by
                                        // geometry" at a glance.
const CELL_ALPHA = 0.22;
const GRID_LINE_ALPHA = 0.35;
const BOUNDS_COLOR = 0xffd166; // amber outline for the bake bounds rectangle

// Distinct per-area-slot fill colors, one per NAV_AREA_COUNT slot.
// Slot 0 (Ground) is intentionally NOT in this list — Ground cells fall
// through to the ordinary WALKABLE_COLOR/BLOCKED_COLOR below, so a
// project that never uses areas at all sees exactly the same plain
// green/red grid it always has; only cells actually painted with a
// NON-Ground area (via the O / Nav Area tool) pick up a distinct color.
// 15 hand-picked hues spread around the color wheel so adjacent slots
// stay visually distinguishable even for a project using most of them.
const AREA_COLORS = [
  null, // slot 0 = Ground, deliberately unused — see comment above
  0x38bdf8, // 1
  0xa78bfa, // 2
  0xf472b6, // 3
  0xfbbf24, // 4
  0x34d399, // 5
  0xfb7185, // 6
  0x60a5fa, // 7
  0xc084fc, // 8
  0xfacc15, // 9
  0x2dd4bf, // 10
  0xf87171, // 11
  0x818cf8, // 12
  0x4ade80, // 13 — note: same hue family as WALKABLE_COLOR is fine here,
             //      since area color only ever applies via the dedicated
             //      per-area branch below, never mixed with the plain
             //      walkable tint on the same cell.
  0xfde047, // 14
  0xe879f9, // 15
];

/** Fill color for one cell in the plain (non-agent-preview) grid view —
 *  the cell's own area color if it's tagged with a non-Ground area,
 *  otherwise the ordinary walkable/blocked color. Blocked always wins
 *  visually over area (a blocked cell reads as red regardless of which
 *  area it's tagged with), since "can anything path through here at
 *  all" is a more urgent fact than "which area is this". */
function _cellColor(navWorld, col, row, walkable) {
  if (!walkable) return BLOCKED_COLOR;
  const areaIndex = navCellArea(navWorld, col, row);
  const areaColor = AREA_COLORS[areaIndex];
  return areaColor != null ? areaColor : WALKABLE_COLOR;
}

/**
 * @param {PIXI.Container} container editor-only chrome layer to draw into
 * @param {import('../../runtime/core/World.js').World|null} world
 * @param {boolean} visible mirrors editorState.showNavWorld — when
 *   false, this still clears the container (so toggling off doesn't
 *   leave a stale frame's cells on screen) but draws nothing further,
 *   same "cheap to call every frame regardless of the toggle" shape
 *   drawColliderGizmo/drawLightGizmo already have for their own
 *   always-invoked-but-selectively-drawing callers. Ignored (treated
 *   as true) when previewRadius is set, so the agent preview stays
 *   visible even if the developer never separately toggled the plain
 *   cell view on — selecting an agent and clicking "Show Agent
 *   Navigation" is a complete, self-sufficient action on its own.
 * @param {"bounds"|"cells"} viewMode "bounds" draws only the bake rectangle;
 *   "cells" additionally draws the detailed walkable/blocked grid. Also
 *   ignored (treated as "cells") when previewRadius is set — a radius
 *   preview with nothing drawn would look like a no-op to whoever
 *   just clicked the button.
 * @param {number|null} [previewRadius] when set, draws using that
 *   specific agent radius's derived layer instead of the base cells —
 *   see this file's header.
 * @param {number} [previewAreaMask] the previewed agent's area mask
 *   (NavAgent2D.area) — combined with previewRadius to look up the
 *   exact same (radius, areaMask) layer real pathfinding would use for
 *   that agent, so a cell blocked only because this agent's mask
 *   excludes its area is shown too, not just radius-blocked cells.
 *   Default 0xffff (every area allowed) so a caller that doesn't pass
 *   one still gets a sensible radius-only preview.
 */
export function drawNavWorldGizmo(container, world, visible, viewMode = "bounds", previewRadius = null, previewAreaMask = 0xffff) {
  container.removeChildren();
  const previewing = Number.isFinite(previewRadius);
  if (!world || (!visible && !previewing)) return;

  const entities = world.query(TRANSFORM, NAV_WORLD_2D);
  const effectiveViewMode = previewing ? "cells" : viewMode;

  for (const entity of entities) {
    const transform = entity.getComponent(TRANSFORM);
    const navWorld = entity.getComponent(NAV_WORLD_2D);
    const originX = transform.x + navWorld.boundsX;
    const originY = transform.y + navWorld.boundsY;
    const size = navWorld.cellSize;

    const g = new PIXI.Graphics();

    // Bake-bounds rectangle first (drawn behind the cell fills below,
    // since it's added to the same Graphics before them) so it's
    // always visible as a reference frame even on a NavWorld2D that
    // hasn't been baked/painted yet at all.
    g.lineStyle(1.5, BOUNDS_COLOR, 0.8);
    g.drawRect(originX, originY, navWorld.boundsWidth, navWorld.boundsHeight);

    // Bounds mode is deliberately bounds-only: never iterate or draw any
    // baked cells while the cheap overview is selected. This keeps a huge
    // open-world NavWorld2D visualization effectively constant-cost.
    if (effectiveViewMode === "cells") {
      if (previewing) {
        // Agent preview: iterate the SAME derived (radius, areaMask)
        // layer real pathfinding for this exact agent already uses
        // (cached, so this costs nothing beyond the draw calls
        // themselves), and only paint AGENT_BLOCKED_COLOR for a cell the
        // base layer allows but this agent's radius/area combination
        // does not — a true obstacle cell still reads as the ordinary
        // blocked color, since it's blocked for every agent, not
        // specifically because of this one's size or area mask.
        const layer = getAgentNavLayer(navWorld, previewRadius, previewAreaMask);
        const cols = Math.max(1, Math.ceil(navWorld.boundsWidth / navWorld.cellSize));
        const cellKeys = Object.keys(navWorld.cells);
        for (const key of cellKeys) {
          const baseWalkable = navWorld.cells[key];
          const { col, row } = parseNavCellKey(key);
          const x = originX + col * size;
          const y = originY + row * size;
          let color;
          if (!baseWalkable) {
            color = BLOCKED_COLOR;
          } else {
            const idx = row * cols + col;
            const agentCanFit = idx >= 0 && idx < layer.walkable.length && layer.walkable[idx] === 1;
            color = agentCanFit ? _cellColor(navWorld, col, row, true) : AGENT_BLOCKED_COLOR;
          }
          g.beginFill(color, CELL_ALPHA);
          g.lineStyle(1, color, GRID_LINE_ALPHA);
          g.drawRect(x, y, size, size);
          g.endFill();
        }
      } else {
        const cellKeys = Object.keys(navWorld.cells);
        for (const key of cellKeys) {
          const walkable = navWorld.cells[key];
          const { col, row } = parseNavCellKey(key);
          const x = originX + col * size;
          const y = originY + row * size;
          const color = _cellColor(navWorld, col, row, walkable);

          g.beginFill(color, CELL_ALPHA);
          g.lineStyle(1, color, GRID_LINE_ALPHA);
          g.drawRect(x, y, size, size);
          g.endFill();
        }
      }
    }

    container.addChild(g);
  }
}
