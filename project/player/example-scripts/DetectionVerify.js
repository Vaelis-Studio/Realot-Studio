/**
 * DetectionVerify.js — drop-in Realot script
 *
 * Proves grounded / isOnCeiling / isOnWall / isOnSlope / groundAngle
 * are ACTUALLY working, using the on-screen debug HUD (not just
 * console spam) so you can watch every flag flip live while you move.
 *
 * ============================== SETUP ==============================
 * Attach to your player entity:
 *   - Rigidbody2D (Kinematic — this is the body type with real
 *     per-axis contact tracking; on Dynamic these all read
 *     false/0 by design, see FIXES.md's item on this.rigidbody.grounded)
 *   - CharacterController, any walk type (Character Controller or
 *     Platformer both work; useGravity ON)
 *   - This script
 *
 * ==================== BUILD THIS TEST SCENE =========================
 * To exercise all five flags you need FOUR pieces of geometry, each a
 * Static entity with a Collider2D:
 *
 *   1. FLOOR       — flat ground strip. Walk onto it → grounded = true,
 *                    groundAngle = 0, isOnSlope = false.
 *   2. RAMP        — a box/platform ROTATED ~20-30° (set Rotation in
 *                    the Inspector's Transform). Walk onto it →
 *                    grounded = true, groundAngle ≈ your rotation
 *                    amount, isOnSlope = true (once past slopeMinAngle,
 *                    default 10°).
 *   3. LOW CEILING  — a box positioned just above head height, low
 *                    enough that a jump hits it. Jump under it →
 *                    isOnCeiling = true for the moment of impact, then
 *                    false again once you fall away from it.
 *   4. WALL         — a tall vertical box beside the floor. Walk into
 *                    it → isOnWall = true while pressed against it,
 *                    false the instant you back off.
 *
 * ========================= HOW TO READ IT ============================
 * Press P in-game to toggle the HUD on/off (debug.show()). While
 * running, six always-visible lines update live:
 *   Grounded, OnCeiling, OnWall, OnSlope, GroundAngle, Velocity
 * Watch each one flip from false→true (or the angle change) at the
 * exact moment you touch the matching piece of geometry above. If a
 * flag never flips no matter what you touch, that's the one that isn't
 * working — everything else having correctly flipped rules out a
 * general script/setup mistake and narrows it to that specific flag.
 *
 * The console also prints ONE line every time any flag actually
 * CHANGES value (not every frame — only on a real transition), so you
 * get a clean timestamped log of every detection event instead of
 * needing to stare at the HUD the whole time.
 */

function onStart() {
  debug.show();
  this._prev = { grounded: null, onCeiling: null, onWall: null, onSlope: null };
}

function onUpdate(dt) {
  // Toggle the HUD on/off with P, in case it's in your way.
  if (input.keyPressed("KeyP")) {
    this._hudOn = !this._hudOn;
    debug.show(this._hudOn !== false);
  }

  const rb = this.rigidbody;
  const grounded = rb.grounded;
  const onCeiling = rb.isOnCeiling;
  const onWall = rb.isOnWall;
  const onSlope = rb.isOnSlope;
  const angle = rb.groundAngle;

  // Live HUD lines — always visible, updated every frame.
  debug.log("Grounded", grounded);
  debug.log("OnCeiling", onCeiling);
  debug.log("OnWall", onWall);
  debug.log("OnSlope", onSlope);
  debug.log("GroundAngle", angle.toFixed(1) + "\u00b0");
  debug.log("Velocity", "(" + rb.velocityX.toFixed(0) + ", " + rb.velocityY.toFixed(0) + ")");

  // Console line ONLY on an actual state change — proves the exact
  // moment each flag flips, instead of flooding the console every frame.
  if (grounded !== this._prev.grounded) {
    console.log("[DetectionVerify] grounded: " + this._prev.grounded + " -> " + grounded);
    this._prev.grounded = grounded;
  }
  if (onCeiling !== this._prev.onCeiling) {
    console.log("[DetectionVerify] isOnCeiling: " + this._prev.onCeiling + " -> " + onCeiling);
    this._prev.onCeiling = onCeiling;
  }
  if (onWall !== this._prev.onWall) {
    console.log("[DetectionVerify] isOnWall: " + this._prev.onWall + " -> " + onWall);
    this._prev.onWall = onWall;
  }
  if (onSlope !== this._prev.onSlope) {
    console.log("[DetectionVerify] isOnSlope: " + this._prev.onSlope + " (groundAngle=" + angle.toFixed(1) + ")");
    this._prev.onSlope = onSlope;
  }
}
