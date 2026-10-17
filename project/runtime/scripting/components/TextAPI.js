/**
 * runtime/scripting/components/TextAPI.js
 *
 * The `this.text` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the rationale. Mirrors
 * SpriteAPI.js's structure closely since TextRenderer is, like
 * SpriteRenderer, a single-shape optional visual component.
 *
 * RUNTIME-ONLY FILE.
 */

import { TEXT_RENDERER } from "../../components/TextRenderer.js";

/** Tags an Error with a machine-readable `kind` so ScriptSystem can
 *  format a specific, actionable console message. */
function _tag(err, kind) {
  err.kind = kind;
  return err;
}

/** Throws a descriptive error when a script calls this.text on an
 *  entity that has no TextRenderer. The error propagates through
 *  ScriptSystem's per-lifecycle try/catch and is reported to the editor
 *  console — same path as any other script runtime error. */
function _requireText(entity) {
  var t = entity.getComponent(TEXT_RENDERER);
  if (!t) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.text but has no Text component. " +
    "Add one in the Inspector (Add Component → Text)."
  ), "missing-component");
  return t;
}

const TEXT_MEMBERS = new Set([
  "value", "fontSize", "color", "fontFamily", "bold", "italic",
  "align", "anchorX", "anchorY", "opacity", "screenSpace", "wordWrap", "wrapWidth",
]);

/**
 * Builds the `this.text` object for a given entity.
 * Accessing any property throws a clear error if the entity has no
 * TextRenderer, so the editor console shows exactly what is missing
 * instead of silently returning a default value. Accessing an unknown
 * property (typo) throws a distinct "does not exist" error rather than
 * silently returning undefined — same contract as this.sprite.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createTextAPI(entity) {
  const target = {
    /** The actual string shown on screen. Set it from a script to make
     *  dynamic text — e.g. this.text.value = "Score: " + global.score. */
    get value() { return _requireText(entity).value; },
    set value(v) { _requireText(entity).value = String(v); },
    get fontSize() { return _requireText(entity).fontSize; },
    set fontSize(v) {
      const n = Number(v);
      _requireText(entity).fontSize = Number.isFinite(n) ? n : 32;
    },
    get color() { return _requireText(entity).color; },
    set color(v) { _requireText(entity).color = v; },
    get fontFamily() { return _requireText(entity).fontFamily; },
    set fontFamily(v) { _requireText(entity).fontFamily = v; },
    get bold() { return _requireText(entity).bold; },
    set bold(v) { _requireText(entity).bold = !!v; },
    get italic() { return _requireText(entity).italic; },
    set italic(v) { _requireText(entity).italic = !!v; },
    /** "left" | "center" | "right" — multi-line text alignment. */
    get align() { return _requireText(entity).align; },
    set align(v) { _requireText(entity).align = v; },
    /** 0–1 — this text's own pivot point (0.5 = centered on this.x/this.y). */
    get anchorX() { return _requireText(entity).anchorX; },
    set anchorX(v) {
      const n = Number(v);
      _requireText(entity).anchorX = Number.isFinite(n) ? n : 0.5;
    },
    get anchorY() { return _requireText(entity).anchorY; },
    set anchorY(v) {
      const n = Number(v);
      _requireText(entity).anchorY = Number.isFinite(n) ? n : 0.5;
    },
    /** 0.0–1.0 transparency, same convention as this.sprite.opacity. */
    get opacity() { return _requireText(entity).opacity; },
    set opacity(v) {
      const n = Number(v);
      _requireText(entity).opacity = Number.isFinite(n) ? n : 1;
    },
    /** true = fixed screen-space UI label (this.x/this.y are raw screen
     *  pixels, never moves with the camera). false = world-space, pans/
     *  zooms with the Main Camera like a sprite. See TextRenderer.js. */
    get screenSpace() { return _requireText(entity).screenSpace; },
    set screenSpace(v) { _requireText(entity).screenSpace = !!v; },
    get wordWrap() { return _requireText(entity).wordWrap; },
    set wordWrap(v) { _requireText(entity).wordWrap = !!v; },
    /** Px width the text wraps at — only takes effect while wordWrap is true. */
    get wrapWidth() { return _requireText(entity).wrapWidth; },
    set wrapWidth(v) {
      const n = Number(v);
      _requireText(entity).wrapWidth = Number.isFinite(n) ? n : 300;
    },
  };
  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !TEXT_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.text." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(TEXT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      return t[prop];
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !TEXT_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.text." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(TEXT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var descriptor = Object.getOwnPropertyDescriptor(t, key);
      if (descriptor && descriptor.get && !descriptor.set) {
        throw _tag(new Error(
          "this.text." + key + " is read-only and can't be set directly."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
