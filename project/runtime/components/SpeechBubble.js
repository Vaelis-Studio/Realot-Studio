/**
 * runtime/components/SpeechBubble.js
 *
 * A speech/dialog bubble that floats above the entity it's attached to
 * — a rounded background with a little pointer tail, plus text, always
 * positioned relative to (and moving with) this entity's own Transform.
 * Unlike TextRenderer there's no screenSpace option here: a speech
 * bubble is inherently "attached to a character," so it's always
 * world-space, offset from the entity by (offsetX, offsetY).
 *
 * Like SpriteRenderer/TextRenderer, this is plain serializable data —
 * it never holds a PIXI object directly. runtime/systems/RenderSystem.js
 * is the only place that turns it into actual PIXI objects (RULES.txt
 * #5). hideTimer is the one field a script wouldn't normally hand-author
 * directly (see this.speechBubble.show(text, duration) in
 * SpeechBubbleAPI.js) but it's kept here rather than off in some other
 * system's private state so save/load and the Inspector both see the
 * bubble's real current countdown, not a hidden value they can't inspect.
 *
 * RUNTIME-ONLY FILE.
 */

export const SPEECH_BUBBLE = "SpeechBubble";

export class SpeechBubble {
  constructor({
    text = "Hello!",
    visible = false,
    backgroundColor = "#ffffff",
    textColor = "#111111",
    borderColor = "#111111",
    borderWidth = 2,
    fontSize = 20,
    fontFamily = "Arial",
    padding = 12,          // px between the text and the bubble's edge
    cornerRadius = 10,
    maxWidth = 220,         // px — text wraps at this width
    offsetX = 0,            // px offset from this entity's own position
    offsetY = -60,          // negative = above the entity's head (typical)
    tailDirection = "down", // "down" | "up" | "left" | "right" | "none" — which edge the pointer triangle sits on, pointing back at the entity
    tailSize = 14,
    // Auto-hide countdown in seconds, ticked down by SpeechBubbleSystem
    // while visible; 0 or less means "stays visible until hidden
    // manually" (see this.speechBubble.hide()). Normally set via
    // this.speechBubble.show(text, duration), not hand-authored.
    hideTimer = 0,
  } = {}) {
    this.text = text;
    this.visible = visible;
    this.backgroundColor = backgroundColor;
    this.textColor = textColor;
    this.borderColor = borderColor;
    this.borderWidth = borderWidth;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.padding = padding;
    this.cornerRadius = cornerRadius;
    this.maxWidth = maxWidth;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.tailDirection = tailDirection;
    this.tailSize = tailSize;
    this.hideTimer = hideTimer;
  }
}
