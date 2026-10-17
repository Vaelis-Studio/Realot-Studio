/**
 * runtime/scripting/components/JoystickAPI.js
 *
 * The `this.joystick` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). Mirrors TextInputAPI.js/ChatLogAPI.js's Proxy
 * pattern. The typical read pattern — driving a character with a
 * joystick exactly like this.controller.simulateMove() already does
 * from keyboard input:
 *
 *   function onUpdate() {
 *     if (this.joystick) {
 *       this.controller.simulateMove(this.joystick.x, this.joystick.y);
 *     }
 *   }
 *
 * x/y/magnitude/angle/active reflect the real, currently-dragged knob
 * position — see runtime/systems/JoystickSystem.js for how the actual
 * pointer/touch tracking gets in here. Every property below is
 * read/write EXCEPT the five live-state fields (x, y, magnitude, angle,
 * active), which are read-only — same "can't fight the real input"
 * reasoning TextInputAPI.js's focused/justSubmitted use.
 *
 * RUNTIME-ONLY FILE.
 */

import { JOYSTICK } from "../../components/Joystick.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _requireJoystick(entity) {
  var j = entity.getComponent(JOYSTICK);
  if (!j) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.joystick but has no Joystick component. " +
    "Add one in the Inspector (Add Component → Joystick)."
  ), "missing-component");
  return j;
}

const JOYSTICK_MEMBERS = new Set([
  "x", "y", "magnitude", "angle", "active",
  "positionMode", "regionX", "regionY", "regionWidth", "regionHeight",
  "baseRadius", "knobRadius", "baseColor", "baseOpacity", "knobColor", "knobOpacity",
  "outlineColor", "outlineWidth", "deadZone", "returnToCenter", "hideWhenIdle",
  "idleOpacityMultiplier",
]);

const READONLY_MEMBERS = new Set(["x", "y", "magnitude", "angle", "active"]);

/**
 * Builds the `this.joystick` object for a given entity.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createJoystickAPI(entity) {
  const target = {
    /** -1..1 horizontal knob offset, right = positive (read-only, after dead zone). */
    get x() { return _requireJoystick(entity).x; },
    /** -1..1 vertical knob offset, down = positive (read-only, after dead zone). */
    get y() { return _requireJoystick(entity).y; },
    /** 0..1 distance the knob is pushed from center, after dead zone (read-only). */
    get magnitude() { return _requireJoystick(entity).magnitude; },
    /** Degrees, 0 = right, 90 = down — screen-space angle of the push direction (read-only). Meaningful even at magnitude 0 (holds the last direction). */
    get angle() { return _requireJoystick(entity).angle; },
    /** True while a finger/mouse is actively dragging this joystick right now (read-only). */
    get active() { return _requireJoystick(entity).active; },

    get positionMode() { return _requireJoystick(entity).positionMode; },
    set positionMode(v) { _requireJoystick(entity).positionMode = v; },
    /** Dynamic-mode touchable screen region — ignored in Fixed mode. */
    get regionX() { return _requireJoystick(entity).regionX; },
    set regionX(v) { _requireJoystick(entity).regionX = Number(v) || 0; },
    get regionY() { return _requireJoystick(entity).regionY; },
    set regionY(v) { _requireJoystick(entity).regionY = Number(v) || 0; },
    get regionWidth() { return _requireJoystick(entity).regionWidth; },
    set regionWidth(v) { _requireJoystick(entity).regionWidth = Number(v) || 0; },
    get regionHeight() { return _requireJoystick(entity).regionHeight; },
    set regionHeight(v) { _requireJoystick(entity).regionHeight = Number(v) || 0; },

    get baseRadius() { return _requireJoystick(entity).baseRadius; },
    set baseRadius(v) { _requireJoystick(entity).baseRadius = Math.max(1, Number(v) || 60); },
    get knobRadius() { return _requireJoystick(entity).knobRadius; },
    set knobRadius(v) { _requireJoystick(entity).knobRadius = Math.max(1, Number(v) || 28); },
    get baseColor() { return _requireJoystick(entity).baseColor; },
    set baseColor(v) { _requireJoystick(entity).baseColor = v; },
    get baseOpacity() { return _requireJoystick(entity).baseOpacity; },
    set baseOpacity(v) { _requireJoystick(entity).baseOpacity = Number(v); },
    get knobColor() { return _requireJoystick(entity).knobColor; },
    set knobColor(v) { _requireJoystick(entity).knobColor = v; },
    get knobOpacity() { return _requireJoystick(entity).knobOpacity; },
    set knobOpacity(v) { _requireJoystick(entity).knobOpacity = Number(v); },
    get outlineColor() { return _requireJoystick(entity).outlineColor; },
    set outlineColor(v) { _requireJoystick(entity).outlineColor = v; },
    get outlineWidth() { return _requireJoystick(entity).outlineWidth; },
    set outlineWidth(v) { _requireJoystick(entity).outlineWidth = Number(v) || 0; },

    /** 0..1 fraction of baseRadius the knob must move before x/y leaves 0. */
    get deadZone() { return _requireJoystick(entity).deadZone; },
    set deadZone(v) { _requireJoystick(entity).deadZone = Math.max(0, Math.min(0.95, Number(v) || 0)); },
    /** true = knob snaps back to center on release; false = holds its last position. */
    get returnToCenter() { return _requireJoystick(entity).returnToCenter; },
    set returnToCenter(v) { _requireJoystick(entity).returnToCenter = !!v; },
    /** true = invisible until actively being dragged. */
    get hideWhenIdle() { return _requireJoystick(entity).hideWhenIdle; },
    set hideWhenIdle(v) { _requireJoystick(entity).hideWhenIdle = !!v; },
    get idleOpacityMultiplier() { return _requireJoystick(entity).idleOpacityMultiplier; },
    set idleOpacityMultiplier(v) { _requireJoystick(entity).idleOpacityMultiplier = Number(v); },
  };
  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !JOYSTICK_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.joystick." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(JOYSTICK_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      return t[prop];
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (READONLY_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.joystick." + key + " is read-only and can't be set directly — it reflects the real dragged knob position."
        ), "unknown-api");
      }
      if (!(key in t) && !JOYSTICK_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.joystick." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(JOYSTICK_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
