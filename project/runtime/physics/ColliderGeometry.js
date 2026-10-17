/**
 * runtime/physics/ColliderGeometry.js
 *
 * The ONE place that converts a Collider2D + Transform into world-space
 * shape data (half-extents/radius + center position + rotation). Both
 * runtime/physics/PhysicsWorld.js (feeding Rapier) and
 * editor/viewport/ColliderGizmo.js (drawing the red outline) call this
 * same function, so the shape Rapier actually collides with and the
 * shape drawn on screen are mathematically guaranteed to match — there
 * is no second copy of this math anywhere to drift out of sync.
 *
 * A Collider2D's offset/size are defined in the entity's LOCAL space,
 * and a Rapier collider is rigidly attached to its parent body — so
 * when the body rotates, BOTH the shape itself AND its offset from the
 * body's origin rotate with it (an offset collider swings around the
 * body like a rock on a string, it doesn't just slide). That's exactly
 * what this function reproduces: rotate the local offset by the
 * entity's rotation before adding it to the entity's world position.
 *
 * RUNTIME-ONLY FILE. (Imported by the editor for drawing, but contains
 * no editor-only logic itself — pure geometry.)
 */

import { ColliderShape } from "../components/Collider2D.js";

/**
 * @param {import('../components/Collider2D.js').Collider2D} collider
 * @param {import('../components/Transform.js').Transform} transform
 * @returns {
 *   { shape: 'Box', centerX: number, centerY: number, halfWidth: number, halfHeight: number, rotationDeg: number } |
 *   { shape: 'Circle', centerX: number, centerY: number, radius: number, rotationDeg: number }
 * } world-space geometry, in the same pixel units as Transform.
 *   rotationDeg is included on both shapes (a circle's own rotation is
 *   visually meaningless, but is still returned for API consistency —
 *   ColliderGizmo uses it to rotate the box case only).
 */
export function getColliderWorldGeometry(collider, transform) {
  const rotationDeg = transform.rotation || 0;
  const angleRad = (rotationDeg * Math.PI) / 180;

  // Rotate the LOCAL offset (already scaled to world size) by the
  // entity's rotation, then translate by the entity's world position —
  // this is the standard "rotate then translate" local-to-world
  // transform, matching exactly what Rapier does internally when it
  // composes a collider's local offset with its parent body's isometry.
  const localOffsetX = collider.offsetX * transform.scaleX;
  const localOffsetY = collider.offsetY * transform.scaleY;
  const rotatedOffsetX = localOffsetX * Math.cos(angleRad) - localOffsetY * Math.sin(angleRad);
  const rotatedOffsetY = localOffsetX * Math.sin(angleRad) + localOffsetY * Math.cos(angleRad);

  const centerX = transform.x + rotatedOffsetX;
  const centerY = transform.y + rotatedOffsetY;

  if (collider.shape === ColliderShape.CIRCLE) {
    const radius = collider.radius * Math.max(Math.abs(transform.scaleX), Math.abs(transform.scaleY));
    return { shape: ColliderShape.CIRCLE, centerX, centerY, radius, rotationDeg };
  }

  if (collider.shape === ColliderShape.CAPSULE) {
    // Capsule scales like a box: halfHeight follows Y scale, radius
    // follows the larger of the two axes (same convention CIRCLE uses
    // above) so a non-uniform scale doesn't produce a squashed capsule
    // Rapier can't actually represent (Rapier's capsule radius is a
    // single scalar, it can't be elliptical).
    const halfHeight = collider.capsuleHalfHeight * Math.abs(transform.scaleY);
    const radius = collider.capsuleRadius * Math.max(Math.abs(transform.scaleX), Math.abs(transform.scaleY));
    return { shape: ColliderShape.CAPSULE, centerX, centerY, halfHeight, radius, rotationDeg };
  }

  if (collider.shape === ColliderShape.TRIANGLE) {
    // Rapier's ColliderDesc.triangle(a, b, c) takes points in the
    // collider's LOCAL space and applies the parent body's rotation
    // itself — so the "local" points here are only scaled, NOT
    // rotated (rotating them here too would double-rotate once Rapier
    // also applies the body's rotation). We still also hand back
    // ROTATED, translated worldPoints for ColliderGizmo, which draws
    // directly in world space and has no separate rotation step of its
    // own to rely on.
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const localPoints = collider.trianglePoints.map((p) => ({
      x: p.x * transform.scaleX,
      y: p.y * transform.scaleY,
    }));
    const worldPoints = localPoints.map((p) => ({
      x: centerX + (p.x * cos - p.y * sin),
      y: centerY + (p.x * sin + p.y * cos),
    }));
    return { shape: ColliderShape.TRIANGLE, centerX, centerY, localPoints, worldPoints, rotationDeg };
  }

  const halfWidth = (collider.width * Math.abs(transform.scaleX)) / 2;
  const halfHeight = (collider.height * Math.abs(transform.scaleY)) / 2;
  return { shape: ColliderShape.BOX, centerX, centerY, halfWidth, halfHeight, rotationDeg };
}
