/**
 * runtime/scripting/components/NavAgentAPI.js
 *
 * The `this.navAgent` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js's _buildSubObjects). One file per scripting
 * component — see TransformAPI.js's header comment for the general
 * rationale.
 *
 * Unlike ColliderAPI.js (read-only — collider shape changes have real
 * physics-engine cost, so scripts are steered toward the Inspector),
 * every NavAgent2D field here is READ/WRITE. A script can tune an
 * agent's behavior at runtime with plain assignment:
 *
 *   this.navAgent.speed = 200;               // sudden burst of speed
 *   this.navAgent.radius = 4;                // shrink to squeeze through a gap
 *   this.navAgent.avoidanceEnabled = false;   // ignore other agents briefly
 *   this.navAgent.area = this.navAgent.area | (1 << 3); // allow area bit 3
 *
 * This is intentional and cheap: NavAgent2D is plain per-entity data
 * (see components/NavAgent2D.js), not something Rapier or the bake
 * pipeline needs to be told about synchronously. A `radius` change
 * takes effect on the agent's NEXT path query — NavWorld2D.
 * getAgentNavLayer() lazily computes (and caches) a fresh derived
 * layer for whatever radius it's asked for, so nothing needs to be
 * manually invalidated/rebuilt here for a radius edit to take effect.
 *
 * `currentPath`/`currentPathIndex` are exposed READ-ONLY — they're
 * transient bookkeeping owned by this.navMoveToward()'s internal state
 * machine (see ScriptAPI.js), not meant to be hand-edited; a script
 * that wants to change WHERE an agent is headed should call
 * this.navMoveToward(newX, newY, ...) again, not poke the path array.
 *
 * RUNTIME-ONLY FILE.
 */

import { NAV_AGENT_2D } from "../../components/NavAgent2D.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _requireNavAgent(entity) {
  const navAgent = entity.getComponent(NAV_AGENT_2D);
  if (!navAgent) {
    throw _tag(new Error(
      "'" + (entity.name || "Entity") + "' called this.navAgent but has no Nav Agent 2D. " +
      "Add one in the Inspector (Add Component → Nav Agent 2D)."
    ), "missing-component");
  }
  return navAgent;
}

const NAV_AGENT_MEMBERS = new Set([
  "radius",
  "speed", "acceleration", "deceleration", "stoppingDistance",
  "autoRepath", "repathInterval", "repathDistance",
  "avoidanceEnabled", "avoidancePriority",
  "collabEnabled", "collabGroupRadius",
  "vehicleLookahead", "vehicleCornerLookahead", "vehicleObstacleLookahead",
  "vehicleObstacleWidth", "vehicleSteerSmoothing", "vehicleSpeedSmoothing",
  "vehicleCornerSlowdown", "vehicleObstacleBrake", "vehicleRecoveryTime",
  "vehicleRecoveryReverseTime",
  "area",
  "areaCosts",
  "currentPath", "currentPathIndex",
]);

const READ_ONLY_MEMBERS = new Set(["currentPath", "currentPathIndex"]);

