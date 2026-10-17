/**
 * GeometryDashKinematicCustom.js — custom-controller example
 *
 * Use this when the player has Rigidbody2D = Kinematic and NO CharacterController
 * / Movement Type attached. The script owns horizontal movement, gravity, jump,
 * and mid-air rotation. The engine keeps the collider synchronized when the
 * grounded cube snaps to the nearest 90° angle, so the landing does not vibrate.
 *
 * Suggested setup:
 *   - Rigidbody2D: Body Type = Kinematic
 *   - Collider2D: Box, centered on the Rigidbody
 *   - No CharacterController / Movement Type
 *   - A Static Rigidbody2D + Collider2D floor
 */

const RUN_SPEED = 300;          // px/s
const GRAVITY = 1200;           // px/s² (20/frame at 60 FPS)
const JUMP_VELOCITY = -200;     // px/s
const AIR_ROTATION_SPEED = 360; // degrees/s (6°/frame at 60 FPS)

let wasGrounded = false;

function onStart() {
  wasGrounded = this.rigidbody.isGrounded;
}

function onUpdate(dt) {
  const grounded = this.rigidbody.isGrounded;

  // Geometry-style constant forward movement.
  this.rigidbody.velocityX = RUN_SPEED;

  // Jump takes priority on a grounded frame. Once airborne, gravity takes over.
  if (input.keyPressed("Space") && grounded) {
    this.rigidbody.velocityY = JUMP_VELOCITY;
  } else if (!grounded) {
    this.rigidbody.velocityY += GRAVITY * dt;
  } else {
    this.rigidbody.velocityY = 0;
  }

  // Rotate only while airborne. On the first grounded frame, snap once to the
  // nearest 90° cardinal orientation; do not repeatedly rewrite the angle.
  if (!grounded) {
    this.rotation += AIR_ROTATION_SPEED * dt;
  } else if (!wasGrounded) {
    this.rotation = Math.round(this.rotation / 90) * 90;
  }

  wasGrounded = grounded;
}
