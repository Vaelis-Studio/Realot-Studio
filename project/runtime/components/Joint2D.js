/**
 * runtime/components/Joint2D.js
 *
 * Plain joint data, mirrored 1:1 to a real Rapier ImpulseJoint by
 * runtime/physics/PhysicsWorld.js — same split as Rigidbody2D/
 * Collider2D: no Rapier objects and no physics math live on the
 * component itself, so it stays trivially serializable (RULES.txt
 * section 4).
 *
 * A Joint2D connects the entity it's attached to (the "self" body,
 * treated as Rapier's body1) to a second body named by
 * `connectedEntityId` (Rapier's body2). Leaving `connectedEntityId`
 * null joints the entity to a fixed point in the WORLD instead — Rapier
 * has no first-class "world anchor", so PhysicsWorld fakes one the
 * standard Rapier way: a hidden zero-size Fixed body positioned at
 * anchor2, created/owned entirely by PhysicsWorld (see
 * PhysicsWorld._getOrCreateWorldAnchor). Nothing about that hidden body
 * is visible here or in the scene file.
 *
 * jointType decides which of the type-specific fields below are
 * actually meaningful — same convention Rigidbody2D uses for
 * bodyType — the Inspector reads jointType to decide which fields to
 * show:
 *  - Fixed:      anchor1/anchor2 only. Welds the two bodies together
 *                rigidly (no relative motion at all).
 *  - Revolute:   anchor1/anchor2 (the hinge point) + the shared
 *                motor/limit fields. Free to rotate around that point.
 *  - Prismatic:  anchor1/anchor2 + axisX/axisY (the slide direction,
 *                in body1's local space) + motor/limit fields. Free to
 *                slide along that axis only.
 *  - Rope:       anchor1/anchor2 + length (maximum physical distance).
 *                PhysicsWorld builds a real multi-segment chain — small
 *                intermediate Rapier bodies, with a native RopeImpulseJoint
 *                on every span. Each span can go slack/bend but cannot extend
 *                beyond its maximum length.
 *  - Spring:     anchor1/anchor2 + length (rest length) + stiffness +
 *                damping. Same multi-segment link chain as Rope, but every
 *                span uses a native Rapier SpringImpulseJoint with this
 *                joint's stiffness/damping, so the chain can compress/stretch
 *                and oscillate naturally instead of behaving like a hard rope.
 *                No second hand-written endpoint tension is added.
 *
 * anchor1/anchor2 are each in the LOCAL space of their own body (same
 * convention Rapier itself uses — see JointData.fixed/.revolute/etc in
 * the vendored rapier2d-compat types), in this engine's pixel units.
 * anchor1 is local to the entity this component is attached to;
 * anchor2 is local to connectedEntityId's body (or, with no connected
 * entity, an offset from the world anchor point itself — effectively
 * world-space since the hidden anchor body never rotates).
 *
 * RUNTIME-ONLY FILE.
 */

export const JOINT_2D = "Joint2D";

export const JointType2D = Object.freeze({
  FIXED: "Fixed",
  REVOLUTE: "Revolute",
  PRISMATIC: "Prismatic",
  ROPE: "Rope",
  SPRING: "Spring",
});

