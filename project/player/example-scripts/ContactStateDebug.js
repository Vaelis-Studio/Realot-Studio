/**
 * ContactStateDebug.js — drop-in Realot script
 *
 * Paste this into the Script Editor (Add Component → Script → new/edit)
 * on any entity that has a Rigidbody2D (Kinematic works best — that's
 * the body type with real per-axis contact detection) and a
 * CharacterController if you want to test movement at the same time.
 *
 * WHAT THIS DEMONSTRATES
 *  1. console.log-ing every "on___" contact-state flag the engine
 *     tracks: grounded, isOnCeiling, isOnWall, isOnSlope.
 *  2. Reading the live groundAngle (the actual angle of whatever
 *     surface you're standing on).
 *  3. Setting the three angle THRESHOLDS that decide how a contact
 *     gets classified into ground / slope / wall in the first place.
 *  4. Using this.rigidbody.* AND this.controller.* — both now expose
 *     the same contact-state readers, so use whichever this.___ you're
 *     already reading velocity/move info from.
 *
 * ANGLES, EXPLAINED
 *   All angles are in DEGREES, measured from flat/horizontal ground:
 *     0°   = perfectly flat floor
 *     ~30° = a walkable ramp
 *     ~90° = a vertical wall
 *
 *   Three thresholds decide how a contact gets classified:
 *     groundAngleLimit (default 45)
 *       Contacts at or below this angle count as walkable ground.
 *       Raise this (e.g. 60) to let the character climb steeper ramps.
 *     wallAngleLimit (default 70)
 *       Contacts at or ABOVE this angle count as a genuine wall
 *       (isOnWall = true). Between groundAngleLimit and wallAngleLimit
 *       is a "too steep to climb, but not a wall either" band — an
 *       unclimbable slope the character just can't walk up.
 *     slopeMinAngle (default 10)
 *       The minimum groundAngle before isOnSlope flips to true.
 *       Below this, a slightly-uneven floor still reads as flat
 *       ground instead of "on a slope" (avoids false positives from
 *       floating-point noise on a perfectly flat floor).
 *
 *   Set them once in onStart() (or anytime) like this:
 *     this.rigidbody.groundAngleLimit = 55;
 *     this.rigidbody.wallAngleLimit   = 75;
 *     this.rigidbody.slopeMinAngle    = 12;
 *   (this.controller does NOT expose the setters for these three —
 *   only this.rigidbody does, since they're a property of the physics
 *   body's sweep, not of the movement scheme. Read-state — isOnWall
 *   etc — works from either sub-object.)
 */

// How often to print the full state block, in seconds. Every-frame
// logging is too noisy to read — 0.5s gives a readable stream while
// still catching short-lived states like a mid-air ceiling tap.
const LOG_INTERVAL = 0.5;

function onStart() {
  this._logTimer = 0;

  // --- Example: configuring the angle thresholds ---
  // Uncomment/edit any of these to change how THIS body classifies
  // ground vs slope vs wall. Safe to leave commented — defaults
  // (45 / 70 / 10) match Unity's own CharacterController.slopeLimit
  // convention and Rapier's documented example values.
  //
  // this.rigidbody.groundAngleLimit = 45; // ground/slope vs "too steep"
  // this.rigidbody.wallAngleLimit   = 70; // "too steep" vs genuine wall
  // this.rigidbody.slopeMinAngle    = 10; // flat floor vs "on a slope"

  console.log(
    "[ContactStateDebug] started on '" + (this.name || "entity") + "'. " +
    "Thresholds — groundAngleLimit=" + this.rigidbody.groundAngleLimit +
    "  wallAngleLimit=" + this.rigidbody.wallAngleLimit +
    "  slopeMinAngle=" + this.rigidbody.slopeMinAngle
  );
}

function onUpdate(dt) {
  this._logTimer += dt;
  if (this._logTimer < LOG_INTERVAL) return;
  this._logTimer = 0;

  // --- Every "on___" state, read straight off this.rigidbody ---
  // (this.controller.isOnCeiling / isOnWall / isOnSlope / groundAngle
  // report the exact same live values — use whichever object you're
  // already working with. isGrounded only exists on this.controller
  // if the controller type can jump; grounded/isGrounded on
  // this.rigidbody always works regardless of controller type.)
  var grounded   = this.rigidbody.grounded;   // touching walkable ground/slope
  var onCeiling  = this.rigidbody.isOnCeiling; // hit something directly above
  var onWall     = this.rigidbody.isOnWall;    // touching a near-vertical surface
  var onSlope    = this.rigidbody.isOnSlope;   // grounded AND the surface is tilted
  var groundAngle = this.rigidbody.groundAngle; // 0 = flat, up to groundAngleLimit

  console.log(
    "[ContactStateDebug] " +
    "grounded=" + grounded + "  " +
    "onCeiling=" + onCeiling + "  " +
    "onWall=" + onWall + "  " +
    "onSlope=" + onSlope + "  " +
    "groundAngle=" + groundAngle.toFixed(1) + "\u00b0" + "  " +
    "vel=(" + this.rigidbody.velocityX.toFixed(0) + "," + this.rigidbody.velocityY.toFixed(0) + ")"
  );

  // --- Example reaction to state, so you can see it wired to logic ---
  // A wall-slide/wall-jump often checks onWall + !grounded together:
  if (onWall && !grounded) {
    // e.g. a wall-jump could go here:
    // if (input.keyPressed("Space")) this.controller.simulateJump();
  }

  // A slope check might slow the character down on steep ground:
  if (onSlope && groundAngle > 25) {
    // e.g. this.controller.moveSpeed could be temporarily reduced here.
  }
}

// Realot compiles this with `new Function(...)` and looks for these
// exact top-level function names (onStart, onUpdate, onFixedUpdate,
// onCollision, onCollisionEnter/Exit, onTriggerEnter/Exit, onDestroy) —
// declare a plain `function name() {}` for each lifecycle you use, no
// export statement needed (or wanted — this isn't an ES module).
