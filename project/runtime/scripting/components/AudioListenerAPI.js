/**
 * runtime/scripting/components/AudioListenerAPI.js
 *
 * The `this.ear` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js) — the query surface for the AudioListener
 * component (see components/AudioListener.js). Detection itself (which
 * 3D AudioSources currently fall inside the radius) is computed once
 * per frame by runtime/systems/AudioListenerSystem.js, which also
 * fires onHearSound(source)/onLoseSound(source) via ScriptSystem — this
 * file just exposes that same computed result to scripts as a live
 * read-only view, one file per scripting component (see
 * TransformAPI.js's header comment for the general rationale).
 *
 * RUNTIME-ONLY FILE.
 */

import { AUDIO_LISTENER } from "../../components/AudioListener.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

/** Throws a descriptive error when a script calls this.ear on an entity
 *  without an Audio Listener component. */
function _requireEar(entity) {
  var e = entity.getComponent(AUDIO_LISTENER);
  if (!e) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.ear but has no Audio Listener component. " +
    "Add one in the Inspector (Add Component → Audio Listener)."
  ), "missing-component");
  return e;
}

const EAR_MEMBERS = new Set(["radius", "enabled", "sourcesInRange", "canHear"]);

/**
 * Builds the `this.ear` object for a given entity.
 * @param {import('../../core/Entity.js').Entity} entity
 * @param {object} scriptApi  ScriptAPI instance — used to resolve raw
 *   Entity ids (from AudioListenerSystem's per-frame detection set)
 *   into live EntityContexts for sourcesInRange/canHear, same
 *   resolve-through-scriptApi pattern raycast()/find() already use.
 * @returns {object}
 */
export function createAudioListenerAPI(entity, scriptApi) {
  const target = {
    /** Hearing radius in world units. Throws if no Audio Listener component. */
    get radius() { return _requireEar(entity).radius; },
    set radius(v) { _requireEar(entity).radius = Math.max(0, v); },
    /** Whether this listener is currently detecting sounds at all. */
    get enabled() { return _requireEar(entity).enabled; },
    set enabled(v) { _requireEar(entity).enabled = !!v; },
    /**
     * Every 3D AudioSource entity currently inside this listener's
     * radius, as an array of live EntityContexts (empty array if
     * none — never null, matches findAll()'s "always an array"
     * convention). Recomputed fresh every frame by
     * AudioListenerSystem — reading this never returns stale data
     * from a previous frame.
     *   var nearby = this.ear.sourcesInRange;
     *   for (var i = 0; i < nearby.length; i++) { ... }
     */
    get sourcesInRange() {
      _requireEar(entity);
      var ids = scriptApi._audioListenerRangeFn ? scriptApi._audioListenerRangeFn(entity.id) : [];
      var out = [];
      for (var i = 0; i < ids.length; i++) {
        var e = scriptApi.world.getEntity(ids[i]);
        if (e) out.push(scriptApi.createEntityContext(e));
      }
      return out;
    },
    /**
     * True if the named (or tagged, with {byTag:true}) 3D AudioSource
     * entity is currently within range of this listener — the
     * beginner-friendly single-target check, so a script doesn't have
     * to loop sourcesInRange itself for the common "can I hear THIS
     * one specific thing" case:
     *   if (this.ear.canHear("Siren")) { this.playAlarm(); }
     *   if (this.ear.canHear("Enemy", { byTag: true })) { ... }
     */
    canHear: function (nameOrTag, opts) {
      _requireEar(entity);
      opts = opts || {};
      var nearby = target.sourcesInRange;
      for (var i = 0; i < nearby.length; i++) {
        var match = opts.byTag ? nearby[i].tag === nameOrTag : nearby[i].name === nameOrTag;
        if (match) return true;
      }
      return false;
    },
  };

  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !EAR_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.ear." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(EAR_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var v = t[prop];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !EAR_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.ear." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(EAR_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var descriptor = Object.getOwnPropertyDescriptor(t, key);
      if (descriptor && descriptor.get && !descriptor.set) {
        throw _tag(new Error(
          "this.ear." + key + " is read-only."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
