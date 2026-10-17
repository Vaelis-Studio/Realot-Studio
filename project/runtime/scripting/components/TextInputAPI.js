/**
 * runtime/scripting/components/TextInputAPI.js
 *
 * The `this.textInput` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). Mirrors TextAPI.js/ChatLogAPI.js's Proxy
 * pattern. The typical read pattern:
 *
 *   function onUpdate() {
 *     if (this.textInput.justSubmitted) {
 *       var said = this.textInput.value;
 *       // decide what the NPC says back based on `said`
 *     }
 *   }
 *
 * value/focused/justSubmitted reflect real player typing — see
 * runtime/systems/TextInputSystem.js for how the actual keystrokes get
 * in here.
 *
 * RUNTIME-ONLY FILE.
 */

import { TEXT_INPUT } from "../../components/TextInput.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _requireInput(entity) {
  var t = entity.getComponent(TEXT_INPUT);
  if (!t) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.textInput but has no Text Input component. " +
    "Add one in the Inspector (Add Component → Text Input)."
  ), "missing-component");
  return t;
}

const INPUT_MEMBERS = new Set([
  "value", "placeholder", "maxLength", "fontSize", "fontFamily",
  "textColor", "placeholderColor", "backgroundColor", "borderColor",
  "borderWidth", "cornerRadius", "width", "height", "padding",
  "clearOnSubmit", "focused", "justSubmitted",
  "clear",
]);

/**
 * Builds the `this.textInput` object for a given entity.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createTextInputAPI(entity) {
  const target = {
    /** The text currently typed into the field (read/write). Setting
     *  this while the player is actively focused/typing won't fight
     *  their keystrokes — it only pushes through once they're not
     *  focused. */
    get value() { return _requireInput(entity).value; },
    set value(v) { _requireInput(entity).value = String(v); },
    get placeholder() { return _requireInput(entity).placeholder; },
    set placeholder(v) { _requireInput(entity).placeholder = v; },
    get maxLength() { return _requireInput(entity).maxLength; },
    set maxLength(v) {
      const n = Number(v);
      _requireInput(entity).maxLength = Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
    },
    get fontSize() { return _requireInput(entity).fontSize; },
    set fontSize(v) {
      const n = Number(v);
      _requireInput(entity).fontSize = Number.isFinite(n) ? n : 18;
    },
    get fontFamily() { return _requireInput(entity).fontFamily; },
    set fontFamily(v) { _requireInput(entity).fontFamily = v; },
    get textColor() { return _requireInput(entity).textColor; },
    set textColor(v) { _requireInput(entity).textColor = v; },
    get placeholderColor() { return _requireInput(entity).placeholderColor; },
    set placeholderColor(v) { _requireInput(entity).placeholderColor = v; },
    get backgroundColor() { return _requireInput(entity).backgroundColor; },
    set backgroundColor(v) { _requireInput(entity).backgroundColor = v; },
    get borderColor() { return _requireInput(entity).borderColor; },
    set borderColor(v) { _requireInput(entity).borderColor = v; },
    get borderWidth() { return _requireInput(entity).borderWidth; },
    set borderWidth(v) {
      const n = Number(v);
      _requireInput(entity).borderWidth = Number.isFinite(n) ? n : 0;
    },
    get cornerRadius() { return _requireInput(entity).cornerRadius; },
    set cornerRadius(v) {
      const n = Number(v);
      _requireInput(entity).cornerRadius = Number.isFinite(n) ? n : 8;
    },
    get width() { return _requireInput(entity).width; },
    set width(v) {
      const n = Number(v);
      _requireInput(entity).width = Number.isFinite(n) ? n : 260;
    },
    get height() { return _requireInput(entity).height; },
    set height(v) {
      const n = Number(v);
      _requireInput(entity).height = Number.isFinite(n) ? n : 40;
    },
    get padding() { return _requireInput(entity).padding; },
    set padding(v) {
      const n = Number(v);
      _requireInput(entity).padding = Number.isFinite(n) ? n : 10;
    },
    /** true = the field empties itself automatically right after Enter
     *  (typical chat-box behavior). false = value stays after submit. */
    get clearOnSubmit() { return _requireInput(entity).clearOnSubmit; },
    set clearOnSubmit(v) { _requireInput(entity).clearOnSubmit = !!v; },
    /** True while the player is actively typing into this field
     *  (read-only — driven by real focus/blur on the underlying input,
     *  not something a script sets directly; mobile browsers block
     *  programmatic focus outside a direct user tap anyway). */
    get focused() { return _requireInput(entity).focused; },
    /** True for exactly one frame right after the player presses Enter
     *  — read this.textInput.value in the SAME frame to see what they
     *  typed (read-only). */
    get justSubmitted() { return _requireInput(entity).justSubmitted; },
    /** Empties the field immediately (equivalent to clearOnSubmit's
     *  automatic behavior, callable any time). */
    clear: function () { _requireInput(entity).value = ""; },
  };
  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !INPUT_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.textInput." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(INPUT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      return t[prop];
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !INPUT_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.textInput." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(INPUT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var descriptor = Object.getOwnPropertyDescriptor(t, key);
      if (descriptor && descriptor.get && !descriptor.set) {
        throw _tag(new Error(
          "this.textInput." + key + " is read-only and can't be set directly."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
