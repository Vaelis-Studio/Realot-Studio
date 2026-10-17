/**
 * runtime/components/TextInput.js
 *
 * A UI text field the PLAYER can tap/click and type into — for chat
 * messages, NPC dialogue responses, name entry, anything where the game
 * needs to read back what the person typed. Always screen-space (see
 * TextRenderer.js for that concept) — a typeable field only makes sense
 * as a fixed UI element, not something floating in the world.
 *
 * Like SpriteRenderer/TextRenderer/SpeechBubble/ChatLog, this is plain
 * serializable data — it never holds the actual DOM <input> or any PIXI
 * object directly. Two systems cooperate to bring it to life:
 *   - runtime/systems/TextInputSystem.js owns the REAL, invisible HTML
 *     <input> element that actually captures keystrokes (and triggers
 *     a phone's on-screen keyboard) — see that file's header for why a
 *     real DOM input is used instead of hand-rolling key capture.
 *   - runtime/systems/RenderSystem.js draws the visible box/text/cursor
 *     you actually see, purely from this component's current data
 *     (RULES.txt #5: RenderSystem is the only system that touches PIXI).
 *
 * `value`, `focused`, and `justSubmitted` all reflect real, live state
 * (what's typed right now / whether the field has focus / whether
 * Enter was just pressed) rather than being hand-authored — same
 * reasoning as SpeechBubble's hideTimer and ChatLog's messages: keeping
 * them here means the Inspector and save/load both see the real
 * current state, not something hidden in a system's private map.
 *
 * RUNTIME-ONLY FILE.
 */

export const TEXT_INPUT = "TextInput";

export class TextInput {
  constructor({
    value = "",
    placeholder = "Type a message...",
    maxLength = 200,
    fontSize = 18,
    fontFamily = "Arial",
    textColor = "#111111",
    placeholderColor = "#999999",
    backgroundColor = "#ffffff",
    borderColor = "#888888",
    borderWidth = 2,
    cornerRadius = 8,
    width = 260,
    height = 40,
    padding = 10,
    clearOnSubmit = true,  // empty the field automatically after Enter — typical chat-box behavior
    // Live state — see the file header for why these live here rather
    // than in TextInputSystem's private state.
    focused = false,        // true while the player is actively typing into this field
    justSubmitted = false,  // one-frame pulse: true for exactly one frame after Enter is pressed
  } = {}) {
    this.value = value;
    this.placeholder = placeholder;
    this.maxLength = maxLength;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.textColor = textColor;
    this.placeholderColor = placeholderColor;
    this.backgroundColor = backgroundColor;
    this.borderColor = borderColor;
    this.borderWidth = borderWidth;
    this.cornerRadius = cornerRadius;
    this.width = width;
    this.height = height;
    this.padding = padding;
    this.clearOnSubmit = clearOnSubmit;
    this.focused = focused;
    this.justSubmitted = justSubmitted;
  }
}
