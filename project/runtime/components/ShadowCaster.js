/**
 * runtime/components/ShadowCaster.js
 *
 * Marks an entity as a shadow-casting occluder — something that blocks
 * light and projects a dynamic shadow, the 2D equivalent of Unity's
 * per-renderer "Cast Shadows" toggle.
 *
 * By default an occluder's blocking shape is read from its own live
 * rendered sprite bounds (same real, post-scale pixel size RenderSystem
 * already tracks for click-hit-testing — see
 * RenderSystem.getSpriteWorldHalfExtents), so a shadow automatically
 * matches what the sprite actually looks like with zero extra setup.
 * `width`/`height` here are an OPTIONAL override for entities that need
 * a shadow shape different from their sprite (a thin sprite that should
 * cast a wide shadow, or an invisible occluder with no SpriteRenderer at
 * all) — leave them null to use the sprite's real bounds.
 *
 * This component only marks INTENT + per-object shadow tuning ("this
 * entity blocks light, offset/sized/faded like THIS"); the actual
 * shadow-polygon math lives in runtime/systems/LightingSystem.js, which
 * is also the only place that decides whether a given Light even casts
 * shadows (Light.castShadows — see components/Light.js). Kept as its
 * own small component rather than folded into SpriteRenderer so
 * occluders don't require a visible sprite (RULES.txt #3/#4: one
 * feature = new file, components stay plain data).
 *
 * RUNTIME-ONLY FILE.
 */

export const SHADOW_CASTER = "ShadowCaster";

export class ShadowCaster {
  constructor({
    enabled = true,
    width = null,
    height = null,
    offsetX = 0,
    offsetY = 0,
    opacity = 1,
    length = 1,
    softness = 0,
  } = {}) {
    // Per-entity on/off, same spirit as Light.castsOnWorld — lets a
    // caster be temporarily excluded from shadow casting (e.g. a
    // see-through window sprite) without removing the component or
    // touching entity.active.
    this.enabled = enabled;

    // Optional explicit occluder size override, in world units/px
    // (same space as Transform.x/y). null means "use this entity's real
    // rendered sprite bounds" (see file header).
    this.width = width;
    this.height = height;

    // Occluder box center offset from the entity's Transform, in LOCAL
    // space — rotated by the entity's Transform.rotation before being
    // applied, exactly like Collider2D.offsetX/offsetY (see
    // runtime/physics/ColliderGeometry.js) — so an offset caster on a
    // rotated object swings around with it instead of just sliding.
    // Useful when the shadow-casting silhouette shouldn't be centered
    // on the sprite's pivot (e.g. a character whose feet, not its
    // center, should anchor the shadow).
    this.offsetX = offsetX;
    this.offsetY = offsetY;

    // How dark this object's shadow reads, 0 (invisible/no shadow) to 1
    // (full ambient darkness). Multiplied together with the casting
    // light's own shadowStrength (see components/Light.js) — either one
    // can fade a shadow out independently, matching Unity's split
    // between a light's Shadow Strength and (indirectly) a renderer's
    // own shadow contribution.
    this.opacity = opacity;

    // How far this object's shadow reaches, as a multiplier on the
    // casting light's natural reach (its radius, or a fixed world-unit
    // distance for Directional/parallel shadows — see the shadow-reach
    // uniform LightingSystem uploads per light, uLightShadowReach). 1 = shadow
    // reaches exactly as far as the light itself would; 0.5 = half as
    // far (a short, contact-y shadow); 2 = twice as far (a long,
    // late-afternoon-sun-style shadow). This is what actually varies
    // shadow LENGTH independently of how big the caster's own silhouette
    // is, matching the "length" control requested for realism.
    this.length = length;

    // Soft shadow edge (penumbra) amount in world units/px, 0 = crisp
    // hard edge. Evaluated per-pixel on the GPU by LightingSystem's
    // shader (see LightTextureShaderSource.js's quadShadowTest edge-fade
    // and raymarchShadowTest's soft-distance accumulation) rather than
    // approximated with multiple CPU-drawn polygon copies.
    this.softness = softness;
  }
}
