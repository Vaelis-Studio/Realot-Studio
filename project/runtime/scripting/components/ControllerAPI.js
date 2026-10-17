/**
 * runtime/scripting/components/ControllerAPI.js
 *
 * The `this.controller` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the general rationale.
 *
 * MOVEMENT-TYPE-AWARE, same convention as RigidbodyAPI.js's
 * body-type-aware API: this exposes a DIFFERENT set of members
 * depending on the entity's actual CharacterController.controllerType,
 * matching what that movement type's own tunables/behavior actually
 * are (see components/CharacterController.js) instead of one flat
 * object where most fields are meaningless for most types:
 *
 *   - Character Controller / Platformer / Top-Down (all share the
 *     "walk + optional gravity + optional jump" tunables):
 *       moveSpeed, acceleration, airControl, useGravity, gravityScale,
 *       useDefaultInput, simulateMove(x, y), isGrounded, isOnWall,
 *       isOnCeiling, isOnSlope, groundAngle
 *     Character Controller + Platformer only (both can jump):
 *       canJump, jumpForce, maxJumps, simulateJump()
 *   - Car:
 *       maxSpeed, acceleration (maps to CharacterController.
 *       carAcceleration — same tunable, Car's own name for it),
 *       brakeForce, turnSpeed, driftFactor, useDefaultInput,
 *       simulateDrive(throttle, steer) — contributes throttle/steer to the
 *       same car input axes as WASD/Arrows when useDefaultInput is on; when
 *       it is off, script/joystick input is the only source.
 *   - Follow:
 *       targetName, followSpeed, followDistance
 *   - Patrol:
 *       moveSpeed, acceleration (shared with the walk family),
 *       useDefaultInput, simulateMove(x, y) — automatic patrol and scripted
 *       movement can contribute together while useDefaultInput is on; turn it
 *       off to make simulateMove the only movement source (y is ignored,
 *       Patrol has no vertical input concept). flipDirection() forces an immediate
 *       turn on demand in EITHER mode. Also: patrolDistance,
 *       facingDirection (read-only), isOnWall, isOnCeiling, isOnSlope,
 *       groundAngle, isGrounded (read-only). No jump — Patrol never
 *       jumps.
 *   - Free: this sub-object still exists (so this.controller.
 *     controllerType reads "Free" and a script can check what type it
 *     is), but every member beyond `type` throws — Free means fully
 *     script-driven (see CharacterController.js's doc comment):
 *     ControllerSystem does nothing for it at all, so there is no
 *     isGrounded/simulateJump/etc. for this.controller to report.
 *
 * Calling/reading a member that doesn't apply to the CURRENT
 * controllerType throws a clear, actionable error (same three-way
 * split as RigidbodyAPI.js: missing-component / unsupported-
 * controller-type / unknown-api) instead of silently returning
 * undefined or a stale/wrong value.
 *
 * isGrounded reads Rigidbody2D.grounded — populated by
 * PhysicsWorld.js's character-controller sweep for Kinematic bodies,
 * and by ControllerSystem.js's own epsilon check for Dynamic bodies
 * (see that file's _applyDynamic). simulateJump() sets
 * CharacterController.requestJump, a one-shot flag ControllerSystem.js
 * consumes on its next update exactly like a literal Space keypress —
 * see ControllerSystem.js's _applyDynamic/_applyKinematic.
 *
 * IMPLEMENTATION NOTE: like RigidbodyAPI.js, this deliberately does
 * NOT put throwing getters inside the per-type object literals below —
 * Object.assign()/an object literal evaluates a getter IMMEDIATELY
 * while being built, not lazily when read, so a throwing getter placed
 * directly in one of these literals would crash API construction
 * itself. Each type's object literal only defines what it actually
 * supports; the Proxy in createControllerAPI() consults
 * ALL_KNOWN_MEMBERS to tell "wrong controller type" apart from
 * "not a real member at all".
 *
 * RUNTIME-ONLY FILE.
 */

