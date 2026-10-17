/**
 * runtime/components/NavAgent2D.js
 *
 * Plain data describing ONE agent's navigation settings against the
 * scene's shared NavWorld2D (see components/NavWorld2D.js). Add this
 * component to any entity that should move over the shared nav data —
 * many entities can each have their own NavAgent2D pointed at the SAME
 * NavWorld2D, with no per-agent navigation world and no per-agent bake
 * (see systems/NavWorldSystem.js's header for the full pipeline).
 *
 * Field groups mirror the requested Inspector layout, with one change
 * from the original spec — see the "Navigation" note below:
 *
 *   NAV AGENT 2D
 *   Agent
 *       Radius
 *   Movement
 *       Speed
 *       Acceleration
 *       Deceleration
 *       Stopping Distance
 *   Pathfinding
 *       Auto Repath
 *       Repath Interval
 *       Repath Distance
 *   Avoidance
 *       Enabled
 *       Priority
 *   Collaboration
 *       Enabled
 *       Group Radius
 *   Navigation
 *       Area Mask
 *
 * Deliberately 2D-only: no agent height, no 3D radius/slope/step-offset
 * fields — this is a 2D grid system, not a port of a 3D nav agent.
 *
 * IMPORTANT: this component does NOT implement movement or pathfinding
 * itself. All real path queries/erosion-by-radius go through
 * NavWorld2D's getAgentNavLayer() + pathfinding/AStar.js, wired via
 * NavWorldSystem.js — same "plain data only, systems do the work"
 * convention as Rigidbody2D/CharacterController.
 *
 * RUNTIME-ONLY FILE.
 */

export const NAV_AGENT_2D = "NavAgent2D";

