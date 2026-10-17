/**
 * runtime/systems/ControllerSystem.js
 *
 * Movement behaviors are engine shortcuts, not physics body replacements.
 * A Rigidbody2D keeps its selected Dynamic/Kinematic/Static type; this
 * system only computes movement intent for the existing body.
 *
 * Dynamic bodies receive target velocity input and remain fully simulated by
 * Rapier. Kinematic bodies receive a target velocity/translation and are
 * resolved by PhysicsWorld against the same Rapier collider. Static bodies
 * are never moved. No Rapier CharacterController is created here or anywhere
 * else in the engine.
 *
 * Supported controllerType values: Character Controller, Platformer,
 * Top-Down, Car, Follow, Patrol, and Free.
 *
 * RUNTIME-ONLY FILE.
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { RIGIDBODY_2D, BodyType } from "../components/Rigidbody2D.js";
import { CHARACTER_CONTROLLER, ControllerType, PatrolMode, PatrolAxis } from "../components/CharacterController.js";
import { JOINT_2D, JointType2D } from "../components/Joint2D.js";

const GRAVITY_Y = 980; // px/s^2 — matches PhysicsWorld.js's GRAVITY_Y. Only
// used for the KINEMATIC path (which gets none of Rapier's own gravity
// integration for free) so a gravity-enabled Kinematic controller still
// falls at a visually consistent rate. Dynamic bodies never use this —
// they get real gravity straight from Rapier via gravityScale.


// Keys this engine's default input binds to game actions (see isDown()
// calls throughout this file: ArrowLeft/Right/Up/Down, WASD, Space).
// Their default browser behavior (arrow keys and Space scroll the
// page; Space also "clicks" whatever element currently has focus) is
// suppressed ONLY for these specific codes — not blanket-blocked for
// every key — so normal browser/editor shortcuts and any text inputs
// elsewhere on the page keep working normally.
const GAME_KEY_CODES = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "KeyW", "KeyA", "KeyS", "KeyD",
  "Space",
]);

/** Tracks currently-held keys. One instance per ControllerSystem (per game). */
class InputState {
  constructor() {
    this.keys = new Set();
    /** Keys that went down THIS frame only — cleared at the start of each
     *  ControllerSystem.update() tick via tick(). Used for jump so holding
     *  Space only triggers one jump per press, not one per frame. */
    this._justPressed = new Set();
    this._onKeyDown = (e) => {
      // BUG FIX: without this, holding an arrow key or Space scrolled
      // the whole page (taking the game canvas out of view), and
      // Space could "click" a focused button/link on the page. Either
      // one can shift keyboard focus away from the game, which
      // sometimes drops the matching keyup event entirely — leaving
      // that key stuck "down" in this Set forever, i.e. a character
      // that keeps walking/jumping on its own after the key was
      // actually released. preventDefault() only for the specific
      // codes this engine binds to game actions (see GAME_KEY_CODES
      // above), so nothing else on the page is affected.
      //
      // BUG FIX 2: this listener is attached to `window` and this
      // system lives for as long as the editor's own live preview is
      // running (SceneViewport.js calls createGame() to drive it),
      // not just inside actual Play mode. That means it was ALWAYS
      // active while using the editor — including while typing in the
      // Monaco script editor. Since WASD/Space/arrows are exactly the
      // codes this handler preventDefault()s unconditionally, every
      // one of those keystrokes was swallowed before Monaco's own
      // hidden textarea ever saw them, while every other key typed
      // normally. Guard against that: skip entirely when a normal
      // text input/textarea or the Monaco editor currently has focus.
      if (InputState._isTypingTarget(e.target)) return;
      if (GAME_KEY_CODES.has(e.code)) e.preventDefault();
      // Track just-pressed: only fires once per physical key-down, not
      // repeatedly while held (browser fires repeated keydown events
      // while a key is held; skip those by checking keys first).
      if (!this.keys.has(e.code)) {
        this._justPressed.add(e.code);
      }
      this.keys.add(e.code);
    };
    this._onKeyUp = (e) => {
      if (InputState._isTypingTarget(e.target)) return;
      this.keys.delete(e.code);
    };
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
  }

  /** Clear the just-pressed set at the start of each frame. */
  tick() {
    this._justPressed.clear();
  }

  /**
   * True when the event's target is a normal text field or Monaco's
   * own editing surface, meaning the keystroke is meant for typing —
   * not game input — and this system should get completely out of
   * its way (no preventDefault, no key tracking). Checked on both
   * keydown and keyup so a key held while focus moves in/out of a
   * text field doesn't leave a stuck entry in `keys`.
   */
  static _isTypingTarget(target) {
    if (!target) return false;
    if (/^(input|textarea)$/i.test(target.tagName)) return true;
    if (target.isContentEditable) return true;
    // Monaco's real keyboard-capturing element is a hidden textarea
    // with class "inputarea" inside .monaco-editor — some browsers
    // report its tagName oddly, so also check via closest() as a
    // belt-and-suspenders match against the editor's outer container.
    if (target.closest && target.closest(".monaco-editor")) return true;
    return false;
  }

  isDown(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  /** True if ANY of the given codes was pressed THIS frame (not held). */
  isJustPressed(...codes) {
    return codes.some((c) => this._justPressed.has(c));
  }

  destroy() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    this.keys.clear();
    this._justPressed.clear();
  }
}

export class ControllerSystem extends System {
  constructor() {
    super();
    this.input = new InputState();
    /** @type {Map<string, number>} entityId -> vertical velocity carried between frames (KINEMATIC path only — DYNAMIC gets real gravity from Rapier) */
    this._verticalVelocity = new Map();
    /** @type {Map<string, number>} entityId -> jumps used since last grounded */
    this._jumpsUsed = new Map();
    /** @type {Map<string, number>} entityId -> buffered jump request time remaining */
    this._jumpBuffer = new Map();
    /** @type {Map<string, number>} entityId -> seconds since a jump was launched */
    this._jumpAirTime = new Map();
    /** @type {Map<string, boolean>} entityId -> whether the current jump arc has launched */
    this._jumpHasLaunched = new Map();
    /** @type {Map<string, number>} entityId -> current forward speed (Car controller) */
    this._carSpeed = new Map();
    /** @type {Map<string, {dir:1|-1, distance:number}>} entityId -> facing
     * direction (+1 = right, -1 = left) and px walked since the last turn
     * (Patrol controller only). Runtime-only derived state, same reasoning
     * as _verticalVelocity/_jumpsUsed/_carSpeed above — not authored data,
     * so it lives here rather than on the CharacterController component
     * (RULES.txt section 4: components stay plain data). */
    this._patrolState = new Map();
    /** @type {Map<string, boolean>} Compatibility flag: whether the current
     * driveToward maneuver is committed to reverse. The richer maneuver
     * state lives in _driveTowardManeuver below. */
    this._driveTowardReverseState = new Map();
    /** Runtime-only committed maneuver state for driveToward autopilot. */
    this._driveTowardManeuver = new Map();
    /**
     * Set by runtime/index.js so Dynamic movement can read real Rapier
     * contact state (especially ground contact) before the next simulation step.
     * @type {import('../physics/PhysicsWorld.js').PhysicsWorld|null}
     */
    this.physicsWorld = null;
  }

  // Safety multiplier on top of the physical ascent time (jumpForce / GRAVITY_Y).
  // 1.2 = 20% past the theoretical apex, giving margin for frame-rate variance
  // and the brief plateau near the top of a real jump arc.
  static POST_JUMP_LOCKOUT_SAFETY = 1.2;
  static JUMP_BUFFER_SECONDS = 0.12;
  static JUMP_MIN_AIR_TIME_SECONDS = 0.08;

