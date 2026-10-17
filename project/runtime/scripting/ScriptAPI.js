/**
 * runtime/scripting/ScriptAPI.js
 *
 * The API exposed to user game scripts. Scripts are given this API instead
 * of the World/Entity classes, and the common browser globals (document,
 * window, localStorage, fetch...) are shadowed to `undefined` inside
 * compiled scripts (see SHADOWED_GLOBALS in ScriptSystem.js). That is a
 * guard rail, NOT a security boundary — treat scripts as trusted code
 * (see SECURITY.md).
 *
 * Two layers:
 *  1. Globals passed as function parameters to each compiled script:
 *     find/lookups, scene, physics, input, time, random, mathx, tween, global
 *  2. EntityContext — the `this` binding inside lifecycle functions:
 *     this.x, this.y, this.transform, this.sprite, this.rigidbody, etc.
 *
 * Property access uses getters/setters that read/write LIVE component
 * data, so a script doing `this.x = 100` immediately moves the entity
 * and `this.rigidbody.velocity` always reflects the physics body's
 * real velocity.
 *
 * ONE API PER CAPABILITY: this.x/y/position/rotation/scaleX/scaleY/
 * translate/visible/enabled are flat shortcuts (Transform has only one
 * shape, and other.x/other.y is the documented pattern inside
 * onCollision(other)/onTriggerEnter(other)). Everything else —
 * velocity, physics forces, sprite properties, animation, camera,
 * audio, movement-type tunables (jump/car/follow settings) — is
 * reached ONLY through its sub-object (this.rigidbody.*, this.sprite.*,
 * this.shape.*, this.animator.*, this.camera.*, this.audio.*, this.controller.*).
 * There is deliberately no this.velocityX / this.addForce() / this.
 * texture / this.isOnGround flat-shortcut duplicate of these:
 * RigidbodyAPI.js exposes a DIFFERENT shape per Rigidbody2D.bodyType
 * (Dynamic/Kinematic/Static), and ControllerAPI.js exposes a DIFFERENT
 * shape per CharacterController.controllerType (Character/Platformer/
 * Top-Down/Car/Follow/Free) — a second flat copy of either would have
 * to duplicate that per-type logic or drift out of sync with it, two
 * ways to do the same thing that could behave differently from each
 * other. See scripting/components/RigidbodyAPI.js and ControllerAPI.js.
 *
 * Each `this.<subobject>` (transform, sprite, rigidbody, animator,
 * camera, audio, controller) is built by its OWN file under
 * scripting/components/, not inlined here — that folder is where new
 * scripting components get added as the API grows (RULES.txt
 * scripting/ folder convention), keeping this file focused on wiring
 * rather than growing without bound.
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../components/Transform.js";
import { clientToLocal, prepareGameCanvas } from "../core/MobileViewport.js";
import { SCRIPT } from "../components/Script.js";
import { COLLIDER_2D } from "../components/Collider2D.js";
import { JOINT_2D } from "../components/Joint2D.js";
import { SPRITE_RENDERER } from "../components/SpriteRenderer.js";
import { SHAPE_RENDERER } from "../components/ShapeRenderer.js";
import { TEXT_RENDERER } from "../components/TextRenderer.js";
import { SPEECH_BUBBLE } from "../components/SpeechBubble.js";
import { CHAT_LOG } from "../components/ChatLog.js";
import { TEXT_INPUT } from "../components/TextInput.js";
import { JOYSTICK } from "../components/Joystick.js";
import { RIGIDBODY_2D, markScriptPositionTarget } from "../components/Rigidbody2D.js";
import { SPRITE_ANIMATION } from "../components/SpriteAnimation.js";
import { CAMERA } from "../components/Camera.js";
import { AUDIO_SOURCE } from "../components/AudioSource.js";
import { AUDIO_LISTENER } from "../components/AudioListener.js";
import { NAV_AGENT_2D } from "../components/NavAgent2D.js";
import { resolveNavAreaIndex, resolveNavAreaMask, resolveNavAreaCosts } from "./NavAPI.js";
import { CHARACTER_CONTROLLER, ControllerType } from "../components/CharacterController.js";
import { cloneEntity } from "../scene/SceneSerializer.js";
import { createTransformAPI } from "./components/TransformAPI.js";
import { createSpriteAPI } from "./components/SpriteAPI.js";
import { createShapeAPI } from "./components/ShapeAPI.js";
import { createTextAPI } from "./components/TextAPI.js";
import { createSpeechBubbleAPI } from "./components/SpeechBubbleAPI.js";
import { createChatLogAPI } from "./components/ChatLogAPI.js";
import { createTextInputAPI } from "./components/TextInputAPI.js";
import { createJoystickAPI } from "./components/JoystickAPI.js";
import { createRigidbodyAPI } from "./components/RigidbodyAPI.js";
import { createAnimatorAPI } from "./components/AnimatorAPI.js";
import { createCameraAPI } from "./components/CameraAPI.js";
import { createAudioAPI } from "./components/AudioAPI.js";
import { createAudioListenerAPI } from "./components/AudioListenerAPI.js";
import { createControllerAPI } from "./components/ControllerAPI.js";
import { createColliderAPI } from "./components/ColliderAPI.js";
import { createJointAPI } from "./components/JointAPI.js";
import { createNavAgentAPI } from "./components/NavAgentAPI.js";
import { LIGHT } from "../components/Light.js";
import { createLightAPI } from "./components/LightAPI.js";
import { SHADOW_CASTER } from "../components/ShadowCaster.js";
import { createShadowCasterAPI } from "./components/ShadowCasterAPI.js";
import { createLightingSettingsAPI } from "./components/LightingSettingsAPI.js";
import { STROKE_PATH } from "../components/StrokePath.js";
import { createStrokePathAPI } from "./components/StrokePathAPI.js";
import { createStateAPI } from "./components/StateAPI.js";
import { createTouchTrackAPI } from "./components/TouchTrackAPI.js";
import { createSaveAPI } from "./components/SaveAPI.js";
import { SaveStore } from "./SaveStore.js";

import { NAV_API_OPTION_FIELDS } from "./NavAPI.js";
/**
 * The `this` context inside a user script. All property access reads
 * from / writes to the entity's live components.
 */
class EntityContext {
  constructor(entity, world, scriptApi) {
    this._entity = entity;
    this._world = world;
    this._scriptApi = scriptApi;
    // Set to true ONLY on the context handed to a freshly-spawned
    // entity's OWN script instances (see ScriptSystem
    // ._initEntityScripts()) — false for every entity that came from
    // the scene file itself, and false for every OTHER context this same
    // clone hands out later (e.g. `other` inside onCollision) even
    // though contexts are cached per-entity-id, since this flag is set
    // once right after creation and never toggled again. Mirrors
    // Unity's own convention of tagging runtime-Instantiate()'d copies.
    this._isClone = false;
    this._buildSubObjects();
  }

  // Raycasting is handled entirely by Rapier now (PhysicsWorld.castRay,
  // wired through _physicsRaycastFn — see runtime/index.js and _raycast()
  // below). The old _getColliderAABB() box-fit approximation used to back
  // a manual raycast path here; it's gone because Rapier's real shape
  // query is both more accurate (correct on circle/capsule/triangle/
  // polygon colliders, not just their bounding boxes) and cheaper (no
  // extra object allocated/discarded per raycast call, no redundant
  // shape math duplicating what Rapier already computes internally).

  // --- Shortcut aliases (read/write live Transform data) ---

  get x() { const t = this._entity.getComponent(TRANSFORM); return t ? t.x : 0; }
  set x(v) {
    const t = this._entity.getComponent(TRANSFORM);
    if (!t) return;
    t.x = v;
    // See Rigidbody2D.js's markScriptPositionTarget doc comment: a
    // Dynamic/Kinematic body owns its own position once created, so a
    // bare Transform write here would otherwise get silently
    // overwritten by PhysicsWorld's next post-step sync instead of
    // actually teleporting the body.
    markScriptPositionTarget(this._entity, t.x, t.y);
  }

  get y() { const t = this._entity.getComponent(TRANSFORM); return t ? t.y : 0; }
  set y(v) {
    const t = this._entity.getComponent(TRANSFORM);
    if (!t) return;
    t.y = v;
    markScriptPositionTarget(this._entity, t.x, t.y);
  }

  // position as an { x, y } object — mirrors this.transform.position
  get position() { const t = this._entity.getComponent(TRANSFORM); return t ? { x: t.x, y: t.y } : { x: 0, y: 0 }; }
  set position(v) {
    const t = this._entity.getComponent(TRANSFORM);
    if (!t) return;
    // NOTE: was previously `t.position = v`, which did nothing —
    // Transform (components/Transform.js) has no `position` field at
    // all, only x/y, so that write silently created an unused ad-hoc
    // property instead of actually moving the entity. this.position =
    // {...} was a no-op bug before this fix, independent of the
    // Rigidbody teleport issue markScriptPositionTarget addresses below.
    t.x = v.x;
    t.y = v.y;
    markScriptPositionTarget(this._entity, t.x, t.y);
  }

  // translate — move by a delta amount this frame
  translate(dx, dy) {
    const t = this._entity.getComponent(TRANSFORM);
    if (!t) return;
    t.translate(dx, dy);
    // A relative nudge is just as much an intentional teleport as an
    // absolute assignment from the physics body's point of view — both
    // need Rapier's translation moved to match, or the same
    // next-step-overwrite bug applies.
    markScriptPositionTarget(this._entity, t.x, t.y);
  }

  /**
   * One-line NavWorld2D-following movement: paths to (targetX,targetY)
   * via nav.findPath() and advances this entity ONE STEP along that
   * path every call — call it once per onUpdate() and it does
   * everything SmartChaseNPC.js used to hand-roll manually (caching the
   * path, re-pathing on a timer, walking waypoint by waypoint, picking
   * rigidbody-vs-direct-transform movement):
   *
   *   this.navMoveToward(target.x, target.y, 120);
   *
   * If this entity has a NavAgent2D component (Add Component > Nav
   * Agent 2D), its Radius, Speed, Auto Repath, Repath Interval, Repath
   * Distance, and Stopping Distance settings are used as the defaults
   * for every argument/opts field below — Radius in particular is what
   * makes the path actually respect THIS agent's size against the
   * scene's shared NavWorld2D (see components/NavAgent2D.js and the
   * architecture doc atop systems/NavWorldSystem.js). An explicit
   * `speed` argument or `opts` field always overrides the component's
   * value for that one call. An entity with no NavAgent2D still works
   * exactly as before, using radius 0 (the base unpadded layer) and the
   * literal defaults listed below.
   *
   * DELIBERATELY HAS NO "no path found" straight-line fallback — that
   * fallback is exactly what let an agent visibly walk straight through
   * a blocked NavWorld2D cell (a direct line ignores the world
   * entirely). If no route exists yet (NavWorld2D not baked, or the
   * goal truly unreachable), this holds position and returns false
   * rather than cutting through geometry, so "respects the not-walkable
   * zone" is true by construction, not just by convention.
   *
   * @param {number} targetX @param {number} targetY world-space goal
   * @param {number} [speed] px/sec — defaults to this entity's
   *   NavAgent2D.speed if present, otherwise 120.
   * @param {{ repathInterval?: number, arriveDist?: number, finalArriveDist?: number, targetChangeDistance?: number, debug?: boolean }} [opts]
   *   repathInterval: seconds between path re-checks (default:
   *     NavAgent2D.repathInterval if present, else 0.35). A shorter
   *     interval reacts faster to moving targets; a longer one is
   *     cheaper for a stable target. Ignored (no automatic re-path)
   *     when NavAgent2D.autoRepath is explicitly false.
   *   arriveDist: px distance from an intermediate waypoint that counts
   *     as reached (default 4). The final target uses finalArriveDist.
   *   finalArriveDist: px distance from the actual target that counts as
   *     arrived (default: NavAgent2D.stoppingDistance if present, else 1).
   *   targetChangeDistance: re-path immediately when a moving target
   *     shifts this far (default: NavAgent2D.repathDistance if present,
   *     else max(4, arriveDist)).
   *   debug: draws the current path as green segments, same visual
   *     language as nav.findPath(...,{debug:true}).
   * The options are defined by NAV_API_OPTION_FIELDS.navMoveToward, which
   * is also consumed by editor IntelliSense for `{ ... }` completion.
   * @returns {boolean} true if it moved this call, false if no path to
   *   the target exists right now (already-arrived also returns true).
   */
  navMoveToward(targetX, targetY, speed, opts) {
    opts = opts || {};
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return false;
    var navAgent = this._entity.getComponent(NAV_AGENT_2D);
    var dt = Math.max(0, this._scriptApi.time.deltaTime || 0);

    if (!this._navMoveState) {
      this._navMoveState = {
        path: null,
        index: 0,
        repathTimer: 0,
        goalX: 0,
        goalY: 0,
        plannedX: 0,
        plannedY: 0,
        rawTargetX: 0,
        rawTargetY: 0,
        targetVX: 0,
        targetVY: 0,
        hasRawTarget: false,
        currentSpeed: 0,
        routeDirX: 0,
        routeDirY: 0,
      };
    }
    var state = this._navMoveState;

    // Track the target instead of treating every navMoveToward() call as a
    // completely new static point. A moving target gets a small, bounded
    // look-ahead prediction based on its recent velocity. This is the same
    // general idea used by game AI steering: pathfind toward where the
    // target is likely to be, then continuously re-plan as that prediction
    // changes. The cap keeps fast targets from making agents visibly
    // over-lead corners or teleporting their goal far ahead.
    if (state.hasRawTarget && dt > 0.000001) {
      var rawVX = (targetX - state.rawTargetX) / dt;
      var rawVY = (targetY - state.rawTargetY) / dt;
      var rawSpeed = Math.hypot(rawVX, rawVY);
      if (Number.isFinite(rawSpeed)) {
        var maxTrackedSpeed = Math.max(120, (navAgent ? navAgent.speed : 120) * 2.5);
        if (rawSpeed > maxTrackedSpeed) {
          var scale = maxTrackedSpeed / rawSpeed;
          rawVX *= scale;
          rawVY *= scale;
        }
        // Exponential smoothing prevents jitter when the target itself is
        // driven by input/camera samples that move by only a few pixels.
        var velocityBlend = 1 - Math.exp(-12 * dt);
        state.targetVX += (rawVX - state.targetVX) * velocityBlend;
        state.targetVY += (rawVY - state.targetVY) * velocityBlend;
      }
    } else {
      state.targetVX = 0;
      state.targetVY = 0;
    }
    state.rawTargetX = targetX;
    state.rawTargetY = targetY;
    state.hasRawTarget = true;

    var baseSpeedForPrediction = Number.isFinite(speed) ? Math.max(0, speed) : (navAgent ? navAgent.speed : 120);
    var targetDistanceNow = Math.hypot(targetX - this.x, targetY - this.y);
    var predictionTime = baseSpeedForPrediction > 0
      ? Math.min(0.35, Math.max(0, targetDistanceNow / baseSpeedForPrediction))
      : 0;
    var predictedTargetX = targetX + state.targetVX * predictionTime;
    var predictedTargetY = targetY + state.targetVY * predictionTime;

    // Collaboration: when several collabEnabled agents are all heading
    // toward roughly the same point, redirect EACH agent to its own
    // slot on a ring around that point instead of all of them pathing
    // straight to the identical (targetX,targetY) — see
    // _applyNavCollab()'s doc comment for the full "smart NPC surround"
    // rationale. Done here, BEFORE any path is planned, deliberately —
    // unlike avoidance (which only bends the per-frame move direction),
    // this changes the actual PATHING GOAL, so A* routes each agent
    // around obstacles toward ITS OWN side of the target rather than
    // toward the same point and then fighting over the last few pixels.
    if (navAgent && navAgent.collabEnabled) {
      // Give the collaboration layer the predicted target, not just the
      // target's last sampled position. That lets a group keep formation
      // while the player is running instead of repeatedly converging on
      // where the player WAS.
      var slot = this._applyNavCollab(navAgent, predictedTargetX, predictedTargetY);
      targetX = slot.x;
      targetY = slot.y;
    } else {
      targetX = predictedTargetX;
      targetY = predictedTargetY;
    }

    speed = baseSpeedForPrediction;
    var autoRepath = navAgent ? navAgent.autoRepath : true;
    var repathInterval = opts.repathInterval !== undefined
      ? Math.max(0.05, opts.repathInterval)
      : Math.max(0.05, navAgent ? navAgent.repathInterval : 0.35);
    var arriveDist = opts.arriveDist === undefined ? 4 : Math.max(0.01, opts.arriveDist);
    var finalArriveDist = opts.finalArriveDist !== undefined
      ? Math.max(0.01, opts.finalArriveDist)
      : Math.max(0.01, navAgent ? navAgent.stoppingDistance : 1);
    var targetChangeDistance = opts.targetChangeDistance !== undefined
      ? Math.max(0.01, opts.targetChangeDistance)
      : Math.max(navAgent ? navAgent.repathDistance : 4, arriveDist);
    var agentRadius = navAgent ? navAgent.radius : 0;
    var agentArea = navAgent ? navAgent.area : 0xffff;
    var body = this.rigidbody;
    var canUseBody = body && body.type !== "Static";

    state.repathTimer -= dt;
    var targetMoved = !state.path || Math.hypot(targetX - state.plannedX, targetY - state.plannedY) > targetChangeDistance;

    // With autoRepath off, only (re)plan once (no path yet) or when the
    // target itself moved far enough to invalidate the current route —
    // never on the timer. A script can still force a fresh plan any
    // time by clearing state.path indirectly (calling with a new
    // target far enough away counts) or via nav.findPath() directly.
    var shouldRepath = !state.path || targetMoved || (autoRepath && state.repathTimer <= 0);

    if (shouldRepath) {
      state.repathTimer = repathInterval;
      var freshPath = this._scriptApi._findNavPath(this.x, this.y, targetX, targetY, { debug: opts.debug, radius: agentRadius, area: agentArea, areaCosts: navAgent ? navAgent.areaCosts : null });
      if (!freshPath || freshPath.length === 0) {
        // Before just holding position (the old behavior, still correct
        // for a genuinely unreachable GOAL), check whether the problem
        // is actually that WE are standing somewhere our own
        // radius/area disallows — e.g. pushed into a zone, or spawned
        // there. If so, treat the nearest legal ground as a one-point
        // "path" and let the normal waypoint-following code below drive
        // us there with its own accel/decel/avoidance, instead of
        // freezing forever inside the disallowed zone — see
        // _escapeDisallowedArea()'s doc comment for the full reasoning.
        // The very next repath cycle after escaping succeeds normally
        // on its own; no other state needs special-casing.
        var escape = this._escapeDisallowedArea(navAgent, agentRadius, agentArea);
        if (escape) {
          state.path = [escape];
          state.index = 0;
          state.goalX = targetX;
          state.goalY = targetY;
          // Force a real repath attempt again next call instead of
          // waiting out the full interval — as soon as we're back on
          // legal ground the normal path to the real goal should take
          // over immediately, not one interval later.
          state.repathTimer = 0;
          state.plannedX = Infinity;
          state.plannedY = Infinity;
        } else {
          state.path = null;
          state.index = 0;
          if (canUseBody) body.velocity = { x: 0, y: 0 };
          return false;
        }
      } else {
        state.path = freshPath;
        state.index = 0;
        state.goalX = targetX;
        state.goalY = targetY;
        state.plannedX = targetX;
        state.plannedY = targetY;
      }
    }

    var path = state.path;
    var lastIndex = path.length - 1;
    var waypoint = path[state.index];
    var distance = Math.hypot(waypoint.x - this.x, waypoint.y - this.y);

    // Consume already-reached points in one call. Rigidbody movement can
    // land a little past a point between script updates; without this the
    // next frame briefly steers backwards and produces corner jitter.
    var waypointThreshold = canUseBody ? Math.max(arriveDist, speed * dt + 0.25) : 0.001;
    while (state.index < lastIndex && distance <= waypointThreshold) {
      state.index++;
      waypoint = path[state.index];
      distance = Math.hypot(waypoint.x - this.x, waypoint.y - this.y);
    }

    if (state.index === lastIndex && distance <= finalArriveDist) {
      if (!canUseBody) {
        // Direct-transform agents can finish exactly; this fixes the old
        // "same NavWorld2D cell means already there" inaccuracy.
        this.x = waypoint.x;
        this.y = waypoint.y;
      } else {
        body.velocity = { x: 0, y: 0 };
      }
      return true;
    }

    if (canUseBody) {
      if (distance <= 0.000001) {
        body.velocity = { x: 0, y: 0 };
        state.currentSpeed = Math.max(0, state.currentSpeed - (navAgent ? navAgent.deceleration : 1000) * dt);
        return false;
      }
      // Follow the weighted route as a continuous corridor instead of
      // aiming at every raw A* point independently. The look-ahead is
      // deliberately capped at the NEXT turn, so smoothing can never
      // invent a shortcut across a different Nav Area (for example from
      // a cheap Road into expensive Ground). On straight portions this
      // produces a stable tangent direction; at turns the existing
      // acceleration-limited velocity transition rounds the heading
      // naturally without leaving the selected route.
      var routeAim = this._navWalkPathPreview(
        path, state.index, this.x, this.y,
        Math.max(10, Math.min(48, speed * Math.max(dt, 1 / 60) * 3.5))
      );
      var aimDistance = Math.hypot(routeAim.x - this.x, routeAim.y - this.y);
      if (aimDistance < 0.000001) {
        routeAim.x = waypoint.x;
        routeAim.y = waypoint.y;
        aimDistance = distance;
      }
      var dirX = (routeAim.x - this.x) / Math.max(0.000001, aimDistance);
      var dirY = (routeAim.y - this.y) / Math.max(0.000001, aimDistance);

      // Low-cost areas are a preferred corridor, not a reason to oscillate
      // between neighboring cells. Smooth the route direction itself, but
      // keep the blend responsive enough to follow a real corner.
      var routeBlend = 1 - Math.exp(-Math.max(6, (navAgent ? navAgent.acceleration : 800) / 100) * dt);
      if (Number.isFinite(state.routeDirX) && Number.isFinite(state.routeDirY) && Math.hypot(state.routeDirX, state.routeDirY) > 0.001) {
        state.routeDirX += (dirX - state.routeDirX) * routeBlend;
        state.routeDirY += (dirY - state.routeDirY) * routeBlend;
        var routeLen = Math.hypot(state.routeDirX, state.routeDirY);
        if (routeLen > 0.000001) {
          dirX = state.routeDirX / routeLen;
          dirY = state.routeDirY / routeLen;
        }
      } else {
        state.routeDirX = dirX;
        state.routeDirY = dirY;
      }
      var steered = this._applyNavAvoidance(navAgent, agentRadius, dirX, dirY);

      // Slow down as the agent approaches the final destination, while
      // keeping full speed through ordinary intermediate corners. Then
      // approach the desired velocity using acceleration/deceleration
      // rather than snapping velocity every frame. This is what makes a
      // chasing group feel like moving characters instead of path points
      // teleporting between headings.
      var desiredSpeed = speed;
      if (state.index === lastIndex) {
        var brakingDistance = Math.max(8, speed * speed / Math.max(1, (navAgent ? navAgent.deceleration : 1000) * 2));
        if (distance < brakingDistance) {
          desiredSpeed *= Math.max(0, Math.min(1, distance / brakingDistance));
        }
      }

      var desiredVX = steered.x * desiredSpeed;
      var desiredVY = steered.y * desiredSpeed;
      var currentVX = Number.isFinite(body.velocity && body.velocity.x) ? body.velocity.x : 0;
      var currentVY = Number.isFinite(body.velocity && body.velocity.y) ? body.velocity.y : 0;
      var deltaVX = desiredVX - currentVX;
      var deltaVY = desiredVY - currentVY;
      var deltaLen = Math.hypot(deltaVX, deltaVY);
      var accelRate = desiredSpeed < Math.hypot(currentVX, currentVY)
        ? (navAgent ? navAgent.deceleration : 1000)
        : (navAgent ? navAgent.acceleration : 800);
      var maxDelta = Math.max(0, accelRate * dt);
      if (deltaLen > maxDelta && deltaLen > 0.000001) {
        var f = maxDelta / deltaLen;
        deltaVX *= f;
        deltaVY *= f;
      }
      body.velocity = { x: currentVX + deltaVX, y: currentVY + deltaVY };
      state.currentSpeed = Math.hypot(body.velocity.x, body.velocity.y);
      return true;
    }

    if (body && body.type === "Static") return false;
    if (speed <= 0 || dt <= 0) return false;

    // A direct-transform agent uses its entire frame budget without ever
    // stepping beyond a waypoint. This prevents high-speed agents from
    // oscillating on opposite sides of a turn, and lets them cross more
    // than one tiny path segment in a slow frame without pausing.
    var desiredDirectSpeed = speed;
    if (state.index === lastIndex && distance > 0) {
      var directBrakeDistance = Math.max(8, speed * speed / Math.max(1, (navAgent ? navAgent.deceleration : 1000) * 2));
      if (distance < directBrakeDistance) {
        desiredDirectSpeed *= Math.max(0, Math.min(1, distance / directBrakeDistance));
      }
    }
    var directAccel = desiredDirectSpeed < state.currentSpeed
      ? (navAgent ? navAgent.deceleration : 1000)
      : (navAgent ? navAgent.acceleration : 800);
    if (dt > 0) {
      var directDelta = desiredDirectSpeed - state.currentSpeed;
      var directMaxDelta = directAccel * dt;
      if (Math.abs(directDelta) <= directMaxDelta) state.currentSpeed = desiredDirectSpeed;
      else state.currentSpeed += Math.sign(directDelta) * directMaxDelta;
    } else {
      state.currentSpeed = desiredDirectSpeed;
    }
    var remaining = state.currentSpeed * dt;
    var moved = false;
    while (remaining > 0) {
      waypoint = path[state.index];
      var dx = waypoint.x - this.x;
      var dy = waypoint.y - this.y;
      distance = Math.hypot(dx, dy);
      var threshold = state.index === lastIndex ? finalArriveDist : 0.001;

      if (distance <= threshold) {
        if (state.index === lastIndex) {
          this.x = waypoint.x;
          this.y = waypoint.y;
          return true;
        }
        state.index++;
        continue;
      }

      var step = Math.min(remaining, distance);
      // Direct-transform agents used to point exactly at each raw A*
      // waypoint. That made a curved road look like a sequence of tiny
      // stop-turn-go corners. Use the same route-tangent solver as the
      // rigidbody branch so the heading bends continuously as we enter and
      // leave a corner, while the actual navigation polyline remains the
      // authoritative route. The blend is deliberately local to the next
      // corner so it cannot invent a long diagonal through another area.
      var smoothDir = this._navSmoothRouteDirection(
        path, state.index, this.x, this.y,
        Math.max(6, Math.min(28, speed * Math.max(dt, 1 / 60) * 2.5))
      );
      var stepDir = this._applyNavAvoidance(navAgent, agentRadius, smoothDir.x, smoothDir.y);
      this.x += stepDir.x * step;
      this.y += stepDir.y * step;
      remaining -= step;
      moved = true;

      if (step >= distance - 0.000001) {
        if (state.index === lastIndex) {
          this.x = waypoint.x;
          this.y = waypoint.y;
          return true;
        }
        state.index++;
      }
    }
    return moved;
  }

