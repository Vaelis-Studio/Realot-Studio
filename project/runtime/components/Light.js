/**
 * runtime/components/Light.js
 *
 * Light descriptor, modeled after Unity's 4 light types (adapted to 2D):
 *
 *  - Directional : uniform light across the whole scene from one angle,
 *    like sunlight. No position falloff. `rotation` (degrees) sets the
 *    direction shadows/gradient would lean, `intensity` sets brightness.
 *    When castShadows is on, shadows are PARALLEL (every occluder's
 *    shadow points the same direction, set purely by this light's
 *    rotation) rather than radiating from a position — exactly like
 *    real sunlight, where the sun's position doesn't matter, only its
 *    angle in the sky. Computed per-pixel in Phase 1 of the two-phase
 *    lighting pipeline's GPU shader (see
 *    systems/LightTextureShaderSource.js's directional-light shadow
 *    branch, which derives an effective light position from rotation
 *    alone rather than reading this entity's Transform position).
 *  - Point       : radiates outward from the entity's Transform position
 *    in all directions, fading out at `radius`. The classic "lightbulb".
 *  - Spot        : radiates from the entity's Transform position within
 *    a cone (`angle` degrees wide, aimed along `rotation`), fading out
 *    at `radius`. Good for flashlights / focused beams.
 *  - Area        : uniform light emitted from a rectangular region
 *    (`width` x `height`) centered on the entity's Transform position,
 *    with a soft `radius`-sized falloff at the rectangle's edge.
 *  - GodRays     : a 5th type beyond Unity's stock 4 — bright,
 *    streaked shafts of light radiating within a cone (`angle` degrees
 *    wide, aimed along `rotation`, reaching out to `radius`), like
 *    sunlight breaking through clouds or a window. Uses the same
 *    fields as Spot (radius/angle/rotation) but the Phase 1 shader
 *    modulates its brightness with a streak pattern instead of a flat
 *    cone (see LightTextureShaderSource.js's typeId==4 branch).
 *
 * All types share color/intensity so the Inspector and the Phase 1
 * light-texture shader can treat them uniformly where the math allows,
 * while type-specific fields (radius/angle/width/height) only apply to
 * the relevant type.
 *
 * Every light type is also visibly a LIGHT SOURCE, not just an
 * invisible tint generator: on top of dimming/brightening sprites
 * (Phase 2, SpriteLightFilter.js), each light's own glow is drawn
 * additively over the whole screen — background included — by Phase 3
 * (see systems/LightGlowFilter.js and LightingSystem.js's
 * _glowSprite), matching Unity's 2D lights actually being visible
 * where they shine, not just where they happen to land on something.
 *
 * This component is PLAIN DATA ONLY (see RULES.txt #4) — actually
 * darkening/lighting the world and sprites is LightingSystem's job
 * (runtime/systems/LightingSystem.js, which now orchestrates a
 * two-phase pipeline — see that file's header), not this file's.
 *
 * RUNTIME-ONLY FILE.
 */

export const LIGHT = "Light";

export const LightType = Object.freeze({
  DIRECTIONAL: "Directional",
  POINT: "Point",
  SPOT: "Spot",
  AREA: "Area",
  GOD_RAYS: "GodRays",
  FREEFORM: "Freeform",
});

// Default Freeform shape: a simple diamond, in LOCAL space (offsets from
// the entity's own Transform position, world units/px) — matches
// Unity's 2D Freeform Light, which always starts as an editable polygon
// rather than a blank shape. Cloned (never shared by reference) every
// time a new Freeform light is created — see Light's constructor below.
export const DEFAULT_FREEFORM_POINTS = Object.freeze([
  { x: 0, y: -80 },
  { x: 80, y: 0 },
  { x: 0, y: 80 },
  { x: -80, y: 0 },
]);