import { CHARACTER_CONTROLLER, ControllerType, PatrolMode, PatrolAxis } from "../../components/CharacterController.js";
import { RIGIDBODY_2D } from "../../components/Rigidbody2D.js";

function _cc(entity) {
  return entity.getComponent(CHARACTER_CONTROLLER);
}
function _rb(entity) {
  return entity.getComponent(RIGIDBODY_2D);
}

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _missingComponentError(entity, member) {
  return _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.controller." + member +
    " but has no Character Controller component. " +
    "Add one in the Inspector (Add Component → Character Controller) and pick a Movement Type."
  ), "missing-component");
}

function _unknownMemberError(entity, controllerType, member) {
  return _tag(new Error(
    "this.controller." + member + " does not exist. Check the spelling — " +
    "see the autocomplete list for this.controller on a " + controllerType + " controller."
  ), "unknown-api");
}

function _unsupportedError(controllerType, member, why) {
  return _tag(new Error(
    "controller." + member + " is not available on a " + controllerType +
    " controller. " + why
  ), "unsupported-body-type");
}

const JUMP_WHY = "Only Character Controller and Platformer movement types can jump — change the Movement Type in the Inspector if this object needs to jump.";
const CAR_ONLY_WHY = "This is a Car-only tunable — change the Movement Type to Car in the Inspector to use it.";
const FOLLOW_ONLY_WHY = "This is a Follow-only tunable — change the Movement Type to Follow in the Inspector to use it.";
const PATROL_ONLY_WHY = "This is a Patrol-only tunable — change the Movement Type to Patrol in the Inspector to use it.";
const WALK_ONLY_WHY = "This tunable only applies to Character Controller, Platformer, or Top-Down movement types.";
const FREE_WHY = "Free means fully script-driven — ControllerSystem does not run for it at all (see CharacterController.js), so there is nothing for this.controller to report or trigger here. Drive this.rigidbody directly instead.";

/** Shared "am I currently grounded" read, used by both Character
 * Controller and Platformer — populated by PhysicsWorld.js's sweep
 * (Kinematic) or ControllerSystem.js's own check (Dynamic). */
function _isGrounded(entity) {
  var r = _rb(entity);
  return r ? !!r.grounded : false;
}

/** Shared contact-state reads (isOnCeiling/isOnWall/isOnSlope/
 * groundAngle) — mirror the same fields already exposed via
 * this.rigidbody (see RigidbodyAPI.js), added here too so a script
 * driving movement through this.controller doesn't also need to reach
 * into this.rigidbody just to check what surface it's touching. Real
 * per-frame values on Kinematic bodies (from PhysicsWorld.js's
 * character-controller sweep); always false/0 on Dynamic bodies, which
 * have no per-axis contact tracking (see ControllerSystem.js's
 * _applyDynamic doc comment) — Rapier's own solver handles those
 * contacts directly instead. */
function _isOnCeiling(entity) {
  var r = _rb(entity);
  return r ? !!r.isOnCeiling : false;
}
function _isOnWall(entity) {
  var r = _rb(entity);
  return r ? !!r.isOnWall : false;
}
function _isOnSlope(entity) {
  var r = _rb(entity);
  return r ? !!r.isOnSlope : false;
}
function _groundAngle(entity) {
  var r = _rb(entity);
  return r ? r.groundAngle : 0;
}

/** Shared simulateJump() — sets the one-shot request flag
 * ControllerSystem.js consumes on its next update, exactly like a
 * literal Space keypress would. No-ops (does not throw) if canJump is
 * off or maxJumps is already used up THIS frame — same as a real
 * keypress would silently do nothing in that case; the point of
 * simulateJump() is "ask for a jump", not "force one no matter what". */
function _simulateJump(entity) {
  var c = _cc(entity);
  if (c) c.requestJump = true;
}

