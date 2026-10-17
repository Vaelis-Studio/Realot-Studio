/**
 * editor/viewport/AudioListenerGizmo.js
 *
 * Draws every AudioListener entity's editor-only gizmo in the Scene
 * viewport, directly mirroring AudioGizmo.js's structure:
 *  - a small ear icon at the entity's Transform position, constant
 *    screen size (see ICON_SCREEN_RADIUS) so it stays clickable/visible
 *    regardless of zoom.
 *  - a single circle showing the hearing radius — unlike AudioSource's
 *    two concentric min/max circles, AudioListener has one boolean
 *    range (in range / not), so one solid circle is the accurate
 *    picture rather than a falloff gradient.
 *
 * Editor-only chrome: never imported by /runtime, /player, or the
 * play-mode popup.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { AUDIO_LISTENER } from "../../runtime/components/AudioListener.js";

const LISTENER_COLOR = 0xf6ad55; // amber — visually distinct from AudioSource's teal and Light's yellow
const SELECTED_ALPHA = 1;
const UNSELECTED_ALPHA = 0.85;
const RANGE_ALPHA_SELECTED = 0.85;
const RANGE_ALPHA_UNSELECTED = 0.3;

const ICON_SCREEN_RADIUS = 9;

/**
 * @param {PIXI.Container} container editor-only chrome layer to draw into
 * @param {import('../../runtime/core/World.js').World|null} world
 * @param {string|null} selectedId
 * @param {number} worldPerPixel see AudioGizmo.js's identical param
 */
export function drawAudioListenerGizmo(container, world, selectedId, worldPerPixel) {
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
  const entities = world.query(TRANSFORM, AUDIO_LISTENER);

  for (const entity of entities) {
    const transform = entity.getComponent(TRANSFORM);
    const listener = entity.getComponent(AUDIO_LISTENER);
    const isSelected = entity.id === selectedId;
    const alpha = isSelected ? SELECTED_ALPHA : UNSELECTED_ALPHA;
    const rangeAlpha = isSelected ? RANGE_ALPHA_SELECTED : RANGE_ALPHA_UNSELECTED;
    const lineWidth = isSelected ? 2 : 1.2;

    const g = new PIXI.Graphics();

    if (listener.enabled) {
      g.lineStyle(lineWidth, LISTENER_COLOR, rangeAlpha);
      g.drawCircle(transform.x, transform.y, listener.radius);
    } else {
      // Disabled listeners still show WHERE their circle would be, just
      // dashed and faint — same "off but visible" convention as a
      // disabled Light gizmo, so it doesn't look like the component is
      // simply missing.
      _drawDashedCircle(g, transform.x, transform.y, listener.radius, lineWidth, rangeAlpha * 0.5);
    }

    _drawEarIcon(g, transform.x, transform.y, iconRadius, alpha, isSelected);
    container.addChild(g);

    if (isSelected) {
      const label = new PIXI.Text(_labelFor(listener), {
        fontSize: 10,
        fill: LISTENER_COLOR,
        fontFamily: "monospace",
      });
      label.x = transform.x + iconRadius + 4;
      label.y = transform.y - iconRadius - 2;
      container.addChild(label);
    }
  }
}

function _labelFor(listener) {
  return "Audio Listener  radius=" + Math.round(listener.radius) + (listener.enabled ? "" : "  (disabled)");
}

/** Dashed circle — used only for disabled listeners, see caller above. */
function _drawDashedCircle(g, cx, cy, radius, lineWidth, alpha) {
  g.lineStyle(lineWidth, LISTENER_COLOR, alpha);
  const segments = 48;
  const dashRatio = 0.55;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + dashRatio) / segments) * Math.PI * 2;
    g.moveTo(cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius);
    g.lineTo(cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius);
  }
}

/**
 * Hand-drawn ear glyph (a simple spiral-ish "C" shape with an inner
 * fold), same "no image/SVG loading" convention as AudioGizmo's
 * speaker and LightGizmo's bulb.
 */
function _drawEarIcon(g, x, y, radius, alpha, isSelected) {
  g.lineStyle(isSelected ? 2 : 1.5, LISTENER_COLOR, alpha);
  // Outer ear curve — a wide arc open on the left, like a "C".
  g.arc(x, y, radius * 0.85, -Math.PI * 0.35, Math.PI * 0.85);
  // Inner fold — a smaller nested arc, same opening direction.
  g.arc(x + radius * 0.08, y + radius * 0.05, radius * 0.42, -Math.PI * 0.2, Math.PI * 0.7);
  // Lobe — small filled dot at the bottom of the outer curve.
  g.lineStyle(0);
  g.beginFill(LISTENER_COLOR, alpha);
  g.drawCircle(x + radius * 0.05, y + radius * 0.7, radius * 0.16);
  g.endFill();
}

/**
 * Hit-test mirroring AudioGizmo's hitTestAudioGizmo() exactly.
 */
export function hitTestAudioListenerGizmo(world, worldX, worldY, worldPerPixel) {
  if (!world) return null;
  const iconRadius = ICON_SCREEN_RADIUS * (worldPerPixel || 1);
  const hitRadius = iconRadius * 1.6;

  const entities = world.query(TRANSFORM, AUDIO_LISTENER);
  for (let i = entities.length - 1; i >= 0; i--) {
    const transform = entities[i].getComponent(TRANSFORM);
    const dx = worldX - transform.x;
    const dy = worldY - transform.y;
    if (dx * dx + dy * dy <= hitRadius * hitRadius) return entities[i];
  }
  return null;
}
