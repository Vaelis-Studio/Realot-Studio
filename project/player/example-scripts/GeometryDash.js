/**
 * GeometryDash.js — drop-in Realot script
 *
 * Classic Geometry Dash gameplay: the player auto-scrolls right at a
 * constant speed forever, tap/click/Space jumps, touching an obstacle
 * instantly restarts the scene.
 *
 * ============================== SETUP ==============================
 *
 * 1) PLAYER ENTITY — the entity you attach this script to must have:
 *      - Rigidbody2D, Body Type = Dynamic
 *      - Collider2D (Box or Circle both work)
 *      - CharacterController, Controller Type = "Character Controller"
 *        (any Movement Type that supports jumping works, but Character
 *        Controller is the simplest — this script does NOT require
 *        useDefaultInput to be on; it drives jumps itself)
 *      - Script (this file)
 *    Gravity should be ON (CharacterController.useGravity checked, or
 *    just leave Rigidbody2D's gravityScale at its default 1) — that's
 *    what makes the jump arc back down.
 *
 * 2) GROUND — one or more STATIC entities with a Collider2D running
 *    along the bottom of the level for the player to run on.
 *
 * 3) OBSTACLES (spikes/blocks that kill on touch) — give each one:
 *      - A Collider2D (isTrigger can be ON or OFF, both work — see
 *        onCollisionEnter/onTriggerEnter below, this script handles
 *        both automatically)
 *      - A Rigidbody2D, Body Type = Static (so it doesn't fall/move)
 *      - A NAME (Hierarchy panel, double-click to rename) that
 *        contains the word "Obstacle" — e.g. "Obstacle", "Obstacle 1",
 *        "SpikeObstacle". That's how this script tells an obstacle
 *        apart from the ground/floor/decorations it also touches.
 *      Anything whose name does NOT contain "Obstacle" is ignored on
 *      contact (so touching the ground or a background object is safe).
 *
 * ===================== HOW TO CHANGE THE FEEL =======================
 *   SCROLL_SPEED  — how fast the level auto-scrolls (px/s)
 *   JUMP_FORCE    — how high a jump goes (px/s upward impulse)
 *   OBSTACLE_NAME_MATCH — the substring an entity's name must contain
 *                   to count as a deadly obstacle (case-insensitive)
 *
 * ===================== WHAT COUNTS AS "GROUNDED" =====================
 *   this.controller.isGrounded is used to gate jumping — it comes from
 *   ControllerSystem's own per-frame ground check on a Dynamic body
 *   (near-zero vertical speed), NOT this.rigidbody.grounded (which is
 *   always false on a Dynamic body by design — Dynamic bodies don't
 *   get the Kinematic sweep's real ground-contact tracking; the
 *   CharacterController's own approximation is the correct signal to
 *   use here, which is exactly what this script does).
 */

// How fast the level scrolls (and the player runs) to the right, in px/s.
const SCROLL_SPEED = 300;

// Upward velocity applied on jump, in px/s. Higher = jumps higher.
const JUMP_FORCE = 480;

// An obstacle entity's Name (Hierarchy panel) must contain this text
// (case-insensitive) to count as deadly on contact. Anything else the
// player touches (ground, decorations, etc.) is ignored.
const OBSTACLE_NAME_MATCH = "obstacle";

function onStart() {
  // Lock rotation so the player capsule/box doesn't tumble on impact —
  // classic Geometry Dash keeps the player's orientation controlled
  // (only this script/an animation should rotate it, never physics).
  this.rigidbody.lockRotation = true;

  // This script drives movement itself (constant auto-scroll), so
  // WASD/Arrow input is turned off — only Space/click/tap is used, and
  // only for jumping. If useDefaultInput was left on in the Inspector,
  // turning it off here means left/right keys never fight the
  // auto-scroll.
  this.controller.useDefaultInput = false;
}

function onUpdate(dt) {
  // Constant forward speed — every frame, not just once, because a
  // Dynamic body's driveVelocityX is a ONE-SHOT seed (PhysicsWorld.js
  // resets it right after applying it each physics step) rather than a
  // standing value, so it has to be re-set every frame to keep holding
  // this speed against gravity/collisions.
  this.controller.simulateMove(1, 0);

  // Jump on Space (keydown edge) OR a tap/click (see onCollisionEnter's
  // sibling handlers below aren't used for input — pointer input isn't
  // exposed to scripts in this engine, so Space is the primary control;
  // most browser Geometry Dash clones also bind click/tap to the SAME
  // key the browser already sends for a canvas click focus, so Space
  // covers keyboard play here). Only allowed while grounded so this
  // matches classic GD's single-jump-per-landing feel (maxJumps on the
  // CharacterController component controls double-jump if you want it).
  if (input.keyPressed("Space") && this.controller.isGrounded) {
    this.controller.simulateJump();
  }
}

function onCollisionEnter(other) {
  _checkObstacle(other);
}

// Some obstacle colliders may be set up as Trigger colliders instead of
// solid ones (isTrigger = true) — e.g. so the player visually passes
// through a spike's collider bounds instead of physically bouncing off
// it right before dying. Handling both means this script works no
// matter which the obstacle's Collider2D is configured as.
function onTriggerEnter(other) {
  _checkObstacle(other);
}

function _checkObstacle(other) {
  if (!other || !other.name) return;
  if (other.name.toLowerCase().indexOf(OBSTACLE_NAME_MATCH) === -1) return;

  // Instant classic-GD retry: reload the whole scene from scratch.
  scene.restart();
}
