/**
 * runtime/systems/LightGlowFilter.js
 *
 * PHASE 3 of the lighting pipeline (new): makes light SOURCES
 * themselves visibly glow in the game view, even over empty
 * background with nothing standing under them — matching how a
 * light in Unity's 2D Renderer is a visible thing in the world, not
 * just an invisible tint that only shows up wherever it happens to
 * land on a sprite.
 *
 * Phase 1 (LightTextureShaderSource.js) already computes a full
 * screen-space "how bright is the light here" buffer. Phase 2
 * (SpriteLightFilter.js) multiplies that into sprites only, so a
 * light in open air (no sprite underneath it) was previously
 * completely invisible. This filter is the missing third leg: it
 * samples the SAME Phase 1 buffer and draws the light's own glow
 * ADDITIVELY over the whole screen — background included — via a
 * dedicated full-screen sprite with PIXI.BLEND_MODES.ADD (see
 * LightingSystem.js's _glowSprite) so every light type is visible as
 * an actual light, everywhere it reaches.
 *
 * Only the EXCESS light above the scene's flat ambient floor
 * (1 - ambientDarkness, the same value baked uniformly into every
 * pixel of Phase 1's buffer) is added — otherwise every pixel on
 * screen would get additively brightened by the ambient floor alone,
 * washing out unlit areas for no reason. Subtracting that floor means
 * only pixels a light ACTUALLY reaches glow, and shadowed pixels
 * (carried in Phase 1's alpha channel) fade the glow back out too, so
 * a light's own glow correctly dims/vanishes behind an occluder just
 * like its effect on sprites does.
 *
 * RUNTIME-ONLY FILE (depends on PIXI's Filter, not on the editor).
 */

const VERTEX_SRC = `
attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;
uniform vec4 inputSize;
uniform vec4 outputFrame;

varying vec2 vScreenCoord;

void main(void) {
    vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;
    gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
    vScreenCoord = position;
}
`;

const FRAGMENT_SRC = `
precision mediump float;

varying vec2 vScreenCoord;

uniform sampler2D uLightTexture; // Phase 1's screen-space light buffer
uniform vec2 uLightTexSize;
uniform float uLightTexFlipY;
uniform float uAmbientFloor;  // 1 - ambientDarkness, baked into every Phase 1 pixel
uniform float uGlowStrength;  // scene-tunable overall glow intensity (LightingSettings.glowStrength)

void main(void) {
    vec2 lightUV = vScreenCoord / uLightTexSize;
    lightUV.y = mix(lightUV.y, 1.0 - lightUV.y, uLightTexFlipY);
    vec4 lightSample = texture2D(uLightTexture, clamp(lightUV, 0.0, 1.0));

    vec3 glow = max(lightSample.rgb - vec3(uAmbientFloor), 0.0) * uGlowStrength;
    // lightSample.a carries Phase 1's shadow mix — a light's own
    // visible glow should fade under its own shadows exactly like its
    // effect on sprites does, not shine through them.
    glow *= (1.0 - lightSample.a);

    float outAlpha = clamp(max(max(glow.r, glow.g), glow.b), 0.0, 1.0);
    gl_FragColor = vec4(glow, outAlpha);
}
`;

/**
 * Builds a fresh PIXI.Filter for the glow overlay sprite. One shared
 * instance is enough (unlike SpriteLightFilter, there's only ever ONE
 * glow overlay per LightingSystem, not one per sprite).
 */
export function buildLightGlowFilter() {
  const uniforms = {
    uLightTexture: PIXI.Texture.EMPTY,
    uLightTexSize: new Float32Array([1, 1]),
    uLightTexFlipY: 0.0,
    uAmbientFloor: 0.35,
    uGlowStrength: 1.0,
  };
  const filter = new PIXI.Filter(VERTEX_SRC, FRAGMENT_SRC, uniforms);
  filter.resolution = (window.__realotPixiApp && window.__realotPixiApp.renderer && window.__realotPixiApp.renderer.resolution) || Math.min(2, window.devicePixelRatio || 1);
  filter.autoFit = false;
  return filter;
}