/** Shared simulateMove(x, y) — sets the one-shot requestMoveX/Y axis
 * request ControllerSystem.js consumes on its very next update and
 * then clears back to null, exactly like a literal held arrow key
 * would for that one frame. x and y are each clamped to -1..1 (same
 * range the keyboard's own (right?1:0)-(left?1:0) read produces) so
 * this.controller.simulateMove(-1, 0) means "move left at full speed"
 * regardless of what value is passed in.
 *
 * ONE-SHOT, NOT A TOGGLE: because it is consumed and reset every
 * frame, call it from onUpdate() every frame you want movement to
 * continue (this.controller.simulateMove(-1, 0)) — calling it once
 * from onStart() only moves the character for a single physics step,
 * same as tapping a key for one frame instead of holding it down.
 *
 * y defaults to 0 (no vertical request) so this.controller.
 * simulateMove(-1) alone reads as "move left, don't touch vertical" —
 * matching the common "simulate left/right" use case without forcing
 * every caller to also think about the Y axis. Pass y explicitly for
 * Top-Down movement or a gravity-off Character Controller's vertical
 * axis.
 */
function _simulateMove(entity, x, y) {
  var c = _cc(entity);
  if (!c) return;
  var clampedX = Math.max(-1, Math.min(1, x));
  c.requestMoveX = clampedX;
  if (y !== undefined) {
    c.requestMoveY = Math.max(-1, Math.min(1, y));
  }
}

/** Car-only: simulateDrive(throttle, steer) — sets one-shot car input
 * consumed by ControllerSystem.js's _applyCar. throttle and steer are
 * independent axes, matching the built-in keyboard controls: throttle
 * controls acceleration/braking and steer controls steering. Fractional
 * values are preserved for analog joysticks.
 * When useDefaultInput is true, the scripted axes are combined with
 * WASD/Arrow input; when false, they are the only car input source.
 *
 * throttle: -1..1 (1 = full accelerate, -1 = full brake/reverse, 0 =
 * coast/natural decel — matching Up/Down or W/S). steer: -1..1 (1 =
 * full right, -1 = full left, 0 = straight — matching Right/Left or
 * A/D). Both clamped to -1..1. Unlike the keyboard (which only ever
 * produces -1/0/1), fractional values are honored — e.g. a joystick
 * or analog input can pass simulateDrive(0.4, -0.7) for partial
 * throttle and steer.
 *
 * ONE-SHOT, NOT A TOGGLE: call it from onUpdate() every frame you
 * want the car to keep moving/turning — calling it once from
 * onStart() only drives the car for a single physics step, same as
 * tapping a key for one frame instead of holding it down.
 */
function _simulateDrive(entity, throttle, steer) {
  var c = _cc(entity);
  if (!c) return;
  c.requestThrottle = Math.max(-1, Math.min(1, Number(throttle) || 0));
  if (steer !== undefined) {
    c.requestSteer = Math.max(-1, Math.min(1, Number(steer) || 0));
  }
}

/** Car-only joystick mode: x/y are the actual joystick direction. The
 * controller derives magnitude and target heading from them, so a script
 * can pass this.joystick.x/y directly and get directional arcade-car
 * steering rather than treating the pair as a 2D movement vector.
 */
function _simulateDriveJoystick(entity, x, y) {
  var c = _cc(entity);
  if (!c) return;
  c.requestJoystickX = Math.max(-1, Math.min(1, Number(x) || 0));
  c.requestJoystickY = Math.max(-1, Math.min(1, Number(y) || 0));
}