export class Light {
  constructor({
    type = LightType.POINT,
    color = "#ffffff",
    intensity = 1,
    radius = 200,
    angle = 45,
    width = 200,
    height = 200,
    castsOnWorld = true,
    castShadows = false,
    shadowColor = "#000000",
    shadowStrength = 1,
    flicker = false,
    flickerSpeed = 8,
    flickerDuration = 0,
    coreSize = 0.22,
    coreVisible = true,
    points = null,
  } = {}) {
    this.type = type;
    this.color = color;
    // 0 = off, 1 = normal brightness, >1 = overbright. Drives both how
    // strongly the light punches through the ambient darkness and how
    // much it additively brightens/tints sprites underneath it.
    this.intensity = intensity;

    // Point / Spot / Area only: how far the light reaches before fading
    // to nothing (world units / px). For Directional this is unused for
    // the glow itself (a Directional light fills the whole screen
    // uniformly — see LightTextureShaderSource.js's typeId==0 branch) but
    // IS used as the base shadow-casting distance when castShadows is
    // on (scaled further per-caster by ShadowCaster.length).
    this.radius = radius;

    // Spot / GodRays only: full cone width in degrees, centered on the
    // entity's Transform.rotation (0 = pointing along +X).
    this.angle = angle;

    // Area only: size in world units / px of the flat-lit rectangle
    // before the `radius`-sized soft falloff kicks in at its edges.
    this.width = width;
    this.height = height;

    // When true (default), this light contributes to the scene-wide
    // ambient darkness pass in LightingSystem, visibly lighting up
    // sprites and background underneath it. Turning it off keeps the
    // light purely as scene data (e.g. for a script to read) without
    // any visual effect — matches Unity's light "Enabled" behavior
    // without overloading entity.active, which would also stop the
    // entity from being queried at all.
    this.castsOnWorld = castsOnWorld;

    // When true, this light computes real-time shadows from every
    // ShadowCaster entity in the scene (see components/ShadowCaster.js
    // and systems/LightingSystem.js) and darkens the occluded regions
    // behind them, dynamically — moving the light, an occluder, OR (for
    // Directional) just rotating the light updates shadows every frame,
    // no baking. Defaults to false: shadow casting is real rendering
    // cost (one shadow shape per occluder per shadow-casting light per
    // frame), so it's opt-in per light rather than always-on, matching
    // Unity's own per-light "Shadow Type: None" default. Valid for
    // EVERY light type including Directional (real sunlight casts
    // shadows too) — see the Directional-specific parallel-shadow note
    // above.
    this.castShadows = castShadows;

    // Tint applied to this light's shadows. Defaults to pure black
    // (a normal, "physically correct" shadow), but real scenes often
    // want e.g. a cool blue-tinted shadow under a warm key light for
    // extra realism/mood — matches Unity's per-Light2D shadow color.
    this.shadowColor = shadowColor;

    // Per-light shadow opacity multiplier, 0 (this light casts no
    // visible shadow at all, even from enabled ShadowCasters) to 1
    // (full strength). Multiplied together with each individual
    // ShadowCaster's own `opacity` (see components/ShadowCaster.js) —
    // either can independently fade shadows, matching Unity's split
    // between a light's own Shadow Strength and a renderer's shadow
    // contribution.
    this.shadowStrength = shadowStrength;

    // Optional natural-looking source flicker. Speed is cycles/second;
    // duration is seconds, with 0 meaning flicker forever.
    this.flicker = !!flicker;
    this.flickerSpeed = Math.max(0, flickerSpeed);
    this.flickerDuration = Math.max(0, flickerDuration);

    // Size of the bright/hot source core as a fraction of the light's
    // natural source area. 0 = tiny core, 1 = broad core.
    this.coreSize = Math.max(0.01, Math.min(1, coreSize));
    this.coreVisible = !!coreVisible;

    // Freeform only: an editable polygon outline, drawn by hand in the
    // Scene view (see editor/viewport/LightGizmo.js's vertex-drag
    // handling) instead of expressed with a radius/angle/size — Unity's
    // 2D Freeform Light. Each point is a LOCAL offset {x,y} from this
    // entity's Transform position (NOT rotated by Transform.rotation —
    // a deliberate simplification so dragging a vertex in the viewport
    // always maps 1:1 to world space with no extra rotation math).
    // Deep-cloned from the shared DEFAULT_FREEFORM_POINTS constant so
    // every Freeform light gets its own independent, mutable point
    // array rather than all lights sharing (and corrupting) one array.
    this.points = points
      ? points.map((p) => ({ x: p.x, y: p.y }))
      : DEFAULT_FREEFORM_POINTS.map((p) => ({ x: p.x, y: p.y }));
  }
}
