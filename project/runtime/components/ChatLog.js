/**
 * runtime/components/ChatLog.js
 *
 * A scrolling chat/message-history panel — a background box showing the
 * last few messages, each as "Sender: text" with the sender name in its
 * own color. Useful two ways:
 *   - NPC dialogue history — a running log of what's been said, instead
 *     of (or alongside) a single SpeechBubble.
 *   - Live/multiplayer chat — call this.chat.send(name, text) whenever a
 *     message arrives and the panel handles history, trimming, and
 *     layout for you.
 *
 * Like SpriteRenderer/TextRenderer/SpeechBubble, this is plain
 * serializable data — it never holds a PIXI object directly.
 * runtime/systems/RenderSystem.js is the only place that turns it into
 * actual PIXI objects (RULES.txt #5).
 *
 * `messages` holds real chat history rather than being hand-authored in
 * the Inspector — same reasoning as SpeechBubble's hideTimer: keeping it
 * here (not off in some other system's private state) means save/load
 * and the Inspector both see the real current log, not a hidden value
 * they can't inspect. Normally added to via this.chat.send(...), not by
 * hand.
 *
 * RUNTIME-ONLY FILE.
 */

export const CHAT_LOG = "ChatLog";

export class ChatLog {
  constructor({
    messages = [],          // [{ sender, text, senderColor }], oldest first
    maxMessages = 50,        // total history kept — oldest dropped once exceeded
    visibleCount = 6,        // how many of the most recent messages are shown at once
    width = 320,
    lineHeight = 26,
    fontSize = 16,
    fontFamily = "Arial",
    messageColor = "#ffffff",
    senderColor = "#ffd700", // default sender-name color if a message doesn't specify its own
    backgroundColor = "#000000",
    backgroundOpacity = 0.5, // semi-transparent panel behind the text, typical chat-overlay look
    padding = 10,
    showSender = true,       // false = just the message text, no "Name: " prefix (good for narration logs)
    screenSpace = true,      // see TextRenderer.js's file header for the exact meaning — true = fixed UI overlay, false = world-space (e.g. a chat log floating above a player in a multiplayer scene)
    visible = true,
  } = {}) {
    // Defensive copy — this is the first component with an array field.
    // Scene save/clone/spawn all reconstruct components as `new ChatLog(data)`
    // from a SHALLOW copy of the original's fields (see SceneSerializer.js's
    // serializeScene/cloneEntity) — a shallow copy keeps `messages` as the
    // SAME array reference, which would otherwise mean a spawned/cloned
    // entity's chat history is literally the same array as the original's:
    // sending a message on one would silently show up on the other too.
    // Copying it here, at the one place every reconstruction path funnels
    // through, closes that off regardless of how the component was built.
    this.messages = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
    this.maxMessages = maxMessages;
    this.visibleCount = visibleCount;
    this.width = width;
    this.lineHeight = lineHeight;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.messageColor = messageColor;
    this.senderColor = senderColor;
    this.backgroundColor = backgroundColor;
    this.backgroundOpacity = backgroundOpacity;
    this.padding = padding;
    this.showSender = showSender;
    this.screenSpace = screenSpace;
    this.visible = visible;
  }
}