/** Car-only "drive there yourself" autopilot: x/y are a world-space
 * point, not throttle/steer or a joystick direction. ControllerSystem's
 * _applyCar (via _resolveDriveTowardInput) works out the throttle and
 * steering itself every frame — accelerating while pointed roughly the
 * right way, steering toward the target, easing off / braking as it
 * approaches, and reversing instead of turning around when the point is
 * effectively behind the car — then feeds that into the SAME
 * accelerate/brake/steer/drift math every other Car input source uses,
 * so maxSpeed/acceleration/brakeForce/turnSpeed/driftFactor (Inspector
 * or script) all shape it automatically. This drives the car like a
 * chase-car NPC toward a point: no pathfinding/obstacle-avoidance — for
 * that, add a Nav Agent 2D component and use this.navDriveToward(x, y)
 * instead (see NavAPI-adjacent docs in ScriptAPI.js), which paths there
 * step by step and calls this same steering model per waypoint.
 *
 * ONE-SHOT, NOT A TOGGLE: call it from onUpdate() every frame you want
 * the car still heading toward (x, y) — calling it once from onStart()
 * only steers the car for a single physics step, same as every other
 * simulateDrive*() method on this API.
 */
function _simulateDriveToward(entity, x, y) {
  var c = _cc(entity);
  if (!c) return;
  c.requestDriveTowardX = Number(x) || 0;
  c.requestDriveTowardY = Number(y) || 0;
}

/** Patrol-only: flipDirection() — sets the one-shot requestFlip flag
 * ControllerSystem.js's _applyPatrol consumes on its very next update
 * and then clears back to false. Forces an immediate turn regardless
 * of useDefaultInput: works the same whether Patrol is auto-walking
 * (wall/distance auto-turn active) or being driven manually via
 * simulateMove — e.g. "turn around the instant the player is spotted"
 * without having to give up the built-in wall/distance auto-turn to
 * get it. ONE-SHOT: call it once per turn you want (e.g. from the
 * frame a condition becomes true), not every frame — calling it every
 * frame would flip the direction every frame, which is the shaking
 * bug this same file's ControllerSystem.js fix was written to avoid.
 */
function _flipDirection(entity) {
  var c = _cc(entity);
  if (c) c.requestFlip = true;
}

/** WALK family: Character Controller, Platformer, Top-Down. All three
 * share moveSpeed/acceleration/airControl/useGravity/gravityScale/
 * useDefaultInput; jump-specific members are added only for
 * Character/Platformer below. */
function _createWalkAPI(entity, canJump) {
  var api = {
    get controllerType() { var c = _cc(entity); return c ? c.controllerType : null; },

    get moveSpeed() { var c = _cc(entity); return c ? c.moveSpeed : 0; },
    set moveSpeed(v) { var c = _cc(entity); if (c) c.moveSpeed = v; },
    get acceleration() { var c = _cc(entity); return c ? c.acceleration : 0; },
    set acceleration(v) { var c = _cc(entity); if (c) c.acceleration = v; },
    get airControl() { var c = _cc(entity); return c ? c.airControl : 0; },
    set airControl(v) { var c = _cc(entity); if (c) c.airControl = v; },
    get useGravity() { var c = _cc(entity); return c ? c.useGravity : false; },
    set useGravity(v) { var c = _cc(entity); if (c) c.useGravity = !!v; },
    // gravityScale has no effect on Top-Down (never uses gravity
    // regardless of this value — see ControllerSystem.js's
    // _applyKinematic), but is exposed here too for the same
    // API-shape-consistency reason useGravity already is above.
    get gravityScale() { var c = _cc(entity); return c ? c.gravityScale : 1; },
    set gravityScale(v) { var c = _cc(entity); if (c) c.gravityScale = v; },
    get useDefaultInput() { var c = _cc(entity); return c ? c.useDefaultInput : false; },
    set useDefaultInput(v) { var c = _cc(entity); if (c) c.useDefaultInput = !!v; },

    // Available on all three walk types (Character Controller,
    // Platformer, Top-Down) — see _simulateMove()'s doc comment above
    // for the full one-shot-per-frame contract.
    simulateMove: function (x, y) { _simulateMove(entity, x, y); },
  };
  // Contact-state readers: available on ALL walk types (isGrounded
  // included — NOT gated behind canJump the way jump-specific members
  // below are) since touching ground, a wall, a ceiling, or a slope is
  // meaningful even for a controller that can't jump — e.g. a Top-Down
  // controller bumping a wall, or checking isGrounded to decide whether
  // it's safe to walk off a ledge.
  Object.defineProperties(api, {
    isGrounded: {
      get: function () { return _isGrounded(entity); },
      enumerable: true,
    },
    isOnCeiling: {
      get: function () { return _isOnCeiling(entity); },
      enumerable: true,
    },
    isOnWall: {
      get: function () { return _isOnWall(entity); },
      enumerable: true,
    },
    isOnSlope: {
      get: function () { return _isOnSlope(entity); },
      enumerable: true,
    },
    groundAngle: {
      get: function () { return _groundAngle(entity); },
      enumerable: true,
    },
  });
  if (canJump) {
    Object.defineProperties(api, {
      canJump: {
        get: function () { var c = _cc(entity); return c ? c.canJump : false; },
        set: function (v) { var c = _cc(entity); if (c) c.canJump = !!v; },
        enumerable: true,
      },
      jumpForce: {
        get: function () { var c = _cc(entity); return c ? c.jumpForce : 0; },
        set: function (v) { var c = _cc(entity); if (c) c.jumpForce = v; },
        enumerable: true,
      },
      maxJumps: {
        get: function () { var c = _cc(entity); return c ? c.maxJumps : 0; },
        set: function (v) { var c = _cc(entity); if (c) c.maxJumps = v; },
        enumerable: true,
      },
      simulateJump: {
        value: function () { _simulateJump(entity); },
        enumerable: true,
      },
    });
  }
  return api;
}

