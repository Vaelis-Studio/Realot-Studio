/**
 * runtime/scripting/components/LightingSettingsAPI.js
 *
 * The `scene.lighting` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js's getGlobals()) — lets scripts tune scene-wide
 * lighting/shadow realism settings at runtime (see
 * components/LightingSettings.js for the full field guide), e.g.
 * fading ambientDarkness up for a day-to-night transition, or swapping
 * shadowMode when a low-end device is detected.
 *
 * Unlike every OTHER *API.js file in this folder, LightingSettings is
 * not a per-entity component gated behind `this.<name>` — it's scene-wide
 * singleton data (same idea as Camera's enablePseudo3D, but promoted to
 * its own component — see LightingSettings.js's header), so it hangs
 * off `scene.lighting` instead, alongside scene.load()/scene.pause()/etc.
 *
 * If the scene has no LightingSettings entity at all, reads fall back to
 * the same defaults LightingSystem itself uses (see
 * systems/LightingSystem.js's _readSettings()) rather than throwing —
 * unlike a missing per-entity component (this.light on a light-less
 * entity), a missing scene-wide settings entity is a normal, valid scene
 * state (LightingSystem already handles it), not a script mistake.
 * Writes when no LightingSettings entity exists are silently no-ops
 * (nothing to write to) — this mirrors scene.pause()/scene.load()
 * degrading gracefully rather than throwing when their backing system
 * isn't wired up.
 *
 * RUNTIME-ONLY FILE.
 */

import { LIGHTING_SETTINGS } from "../../components/LightingSettings.js";
import { ShadowMode } from "../../systems/LightingQuality.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

const LIGHTING_SETTINGS_MEMBERS = new Set([
  "shadowMode", "raymarchSteps", "ambientDarkness", "glowStrength",
]);

// Same fallback defaults LightingSystem._readSettings() uses when a scene
// has no LightingSettings entity, so scripts reading scene.lighting see
// the same numbers the renderer is actually using.
const DEFAULTS = Object.freeze({
  shadowMode: ShadowMode.QUAD,
  raymarchSteps: 24,
  ambientDarkness: 0.65,
  glowStrength: 1,
});

/**
 * Builds the `scene.lighting` object. All reads/writes go directly to the
 * live LightingSettings component data (found fresh via world.query()
 * each access, same as LightingSystem._readSettings()), so changing
 * ambientDarkness in onUpdate() takes effect immediately on the next
 * rendered frame.
 * @param {import('../../core/World.js').World} world
 * @returns {object}
 */
export function createLightingSettingsAPI(world) {
  function _find() {
    if (!world || typeof world.query !== "function") return null;
    var entity = world.query(LIGHTING_SETTINGS)[0];
    return entity ? entity.getComponent(LIGHTING_SETTINGS) : null;
  }

  const target = {
    /**
     * "Quad" (cheap analytic shadows) or "Raymarch" (true per-pixel
     * shadow occlusion, correct soft edges, higher GPU cost). Falls back
     * to "Quad" when the scene has no LightingSettings entity.
     */
    get shadowMode() { var s = _find(); return s ? s.shadowMode : DEFAULTS.shadowMode; },
    set shadowMode(v) { var s = _find(); if (s) s.shadowMode = v; },

    /**
     * Raymarch step count (1-200), only used when shadowMode ===
     * "Raymarch". Higher = smoother shadow edges and fewer thin-occluder
     * leaks, at higher GPU cost.
     */
    get raymarchSteps() { var s = _find(); return s ? s.raymarchSteps : DEFAULTS.raymarchSteps; },
    set raymarchSteps(v) { var s = _find(); if (s) s.raymarchSteps = Math.max(1, Math.min(200, Number(v) || 24)); },

    /**
     * How dark the world gets where no light reaches, 0 (no darkening,
     * full daylight everywhere) to 1 (pitch black outside any light's
     * reach). The single biggest "how moody does my lighting look" dial.
     */
    get ambientDarkness() { var s = _find(); return s ? s.ambientDarkness : DEFAULTS.ambientDarkness; },
    set ambientDarkness(v) { var s = _find(); if (s) s.ambientDarkness = Math.max(0, Math.min(1, v)); },

    /**
     * How visible a light's own glow is in open air (not just where it
     * lands on a sprite). 0 = no open-air glow, 1 = normal, higher =
     * brighter/further "hot" glow.
     */
    get glowStrength() { var s = _find(); return s ? s.glowStrength : DEFAULTS.glowStrength; },
    set glowStrength(v) { var s = _find(); if (s) s.glowStrength = Math.max(0, v); },
  };

  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      var key = String(prop);
      if (!(key in t) && !LIGHTING_SETTINGS_MEMBERS.has(key)) {
        throw _tag(new Error(
          "scene.lighting." + key + " does not exist. " +
          "Valid members: " + Array.from(LIGHTING_SETTINGS_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var v = t[key];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !LIGHTING_SETTINGS_MEMBERS.has(key)) {
        throw _tag(new Error(
          "scene.lighting." + key + " does not exist. " +
          "Valid members: " + Array.from(LIGHTING_SETTINGS_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
