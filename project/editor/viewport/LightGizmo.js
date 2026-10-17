/**
 * editor/viewport/LightGizmo.js
 *
 * Draws every Light entity's editor-only gizmo in the Scene viewport:
 *  - a small bulb icon at the light's Transform position, ALWAYS drawn
 *    at a constant screen-ish size (see ICON_SCREEN_SIZE) so it stays
 *    clickable and visible even when zoomed out or when the light's
 *    glow itself is faint/tiny — this is what makes a Light entity
 *    selectable by clicking on it directly in the viewport, the same
 *    way Unity's scene-view light icon works.
 *  - a range indicator matching the light's real shape: a circle for
 *    Point, a cone outline for Spot, a rectangle for Area, and a small
 *    sun/arrow glyph for Directional (which has no reach to show).
 *
 * Editor-only chrome: this file is never imported by /runtime, /player,
 * or the play-mode popup, so the icon/range outline only ever appears
 * in the editor's Scene view, never in an actual played/exported game —
 * same convention as CameraGizmo.js and ColliderGizmo.js.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { LIGHT, LightType } from "../../runtime/components/Light.js";

const LIGHT_COLOR = 0xffd23f; // matches the Main Camera gizmo's yellow, Unity's own gizmo-icon yellow
const SELECTED_ALPHA = 1;
const UNSELECTED_ALPHA = 0.85;
const RANGE_ALPHA_SELECTED = 0.9;
const RANGE_ALPHA_UNSELECTED = 0.35;

// Bulb icon is drawn in WORLD units but continuously re-scaled against
// the viewport's current zoom (see drawLightGizmo's `worldPerPixel`
// param) so it reads as a constant ~9px on screen regardless of zoom —
// exactly like Unity's own gizmo icons, which never shrink into
// invisibility when you zoom out, nor balloon to enormous size zoomed
// in. Without this a Point light with radius 40 would draw a bulb
// bigger than its own light range at high zoom.
const ICON_SCREEN_RADIUS = 9;

/**
 * @param {PIXI.Container} container editor-only chrome layer to draw into
 * @param {import('../../runtime/core/World.js').World|null} world
 * @param {string|null} selectedId currently selected entity id, drawn brighter
 * @param {number} worldPerPixel how many world units correspond to 1 screen
 *   pixel at the viewport's current zoom (i.e. 1 / zoomScale) — used only
 *   to keep the bulb icon a constant apparent screen size.
 */
export function drawLightGizmo(container, world, selectedId, worldPerPixel) {
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
  const entities = world.query(TRANSFORM, LIGHT);

  for (const entity of entities) {
    const transform = entity.getComponent(TRANSFORM);
    const light = entity.getComponent(LIGHT);
    const isSelected = entity.id === selectedId;
    const alpha = isSelected ? SELECTED_ALPHA : UNSELECTED_ALPHA;
    const rangeAlpha = isSelected ? RANGE_ALPHA_SELECTED : RANGE_ALPHA_UNSELECTED;
    const lineWidth = isSelected ? 2 : 1.2;

    const g = new PIXI.Graphics();

    _drawRangeIndicator(g, transform, light, rangeAlpha, lineWidth);
    _drawBulbIcon(g, transform.x, transform.y, iconRadius, alpha, isSelected);

    container.addChild(g);

    if (isSelected) {
      const label = new PIXI.Text(_labelFor(light), {
        fontSize: 10,
        fill: LIGHT_COLOR,
        fontFamily: "monospace",
      });
      label.x = transform.x + iconRadius + 4;
      label.y = transform.y - iconRadius - 2;
      container.addChild(label);
    }
  }
}

function _labelFor(light) {
  switch (light.type) {
    case LightType.DIRECTIONAL:
      return "Directional Light";
    case LightType.SPOT:
      return "Spot Light  r=" + Math.round(light.radius) + " " + Math.round(light.angle || 45) + "\u00b0";
    case LightType.AREA:
      return "Area Light  " + Math.round(light.width) + "x" + Math.round(light.height);
    case LightType.GOD_RAYS:
      return "God Rays  r=" + Math.round(light.radius) + " " + Math.round(light.angle || 45) + "\u00b0";
    case LightType.FREEFORM:
      return "Freeform Light  " + (light.points ? light.points.length : 0) + " pts";
    case LightType.POINT:
    default:
      return "Point Light  r=" + Math.round(light.radius);
  }
}

/**
 * Unity-style range indicator, drawn as a thin outline (never filled)
 * so it never visually competes with the light's own real glow — it's
 * purely a "here's the shape/reach" reference, matching how Unity draws
 * its light-range gizmos as wireframe, not solid.
 */