  update(world, dt) {
    const entities = world.query(TRANSFORM, CHARACTER_CONTROLLER, RIGIDBODY_2D);

    // Prune per-entity movement state when controllers are destroyed mid-scene.
    // are all keyed by entityId and only ever written via .set() below —
    // resetScene() clears them on a full scene reload, but nothing
    // previously removed a single entity's entries when that specific
    // entity was destroyed mid-scene (e.g. a pooled enemy or a temporary
    // platform with a CharacterController). Over a long play session with
    // controllers spawning/despawning, all four maps grow forever. Pruned
    // here the same way RenderSystem/PhysicsWorld prune their own stale
    // per-entity maps: build the current id set, then drop anything not
    // present from every map that isn't already empty for that id.
    const liveIds = new Set();
    for (const entity of entities) liveIds.add(entity.id);
    if (this._verticalVelocity.size || this._jumpsUsed.size || this._jumpBuffer.size || this._jumpAirTime.size || this._jumpHasLaunched.size || this._carSpeed.size || this._patrolState.size || this._driveTowardReverseState.size || this._driveTowardManeuver.size) {
      for (const id of this._verticalVelocity.keys()) if (!liveIds.has(id)) this._verticalVelocity.delete(id);
      for (const id of this._jumpsUsed.keys()) if (!liveIds.has(id)) this._jumpsUsed.delete(id);
      for (const id of this._jumpBuffer.keys()) if (!liveIds.has(id)) this._jumpBuffer.delete(id);
      for (const id of this._jumpAirTime.keys()) if (!liveIds.has(id)) this._jumpAirTime.delete(id);
      for (const id of this._jumpHasLaunched.keys()) if (!liveIds.has(id)) this._jumpHasLaunched.delete(id);
      for (const id of this._carSpeed.keys()) if (!liveIds.has(id)) this._carSpeed.delete(id);
      for (const id of this._patrolState.keys()) if (!liveIds.has(id)) this._patrolState.delete(id);
      for (const id of this._driveTowardReverseState.keys()) if (!liveIds.has(id)) this._driveTowardReverseState.delete(id);
      for (const id of this._driveTowardManeuver.keys()) if (!liveIds.has(id)) this._driveTowardManeuver.delete(id);
    }



    for (const entity of entities) {
      const controller = entity.getComponent(CHARACTER_CONTROLLER);
      const rigidbody = entity.getComponent(RIGIDBODY_2D);

      // FREE means "fully script-driven" (see CharacterController.js's
      // doc comment) — this system does nothing at all for it, so a
      // script's own this.rigidbody calls are never fought/overridden.
      if (controller.controllerType === ControllerType.FREE) continue;
      // Static bodies never move — nothing to drive.
      if (rigidbody.bodyType === BodyType.STATIC) continue;

      const type = controller.controllerType;
      if (type === ControllerType.CAR) {
        // ALL Car input is resolved in the late pass, after ScriptSystem.
        // That lets the same frame combine live WASD/Arrow input with
        // this.controller.simulateDrive(), while still letting
        // useDefaultInput=false mean "script input only". Keeping one
        // authoritative Car pass also prevents acceleration/braking from
        // being applied twice in a single frame.
      } else if (type === ControllerType.FOLLOW) {
        this._applyFollow(entity, controller, rigidbody, dt, world);
      } else if (type === ControllerType.PATROL) {
        this._applyPatrol(entity, controller, rigidbody, dt);
      } else if (rigidbody.bodyType === BodyType.DYNAMIC) {
        // NOTE: unlike useDefaultInput's old all-or-nothing gate, this
        // still runs even with useDefaultInput=false for Character/
        // Platformer/Top-Down — it just skips reading the keyboard
        // (see the `controller.useDefaultInput ? ... : false` reads
        // inside _applyDynamic/_applyKinematic below) so gravity and
        // controller.simulateJump() (scripting/components/
        // ControllerAPI.js) still work for a controller a script wants
        // to trigger jumps on without also taking over WASD.
        this._applyDynamic(entity.id, controller, rigidbody, dt);
      } else {
        this._applyKinematic(entity.id, controller, rigidbody, dt);
      }
    }

    // Clear just-pressed state at the END of the frame (after all controllers
    // have read it) so every isJustPressed() call this tick sees the press,
    // and it is cleared before the NEXT frame's keydown events arrive.
    // Placing tick() at the START of update() was the original bug: a keydown
    // event queued between frames would be added to _justPressed and then
    // immediately cleared before any controller could read it.
    this.input.tick();
  }

  /**
   * LATE Car-input pass. Every Car goes through this single pass so
   * ScriptSystem can contribute same-frame simulateDrive() values while
   * default WASD/Arrow input remains available when useDefaultInput=true.
   *
   * This is intentionally Car-only: other controller types keep their
   * existing early-update ordering so their scripts can continue reading
   * the frame's fresh controller/contact state.
   */
  updateLateCarInput(world, dt) {
    const entities = world.query(TRANSFORM, CHARACTER_CONTROLLER, RIGIDBODY_2D);
    for (const entity of entities) {
      const controller = entity.getComponent(CHARACTER_CONTROLLER);
      if (controller.controllerType !== ControllerType.CAR) continue;

      const rigidbody = entity.getComponent(RIGIDBODY_2D);
      if (rigidbody.bodyType === BodyType.STATIC) continue;

      this._applyCar(entity, controller, rigidbody, dt);
    }
  }

