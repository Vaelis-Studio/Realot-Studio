/**
 * runtime/systems/SpriteLightFilter.js
 *
 * PHASE 2 of the Unity-URP-2D-style two-phase pipeline (see
 * LightingSystem.js file header). One instance of this filter is
 * attached to EVERY individual sprite RenderSystem tracks (not to the
 * whole world container) — this mirrors Unity's actual Sprite-Lit
 * shader, which samples the already-rendered Light Render Texture at
 * its own screen position and multiplies it into the sprite's own
 * albedo color.
 *
 * math: gl_FragColor.rgb = spriteColor.rgb * lightSample.rgb
 *
 * This one multiply is what makes the whole rebuild behave correctly
 * where the old single-pass filter didn't:
 *  - A light can only ever brighten/dim/tint a sprite's OWN color —
 *    it structurally cannot replace it with a flat wash of the light's
 *    color, because the sprite's rgb is always one of the two
 *    multiplicands. No more "sprite turns white".
 *  - A fully-shadowed pixel multiplies by whatever the light buffer's
 *    ambient floor is (1 - ambientDarkness), not by zero — so shadows
 *    read as "dim, tinted toward shadowColor," never a hard, clipped
 *    (0,0,0) black rectangle, matching Unity's own softer 2D shadow
 *    look. (For a deliberately pitch-black shadow, set
 *    LightingSettings.ambientDarkness to 1 and shadowColor to black —
 *    an explicit user choice, not a shader floor.)
 *
 * RUNTIME-ONLY FILE (depends on PIXI's Filter, not on the editor).
 */

const VERTEX_SRC = `
attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;
uniform vec4 inputSize;
uniform vec4 outputFrame;

varying vec2 vTextureCoord;
varying vec2 vScreenCoord;

void main(void) {
    vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;
    gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
    vTextureCoord = aVertexPosition * (outputFrame.zw * inputSize.zw);
    // Screen-space (CSS pixel, top-left origin) position of this
    // fragment — used to sample the Light Texture, which is rendered
    // at the exact same screen resolution/orientation each frame (see
    // LightingSystem.js's _renderLightTexture). uLightTexSize converts
    // this to the [0,1] UV space the light RenderTexture uses.
    vScreenCoord = position;
}
`;

const FRAGMENT_SRC = `
precision mediump float;

varying vec2 vTextureCoord;
varying vec2 vScreenCoord;

uniform sampler2D uSampler;      // this sprite's own already-rendered pixels
uniform sampler2D uLightTexture; // Phase 1's screen-space light buffer
uniform vec2 uLightTexSize;      // Light RenderTexture's pixel size, for UV conversion
uniform float uLightTexFlipY;    // 1.0 or 0.0 — RenderTexture UV can be Y-flipped vs screen space depending on renderer/platform

void main(void) {
    vec4 spriteColor = texture2D(uSampler, vTextureCoord);

    vec2 lightUV = vScreenCoord / uLightTexSize;
    lightUV.y = mix(lightUV.y, 1.0 - lightUV.y, uLightTexFlipY);
    vec4 lightSample = texture2D(uLightTexture, clamp(lightUV, 0.0, 1.0));

    // The ONE line that fixes "pure white under light / pure black
    // under shadow": light MULTIPLIES the sprite's own rgb, it never
    // replaces it. lightSample.rgb already includes ambient floor +
    // every light's contribution + shadow tint (all computed in
    // Phase 1 — see LightTextureShaderSource.js), so no further
    // darkness/shadow math is needed here at all.
    vec3 finalColor = spriteColor.rgb * lightSample.rgb;

    gl_FragColor = vec4(finalColor, spriteColor.a);
}
`;

/**
 * Builds a fresh SpriteLightFilter instance. One per sprite (not
 * shared) so each sprite's uniforms (light texture reference/size can
 * actually be shared safely, but PIXI filters are cheap and this keeps
 * per-sprite lifecycle simple — see LightingSystem.js's per-sprite
 * filter map).
 */
export function buildSpriteLightFilter() {
  const uniforms = {
    uLightTexture: PIXI.Texture.EMPTY,
    uLightTexSize: new Float32Array([1, 1]),
    uLightTexFlipY: 0.0,
  };
  const filter = new PIXI.Filter(VERTEX_SRC, FRAGMENT_SRC, uniforms);
  filter.resolution = (window.__realotPixiApp && window.__realotPixiApp.renderer && window.__realotPixiApp.renderer.resolution) || Math.min(2, window.devicePixelRatio || 1);
  return filter;
}
