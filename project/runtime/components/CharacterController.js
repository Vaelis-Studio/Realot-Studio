/**
 * runtime/components/CharacterController.js
 *
 * Plain data describing WHICH movement scheme an entity uses (Character
 * Controller / Platformer / Top-Down / Car / Follow / Patrol / Free) and that
 * scheme's tunables (move speed, jump force, acceleration, etc). This
 * is the "movement type" (a.k.a. controller type) the Inspector's Add
 * Component menu offers, per the same Unity-style convention
 * Rigidbody2D/Collider2D already follow (RULES.txt section 4: plain
 * data only, no behavior).
 *
 * IMPORTANT: this component does NOT implement its own physics. All
 * actual force/velocity integration and collision detection still goes
 * through Rapier via Rigidbody2D + runtime/physics/PhysicsWorld.js —
 * see runtime/systems/ControllerSystem.js, which reads this component
 * each frame and only ever writes into Rigidbody2D's velocity fields
 * (the same fields the Inspector's Kinematic velocity sliders already
 * write to), never touching Rapier directly. An entity needs a
 * Rigidbody2D (Kinematic works best) for this component to have any
 * physical effect — CharacterController describes intent/tuning,
 * Rigidbody2D + Rapier still do the actual moving and colliding.
 *
 * RUNTIME-ONLY FILE.
 */

export const CHARACTER_CONTROLLER = "CharacterController";

/**
 * ControllerType is presented to the user as "Movement Type" in the Add
 * Component menu and as "Controller Type" inside this component's own
 * settings (matching the user-facing names requested) — same enum,
 * different label depending on where in the UI it's shown.
 */
export const ControllerType = Object.freeze({
  CHARACTER: "Character Controller", // classic Unity-style CharacterController: 4/8-way move, optional gravity
  PLATFORMER: "Platformer", // side-scroller: horizontal move + jump, gravity always on
  TOP_DOWN: "Top-Down", // 8-directional move, no gravity, no jump
  CAR: "Car", // arcade-style car: throttle/brake + steer, moves along heading
  FOLLOW: "Follow", // AI pursuit: homes toward a named target entity at set speed
  PATROL: "Patrol", // AI ground patrol: walks back and forth, auto-turning at a wall or after patrolDistance px, whichever comes first
  FREE: "Free", // no built-in input mapping — script-driven only, tunables still available for scripts to read
});

/**
 * Patrol's own movement scheme — how it patrols, borrowing the same
 * two ground-rules Platformer/Top-Down already use elsewhere in this
 * file, rather than inventing a third. Platformer means gravity is
 * always on and it turns/walks along X only (the original, and still
 * default, Patrol behavior). TopDown means no gravity and it walks
 * along whichever single axis patrolAxis picks (below) — useful for a
 * guard pacing a corridor in a top-down room, or bobbing up/down along
 * a vertical stretch, without gravity pulling it down.
 */
export const PatrolMode = Object.freeze({
  PLATFORMER: "Platformer",
  TOP_DOWN: "Top-Down",
});

/**
 * Which single axis a TopDown-mode Patrol walks along. Ignored in
 * Platformer mode (always Horizontal there, same as every other
 * ground-based controller in this file). HORIZONTAL reuses isOnWall as
 * its turn-trigger obstacle check (a wall is just a contact whose
 * normal is roughly horizontal — see PhysicsWorld.js's _readContactState,
 * which is gravity-independent); VERTICAL reuses the SAME kind of
 * contact but on the other axis — PhysicsWorld's `grounded`/`isOnCeiling`
 * flags are really just "hit something below/above," gravity-independent
 * too, so they double as the vertical-axis obstacle check here with no
 * gravity ever applied.
 */
export const PatrolAxis = Object.freeze({
  HORIZONTAL: "Horizontal",
  VERTICAL: "Vertical",
});

