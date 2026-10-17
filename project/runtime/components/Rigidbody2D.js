/**
 * runtime/components/Rigidbody2D.js
 *
 * Plain physics-body data, mirrored 1:1 to a real Rapier RigidBody by
 * runtime/physics/PhysicsWorld.js — no physics math and no Rapier
 * objects live on the component itself, so it stays trivially
 * serializable (RULES.txt section 4).
 *
 * bodyType decides which fields are actually meaningful:
 *  - Dynamic:   full simulation. mass/gravityScale/damping/lockRotation
 *               all apply; Rapier integrates forces + collisions. A
 *               CharacterController (see components/CharacterController.js)
 *               can still drive a Dynamic body's velocity directly —
 *               see the driveVelocityX/driveVelocityY fields below —
 *               while Rapier's own gravity/solver still owns everything
 *               else (falling, being pushed, landing).
 *  - Kinematic: moved by code/animation, not forces. Only velocity
 *               (used to move it) and lockRotation apply; mass, drag,
 *               and gravity are ignored by a kinematic body.
 *  - Static:    never moves. None of the dynamic-only fields apply —
 *               only the body exists as an immovable collider anchor.
 * The Inspector (editor/panels/Inspector.js) reads bodyType to decide
 * which of these fields to actually show, matching Unity's convention
 * of hiding body-type-irrelevant settings.
 *
 * RUNTIME-ONLY FILE.
 */

export const RIGIDBODY_2D = "Rigidbody2D";

export const BodyType = Object.freeze({
  DYNAMIC: "Dynamic",
  KINEMATIC: "Kinematic",
  STATIC: "Static",
});

// Native point-force requests live outside the serializable component so a
// script can apply multiple forces at arbitrary world-space points in one
// frame without polluting scene JSON with transient physics state.
const pendingPointForces = new WeakMap();

/** Queue one world-space force at one world-space point for the next physics step. */
export function queueForceAtPoint(rb, forceX, forceY, pointX, pointY) {
  if (!rb || !Number.isFinite(forceX) || !Number.isFinite(forceY) ||
      !Number.isFinite(pointX) || !Number.isFinite(pointY)) return;
  let list = pendingPointForces.get(rb);
  if (!list) { list = []; pendingPointForces.set(rb, list); }
  list.push({ forceX, forceY, pointX, pointY });
}

/** Drain and clear all point-force requests queued for this physics frame. */
export function drainPendingPointForces(rb) {
  const list = pendingPointForces.get(rb);
  if (!list) return [];
  pendingPointForces.delete(rb);
  return list;
}

/**
 * Marks entity.x/y as an intentional TELEPORT, for PhysicsWorld to
 * apply to the live Rapier body — see Rigidbody2D's
 * _scriptPositionTargetX/Y doc comment above for the full "why".
 *
 * Called from every script-facing write path that sets Transform
 * position directly: EntityContext's this.x/this.y/this.position
 * setters (ScriptAPI.js) and this.transform.position (TransformAPI.js).
 * A no-op (besides the ordinary Transform write those callers already
 * do) when the entity has no Rigidbody2D at all, or when it's Static —
 * Static already re-syncs Transform->Rapier every frame unconditionally
 * (see PhysicsWorld._syncEntity), so it needs no special-casing here.
 *
 * @param {import('../core/Entity.js').Entity} entity
 * @param {number} x @param {number} y the NEW Transform position, in
 *   world units, already written to Transform.x/y by the caller
 */
export function markScriptPositionTarget(entity, x, y) {
  var rb = entity.getComponent ? entity.getComponent(RIGIDBODY_2D) : null;
  if (!rb || rb.bodyType === BodyType.STATIC) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  rb._scriptPositionTargetX = x;
  rb._scriptPositionTargetY = y;
}

/**
 * Drops every force/impulse/torque/move request queued on a body. A
 * queued request only makes sense for the body type it was queued
 * under (a force queued while Dynamic must not silently apply the
 * moment the body becomes Dynamic again after a detour through
 * Kinematic), so this runs whenever a body's type changes — see
 * PhysicsWorld._syncEntity and RigidbodyAPI's `type` setter.
 *
 * @param {Rigidbody2D} rb
 */
export function clearPendingBodyRequests(rb) {
  rb.pendingForceX = 0;
  rb.pendingForceY = 0;
  rb.pendingImpulseX = 0;
  rb.pendingImpulseY = 0;
  rb.pendingTorque = 0;
  rb.pendingAngularImpulse = 0;
  rb.pendingMoveX = null;
  rb.pendingMoveY = null;
  pendingPointForces.delete(rb);
}