export class Joint2D {
  constructor({
    jointType = JointType2D.REVOLUTE,

    // null = jointed to a fixed point in the world instead of another
    // body. Otherwise the id (Entity.id, e.g. "e12") of the other
    // entity — that entity needs a Rigidbody2D of its own (Static is
    // fine) for the joint to attach to; see PhysicsWorld's joint sync
    // for the "entity has no body yet" handling.
    connectedEntityId = null,

    // Local-space anchor points, in pixels — see class doc comment.
    anchor1X = 0,
    anchor1Y = 0,
    anchor2X = 0,
    anchor2Y = 0,

    // Prismatic only: slide axis, local to body1. Does not need to be
    // normalized — PhysicsWorld normalizes it before handing it to
    // Rapier (a zero-length axis falls back to (1, 0)).
    axisX = 1,
    axisY = 0,

    // Rope: total physical link-path length of the rope.
    // Spring: the rest length the endpoint spring pulls/pushes toward.
    // Unused by Fixed/Revolute/Prismatic.
    length = 100,

    // Spring only. Note these are NOT the small "intuitive" values a
    // spring might use in an SI/meters engine — Rapier computes spring
    // force from anchor distance in METERS (via World.lengthUnit, see
    // PhysicsWorld.js's LENGTH_UNIT_PX_PER_METER = 100), so at this
    // engine's pixel scale a rest-length-50px displacement is only
    // 0.5m, and gravity here (980px/s^2 = 9.8m/s^2, correctly
    // Earth-like once scaled) easily overpowers a small stiffness.
    // 5000-10000 is a reasonable starting range for a body of a few
    // dozen pixels in size; scale up further for heavier/larger bodies
    // or a stiffer feel. Values under ~500 will look like the spring
    // barely exists — the body just falls under gravity with almost no
    // pull back. Damping around 18-30 gives a responsive settle for the
    // default lightweight chain; raise it to reduce oscillation.
    stiffness = 6000,
    damping = 18,

    // Revolute only: how freely the connected body may rotate.
    // 100 = completely free hinge (normal revolute behavior), 0 = strongly
    // held near the relative angle at which the joint was created. This is
    // implemented as a torsional joint motor when no user motor is enabled,
    // rather than by changing the anchor constraint itself.
    flexibility = 100,

    // Flexible Rope/Spring physical structure. segmentCount is now the
    // actual number of real simulated link bodies PhysicsWorld builds
    // between anchor1 and anchor2 (clamped 2-32 — see the constructor
    // below), not just a visual sample count: more links means a smoother,
    // more rope-like bend and sag at the cost of a slightly heavier
    // simulation. ropeMass is the total mass of the rope, spread evenly
    // across every link (a heavier rope swings with more inertia and sags
    // more before a Spring's tension can pull it back).
    segmentCount = 18,
    ropeMass = 0.5,

    // Runtime rope/string visualization. The line is driven by the same
    // Rapier link positions used for the actual physics, so there is no
    // separate "fake sag" curve to drift away from the simulation.
    visualEnabled = true,
    visualColor = "#c8a66a",
    visualThickness = 3,

    // Optional image texture running along the rope/string instead of a
    // flat color line — same texture/mode vocabulary as StrokePath (see
    // runtime/components/StrokePath.js), so anyone who has textured a
    // StrokePath already recognizes these fields. Only used when
    // visualEnabled is also true.
    useTexture = false,
    textureKey = null,
    // "stretch": the whole image is squeezed/stretched to fit the rope's
    // current length end-to-end — warps as the rope swings and its chord
    // length changes. "tile": the image repeats at its own size along the
    // rope without stretching — textureTiling sets how many px one tile
    // covers, so a rope/chain-link texture keeps a constant apparent scale
    // no matter how the rope moves.
    textureMode = "stretch",
    textureTiling = 32,
    textureScale = 1,
    textureOffset = 0,
    textureFlip = false,

    // Revolute + Prismatic: optional min/max limit on the joint's one
    // free coordinate (degrees for Revolute, pixels for Prismatic).
    // Ignored unless limitsEnabled is true.
    limitsEnabled = false,
    limitMin = -45,
    limitMax = 45,

    // Revolute + Prismatic: optional motor driving that same free
    // coordinate. motorSpeed is in degrees/sec (Revolute) or px/sec
    // (Prismatic); motorMaxForce is the torque/force cap Rapier's
    // motor is allowed to use to reach it — 0 disables the motor
    // without needing a separate enabled flag, matching how
    // Rigidbody2D's own force fields default off. Sign/direction is
    // Rapier's own convention (relative to axis/anchor1's frame on the
    // entity this component is attached to) rather than anything this
    // engine remaps — if a motor drives the "wrong" way for your
    // setup, negate motorSpeed rather than flipping axisX/axisY (which
    // also changes the limit direction).
    motorEnabled = false,
    motorSpeed = 0,
    motorMaxForce = 0,

    // Revolute-only passive rotational response. Zero means the hinge is
    // genuinely free and no passive motor constraint is configured.
    jointDrag = 0,
    restStiffness = 0,

    // Revolute-only structural failure. Break force is measured in the
    // engine's force units and evaluated from the joint constraint demand.
    breakable = false,
    breakForce = 10000,

    // When enabled, only this joint's two connected entities stop
    // generating contact pairs with one another. Their collision layers
    // and interactions with every other entity remain unchanged.
    disableConnectedCollision = false,
    // Legacy scene/script field. Its old value was not applied to
    // contact filtering, so stored values are ignored when loading.
    collideConnected = undefined,

    // Editor/gizmo convenience only — never read by PhysicsWorld.
    enabled = true,
  } = {}) {
    this.jointType = jointType;
    this.connectedEntityId = connectedEntityId;

    this.anchor1X = anchor1X;
    this.anchor1Y = anchor1Y;
    this.anchor2X = anchor2X;
    this.anchor2Y = anchor2Y;

    this.axisX = axisX;
    this.axisY = axisY;

    this.length = length;
    this.stiffness = stiffness;
    this.damping = damping;

    this.flexibility = Math.max(0, Math.min(100, Number(flexibility) || 0));

    this.segmentCount = Math.max(2, Math.min(32, Math.round(Number(segmentCount) || 18)));
    this.ropeMass = Math.max(0, Number(ropeMass) || 0);
    this.visualEnabled = !!visualEnabled;
    this.visualColor = visualColor || "#c8a66a";
    this.visualThickness = Math.max(0.5, Number(visualThickness) || 3);

    this.useTexture = !!useTexture;
    this.textureKey = textureKey || null;
    this.textureMode = textureMode === "tile" ? "tile" : "stretch";
    this.textureTiling = Math.max(1, Number(textureTiling) || 32);
    this.textureScale = Number(textureScale) || 1;
    this.textureOffset = Number(textureOffset) || 0;
    this.textureFlip = !!textureFlip;

    this.limitsEnabled = limitsEnabled;
    this.limitMin = limitMin;
    this.limitMax = limitMax;

    this.motorEnabled = !!motorEnabled;
    this.motorSpeed = Number(motorSpeed) || 0;
    this.motorMaxForce = Math.max(0, Number(motorMaxForce) || 0);

    this.jointDrag = Math.max(0, Number(jointDrag) || 0);
    this.restStiffness = Math.max(0, Number(restStiffness) || 0);
    this.breakable = !!breakable;
    this.breakForce = Math.max(0, Number(breakForce) || 0);

    this.disableConnectedCollision = !!disableConnectedCollision;

    this.enabled = enabled;
  }

  // Compatibility alias for scripts using the previous Rapier-style
  // setting. New projects should use disableConnectedCollision.
  get collideConnected() {
    return !this.disableConnectedCollision;
  }

  set collideConnected(value) {
    this.disableConnectedCollision = !Boolean(value);
  }
}