  /**
   * DYNAMIC path: seeds Rapier's velocity via the transient
   * driveVelocityX/driveVelocityY fields (consumed + cleared each step by
   * PhysicsWorld.js) instead of owning velocity outright, so gravity,
   * contact pushback, and landing on slopes all stay fully Rapier's.
   */
  _applyDynamic(entityId, controller, rigidbody, dt) {
    const useKeys = controller.useDefaultInput;
    const left = useKeys && this.input.isDown("ArrowLeft", "KeyA");
    const right = useKeys && this.input.isDown("ArrowRight", "KeyD");
    const up = useKeys && this.input.isDown("ArrowUp", "KeyW");
    const down = useKeys && this.input.isDown("ArrowDown", "KeyS");
    // A script can request a jump via this.controller.simulateJump()
    // (scripting/components/ControllerAPI.js sets requestJump=true on
    // the component); consumed here alongside the keyboard Space/ArrowUp
    // keys so all trigger the exact same jump logic/limits.
    //
    // JUMP-KEY FIX: use isJustPressed (went down THIS frame) rather than
    // isDown (held), so holding Space doesn't fire a jump every frame.
    // With isDown and maxJumps=2, holding Space would consume both jumps
    // in consecutive frames before the body had time to leave the ground,
    // making double-jump impossible and allowing infinite jumping when
    // combined with the apex grounded false-positive (see grounded fix
    // below). isJustPressed fires exactly once per physical key-down.
    // ArrowUp is added as an alternative jump key — the standard
    // Platformer convention alongside Space.
    const jumpJustPressed = useKeys && (
      this.input.isJustPressed("Space") ||
      (controller.controllerType === ControllerType.PLATFORMER && this.input.isJustPressed("ArrowUp", "KeyW"))
    );
    const jumpPressed = jumpJustPressed || controller.requestJump;
    if (jumpPressed) {
      const bufferedJumpsUsed = this._jumpsUsed.get(entityId) || 0;
      const jumpHasLaunched = this._jumpHasLaunched.get(entityId) || false;
      // Buffer an initial press before the first launch, or a legitimate extra
      // jump while maxJumps still has capacity. Once the available mid-air
      // jumps are consumed, an extra press is ignored rather than queued for
      // a later landing.
      if (!jumpHasLaunched || bufferedJumpsUsed < controller.maxJumps) {
        this._jumpBuffer.set(entityId, ControllerSystem.JUMP_BUFFER_SECONDS);
      }
    }
    controller.requestJump = false;
    const existingBuffer = this._jumpBuffer.get(entityId) || 0;
    const bufferedJump = existingBuffer > 0;
    if (existingBuffer > 0) {
      this._jumpBuffer.set(entityId, Math.max(0, existingBuffer - dt));
    }

    // Default input and scripted input are two sources feeding the SAME
    // movement axes. This is deliberately additive, not override-only:
    // useDefaultInput=true keeps WASD/Arrows active while a script can add
    // joystick/AI/cutscene input in the same frame. With useDefaultInput=false
    // the keyboard contribution is zero, so the exact same API becomes
    // script/joystick-only. Analog values are preserved and the final axis is
    // clamped to [-1, 1].
    const keyMoveX = (right ? 1 : 0) - (left ? 1 : 0);
    const keyMoveY = (down ? 1 : 0) - (up ? 1 : 0);
    const scriptMoveX = controller.requestMoveX !== null
      ? Number(controller.requestMoveX) : 0;
    const scriptMoveY = controller.requestMoveY !== null
      ? Number(controller.requestMoveY) : 0;
    const moveX = Math.max(-1, Math.min(1, keyMoveX + (Number.isFinite(scriptMoveX) ? scriptMoveX : 0)));
    const moveY = Math.max(-1, Math.min(1, keyMoveY + (Number.isFinite(scriptMoveY) ? scriptMoveY : 0)));
    controller.requestMoveX = null;
    controller.requestMoveY = null;

    // TOP-DOWN DIAGONAL SPEED FIX: moveX/moveY above are each independently
    // clamped to [-1, 1], but never jointly normalized — holding two
    // directions at once (e.g. Right+Down) previously gave a combined
    // input vector of length sqrt(2) (~1.41), so a Top-Down entity moved
    // ~41% faster diagonally than along a single axis. Only Top-Down uses
    // moveX/moveY together as a 2D movement vector (Platformer/Character
    // Controller use moveY for jump-adjacent input, not simultaneous
    // travel; Car/Follow/Patrol don't read this axis pair at all), so the
    // rescale is scoped to that controller type only.
    let normMoveX = moveX, normMoveY = moveY;
    if (controller.controllerType === ControllerType.TOP_DOWN) {
      const mag = Math.hypot(moveX, moveY);
      if (mag > 1) { normMoveX = moveX / mag; normMoveY = moveY / mag; }
    }

    const targetX = normMoveX * controller.moveSpeed;

    // PhysicsWorld needs to know which Kinematic bodies are Platformers so
    // it can apply moving-Dynamic-platform carry only to that controller.
    rigidbody._controllerType = controller.controllerType;

    // Air control scales horizontal acceleration while the body is not in
    // contact with ground. Grounded state comes from Rapier's manifolds.
    //
    // Dynamic bodies use the actual Rapier contact manifold when physics is
    // wired. The velocity fallback exists only for isolated unit tests.

    // For a standalone ControllerSystem unit test with no PhysicsWorld wired,
    // retain the velocity fallback so the system remains usable in isolation;
    // the real engine always wires physicsWorld in runtime/index.js.
    const gravityScale = Math.max(0.05, rigidbody.gravityScale != null ? rigidbody.gravityScale : 1);
    const vy = rigidbody.velocityY;
    const velocityLooksGrounded =
      vy >= -10 * gravityScale && vy < 40 * gravityScale;

    const hasRealGroundContact = this.physicsWorld
      ? this.physicsWorld.hasGroundContact(entityId)
      : velocityLooksGrounded;

    // ControllerSystem runs BEFORE PhysicsSystem each frame. Immediately after
    // a jump, Rapier can still report the floor contact from the previous step
    // for one or more frames even though the body is already moving upward.
    // A contact alone is therefore not enough to declare a landing: an actual
    // upward velocity means this is takeoff state, not a new grounded state.
    // This uses the body's real velocity rather than an arbitrary frame/time
    // lock, so the rule remains correct at different frame rates and jump
    // strengths.
    const airTime = this._jumpAirTime.get(entityId) || 0;
    const stillTakingOff = rigidbody.velocityY < -0.001 || (airTime > 0 && airTime < ControllerSystem.JUMP_MIN_AIR_TIME_SECONDS);
    const grounded = controller.controllerType === ControllerType.TOP_DOWN
      ? true
      : (hasRealGroundContact && !stillTakingOff);
    const airborneMultiplier = grounded ? 1 : controller.airControl;

    // Tethered Dynamic Character/Platformer bodies must not have their world-X
    // velocity overwritten while a Rope joint is taut. A real pendulum keeps
    // its tangential momentum when input is released; replacing vx with a
    // horizontal target every frame injects/removes energy and makes the body
    // appear to float or slow down unnaturally during the swing.
    const tetheredRope = this.physicsWorld?.getRopeMotionInfo?.(entityId);
    const isSwingController =
      controller.controllerType === ControllerType.PLATFORMER ||
      controller.controllerType === ControllerType.CHARACTER;
    const swingInput = normMoveX;
    if (tetheredRope?.taut && isSwingController && !controller.requestJump) {
      const currentVx = Number(rigidbody.velocityX) || 0;
      const currentVy = Number(rigidbody.velocityY) || 0;
      const tangentSpeed = currentVx * tetheredRope.tangentX + currentVy * tetheredRope.tangentY;
      const radialSpeed = currentVx * tetheredRope.radialX + currentVy * tetheredRope.radialY;

      if (Math.abs(swingInput) > 1e-4) {
        // Input accelerates toward a target tangential speed. It never erases
        // the existing swing momentum just because the key is released.
        const desiredTangent = swingInput * controller.moveSpeed;
        const swingLerp = Math.min(1, controller.acceleration * airborneMultiplier * dt);
        const nextTangent = tangentSpeed + (desiredTangent - tangentSpeed) * swingLerp;
        rigidbody.driveVelocityX = nextTangent * tetheredRope.tangentX + radialSpeed * tetheredRope.radialX;
        rigidbody.driveVelocityY = nextTangent * tetheredRope.tangentY + radialSpeed * tetheredRope.radialY;
      } else {
        // No input: do NOT seed a target velocity. Let Rapier preserve the
        // tangential momentum and let gravity provide the restoring torque.
        rigidbody.driveVelocityX = null;
        rigidbody.driveVelocityY = null;
      }
    }

    if (controller.controllerType !== ControllerType.TOP_DOWN) {
      this._jumpAirTime.set(entityId, airTime + dt);
    }

    // Dynamic movement is just a target velocity. Rapier remains responsible
    // for collision response, sliding, gravity, impulses, and body-to-body
    // interaction. There is no manual wall correction here.
    //
    // If a taut rope branch above already supplied both velocity components,
    // keep that tangential result. Otherwise use the normal controller path.
    const currentX = rigidbody.velocityX;
    const lerpT = Math.min(1, controller.acceleration * airborneMultiplier * dt);
    const swingVelocityAlreadySeeded =
      tetheredRope?.taut && isSwingController && !controller.requestJump && swingInput !== 0;
    if (!swingVelocityAlreadySeeded && !tetheredRope?.taut) {
      rigidbody.driveVelocityX = currentX + (targetX - currentX) * lerpT;
    }

    if (controller.controllerType === ControllerType.TOP_DOWN) {
      // Top-Down has no gravity concept even on a Dynamic body — drive Y
      // directly too via the same transient channel, bypassing gravity.
      const targetY = normMoveY * controller.moveSpeed;
      const currentY = rigidbody.velocityY;
      rigidbody.driveVelocityY = currentY + (targetY - currentY) * lerpT;
      return;
    }

    // Character Controller / Platformer on a Dynamic body: let Rapier's
    // own gravityScale integrate falling. We only ever touch Y to apply
    // a jump impulse (a velocity kick), never to simulate gravity
    // ourselves — that would double up with Rapier's.
    // (grounded was already computed above, before the air-control lerp.)
    // Store back onto the component (same field the Kinematic sweep in
    // PhysicsWorld.js already populates) so this.controller.isGrounded
    // (see scripting/components/ControllerAPI.js) reads real state on a
    // Dynamic body too, not just Kinematic. This IS a coarser signal
    // than Kinematic's real sweep-based grounded (no isOnCeiling/
    // isOnWall/isOnSlope/groundAngle equivalent exists for Dynamic —
    // Rapier's own solver handles those contacts, this engine doesn't
    // track them per-axis for Dynamic bodies), but it's the same
    // approximation this system already used internally, just now
    // exposed instead of staying a local-only const.
    rigidbody.grounded = grounded;

    // Reset the jump allowance only on a genuine landing after the minimum
    // airborne window. This prevents a partial/stale contact on takeoff from
    // immediately resetting the jump count and allowing a second mid-air press.
    if (grounded && airTime >= ControllerSystem.JUMP_MIN_AIR_TIME_SECONDS) {
      this._jumpsUsed.set(entityId, 0);
      this._jumpHasLaunched.set(entityId, false);
    }

    if (controller.canJump && bufferedJump) {
      const jumpsUsed = this._jumpsUsed.get(entityId) || 0;
      if ((grounded || jumpsUsed < controller.maxJumps) && jumpsUsed < controller.maxJumps) {
        rigidbody.driveVelocityY = -controller.jumpForce; // negative = up (this engine is Y-down)
        this._jumpsUsed.set(entityId, jumpsUsed + 1);
        this._jumpHasLaunched.set(entityId, true);
        this._jumpBuffer.delete(entityId);
        this._jumpAirTime.set(entityId, 0);
      }
    }

  }

