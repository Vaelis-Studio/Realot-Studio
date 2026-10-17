/**
 * runtime/scripting/components/ShadowCasterAPI.js
 *
 * The `this.shadowCaster` sub-object exposed to user scripts on any
 * entity that has a ShadowCaster component (see
 * components/ShadowCaster.js). Lets scripts toggle an occluder on/off,
 * tune its shadow length/opacity/softness, or resize/offset its
 * blocking shape at runtime — e.g. a window that stops casting a
 * shadow when its shutter closes, or a shadow that fades as an object
 * dissolves.
 *
 * Only offered to entities that actually have a ShadowCaster component;
 * accessing this.shadowCaster on an entity without one throws a clear
 * "missing component" error with an Inspector hint, same pattern as
 * this.light / this.ear.
 *
 * RUNTIME-ONLY FILE.
 */

import { SHADOW_CASTER } from "../../components/ShadowCaster.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

/** Throws a descriptive error when a script calls this.shadowCaster on an
 *  entity without a Shadow Caster component. */
function _requireShadowCaster(entity) {
  var s = entity.getComponent(SHADOW_CASTER);
  if (!s) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.shadowCaster but has no Shadow Caster component. " +
    "Add one in the Inspector (Add Component → Shadow Caster)."
  ), "missing-component");
  return s;
}

const SHADOW_CASTER_MEMBERS = new Set([
  "enabled", "width", "height", "offsetX", "offsetY", "opacity", "length", "softness",
]);

/**
 * Builds the `this.shadowCaster` object for a given entity. All reads and
 * writes go directly to the live ShadowCaster component data, so toggling
 * `enabled` or changing `opacity` in onUpdate() takes effect immediately
 * on the next rendered frame (LightingSystem re-reads every frame).
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createShadowCasterAPI(entity) {
  const target = {
    /**
     * Per-entity on/off for shadow casting. Set to false to temporarily
     * exclude this occluder (e.g. a see-through window) without removing
     * the component.
     */
    get enabled() { return _requireShadowCaster(entity).enabled; },
    set enabled(v) { _requireShadowCaster(entity).enabled = !!v; },

    /**
     * Optional explicit occluder width override, in world units/px.
     * null (the default) uses this entity's real rendered sprite bounds.
     */
    get width() { return _requireShadowCaster(entity).width; },
    set width(v) { _requireShadowCaster(entity).width = v; },

    /**
     * Optional explicit occluder height override, in world units/px.
     * null (the default) uses this entity's real rendered sprite bounds.
     */
    get height() { return _requireShadowCaster(entity).height; },
    set height(v) { _requireShadowCaster(entity).height = v; },

    /** Occluder box center X offset from the entity's Transform, in LOCAL space. */
    get offsetX() { return _requireShadowCaster(entity).offsetX; },
    set offsetX(v) { _requireShadowCaster(entity).offsetX = v; },

    /** Occluder box center Y offset from the entity's Transform, in LOCAL space. */
    get offsetY() { return _requireShadowCaster(entity).offsetY; },
    set offsetY(v) { _requireShadowCaster(entity).offsetY = v; },

    /**
     * How dark this object's shadow reads, 0 (invisible/no shadow) to 1
     * (full ambient darkness). Multiplied with the casting light's own
     * shadowStrength. Clamped to [0, 1].
     */
    get opacity() { return _requireShadowCaster(entity).opacity; },
    set opacity(v) { _requireShadowCaster(entity).opacity = Math.max(0, Math.min(1, v)); },

    /**
     * How far this object's shadow reaches, as a multiplier on the
     * casting light's natural reach. 1 = normal reach, 0.5 = a short
     * contact-y shadow, 2 = a long late-afternoon-sun-style shadow.
     * Clamped to >= 0.
     */
    get length() { return _requireShadowCaster(entity).length; },
    set length(v) { _requireShadowCaster(entity).length = Math.max(0, v); },

    /**
     * Soft shadow edge (penumbra) amount in world units/px. 0 = crisp
     * hard edge. Clamped to >= 0.
     */
    get softness() { return _requireShadowCaster(entity).softness; },
    set softness(v) { _requireShadowCaster(entity).softness = Math.max(0, v); },
  };

  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      var key = String(prop);
      if (!(key in t) && !SHADOW_CASTER_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.shadowCaster." + key + " does not exist. " +
          "Valid members: " + Array.from(SHADOW_CASTER_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var v = t[key];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !SHADOW_CASTER_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.shadowCaster." + key + " does not exist. " +
          "Valid members: " + Array.from(SHADOW_CASTER_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
