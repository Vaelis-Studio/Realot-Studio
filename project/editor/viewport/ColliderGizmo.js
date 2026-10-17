/**
 * editor/viewport/ColliderGizmo.js
 *
 * Draws every entity's Collider2D shape as a red outline in the Scene
 * viewport — the same red-box/red-circle convention Unity uses — so you
 * can see exactly how big a collider is and where it sits relative to
 * the sprite, INCLUDING its offset and Transform scale.
 *
 * Geometry is computed by runtime/physics/ColliderGeometry.js — the
 * SAME function runtime/physics/PhysicsWorld.js uses to build the real
 * Rapier collider. That is a deliberate, load-bearing choice: it's the
 * only thing that guarantees this red outline is always exactly what
 * will physically collide, not just a visual approximation of it. If
 * you ever need to change how offset/scale/size map to world space, do
 * it in ColliderGeometry.js so both stay in sync automatically.
 *
 * Editor-only chrome: this file is never imported by /runtime, /player,
 * or the play-mode popup, so the outline only ever appears in the
 * editor's Scene view, never in an actual played/exported game.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { COLLIDER_2D, ColliderShape } from "../../runtime/components/Collider2D.js";
import { getColliderWorldGeometry } from "../../runtime/physics/ColliderGeometry.js";

const COLLIDER_COLOR = 0xff2d55; // Unity-style collider red
const TRIGGER_COLOR = 0x2dd4ff; // distinct color for trigger colliders (not solid)
const SELECTED_ALPHA = 1;
const UNSELECTED_ALPHA = 0.55;

/**
 * @param {PIXI.Container} container editor-only chrome layer to draw into
 * @param {import('../../runtime/core/World.js').World|null} world
 * @param {string|null} selectedId currently selected entity id, drawn brighter/thicker
 */
export function drawColliderGizmo(container, world, selectedId) {
  container.removeChildren();
  if (!world) return;

  const entities = world.query(TRANSFORM, COLLIDER_2D);

  for (const entity of entities) {
    const transform = entity.getComponent(TRANSFORM);
    const collider = entity.getComponent(COLLIDER_2D);
    const isSelected = entity.id === selectedId;
    const geo = getColliderWorldGeometry(collider, transform);

    const color = collider.isTrigger ? TRIGGER_COLOR : COLLIDER_COLOR;
    const alpha = isSelected ? SELECTED_ALPHA : UNSELECTED_ALPHA;
    const lineWidth = isSelected ? 2.5 : 1.5;

    const g = new PIXI.Graphics();
    g.lineStyle(lineWidth, color, alpha);

    if (geo.shape === ColliderShape.CIRCLE) {
      // A circle looks identical at any rotation, so no rotation is
      // applied when drawing it — this matches Rapier too: a ball
      // collider's rotation never changes its physical footprint.
      g.drawCircle(geo.centerX, geo.centerY, geo.radius);
    } else if (geo.shape === ColliderShape.CAPSULE) {
      // A capsule ("stadium" shape) is a rectangle of width
      // 2*radius/height 2*halfHeight with its two short ends replaced
      // by semicircle caps — draw it as two arcs joined by two
      // straight side segments, rotated as a whole by the entity's
      // rotation (unlike CIRCLE, a capsule's long axis DOES visibly
      // change with rotation, so it can't skip the rotation step).
      const angleRad = (geo.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      const rot = (lx, ly) => [geo.centerX + lx * cos - ly * sin, geo.centerY + lx * sin + ly * cos];

      const topCenter = rot(0, -geo.halfHeight);
      const bottomCenter = rot(0, geo.halfHeight);
      // side lines tangent to both caps
      const topLeft = rot(-geo.radius, -geo.halfHeight);
      const bottomLeft = rot(-geo.radius, geo.halfHeight);
      const topRight = rot(geo.radius, -geo.halfHeight);
      const bottomRight = rot(geo.radius, geo.halfHeight);

      g.moveTo(topLeft[0], topLeft[1]);
      g.lineTo(bottomLeft[0], bottomLeft[1]);
      g.moveTo(topRight[0], topRight[1]);
      g.lineTo(bottomRight[0], bottomRight[1]);
      // PIXI's Graphics.arc() always sweeps in the shape's own local
      // (unrotated) angle space, so draw each cap as a full circle
      // clipped visually by only the two tangent lines above rather
      // than fighting arc()'s rotation semantics — simplest robust
      // approach for an editor-only preview outline.
      g.drawCircle(topCenter[0], topCenter[1], geo.radius);
      g.drawCircle(bottomCenter[0], bottomCenter[1], geo.radius);
    } else if (geo.shape === ColliderShape.TRIANGLE) {
      const pts = geo.worldPoints;
      g.moveTo(pts[0].x, pts[0].y);
      g.lineTo(pts[1].x, pts[1].y);
      g.lineTo(pts[2].x, pts[2].y);
      g.lineTo(pts[0].x, pts[0].y);
    } else {
      // Draw the box as 4 rotated corner points rather than an
      // axis-aligned drawRect — this is what makes the red outline
      // actually track the entity's rotation the same way Rapier's
      // real cuboid collider does (a rotated body rotates its attached
      // collider rigidly, not just its sprite).
      const angleRad = (geo.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      const corners = [
        [-geo.halfWidth, -geo.halfHeight],
        [geo.halfWidth, -geo.halfHeight],
        [geo.halfWidth, geo.halfHeight],
        [-geo.halfWidth, geo.halfHeight],
      ].map(([lx, ly]) => [geo.centerX + lx * cos - ly * sin, geo.centerY + lx * sin + ly * cos]);

      g.moveTo(corners[0][0], corners[0][1]);
      for (let i = 1; i < corners.length; i++) g.lineTo(corners[i][0], corners[i][1]);
      g.lineTo(corners[0][0], corners[0][1]);
    }

    // small crosshair at the collider's own center so the offset from
    // the sprite's pivot is obvious at a glance, not just implied by
    // the outline's position
    g.moveTo(geo.centerX - 5, geo.centerY);
    g.lineTo(geo.centerX + 5, geo.centerY);
    g.moveTo(geo.centerX, geo.centerY - 5);
    g.lineTo(geo.centerX, geo.centerY + 5);

    container.addChild(g);

    if (isSelected) {
      const dims =
        geo.shape === ColliderShape.CIRCLE
          ? "r=" + Math.round(geo.radius)
          : geo.shape === ColliderShape.CAPSULE
          ? "r=" + Math.round(geo.radius) + " h=" + Math.round(geo.halfHeight * 2)
          : geo.shape === ColliderShape.TRIANGLE
          ? "3pt"
          : Math.round(geo.halfWidth * 2) + "x" + Math.round(geo.halfHeight * 2);
      const label = new PIXI.Text((collider.isTrigger ? "Trigger " : "Collider ") + dims, {
        fontSize: 10,
        fill: color,
        fontFamily: "monospace",
      });
      const labelTopOffset =
        geo.shape === ColliderShape.CIRCLE
          ? geo.radius
          : geo.shape === ColliderShape.CAPSULE
          ? geo.halfHeight + geo.radius
          : geo.shape === ColliderShape.TRIANGLE
          ? Math.max(...geo.worldPoints.map((p) => geo.centerY - p.y), 0)
          : geo.halfHeight;
      label.x = geo.centerX + 6;
      label.y = geo.centerY - labelTopOffset - 14;
      container.addChild(label);
    }
  }
}

