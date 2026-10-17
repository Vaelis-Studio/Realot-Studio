/**
 * runtime/systems/LightingQuality.js
 *
 * The user-facing GPU shadow-quality toggle for LightingSystem. Both
 * modes run entirely inside the same lighting shader (see
 * LightTextureShaderSource.js's `uShadowMode` branch), so switching between
 * them is instant (no shader recompile) and can happen mid-game from a
 * settings menu, not just at scene-load.
 *
 *  - QUAD:      analytic per-pixel test against each occluder's
 *               rotated silhouette-shadow quad (the same geometry the
 *               original CPU LightingSystem filled with PIXI.Graphics)
 *               — cheap, scales with (lights * occluders) per pixel
 *               with simple math, no ray marching.
 *  - RAYMARCH:  a real ray is stepped from the shaded pixel toward
 *               each light and tested against every occluder box along
 *               the way — exact per-pixel occlusion and naturally
 *               correct penumbras, at real GPU cost that scales with
 *               (lights * occluders * marchSteps) per pixel.
 *
 * RUNTIME-ONLY FILE. Pure data, no PIXI.
 */

export const ShadowMode = Object.freeze({
  QUAD: "quad",
  RAYMARCH: "raymarch",
});

export class LightingQuality {
  constructor({ shadowMode = ShadowMode.QUAD, raymarchSteps = 24 } = {}) {
    /** @type {string} one of ShadowMode */
    this.shadowMode = shadowMode;

    // Only used when shadowMode === RAYMARCH. More steps = smoother,
    // more accurate occlusion along the ray at a higher GPU cost per
    // pixel; fewer steps on lower-end machines can under-sample a
    // thin occluder and let a shadow "leak" slightly. 24 is a
    // reasonable default for typical scene sizes/occluder counts;
    // expose it in a game's settings menu alongside shadowMode itself
    // for a "shadow quality: low/medium/high" style slider.
    this.raymarchSteps = Math.max(1, Math.min(200, Number(raymarchSteps) || 24));
  }
}
