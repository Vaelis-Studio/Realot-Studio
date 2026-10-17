/**
 * runtime/physics/PhysicsWorld.js
 *
 * Owns the real Rapier2D physics simulation and keeps it in sync with
 * the ECS: for every entity with a Rigidbody2D (and/or Collider2D) it
 * creates/updates a matching Rapier RigidBody + Collider, steps the
 * Rapier world each tick, and writes the resulting position/rotation
 * back onto that entity's Transform. No collision math, no AABB sweep,
 * no custom solver of any kind lives here or anywhere else in the
 * engine — Rapier is the single source of truth for all collision
 * detection and resolution.
 *
 * Units: this engine is 1 world-unit = 1 pixel everywhere (Transform,
 * Camera resolution, etc — see runtime/core/CameraUtils.js). Every
 * position/size passed to Rapier below stays in that same pixel space —
 * there is NO coordinate conversion layer, and nothing outside this
 * file needs to know Rapier is involved at all. The only physics-scale
 * concern is Rapier's internal SOLVER TOLERANCES (contact/penetration/
 * sleep thresholds), which assume ~1-unit objects by default; that is
 * handled once, below, via World.lengthUnit — see the comment there.
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../components/Transform.js";
import { RIGIDBODY_2D, BodyType, bodyTypeSwitchHandled, clearPendingBodyRequests, drainPendingPointForces } from "../components/Rigidbody2D.js";
import { COLLIDER_2D, ColliderShape, makeCollisionGroups } from "../components/Collider2D.js";
import { JOINT_2D, JointType2D } from "../components/Joint2D.js";
import { TILEMAP } from "../components/Tilemap.js";
import { TILESET } from "../components/Tileset.js";
import { getColliderWorldGeometry } from "./ColliderGeometry.js";
import { loadRapier } from "./RapierLoader.js";
import { CHARACTER_CONTROLLER } from "../components/CharacterController.js";

const GRAVITY_Y = 980; // px/s^2 downward — same constant the old stub integrator used

// Rapier's solver internally assumes "human scale" objects are ~1 unit
// (1 meter) — its contact/penetration/sleep tolerances are all derived
// from that assumption. This engine works entirely in pixels (1 unit =
// 1 pixel), where a typical object is ~100 units, i.e. ~100x too big
// for those tolerances. Rather than rewriting every position/size in
// the engine into meters, Rapier's World.lengthUnit tells the solver
// "100 of your units = 1 of my meters" so it rescales its internal
// thresholds to match — this is Rapier's own documented fix for
// exactly this pixel-scale mismatch, and it requires no coordinate
// conversion anywhere else: Transform, the Collider2D gizmo, and scene
// files all keep using plain pixels, unaffected.
const LENGTH_UNIT_PX_PER_METER = 100;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const GROUND_STATE_ANGLE_EPS_DEG = 1e-3;

// Default contact classification thresholds. Movement behavior may override
// these per Rigidbody2D, while Rapier remains responsible for the actual
// collision solve and contact manifolds.
const SLOPE_LIMIT_DEG = 45;
const WALL_ANGLE_DEG = 70;
// Kinematic bodies are intentionally infinite-mass in Rapier, so a direct
// contact can transfer their full normal velocity to a resting Dynamic body
// in one frame. That is physically valid but feels like a shove for game
// movers/platforms. Blend only the contact-normal component over time;
// tangential motion and Rapier's actual collision resolution remain intact.
const KINEMATIC_PUSH_MAX_ACCEL = 1400; // px/s^2, bounded pre-contact carry

// Rapier's joint solver (used for every Rope/Spring chain — see
// _buildFlexibleJoint's INTERNAL_LINK_STIFFNESS/DAMPING) is tuned assuming
// a CONSTANT timestep. Before this fix, step() fed Rapier the raw
// render-frame dt (whatever requestAnimationFrame happened to measure that
// tick — 14ms, 18ms, 22ms after a hitch, etc). A stiff spring chain's
// response changes with timestep, so a timestep that changes every single
// frame made every rope/string visibly vibrate/shimmer even though nothing
// about the actual physics setup was wrong — rigid bodies and colliders
// stayed visually stable because they aren't driven by a stiff spring
// solve, which is exactly why only rope/joint visuals showed it.
//
// Fix: decouple Rapier's timestep from render dt with a standard fixed-
// timestep accumulator. Rapier always steps by exactly FIXED_PHYSICS_DT;
// leftover time carries over in _physicsAccumulator instead of being
// baked into that step's timestep. This keeps real-time simulation speed
// correct (no slow-mo/fast-forward — averaged over multiple frames the
// game still simulates exactly as much time as actually passed) while
// giving the joint solver the stable timestep it needs.
const FIXED_PHYSICS_DT = 1 / 60;
// Safety cap on substeps per rendered frame so a long stall (tab-out,
// breakpoint, slow device) can't force an unbounded catch-up burst; any
// remaining accumulated time beyond this is simply dropped, same spirit
// as the existing stepDt clamp this replaces.
const MAX_PHYSICS_SUBSTEPS_PER_FRAME = 4;


function rapierBodyType(RAPIER, bodyType) {
  switch (bodyType) {
    case BodyType.STATIC:
      return RAPIER.RigidBodyType.Fixed;
    case BodyType.KINEMATIC:
      // Position-based (not velocity-based): a KinematicVelocityBased
      // body's trajectory is NEVER corrected by Rapier no matter what
      // it hits — that body type only generates contact events, it
      // does not get blocked (see Rapier's own docs: kinematic bodies
      // are moved by the user and are "independent from any contact").
      // below to sweep-test the desired movement against obstacles
      // and get back a corrected (blocked/slid) movement to apply.
      return RAPIER.RigidBodyType.KinematicPositionBased;
    case BodyType.DYNAMIC:
    default:
      return RAPIER.RigidBodyType.Dynamic;
  }
}

export class PhysicsWorld {
  constructor() {
    /** @type {any} Rapier is loaded from the checked-in browser bundle. */
    this.RAPIER = null;
    /** @type {any} */
    this.rapierWorld = null;
    this.ready = false;

    // Leftover render-frame time not yet consumed by a fixed physics
    // substep — see FIXED_PHYSICS_DT above and its use in step() below.
    this._physicsAccumulator = 0;

    /** @type {Map<string, { body: object, collider: object|null, bodyType: string, _colliderRef: object|null }>} entityId -> handles. Also carries cached _sig* fields used by _syncCollider's cheap per-frame dirty-check (see that method). */
    this._handles = new Map();
    // Per-tilemap-cell static colliders: each Tilemap entity whose
    // cells map to solid ground gets a single STATIC Rapier body, and
    // one cuboid collider per painted cell (sized to the referenced
    // Tileset's tileWidth/tileHeight, positioned in the body's local
    // frame at (col+0.5)*tw, (row+0.5)*th — matching
    // TilemapSystem.js's per-tile placement). This is what makes a
    // painted tilemap act as real collision geometry in Play mode,
    // so the player/kinematic/dynamic bodies land on and bump into
    // individual tiles instead of falling through the floor.
    this._tilemapBodies = new Map(); // entityId -> RigidBody
    this._tilemapCellColliders = new Map(); // entityId -> Map<cellKey, Collider>
    this._tilemapBodySig = new Map(); // entityId -> "tw,th"

    /** entityId (of the entity the Joint2D is attached to) -> {
     *    joint: ImpulseJoint, sig: string (cache key — see _syncJoints),
     *    body1: RigidBody, body2: RigidBody
     *  }. One entry per Joint2D component currently backed by a live
     * Rapier joint — see _syncJoints. */
    this._joints = new Map();
    /** Canonical entity-id pairs excluded from contact generation by an
     * enabled Joint2D. */
    this._disabledJointCollisionPairs = new Set();
    /** connectedEntityId=null anchor point -> a hidden zero-size Fixed
     * RigidBody PhysicsWorld itself owns, standing in for Rapier's lack
     * of a first-class "world anchor" (see Joint2D.js's header comment).
     * Keyed by "x,y" (already-rounded pixel anchor position) so two
     * Joint2D components anchored to the same world point share one
     * hidden body instead of each getting their own. */
    this._worldAnchorBodies = new Map(); // "x,y" -> RigidBody

    
    /** Reverse map from Rapier collider handle index → entityId for event dispatch */
    this._colliderHandleMap = new Map();
    /** Set of Rapier collider handle indices currently flagged
     * isOneWayPlatform=true (see Collider2D.js). Populated/pruned in
     * _syncCollider alongside _colliderHandleMap so it never drifts out
     * of sync with which colliders actually have FILTER_CONTACT_PAIRS
     * active. Read by the PhysicsHooks.filterContactPair passed to
     * rapierWorld.step() below. */
    this._oneWayPlatformHandles = new Set();
    /** Rapier collider handle → cached world geometry used by the
     * one-way filter. The cache is refreshed every _syncCollider call
     * (every frame, for every collider), because filterContactPair runs
     * inside Rapier's solve and cannot safely query Rapier-owned state.
     *
     * The important fields are BOTH current and previous vertical support
     * edges. They include body rotation, so an unlocked Dynamic box that
     * spins in place cannot make the one-way test use the old, unrotated
     * halfHeight and accidentally classify the body as having stayed above
     * the platform when its real lowest point has moved through it. */
    this._colliderWorldBoundsCache = new Map();
    /** Current solid contact pairs. Keys are stable entity-id pairs. */
    this._activeSolidContacts = new Map();
    /** Rapier EventQueue used to drain collision/trigger events after each step */
    this._eventQueue = null;
    // Stable PhysicsHooks object passed to rapierWorld.step() whenever a
    // one-way platform or connected-pair exclusion exists (see step()).
    // The callback reads live state via `this`.
    this._oneWayPlatformHooks = {
      filterContactPair: this._filterContactPair.bind(this),
      // Contact filtering must not change sensor/trigger intersections.
      filterIntersectionPair: () => true,
    };

    this._readyPromise = loadRapier().then((RAPIER) => {
      this.RAPIER = RAPIER;
      this.rapierWorld = new RAPIER.World({ x: 0, y: GRAVITY_Y });
      this.rapierWorld.lengthUnit = LENGTH_UNIT_PX_PER_METER;
      // Improve anchor and chain convergence without changing the fixed
      // timestep that keeps the simulation stable across render rates.
      this.rapierWorld.numSolverIterations = 12;
      // Two internal PGS iterations improve stiff articulated chains without
      // paying the full cost of doubling outer solver iterations. Rapier
      // documents both controls as stability/rigidity tuning knobs.
      this.rapierWorld.numInternalPgsIterations = 2;
      // More CCD continuation steps prevent fast ragdoll limbs/rope weights
      // from tunneling after an impact. CCD remains body-opt-in below.
      this.rapierWorld.maxCcdSubsteps = 4;
      // true = drains intersection (sensor) events in addition to contact events
      this._eventQueue = new RAPIER.EventQueue(true);


      this.ready = true;
    });
  }

  /** @returns {Promise<void>} resolves once Rapier's WASM is loaded and the world exists */
  whenReady() {
    return this._readyPromise;
  }

  /**
   * Finds every entity whose Collider2D shape actually contains the
   * given WORLD-space point — i.e. real shape-accurate hit-testing
   * (box/circle/capsule/triangle, including rotation), not just a
   * bounding-box check. This is what powers mouse.clickedOn(),
   * this.isClicked, and mouse.isOver() in ScriptAPI — Rapier is
   * already tracking every one of these shapes for physics, so this
   * reuses that instead of reimplementing per-shape point tests.
   *
   * Returns entities ordered arbitrarily (Rapier's own broad-phase
   * order, not z/depth order) — if several overlapping colliders
   * contain the point, ALL of them are returned; the caller decides
   * what "the" clicked object means for its use case.
   *
   * @param {number} x world-space x
   * @param {number} y world-space y
   * @returns {string[]} entityIds whose collider contains the point (possibly empty)
   */
  entityAtPoint(x, y) {
    if (!this.ready || !this.rapierWorld) return [];
    const found = [];
    const point = { x, y };
    this.rapierWorld.intersectionsWithPoint(point, (collider) => {
      const entityId = this._colliderHandleMap.get(collider.handle);
      if (entityId) found.push(entityId);
      return true; // keep searching — a point can be inside multiple overlapping colliders
    });
    return found;
  }

  /**
   * True if entityId's collider is CURRENTLY touching anything (no
   * otherEntityId given), or specifically touching otherEntityId (if
   * given). Backs this.collider.isColliding() / this.collider.isColliding
   * (other) — see ColliderAPI.js.
   *
   * Reads the current solid-contact set rebuilt directly from Rapier
   * contact manifolds after each physics step. Trigger overlaps are kept
   * separate and are reported through the trigger callbacks.
   */
  isColliding(entityId, otherEntityId) {
    for (const pair of this._activeSolidContacts.values()) {
      if (otherEntityId) {
        if ((pair.id1 === entityId && pair.id2 === otherEntityId) ||
            (pair.id2 === entityId && pair.id1 === otherEntityId)) return true;
      } else if (pair.id1 === entityId || pair.id2 === entityId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Return this collider's contact normal in WORLD space. Rapier's
   * localNormal1/localNormal2 are expressed in the corresponding shape's
   * local frame, so a rotated collider must rotate its own normal before any
   * ground/wall classification or velocity projection uses it.
   */
  _selfContactNormal(collider, manifold, flipped) {
    try {
      const local = flipped ? manifold.localNormal2() : manifold.localNormal1();
      if (!local) return null;
      return this._worldTargetNormal(collider, local);
    } catch (_) {
      return null;
    }
  }


  /**
   * Shape-cast normals are local to the hit collider. Convert the normal on
   * collider #2 into world space before using it for sliding/projection.
   * This makes rotated boxes, capsules and triangles use their real contact
   * surface rather than an assumed axis-aligned normal.
   */
  _worldTargetNormal(collider, localNormal) {
    const nx = Number(localNormal?.x) || 0;
    const ny = Number(localNormal?.y) || 0;
    const len = Math.hypot(nx, ny);
    if (len < 1e-7) return { x: 0, y: 0 };

    let angle = 0;
    try {
      const body = typeof collider?.parent === "function" ? collider.parent() : null;
      if (body && typeof body.rotation === "function") angle = Number(body.rotation()) || 0;
    } catch (_) {}

    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return {
      x: (nx * c - ny * s) / len,
      y: (nx * s + ny * c) / len,
    };
  }

  /**
   * ShapeContact normals from Collider.contactCollider() are already in
   * WORLD space (unlike ColliderShapeCastHit normals from castCollider(),
   * which are local-frame and must go through _worldTargetNormal). Passing
   * a contactCollider() normal through _worldTargetNormal rotates an
   * already-world vector a second time by the collider's own body angle --
   * harmless at zero rotation, but as the body rotates it progressively
   * skews a stable normal (e.g. a flat floor contact) toward an incorrect
   * direction, which can make a support contact misread as a wall. Use this
   * helper for any normal that came from contactCollider()/ShapeContact.
   */
  _normalizeWorldContactNormal(localNormal) {
    const nx = Number(localNormal?.x) || 0;
    const ny = Number(localNormal?.y) || 0;
    const len = Math.hypot(nx, ny);
    if (len < 1e-7) return { x: 0, y: 0 };
    return { x: nx / len, y: ny / len };
  }

  /**
   * Reads ground/wall/ceiling state directly from Rapier contact manifolds.
   * This is shared by Dynamic and Kinematic bodies so movement type never
   * changes what collision state means.
   */
  _readContactState(collider, rb) {
    const result = { grounded: false, isOnWall: false, isOnCeiling: false, isOnSlope: false, groundAngle: 0, groundNormalX: 0, groundNormalY: 1, _bestGroundNy: -Infinity };
    if (!collider || collider.isSensor?.()) return result;

    const groundLimit = Math.max(0, Math.min(89.9, rb?.groundAngleLimit ?? SLOPE_LIMIT_DEG));
    const wallLimit = Math.max(0, Math.min(89.9, rb?.wallAngleLimit ?? WALL_ANGLE_DEG));
    const slopeMin = Math.max(0, Math.min(89.9, rb?.slopeMinAngle ?? 10));
    const minGroundY = Math.cos(groundLimit * DEG2RAD);

    // groundAngle can never exceed groundAngleLimit — anything steeper
    // stops counting as "grounded" at all (see the ny >= minGroundY
    // check below) and is classified as a wall/unclimbable slope
    // instead. If slopeMinAngle is set above groundAngleLimit, no contact
    // can satisfy both thresholds. Equality is valid and inclusive, so a
    // surface exactly at both limits can report BOTH grounded and isOnSlope.
    // Warn once per body for the no-overlap configuration
    // rather than silently doing nothing, since this is a genuine
    // config mistake, not a normal runtime condition — and deliberately
    // just a warning, not an auto-clamp: clamping would quietly change
    // a value the user explicitly set without telling them.
    if (rb && slopeMin > groundLimit + GROUND_STATE_ANGLE_EPS_DEG && !rb._warnedSlopeMinExceedsGroundLimit) {
      rb._warnedSlopeMinExceedsGroundLimit = true;
      console.warn(
        "[Physics] slopeMinAngle (" + slopeMin + "\u00b0) is greater than groundAngleLimit (" + groundLimit + "\u00b0) " +
        "on a Rigidbody2D. No surface can satisfy both thresholds, so isOnSlope cannot be true " +
        "while grounded with this combination. Lower slopeMinAngle or raise groundAngleLimit."
      );
    }

    try {
      this.rapierWorld.contactPairsWith(collider, (other) => {
        if (!other || other === collider || other.isSensor?.()) return;
        this.rapierWorld.contactPair(collider, other, (manifold, flipped) => {
          if (!manifold || (typeof manifold.numContacts === 'function' && manifold.numContacts() <= 0)) return;
          const n = this._selfContactNormal(collider, manifold, flipped);
          if (!n) return;
          const nx = Number(n.x) || 0;
          const ny = Number(n.y) || 0;
          if (ny >= minGroundY) {
            result.grounded = true;
            const angle = Math.acos(Math.max(-1, Math.min(1, ny))) * RAD2DEG;
            if (ny > result._bestGroundNy) {
              result._bestGroundNy = ny;
              result.groundNormalX = nx;
              result.groundNormalY = ny;
            }
            result.groundAngle = Math.max(result.groundAngle, angle);
          } else if (ny < 0 && Math.abs(ny) >= Math.cos(wallLimit * DEG2RAD)) {
            result.isOnCeiling = true;
          } else if (Math.abs(nx) >= Math.sin(wallLimit * DEG2RAD)) {
            result.isOnWall = true;
          }
        });
      });
    } catch (_) {
      return result;
    }

    result.isOnSlope = result.grounded &&
      result.groundAngle + GROUND_STATE_ANGLE_EPS_DEG >= slopeMin;
    delete result._bestGroundNy;
    return result;
  }

  _hasNearbyGroundSupport(collider, rb, maxDistance = 1.0) {
    if (!collider || collider.isSensor?.()) return false;
    const groundLimit = Math.max(0, Math.min(89.9, rb?.groundAngleLimit ?? SLOPE_LIMIT_DEG));
    const minGroundY = Math.cos(groundLimit * DEG2RAD);
    let found = false;
    try {
      for (const [colliderHandle] of this._colliderHandleMap) {
        if (found) break;
        const other = this.rapierWorld.getCollider(colliderHandle);
        if (!other || other === collider || other.isSensor?.()) continue;
        if (!this._collisionGroupsInteract(collider.collisionGroups(), other.collisionGroups())) continue;
        const otherBody = typeof other.parent === 'function' ? other.parent() : null;
        if (otherBody && otherBody.bodyType?.() === this.RAPIER.RigidBodyType.Dynamic) continue;
        const contact = collider.contactCollider(other, maxDistance);
        const distance = Number(contact?.distance);
        if (!Number.isFinite(distance) || distance > maxDistance) continue;
        const raw = contact?.normal1;
        const nx = Number(raw?.x) || 0;
        const ny = Number(raw?.y) || 0;
        const len = Math.hypot(nx, ny);
        if (len < 1e-7) continue;
        const cny = ny / len;
        if (cny >= minGroundY) found = true;
      }
    } catch (_) {}
    return found;
  }

  hasGroundContact(entityId) {
    const handle = this._handles.get(entityId);
    if (!handle || !handle.collider) return false;
    return this._readContactState(handle.collider, handle.rigidbody2D).grounded;
  }

  getHorizontalWallContact(entityId, direction = 1) {
    const handle = this._handles.get(entityId);
    if (!handle || !handle.collider) return false;
    let found = false;
    try {
      this.rapierWorld.contactPairsWith(handle.collider, (other) => {
        if (found || !other || other.isSensor?.()) return;
        this.rapierWorld.contactPair(handle.collider, other, (manifold, flipped) => {
          const n = this._selfContactNormal(handle.collider, manifold, flipped);
          if (!n) return;
          if (Math.abs(Number(n.x) || 0) >= 0.5 && Math.sign(Number(n.x) || 0) === direction) found = true;
        });
      });
    } catch (_) {}
    return found;
  }

  /**
   * Creates/updates Rapier bodies+colliders to match current ECS state,
   * steps the simulation, then writes results back to Transform.
   * No-ops silently until Rapier finishes loading (whenReady()).
   * @param {import('../core/World.js').World} world
   * @param {number} dt
   */
  /**
   * Public entry point called once per rendered frame (see
   * systems/PhysicsSystem.js). Runs Rapier at a FIXED internal timestep
   * (FIXED_PHYSICS_DT) via a standard accumulator, regardless of how much
   * wall-clock time this render frame actually took — see the
   * FIXED_PHYSICS_DT comment above for why (stiff Rope/Spring joints
   * vibrate under a timestep that changes every frame). `dt` still fully
   * determines how much simulated time passes; it just may now be spread
   * across zero, one, or a few FIXED_PHYSICS_DT-sized calls to
   * _stepOnce() instead of always exactly one call sized to `dt` itself.
   */
  step(world, dt, scriptSystem) {
    if (!this.ready) return;

    // time.scale = 0 (GameLoop passes dt === 0): gameplay time is frozen, so
    // nothing may step. (A non-positive dt that is NOT exactly 0 still means
    // "unknown", and falls back to one 60 Hz frame below.)
    if (dt === 0) return;

    // time.scale > 1 means each rendered frame legitimately has to simulate
    // more game time than usual, so the stall clamp and substep cap grow with
    // it (bounded at 15x: 0.5 s and 60 substeps per frame). At scale <= 1
    // this is exactly the old behavior.
    const speed = Math.min(Math.max(1, (world && world.timeScale) || 1), 15);
    const maxSubsteps = Math.ceil(MAX_PHYSICS_SUBSTEPS_PER_FRAME * speed);

    // Same stall clamp as before (tab-out/hitch protection), now applied
    // to how much time is allowed INTO the accumulator rather than to a
    // single step's timestep.
    const clampedDt = Math.min(dt > 0 ? dt : 1 / 60, (1 / 30) * speed);
    this._physicsAccumulator += clampedDt;

    let substeps = 0;
    while (this._physicsAccumulator >= FIXED_PHYSICS_DT && substeps < maxSubsteps) {
      this._stepOnce(world, FIXED_PHYSICS_DT, scriptSystem);
      this._physicsAccumulator -= FIXED_PHYSICS_DT;
      substeps++;
    }
    // Drop any further backlog beyond the substep cap rather than let it
    // keep growing (same intent as the old single-step clamp: a bad
    // stall should not demand an unbounded catch-up burst later).
    if (substeps >= maxSubsteps) {
      this._physicsAccumulator = 0;
    }
  }

  /**
   * Runs exactly one Rapier step at the given (now always fixed, see
   * step() above) timestep. This is the original body of step() before
   * the fixed-timestep accumulator was introduced — everything below is
   * unchanged behavior, just now always called with stepDt ===
   * FIXED_PHYSICS_DT instead of a raw, varying render dt.
   */
  _stepOnce(world, stepDt, scriptSystem) {
    this._stepWorld = world;

    const entities = world.query(TRANSFORM).filter(
      (e) => e.hasComponent(RIGIDBODY_2D) || e.hasComponent(COLLIDER_2D)
    );
    const seen = new Set();
    this._pendingKinematicPushes = new Map();
    this._kinematicPushTargetsThisStep = new Map();

    // stepDt is now always FIXED_PHYSICS_DT, passed in by step()'s
    // accumulator loop above — no longer derived from a raw render dt
    // here (that's what used to make Rope/Spring joints vibrate).
    for (const entity of entities) {
      seen.add(entity.id);
      this._syncEntity(entity, stepDt);
    }

    // remove Rapier bodies for entities that no longer have physics
    // components (or were destroyed)
    for (const [entityId, handle] of this._handles) {
      if (!seen.has(entityId)) {
        if (handle.collider) this._colliderHandleMap.delete(handle.collider.handle);
        if (handle.collider) this._oneWayPlatformHandles.delete(handle.collider.handle);
        if (handle.collider) this._colliderWorldBoundsCache.delete(handle.collider.handle);
        this.rapierWorld.removeRigidBody(handle.body);
        this._handles.delete(entityId);
      }
    }
    // Rebuild/refresh per-tilemap-cell static colliders so a painted
    // tilemap participates in the Rapier solve this step (see
    // _syncTilemapColliders). Done BEFORE the step so freshly painted
    // cells collide immediately, and after _syncEntity so a tilemap
    // entity's own Rigidbody2D/Collider2D (if any) is already in place.
    this._syncTilemapColliders(world);

    // Joints connect two already-existing Rapier bodies, so this runs
    // AFTER every entity's body has been created/rebuilt above (both
    // endpoints are guaranteed to exist) and BEFORE rapierWorld.step()
    // below so the joint actually constrains this step's solve, not
    // next frame's.
    this._syncJoints(world);

    // Capture the Dynamic velocities BEFORE Rapier's step. A Kinematic body
    // can legitimately transfer its full normal velocity during the solver
    // step; this snapshot lets the post-step carry limiter distinguish that
    // solver-generated push from velocity the Dynamic already had.
    // Pre-contact carry hints are produced by the kinematic sweep.
    // Apply them BEFORE Rapier's solve so the solver sees a smaller relative
    // speed instead of first teleporting the Dynamic and then being corrected.
    this._applyPredictedKinematicPushes(entities, stepDt);

    const preStepDynamicVelocities = new Map();
    for (const entity of entities) {
      const rb = entity.getComponent(RIGIDBODY_2D);
      if (!rb || rb.bodyType !== BodyType.DYNAMIC || !rb.simulated) continue;
      const h = this._handles.get(entity.id);
      if (!h?.body) continue;
      const v = h.body.linvel();
      preStepDynamicVelocities.set(entity.id, { x: Number(v?.x) || 0, y: Number(v?.y) || 0 });
    }

    // Rope/Spring joints are solved by Rapier itself below. Do not add a
    // second hand-written endpoint spring/impulse here: double-counting the
    // same constraint injects energy and is especially noticeable in ragdoll
    // chains. Forces queued by scripts are also applied only once below.

    this.rapierWorld.timestep = stepDt;
    // One-way platforms and connected-pair exclusions share this hook.
    // Rapier invokes it only for pairs where at least one collider has
    // ActiveHooks.FILTER_CONTACT_PAIRS set. With neither feature active,
    // ordinary contact pairs skip the hook entirely. The hook runs BEFORE contact manifolds exist, so it
    // can't inspect a contact normal directly; instead it does a
    // position/velocity check: solid only when the OTHER body's
    // trailing edge is on the correct side of the platform's own
    // leading edge AND still approaching that side, matching the
    // classic "solid from above, pass-through from below/side" jump-
    // through-platform behavior. Read directly off Rapier's own
    // collider/body state (translation/halfExtents/linvel) rather than
    // this engine's Transform component, since the hook fires mid-solve
    // before this step's Transform writeback has happened.
    const needsContactFiltering =
      this._oneWayPlatformHandles.size > 0 ||
      this._disabledJointCollisionPairs.size > 0;
    this.rapierWorld.step(
      this._eventQueue,
      needsContactFiltering ? this._oneWayPlatformHooks : undefined
    );
    this._checkBreakableRevoluteJoints(FIXED_PHYSICS_DT);

    // A Dynamic can receive a short solver impulse from a Kinematic contact
    // that leaves it a small distance inside the Static/Kinematic wall it is
    // pinned against. Recover only those Dynamic bodies that were actually
    // involved in a Kinematic push this frame; ordinary Dynamic collision
    // resolution is untouched.
    this._recoverKinematicPushContacts();

    // Rapier's kinematic-vs-dynamic solve can transfer the full kinematic
    // contact velocity to a resting Dynamic body on the first contact frame.
    // Keep that physical contact solve, but smooth ONLY the normal velocity
    // transfer so a moving platform/kinematic mover carries a Dynamic body
    // into motion instead of giving it a one-frame shove.
    this._smoothKinematicDynamicPushes(entities, stepDt, preStepDynamicVelocities);

    // High-speed side impacts can produce a large friction impulse at a wall.
    // For controller-driven Dynamic bodies, that impulse must not turn the
    // wall into a magnetic surface that steals the jump/fall velocity.
    // Preserve only the expected gravity/damping update on the wall tangent;
    // floor and ceiling contacts are deliberately excluded so normal landing
    // and head-hit responses remain fully solver-owned.
    this._preserveDynamicWallFallSpeed(entities, stepDt, preStepDynamicVelocities);


    // write results back onto Transform for every DYNAMIC / KINEMATIC body
    for (const entity of entities) {
      const rb = entity.getComponent(RIGIDBODY_2D);
      if (!rb || rb.bodyType === BodyType.STATIC || !rb.simulated) continue;

      const handle = this._handles.get(entity.id);
      if (!handle) continue;

      const transform = entity.getComponent(TRANSFORM);
      const pos = handle.body.translation();
      transform.x = pos.x;
      transform.y = pos.y;
      if (!rb.lockRotation) transform.rotation = handle.body.rotation() * RAD2DEG;

      if (rb.bodyType === BodyType.DYNAMIC) {
        // Dynamic bodies: Rapier's solver owns velocity outright, so
        // read it back every frame (as before) so scripts/Inspector see
        // the true simulated speed (e.g. after gravity, pushes, etc).
        let vel = handle.body.linvel();

        // Movement-type Dynamic bodies should slide along contacted surfaces
        // rather than inherit tangential friction impulses that can feel like
        // wall/ceiling glue. This is a controller behavior only; ordinary
        // Dynamic bodies keep the material/friction behavior the user chose.
        // Do not run a second, engine-side velocity projection here. Rapier
        // already solved the contact for this step. A second projection can
        // see the previous frame's floor manifold during the first jump
        // frame and cancel the newly applied upward velocity, producing the
        // characteristic "short first jump, full second jump" bug.
        // Movement-type wall sliding is handled by the collider friction
        // combine rule (Min) when the collider is synced below, so there is
        // no need for a second solver-like correction here.

        rb.velocityX = vel.x;
        rb.velocityY = vel.y;
        rb.angularVelocity = handle.body.angvel();
      }

      // Contact flags are always derived from Rapier's actual manifolds.
      // This is intentionally shared by Dynamic and Kinematic bodies so a
      // movement behavior never invents a second definition of ground/wall/
      // ceiling contact. Static bodies do not need movement-state flags.
      if (rb.bodyType !== BodyType.STATIC && handle.collider) {
        const wasGrounded = !!rb.grounded;
        const state = this._readContactState(handle.collider, rb);

        // Ground-state hysteresis: Rapier can briefly omit/rebuild a support
        // manifold while a controller-driven Dynamic body is moving across
        // a one-way platform, especially when its rotation changes the
        // contact point. If the body was grounded on the previous physics
        // frame, is not clearly jumping upward, and a real support surface is
        // still within a very small contact distance, keep it grounded for
        // this frame. This is deliberately applied to BOTH Platformer and
        // Character Controller Dynamic bodies; otherwise their public
        // grounded/falling state can flicker 0/1 even though the body never
        // actually left the platform.
        if (wasGrounded && !state.grounded) {
          const upward =
            Number(rb._scriptVelocityY) < -0.001 ||
            Number(rb.resolvedVelocityY) < -0.001 ||
            Number(rb.velocityY) < -0.001;
          if (!upward && this._hasNearbyGroundSupport(handle.collider, rb, 0.35)) {
            state.grounded = true;
            state.isOnSlope = false;
            state.groundAngle = 0;
            state.groundNormalX = 0;
            state.groundNormalY = 1;
          }
        }

        // Kinematic grounded state is allowed a tiny, shape-accurate support
        // tolerance when the previous physics frame was grounded. A rotated
        // cube can momentarily lose its manifold while Rapier refreshes the
        // contact after a corner/cardinal-angle landing, even though its
        // collider is still within a sub-pixel distance of the same floor.
        // Preserve grounded only when there is a real nearby support surface
        // and the body is not beginning an upward jump. This prevents the
        // custom script's `if (!isGrounded) rotation += ...` branch from
        // running while the cube is already resting on the floor.
        if (rb.bodyType === BodyType.KINEMATIC && wasGrounded && !state.grounded) {
          const scriptVelocityY = Number(rb._scriptVelocityY);
          const jumping = Number.isFinite(scriptVelocityY) && scriptVelocityY < -0.001;
          const movingUp = jumping || rb.resolvedVelocityY < -0.001 || rb.velocityY < -0.001;
          if (!movingUp && this._hasNearbyGroundSupport(handle.collider, rb, 1.0)) {
            state.grounded = true;
            state.isOnSlope = false;
            state.groundAngle = 0;
            state.groundNormalX = 0;
            state.groundNormalY = 1;
          }
        }

        // Position-based Kinematics can still have a speculative/zero-distance
        // floor manifold for one frame immediately after takeoff. The actual
        // resolved movement is the decisive signal here: if this Kinematic
        // frame moved upward, do not publish that stale support manifold as
        // `isGrounded`. This is what lets a custom script use the natural
        // pattern `if (isGrounded) velocityY = 0;` without cancelling its own
        // jump on the next frame. Prefer the explicit script marker when it is
        // present (Movement Type = None), otherwise use the resolved Kinematic
        // displacement. This does not affect Dynamic bodies and does not make
        // rotation special-cased — mid-air rotation remains fully supported.
        if (rb.bodyType === BodyType.KINEMATIC) {
          const scriptUpward = Number.isFinite(Number(rb._scriptVelocityY)) && Number(rb._scriptVelocityY) < -0.001;
          const resolvedUpward = rb.resolvedVelocityY < -0.001;
          if (state.grounded && (scriptUpward || resolvedUpward)) {
            state.grounded = false;
            state.isOnSlope = false;
          }
          // A grounded scripted rotation snap may have re-seated the new
          // collider exactly on the previous support point. Rapier's contact
          // manifold still reflects the pre-snap pose during this writeback,
          // so carry the already-verified grounded result for one frame.
          // The next physics step reads the real manifold from the new pose.
          if (rb._rotationSnapGrounded && !scriptUpward) {
            const gny = Math.max(-1, Math.min(1, Number(rb._groundNormalY) || 1));
            // The re-seat was computed from the previous real support contact,
            // so keep the grounded state stable for a very small, bounded
            // number of physics updates while Rapier catches up with the new
            // rotated pose. This is not a permanent synthetic ground state.
            // Keep this verified support result for the full short lock
            // window, even if Rapier has not yet refreshed the manifold for
            // the newly rotated pose. The support point was computed from the
            // previous real contact, so this is stable for the transition.
            state.grounded = true;
            state.groundAngle = Math.acos(gny) * RAD2DEG;
            state.isOnSlope = state.groundAngle + GROUND_STATE_ANGLE_EPS_DEG >= (rb.slopeMinAngle ?? 10);
            rb._rotationSnapGroundedFrames = Math.max(0, (rb._rotationSnapGroundedFrames || 0) - 1);
            if (rb._rotationSnapGroundedFrames === 0) rb._rotationSnapGrounded = false;
          }
        }

        rb.grounded = state.grounded;
        rb.isOnWall = state.isOnWall;
        rb.isOnCeiling = state.isOnCeiling;
        rb.isOnSlope = state.isOnSlope;
        rb.groundAngle = state.groundAngle;
        rb._groundNormalX = Number(state.groundNormalX) || 0;
        rb._groundNormalY = Number(state.groundNormalY) || 1;
      }
      // KINEMATIC: rb.velocityX/Y stay as the INTENDED input the
      // controller/Inspector/script set (they are NOT overwritten here
      // or by the sweep — see resolvedVelocityX/Y for the actual/blocked
      // movement). A KinematicPositionBased body has no meaningful
      // linvel() from Rapier's solver to read back here, since we drive
      // it via setNextKinematicTranslation rather than forces/velocity.
    }

    // Rapier's event queue is still used for triggers/sensors. Solid collision
    // state is rebuilt from actual contact manifolds below so every body type
    // follows the same Dynamic/Kinematic/Static path.
    if (this._eventQueue && scriptSystem) {
      this._eventQueue.drainCollisionEvents((handle1, handle2, started) => {
        const entityId1 = this._colliderHandleMap.get(handle1);
        const entityId2 = this._colliderHandleMap.get(handle2);
        if (!entityId1 || !entityId2 || entityId1 === entityId2) return;
        const entity1 = world.getEntity(entityId1);
        const entity2 = world.getEntity(entityId2);
        if (!entity1 || !entity2) return;
        const coll1 = this.rapierWorld.getCollider(handle1);
        const coll2 = this.rapierWorld.getCollider(handle2);
        if ((coll1 && coll1.isSensor?.()) || (coll2 && coll2.isSensor?.())) {
          scriptSystem.fireTrigger(entityId1, entity2, world, started);
          scriptSystem.fireTrigger(entityId2, entity1, world, started);
        }
      });
    }

    this._refreshSolidContacts(world, scriptSystem);

    // onCollisionStay is derived from the same contact-pair set used for
    // enter/exit, so all body-type combinations behave identically.
    this._dispatchCollisionStay(world, scriptSystem);
  }



  _recoverKinematicPushContacts() {
    if (!this._kinematicPushTargetsThisStep || !this.rapierWorld) return;
    for (const [entityId, requestedNormal] of this._kinematicPushTargetsThisStep) {
      const handle = this._handles.get(entityId);
      if (!handle?.body || !handle.collider) continue;
      for (let pass = 0; pass < 2; pass++) {
        let deepest = null;
        try {
          for (const [colliderHandle] of this._colliderHandleMap) {
            const other = this.rapierWorld.getCollider(colliderHandle);
            if (!other || other === handle.collider || other.isSensor?.()) continue;
            if (!this._collisionGroupsInteract(handle.collider.collisionGroups(), other.collisionGroups())) continue;
            const otherBody = typeof other.parent === 'function' ? other.parent() : null;
            const type = otherBody?.bodyType?.();
            if (type === this.RAPIER.RigidBodyType.Dynamic) continue;
            const contact = handle.collider.contactCollider(other, 0);
            const distance = Number(contact?.distance);
            if (!contact || !Number.isFinite(distance) || distance >= -0.001) continue;
            const n = this._normalizeWorldContactNormal(contact.normal1);
            const len = Math.hypot(Number(n?.x) || 0, Number(n?.y) || 0);
            if (len < 1e-7) continue;
            const nx = n.x / len, ny = n.y / len;
            const rnLen = Math.hypot(Number(requestedNormal?.x) || 0, Number(requestedNormal?.y) || 0);
            if (rnLen > 1e-7) {
              const rx = (Number(requestedNormal?.x) || 0) / rnLen;
              const ry = (Number(requestedNormal?.y) || 0) / rnLen;
              if (nx * rx + ny * ry > -0.5) continue;
            }
            if (!deepest || distance < deepest.distance) deepest = { distance, nx, ny };
          }
        } catch (_) { deepest = null; }
        if (!deepest) break;
        const correction = Math.min(-deepest.distance + 0.02, 2.0);
        const pos = handle.body.translation();
        handle.body.setTranslation({
          x: Number(pos.x) - deepest.nx * correction,
          y: Number(pos.y) - deepest.ny * correction,
        }, true);
        if (typeof handle.body.linvel === 'function' && typeof handle.body.setLinvel === 'function') {
          const v = handle.body.linvel();
          const along = (Number(v?.x) || 0) * deepest.nx + (Number(v?.y) || 0) * deepest.ny;
          if (along > 0) {
            handle.body.setLinvel({
              x: (Number(v?.x) || 0) - deepest.nx * along,
              y: (Number(v?.y) || 0) - deepest.ny * along,
            }, true);
          }
        }
      }
    }
    this._kinematicPushTargetsThisStep.clear();
  }

  /**
   * Estimate how much Dynamic load is resting on top of a Dynamic body that
   * a Kinematic character is trying to push. A grounded stack increases the
   * normal force at the floor, so a fixed push-acceleration cap can otherwise
   * make the bottom body look immovable even though it is not pinned by a wall.
   *
   * This is only used to scale the existing kinematic->dynamic carry limiter;
   * Rapier still owns the actual contacts, friction and final solver response.
   */
  _getKinematicPushLoadFactor(dynamicCollider) {
    if (!dynamicCollider || !this.rapierWorld) return 1;
    const maxBodies = 64;
    const visited = new Set();
    const queue = [dynamicCollider];
    let factor = 1;

    try {
      while (queue.length && visited.size < maxBodies) {
        const collider = queue.shift();
        if (!collider || visited.has(collider.handle)) continue;
        visited.add(collider.handle);

        this.rapierWorld.contactPairsWith(collider, (other) => {
          if (!other || other === collider || other.isSensor?.()) return;
          if (visited.has(other.handle)) return;
          if (!this._collisionGroupsInteract(collider.collisionGroups(), other.collisionGroups())) return;

          const otherBody = typeof other.parent === 'function' ? other.parent() : null;
          if (otherBody?.bodyType?.() !== this.RAPIER.RigidBodyType.Dynamic) return;

          this.rapierWorld.contactPair(collider, other, (manifold, flipped) => {
            if (!manifold || (typeof manifold.numContacts === 'function' && manifold.numContacts() <= 0)) return;
            const n = this._selfContactNormal(collider, manifold, flipped);
            if (!n) return;

            // Y-down coordinates: a body resting on top of `collider` produces
            // a normal that points downward from `collider` toward that body.
            const nx = Number(n.x) || 0;
            const ny = Number(n.y) || 0;
            if (ny < -0.5 && Math.abs(ny) >= Math.abs(nx) * 0.75) {
              factor += 1;
              queue.push(other);
            }
          });
        });
      }
    } catch (_) {}

    return Math.max(1, Math.min(maxBodies, factor));
  }

  _applyPredictedKinematicPushes(entities, dt) {
    if (!this._pendingKinematicPushes || dt <= 0) return;
    for (const [entityId, hint] of this._pendingKinematicPushes) {
      const entity = this._stepWorld?.getEntity(entityId);
      if (this._kinematicPushTargetsThisStep) this._kinematicPushTargetsThisStep.set(entityId, { x: Number(hint.nx) || 0, y: Number(hint.ny) || 0 });
      const rb = entity?.getComponent(RIGIDBODY_2D);
      const handle = this._handles.get(entityId);
      if (!rb || rb.bodyType !== BodyType.DYNAMIC || !handle?.body || !rb.simulated) continue;
      const sourceHandle = hint.sourceEntityId ? this._handles.get(hint.sourceEntityId) : null;
      const sourceCollider = sourceHandle?.collider || null;

      let vel = handle.body.linvel();
      let vx = Number(vel?.x) || 0;
      let vy = Number(vel?.y) || 0;
      const nx = Number(hint.nx) || 0;
      const ny = Number(hint.ny) || 0;
      const len = Math.hypot(nx, ny);
      if (len < 1e-7) continue;

      const ux = nx / len;
      const uy = ny / len;

      // The Dynamic can retain a much larger velocity from the previous
      // Kinematic contact than the bounded carry hint represents. Before
      // applying this frame's carry, sweep the Dynamic's actual current
      // one-frame displacement against Static/Kinematic geometry. If that
      // displacement reaches a wall/corner, remove only the velocity component
      // into that surface. Supporting floors remain free to carry gravity and
      // do not block horizontal movement.
      try {
        const motion = { x: vx * dt, y: vy * dt };
        if (Math.hypot(motion.x, motion.y) > 1e-7) {
          for (const [colliderHandle] of this._colliderHandleMap) {
            const other = this.rapierWorld.getCollider(colliderHandle);
            if (!other || other === handle.collider || other.isSensor?.()) continue;
            if (!this._collisionGroupsInteract(handle.collider.collisionGroups(), other.collisionGroups())) continue;
            const otherBody = typeof other.parent === 'function' ? other.parent() : null;
            const otherType = otherBody?.bodyType?.();
            if (otherType === this.RAPIER.RigidBodyType.Dynamic) continue;
            let hit = null;
            try { hit = handle.collider.castCollider(motion, other, { x: 0, y: 0 }, 0.01, 1, true); } catch (_) { hit = null; }
            if (!hit) continue;
            const n = this._worldTargetNormal(other, hit.normal2);
            const nLen = Math.hypot(Number(n?.x) || 0, Number(n?.y) || 0);
            if (nLen < 1e-7) continue;
            const nx2 = Number(n.x) / nLen, ny2 = Number(n.y) / nLen;
            const horizontal = Math.abs(vx) >= Math.abs(vy) * 1.5;
            const supporting = Math.abs(ny2) > Math.abs(nx2) * 1.5;
            if (horizontal && supporting) continue;
            // The cast itself is directional: a hit means the Dynamic's
            // current one-frame velocity reaches this Static/Kinematic surface.
            // Do not depend on manifold normal orientation here, especially for
            // triangles. Stop only the velocity component along the hit normal.
            const into = vx * nx2 + vy * ny2;
            const blockMagnitude = Math.abs(into) > 1e-7 ? Math.abs(into) : 0;
            if (blockMagnitude > 0) {
              vx -= nx2 * into;
              vy -= ny2 * into;
              handle.body.setLinvel({ x: vx, y: vy }, true);
            }
          }
        }
      } catch (_) {}

      // Re-check the Dynamic's actual one-frame travel against Static/Kinematic
      // geometry before applying another bounded Kinematic carry. If the body
      // is already close enough that its current velocity reaches the wall this
      // frame, stop only the inward component; free pushing and tangent motion
      // remain unchanged. The source Kinematic is excluded from this query.
      const actualMotion = { x: vx * dt, y: vy * dt };
      const carryBlock = this._dynamicPushBlocked(handle.collider, sourceCollider, actualMotion, 0.01);
      if (carryBlock) {
        const bx = Number(carryBlock.x) || 0, by = Number(carryBlock.y) || 0;
        const bl = Math.hypot(bx, by);
        if (bl > 1e-7) {
          const bux = bx / bl, buy = by / bl;
          const along = vx * bux + vy * buy;
          if (along > 0) {
            vx -= bux * along;
            vy -= buy * along;
            handle.body.setLinvel({ x: vx, y: vy }, true);
          }
        }
        continue;
      }

      // n points Dynamic -> Kinematic, so a negative projection is movement
      // of the Kinematic into the Dynamic. Move the Dynamic toward the
      // Kinematic's normal velocity by a bounded acceleration before the
      // solver runs. This reduces the solver's relative closing speed and
      // prevents the one-frame positional shove.
      const target = Number(hint.targetNormalVelocity) || 0;
      const current = vx * ux + vy * uy;
      const delta = target - current;
      const loadFactor = this._getKinematicPushLoadFactor(handle.collider);
      const maxDelta = KINEMATIC_PUSH_MAX_ACCEL * loadFactor * dt;
      const step = Math.max(-maxDelta, Math.min(maxDelta, delta));
      if (Math.abs(step) < 1e-7) continue;

      vx += ux * step;
      vy += uy * step;
      handle.body.setLinvel({ x: vx, y: vy }, true);
      handle.body.wakeUp();
    }
    this._pendingKinematicPushes.clear();
  }


  _smoothKinematicDynamicPushes(entities, dt, preStepDynamicVelocities) {
    if (!Array.isArray(entities) || dt <= 0 || !this.rapierWorld) return;

    // Limit ONLY the velocity that a moving Kinematic contact adds along its
    // contact normal. Rapier continues to own collision detection,
    // penetration correction, friction, and all other solver response.
    //
    // Why the pre-step velocity matters: after Rapier's solve a Kinematic
    // platform can make the Dynamic's velocity jump from 0 -> platformSpeed
    // in one frame. Looking only at the post-step velocity cannot tell that
    // transfer happened because the Dynamic already matches the platform.
    const baseMaxNormalDelta = KINEMATIC_PUSH_MAX_ACCEL * dt;
    if (!(baseMaxNormalDelta > 0)) return;

    for (const entity of entities) {
      const rb = entity.getComponent(RIGIDBODY_2D);
      if (!rb || rb.bodyType !== BodyType.DYNAMIC || !rb.simulated) continue;
      const handle = this._handles.get(entity.id);
      if (!handle?.collider) continue;

      const preVel = preStepDynamicVelocities?.get(entity.id) || { x: 0, y: 0 };
      const loadFactor = this._getKinematicPushLoadFactor(handle.collider);
      const maxNormalDelta = baseMaxNormalDelta * loadFactor;
      let vel = handle.body.linvel();
      let vx = Number(vel?.x) || 0;
      let vy = Number(vel?.y) || 0;

      try {
        this.rapierWorld.contactPairsWith(handle.collider, (other) => {
          if (!other || other.isSensor?.()) return;
          const otherEntityId = this._colliderHandleMap.get(other.handle);
          if (!otherEntityId) return;
          const otherEntity = this._stepWorld?.getEntity(otherEntityId);
          const otherRb = otherEntity?.getComponent(RIGIDBODY_2D);
          const otherHandle = this._handles.get(otherEntityId);
          if (!otherHandle?.body || !otherRb || otherRb.bodyType !== BodyType.KINEMATIC) return;

          // Use the Kinematic body's actual resolved movement for the current
          // step. This is the velocity the sweep really produced, not merely
          // the intended inspector/script value.
          const kVelX = Number(otherRb.resolvedVelocityX) || 0;
          const kVelY = Number(otherRb.resolvedVelocityY) || 0;
          if (Math.hypot(kVelX, kVelY) < 1e-7) return;

          this.rapierWorld.contactPair(handle.collider, other, (manifold, flipped) => {
            if (!manifold || (typeof manifold.numContacts === 'function' && manifold.numContacts() <= 0)) return;
            const n = this._selfContactNormal(handle.collider, manifold, flipped);
            if (!n) return;

            const len = Math.hypot(Number(n.x) || 0, Number(n.y) || 0);
            if (len < 1e-7) return;
            const ux = (Number(n.x) || 0) / len;
            const uy = (Number(n.y) || 0) / len;

            // Normal points Dynamic -> Kinematic. Negative means the
            // Kinematic is moving into the Dynamic and can push/carry it.
            const kNormal = kVelX * ux + kVelY * uy;
            if (kNormal >= -1e-7) return;

            const preNormal = (Number(preVel.x) || 0) * ux + (Number(preVel.y) || 0) * uy;
            const postNormal = vx * ux + vy * uy;

            // Bound the change in the contact-normal component supplied by
            // this Kinematic contact. A later contact manifold can have a
            // different normal (especially in a stack or at a corner), so
            // do not rely on the old pre/post-normal sign gate alone.
            if (kNormal < -1e-7 && postNormal < preNormal) {
              const allowedNormal = preNormal - maxNormalDelta;
              if (postNormal < allowedNormal) {
                const delta = allowedNormal - postNormal;
                vx += ux * delta;
                vy += uy * delta;
              }
            }

            // Also cap any remaining Kinematic-induced velocity increase
            // along the Kinematic's actual movement direction. This catches
            // multi-contact stack/corner frames where Rapier resolves the
            // same push through a newly changed contact normal. Only the
            // Kinematic-aligned component is limited; tangential motion and
            // unrelated Dynamic impulses remain Rapier-owned.
            const kSpeed = Math.hypot(kVelX, kVelY);
            if (kSpeed > 1e-7 && kNormal < -1e-7) {
              const kdx = kVelX / kSpeed;
              const kdy = kVelY / kSpeed;
              const preK = (Number(preVel.x) || 0) * kdx + (Number(preVel.y) || 0) * kdy;
              const postK = vx * kdx + vy * kdy;
              const kDelta = postK - preK;
              if (kDelta > maxNormalDelta) {
                const excess = kDelta - maxNormalDelta;
                vx -= kdx * excess;
                vy -= kdy * excess;
              }
            }
          });
        });
      } catch (_) {
        continue;
      }

      handle.body.setLinvel({ x: vx, y: vy }, true);
      handle.body.wakeUp();
    }
  }

  _preserveDynamicWallFallSpeed(entities, dt, preStepDynamicVelocities) {
    if (!Array.isArray(entities) || dt <= 0 || !this.rapierWorld) return;

    for (const entity of entities) {
      const rb = entity.getComponent(RIGIDBODY_2D);
      if (!rb || rb.bodyType !== BodyType.DYNAMIC || !rb.simulated) continue;

      // This correction is intentionally limited to Movement Type bodies.
      // Plain Dynamic bodies are still expected to obey their configured
      // friction material, while character movement should never get slower
      // falling simply because the horizontal impact speed was higher.
      if (!entity.hasComponent(CHARACTER_CONTROLLER)) continue;

      const handle = this._handles.get(entity.id);
      if (!handle?.body || !handle.collider) continue;

      let hasWallContact = false;
      let hasSupportOrCeiling = false;
      let bestWallNormal = null;

      try {
        this.rapierWorld.contactPairsWith(handle.collider, (other) => {
          if (!other || other.isSensor?.()) return;
          if (!this._collisionGroupsInteract(handle.collider.collisionGroups(), other.collisionGroups())) return;

          const otherBody = typeof other.parent === 'function' ? other.parent() : null;
          const otherType = otherBody?.bodyType?.();
          // A Dynamic-vs-Dynamic contact can legitimately change vertical
          // velocity, so never overwrite that solver response here.
          if (otherType === this.RAPIER.RigidBodyType.Dynamic) return;

          this.rapierWorld.contactPair(handle.collider, other, (manifold, flipped) => {
            if (!manifold || (typeof manifold.numContacts === 'function' && manifold.numContacts() <= 0)) return;
            const n = this._selfContactNormal(handle.collider, manifold, flipped);
            if (!n) return;

            const nx = Number(n.x) || 0;
            const ny = Number(n.y) || 0;
            const len = Math.hypot(nx, ny);
            if (len < 1e-7) return;
            const ux = nx / len;
            const uy = ny / len;

            // Y-down coordinates: floor/support normals point up (negative Y),
            // ceilings point down (positive Y). Only a predominantly horizontal
            // normal counts as a wall for this correction.
            const wallLike = Math.abs(ux) > Math.abs(uy) * 1.5;
            if (!wallLike) {
              hasSupportOrCeiling = true;
              return;
            }

            hasWallContact = true;
            bestWallNormal = { x: ux, y: uy };
          });
        });
      } catch (_) {
        continue;
      }

      if (!hasWallContact || hasSupportOrCeiling) continue;

      const pre = preStepDynamicVelocities?.get(entity.id);
      if (!pre) continue;

      let vel = handle.body.linvel();
      let vx = Number(vel?.x) || 0;
      let vy = Number(vel?.y) || 0;

      // A pure wall cannot change the normal (horizontal) velocity except by
      // blocking it, so keep that solver result. Reconstruct only the vertical
      // component expected from the pre-step velocity + this body's gravity.
      // Linear damping is included as a small multiplicative factor matching
      // Rapier's damped-velocity integration closely enough without attempting
      // to replace its solver.
      const gravityScale = Number(rb.gravityScale);
      const gScale = Number.isFinite(gravityScale) ? gravityScale : 1;
      const damping = Math.max(0, Number(rb.linearDamping) || 0);
      const dampingFactor = damping > 0 ? 1 / (1 + damping * dt) : 1;
      const expectedVy = ((Number(pre.y) || 0) + GRAVITY_Y * gScale * dt) * dampingFactor;

      // Correct only a friction-induced loss of tangent speed. Never create
      // extra downward/upward speed when the solver already produced an equal
      // or larger tangent velocity.
      const tangentSign = Math.abs(expectedVy) > 1e-5 ? Math.sign(expectedVy) : Math.sign((Number(pre.y) || 0) + GRAVITY_Y * gScale * dt);
      const lostTangent = tangentSign === 0
        ? 0
        : (Math.abs(expectedVy) - Math.abs(vy)) * tangentSign;

      if (lostTangent > 0.5) {
        vy += lostTangent;
        handle.body.setLinvel({ x: vx, y: vy }, true);
        handle.body.wakeUp();
      }
    }
  }

  _projectVelocityAwayFromContacts(collider, velocity) {
    let vx = Number(velocity?.x) || 0;
    let vy = Number(velocity?.y) || 0;
    if (!collider || !this.rapierWorld) return { x: vx, y: vy };
    try {
      this.rapierWorld.contactPairsWith(collider, (other) => {
        if (!other || other.isSensor?.()) return;
        this.rapierWorld.contactPair(collider, other, (manifold, flipped) => {
          if (!manifold || (typeof manifold.numContacts === 'function' && manifold.numContacts() <= 0)) return;
          const n = this._selfContactNormal(collider, manifold, flipped);
          if (!n) return;
          const nx = Number(n.x) || 0;
          const ny = Number(n.y) || 0;
          const len = Math.hypot(nx, ny);
          if (len < 1e-6) return;
          const ux = nx / len, uy = ny / len;
          const into = vx * ux + vy * uy;
          if (into < 0) {
            vx -= ux * into;
            vy -= uy * into;
          }
        });
      });
    } catch (_) {}
    return { x: vx, y: vy };
  }

  _refreshSolidContacts(world, scriptSystem) {
    const current = new Map();
    const processSource = (source, sourceEntityId) => {
      if (!source || source.isSensor?.() || !sourceEntityId) return;
      try {
        this.rapierWorld.contactPairsWith(source, (other) => {
          if (!other || other === source || other.isSensor?.()) return;
          const otherEntityId = this._colliderHandleMap.get(other.handle);
          if (!otherEntityId || otherEntityId === sourceEntityId) return;
          // Avoid processing the same entity pair twice.
          if (sourceEntityId > otherEntityId) return;
          let touching = false;
          try {
            this.rapierWorld.contactPair(source, other, (manifold) => {
              const points = typeof manifold?.numContacts === 'function' ? manifold.numContacts() : 0;
              if (points > 0) touching = true;
            });
          } catch (_) {}
          if (!touching) return;
          const key = sourceEntityId + '|' + otherEntityId;
          current.set(key, { id1: sourceEntityId, id2: otherEntityId });
        });
      } catch (_) {}
    };

    for (const [handle, entityId] of this._colliderHandleMap) {
      processSource(this.rapierWorld.getCollider(handle), entityId);
    }

    if (scriptSystem) {
      for (const [key, pair] of current) {
        if (this._activeSolidContacts.has(key)) continue;
        const e1 = world.getEntity(pair.id1);
        const e2 = world.getEntity(pair.id2);
        if (e1 && e2) {
          scriptSystem.fireCollision(pair.id1, e2, world);
          scriptSystem.fireCollision(pair.id2, e1, world);
        }
      }
      for (const [key, pair] of this._activeSolidContacts) {
        if (current.has(key)) continue;
        const e1 = world.getEntity(pair.id1);
        const e2 = world.getEntity(pair.id2);
        if (e1 && e2) {
          scriptSystem.fireCollisionExit(pair.id1, e2, world);
          scriptSystem.fireCollisionExit(pair.id2, e1, world);
        }
      }
    }
    this._activeSolidContacts = current;
  }

  _dispatchCollisionStay(world, scriptSystem) {
    if (!scriptSystem) return;
    for (const { id1, id2 } of this._activeSolidContacts.values()) {
      const e1 = world.getEntity(id1);
      const e2 = world.getEntity(id2);
      if (!e1 || !e2) continue;
      scriptSystem.fireCollisionStay(id1, e2, world);
      scriptSystem.fireCollisionStay(id2, e1, world);
    }
  }

  /**
   * Builds/refreshes one STATIC Rapier body per Tilemap entity and a
   * cuboid collider for every painted cell in Tilemap.cells, so a
   * painted tilemap acts as solid collision geometry in Play mode.
   * Cell world position = transform.x/y + (col+0.5)*tw, (row+0.5)*th,
   * matching TilemapSystem.js's per-tile placement, so a tilemap entity
   * can be moved and its solid cells follow. Erased cells (and whole
   * destroyed tilemap entities) have their colliders removed. If the
   * referenced Tileset's tile size changes, all of that tilemap's cell
   * colliders are rebuilt to the new size.
   */
  _syncTilemapColliders(world) {
    const RAPIER = this.RAPIER;
    const tilemapEntities = world.query(TRANSFORM, TILEMAP);
    const seenTilemaps = new Set();

    for (const entity of tilemapEntities) {
      seenTilemaps.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const tilemap = entity.getComponent(TILEMAP);

      const tilesetEntity = tilemap.tilesetEntityId ? world.getEntity(tilemap.tilesetEntityId) : null;
      const tileset = tilesetEntity ? tilesetEntity.getComponent(TILESET) : null;
      const tw = tileset ? tileset.tileWidth : 32;
      const th = tileset ? tileset.tileHeight : 32;
      const sizeSig = tw + "," + th;

      let body = this._tilemapBodies.get(entity.id);
      let cellColliders = this._tilemapCellColliders.get(entity.id);
      const prevSig = this._tilemapBodySig.get(entity.id);

      if (!body) {
        const desc = new RAPIER.RigidBodyDesc(RAPIER.RigidBodyType.Fixed)
          .setTranslation(transform.x, transform.y)
          .setRotation(transform.rotation * DEG2RAD);
        body = this.rapierWorld.createRigidBody(desc);
        this._tilemapBodies.set(entity.id, body);
        cellColliders = new Map();
        this._tilemapCellColliders.set(entity.id, cellColliders);
        this._tilemapBodySig.set(entity.id, sizeSig);
      } else {
        // keep the static body pinned to the entity's Transform so a
        // moved tilemap's solid cells follow it. Static bodies don't
        // simulate, so this is safe to apply every frame.
        body.setTranslation({ x: transform.x, y: transform.y }, true);
        body.setRotation(transform.rotation * DEG2RAD, true);

        // tile size changed -> drop all existing cell colliders so they
        // rebuild at the new size on the loop below.
        if (prevSig !== sizeSig) {
          for (const collider of cellColliders.values()) {
            this._colliderHandleMap.delete(collider.handle);
            this.rapierWorld.removeCollider(collider, true);
          }
          cellColliders.clear();
          this._tilemapBodySig.set(entity.id, sizeSig);
        }
      }

      const filledKeys = Object.keys(tilemap.cells);
      for (const key of filledKeys) {
        if (cellColliders.has(key)) continue;
        const comma = key.indexOf(",");
        const col = parseInt(key.slice(0, comma), 10);
        const row = parseInt(key.slice(comma + 1), 10);
        const cx = (col + 0.5) * tw;
        const cy = (row + 0.5) * th;
        const desc = RAPIER.ColliderDesc.cuboid(Math.max(0.01, tw / 2), Math.max(0.01, th / 2))
          .setTranslation(cx, cy)
          .setFriction(1)
          .setActiveCollisionTypes(
            RAPIER.ActiveCollisionTypes.ALL |
              RAPIER.ActiveCollisionTypes.KINEMATIC_KINEMATIC |
              RAPIER.ActiveCollisionTypes.KINEMATIC_STATIC
          )
          // Tilemap cells live on Default layer (0) with all-groups filter
          // so entities that exclude Default from their mask can pass through
          // tiles — e.g. a ghost or background object with mask=0 will not
          // be physically blocked by tilemap walls.
          .setCollisionGroups(makeCollisionGroups(0, 0xFFFF));
        const collider = this.rapierWorld.createCollider(desc, body);
        cellColliders.set(key, collider);
        this._colliderHandleMap.set(collider.handle, entity.id);
      }

      // remove colliders for cells that were erased since last step.
      const filledSet = new Set(filledKeys);
      for (const [key, collider] of cellColliders) {
        if (!filledSet.has(key)) {
          this._colliderHandleMap.delete(collider.handle);
          this.rapierWorld.removeCollider(collider, true);
          cellColliders.delete(key);
        }
      }
    }

    // remove bodies for tilemap entities that were destroyed.
    for (const [entityId, body] of this._tilemapBodies) {
      if (!seenTilemaps.has(entityId)) {
        for (const collider of (this._tilemapCellColliders.get(entityId)?.values() || [])) {
          this._colliderHandleMap.delete(collider.handle);
        }
        this.rapierWorld.removeRigidBody(body);
        this._tilemapBodies.delete(entityId);
        this._tilemapCellColliders.delete(entityId);
        this._tilemapBodySig.delete(entityId);
      }
    }
  }

  /**
   * Gets (creating if needed) the hidden zero-size Fixed body that
   * stands in for "jointed to a fixed point in the world" — see
   * Joint2D.js's header comment for why this exists. One hidden body
   * per distinct anchor point, shared across every Joint2D anchored
   * there, and never exposed outside this file.
   *
   * @param {number} x @param {number} y world-space anchor position, px
   * @returns {object} a Rapier Fixed RigidBody at (x, y)
   */
  _getOrCreateWorldAnchor(x, y) {
    const key = x.toFixed(2) + "," + y.toFixed(2);
    let body = this._worldAnchorBodies.get(key);
    if (body) return body;
    const desc = new this.RAPIER.RigidBodyDesc(this.RAPIER.RigidBodyType.Fixed).setTranslation(x, y);
    body = this.rapierWorld.createRigidBody(desc);
    this._worldAnchorBodies.set(key, body);
    return body;
  }

  /**
   * Removes every hidden world-anchor body that no Joint2D uses anymore
   * this step. Run at the end of _syncJoints, after every live Joint2D
   * has had the chance to call _getOrCreateWorldAnchor (which only
   * creates — it never marks a key "still used" on its own), so this
   * needs its own usage pass; see the `usedAnchorKeys` set built in
   * _syncJoints.
   *
   * @param {Set<string>} usedAnchorKeys
   */
  _pruneWorldAnchors(usedAnchorKeys) {
    for (const [key, body] of this._worldAnchorBodies) {
      if (!usedAnchorKeys.has(key)) {
        this.rapierWorld.removeRigidBody(body);
        this._worldAnchorBodies.delete(key);
      }
    }
  }

  /**
   * Applies a Joint2D's shared limit/motor fields to a live Rapier
   * Revolute or Prismatic joint. Both joint types expose the identical
   * UnitImpulseJoint surface (setLimits/configureMotor — see the
   * vendored rapier2d-compat types), so one function covers both.
   *
   * @param {object} rapierJoint an ImpulseJoint (Revolute or Prismatic)
   * @param {import('../components/Joint2D.js').Joint2D} joint
   */
  _applyUnitJointTuning(rapierJoint, joint, referenceAngle = null) {
    if (joint.limitsEnabled) {
      const isRevolute = joint.jointType === JointType2D.REVOLUTE;
      const min = isRevolute ? joint.limitMin * DEG2RAD : joint.limitMin;
      const max = isRevolute ? joint.limitMax * DEG2RAD : joint.limitMax;
      rapierJoint.setLimits(Math.min(min, max), Math.max(min, max));
    } else {
      rapierJoint.setLimits(-1e8, 1e8);
    }

    const isRevolute = joint.jointType === JointType2D.REVOLUTE;
    const motorEnabled = !!joint.motorEnabled && Number(joint.motorMaxForce) > 0;

    if (motorEnabled) {
      const targetVel = isRevolute ? joint.motorSpeed * DEG2RAD : joint.motorSpeed;
      rapierJoint.configureMotorVelocity(targetVel, joint.motorMaxForce);
      return;
    }

    if (isRevolute) {
      // CRITICAL REVOLUTE FIX: never configure a zero-speed motor just to
      // represent "off". A free hinge must have no active angular motor.
      // New passive controls are opt-in and use Rapier's force-based motor
      // surface so the solver remains the owner of the response.
      const drag = Math.max(0, Number(joint.jointDrag) || 0);
      const explicitRest = Math.max(0, Number(joint.restStiffness) || 0);
      let stiffness = explicitRest;
      let damping = drag;

      // Preserve the old flexibility feature for existing scenes. Explicit
      // Rest Stiffness takes precedence; otherwise flexibility < 100 still
      // applies its old torsional resistance.
      if (stiffness <= 0 && referenceAngle != null) {
        const f = Math.max(0, Math.min(100, Number(joint.flexibility) || 0)) / 100;
        if (f < 0.999) {
          stiffness = 800 * Math.pow(1 - f, 2);
          if (damping <= 0) damping = 2 * Math.sqrt(stiffness);
        }
      }

      if (stiffness > 0 || damping > 0) {
        if (typeof rapierJoint.configureMotorModel === "function" && RAPIER.MotorModel?.ForceBased != null) {
          rapierJoint.configureMotorModel(RAPIER.MotorModel.ForceBased);
        }
        const target = referenceAngle ?? 0;
        if (typeof rapierJoint.configureMotor === "function") {
          rapierJoint.configureMotor(target, 0, stiffness, damping);
        } else if (stiffness > 0 && typeof rapierJoint.configureMotorPosition === "function") {
          rapierJoint.configureMotorPosition(target, stiffness, damping);
        }
      }
      return;
    }

    // Preserve the original Prismatic behavior exactly. This is intentionally
    // not used for Revolute because Revolute needs a truly unconfigured motor
    // when its motor is disabled.
    rapierJoint.configureMotorVelocity(0, 0);
  }

  /**
   * Converts a local anchor on a Rapier body into a world-space point.
   * Kept here because the flexible rope links use the same local-anchor
   * convention as every other Joint2D type.
   */
  _jointAnchorWorld(body, localX, localY) {
    const t = body.translation();
    const r = body.rotation();
    const c = Math.cos(r);
    const sn = Math.sin(r);
    return {
      x: t.x + localX * c - localY * sn,
      y: t.y + localX * sn + localY * c,
    };
  }

  /**
   * Destroys the hidden Rapier bodies/colliders/joints that make up a
   * flexible Rope/Spring Joint2D. These objects deliberately never enter
   * the ECS: the ECS still contains one Joint2D component while the
   * PhysicsWorld owns the internal rope topology.
   */
  _destroyFlexibleJoint(entry) {
    if (!entry?.links) return;

    if (entry.joint?.isValid?.()) {
      try { this.rapierWorld.removeImpulseJoint(entry.joint, true); } catch (_) {}
    }
    for (const link of entry.links || []) {
      try {
        if (link.joint?.isValid?.()) this.rapierWorld.removeImpulseJoint(link.joint, true);
      } catch (_) {}
    }

    for (const segment of entry.segments || []) {
      try {
        if (segment.collider) {
          this._colliderHandleMap.delete(segment.collider.handle);
          this._oneWayPlatformHandles.delete(segment.collider.handle);
          this._colliderWorldBoundsCache.delete(segment.collider.handle);
        }
        if (segment.body?.isValid?.()) {
          this.rapierWorld.removeRigidBody(segment.body);
        }
      } catch (_) {}
    }
  }

  /**
   * Builds a distributed Rope/Spring chain from real Rapier rigid bodies.
   * Rope uses a native one-sided RopeImpulseJoint on every span; Spring uses
   * a native SpringImpulseJoint on every span. The visual rope is therefore
   * driven by the same bodies and constraints that the solver uses, rather
   * than a separate fake curve or a second hand-written endpoint force.
   *
   * Link colliders remain non-interacting hidden sensors. Their mass/inertia is
   * still real, so gravity, collisions at the endpoints, impulses and joint
   * reaction forces can propagate through the entire chain.
   */
  _buildFlexibleJoint(entry, joint, body1, body2, anchor1, anchor2) {
    const RAPIER = this.RAPIER;
    const configuredLength = Math.max(0, Number(joint.length) || 0);
    const isRope = joint.jointType === JointType2D.ROPE;

    const p1 = this._jointAnchorWorld(body1, anchor1.x, anchor1.y);
    const p2 = this._jointAnchorWorld(body2, anchor2.x, anchor2.y);
    const chordDx = p2.x - p1.x;
    const chordDy = p2.y - p1.y;
    const chordLength = Math.hypot(chordDx, chordDy);

    // segmentCount is the number of actual physical spans. Each span is a
    // real rigid-body constraint, so gravity can bend the chain and the end
    // body can transfer angular momentum through it. More segments gives a
    // smoother curve but costs more solver work.
    const segmentCount = Math.max(2, Math.min(32, Math.round(Number(joint.segmentCount) || 18)));
    const linkCount = segmentCount - 1;

    // Rope length is a hard MAX length because RopeImpulseJoint only resists
    // extension; it can go slack and bend naturally. Spring length is its REST
    // length, with Hooke/damping response supplied by Rapier's native Spring
    // constraint. If a scene has a zero length, use the current endpoint span
    // to avoid zero-length degenerate constraints.
    const pathLength = configuredLength > 1e-4 ? configuredLength : Math.max(chordLength, 1);
    const segLength = pathLength / segmentCount;

    const totalMass = Math.max(0, Number(joint.ropeMass) || 0);
    const perLinkMass = Math.max(0.001, linkCount > 0 ? totalMass / linkCount : totalMass);

    // Hidden link colliders are intentionally non-interacting, but the links
    // still have real mass/inertia so gravity and impulses travel through the
    // articulated chain instead of the visual being a fake curve.
    const linkRadius = Math.max(0.5, Math.min(4, segLength * 0.15));
    const linkHalfHeight = Math.max(0.01, segLength / 2 - linkRadius);

    let dirX = 0, dirY = 1;
    if (chordLength > 1e-4) {
      dirX = chordDx / chordLength;
      dirY = chordDy / chordLength;
    }

    const segments = [];
    for (let i = 0; i < linkCount; i++) {
      const t = (i + 1) / segmentCount;
      const x = p1.x + chordDx * t;
      const y = p1.y + chordDy * t;
      const angle = Math.atan2(dirY, dirX) - Math.PI / 2;

      // Internal links are physical parts of the rope/string, not hidden
      // animated points. Keep their damping low so momentum can travel
      // through the chain naturally. Heavy damping here makes a rope feel
      // like it is moving through syrup and can make spring strings appear
      // to move in slow motion. The user's Joint2D damping belongs to the
      // native SpringImpulseJoint below.
      const desc = new RAPIER.RigidBodyDesc(RAPIER.RigidBodyType.Dynamic)
        .setTranslation(x, y)
        .setRotation(angle)
        .setLinearDamping(0.02)
        .setAngularDamping(0.04)
        .setCcdEnabled(true);
      const body = this.rapierWorld.createRigidBody(desc);
      body.setAdditionalMass(perLinkMass, true);

      const colliderDesc = RAPIER.ColliderDesc.capsule(linkHalfHeight, linkRadius)
        .setDensity(0)
        .setCollisionGroups(makeCollisionGroups(0, 0))
        .setSensor(true);
      const collider = this.rapierWorld.createCollider(colliderDesc, body);
      segments.push({ body, collider });
    }

    // body1 -> link0 -> ... -> linkN -> body2. For Rope, EVERY span is a
    // native RopeImpulseJoint. This is the physically correct topology: every
    // joint is a one-sided distance constraint, allowing slack/bending but
    // preventing an individual span from stretching past its maximum.
    // For Spring, EVERY span is a native SpringImpulseJoint with the user's
    // stiffness/damping. There is intentionally NO extra endpoint backstop or
    // hand-written endpoint impulse: one solver should own the constraint.
    const chain = [
      { body: body1, anchor: anchor1 },
      ...segments.map((s) => ({ body: s.body, anchor: { x: 0, y: 0 } })),
      { body: body2, anchor: anchor2 },
    ];

    const links = [];
    const stiffness = Math.max(0, Number(joint.stiffness) || 0);
    const damping = Math.max(0, Number(joint.damping) || 0);
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const params = isRope
        ? RAPIER.JointData.rope(segLength, a.anchor, b.anchor)
        : RAPIER.JointData.spring(segLength, stiffness, damping, a.anchor, b.anchor);

      const rapierJoint = this.rapierWorld.createImpulseJoint(params, a.body, b.body, true);
      // Endpoint collision setting is also applied to internal links. The
      // hidden link colliders have an empty mask, so this is mostly defensive.
      rapierJoint.setContactsEnabled(!joint.disableConnectedCollision);
      links.push({ joint: rapierJoint, bodyA: a.body, bodyB: b.body });
    }

    entry.joint = null;
    entry.body1 = body1;
    entry.body2 = body2;
    entry.component = joint;
    entry.anchor1 = { ...anchor1 };
    entry.anchor2 = { ...anchor2 };
    entry.segments = segments;
    entry.links = links;
    entry.segLength = segLength;
    entry.maxLength = isRope ? pathLength : Infinity;
    entry.flexible = true;
    entry.flexibleMode = isRope ? "rope" : "spring";
  }

  /**
   * Returns the real simulated points used to render a Rope/Spring Joint2D.
   * The first/last points are the actual anchor locations on the two end
   * bodies; every point in between is a real Rapier link body's actual
   * simulated world position (see _buildFlexibleJoint) — so the rendered
   * cord always matches exactly how the rope is physically bending and
   * sagging this frame, never an invented curve that could drift away from
   * the simulation.
   */
  getJointVisualPoints(entityId) {
    const entry = this._joints.get(entityId);
    if (!entry?.flexible || !entry.body1 || !entry.body2) return null;

    const p1 = this._jointAnchorWorld(entry.body1, entry.anchor1.x, entry.anchor1.y);
    const p2 = this._jointAnchorWorld(entry.body2, entry.anchor2.x, entry.anchor2.y);

    const points = [p1];
    for (const segment of entry.segments || []) {
      if (!segment.body?.isValid?.()) continue;
      const t = segment.body.translation();
      points.push({ x: t.x, y: t.y });
    }
    points.push(p2);
    return points;
  }

  /**
   * Returns the live motion state of a world/body-anchored Rope joint.
   * This is intentionally read from Rapier's current body/anchor poses so
   * movement controllers can drive a swinging body along the actual tangent
   * instead of replacing one component of its world velocity.
   *
   * The rope is now a real bending multi-link chain (see
   * _buildFlexibleJoint), so the direction that actually matters for the
   * swinging body's motion is the LAST link segment nearest body2 — not the
   * straight line from the world/other-body anchor all the way to body2,
   * which would only be correct for a perfectly straight rope. Using the
   * last segment keeps the tangent/radial decomposition correct even while
   * the rope is bent into a curve.
   */
  getRopeMotionInfo(entityId) {
    const entry = this._joints.get(entityId);
    if (!entry?.flexible || entry.flexibleMode !== "rope" || !entry.body1 || !entry.body2) {
      return null;
    }

    const body2 = entry.body2;
    if (!body2?.isValid?.()) return null;

    // The point one real link back from body2 — the last real segment's
    // other end. Falls back to the far endpoint anchor (body1) when there
    // are no intermediate links (a very short rope), preserving the
    // original straight-chord behavior in that degenerate case.
    const segments = entry.segments || [];
    let nearBody = null;
    let nearLocalAnchor = { x: 0, y: 0 };
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].body?.isValid?.()) {
        nearBody = segments[i].body;
        break;
      }
    }
    if (!nearBody) {
      if (!entry.body1?.isValid?.()) return null;
      nearBody = entry.body1;
      nearLocalAnchor = entry.anchor1;
    }

    const p1 = this._jointAnchorWorld(nearBody, nearLocalAnchor.x, nearLocalAnchor.y);
    const p2 = this._jointAnchorWorld(body2, entry.anchor2.x, entry.anchor2.y);
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const distance = Math.hypot(dx, dy);
    const segMaxLength = Math.max(0, Number(entry.segLength) || 0);
    if (!(distance > 1e-6) || !(segMaxLength > 0)) return null;

    // radius points from the last link toward the dynamic body. A
    // perpendicular tangent is therefore the only direction that changes
    // the swing angle without injecting radial velocity.
    const radialX = dx / distance;
    const radialY = dy / distance;
    const tangentX = -radialY;
    const tangentY = radialX;
    const slackPx = segMaxLength - distance;

    return {
      distance,
      maxLength: segMaxLength,
      slackPx,
      taut: slackPx <= 0.75,
      radialX,
      radialY,
      tangentX,
      tangentY,
    };
  }

  /**
   * Creates/updates/removes the live Rapier ImpulseJoint backing each
   * entity's Joint2D component — same create-once/rebuild-on-change
   * shape as _syncEntity's body handling, one level up: a joint can
   * only be built once BOTH of its endpoint bodies exist, so this runs
   * after every entity in the step has already gone through
   * _syncEntity (see the call site in step()).
   *
   * Like Rapier bodies, a joint is destroyed and recreated (never
   * mutated in place) whenever anything about WHICH bodies/anchors it
   * connects changes — Rapier's ImpulseJoint has no "re-point this
   * joint at a different body" call. Per-motor/limit tuning on an
   * otherwise-unchanged joint IS applied in place every step (cheap,
   * and lets a script drive motorSpeed live — see RigidbodyAPI.js's
   * own live-tunable fields for the same idea applied to bodies).
   *
   * Also note: Rapier automatically removes any joint attached to a
   * body when that body itself is removed (e.g. _syncEntity rebuilding
   * a body on a bodyType change, or the entity being destroyed) — so a
   * stale entry in `this._joints` whose Rapier joint is already gone
   * is expected and handled below via `.isValid()`, not a bug.
   *
   * @param {import('../core/World.js').World} world
   */
  /**
   * Estimates Revolute anchor constraint demand. The vendored Rapier wrapper
   * does not expose the solved joint reaction impulse, so this is explicitly
   * an estimate based on endpoint error/relative velocity, not a raw solver force.
   */
  _estimateRevoluteBreakForce(entry, joint, dt) {
    if (!entry?.joint || !entry.joint.isValid?.() || joint.jointType !== JointType2D.REVOLUTE) return 0;
    const b1 = entry.body1, b2 = entry.body2;
    if (!b1 || !b2 || !b1.isValid?.() || !b2.isValid?.()) return 0;
    const rotate = (body, x, y) => {
      const a = Number(body.rotation()) || 0;
      const c = Math.cos(a), sn = Math.sin(a);
      return { x: c * x - sn * y, y: sn * x + c * y };
    };
    const t1 = b1.translation(), t2 = b2.translation();
    const r1 = rotate(b1, Number(joint.anchor1X) || 0, Number(joint.anchor1Y) || 0);
    const r2 = rotate(b2, joint.connectedEntityId ? Number(joint.anchor2X) || 0 : 0, joint.connectedEntityId ? Number(joint.anchor2Y) || 0 : 0);
    const p1 = { x: Number(t1.x) + r1.x, y: Number(t1.y) + r1.y };
    const p2 = { x: Number(t2.x) + r2.x, y: Number(t2.y) + r2.y };
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const distance = Math.hypot(dx, dy);
    const nx = distance > 1e-6 ? dx / distance : 1;
    const ny = distance > 1e-6 ? dy / distance : 0;
    const v1 = b1.linvel(), v2 = b2.linvel();
    const w1 = Number(b1.angvel()) || 0, w2 = Number(b2.angvel()) || 0;
    const pv1x = Number(v1.x) - w1 * r1.y, pv1y = Number(v1.y) + w1 * r1.x;
    const pv2x = Number(v2.x) - w2 * r2.y, pv2y = Number(v2.y) + w2 * r2.x;
    const relativeSpeed = (pv2x - pv1x) * nx + (pv2y - pv1y) * ny;
    const invM1 = Number(b1.invMass?.()) || 0, invM2 = Number(b2.invMass?.()) || 0;
    const I1 = Number(b1.principalInertia?.()) || 0, I2 = Number(b2.principalInertia?.()) || 0;
    const invI1 = I1 > 1e-9 ? 1 / I1 : 0, invI2 = I2 > 1e-9 ? 1 / I2 : 0;
    const cross1 = r1.x * ny - r1.y * nx, cross2 = r2.x * ny - r2.y * nx;
    const effectiveInvMass = invM1 + invM2 + cross1 * cross1 * invI1 + cross2 * cross2 * invI2;
    if (effectiveInvMass <= 1e-9) return 0;
    const requiredVelocity = Math.abs(relativeSpeed) + distance / Math.max(dt, 1e-6);
    return Math.abs((requiredVelocity / effectiveInvMass) / Math.max(dt, 1e-6));
  }

  _checkBreakableRevoluteJoints(dt) {
    for (const [entityId, entry] of this._joints) {
      const joint = entry.component;
      if (!joint || joint.jointType !== JointType2D.REVOLUTE || !joint.breakable || entry.broken) continue;
      const limit = Math.max(0, Number(joint.breakForce) || 0);
      if (limit <= 0) continue;
      const demand = this._estimateRevoluteBreakForce(entry, joint, dt);
      if (demand <= limit) continue;
      try { this.rapierWorld.removeImpulseJoint(entry.joint, true); } catch (_) {}
      entry.broken = true;
      if (joint.connectedEntityId) {
        this._disabledJointCollisionPairs?.delete?.(this._collisionPairKey(entityId, joint.connectedEntityId));
      }
      try { entry.body1.wakeUp(); } catch (_) {}
      try { entry.body2.wakeUp(); } catch (_) {}
    }
  }

  _syncJoints(world) {
    const RAPIER = this.RAPIER;
    const entities = world.query(JOINT_2D);
    const seen = new Set();
    const usedAnchorKeys = new Set();
    const disabledCollisionPairs = new Set();

    for (const entity of entities) {
      const joint = entity.getComponent(JOINT_2D);
      const transform = entity.getComponent(TRANSFORM);
      if (!joint.enabled || !transform) continue;

      const selfHandle = this._handles.get(entity.id);
      if (!selfHandle) continue; // entity has no Rigidbody2D/Collider2D yet

      let body2 = null;
      let anchorKey = null;
      if (joint.connectedEntityId) {
        const otherHandle = this._handles.get(joint.connectedEntityId);
        if (!otherHandle) {
          // Connected entity doesn't have a live body yet this step
          // (e.g. it's still loading, or was just deleted) — skip this
          // joint entirely for now rather than fall back to a world
          // anchor, so it snaps in correctly the moment the real body
          // exists instead of briefly welding to the wrong thing.
          continue;
        }
        body2 = otherHandle.body;
      } else {
        // World-anchored: anchor2 is an offset from the anchor body's
        // own position, and the hidden body never moves or rotates, so
        // its world position IS the joint's fixed point. Using
        // anchor2X/Y directly as that position (rather than always
        // pinning at (0,0) and leaving anchor2 to do the offsetting)
        // keeps a single anchor point shared across every Joint2D that
        // targets the same (anchor2X, anchor2Y) — see
        // _getOrCreateWorldAnchor's dedup-by-key.
        const ax = joint.anchor2X;
        const ay = joint.anchor2Y;
        body2 = this._getOrCreateWorldAnchor(ax, ay);
        anchorKey = ax.toFixed(2) + "," + ay.toFixed(2);
        usedAnchorKeys.add(anchorKey);
      }

      // World-anchored joints apply anchor2X/Y to POSITION the hidden
      // body itself (above), so the joint's own anchor2 must be
      // (0,0) — local origin of that hidden body — not the offset
      // again, or the anchor point would be double-applied.
      const anchor2X = joint.connectedEntityId ? joint.anchor2X : 0;
      const anchor2Y = joint.connectedEntityId ? joint.anchor2Y : 0;
      let entry = this._joints.get(entity.id);
      // Broken Revolutes stay broken until their component is disabled/re-enabled
      // or the scene is reloaded; do not recreate them on every physics step.
      if (entry?.broken && joint.jointType === JointType2D.REVOLUTE) {
        seen.add(entity.id);
        continue;
      }
      if (joint.disableConnectedCollision && joint.connectedEntityId) {
        disabledCollisionPairs.add(
          this._collisionPairKey(entity.id, joint.connectedEntityId)
        );
      }

      // Signature of everything that requires destroying and rebuilding
      // the Rapier joint (as opposed to the live-tunable fields applied
      // below via _applyUnitJointTuning, which don't need a rebuild).
      const sig = [
        joint.jointType,
        joint.connectedEntityId || anchorKey,
        joint.anchor1X, joint.anchor1Y, anchor2X, anchor2Y,
        joint.axisX, joint.axisY,
        joint.length, joint.stiffness, joint.damping,
        joint.flexibility, joint.jointDrag, joint.restStiffness,
        joint.breakable, joint.breakForce,
        joint.segmentCount, joint.ropeMass,
        !!joint.disableConnectedCollision,
        (joint.jointType === JointType2D.REVOLUTE &&
          !!joint.motorEnabled && Number(joint.motorMaxForce) > 0) ? "motor:on" : "motor:off",
      ].join("|");

      const isFlexible =
        joint.jointType === JointType2D.ROPE ||
        joint.jointType === JointType2D.SPRING;
      const needsRebuild =
        !entry ||
        entry.sig !== sig ||
        entry.body1 !== selfHandle.body ||
        entry.body2 !== body2 ||
        (isFlexible ? !entry.flexible : entry.flexible);

      if (needsRebuild) {
        if (entry) {
          if (entry.flexible) {
            this._destroyFlexibleJoint(entry);
          } else if (entry.joint?.isValid?.()) {
            this.rapierWorld.removeImpulseJoint(entry.joint, true);
          }
        }

        const a1 = { x: joint.anchor1X, y: joint.anchor1Y };
        const a2 = { x: anchor2X, y: anchor2Y };

        if (isFlexible) {
          entry = {
            joint: null,
            sig,
            component: joint,
            body1: selfHandle.body,
            body2,
            flexible: true,
            links: [],
            segments: [],
          };
          this._buildFlexibleJoint(entry, joint, selfHandle.body, body2, a1, a2);
          this._joints.set(entity.id, entry);
        } else {
          let params;
          switch (joint.jointType) {
            case JointType2D.FIXED: {
              // Preserve the bodies' CURRENT relative orientation when the
              // weld is created. Using frame1=frame2=0 here would silently
              // demand that both bodies have the same world rotation and
              // could make an already-posed ragdoll limb snap/jerk on the
              // first solver step. A fixed joint should lock the existing
              // relative angle, just like a physical weld created in that
              // pose.
              let r1 = 0;
              let r2 = 0;
              try { r1 = Number(selfHandle.body.rotation()) || 0; } catch (_) {}
              try { r2 = Number(body2.rotation()) || 0; } catch (_) {}
              let relativeFrame2 = r2 - r1;
              while (relativeFrame2 > Math.PI) relativeFrame2 -= Math.PI * 2;
              while (relativeFrame2 < -Math.PI) relativeFrame2 += Math.PI * 2;
              params = RAPIER.JointData.fixed(a1, 0.0, a2, relativeFrame2);
              break;
            }
            case JointType2D.PRISMATIC: {
              let ax = joint.axisX, ay = joint.axisY;
              const len = Math.hypot(ax, ay);
              if (len < 1e-6) { ax = 1; ay = 0; } else { ax /= len; ay /= len; }
              params = RAPIER.JointData.prismatic(a1, a2, { x: ax, y: ay });
              break;
            }
            case JointType2D.REVOLUTE:
            default: {
              params = RAPIER.JointData.revolute(a1, a2);
              break;
            }
          }

          const rapierJoint = this.rapierWorld.createImpulseJoint(
            params,
            selfHandle.body,
            body2,
            true
          );
          rapierJoint.setContactsEnabled(!joint.disableConnectedCollision);
          // A newly-created constraint is a physical relationship, not a
          // request to keep two sleeping bodies frozen. Wake both endpoints
          // so gravity, motors, limits, and collisions can immediately take
          // effect. This matters when an editor-created joint is added to a
          // body that was already sleeping.
          try { selfHandle.body.wakeUp(); } catch (_) {}
          try { body2.wakeUp(); } catch (_) {}
          entry = {
            joint: rapierJoint,
            sig,
            component: joint,
            body1: selfHandle.body,
            body2,
            referenceAngle: joint.jointType === JointType2D.REVOLUTE
              ? (() => {
                  let rr1 = 0, rr2 = 0;
                  try { rr1 = Number(selfHandle.body.rotation()) || 0; } catch (_) {}
                  try { rr2 = Number(body2.rotation()) || 0; } catch (_) {}
                  let rel = rr2 - rr1;
                  while (rel > Math.PI) rel -= Math.PI * 2;
                  while (rel < -Math.PI) rel += Math.PI * 2;
                  return rel;
                })()
              : null,
          };
          this._joints.set(entity.id, entry);
        }
      }

      // Live-tunable every step regardless of whether a rebuild just
      // happened — motor/limits on Revolute and Prismatic only; Fixed/
      // Rope/Spring have no motor/limit surface in Rapier.
      if (joint.jointType === JointType2D.REVOLUTE || joint.jointType === JointType2D.PRISMATIC) {
        this._applyUnitJointTuning(entry.joint, joint, entry.referenceAngle);
      }

      seen.add(entity.id);
    }

    // Remove Rapier joints for entities whose Joint2D was removed,
    // disabled, or destroyed this step.
    for (const [entityId, entry] of this._joints) {
      if (!seen.has(entityId)) {
        if (entry.flexible) {
          this._destroyFlexibleJoint(entry);
        } else if (entry.joint?.isValid?.()) {
          this.rapierWorld.removeImpulseJoint(entry.joint, true);
        }
        this._joints.delete(entityId);
      }
    }

    this._pruneWorldAnchors(usedAnchorKeys);
    this._disabledJointCollisionPairs = disabledCollisionPairs;
    this._syncContactFilterHooks();
  }

  /**
   * Ensures entity has a matching Rapier body/collider whose settings
   * match its current components, creating or recreating as needed, and
   * pushes any editor-driven Transform/velocity changes onto the body.
   */
  _syncEntity(entity, dt) {
    const RAPIER = this.RAPIER;
    const transform = entity.getComponent(TRANSFORM);
    const rb = entity.getComponent(RIGIDBODY_2D);
    const collider = entity.getComponent(COLLIDER_2D);

    // An entity with ONLY a Collider2D (no Rigidbody2D) is an implicit
    // static collider — the common "just a wall" Unity pattern.
    const effectiveBodyType = rb ? rb.bodyType : BodyType.STATIC;
    const simulated = rb ? rb.simulated : true;

    // A script's `this.rigidbody.type = ...` already dropped the stale
    // force/impulse/move requests at the moment it switched (see
    // Rigidbody2D.js's bodyTypeSwitchHandled for why). Consume that
    // mark here — every sync, not only when a rebuild happens, so it
    // can't linger past this frame (a switch and switch-back in one
    // frame needs no rebuild, and a !simulated body returns early
    // below) and wrongly suppress a later, unrelated rebuild's clear.
    const scriptSwitchedType = rb ? bodyTypeSwitchHandled.delete(rb) : false;

    let handle = this._handles.get(entity.id);

    if (!simulated) {
      // simulated=false: remove any live body, do nothing further, but
      // keep no handle so it's recreated cleanly if re-enabled.
      if (handle) {
        if (handle.collider) this._colliderHandleMap.delete(handle.collider.handle);
        if (handle.collider) this._oneWayPlatformHandles.delete(handle.collider.handle);
        if (handle.collider) this._colliderWorldBoundsCache.delete(handle.collider.handle);
        this.rapierWorld.removeRigidBody(handle.body);
        this._handles.delete(entity.id);
      }
      return;
    }

    const needsNewBody = !handle || handle.bodyType !== effectiveBodyType;

    if (needsNewBody) {
      if (handle) {
        if (handle.collider) this._colliderHandleMap.delete(handle.collider.handle);
        if (handle.collider) this._oneWayPlatformHandles.delete(handle.collider.handle);
        if (handle.collider) this._colliderWorldBoundsCache.delete(handle.collider.handle);
        this.rapierWorld.removeRigidBody(handle.body);
      }

      // Body type just changed (or is being created) — drop any
      // force/impulse/move request queued for a previous body type so
      // nothing carries over into a type that doesn't support it (e.g.
      // a force queued while Dynamic must not silently apply the
      // instant this entity becomes Dynamic again after a detour
      // through Kinematic).
      //
      // Skipped when a script's `this.rigidbody.type = ...` caused the
      // change: it already dropped the stale requests when it switched,
      // so whatever is queued NOW was queued after the switch (e.g.
      // `type = "Dynamic"; addImpulse(...)` in one onUpdate) and is
      // meant to apply to the new body, not be thrown away with it.
      if (rb && !scriptSwitchedType) {
        clearPendingBodyRequests(rb);
      }

      const desc = new RAPIER.RigidBodyDesc(rapierBodyType(RAPIER, effectiveBodyType))
        .setTranslation(transform.x, transform.y)
        .setRotation(transform.rotation * DEG2RAD);

      const body = this.rapierWorld.createRigidBody(desc);
      handle = { body, collider: null, bodyType: effectiveBodyType, _colliderRef: null, _entityId: entity.id, rigidbody2D: rb };
      this._handles.set(entity.id, handle);
    } else {
      handle.rigidbody2D = rb;
      // Static bodies never move via simulation, but the editor may
      // still drag them around in edit mode — keep them synced to
      // Transform. Dynamic bodies own their own position once created;
      // don't stomp Rapier's simulated position with stale Transform
      // data every frame.
      if (effectiveBodyType === BodyType.STATIC) {
        handle.body.setTranslation({ x: transform.x, y: transform.y }, true);
        handle.body.setRotation(transform.rotation * DEG2RAD, true);
      } else if (effectiveBodyType === BodyType.KINEMATIC) {
        // Capture the ACTUAL previous Rapier pose before applying any
        // Transform.rotation written by the script this frame. This is
        // needed later by _syncKinematicMovement() to distinguish a true
        // grounded rotation snap from an ordinary airborne rotation.
        try {
          handle.rigidbody2D._previousKinematicRotation = Number(handle.body.rotation()) || 0;
        } catch (_) {
          handle.rigidbody2D._previousKinematicRotation = null;
        }

        // Position-based kinematics are driven by setNextKinematic* calls,
        // but scripts are allowed to write Transform.rotation directly
        // (for example: `this.rotation = 90` when grounded).  Previously
        // that write was visible to rendering while the Rapier body kept
        // the previous-frame angle until the very end of this sync.  On a
        // contact edge this one-frame mismatch could change the manifold
        // and make grounded state flicker, which in turn made a scripted
        // snap such as 90 -> 92 -> 90 look like a shake.
        //
        // Kinematic rotation has no solver-generated angular correction, so
        // when the ECS Transform and Rapier body disagree, the Transform is
        // the authoritative script/editor input for THIS frame.  Normal
        // kinematic angular motion remains intact because
        // _syncKinematicMovement() schedules the next kinematic rotation
        // from the same Transform plus rb.angularVelocity * dt.
        const scriptedRotation = Number(rb._scriptRotationTarget);
        const desiredRotation = (Number.isFinite(scriptedRotation) ? scriptedRotation : transform.rotation) * DEG2RAD;
        let currentRotation = 0;
        try { currentRotation = Number(handle.body.rotation()) || 0; } catch (_) {}
        let delta = desiredRotation - currentRotation;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        if (Math.abs(delta) > 1e-7) {
          handle.body.setRotation(desiredRotation, true);
        }
      }
    }

    // Apply an intentional script-authored TELEPORT for Dynamic/
    // Kinematic bodies — see Rigidbody2D.js's markScriptPositionTarget
    // doc comment for the full rationale. Skipped for Static (already
    // fully re-synced from Transform every frame just above) and for a
    // body that was JUST created this call (needsNewBody's
    // RigidBodyDesc already used transform.x/y directly, so the target
    // — if any — is already satisfied).
    //
    // Deliberately placed AFTER the STATIC/KINEMATIC-rotation branch
    // above (so a same-frame position AND rotation script write both
    // land before this entity's collider/kinematic-movement sync below
    // sees them) but BEFORE _syncCollider/_syncKinematicMovement, so a
    // teleported Kinematic body's grounded/contact state is computed
    // against its NEW position this same step rather than one frame
    // stale.
    if (!needsNewBody && rb && (effectiveBodyType === BodyType.DYNAMIC || effectiveBodyType === BodyType.KINEMATIC)) {
      const targetX = rb._scriptPositionTargetX;
      const targetY = rb._scriptPositionTargetY;
      if (targetX !== null && targetY !== null && Number.isFinite(targetX) && Number.isFinite(targetY)) {
        handle.body.setTranslation({ x: targetX, y: targetY }, true);
        if (effectiveBodyType === BodyType.DYNAMIC) {
          // A teleport is a position SNAP, not a high-speed traversal —
          // without zeroing linvel, Rapier would otherwise still be
          // carrying whatever velocity the body had right before the
          // teleport (or CCD could even try to "sweep" through the
          // jump), producing a visible slide/impact at the new spot
          // instead of a clean, motionless arrival. Matches Unity's own
          // Rigidbody2D.position = ... behavior, which likewise does
          // not preserve velocity across a position snap.
          handle.body.setLinvel({ x: 0, y: 0 }, true);
          handle.body.wakeUp();
        }
        // Keep the ECS Transform authoritative for this exact value —
        // it's already at targetX/Y from the script write that set the
        // flag, but re-asserting here is cheap and guards against any
        // floor/collider-offset code between here and the post-step
        // Rapier->Transform sync reading a stale value in between.
        transform.x = targetX;
        transform.y = targetY;
      }
    }
    // One-shot: clear regardless of whether a teleport was actually
    // pending, so a body that starts as Static (or simulated=false, or
    // mid-recreate) and only later gains a live Dynamic/Kinematic body
    // doesn't replay a teleport request from several frames ago.
    if (rb) {
      rb._scriptPositionTargetX = null;
      rb._scriptPositionTargetY = null;
    }

    // Apply per-body-type tunables every frame (cheap, and lets the
    // Inspector's live sliders take effect immediately).
    if (rb) {
      if (effectiveBodyType === BodyType.DYNAMIC) {
        handle.body.setGravityScale(rb.gravityScale, true);
        handle.body.setLinearDamping(rb.linearDamping);
        handle.body.setAngularDamping(rb.angularDamping);
        handle.body.lockRotations(!!rb.lockRotation, true);
        // Auto Mass uses Rapier's collider-derived mass properties. Manual
        // mode retains the explicit additional-mass control.
        handle.body.setAdditionalMass(rb.autoMass !== false ? 0 : Math.max(0.0001, rb.mass), true);

        // Controller-driven Dynamic bodies are game-play movers, not tiny
        // debris objects. Keep CCD enabled for them so high-speed jumps,
        // wall runs, and ceiling hits do not tunnel through thin geometry.
        const hasMovementType = !!this._stepWorld?.getEntity(entity.id)?.hasComponent(CHARACTER_CONTROLLER);
        if (typeof handle.body.enableCcd === "function") {
          handle.body.enableCcd(hasMovementType);
        } else if (typeof handle.body.setCcdEnabled === "function") {
          handle.body.setCcdEnabled(hasMovementType);
        }

        // A CharacterController (runtime/systems/ControllerSystem.js)
        // may request a specific horizontal speed and/or override Y
        // (a jump kick, or continuous Y drive for Top-Down) this frame
        // WITHOUT taking over the whole body: X is set directly (so
        // movement feels responsive instead of force-accelerated), Y is
        // left to Rapier's own gravity/solver integration unless a
        // controller explicitly requested a Y override. This is still
        // 100% Rapier's solver doing the actual moving/colliding — this
        // just seeds its linear velocity, the same primitive the
        // Inspector's own Kinematic velocity fields use.
        if (rb.driveVelocityX !== null || rb.driveVelocityY !== null || rb.driveAngularVelocity !== null) {
          const current = handle.body.linvel();
          const nextX = rb.driveVelocityX !== null ? rb.driveVelocityX : current.x;
          const nextY = rb.driveVelocityY !== null ? rb.driveVelocityY : current.y;
          handle.body.setLinvel({ x: nextX, y: nextY }, true);
          if (rb.driveAngularVelocity !== null) {
            handle.body.setAngvel(rb.driveAngularVelocity, true);
          }
          handle.body.wakeUp();
        }
        // These are one-shot, transient requests — clear them now that
        // they've been applied so a controller-less frame (or a
        // Free-type controller mid-script-drive) doesn't keep re-seeding
        // stale velocity forever.
        rb.driveVelocityX = null;
        rb.driveVelocityY = null;
        rb.driveAngularVelocity = null;

      }
      // The force/impulse/torque drain for DYNAMIC (just below the
      // KINEMATIC comment already here) is applied AFTER _syncCollider
      // for the same reason KINEMATIC's sweep is: on the frame a body is
      // freshly created (or just switched type — see RigidbodyAPI.js's
      // `type` setter), it has no collider attached yet, and Rapier
      // treats a collider-less body as having zero mass — applyImpulse/
      // addForce on it is a silent no-op. A script that does
      // `this.rigidbody.type = "Dynamic"; this.rigidbody.addImpulse(...)`
      // in the same onUpdate must not have that impulse silently
      // swallowed just because the type switch happened this same frame.
      //
      // KINEMATIC is handled further below, also AFTER _syncCollider —
      // its sweep needs handle.collider to exist too, for the same
      // reason.
    }

    this._syncCollider(handle, collider, transform);

    if (rb && effectiveBodyType === BodyType.DYNAMIC) {
      // Drain any force/impulse/torque a script queued this frame via
      // DynamicRigidbodyAPI (scripting/components/RigidbodyAPI.js).
      //
      // IMPORTANT: Rapier's addForce/addTorque are NOT automatically
      // zeroed after a timestep (that changed in a past Rapier
      // release — see rapier.js's own CHANGELOG) — a force added once
      // stays in Rapier's internal accumulator and keeps being
      // applied EVERY step forever until resetForces()/resetTorques()
      // is called. Unity's Rigidbody2D.AddForce, which this API is
      // modeled on, works the opposite way: a force only acts for the
      // ONE FixedUpdate it was called in — sustaining a push means
      // calling AddForce again next frame. To match that expected
      // behavior (and avoid a single addForce call silently
      // accelerating a body forever), Rapier's accumulator is reset
      // FIRST every step, then this frame's queued force (if any) is
      // added back on top — so a script that stops calling addForce
      // actually stops accelerating the body, exactly like Unity.
      // Impulses are already one-shot by nature (instantaneous
      // velocity change) and need no such reset.
      handle.body.resetForces(true);
      handle.body.resetTorques(true);

      if (rb.pendingForceX !== 0 || rb.pendingForceY !== 0) {
        handle.body.addForce({ x: rb.pendingForceX, y: rb.pendingForceY }, true);
        rb.pendingForceX = 0;
        rb.pendingForceY = 0;
      }

      // Point forces are kept outside the serializable Rigidbody2D component
      // (see queueForceAtPoint/drainPendingPointForces). Applying them through
      // Rapier's native point-force API preserves both linear acceleration and
      // the correct torque around the actual world-space application point.
      const pendingPointForces = drainPendingPointForces(rb);
      for (const request of pendingPointForces) {
        if (!request) continue;
        handle.body.addForceAtPoint(
          { x: request.forceX, y: request.forceY },
          { x: request.pointX, y: request.pointY },
          true
        );
      }
      if (rb.pendingImpulseX !== 0 || rb.pendingImpulseY !== 0) {
        handle.body.applyImpulse({ x: rb.pendingImpulseX, y: rb.pendingImpulseY }, true);
        rb.pendingImpulseX = 0;
        rb.pendingImpulseY = 0;
      }
      if (rb.pendingTorque !== 0) {
        handle.body.addTorque(rb.pendingTorque, true);
        rb.pendingTorque = 0;
      }
      if (rb.pendingAngularImpulse !== 0) {
        handle.body.applyTorqueImpulse(rb.pendingAngularImpulse, true);
        rb.pendingAngularImpulse = 0;
      }
    }

    // Refresh the one-way filter's plain-JS geometry cache EVERY frame, even
    // when _syncCollider took its shape-only fast path. filterContactPair runs
    // inside Rapier's solve, where querying Rapier-owned transforms is unsafe,
    // so the callback must consume geometry prepared here before the solve.
    //
    // The old cache stored centerY + the collider's UNROTATED halfHeight.
    // That is incorrect for an unlocked Dynamic body: when a box rotates, its
    // true lowest world-space point changes with sin/cos even if its center has
    // barely moved. A Platformer/Character Controller Dynamic can therefore
    // rotate into the platform while the one-way test still thinks it stayed
    // above it, then lose the contact and fall through. Cache the real support
    // edge instead, including the current and previous rotation.
    if (handle.collider) {
      const cached = this._colliderWorldBoundsCache.get(handle.collider.handle);
      if (cached) {
        const rotationDeg = Number(transform?.rotation) || 0;
        const angle = rotationDeg * DEG2RAD;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const scaleX = Number(transform?.scaleX) || 1;
        const scaleY = Number(transform?.scaleY) || 1;
        const offsetX = (Number(collider?.offsetX) || 0) * scaleX;
        const offsetY = (Number(collider?.offsetY) || 0) * scaleY;
        const centerY = (Number(transform?.y) || 0) + offsetX * s + offsetY * c;

        let verticalExtent = Number(cached.halfHeight) || 0;
        if (cached.shape === ColliderShape.BOX) {
          verticalExtent =
            Math.abs(c) * (Number(cached.halfHeight) || 0) +
            Math.abs(s) * (Number(cached.halfWidth) || 0);
        } else if (cached.shape === ColliderShape.CAPSULE) {
          verticalExtent =
            Math.abs(c) * (Number(cached.halfHeight) || 0) +
            (Number(cached.radius) || 0);
        } else if (cached.shape === ColliderShape.CIRCLE) {
          verticalExtent = Number(cached.radius) || 0;
        } else if (cached.shape === ColliderShape.TRIANGLE) {
          const points = Array.isArray(collider?.trianglePoints) ? collider.trianglePoints : [];
          let maxY = 0;
          for (const point of points) {
            const px = (Number(point?.x) || 0) * scaleX;
            const py = (Number(point?.y) || 0) * scaleY;
            const pointY = px * s + py * c;
            if (pointY > maxY) maxY = pointY;
          }
          verticalExtent = Math.max(0, maxY);
        }

        const currentBottomY = centerY + verticalExtent;
        const currentTopY = centerY - verticalExtent;
        cached.previousCenterY = Number.isFinite(cached.centerY)
          ? cached.centerY
          : centerY;
        cached.previousBottomY = Number.isFinite(cached.bottomY)
          ? cached.bottomY
          : currentBottomY;
        cached.centerY = centerY;
        cached.bottomY = currentBottomY;
        cached.topY = currentTopY;
        cached.halfHeight = Number(cached.halfHeight) || verticalExtent;
        cached.vy = rb ? rb.velocityY : 0;
      }
    }

    if (rb && effectiveBodyType === BodyType.KINEMATIC) {
      this._syncKinematicMovement(handle, rb, dt);
    }
  }

  /**
   * Returns the world-space support point of a Collider2D relative to the
   * Rigidbody center, in the supplied world direction. The direction uses
   * the same convention as _readContactState: for a flat floor the ground
   * direction toward the support is +Y in this engine's coordinate system.
   *
   * This is used only when a grounded Kinematic script changes rotation. It
   * preserves the actual contact point instead of letting the new collider
   * pose create a gap and a subsequent gravity/contact oscillation.
   */
  _kinematicSupportPoint(collider, transform, rotationDeg, directionX, directionY) {
    const dx = Number(directionX) || 0;
    const dy = Number(directionY) || 0;
    const dLen = Math.hypot(dx, dy);
    const nx = dLen > 1e-7 ? dx / dLen : 0;
    const ny = dLen > 1e-7 ? dy / dLen : 1;

    const angle = Number(rotationDeg || 0) * DEG2RAD;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const sx = Number(transform?.scaleX) || 1;
    const sy = Number(transform?.scaleY) || 1;
    const ox = (Number(collider?.offsetX) || 0) * sx;
    const oy = (Number(collider?.offsetY) || 0) * sy;
    const rox = ox * c - oy * s;
    const roy = ox * s + oy * c;

    if (collider.shape === ColliderShape.CIRCLE) {
      const radius = (Number(collider.radius) || 0) * Math.max(Math.abs(sx), Math.abs(sy));
      return { x: rox + nx * radius, y: roy + ny * radius };
    }

    if (collider.shape === ColliderShape.CAPSULE) {
      const halfHeight = (Number(collider.capsuleHalfHeight) || 0) * Math.abs(sy);
      const radius = (Number(collider.capsuleRadius) || 0) * Math.max(Math.abs(sx), Math.abs(sy));
      const ux = -s; // rotated local +Y axis
      const uy = c;
      const sign = (ux * nx + uy * ny) >= 0 ? 1 : -1;
      return {
        x: rox + ux * halfHeight * sign + nx * radius,
        y: roy + uy * halfHeight * sign + ny * radius,
      };
    }

    if (collider.shape === ColliderShape.TRIANGLE) {
      let best = { x: rox, y: roy, dot: -Infinity };
      for (const p of (collider.trianglePoints || [])) {
        const lx = (Number(p?.x) || 0) * sx;
        const ly = (Number(p?.y) || 0) * sy;
        const wx = rox + lx * c - ly * s;
        const wy = roy + lx * s + ly * c;
        const dot = wx * nx + wy * ny;
        if (dot > best.dot) best = { x: wx, y: wy, dot };
      }
      return { x: best.x, y: best.y };
    }

    const halfWidth = Math.abs((Number(collider.width) || 0) * sx) / 2;
    const halfHeight = Math.abs((Number(collider.height) || 0) * sy) / 2;
    const uxX = c, uxY = s;
    const uyX = -s, uyY = c;
    const signX = (uxX * nx + uxY * ny) >= 0 ? 1 : -1;
    const signY = (uyX * nx + uyY * ny) >= 0 ? 1 : -1;
    return {
      x: rox + uxX * halfWidth * signX + uyX * halfHeight * signY,
      y: roy + uxY * halfWidth * signX + uyY * halfHeight * signY,
    };
  }

  /**
   * Resolves engine-level Kinematic movement using Rapier shape casts.
   *
   * This is intentionally NOT a second physics engine and NOT a Rapier
   * CharacterController: Rapier still owns contacts, impulses, friction,
   * gravity and dynamic-body response. The engine only asks Rapier where the
   * existing collider can move this frame, then submits the resolved target
   * position back as a normal position-based kinematic body.
   */
  /**
   * Synchronize a Kinematic script rotation immediately during the script
   * phase. When the body is grounded, preserve the current world-space
   * support point under the stored ground normal so a sudden collider rotation
   * (such as a Geometry-style 127° -> 90° landing snap) cannot create a
   * one-frame support gap and subsequent visible bounce. Airborne rotation is
   * left alone; this is purely a grounded pose-preservation operation.
   */
  syncScriptKinematicRotation(entity, rotationDeg) {
    if (!this.ready || !entity) return false;
    const rb = entity.getComponent?.(RIGIDBODY_2D);
    const transform = entity.getComponent?.(TRANSFORM);
    if (!rb || rb.bodyType !== BodyType.KINEMATIC || !transform) return false;

    const handle = this._handles.get(entity.id);
    if (!handle?.body || !handle?.collider || handle.collider.isSensor?.()) return false;
    const targetDeg = Number(rotationDeg);
    if (!Number.isFinite(targetDeg) || rb.lockRotation) return false;

    let currentRad = 0;
    try { currentRad = Number(handle.body.rotation()) || 0; }
    catch (_) { currentRad = Number(transform.rotation || 0) * DEG2RAD; }
    const targetRad = targetDeg * DEG2RAD;

    // Capture the signed distance to the support surface BEFORE changing the
    // collider angle. Rapier's contact query includes a small contact margin,
    // so preserving this existing signed distance is what keeps the snapped
    // pose at the same solver-resting height instead of creating a tiny
    // overlap that the next physics step would correct visibly.
    let oldSupportDistance = 0;
    let supportNx = Number(rb._groundNormalX) || 0;
    let supportNy = Number(rb._groundNormalY);
    if (!Number.isFinite(supportNy)) supportNy = 1;
    const supportLen = Math.hypot(supportNx, supportNy);
    if (supportLen > 1e-7) {
      supportNx /= supportLen;
      supportNy /= supportLen;
    } else {
      supportNx = 0;
      supportNy = 1;
    }
    const canPreserveSupport = rb.grounded && !rb.lockRotation && handle._colliderRef &&
      !(Number(rb._scriptVelocityY) < -0.001);
    if (canPreserveSupport) {
      try {
        const slopeMin = Math.max(0, Math.min(89.9, rb.slopeMinAngle ?? 10));
        const minGroundY = Math.cos(slopeMin * DEG2RAD);
        let bestAlignment = -Infinity;
        let bestDistance = null;
        for (const [colliderHandle] of this._colliderHandleMap) {
          const other = this.rapierWorld.getCollider(colliderHandle);
          if (!other || other === handle.collider || other.isSensor?.()) continue;
          if (!this._collisionGroupsInteract(handle.collider.collisionGroups(), other.collisionGroups())) continue;
          try {
            const contact = handle.collider.contactCollider(other, 0);
            const distance = Number(contact?.distance);
            if (!Number.isFinite(distance) || Math.abs(distance) > 2.0) continue;
            const raw = contact?.normal1;
            const rnx = Number(raw?.x) || 0;
            const rny = Number(raw?.y) || 0;
            const rlen = Math.hypot(rnx, rny);
            if (rlen < 1e-7) continue;
            const cnx = rnx / rlen;
            const cny = rny / rlen;
            if (cny < minGroundY) continue;
            const alignment = cnx * supportNx + cny * supportNy;
            if (alignment > bestAlignment) {
              bestAlignment = alignment;
              bestDistance = distance;
            }
          } catch (_) {}
        }
        if (bestDistance !== null) oldSupportDistance = bestDistance;
      } catch (_) {}
    }

    let delta = targetRad - currentRad;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    // Always synchronize the Rapier pose to the exact scripted target.
    try { handle.body.setRotation(targetRad, true); } catch (_) {}
    if (Math.abs(delta) <= 1e-7) {
      rb._previousKinematicRotation = targetRad;
      return false;
    }

    const scriptVelocityY = Number(rb._scriptVelocityY);
    const jumping = Number.isFinite(scriptVelocityY) && scriptVelocityY < -0.001;
    if (!rb.grounded || jumping || !handle._colliderRef) return true;

    const nx = supportNx;
    const ny = supportNy;

    const oldSupport = this._kinematicSupportPoint(
      handle._colliderRef, transform, currentRad * RAD2DEG, nx, ny
    );
    const newSupport = this._kinematicSupportPoint(
      handle._colliderRef, transform, targetDeg, nx, ny
    );

    let correctionX = oldSupport.x - newSupport.x;
    let correctionY = oldSupport.y - newSupport.y;
    // Rotation is not movement. On a flat ground surface, preserve the
    // existing horizontal center exactly so a pure rotation reset cannot
    // create forward/backward travel when velocityX is untouched.
    if (Math.abs(nx) < 1e-4) correctionX = 0;
    const maxCorrection = 32;
    const correctionLength = Math.hypot(correctionX, correctionY);
    if (correctionLength > maxCorrection) {
      const scale = maxCorrection / correctionLength;
      correctionX *= scale;
      correctionY *= scale;
    }

    if (Math.hypot(correctionX, correctionY) > 1e-7) {
      const pos = handle.body.translation();
      const x = Number(pos.x) + correctionX;
      const y = Number(pos.y) + correctionY;
      transform.x = x;
      transform.y = y;
      try { handle.body.setTranslation({ x, y }, true); } catch (_) {}
      rb._rotationSnapCorrectionX = correctionX;
      rb._rotationSnapCorrectionY = correctionY;
    }

    // Preserve the pre-snap Rapier support distance after the geometric
    // support-point correction. This cancels the collider/contact margin that
    // would otherwise be interpreted as penetration on the next step.
    if (oldSupportDistance !== 0 && canPreserveSupport) {
      const dx = nx * oldSupportDistance;
      const dy = ny * oldSupportDistance;
      if (Math.hypot(dx, dy) <= 2.0) {
        const pos = handle.body.translation();
        const x = Number(pos.x) + dx;
        const y = Number(pos.y) + dy;
        transform.x = x;
        transform.y = y;
        try { handle.body.setTranslation({ x, y }, true); } catch (_) {}
        rb._rotationSnapCorrectionX = (rb._rotationSnapCorrectionX || 0) + dx;
        rb._rotationSnapCorrectionY = (rb._rotationSnapCorrectionY || 0) + dy;
      }
    }

    rb._rotationSnapGrounded = true;
    rb._rotationSnapGroundedFrames = 3;
    rb._previousKinematicRotation = targetRad;
    try { handle.body.setNextKinematicRotation(targetRad); } catch (_) {}
    return true;
  }

  _syncKinematicMovement(handle, rb, dt) {
    const extraMoveX = rb.pendingMoveX || 0;
    const extraMoveY = rb.pendingMoveY || 0;
    // Do not clear _rotationSnapGrounded here. Once a grounded rotation
    // snap has re-seated the collider, the marker must survive until Rapier
    // publishes the new-pose contact manifold. A script may run between
    // physics frames and needs to see the body as grounded during that
    // transition. The marker is cleared below as soon as the real manifold
    // confirms grounding (or an explicit upward jump begins).
    rb._rotationSnapCorrectionX = 0;
    rb._rotationSnapCorrectionY = 0;
    rb.pendingMoveX = null;
    rb.pendingMoveY = null;

    if (!handle.collider || handle.collider.isSensor?.()) {
      const current = handle.body.translation();
      const dx = rb.velocityX * dt + extraMoveX;
      const dy = rb.velocityY * dt + extraMoveY;
      handle.body.setNextKinematicTranslation({ x: current.x + dx, y: current.y + dy });
      rb.resolvedVelocityX = dt > 0 ? dx / dt : 0;
      rb.resolvedVelocityY = dt > 0 ? dy / dt : 0;
      return;
    }

    let remaining = {
      x: rb.velocityX * dt + extraMoveX,
      y: rb.velocityY * dt + extraMoveY,
    };
    const originalPosition = handle.body.translation();
    const source = handle.collider;
    const sourceData = handle._colliderRef;
    const skin = 0.01;

    // A Dynamic body can be a legitimate moving platform for a Kinematic
    // Platformer. Carry only from contacts whose outward normal points up;
    // side contacts are ordinary collision surfaces. This makes standing on
    // a Dynamic platform stable and lets a jump inherit the platform motion
    // instead of appearing to lose its floor under it.
    if (rb._controllerType === 'Platformer') {
      try {
        let supportVX = 0;
        let supportVY = 0;
        let supportWeight = 0;
        this.rapierWorld.contactPairsWith(source, (other) => {
          if (!other || other === source || other.isSensor?.()) return;
          const otherBody = typeof other.parent === 'function' ? other.parent() : null;
          if (!otherBody || otherBody.bodyType?.() !== this.RAPIER.RigidBodyType.Dynamic) return;
          this.rapierWorld.contactPair(source, other, (manifold, flipped) => {
            const n = this._selfContactNormal(source, manifold, flipped);
            if (!n) return;
            const nx = Number(n.x) || 0;
            const ny = Number(n.y) || 0;
            if (ny < 0.65 || Math.abs(ny) <= Math.abs(nx) * 1.25) return;
            const platformVelocity = otherBody.linvel?.();
            if (!platformVelocity) return;
            const weight = Math.max(0.25, Math.min(1, ny));
            supportVX += (Number(platformVelocity.x) || 0) * weight;
            supportVY += (Number(platformVelocity.y) || 0) * weight;
            supportWeight += weight;
          });
        });
        if (supportWeight > 0) {
          remaining.x += (supportVX / supportWeight) * dt;
          remaining.y += (supportVY / supportWeight) * dt;
        }
      } catch (_) {}
    }
    let position = { x: originalPosition.x, y: originalPosition.y };

    // A scripted Kinematic rotation can change which point of a grounded
    // collider is touching its support. Preserve that actual contact point
    // when the script changes angle (for example 120° -> 0° on a Geometry
    // cube). Without this correction the new pose can leave a small gap;
    // gravity then drops the cube back onto the same floor and grounded
    // flickers, which looks like vibration. This is a geometric re-seat, not
    // a force, spring, friction hack, or free downward teleport.
    const scriptedRotation = Number(rb._scriptRotationTarget);
    const previousRotation = Number(rb._previousKinematicRotation);
    if (
      rb.grounded &&
      Number.isFinite(scriptedRotation) &&
      Number.isFinite(previousRotation) &&
      !(Number(rb._scriptVelocityY) < -0.001)
    ) {
      let angleDelta = scriptedRotation * DEG2RAD - previousRotation;
      while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
      while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;

      if (Math.abs(angleDelta) > 1e-7) {
        const gnx = Number(rb._groundNormalX) || 0;
        const gny = Number(rb._groundNormalY) || 1;
        const supportTransform = this._stepWorld?.getEntity(handle._entityId)?.getComponent(TRANSFORM);
        const oldSupport = this._kinematicSupportPoint(sourceData, supportTransform, previousRotation * RAD2DEG, gnx, gny);
        const newSupport = this._kinematicSupportPoint(sourceData, supportTransform, scriptedRotation, gnx, gny);
        let correctionX = oldSupport.x - newSupport.x;
        const correctionY = oldSupport.y - newSupport.y;

        // A scripted rotation must not manufacture horizontal motion on a
        // flat floor. Slopes retain normal-based support correction.
        if (Math.abs(gnx) < 1e-4) correctionX = 0;

        // Limit only extreme editor-time/custom-script rotations. Normal
        // Geometry cube cardinal snaps are far below this and remain exact.
        // The cap prevents an accidental multi-hundred-pixel offset from a
        // malformed collider from becoming a teleport.
        const maxCorrection = 32;
        const correctionLength = Math.hypot(correctionX, correctionY);
        const scale = correctionLength > maxCorrection ? maxCorrection / correctionLength : 1;
        const appliedX = correctionX * scale;
        const appliedY = correctionY * scale;
        position.x += appliedX;
        position.y += appliedY;
        rb._rotationSnapCorrectionX = appliedX;
        rb._rotationSnapCorrectionY = appliedY;
        rb._rotationSnapGrounded = true;
        // Keep the support lock for two physics updates. The first update can
        // still expose the pre-rotation manifold; the second lets Rapier
        // publish the new rotated contact even on a solver/query boundary.
        rb._rotationSnapGroundedFrames = 3;
        handle.body.setTranslation(position, true);
      }
    }

    let pinnedDynamicStop = false;
    let pinnedDynamicNormal = null;

    // KinematicPositionBased bodies are user-driven, so Rapier does not
    // automatically relocate a body that starts a frame already intersecting
    // a fixed/kinematic collider.  Recover only a SMALL amount here.  The
    // important rule is that overlap recovery must never become a teleport: a
    // bad editor overlap or a tiny corner penetration should be corrected
    // gradually, while the normal sweep remains responsible for ordinary
    // movement and collision blocking. Dynamic bodies are intentionally
    // excluded so Kinematic -> Dynamic pushing is unchanged.
    //
    // We combine all penetrating contact normals into one bounded correction
    // instead of moving once per collider.  That avoids the old corner bug
    // where a wall correction followed by a floor correction could add up to
    // a large displacement or flip the body back and forth between contacts.
    const MAX_DEPENETRATION_PER_FRAME = 0.75; // px/frame; bounded, never a teleport
    let correctionX = 0;
    let correctionY = 0;
    let deepestPenetration = 0;
    let deepestSupportNormal = { x: 0, y: 0 };

    handle.body.setTranslation(position, true);
    for (const [colliderHandle] of this._colliderHandleMap) {
      const other = this.rapierWorld.getCollider(colliderHandle);
      if (!other || other === source || other.isSensor?.()) continue;
      if (!this._collisionGroupsInteract(source.collisionGroups(), other.collisionGroups())) continue;

      // Match the one-way rule used by the movement sweep. If a Kinematic
      // body is jumping up through a one-way platform, or is already below
      // its top surface, overlap recovery must not push it back down and
      // re-create the very blockage the sweep is supposed to avoid.
      if (this._oneWayPlatformHandles.has(other.handle)) {
        const platformBounds = this._colliderWorldBoundsCache.get(other.handle);
        const sourceBounds = this._colliderWorldBoundsCache.get(source.handle);
        if (platformBounds && sourceBounds) {
          const platformTop = Number.isFinite(platformBounds.topY)
            ? platformBounds.topY
            : platformBounds.centerY - platformBounds.halfHeight;
          const sourceBottom = Number.isFinite(sourceBounds.bottomY)
            ? sourceBounds.bottomY
            : position.y + sourceBounds.halfHeight;
          if (remaining.y < -1e-7 || sourceBottom > platformTop + skin) continue;
        }
      }

      const otherBody = typeof other.parent === "function" ? other.parent() : null;
      const otherBodyType = otherBody?.bodyType?.();
      if (otherBodyType === this.RAPIER.RigidBodyType.Dynamic) continue;

      let contact = null;
      try {
        contact = source.contactCollider(other, 0);
      } catch (_) {
        continue;
      }
      const distance = Number(contact?.distance);
      if (!(distance < -1e-5)) continue;

      const normal = contact.normal1 || { x: 0, y: 0 };
      const nx = Number(normal.x) || 0;
      const ny = Number(normal.y) || 0;
      // A just-snapped Geometry-style Kinematic cube can sit inside Rapier's
      // tiny shape-contact margin even though the support point was deliberately
      // re-seated. Do not immediately undo that verified snap; other overlap
      // recovery paths keep the original threshold and behavior.
      if (rb._rotationSnapGrounded && distance >= -0.5 && ny > 0.55) continue;
      const len = Math.hypot(nx, ny);
      if (len < 1e-7) continue;

      const depth = -distance;
      const weight = Math.min(depth, 4);
      if (depth > deepestPenetration) {
        deepestSupportNormal = { x: nx / len, y: ny / len };
      }
      // contact.normal1 points from the source collider toward the other
      // collider. To move the Kinematic OUT of the other collider, apply the
      // opposite direction. Using +normal here pushes an overlap deeper into
      // the floor/wall and was the source of the previous large displacement.
      correctionX -= (nx / len) * weight;
      correctionY -= (ny / len) * weight;
      deepestPenetration = Math.max(deepestPenetration, depth);
    }

    const correctionLength = Math.hypot(correctionX, correctionY);
    if (correctionLength > 1e-7 && deepestPenetration > 1e-5) {
      // A KinematicPositionBased body is not relocated by Rapier's solver,
      // so a high-speed downward frame that begins just inside a floor can
      // otherwise spend many frames climbing out through the bounded
      // 0.75px recovery cap. Treat a clear support contact specially:
      // when the frame's requested motion is downward and the deepest
      // penetrating surface points upward, recover that actual penetration
      // in one Rapier-contact-derived correction. Side/corner overlaps keep
      // the existing bounded recovery so editor-time bad overlaps can never
      // turn into a large teleport.
      const fallingIntoSupport =
        remaining.y > 0 &&
        deepestSupportNormal.y > 0.55 &&
        Math.abs(deepestSupportNormal.y) > Math.abs(deepestSupportNormal.x) * 0.75;
      const correctionLimit = fallingIntoSupport
        ? Math.max(MAX_DEPENETRATION_PER_FRAME, Math.min(deepestPenetration + skin, 16))
        : MAX_DEPENETRATION_PER_FRAME;
      const scale = Math.min(correctionLimit / correctionLength, 1);
      position.x += correctionX * scale;
      position.y += correctionY * scale;

      if (fallingIntoSupport && rb.velocityY > 0) {
        // This frame was already resolved against the support plane. Clear
        // only downward intent; horizontal/tangent movement remains exactly
        // as requested by the caller.
        rb.velocityY = 0;
      }
    }

    for (let iteration = 0; iteration < 4; iteration++) {
      const distance = Math.hypot(remaining.x, remaining.y);
      if (distance < 1e-7) break;

      // castCollider uses the source collider's current world transform.
      // Temporarily place the real Rapier body at the resolved point so a
      // second/third slide cast starts from the point reached by the previous
      // impact, then restore the pre-step transform before submitting the
      // final kinematic target.
      handle.body.setTranslation(position, true);

      const velocity = { x: remaining.x, y: remaining.y };
      let closest = null;

      const consider = (other) => {
        if (!other || other === source || other.isSensor?.()) return;
        if (!this._collisionGroupsInteract(source.collisionGroups(), other.collisionGroups())) return;

        // Kinematic movement is resolved with a shape-cast BEFORE the Rapier
        // solver runs. That means Rapier's one-way PhysicsHooks filter cannot
        // protect a Kinematic body here: without this matching rule, the
        // shape-cast sees the platform as a normal solid collider and stops
        // the body underneath it for multiple frames. Dynamic bodies do not
        // use this sweep.
        //
        // A one-way platform is solid only for a downward crossing of its
        // top surface. Upward motion and horizontal/side motion must pass
        // through. A body that is already below the platform top must also
        // remain pass-through until it has cleared the platform and starts
        // falling.
        if (this._oneWayPlatformHandles.has(other.handle)) {
          const platformBounds = this._colliderWorldBoundsCache.get(other.handle);
          const sourceBounds = this._colliderWorldBoundsCache.get(source.handle);

          if (platformBounds && sourceBounds) {
            const platformTop = Number.isFinite(platformBounds.topY)
              ? platformBounds.topY
              : platformBounds.centerY - platformBounds.halfHeight;
            const sourceBottom = Number.isFinite(sourceBounds.bottomY)
              ? sourceBounds.bottomY
              : position.y + sourceBounds.halfHeight;

            if (
              remaining.y < -1e-7 ||       // moving upward
              remaining.y <= 1e-7 ||       // horizontal / stationary
              sourceBottom > platformTop + skin // already below the top
            ) {
              return;
            }
          }
        }

        const otherBody = typeof other.parent === "function" ? other.parent() : null;
        const otherBodyType = otherBody?.bodyType?.();
        let hit = null;
        let existingDynamicContact = false;
        if (otherBodyType === this.RAPIER.RigidBodyType.Dynamic) {
          try {
            const contact = source.contactCollider(other, skin);
            const distance = Number(contact?.distance);
            if (contact && Number.isFinite(distance) && distance <= skin + 1e-4) {
              existingDynamicContact = true;
              hit = { time_of_impact: 0, normal1: contact.normal1, normal2: contact.normal2, collider: other };
            }
          } catch (_) {}
        }
        if (!hit) try {
          hit = source.castCollider(velocity, other, { x: 0, y: 0 }, skin, 1, true);
        } catch (_) {
          return;
        }
        if (!hit && otherBodyType === this.RAPIER.RigidBodyType.Dynamic) {
          try {
            // Give the Dynamic push detector a tiny early-contact margin.
            // This prevents a grounded box from making the Kinematic mover
            // pause for several frames at exact tangency before the bounded
            // carry velocity is applied. The normal sweep skin and actual
            // Rapier collision resolution remain unchanged.
            hit = source.castCollider(velocity, other, { x: 0, y: 0 }, 0.25, 1, true);
          } catch (_) {}
        }
        if (!hit) return;

        // A zero-time shape cast can report a collider that the Kinematic is
        // ALREADY touching even when the requested motion is directly AWAY
        // from that surface. This is common on the first jump frame: the
        // previous frame's floor contact is still at TOI=0, while the new
        // velocity points upward. Treating that stale contact as a blocker
        // causes the four slide iterations to spend their entire motion on
        // tiny skin separations instead of allowing takeoff, which makes a
        // custom Kinematic jump appear to require several Space presses.
        // Check the actual hit normal in world space and ignore only this
        // zero-time/away case. Motion INTO the surface (including ceilings)
        // remains fully blocked. This is independent of rotation, so a
        // Geometry-style body can rotate while airborne without changing the
        // jump lifecycle.
        const hitToiForDeparture = Number(hit.time_of_impact);
        if (Number.isFinite(hitToiForDeparture) && hitToiForDeparture <= 1e-7) {
          const departureNormal = this._worldTargetNormal(other, hit.normal2);
          const departureDot = velocity.x * departureNormal.x + velocity.y * departureNormal.y;
          if (departureDot > 1e-7) return;
        }

        // A supporting FLAT floor contact must not block a grounded
        // Kinematic body's horizontal platformer movement. The sweep is
        // still authoritative for true walls, ceilings, slopes and corners;
        // we only ignore a NEAR-FLAT support normal when the requested
        // movement is substantially horizontal. This keeps a Kinematic
        // standing on a Static/Kinematic floor able to push a Dynamic body
        // instead of stopping several pixels before contact.
        //
        // IMPORTANT: this must NOT swallow slopes. A 1.5:1 y/x ratio
        // (~56° from vertical, i.e. anything shallower than ~34° from
        // horizontal) previously matched sloped ground too, not just flat
        // floors — so a Kinematic walking onto a ramp had its sweep hit
        // discarded here before it ever settled against the slope, and
        // _readContactState (which relies on Rapier's own contact
        // manifolds forming from the body's FINAL resolved position) then
        // found no manifold at all, leaving grounded/isOnSlope stuck at
        // false. Dynamic bodies don't go through this sweep — Rapier's own
        // solver settles them onto the slope for real — which is why only
        // Kinematic was affected. Use the body's own groundAngleLimit (the
        // same threshold _readContactState uses to decide "walkable
        // ground") as the flat-floor cutoff instead of a fixed ratio, so
        // any surface steep enough to count as a slope still blocks/settles
        // the sweep normally.
        const sweepSpeed = Math.hypot(velocity.x, velocity.y);
        if (sweepSpeed > 1e-7 && otherBodyType !== this.RAPIER.RigidBodyType.Dynamic) {
          const sweepNormal = this._worldTargetNormal(other, hit.normal2);
          const horizontalSweep = Math.abs(velocity.x) >= Math.abs(velocity.y) * 1.5;
          const groundLimit = Math.max(0, Math.min(89.9, rb?.groundAngleLimit ?? SLOPE_LIMIT_DEG));
          // slopeMinAngle marks where a contact starts counting as "on a
          // slope" rather than flat ground; only skip the sweep hit below
          // that angle so genuine slopes (>= slopeMinAngle) still register.
          const slopeMin = Math.max(0, Math.min(89.9, rb?.slopeMinAngle ?? 10));
          const minFlatY = Math.cos(slopeMin * DEG2RAD);
          const supportingSurface = sweepNormal.y > minFlatY;
          const sweepInto = velocity.x * sweepNormal.x + velocity.y * sweepNormal.y;
          if (horizontalSweep && supportingSurface && sweepInto < 0) return;
        }

        // A Dynamic collider remains pushable in open space. Only treat it
        // as a kinematic-movement blocker when the Dynamic itself cannot
        // accept the requested push because a Static/Kinematic collider is
        // directly in the push path. This preserves the existing one-way
        // kinematic -> dynamic behavior while preventing the kinematic body
        // from ghosting through a Dynamic body that is pinned against a wall.
        if (otherBodyType === this.RAPIER.RigidBodyType.Dynamic) {
          const targetNormal = this._worldTargetNormal(other, hit.normal2);
          const sourceNormal = this._worldTargetNormal(source, hit.normal1);
          const sourceInto = velocity.x * sourceNormal.x + velocity.y * sourceNormal.y;
          // Prefer the source-collider normal when Rapier supplied it. For a
          // directional cast this is the unambiguous normal of the surface the
          // Kinematic is moving into, so the push direction is simply its
          // opposite. This removes the left/right asymmetry that can appear
          // when a touching/curved/rotated contact reports an inconvenient
          // target-collider normal. Fall back to normal2 only when normal1 is
          // unavailable.
          const hasSourceNormal = Math.hypot(sourceNormal.x, sourceNormal.y) > 0.5 && sourceInto > 1e-7;
          const pushNormal = hasSourceNormal
            ? { x: -sourceNormal.x, y: -sourceNormal.y }
            : targetNormal;
          const pushInto = velocity.x * pushNormal.x + velocity.y * pushNormal.y;

          // Dynamic contacts are directional movement constraints. If the
          // Kinematic is moving away from the Dynamic (or exactly tangent),
          // the Dynamic must not block the sweep. This is especially important
          // when jumping off a Dynamic platform: the supporting contact is still
          // present at the start of the jump frame, but the character is moving
          // away from it and must be allowed to leave immediately.
          const hitToi = Number(hit.time_of_impact);
          const touchingStart = Number.isFinite(hitToi) && hitToi <= 1e-6;
          // A zero-time/touching contact can be a body we are moving away
          // from (for example, jumping off a Dynamic top). A positive TOI is
          // different: the sweep itself proved that the requested movement
          // reaches the Dynamic during this frame, so do not reject it merely
          // because a rotated/curved shape reports a non-intuitive normal sign.
          if (touchingStart && pushInto >= -1e-7) return;

          // Platformer jump escape: when the controller is traveling mostly
          // upward, a Dynamic on the side is not a ceiling and must not become
          // a false vertical clamp. Only a contact whose normal points down
          // (the Dynamic is genuinely above the character) is allowed to stop
          // the upward jump. This is especially important for convex shapes
          // such as triangles, where the side contact normal can be diagonal.
          const verticalJumpEscape =
            rb._controllerType === 'Platformer' &&
            velocity.y < -1e-7 &&
            Math.abs(velocity.y) > Math.abs(velocity.x) * 1.5;
          if (verticalJumpEscape) {
            // During a mostly-vertical jump, a Dynamic beside the character
            // is not a ceiling. Shape casts against circles/triangles can
            // produce diagonal normals that otherwise look ceiling-like and
            // trap the Kinematic against a pinned Dynamic. Only keep this
            // Dynamic as a jump blocker when its center is actually above
            // the Kinematic; the ordinary sweep still handles the real hit.
            let dynamicIsActuallyAbove = false;
            try {
              const sourcePos = handle.body.translation();
              const targetPos = otherBody?.translation?.();
              if (targetPos && sourcePos) {
                dynamicIsActuallyAbove = Number(targetPos.y) < Number(sourcePos.y) - 2;
              }
            } catch (_) {}
            if (!dynamicIsActuallyAbove) return;
            if (pushNormal.y < -0.05) return;
          }

          // A Dynamic collider's top surface is a valid support surface for a
          // Platformer Kinematic. Once the Kinematic is resting on that top
          // and requests horizontal movement, do not treat the same vertical
          // normal as a zero-time horizontal blocker. Otherwise the sweep can
          // hit the same top manifold on all sub-iterations, repeatedly add
          // the separation skin, and make the character appear glued to the
          // Dynamic's head. Side/underside contacts remain normal movement
          // blockers.
          const horizontalSweepOnTop =
            Math.abs(velocity.x) > Math.abs(velocity.y) * 1.5 &&
            pushNormal.y < -0.5 &&
            Math.abs(pushNormal.y) > Math.abs(pushNormal.x) * 1.25;
          if (horizontalSweepOnTop) return;
          // A successful Dynamic cast is already proof that the requested
          // Kinematic motion reaches this Dynamic within the current frame.
          // Never discard that hit based on normal orientation: doing so can
          // leave a zero-TOI/touching state on the next frame and let the
          // Kinematic advance through the Dynamic. The push-transfer logic
          // below still uses the normal sign to decide whether to carry the
          // Dynamic, so this does not create a new push when moving away.
          const dynamicPush = {
            x: pushInto < 0 ? -pushNormal.x * (-pushInto) : 0,
            y: pushInto < 0 ? -pushNormal.y * (-pushInto) : 0,
          };
          // Landing on the TOP of a Dynamic body is support, not a pinned
          // horizontal push. A Platformer Kinematic may be falling while
          // carrying horizontal motion; that downward contact must cancel
          // only the vertical component so the body can immediately walk
          ///slide off the Dynamic's top instead of becoming glued to it.
          const landingOnDynamicTop =
            pushInto < -1e-7 &&
            pushNormal.y < -0.5 &&
            velocity.y > 0 &&
            Math.abs(pushNormal.y) > Math.abs(pushNormal.x) * 1.25;

          const blockNormal = (landingOnDynamicTop || verticalJumpEscape)
            ? null
            : this._dynamicPushBlocked(other, source, {
                x: dynamicPush.x * dt,
                y: dynamicPush.y * dt,
              }, skin);
          if (blockNormal) {
            // The Dynamic is pinned by a Static/Kinematic obstacle. Do not let
            // Rapier see the full pre-contact Kinematic travel as a pushing
            // velocity; that would drive the trapped Dynamic farther into its wall.
            pinnedDynamicStop = true;
            pinnedDynamicNormal = { x: Number(blockNormal.x) || 0, y: Number(blockNormal.y) || 0 };
            // The Dynamic is pinned by a Static/Kinematic obstacle. Remove
            // only the velocity component into the actual blocking surface;
            // gravity and tangent motion remain untouched.
            try {
              const body = other.parent?.();
              if (body && typeof body.linvel === 'function' && typeof body.setLinvel === 'function') {
                const dv = body.linvel();
                const nx = Number(blockNormal.x) || 0;
                const ny = Number(blockNormal.y) || 0;
                const len = Math.hypot(nx, ny);
                if (len > 1e-7) {
                  const ux = nx / len, uy = ny / len;
                  // A Dynamic that is truly pinned has zero admissible
                  // velocity through the blocking surface in either direction.
                  // Remove the entire normal component so Rapier cannot bounce
                  // the body a few tenths of a pixel away and then let the
                  // Kinematic push it back on the next frame (visible jitter).
                  const along = (Number(dv?.x) || 0) * ux + (Number(dv?.y) || 0) * uy;
                  if (Math.abs(along) > 1e-7) {
                    body.setLinvel({
                      x: (Number(dv?.x) || 0) - ux * along,
                      y: (Number(dv?.y) || 0) - uy * along,
                    }, true);
                  }
                }
              }
            } catch (_) {}
            const stopHit = {
              ...hit,
              time_of_impact: 0,
            };
            if (!closest || 0 < closest.time_of_impact) closest = stopHit;
            return;
          }

          // If the Dynamic is already touching the Kinematic at the start of
          // this sub-sweep, Rapier may legitimately return no TOI from the
          // touching start pose. Treat that existing contact as a zero-time
          // stop so the Kinematic cannot advance through the Dynamic on the
          // following frame. This is a movement-query constraint only; Rapier
          // still owns the actual Dynamic velocity transfer and solver.
          try {
            const existingContact = source.contactCollider(other, skin);
            const distance = Number(existingContact?.distance);
            if (existingContact && Number.isFinite(distance) && distance <= skin + 1e-4) {
              const contactNormal = this._normalizeWorldContactNormal(existingContact.normal1);
              const cnx = Number(contactNormal?.x) || 0;
              const cny = Number(contactNormal?.y) || 0;
              const clen = Math.hypot(cnx, cny);
              if (clen > 1e-7) {
                const normalized = { x: cnx / clen, y: cny / clen };
                const intoContact = velocity.x * normalized.x + velocity.y * normalized.y;
                if (intoContact > 0) {
                  if (!closest || 0 < closest.time_of_impact) {
                    closest = {
                      time_of_impact: 0,
                      collider: other,
                      normal1: existingContact.normal1,
                      normal2: existingContact.normal2,
                      point1: existingContact.point1,
                      point2: existingContact.point2,
                    };
                  }
                  return;
                }
              }
            }
          } catch (_) {}

          const otherEntityId = this._colliderHandleMap.get(other.handle);
          if (!otherEntityId) return;
          const targetNormalVelocity = rb.velocityX * pushNormal.x + rb.velocityY * pushNormal.y;
          if (!landingOnDynamicTop && targetNormalVelocity < -1e-7) {
            const existing = this._pendingKinematicPushes.get(otherEntityId);
            if (!existing || Math.abs(targetNormalVelocity) > Math.abs(existing.targetNormalVelocity)) {
              this._pendingKinematicPushes.set(otherEntityId, {
                nx: pushNormal.x,
                ny: pushNormal.y,
                targetNormalVelocity,
                sourceEntityId: handle._entityId,
              });
            }
          }
          // A free Dynamic is still a real contact for the Kinematic sweep.
          // Stop at the contact point so the Kinematic never visually passes
          // through the Dynamic; Rapier remains responsible for transferring
          // the push to the Dynamic itself. Pushing is recorded above.
          if (!closest || hit.time_of_impact < closest.time_of_impact) closest = hit;
          return;
        }

        if (!closest || hit.time_of_impact < closest.time_of_impact) closest = hit;
      };

      for (const [colliderHandle] of this._colliderHandleMap) {
        const other = this.rapierWorld.getCollider(colliderHandle);
        consider(other);
      }

      if (!closest) {
        position = { x: position.x + remaining.x, y: position.y + remaining.y };
        remaining = { x: 0, y: 0 };
        break;
      }

      const toi = Math.max(0, Math.min(1, Number(closest.time_of_impact) || 0));
      const travel = Math.max(0, Math.min(1, toi)) * 0.9999;
      position = {
        x: position.x + remaining.x * travel,
        y: position.y + remaining.y * travel,
      };

      let remX = remaining.x * (1 - travel);
      let remY = remaining.y * (1 - travel);

      if (pinnedDynamicStop && pinnedDynamicNormal) {
        const hasMovementController =
          rb._controllerType === 'Platformer' ||
          rb._controllerType === 'Character Controller';

        if (!hasMovementController) {
          // Plain scripted Kinematic movers keep the old conservative rule:
          // a pinned Dynamic is a hard movement stop. This preserves exact
          // push semantics for generic movers/platforms.
          remX = 0;
          remY = 0;
        } else {
          // Character movement is different: a pinned Dynamic is a constraint
          // only in the direction in which the Dynamic is actually blocked.
          // Never zero the whole remainder. Project only the component into
          // the blocking surface and preserve tangent motion, just like a
          // proper character-controller slide. This is what prevents a
          // platformer from sticking to a Dynamic that is pinned against a
          // wall while the character is jumping/falling beside it.
          const plen = Math.hypot(pinnedDynamicNormal.x, pinnedDynamicNormal.y);
          if (plen > 1e-7) {
            const pnX = pinnedDynamicNormal.x / plen;
            const pnY = pinnedDynamicNormal.y / plen;
            const intoBlocker = remX * pnX + remY * pnY;
            if (intoBlocker > 0) {
              remX -= pnX * intoBlocker;
              remY -= pnY * intoBlocker;
            }
          }
        }
      }

      remaining = { x: remX, y: remY };

      // normal2 is expressed in the hit collider's local frame. Convert it
      // to world space so the slide is correct for rotated colliders.
      const n = this._worldTargetNormal(closest.collider, closest.normal2);
      const nx = n.x;
      const ny = n.y;

      // If this sweep is moving upward and the hit surface is a ceiling,
      // cancel the Kinematic controller's upward velocity immediately.
      // The engine uses Y-down coordinates, so an upward movement has a
      // negative Y component and a ceiling's outward normal points down
      // (positive Y). Doing this here is important: ControllerSystem runs
      // before PhysicsWorld on the next frame, so waiting for the contact
      // flag there would leave one frame of stale upward velocity and can
      // make a character appear to stick to the ceiling.
      const hitsCeiling = remY < 0 && ny > 0.001;
      if (hitsCeiling && rb.velocityY < 0) {
        rb.velocityY = 0;
      }

      // Slide the remaining motion along the contact plane. Do not invent
      // gravity, friction or impulses here; Rapier owns those.
      const into = remX * nx + remY * ny;
      remaining = into < 0
        ? { x: remX - nx * into, y: remY - ny * into }
        : { x: remX, y: remY };

      // Once a ceiling impact has cancelled the controller's upward speed,
      // the unresolved motion must not keep carrying that old upward intent
      // through later sub-iterations of the same sweep. Remove only the
      // upward component; preserve any horizontal/tangent motion so the
      // character can slide out from under the ceiling normally.
      if (hitsCeiling && remaining.y < 0) {
        remaining.y = 0;
      }

      // A tiny separation moves the kinematic out of the exact TOI plane so
      // the NEXT SUB-ITERATION of this same sweep cannot repeatedly report
      // the same zero-time hit. Only do this when there is still meaningful
      // remaining motion to resolve (i.e. we are about to loop again for a
      // slide/second cast) — otherwise this runs unconditionally on every
      // frame a Kinematic body rests on a support surface (gravity alone
      // keeps feeding a tiny `remaining` each frame), continuously pushing
      // the body `skin` distance off the ground/slope it just landed on.
      // The very next frame's gravity pulls it back into contact range,
      // producing a resting body whose position — and therefore whose
      // Rapier contact manifold — alternates in and out of range every
      // frame. _readContactState only sees a manifold on the frames the
      // body happens to be back inside contact tolerance, so grounded/
      // isOnSlope flicker true/false/true every frame instead of holding
      // steady. Skipping the push-out once the slide has settled onto the
      // support normal (near-zero leftover tangential motion) lets the
      // body stay genuinely resting against the surface, exactly like a
      // Dynamic body settles under Rapier's own solver with no manual
      // separation step at all.
      const remainingAfterSlide = Math.hypot(remaining.x, remaining.y);
      if (remainingAfterSlide > 1e-4) {
        // Keep a very small separation nudge so a true moving hit can advance
        // into its slide plane, while limiting zero-time resting/corner
        // contacts to a tiny 0.002px nudge. The old full skin nudge could make
        // wall-floor seams alternate by a visible fraction of a pixel.
        const separation = toi <= 1e-6 ? Math.min(skin, 0.002) : skin;
        position.x += nx * separation;
        position.y += ny * separation;
      }
    }

    // Restore the actual pre-step pose so Rapier computes the intended
    // kinematic velocity/trajectory from the original position to the
    // resolved target. A pinned Dynamic is different: arrive at the contact
    // point without a solver-visible kinematic velocity so the trapped body
    // cannot be driven farther into its wall.
    if (pinnedDynamicStop) {
      handle.body.setTranslation(position, true);
      // Shape casts and Rapier contact manifolds can differ slightly for
      // circles/capsules/triangles at the exact stop point. Reconcile only
      // actual Kinematic->Dynamic penetration so the two colliders finish the
      // frame flush instead of a fraction of a pixel inside one another.
      for (const [colliderHandle] of this._colliderHandleMap) {
        const other = this.rapierWorld.getCollider(colliderHandle);
        if (!other || other === source || other.isSensor?.()) continue;
        const otherBody = typeof other.parent === 'function' ? other.parent() : null;
        if (otherBody?.bodyType?.() !== this.RAPIER.RigidBodyType.Dynamic) continue;
        if (!this._collisionGroupsInteract(source.collisionGroups(), other.collisionGroups())) continue;
        try {
          const contact = source.contactCollider(other, 0);
          const distance = Number(contact?.distance);
          if (!(distance < -1e-4)) continue;
          const n = this._normalizeWorldContactNormal(contact.normal1);
          const len = Math.hypot(n.x, n.y);
          if (len < 1e-7) continue;
          const correction = Math.min(-distance + 0.02, 1.25);
          position.x -= (n.x / len) * correction;
          position.y -= (n.y / len) * correction;
          handle.body.setTranslation(position, true);
        } catch (_) {}
      }
      handle.body.setNextKinematicTranslation(position);
      rb.resolvedVelocityX = dt > 0 ? (position.x - originalPosition.x - (rb._rotationSnapCorrectionX || 0)) / dt : 0;
      rb.resolvedVelocityY = dt > 0 ? (position.y - originalPosition.y - (rb._rotationSnapCorrectionY || 0)) / dt : 0;
    } else {
      handle.body.setTranslation(originalPosition, true);
      handle.body.setNextKinematicTranslation(position);
      rb.resolvedVelocityX = dt > 0 ? (position.x - originalPosition.x - (rb._rotationSnapCorrectionX || 0)) / dt : 0;
      rb.resolvedVelocityY = dt > 0 ? (position.y - originalPosition.y - (rb._rotationSnapCorrectionY || 0)) / dt : 0;
    }

    if (!rb.lockRotation) {
      const entity = this._stepWorld && this._stepWorld.getEntity(handle._entityId);
      const tf = entity && entity.getComponent(TRANSFORM);
      const scriptedRotation = Number(rb._scriptRotationTarget);
      if (Number.isFinite(scriptedRotation)) {
        // A script assignment is an exact kinematic rotation target. Apply it
        // both to the current Rapier pose used by contact queries and to the
        // next pose submitted for the step. Do not add angularVelocity on top
        // of the explicit target: that was the source of the visible
        // 90->92->90-style rocking when a square landed and snapped.
        const targetRotation = scriptedRotation * DEG2RAD;
        handle.body.setRotation(targetRotation, true);
        handle.body.setNextKinematicRotation(targetRotation);
        rb._scriptRotationTarget = null;
      } else {
        const baseRot = tf ? tf.rotation * DEG2RAD : rotation;
        handle.body.setNextKinematicRotation(baseRot + rb.angularVelocity * dt);
      }
      rb._previousKinematicRotation = null;
    }
  }

  /**
   * Predict whether a Dynamic collider can accept a requested push without
   * immediately running into Static/Kinematic geometry. This is only a
   * movement-query helper; Rapier remains responsible for the actual solver,
   * contacts, impulses, and final Dynamic-body motion.
   */
  _dynamicPushBlocked(dynamicCollider, pusherCollider, push, skin = 0.01) {
    if (!dynamicCollider || !this.rapierWorld) return false;
    if (Math.hypot(push.x, push.y) < 1e-7) return false;

    try {
      const velocity = { x: push.x, y: push.y };
      const speed = Math.hypot(velocity.x, velocity.y);
      const horizontalPush = Math.abs(velocity.x) >= Math.abs(velocity.y) * 1.5;
      const blockingCosine = 0.05;

      for (const [colliderHandle] of this._colliderHandleMap) {
        const other = this.rapierWorld.getCollider(colliderHandle);
        if (!other || other === dynamicCollider || other === pusherCollider || other.isSensor?.()) continue;
        if (!this._collisionGroupsInteract(dynamicCollider.collisionGroups(), other.collisionGroups())) continue;

        const otherBody = typeof other.parent === 'function' ? other.parent() : null;
        const bodyType = otherBody?.bodyType?.();
        if (bodyType === this.RAPIER.RigidBodyType.Dynamic) continue;

        // First check an already-existing contact. This is essential when a
        // Dynamic is already resting against a wall: a new shape cast can
        // legitimately return no TOI from a touching/penetrating start pose.
        try {
          const contact = dynamicCollider.contactCollider(other, skin);
          const distance = Number(contact?.distance);
          if (contact && Number.isFinite(distance)) {
            // contactCollider() returns ShapeContact data already in WORLD
            // space (unlike manifold.localNormal1/2, which are local-frame
            // and do need _worldTargetNormal's rotation). Rotating an
            // already-world normal a second time by the Dynamic's own body
            // angle was the actual bug: as the box rotated, a stable,
            // near-vertical floor-contact normal got progressively skewed
            // toward horizontal by that spurious extra rotation, until it
            // read as a wall and falsely pinned the Dynamic against its own
            // floor -- in whichever direction the rotation happened to skew
            // it, matching the reported one-direction-only symptom.
            const nx = Number(contact.normal1?.x) || 0;
            const ny = Number(contact.normal1?.y) || 0;
            const nlen = Math.hypot(nx, ny);
            const n = nlen > 1e-7 ? { x: nx / nlen, y: ny / nlen } : { x: 0, y: 0 };
            const predominantlyVertical = Math.abs(n.y) > Math.abs(n.x) * 1.5;
            const pushDot = push.x * n.x + push.y * n.y;
            const travel = Math.hypot(push.x, push.y);
            const reachesContact = distance <= skin + travel + 1e-4;
            if (reachesContact && pushDot > 1e-7 && !(horizontalPush && predominantlyVertical)) {
              // If the Dynamic is already slightly inside the blocker, correct
              // only that existing penetration (bounded to 2 px). This is a
              // recovery for an already-invalid contact, not a general solver.
              if (distance < -1e-4) {
                try {
                  const body = typeof dynamicCollider.parent === 'function' ? dynamicCollider.parent() : null;
                  if (body && typeof body.translation === 'function' && typeof body.setTranslation === 'function') {
                    const depthCorrection = Math.min(-distance + 0.02, 4);
                    const pos = body.translation();
                    body.setTranslation({
                      x: Number(pos.x) - n.x * depthCorrection,
                      y: Number(pos.y) - n.y * depthCorrection,
                    }, true);
                  }
                } catch (_) {}
              }
              return { x: n.x, y: n.y };
            }
          }
        } catch (_) {}

        let hit = null;
        try {
          hit = dynamicCollider.castCollider(velocity, other, { x: 0, y: 0 }, skin, 1, true);
        } catch (_) {
          continue;
        }
        if (!hit) continue;

        const n = this._worldTargetNormal(other, hit.normal2);

        // The cast itself proves that the requested Dynamic displacement reaches
        // this Static/Kinematic collider during the frame. Do not require a
        // second normal-sign test here; manifold normal orientation differs
        // between collider pairs and triangles, while the sweep TOI is already
        // directional. Supporting floor/ceiling contacts remain excluded so a
        // grounded Dynamic can still be pushed horizontally.
        if (speed <= 1e-7) continue;
        const predominantlyVertical = Math.abs(n.y) > Math.abs(n.x) * 1.5;
        if (horizontalPush && predominantlyVertical) continue;

        return { x: n.x, y: n.y };
      }
    } catch (_) {}

    return false;
  }

  _collisionGroupsInteract(groupsA, groupsB) {
    const a = Number(groupsA) >>> 0;
    const b = Number(groupsB) >>> 0;
    const aMembership = a & 0xFFFF;
    const aFilter = (a >>> 16) & 0xFFFF;
    const bMembership = b & 0xFFFF;
    const bFilter = (b >>> 16) & 0xFFFF;
    return (aMembership & bFilter) !== 0 && (bMembership & aFilter) !== 0;
  }

  /**
   * Creates/recreates the Rapier collider attached to `handle.body` to
   * match the Collider2D component. Uses the SAME
   * getColliderWorldGeometry() helper the editor's red gizmo outline
   * uses, so the shape Rapier actually collides with is guaranteed to
   * be the shape drawn on screen — including the entity's Transform
   * scale, which earlier only the gizmo accounted for (Rapier colliders
   * don't auto-scale with non-uniform Transform scale the way a Pixi
   * sprite does, so the effective size must be baked in here).
   *
   * A cheap per-frame dirty-check (primitive field comparisons, no
   * allocation) lets us skip the relatively expensive rebuild — and the
   * trig-heavy geometry computation that feeds it — when nothing
   * shape-affecting actually changed since last frame.
   */
  _collisionPairKey(entityIdA, entityIdB) {
    const a = String(entityIdA);
    const b = String(entityIdB);
    return a < b ? a + "\u0000" + b : b + "\u0000" + a;
  }

  /**
   * Synchronize Rapier's per-collider hook flags with the live joint set.
   * When a joint excludes its connected pair, the filter must also be
   * active on the other collider in that pair; one-way platforms remain
   * independently active as before.
   */
  _syncContactFilterHooks() {
    if (!this.RAPIER) return;
    const hasExcludedJointPair = this._disabledJointCollisionPairs.size > 0;
    for (const handle of this._handles.values()) {
      if (!handle?.collider) continue;
      const active =
        hasExcludedJointPair ||
        this._oneWayPlatformHandles.has(handle.collider.handle);
      if (handle._filterContactPairsActive === active) continue;
      handle.collider.setActiveHooks(
        active
          ? this.RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS
          : this.RAPIER.ActiveHooks.NONE
      );
      handle._filterContactPairsActive = active;
    }
  }

  /**
   * PhysicsHooks.filterContactPair for connected-joint exclusions and
   * one-way platforms (see Collider2D.js and the step() call below).
   * Collider2D.js's isOneWayPlatform and step()'s call to
   * rapierWorld.step(..., this._oneWayPlatformHooks)). Rapier only
   * invokes this for a pair where at least one collider has
   * ActiveHooks.FILTER_CONTACT_PAIRS set. With no one-way platform or
   * joint-pair exclusion active, ordinary pairs never reach this method.
   *
   * Returns RAPIER.SolverFlags.COMPUTE_IMPULSE (solid contact) or null
   * (pass straight through, no contact generated) for this pair.
   *
   * CRITICAL CONSTRAINT — reads ONLY this._colliderWorldBoundsCache,
   * NEVER calls this.rapierWorld.getCollider(...)/.halfExtents()/
   * .translation() or body.linvel() from inside this method. Rapier is
   * mid-mutation of its own collider/body set while this callback
   * runs, and calling back into those query methods from here throws
   * "recursive use of an object detected... unsafe aliasing in rust"
   * (confirmed by hand — every one of those calls threw every time,
   * every frame, and the resulting exception was silently swallowed
   * somewhere in the wasm boundary, which made every contact fall back
   * to solid-by-default and made the whole feature look like it was
   * working — landing correctly — while actually never running any
   * real one-way logic at all). _colliderWorldBoundsCache is refreshed
   * from this engine's own Transform/Collider2D/Rigidbody2D data (pure
   * JS, no Rapier calls) once per collider per frame in _syncCollider/
   * _syncEntity, safely BEFORE rapierWorld.step() begins the solve —
   * that's what makes a position check possible here at all.
   *
   * Also fires BEFORE contact manifolds exist for the step, so there's
   * no contact normal to read even if live queries were safe — hence a
   * position check in the first place: solid only when the OTHER
   * body's leading edge (the side facing the platform) has not yet
   * crossed the platform's own top surface, i.e. it's still
   * approaching from above rather than already inside/below it. A
   * small skin tolerance avoids flickering solid/pass-through right at
   * the boundary from floating-point noise.
   *
   * Only Box/Capsule/Circle one-way colliders are meaningfully
   * supported (see the cache-population comment in _syncCollider) —
   * Triangle falls back to treating the platform's own bounds as a
   * single point, which in practice behaves like solid-from-nowhere
   * rather than a real platform, so a Triangle isn't a useful shape to
   * mark isOneWayPlatform on (matches Collider2D.js's own doc comment
   * that one-way platforms are conventionally flat Box shapes anyway).
   */
  _filterContactPair(collider1, collider2, body1, body2) {
    const RAPIER = this.RAPIER;
    const entity1 = this._colliderHandleMap.get(collider1);
    const entity2 = this._colliderHandleMap.get(collider2);
    if (
      entity1 &&
      entity2 &&
      this._disabledJointCollisionPairs.has(this._collisionPairKey(entity1, entity2))
    ) {
      return null;
    }

    const platformIsFirst = this._oneWayPlatformHandles.has(collider1);
    const platformIsSecond = this._oneWayPlatformHandles.has(collider2);
    // Two one-way platforms touching each other: neither should ever
    // push the other around (both are meant to be stood ON, not
    // collided WITH each other) — treat as always pass-through rather
    // than picking an arbitrary "platform" side.
    if (platformIsFirst && platformIsSecond) return null;
    if (!platformIsFirst && !platformIsSecond) return RAPIER.SolverFlags.COMPUTE_IMPULSE;

    const platformHandle = platformIsFirst ? collider1 : collider2;
    const otherHandle = platformIsFirst ? collider2 : collider1;
    const platformBounds = this._colliderWorldBoundsCache.get(platformHandle);
    const otherBounds = this._colliderWorldBoundsCache.get(otherHandle);
    // Cache miss (e.g. a collider created this exact frame, not yet
    // synced) — fail safe to solid rather than letting something fall
    // through a platform due to a bookkeeping gap.
    if (!platformBounds || !otherBounds) return RAPIER.SolverFlags.COMPUTE_IMPULSE;

    const platformTop = Number.isFinite(platformBounds.topY)
      ? platformBounds.topY
      : platformBounds.centerY - platformBounds.halfHeight;
    const otherBottom = Number.isFinite(otherBounds.bottomY)
      ? otherBounds.bottomY
      : otherBounds.centerY + otherBounds.halfHeight;
    const previousBottom = Number.isFinite(otherBounds.previousBottomY)
      ? otherBounds.previousBottomY
      : ((Number.isFinite(otherBounds.previousCenterY)
        ? otherBounds.previousCenterY
        : otherBounds.centerY) + otherBounds.halfHeight);

    // Skin tolerance: same spirit as the small tolerances already used
    // elsewhere in this file for contact classification — a few
    // hundredths of a unit avoids the pair flickering solid/pass-
    // through from floating-point noise right at the boundary, without
    // being large enough to feel like the platform has a "thick" top.
    const skin = 0.05;
    // Once a body has actually reached the top surface, Rapier can leave
    // the solved contact point a fraction of a pixel below/above that exact
    // geometric boundary on alternating frames. Keep a small support window
    // so a resting Dynamic does not lose the one-way contact and begin
    // falling again. This is intentionally tiny relative to normal collider
    // sizes and is only considered when the previous frame was already at
    // the platform top.
    const supportSkin = 2.0;

    // A body that is genuinely moving upward THROUGH the platform from
    // below must remain pass-through. Do NOT use `vy < 0` by itself here:
    // an unlocked Dynamic body that is rotating while supported can receive
    // a small upward linear impulse from the rotating contact. Treating that
    // tiny solver-generated lift as a jump-through makes the hook disable the
    // one-way contact for that frame, the body loses support, and gravity then
    // carries it through the platform. Only reject the pair when the body is
    // clearly BELOW the platform and was already below it on the previous
    // frame, which is the actual jump-through case.
    const upwardFromBelow =
      otherBounds.vy < -0.001 &&
      otherBottom > platformTop + supportSkin &&
      previousBottom > platformTop + supportSkin;
    if (upwardFromBelow) return null;

    // Normal case: the body's leading edge is still above the platform at
    // the start of this step. This is the ordinary landing path.
    if (otherBottom <= platformTop + skin) {
      return RAPIER.SolverFlags.COMPUTE_IMPULSE;
    }

    // Swept landing case: a fast Dynamic may have crossed the platform top
    // between physics steps, leaving its current bottom slightly below the
    // top before this hook runs. Accept the contact only when the PREVIOUS
    // frame was above the platform and the body is moving downward. This
    // fixes tunneling without making a one-way platform into a wall: side
    // approaches still fail the vertical crossing test, and upward motion
    // was already rejected above.
    if (previousBottom <= platformTop + supportSkin && otherBounds.vy >= 0) {
      return RAPIER.SolverFlags.COMPUTE_IMPULSE;
    }

    // Persistent-support case. A Dynamic body using the Platformer movement
    // type can be at rest on the top of a one-way platform for many frames.
    // The movement controller intentionally leaves Y to Rapier, but the
    // body's cached Transform/velocity can be a fraction of a pixel inside
    // the solver's contact margin on the following frame. If the pair was a
    // REAL solid one-way contact on the previous physics step, keep that
    // specific pair solid while it remains vertically close to the platform
    // and is not jumping upward. This is deliberately pair-specific: it does
    // not turn the one-way collider into a side wall for unrelated bodies.
    //
    // The active-contact set is refreshed from Rapier after every step, so
    // this is not a synthetic grounded flag. It is only a one-frame bridge
    // across Rapier's contact refresh boundary.
    const platformEntityId = this._colliderHandleMap.get(platformHandle);
    const otherEntityId = this._colliderHandleMap.get(otherHandle);
    if (platformEntityId && otherEntityId) {
      const pairKey = platformEntityId < otherEntityId
        ? platformEntityId + '|' + otherEntityId
        : otherEntityId + '|' + platformEntityId;
      if (this._activeSolidContacts.has(pairKey) && otherBounds.vy >= 0) {
        const persistentSkin = 12.0;
        const nearTop = otherBottom <= platformTop + persistentSkin ||
          previousBottom <= platformTop + persistentSkin;
        if (nearTop) return RAPIER.SolverFlags.COMPUTE_IMPULSE;
      }
    }

    return null;
  }

  _syncCollider(handle, collider, transform) {
    const RAPIER = this.RAPIER;

    if (!collider) {
      if (handle.collider) {
        // BUGFIX: this used to remove the Rapier collider without also
        // deleting its entry from _colliderHandleMap. Rapier RECYCLES
        // removed collider handle indices for the next collider it
        // creates — so the stale map entry (still pointing at THIS
        // entity's id) could silently get reassigned to a completely
        // different entity's new collider on a later frame. Every
        // handle -> entityId lookup that reads this map (raycasts,
        // collision/trigger event dispatch, entityAtPoint, the kinematic
        // contactPair scan) would then resolve to the WRONG entity —
        // showing up as "collides without respecting layers" even though
        // the actual layer/mask filtering was correct all along; the
        // hit/contact was just attributed to the wrong object. Must be
        // cleaned up here, symmetric with every other removeCollider/
        // removeRigidBody call site in this file.
        this._colliderHandleMap.delete(handle.collider.handle);
        this._oneWayPlatformHandles.delete(handle.collider.handle);
        this._colliderWorldBoundsCache.delete(handle.collider.handle);
        this.rapierWorld.removeCollider(handle.collider, true);
        handle.collider = null;
        handle._colliderRef = null;
      }
      return;
    }

    // PERFORMANCE: this used to call getColliderWorldGeometry() (trig:
    // sin/cos + scale math) AND build a JSON.stringify signature array
    // EVERY frame for EVERY physics entity, purely to detect "did
    // anything shape-affecting change" — even though a collider's
    // shape/offset/material almost never change after spawn (only
    // transform.rotation moves every frame for a spinning/rotating
    // body, and rotation doesn't even affect Box/Circle collider
    // geometry the way this signature is built). JSON.stringify in
    // particular allocates a fresh array + walks/escapes every field
    // into a string every single call — with even one Rigidbody2D in a
    // scene, that ran 60+ times a second for no reason, which is
    // exactly the "one physics object tanks FPS" symptom.
    //
    // Fix: compare the handful of primitive fields that can actually
    // change directly (a handful of === checks, no allocation at all),
    // and only call getColliderWorldGeometry() + rebuild the Rapier
    // collider on the rare frame something really did change.
    const entityForCollider = this._stepWorld?.getEntity(handle._entityId);
    const entityHasMovementType = !!entityForCollider?.hasComponent(CHARACTER_CONTROLLER);

    if (
      handle._colliderRef === collider &&
      handle._sigShape === collider.shape &&
      handle._sigOffsetX === collider.offsetX &&
      handle._sigOffsetY === collider.offsetY &&
      handle._sigWidth === collider.width &&
      handle._sigHeight === collider.height &&
      handle._sigRadius === collider.radius &&
      handle._sigCapsuleRadius === collider.capsuleRadius &&
      handle._sigCapsuleHalfHeight === collider.capsuleHalfHeight &&
      handle._sigTrianglePoints === collider.trianglePoints &&
      handle._sigIsTrigger === collider.isTrigger &&
      handle._sigIsOneWayPlatform === collider.isOneWayPlatform &&
      handle._sigHasMovementType === entityHasMovementType &&
      handle._sigFriction === collider.friction &&
      handle._sigRestitution === collider.restitution &&
      handle._sigDensity === collider.density &&
      handle._sigScaleX === transform.scaleX &&
      handle._sigScaleY === transform.scaleY &&
      handle._sigLayer === collider.layer &&
      handle._sigMask  === collider.mask
    ) {
      return; // nothing shape-affecting changed since last frame — skip entirely
    }

    const geo = getColliderWorldGeometry(collider, transform);

    if (handle.collider) {
      // BUGFIX (same root cause as the !collider branch above): delete
      // the stale handle -> entityId mapping BEFORE removing the Rapier
      // collider, not after. This runs whenever a shape field OR
      // layer/mask changed since last frame (see the dirty-check just
      // above) — e.g. a script doing `this.collider.layer = 2` at
      // runtime. Without this delete, Rapier can recycle the removed
      // handle's numeric index for ANY new collider created afterward
      // (this entity's own replacement, or a totally different entity
      // spawned later), and the old entry would keep resolving that
      // index back to THIS entity. Every consumer of
      // _colliderHandleMap — castRay(), the collision/trigger event
      // drain, entityAtPoint(), _dispatchKinematicCollisions' contactPair
      // scan — would then attribute a hit/contact to the wrong entity,
      // which is exactly what "physics layer collides with things it
      // shouldn't, sometimes" looks like from a script's perspective:
      // the layer filter itself was fine, the collider handle bookkeeping
      // wasn't.
      this._colliderHandleMap.delete(handle.collider.handle);
      this._oneWayPlatformHandles.delete(handle.collider.handle);
      this._colliderWorldBoundsCache.delete(handle.collider.handle);
      this.rapierWorld.removeCollider(handle.collider, true);
      handle.collider = null;
    }

    // Collider offset is attached in the BODY's local frame, so we pass
    // the raw (unscaled) offset here — Rapier rotates it with the body
    // automatically. Size, however, must be the already-scaled
    // half-extents from getColliderWorldGeometry, since Rapier shapes
    // don't respond to Transform scale on their own.
    let desc;
    if (geo.shape === ColliderShape.CIRCLE) {
      desc = RAPIER.ColliderDesc.ball(Math.max(0.01, geo.radius));
    } else if (geo.shape === ColliderShape.CAPSULE) {
      desc = RAPIER.ColliderDesc.capsule(Math.max(0.01, geo.halfHeight), Math.max(0.01, geo.radius));
    } else if (geo.shape === ColliderShape.TRIANGLE) {
      // geo.localPoints are already scaled but NOT rotated/translated —
      // Rapier applies the parent body's rotation to them itself, and
      // .setTranslation() below applies the offset, exactly matching
      // how BOX/CIRCLE/CAPSULE already handle offset+rotation.
      let [a, b, c] = geo.localPoints;
      const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (area2 < 0) [b, c] = [c, b];
      desc = RAPIER.ColliderDesc.convexHull(new Float32Array([
        a.x, a.y,
        b.x, b.y,
        c.x, c.y
      ]));
      if (!desc) {
        throw new Error("Failed to build triangle convex hull collider");
      }
    } else {
      desc = RAPIER.ColliderDesc.cuboid(Math.max(0.01, geo.halfWidth), Math.max(0.01, geo.halfHeight));
    }

    desc
      .setTranslation(collider.offsetX * transform.scaleX, collider.offsetY * transform.scaleY)
      .setSensor(!!collider.isTrigger)
      // One-way platforms opt into this hook; connected-pair exclusion
      // can also enable it on all scene colliders while a joint requests it.
      .setActiveHooks(
        collider.isOneWayPlatform || this._disabledJointCollisionPairs.size > 0
          ? RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS
          : RAPIER.ActiveHooks.NONE
      )
      .setFriction(entityHasMovementType ? 0 : collider.friction)
      // Movement-type Dynamic bodies should not lose tangential speed when
      // contacting a normal Static/Kinematic surface. Rapier combines the two
      // collider friction coefficients by default using Average, so a player
      // with friction=0 can still receive wall-friction from a wall with
      // friction=1. Min makes the movement body's zero-friction material win
      // without changing the other collider's friction for ordinary Dynamic
      // bodies. This is a real Rapier material-combination rule, not a manual
      // velocity/friction impulse hack.
      .setFrictionCombineRule(
        entityHasMovementType
          ? RAPIER.CoefficientCombineRule.Min
          : RAPIER.CoefficientCombineRule.Average
      )
      .setRestitution(collider.restitution)
      .setDensity(collider.density)
      // Rapier's DEFAULT active-collision-types only computes contacts
      // for pairs involving at least one Dynamic body — ANY pairing of
      // two non-dynamic bodies (Kinematic-vs-Static, Kinematic-vs-
      // Kinematic, Static-vs-Static) is silently skipped unless
      // explicitly opted in, no matter how the constant is named. A
      // Movement behaviors that use a Kinematic body need contact generation
      // with Static and Kinematic colliders so the movement layer can resolve
      // its target translation against real Rapier geometry.
      //
      // Explicitly enable Kinematic-vs-Static and Kinematic-vs-Kinematic
      // contacts; Rapier's default active-collision set does not include
      // non-dynamic pairs. Static-vs-Static remains unnecessary because no
      // solver response can ever move either body.
      .setActiveCollisionTypes(
        RAPIER.ActiveCollisionTypes.ALL |
          RAPIER.ActiveCollisionTypes.KINEMATIC_KINEMATIC |
          RAPIER.ActiveCollisionTypes.KINEMATIC_STATIC
      )
      // Collision layer / mask filter — Rapier's InteractionGroups encode
      // membership (which layer this IS) in the lower 16 bits and filter
      // (which layers it CAN interact with) in the upper 16 bits.
      // Two colliders can only interact when each is in the other's mask.
      .setCollisionGroups(makeCollisionGroups(collider.layer, collider.mask));

    handle.collider = this.rapierWorld.createCollider(desc, handle.body);

    // Cache the primitive fields the fast-path check above compares
    // next frame — see the dirty-check block near the top of this
    // method for why this replaced a JSON.stringify signature.
    handle._colliderRef = collider;
    handle._sigShape = collider.shape;
    handle._sigOffsetX = collider.offsetX;
    handle._sigOffsetY = collider.offsetY;
    handle._sigWidth = collider.width;
    handle._sigHeight = collider.height;
    handle._sigRadius = collider.radius;
    handle._sigCapsuleRadius = collider.capsuleRadius;
    handle._sigCapsuleHalfHeight = collider.capsuleHalfHeight;
    handle._sigTrianglePoints = collider.trianglePoints;
    handle._sigIsTrigger = collider.isTrigger;
    handle._sigIsOneWayPlatform = collider.isOneWayPlatform;
    handle._sigHasMovementType = entityHasMovementType;
    handle._sigFriction = collider.friction;
    handle._sigRestitution = collider.restitution;
    handle._sigDensity = collider.density;
    handle._sigScaleX = transform.scaleX;
    handle._sigScaleY = transform.scaleY;
    handle._sigLayer  = collider.layer;
    handle._sigMask   = collider.mask;

    // Register the new collider in the reverse-lookup map so event
    // draining can find the owning entityId from Rapier's handle index.
    this._colliderHandleMap.set(handle.collider.handle, handle._entityId);
    if (collider.isOneWayPlatform) this._oneWayPlatformHandles.add(handle.collider.handle);

    // World-space bounds cache for one-way platform filtering — see
    // this._colliderWorldBoundsCache's own doc comment in the
    // constructor for why this can't just be read live from Rapier
    // inside filterContactPair. geo.halfHeight covers Box/Capsule;
    // Circle uses geo.radius as its effective half-height (a circle's
    // "top"/"bottom" edge is radius away from center on every axis);
    // Triangle has neither, so it falls back to 0 (a Triangle collider
    // is never a meaningful one-way platform shape in the first place —
    // see Collider2D.js's own doc comment on isOneWayPlatform being
    // Box-only in practice), which just means a Triangle "other body"
    // is treated as a single point for this specific check, not that
    // one-way support is broken for it.
    const cacheHalfWidth = geo.halfWidth != null ? geo.halfWidth : (geo.radius != null ? geo.radius : 0);
    const cacheHalfHeight = geo.halfHeight != null ? geo.halfHeight : (geo.radius != null ? geo.radius : 0);
    let cacheTopY = geo.centerY - cacheHalfHeight;
    let cacheBottomY = geo.centerY + cacheHalfHeight;
    if (geo.shape === ColliderShape.TRIANGLE && Array.isArray(geo.worldPoints) && geo.worldPoints.length) {
      cacheTopY = Math.min(...geo.worldPoints.map((p) => p.y));
      cacheBottomY = Math.max(...geo.worldPoints.map((p) => p.y));
    }
    this._colliderWorldBoundsCache.set(handle.collider.handle, {
      centerY: geo.centerY,
      previousCenterY: geo.centerY,
      bottomY: cacheBottomY,
      previousBottomY: cacheBottomY,
      topY: cacheTopY,
      halfWidth: cacheHalfWidth,
      halfHeight: cacheHalfHeight,
      radius: geo.radius != null ? geo.radius : 0,
      shape: geo.shape,
    });

    // Opt this collider into the EventQueue so collision and sensor
    // (trigger) events are actually delivered — Rapier only emits events
    // for colliders that have explicitly requested them.
    handle.collider.setActiveEvents(this.RAPIER.ActiveEvents.COLLISION_EVENTS);
  }

  /**
   * Casts a ray from (x1,y1) to (x2,y2) using Rapier's shape-accurate query.
   * Respects physics layers via the `layerMask` option — only hits colliders
   * whose layer bit is set in the mask. Returns the CLOSEST hit or null.
   *
   * @param {number} x1  @param {number} y1  start point (world space)
   * @param {number} x2  @param {number} y2  end point (world space)
   * @param {{ layerMask?: number }} [opts]
   *   layerMask — 16-bit mask of layers to test (default 0xFFFF = all layers)
   * @returns {{ entityId:string, point:{x,y}, normal:{x,y}|null, distance:number }|null}
   */
  castRay(x1, y1, x2, y2, opts) {
    if (!this.ready || !this.rapierWorld) return null;
    opts = opts || {};
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) return null;

    const RAPIER = this.RAPIER;
    const ray = new RAPIER.Ray({ x: x1, y: y1 }, { x: dx / len, y: dy / len });
    const maxToi = len;

    // Encode the ray's collision filter groups:
    //   membership  (lower 16 bits) = 0xFFFF  → the ray is "visible" from every layer
    //   filter      (upper 16 bits) = layerMask → the ray only tests colliders on these layers
    // Rapier allows interaction when both (A.membership & B.filter) != 0 AND
    // (B.membership & A.filter) != 0. With membership = 0xFFFF the first condition
    // always passes; the second passes only for colliders in layerMask.
    const layerMask = (opts.layerMask !== undefined) ? (opts.layerMask & 0xFFFF) : 0xFFFF;
    const filterGroups = 0xFFFF | (layerMask << 16);

    // Build a Rapier predicate that excludes specific entities by ID.
    // Rapier 0.14 passes the Collider object to the predicate; we look up
    // its entity ID via _colliderHandleMap and reject it when it's in the
    // exclude set. undefined = no predicate = hit everything.
    const excludeIds = opts.excludeEntityIds;
    const predicate = (excludeIds && excludeIds.size > 0)
      ? (collider) => !excludeIds.has(this._colliderHandleMap.get(collider.handle))
      : undefined;

    let hit = null;
    try {
      // castRayAndGetNormal gives us the surface normal for free.
      // Rapier 0.14 signature: (ray, maxToi, solid, filterFlags, filterGroups,
      //   filterExcludeCollider, filterExcludeRigidBody, filterPredicate)
      hit = this.rapierWorld.castRayAndGetNormal(
        ray, maxToi, true, undefined, filterGroups, null, null, predicate
      );
    } catch (_) {
      try {
        hit = this.rapierWorld.castRay(
          ray, maxToi, true, undefined, filterGroups, null, null, predicate
        );
      } catch (_2) { /* Rapier not ready */ }
    }
    if (!hit) return null;

    const entityId = this._colliderHandleMap.get(hit.collider.handle);
    const t = hit.timeOfImpact;
    return {
      entityId,
      point:    { x: x1 + (dx / len) * t, y: y1 + (dy / len) * t },
      normal:   hit.normal ? { x: hit.normal.x, y: hit.normal.y } : null,
      distance: t,
    };
  }

  /** Removes every tracked Rapier body (used when the World/scene is cleared). */
  clear() {
    if (!this.ready) return;
    // Joints and world-anchor bodies first: removing a Rapier RigidBody
    // already auto-removes any joint attached to it, but the explicit
    // removeImpulseJoint calls (and clearing our own maps) keep this
    // engine's bookkeeping honest rather than relying on that implicit
    // side effect.
    for (const entry of this._joints.values()) {
      if (entry.flexible) {
        this._destroyFlexibleJoint(entry);
      } else if (entry.joint?.isValid?.()) {
        this.rapierWorld.removeImpulseJoint(entry.joint, true);
      }
    }
    this._joints.clear();
    for (const body of this._worldAnchorBodies.values()) {
      this.rapierWorld.removeRigidBody(body);
    }
    this._worldAnchorBodies.clear();

    for (const handle of this._handles.values()) {
      this.rapierWorld.removeRigidBody(handle.body);
    }
    this._handles.clear();
    this._colliderHandleMap.clear();
    this._oneWayPlatformHandles.clear();
    this._disabledJointCollisionPairs.clear();
    this._colliderWorldBoundsCache.clear();
    this._activeSolidContacts.clear();
    for (const body of this._tilemapBodies.values()) {
      this.rapierWorld.removeRigidBody(body);
    }
    this._tilemapBodies.clear();
    this._tilemapCellColliders.clear();
    this._tilemapBodySig.clear();
    // Drop any leftover fixed-timestep backlog from the scene that just
    // ended so a restart doesn't immediately burn through several
    // catch-up substeps of stale time.
    this._physicsAccumulator = 0;
  }

  destroy() {
    this.clear();
    this.rapierWorld = null;
    this.ready = false;
  }
}