export class NavAgent2D {
  constructor({
    // Agent
    radius = 16, // px clearance this agent needs from obstacles/other geometry.
                 // Belongs to the AGENT, not the shared NavWorld2D — see that
                 // component's header. Many agents with different radii can
                 // query the same baked world; a narrow passage can be
                 // walkable for a small agent and blocked for a large one.
                 //
                 // 16 is a placeholder, NOT a size this should be left at —
                 // it has no relationship to how big this entity actually
                 // is. It should be roughly this entity's own bounding
                 // radius (half-diagonal for a box), since that's the
                 // clearance the agent's own body needs from a same-sized
                 // obstacle to avoid clipping it — e.g. a 100x100 default
                 // box needs a radius of about 60-80 (half-diagonal ≈ 70.7),
                 // not the fixed default. The Inspector's "Match Collider"
                 // button on this component sets it from the entity's own
                 // Collider2D + Transform.scale automatically; see
                 // EditorEvents.js's "match-navagent-radius" action.

    // Movement
    speed = 120, // px/s top move speed
    acceleration = 800, // px/s^2 — how fast the agent speeds up toward `speed`
    deceleration = 1000, // px/s^2 — how fast the agent slows when arriving/stopping
    stoppingDistance = 1, // px from the final target that counts as arrived

    // Pathfinding
    autoRepath = true, // if true, the agent re-checks its path on a timer/on
                        // target movement automatically (see repathInterval/
                        // repathDistance below). If false, the path is only
                        // (re)computed when a script explicitly requests one.
    repathInterval = 0.35, // seconds between automatic path re-checks
    repathDistance = 4, // world units a moving target must shift before an
                         // immediate re-path is forced, independent of the timer

    // Avoidance — separate from pathfinding (see NavWorldSystem.js header:
    // "Pathfinding answers how do I get there, avoidance answers how do I
    // avoid this NPC directly in front of me"). Plain tuning data here;
    // the actual steering adjustment is applied by whichever movement
    // system reads it (e.g. ScriptAPI.navMoveToward), same division of
    // responsibility CharacterController has with ControllerSystem.
    avoidanceEnabled = true,
    avoidancePriority = 50, // 0-100. Higher-priority agents yield less to
                             // lower-priority ones when two agents' local
                             // avoidance disagrees about who moves aside.

    // Collaboration — separate from both pathfinding AND avoidance (see
    // #5 above: "how do I get there" vs "how do I avoid the NPC in front
    // of me"). This answers a third question: "when several of us are
    // converging on the SAME thing, how do we spread out around it
    // instead of stacking up on one side?" Like avoidance, this is pure
    // per-frame steering applied by whichever movement code calls
    // this.navMoveToward() — it never touches the NavWorld2D or
    // re-plans a path. See ScriptAPI.js's _applyNavCollab() for the
    // actual grouping/slotting logic and NavAgentAPI.js for the
    // script-facing this.navAgent.collabEnabled/collabGroupRadius knobs.
    collabEnabled = false, // opt-in: off by default so existing scenes/
                            // scripts behave exactly as before. Turn on
                            // per-agent for NPCs that should encircle a
                            // shared target (guards converging on an
                            // intruder, a pack surrounding prey) instead
                            // of independently pathing to the same point
                            // and shoving each other there.
    collabGroupRadius = 96, // px. Two collabEnabled agents heading toward
                             // targets within this distance of each other
                             // are treated as "going for the same thing"
                             // and are assigned separate slots around it.
                             // Larger = groups form across bigger gaps
                             // (good for open areas); smaller = only
                             // near-exact same-target convergence groups
                             // (good for tightly packed scenes).

    // Car + NavAgent2D local vehicle planner. These affect navDriveToward()
    // only; normal walking NavAgent2D behavior remains unchanged.
    vehicleLookahead = 72,
    vehicleCornerLookahead = 110,
    vehicleObstacleLookahead = 120,
    vehicleObstacleWidth = 28,
    vehicleSteerSmoothing = 7,
    vehicleSpeedSmoothing = 5,
    vehicleCornerSlowdown = 0.72,
    vehicleObstacleBrake = 0.9,
    vehicleRecoveryTime = 1.35, // seconds of being stuck (pushing into
                                 // something with little progress, drifting
                                 // off the planned lane, or on a collision
                                 // course with something dead ahead) before
                                 // the car commits to a recovery maneuver.
                                 // At that point it does NOT just blindly
                                 // back up: it compares a forward turn-
                                 // around against a careful reverse (using
                                 // this frame's own obstacle-scan clearance
                                 // on both sides, plus a short rear raycast)
                                 // and picks whichever is actually safer/
                                 // faster — reversing if turning would clip
                                 // something, turning if reverse is blocked,
                                 // or a combined reverse-while-turning when
                                 // that gets the car realigned fastest. See
                                 // navDriveToward()'s recovery block in
                                 // ScriptAPI.js for the full decision.
    vehicleRecoveryReverseTime = 0.9, // seconds the chosen recovery
                                       // maneuver runs before the car forces
                                       // an immediate repath and resumes
                                       // toward its goal from wherever the
                                       // maneuver actually left it.

    // Navigation — same model as Unity's NavMeshAgent.areaMask: a
    // bitmask of which NavWorld2D cell areas (Ground, Water, Mud, ...)
    // this agent is ALLOWED to path through at all — a route can never
    // cross a bit that's off here, no matter how short a shortcut it
    // would be. See components/NavWorld2D.js's NAV_AREA_COUNT and
    // editor/state/NavAreas.js for the name registry, and
    // NavWorld2D.js's `areaCosts` for the separate, SOFT per-area
    // preference (e.g. "prefer roads over mud") that applies only to
    // areas already allowed by this mask. There is deliberately no
    // separate `layer` field here — Unity's NavMeshAgent has no such
    // concept either; physics layers (Collider2D.layer/mask) and nav
    // areas are two unrelated systems, and folding one into the other
    // was the source of an earlier confusing design.
    area = 0xffff, // default: every area allowed

    // Per-agent override of NavWorld2D.areaCosts, index-aligned with the
    // same 16 area slots (see editor/state/NavAreas.js for the name
    // registry both arrays share). null (the default) means "use the
    // NavWorld2D's cost for every area" — existing scenes/agents are
    // completely unaffected until a value is set here. When non-null,
    // this array is checked FIRST per area slot: a finite entry > 0
    // overrides the world's cost for that slot for THIS agent only;
    // any slot left null/undefined/non-numeric on this agent falls
    // through to the world's cost for that slot, so an agent can
    // override just one or two areas without having to restate every
    // slot. Two agents can therefore treat the exact same "Mud" cell as
    // different costs — e.g. a heavy truck agent makes Mud very
    // expensive while a light scout agent leaves it at the world
    // default — without either of them touching the shared NavWorld2D.
    // See NavWorld2D.getAgentNavLayer()'s header for how this and the
    // world cost are combined into one per-cell cost array, and
    // NavWorld2D.areaCosts's header for the mask-vs-cost distinction
    // (this is still a SOFT preference; area still comes from `area`
    // above).
    areaCosts = null,

    // Set (transiently, for one movement step) by NavWorldSystem/ScriptAPI
    // path-following helpers to hand a fresh path to this agent without
    // NavAgent2D reaching back into the system itself — plain data, one-
    // shot per repath, same pattern as CharacterController's requestJump.
    currentPath = null,
    currentPathIndex = 0,
  } = {}) {
    this.radius = Math.max(0, radius);

    this.speed = Math.max(0, speed);
    this.acceleration = Math.max(0, acceleration);
    this.deceleration = Math.max(0, deceleration);
    this.stoppingDistance = Math.max(0, stoppingDistance);

    this.autoRepath = !!autoRepath;
    this.repathInterval = Math.max(0.05, repathInterval);
    this.repathDistance = Math.max(0, repathDistance);

    this.avoidanceEnabled = !!avoidanceEnabled;
    this.avoidancePriority = Math.max(0, Math.min(100, avoidancePriority));

    this.collabEnabled = !!collabEnabled;
    this.collabGroupRadius = Math.max(0, collabGroupRadius);

    this.vehicleLookahead = Math.max(16, Number(vehicleLookahead) || 72);
    this.vehicleCornerLookahead = Math.max(this.vehicleLookahead, Number(vehicleCornerLookahead) || 110);
    this.vehicleObstacleLookahead = Math.max(24, Number(vehicleObstacleLookahead) || 120);
    this.vehicleObstacleWidth = Math.max(4, Number(vehicleObstacleWidth) || 28);
    this.vehicleSteerSmoothing = Math.max(1, Number(vehicleSteerSmoothing) || 7);
    this.vehicleSpeedSmoothing = Math.max(1, Number(vehicleSpeedSmoothing) || 5);
    this.vehicleCornerSlowdown = Math.max(0.2, Math.min(1, Number(vehicleCornerSlowdown) || 0.72));
    this.vehicleObstacleBrake = Math.max(0.2, Math.min(1.5, Number(vehicleObstacleBrake) || 0.9));
    this.vehicleRecoveryTime = Math.max(0.5, Number(vehicleRecoveryTime) || 1.35);
    this.vehicleRecoveryReverseTime = Math.max(0.35, Number(vehicleRecoveryReverseTime) || 0.9);

    this.area = area & 0xffff;

    // Normalize to either null (no override at all — the common case)
    // or a full NAV_AREA_COUNT-length array with non-overriding slots
    // left as null, never undefined/NaN, so getAgentNavLayer's signature
    // + fallback logic never has to special-case a ragged input array.
    if (Array.isArray(areaCosts)) {
      this.areaCosts = new Array(16).fill(null);
      for (let i = 0; i < 16; i++) {
        const v = Number(areaCosts[i]);
        this.areaCosts[i] = Number.isFinite(v) && v > 0 ? v : null;
      }
    } else {
      this.areaCosts = null;
    }

    this.currentPath = currentPath;
    this.currentPathIndex = currentPathIndex;
  }
}