  /**
   * KINEMATIC path: this system owns velocity outright (Rapier applies
   * no forces to a Kinematic body), so it has to simulate its own
   * gravity/jump-arc using the same GRAVITY_Y constant PhysicsWorld.js
   * uses for Dynamic bodies, to keep the two body types feeling similar.
   */
  _applyKinematic(entityId, controller, rigidbody, dt) {
    const useKeys = controller.useDefaultInput;
    const left = useKeys && this.input.isDown("ArrowLeft", "KeyA");
    const right = useKeys && this.input.isDown("ArrowRight", "KeyD");
    const up = useKeys && this.input.isDown("ArrowUp", "KeyW");
    const down = useKeys && this.input.isDown("ArrowDown", "KeyS");
    // JUMP-KEY FIX: use isJustPressed so holding Space only triggers one
    // jump per press, matching the Dynamic path fix above. ArrowUp is also
    // accepted as an alternative jump key for Platformer (common convention).
    const jumpJustPressed = useKeys && (
      this.input.isJustPressed("Space") ||
      (controller.controllerType === ControllerType.PLATFORMER && this.input.isJustPressed("ArrowUp", "KeyW"))
    );
    const jumpPressed = jumpJustPressed || controller.requestJump;
    if (jumpPressed) {
      const bufferedJumpsUsed = this._jumpsUsed.get(entityId) || 0;
      const jumpHasLaunched = this._jumpHasLaunched.get(entityId) || false;
      if (!jumpHasLaunched || bufferedJumpsUsed < controller.maxJumps) {
        this._jumpBuffer.set(entityId, ControllerSystem.JUMP_BUFFER_SECONDS);
      }
    }
    controller.requestJump = false;
    const existingBuffer = this._jumpBuffer.get(entityId) || 0;
    const bufferedJump = existingBuffer > 0;
    if (existingBuffer > 0) {
      this._jumpBuffer.set(entityId, Math.max(0, existingBuffer - dt));
    }

    // Scripted and default input are combined exactly the same way as the
    // Dynamic path: with useDefaultInput=true both sources contribute to the
    // same axes; with it false only the scripted request remains. This keeps
    // Character/Platformer/Top-Down behavior consistent across body types.
    const keyMoveX = (right ? 1 : 0) - (left ? 1 : 0);
    const keyMoveY = (down ? 1 : 0) - (up ? 1 : 0);
    const scriptMoveX = controller.requestMoveX !== null
      ? Number(controller.requestMoveX) : 0;
    const scriptMoveY = controller.requestMoveY !== null
      ? Number(controller.requestMoveY) : 0;
    const moveX = Math.max(-1, Math.min(1, keyMoveX + (Number.isFinite(scriptMoveX) ? scriptMoveX : 0)));
    const moveY = Math.max(-1, Math.min(1, keyMoveY + (Number.isFinite(scriptMoveY) ? scriptMoveY : 0)));
    controller.requestMoveX = null;
    controller.requestMoveY = null;

    // TOP-DOWN DIAGONAL SPEED FIX — same reasoning/scoping as the
    // identical block in _applyDynamic above: without this, holding two
    // directions at once gave a combined input vector of length sqrt(2),
    // ~41% faster than a single-axis move.
    let normMoveX = moveX, normMoveY = moveY;
    if (controller.controllerType === ControllerType.TOP_DOWN) {
      const mag = Math.hypot(moveX, moveY);
      if (mag > 1) { normMoveX = moveX / mag; normMoveY = moveY / mag; }
    }

    const targetX = normMoveX * controller.moveSpeed;
    rigidbody._controllerType = controller.controllerType;

    // AIR CONTROL FIX: controller.airControl (0-1 multiplier on
    // acceleration while airborne — see CharacterController.js's doc
    // comment, the Inspector's "Air Control" slider, and
    // ControllerAPI.js's this.controller.airControl) was previously
    // defined and fully wired everywhere EXCEPT here — this system
    // never actually read it, so every controller accelerated at full
    // ground acceleration in mid-air regardless of the slider's value.
    // Applied only for Character Controller/Platformer (their gravity
    // path, resolved a few lines below) — Top-Down has no airborne
    // concept and already returns above.
    const airborneMultiplier = rigidbody.grounded ? 1 : controller.airControl;
    const lerpT = Math.min(1, controller.acceleration * airborneMultiplier * dt);
    rigidbody.velocityX += (targetX - rigidbody.velocityX) * lerpT;

    const usesGravity =
      controller.controllerType === ControllerType.PLATFORMER
        ? true
        : controller.controllerType === ControllerType.TOP_DOWN
        ? false
        : controller.useGravity;

    if (controller.controllerType === ControllerType.TOP_DOWN) {
      const targetY = normMoveY * controller.moveSpeed;
      rigidbody.velocityY += (targetY - rigidbody.velocityY) * lerpT;
      return;
    }

    let vy = this._verticalVelocity.get(entityId) || 0;
    // A Kinematic script may directly assign this.rigidbody.velocityY
    // (for example `velocityY = -200` on Space). ScriptSystem runs after
    // physics, while this controller runs before physics, so without this
    // hand-off the controller's private gravity velocity would overwrite
    // the script value on the following frame. Consume the explicit script
    // value as authoritative for this tick; this is transient and never
    // serialized.
    const scriptVelocityY = rigidbody._scriptVelocityY;
    if (scriptVelocityY !== null && Number.isFinite(Number(scriptVelocityY))) {
      vy = Number(scriptVelocityY);
      rigidbody._scriptVelocityY = null;
    }
    // Ground/contact state is supplied by Rapier's actual post-step contact
    // manifolds. ControllerSystem runs before PhysicsSystem, so immediately
    // after takeoff the manifold can still describe the floor while the
    // controller's stored vertical velocity is already upward. Do not let
    // that stale contact zero the jump velocity or reset the jump allowance.
    const stillTakingOff = vy < -0.001;
    const grounded = rigidbody.grounded && !stillTakingOff;

    // A ceiling is a real contact too. Kill an upward movement request once
    // the solver/contact query says the body is touching a ceiling so the
    // next frame starts falling instead of repeatedly requesting the blocked
    // upward translation.
    if (rigidbody.isOnCeiling && vy < 0) {
      vy = 0;
    }

    const airTime = this._jumpAirTime.get(entityId) || 0;
    const scriptVelocityWasApplied = scriptVelocityY !== null && Number.isFinite(Number(scriptVelocityY));
    const effectiveGrounded = grounded && !scriptVelocityWasApplied && (airTime === 0 || airTime >= ControllerSystem.JUMP_MIN_AIR_TIME_SECONDS);
    if (effectiveGrounded) {
      vy = 0;
      const jumpsUsed = this._jumpsUsed.get(entityId) || 0;
      if (jumpsUsed > 0) this._jumpsUsed.set(entityId, 0);
      this._jumpHasLaunched.set(entityId, false);
    }
    this._jumpAirTime.set(entityId, airTime + dt);

    // Gravity is movement behavior for Kinematic bodies only; Rapier owns
    // gravity for Dynamic bodies. Grounded bodies stay at zero vertical
    // controller velocity until a jump or other explicit move occurs.
    // gravityScale multiplies GRAVITY_Y the same way Rigidbody2D
    // .gravityScale multiplies Rapier's own gravity for Dynamic bodies —
    // see CharacterController.js's doc comment on gravityScale.
    if (!grounded && usesGravity && !scriptVelocityWasApplied) {
      vy += GRAVITY_Y * controller.gravityScale * dt;
    } else if (controller.controllerType === ControllerType.CHARACTER && !scriptVelocityWasApplied) {
      // Character Controller with gravity off: vertical is direct move
      // input too (e.g. a floating/flying controller). Reuses the same
      // moveY resolved above (keyboard OR a script's simulateMove(x,y))
      // instead of re-reading up/down directly, so a scripted vertical
      // move request works here exactly like it does for horizontal.
      vy = moveY * controller.moveSpeed;
    }

    if (controller.canJump && bufferedJump) {
      const jumpsUsed = this._jumpsUsed.get(entityId) || 0;
      if ((grounded || jumpsUsed < controller.maxJumps) && jumpsUsed < controller.maxJumps) {
        vy = -controller.jumpForce;
        this._jumpsUsed.set(entityId, jumpsUsed + 1);
        this._jumpHasLaunched.set(entityId, true);
        this._jumpBuffer.delete(entityId);
        this._jumpAirTime.set(entityId, 0);
      }
    }


    this._verticalVelocity.set(entityId, vy);
    rigidbody.velocityY = vy;
  }