function _drawRangeIndicator(g, transform, light, alpha, lineWidth) {
  g.lineStyle(lineWidth, LIGHT_COLOR, alpha);

  switch (light.type) {
    case LightType.POINT: {
      g.drawCircle(transform.x, transform.y, light.radius);
      break;
    }
    case LightType.SPOT: {
      const rot = (transform.rotation * Math.PI) / 180;
      const halfAngle = ((light.angle || 45) * Math.PI) / 360;
      const steps = 24;
      g.moveTo(transform.x, transform.y);
      for (let i = 0; i <= steps; i++) {
        const a = rot - halfAngle + (i / steps) * (halfAngle * 2);
        g.lineTo(transform.x + Math.cos(a) * light.radius, transform.y + Math.sin(a) * light.radius);
      }
      g.lineTo(transform.x, transform.y);
      // a couple of short radial ticks at the cone's edges make the aim
      // direction readable at a glance even before the fill is visible
      break;
    }
    case LightType.AREA: {
      const w = light.width || 200;
      const h = light.height || 200;
      g.drawRect(transform.x - w / 2, transform.y - h / 2, w, h);
      break;
    }
    case LightType.GOD_RAYS: {
      // Same cone outline as Spot, plus a few inner streak lines so a
      // God Rays light reads as "shafts of light" rather than a plain
      // spotlight at a glance, before the fill is even visible.
      const rot = (transform.rotation * Math.PI) / 180;
      const halfAngle = ((light.angle || 45) * Math.PI) / 360;
      const steps = 24;
      g.moveTo(transform.x, transform.y);
      for (let i = 0; i <= steps; i++) {
        const a = rot - halfAngle + (i / steps) * (halfAngle * 2);
        g.lineTo(transform.x + Math.cos(a) * light.radius, transform.y + Math.sin(a) * light.radius);
      }
      g.lineTo(transform.x, transform.y);
      const rayCount = 5;
      for (let i = 1; i < rayCount; i++) {
        const a = rot - halfAngle + (i / rayCount) * (halfAngle * 2);
        g.moveTo(transform.x, transform.y);
        g.lineTo(transform.x + Math.cos(a) * light.radius, transform.y + Math.sin(a) * light.radius);
      }
      break;
    }
    case LightType.FREEFORM: {
      // Actual polygon vertex dragging/handles are drawn separately by
      // FreeformLightGizmo.js (only when this light is the selected
      // entity); this just gives every Freeform light — selected or
      // not — a lightweight outline so its shape reads at a glance.
      const points = light.points;
      if (points && points.length >= 2) {
        g.moveTo(transform.x + points[0].x, transform.y + points[0].y);
        for (let i = 1; i < points.length; i++) {
          g.lineTo(transform.x + points[i].x, transform.y + points[i].y);
        }
        g.lineTo(transform.x + points[0].x, transform.y + points[0].y);
      }
      break;
    }
    case LightType.DIRECTIONAL:
    default: {
      // No reach to show — instead draw a small sun glyph (circle +
      // rays) so a Directional light is visually distinct from a Point
      // light at a glance even before you check the Inspector.
      const r = 14;
      g.drawCircle(transform.x, transform.y, r);
      const rays = 8;
      for (let i = 0; i < rays; i++) {
        const a = (i / rays) * Math.PI * 2;
        g.moveTo(transform.x + Math.cos(a) * (r + 4), transform.y + Math.sin(a) * (r + 4));
        g.lineTo(transform.x + Math.cos(a) * (r + 10), transform.y + Math.sin(a) * (r + 10));
      }
      break;
    }
  }
}

/**
 * Small filled bulb glyph: a circle "bulb" with a short rectangular
 * "base" beneath it, drawn entirely with PIXI.Graphics (no image/SVG
 * loading — keeps this gizmo synchronous and dependency-free, matching
 * CameraGizmo.js and ColliderGizmo.js, which also hand-draw their icons
 * rather than rasterizing an SVG).
 */
function _drawBulbIcon(g, x, y, radius, alpha, isSelected) {
  g.lineStyle(0);
  g.beginFill(LIGHT_COLOR, alpha);
  g.drawCircle(x, y, radius);
  g.endFill();

  // base "screw" nub beneath the bulb
  const baseW = radius * 0.7;
  const baseH = radius * 0.5;
  g.beginFill(LIGHT_COLOR, alpha);
  g.drawRect(x - baseW / 2, y + radius * 0.55, baseW, baseH);
  g.endFill();

  // outline ring so the icon reads clearly even over a bright/matching
  // background color
  g.lineStyle(isSelected ? 1.5 : 1, 0x1c1c1c, 0.6);
  g.drawCircle(x, y, radius);
}

/**
 * Hit-test used by SceneViewport.js's click-to-select: returns the
 * topmost Light entity whose bulb icon contains the given world-space
 * point, or null. Runs BEFORE sprite hit-testing (see SceneViewport.js)
 * so a light's small icon always takes priority over whatever sprite
 * might happen to be underneath/behind it at that point.
 *
 * @param {import('../../runtime/core/World.js').World|null} world
 * @param {number} worldX
 * @param {number} worldY
 * @param {number} worldPerPixel same constant-screen-size basis
 *   drawLightGizmo uses, so the clickable area always matches what's
 *   actually drawn regardless of zoom.
 */
export function hitTestLightGizmo(world, worldX, worldY, worldPerPixel) {
  if (!world) return null;
  const iconRadius = ICON_SCREEN_RADIUS * (worldPerPixel || 1);
  // generous click padding — small icons are hard to click precisely,
  // Unity's own gizmo icons are similarly forgiving
  const hitRadius = iconRadius * 1.6;

  const entities = world.query(TRANSFORM, LIGHT);
  for (let i = entities.length - 1; i >= 0; i--) {
    const transform = entities[i].getComponent(TRANSFORM);
    const dx = worldX - transform.x;
    const dy = worldY - transform.y;
    if (dx * dx + dy * dy <= hitRadius * hitRadius) return entities[i];
  }
  return null;
}
