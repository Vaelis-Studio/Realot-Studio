/**
 * runtime/components/Collider2D.js
 *
 * Plain physics-shape data. Separate from Rigidbody2D on purpose (same
 * split Unity uses): a Rigidbody2D says HOW an entity moves (Dynamic /
 * Kinematic / Static), a Collider2D says WHAT SHAPE it collides as. An
 * entity can have a Collider2D with no Rigidbody2D at all (Rapier still
 * treats it as a static collider), matching Unity's "collider-only"
 * convention.
 *
 * No Rapier objects live here — this is pure serializable data. Rapier
 * collider handles are built/kept in sync by
 * runtime/physics/PhysicsWorld.js.
 *
 * RUNTIME-ONLY FILE.
 */

export const COLLIDER_2D = "Collider2D";

// Named physics layers — same slot-based design as Unity's Layer system.
// Layer 0 (Default) is the everything-collides-with-everything baseline.
// Assign objects to named layers and configure per-collider masks in the
// Inspector to control which pairs physically interact and receive script
// callbacks (onCollisionEnter / onTriggerEnter).
export const LAYER_COUNT = 16;

/**
 * Encodes a layer + mask pair into Rapier's 32-bit collision groups word.
 *   bits  0-15 = membership  (which layer this collider IS on)
 *   bits 16-31 = filter      (which layers it CAN interact with)
 *
 * Two colliders A and B interact only when BOTH of these hold:
 *   (A.membership & B.filter) !== 0
 *   (B.membership & A.filter) !== 0
 *
 * @param {number} layer  0–15: which layer this collider belongs to
 * @param {number} mask   16-bit mask: which layers it can collide with
 * @returns {number} 32-bit groups word for Rapier
 */
export function makeCollisionGroups(layer, mask) {
  const membership = (1 << (layer & 0xF)) & 0xFFFF;
  const filter     = mask & 0xFFFF;
  return membership | (filter << 16);
}

export const ColliderShape = Object.freeze({
  BOX: "Box",
  CIRCLE: "Circle",
  CAPSULE: "Capsule",
  TRIANGLE: "Triangle",
});

export class Collider2D {
  constructor({
    shape = ColliderShape.BOX,
    width = 1,
    height = 1,
    radius = 0.5,
    // Capsule: a "stadium" shape (rectangle with semicircle caps) —
    // matches Rapier's ColliderDesc.capsule(halfHeight, radius), whose
    // principal axis is Y (i.e. it's a vertical pill by default, the
    // conventional orientation for a 2D character collider).
    capsuleHalfHeight = 0.5,
    capsuleRadius = 0.3,
    // Triangle: 3 points in the entity's LOCAL space (same space as
    // offsetX/offsetY), user-editable via 3 draggable gizmo handles.
    // Stored as a flat default so a fresh Triangle collider is a
    // sensible small right-triangle rather than 3 coincident points
    // (which Rapier would reject as a degenerate/zero-area shape).
    trianglePoints = [
      { x: -0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0, y: -0.5 },
    ],
    offsetX = 0,
    offsetY = 0,
    isTrigger = false,
    // One-way platform: solid only when the other body is landing on it
    // from above; a body approaching from below or the side passes
    // straight through, like a Mario/Metroidvania jump-through platform.
    // Implemented via Rapier's PhysicsHooks.filterContactPair — see
    // PhysicsWorld.js's step() for the actual per-contact test (checked
    // there rather than here since it needs live position data from
    // both bodies, which isn't available on the component itself).
    // No effect on a Trigger collider (isTrigger already skips real
    // contact resolution entirely) or on shapes other than Box (one-way
    // platforms are conventionally flat, thin, rectangular surfaces).
    isOneWayPlatform = false,
    friction = 0.5,
    restitution = 0,
    density = 1,
    // Collision layer/mask — inspired by Unity's physics layer matrix.
    // layer: which of the 16 named layers this collider belongs to.
    // mask:  16-bit bitmask of layers this collider CAN physically interact
    //        with. Two colliders interact only when EACH is in the other's mask.
    // Default: layer 0 (Default), mask 0xFFFF (collides with all layers).
    layer = 0,
    mask  = 0xFFFF,
  } = {}) {
    this.shape = shape;
    // Box
    this.width = width;
    this.height = height;
    // Circle
    this.radius = radius;
    // Capsule
    this.capsuleHalfHeight = capsuleHalfHeight;
    this.capsuleRadius = capsuleRadius;
    // Triangle — deep-copy so distinct Collider2D instances never share
    // point objects by accident (e.g. via spread/default-arg reuse)
    this.trianglePoints = trianglePoints.map((p) => ({ x: p.x, y: p.y }));
    // Shared
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.isTrigger = isTrigger;
    this.isOneWayPlatform = isOneWayPlatform;
    this.friction = friction;
    this.restitution = restitution;
    this.density = density;
    this.layer = layer;
    this.mask  = mask;
  }
}