  /**
   * CAR controller: arcade-style car movement. Up/Down (W/S)
   * accelerate / brake-and-reverse; Left/Right (A/D) steer. Steering
   * is proportional to speed (can't turn when stopped). The car moves
   * along its own forward direction (derived from Transform rotation,
   * 0 deg = up, clockwise). Works on both Kinematic (velocityX/Y +
   * angularVelocity) and Dynamic (driveVelocityX/Y +
   * driveAngularVelocity) bodies.
   *
   * useDefaultInput = true (default): WASD/Arrows remain active and a
   * script can add to them. simulateDrive(throttle, steer) uses the same
   * two independent car axes as the built-in controls: throttle controls
   * acceleration/braking and steer controls steering. Fractional values are
   * supported for analog joysticks.
   * useDefaultInput = false: only the scripted throttle/steer is used. Requests are
   * one-shot and consumed after this update, so simulateDrive() should be
   * called every frame the script wants to keep supplying input.
   */
  /**
   * Resolves a world-space target into one frame of Car throttle/steer.
   *
   * The autopilot is deliberately stateful: it uses a committed reverse
   * maneuver with a brake-before-reverse transition, a locked steering side
   * for centered-behind targets, and wide forward/reverse hysteresis. Once
   * the car has backed around enough to put the target in its forward cone,
   * it performs a smooth reverse-to-forward handoff instead of choosing a
   * different gear from scratch every frame.
   *
   * The same resolver is used by simulateDriveToward() and navDriveToward(),
   * so direct chase cars and NavAgent2D cars share identical vehicle handling.
   */
  _resolveDriveTowardInput(entity, controller, transform, targetX, targetY, currentSpeed, dt = 1 / 60) {
    const dx = targetX - transform.x;
    const dy = targetY - transform.y;
    const distance = Math.hypot(dx, dy);
    const arriveDist = Math.max(1, Number(controller.driveTowardArriveDistance) || 12);

    if (distance <= arriveDist) {
      this._driveTowardReverseState.delete(entity.id);
      this._driveTowardManeuver.delete(entity.id);
      return { throttle: 0, steer: 0 };
    }

    const rad = (transform.rotation * Math.PI) / 180;
    const forwardX = Math.sin(rad);
    const forwardY = -Math.cos(rad);
    const dirX = dx / distance;
    const dirY = dy / distance;
    const angleTo = (fx, fy) => Math.atan2(fx * dirY - fy * dirX, fx * dirX + fy * dirY);
    const forwardAngle = angleTo(forwardX, forwardY);
    const reverseAngle = angleTo(-forwardX, -forwardY);
    const absForward = Math.abs(forwardAngle);
    const absSpeed = Math.abs(Number(currentSpeed) || 0);

    let state = this._driveTowardManeuver.get(entity.id);
    if (!state) {
      state = { mode: 'forward', turnSign: 1, turnSignLocked: false, reverseTime: 0, targetX, targetY };
      this._driveTowardManeuver.set(entity.id, state);
    }

    // Ordinary chase-target motion should not reset the maneuver. A large
    // jump is treated as a new waypoint/goal so an old reverse decision is
    // never carried into a completely different target.
    const targetJump = Math.hypot(targetX - state.targetX, targetY - state.targetY);
    const targetResetDistance = Math.max(28, arriveDist * 8, (Number(controller.maxSpeed) || 350) * 0.20);
    if (targetJump > targetResetDistance) {
      state.mode = 'forward';
      state.turnSignLocked = false;
      state.reverseTime = 0;
    }
    state.targetX = targetX;
    state.targetY = targetY;

    // Strong hysteresis gives the car real gear commitments instead of
    // choosing a different gear every frame around the side of the car.
    const REVERSE_ENTER_ANGLE = 120 * Math.PI / 180;
    const REVERSE_EXIT_ANGLE = 55 * Math.PI / 180;
    const REVERSE_MIN_TIME = 0.22;
    const REVERSE_MIN_SPEED = Math.max(8, (Number(controller.maxSpeed) || 350) * 0.045);
    const FORWARD_RECOVERY_ANGLE = 18 * Math.PI / 180;

    // Exactly-behind targets have reverseAngle ~= 0. A straight reverse can
    // never change heading, so choose a steering side once. IMPORTANT: once
    // reverse begins, that side is locked until the maneuver finishes.
    // Otherwise the target moving across the car's centerline could flip the
    // reverse steering sign mid-maneuver and recreate left/right jitter.
    if (!state.turnSignLocked && state.mode !== 'reverseAlign') {
      if (Math.abs(reverseAngle) > 8 * Math.PI / 180) {
        state.turnSign = reverseAngle > 0 ? 1 : -1;
      } else if (!state.turnSign) {
        state.turnSign = 1;
      }
    }

    if (state.mode === 'forward' && absForward >= REVERSE_ENTER_ANGLE) {
      // Do not reverse merely because the target is behind the car. Estimate
      // both maneuvers first. A distant target is usually better handled by
      // a normal forward U-turn; a close target in a constrained space is
      // where a committed reverse maneuver actually saves time.
      const turnRate = Math.max(0.85, Number(controller.turnSpeed) || 2.4) * Math.PI / 180;
      const forwardTurnTime = absForward / turnRate;
      const reverseTurnTime = 0.55 + Math.max(0, (absForward - Math.PI * 0.5)) / Math.max(1.2, turnRate * 1.35);
      const brakeTime = absSpeed > REVERSE_MIN_SPEED
        ? absSpeed / Math.max(40, Number(controller.brakeForce) || 360)
        : 0;
      const closeEnoughToReverse = distance <= Math.max(100, absSpeed * 0.95, Number(controller.maxSpeed) * 0.28);
      const reverseIsFaster = (reverseTurnTime + brakeTime + 0.12) < (forwardTurnTime * 0.82);

      if (closeEnoughToReverse && reverseIsFaster) {
        state.mode = absSpeed > REVERSE_MIN_SPEED ? 'brakeForReverse' : 'reverseAlign';
        state.turnSignLocked = true;
        state.reverseTime = 0;
      } else {
        // Keep driving forward and let the normal steering system make the
        // U-turn. This prevents long-range targets from causing unnecessary
        // backing-up behavior.
        state.mode = 'forward';
        state.turnSignLocked = false;
      }
    }

    if (state.mode === 'brakeForReverse') {
      if ((Number(currentSpeed) || 0) <= REVERSE_MIN_SPEED) {
        state.mode = 'reverseAlign';
        state.reverseTime = 0;
      } else {
        this._driveTowardReverseState.set(entity.id, false);
        return { throttle: -1, steer: 0 };
      }
    }

    if (state.mode === 'reverseAlign') {
      state.reverseTime += Math.max(0, dt);
      this._driveTowardReverseState.set(entity.id, true);

      // Keep reversing until the car's FRONT is clearly pointed toward the
      // target. The exit threshold is much smaller than the entry threshold,
      // so small target/physics changes cannot bounce the car back into gear.
      if (state.reverseTime >= REVERSE_MIN_TIME && absForward <= REVERSE_EXIT_ANGLE) {
        state.mode = 'forwardRecover';
        this._driveTowardReverseState.set(entity.id, false);
      } else {
        let steer = reverseAngle;
        const absReverseTurn = Math.abs(steer);
        if (absReverseTurn <= 8 * Math.PI / 180) {
          steer = state.turnSign * (0.52 + Math.min(0.28, state.reverseTime * 0.6));
        } else {
          steer = Math.sign(steer) * Math.max(0.52, Math.min(1, absReverseTurn / (58 * Math.PI / 180)));
        }
        const throttleMagnitude = absForward < 95 * Math.PI / 180 ? 0.48 : 0.62;
        return { throttle: -throttleMagnitude, steer };
      }
    }

    if (state.mode === 'forwardRecover') {
      this._driveTowardReverseState.set(entity.id, false);

      // The car is now facing the target well enough to leave the reverse
      // maneuver. Positive throttle first removes any remaining reverse speed.
      // A tiny steering amount during that handoff keeps the nose from
      // drifting away without causing a sudden full-lock turn at zero speed.
      const currentLongitudinalSpeed = Number(currentSpeed) || 0;
      if (currentLongitudinalSpeed < -REVERSE_MIN_SPEED) {
        const handoffSteer = Math.max(-0.28, Math.min(0.28, forwardAngle / (55 * Math.PI / 180) * 0.28));
        return { throttle: 1, steer: handoffSteer };
      }

      state.mode = 'forward';
      state.turnSignLocked = false;
    }

    if (state.mode === 'forward') {
      this._driveTowardReverseState.set(entity.id, false);

      const STEER_FULL_ANGLE = 52 * Math.PI / 180;
      const steerMagnitude = Math.max(0, Math.min(1, absForward / STEER_FULL_ANGLE));
      const steer = Math.sign(forwardAngle) * steerMagnitude;

      // Speed planning: stronger steering demand means less throttle. This
      // keeps the car from overshooting waypoints and then looping back.
      const turnSlowStart = 28 * Math.PI / 180;
      const turnSlowEnd = 105 * Math.PI / 180;
      let turnFactor = 1;
      if (absForward > turnSlowStart) {
        turnFactor = 1 - 0.58 * Math.min(1, (absForward - turnSlowStart) / (turnSlowEnd - turnSlowStart));
      }

      const brakingDistance = Math.max(
        arriveDist * 2,
        (absSpeed * absSpeed) / Math.max(1, 2 * (Number(controller.brakeForce) || 1))
      );
      const arrivalFactor = distance < brakingDistance
        ? Math.max(0, Math.min(1, (distance - arriveDist) / Math.max(1, brakingDistance - arriveDist)))
        : 1;

      // A realistic car cannot make a tight turn at full road speed. Convert
      // the heading error into a target speed, then BRAKE when the actual
      // commanded speed is too high. This is the important piece that keeps
      // a car from flying past a target in a large circle after a reverse
      // maneuver. It also makes ordinary NavAgent waypoint corners cleaner.
      const headingCos = Math.max(0, Math.cos(absForward));
      const minCornerSpeed = Math.max(35, (Number(controller.maxSpeed) || 350) * 0.13);
      const cruiseSpeed = Math.max(1, Number(controller.maxSpeed) || 350);
      const turnSpeedLimit = Math.max(minCornerSpeed, cruiseSpeed * (0.16 + 0.84 * headingCos));
      const desiredSpeed = Math.min(cruiseSpeed * arrivalFactor, turnSpeedLimit);

      let throttle;
      if (absSpeed > desiredSpeed + 8) {
        // Brake rather than continue accelerating into a corner. The normal
        // _applyCar speed integration will smoothly bleed velocity down.
        throttle = -Math.min(1, Math.max(0.35, (absSpeed - desiredSpeed) / Math.max(30, controller.brakeForce * 0.45)));
      } else if (desiredSpeed <= minCornerSpeed + 1 && absSpeed < minCornerSpeed) {
        throttle = 0.32;
      } else {
        throttle = Math.max(0, Math.min(1, turnFactor * arrivalFactor));
      }

      return { throttle, steer };
    }

    state.mode = 'forward';
    state.turnSignLocked = false;
    this._driveTowardReverseState.set(entity.id, false);
    return { throttle: 0, steer: 0 };
  }

