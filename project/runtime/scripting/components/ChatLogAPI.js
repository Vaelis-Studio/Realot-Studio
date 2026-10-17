/**
 * runtime/scripting/components/ChatLogAPI.js
 *
 * The `this.chat` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). Mirrors TextAPI.js/SpeechBubbleAPI.js's
 * Proxy pattern, plus send()/clear() since appending a message is the
 * overwhelmingly common way this actually gets used.
 *
 * RUNTIME-ONLY FILE.
 */

import { CHAT_LOG } from "../../components/ChatLog.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _requireChat(entity) {
  var c = entity.getComponent(CHAT_LOG);
  if (!c) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.chat but has no Chat Log component. " +
    "Add one in the Inspector (Add Component → Chat Log)."
  ), "missing-component");
  return c;
}

const CHAT_MEMBERS = new Set([
  "messages", "maxMessages", "visibleCount", "width", "lineHeight",
  "fontSize", "fontFamily", "messageColor", "senderColor",
  "backgroundColor", "backgroundOpacity", "padding", "showSender",
  "screenSpace", "visible",
  "send", "clear",
]);

/**
 * Builds the `this.chat` object for a given entity.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createChatLogAPI(entity) {
  const target = {
    /** Read-only snapshot of the message history (oldest first), each
     *  { sender, text, senderColor }. Use send() to add to it — don't
     *  push directly onto this array, it won't be trimmed to
     *  maxMessages if you do. */
    get messages() { return _requireChat(entity).messages.slice(); },
    get maxMessages() { return _requireChat(entity).maxMessages; },
    set maxMessages(v) {
      const n = Number(v);
      _requireChat(entity).maxMessages = Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
    },
    get visibleCount() { return _requireChat(entity).visibleCount; },
    set visibleCount(v) {
      const n = Number(v);
      _requireChat(entity).visibleCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : 6;
    },
    get width() { return _requireChat(entity).width; },
    set width(v) {
      const n = Number(v);
      _requireChat(entity).width = Number.isFinite(n) ? n : 320;
    },
    get lineHeight() { return _requireChat(entity).lineHeight; },
    set lineHeight(v) {
      const n = Number(v);
      _requireChat(entity).lineHeight = Number.isFinite(n) ? n : 26;
    },
    get fontSize() { return _requireChat(entity).fontSize; },
    set fontSize(v) {
      const n = Number(v);
      _requireChat(entity).fontSize = Number.isFinite(n) ? n : 16;
    },
    get fontFamily() { return _requireChat(entity).fontFamily; },
    set fontFamily(v) { _requireChat(entity).fontFamily = v; },
    get messageColor() { return _requireChat(entity).messageColor; },
    set messageColor(v) { _requireChat(entity).messageColor = v; },
    /** Default sender-name color used when send() isn't given its own color. */
    get senderColor() { return _requireChat(entity).senderColor; },
    set senderColor(v) { _requireChat(entity).senderColor = v; },
    get backgroundColor() { return _requireChat(entity).backgroundColor; },
    set backgroundColor(v) { _requireChat(entity).backgroundColor = v; },
    get backgroundOpacity() { return _requireChat(entity).backgroundOpacity; },
    set backgroundOpacity(v) {
      const n = Number(v);
      _requireChat(entity).backgroundOpacity = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
    },
    get padding() { return _requireChat(entity).padding; },
    set padding(v) {
      const n = Number(v);
      _requireChat(entity).padding = Number.isFinite(n) ? n : 10;
    },
    /** false = just the message text, no "Name: " prefix. */
    get showSender() { return _requireChat(entity).showSender; },
    set showSender(v) { _requireChat(entity).showSender = !!v; },
    get screenSpace() { return _requireChat(entity).screenSpace; },
    set screenSpace(v) { _requireChat(entity).screenSpace = !!v; },
    get visible() { return _requireChat(entity).visible; },
    set visible(v) { _requireChat(entity).visible = !!v; },
    /**
     * Appends a message to the log — the normal way to use this:
     *   this.chat.send("Alex", "hey, you online?");
     *   this.chat.send("Guard", "Halt! Who goes there?", "#ff6666"); // custom color for this message only
     * Oldest messages are dropped automatically once maxMessages is
     * exceeded — you never need to trim the list yourself.
     */
    send: function (sender, text, color) {
      var c = _requireChat(entity);
      c.messages.push({
        sender: String(sender != null ? sender : ""),
        text: String(text != null ? text : ""),
        senderColor: color || c.senderColor,
      });
      while (c.messages.length > c.maxMessages) c.messages.shift();
    },
    /** Empties the whole message history. */
    clear: function () {
      _requireChat(entity).messages.length = 0;
    },
  };
  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !CHAT_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.chat." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(CHAT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      return t[prop];
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !CHAT_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.chat." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(CHAT_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var descriptor = Object.getOwnPropertyDescriptor(t, key);
      if (descriptor && descriptor.get && !descriptor.set) {
        throw _tag(new Error(
          "this.chat." + key + " is read-only and can't be set directly."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