/** CAR: throttle/brake + steer tunables. `acceleration` here is
 * deliberately the SAME property name as the walk family's
 * acceleration (matches the "controller.acceleration" spelling asked
 * for), but reads/writes CharacterController.carAcceleration — the
 * component's own Car-specific field — since a Car has no separate
 * "acceleration" field of its own; carAcceleration IS its acceleration. */
function _createCarAPI(entity) {
  return {
    get controllerType() { var c = _cc(entity); return c ? c.controllerType : null; },

    get maxSpeed() { var c = _cc(entity); return c ? c.maxSpeed : 0; },
    set maxSpeed(v) { var c = _cc(entity); if (c) c.maxSpeed = v; },
    get acceleration() { var c = _cc(entity); return c ? c.carAcceleration : 0; },
    set acceleration(v) { var c = _cc(entity); if (c) c.carAcceleration = v; },
    get brakeForce() { var c = _cc(entity); return c ? c.brakeForce : 0; },
    set brakeForce(v) { var c = _cc(entity); if (c) c.brakeForce = v; },
    get turnSpeed() { var c = _cc(entity); return c ? c.turnSpeed : 0; },
    set turnSpeed(v) { var c = _cc(entity); if (c) c.turnSpeed = v; },
    get driftFactor() { var c = _cc(entity); return c ? c.driftFactor : 0; },
    set driftFactor(v) { var c = _cc(entity); if (c) c.driftFactor = v; },
    get driveTowardArriveDistance() { var c = _cc(entity); return c ? c.driveTowardArriveDistance : 0; },
    set driveTowardArriveDistance(v) { var c = _cc(entity); if (c) c.driveTowardArriveDistance = v; },
    get useDefaultInput() { var c = _cc(entity); return c ? c.useDefaultInput : false; },
    set useDefaultInput(v) { var c = _cc(entity); if (c) c.useDefaultInput = !!v; },
    simulateDrive: function (throttle, steer) { _simulateDrive(entity, throttle, steer); },
    simulateDriveJoystick: function (x, y) { _simulateDriveJoystick(entity, x, y); },
    simulateDriveToward: function (x, y) { _simulateDriveToward(entity, x, y); },
  };
}