  _applyCar(entity, controller, rigidbody, dt) {
    const transform = entity.getComponent(TRANSFORM);
    if (!transform) return;

    const useKeys = controller.useDefaultInput;
    const keyAccelerate = useKeys && this.input.isDown("ArrowUp", "KeyW");
    const keyBrake = useKeys && this.input.isDown("ArrowDown", "KeyS");
    const keySteerLeft = useKeys && this.input.isDown("ArrowLeft", "KeyA");
    const keySteerRight = useKeys && this.input.isDown("ArrowRight", "KeyD");

    const keyThrottle = (keyAccelerate ? 1 : 0) - (keyBrake ? 1 : 0);
    const keySteer = (keySteerRight ? 1 : 0) - (keySteerLeft ? 1 : 0);

    // Four independent input paths:
    // 1) default keyboard = normal throttle + steering;
    // 2) simulateDrive() = scripted throttle + steering;
    // 3) simulateDriveJoystick() = a true directional joystick;
    // 4) simulateDriveToward(x, y) / navDriveToward()'s internal call into
    //    simulateDriveToward() = a world-space point this car resolves
    //    into its own throttle/steer every frame (see
    //    _resolveDriveTowardInput()'s doc comment). Any of the first three
    //    takes over for this frame without changing the Inspector's
    //    useDefaultInput setting.
    const hasJoystick = controller.requestJoystickX !== null && controller.requestJoystickY !== null;
    const joystickX = hasJoystick ? Number(controller.requestJoystickX) : 0;
    const joystickY = hasJoystick ? Number(controller.requestJoystickY) : 0;

    const hasScriptThrottle = controller.requestThrottle !== null;
    const hasScriptSteer = controller.requestSteer !== null;
    let scriptThrottle = hasScriptThrottle ? Number(controller.requestThrottle) : 0;
    let scriptSteer = hasScriptSteer ? Number(controller.requestSteer) : 0;

    const hasDriveToward = controller.requestDriveTowardX !== null && controller.requestDriveTowardY !== null;
    if (hasDriveToward && !hasJoystick) {
      const currentSpeedForAim = this._carSpeed.get(entity.id) || 0;
      const aim = this._resolveDriveTowardInput(
        entity, controller, transform,
        Number(controller.requestDriveTowardX), Number(controller.requestDriveTowardY),
        currentSpeedForAim
      );
      // Additive with any same-frame scripted throttle/steer (e.g. a
      // script nudging the autopilot's steer), exactly like keyboard +
      // simulateDrive() are additive above — clamped together below.
      scriptThrottle += aim.throttle;
      scriptSteer += aim.steer;
    }
    controller.requestDriveTowardX = null;
    controller.requestDriveTowardY = null;

    controller.requestThrottle = null;
    controller.requestSteer = null;
    controller.requestJoystickX = null;
    controller.requestJoystickY = null;

    const clamp = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
    let speed = this._carSpeed.get(entity.id) || 0;
    let angularVelocity = 0;

    if (hasJoystick) {
      // TRUE JOYSTICK CAR MODE
      // x/y are screen-space joystick coordinates: up is y=-1. The car
      // accelerates according to how far the stick is pushed, but it turns
      // toward the stick's direction instead of instantly snapping to it.
      const x = clamp(joystickX);
      const y = clamp(joystickY);
      const magnitude = Math.min(1, Math.hypot(x, y));

      if (magnitude > 0.0001) {
        // Transform rotation convention is 0 degrees = up, clockwise.
        // atan2(x, -y) therefore gives the desired car heading in radians.
        const targetAngle = Math.atan2(x, -y);
        let currentAngle = (transform.rotation * Math.PI) / 180;
        let angleDiff = targetAngle - currentAngle;

        // Normalize to the shortest turn in [-PI, PI].
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        // turnSpeed remains the existing car tuning in degrees/second.
        const maxTurn = Math.max(0, Number(controller.turnSpeed) || 0) * dt * Math.PI / 180;
        const turn = Math.max(-maxTurn, Math.min(maxTurn, angleDiff));
        currentAngle += turn;
        transform.rotation = currentAngle * 180 / Math.PI;
        angularVelocity = turn / Math.max(dt, 1e-6);

        // Stick magnitude is the gas pedal. No reverse is inferred from
        // direction; pointing the stick behind the car makes the car turn
        // around smoothly while continuing to accelerate.
        speed += controller.carAcceleration * magnitude * dt;
      } else {
        // Released/centered stick: natural deceleration, no steering snap.
        const decay = 200 * dt;
        if (speed > 0) speed = Math.max(0, speed - decay);
        else if (speed < 0) speed = Math.min(0, speed + decay);
      }
    } else {
      // NORMAL CAR MODE: keyboard and simulateDrive() use independent
      // throttle/steer axes. This is deliberately unchanged from the
      // default car behavior so keyboard controls do not inherit joystick
      // heading semantics.
      const sThrottle = clamp(scriptThrottle);
      const sSteer = clamp(scriptSteer);
      const inputThrottle = clamp(sThrottle + (useKeys ? keyThrottle : 0));
      const inputSteer = clamp(sSteer + (useKeys ? keySteer : 0));

      if (inputThrottle > 0) {
        speed += controller.carAcceleration * inputThrottle * dt;
      } else if (inputThrottle < 0) {
        speed += controller.brakeForce * inputThrottle * dt;
      } else {
        const decay = 200 * dt;
        if (speed > 0) speed = Math.max(0, speed - decay);
        else if (speed < 0) speed = Math.min(0, speed + decay);
      }

      if (inputSteer !== 0 && Math.abs(speed) > 0.001) {
        const speedFactor = Math.min(1, Math.abs(speed) / Math.max(1, controller.maxSpeed));
        const reverseSign = speed >= 0 ? 1 : -1;
        const angStep = inputSteer * (Number(controller.turnSpeed) || 0) * speedFactor * reverseSign * dt;
        transform.rotation += angStep;
        angularVelocity = angStep * Math.PI / 180 / Math.max(dt, 1e-6);
      }
    }

    speed = Math.max(
      -controller.maxSpeed * 0.5,
      Math.min(controller.maxSpeed, speed)
    );

    this._carSpeed.set(entity.id, speed);

    const rad = (transform.rotation * Math.PI) / 180;
    const forwardX = Math.sin(rad);
    const forwardY = -Math.cos(rad);
    const rightX = Math.cos(rad);
    const rightY = Math.sin(rad);

    const oldVx = Number(rigidbody.velocityX) || 0;
    const oldVy = Number(rigidbody.velocityY) || 0;
    const oldLateral = oldVx * rightX + oldVy * rightY;
    const drift = Math.max(0, Math.min(1, Number(controller.driftFactor) || 0));
    const lateral = oldLateral * drift;

    const vx = forwardX * speed + rightX * lateral;
    const vy = forwardY * speed + rightY * lateral;

    if (rigidbody.bodyType === BodyType.DYNAMIC) {
      rigidbody.driveVelocityX = vx;
      rigidbody.driveVelocityY = vy;
      rigidbody.driveAngularVelocity = angularVelocity;
    } else {
      rigidbody.velocityX = vx;
      rigidbody.velocityY = vy;
      rigidbody.angularVelocity = angularVelocity;
    }
  }