export function createNavAgentAPI(entity) {
  const target = {
    get radius() { return _requireNavAgent(entity).radius; },
    set radius(v) { _requireNavAgent(entity).radius = Math.max(0, Number(v) || 0); },

    get speed() { return _requireNavAgent(entity).speed; },
    set speed(v) { _requireNavAgent(entity).speed = Math.max(0, Number(v) || 0); },
    get acceleration() { return _requireNavAgent(entity).acceleration; },
    set acceleration(v) { _requireNavAgent(entity).acceleration = Math.max(0, Number(v) || 0); },
    get deceleration() { return _requireNavAgent(entity).deceleration; },
    set deceleration(v) { _requireNavAgent(entity).deceleration = Math.max(0, Number(v) || 0); },
    get stoppingDistance() { return _requireNavAgent(entity).stoppingDistance; },
    set stoppingDistance(v) { _requireNavAgent(entity).stoppingDistance = Math.max(0, Number(v) || 0); },

    get autoRepath() { return _requireNavAgent(entity).autoRepath; },
    set autoRepath(v) { _requireNavAgent(entity).autoRepath = !!v; },
    get repathInterval() { return _requireNavAgent(entity).repathInterval; },
    set repathInterval(v) { _requireNavAgent(entity).repathInterval = Math.max(0.05, Number(v) || 0.05); },
    get repathDistance() { return _requireNavAgent(entity).repathDistance; },
    set repathDistance(v) { _requireNavAgent(entity).repathDistance = Math.max(0, Number(v) || 0); },

    get avoidanceEnabled() { return _requireNavAgent(entity).avoidanceEnabled; },
    set avoidanceEnabled(v) { _requireNavAgent(entity).avoidanceEnabled = !!v; },
    get avoidancePriority() { return _requireNavAgent(entity).avoidancePriority; },
    set avoidancePriority(v) { _requireNavAgent(entity).avoidancePriority = Math.max(0, Math.min(100, Number(v) || 0)); },

    // Collaboration — see components/NavAgent2D.js's collabEnabled/
    // collabGroupRadius doc comments and ScriptAPI.js's
    // _applyNavCollab() for the "smart NPC surround" behavior these
    // drive. Both live-tunable, same as avoidance above:
    //   this.navAgent.collabEnabled = true;      // join group-surround behavior
    //   this.navAgent.collabGroupRadius = 200;    // widen how far apart targets can be and still count as "the same thing"
    get collabEnabled() { return _requireNavAgent(entity).collabEnabled; },
    set collabEnabled(v) { _requireNavAgent(entity).collabEnabled = !!v; },
    get collabGroupRadius() { return _requireNavAgent(entity).collabGroupRadius; },
    set collabGroupRadius(v) { _requireNavAgent(entity).collabGroupRadius = Math.max(0, Number(v) || 0); },


    // Car-only local driving planner knobs used by navDriveToward().
    get vehicleLookahead() { return _requireNavAgent(entity).vehicleLookahead; },
    set vehicleLookahead(v) { _requireNavAgent(entity).vehicleLookahead = Math.max(16, Number(v) || 16); },
    get vehicleCornerLookahead() { return _requireNavAgent(entity).vehicleCornerLookahead; },
    set vehicleCornerLookahead(v) { _requireNavAgent(entity).vehicleCornerLookahead = Math.max(16, Number(v) || 16); },
    get vehicleObstacleLookahead() { return _requireNavAgent(entity).vehicleObstacleLookahead; },
    set vehicleObstacleLookahead(v) { _requireNavAgent(entity).vehicleObstacleLookahead = Math.max(24, Number(v) || 24); },
    get vehicleObstacleWidth() { return _requireNavAgent(entity).vehicleObstacleWidth; },
    set vehicleObstacleWidth(v) { _requireNavAgent(entity).vehicleObstacleWidth = Math.max(4, Number(v) || 4); },
    get vehicleSteerSmoothing() { return _requireNavAgent(entity).vehicleSteerSmoothing; },
    set vehicleSteerSmoothing(v) { _requireNavAgent(entity).vehicleSteerSmoothing = Math.max(1, Number(v) || 1); },
    get vehicleSpeedSmoothing() { return _requireNavAgent(entity).vehicleSpeedSmoothing; },
    set vehicleSpeedSmoothing(v) { _requireNavAgent(entity).vehicleSpeedSmoothing = Math.max(1, Number(v) || 1); },
    get vehicleCornerSlowdown() { return _requireNavAgent(entity).vehicleCornerSlowdown; },
    set vehicleCornerSlowdown(v) { _requireNavAgent(entity).vehicleCornerSlowdown = Math.max(0.2, Math.min(1, Number(v) || 0.2)); },
    get vehicleObstacleBrake() { return _requireNavAgent(entity).vehicleObstacleBrake; },
    set vehicleObstacleBrake(v) { _requireNavAgent(entity).vehicleObstacleBrake = Math.max(0.2, Math.min(1.5, Number(v) || 0.2)); },
    get vehicleRecoveryTime() { return _requireNavAgent(entity).vehicleRecoveryTime; },
    set vehicleRecoveryTime(v) { _requireNavAgent(entity).vehicleRecoveryTime = Math.max(0.5, Number(v) || 0.5); },
    get vehicleRecoveryReverseTime() { return _requireNavAgent(entity).vehicleRecoveryReverseTime; },
    set vehicleRecoveryReverseTime(v) { _requireNavAgent(entity).vehicleRecoveryReverseTime = Math.max(0.35, Number(v) || 0.35); },

    // Bitmask of NavWorld2D area slots this agent is ALLOWED to path
    // through at all — same model as Unity's NavMeshAgent.areaMask. A
    // route never crosses a cell whose area bit isn't set here, no
    // matter how short a shortcut it would be. See
    // editor/state/NavAreas.js for the name registry behind each bit,
    // and NavWorld2D.areaCosts for the separate SOFT per-area
    // preference (e.g. "prefer roads over mud") that applies only to
    // areas already allowed by this mask. Scripts toggle one area at a
    // time with the same bitwise pattern the Inspector's checkboxes use
    // under the hood:
    //   this.navAgent.area = this.navAgent.area | (1 << 2);  // allow area 2
    //   this.navAgent.area = this.navAgent.area & ~(1 << 2); // disallow area 2
    get area() { return _requireNavAgent(entity).area; },
    set area(v) { _requireNavAgent(entity).area = (Number(v) || 0) & 0xffff; },

    // Per-agent override of NavWorld2D.areaCosts — see
    // components/NavAgent2D.js's areaCosts field header for the full
    // "override just what you need, fall through to the world's cost
    // for everything else" semantics. null (the default) means "use
    // the world's cost for every area". Assigning an array here
    // re-normalizes it exactly like the component constructor does
    // (16 slots, non-finite/<=0 entries become null), so a script
    // can safely write a short/sparse array and rely on the rest
    // falling back to the world:
    //   this.navAgent.areaCosts = [];       // no overrides (== null)
    //   this.navAgent.areaCosts[2] = 5;      // WRONG — doesn't trigger
    //                                        // the setter; read, mutate
    //                                        // a copy, then reassign:
    //   var costs = this.navAgent.areaCosts || [];
    //   costs[2] = 5;
    //   this.navAgent.areaCosts = costs;
    get areaCosts() { return _requireNavAgent(entity).areaCosts; },
    set areaCosts(v) {
      const navAgent = _requireNavAgent(entity);
      if (!Array.isArray(v)) { navAgent.areaCosts = null; return; }
      const normalized = new Array(16).fill(null);
      for (let i = 0; i < 16; i++) {
        const n = Number(v[i]);
        normalized[i] = Number.isFinite(n) && n > 0 ? n : null;
      }
      navAgent.areaCosts = normalized;
    },

    // Read-only — see this file's header for why these aren't settable
    // directly.
    get currentPath() { return _requireNavAgent(entity).currentPath; },
    get currentPathIndex() { return _requireNavAgent(entity).currentPathIndex; },
  };

  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      const key = String(prop);
      if (!(key in t) && !NAV_AGENT_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.navAgent." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(NAV_AGENT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      const v = t[key];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set(t, prop, value) {
      const key = String(prop);
      if (READ_ONLY_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.navAgent." + key + " is read-only — it's managed automatically by this.navMoveToward(). " +
          "Call this.navMoveToward(x, y) again to change where this agent is headed."
        ), "unsupported-body-type");
      }
      if (!NAV_AGENT_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.navAgent." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(NAV_AGENT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