  /**
   * Car-controller counterpart to navMoveToward(): paths to
   * (targetX,targetY) over the shared NavWorld2D exactly like
   * navMoveToward() does (same repath timer, waypoint advancement,
   * target-velocity prediction, and NavAgent2D avoidance/collab
   * steering), but instead of moving the entity like a top-down point,
   * it drives it like an actual car — accelerating, braking, steering,
   * and drifting through turns via the SAME Car physics
   * ControllerSystem._applyCar already uses for simulateDrive()/
   * simulateDriveToward() (see CharacterController.js's Car-specific
   * tunables: maxSpeed, carAcceleration, brakeForce, turnSpeed,
   * driftFactor — every one of them still applies here).
   *
   * Requires BOTH a Car-type CharacterController AND a NavAgent2D on
   * this entity — the Movement Type supplies the actual driving/drift
   * feel, the Nav Agent supplies the path + obstacle avoidance. Without
   * either one this returns false and does nothing (see the two
   * component checks below) rather than silently falling back to a
   * different movement style.
   *
   *   this.navDriveToward(target.x, target.y, 220);
   *
   * Call it once per onUpdate() — like navMoveToward(), it re-plans on
   * its own schedule (NavAgent2D.autoRepath/repathInterval/
   * repathDistance) rather than needing a fresh path every call.
   *
   * WHY THIS EXISTS SEPARATELY FROM navMoveToward(): navMoveToward()
   * moves an entity directly toward each waypoint (fine for a top-down
   * character), but a car can't strafe sideways to a waypoint — it has
   * to actually steer there, and it needs to know its own front from
   * its back so it drives forward into a turn instead of continuing to
   * reverse away from where it's chasing something (see
   * _resolveDriveTowardInput()'s doc comment in ControllerSystem.js for
   * the forward-vs-reverse decision this shares with
   * simulateDriveToward()). This method is what makes a Car+NavAgent2D
   * NPC behave like a chase-car — pathing around obstacles like a nav
   * agent, but handling like a car while it does it.
   *
   * If navigation is temporarily unavailable (for example while the
   * navigation map is synchronizing), the method uses a short-lived direct
   * drive fallback and retries pathfinding on the next scheduled repath.
   *
   * @param {number} targetX @param {number} targetY world-space goal
   * @param {number} [speed] px/sec top speed for this call — defaults to
   *   this entity's NavAgent2D.speed if present, otherwise 120. Feeds the
   *   waypoint-arrival braking math the same way navMoveToward()'s speed
   *   argument does; the car's OWN maxSpeed/carAcceleration/brakeForce
   *   still govern how it actually reaches that speed.
   * @param {{ repathInterval?: number, arriveDist?: number, finalArriveDist?: number, targetChangeDistance?: number, debug?: boolean }} [opts]
   *   Same meaning as navMoveToward()'s opts — see that method's doc
   *   comment. Also defined in NAV_API_OPTION_FIELDS.navDriveToward for
   *   editor `{ ... }` completion.
   * @returns {boolean} true if actively driving (or already arrived),
   *   false if no path exists right now, or if this entity is missing
   *   its Car controller or NavAgent2D.
   */
  navDriveToward(targetX, targetY, speed, opts) {
    opts = opts || {};
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return false;

    var controllerComponent = this._entity.getComponent(CHARACTER_CONTROLLER);
    if (!controllerComponent || controllerComponent.controllerType !== ControllerType.CAR) {
      return false;
    }
    var navAgent = this._entity.getComponent(NAV_AGENT_2D);
    if (!navAgent) return false;

    var dt = Math.max(0, this._scriptApi.time.deltaTime || 0);

    if (!this._navDriveState) {
      this._navDriveState = {
        path: null,
        index: 0,
        repathTimer: 0,
        plannedX: 0,
        plannedY: 0,
        rawTargetX: 0,
        rawTargetY: 0,
        targetVX: 0,
        targetVY: 0,
        hasRawTarget: false,
        // Sticky "have we actually stopped at THIS target" latch — see
        // its use below, right after the waypoint-arrival check. Without
        // this, a car that settles just outside finalArriveDist (normal
        // physics drift/friction after simulateDrive(0,0) — zero throttle
        // doesn't mean zero velocity) falls back into the full driving
        // branch on the very next call and re-throttles, which is what
        // made "Stopping Distance" look like it was being ignored: the
        // car would creep/bump near the target instead of cleanly
        // stopping. Cleared only when the target itself moves far enough
        // to count as a new destination (see arrivedTargetX/Y below).
        arrived: false,
        arrivedTargetX: 0,
        arrivedTargetY: 0,
      };
    }
    var state = this._navDriveState;

    // Same bounded target-velocity prediction navMoveToward() uses —
    // pathfind toward where a moving target is likely to be instead of
    // where it was a frame ago, re-smoothed every call.
    if (state.hasRawTarget && dt > 0.000001) {
      var rawVX = (targetX - state.rawTargetX) / dt;
      var rawVY = (targetY - state.rawTargetY) / dt;
      var rawSpeed = Math.hypot(rawVX, rawVY);
      if (Number.isFinite(rawSpeed)) {
        var maxTrackedSpeed = Math.max(120, (navAgent.speed || 120) * 2.5);
        if (rawSpeed > maxTrackedSpeed) {
          var scale = maxTrackedSpeed / rawSpeed;
          rawVX *= scale;
          rawVY *= scale;
        }
        var velocityBlend = 1 - Math.exp(-12 * dt);
        state.targetVX += (rawVX - state.targetVX) * velocityBlend;
        state.targetVY += (rawVY - state.targetVY) * velocityBlend;
      }
    } else {
      state.targetVX = 0;
      state.targetVY = 0;
    }
    state.rawTargetX = targetX;
    state.rawTargetY = targetY;
    state.hasRawTarget = true;

    var baseSpeed = Number.isFinite(speed) ? Math.max(0, speed) : (navAgent.speed || 120);
    var targetDistanceNow = Math.hypot(targetX - this.x, targetY - this.y);
    var predictionTime = baseSpeed > 0
      ? Math.min(0.35, Math.max(0, targetDistanceNow / baseSpeed))
      : 0;
    var predictedTargetX = targetX + state.targetVX * predictionTime;
    var predictedTargetY = targetY + state.targetVY * predictionTime;

    // Collaboration (group-surround) reuses the exact same slotting the
    // walking navMoveToward() uses — a mixed group of Car and walking
    // NavAgent2D NPCs converging on the same point still spreads out
    // into shared ring slots instead of each movement style solving it
    // independently.
    if (navAgent.collabEnabled) {
      var slot = this._applyNavCollab(navAgent, predictedTargetX, predictedTargetY);
      targetX = slot.x;
      targetY = slot.y;
    } else {
      targetX = predictedTargetX;
      targetY = predictedTargetY;
    }

    var autoRepath = navAgent.autoRepath;
    var repathInterval = opts.repathInterval !== undefined
      ? Math.max(0.05, opts.repathInterval)
      : Math.max(0.05, navAgent.repathInterval);
    var arriveDist = opts.arriveDist === undefined ? 4 : Math.max(0.01, opts.arriveDist);
    var finalArriveDist = opts.finalArriveDist !== undefined
      ? Math.max(0.01, opts.finalArriveDist)
      : Math.max(0.01, navAgent.stoppingDistance);
    var targetChangeDistance = opts.targetChangeDistance !== undefined
      ? Math.max(0.01, opts.targetChangeDistance)
      : Math.max(navAgent.repathDistance, arriveDist);
    var agentRadius = navAgent.radius;
    var agentArea = navAgent.area;

    // Arrived latch: once this car has come to rest at a target, stay
    // stopped and skip driving entirely until the TARGET moves far enough
    // to count as a new destination — not merely until the car's own
    // position drifts a few pixels from friction. This is what makes
    // Stopping Distance actually hold: without it, settling just outside
    // finalArriveDist on one frame (normal physics drift after throttle
    // hits zero) would fall through to the full drive branch below and
    // re-throttle toward the target, over and over, instead of staying
    // stopped. Checked against this call's resolved targetX/targetY
    // (already collab-slotted above if collabEnabled), so a group-surround
    // car correctly wakes back up if its assigned ring slot shifts even
    // while the shared group target hasn't moved.
    var arrivedTargetMoved = !state.arrived ||
      Math.hypot(targetX - state.arrivedTargetX, targetY - state.arrivedTargetY) > Math.max(finalArriveDist, targetChangeDistance);
    if (state.arrived && !arrivedTargetMoved) {
      this.controller.simulateDrive(0, 0);
      return true;
    }
    if (arrivedTargetMoved) state.arrived = false;

    state.repathTimer -= dt;
    var targetMoved = !state.path || Math.hypot(targetX - state.plannedX, targetY - state.plannedY) > targetChangeDistance;
    var shouldRepath = !state.path || targetMoved || (autoRepath && state.repathTimer <= 0);

    if (shouldRepath) {
      state.repathTimer = repathInterval;
      var freshPath = this._scriptApi._findNavPath(this.x, this.y, targetX, targetY, { debug: opts.debug, radius: agentRadius, area: agentArea, areaCosts: navAgent ? navAgent.areaCosts : null });
      if (!freshPath || freshPath.length === 0) {
        // Same "am I illegally standing in a disallowed area" recovery
        // as navMoveToward() above — see _escapeDisallowedArea()'s doc
        // comment. A one-point escape "path" is handed to the normal
        // waypoint-following/simulateDriveToward() code below, so the
        // car actually DRIVES out (steering, accel/brake — not
        // teleporting), and the very next repath after arriving there
        // retries the real goal automatically.
        var escape = this._escapeDisallowedArea(navAgent, agentRadius, agentArea);
        if (escape) {
          state.path = [escape];
          state.index = 0;
          state.repathTimer = 0;
          state.plannedX = Infinity;
          state.plannedY = Infinity;
        } else {
          // A car must never become permanently dead just because the nav
          // query temporarily has no route (for example while a NavWorld is
          // rebuilding, the target is outside the baked area, or a moving
          // target prediction lands one frame outside the corridor).
          // Keep the NavCar alive by handing the real goal to the same
          // human-driver resolver used by direct chase cars. The next call
          // will retry the navigation query automatically.
          state.path = null;
          state.index = 0;
          state.repathTimer = 0;
          this.controller.simulateDriveToward(targetX, targetY);
          return true;
        }
      } else {
        // Vehicle paths get a second, conservative post-process. A* grid
        // paths can contain many tiny left/right cells even when the actual
        // road is one continuous bend. Cars should follow the route corridor,
        // not every grid vertex. Only shortcuts whose sampled points remain
        // walkable for THIS car are accepted, so this cannot cut through a
        // forbidden area or leave a narrow road.
        freshPath = this._navCarSimplifyPath(
          freshPath, agentRadius, agentArea, navAgent ? navAgent.areaCosts : null
        );
        state.path = freshPath;
        state.index = 0;
        state.plannedX = targetX;
        state.plannedY = targetY;
      }
    }

    var path = state.path;
    var lastIndex = path.length - 1;
    var waypoint = path[state.index];
    var distanceToWaypoint = Math.hypot(waypoint.x - this.x, waypoint.y - this.y);
    var vehicleState = state.vehicle || (state.vehicle = {
      steer: 0,
      desiredSpeed: 0,
      stuckTime: 0,
      recoveryTimer: 0,
      recoverySign: 1,
      recoveryPhase: 'back', // 'back' (reversing away, straight, no steer)
                              // or 'face' (stopped/creeping, pivoting to
                              // point at the target/opening before the
                              // normal drive loop is allowed to resume) —
                              // see the recovery state machine below.
      recoveryBackDist: 0,   // distance actually covered so far in the
                              // current 'back' phase, compared against
                              // recoveryBackTarget to decide when to
                              // switch to 'face'.
      recoveryBackTarget: 0, // how far this recovery plan wants to back up
                              // before facing/resuming — longer when the
                              // plan combines reverse+turn (see below).
      obstacleTime: 0,
      offPathTime: 0,
      routeHeadingX: 0,
      routeHeadingY: -1,
      lastX: this.x,
      lastY: this.y,
      lastProgressTimer: 0,
      lastPathIndex: state.index,
    });

    // Advance by ROUTE PROGRESS, not just a circular distance test. A car can
    // legitimately pass close to a corner while still approaching it from
    // the wrong side; blindly advancing then makes the next waypoint appear
    // behind the car and can trigger a needless reverse/steering flip. We
    // therefore require either (a) the car is close enough to the waypoint,
    // or (b) it has crossed the waypoint along the incoming route direction.
    // This makes waypoint consumption monotonic and is especially important
    // on zig-zag road nav layers.
    var waypointThreshold = Math.max(arriveDist, Math.min(18, baseSpeed * dt * 2.5 + 0.25));
    while (state.index < lastIndex) {
      waypoint = path[state.index];
      distanceToWaypoint = Math.hypot(waypoint.x - this.x, waypoint.y - this.y);
      var incoming = state.index > 0 ? path[state.index - 1] : null;
      var crossed = false;
      if (incoming) {
        var ix = waypoint.x - incoming.x;
        var iy = waypoint.y - incoming.y;
        var ilen = Math.hypot(ix, iy);
        if (ilen > 1e-5) {
          // Positive means the vehicle has moved beyond the waypoint in the
          // direction the route arrived from. A small tolerance prevents
          // jitter around the exact corner.
          var past = (this.x - waypoint.x) * ix + (this.y - waypoint.y) * iy;
          crossed = past > Math.max(4, ilen * 0.08);
        }
      }
      if (distanceToWaypoint > waypointThreshold && !crossed) break;
      state.index++;
    }
    waypoint = path[state.index];
    distanceToWaypoint = Math.hypot(waypoint.x - this.x, waypoint.y - this.y);

    // Arrival is measured against the ACTUAL destination (targetX/targetY),
    // not just "am I on the last waypoint AND close to it". Those two used
    // to be required together, but a late obstacle parked at/near the goal
    // (see _navCarScanObstacles below) steers the aim point laterally to
    // dodge it — which can keep distanceToWaypoint just outside
    // finalArriveDist indefinitely, or keep the waypoint-advance loop above
    // from ever promoting state.index to lastIndex, so the car circles the
    // obstacle at speed near its destination instead of ever being allowed
    // to stop. A car that is genuinely within finalArriveDist of the real
    // target should stop, full stop, regardless of which waypoint index the
    // avoidance detour currently has it on.
    var distanceToTarget = Math.hypot(targetX - this.x, targetY - this.y);
    if (distanceToTarget <= finalArriveDist) {
      this.controller.simulateDrive(0, 0);
      vehicleState.steer = 0;
      vehicleState.desiredSpeed = 0;
      vehicleState.stuckTime = 0;
      // Latch "arrived" for THIS target so the next call short-circuits at
      // the arrivedTargetMoved check earlier in this function instead of
      // re-entering the full drive/braking pipeline — that re-entry (after
      // ordinary physics drift carried the car a hair past finalArriveDist
      // again) was the actual source of the "stopping distance doesn't
      // work" creep/bump-in-place behavior.
      state.arrived = true;
      state.arrivedTargetX = targetX;
      state.arrivedTargetY = targetY;
      return true;
    }

    const rb = this._entity.getComponent(RIGIDBODY_2D);
    const rbVx = rb ? Number(rb.velocityX) || 0 : 0;
    const rbVy = rb ? Number(rb.velocityY) || 0 : 0;
    const actualSpeed = Math.hypot(rbVx, rbVy);
    const currentForwardRad = (this.rotation * Math.PI) / 180;
    const currentForwardX = Math.sin(currentForwardRad);
    const currentForwardY = -Math.cos(currentForwardRad);

    // More speed -> farther lookahead. Hard corners deliberately use a
    // shorter near sample so the car does not cut across the road.
    const carComponent = this._entity.getComponent(CHARACTER_CONTROLLER);
    const speed01 = Math.min(1, actualSpeed / Math.max(1, (Number(carComponent?.maxSpeed) || 350)));
    const lookahead = Math.max(
      Number(navAgent.vehicleLookahead) || 72,
      (Number(navAgent.vehicleLookahead) || 72) * (0.75 + 1.55 * speed01)
    );
    const preview = this._navCarPathPreview(
      path, state.index, this.x, this.y,
      lookahead,
      Number(navAgent.vehicleCornerLookahead) || 110
    );

    var aimX = preview.x, aimY = preview.y;
    var distToAim = Math.hypot(aimX - this.x, aimY - this.y);
    if (distToAim < 1e-4) { aimX = waypoint.x; aimY = waypoint.y; distToAim = distanceToWaypoint; }

    // Agent avoidance is applied to a route tangent, not to a raw waypoint.
    // On a curve the tangent is gradually rotated toward the next segment
    // before the corner, which lets the car steer through the bend instead
    // of making a square waypoint-to-waypoint turn. The actual aim point is
    // still sampled on the navigation polyline, so area restrictions remain
    // authoritative.
    var aimDirX = (aimX - this.x) / Math.max(1e-5, distToAim);
    var aimDirY = (aimY - this.y) / Math.max(1e-5, distToAim);
    if (Number.isFinite(preview.tangentX) && Number.isFinite(preview.tangentY) && (Math.abs(preview.tangentX) + Math.abs(preview.tangentY) > 0.001)) {
      const tangentBlend = preview.tangentBlend !== undefined ? Math.max(0, Math.min(1, preview.tangentBlend)) : 0;
      aimDirX = aimDirX * (1 - tangentBlend) + preview.tangentX * tangentBlend;
      aimDirY = aimDirY * (1 - tangentBlend) + preview.tangentY * tangentBlend;
      const tangentLen = Math.hypot(aimDirX, aimDirY);
      if (tangentLen > 1e-5) { aimDirX /= tangentLen; aimDirY /= tangentLen; }
    }
    // Until the vehicle reaches the dedicated turn-activation gate, keep the
    // steering vector locked to the CURRENT incoming road edge.  This is the
    // key anti-hunting rule: being near a future corner must not make the car
    // nibble toward that corner early and then correct back.  Once the gate is
    // reached, _navCarPathPreview() gradually introduces the next-edge tangent.
    if (Number.isFinite(preview.cornerDistance) && preview.cornerDistance < Infinity &&
        Number.isFinite(preview.cornerIncomingLength) && preview.cornerIncomingLength > 1e-5 &&
        preview.cornerIndex === state.index && preview.cornerTurnGate <= 0) {
      var prevPoint = state.index > 0 ? path[state.index - 1] : null;
      var currPoint = state.index < path.length ? path[state.index] : null;
      if (prevPoint && currPoint) {
        var routeDX = Number(currPoint.x) - Number(prevPoint.x);
        var routeDY = Number(currPoint.y) - Number(prevPoint.y);
        var routeLen = Math.hypot(routeDX, routeDY);
        if (routeLen > 1e-5) {
          aimDirX = routeDX / routeLen;
          aimDirY = routeDY / routeLen;
        }
      }
    }
    var steered = this._applyNavAvoidance(navAgent, agentRadius, aimDirX, aimDirY);


    // Local physics scan: dynamic/late obstacles can exist after the last
    // Nav bake. Pick the clearer side and request a faster repath if one
    // stays in the lane for several frames.
    var targetForScanX = aimX, targetForScanY = aimY;
    var obstacle = this._navCarScanObstacles(
      { x: this.x, y: this.y, rotation: this.rotation },
      navAgent, actualSpeed, targetForScanX, targetForScanY
    );
    if (obstacle.blocked) {
      vehicleState.obstacleTime += dt;
      if (vehicleState.obstacleTime > 0.18) state.repathTimer = 0;
    } else {
      vehicleState.obstacleTime = Math.max(0, vehicleState.obstacleTime - dt * 2);
    }

    // Predictive traffic: anticipates other NavCars/agents by their actual
    // velocity, ahead of when a raw raycast would hit them. See
    // _navCarTrafficScan()'s doc comment for the following-distance/
    // closing-speed/yield-by-priority behaviors this adds.
    var traffic = this._navCarTrafficScan(navAgent, agentRadius, actualSpeed, aimDirX, aimDirY);

    if (Math.abs(obstacle.steer) > 0.001) {
      // Lateral avoidance vector around the obstacle, blended with route
      // direction. The blend is capped so an obstacle cannot make the car
      // instantly reverse its steering direction.
      const sideX = -currentForwardY * obstacle.steer;
      const sideY = currentForwardX * obstacle.steer;
      steered.x = steered.x * 0.72 + sideX * 0.28;
      steered.y = steered.y * 0.72 + sideY * 0.28;
      const len = Math.hypot(steered.x, steered.y);
      if (len > 1e-5) { steered.x /= len; steered.y /= len; }
    }

    const desiredAngle = Math.atan2(steered.x, -steered.y);
    let angleError = desiredAngle - currentForwardRad;
    while (angleError > Math.PI) angleError -= Math.PI * 2;
    while (angleError < -Math.PI) angleError += Math.PI * 2;

    // Pure-pursuit-inspired steering: angle demand grows with lookahead
    // geometry, then is rate-smoothed through the car's normal steer axis.
    const wheelBaseLike = Math.max(20, Math.min(140, lookahead * 0.55));
    const curvature = (2 * Math.sin(angleError)) / Math.max(1, wheelBaseLike);
    let desiredSteer = Math.max(-1, Math.min(1, curvature * 85));
    desiredSteer += Math.max(-0.30, Math.min(0.30, obstacle.steer * 0.48));

    // Cars should not chase every tiny navigation-cell direction change.
    // Keep a small steering deadband on straight sections and add a little
    // directional hysteresis so the wheel does not hunt left/right around 0.
    desiredSteer += Math.max(-0.10, Math.min(0.10, Math.sin(angleError) * 0.10));
    if (Math.abs(desiredSteer) < 0.075) desiredSteer = 0;
    const previousSteer = Number(vehicleState.steer) || 0;
    if (previousSteer > 0.16 && desiredSteer < 0.04 && desiredSteer > -0.10) desiredSteer = 0.02;
    if (previousSteer < -0.16 && desiredSteer > -0.04 && desiredSteer < 0.10) desiredSteer = -0.02;
    desiredSteer = Math.max(-1, Math.min(1, desiredSteer));
    vehicleState.steer = this._navCarSmoothSignal(
      Number(vehicleState.steer) || 0,
      desiredSteer,
      dt,
      Number(navAgent.vehicleSteerSmoothing) || 7
    );

    const maxSpeed = Math.max(1, Number(carComponent?.maxSpeed) || Number(navAgent.speed) || 350);
    const requestedSpeed = Math.max(1, Number.isFinite(speed) ? Math.abs(speed) : (Number(navAgent.speed) || maxSpeed));
    const turnSeverity = Math.min(1, Math.abs(angleError) / (Math.PI * 0.55));
    const cornerSeverity = Math.max(0, Math.min(1, preview.cornerSeverity * 1.7));
    const cornerFactor = 1 - cornerSeverity * (1 - (Number(navAgent.vehicleCornerSlowdown) || 0.72));
    const headingFactor = 0.25 + 0.75 * Math.max(0, Math.cos(angleError));
    const obstacleFactor = 1 - Math.max(0, Math.min(0.92, obstacle.brake * (Number(navAgent.vehicleObstacleBrake) || 0.9)));
    // Narrow corridors need a lower speed even before the center ray says
    // “blocked”. This gives the driver room to make small corrections rather
    // than entering a tight gap at full speed.
    const usableClearance = Math.min(obstacle.leftClear, obstacle.rightClear);
    const narrowLimit = Math.max(agentRadius * 2.2, (Number(navAgent.vehicleObstacleWidth) || 28) * 1.8);
    const narrowFactor = usableClearance < narrowLimit
      ? Math.max(0.30, usableClearance / Math.max(1, narrowLimit))
      : 1;

    // Use a physically meaningful stopping-distance estimate. The car starts
    // braking before a final point or hard corner instead of discovering the
    // need for braking after it has already passed the turn.
    const brakeAccel = Math.max(40, Number(carComponent?.brakeForce) || Number(navAgent.deceleration) || 1000);
    const stoppingDistance = (actualSpeed * actualSpeed) / (2 * brakeAccel);
    // Gate on real distance to the destination (distanceToTarget), not on
    // state.index === lastIndex. An obstacle parked near the goal can keep
    // the avoidance detour on an earlier waypoint index right up until the
    // car is already on top of the target — gating braking on the index
    // meant the car approached that final stretch at full/near-full speed
    // instead of decelerating in, which is what let it overshoot into a
    // circling pattern around the destination instead of settling.
    const arrivalFactor = distanceToTarget <= Math.max(finalArriveDist, stoppingDistance * 1.4 + finalArriveDist) * 1.5
      ? Math.max(0.05, Math.min(1, (distanceToTarget - finalArriveDist) / Math.max(1, stoppingDistance * 1.4 + finalArriveDist)))
      : 1;

    // Long-range braking lookahead: scans well beyond the short steering
    // window to catch every corner a real driver would already be
    // planning for, including a run of several close corners (zigzag/
    // S-curve road) treated as one continuous braking problem rather than
    // each bend only being discovered once it's the nearest waypoint.
    //
    // The scan distance is sized from this car's MAX speed and braking
    // power, not its current speed. Sizing it from current speed was the
    // original bug here: right after a stop or a previous corner the car
    // is still accelerating, so its current-speed stopping distance is
    // small — meaning the scan window stayed short exactly while the car
    // was speeding up down a straight, so it only "saw" an upcoming curve
    // once already close to cruising speed, by which point the curve
    // could already be near. Sizing from maxSpeed instead means the car
    // always looks as far ahead as it could EVER need to brake from,
    // whether it happens to be at that speed yet or not — a driver plans
    // for the speed they're headed toward on a straight, not just the
    // speed they're at right this instant.
    const maxStoppingDistance = (maxSpeed * maxSpeed) / (2 * brakeAccel);
    const brakeScanRange = Math.max(
      Number(navAgent.vehicleCornerLookahead) || 110,
      maxStoppingDistance * 1.6 + agentRadius * 4
    );
    const brakingLookahead = this._navCarBrakingLookahead(
      path, state.index, this.x, this.y, brakeScanRange, brakeAccel, maxSpeed
    );
    // How much of the requested speed this car is allowed given everything
    // ahead within brakeScanRange — 1 when nothing ahead needs braking for
    // (clear/straight road, free to approach maxSpeed), shrinking toward 0
    // for a hairpin bend that's coming up soon.
    const cornerBraking = maxSpeed > 0 ? Math.max(0.15, brakingLookahead.targetSpeed / maxSpeed) : 1;

    // Predictive traffic factor: anticipated closing speed toward another
    // moving NavCar/agent brakes proportionally, same as obstacleFactor
    // does for raycast hits — but this fires BEFORE a ray would ever touch
    // the other car, since it is driven by trajectories, not proximity
    // alone. A forced yield (lower-priority car crossing a higher-priority
    // one's path) clamps harder than a plain brake amount would, so an
    // intersection conflict reads as a deliberate stop/hold rather than
    // just "traffic slowed me down a bit".
    const trafficFactor = traffic.yield
      ? Math.max(0.08, 1 - Math.max(0.75, traffic.brake))
      : 1 - Math.max(0, Math.min(0.92, traffic.brake));

    let targetSpeed = requestedSpeed;
    targetSpeed = Math.min(targetSpeed, maxSpeed * (0.18 + 0.82 * headingFactor));
    targetSpeed = Math.min(targetSpeed, maxSpeed * cornerFactor);
    targetSpeed = Math.min(targetSpeed, maxSpeed * cornerBraking);
    targetSpeed *= obstacleFactor;
    targetSpeed *= narrowFactor;
    targetSpeed *= trafficFactor;
    // Following a lead car: never target faster than the lead car's own
    // speed (a small undercut keeps a natural gap instead of the two cars
    // drifting into exact lockstep and occasionally kissing bumpers).
    if (traffic.followSpeed !== null) {
      targetSpeed = Math.min(targetSpeed, Math.max(0, traffic.followSpeed * 0.94));
    }
    targetSpeed *= Math.max(0.08, arrivalFactor);

    // Very sharp orientation errors should roll/brake instead of trying to
    // spin the car in place. The existing controller already refuses to
    // rotate at exactly zero speed, so this produces a natural slow pivot.
    if (turnSeverity > 0.82 && actualSpeed > maxSpeed * 0.18) targetSpeed = Math.min(targetSpeed, maxSpeed * 0.28);

    vehicleState.desiredSpeed = this._navCarSmoothSignal(
      Number(vehicleState.desiredSpeed) || 0,
      targetSpeed,
      dt,
      Number(navAgent.vehicleSpeedSmoothing) || 5
    );

    const speedError = vehicleState.desiredSpeed - actualSpeed;
    let throttle = 0;
    if (speedError > 8) {
      throttle = Math.min(1, speedError / Math.max(35, Number(carComponent?.carAcceleration) || 200));
    } else if (speedError < -10) {
      throttle = -Math.min(1, Math.max(0.18, -speedError / Math.max(35, Number(carComponent?.brakeForce) || 360)));
    }

    // Stuck detection uses actual transform progress as well as measured
    // speed. This catches a car pushing its way into an obstacle where its
    // commanded velocity is high but the body is barely progressing.
    const movedThisFrame = Math.hypot(this.x - vehicleState.lastX, this.y - vehicleState.lastY);
    vehicleState.lastProgressTimer += dt;
    const lowProgress = movedThisFrame < Math.max(0.35, actualSpeed * dt * 0.10);
    if (distanceToWaypoint > Math.max(45, agentRadius * 2) && throttle > 0.35 && lowProgress && Math.abs(angleError) < Math.PI * 0.7) {
      vehicleState.stuckTime += dt;
    } else {
      vehicleState.stuckTime = Math.max(0, vehicleState.stuckTime - dt * 1.5);
    }

    // Off-path drift: distinct from "pushing into an obstacle" — this is a
    // car that IS still moving but has been pushed/steered sideways off its
    // intended line (sideswiped, drifted through a corner, shoved by
    // another car) and is not converging back toward the route. Caught
    // separately from stuckTime because the car can be doing this at speed,
    // where the low-progress test above never fires.
    const laneDX = aimX - this.x, laneDY = aimY - this.y;
    const laneDist = Math.hypot(laneDX, laneDY);
    const laneDeviation = laneDist > 1e-4
      ? Math.abs(currentForwardX * (laneDY / laneDist) - currentForwardY * (laneDX / laneDist))
      : 0;
    const driftingOffPath = laneDist > Math.max(agentRadius * 2.5, lookahead * 0.9) && laneDeviation > 0.55;
    vehicleState.offPathTime = driftingOffPath ? vehicleState.offPathTime + dt : Math.max(0, vehicleState.offPathTime - dt * 1.5);

    // Predictive pre-impact reverse: obstacle.blocked already means "about
    // to hit something at this speed" (see _navCarScanObstacles — blocked
    // is true when the center ray hit is closer than a speed-scaled safety
    // distance). Treat sustained blocked+closing exactly like being stuck,
    // so the car starts braking/backing away BEFORE contact instead of only
    // reacting once it has already stalled against the obstacle.
    const aboutToHit = obstacle.blocked && actualSpeed > maxSpeed * 0.12;
    if (aboutToHit) vehicleState.stuckTime += dt * 1.6;

    vehicleState.lastX = this.x;
    vehicleState.lastY = this.y;

    if (vehicleState.recoveryTimer > 0) {
      vehicleState.recoveryTimer -= dt;
      const phase = vehicleState.recoveryPhase || 'back';

      if (phase === 'back') {
        // Reverse STRAIGHT away first — no lateral steering at all. This is
        // the fix for "never follow the obstacle while reversing": any
        // steer input while moving backward swings the car's real-world
        // heading the OPPOSITE way from a forward turn, so steering toward
        // the "open side" while still in reverse actually swings the car's
        // tail toward/along the obstacle it's trying to get away from.
        // Reversing straight is always safe-by-construction here because
        // rearClear was already checked before this phase was ever entered.
        this.controller.simulateDrive(-0.75, 0);
        vehicleState.recoveryBackDist = (vehicleState.recoveryBackDist || 0)
          + Math.hypot(this.x - vehicleState.lastX, this.y - vehicleState.lastY);

        const backedFarEnough = vehicleState.recoveryBackDist >= vehicleState.recoveryBackTarget;
        if (backedFarEnough || vehicleState.recoveryTimer <= 0) {
          vehicleState.recoveryPhase = 'face';
          vehicleState.recoveryBackDist = 0;
        }
      } else if (phase === 'face') {
        // Now stationary-ish and clear of the obstacle: rotate in place
        // (near-zero throttle, full steer) to actually FACE the target/
        // opening before driving toward it — this is the "reverse to face
        // the obj or turn to face it, THEN follow" ordering: the car does
        // not resume chasing the target until its nose is genuinely
        // pointed at it, so it never drives forward while still angled
        // into the thing it just backed away from.
        const faceRad = (this.rotation * Math.PI) / 180;
        const faceForwardX = Math.sin(faceRad), faceForwardY = -Math.cos(faceRad);
        const faceDX = targetX - this.x, faceDY = targetY - this.y;
        const faceDist = Math.hypot(faceDX, faceDY);
        const faceErr = faceDist > 1e-4
          ? Math.atan2(
              faceForwardX * (faceDY / faceDist) - faceForwardY * (faceDX / faceDist),
              faceForwardX * (faceDX / faceDist) + faceForwardY * (faceDY / faceDist)
            )
          : 0;
        const faced = Math.abs(faceErr) < 12 * Math.PI / 180;
        // A little creep throttle so the controller's turn model (which
        // refuses to rotate at exactly zero speed) can actually pivot —
        // capped low so this never turns into "drive forward while still
        // facing the wrong way".
        this.controller.simulateDrive(0.22, Math.sign(faceErr) * 0.85 || vehicleState.recoverySign * 0.85);
        if (faced || vehicleState.recoveryTimer <= 0) {
          vehicleState.recoveryPhase = 'back';
          vehicleState.recoveryBackDist = 0;
          vehicleState.recoveryTimer = 0;
        }
      }

      if (vehicleState.recoveryTimer <= 0) {
        vehicleState.stuckTime = 0;
        vehicleState.offPathTime = 0;
        vehicleState.recoveryPhase = 'back';
        vehicleState.recoveryBackDist = 0;
        // Force an immediate repath rather than just resetting the timer —
        // a recovery maneuver can easily land the car in a position where
        // the OLD path's next waypoint is now an awkward angle behind or
        // beside it. Re-planning from wherever the recovery actually left
        // the car is what lets it cleanly resume toward the goal instead of
        // lurching back onto a stale route.
        state.repathTimer = 0;
      }
      vehicleState.lastX = this.x;
      vehicleState.lastY = this.y;
      return true;
    }

    const stuckThreshold = Number(navAgent.vehicleRecoveryTime) || 1.35;
    const offPathThreshold = stuckThreshold * 1.15;
    const shouldRecover = vehicleState.stuckTime >= stuckThreshold || vehicleState.offPathTime >= offPathThreshold;

    if (shouldRecover) {
      // Decide the recovery PLAN the way a careful driver would: not
      // "always back up when stuck" and not one single fixed maneuver —
      // reverse-only, turn-only, and reverse-then-turn are all considered,
      // and the plan can freely combine them in sequence (the 'back' ->
      // 'face' phase machine above always runs both phases; what changes
      // per-plan is HOW FAR it backs and whether a forward turn is even
      // allowed to be part of the answer at all).
      const turnRate = Math.max(0.85, Number(carComponent?.turnSpeed) || 150) * Math.PI / 180;
      const forwardTurnTime = Math.abs(angleError) / Math.max(0.05, turnRate);
      const reverseTurnTime = 0.5 + Math.max(0, Math.abs(angleError) - Math.PI * 0.45) / Math.max(1.1, turnRate * 1.3);

      // Clearance on the side a forward turn would swing the car's tail/
      // flank through. leftClear/rightClear come from the SAME three-ray
      // scan already run this frame, so this costs nothing extra.
      const turnSide = Math.sign(Math.sin(angleError)) || (obstacle.steer !== 0 ? Math.sign(obstacle.steer) : 1);
      const turnSideClearance = turnSide > 0 ? obstacle.rightClear : obstacle.leftClear;
      const turnClearanceNeeded = agentRadius * 2.4;
      const turnRiskPenalty = turnSideClearance < turnClearanceNeeded
        ? (1 - Math.max(0, turnSideClearance) / turnClearanceNeeded)
        : 0;

      // Would turning here actually walk the car OFF the baked nav layer?
      // A pivot swings the car's body through an arc, not just its center
      // point — sample a point offset to the turn side, roughly where the
      // car's flank travels through mid-turn, and ask the nav layer
      // directly whether that point is walkable for THIS agent's own
      // radius+area+areaCosts. Obstacle-scan clearance only sees physical
      // colliders; it has no idea a "clear" patch of ground is actually
      // off-road / water / a disallowed area on the nav layer, which is a
      // separate reason turning-around-here can be the wrong call even
      // with open space to swing into.
      const turnArcProbeX = this.x + (-currentForwardY * turnSide) * (agentRadius * 1.8) + currentForwardX * (agentRadius * 0.6);
      const turnArcProbeY = this.y + (currentForwardX * turnSide) * (agentRadius * 1.8) + currentForwardY * (agentRadius * 0.6);
      const turnStaysOnNav = !this._scriptApi._navIsWalkableForAgentFn || this._scriptApi._navIsWalkableForAgentFn(
        turnArcProbeX, turnArcProbeY, agentRadius, agentArea, navAgent ? navAgent.areaCosts : null
      );

      // Reverse has its own risk: backing into something behind the car.
      // The rear-lateral rays aren't scanned, so this is a shorter,
      // deliberately conservative direct raycast behind the car — reverse
      // only gets credited as "safe" if that's actually clear.
      const rearProbeDist = Math.max(40, agentRadius * 2.5);
      const rearHit = (this._scriptApi && typeof this._scriptApi._raycast === 'function')
        ? this._scriptApi._raycast(
            this.x, this.y,
            this.x - currentForwardX * rearProbeDist, this.y - currentForwardY * rearProbeDist,
            { exclude: [this._entity] }
          )
        : null;
      const rearClear = rearHit && Number.isFinite(rearHit.distance) ? rearHit.distance : rearProbeDist;
      const reverseBlocked = rearClear < agentRadius * 1.6;

      // A turn is only actually AVAILABLE as part of the plan if it both
      // has physical clearance (not heavily obstacle-penalized) AND stays
      // on the nav layer. If turning here would put the car off-mesh, it
      // is excluded from consideration entirely rather than merely
      // costed higher — an off-nav-layer position is a strictly worse
      // outcome than taking longer to reverse, since the car would need
      // ANOTHER recovery just to get back onto walkable ground.
      const turnAvailable = turnStaysOnNav && turnRiskPenalty < 0.85;

      const forwardCost = turnAvailable
        ? forwardTurnTime * (1 + turnRiskPenalty * 2.2)
        : Infinity;
      const reverseCost = reverseTurnTime * (reverseBlocked ? 3.0 : 1) + (reverseBlocked ? 0.6 : 0);

      // How far to back up before switching to the facing phase. A plain
      // "turn is available and cheap" case only needs enough distance to
      // clear the obstacle's own footprint. When the turn is unavailable
      // (off-nav-layer or too tight) or reverse is clearly the cheaper
      // option, back up FARTHER — this is the "combine reverse + turn"
      // case: a longer reverse buys enough room that the subsequent facing
      // pivot has a wide-open arc to turn in, rather than a short reverse
      // followed by a turn that immediately re-triggers the same problem.
      const shortBack = Math.max(agentRadius * 2.2, 30);
      const longBack = Math.max(agentRadius * 4.5, 70);
      vehicleState.recoveryBackTarget = (!turnAvailable || reverseCost <= forwardCost)
        ? longBack
        : shortBack;

      // Pick the recovery steering side (used only by the 'face' phase,
      // never while actually reversing) toward whichever flank actually
      // has room AND stays on the nav layer — obstacle-scan clearance
      // first, falling back to the angle-to-target sign if the scan saw no
      // meaningful difference between sides.
      const clearanceBias = obstacle.rightClear - obstacle.leftClear;
      vehicleState.recoverySign = turnStaysOnNav
        ? (Math.abs(clearanceBias) > 4 ? Math.sign(clearanceBias) : (obstacle.steer !== 0 ? Math.sign(obstacle.steer) : (Math.sign(Math.sin(angleError)) || 1)))
        : -(Math.abs(clearanceBias) > 4 ? Math.sign(clearanceBias) : 1); // avoid the off-nav side entirely

      vehicleState.recoveryTimer = (Number(navAgent.vehicleRecoveryReverseTime) || 0.9)
        * (!turnAvailable || reverseCost <= forwardCost ? 1.6 : 1); // combined plan runs longer
      vehicleState.recoveryPhase = reverseBlocked ? 'face' : 'back';
      vehicleState.recoveryBackDist = 0;
      vehicleState.lastX = this.x;
      vehicleState.lastY = this.y;
      return true;
    }

    // The ControllerSystem's driveToward resolver supplies the gear logic
    // (including committed reverse) while this local planner supplies the
    // smooth, forward-looking point and obstacle response.
    const driveAimDistance = Math.max(lookahead * 0.9, 36);
    this.controller.simulateDriveToward(
      this.x + steered.x * driveAimDistance,
      this.y + steered.y * driveAimDistance
    );

    // The controller's driveToward resolver remains responsible for forward
    // vs reverse gear choice. Add the locally planned brake and only a small
    // steering correction; never add extra positive throttle here because
    // that would fight the resolver's speed governor.
    this.controller.simulateDrive(Math.min(0, throttle), vehicleState.steer * 0.55);

    // Guaranteed launch: a fresh NavCar at rest should leave a valid route
    // immediately. Near-zero-speed alignment must not become a deadlock where
    // the steering planner waits for speed before permitting the car to move.
    if (actualSpeed < 1.0 && distanceToWaypoint > finalArriveDist * 1.25) {
      const frontDot = currentForwardX * aimDirX + currentForwardY * aimDirY;
      if (frontDot > -0.35) {
        this.controller.simulateDrive(0.28, vehicleState.steer * 0.35);
      }
    }
    return true;
  }