/**
 * Handshake between a script's `this.rigidbody.type = ...` and
 * PhysicsWorld._syncEntity.
 *
 * PhysicsWorld drops queued force/impulse/move requests when it
 * rebuilds a body for a new type (see clearPendingBodyRequests) — but
 * it does that on the NEXT physics step, long after the script's
 * onUpdate ran. Without this handshake, `type = "Dynamic"` followed
 * right away by `addImpulse(...)` in the same frame would have that
 * impulse silently wiped by the rebuild, since PhysicsWorld can't
 * tell a stale request queued BEFORE the switch from a fresh one
 * queued AFTER it.
 *
 * So the `type` setter drops the stale requests itself, at the moment
 * of the switch, then adds the Rigidbody2D here. PhysicsWorld sees the
 * mark on its next sync of that body, skips its own (now redundant)
 * clear, and consumes the mark — anything queued since the switch is
 * fresh and survives.
 *
 * A WeakSet, not a field on the component: a component's own fields
 * are all serialized (JSON.stringify — see SceneSerializer.js), and
 * this is a transient one-frame flag that must never end up in a
 * scene file. A WeakSet also can't leak a body that gets deleted.
 *
 * @type {WeakSet<Rigidbody2D>}
 */
export const bodyTypeSwitchHandled = new WeakSet();