export class CharacterController {
  constructor({
    controllerType = ControllerType.CHARACTER,

    // Movement (Character / Platformer / Top-Down)
    moveSpeed = 200, // px/s
    acceleration = 20, // how fast velocity approaches target (higher = snappier)
    airControl = 0.5, // 0-1 multiplier on acceleration while airborne (Platformer only)

    // Jump (Character Controller + Platformer)
    canJump = true,
    jumpForce = 420, // px/s upward velocity applied on jump
    maxJumps = 1, // 1 = no double jump, 2 = double jump, etc.

    // Gravity (Character Controller can toggle it off for e.g. a floating
    // controller; Platformer always uses gravity; Top-Down never does)
    useGravity = true,

    // Multiplier on gravity's strength for Character Controller/Platformer
    // (same name/semantics as Rigidbody2D.gravityScale on a Dynamic body —
    // 1 = normal, 2 = falls twice as fast, 0.5 = floaty/moon-gravity, 0 =
    // no downward pull at all while still respecting useGravity's on/off
    // switch). Rigidbody2D's own gravityScale already covers Dynamic
    // bodies via Rapier's real physics; this field is its Kinematic-body
    // counterpart, since a Kinematic controller simulates its own gravity
    // in ControllerSystem.js's _applyKinematic rather than letting Rapier
    // apply any (see that method's own doc comment on why: "this system
    // owns velocity outright ... has to simulate its own gravity"). Has
    // no effect on Top-Down or Free (no gravity concept), or Dynamic
    // bodies (use Rigidbody2D.gravityScale for those instead).
    gravityScale = 1,

    // Input. For Character/Platformer/Top-Down and Car, this controls the
    // built-in keyboard while script APIs can contribute in the same frame.
    // With useDefaultInput=true, default and scripted input are combined and
    // clamped to [-1,1]. With false, the default keyboard is disabled and the
    // script/joystick channel is the only movement source. Patrol uses the
    // same relationship for its automatic walk direction.
    // For Patrol
    // specifically it instead gates Patrol's own built-in back-and-
    // forth auto-walk (see ControllerSystem.js's _applyPatrol) — ON
    // (default) walks back and forth with no input needed; turn OFF
    // to drive it manually from a script via
    // this.controller.simulateMove(x, y) (ControllerAPI.js), the same
    // requestMoveX/Y one-shot channel the walk family already uses.
    useDefaultInput = true, // WASD/Arrows (+ Space to jump) wired automatically; Patrol: auto-walk on/off

    // Car-specific (Car controller only)
    maxSpeed = 350, // top forward speed in px/s
    carAcceleration = 200, // how fast the car speeds up (px/s^2)
    brakeForce = 400, // how fast it brakes / goes into reverse (px/s^2)
    turnSpeed = 150, // max turn rate in deg/s (at full speed; scales down at lower speeds)
    driftFactor = 0.92, // 0-1: how much lateral velocity is retained (higher = more slide)
    driveTowardArriveDistance = 12, // px from the target that counts as "arrived" for
                                     // this.controller.simulateDriveToward(x, y) and
                                     // this.navDriveToward(x, y) — inside this radius the
                                     // car coasts/brakes to a stop instead of hunting for an
                                     // exact heading to a point right under it.

    // Follow-specific (Follow controller only)
    targetName = "", // name of the entity to pursue
    followSpeed = 150, // pursuit speed in px/s
    followDistance = 5, // stop when within this many pixels of the target

    // Patrol-specific (Patrol controller only). Patrol reuses moveSpeed/
    // acceleration from the Movement block above for its walk speed —
    // this is its only unique tunable. Turns around at a wall OR after
    // walking this many px, whichever comes first (see ControllerSystem
    // .js's _applyPatrol). Facing direction and distance walked since
    // the last turn are runtime-only state (not authored data), tracked
    // in ControllerSystem._patrolState, the same way
    // _verticalVelocity/_jumpsUsed/_carSpeed are — see that file.
    patrolDistance = 150, // px to walk before auto-turning, if nothing else turns it first

    // Patrol's own movement scheme — see PatrolMode above. Defaults to
    // Platformer so every existing Patrol (authored before this field
    // existed) keeps its original gravity-on, X-only behavior unchanged.
    patrolMode = PatrolMode.PLATFORMER,

    // Which axis a TopDown-mode Patrol walks along — see PatrolAxis
    // above. Ignored entirely in Platformer mode (always horizontal
    // there).
    patrolAxis = PatrolAxis.HORIZONTAL,

    // Set (transiently, for one ControllerSystem update) by
    // this.controller.simulateJump() (see scripting/components/
    // ControllerAPI.js) to trigger a jump from script logic — consumed
    // and reset to false by ControllerSystem.js right after reading it,
    // the same one-shot request pattern Rigidbody2D's pendingForceX/Y
    // uses. Plain data (RULES.txt section 4), not a function/callback.
    requestJump = false,

    // Set (transiently, for one ControllerSystem update) by
    // this.controller.simulateMove(x, y) (see scripting/components/
    // ControllerAPI.js) as a script/joystick movement contribution. When
    // useDefaultInput=true it is added to the keyboard axis; when false it
    // is the only movement source. -1..1 per axis, with analog values kept.
    // Consumed and reset to null by ControllerSystem.js right after
    // reading it each update — a one-shot per-frame request, same
    // pattern as requestJump above, NOT a standing value a script must
    // remember to clear (see simulateMove()'s own doc comment in
    // ControllerAPI.js for why it must be called every frame the
    // script wants movement to continue, exactly like a held key).
    requestMoveX = null,
    requestMoveY = null,

    // Set (transiently, for one ControllerSystem update) by
    // this.controller.simulateDrive(throttle, steer) (see scripting/
    // components/ControllerAPI.js), Car-only. Drives Car exactly like
    // requestMoveX/Y drives the walk family — a one-shot per-frame
    // request consumed and reset to null by ControllerSystem.js's
    // _applyCar right after reading it. throttle: -1..1 (1 = full
    // accelerate, -1 = full brake/reverse, matching Up/Down). steer:
    // -1..1 (1 = full right, -1 = full left, matching Right/Left).
    // Only takes effect while useDefaultInput is off; call it every
    // frame you want the car driven, exactly like holding a key —
    // see simulateDrive()'s own doc comment in ControllerAPI.js.
    requestThrottle = null,
    requestSteer = null,

    // Set (transiently, for one ControllerSystem update) by
    // this.controller.simulateDriveJoystick(x, y) (see scripting/
    // components/ControllerAPI.js), Car-only. Unlike simulateDrive(), this
    // is a true twin-stick-style directional car control: x/y describe the
    // joystick direction, magnitude controls acceleration, and the car
    // smoothly turns toward the joystick direction. Consumed and reset to
    // null by ControllerSystem.js after each update.
    requestJoystickX = null,
    requestJoystickY = null,

    // Set (transiently, for one ControllerSystem update) by
    // this.controller.simulateDriveToward(x, y) (see scripting/
    // components/ControllerAPI.js), Car-only. "Autopilot" car input: unlike
    // simulateDrive()/simulateDriveJoystick() (which take throttle/steer or
    // a joystick direction), this takes a world-space POINT and
    // ControllerSystem._applyCar works out the throttle/steer itself every
    // frame — deciding whether to drive forward or reverse toward it
    // (whichever needs less turning, so the car doesn't drive there
    // backwards just because that's the shorter turn) and easing off the
    // throttle as it nears the point so it doesn't overshoot and loop back.
    // Still goes through the exact same accelerate/brake/steer/drift math
    // as every other Car input source, so maxSpeed/carAcceleration/
    // brakeForce/turnSpeed/driftFactor from the Inspector (or a script) all
    // apply automatically — this is a steering target, not a separate
    // movement mode. One-shot per-frame request, same consumed-and-reset
    // pattern as requestThrottle/requestSteer above — call it every frame
    // you want the car still heading there.
    requestDriveTowardX = null,
    requestDriveTowardY = null,

    // Set (transiently, for one ControllerSystem update) by
    // this.controller.flipDirection() (see scripting/components/
    // ControllerAPI.js), Patrol-only. Forces an immediate turn on the
    // next update regardless of useDefaultInput — works whether Patrol
    // is auto-walking or being driven manually via simulateMove, since
    // it's read and cleared before either mode's logic runs (see
    // _applyPatrol). One-shot request, same pattern as requestJump/
    // requestMoveX/Y above.
    requestFlip = false,
  } = {}) {
    this.controllerType = controllerType;
    this.moveSpeed = moveSpeed;
    this.acceleration = acceleration;
    this.airControl = airControl;

    this.canJump = canJump;
    this.jumpForce = jumpForce;
    this.maxJumps = maxJumps;

    this.useGravity = useGravity;
    this.gravityScale = gravityScale;

    this.useDefaultInput = useDefaultInput;

    this.maxSpeed = maxSpeed;
    this.carAcceleration = carAcceleration;
    this.brakeForce = brakeForce;
    this.turnSpeed = turnSpeed;
    this.driftFactor = driftFactor;
    this.driveTowardArriveDistance = driveTowardArriveDistance;

    this.targetName = targetName;
    this.followSpeed = followSpeed;
    this.followDistance = followDistance;

    this.patrolDistance = patrolDistance;
    this.patrolMode = patrolMode;
    this.patrolAxis = patrolAxis;

    this.requestJump = requestJump;
    this.requestMoveX = requestMoveX;
    this.requestMoveY = requestMoveY;
    this.requestThrottle = requestThrottle;
    this.requestSteer = requestSteer;
    this.requestJoystickX = requestJoystickX;
    this.requestJoystickY = requestJoystickY;
    this.requestDriveTowardX = requestDriveTowardX;
    this.requestDriveTowardY = requestDriveTowardY;
    this.requestFlip = requestFlip;

    // Patrol's authoritative facing direction (+1 right, -1 left),
    // written every update by ControllerSystem.js's _applyPatrol from
    // its own state.dir — the same runtime-only, engine-owned mirror
    // pattern as Rigidbody2D's isOnWall/grounded (written by the
    // physics/controller layer, read-only from scripts via
    // this.controller.facingDirection in ControllerAPI.js). NOT
    // derived from velocity: velocity is a LAGGING, smoothed
    // consequence of state.dir (it lerps toward the new direction via
    // controller.acceleration after a turn), so right at the moment of
    // a wall/distance/scripted turn, velocity can still read close to
    // zero or even the OLD direction's sign for several frames. A
    // sprite flip driven by velocity's sign would therefore flip late
    // or flicker instead of turning cleanly with the entity. Defaults
    // to 1 (right), matching _applyPatrol's initial state.dir.
    this._patrolFacingDirection = 1;
  }
}