/** Patrol's authoritative "which way is it currently walking" read —
 * +1 = right, -1 = left. Reads controller._patrolFacingDirection,
 * written every update by ControllerSystem.js's _applyPatrol from its
 * own state.dir (see CharacterController.js's doc comment on that
 * field for why this is NOT derived from velocity: velocity lags
 * state.dir by controller.acceleration's lerp, so right at the moment
 * of a turn it can still read near-zero or even the OLD direction's
 * sign for several frames — using it here would flip a script's
 * sprite late or make it flicker instead of turning cleanly with the
 * entity). Defaults to 1 (right) if the controller hasn't updated yet
 * (e.g. read on the very first frame before _applyPatrol has run).
 * Read-only: the engine owns when to turn (wall, ledge, or
 * patrolDistance — see ControllerSystem.js's _applyPatrol), same
 * reasoning as isGrounded being read-only. */
function _facingDirection(entity) {
  var c = _cc(entity);
  if (!c) return 1;
  var d = Number(c._patrolFacingDirection);
  return d < 0 ? -1 : 1;
}

/** PATROL: by default (useDefaultInput = true) walks back and forth
 * automatically — turns at an obstacle or after patrolDistance px,
 * whichever comes first, no jump. Turn useDefaultInput off to take
 * over manually via simulateMove(x, y) instead (see ControllerSystem
 * .js's _applyPatrol for exactly what turns off when you do —
 * auto-walk AND auto-turn both stop). moveSpeed/acceleration/
 * useDefaultInput/simulateMove are shared with the walk family
 * (reused, not duplicated — see CharacterController.js's doc comment
 * on patrolDistance); patrolDistance is Patrol's own unique tunable.
 * flipDirection() forces an immediate turn on demand in EITHER mode —
 * the one thing simulateMove alone can't do while useDefaultInput is
 * still on, since auto mode ignores simulateMove entirely. Contact
 * readers are exposed too since a script may want to react to a turn
 * (e.g. play a "Turn" animation) even when auto-walk is doing the
 * turning itself.
 *
 * patrolMode (PatrolMode.PLATFORMER default, or PatrolMode.TOP_DOWN)
 * picks Patrol's own movement scheme — Platformer is the original
 * behavior (gravity on, walks X only). Top-Down (no gravity) also
 * needs patrolAxis (PatrolAxis.HORIZONTAL default, or .VERTICAL) to
 * say which single axis it walks along — in Vertical mode, simulateMove's
 * y argument (not x) becomes the driving/facing axis, since Patrol
 * only ever moves along one axis at a time (see CharacterController
 * .js's PatrolMode/PatrolAxis doc comments and ControllerSystem.js's
 * _applyPatrol for the full behavior). */
function _createPatrolAPI(entity) {
  var api = {
    get controllerType() { var c = _cc(entity); return c ? c.controllerType : null; },

    get moveSpeed() { var c = _cc(entity); return c ? c.moveSpeed : 0; },
    set moveSpeed(v) { var c = _cc(entity); if (c) c.moveSpeed = v; },
    get acceleration() { var c = _cc(entity); return c ? c.acceleration : 0; },
    set acceleration(v) { var c = _cc(entity); if (c) c.acceleration = v; },
    get patrolDistance() { var c = _cc(entity); return c ? c.patrolDistance : 0; },
    set patrolDistance(v) { var c = _cc(entity); if (c) c.patrolDistance = v; },
    get patrolMode() { var c = _cc(entity); return c ? c.patrolMode : PatrolMode.PLATFORMER; },
    set patrolMode(v) { var c = _cc(entity); if (c) c.patrolMode = v; },
    get patrolAxis() { var c = _cc(entity); return c ? c.patrolAxis : PatrolAxis.HORIZONTAL; },
    set patrolAxis(v) { var c = _cc(entity); if (c) c.patrolAxis = v; },
    get useDefaultInput() { var c = _cc(entity); return c ? c.useDefaultInput : true; },
    set useDefaultInput(v) { var c = _cc(entity); if (c) c.useDefaultInput = !!v; },
    simulateMove: function (x, y) { _simulateMove(entity, x, y); },
    flipDirection: function () { _flipDirection(entity); },
  };
  Object.defineProperties(api, {
    isOnWall: { get: function () { return _isOnWall(entity); }, enumerable: true },
    isOnCeiling: { get: function () { return _isOnCeiling(entity); }, enumerable: true },
    isOnSlope: { get: function () { return _isOnSlope(entity); }, enumerable: true },
    groundAngle: { get: function () { return _groundAngle(entity); }, enumerable: true },
    isGrounded: { get: function () { return _isGrounded(entity); }, enumerable: true },
    facingDirection: { get: function () { return _facingDirection(entity); }, enumerable: true },
  });
  return api;
}

