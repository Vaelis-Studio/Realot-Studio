/**
 * runtime/scripting/components/JointAPI.js
 *
 * The `this.joint` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the general rationale.
 *
 * Unlike Collider2D's API (mostly read-only, one writable field),
 * every Joint2D field here is script-writable — motorSpeed/
 * motorMaxForce/limits are the whole point of driving a joint from
 * gameplay code (a motorized hinge door, a winch reeling in a rope's
 * length), and even the "structural" fields (jointType, anchors, the
 * connected entity) are safe to change live: PhysicsWorld._syncJoints
 * already rebuilds the underlying Rapier joint from scratch whenever
 * any of them differ from what it last built (see that method's `sig`
 * check) — same rebuild-on-change shape RigidbodyAPI's `type` setter
 * relies on for body-type switches. A change takes effect at the next
 * physics step, not instantly.
 *
 * `connectedEntity` takes/returns an EntityContext (or null for
 * "jointed to a fixed point in the world"), not a raw entity id,
 * matching how every other cross-entity reference in this API
 * (findFirst, onCollisionEnter's `other`, etc) is always an
 * EntityContext — scripts never see this engine's internal id strings.
 *
 * RUNTIME-ONLY FILE.
 */

import { JOINT_2D, JointType2D } from "../../components/Joint2D.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _requireJoint(entity) {
  const joint = entity.getComponent(JOINT_2D);
  if (!joint) {
    throw _tag(new Error(
      "'" + (entity.name || "Entity") + "' called this.joint but has no Joint 2D. " +
      "Add one in the Inspector (Add Component → Joint 2D)."
    ), "missing-component");
  }
  return joint;
}

function _validJointTypeOrThrow(value) {
  const known = Object.values(JointType2D);
  if (typeof value === "string") {
    const wanted = value.trim().toLowerCase();
    for (const t of known) if (t.toLowerCase() === wanted) return t;
  }
  throw new Error(
    "this.joint.jointType must be one of " + known.map((t) => JSON.stringify(t)).join(", ") +
    " (got " + (typeof value === "string" ? JSON.stringify(value) : typeof value + " " + String(value)) + ")."
  );
}

const JOINT_MEMBERS = new Set([
  "jointType", "connectedEntity",
  "anchor1", "anchor2", "axis",
  "length", "stiffness", "damping", "flexibility",
  "segmentCount", "ropeMass", "visualEnabled", "visualColor", "visualThickness",
  "useTexture", "textureKey", "textureMode", "textureTiling", "textureScale",
  "textureOffset", "textureFlip",
  "limitsEnabled", "limitMin", "limitMax",
  "motorEnabled", "motorSpeed", "motorMaxForce",
  "jointDrag", "restStiffness", "breakable", "breakForce",
  "disableConnectedCollision", "collideConnected", "enabled",
]);

/**
 * @param {import('../../core/Entity.js').Entity} entity the entity this
 *   Joint2D is attached to (Rapier's body1)
 * @param {object} scriptApi the top-level scripting api object (the
 *   same one every EntityContext carries as this._scriptApi) — used
 *   only via its findById(id) to turn connectedEntityId into an
 *   EntityContext, same lookup findFirst/findFirstWithTag go through.
 */
