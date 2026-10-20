/**
 * ComponentRules.js — validation for component property edits coming from MCP.
 *
 * Goal: every rejected edit tells Claude exactly what is wrong and what is
 * allowed, and ALL problems in one call are reported together, so Claude can
 * fix the call in one retry instead of discovering errors one at a time.
 *
 * Layers, in order, for each property:
 *   1. name   — unsafe or unknown property (lists the valid ones)
 *   2. type   — wrong JSON type compared with the component's own default
 *   3. rules  — allowed enum values, numeric ranges, integer-ness, color format
 *   4. engine — "probe": build the component with just that property and see
 *               whether the engine's constructor clamps, rewrites or ignores it.
 *               This catches limits the engine enforces silently (for example
 *               Light.coreSize is clamped to 0.01–1) without hand-listing them.
 */
import { BodyType } from "../../runtime/components/Rigidbody2D.js";
import { ColliderShape } from "../../runtime/components/Collider2D.js";
import { LightType } from "../../runtime/components/Light.js";
import { CameraAspectMode, ScalingMode } from "../../runtime/components/Camera.js";
import { ControllerType, PatrolMode, PatrolAxis } from "../../runtime/components/CharacterController.js";
import { ShapeType } from "../../runtime/components/ShapeRenderer.js";
import { JointType2D } from "../../runtime/components/Joint2D.js";
import { JoystickPositionMode } from "../../runtime/components/Joystick.js";
import { StrokePathTextureMode, StrokePathJointMode, StrokePathCapMode } from "../../runtime/components/StrokePath.js";
import { ShadowMode } from "../../runtime/systems/LightingQuality.js";

const values = (obj) => Object.values(obj);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Allowed values for string fields. */
export const ENUM_RULES = {
  Rigidbody2D: { bodyType: values(BodyType) },
  Collider2D: { shape: values(ColliderShape) },
  Light: { type: values(LightType) },
  Camera: {
    aspectMode: values(CameraAspectMode),
    scalingMode: values(ScalingMode),
    letterboxing: ["Auto", "On", "Off"],
    pillarboxing: ["Auto", "On", "Off"],
  },
  CharacterController: {
    controllerType: values(ControllerType),
    patrolMode: values(PatrolMode),
    patrolAxis: values(PatrolAxis),
  },
  ShapeRenderer: { shapeType: values(ShapeType) },
  Joint2D: { jointType: values(JointType2D), textureMode: ["stretch", "tile"] },
  Joystick: { positionMode: values(JoystickPositionMode) },
  StrokePath: {
    textureMode: values(StrokePathTextureMode),
    jointMode: values(StrokePathJointMode),
    capMode: values(StrokePathCapMode),
  },
  LightingSettings: { shadowMode: values(ShadowMode) },
  SpeechBubble: { tailDirection: ["down", "up", "left", "right", "none"] },
  TextRenderer: { align: ["left", "center", "right"] },
};

/** Numeric limits: [min, max] (null = unbounded on that side), plus `int` for whole numbers. */
export const NUMBER_RULES = {
  Light: {
    intensity: { min: 0, max: 100 }, shadowStrength: { min: 0, max: 1 }, angle: { min: 0, max: 360 },
    radius: { min: 0 }, width: { min: 0 }, height: { min: 0 },
  },
  AudioSource: {
    volume: { min: 0, max: 1 }, pitch: { min: 0.1, max: 16 },
    minDistance: { min: 0 }, maxDistance: { min: 0 },
  },
  SpriteRenderer: { opacity: { min: 0, max: 1 } },
  ShapeRenderer: { opacity: { min: 0, max: 1 }, outlineWidth: { min: 0 }, width: { min: 0 }, height: { min: 0 }, radius: { min: 0 } },
  TextRenderer: { anchorX: { min: 0, max: 1 }, anchorY: { min: 0, max: 1 } },
  Collider2D: {
    layer: { min: 0, max: 15, int: true }, mask: { min: 0, max: 65535, int: true },
    friction: { min: 0 }, restitution: { min: 0 }, density: { min: 0 },
    width: { min: 0 }, height: { min: 0 }, radius: { min: 0 },
  },
  Rigidbody2D: { mass: { min: 0.0001 }, linearDamping: { min: 0 }, angularDamping: { min: 0 } },
  CharacterController: {
    airControl: { min: 0, max: 1 }, driftFactor: { min: 0, max: 1 },
    maxJumps: { min: 0, int: true }, moveSpeed: { min: 0 }, jumpForce: { min: 0 },
  },
  Joystick: { deadZone: { min: 0, max: 1 } },
  NavAgent2D: { avoidancePriority: { min: 0, max: 100 } },
  LightingSettings: { ambientDarkness: { min: 0, max: 1 }, glowStrength: { min: 0 }, raymarchSteps: { min: 1, max: 200, int: true } },
  StrokePath: { smoothing: { min: 0, max: 1 } },
  Camera: { size: { min: 0.0001 }, nearClip: { min: 0 }, farClip: { min: 0 } },
};