  /**
   * Recovery strategy for an agent that finds itself standing somewhere
   * ITS OWN radius+area disallows — e.g. spawned inside a zone its
   * areaMask excludes, pushed into one by physics, or the zone's
   * NavAreas paint changed underneath it. Without this, findGridPath's
   * own start-snapping (AStar.js's nearestWalkable, max 4 rings) simply
   * fails once the disallowed zone is wider than a few cells, findPath()
   * returns null, and navMoveToward()/navDriveToward() would hold
   * position FOREVER — indistinguishable from "the goal is genuinely
   * unreachable" even though this is a completely different situation
   * (the agent itself is illegally placed, not the goal). Holding
   * position forever there is the "stuck and stops moving" bug this
   * fixes.
   *
   * STRATEGY: when a repath attempt fails, separately check whether
   * THIS agent's own current position is walkable for its own
   * radius+area (regardless of the goal). If it's NOT, that's the real
   * problem — search outward (via NavWorldSystem.
   * nearestWalkablePointForAgent, a wider ring than findPath's own
   * start-snap) for the nearest point this agent COULD legally stand,
   * and steer directly toward THAT instead of the original goal until
   * it's back on walkable ground — at that point the very next repath
   * naturally succeeds and normal path-following resumes on its own,
   * no special-case hand-off needed. If the agent's own position IS
   * walkable (so this is a genuinely unreachable/unbaked goal instead),
   * this returns null and the caller keeps its existing hold-position
   * behavior — this only changes behavior for the specific "I'm
   * somewhere I shouldn't be" case.
   *
   * @returns {{x:number,y:number}|null} an escape aim point, or null if
   *   this agent's current position is already walkable (not the
   *   problem) or no walkable point could be found nearby at all.
   */
  _escapeDisallowedArea(navAgent, agentRadius, agentArea) {
    var agentAreaCosts = navAgent ? navAgent.areaCosts : null;
    if (this._scriptApi._navIsWalkableForAgentFn &&
        this._scriptApi._navIsWalkableForAgentFn(this.x, this.y, agentRadius, agentArea, agentAreaCosts)) {
      return null;
    }
    var nearest = this._scriptApi._findNearestWalkable(this.x, this.y, agentRadius, agentArea, agentAreaCosts);
    if (!nearest) return null;
    // Already effectively there (e.g. right on the boundary) — nothing
    // useful to steer toward.
    if (Math.hypot(nearest.x - this.x, nearest.y - this.y) < 0.01) return null;
    return nearest;
  }

  /**
   * Local avoidance steering consumed ONLY by navMoveToward() — see the
   * "Pathfinding and local avoidance are SEPARATE concerns" note atop
   * systems/NavWorldSystem.js. This never re-plans a path or touches
   * NavWorld2D; it just bends the per-frame move direction away from
   * other nearby NavAgent2D entities so two agents crossing paths slide
   * past each other instead of overlapping.
   *
   * Skipped entirely (returns dirX/dirY unchanged) when this agent has
   * no NavAgent2D, or when navAgent.avoidanceEnabled is false — that's
   * the documented way to turn avoidance off per-agent, e.g.
   * `this.navAgent.avoidanceEnabled = false` to let an agent shove
   * through a crowd during a scripted moment.
   *
   * For every OTHER active NavAgent2D within combined-radius range,
   * this agent yields ground in proportion to the OTHER agent's
   * avoidancePriority relative to the sum of both priorities — a
   * higher-priority agent barely bends off course, a lower-priority one
   * bends hard, and two equal-priority agents split the difference
   * (each nudges ~50%), which is what NavAgent2D.js's field comment
   * ("higher-priority agents yield less... than lower-priority ones")
   * describes. If the other agent has avoidance disabled it's still
   * treated as an obstacle to steer around (it won't reciprocate, but
   * this agent still shouldn't walk through it).
   *
   * @param {import("../components/NavAgent2D.js").NavAgent2D|null} navAgent
   * @param {number} agentRadius this agent's NavAgent2D.radius (0 if none)
   * @param {number} dirX @param {number} dirY unit-length desired direction
   * @returns {{x:number,y:number}} unit-length (or zero) steered direction
   */
  /**
   * Returns a locally smoothed tangent for a navigation polyline. The agent
   * keeps following the CURRENT route segment, but as it approaches a
   * waypoint the outgoing tangent is blended in using a smoothstep curve.
   * This produces a natural continuous bend on roads made from many grid
   * cells without replacing the weighted A* route with a new shortcut.
   */
  _navSmoothRouteDirection(path, index, x, y, lookaheadDistance = 16) {
    if (!Array.isArray(path) || path.length === 0) return { x: 1, y: 0 };
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const smoothstep = (a, b, v) => {
      const t = clamp01((v - a) / Math.max(1e-6, b - a));
      return t * t * (3 - 2 * t);
    };
    let i = Math.max(0, Math.min(path.length - 1, Number(index) || 0));
    let wx = Number(path[i]?.x);
    let wy = Number(path[i]?.y);
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return { x: 1, y: 0 };

    let dx = wx - x, dy = wy - y;
    let distToCorner = Math.hypot(dx, dy);
    if (distToCorner < 1e-5 && i < path.length - 1) {
      i++;
      wx = Number(path[i]?.x) || x;
      wy = Number(path[i]?.y) || y;
      dx = wx - x; dy = wy - y;
      distToCorner = Math.hypot(dx, dy);
    }
    if (distToCorner < 1e-5) return { x: 1, y: 0 };

    const inX = dx / distToCorner;
    const inY = dy / distToCorner;
    if (i >= path.length - 1) return { x: inX, y: inY };

    const nx = (Number(path[i + 1]?.x) || 0) - wx;
    const ny = (Number(path[i + 1]?.y) || 0) - wy;
    const nextLen = Math.hypot(nx, ny);
    if (nextLen < 1e-5) return { x: inX, y: inY };
    const outX = nx / nextLen;
    const outY = ny / nextLen;

    // Only bend while inside a short window before the corner. The corner
    // itself remains on the selected path, so this does not turn route
    // smoothing into a hidden path replanner.
    const window = Math.max(4, Math.min(32, Number(lookaheadDistance) || 16));
    const t = 1 - clamp01(distToCorner / window);
    let smooth = t * t * (3 - 2 * t);
    // Gentle curves get a full tangent blend; tight grid corners get only a
    // small blend so a walking agent cannot drift outside a narrow road.
    const turnDot = Math.max(-1, Math.min(1, inX * outX + inY * outY));
    const turnAngle = Math.acos(turnDot);
    const gentleFactor = Math.max(0, Math.min(1, 1 - turnAngle / (Math.PI * 0.72)));
    smooth *= gentleFactor;
    let dirX = inX * (1 - smooth) + outX * smooth;
    let dirY = inY * (1 - smooth) + outY * smooth;
    const len = Math.hypot(dirX, dirY);
    if (len < 1e-5) return { x: inX, y: inY };
    return { x: dirX / len, y: dirY / len };
  }

  /**
   * Walking NavAgent path preview. Unlike a generic look-ahead, this helper
   * never skips across a corner: it samples only along the current route
   * segment and caps the preview at that segment's next waypoint. That gives
   * smooth tangent-following on long preferred-area corridors while keeping
   * the exact weighted A* route authoritative at area boundaries and turns.
   */
  _navWalkPathPreview(path, index, x, y, lookaheadDistance) {
    if (!Array.isArray(path) || path.length === 0) return { x, y };
    let i = Math.max(0, Math.min(path.length - 1, Number(index) || 0));
    let wx = Number(path[i]?.x);
    let wy = Number(path[i]?.y);
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return { x, y };

    // If the agent is already essentially at the current waypoint, advance
    // to the next segment. This avoids a one-frame reverse twitch at turns.
    let dx = wx - x, dy = wy - y;
    let distanceToWaypoint = Math.hypot(dx, dy);
    if (distanceToWaypoint < 1e-4 && i < path.length - 1) {
      i++;
      wx = Number(path[i].x) || x;
      wy = Number(path[i].y) || y;
      dx = wx - x;
      dy = wy - y;
      distanceToWaypoint = Math.hypot(dx, dy);
    }

    if (distanceToWaypoint <= 1e-5) return { x: wx, y: wy };

    // Never preview beyond the next waypoint. The next segment may belong
    // to a different side of a weighted-area boundary, and crossing the
    // corner early would turn a smooth visual aim into a real shortcut.
    const distance = Math.min(Math.max(1, Number(lookaheadDistance) || 16), distanceToWaypoint);
    return {
      x: x + (dx / distanceToWaypoint) * distance,
      y: y + (dy / distanceToWaypoint) * distance,
    };
  }

