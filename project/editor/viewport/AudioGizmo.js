/**
 * editor/viewport/AudioGizmo.js
 *
 * Draws every AudioSource entity's editor-only gizmo in the Scene
 * viewport, directly mirroring LightGizmo.js's structure:
 *  - a small speaker icon at the entity's Transform position, always
 *    drawn at a constant screen size (see ICON_SCREEN_RADIUS) so it
 *    stays clickable/visible regardless of zoom.
 *  - for 3D audio only: two concentric circles showing minDistance
 *    (inner, full volume) and maxDistance (outer, silent beyond this)
 *    — the exact falloff AudioSystem.js computes, made visible.
 *  - 2D audio draws no range circles at all: it has no position-based
 *    falloff, so a range indicator would be actively misleading.
 *
 * Editor-only chrome: never imported by /runtime, /player, or the
 * play-mode popup.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { AUDIO_SOURCE } from "../../runtime/components/AudioSource.js";

const AUDIO_COLOR = 0x4fd1c5; // teal — visually distinct from the light gizmo's yellow
const SELECTED_ALPHA = 1;
const UNSELECTED_ALPHA = 0.85;
const RANGE_ALPHA_SELECTED = 0.9;
const RANGE_ALPHA_UNSELECTED = 0.35;

const ICON_SCREEN_RADIUS = 9;

/**
 * @param {PIXI.Container} container editor-only chrome layer to draw into
 * @param {import('../../runtime/core/World.js').World|null} world
 * @param {string|null} selectedId
 * @param {number} worldPerPixel see LightGizmo.js's identical param
 */
export function drawAudioGizmo(container, world, selectedId, worldPerPixel) {
  // destroy() before removeChildren(): removeChildren() only unlinks
  // parent/child pointers, it does NOT free the Graphics' GPU geometry
  // buffers or a Text object's baked canvas texture. Without destroy()
  // here, every dirty frame allocates a fresh Graphics/Text (below) and
  // orphans the previous frame's — a steady leak while the scene sits
  // static, since selection alone keeps this function re-running.
  for (const child of container.children) {
    child.destroy({ children: true, texture: true, baseTexture: true });
  }
  container.removeChildren();
  if (!world) return;

  const iconRadius = ICON_SCREEN_RADIUS * (worldPerPixel || 1);
  const entities = world.query(TRANSFORM, AUDIO_SOURCE);

  for (const entity of entities) {
    const transform = entity.getComponent(TRANSFORM);
    const source = entity.getComponent(AUDIO_SOURCE);
    const isSelected = entity.id === selectedId;
    const alpha = isSelected ? SELECTED_ALPHA : UNSELECTED_ALPHA;
    const rangeAlpha = isSelected ? RANGE_ALPHA_SELECTED : RANGE_ALPHA_UNSELECTED;
    const lineWidth = isSelected ? 2 : 1.2;

    const g = new PIXI.Graphics();

    if (source.is3D) {
      g.lineStyle(lineWidth, AUDIO_COLOR, rangeAlpha);
      g.drawCircle(transform.x, transform.y, source.minDistance);
      g.lineStyle(lineWidth, AUDIO_COLOR, rangeAlpha * 0.55);
      _drawDashedCircle(g, transform.x, transform.y, source.maxDistance, lineWidth);
    }

    _drawSpeakerIcon(g, transform.x, transform.y, iconRadius, alpha, isSelected);
    container.addChild(g);

    if (isSelected) {
      const label = new PIXI.Text(_labelFor(source), {
        fontSize: 10,
        fill: AUDIO_COLOR,
        fontFamily: "monospace",
      });
      label.x = transform.x + iconRadius + 4;
      label.y = transform.y - iconRadius - 2;
      container.addChild(label);
    }
  }
}

function _labelFor(source) {
  const clip = source.audioKey || "None";
  return source.is3D
    ? "3D Audio  " + clip + "  min=" + Math.round(source.minDistance) + " max=" + Math.round(source.maxDistance)
    : "2D Audio  " + clip;
}

/** Dashed outer circle so it's visually distinct from the solid inner (full-volume) circle. */
function _drawDashedCircle(g, cx, cy, radius, lineWidth) {
  const segments = 48;
  const dashRatio = 0.55; // fraction of each segment that's drawn vs skipped
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + dashRatio) / segments) * Math.PI * 2;
    g.moveTo(cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius);
    g.lineTo(cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius);
  }
}

/**
 * Hand-drawn speaker glyph (trapezoid cone + box) with small sound-wave
 * arcs, same "no image/SVG loading" convention as LightGizmo's bulb.
 */
function _drawSpeakerIcon(g, x, y, radius, alpha, isSelected) {
  g.lineStyle(0);
  g.beginFill(AUDIO_COLOR, alpha);
  const boxW = radius * 0.55;
  const boxH = radius * 1.1;
  g.drawRect(x - radius * 0.85, y - boxH / 2, boxW, boxH);
  g.drawPolygon([
    x - radius * 0.3, y - boxH / 2,
    x + radius * 0.35, y - radius,
    x + radius * 0.35, y + radius,
    x - radius * 0.3, y + boxH / 2,
  ]);
  g.endFill();

  g.lineStyle(isSelected ? 1.5 : 1, AUDIO_COLOR, alpha);
  g.arc(x + radius * 0.35, y, radius * 0.75, -Math.PI / 3.2, Math.PI / 3.2);
  g.moveTo(
    x + radius * 0.35 + Math.cos(-Math.PI / 4) * radius * 1.15,
    y + Math.sin(-Math.PI / 4) * radius * 1.15
  );
  g.arc(x + radius * 0.35, y, radius * 1.15, -Math.PI / 4, Math.PI / 4);

  g.lineStyle(isSelected ? 1.5 : 1, 0x1c1c1c, 0.6);
  g.drawRect(x - radius * 0.85, y - boxH / 2, boxW, boxH);
}

/**
 * Hit-test mirroring LightGizmo's hitTestLightGizmo() exactly.
 */
export function hitTestAudioGizmo(world, worldX, worldY, worldPerPixel) {
  if (!world) return null;
  const iconRadius = ICON_SCREEN_RADIUS * (worldPerPixel || 1);
  const hitRadius = iconRadius * 1.6;

  const entities = world.query(TRANSFORM, AUDIO_SOURCE);
  for (let i = entities.length - 1; i >= 0; i--) {
    const transform = entities[i].getComponent(TRANSFORM);
    const dx = worldX - transform.x;
    const dy = worldY - transform.y;
    if (dx * dx + dy * dy <= hitRadius * hitRadius) return entities[i];
  }
  return null;
}