/**
 * Sets (or clears) this agent's cost OVERRIDE for one area slot —
 * the per-agent counterpart to NavWorld2D's setNavAreaCost(). Lazily
 * allocates the 16-slot override array the first time any slot is
 * overridden, same "null until touched" convention the constructor
 * uses, so an agent that never overrides anything keeps areaCosts
 * exactly null (cheapest possible cache-key case — see
 * NavWorld2D.getAgentNavLayer's radiusCacheKey).
 * @param {NavAgent2D} navAgent
 * @param {number} areaIndex 0-15
 * @param {number|null} cost a finite cost > 0 to override with, or
 *   null/NaN/<=0 to clear the override for this slot (falls back to
 *   the NavWorld2D's own cost for that slot again).
 * @returns {boolean} true if anything actually changed.
 */
export function setNavAgentAreaCost(navAgent, areaIndex, cost) {
  if (!navAgent || areaIndex < 0 || areaIndex >= 16) return false;
  const numericCost = Number(cost);
  const clamped = Number.isFinite(numericCost) && numericCost > 0 ? Math.max(0.01, numericCost) : null;
  const current = Array.isArray(navAgent.areaCosts) ? navAgent.areaCosts[areaIndex] : null;
  if (current === clamped) return false;
  if (!Array.isArray(navAgent.areaCosts)) {
    if (clamped === null) return false; // clearing an already-unset slot: no-op
    navAgent.areaCosts = new Array(16).fill(null);
  }
  navAgent.areaCosts[areaIndex] = clamped;
  // Collapse back to null once every slot is cleared, so a fully
  // reverted agent goes back to sharing the plain radius+mask cached
  // layer instead of permanently paying for its own (all-null) one.
  if (navAgent.areaCosts.every((v) => v === null)) navAgent.areaCosts = null;
  return true;
}
