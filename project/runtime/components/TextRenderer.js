/**
 * runtime/components/TextRenderer.js
 *
 * On-screen text — a UI label (score, dialog, prompts) OR a world-space
 * label (a floating name tag, damage number) depending on `screenSpace`.
 * Like SpriteRenderer, this is plain serializable data — it never holds
 * a PIXI object directly; runtime/systems/RenderSystem.js is the only
 * place that turns it into an actual PIXI.Text (RULES.txt #5: RenderSystem
 * is the ONLY system that touches PIXI).
 *
 * Position/rotation/scale come from the entity's own Transform, exactly
 * like SpriteRenderer — there's no separate x/y on this component. What
 * that Transform.x/y MEANS depends on screenSpace:
 *   screenSpace: true  (default) — Transform.x/y are raw SCREEN pixels,
 *     (0,0) = top-left of the game canvas. Never moves with the camera —
 *     this is what you want for a HUD/UI label like a score display.
 *   screenSpace: false — Transform.x/y are WORLD-space coordinates, same
 *     space every sprite lives in. Pans and zooms with the Main Camera
 *     like anything else in the scene — use this for a name tag or
 *     floating damage number that should stay attached to a world
 *     position.
 * See RenderSystem.js for exactly how each is routed to a different PIXI
 * container to get this behavior.
 *
 * RUNTIME-ONLY FILE.
 */

export const TEXT_RENDERER = "TextRenderer";

export class TextRenderer {
  constructor({
    value = "Text",
    fontSize = 32,
    color = "#ffffff",
    fontFamily = "Arial",
    bold = false,
    italic = false,
    align = "left",        // "left" | "center" | "right" — multi-line text alignment
    anchorX = 0.5,          // 0–1, this text's own pivot point (0.5,0.5 = centered on Transform.x/y, matching a sprite's default anchor)
    anchorY = 0.5,
    opacity = 1,
    screenSpace = true,     // see file header — true = fixed UI overlay, false = world-space
    wordWrap = false,
    wrapWidth = 300,        // px — only used while wordWrap is true
  } = {}) {
    this.value = value;
    this.fontSize = fontSize;
    this.color = color;
    this.fontFamily = fontFamily;
    this.bold = bold;
    this.italic = italic;
    this.align = align;
    this.anchorX = anchorX;
    this.anchorY = anchorY;
    this.opacity = opacity;
    this.screenSpace = screenSpace;
    this.wordWrap = wordWrap;
    this.wrapWidth = wrapWidth;
  }
}