  /**
   * Conservative vehicle path simplifier. A* often returns a dense grid
   * polyline. Walking agents can tolerate following every cell, but a car
   * will visibly hunt left/right if it tries to steer at each tiny vertex.
   *
   * We greedily connect the current point to the farthest future point whose
   * straight chord is still inside the agent's walkable nav corridor. The
   * chord is sampled at a spacing tied to the car radius, so simplification
   * never knowingly crosses a forbidden/narrow region.
   */
  _navCarSimplifyPath(path, radius, area, areaCosts) {
    if (!Array.isArray(path) || path.length < 3) return path;

    // A car should remove noisy A* samples, NOT erase the road's actual
    // corners. The old visibility simplifier could legally see across a
    // zig-zag road and replace several bends with one diagonal chord. That
    // was still "walkable" to the nav grid, but it was the wrong route for a
    // vehicle. Preserve meaningful direction changes and only collapse points
    // that are genuinely almost-collinear.
    const out = [path[0]];
    const cosKeep = Math.cos(10 * Math.PI / 180);
    const minSegment = Math.max(2, Math.min(12, (Number(radius) || 8) * 0.20));

    const unit = (a, b) => {
      const dx = (Number(b.x) || 0) - (Number(a.x) || 0);
      const dy = (Number(b.y) || 0) - (Number(a.y) || 0);
      const len = Math.hypot(dx, dy);
      return len > 1e-5 ? { x: dx / len, y: dy / len, len } : null;
    };

    for (let i = 1; i < path.length - 1; i++) {
      const prev = out[out.length - 1];
      const cur = path[i];
      const next = path[i + 1];
      const a = unit(prev, cur);
      const b = unit(cur, next);
      if (!a || !b) continue;

      // Keep every real bend. Small grid jitter is removed only when the
      // incoming/outgoing headings differ by <= 10 degrees.
      const dot = a.x * b.x + a.y * b.y;
      const nearlyStraight = dot >= cosKeep;
      const veryShort = a.len < minSegment || b.len < minSegment;
      if (!nearlyStraight || !veryShort && a.len >= minSegment && b.len >= minSegment) {
        out.push(cur);
      }
      // For a short nearly-straight grid fragment, skip it. For a long
      // nearly-straight segment, retain it as a useful route anchor.
      else if (!nearlyStraight) out.push(cur);
    }
    out.push(path[path.length - 1]);

    // Remove accidental duplicate/near-duplicate anchors without ever
    // removing a corner anchor.
    const cleaned = [out[0]];
    for (let i = 1; i < out.length; i++) {
      const last = cleaned[cleaned.length - 1];
      if (Math.hypot((out[i].x || 0) - (last.x || 0), (out[i].y || 0) - (last.y || 0)) > 0.75) {
        cleaned.push(out[i]);
      }
    }
    return cleaned.length >= 2 ? cleaned : [path[0], path[path.length - 1]];
  }

  /**
   * Braking lookahead for cars: scans the route FAR beyond the short
   * steering window (_navCarPathPreview above) to find every corner a
   * real driver would already be planning for, and returns the speed the
   * car needs to be down to RIGHT NOW to comfortably make the tightest of
   * them — treating a run of several close corners (a zigzag/S-curve
   * road) as one continuous braking problem instead of discovering each
   * bend only once it's already the nearest waypoint.
   *
   * This is intentionally separate from _navCarPathPreview()'s corner
   * detection, which stays short-range because it drives STEERING (the
   * point the wheel aims at) — a driver looks far ahead to decide how
   * hard to brake, but still steers based on the road immediately under
   * the hood. Conflating the two made the old single-fixed-window
   * approach ambiguous: a window long enough for high-speed braking would
   * have made steering hunt at distant corners, and a window short enough
   * for clean steering left braking with no time to react at speed.
   *
   * For each corner found, computes the physically required approach
   * speed via the standard v = sqrt(2 * a * d) stopping-distance relation
   * (same relation already used for the final-arrival brake elsewhere in
   * this file), sized down further by how sharp the corner is — a gentle
   * bend can be taken faster than a hairpin even at the same distance.
   * Returns the MINIMUM such speed across every corner in range, which is
   * exactly the one a driver has to actually obey: you plan for the
   * tightest upcoming constraint, not the average of all of them.
   *
   * @param {Array<{x:number,y:number}>} path
   * @param {number} index current waypoint index the car is walking toward
   * @param {number} x @param {number} y car's current position
   * @param {number} scanRange how far ahead along the route to look, in
   *   pixels — the caller sizes this to the car's own current speed and
   *   braking capability so a fast car actually looks far enough ahead.
   * @param {number} brakeAccel this car's braking deceleration (px/s^2)
   * @param {number} maxSpeed this car's configured top speed — a corner
   *   requiring a HIGHER speed than this to "need braking for" is not a
   *   real constraint (the car was never going to exceed maxSpeed there
   *   anyway), so such corners are ignored rather than pulling the target
   *   speed up.
   * @returns {{targetSpeed:number, nearestCornerDistance:number}}
   *   targetSpeed: maxSpeed if no corner within range needs braking for,
   *   otherwise the minimum required approach speed across all of them.
   */
  _navCarBrakingLookahead(path, index, x, y, scanRange, brakeAccel, maxSpeed) {
    if (!Array.isArray(path) || path.length < 2) return { targetSpeed: maxSpeed, nearestCornerDistance: Infinity };
    let i = Math.max(0, Math.min(path.length - 1, Number(index) || 0));
    let px = x, py = y;
    let travelled = 0;
    let prevTangentX = 0, prevTangentY = 0, havePrevTangent = false;
    let minTargetSpeed = maxSpeed;
    let nearestCornerDistance = Infinity;
    const accel = Math.max(40, Number(brakeAccel) || 1000);

    while (i < path.length && travelled <= scanRange) {
      const wx = Number(path[i].x) || 0;
      const wy = Number(path[i].y) || 0;
      const dx = wx - px, dy = wy - py;
      const seg = Math.hypot(dx, dy);
      if (seg > 1e-5) {
        const ux = dx / seg, uy = dy / seg;
        if (havePrevTangent) {
          const dot = Math.max(-1, Math.min(1, prevTangentX * ux + prevTangentY * uy));
          const turn = Math.acos(dot); // 0 = straight, PI = hairpin reversal
          if (turn > 0.05) {
            // Sharper turns need a lower speed at the same distance. This
            // maps turn angle to a 0-1 "how much must I slow" factor —
            // a gentle ~15-degree bend barely registers, while anything
            // beyond ~100 degrees is treated as needing to be nearly
            // walking-paced through the apex, same spirit as
            // cornerSeverity elsewhere but tuned for a braking curve
            // rather than a steering one.
            const sharpness = Math.max(0, Math.min(1, turn / (Math.PI * 0.62)));
            // Physical approach speed for this corner: how fast the car
            // can be going NOW and still be slowed to a corner-appropriate
            // speed by the time it arrives, using the same v=sqrt(2*a*d)
            // relation as the final-arrival brake. The corner's own
            // "comfortable" speed shrinks with sharpness so a hairpin is
            // targeted near a crawl while a gentle bend barely slows.
            const cornerComfortSpeed = maxSpeed * (1 - sharpness * 0.85);
            const approachSpeed = Math.sqrt(
              Math.max(0, cornerComfortSpeed * cornerComfortSpeed + 2 * accel * travelled)
            );
            if (approachSpeed < minTargetSpeed) minTargetSpeed = approachSpeed;
            if (travelled < nearestCornerDistance) nearestCornerDistance = travelled;
          }
        }
        prevTangentX = ux; prevTangentY = uy; havePrevTangent = true;
        travelled += seg;
      }
      px = wx; py = wy; i++;
    }
    return { targetSpeed: Math.max(0, Math.min(maxSpeed, minTargetSpeed)), nearestCornerDistance };
  }

  /**
   * Vehicle-specific path preview. Grid/A* paths are deliberately kept as
   * navigation data, while the car follows a look-ahead point between/along
   * those waypoints. This removes the stop-turn-go look of point chasing.
   * It also measures the next corner so speed control can anticipate it.
   */
  _navCarPathPreview(path, index, x, y, lookaheadDistance, cornerLookahead) {
    if (!Array.isArray(path) || path.length === 0) {
      return { x, y, cornerSeverity: 0, cornerDistance: Infinity, tangentX: 0, tangentY: -1 };
    }
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const smoothstep = (a, b, v) => {
      const t = clamp01((v - a) / Math.max(1e-6, b - a));
      return t * t * (3 - 2 * t);
    };
    let i = Math.max(0, Math.min(path.length - 1, Number(index) || 0));
    let px = x, py = y;
    let remaining = Math.max(1, lookaheadDistance);
    let aimX = path[i]?.x ?? x;
    let aimY = path[i]?.y ?? y;
    let tangentX = 0, tangentY = -1;
    let travelled = 0;
    let cornerSeverity = 0;
    let cornerDistance = Infinity;
    let cornerIndex = -1;
    let cornerIncomingLength = 0;
    let cornerTravelBeforeSegment = 0;

    while (i < path.length) {
      const wx = Number(path[i].x) || 0;
      const wy = Number(path[i].y) || 0;
      const dx = wx - px, dy = wy - py;
      const seg = Math.hypot(dx, dy);
      if (seg > 1e-5) {
        const ux = dx / seg, uy = dy / seg;
        tangentX = ux; tangentY = uy;
        if (seg >= remaining) {
          aimX = px + ux * remaining;
          aimY = py + uy * remaining;
          break;
        }
        remaining -= seg;
        travelled += seg;
      }

      // At this waypoint, compare the incoming direction with the next
      // outgoing segment. A large change means a driver should start
      // braking before the corner rather than after it.
      if (i < path.length - 1 && (tangentX !== 0 || tangentY !== 0)) {
        const nx = (Number(path[i + 1].x) || 0) - wx;
        const ny = (Number(path[i + 1].y) || 0) - wy;
        const nlen = Math.hypot(nx, ny);
        if (nlen > 1e-5) {
          const nuX = nx / nlen, nuY = ny / nlen;
          const dot = Math.max(-1, Math.min(1, tangentX * nuX + tangentY * nuY));
          const turn = Math.acos(dot);
          const previewFactor = 1 - clamp01(travelled / Math.max(1, cornerLookahead));
          cornerSeverity = Math.max(cornerSeverity, (turn / Math.PI) * previewFactor);
          if (cornerDistance === Infinity) {
            cornerDistance = travelled;
            cornerIndex = i;
            cornerIncomingLength = i > 0
              ? Math.hypot(
                  (Number(path[i].x) || 0) - (Number(path[i - 1].x) || 0),
                  (Number(path[i].y) || 0) - (Number(path[i - 1].y) || 0)
                )
              : seg;
            cornerTravelBeforeSegment = Math.max(0, travelled - cornerIncomingLength);
          }
        }
      }

      px = wx; py = wy; i++;
      aimX = px; aimY = py;
      if (remaining <= 1e-4 || i >= path.length) break;
    }

    // Do NOT blend a point from before a corner with a point after the
    // corner. That interpolation creates a brand-new diagonal point that
    // was never on the navigation route, which can make a car cut across
    // an unwalkable/forbidden area (for example, leaving a road and
    // shortcutting over the Ground at a 90-degree road bend). The near
    // sample above is already a look-ahead point measured along the actual
    // path polyline, so it is both smooth enough for steering and guaranteed
    // to remain on the path segment selected by navigation.
    // Bend the route tangent toward the outgoing segment while approaching
    // the next corner. This is intentionally local: once the car is past the
    // corner the new segment becomes authoritative, and before the corner the
    // bend begins gradually so steering never snaps.
    let tangentBlend = 0;
    if (cornerIndex >= 0 && cornerIndex < path.length - 1 && cornerDistance !== Infinity) {
      const turnWindow = Math.max(18, Math.min(72, Number(cornerLookahead) || 70));

      // Real drivers generally do not start rotating the car the instant a
      // new navigation edge begins.  A grid/path corner can otherwise make
      // the vehicle “turn at the edge” and visibly hug the wrong side of the
      // road.  Wait until the car has covered roughly the first half of the
      // incoming edge before blending toward the outgoing edge.  This keeps
      // the car committed to one direction through the first half of a
      // segment, then lets it arc naturally into the turn.
      // cornerDistance is measured from the car to the corner.  When the
      // corner is the next route vertex, subtracting that distance from the
      // full incoming-edge length gives exactly how far through the edge the
      // car has progressed.  If a future corner is more than one edge away,
      // the gate stays closed.
      const incomingLength = Math.max(1, cornerIncomingLength);
      const midEdgeFraction = clamp01(1 - cornerDistance / incomingLength);
      // Steering stays fully committed to the incoming edge until ~50% of
      // that edge has been travelled. The next segment only becomes eligible
      // after this gate, preventing the repeated tiny-left/tiny-right hunt on
      // long straight road cells.
      const midEdgeGate = smoothstep(0.50, 0.72, midEdgeFraction);
      const distanceGate = 1 - clamp01(cornerDistance / turnWindow);
      tangentBlend = distanceGate * midEdgeGate;
      tangentBlend = tangentBlend * tangentBlend * (3 - 2 * tangentBlend);
      // Tight corners are kept much more conservative than gentle curves.
      // A near-180-degree reversal should never be rounded aggressively,
      // while small bends can begin steering earlier.
      const wx = Number(path[cornerIndex]?.x) || aimX;
      const wy = Number(path[cornerIndex]?.y) || aimY;
      const nx = (Number(path[cornerIndex + 1]?.x) || wx) - wx;
      const ny = (Number(path[cornerIndex + 1]?.y) || wy) - wy;
      const nlen = Math.hypot(nx, ny);
      if (nlen > 1e-5 && tangentBlend > 0) {
        const nextX = nx / nlen, nextY = ny / nlen;
        const dot = Math.max(-1, Math.min(1, tangentX * nextX + tangentY * nextY));
        const turnAngle = Math.acos(dot);
        const gentleFactor = Math.max(0, Math.min(1, 1 - turnAngle / (Math.PI * 0.72)));
        tangentBlend *= gentleFactor;
        tangentX = tangentX * (1 - tangentBlend) + nextX * tangentBlend;
        tangentY = tangentY * (1 - tangentBlend) + nextY * tangentBlend;
        const tlen = Math.hypot(tangentX, tangentY);
        if (tlen > 1e-5) { tangentX /= tlen; tangentY /= tlen; }
      }
    }
    const cornerTurnGate = (cornerIndex >= 0 && cornerIncomingLength > 1e-5)
      ? smoothstep(0.50, 0.72, clamp01(1 - cornerDistance / cornerIncomingLength))
      : 1;
    return { x: aimX, y: aimY, cornerSeverity, cornerDistance, cornerIndex, cornerIncomingLength, cornerTurnGate, tangentX, tangentY, tangentBlend };
  }

  /**
   * Predictive traffic awareness for NavCars: anticipates other moving
   * NavAgent2D/Car entities BEFORE they become a raycast hit, the way a
   * real driver watches other cars' trajectories rather than only
   * reacting once something is directly in front of the hood.
   *
   * This is deliberately separate from _navCarScanObstacles() (which
   * stays a reactive short-range raycast fan for static/late geometry)
   * and from _applyNavAvoidance() (a static-position potential field with
   * no sense of where a neighbor is HEADING). Three real-driver behaviors
   * this adds that neither of those covers:
   *
   *   1. CLOSING-SPEED BRAKING: projects both this car's and each nearby
   *      agent's position forward over a short horizon and brakes
   *      proportional to how soon (not just how close) they'd collide —
   *      a fast car closing on a slow one brakes earlier than a
   *      near-stationary one the same distance away, same as a human
   *      judging "how long until I reach that gap" rather than just "how
   *      far away is it right now".
   *   2. FOLLOWING DISTANCE: a neighbor moving the same direction, close
   *      ahead, in-lane, is treated as "traffic to follow" rather than
   *      "obstacle to dodge" — this car matches/undercuts the lead
   *      car's speed instead of swerving around it or tailgating at full
   *      throttle until a raycast finally fires.
   *   3. YIELD BY PRIORITY: when two NavCars' predicted paths are about
   *      to cross (an intersection-style conflict, not a following
   *      situation), the one with the LOWER NavAgent2D.avoidancePriority
   *      brakes to let the higher-priority one through — reuses the
   *      exact same priority field _applyNavAvoidance() already has, so
   *      existing avoidancePriority tuning on a scene keeps working
   *      without any new per-agent setup.
   *
   * Only queries entities with a Rigidbody2D (so a parked/kinematic prop
   * with a NavAgent2D but no velocity falls through to the ordinary
   * raycast/avoidance path instead of ever being treated as "traffic").
   *
   * @returns {{brake:number, followSpeed:number|null, yield:boolean}}
   *   brake: 0-1 additional braking pressure from anticipated traffic.
   *   followSpeed: the lead car's own speed to match/undercut, or null
   *     if nothing is being followed this frame.
   *   yield: true if this car should hold back for a higher-priority
   *     crossing car regardless of the numeric brake amount (used to
   *     force a firmer stop at a predicted intersection conflict rather
   *     than only a partial slowdown).
   */
  _navCarTrafficScan(navAgent, agentRadius, speed, aimDirX, aimDirY) {
    var world = this._world;
    if (!world || typeof world.query !== "function") return { brake: 0, followSpeed: null, yield: false };

    var selfId = this._entity.id;
    var selfX = this.x, selfY = this.y;
    var selfSpeed = Math.max(0, Number(speed) || 0);
    var selfPriority = Number(navAgent.avoidancePriority) || 0;

    // Look further ahead the faster this car is going — same idea as a
    // human driver's following distance growing with speed, not a fixed
    // bumper-to-bumper radius regardless of how fast either car is moving.
    var horizon = Math.max(0.6, Math.min(2.2, 0.6 + selfSpeed / 220)); // seconds
    var scanRange = Math.max(60, selfSpeed * horizon + agentRadius * 3);

    var others = world.query(NAV_AGENT_2D, TRANSFORM, RIGIDBODY_2D);
    var brake = 0;
    var followSpeed = null;
    var closestFollowDist = Infinity;
    var shouldYield = false;

    for (var i = 0; i < others.length; i++) {
      var other = others[i];
      if (other.id === selfId) continue;
      var otherTransform = other.getComponent(TRANSFORM);
      var otherRb = other.getComponent(RIGIDBODY_2D);
      var otherAgent = other.getComponent(NAV_AGENT_2D);
      if (!otherTransform || !otherRb || !otherAgent) continue;

      var offX = otherTransform.x - selfX;
      var offY = otherTransform.y - selfY;
      var dist = Math.hypot(offX, offY);
      if (dist > scanRange || dist <= 0.000001) continue;

      var otherVX = Number(otherRb.velocityX) || 0;
      var otherVY = Number(otherRb.velocityY) || 0;
      var otherSpeed = Math.hypot(otherVX, otherVY);

      // Only cars roughly ahead of this one's intended direction matter —
      // a neighbor behind or well off to the side is not something a
      // driver brakes for, that is what side-avoidance/steering already
      // handles via _applyNavAvoidance/_navCarScanObstacles.
      var aheadDot = (offX / dist) * aimDirX + (offY / dist) * aimDirY;
      if (aheadDot < 0.35) continue;

      var combinedRadius = agentRadius + (Number(otherAgent.radius) || agentRadius);

      // Closing speed along the line between the two cars: positive means
      // the gap is shrinking. `n` points from this car TOWARD the other
      // car, so relative velocity projected onto `n` (no negation) is
      // exactly the rate the distance between them is closing — positive
      // when this car is gaining on the other, negative when the gap is
      // opening. Using relative velocity (not just this car's own speed)
      // is what lets this correctly ignore a car moving away at the same
      // speed ahead, and correctly react early to one coming to a stop or
      // turning across this car's path.
      var nx = offX / dist, ny = offY / dist;
      var relVX = selfSpeed * aimDirX - otherVX;
      var relVY = selfSpeed * aimDirY - otherVY;
      var closingSpeed = relVX * nx + relVY * ny;
      if (closingSpeed <= 0.001) continue; // gap steady or opening — no anticipation needed

      var timeToClose = Math.max(0, dist - combinedRadius) / closingSpeed;
      if (timeToClose > horizon) continue;

      // Same-direction, close ahead, roughly centered on this car's aim —
      // this is "traffic to follow", not a crossing conflict. Track the
      // nearest such neighbor so this car can match its speed smoothly
      // instead of alternating between full throttle and hard braking.
      var headingAgreement = otherSpeed > 1
        ? (otherVX / otherSpeed) * aimDirX + (otherVY / otherSpeed) * aimDirY
        : 1; // a stopped car ahead counts as "in-lane" for following purposes
      var laneAlignment = aheadDot > 0.85;
      if (laneAlignment && headingAgreement > 0.6 && dist < closestFollowDist) {
        closestFollowDist = dist;
        followSpeed = otherSpeed;
      }

      var urgency = Math.max(0, Math.min(1, 1 - timeToClose / horizon));
      brake = Math.max(brake, urgency);

      // Crossing-path conflict (not simple following): the lower-priority
      // car yields. Only applies when paths genuinely cross rather than
      // run parallel, so two cars in the same lane don't fight over
      // priority when they should just be following each other.
      if (!laneAlignment) {
        var otherPriority = Number(otherAgent.avoidancePriority) || 0;
        if (selfPriority < otherPriority && urgency > 0.15) shouldYield = true;
      }
    }

    return { brake, followSpeed, yield: shouldYield };
  }

  /** Local short-range obstacle scanner for cars. Nav baking handles the
   * global route; these shape-agnostic rays handle moving/late obstacles
   * that are not represented in the last Nav bake. */
  _navCarScanObstacles(transform, navAgent, speed, targetX, targetY) {
    const forwardAngle = (transform.rotation * Math.PI) / 180;
    const fx = Math.sin(forwardAngle), fy = -Math.cos(forwardAngle);
    const rx = Math.cos(forwardAngle), ry = Math.sin(forwardAngle);
    // Base configured lookahead, extended further the faster the car is
    // currently moving — a real driver watches farther down the road at
    // speed instead of scanning the same fixed distance whether crawling
    // or at full throttle. Capped at 2x base so a very fast car cannot
    // start braking for something absurdly far away and behind a corner.
    const baseRange = Math.max(48, Number(navAgent?.vehicleObstacleLookahead) || 120);
    const speedRangeBoost = Math.max(0, Math.min(baseRange, (Number(speed) || 0) * 0.55));
    const range = baseRange + speedRangeBoost;
    const width = Math.max(6, Number(navAgent?.vehicleObstacleWidth) || 28);
    const cast = (dx, dy, length) => {
      if (!this._scriptApi || typeof this._scriptApi._raycast !== 'function') return null;
      return this._scriptApi._raycast(transform.x, transform.y,
        transform.x + dx * length, transform.y + dy * length,
        { exclude: [this._entity] });
    };

    const samples = [
      { lateral: 0, x: fx, y: fy },
      { lateral: -width, x: fx * 0.98 - rx * 0.20, y: fy * 0.98 - ry * 0.20 },
      { lateral: width, x: fx * 0.98 + rx * 0.20, y: fy * 0.98 + ry * 0.20 },
    ];
    let centerHit = null, leftClear = range, rightClear = range;
    for (const sample of samples) {
      const hit = cast(sample.x, sample.y, range);
      const d = hit && Number.isFinite(hit.distance) ? hit.distance : range;
      if (sample.lateral === 0) centerHit = hit ? { ...hit, distance: d } : null;
      else if (sample.lateral < 0) leftClear = Math.min(leftClear, d);
      else rightClear = Math.min(rightClear, d);
    }

    // If the target itself is substantially off to one side, preserve a
    // little bias so obstacle avoidance does not over-correct away from the
    // actual route.
    const targetDX = targetX - transform.x, targetDY = targetY - transform.y;
    const targetSide = fx * targetDY - fy * targetDX;
    let steer = 0;
    let brake = 0;
    let blocked = false;
    if (centerHit) {
      const normalized = Math.max(0, Math.min(1, 1 - centerHit.distance / range));
      const speedFactor = Math.max(0.35, Math.min(1.2, (Math.abs(speed) + 40) / 180));
      brake = normalized * speedFactor;
      blocked = centerHit.distance < Math.max(45, Math.abs(speed) * 0.8);
      // Choose the side with more room. Tiny target-side bias breaks exact
      // symmetry without causing frame-to-frame left/right chatter.
      const clearanceBias = rightClear - leftClear;
      steer = clearanceBias > 4 ? 1 : clearanceBias < -4 ? -1 : (targetSide >= 0 ? 1 : -1) * 0.15;
      steer *= normalized;
    } else {
      const sidePressure = Math.max(0, (range - leftClear) / range) - Math.max(0, (range - rightClear) / range);
      steer += sidePressure * 0.55;
    }
    return { centerHit, leftClear, rightClear, steer, brake, blocked, range };
  }

  /** Controller smoothing is deliberately based on the requested steering
   * signal, not by directly rewriting transform.rotation. That keeps manual
   * driving untouched and makes Nav cars feel like they have steering inertia. */
  _navCarSmoothSignal(previous, next, dt, response) {
    const a = 1 - Math.exp(-Math.max(0.1, response) * Math.max(0, dt));
    return previous + (next - previous) * a;
  }

  _applyNavAvoidance(navAgent, agentRadius, dirX, dirY) {
    if (!navAgent || !navAgent.avoidanceEnabled) return { x: dirX, y: dirY };

    var world = this._world;
    if (!world || typeof world.query !== "function") return { x: dirX, y: dirY };

    var selfId = this._entity.id;
    var selfX = this.x;
    var selfY = this.y;
    var selfPriority = navAgent.avoidancePriority;

    var pushX = 0;
    var pushY = 0;

    var others = world.query(NAV_AGENT_2D, TRANSFORM);
    for (var i = 0; i < others.length; i++) {
      var other = others[i];
      if (other.id === selfId) continue;
      var otherAgent = other.getComponent(NAV_AGENT_2D);
      var otherTransform = other.getComponent(TRANSFORM);
      if (!otherAgent || !otherTransform) continue;

      var offX = selfX - otherTransform.x;
      var offY = selfY - otherTransform.y;
      var dist = Math.hypot(offX, offY);

      // Combined clearance both agents need to not overlap, plus a
      // little headroom so agents start sliding apart just BEFORE they
      // touch rather than after — same spirit as physics contact margins.
      var minDist = agentRadius + otherAgent.radius;
      if (minDist <= 0) minDist = Math.max(agentRadius, otherAgent.radius, 8);
      var avoidRange = minDist * 1.5;
      if (dist >= avoidRange || dist <= 0.000001) continue;

      // How much of the yielding falls on THIS agent vs the other one.
      // Equal priorities split 50/50; a much higher-priority neighbor
      // makes this agent yield almost entirely, and vice versa.
      var otherPriority = otherAgent.avoidancePriority;
      var totalPriority = selfPriority + otherPriority;
      var yieldShare = totalPriority > 0 ? otherPriority / totalPriority : 0.5;

      // Push away from the other agent, stronger the closer they are
      // (falls off linearly to 0 at avoidRange), scaled by this agent's
      // yield share.
      var closeness = 1 - dist / avoidRange;
      var weight = closeness * yieldShare;
      pushX += (offX / dist) * weight;
      pushY += (offY / dist) * weight;
    }

    if (pushX === 0 && pushY === 0) return { x: dirX, y: dirY };

    // Blend the original heading with the avoidance push rather than
    // fully replacing it, so an agent still makes progress toward its
    // waypoint while sliding around a neighbor instead of stopping
    // dead or spinning in place when two pushes briefly cancel out.
    var blendedX = dirX + pushX;
    var blendedY = dirY + pushY;
    var blendedLen = Math.hypot(blendedX, blendedY);
    if (blendedLen <= 0.000001) return { x: dirX, y: dirY };
    return { x: blendedX / blendedLen, y: blendedY / blendedLen };
  }