/** FOLLOW: pursuit tunables only — no movement/jump concept. */
function _createFollowAPI(entity) {
  return {
    get controllerType() { var c = _cc(entity); return c ? c.controllerType : null; },

    get targetName() { var c = _cc(entity); return c ? c.targetName : ""; },
    set targetName(v) { var c = _cc(entity); if (c) c.targetName = v; },
    get followSpeed() { var c = _cc(entity); return c ? c.followSpeed : 0; },
    set followSpeed(v) { var c = _cc(entity); if (c) c.followSpeed = v; },
    get followDistance() { var c = _cc(entity); return c ? c.followDistance : 0; },
    set followDistance(v) { var c = _cc(entity); if (c) c.followDistance = v; },
  };
}

/** FREE: only `controllerType` is readable — everything else throws
 * (see FREE_WHY) since ControllerSystem does nothing for this type. */
function _createFreeAPI(entity) {
  return {
    get controllerType() { var c = _cc(entity); return c ? c.controllerType : null; },
  };
}

// Every member name that exists on AT LEAST ONE controller type. Used
// by the Proxy to tell "this doesn't exist anywhere" (unknown-api / a
// typo) apart from "this exists, but not for the CURRENT controller
// type" (unsupported-body-type, reusing RigidbodyAPI's `kind` value
// since it's the same concept — "wrong variant of this component").
const ALL_KNOWN_MEMBERS = new Set([
  "controllerType",
  "moveSpeed", "acceleration", "airControl", "useGravity", "gravityScale", "useDefaultInput", "simulateMove",
  "isGrounded", "isOnCeiling", "isOnWall", "isOnSlope", "groundAngle",
  "canJump", "jumpForce", "maxJumps", "simulateJump",
  "maxSpeed", "brakeForce", "turnSpeed", "driftFactor", "driveTowardArriveDistance", "simulateDrive", "simulateDriveJoystick", "simulateDriveToward",
  "targetName", "followSpeed", "followDistance",
  "patrolDistance", "patrolMode", "patrolAxis", "facingDirection", "flipDirection",
]);

// Which "why" explanation to show for each unsupported member, keyed
// by member name — covers every member NOT valid on every type.
// NOTE: isGrounded/isOnCeiling/isOnWall/isOnSlope/groundAngle are valid
// on BOTH the walk family and Patrol, so this only needs to cover the
// case where neither of those is the current type (Car/Follow/Free) —
// WALK_ONLY_WHY is close enough there since Patrol has its own tunables
// covered separately, and the message still correctly points the user
// at a movement type that supports it.
function _whyFor(member) {
  if (member === "canJump" || member === "jumpForce" || member === "maxJumps" ||
      member === "simulateJump") return JUMP_WHY;
  if (member === "maxSpeed" || member === "brakeForce" || member === "turnSpeed" || member === "driftFactor" || member === "driveTowardArriveDistance" || member === "simulateDrive" || member === "simulateDriveJoystick" || member === "simulateDriveToward") return CAR_ONLY_WHY;
  if (member === "targetName" || member === "followSpeed" || member === "followDistance") return FOLLOW_ONLY_WHY;
  if (member === "patrolDistance" || member === "patrolMode" || member === "patrolAxis" || member === "facingDirection" || member === "flipDirection") return PATROL_ONLY_WHY;
  if (member === "isGrounded" || member === "moveSpeed" || member === "airControl" || member === "useGravity" || member === "gravityScale" || member === "simulateMove" ||
      member === "isOnCeiling" || member === "isOnWall" || member === "isOnSlope" || member === "groundAngle") return WALK_ONLY_WHY;
  return "This tunable does not apply to the current Movement Type.";
}