const isColorKey = (key) => key === "color" || /Color$/.test(key);
const describe = (value) => {
  const text = typeof value === "string" ? JSON.stringify(value) : (() => { try { return JSON.stringify(value); } catch (_) { return String(value); } })();
  return text === undefined ? String(value) : (text.length > 60 ? text.slice(0, 57) + "…" : text);
};
const sameJson = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; } };
const clone = (v) => JSON.parse(JSON.stringify(v));

function suggestion(value, allowed) {
  if (typeof value !== "string") return "";
  const hit = allowed.find((item) => String(item).toLowerCase() === value.toLowerCase());
  return hit ? " Did you mean " + JSON.stringify(hit) + "?" : "";
}

/** Wrong JSON type compared with the component's current value. Returns a message or null. */
export function fieldTypeError(type, key, current, value) {
  if (current === null || current === undefined || value === null) return null;
  const label = type + "." + key;
  if (typeof current === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return null;
    return label + " must be a finite number (got " + describe(value) + ").";
  }
  if (Array.isArray(current)) return Array.isArray(value) ? null : label + " must be an array (got " + describe(value) + ").";
  if (typeof current === "object") {
    return value && typeof value === "object" && !Array.isArray(value) ? null : label + " must be an object (got " + describe(value) + ").";
  }
  return typeof value === typeof current ? null : label + " must be a " + typeof current + " (got " + describe(value) + ").";
}

/**
 * @param {string} type component type name
 * @param {object} props the properties Claude wants to set
 * @param {Function} Cls component class (to probe engine behaviour)
 * @param {object} [current] a live component, or defaults (new Cls({})) when adding
 * @returns {string[]} problems; empty when everything is acceptable
 */
export function validateComponentProps(type, props, Cls, current) {
  const problems = [];
  const base = current || new Cls({});
  const known = Object.keys(base).filter((k) => !k.startsWith("_"));

  for (const [key, value] of Object.entries(props)) {
    const label = type + "." + key;

    // 1. name
    if (UNSAFE_KEYS.has(key) || key.startsWith("_") || !hasOwn(base, key)) {
      problems.push(label + " is not a property of " + type + ". Valid properties: " + known.join(", ") + ".");
      continue;
    }

    // 2. type
    const typeProblem = fieldTypeError(type, key, base[key], value);
    if (typeProblem) { problems.push(typeProblem); continue; }
    if (value === null) continue;

    // 3. rules
    let failed = false;
    const allowed = ENUM_RULES[type] && ENUM_RULES[type][key];
    if (allowed && !allowed.includes(value)) {
      problems.push(label + " must be one of " + allowed.map((v) => JSON.stringify(v)).join(", ") + " (got " + describe(value) + ")." + suggestion(value, allowed));
      failed = true;
    }
    const range = NUMBER_RULES[type] && NUMBER_RULES[type][key];
    if (range && typeof value === "number") {
      if (range.int && !Number.isInteger(value)) { problems.push(label + " must be a whole number (got " + value + ")."); failed = true; }
      else if ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max)) {
        const span = range.min !== undefined && range.max !== undefined ? "between " + range.min + " and " + range.max
          : range.min !== undefined ? "at least " + range.min : "at most " + range.max;
        problems.push(label + " must be " + span + " (got " + value + ").");
        failed = true;
      }
    }
    if (isColorKey(key) && typeof base[key] === "string" && typeof value === "string" && !COLOR_RE.test(value)) {
      problems.push(label + " must be a hex color like \"#ff8800\" (got " + describe(value) + ").");
      failed = true;
    }
    if (failed) continue;

    // 4. engine probe — does the constructor keep this value as given?
    try {
      const probe = new Cls({ [key]: clone(value) });
      if (!sameJson(probe[key], value)) {
        const defaultValue = new Cls({})[key];
        problems.push(sameJson(probe[key], defaultValue)
          ? label + " = " + describe(value) + " is not accepted by the engine (it falls back to the default " + describe(defaultValue) + ")."
          : label + " = " + describe(value) + " is outside what the engine allows; it would be changed to " + describe(probe[key]) + ". Send an in-range value such as " + describe(probe[key]) + ".");
      }
    } catch (error) {
      problems.push(label + " = " + describe(value) + " was rejected by the engine: " + String((error && error.message) || error) + ".");
    }
  }
  return problems;
}

/** One message for a tool result. */
export function formatProblems(action, type, problems) {
  return action + " " + type + " rejected — " + problems.length + " problem" + (problems.length === 1 ? "" : "s") +
    ":\n" + problems.map((p) => "- " + p).join("\n") + "\nNothing was changed. Call get_entity to see the component's current values.";
}