  /**
   * FOLLOW controller: moves toward a named target entity at a set
   * speed, stopping when within followDistance. Useful for simple AI
   * pursuit, escort NPCs, or camera followers. The target is looked
   * up by name every frame via World.findFirstByName.
   */
  _applyFollow(entity, controller, rigidbody, dt, world) {
    if (!controller.targetName) return;
    const target = world.findFirstByName(controller.targetName);
    if (!target) return;
    const targetTransform = target.getComponent(TRANSFORM);
    if (!targetTransform) return;

    const transform = entity.getComponent(TRANSFORM);
    if (!transform) return;

    const dx = targetTransform.x - transform.x;
    const dy = targetTransform.y - transform.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= controller.followDistance) {
      if (rigidbody.bodyType === BodyType.DYNAMIC) {
        rigidbody.driveVelocityX = 0;
        rigidbody.driveVelocityY = 0;
      } else {
        rigidbody.velocityX = 0;
        rigidbody.velocityY = 0;
      }
      return;
    }

    const vx = (dx / dist) * controller.followSpeed;
    const vy = (dy / dist) * controller.followSpeed;

    if (rigidbody.bodyType === BodyType.DYNAMIC) {
      rigidbody.driveVelocityX = vx;
      rigidbody.driveVelocityY = vy;
    } else {
      rigidbody.velocityX = vx;
      rigidbody.velocityY = vy;
    }
  }

  // After a Patrol turn, ignore wall/ledge triggers for this long
  // (seconds) before allowing another one. FIXES THE SHAKING/JITTER
  // BUG: ControllerSystem runs BEFORE PhysicsSystem each frame (same
  // ordering note as _applyDynamic/_applyKinematic above), so the very
  // frame after a turn, rigidbody.isOnWall/isOnCeiling still reflect
  // the PREVIOUS position — the body hasn't actually been swept away
  // from the wall yet. Without a cooldown, that one-frame-stale
  // isOnWall reads true again immediately, flips state.dir right back,
  // and the entity oscillates left/right every single frame instead of
  // walking away — visually a rapid shake/jitter rather than a clean
  // turn. A brief lockout gives the sweep a moment to actually move the
  // body clear of the wall before another turn can be triggered, same
  // "don't trust a contact the instant something else just changed"
  // reasoning as _applyDynamic's stillTakingOff guard.
  static PATROL_TURN_LOCKOUT = 0.15;

  /**
   * PATROL controller: by default (controller.useDefaultInput = true)
   * walks back and forth automatically, no input needed, turning
   * around whenever EITHER of these happens first:
   *   1. it touches an obstacle ahead along its patrol axis
   *   2. it has walked controller.patrolDistance px since its last turn
   * Ledge detection was deliberately left out (a separate raycast-based
   * check that was itself a source of false turns on flat ground/tile
   * seams — see the wall-jitter fix below for the same class of issue).
   * Obstacle + distance together is a clean, predictable combo: it
   * walks up to patrolDistance px and turns on its own, or turns sooner
   * if it actually hits something solid first.
   * Turning off useDefaultInput disables auto-walk/auto-turn entirely
   * and hands control to a script instead via
   * this.controller.simulateMove(x, y) (ControllerAPI.js) — the same
   * one-shot requestMoveX/Y channel the walk family already reads in
   * _applyDynamic/_applyKinematic, consumed and cleared here the same
   * way.
   * Works on both Dynamic and Kinematic bodies, same dual-path
   * convention as every other controller type in this file — Dynamic
   * seeds Rapier's gravity/velocity via driveVelocityX/Y (consumed +
   * cleared each step by PhysicsWorld.js), Kinematic simulates its own
   * gravity the same way _applyKinematic above does (reusing
   * this._verticalVelocity).
   *
   * TWO MODES (controller.patrolMode — see PatrolMode in
   * CharacterController.js):
   *   - Platformer (default — original Patrol behavior, unchanged):
   *     gravity always on, walks along X only, turns on rigidbody.isOnWall.
   *   - Top-Down: no gravity, walks along whichever single axis
   *     controller.patrolAxis picks (Horizontal or Vertical). Turn
   *     trigger reuses the same gravity-independent contact flags
   *     Platformer mode already relies on — isOnWall for Horizontal
   *     (a contact whose normal is roughly sideways), grounded/
   *     isOnCeiling for Vertical (a contact whose normal is roughly
   *     up/down) — see PhysicsWorld.js's _readContactState, which
   *     classifies contacts purely by surface normal, never by
   *     gravity, so both flags stay meaningful with gravity off.
   *     state.dir still means "+1/-1 along the chosen axis," and
   *     facingDirection/flipDirection/simulateMove(x, y) all work the
   *     same way — simulateMove's y argument, ignored in Platformer
   *     mode, becomes the driving axis in Top-Down+Vertical instead of x.
   */
  _applyPatrol(entity, controller, rigidbody, dt) {
    const transform = entity.getComponent(TRANSFORM);
    if (!transform) return;
    const entityId = entity.id;

    let state = this._patrolState.get(entityId);
    if (!state) {
      // turnLockout counts down after every turn (auto or scripted
      // direction change) — see PATROL_TURN_LOCKOUT above.
      state = { dir: 1, distance: 0, turnLockout: 0 };
      this._patrolState.set(entityId, state);
    }

    const isDynamic = rigidbody.bodyType === BodyType.DYNAMIC;
    const isTopDown = controller.patrolMode === PatrolMode.TOP_DOWN;
    const isVertical = isTopDown && controller.patrolAxis === PatrolAxis.VERTICAL;

    // Grounded state: same real-Rapier-contact reasoning as every other
    // path in this file (see _applyDynamic/_applyKinematic above) —
    // hasGroundContact() for Dynamic, rigidbody.grounded (populated by
    // PhysicsWorld.js's Kinematic sweep) for Kinematic. In Top-Down
    // mode there is no gravity, so this is never used for a fall/land
    // concept — Vertical axis reuses it purely as "hit something below"
    // (see the class doc comment above), and Horizontal/Platformer
    // still use it as the real airborne-acceleration gate it always was.
    const grounded = isDynamic
      ? (this.physicsWorld ? this.physicsWorld.hasGroundContact(entityId) : true)
      : !!rigidbody.grounded;

    if (state.turnLockout > 0) state.turnLockout = Math.max(0, state.turnLockout - dt);

    // Scripted flip: this.controller.flipDirection() (ControllerAPI.js).
    // Consumed here, BEFORE the auto/manual branch below, so it works
    // regardless of useDefaultInput — forces an immediate turn whether
    // Patrol is auto-walking or being driven manually via simulateMove.
    // Resets state.distance the same as any other turn (wall or
    // distance-based) so the next leg starts fresh, and sets
    // turnLockout so an obstacle the entity happens to be touching at
    // the same moment can't immediately flip it right back (same
    // stale-contact protection as the auto turn below).
    if (controller.requestFlip) {
      state.dir = state.dir === 1 ? -1 : 1;
      state.distance = 0;
      state.turnLockout = ControllerSystem.PATROL_TURN_LOCKOUT;
      controller._patrolFacingDirection = state.dir;
    }
    controller.requestFlip = false;

    // Scripted movement is an additional input source when default input is
    // enabled, just like Character/Platformer/Top-Down and Car. With
    // useDefaultInput=false it becomes the only source. This means a Patrol
    // can keep its automatic back-and-forth behavior while a script nudges it
    // in the same frame, or a script can take complete control.
    // Which request channel drives the patrol axis: X for
    // Platformer/Horizontal, Y for Top-Down+Vertical — see the class
    // doc comment above on simulateMove's y argument in Vertical mode.
    const useAutoWalk = controller.useDefaultInput;
    const scriptMoveRaw = isVertical
      ? (controller.requestMoveY !== null ? Number(controller.requestMoveY) : 0)
      : (controller.requestMoveX !== null ? Number(controller.requestMoveX) : 0);
    controller.requestMoveX = null;
    controller.requestMoveY = null;

    if (!useAutoWalk) {
      // Manual mode: no auto-walk/auto-turn. Script movement is the only
      // source along the patrol axis. Facing direction follows the
      // requested axis.
      const requested = Number.isFinite(scriptMoveRaw) ? scriptMoveRaw : 0;
      if (requested > 0) state.dir = 1;
      else if (requested < 0) state.dir = -1;
      controller._patrolFacingDirection = state.dir;

      const target = Math.max(-1, Math.min(1, requested)) * controller.moveSpeed;
      const lerpT = Math.min(1, controller.acceleration * (grounded || isTopDown ? 1 : controller.airControl) * dt);

      if (isTopDown) {
        // No gravity in Top-Down: drive the patrol axis directly,
        // leave the other axis at 0 (Patrol only ever moves along one
        // axis at a time, same one-axis-at-a-time design as Platformer
        // mode's X-only walk).
        if (isDynamic) {
          const cur = isVertical ? rigidbody.velocityY : rigidbody.velocityX;
          const next = cur + (target - cur) * lerpT;
          if (isVertical) { rigidbody.driveVelocityY = next; rigidbody.driveVelocityX = 0; }
          else { rigidbody.driveVelocityX = next; rigidbody.driveVelocityY = 0; }
        } else {
          if (isVertical) {
            rigidbody.velocityY += (target - rigidbody.velocityY) * lerpT;
            rigidbody.velocityX = 0;
          } else {
            rigidbody.velocityX += (target - rigidbody.velocityX) * lerpT;
            rigidbody.velocityY = 0;
          }
        }
        return;
      }

      // Platformer mode (original behavior, unchanged): X-only, gravity on.
      if (isDynamic) {
        const currentX = rigidbody.velocityX;
        rigidbody.driveVelocityX = currentX + (target - currentX) * lerpT;
        rigidbody.grounded = grounded;
      } else {
        rigidbody.velocityX += (target - rigidbody.velocityX) * lerpT;

        let vy = this._verticalVelocity.get(entityId) || 0;
        if (rigidbody.isOnCeiling && vy < 0) vy = 0;
        if (grounded) vy = 0;
        else vy += GRAVITY_Y * dt;
        this._verticalVelocity.set(entityId, vy);
        rigidbody.velocityY = vy;
      }
      return;
    }

    // TURN TRIGGER: whichever comes first — an obstacle ahead along the
    // patrol axis OR having walked controller.patrolDistance px since
    // the last turn. Ledge detection was left out (its own raycast-
    // based detection was a separate source of false turns — see the
    // removed code this replaced), but distance + obstacle together is
    // a clean, predictable combo: walk up to patrolDistance px, or turn
    // sooner if something solid is hit first.
    //
    // Which contact flag counts as "obstacle ahead" depends on the
    // patrol axis — isOnWall for Horizontal (Platformer always uses
    // this), grounded-or-isOnCeiling for Vertical (see the class doc
    // comment above on why these gravity-oriented flags are still
    // valid, gravity-independent contact reads in Top-Down mode).
    //
    // turnLockout gate: while it's still counting down after a turn,
    // ignore the obstacle flag (see PATROL_TURN_LOCKOUT's comment above
    // — this is what stops the stale-contact jitter right after a
    // turn). The distance trigger is NOT gated by turnLockout —
    // patrolDistance is an intentional walk limit, not a stale-contact
    // read, so there's nothing to protect it from; state.distance is
    // reset to 0 on every turn (obstacle or distance) so it can't
    // immediately re-trigger.
    const obstacleAhead = isVertical
      ? (state.dir > 0 ? rigidbody.isOnCeiling : grounded)
      : rigidbody.isOnWall;
    const obstacleTurn = state.turnLockout <= 0 && obstacleAhead;
    if (obstacleTurn || state.distance >= controller.patrolDistance) {
      state.dir = state.dir === 1 ? -1 : 1;
      state.distance = 0;
      state.turnLockout = ControllerSystem.PATROL_TURN_LOCKOUT;
    }
    controller._patrolFacingDirection = state.dir;

    // Automatic patrol direction and scripted input are combined on the same
    // normalized axis. A script can therefore slow, stop, or reverse the
    // automatic patrol without disabling default input.
    const scriptContribution = Number.isFinite(scriptMoveRaw) ? scriptMoveRaw : 0;
    const combined = Math.max(-1, Math.min(1, state.dir + scriptContribution));
    const target = combined * controller.moveSpeed;
    const lerpT = Math.min(1, controller.acceleration * (grounded || isTopDown ? 1 : controller.airControl) * dt);

    if (isTopDown) {
      // No gravity in Top-Down: drive the patrol axis directly, leave
      // the other axis at 0.
      if (isDynamic) {
        const cur = isVertical ? rigidbody.velocityY : rigidbody.velocityX;
        const next = cur + (target - cur) * lerpT;
        if (isVertical) { rigidbody.driveVelocityY = next; rigidbody.driveVelocityX = 0; }
        else { rigidbody.driveVelocityX = next; rigidbody.driveVelocityY = 0; }
      } else {
        if (isVertical) {
          rigidbody.velocityY += (target - rigidbody.velocityY) * lerpT;
          rigidbody.velocityX = 0;
        } else {
          rigidbody.velocityX += (target - rigidbody.velocityX) * lerpT;
          rigidbody.velocityY = 0;
        }
      }
      // Track distance walked using actual resolved speed along the
      // patrol axis, same reasoning as Platformer mode below.
      const resolvedSpeed = isDynamic
        ? (isVertical ? rigidbody.driveVelocityY : rigidbody.driveVelocityX)
        : (isVertical ? rigidbody.velocityY : rigidbody.velocityX);
      state.distance += Math.abs(resolvedSpeed || 0) * dt;
      return;
    }

    // Platformer mode (original behavior, unchanged): X-only, gravity on.
    if (isDynamic) {
      const currentX = rigidbody.velocityX;
      rigidbody.driveVelocityX = currentX + (target - currentX) * lerpT;
      rigidbody.grounded = grounded;
    } else {
      rigidbody.velocityX += (target - rigidbody.velocityX) * lerpT;

      let vy = this._verticalVelocity.get(entityId) || 0;
      const stillTakingOff = false; // Patrol never jumps — no takeoff state to protect
      const isGrounded = grounded && !stillTakingOff;
      if (rigidbody.isOnCeiling && vy < 0) vy = 0;
      if (isGrounded) vy = 0;
      else vy += GRAVITY_Y * dt;
      this._verticalVelocity.set(entityId, vy);
      rigidbody.velocityY = vy;
    }

    // Track distance walked using actual resolved horizontal speed so a
    // stall against something that doesn't count as isOnWall (e.g. a
    // trigger, or grazing acceleration ramp-up) still can't stall the
    // distance-based turn forever.
    state.distance += Math.abs(rigidbody.bodyType === BodyType.DYNAMIC ? rigidbody.driveVelocityX || 0 : rigidbody.velocityX) * dt;
  }

  destroy() {
    this.input.destroy();
  }

  /**
   * Clears controller state that belongs to the current scene while keeping
   * the shared keyboard listeners alive for the next scene.
   */
  resetScene() {
    this._verticalVelocity.clear();
    this._jumpsUsed.clear();
    this._carSpeed.clear();
    this._patrolState.clear();
    this._driveTowardReverseState.clear();
    this._driveTowardManeuver.clear();
  }
}