/**
 * Builds the `this.controller` object for a given entity, LIVE-checking
 * the entity's current CharacterController.controllerType on every
 * access (via a Proxy) so the exposed API always matches the Inspector
 * setting — same pattern as createRigidbodyAPI's body-type awareness.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createControllerAPI(entity) {
  var apis = {}; // built lazily, one object per controller type, cached

  function _current() {
    var c = _cc(entity);
    var type = c ? c.controllerType : ControllerType.FREE;
    if (!apis[type]) {
      if (type === ControllerType.CHARACTER) apis[type] = _createWalkAPI(entity, true);
      else if (type === ControllerType.PLATFORMER) apis[type] = _createWalkAPI(entity, true);
      else if (type === ControllerType.TOP_DOWN) apis[type] = _createWalkAPI(entity, false);
      else if (type === ControllerType.CAR) apis[type] = _createCarAPI(entity);
      else if (type === ControllerType.FOLLOW) apis[type] = _createFollowAPI(entity);
      else if (type === ControllerType.PATROL) apis[type] = _createPatrolAPI(entity);
      else apis[type] = _createFreeAPI(entity);
    }
    return apis[type];
  }

  return new Proxy(
    {},
    {
      get: function (_target, prop) {
        if (typeof prop === "symbol") return undefined;
        var key = String(prop);
        if (key === "then") return undefined; // avoid Promise-like duck-typing false positives
        if (!_cc(entity)) throw _missingComponentError(entity, key);

        var current = _current();
        if (key in current) {
          var value = current[key];
          return typeof value === "function" ? value.bind(current) : value;
        }
        var type = current.controllerType || "?";
        if (type === ControllerType.FREE && key !== "controllerType" && ALL_KNOWN_MEMBERS.has(key)) {
          throw _unsupportedError(type, key, FREE_WHY);
        }
        if (ALL_KNOWN_MEMBERS.has(key)) {
          throw _unsupportedError(type, key, _whyFor(key));
        }
        throw _unknownMemberError(entity, type, key);
      },
      set: function (_target, prop, value) {
        var key = String(prop);
        if (!_cc(entity)) throw _missingComponentError(entity, key);
        var current = _current();
        if (key in current) {
          var descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (descriptor && !descriptor.set && descriptor.get) {
            // Read-only member for this type (e.g. isGrounded) — exists
            // and is readable, just can't be assigned to. Distinct
            // message from _unsupportedError (which means "doesn't
            // exist for this type AT ALL") so this doesn't read as a
            // contradiction ("not available... but also read-only?").
            throw _tag(new Error(
              "controller." + key + " is read-only — it reflects the controller's real state " +
              "and can't be set directly." +
              (key === "isGrounded" ? " Move the entity via this.rigidbody or this.controller.simulateJump() instead." : "")
            ), "unsupported-body-type");
          }
          current[key] = value;
          return true;
        }
        var type = current.controllerType || "?";
        if (ALL_KNOWN_MEMBERS.has(key)) {
          throw _unsupportedError(type, key, _whyFor(key));
        }
        throw _unknownMemberError(entity, type, key);
      },
      has: function (_target, prop) {
        var key = String(prop);
        return _cc(entity) ? key in _current() : ALL_KNOWN_MEMBERS.has(key);
      },
    }
  );
}