export function createJointAPI(entity, scriptApi) {
  const target = {
    get jointType() { return _requireJoint(entity).jointType; },
    set jointType(v) { _requireJoint(entity).jointType = _validJointTypeOrThrow(v); },

    get connectedEntity() {
      const j = _requireJoint(entity);
      if (!j.connectedEntityId || !scriptApi || typeof scriptApi.findById !== "function") return null;
      return scriptApi.findById(j.connectedEntityId);
    },
    // Accepts an EntityContext, or null/undefined to joint to a fixed
    // point in the world instead of another body (see Joint2D.js's
    // header comment on connectedEntityId).
    set connectedEntity(v) {
      const j = _requireJoint(entity);
      if (v == null) { j.connectedEntityId = null; return; }
      const otherEntity = v._entity; // every EntityContext this engine hands out carries this
      if (!otherEntity || !otherEntity.id) {
        throw new Error(
          "this.joint.connectedEntity must be an EntityContext (e.g. from findFirst(...)) or null — " +
          "got " + (typeof v) + "."
        );
      }
      j.connectedEntityId = otherEntity.id;
    },

    get anchor1() { const j = _requireJoint(entity); return { x: j.anchor1X, y: j.anchor1Y }; },
    set anchor1(v) {
      const j = _requireJoint(entity);
      j.anchor1X = Number(v && v.x) || 0;
      j.anchor1Y = Number(v && v.y) || 0;
    },
    get anchor2() { const j = _requireJoint(entity); return { x: j.anchor2X, y: j.anchor2Y }; },
    set anchor2(v) {
      const j = _requireJoint(entity);
      j.anchor2X = Number(v && v.x) || 0;
      j.anchor2Y = Number(v && v.y) || 0;
    },

    /** Prismatic only — ignored by every other jointType. Does not need
     *  to be normalized; PhysicsWorld normalizes it before Rapier sees it. */
    get axis() { const j = _requireJoint(entity); return { x: j.axisX, y: j.axisY }; },
    set axis(v) {
      const j = _requireJoint(entity);
      j.axisX = Number(v && v.x) || 0;
      j.axisY = Number(v && v.y) || 0;
    },

    /** Rope: total physical link-path length. Spring: endpoint rest length. */
    get length() { return _requireJoint(entity).length; },
    set length(v) { _requireJoint(entity).length = Number(v) || 0; },

    /** Spring/String only. */
    get stiffness() { return _requireJoint(entity).stiffness; },
    set stiffness(v) { _requireJoint(entity).stiffness = Number(v) || 0; },
    get damping() { return _requireJoint(entity).damping; },
    set damping(v) { _requireJoint(entity).damping = Number(v) || 0; },

    /** Rope/String: number of physical links used to distribute gravity. */
    get segmentCount() { return _requireJoint(entity).segmentCount; },
    set segmentCount(v) {
      const j = _requireJoint(entity);
      j.segmentCount = Math.max(2, Math.min(32, Math.round(Number(v) || 18)));
    },
    get ropeMass() { return _requireJoint(entity).ropeMass; },
    set ropeMass(v) { _requireJoint(entity).ropeMass = Math.max(0, Number(v) || 0); },
    get visualEnabled() { return !!_requireJoint(entity).visualEnabled; },
    set visualEnabled(v) { _requireJoint(entity).visualEnabled = !!v; },
    get visualColor() { return _requireJoint(entity).visualColor; },
    set visualColor(v) {
      const j = _requireJoint(entity);
      j.visualColor = typeof v === "string" && v.trim() ? v.trim() : "#c8a66a";
    },
    get visualThickness() { return _requireJoint(entity).visualThickness; },
    set visualThickness(v) { _requireJoint(entity).visualThickness = Math.max(0.5, Number(v) || 3); },

    /** When true, the rope/string is textured with textureKey's image instead of a flat visualColor line. */
    get useTexture() { return !!_requireJoint(entity).useTexture; },
    set useTexture(v) { _requireJoint(entity).useTexture = !!v; },

    /** Logical sprite/texture asset key painted along the rope/string when useTexture is true. */
    get textureKey() { return _requireJoint(entity).textureKey; },
    set textureKey(v) { _requireJoint(entity).textureKey = v; },

    /** "stretch" (fit the whole image end-to-end, warps as length changes) or "tile" (repeat at natural size, never stretches). */
    get textureMode() { return _requireJoint(entity).textureMode; },
    set textureMode(v) { _requireJoint(entity).textureMode = v === "tile" ? "tile" : "stretch"; },

    /** Tile mode only: world px one tile covers along the rope's length. */
    get textureTiling() { return _requireJoint(entity).textureTiling; },
    set textureTiling(v) { _requireJoint(entity).textureTiling = Math.max(1, Number(v) || 32); },

    /** How many times the texture repeats ACROSS the rope's thickness. */
    get textureScale() { return _requireJoint(entity).textureScale; },
    set textureScale(v) { _requireJoint(entity).textureScale = Number(v) || 1; },

    /** Shifts the texture along the rope's length, in the same units as textureTiling. */
    get textureOffset() { return _requireJoint(entity).textureOffset; },
    set textureOffset(v) { _requireJoint(entity).textureOffset = Number(v) || 0; },

    /** Mirrors the texture across the rope's length. */
    get textureFlip() { return !!_requireJoint(entity).textureFlip; },
    set textureFlip(v) { _requireJoint(entity).textureFlip = !!v; },

    /** Revolute (degrees) + Prismatic (pixels) only. */
    get limitsEnabled() { return !!_requireJoint(entity).limitsEnabled; },
    set limitsEnabled(v) { _requireJoint(entity).limitsEnabled = !!v; },
    get limitMin() { return _requireJoint(entity).limitMin; },
    set limitMin(v) { _requireJoint(entity).limitMin = Number(v) || 0; },
    get limitMax() { return _requireJoint(entity).limitMax; },
    set limitMax(v) { _requireJoint(entity).limitMax = Number(v) || 0; },

    /** Revolute (deg/sec) + Prismatic (px/sec) only. motorMaxForce=0
     *  behaves as "off" even with motorEnabled=true — see Joint2D.js. */
    get motorEnabled() { return !!_requireJoint(entity).motorEnabled; },
    set motorEnabled(v) { _requireJoint(entity).motorEnabled = !!v; },
    get motorSpeed() { return _requireJoint(entity).motorSpeed; },
    set motorSpeed(v) { _requireJoint(entity).motorSpeed = Number(v) || 0; },
    get motorMaxForce() { return _requireJoint(entity).motorMaxForce; },
    set motorMaxForce(v) { _requireJoint(entity).motorMaxForce = Math.max(0, Number(v) || 0); },

    /** Revolute-only passive rotational drag/damping. Zero leaves the hinge free. */
    get jointDrag() { return _requireJoint(entity).jointDrag; },
    set jointDrag(v) { _requireJoint(entity).jointDrag = Math.max(0, Number(v) || 0); },
    /** Revolute-only torsional stiffness toward the joint's creation/rest angle. */
    get restStiffness() { return _requireJoint(entity).restStiffness; },
    set restStiffness(v) { _requireJoint(entity).restStiffness = Math.max(0, Number(v) || 0); },
    /** Revolute-only: enables structural breaking when estimated joint demand exceeds breakForce. */
    get breakable() { return !!_requireJoint(entity).breakable; },
    set breakable(v) { _requireJoint(entity).breakable = !!v; },
    get breakForce() { return _requireJoint(entity).breakForce; },
    set breakForce(v) { _requireJoint(entity).breakForce = Math.max(0, Number(v) || 0); },

    get disableConnectedCollision() { return !!_requireJoint(entity).disableConnectedCollision; },
    set disableConnectedCollision(v) { _requireJoint(entity).disableConnectedCollision = !!v; },
    // Backward-compatible inverse alias. Prefer disableConnectedCollision.
    get collideConnected() { return !_requireJoint(entity).disableConnectedCollision; },
    set collideConnected(v) { _requireJoint(entity).disableConnectedCollision = !Boolean(v); },

    /** Set false to remove the live Rapier joint next step without
     *  deleting the component — the two bodies move independently
     *  again until re-enabled. */
    get enabled() { return !!_requireJoint(entity).enabled; },
    set enabled(v) { _requireJoint(entity).enabled = !!v; },
  };

  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      const key = String(prop);
      if (!(key in t) && !JOINT_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.joint." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(JOINT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      const v = t[key];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set(t, prop, value) {
      const key = String(prop);
      if (!JOINT_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.joint." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(JOINT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      t[key] = value; // goes through the validating setter above
      return true;
    },
  });
}
