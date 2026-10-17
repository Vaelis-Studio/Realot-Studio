/**
 * runtime/scripting/components/SpeechBubbleAPI.js
 *
 * The `this.speechBubble` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). Mirrors TextAPI.js's structure/Proxy pattern
 * closely, plus two convenience methods (show/hide) since "say this for
 * N seconds" is the overwhelmingly common way a speech bubble actually
 * gets used from a script — see the file header on components/
 * SpeechBubble.js for why hideTimer itself lives on the component
 * rather than as private state here.
 *
 * RUNTIME-ONLY FILE.
 */

import { SPEECH_BUBBLE } from "../../components/SpeechBubble.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _requireBubble(entity) {
  var b = entity.getComponent(SPEECH_BUBBLE);
  if (!b) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.speechBubble but has no Speech Bubble component. " +
    "Add one in the Inspector (Add Component → Speech Bubble)."
  ), "missing-component");
  return b;
}

const BUBBLE_MEMBERS = new Set([
  "text", "visible", "backgroundColor", "textColor", "borderColor", "borderWidth",
  "fontSize", "fontFamily", "padding", "cornerRadius", "maxWidth",
  "offsetX", "offsetY", "tailDirection", "tailSize",
  "show", "hide",
]);

/**
 * Builds the `this.speechBubble` object for a given entity.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createSpeechBubbleAPI(entity) {
  const target = {
    /** The text shown inside the bubble. Prefer show(text) over setting
     *  this directly if you also want the bubble to become visible. */
    get text() { return _requireBubble(entity).text; },
    set text(v) { _requireBubble(entity).text = String(v); },
    /** Whether the bubble is currently shown (read/write). */
    get visible() { return _requireBubble(entity).visible; },
    set visible(v) { _requireBubble(entity).visible = !!v; },
    get backgroundColor() { return _requireBubble(entity).backgroundColor; },
    set backgroundColor(v) { _requireBubble(entity).backgroundColor = v; },
    get textColor() { return _requireBubble(entity).textColor; },
    set textColor(v) { _requireBubble(entity).textColor = v; },
    get borderColor() { return _requireBubble(entity).borderColor; },
    set borderColor(v) { _requireBubble(entity).borderColor = v; },
    get borderWidth() { return _requireBubble(entity).borderWidth; },
    set borderWidth(v) {
      const n = Number(v);
      _requireBubble(entity).borderWidth = Number.isFinite(n) ? n : 0;
    },
    get fontSize() { return _requireBubble(entity).fontSize; },
    set fontSize(v) {
      const n = Number(v);
      _requireBubble(entity).fontSize = Number.isFinite(n) ? n : 20;
    },
    get fontFamily() { return _requireBubble(entity).fontFamily; },
    set fontFamily(v) { _requireBubble(entity).fontFamily = v; },
    get padding() { return _requireBubble(entity).padding; },
    set padding(v) {
      const n = Number(v);
      _requireBubble(entity).padding = Number.isFinite(n) ? n : 12;
    },
    get cornerRadius() { return _requireBubble(entity).cornerRadius; },
    set cornerRadius(v) {
      const n = Number(v);
      _requireBubble(entity).cornerRadius = Number.isFinite(n) ? n : 10;
    },
    /** Px width the text wraps at. */
    get maxWidth() { return _requireBubble(entity).maxWidth; },
    set maxWidth(v) {
      const n = Number(v);
      _requireBubble(entity).maxWidth = Number.isFinite(n) ? n : 220;
    },
    /** Px offset from this entity's own position — where the bubble sits. */
    get offsetX() { return _requireBubble(entity).offsetX; },
    set offsetX(v) {
      const n = Number(v);
      _requireBubble(entity).offsetX = Number.isFinite(n) ? n : 0;
    },
    get offsetY() { return _requireBubble(entity).offsetY; },
    set offsetY(v) {
      const n = Number(v);
      _requireBubble(entity).offsetY = Number.isFinite(n) ? n : -60;
    },
    /** "down" | "up" | "left" | "right" | "none" — which edge the little pointer sits on. */
    get tailDirection() { return _requireBubble(entity).tailDirection; },
    set tailDirection(v) { _requireBubble(entity).tailDirection = v; },
    get tailSize() { return _requireBubble(entity).tailSize; },
    set tailSize(v) {
      const n = Number(v);
      _requireBubble(entity).tailSize = Number.isFinite(n) ? n : 14;
    },
    /**
     * Shows the bubble with this text. Pass a duration (seconds) to
     * auto-hide after that long — omit it (or pass 0) to leave the
     * bubble showing until you call hide() yourself:
     *   this.speechBubble.show("Watch out!", 2); // shows for 2 seconds
     *   this.speechBubble.show("..."); // stays until hide() is called
     */
    show: function (text, duration) {
      var b = _requireBubble(entity);
      b.text = String(text);
      b.visible = true;
      b.hideTimer = duration > 0 ? duration : 0;
    },
    /** Hides the bubble immediately. */
    hide: function () {
      var b = _requireBubble(entity);
      b.visible = false;
      b.hideTimer = 0;
    },
  };
  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !BUBBLE_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.speechBubble." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(BUBBLE_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      return t[prop];
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !BUBBLE_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.speechBubble." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(BUBBLE_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var descriptor = Object.getOwnPropertyDescriptor(t, key);
      if (descriptor && descriptor.get && !descriptor.set) {
        throw _tag(new Error(
          "this.speechBubble." + key + " is read-only and can't be set directly."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
