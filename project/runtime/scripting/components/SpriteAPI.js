/**
 * runtime/scripting/components/SpriteAPI.js
 *
 * The `this.sprite` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the rationale.
 *
 * RUNTIME-ONLY FILE.
 */

import { SPRITE_RENDERER } from "../../components/SpriteRenderer.js";

/** Tags an Error with a machine-readable `kind` so ScriptSystem can
 *  format a specific, actionable console message. */
function _tag(err, kind) {
  err.kind = kind;
  return err;
}

/** Throws a descriptive error when a script calls this.sprite on an
 *  entity that has no SpriteRenderer. The error propagates through
 *  ScriptSystem's per-lifecycle try/catch and is reported to the editor
 *  console — same path as any other script runtime error. */
function _requireSprite(entity) {
  var s = entity.getComponent(SPRITE_RENDERER);
  if (!s) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.sprite but has no Sprite Renderer. " +
    "Add one in the Inspector (Add Component → Sprite Renderer)."
  ), "missing-component");
  return s;
}

const SPRITE_MEMBERS = new Set(["texture", "color", "flipX", "flipY", "opacity"]);

/**
 * Builds the `this.sprite` object for a given entity.
 * Accessing any property throws a clear error if the entity has no
 * SpriteRenderer, so the editor console shows exactly what is missing
 * instead of silently returning a default value. Accessing an unknown
 * property (typo) throws a distinct "does not exist" error rather than
 * silently returning undefined.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createSpriteAPI(entity) {
  const target = {
    get texture() { return _requireSprite(entity).spriteKey; },
    set texture(v) { _requireSprite(entity).spriteKey = v; },
    get color() { return _requireSprite(entity).color; },
    set color(v) { _requireSprite(entity).color = v; },
    get flipX() { return _requireSprite(entity).flipX; },
    set flipX(v) { _requireSprite(entity).flipX = !!v; },
    get flipY() { return _requireSprite(entity).flipY; },
    set flipY(v) { _requireSprite(entity).flipY = !!v; },
    /** 0.0–1.0 transparency. RenderSystem copies this onto the live
     *  PIXI sprite's `.alpha` each frame, so changing it at runtime fades
     *  the sprite in/out immediately (no re-deserialize needed). */
    get opacity() { return _requireSprite(entity).opacity; },
    set opacity(v) {
      const n = Number(v);
      _requireSprite(entity).opacity = (Number.isFinite(n) ? n : 1);
    },
  };
  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !SPRITE_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.sprite." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(SPRITE_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      return t[prop];
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !SPRITE_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.sprite." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(SPRITE_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      // Read-only guard (none of SPRITE_MEMBERS are read-only today,
      // but this keeps the file self-maintaining if one becomes
      // read-only later, instead of silently letting JS's own raw,
      // untagged TypeError leak through — see AnimatorAPI.js's set
      // trap for the same pattern).
      var descriptor = Object.getOwnPropertyDescriptor(t, key);
      if (descriptor && descriptor.get && !descriptor.set) {
        throw _tag(new Error(
          "this.sprite." + key + " is read-only and can't be set directly."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
