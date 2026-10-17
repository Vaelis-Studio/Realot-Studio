/**
 * runtime/scripting/components/LightAPI.js
 *
 * The `this.light` sub-object exposed to user scripts on any entity that
 * has a Light component. Lets scripts animate lights at runtime — fade
 * intensity, change color, pulse radius, toggle shadows, etc.
 *
 * Only offered to entities that actually have a Light component; accessing
 * this.light on an entity without one throws a clear "missing component"
 * error with an Inspector hint, same pattern as this.audio / this.camera.
 *
 * Properties are also validated against the light's current type — e.g.
 * accessing `this.light.radius` on a Directional light throws a clear
 * error explaining which type the light is and what's actually available.
 *
 * RUNTIME-ONLY FILE.
 */

import { LIGHT, LightType } from "../../components/Light.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

/** Throws a descriptive error when a script calls this.light on an entity
 *  without a Light component. */
function _requireLight(entity) {
  var l = entity.getComponent(LIGHT);
  if (!l) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.light but has no Light component. " +
    "Add one in the Inspector (Add Component → Light)."
  ), "missing-component");
  return l;
}

// All valid property names across all light types.
const LIGHT_MEMBERS = new Set([
  "type", "color", "intensity", "radius", "angle",
  "width", "height", "castsOnWorld", "castShadows",
  "shadowColor", "shadowStrength", "flicker", "flickerSpeed", "flickerDuration", "coreSize", "coreVisible",
]);

// Properties valid per light type. Shared across all: type, color, intensity,
// castsOnWorld, castShadows, shadowColor, shadowStrength.
const LIGHT_TYPE_MEMBERS = {
  [LightType.DIRECTIONAL]: new Set([
    "type", "color", "intensity",
    "castsOnWorld", "castShadows", "shadowColor", "shadowStrength", "flicker", "flickerSpeed", "flickerDuration", "coreSize", "coreVisible",
  ]),
  [LightType.POINT]: new Set([
    "type", "color", "intensity", "radius",
    "castsOnWorld", "castShadows", "shadowColor", "shadowStrength", "flicker", "flickerSpeed", "flickerDuration", "coreSize", "coreVisible",
  ]),
  [LightType.SPOT]: new Set([
    "type", "color", "intensity", "radius", "angle",
    "castsOnWorld", "castShadows", "shadowColor", "shadowStrength", "flicker", "flickerSpeed", "flickerDuration", "coreSize", "coreVisible",
  ]),
  [LightType.AREA]: new Set([
    "type", "color", "intensity", "radius", "width", "height",
    "castsOnWorld", "castShadows", "shadowColor", "shadowStrength", "flicker", "flickerSpeed", "flickerDuration", "coreSize", "coreVisible",
  ]),
  [LightType.GOD_RAYS]: new Set([
    "type", "color", "intensity", "radius", "angle",
    "castsOnWorld", "castShadows", "shadowColor", "shadowStrength", "flicker", "flickerSpeed", "flickerDuration", "coreSize", "coreVisible",
  ]),
  [LightType.FREEFORM]: new Set([
    "type", "color", "intensity",
    "castsOnWorld", "castShadows", "shadowColor", "shadowStrength", "flicker", "flickerSpeed", "flickerDuration", "coreSize", "coreVisible",
  ]),
};

/**
 * Returns the type-specific member set for a light, falling back to the
 * full LIGHT_MEMBERS set for any unrecognised type so we're never more
 * restrictive than the base list.
 */
function _membersForType(lightType) {
  return LIGHT_TYPE_MEMBERS[lightType] || LIGHT_MEMBERS;
}