  /**
   * "Smart NPC" group-surround steering: when two or more collabEnabled
   * NavAgent2D entities are heading toward the SAME (or nearly the same)
   * point — e.g. several guards all given the intruder's position, or a
   * pack all chasing the same prey — this spreads them into distinct
   * slots on a ring around that point instead of every agent pathing to
   * the identical pixel and shoving each other for the last approach,
   * so the group visually traps/encircles the target the way coordinated
   * NPCs do, rather than forming a single-file jam on one side of it.
   *
   * Grouping rule: this agent joins every OTHER active, collabEnabled
   * NavAgent2D whose own current goal is within
   * min(this.collabGroupRadius, other.collabGroupRadius) of THIS call's
   * (targetX,targetY) — the smaller of the two radii wins so one agent
   * can't unilaterally force a huge group. Agents already grouped from a
   * PREVIOUS call (i.e. still converging on the same target) keep the
   * same stable slot index across frames — indices are assigned by
   * entity id order, not recomputed from scratch each call, so a group
   * doesn't visibly reshuffle which agent takes which side every frame.
   *
   * Ring radius is this agent's own NavAgent2D.radius plus the group's
   * largest member radius, so slots are spaced far enough apart that
   * two different-sized agents both fit their own clearance without
   * overlapping each other at the target.
   *
   * Falls back to the plain (targetX,targetY) — no ring offset — when
   * this agent is the only collab member converging on this target, so
   * a lone collabEnabled agent behaves exactly like collabEnabled=false.
   *
   * @param {import("../components/NavAgent2D.js").NavAgent2D} navAgent
   * @param {number} targetX @param {number} targetY the RAW target this
   *   call's navMoveToward() was given, before any collab adjustment
   * @returns {{x:number,y:number}} this agent's assigned goal point —
   *   either the ring slot, or the original target if ungrouped
   */
  _applyNavCollab(navAgent, targetX, targetY) {
    var world = this._world;
    if (!world || typeof world.query !== "function") return { x: targetX, y: targetY };

    var selfId = this._entity.id;
    var groupRadius = navAgent.collabGroupRadius;
    var members = [{ id: selfId, radius: navAgent.radius }]; // self always included

    var others = world.query(NAV_AGENT_2D);
    for (var i = 0; i < others.length; i++) {
      var other = others[i];
      if (other.id === selfId) continue;
      var otherAgent = other.getComponent(NAV_AGENT_2D);
      if (!otherAgent || !otherAgent.collabEnabled) continue;

      // Compare against the OTHER agent's own current nav-move goal
      // (its _navMoveState.goalX/Y, set by its own navMoveToward() call
      // this frame or a prior one) — not its live position — since
      // "heading toward the same thing" is about shared INTENT, not
      // proximity to each other, which is exactly what avoidance
      // already handles.
      var otherGoal = this._scriptApi._peekNavGoal(other.id);
      if (!otherGoal) continue;

      var maxJoinDist = Math.min(groupRadius, otherAgent.collabGroupRadius);
      if (maxJoinDist <= 0) continue;
      if (Math.hypot(otherGoal.x - targetX, otherGoal.y - targetY) > maxJoinDist) continue;

      members.push({ id: other.id, radius: otherAgent.radius });
    }

    // Publish this call's goal so OTHER agents evaluating collab this
    // same frame (or next frame, before this one repaths) can find it —
    // see _peekNavGoal()/_publishNavGoal() below. Must happen even when
    // ungrouped (members.length === 1) so a second agent that starts
    // converging on this target a moment later can still find this one.
    this._scriptApi._publishNavGoal(selfId, targetX, targetY);

    if (members.length < 2) return { x: targetX, y: targetY };

    // Stable slot assignment: sort by entity id (entity ids are strings
    // like "e1", "e2", ... — see core/Entity.js's id counter — so this
    // is a STRING sort, not numeric subtraction, which would silently
    // NaN-compare and produce an unstable/duplicate order) so every
    // member of the group independently computes the SAME order and
    // therefore the SAME ring layout, with no coordination needed
    // beyond each agent seeing the same member list.
    members.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    var slotIndex = 0;
    var maxMemberRadius = 0;
    for (var m = 0; m < members.length; m++) {
      if (members[m].id === selfId) slotIndex = m;
      if (members[m].radius > maxMemberRadius) maxMemberRadius = members[m].radius;
    }

    var ringRadius = Math.max(navAgent.radius, 8) + Math.max(maxMemberRadius, 8);
    var angle = (slotIndex / members.length) * Math.PI * 2;
    return {
      x: targetX + Math.cos(angle) * ringRadius,
      y: targetY + Math.sin(angle) * ringRadius,
    };
  }

  get rotation() { const t = this._entity.getComponent(TRANSFORM); return t ? t.rotation : 0; }
  set rotation(v) {
    const t = this._entity.getComponent(TRANSFORM);
    if (!t) return;
    const nextRotation = Number(v);
    if (!Number.isFinite(nextRotation)) return;
    t.rotation = nextRotation;

    // Kinematic rotation is driven by the script/Transform. Remember this
    // exact assignment for the next physics sync so a contact transition
    // cannot blend the body toward another angle. Airborne calls such as
    // `rotation += 2` remain fully supported because every assignment is
    // simply made the exact target for that frame.
    const rb = this._entity.getComponent('Rigidbody2D');
    if (rb && rb.bodyType === 'Kinematic') {
      rb._scriptRotationTarget = nextRotation;
      if (typeof this._scriptApi._kinematicRotationFn === 'function') {
        try {
          this._scriptApi._kinematicRotationFn(this._entity, nextRotation);
        } catch (_) {}
      }
    }
  }

  get scaleX() { const t = this._entity.getComponent(TRANSFORM); return t ? t.scaleX : 1; }
  set scaleX(v) { const t = this._entity.getComponent(TRANSFORM); if (t) t.scaleX = v; }

  get scaleY() { const t = this._entity.getComponent(TRANSFORM); return t ? t.scaleY : 1; }
  set scaleY(v) { const t = this._entity.getComponent(TRANSFORM); if (t) t.scaleY = v; }

  get visible() { return this._entity.active; }
  set visible(v) { this._entity.active = !!v; }

  get enabled() { const s = this._entity.getComponent(SCRIPT); return s ? s.enabled : true; }
  set enabled(v) { const s = this._entity.getComponent(SCRIPT); if (s) s.enabled = !!v; }

  // Identity shortcuts — read the underlying Entity's name/tag (set in
  // the Hierarchy/Inspector, or via new Entity(name, tag)). Added so
  // onCollisionEnter(other)/onTriggerEnter(other) handlers can tell
  // WHAT they just touched ("if (other.tag === 'Obstacle') ...") —
  // previously EntityContext exposed no way at all to read an entity's
  // name or tag, even though Entity itself has always carried both.
  // name is read-only (an entity's identity isn't meant to be
  // rewritten at runtime); tag is read/write since re-tagging at
  // runtime is a normal gameplay pattern (e.g. marking a picked-up
  // item's tag as "Collected" so it's skipped by later checks).
  get name() { return this._entity.name; }
  get tag() { return this._entity.tag; }
  set tag(v) { this._entity.tag = v; }

  /**
   * Stable unique identifier for this entity — unlike name/tag, which
   * many entities can share (e.g. a dozen "Enemy"-named/tagged clones),
   * id is assigned once per entity when it's created and never reused,
   * even after the entity is destroyed (see Entity.js's _nextEntityId
   * counter — it only ever increments). This is what makes findById()
   * a RELIABLE way to re-locate one specific entity later — e.g. save
   * the id of an entity you spawn() so you can findById() that EXACT
   * clone afterward, instead of findFirst(name)/findFirstWithTag(tag)
   * which can silently return a different entity if more than one
   * shares that name or tag.
   *   var e = spawn("Enemy", { x: 100, y: 50 });
   *   var savedId = e.id;
   *   // ...later, maybe in a different script...
   *   var sameEnemy = findById(savedId); // always this exact clone, or null if it was destroyed
   * Read-only — an entity's id is fixed for its entire lifetime.
   */
  get id() { return this._entity.id; }

  /**
   * Destroys this entity — removes it from the scene, exactly like
   * Unity's Destroy(gameObject). Safe to call from ANY lifecycle
   * method (onUpdate, onCollision, onTriggerEnter, even onStart) and
   * safe to call more than once (later calls are harmless no-ops).
   *
   * DEFERRED, not immediate — matches Unity's own Destroy() semantics
   * exactly: the entity is only actually removed at the END of this
   * frame (see World.js's queueDestroy()/flushDestroyed() and
   * ScriptSystem.js's update(), which calls flushDestroyed() after
   * every system has finished its pass for the frame). That means:
   *   - this.x, this.rigidbody.velocity, etc. all keep working
   *     normally for the REST of this frame after calling destroy() —
   *     the entity isn't half-torn-down mid-callback.
   *   - Other scripts' onCollision(other) firing later THIS SAME
   *     frame for this entity still receive a valid `other` context.
   *   - Starting next frame, the entity is gone: it won't appear in
   *     find()/scene.query(), its onUpdate/onFixedUpdate won't run,
   *     its Rapier physics body is removed, its Pixi sprite is
   *     removed, and onDestroy() fires on it exactly once right
   *     before it's actually removed.
   * If you need to know synchronously whether an entity is already
   * queued for removal (e.g. to avoid double-scoring a pickup two
   * scripts both collided with this same frame), check this.destroyed.
   */
  destroy() {
    this._world.queueDestroy(this._entity.id);
  }

  /**
   * True if this entity currently has the given component attached —
   * the runtime backing for editor autocomplete's type-narrowing
   * feature ("if (enemy.hasComponent(\"Rigidbody2D\")) { ... }").
   * Accepts the same component key strings used elsewhere in the
   * engine (see runtime/components/*.js's exported KEY constants,
   * e.g. "Rigidbody2D", "CharacterController", "Collider2D",
   * "SpriteRenderer", "AudioSource", "Light", "Camera",
   * "SpriteAnimation", "TextRenderer", "SpeechBubble", "ChatLog",
   * "TextInput", "StrokePath"). "Transform" always returns true — every entity has
   * one. Safe to call on any entity context, including ones from
   * find()/findFirst()/onCollision's `other` — not just `this`.
   *   function onUpdate() {
   *     if (this.hasComponent("Rigidbody2D")) {
   *       this.rigidbody.addForce(0, -500);
   *     }
   *   }
   * @param {string} componentKey
   * @returns {boolean}
   */
  hasComponent(componentKey) {
    return this._entity.hasComponent(componentKey);
  }

  /** True once destroy() has been called on this entity (this frame or
   *  a callback later this same frame) but before it's actually been
   *  removed — see destroy()'s doc comment for the full deferred-
   *  removal timeline. Never true again after the entity is gone
   *  (there's no context left to read it from at that point). */
  get destroyed() {
    return this._world.isPendingDestroy(this._entity.id);
  }

  /**
   * True if THIS entity was itself created via spawn() (a runtime
   * clone) rather than loaded from the scene file. Read-only — an
   * entity's origin isn't meant to be reassigned at runtime, same as
   * Unity's own gameObject identity. Typical use inside onStart():
   *   function onStart() {
   *     if (this.isClone) { this.hp = 50; } // clones start weaker, say
   *   }
   */
  get isClone() {
    return this._isClone;
  }

  /**
   * True while the mouse cursor is currently over THIS entity's own
   * collider shape — real shape-accurate hit-testing, same as
   * mouse.isOver("Name") but without needing to look this entity up by
   * name/tag since you're already inside its own script:
   *   function onUpdate() {
   *     this.sprite.opacity = this.isPointerOver ? 1 : 0.6; // hover highlight
   *   }
   * Requires this entity to have a Collider2D — an entity with no
   * collider can never register as "under" the pointer.
   * MOUSE ONLY — a finger on a touchscreen does not move the mouse
   * cursor, so this never sees touches. For finger input use
   * this.isTouchOver below instead (or check both if you support mouse
   * AND touch: this.isPointerOver || this.isTouchOver).
   */
  get isPointerOver() {
    var hits = this._scriptApi._entitiesAtPoint(this._scriptApi._mouse.x, this._scriptApi._mouse.y);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i]._entity.id === this._entity.id) return true;
    }
    return false;
  }

  /**
   * True for exactly the one frame the left mouse button was pressed
   * while over THIS entity — the beginner-friendly "was I just
   * clicked" check, meant to be read inside onUpdate():
   *   function onUpdate() {
   *     if (this.isClicked) { this.destroy(); } // click to pop
   *   }
   * Same underlying hit-test as mouse.clickedOn("Name"), just phrased
   * as "did it happen to ME" instead of a name/tag lookup. For a
   * button other than left-click, use mouse.clickedOn(this.name, button)
   * instead.
   * MOUSE ONLY — see this.isTapped below for the finger/touchscreen
   * equivalent (or use this.isClicked || this.isTapped to support both
   * a mouse and a touchscreen with one check).
   */
  get isClicked() {
    if (!this._scriptApi._mouse.buttonsPressed.has(0)) return false;
    return this.isPointerOver;
  }

  /**
   * True while ANY active finger is currently over THIS entity's own
   * collider shape — the touch equivalent of this.isPointerOver above,
   * same real shape-accurate hit-test, just checked against every
   * finger on screen instead of a mouse cursor position:
   *   function onUpdate() {
   *     this.sprite.opacity = this.isTouchOver ? 1 : 0.6; // touch hover highlight
   *   }
   * Requires this entity to have a Collider2D. See touch.isOver("Name")
   * for the name/tag-lookup version of this same check.
   */
  get isTouchOver() {
    return this._touchIsOverSelf();
  }

  /** Internal — isTouchOver needs to confirm the hit is THIS entity
   *  specifically (not just any entity sharing its name), same way
   *  isPointerOver compares by id rather than by name/tag lookup. */
  _touchIsOverSelf() {
    for (var t of this._scriptApi._touches.values()) {
      var hits = this._scriptApi._entitiesAtPoint(t.x, t.y);
      for (var i = 0; i < hits.length; i++) {
        if (hits[i]._entity.id === this._entity.id) return true;
      }
    }
    return false;
  }

  /**
   * True for exactly the one frame a finger FIRST touched down while
   * over THIS entity — the touch equivalent of this.isClicked above,
   * the beginner-friendly "was I just tapped" check for mobile:
   *   function onUpdate() {
   *     if (this.isTapped) { this.destroy(); } // tap to pop
   *   }
   * Only counts the frame a finger STARTS on the entity (like a mouse
   * click), not every frame a finger happens to be resting on it — see
   * touch.tappedOn("Name") for the name/tag-lookup version.
   */
  get isTapped() {
    for (var t of this._scriptApi._touches.values()) {
      if (!this._scriptApi._touchesStarted.has(t.id)) continue;
      var hits = this._scriptApi._entitiesAtPoint(t.x, t.y);
      for (var i = 0; i < hits.length; i++) {
        if (hits[i]._entity.id === this._entity.id) return true;
      }
    }
    return false;
  }

  /**
   * Spawns a runtime copy of ANOTHER entity, positioned at (x, y) if
   * given (otherwise at the source's own position) — Unity's
   * Object.Instantiate(original, position) as an instance method, so
   * scripts can do this.spawn("Bullet", { x: this.x, y: this.y })
   * without needing the free global. Accepts a name/tag string (looked
   * up) OR an EntityContext directly — e.g. this.spawn(this) clones
   * THIS exact entity, no name involved at all, so there's never any
   * ambiguity from other entities sharing this one's name. See
   * ScriptAPI.spawn() for full behavior (source lookup, onClone/
   * onStart timing, isClone).
   * @param {string|EntityContext} nameOrTagOrEntity
   * @param {{x?:number, y?:number, name?:string, byTag?:boolean}} [opts]
   */
  spawn(nameOrTagOrEntity, opts) {
    return this._scriptApi.spawn(nameOrTagOrEntity, opts);
  }

  /**
   * Runs `callback` once, after `seconds` of game time, with `this`
   * bound back to THIS entity — the instance-method form of the global
   * wait(), for scripts that prefer this.wait(...) to the bare global:
   *   this.wait(2, function () { this.visible = false; });
   * Same auto-cancel-on-destroy/restart/scene-switch behavior as the
   * global. See ScriptAPI.wait() for full details.
   * @param {number} seconds
   * @param {function} callback
   * @returns {number} timer id usable with cancelWait()/this.cancelWait()
   */
  wait(seconds, callback) {
    return this._scriptApi.wait(seconds, callback);
  }

  /**
   * Cancels a pending timer started by wait()/this.wait(). No-op if it
   * already fired or was already cancelled.
   * @param {number} timerId
   */
  cancelWait(timerId) {
    this._scriptApi.cancelWait(timerId);
  }

  /**
   * Runs `callback` every `seconds`, forever, starting `seconds` from
   * now — the instance-method form of the global repeat():
   *   this.repeat(2, function () { this.hp += 1; }); // regen over time
   * Same auto-cancel-on-destroy/restart/scene-switch behavior as
   * wait(). See ScriptAPI.repeat() for full details, and cancelRepeat()/
   * this.cancelRepeat() to stop it early.
   * @param {number} seconds
   * @param {function} callback
   * @returns {number} timer id usable with cancelRepeat()/this.cancelRepeat()
   */
  repeat(seconds, callback) {
    return this._scriptApi.repeat(seconds, callback);
  }

  /**
   * Stops a repeat() started by this entity. No-op if it was already
   * cancelled. Commonly called from inside the repeat's OWN callback
   * once some condition is met:
   *   var id = this.repeat(1, function () {
   *     this.hp -= 1;
   *     if (this.hp <= 0) this.cancelRepeat(id);
   *   });
   * @param {number} timerId
   */
  cancelRepeat(timerId) {
    this._scriptApi.cancelRepeat(timerId);
  }

  // NOTE: velocity, sprite (texture/color/flip/opacity), and rigidbody
  // physics (isGrounded, addForce, move, etc.) are intentionally NOT
  // duplicated here as this.<x> shortcuts. Each lives in exactly ONE
  // place: this.rigidbody.* (scripting/components/RigidbodyAPI.js) and
  // this.sprite.* (scripting/components/SpriteAPI.js). Rigidbody in
  // particular exposes a DIFFERENT shape per body type (Dynamic/
  // Kinematic/Static) — a flat this.addForce() shortcut here would
  // either have to duplicate that per-body-type logic or risk
  // diverging from it, giving scripts two ways to do the same thing
  // that could behave differently from one another. Use
  // this.rigidbody.addForce(), this.rigidbody.velocity,
  // this.sprite.texture, etc. instead. (this.x/y/position and friends
  // above stay as shortcuts because Transform has only one shape
  // regardless of entity state, and other.x/other.y in
  // onCollision(other) depends on them.)

  // --- Sub-objects (built once, read live data via closures) ---

  _buildSubObjects() {
    var entity = this._entity;

    // Transform is always present on every entity — always attach it.
    this.transform = createTransformAPI(entity);

    // Every other sub-object is attached ONLY when the entity actually has that
    // component. Absent sub-objects are undefined, so scripts can safely branch:
    //   if (this.rigidbody) { this.rigidbody.addForce(0, -500); }
    // This also means autocomplete correctly reflects what the object can do:
    // a Static-body entity won't offer addForce(), a sprite-less entity won't
    // offer this.sprite.texture, and so on — matching the Inspector exactly.
    this.sprite      = entity.hasComponent(SPRITE_RENDERER)     ? createSpriteAPI(entity)      : undefined;
    this.shape       = entity.hasComponent(SHAPE_RENDERER)      ? createShapeAPI(entity)       : undefined;
    this.text        = entity.hasComponent(TEXT_RENDERER)       ? createTextAPI(entity)        : undefined;
    this.speechBubble = entity.hasComponent(SPEECH_BUBBLE)      ? createSpeechBubbleAPI(entity) : undefined;
    this.chat        = entity.hasComponent(CHAT_LOG)            ? createChatLogAPI(entity)     : undefined;
    this.textInput   = entity.hasComponent(TEXT_INPUT)          ? createTextInputAPI(entity)   : undefined;
    this.joystick    = entity.hasComponent(JOYSTICK)             ? createJoystickAPI(entity)    : undefined;
    this.rigidbody   = entity.hasComponent(RIGIDBODY_2D)        ? createRigidbodyAPI(entity)   : undefined;
    this.animator    = entity.hasComponent(SPRITE_ANIMATION)    ? createAnimatorAPI(entity)    : undefined;
    this.camera      = entity.hasComponent(CAMERA)              ? createCameraAPI(entity)      : undefined;
    this.audio       = entity.hasComponent(AUDIO_SOURCE)        ? createAudioAPI(entity)       : undefined;
    // Movement-type-aware — ControllerAPI.js exposes isGrounded/simulateJump
    // ONLY for Character Controller/Platformer, car tunables ONLY for Car, etc.
    this.controller  = entity.hasComponent(CHARACTER_CONTROLLER)? createControllerAPI(entity)  : undefined;
    this.collider    = entity.hasComponent(COLLIDER_2D)          ? createColliderAPI(entity, this._scriptApi) : undefined;
    this.joint       = entity.hasComponent(JOINT_2D)             ? createJointAPI(entity, this._scriptApi)    : undefined;
    // this.navAgent — component-gated like everything else above. See
    // NavAgentAPI.js for why every field here is read/write (unlike
    // this.collider, which is read-only).
    this.navAgent    = entity.hasComponent(NAV_AGENT_2D)         ? createNavAgentAPI(entity)    : undefined;
    this.light       = entity.hasComponent(LIGHT)                ? createLightAPI(entity)       : undefined;
    // this.shadowCaster — component-gated like everything else above.
    // See ShadowCasterAPI.js for why every field here is read/write.
    this.shadowCaster = entity.hasComponent(SHADOW_CASTER)       ? createShadowCasterAPI(entity) : undefined;
    this.strokePath  = entity.hasComponent(STROKE_PATH)          ? createStrokePathAPI(entity)  : undefined;
    // this.ear — component-gated like everything else above.
    this.ear         = entity.hasComponent(AUDIO_LISTENER)       ? createAudioListenerAPI(entity, this._scriptApi) : undefined;

    // this.state — deliberately UNCONDITIONAL, unlike every sub-object
    // above: state needs no component, it works on every entity (see
    // StateAPI.js's header comment). changeFn is bound here (not left
    // for StateAPI to look up itself) so StateAPI never needs to import
    // ScriptSystem — same decoupling every other _xFn closure in this
    // file already keeps (see _sendMessageFn/_waitFn wiring in
    // ScriptSystem's constructor for the general pattern). Guarded with
    // a fallback no-op in case a script is compiled before ScriptSystem
    // has finished wiring _fireStateChangeFn (mirrors wait()'s identical
    // this._waitFn ? ... : -1 guard below).
    const self = this;
    this.state = createStateAPI(this, function (name) {
      if (self._scriptApi._fireStateChangeFn) {
        self._scriptApi._fireStateChangeFn(self._entity.id, name, self);
      }
    });

    // this.myTouch — also deliberately UNCONDITIONAL, same reasoning as
    // this.state above: no component needed, works on every entity.
    // Locks onto one finger by id and tracks it — see
    // TouchTrackAPI.js's header comment.
    this.myTouch = createTouchTrackAPI(this);
  }

  /**
   * Straight-line distance from this entity's Transform to a given
   * world-space point — the flat-shortcut companion to this.x/this.y
   * (Transform has only one shape, same reasoning as every other
   * Transform shortcut in this class — see the "ONE API PER
   * CAPABILITY" note at the top of this file for why sub-objects like
   * this.rigidbody don't get a similar flat duplicate).
   *   if (this.distanceTo(player.x, player.y) < 100) { this.state.change("chasing"); }
   * @param {number} x
   * @param {number} y
   * @returns {number}
   */
  distanceTo(x, y) {
    const dx = this.x - x;
    const dy = this.y - y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}

