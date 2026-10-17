/**
 * runtime/components/SpriteRenderer.js
 *
 * Visual representation of an entity. `spriteKey` is a logical name that
 * is resolved to a texture by runtime/assets/AssetManager.js — components
 * never hold PIXI objects directly, so they stay serializable.
 *
 * Draw order is controlled entirely by the entity's Transform.z (higher
 * z draws on top) — see runtime/systems/RenderSystem.js. There is no
 * separate per-sprite layer-order field; Z is the single source of
 * truth for stacking, which is also what makes the fake-3D depth-scale
 * effect (Camera.enablePseudo3D) and draw order always agree with each
 * other by construction.
 *
 * RUNTIME-ONLY FILE.
 */

export const SPRITE_RENDERER = "SpriteRenderer";

export class SpriteRenderer {
  constructor({
    spriteKey = null,
    color = "#ffffff",
    opacity = 1,
    flipX = false,
    flipY = false,
    referenceWidth = null,
    referenceHeight = null,
  } = {}) {
    this.spriteKey = spriteKey;
    this.color = color;
    this.opacity = opacity;
    this.flipX = flipX;
    this.flipY = flipY;

    // The PIXEL size RenderSystem treats Transform.scaleX/Y=1 as meaning
    // "this many pixels on screen" — captured once (usually from
    // whichever image the entity was first created/dropped with) and
    // then held fixed for the entity's whole lifetime, INCLUDING while
    // an attached SpriteAnimation cycles through frames whose own raw
    // pixel dimensions may differ from each other (e.g. a walk-cycle
    // sliced from a sheet where frames aren't perfectly uniform, or
    // frames imported from separate files of different sizes).
    //
    // Without this, RenderSystem previously multiplied Transform.scale
    // directly against each frame's raw texture size — so an entity
    // placed via SceneViewport's drag-drop (which computes scale to fit
    // ONE specific image's pixel size, see fitSpriteScale()) would
    // visibly shrink to a near-invisible dot the instant AnimationSystem
    // swapped in a frame with much smaller native pixel dimensions than
    // that original placement image, even though nothing about the
    // user's intended on-screen size changed. Storing the reference size
    // here and having RenderSystem divide it out per-frame is what keeps
    // an animated sprite's on-screen size STABLE across every frame,
    // regardless of each frame image's own raw resolution — exactly the
    // same problem Unity's "Pixels Per Unit" setting solves.
    //
    // null means "not captured yet" (e.g. an entity created some OTHER
    // way than drag-drop, before its first SpriteRenderer texture
    // resolves) — RenderSystem treats that as "use this frame's own
    // size as the reference," i.e. behaves exactly like before until a
    // reference is established.
    this.referenceWidth = referenceWidth;
    this.referenceHeight = referenceHeight;
  }
}