export class Rigidbody2D {
  constructor({
    bodyType = BodyType.DYNAMIC,
    simulated = true,

    // Dynamic-only
    mass = 1,
    autoMass = true,
    gravityScale = 1,
    linearDamping = 0,
    angularDamping = 0,

    // Dynamic + Kinematic
    lockRotation = false,

    // working velocity — for Dynamic this is read back FROM Rapier each
    // frame (unless driveVelocityX below is set by a controller this
    // same frame); for Kinematic this is the velocity the caller/script
    // sets to drive the body (consumed by PhysicsWorld as a kinematic
    // move).
    velocityX = 0,
    velocityY = 0,
    angularVelocity = 0,

    // Set (transiently, one frame at a time) by
    // runtime/systems/ControllerSystem.js to drive a DYNAMIC body's
    // horizontal speed via Rapier's setLinvel while leaving the Y axis
    // (and therefore Rapier's own gravity/impulse integration) alone.
    // null = no controller is driving this body's X this frame, so
    // PhysicsWorld leaves Rapier's own solver-computed velocity as-is.
    // Plain data (RULES.txt section 4) — not a function/callback.
    driveVelocityX = null,
    // Set (transiently, one frame) by ControllerSystem to override a
    // DYNAMIC body's Y velocity this physics step — used both for a
    // one-shot jump kick (Character Controller/Platformer) and for
    // continuous Y drive (Top-Down, which has no gravity to preserve).
    // null = no override requested; Rapier's own gravity/solver keeps
    // integrating Y normally.
    driveVelocityY = null,
    // Private transient override written by the scripting API when a
    // Kinematic script directly assigns `this.rigidbody.velocityY`.
    // ControllerSystem consumes this before applying its own Platformer
    // gravity so a script-authored jump is not overwritten on the next
    // controller tick. It is deliberately not serialized.
    _scriptVelocityY = null,
    // Private transient exact rotation target written by the scripting API
    // when a Kinematic script assigns `this.rotation`. A script assignment
    // is an exact snap/target; it must not be blended with angularVelocity
    // on the same frame, otherwise a grounded square can visibly rock around
    // the requested angle. This is transient and not serialized.
    _scriptRotationTarget = null,
    // Private transient exact POSITION target written by the scripting
    // API when a script assigns this.x/this.y/this.position or
    // this.transform.position on an entity that also has a Rigidbody2D
    // — i.e. a script explicitly TELEPORTING a Dynamic or Kinematic
    // body, as opposed to letting Rapier's own simulation move it.
    // Same rationale as _scriptRotationTarget just above: Dynamic and
    // Kinematic bodies own their position once created (see
    // PhysicsWorld.js's _syncEntity, which deliberately does NOT sync
    // Transform->Rapier every frame for those two body types, unlike
    // Static), so without this flag a script's `this.x = 500` would
    // write Transform.x for exactly one frame and then get silently
    // overwritten right back by PhysicsWorld's own post-step
    // Rapier->Transform sync — the body would visually snap back to
    // where physics had it, never actually teleporting.
    // null = no teleport requested this frame. Set together (both
    // non-null at once) by TransformAPI.js/ScriptAPI.js's EntityContext
    // — see PhysicsWorld.js's _applyScriptPositionTarget for the
    // consuming side. Deliberately not serialized (transient, one-shot,
    // cleared the instant it's applied).
    _scriptPositionTargetX = null,
    _scriptPositionTargetY = null,
    // Set (transiently, one frame) by ControllerSystem to drive a
    // DYNAMIC body's angular velocity (e.g. Car controller steering).
    // null = no override; Rapier's own solver keeps integrating
    // rotation normally.
    driveAngularVelocity = null,

    // Read-only contact state: written every physics step from Rapier
    // contact manifolds. Movement behavior does not own or fake this state.
    grounded = false,

    // KINEMATIC-only, read-only: written every physics step with the
    // ACTUAL movement that the kinematic target-motion query resolved
    // after blocking/sliding against obstacles. velocityX/Y stay as the
    // intended input and are NOT clobbered, so ControllerSystem's
    // acceleration lerp (and any script driving a kinematic body) keeps
    // working from intent rather than feeding a collision-blocked value
    // back into itself — which previously decelerated a kinematic body
    // every time it pushed a dynamic body (a real kinematic body has
    // infinite mass and must never slow from a collision). Read this
    // when you need "did the body actually move / how fast this step",
    // not velocityX/Y. Always 0 for Dynamic/Static bodies.
    resolvedVelocityX = 0,
    resolvedVelocityY = 0,

    // DYNAMIC-only force/impulse queue: pushed by the scripting API's
    // DynamicRigidbodyAPI (see scripting/components/RigidbodyAPI.js) via
    // .addForce()/.addImpulse()/.addTorque() and drained by
    // PhysicsWorld._syncEntity every physics step, exactly like
    // driveVelocityX/Y above — plain, serializable data (RULES.txt
    // section 4), never a function/callback, and never meaningful for
    // Kinematic/Static bodies (which have no force integration at all).
    pendingForceX = 0,
    pendingForceY = 0,
    pendingImpulseX = 0,
    pendingImpulseY = 0,
    pendingTorque = 0,
    pendingAngularImpulse = 0,
  } = {}) {
    this.bodyType = bodyType;
    this.simulated = simulated;

    this.mass = Math.max(0.0001, Number(mass) || 1);
    this.autoMass = !!autoMass;
    this.gravityScale = gravityScale;
    this.linearDamping = linearDamping;
    this.angularDamping = angularDamping;

    this.lockRotation = lockRotation;

    this.velocityX = velocityX;
    this.velocityY = velocityY;
    this.angularVelocity = angularVelocity;

    this.driveVelocityX = driveVelocityX;
    this.driveVelocityY = driveVelocityY;

    this.driveAngularVelocity = driveAngularVelocity;

    this.grounded = grounded;

    this.resolvedVelocityX = resolvedVelocityX;
    this.resolvedVelocityY = resolvedVelocityY;

    this.pendingForceX = pendingForceX;
    this.pendingForceY = pendingForceY;
    this.pendingImpulseX = pendingImpulseX;
    this.pendingImpulseY = pendingImpulseY;
    this.pendingTorque = pendingTorque;
    this.pendingAngularImpulse = pendingAngularImpulse;

    // KINEMATIC-only one-shot move request: set (transiently, one frame)
    // by the scripting API's KinematicRigidbodyAPI.move(dx, dy) — a
    // direct positional nudge for a kinematic mover, swept through the
    // SAME character-controller path as velocity-driven movement (so it
    // still gets blocked/slid by obstacles) rather than a raw teleport.
    // null = no move requested this frame.
    this.pendingMoveX = null;
    this.pendingMoveY = null;

    // Unity-style contact-state flags. These are derived from Rapier's
    // real contact normals for any non-static body (Dynamic AND
    // Kinematic — see PhysicsWorld.js's _readContactState, which is
    // explicitly shared by both movement types), regardless of movement
    // type.
    //
    // isOnCeiling: touching a surface above (normal pushes character down)
    // isOnWall:    touching a wall laterally (normal is mostly horizontal)
    // isOnSlope:   grounded on a non-flat surface (groundAngle >= slopeMinAngle)
    // groundAngle: angle of the ground surface in degrees from horizontal
    //              (0 = flat, 45 = steep slope, up to the groundAngleLimit)
    this.isOnCeiling = false;
    this.isOnWall = false;
    this.isOnSlope = false;
    this.groundAngle = 0;
    // Last grounded contact normal in the engine's world convention.
    // Transient/read-only; updated by PhysicsWorld after each step.
    this._groundNormalX = 0;
    this._groundNormalY = 1;

    // USER-configurable angle thresholds (degrees), read by
    // PhysicsWorld.js's _readContactState for BOTH Dynamic and
    // Kinematic bodies (Static bodies never move, so these have no
    // effect on them). These let scripts define exactly what counts as
    // ground, slope, and wall for THIS body — no global constant to
    // edit, no engine rebuild.
    //
    // groundAngleLimit: contacts whose normal is within this angle of
    //   world-up are treated as walkable ground (and tracked for
    //   isGrounded/groundAngle). Contacts steeper than this are either
    //   walls or unclimbable slopes. Default 45° matches Unity's
    //   CharacterController.slopeLimit default and Rapier's own example.
    //   Script: this.rigidbody.groundAngleLimit = 60
    //
    // wallAngleLimit: contacts between groundAngleLimit and this angle
    //   are "too steep to walk on" but are NOT walls — they are
    //   unclimbable slopes. Only contacts at or above this angle (i.e.
    //   nearly vertical) set isOnWall. Default 70°.
    //   Script: this.rigidbody.wallAngleLimit = 80
    //
    // slopeMinAngle: minimum groundAngle (degrees) before isOnSlope
    //   becomes true. Contacts below this are treated as flat ground.
    //   Default 10° (raised from the old 5° to reduce false positives
    //   from floating-point noise on flat floors). If slopeMinAngle is
    //   lower than or equal to groundAngleLimit, a walkable slope can report
    //   BOTH grounded and isOnSlope. Equality is inclusive. A value above
    //   groundAngleLimit leaves no overlap and logs a warning once.
    //   Script: this.rigidbody.slopeMinAngle = 15
    this.groundAngleLimit = 45;
    this.wallAngleLimit   = 70;
    this.slopeMinAngle    = 10;
  }
}