export class ScriptAPI {
  /**
   * @param {import('../core/World.js').World} world
   */
  constructor(world) {
    this.world = world;
    this._globals = new Map();
    /** @type {Map<string, EntityContext>} cached per-entity contexts */
    this._contexts = new Map();

    /**
     * Backs NavAgent2D "collab" surround steering (see EntityContext.
     * _applyNavCollab() in this file) — a tiny per-entity-id map of
     * "where is this agent CURRENTLY trying to go", published by every
     * navMoveToward() call so OTHER collabEnabled agents evaluating
     * their own group this same tick can see it, without agents needing
     * any direct reference to each other. Keyed by entity id (not the
     * EntityContext itself — ids are stable and cheap to compare, see
     * EntityContext.id's doc comment). Each entry is
     * { x, y, time } — `time` is this.time.elapsed at publish, used by
     * _peekNavGoal() to ignore stale entries from an agent that stopped
     * calling navMoveToward (destroyed, script disabled, target lost)
     * instead of letting it keep "holding" a group slot forever.
     * Cleared on scene restart/switch by clearContexts() below, same as
     * every other per-scene script state on this class.
     * @type {Map<string, {x:number,y:number,time:number}>}
     */
    this._navGoals = new Map();

    /**
     * Backs the `save` global (see components/SaveAPI.js and
     * SaveStore.js) — persistent, per-slot key/value storage in
     * IndexedDB, as opposed to `global` above which is memory-only
     * for the current session. gameId is set via
     * scriptApi.saveStore.gameId = ... by createGame() in
     * runtime/index.js (which receives it as an option), BEFORE
     * save.load("default") is kicked off there — see that file for
     * the exact boot order. Defaulting to "default" here just means
     * a caller who skips the option still gets a working, if
     * unnamespaced, save database instead of a crash.
     */
    this.saveStore = new SaveStore("default");

    // Input state
    this._keysDown = new Set();
    this._keysPressed = new Set();

    /**
     * Mouse/pointer state. World-space x/y are recomputed every time the
     * pointer moves (see attachPointerInput below) by inverting
     * worldContainer's live transform — so they stay correct through
     * camera pan/zoom/rotation and window resizing without this class
     * needing to know anything about cameras itself.
     * buttonsDown/buttonsPressed/buttonsReleased mirror the
     * keysDown/keysPressed pattern: "Pressed"/"Released" are one-frame
     * pulses, cleared at the end of every frame by _clearFrameKeys().
     * Button numbers match the DOM's e.button (0=left, 1=middle, 2=right).
     */
    this._mouse = {
      x: 0, y: 0,               // world-space, updated live as the pointer moves
      screenX: 0, screenY: 0,   // canvas-pixel space (0,0 = top-left of the game view)
      buttonsDown: new Set(),
      buttonsPressed: new Set(),
      buttonsReleased: new Set(),
      /** True while the pointer is anywhere over the game canvas at all. */
      over: false,
    };

    /**
     * Active touches, keyed by the browser's own pointerId/identifier so
     * a specific finger can be tracked across move events even with
     * several fingers down at once. Each entry:
     *   { id, x, y, screenX, screenY, startX, startY }
     * world x/y computed the same way mouse.x/y are. startX/startY are
     * WORLD-space too, captured once at touchstart, so scripts can
     * measure a swipe/drag distance without storing anything themselves:
     *   touch.x - touch.startX
     * @type {Map<number, object>}
     */
    this._touches = new Map();
    /** Touch ids that just went down this frame (one-frame pulse, like
     *  buttonsPressed) — lets `touch.justStarted` work without the
     *  script tracking previous-frame state itself. */
    this._touchesStarted = new Set();
    /** Touch ids that were just lifted/cancelled this frame. Kept ONE
     *  frame after removal from _touches so a script reading
     *  touch.justEnded during onUpdate still sees it — cleared at the
     *  same point buttonsPressed/keysPressed are. */
    this._touchesEnded = new Set();
    /** Snapshot of each ended touch's last-known data (position, startX/Y,
     *  etc.) so touch.justEnded entries still have valid coords the frame
     *  they end — they've already been removed from _touches by then. */
    this._touchesEndedData = new Map();

    /**
     * BUG FIX — THE `touch` GLOBAL WAS FROZEN FOREVER AT SCRIPT START:
     * getGlobals() is only called ONCE per entity, when its script is
     * compiled (see ScriptSystem._initEntityScripts) — the values it
     * returns are passed as plain parameters into `new Function(...)`,
     * so whatever a parameter's value IS at that single call becomes
     * the script's permanent local binding for the whole life of the
     * scene. That's fine for `mouse`/`input`, because those are STABLE
     * objects whose individual properties are getters reading live
     * `self._mouse`/`self._keysDown` state on every access — the outer
     * object reference never changes, only what its getters return.
     * `touch` used to break that pattern: it was itself a top-level
     * `get touch()` that built and returned a BRAND NEW plain array
     * every time it was read. Read once at script-start (before any
     * finger had ever touched the screen), it produced one empty,
     * inert snapshot array — with plain (non-getter) `.count`/`.first`/
     * etc. properties baked in — that got handed to the script and
     * then NEVER recomputed again. Every onUpdate() after that read
     * the exact same dead object: `touch.count` was always 0,
     * `touch.first` was always null, no matter how many fingers were
     * actually on the glass. This is what made mobile touch look
     * completely non-functional from script code.
     *
     * The fix mirrors `mouse`: keep ONE persistent array instance for
     * the whole scene (this field) and mutate it IN PLACE every frame
     * (see _recomputeTouchGlobal(), called by ScriptSystem.update()
     * before scripts run) instead of allocating a new array each read.
     * getGlobals() below now hands out a direct reference to THIS
     * array rather than a getter — since the array's contents are
     * refreshed in place, the script's one-time-bound `touch` variable
     * still sees current data on every frame, exactly like `mouse`.
     */
    this._touchGlobal = [];

    // touch.isOver()/touch.tappedOn() — the name/tag-lookup touch
    // equivalents of mouse.isOver()/mouse.clickedOn(), set ONCE (not
    // inside _recomputeTouchGlobal()'s per-frame refresh — these are
    // functions, not per-frame data, and they already read live state
    // through the `self` closure on every CALL, exactly like
    // mouse.isOver/mouse.clickedOn do). Safe to attach once: the
    // per-frame refresh only clears the array's indexed entries
    // (list.length = 0) and re-sets its data properties — it never
    // touches unrelated named properties like these.
    var touchApiSelf = this;
    /**
     * True if ANY currently active finger is over the given entity —
     * the touch equivalent of mouse.isOver(). Accepts a name/tag
     * string (matches the FIRST entity with that name/tag) OR an
     * EntityContext directly, for an exact, unambiguous check:
     *   if (touch.isOver("Button")) { ... }
     *   if (touch.isOver(door)) { ... }
     */
    this._touchGlobal.isOver = function (nameOrTagOrEntity, opts) {
      return touchApiSelf._entityUnderTouch(nameOrTagOrEntity, opts) !== null;
    };
    /**
     * True the SAME FRAME a finger FIRST touched down over the given
     * entity — the touch equivalent of mouse.clickedOn(), the "I
     * tapped this specific thing" check. Accepts a name/tag string OR
     * an EntityContext directly, same as isOver() above:
     *   if (touch.tappedOn("Button")) { scene.load("Level1"); }
     *   if (touch.tappedOn(door)) { ... }
     * Only counts the frame a finger starts on the entity (like a
     * click), not every frame a finger happens to be resting on it.
     */
    this._touchGlobal.tappedOn = function (nameOrTagOrEntity, opts) {
      opts = Object.assign({}, opts, { justStarted: true });
      return touchApiSelf._entityUnderTouch(nameOrTagOrEntity, opts) !== null;
    };

    // Seed count/first/swipe/pinch etc. right away — see
    // _recomputeTouchGlobal() — so a read before the first frame's
    // refresh (defensive; ScriptSystem.update() always refreshes before
    // any script code runs in the normal path) still sees a real
    // 0/null baseline instead of undefined fields on a bare array.
    this._recomputeTouchGlobal();

    /** Updated by ScriptSystem each frame */
    this.time = { deltaTime: 0, unscaledDeltaTime: 0, elapsed: 0 };
    // time.scale — game speed multiplier (like Unity's Time.timeScale).
    // GameLoop reads it every frame and multiplies the frame's dt by it, so
    // physics, animation, wait()/repeat() timers, property tweens,
    // onUpdate/onFixedUpdate and time.deltaTime/elapsed all speed up or slow down together; input,
    // rendering and the editor are not affected. 0 freezes gameplay time
    // (scripts still run with deltaTime 0). Kept as an accessor so bad
    // values (NaN, negative, strings) are rejected here instead of
    // corrupting the loop.
    let _timeScale = 1;
    Object.defineProperty(this.time, "scale", {
      enumerable: true,
      configurable: false,
      get() { return _timeScale; },
      set(v) {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n) || n < 0) {
          console.warn("time.scale must be a number >= 0 (got " + String(v) + "); keeping " + _timeScale + ".");
          return;
        }
        _timeScale = Math.min(n, 100);
      },
    });

    /**
     * Debug overlay state, driven by the `debug` global exposed to
     * scripts (see getGlobals() below). The play popup (play-popup.js)
     * polls `scriptApi.debugState` every frame to render/hide the HUD —
     * this class only tracks the data, it never touches the DOM itself
     * (ScriptAPI is shared by the editor too, which has no game HUD).
     */
    this.debugState = {
      enabled: false,
      showFps: true,
      stats: new Map(), // custom key -> value pairs from debug.log()
      /** Debug line segments drawn this frame (cleared each frame).
       *  Each entry: { x1,y1,x2,y2, color, hitPoint:{x,y}|null }
       *  Populated by physics.raycast(…,{debug:true}) and rendered by
       *  the player/popup's onTick using PIXI.Graphics in world space. */
      debugLines: [],
    };

    /** Set by createGame to enable scene.restart() */
    this._restartFn = null;
    /** Set by createGame to enable scene.load() */
    this._loadSceneFn = null;
    /** Set by createGame to enable scene.pause() — see GameLoop.pause() */
    this._pauseFn = null;
    /** Set by createGame to enable scene.resume() — see GameLoop.resume() */
    this._resumeFn = null;
    /** Set by createGame to enable scene.isPaused — see GameLoop.isPaused */
    this._isPausedFn = null;
    /** Set by ScriptSystem constructor to enable sendMessage(tag, msg, data) */
    this._sendMessageFn = null;
    /** Set by ScriptSystem constructor to enable broadcastMessage(msg, data) */
    this._broadcastMessageFn = null;
    /** Set by ScriptSystem constructor to enable wait(seconds, callback) */
    this._waitFn = null;
    /** Set by ScriptSystem constructor to enable cancelWait(timerId) */
    this._cancelWaitFn = null;
    /** Set by ScriptSystem constructor to enable repeat(seconds, callback) */
    this._repeatFn = null;
    /** Set by ScriptSystem constructor to enable cancelRepeat(timerId) */
    this._cancelRepeatFn = null;
    /** Set by ScriptSystem constructor to enable tween(target, properties, ...) */
    this._tweenFn = null;
    /** Set by ScriptSystem constructor to enable cancelTween(tweenId) */
    this._cancelTweenFn = null;
    /** Set by ScriptSystem constructor (bound fireStateChange) to back
     *  every entity's this.state.change(name) — see StateAPI.js and
     *  EntityContext's constructor above. */
    this._fireStateChangeFn = null;
    /** Set by createGame (bound AudioListenerSystem.getInRange) to back
     *  this.ear.sourcesInRange/canHear() — see AudioListenerAPI.js. */
    this._audioListenerRangeFn = null;
    /** Set by createGame to enable mouse.clickedOn()/isOver() and
     *  this.isClicked/this.isPointerOver — a (x, y) -> entityId[]
     *  function backed by PhysicsWorld.entityAtPoint (real Rapier
     *  shape queries, not a bounding-box guess). null until physics
     *  finishes loading OR outside a play/editor context that wires it
     *  (e.g. running scripts isn't possible at all without this, so in
     *  practice this is always set before any script runs — kept
     *  nullable defensively, same as every other _*Fn hook here). */
    this._physicsHitTestFn = null;
    /** Set by createGame to enable physics.raycast() with real Rapier
     *  shape queries. (x1,y1,x2,y2,opts) -> { entityId, point, normal, distance } | null */
    this._physicsRaycastFn = null;
    /** Optional PhysicsWorld hook for immediate grounded Kinematic rotation
     *  support preservation. */
    this._kinematicRotationFn = null;
    /** Set by createGame to enable this.collider.isColliding()/isColliding
     *  (other) — see ColliderAPI.js. (entityId, otherEntityId?) -> boolean,
     *  backed by PhysicsWorld.isColliding (reads the same solid-contact
     *  tracking onCollisionStay's per-frame dispatch already reads). */
    this._isCollidingFn = null;
    /** Set by createGame to enable nav.findPath() — see
     *  systems/NavWorldSystem.js for the real implementation this
     *  forwards to. (startX,startY,goalX,goalY,radius?,area?) -> {x,y}[]
     *  | null. Uses the FIRST NavWorld2D entity in the scene (see
     *  NavWorldSystem._firstNavWorld's doc comment on the one-per-scene
     *  convention) — same "no entity argument needed" shape as
     *  physics.raycast(), which likewise never asks a script to name
     *  which PhysicsWorld to use. `radius` defaults to 0 (the base
     *  unpadded layer), `area` defaults to 0xffff (every area allowed);
     *  this.navMoveToward() passes its NavAgent2D's radius and area
     *  automatically — see that method. */
    this._navFindPathFn = null;
    /** Set by createGame to enable nav.isWalkable(x,y) -> boolean. */
    this._navIsWalkableFn = null;
    /** Set by createGame: per-agent (radius+area) walkability check used
     *  by EntityContext._escapeDisallowedArea() to tell "this agent's
     *  own spot is illegal for its radius/area" apart from a merely
     *  unreachable goal — see that method's doc comment. */
    this._navIsWalkableForAgentFn = null;
    /** Set by createGame: nearest point a given (radius, area) agent
     *  could legally stand near (x, y) — backs the same recovery. */
    this._navNearestWalkableFn = null;
    /** Set by createGame to enable nav.bake() -> {walkable,blocked}|null.
     *  Exposed to scripts mainly for a procedurally-generated level that
     *  needs to re-bake after spawning its own obstacles at runtime —
     *  most games bake once in the editor and never call this. */
    this._navBakeFn = null;
    /** Set by createGame from the project's editor Edit → Nav Areas…
     *  registry (editor/state/NavAreas.js's getNavAreaNames()), threaded
     *  through the same way gameFps travels (PlayWindow.js →
     *  play-popup.js → createGame()) — a NAV_AREA_COUNT-length array of
     *  slot names, or null in contexts that never wired it through (e.g.
     *  an older exported build). Backs nav.areaIndex()/nav.areaMask() so
     *  scripts can refer to areas by the same names the editor shows,
     *  instead of hand-writing bit positions. See NavAPI.js's
     *  resolveNavAreaIndex/resolveNavAreaMask for the actual lookup. */
    this._navAreaNames = null;

    this._setupInput();
  }

  _setupInput() {
    if (typeof window === "undefined") return;
    var self = this;
    window.addEventListener("keydown", function (e) {
      // Track both e.key (e.g. " ", "a", "ArrowLeft") and e.code (e.g. "Space", "KeyA")
      if (!self._keysDown.has(e.code)) {
        self._keysPressed.add(e.code);
      }
      if (!self._keysDown.has(e.key)) {
        self._keysPressed.add(e.key);
      }
      self._keysDown.add(e.key);
      self._keysDown.add(e.code);
    });
    window.addEventListener("keyup", function (e) {
      self._keysDown.delete(e.key);
      self._keysDown.delete(e.code);
    });
    window.addEventListener("blur", function () {
      self._keysDown.clear();
      // A window losing focus mid-drag/click is exactly like alt-tabbing
      // mid-keypress — the browser will never send the matching
      // mouseup/touchend, so without this a button/finger could get
      // stuck "down" forever from the game's point of view.
      self._mouse.buttonsDown.clear();
      self._touches.clear();
    });
  }

  /**
   * Wires up mouse + touch input against the actual game canvas. Called
   * once by createGame() (runtime/index.js) — NOT from the constructor,
   * because unlike keyboard input (which listens on `window` and needs
   * nothing else) pointer input needs to know both WHICH canvas is the
   * game view and how to convert a screen pixel into a world position,
   * and neither of those exists yet at ScriptAPI construction time.
   *
   * @param {HTMLCanvasElement} canvas the PIXI Application's own canvas (pixiApp.view)
   * @param {import('../systems/RenderSystem.js').RenderSystem} renderSystem
   *   used for renderSystem.worldContainer.toLocal(...) — the SAME live
   *   PIXI transform (pan/zoom/rotation/camera-follow) sprites are
   *   already drawn through, so mouse.x/y always land exactly where the
   *   sprite under the cursor visually is, with no coordinate math
   *   duplicated here that could drift out of sync with rendering.
   */
  attachPointerInput(canvas, renderSystem) {
    if (!canvas || typeof window === "undefined") return;
    var self = this;

    /**
     * Converts clientX/clientY into screen-pixel and world-space coords.
     * Used by both mouse and touch paths.
     */
    function toCoords(clientX, clientY) {
      var c = clientToLocal(
        clientX,
        clientY,
        canvas,
        renderSystem && renderSystem.pixiApp,
        renderSystem && renderSystem.worldContainer
      );
      return { screenX: c.screenX, screenY: c.screenY, worldX: c.x, worldY: c.y };
    }

    function isTouchPointer(e) {
      return e.pointerType === "touch" || e.pointerType === "pen";
    }

    // ── Mouse input (pointer events, non-touch only) ──────────────────
    canvas.addEventListener("pointermove", function (e) {
      if (isTouchPointer(e)) return; // touch/pen handled by the touch path below
      var c = toCoords(e.clientX, e.clientY);
      self._mouse.x = c.worldX;
      self._mouse.y = c.worldY;
      self._mouse.screenX = c.screenX;
      self._mouse.screenY = c.screenY;
      self._mouse.over = true;
    });
    canvas.addEventListener("pointerleave", function (e) {
      if (!isTouchPointer(e)) self._mouse.over = false;
    });
    canvas.addEventListener("pointerover", function (e) {
      if (!isTouchPointer(e)) self._mouse.over = true;
    });
    canvas.addEventListener("pointerdown", function (e) {
      if (isTouchPointer(e)) return;
      var c = toCoords(e.clientX, e.clientY);
      self._mouse.x = c.worldX;
      self._mouse.y = c.worldY;
      self._mouse.screenX = c.screenX;
      self._mouse.screenY = c.screenY;
      self._mouse.over = true;
      self._mouse.buttonsDown.add(e.button);
      self._mouse.buttonsPressed.add(e.button);
    });
    canvas.addEventListener("pointerup", function (e) {
      if (isTouchPointer(e)) return;
      self._mouse.buttonsDown.delete(e.button);
      self._mouse.buttonsReleased.add(e.button);
    });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    // Prevent the browser (and OS touchpad) from pinch-zooming the page
    // while the game is running. On laptops, a two-finger pinch on the
    // touchpad arrives as a wheel event with ctrlKey=true — stopping it
    // here keeps the viewport locked at 100% regardless of what the
    // player's hands do on the trackpad.
    canvas.addEventListener("wheel", function (e) {
      if (e.ctrlKey) e.preventDefault();
    }, { passive: false });

    // ── Native touch/pointer input ────────────────────────────────────
    // Do not make mobile input depend on Hammer's backend choice. Older
    // Android WebViews expose Touch Events, newer ones expose Pointer Events,
    // and some hybrid devices expose both. Native input is the source of
    // truth here; swipe and pinch are derived from the live touch map below.
    prepareGameCanvas(canvas);

    function touchStart(id, clientX, clientY) {
      var c = toCoords(clientX, clientY);
      self._touches.set(id, {
        id: id,
        x: c.worldX, y: c.worldY,
        screenX: c.screenX, screenY: c.screenY,
        startX: c.worldX, startY: c.worldY,
      });
      self._touchesStarted.add(id);
    }

    function touchMove(id, clientX, clientY) {
      if (!self._touches.has(id)) return;
      var c = toCoords(clientX, clientY);
      var entry = self._touches.get(id);
      entry.x = c.worldX; entry.y = c.worldY;
      entry.screenX = c.screenX; entry.screenY = c.screenY;
    }

    function touchEnd(id) {
      if (!self._touches.has(id)) return;
      self._touchesEndedData.set(id, Object.assign({}, self._touches.get(id)));
      self._touches.delete(id);
      self._touchesEnded.add(id);
    }

    if (typeof window.PointerEvent === "function") {
      canvas.addEventListener("pointerdown", function (e) {
        if (!isTouchPointer(e)) return;
        e.preventDefault();
        if (canvas.setPointerCapture) {
          try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        }
        touchStart(e.pointerId, e.clientX, e.clientY);
      }, { passive: false });
      canvas.addEventListener("pointermove", function (e) {
        if (!isTouchPointer(e)) return;
        e.preventDefault();
        touchMove(e.pointerId, e.clientX, e.clientY);
      }, { passive: false });
      function pointerTouchEnd(e) {
        if (!isTouchPointer(e)) return;
        e.preventDefault();
        touchEnd(e.pointerId);
        if (canvas.releasePointerCapture) {
          try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      }
      canvas.addEventListener("pointerup", pointerTouchEnd, { passive: false });
      canvas.addEventListener("pointercancel", pointerTouchEnd, { passive: false });
    } else {
      canvas.addEventListener("touchstart", function (e) {
        e.preventDefault();
        for (var i = 0; i < e.changedTouches.length; i++) {
          var t = e.changedTouches[i];
          touchStart(t.identifier, t.clientX, t.clientY);
        }
      }, { passive: false });
      canvas.addEventListener("touchmove", function (e) {
        e.preventDefault();
        for (var i = 0; i < e.changedTouches.length; i++) {
          var t = e.changedTouches[i];
          touchMove(t.identifier, t.clientX, t.clientY);
        }
      }, { passive: false });
      function rawTouchEnd(e) {
        e.preventDefault();
        for (var i = 0; i < e.changedTouches.length; i++) {
          touchEnd(e.changedTouches[i].identifier);
        }
      }
      canvas.addEventListener("touchend", rawTouchEnd, { passive: false });
      canvas.addEventListener("touchcancel", rawTouchEnd, { passive: false });
    }
  }

  /**
   * Rebuilds this._touchGlobal (the exact array reference exposed to
   * scripts as the `touch` global — see the comment on that field in
   * the constructor) IN PLACE: clears it, then re-pushes one entry per
   * active/just-ended finger and re-derives the array-level extras
   * (count/first/anyJustStarted/anyJustEnded/swipe/pinch), same shape
   * and math this used to compute inline inside the old `get touch()`.
   * Mutating the SAME array every time (instead of returning a new one)
   * is what makes a script's one-time-bound `touch` variable see fresh
   * data on every onUpdate() — see the BUG FIX comment above
   * this._touchGlobal for why that distinction matters.
   *
   * Called once per frame by ScriptSystem.update(), BEFORE both the
   * fixed-update and regular onUpdate passes, so every script callback
   * that runs this frame observes the same touch snapshot — matching
   * how keyPressed/mouse.pressed pulses are only cleared once per frame
   * (at the very end, via _clearFrameKeys()) rather than mid-frame.
   */
  _recomputeTouchGlobal() {
    var self = this;
    var list = this._touchGlobal;
    list.length = 0; // clear in place — keeps the same array reference

    // Active (currently down) touches.
    for (var t of self._touches.values()) {
      var dx = t.x - t.startX;
      var dy = t.y - t.startY;
      list.push({
        id: t.id,
        x: t.x, y: t.y,
        screenX: t.screenX, screenY: t.screenY,
        startX: t.startX, startY: t.startY,
        dx: dx, dy: dy,
        distance: Math.sqrt(dx * dx + dy * dy),
        justStarted: self._touchesStarted.has(t.id),
        justEnded: false,
      });
    }

    // Just-ended touches (one frame only, so scripts can read final pos).
    for (var endedId of self._touchesEnded) {
      var te = self._touchesEndedData.get(endedId);
      if (!te) continue;
      var edx = te.x - te.startX;
      var edy = te.y - te.startY;
      list.push({
        id: te.id,
        x: te.x, y: te.y,
        screenX: te.screenX, screenY: te.screenY,
        startX: te.startX, startY: te.startY,
        dx: edx, dy: edy,
        distance: Math.sqrt(edx * edx + edy * edy),
        justStarted: false,
        justEnded: true,
      });
    }

    // Array-level convenience properties.
    list.count = self._touches.size; // only currently-down fingers
    list.first = list.length > 0 ? list[0] : null;
    list.anyJustStarted = self._touchesStarted.size > 0;
    list.anyJustEnded = self._touchesEnded.size > 0;

    // ── Swipe gesture ──────────────────────────────────────────────
    // Detected when a SINGLE active finger has moved more than
    // SWIPE_THRESHOLD world-space pixels from its touch-down point.
    // Direction is the dominant (larger) axis: left/right/up/down.
    var SWIPE_THRESHOLD = 40;
    var swipe = { active: false, direction: null, dx: 0, dy: 0, distance: 0 };
    if (self._touches.size === 1) {
      var ft = list[0];
      if (ft && !ft.justEnded && ft.distance >= SWIPE_THRESHOLD) {
        swipe.active = true;
        swipe.dx = ft.dx;
        swipe.dy = ft.dy;
        swipe.distance = ft.distance;
        if (Math.abs(ft.dx) >= Math.abs(ft.dy)) {
          swipe.direction = ft.dx > 0 ? "right" : "left";
        } else {
          swipe.direction = ft.dy > 0 ? "down" : "up";
        }
      }
    }
    list.swipe = swipe;

    // ── Pinch gesture ──────────────────────────────────────────────
    // Detected while EXACTLY two fingers are on screen. scale is the
    // ratio of the current distance between the two fingers vs the
    // distance at the time they both touched down; delta is the raw
    // pixel change (positive = spreading/zooming out).
    var pinch = { active: false, scale: 1, delta: 0, distance: 0 };
    if (self._touches.size >= 2) {
      var touches = Array.from(self._touches.values());
      var p1 = touches[0], p2 = touches[1];
      var curDist = Math.sqrt(
        (p1.x - p2.x) * (p1.x - p2.x) + (p1.y - p2.y) * (p1.y - p2.y)
      );
      var startDist = Math.sqrt(
        (p1.startX - p2.startX) * (p1.startX - p2.startX) +
        (p1.startY - p2.startY) * (p1.startY - p2.startY)
      );
      pinch.active = true;
      pinch.distance = curDist;
      pinch.delta = curDist - startDist;
      pinch.scale = startDist > 0.5 ? curDist / startDist : 1;
    }
    list.pinch = pinch;
  }

  /** Called by ScriptSystem at the end of each frame — clears every
   *  one-frame "pulse" flag (keyPressed, mouse.pressed/released,
   *  touch.justStarted/justEnded) so each only reads true for the
   *  single frame the event actually happened on. */
  _clearFrameKeys() {
    this._keysPressed.clear();
    this._mouse.buttonsPressed.clear();
    this._mouse.buttonsReleased.clear();
    this._touchesStarted.clear();
    this._touchesEnded.clear();
    this._touchesEndedData.clear();
  }

  /**
   * Finds every entity with the given tag and returns live EntityContexts.
   * The returned array is a snapshot of the matching objects at call time;
   * each context still reads and writes the live entity.
   */
  findWithTag(tag) {
    var entities = this.world && this.world.findByTag ? this.world.findByTag(tag) : [];
    return entities.map((entity) => this.createEntityContext(entity));
  }

  // --- Explicit find-by-name / find-by-tag pair ---
  //
  // findWithTag() (above) is unchanged and keeps working exactly as
  // before. These four give lookups explicit, unambiguous names,
  // in matched first/all pairs, so a script never has to guess whether
  // findFirst("Enemy") returns one object or many, or reach for a byTag flag
  // to search by tag instead of name:
  //   findFirst("Enemy")      -> first entity named "Enemy", or null
  //   findAll("Enemy")        -> every entity named "Enemy" (array)
  //   findFirstWithTag("Foe") -> first entity tagged "Foe", or null
  //   findAllWithTag("Foe")   -> every entity tagged "Foe" (array)

  /** Find the first entity with the given NAME. Returns an EntityContext,
   *  or null if none match. */
  findFirst(name) {
    var entity = this.world.findFirst ? this.world.findFirst(name) : this.world.findFirstByName(name);
    if (!entity) return null;
    return this.createEntityContext(entity);
  }

  /** Find every entity with the given NAME. Returns an array of live
   *  EntityContexts (empty array if none match — never null, so a
   *  script can always safely .forEach()/.length it). */
  findAll(name) {
    var entities = this.world && this.world.findAll ? this.world.findAll(name) : [];
    return entities.map((entity) => this.createEntityContext(entity));
  }

  /**
   * Find the entity with the given stable id (see EntityContext's `id`
   * getter for what makes this different from/more reliable than
   * findFirst(name) or findFirstWithTag(tag)). Returns an EntityContext,
   * or null if no entity has that id — including if it once did, but
   * that entity has since been destroyed. There is at most ONE entity
   * with any given id, ever, so unlike findFirst/findFirstWithTag there
   * is no "byTag"-style ambiguity and no findAllById counterpart needed.
   *   var bullet = spawn("Bullet", { x: this.x, y: this.y });
   *   var id = bullet.id;
   *   // ...later...
   *   var sameBullet = findById(id); // null if it was destroyed by then
   */
  findById(id) {
    var entity = this.world && this.world.getEntity ? this.world.getEntity(id) : null;
    if (!entity) return null;
    return this.createEntityContext(entity);
  }

  /** Find the first entity with the given TAG. Returns an EntityContext,
   *  or null if none match. */
  findFirstWithTag(tag) {
    var entity = this.world && this.world.findFirstWithTag ? this.world.findFirstWithTag(tag) : null;
    if (!entity) return null;
    return this.createEntityContext(entity);
  }

  /** Find every entity with the given TAG. Same lookup as findWithTag()
   *  — this is just the name that matches findFirstWithTag() above. */
  findAllWithTag(tag) {
    return this.findWithTag(tag);
  }

  /**
   * Find every entity within `radius` world units of the point (x, y),
   * optionally narrowed to a NAME or a TAG — the distance-search
   * counterpart to findAll()/findAllWithTag() above. Always returns an
   * array (empty if nothing matches — never null, same convention as
   * every other findAll* here), sorted nearest-first so the common
   * "find the CLOSEST thing" case is just `findInRadius(...)[0]`.
   *
   * opts.name and opts.tag are mutually exclusive — if both are given,
   * name wins (matches CAST_TARGETS/ControllerAPI's own "one wins,
   * documented, no silent double-filter" convention elsewhere in this
   * codebase). Omit both to match every entity in the scene regardless
   * of name/tag.
   *
   *   findInRadius(this.x, this.y, 200)                     // everything within 200 units
   *   findInRadius(this.x, this.y, 200, { tag: "Enemy" })   // only Enemies
   *   findInRadius(this.x, this.y, 200, { name: "Coin" })   // only entities named "Coin"
   *
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {{name?:string, tag?:string}} [opts]
   * @returns {object[]} live EntityContexts, nearest first
   */
  findInRadius(x, y, radius, opts) {
    opts = opts || {};
    const r2 = Math.max(0, radius) * Math.max(0, radius);
    const all = this.world ? this.world.getAllEntities() : [];
    const hits = [];
    for (const entity of all) {
      if (opts.name && entity.name !== opts.name) continue;
      if (!opts.name && opts.tag && entity.tag !== opts.tag) continue;
      const t = entity.getComponent(TRANSFORM);
      if (!t) continue;
      const dx = t.x - x;
      const dy = t.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) hits.push({ entity, d2 });
    }
    hits.sort((a, b) => a.d2 - b.d2);
    return hits.map((h) => this.createEntityContext(h.entity));
  }

  /**
   * Spawns a runtime copy of an existing entity — Unity's
   * Object.Instantiate(original). Accepts EITHER:
   *   - an EntityContext directly — `this`, or anything returned by
   *     find*()/findById()/spawn() itself — clones THAT EXACT entity,
   *     no lookup involved at all. This is the reliable option: there
   *     is no ambiguity, even if ten other entities share its name.
   *       spawn(this)                     // clone whatever entity is running this script
   *       var e = findById(id); spawn(e);  // clone one specific entity you already have a handle to
   *   - a name or tag STRING (the original, still-supported form) —
   *     looks up the source by name (default) or tag (opts.byTag),
   *     using the FIRST match if more than one entity shares that
   *     name/tag. Kept for backward compatibility and for the common
   *     "spawn a fresh copy of this prefab-like object by name" case
   *     where you don't have (and don't need) a direct reference.
   *       spawn("Bullet")
   *       spawn("Enemy", { byTag: true })
   * Deep-clones via cloneEntity() (same registry-driven reconstruct as
   * editor copy/paste — every component type is handled uniformly,
   * nothing per-type to keep in sync here), and returns an
   * EntityContext for the new entity.
   *
   * Returns null if no source entity is found (string form only — the
   * EntityContext form can't miss, since you're handing over the exact
   * entity) — mirrors find()'s own null-on-miss behavior rather than
   * throwing, so a script can safely do
   * `var e = spawn("Enemy"); if (e) { ... }`.
   *
   * WIRING NOTE: the new entity is added straight into world.entities,
   * so PhysicsWorld.step() and RenderSystem.update() (both re-query the
   * live world every single frame) pick it up automatically next frame
   * with zero special-casing. ScriptSystem is the one system that does
   * NOT re-scan every frame (it only compiles once at scene start for
   * performance) — see ScriptSystem._initNewInstances(), called right
   * after this returns, which incrementally compiles/starts scripts for
   * ANY entity that doesn't have instances yet, clone or otherwise, and
   * is what actually fires this clone's own onClone()/onStart().
   *
   * @param {string|EntityContext} nameOrTagOrEntity  a name/tag string (looked up), or an EntityContext to clone directly
   * @param {{x?:number, y?:number, name?:string, byTag?:boolean}} [opts]
   *   x/y      — spawn position (defaults to the source's own position)
   *   name     — rename the clone (defaults to the source's own name)
   *   byTag    — true to look up nameOrTagOrEntity as a TAG instead of a name (ignored when passing an EntityContext directly)
   * @returns {object|null} EntityContext for the new entity, or null if no source was found
   */
  spawn(nameOrTagOrEntity, opts) {
    opts = opts || {};
    // EntityContext form: has an underlying _entity, so there's no
    // name/tag lookup to do at all — just clone that exact entity.
    // This is what makes `spawn(this)` / `spawn(someFindResult)`
    // possible, instead of being forced through a name that might
    // match more than one entity.
    var source = (nameOrTagOrEntity && nameOrTagOrEntity._entity)
      ? nameOrTagOrEntity._entity
      : (opts.byTag
          ? (this.world.findByTag ? this.world.findByTag(nameOrTagOrEntity)[0] : null)
          : this.world.findFirstByName(nameOrTagOrEntity));
    if (!source) {
      if (typeof console !== "undefined") {
        console.warn("[ScriptAPI] spawn('" + nameOrTagOrEntity + "') — no entity found " +
          (opts.byTag ? "with tag" : "named") + " '" + nameOrTagOrEntity + "'");
      }
      return null;
    }
    var entity = cloneEntity(this.world, source, opts);
    return this.createEntityContext(entity);
  }

  /**
   * Runs `callback` once after `seconds` of game time. Thin passthrough
   * to ScriptSystem's _scheduleWait (wired up as this._waitFn in
   * ScriptSystem's constructor, same pattern as _sendMessageFn) — see
   * that method's doc comment for the full behavior: ownership,
   * auto-cancel on destroy/restart/scene-switch, and `this` binding.
   * @param {number} seconds
   * @param {function} callback
   * @returns {number} timer id, or -1 if there was no active entity
   */
  wait(seconds, callback) {
    return this._waitFn ? this._waitFn(seconds, callback) : -1;
  }

  /**
   * Cancels a pending wait() timer before it fires. No-op if the id
   * already fired or was already cancelled.
   * @param {number} timerId
   */
  cancelWait(timerId) {
    if (this._cancelWaitFn) this._cancelWaitFn(timerId);
  }

  /**
   * Runs `callback` every `seconds`, forever, until cancelled or the
   * owning entity/scene goes away. Thin passthrough to ScriptSystem's
   * _scheduleRepeat (wired up as this._repeatFn), same pattern as
   * wait()/_waitFn — see that method's doc comment for full behavior.
   * @param {number} seconds
   * @param {function} callback
   * @returns {number} timer id, or -1 if there was no active entity
   */
  repeat(seconds, callback) {
    return this._repeatFn ? this._repeatFn(seconds, callback) : -1;
  }

  /**
   * Stops a repeat() before its next fire. No-op if already cancelled.
   * @param {number} timerId
   */
  cancelRepeat(timerId) {
    if (this._cancelRepeatFn) this._cancelRepeatFn(timerId);
  }

  /**
   * Creates (or returns a cached) EntityContext for the given entity.
   */
  createEntityContext(entity) {
    if (this._contexts.has(entity.id)) {
      return this._contexts.get(entity.id);
    }
    var ctx = new EntityContext(entity, this.world, this);
    this._contexts.set(entity.id, ctx);
    return ctx;
  }

  /**
   * Drops every cached EntityContext. MUST be called whenever the World
   * is cleared/reloaded (scene.restart(), scene.load()) — entity ids get
   * reused after World.clear() resets its id counter (see
   * core/World.js), so without this a stale EntityContext from the
   * PREVIOUS (now-destroyed) Entity instance would keep being handed
   * back to scripts for the new entity that happens to share its id,
   * silently reading/writing dead component data instead of the fresh
   * scene's actual entities.
   */
  clearContexts() {
    this._contexts.clear();
    // Collab goals are per-scene transient state, same category as the
    // contexts themselves — a stale goal surviving a scene.restart()/
    // scene.load() could otherwise make a freshly-spawned agent think
    // it's grouped with a target from the PREVIOUS scene for up to
    // _NAV_GOAL_STALE_SECONDS.
    this._navGoals.clear();
  }

  /**
   * Drops the cached EntityContext for ONE entity id. Used when a
   * single entity is destroyed via this.destroy() (see EntityContext's
   * destroy() method and ScriptSystem.js's flushDestroyed handling) —
   * the rest of the scene keeps running, so a full clearContexts()
   * would be wrong here (it would drop every OTHER entity's live
   * context too); this only removes the one that no longer exists, for
   * the same reuse-safety reason clearContexts() exists at all.
   * @param {string} id
   */
  clearContext(id) {
    this._contexts.delete(id);
    // Same reasoning as clearContexts() above, scoped to just this one
    // entity — a destroyed agent must stop "holding" a collab slot
    // immediately rather than lingering for the rest of the stale window.
    this._navGoals.delete(id);
  }

  /**
   * Real shape-accurate hit-test: which entities' Collider2D actually
   * contains this WORLD-space point (box/circle/capsule/triangle,
   * including rotation — not a bounding-box guess). Thin wrapper over
   * _physicsHitTestFn (wired to PhysicsWorld.entityAtPoint by
   * createGame — see runtime/index.js), returning EntityContexts
   * instead of raw ids so callers get the same `this`-shaped object
   * every other API here returns.
   * @param {number} x world-space x
   * @param {number} y world-space y
   * @returns {object[]} EntityContexts whose collider contains the point (possibly empty)
   */
  _entitiesAtPoint(x, y) {
    if (!this._physicsHitTestFn) return [];
    var ids = this._physicsHitTestFn(x, y) || [];
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var entity = this.world.getEntity(ids[i]);
      if (entity) out.push(this.createEntityContext(entity));
    }
    return out;
  }

  /**
   * Finds the entity currently under the mouse cursor matching
   * `nameOrTagOrEntity`, or null if the cursor isn't over any matching
   * entity right now. Accepts EITHER a name/tag string (opts.byTag
   * picks which) — the original form, which can match the wrong entity
   * if more than one shares that name/tag — OR an EntityContext
   * directly, which always checks against that EXACT entity with no
   * ambiguity at all:
   *   mouse.isOver(door)         // door from findById()/findFirst()/etc — checks THIS exact entity
   *   mouse.isOver("Door")       // still works — first entity named "Door" under the cursor
   * (There's no separate "pass a bare id" form — a bare string always
   * means name/tag, since a real id and someone's chosen entity name
   * are both just strings and can't be told apart reliably. Use the
   * EntityContext itself, e.g. from findById(id), not id alone.)
   * Shared by mouse.isOver()/mouse.clickedOn() — this.
   * isClicked/this.isPointerOver instead check ONE specific entity
   * directly via _entitiesAtPoint, without a name/tag search, since
   * they already know which entity they are.
   * @param {string|object} nameOrTagOrEntity  name/tag string, or an EntityContext
   * @param {{byTag?:boolean}} [opts]
   * @returns {object|null} EntityContext, or null
   */
  _entityUnderMouse(nameOrTagOrEntity, opts) {
    opts = opts || {};
    var hits = this._entitiesAtPoint(this._mouse.x, this._mouse.y);
    // EntityContext form: skip name/tag matching, just look for that
    // EXACT entity among the hits (via its stable, never-reused id —
    // see EntityContext's `id` getter for why this can never
    // accidentally match a different entity).
    var isEntityForm = !!(nameOrTagOrEntity && nameOrTagOrEntity._entity);
    var targetId = isEntityForm ? nameOrTagOrEntity._entity.id : null;
    for (var i = 0; i < hits.length; i++) {
      var entity = hits[i]._entity;
      var matches = isEntityForm
        ? entity.id === targetId
        : (opts.byTag ? entity.tag === nameOrTagOrEntity : entity.name === nameOrTagOrEntity);
      if (matches) return hits[i];
    }
    return null;
  }

  /**
   * Touch equivalent of _entityUnderMouse just above — same lookup
   * (name/tag string, OR an EntityContext for an exact, unambiguous
   * match), but checked against EVERY currently active finger (not a
   * single cursor position), since more than one finger can be on
   * screen at once. Returns the first matching hit found.
   * @param {string|object} nameOrTagOrEntity  name/tag string, or an EntityContext
   * @param {{byTag?:boolean, justStarted?:boolean}} [opts] justStarted
   *   restricts the check to fingers that touched down THIS frame —
   *   used by touch.tappedOn()/this.isTapped so a finger merely resting
   *   on the entity doesn't count as tapping it every single frame.
   * @returns {object|null} EntityContext, or null
   */
  _entityUnderTouch(nameOrTagOrEntity, opts) {
    opts = opts || {};
    var isEntityForm = !!(nameOrTagOrEntity && nameOrTagOrEntity._entity);
    var targetId = isEntityForm ? nameOrTagOrEntity._entity.id : null;
    for (var t of this._touches.values()) {
      if (opts.justStarted && !this._touchesStarted.has(t.id)) continue;
      var hits = this._entitiesAtPoint(t.x, t.y);
      for (var i = 0; i < hits.length; i++) {
        var entity = hits[i]._entity;
        var matches = isEntityForm
          ? entity.id === targetId
          : (opts.byTag ? entity.tag === nameOrTagOrEntity : entity.name === nameOrTagOrEntity);
        if (matches) return hits[i];
      }
    }
    return null;
  }

  /**
   * Real shape-accurate raycast against the live Rapier physics world.
   * Thin wrapper over _physicsRaycastFn (wired to PhysicsWorld.castRay
   * by createGame — see runtime/index.js), same pairing as
   * _entitiesAtPoint/_physicsHitTestFn just above. Exposed to scripts as
   * physics.raycast(x1,y1,x2,y2,opts) — see the doc comment on that
   * global in getGlobals() for the full opts.layerMask/opts.debug
   * behavior from a script author's point of view.
   *
   * @param {number} x1 @param {number} y1 ray start (world space)
   * @param {number} x2 @param {number} y2 ray end (world space)
   * @param {{ layerMask?: number, debug?: boolean }} [opts]
   * @returns {{ entity:object, point:{x,y}, normal:{x,y}|null, distance:number }|null}
   */
  _raycast(x1, y1, x2, y2, opts) {
    opts = opts || {};

    // Build a Set of entity IDs to exclude. opts.exclude is an array of
    // EntityContext objects (e.g. [this, find("Wall")]) — each carries
    // ._entity.id, the internal string ID used by _colliderHandleMap.
    var excludeEntityIds = null;
    if (opts.exclude && opts.exclude.length > 0) {
      excludeEntityIds = new Set();
      for (var i = 0; i < opts.exclude.length; i++) {
        var ex = opts.exclude[i];
        if (ex && ex._entity && ex._entity.id != null) {
          excludeEntityIds.add(ex._entity.id);
        }
      }
    }

    var hit = null;
    if (this._physicsRaycastFn) {
      hit = this._physicsRaycastFn(x1, y1, x2, y2, {
        layerMask: opts.layerMask,
        excludeEntityIds: excludeEntityIds,
      });
    }

    if (opts.debug) {
      // Drawn as a laser beam: the line ends at the hit point (if any),
      // not at the original endpoint — so it looks like a beam that stops
      // at the surface. No separate dot; the cut-off tip IS the indicator.
      // Red = missed, green = hit. NOT cleared here — cleared by the
      // renderer (renderDebugLines in play-popup.js / player/main.js)
      // after drawing, once per frame.
      this.debugState.debugLines.push({
        x1: x1, y1: y1,
        endX: hit ? hit.point.x : x2,
        endY: hit ? hit.point.y : y2,
        color: hit ? 0x00ff00 : 0xff3333,
      });
    }

    if (!hit) return null;
    var entity = this.world.getEntity(hit.entityId);
    return {
      entity: entity ? this.createEntityContext(entity) : null,
      point: hit.point,
      normal: hit.normal,
      distance: hit.distance,
    };
  }

  /**
   * Thin wrapper over _navFindPathFn (wired to NavWorldSystem.findPath
   * by createGame — see runtime/index.js). Exposed to scripts as
   * nav.findPath(x1,y1,x2,y2,opts) — see the doc comment on that global
   * in getGlobals() for the full opts.debug behavior from a script
   * author's point of view. Debug drawing reuses debugState.debugLines
   * (the same queue physics.raycast(...,{debug:true}) feeds) so a
   * script that turns BOTH on at once sees a consistent visual
   * language — green segments for a found path, same as a raycast hit —
   * rather than a second unrelated debug-drawing convention.
   * @param {number} x1 @param {number} y1 start (world space)
   * @param {number} x2 @param {number} y2 goal (world space)
   * @param {{ debug?: boolean, radius?: number, area?: number }} [opts]
   *   radius: agent clearance in world units against the shared
   *     NavWorld2D (default 0 — the base unpadded layer). Pass a
   *     NavAgent2D's radius for a path that actually respects that
   *     agent's size — this.navMoveToward() does this automatically.
   *   area: bitmask of allowed NavWorld2D area slots (default 0xffff —
   *     every area allowed), same model as Unity's NavMeshAgent.
   *     areaMask. A route will never cross a cell whose area isn't in
   *     this mask. Pass a NavAgent2D's area for a path that respects
   *     that agent's restrictions — this.navMoveToward() does this
   *     automatically.
   * Options are defined by NAV_API_OPTION_FIELDS.findPath so runtime docs
   * and editor `{ ... }` completion share one source of truth.
   * @returns {{x:number,y:number}[]|null}
   */
  _findNavPath(x1, y1, x2, y2, opts) {
    opts = opts || {};
    var radius = Number.isFinite(opts.radius) ? Math.max(0, opts.radius) : 0;
    var area = Number.isFinite(opts.area) ? (opts.area & 0xffff) : 0xffff;
    var areaCosts = Array.isArray(opts.areaCosts) ? opts.areaCosts : null;
    var path = this._navFindPathFn ? this._navFindPathFn(x1, y1, x2, y2, radius, area, areaCosts) : null;

    if (opts.debug && path && path.length > 1) {
      for (var i = 0; i < path.length - 1; i++) {
        this.debugState.debugLines.push({
          x1: path[i].x, y1: path[i].y,
          endX: path[i + 1].x, endY: path[i + 1].y,
          color: 0x00ff00,
        });
      }
    }

    return path;
  }

  /**
   * Finds the nearest point THIS agent (given radius+area) could
   * actually stand, expanding outward from (x, y). Backs the "agent is
   * standing somewhere its own area mask/radius disallows" recovery in
   * EntityContext.navMoveToward()/navDriveToward() below — see
   * _escapeDisallowedArea()'s doc comment for the full strategy this
   * feeds into. Thin wrapper over _navNearestWalkableFn (wired to
   * NavWorldSystem.nearestWalkablePointForAgent by createGame — see
   * runtime/index.js), same pattern as _findNavPath/_navIsWalkableFn
   * above.
   * @returns {{x:number,y:number}|null}
   */
  _findNearestWalkable(x, y, radius, area, areaCosts) {
    return this._navNearestWalkableFn ? this._navNearestWalkableFn(x, y, radius, area, areaCosts) : null;
  }

  /**
   * Records this entity's current navMoveToward() goal for
   * NavAgent2D "collab" grouping (see EntityContext._applyNavCollab()).
   * Called every navMoveToward() invocation, even when this agent ends
   * up ungrouped, so a SECOND agent that starts converging on the same
   * point a moment later can still discover this one.
   * @param {string} entityId
   * @param {number} x @param {number} y
   */
  _publishNavGoal(entityId, x, y) {
    this._navGoals.set(entityId, { x: x, y: y, time: this.time.elapsed });
  }

  /**
   * Looks up another entity's most recently published nav goal for
   * collab grouping, or null if it never published one or its entry has
   * gone stale (see _NAV_GOAL_STALE_SECONDS below — an agent that
   * stopped calling navMoveToward this many seconds ago no longer
   * counts as "currently converging on something", so it can't keep a
   * group slot reserved indefinitely).
   * @param {string} entityId
   * @returns {{x:number,y:number}|null}
   */
  _peekNavGoal(entityId) {
    var entry = this._navGoals.get(entityId);
    if (!entry) return null;
    if (this.time.elapsed - entry.time > ScriptAPI._NAV_GOAL_STALE_SECONDS) {
      this._navGoals.delete(entityId);
      return null;
    }
    return entry;
  }

  /**
   * Returns the global API object passed as function parameters to
   * each compiled script. Called once per script at compile time.
   */
  getGlobals() {
    var self = this;
    return {
      // Note: bare `find(name)` was removed — it was an exact duplicate
      // of findFirst(name) (same lookup, same single-entity-or-null
      // return). Use findFirst() instead; it pairs with findAll() the
      // same way findFirstWithTag() pairs with findAllWithTag().
      findWithTag: function (tag) { return self.findWithTag(tag); },
      // Explicit first/all pair for both name and tag lookups — see the
      // doc comments on ScriptAPI.findFirst/findAll/findFirstWithTag/
      // findAllWithTag above for what each returns.
      findFirst: function (name) { return self.findFirst(name); },
      findAll: function (name) { return self.findAll(name); },
      findFirstWithTag: function (tag) { return self.findFirstWithTag(tag); },
      findAllWithTag: function (tag) { return self.findAllWithTag(tag); },
      // Unlike the name/tag lookups above, findById NEVER has an
      // ambiguity problem — see EntityContext's `id` getter and
      // ScriptAPI.findById's doc comments for why an id is reliable
      // where a name or tag might not be.
      findById: function (id) { return self.findById(id); },
      findInRadius: function (x, y, radius, opts) { return self.findInRadius(x, y, radius, opts); },
      scene: {
        findWithTag: function (tag) { return self.findWithTag(tag); },
        findFirst: function (name) { return self.findFirst(name); },
        findAll: function (name) { return self.findAll(name); },
        findFirstWithTag: function (tag) { return self.findFirstWithTag(tag); },
        findAllWithTag: function (tag) { return self.findAllWithTag(tag); },
        findById: function (id) { return self.findById(id); },
        load: function (sceneName) {
          if (self._loadSceneFn) {
            self._loadSceneFn(sceneName);
          } else if (typeof console !== "undefined") {
            console.log("[ScriptAPI] scene.load('" + sceneName + "') — no scene manager available");
          }
        },
        restart: function () {
          if (self._restartFn) {
            self._restartFn();
          } else if (typeof console !== "undefined") {
            console.log("[ScriptAPI] scene.restart() — no scene manager available");
          }
        },
        /**
         * Freezes gameplay: physics, scripts (including this one's own
         * onUpdate — the pause takes effect starting next frame, not
         * mid-call), animation, and audio all stop advancing. Rendering
         * and the editor/Play window itself stay fully responsive — this
         * is a gameplay pause, not tab-out/suspend. Call scene.resume()
         * to continue exactly where it left off.
         *   Example — pause menu:
         *   if (input.keyPressed("Escape")) { scene.pause(); showPauseMenu(); }
         */
        pause: function () {
          if (self._pauseFn) {
            self._pauseFn();
          } else if (typeof console !== "undefined") {
            console.log("[ScriptAPI] scene.pause() — no game loop available");
          }
        },
        /** Resumes gameplay after scene.pause(). Safe to call even if not currently paused. */
        resume: function () {
          if (self._resumeFn) {
            self._resumeFn();
          } else if (typeof console !== "undefined") {
            console.log("[ScriptAPI] scene.resume() — no game loop available");
          }
        },
        /** True while gameplay is frozen by scene.pause(). Read-only. */
        get isPaused() {
          return self._isPausedFn ? self._isPausedFn() : false;
        },
        /**
         * The name of the scene currently loaded and running, exactly as
         * it appears in the Scenes panel (e.g. "Level1", "Main Menu").
         * Always reflects the live scene — updates the instant a
         * scene.load()/scene.restart() finishes, same as world.sceneName
         * itself. Read-only; use scene.load(name) to change scenes.
         *   Example:
         *   if (scene.current === "Boss Room") { musicKey = "boss_theme"; }
         */
        get current() {
          return self.world ? self.world.sceneName : undefined;
        },
        // scene.lighting.* — scene-wide LightingSettings, see
        // LightingSettingsAPI.js's header for why this lives here
        // instead of behind a per-entity this.<name> sub-object.
        lighting: createLightingSettingsAPI(self.world),
      },
      physics: {
        /**
         * Casts a ray from (x1,y1) to (x2,y2) against real Rapier
         * collider shapes and returns the CLOSEST hit, or null.
         *
         *   raycast(x1, y1, x2, y2)
         *   raycast(x1, y1, x2, y2, { exclude: [this] })
         *   raycast(x1, y1, x2, y2, { exclude: [this, find("Wall")] })
         *   raycast(x1, y1, x2, y2, { debug: true })
         *
         * opts.exclude — array of entity objects to skip entirely.
         *   Pass [this] to ignore the caster's own collider (the most
         *   common use). Pass [this, find("Shield")] to skip multiple.
         *   Triggers (isTrigger=true colliders) are always skipped
         *   regardless of this option.
         *
         * opts.debug — draws the ray as a laser beam for one frame:
         *   green and cut at the hit point if it hit, red full-length
         *   if it missed. Call debug.show() once (e.g. in onStart) to
         *   make the overlay visible.
         *
         * Returns { entity, point:{x,y}, normal:{x,y}|null, distance }
         * or null. entity is the same shape as find() / this.
         */
        raycast: function (x1, y1, x2, y2, opts) {
          return self._raycast(x1, y1, x2, y2, opts);
        },
        /**
         * Builds a layerMask bitmask from one or more layer indices
         * (0-15), for use as physics.raycast(...)'s opts.layerMask —
         *   physics.raycast(x1, y1, x2, y2, { layerMask: physics.layer(2, 3) })
         * hits ONLY colliders on layers 2 and 3, ignoring everything else.
         */
        layer: function () {
          var mask = 0;
          for (var i = 0; i < arguments.length; i++) {
            var n = arguments[i] | 0;
            if (n >= 0 && n <= 15) mask |= (1 << n);
          }
          return mask;
        },
      },
      /**
       * Pathfinding over the scene's baked/painted NavWorld2D (see
       * components/NavWorld2D.js and the Nav tool in the Scene view).
       * Uses the FIRST NavWorld2D entity in the scene — see this
       * global's individual method docs and NavWorldSystem.js's
       * one-per-scene convention note. All methods no-op safely (return
       * null/false) if the scene has no NavWorld2D entity yet, same
       * "missing wiring degrades gracefully" behavior physics.raycast()
       * has before physics finishes loading.
       */
      nav: {
        /**
         * Finds a walkable path from (x1,y1) to (x2,y2) across the
         * scene's NavWorld2D, snapping each endpoint to the nearest
         * walkable cell if it doesn't land exactly on one.
         *
         *   nav.findPath(x1, y1, x2, y2)
         *   nav.findPath(x1, y1, x2, y2, { debug: true })
         *   nav.findPath(x1, y1, x2, y2, { radius: 24 })
         *   nav.findPath(x1, y1, x2, y2, { area: (1 << 0) | (1 << 4) })
         *
         * Returns an array of { x, y } WORLD-space waypoints from start
         * to goal inclusive, or null if no path exists (goal
         * unreachable, or no NavWorld2D in the scene). Waypoints are one
         * per grid cell the path passes through a turn at — NOT one
         * per grid cell crossed (straight runs are merged) — so this is
         * cheap enough to call every frame for a single agent, but for
         * many agents prefer calling it once (e.g. in onStart or when
         * the target changes) and walking the returned array over
         * several frames instead of re-pathing every tick.
         *
         * opts.debug — draws the path as a chain of green segments for
         * one frame, same visual language as physics.raycast's debug
         * beam. Call debug.show() once to make the overlay visible.
         *
         * opts.radius — agent clearance in world units against the
         * shared NavWorld2D (default 0, the base unpadded layer). A
         * narrow passage the base layer allows can become unwalkable at
         * a larger radius — that's the same per-agent-size pipeline
         * this.navMoveToward() uses automatically from a NavAgent2D
         * component; pass it here directly for manual path queries.
         *
         * opts.area — bitmask of allowed NavWorld2D area slots (default
         * 0xffff, every area allowed), same model as Unity's
         * NavMeshAgent.areaMask: a route will NEVER cross a cell whose
         * area bit isn't in this mask, no matter how short a shortcut it
         * would be. See editor/state/NavAreas.js (Edit > Nav Areas…) for
         * naming slots, and NavWorld2D.areaCosts for the separate SOFT
         * per-area cost preference (e.g. "prefer roads over mud") that
         * applies only to areas already allowed by this mask.
         *
         * A returned path does NOT smooth into a single straight line
         * across open areas — it follows the grid, so a path through a
         * wide-open room will look like a staircase of cell-sized
         * segments rather than one diagonal line. Move an agent through
         * each waypoint in order (e.g. with mathx.moveToward) for
         * correct obstacle-avoiding movement.
         */
        findPath: function (x1, y1, x2, y2, opts) {
          return self._findNavPath(x1, y1, x2, y2, opts);
        },
        /**
         * True if the world-space point (x,y) falls on a walkable
         * NavWorld2D cell. False for a blocked cell, a cell outside the
         * baked/painted area, or if the scene has no NavWorld2D.
         */
        isWalkable: function (x, y) {
          return self._navIsWalkableFn ? self._navIsWalkableFn(x, y) : false;
        },
        /**
         * Re-bakes the scene's NavWorld2D from every Collider2D
         * currently in the world (same operation as the Inspector's
         * "Bake Nav World" button). Returns { walkable, blocked } cell
         * counts, or null if the scene has no NavWorld2D entity. Most
         * games bake once in the editor and never call this — it's here
         * for levels that spawn their own obstacles procedurally at
         * runtime and need the NavWorld2D to reflect that afterward.
         */
        bake: function () {
          return self._navBakeFn ? self._navBakeFn() : null;
        },
        /**
         * Resolves a named NavWorld2D area (as named in editor Edit →
         * Nav Areas…) to its 0-15 slot index — the named-string
         * counterpart to hand-writing a bit position.
         *   nav.areaIndex("Water")   // -> e.g. 1
         * Case-insensitive. Returns -1 if no area has that name.
         */
        areaIndex: function (name) {
          return resolveNavAreaIndex(self._navAreaNames, name);
        },
        /**
         * Turns one or more named areas into the bitmask nav.findPath's
         * `area` option (and NavAgent2D.area) expect:
         *   nav.findPath(x1, y1, x2, y2, { area: nav.areaMask("Ground", "Road") })
         * Unknown names are skipped rather than corrupting the rest of
         * the mask; a call where NONE of the names resolve returns 0
         * (nothing allowed) — a typo fails closed instead of quietly
         * falling back to "every area allowed".
         */
        areaMask: function () {
          return resolveNavAreaMask(self._navAreaNames, Array.prototype.slice.call(arguments));
        },
        /**
         * Turns a named cost map into the 16-entry array nav.findPath's
         * `areaCosts` option (and NavAgent2D.areaCosts) expect:
         *   nav.findPath(x1, y1, x2, y2, {
         *     area: nav.areaMask("Ground", "Road", "Mud"),
         *     areaCosts: nav.areaCosts({ Road: 0.5, Mud: 4 })
         *   })
         * A name that doesn't resolve, or a cost that isn't a finite
         * number > 0, is skipped — that slot falls back to NavWorld2D's
         * own cost for it rather than the whole call failing.
         */
        areaCosts: function (costsByName) {
          return resolveNavAreaCosts(self._navAreaNames, costsByName);
        },
      },
      /**
       * Send a message to script instances on entities matching the
       * first argument. Accepts EITHER a tag string — messages EVERY
       * entity with that tag, a group broadcast — OR an EntityContext
       * directly, which messages that ONE exact entity only, with no
       * ambiguity even if other entities share its tag. Scripts that
       * define `onMessage(message, sender, data)` will be called
       * immediately.
       *   sendMessage("Enemy", "takeDamage", { amount: 10 })       // every entity tagged "Enemy"
       *   sendMessage(oneEnemy, "takeDamage", { amount: 10 })      // just that one entity, e.g. from findById()/spawn()
       */
      sendMessage: function(tagOrEntity, message, data) {
        if (self._sendMessageFn) self._sendMessageFn(tagOrEntity, message, data);
      },
      /**
       * Broadcast a message to ALL entities in the scene. Every script
       * instance that defines `onMessage(message, sender, data)` will be
       * called.
       *   broadcastMessage("gameOver", { winner: "Player" })
       */
      broadcastMessage: function(message, data) {
        if (self._broadcastMessageFn) self._broadcastMessageFn(message, data);
      },
      /**
       * Spawns a runtime clone of an existing entity — Unity's
       * Object.Instantiate(). Looks the source up by NAME by default:
       *   spawn("Bullet")
       *   spawn("Bullet", { x: this.x, y: this.y })
       * Pass byTag to look up by tag instead (clones the FIRST match):
       *   spawn("Enemy", { byTag: true, x: 200, y: 100 })
       * Optionally rename the clone with `name`. Returns an
       * EntityContext for the new entity (same shape as `this` — .x,
       * .sprite, .rigidbody, etc.), or null if no source entity exists
       * with that name/tag. The clone's own onClone()/onStart() fire
       * automatically on the next frame, with this.isClone === true.
       */
      spawn: function (nameOrTag, opts) {
        return self.spawn(nameOrTag, opts);
      },
      /**
       * Runs `callback` once, after `seconds` of game time — a simple
       * beginner-friendly timer. `this` inside the callback is the SAME
       * entity that called wait(), exactly like onUpdate:
       *   function onStart() {
       *     wait(3, function () {
       *       this.visible = false;
       *     });
       *   }
       * Timers are automatically cancelled if their entity is destroyed,
       * or if the scene restarts/switches before they fire — a wait()
       * never fires "late" against a scene that's already gone.
       * Returns a timer id you can optionally pass to cancelWait(id) to
       * stop it early:
       *   var id = wait(5, function () { this.destroy(); });
       *   // later, e.g. if the player does something that cancels it:
       *   cancelWait(id);
       */
      wait: function (seconds, callback) {
        return self._waitFn ? self._waitFn(seconds, callback) : -1;
      },
      /**
       * Cancels a pending wait() timer before it fires. Safe to call
       * with an id that already fired or was already cancelled (does
       * nothing in either case).
       *   var id = wait(3, function () { ... });
       *   cancelWait(id);
       */
      cancelWait: function (timerId) {
        if (self._cancelWaitFn) self._cancelWaitFn(timerId);
      },
      /**
       * Runs `callback` every `seconds`, forever — the beginner-friendly
       * way to do repeating actions without writing a self-rescheduling
       * wait() by hand:
       *   function onStart() {
       *     repeat(2, function () {
       *       spawn("Enemy", { x: random.int(0, 800), y: 0 });
       *     });
       *   }
       * The first call happens `seconds` from now, then every `seconds`
       * after that, forever, until you call cancelRepeat(id), the
       * entity is destroyed, or the scene restarts/switches — same
       * auto-cancellation as wait(). There's no separate "forever loop"
       * construct in this engine: onUpdate() already runs every frame
       * for as long as the entity exists, and repeat() covers "do this
       * every N seconds" — an actual while(true) would freeze the game,
       * since scripts run synchronously with no pause point mid-frame.
       * Returns a timer id for cancelRepeat(id).
       */
      repeat: function (seconds, callback) {
        return self._repeatFn ? self._repeatFn(seconds, callback) : -1;
      },
      /**
       * Stops a repeat() before its next fire. Safe to call with an id
       * that was already cancelled (does nothing).
       *   var id = repeat(1, function () { ... });
       *   cancelRepeat(id);
       */
      cancelRepeat: function (timerId) {
        if (self._cancelRepeatFn) self._cancelRepeatFn(timerId);
      },
      /**
       * Smoothly animate one or more numeric properties on an entity or
       * scripting component object. Call once from a lifecycle callback:
       *   tween(this, { x: 420, y: 180, rotation: 90 }, 0.8, "easeOutCubic");
       *   tween(this.sprite, { opacity: 0 }, 0.35, "easeInOutSine");
       * Supported easing names are completed by the script editor.
       * Returns an id for cancelTween(id). onComplete runs with `this`
       * bound to the entity that started the tween.
       */
      tween: function (target, properties, duration, easing, onComplete) {
        return self._tweenFn ? self._tweenFn(target, properties, duration, easing, onComplete) : -1;
      },
      /** Cancel an active tween by the id returned from tween(). */
      cancelTween: function (tweenId) {
        return self._cancelTweenFn ? self._cancelTweenFn(tweenId) : false;
      },
      input: {
        /**
         * True while `key` is currently held. Pass the special value
         * "Any" instead of a specific key code to check "is ANY key
         * currently held" — useful for "press any key to continue"
         * prompts without needing to guess/list every possible code.
         */
        keyDown: function (key) { return key === "Any" ? self._keysDown.size > 0 : self._keysDown.has(key); },
        /**
         * True for exactly the one frame `key` was first pressed. Pass
         * "Any" (same sentinel as keyDown above) to check "was ANY key
         * pressed this frame".
         */
        keyPressed: function (key) { return key === "Any" ? self._keysPressed.size > 0 : self._keysPressed.has(key); },
      },
      /**
       * Mouse position + buttons. x/y are WORLD coordinates — the same
       * space this.x/this.y use — so you can compare them directly:
       *   function onUpdate() {
       *     this.x = mouse.x; // sprite follows the cursor
       *   }
       * screenX/screenY are raw canvas-pixel coordinates instead (0,0
       * at the top-left of the game view), for UI-style code that
       * doesn't care about the world/camera at all.
       * down()/pressed()/released() take a button number: 0 = left,
       * 1 = middle, 2 = right (same numbering the browser itself uses).
       * pressed()/released() are true for exactly the one frame the
       * button changed state, same as input.keyPressed().
       */
      mouse: {
        get x() { return self._mouse.x; },
        get y() { return self._mouse.y; },
        get screenX() { return self._mouse.screenX; },
        get screenY() { return self._mouse.screenY; },
        /** True while the cursor is anywhere over the game screen. */
        get over() { return self._mouse.over; },
        down: function (button) { return self._mouse.buttonsDown.has(button === undefined ? 0 : button); },
        pressed: function (button) { return self._mouse.buttonsPressed.has(button === undefined ? 0 : button); },
        released: function (button) { return self._mouse.buttonsReleased.has(button === undefined ? 0 : button); },
        /**
         * True if the mouse is currently over the given entity — real
         * shape-accurate hit-testing (matches a circle collider as a
         * circle, not its bounding box), same query this.isPointerOver
         * uses for "this" entity specifically. Accepts a name/tag
         * string (the original form — matches the FIRST entity with
         * that name/tag, which can be the wrong one if several share
         * it) OR an EntityContext directly, for an exact, unambiguous
         * check:
         *   if (mouse.isOver("PlayButton")) { ... }        // by name
         *   if (mouse.isOver(door)) { ... }                 // door from findFirst()/findById()/etc — checks that EXACT entity
         */
        isOver: function (nameOrTagOrEntity, opts) {
          return self._entityUnderMouse(nameOrTagOrEntity, opts) !== null;
        },
        /**
         * True the SAME FRAME the given button was pressed while the
         * cursor was over the given entity — the "I clicked this
         * specific thing" check, combining isOver() + pressed() into
         * one beginner-friendly call. Accepts a name/tag string OR an
         * EntityContext directly, same as isOver() above:
         *   if (mouse.clickedOn("PlayButton")) { scene.load("Level1"); }
         *   if (mouse.clickedOn(door)) { ... }
         * Defaults to the left mouse button (0). For "did I click
         * ANYTHING on this entity, tracked entity-side", see
         * this.isClicked instead — same underlying check, just phrased
         * as a property on the object itself rather than a global
         * lookup by name.
         */
        clickedOn: function (nameOrTagOrEntity, opts, button) {
          if (typeof opts === "number") { button = opts; opts = undefined; }
          if (!self._mouse.buttonsPressed.has(button === undefined ? 0 : button)) return false;
          return self._entityUnderMouse(nameOrTagOrEntity, opts) !== null;
        },
      },
      /**
       * Active touches for mobile/touchscreen games — one entry per
       * finger currently on the screen (plus any that just lifted this
       * frame, which appear as justEnded: true).
       *
       * PER-TOUCH SHAPE  (same for every entry in the array):
       *   id           — stable finger id, use to tell fingers apart across frames
       *   x, y         — current world-space position
       *   screenX/Y    — current canvas-pixel position
       *   startX/Y     — world-space position where this finger first touched down
       *   dx, dy       — how far it has moved from startX/Y (x - startX, y - startY)
       *   distance     — total distance from startX/Y (Math.hypot(dx, dy))
       *   justStarted  — true for exactly the one frame this finger touched down
       *   justEnded    — true for exactly the one frame this finger lifted
       *
       * ARRAY EXTRAS:
       *   touch.count          — how many fingers are touching right now
       *   touch.first          — first active touch, or null
       *   touch.anyJustStarted — true if any finger touched down this frame
       *   touch.anyJustEnded   — true if any finger lifted this frame
       *
       * GESTURE HELPERS  (recomputed fresh every frame, no setup needed):
       *   touch.swipe.active    — true when one finger has moved > 40 px from start
       *   touch.swipe.direction — 'left'|'right'|'up'|'down' (dominant axis)
       *   touch.swipe.dx/dy     — raw displacement from touch start
       *   touch.swipe.distance  — distance from touch start
       *
       *   touch.pinch.active   — true while two fingers are on screen
       *   touch.pinch.scale    — current / start distance ratio (>1 = spreading)
       *   touch.pinch.delta    — current distance minus start distance (px)
       *   touch.pinch.distance — current distance between the two fingers (px)
       *
       * TAP-ON-ENTITY HELPERS  (the touch equivalent of mouse.isOver/
       * mouse.clickedOn — checked against EVERY active finger, not just
       * one cursor position):
       *   touch.isOver(nameOrTag, opts)    — true if any finger is over that entity right now
       *   touch.tappedOn(nameOrTag, opts)  — true the one frame a finger FIRST touched down on it
       *   opts: { byTag?: boolean } — look up by tag instead of name
       * For "is a finger over/tapping THIS entity" from inside its own
       * script, see this.isTouchOver / this.isTapped instead — same
       * checks, no name/tag lookup needed.
       *
       * EXAMPLE — drag with one finger:
       *   if (touch.count > 0) { this.x = touch.first.x; }
       * EXAMPLE — swipe to jump:
       *   if (touch.swipe.active && touch.swipe.direction === 'up') { simulateJump(); }
       * EXAMPLE — pinch to zoom:
       *   if (touch.pinch.active) { this.camera.zoom = 5 / touch.pinch.scale; }
       * EXAMPLE — tap a button:
       *   if (touch.tappedOn("PlayButton")) { scene.load("Level1"); }
       */
      // See the big comment on `this._touchGlobal` in the constructor —
      // this is a direct reference to that persistent array, refreshed
      // IN PLACE every frame by _recomputeTouchGlobal() below, NOT a
      // getter. A script's `touch` local binding is set once at
      // script-compile time either way; handing out a stable reference
      // that gets mutated in place is what makes it look "live" on
      // every subsequent onUpdate() read, the same way `mouse` already
      // works via its own getters closing over `self`.
      touch: self._touchGlobal,
      time: self.time,
      random: {
        /** Random integer in [min, max] inclusive. */
        int: function (min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; },
        /** Random float in [min, max). */
        float: function (min, max) { return Math.random() * (max - min) + min; },
      },
      /**
       * Small gameplay-math helpers that plain JS `Math` doesn't provide
       * on its own. Named `mathx` (not `math`) so it reads as clearly
       * separate from both native `Math` and the engine itself — scripts
       * can still use `Math.floor`, `Math.abs`, `Math.hypot`, etc.
       * directly. These five are ADDITIONS, not wrappers, so there's no
       * overlap/duplication with native Math.
       */
      /**
       * Standard smoothstep easing. Exposed both as bare `smoothstep(a,b,v)`
       * and through `mathx.smoothstep(...)` so existing scripts that use the
       * helper do not fail at runtime. Inputs are clamped to [0,1] between
       * the two edges; reversed edges are handled safely.
       */
      smoothstep: function (a, b, value) {
        var lo = Number(a);
        var hi = Number(b);
        var v = Number(value);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(v)) return 0;
        if (hi < lo) { var tmp = lo; lo = hi; hi = tmp; }
        if (Math.abs(hi - lo) < 1e-8) return v < hi ? 0 : 1;
        var t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
        return t * t * (3 - 2 * t);
      },
      mathx: {
        /** Linear interpolation from a to b. t=0 -> a, t=1 -> b (t is not clamped, so overshoot works). */
        lerp: function (a, b, t) { return a + (b - a) * t; },
        /** Smooth Hermite easing between a and b; equivalent to the bare smoothstep helper. */
        smoothstep: function (a, b, value) {
          var lo = Number(a);
          var hi = Number(b);
          var v = Number(value);
          if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(v)) return 0;
          if (hi < lo) { var tmp = lo; lo = hi; hi = tmp; }
          if (Math.abs(hi - lo) < 1e-8) return v < hi ? 0 : 1;
          var t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
          return t * t * (3 - 2 * t);
        },
        /** Restrict value to the [min, max] range. */
        clamp: function (value, min, max) { return value < min ? min : (value > max ? max : value); },
        /** Move current toward target by at most maxDelta this call — no overshoot. Great for frame-rate-independent easing: this.x = mathx.moveToward(this.x, targetX, 200 * time.deltaTime). */
        moveToward: function (current, target, maxDelta) {
          if (Math.abs(target - current) <= maxDelta) return target;
          return current + Math.sign(target - current) * maxDelta;
        },
        /** Remap value from [inMin, inMax] into [outMin, outMax]. E.g. mathx.remap(hp, 0, 100, 0, 1) for a health-bar fill amount. */
        remap: function (value, inMin, inMax, outMin, outMax) {
          return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
        },
        /** True if a and b are within epsilon of each other (default 0.0001) — safer than === for comparing floats. */
        approximately: function (a, b, epsilon) { return Math.abs(a - b) < (epsilon === undefined ? 0.0001 : epsilon); },
      },
      global: new Proxy({}, {
        get: function (_, key) { return self._globals.get(key); },
        set: function (_, key, value) { self._globals.set(key, value); return true; },
        has: function (_, key) { return self._globals.has(key); },
      }),
      /**
       * Persistent, per-slot key/value storage backed by IndexedDB —
       * the way to make a game REMEMBER things across page refreshes
       * and browser restarts (unlike `global` above, which resets
       * every time the page reloads). See components/SaveAPI.js for
       * the full per-method docs.
       *   save.set("highScore", 4200);
       *   var best = save.get("highScore") ?? 0;
       *   save.has("checkpoint")
       *   save.delete("temporaryBuff")
       *   await save.load("slot2")   // switch save files
       */
      save: createSaveAPI(self.saveStore),
      /**
       * On-screen debug HUD, shown in the actual Play popup window (not
       * the editor Console panel). Call debug.show() from any script
       * (onStart is the usual place) to turn it on for the whole game —
       * it's global state, not per-entity, so any script can toggle it.
       *   debug.show()            — turn the HUD on, FPS counter visible
       *   debug.show(false)       — turn it off again
       *   debug.showFps(false)    — keep the HUD on but hide just the FPS line
       *   debug.log("label", val) — add/update a custom line in the HUD,
       *                              e.g. debug.log("Player HP", this.hp)
       *   debug.clear("label")    — remove a single custom line
       *   debug.clearAll()        — remove every custom line (FPS stays)
       */
      debug: {
        show: function (on) {
          const enabled = on === undefined ? true : !!on;
          self.debugState.enabled = enabled;
          // Piggyback the world's per-system profiler on the same
          // toggle — see World.js's profilingEnabled doc comment.
          // This is what backs the "SYSTEM TIMES" lines in the debug
          // HUD (see player/main.js / play-popup.js's
          // updateDebugOverlay), so a slow-frame investigation never
          // needs browser DevTools: debug.show() alone is enough to
          // see which system is actually eating the frame budget.
          if (self.world) {
            // Reset the averaging window on every OFF->ON transition
            // so a re-enabled HUD starts from a clean window instead
            // of blending in stale accumulated ms from before — see
            // World.js's resetProfiling() doc comment.
            if (enabled && !self.world.profilingEnabled) self.world.resetProfiling();
            self.world.profilingEnabled = enabled;
          }
        },
        showFps: function (on) {
          self.debugState.showFps = on === undefined ? true : !!on;
        },
        log: function (label, value) {
          self.debugState.stats.set(String(label), value);
        },
        clear: function (label) {
          self.debugState.stats.delete(String(label));
        },
        clearAll: function () {
          self.debugState.stats.clear();
        },
      },
    };
  }

  // --- Backwards-compatible methods (existing runtime/index.js uses these) ---

  findByName(name) { return this.findFirst(name); }

  findByTag(tag) { return this.findWithTag(tag); }

  setGlobal(key, value) { this._globals.set(key, value); }

  getGlobal(key) { return this._globals.has(key) ? this._globals.get(key) : undefined; }
}

/**
 * Seconds after which a published NavAgent2D collab goal (see
 * ScriptAPI._publishNavGoal/_peekNavGoal and EntityContext.
 * _applyNavCollab) is treated as abandoned. Comfortably longer than any
 * sane repathInterval so a normally-ticking agent's goal never appears
 * stale between its own navMoveToward() calls, but short enough that a
 * destroyed/disabled agent stops reserving a group slot within about a
 * second of going quiet.
 */
ScriptAPI._NAV_GOAL_STALE_SECONDS = 1;