/**
 * Builds the `this.light` object for a given entity. All reads and writes
 * go directly to the live Light component data, so changing intensity or
 * color in onUpdate() takes effect immediately on the next rendered frame.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createLightAPI(entity) {
  const target = {
    /** Light type: 'Point' | 'Directional' | 'Spot' | 'Area' | 'GodRays' | 'Freeform' */
    get type() { return _requireLight(entity).type; },
    set type(v) { _requireLight(entity).type = v; },

    /** Light color as a hex string, e.g. "#ffdd88" for warm orange-yellow. */
    get color() { return _requireLight(entity).color; },
    set color(v) { _requireLight(entity).color = v; },

    /**
     * Brightness: 0 = off, 1 = normal, >1 = overbright (HDR-style bloom).
     * Drives both how far the light punches through ambient darkness and how
     * brightly it tints sprites. Clamped to >= 0.
     */
    get intensity() { return _requireLight(entity).intensity; },
    set intensity(v) { _requireLight(entity).intensity = Math.max(0, v); },

    /**
     * Falloff radius in world units / px (Point / Spot / Area / GodRays).
     * Beyond this distance from the light the scene receives no illumination
     * from it. Clamped to >= 0.
     */
    get radius() { return _requireLight(entity).radius; },
    set radius(v) { _requireLight(entity).radius = Math.max(0, v); },

    /**
     * Cone angle in degrees (Spot / GodRays only). The full cone width,
     * centered on the entity's Transform.rotation. Clamped to [0, 360].
     */
    get angle() { return _requireLight(entity).angle; },
    set angle(v) { _requireLight(entity).angle = Math.max(0, Math.min(360, v)); },

    /** Flat-lit rectangle width in px (Area lights only). Clamped to >= 0. */
    get width() { return _requireLight(entity).width; },
    set width(v) { _requireLight(entity).width = Math.max(0, v); },

    /** Flat-lit rectangle height in px (Area lights only). Clamped to >= 0. */
    get height() { return _requireLight(entity).height; },
    set height(v) { _requireLight(entity).height = Math.max(0, v); },

    /**
     * When true (default) this light visually illuminates the scene.
     * Set to false to keep the light in the scene graph (so scripts can read
     * its position and data) without any rendering cost or visual effect.
     */
    get castsOnWorld() { return _requireLight(entity).castsOnWorld; },
    set castsOnWorld(v) { _requireLight(entity).castsOnWorld = !!v; },

    /**
     * Enable real-time shadow casting: every ShadowCaster entity blocks
     * this light and casts a dark region behind it. Real rendering cost
     * (one shadow shape per ShadowCaster per shadow-casting light per frame),
     * so leave false until you need it.
     */
    get castShadows() { return _requireLight(entity).castShadows; },
    set castShadows(v) { _requireLight(entity).castShadows = !!v; },

    /** Shadow tint as a hex string, e.g. "#000000" (black) or "#1a1a3a" (blue-tinted). */
    get shadowColor() { return _requireLight(entity).shadowColor; },
    set shadowColor(v) { _requireLight(entity).shadowColor = v; },

    /**
     * Shadow opacity multiplier: 0 = this light casts no visible shadow,
     * 1 = full-strength shadow. Multiplied with each ShadowCaster's own
     * opacity, so either can independently control shadow density.
     * Clamped to [0, 1].
     */
    get shadowStrength() { return _requireLight(entity).shadowStrength; },
    set shadowStrength(v) { _requireLight(entity).shadowStrength = Math.max(0, Math.min(1, v)); },

    get flicker() { return _requireLight(entity).flicker; },
    set flicker(v) { _requireLight(entity).flicker = !!v; },
    get flickerSpeed() { return _requireLight(entity).flickerSpeed; },
    set flickerSpeed(v) { _requireLight(entity).flickerSpeed = Math.max(0, v); },
    get flickerDuration() { return _requireLight(entity).flickerDuration; },
    set flickerDuration(v) { _requireLight(entity).flickerDuration = Math.max(0, v); },
    get coreSize() { return _requireLight(entity).coreSize; },
    set coreSize(v) { _requireLight(entity).coreSize = Math.max(0.01, Math.min(1, v)); },
    get coreVisible() { return _requireLight(entity).coreVisible; },
    set coreVisible(v) { _requireLight(entity).coreVisible = !!v; },
  };

  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      var key = String(prop);
      // First check: is this even a known light property at all?
      if (!(key in t) && !LIGHT_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.light." + key + " does not exist. " +
          "Valid members: " + Array.from(LIGHT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      // Second check: is it valid for the current light type?
      var light = entity.getComponent(LIGHT);
      if (light && LIGHT_MEMBERS.has(key)) {
        var typeMembers = _membersForType(light.type);
        if (!typeMembers.has(key)) {
          throw _tag(new Error(
            "this.light." + key + " is not available on a " + light.type + " light. " +
            "Available properties for " + light.type + ": " +
            Array.from(typeMembers).join(", ") + "."
          ), "wrong-light-type");
        }
      }
      var v = t[key];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !LIGHT_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.light." + key + " does not exist. " +
          "Valid members: " + Array.from(LIGHT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      // Type check on write too.
      var light = entity.getComponent(LIGHT);
      if (light && LIGHT_MEMBERS.has(key)) {
        var typeMembers = _membersForType(light.type);
        if (!typeMembers.has(key)) {
          throw _tag(new Error(
            "this.light." + key + " cannot be set on a " + light.type + " light. " +
            "Available properties for " + light.type + ": " +
            Array.from(typeMembers).join(", ") + "."
          ), "wrong-light-type");
        }
      }
      t[key] = value;
      return true;
    },
  });
}
