/**
 * runtime/systems/LightTextureShaderSource.js
 *
 * PHASE 1 of the Unity-URP-2D-style two-phase pipeline (see
 * LightingSystem.js file header for the full pipeline description).
 *
 * This shader draws ONLY light shapes: radial/cone/rect falloff per
 * light type, summed together, with shadow occlusion subtracted where
 * a shadow-casting light's rays are blocked by a ShadowCaster. It has
 * NO knowledge of sprites at all — no uSampler, no scene texture, no
 * per-object color. This is exactly Unity's "Light Render Texture":
 * a screen-space buffer that only contains light color/intensity,
 * rendered once per frame regardless of how many sprites exist.
 *
 * Output channels (see main()):
 *  - rgb: accumulated light color (ambient base + every light's
 *    contribution, additive — matches Unity's per-blend-style Light
 *    Render Texture, which is likewise additive-blended per light).
 *  - a:   total shadow mix (0 = fully lit relative to occluders, 1 =
 *    fully in shadow) — carried in the alpha channel so Phase 2
 *    (SpriteLightFilter.js) can optionally tint shadowed sprite pixels
 *    toward a shadow color WITHOUT this shader needing to know
 *    anything about sprite pixels itself.
 *
 * WHY THIS FIXES "sprites go pure white / pure black": because this
 * buffer holds ONLY light values, sampling it later can only ever
 * MULTIPLY against a sprite's own texture color (see
 * SpriteLightFilter.js) — a light value can dim or brighten a sprite's
 * own color, but it structurally cannot replace it with a flat color,
 * the way the old single-pass filter's additive term could.
 *
 * RUNTIME-ONLY FILE (depends on PIXI's Filter, not on the editor).
 *
 * REALISM PASS (point/spot lights): a flat single-color disc scaled by
 * one smooth brightness curve reads as fake — real light sources shift
 * toward white/hot right at the source and only show their actual
 * tint further out (radialHotness blends uLightColor toward white near
 * the core), and real light scatter is never a mathematically perfect
 * gradient (radialGrain layers a faint two-octave noise texture, rigid
 * to the light's own local space, onto the falloff). Both are additive
 * refinements on top of the existing radialFalloff hot-core curve —
 * area/directional/god-rays/freeform lights are untouched, since none
 * of them represent a single point source a "core" makes sense for.
 */

// Same uniform-budget caps as the single-pass shader this replaced:
// GLSL ES 1.00 requires compile-time-constant array sizes, so lights/
// occluders get a fixed-size cap plus an explicit count uniform that
// tells the shader how much of each array is actually populated.
//
// THESE ARE UPPER-BOUND DEFAULTS, NOT GUARANTEED-SAFE SIZES. The GLSL
// ES 1.00 spec only guarantees MAX_FRAGMENT_UNIFORM_VECTORS >= 16 in
// principle, but every real WebGL1 implementation guarantees >= 1024
// (the actual figure that produced "PixiJS Error: Could not initialize
// shader" / "FRAGMENT shader uniforms count exceeds
// MAX_FRAGMENT_UNIFORM_VECTORS" on lower-end/integrated GPUs — those
// devices report the guaranteed 1024, not the much higher figure a
// typical dev machine's discrete GPU reports, and the fixed defaults
// below (particularly uPolyPoints at MAX_LIGHTS * FREEFORM_STRIDE = 544
// vec4 slots on their own) blew well past it). resolveCaps() below
// queries the ACTUAL device budget via
// gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) and scales these
// down to fit BEFORE the shader source is ever built, so the shader
// that gets compiled always fits the device it's compiling on instead
// of a fixed worst-case guess. buildLightTextureFilter(gl) is the only
// place these defaults are read directly; everywhere else (including
// this shader's own template literals below) takes its sizes from the
// resolved caps object that function produces.
export const DEFAULT_MAX_LIGHTS = 32;
export const DEFAULT_MAX_OCCLUDERS = 24;
export const MAX_RAYMARCH_STEPS = 200;
// Freeform lights (typeId 5): each light's polygon outline is uploaded
// as up to this many LOCAL-space {x,y} points, flattened into one big
// per-light-slot array (see uPolyPoints below) rather than a real 2D
// uniform array, since GLSL ES 1.00 (WebGL1) has no dynamic-length
// arrays-of-arrays.
export const DEFAULT_MAX_FREEFORM_POINTS = 16;

// Roughly how many vec4-equivalent uniform slots ONE light/occluder
// "costs" in this shader (see the uLight*/uOcc* uniform declarations
// below) — used by resolveCaps() to size MAX_LIGHTS/MAX_OCCLUDERS/
// MAX_FREEFORM_POINTS down to fit an actual device budget instead of
// guessing. Kept as simple named constants (rather than derived by
// parsing the shader source) so they're easy to keep in sync by eye
// with the uniform list whenever a uLight*/uOcc* line is added.
// Per-light cost: every GLSL array element consumes a complete uniform
// vector on WebGL 1, including float/int arrays. There are 19 fixed
// arrays here (position/type/color, the authored light properties,
// shadow properties, and point count), PLUS FREEFORM_STRIDE entries for
// uPolyPoints. Keeping this exact is important: under-counting it lets
// the shader source exceed a GPU's reported limit before PIXI can link it.
const PER_LIGHT_FIXED_SLOTS = 19;
// Per-occluder cost: pos, halfExtents, rotation, opacity, length,
// softness = 6 slots.
const PER_OCCLUDER_SLOTS = 6;
// Everything else this shader/PIXI itself uses regardless of light/
// occluder count — projectionMatrix, inputSize, outputFrame,
// uStageOffset/Scale, uAmbientDarkness, uShadowMode, uRaymarchSteps,
// uTime, uLightCount, uOccluderCount, plus headroom for whatever
// PIXI's own filter plumbing (samplers etc.) adds — kept conservative
// on purpose since undershooting the real fixed overhead is exactly
// what caused this bug the first time.
const FIXED_OVERHEAD_SLOTS = 64;
// Floor so a genuinely tiny device budget still gets a usable scene
// (a couple of lights, no shadows-casting occluders) instead of
// solving down to zero and silently drawing nothing.
const MIN_LIGHTS = 4;
const MIN_OCCLUDERS = 4;
const MIN_FREEFORM_POINTS = 4;

/**
 * Queries the real GPU's fragment-uniform budget and scales
 * MAX_LIGHTS/MAX_OCCLUDERS/MAX_FREEFORM_POINTS down (never up past the
 * defaults above) so the shader this module builds is guaranteed to
 * fit — this is the actual fix for "Could not initialize shader" /
 * "uniforms count exceeds MAX_FRAGMENT_UNIFORM_VECTORS" on lower-end
 * or integrated GPUs, which report a much smaller budget than a
 * typical dev machine's discrete GPU.
 *
 * gl: a WebGLRenderingContext/WebGL2RenderingContext, normally
 * pixiApp.renderer.gl. Pass null/undefined (e.g. a non-WebGL renderer,
 * or a context that doesn't expose gl) to fall back to the fixed
 * defaults unchanged — same behavior as before this fix, for the rare
 * environment this query itself can't run in.
 *
 * Solves for the largest MAX_LIGHTS (keeping MAX_OCCLUDERS/
 * MAX_FREEFORM_POINTS at their defaults) that fits the budget; if even
 * MIN_LIGHTS lights won't fit at default occluders/freeform-points, it
 * then scales occluders and freeform-points down too, in that order,
 * before finally giving up and using the floor values for all three
 * (which — see FIXED_OVERHEAD_SLOTS — should only happen on a budget
 * far below any real device's actual guaranteed minimum).
 */
export function resolveCaps(gl) {
  let budget = null;
  if (gl) {
    try {
      const raw = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
      if (typeof raw === "number" && isFinite(raw) && raw > 0) budget = raw;
    } catch (err) {
      // gl not a real WebGL context, or getParameter unsupported —
      // fall through to the unscaled defaults below.
    }
  }
  if (budget === null) {
    return {
      MAX_LIGHTS: DEFAULT_MAX_LIGHTS,
      MAX_OCCLUDERS: DEFAULT_MAX_OCCLUDERS,
      MAX_FREEFORM_POINTS: DEFAULT_MAX_FREEFORM_POINTS,
    };
  }

  const available = Math.max(0, budget - FIXED_OVERHEAD_SLOTS);

  const costFor = (lights, occluders, points) =>
    lights * (PER_LIGHT_FIXED_SLOTS + (points + 1)) + occluders * PER_OCCLUDER_SLOTS;

  // Fits comfortably at defaults? Nothing to scale down.
  if (costFor(DEFAULT_MAX_LIGHTS, DEFAULT_MAX_OCCLUDERS, DEFAULT_MAX_FREEFORM_POINTS) <= available) {
    return {
      MAX_LIGHTS: DEFAULT_MAX_LIGHTS,
      MAX_OCCLUDERS: DEFAULT_MAX_OCCLUDERS,
      MAX_FREEFORM_POINTS: DEFAULT_MAX_FREEFORM_POINTS,
    };
  }

  // Keep the authored quality first: retain all shadow casters and all
  // freeform vertices, then take only as many simultaneous lights as the
  // hardware can compile. This is a capacity cap, not a resolution,
  // raymarch-step, or falloff-quality reduction.
  let occluders = DEFAULT_MAX_OCCLUDERS;
  let points = DEFAULT_MAX_FREEFORM_POINTS;
  let lights = Math.min(
    DEFAULT_MAX_LIGHTS,
    Math.floor((available - occluders * PER_OCCLUDER_SLOTS) / (PER_LIGHT_FIXED_SLOTS + points + 1))
  );

  // Exceptionally constrained contexts can still preserve a useful set
  // of lights by reducing shadow-caster capacity before freeform detail.
  if (lights < MIN_LIGHTS) {
    lights = MIN_LIGHTS;
    occluders = Math.min(
      DEFAULT_MAX_OCCLUDERS,
      Math.floor((available - lights * (PER_LIGHT_FIXED_SLOTS + points + 1)) / PER_OCCLUDER_SLOTS)
    );
  }
  if (occluders < MIN_OCCLUDERS) {
    occluders = MIN_OCCLUDERS;
    points = Math.min(
      DEFAULT_MAX_FREEFORM_POINTS,
      Math.floor((available - occluders * PER_OCCLUDER_SLOTS) / lights) - PER_LIGHT_FIXED_SLOTS - 1
    );
  }

  // The WebGL minimum is comfortably above this floor. Clamp only to
  // legal GLSL array sizes for pathological/non-WebGL mocks.
  lights = Math.max(MIN_LIGHTS, lights);
  occluders = Math.max(MIN_OCCLUDERS, occluders);
  points = Math.max(MIN_FREEFORM_POINTS, points);

  return { MAX_LIGHTS: lights, MAX_OCCLUDERS: occluders, MAX_FREEFORM_POINTS: points };
}

/**
 * Builds the {VERTEX_SRC, FRAGMENT_SRC} shader source pair for a given
 * resolved caps object (see resolveCaps()). Sizes every uLight-/uOcc-
 * prefixed uniform array — and every GLSL loop bound over MAX_LIGHTS/
 * MAX_OCCLUDERS/MAX_FREEFORM_POINTS — to the caps actually passed in,
 * so the source this returns is only ever as big as the device that
 * asked for it needs it to be. Pure string templating, no GL calls —
 * safe to call with any caps object, including in a test/Node
 * environment with no WebGL at all.
 */
function buildShaderSource(caps) {
  const MAX_LIGHTS = caps.MAX_LIGHTS;
  const MAX_OCCLUDERS = caps.MAX_OCCLUDERS;
  const MAX_FREEFORM_POINTS = caps.MAX_FREEFORM_POINTS;
  // Each light gets MAX_FREEFORM_POINTS + 1 slots in uPolyPoints: the
  // actual polygon points plus a duplicate of the first point right
  // after the last. This lets the shader iterate polygon edges as
  // simple (p, p+1) pairs including the wrap-around (last->first)
  // edge, avoiding computed array indices -- GLSL ES 1.00 only allows
  // const/loop-variable expressions as array indices.
  const FREEFORM_STRIDE = MAX_FREEFORM_POINTS + 1;

  const VERTEX_SRC = `
attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;
uniform vec4 inputSize;
uniform vec4 outputFrame;

// Inverse of gameContentContainer's current screen transform (plain
// translate+uniform-scale — see LightingSystem.js COORDINATE SPACE
// note), filled from JS each frame so light/occluder world positions
// line up with this pixel regardless of editor pan/zoom or play-mode
// camera-follow translate.
uniform vec2 uStageOffset;
uniform float uStageScale;

varying vec2 vTextureCoord;
varying vec2 vWorldCoord;

void main(void) {
    vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;
    gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
    vTextureCoord = aVertexPosition * (outputFrame.zw * inputSize.zw);
    vWorldCoord = (position - uStageOffset) / uStageScale;
}
`;

  const FRAGMENT_SRC = `
precision mediump float;

varying vec2 vTextureCoord;
varying vec2 vWorldCoord;

uniform float uAmbientDarkness;
uniform int uShadowMode; // 0 = quad, 1 = raymarch
uniform int uRaymarchSteps;
// Running scene clock (seconds), fed from LightingSystem.js each
// frame — only God Rays uses this, to very slowly drift its streak
// pattern the way real light shafts shimmer as dust/haze in the air
// moves, instead of looking like a static painted-on cone.
uniform float uTime;

uniform int uLightCount;
uniform vec2 uLightPos[${MAX_LIGHTS}];
uniform int uLightTypeId[${MAX_LIGHTS}];      // 0 Directional, 1 Point, 2 Spot, 3 Area, 4 GodRays, 5 Freeform
uniform vec3 uLightColor[${MAX_LIGHTS}];
uniform float uLightIntensity[${MAX_LIGHTS}];
uniform float uLightFlicker[${MAX_LIGHTS}];
uniform float uLightFlickerSpeed[${MAX_LIGHTS}];
uniform float uLightFlickerDuration[${MAX_LIGHTS}];
uniform float uLightCoreSize[${MAX_LIGHTS}];
uniform float uLightCoreVisible[${MAX_LIGHTS}];
uniform float uLightRadius[${MAX_LIGHTS}];
uniform float uLightAngle[${MAX_LIGHTS}];     // radians, full cone width
uniform float uLightRotation[${MAX_LIGHTS}];  // radians
uniform float uLightWidth[${MAX_LIGHTS}];
uniform float uLightHeight[${MAX_LIGHTS}];
uniform int uLightCastsShadows[${MAX_LIGHTS}];
uniform float uLightShadowStrength[${MAX_LIGHTS}];
uniform vec3 uLightShadowColor[${MAX_LIGHTS}];
uniform float uLightShadowReach[${MAX_LIGHTS}];

// Freeform-only polygon data, flattened as described above uOccluderCount:
// point j of light i lives at uPolyPoints[i * ${MAX_FREEFORM_POINTS} + j].
uniform int uLightPointCount[${MAX_LIGHTS}];
uniform vec2 uPolyPoints[${MAX_LIGHTS * FREEFORM_STRIDE}];

uniform int uOccluderCount;
uniform vec2 uOccPos[${MAX_OCCLUDERS}];
uniform vec2 uOccHalfExtents[${MAX_OCCLUDERS}];
uniform float uOccRotation[${MAX_OCCLUDERS}];
uniform float uOccOpacity[${MAX_OCCLUDERS}];
uniform float uOccLength[${MAX_OCCLUDERS}];
uniform float uOccSoftness[${MAX_OCCLUDERS}];

const float PI = 3.14159265359;

// Physically-inspired light color response. The lighting buffer is a
// multiplier, so keep the authored hue while gently desaturating only
// the hottest parts of a light. Real emitters tend to become broader
// spectrum at their brightest core, while the surrounding illumination
// keeps more of the source color. The effect is deliberately subtle so
// colored neon/lamps remain colored rather than turning white.
float lightLuminance(vec3 c) {
    return max(dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722)), 0.0001);
}

vec3 realisticLightColor(vec3 color, float sourceHotness, float energy) {
    vec3 safeColor = max(color, vec3(0.0));
    float saturation = max(max(safeColor.r, safeColor.g), safeColor.b) -
                       min(min(safeColor.r, safeColor.g), safeColor.b);
    float coreWhite = clamp(sourceHotness * 0.12 + energy * 0.06, 0.0, 0.16);
    // Preserve strongly colored sources: a high-saturation authored
    // light gets less whitening than an already near-white light.
    coreWhite *= 1.0 - 0.35 * clamp(saturation, 0.0, 1.0);
    return mix(safeColor, vec3(lightLuminance(safeColor)), coreWhite);
}

// Natural source flicker: layered low-frequency sine waves with a tiny
// deterministic variation per light. It is intentionally subtle so a
// flickering lamp still illuminates continuously rather than strobing.
// Duration 0 means forever; once a finite duration expires the light
// returns to its authored intensity.
float lightFlickerMultiplier(float time, float enabled, float speed, float duration, float seed) {
    if (enabled < 0.5 || speed <= 0.0) return 1.0;
    if (duration > 0.0 && time >= duration) return 1.0;
    float t = time * speed;
    float a = sin(t * 6.2831853 + seed * 5.17);
    float b = sin(t * 10.9956 + seed * 11.73 + 1.7);
    float c = sin(t * 3.7699 + seed * 19.41 + 0.4);
    float variation = 0.72 * a + 0.20 * b + 0.08 * c;
    return clamp(1.0 + variation * 0.12, 0.78, 1.12);
}

vec2 toLocal(vec2 p, vec2 center, float rotation) {
    vec2 d = p - center;
    float c = cos(-rotation);
    float s = sin(-rotation);
    return vec2(d.x * c - d.y * s, d.x * s + d.y * c);
}

float boxSDF(vec2 localP, vec2 halfExtents) {
    vec2 d = abs(localP) - halfExtents;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Physical-falloff-ish point light brightness curve: small near-solid
// hot core followed by a steeper-than-linear bloom tail. This is what
// makes a light look like it's actually SHINING from a source point
// rather than a uniform flat disc.
float radialFalloff(float distT) {
    const float HOT_CORE_T = 0.12;
    if (distT <= HOT_CORE_T) {
        return 1.0 - 0.08 * (distT / HOT_CORE_T);
    }
    float bloomT = (distT - HOT_CORE_T) / (1.0 - HOT_CORE_T);
    return 0.92 * (1.0 - pow(clamp(bloomT, 0.0, 1.0), 2.4));
}

// How "hot" (white-core, filament-like) a point on a radial/spot light
// is, purely as a function of distance from the source — used to blend
// the light's own color toward white near the core (see uLightColor
// mix below). Real light sources are whiter/hotter right at the source
// and take on their actual tint further out (a candle's flame tip is
// near-white while its glow is amber; a red neon tube's own surface
// reads near-white-pink while its halo is saturated red) — a flat
// single-color disc reads as fake because real light never holds one
// flat hue all the way from source to edge.
float radialHotness(float distT, float coreSize) {
    float HOT_T = clamp(coreSize, 0.01, 1.0);
    float t = clamp(distT / HOT_T, 0.0, 1.0);
    // Real emitters have a concentrated source region, then a rapid
    // transition into the softer colored glow. A cubic smooth profile
    // avoids the flat disc look of a linear/low-order core.
    float core = 1.0 - smoothstep(0.0, 1.0, t);
    return core * core;
}

// Cheap 2D hash — used to break the perfectly-smooth analytic falloff
// gradient with a faint irregular texture, the way real light scatter
// through air/dust never reads as a mathematically perfect gradient.
// Small enough magnitude to read as organic shimmer, not visible
// banding or grain.
float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Layers a very faint radial "grain" onto an otherwise-smooth falloff
// value. Sampled in the light's own LOCAL space (toPixel, not world
// space) so the texture is rigidly attached to the light and never
// swims across the screen as the light moves — a real light's own
// scatter pattern travels with it. Two octaves (coarse + fine) so it
// reads as soft atmospheric variation rather than a single repeating
// pattern.
float radialGrain(vec2 toPixel, float radius) {
    vec2 cell = toPixel / max(radius, 0.0001);
    float coarse = hash2(floor(cell * 6.0));
    float fine = hash2(floor(cell * 17.0) + 91.7);
    return mix(0.94, 1.0, coarse) * mix(0.97, 1.0, fine);
}

// Strictly contained within the light's own rectangle — matches its
// gizmo box exactly, with NO glow bleeding past the drawn outline
// (previously the radius parameter extended the visible glow OUTWARD
// past the box edges by up to that many world units, which read as
// the light "shining outside" its own shape). The radius parameter
// here instead controls how far the soft edge feathers INWARD from
// the box's own edge, clamped so it can never eat more than half the
// box.
float areaFalloff(vec2 localP, vec2 halfSize, float radius) {
    vec2 d = abs(localP) - halfSize;
    if (d.x > 0.0 || d.y > 0.0) return 0.0;
    float insideEdgeDist = -max(d.x, d.y);
    float feather = clamp(radius, 0.0001, max(0.0001, min(halfSize.x, halfSize.y)));
    return smoothstep(0.0, feather, insideEdgeDist);
}

// Cheap value-noise-ish hash, used only to break up God Rays' streak
// pattern so it reads as irregular dust/haze rather than a perfectly
// periodic sine grating (Unity's Light Shaft/Volumetric 2D packages
// all layer noise on top of a pure radial gradient for this reason).
float hash1(float n) {
    return fract(sin(n) * 43758.5453123);
}

// God Rays realism pass #2 — reworked from scratch to match the
// attached Unity "2D Lights & Shadows" reference: soft, hazy, layered
// volumetric shafts breaking through foliage, NOT a hard-edged cone
// with a barcode of evenly-spaced lines. Three deliberate departures
// from the previous version:
//   1. NO hard cone boundary at all. Real light shafts have no visible
//      edge line — they just gradually dim toward the sides. The cross-
//      beam profile is a smooth bell curve (soft Gaussian-ish falloff)
//      instead of a flat-top mask with a thin feathered edge.
//   2. Far fewer, WIDE, irregular-brightness bands (hashed per-band,
//      not a continuous sine grating) so it reads as a handful of
//      distinct hazy shafts of different strength, exactly like the
//      reference images — never a mechanically even barcode.
//   3. A gentle low-frequency drift + a much softer/hazier longitudinal
//      falloff (bright and fairly even along most of the shaft, then a
//      slow fade) instead of a bright hot core with a steep tail — the
//      reference shafts stay visible and soft for most of their length.
float godRaysBrightness(vec2 toPixel, float dist, float radius, float rotation, float halfCone) {
    float distT = clamp(dist / max(radius, 0.0001), 0.0, 1.0);

    float angleToPixel = atan(toPixel.y, toPixel.x);
    float rel = angleToPixel - rotation;
    rel = mod(rel + PI, 2.0 * PI) - PI;
    float coneT = rel / max(halfCone, 0.0001); // unclamped: lets the bell curve tail off naturally

    // Soft, edgeless cross-beam profile — brightest along the light's
    // aim direction, smoothly (not linearly) dimming toward the sides
    // with no visible boundary line, matching the hazy, undefined edges
    // of the reference shafts.
    float coneMask = exp(-coneT * coneT * 1.15);
    if (coneMask <= 0.0025) return 0.0;

    // Longitudinal haze: stays fairly bright and even for most of the
    // shaft's length, then softly washes out — no sharp "hot core then
    // steep falloff" knee.
    float longFade = dist > radius ? 0.0 : exp(-distT * distT * 1.15) * mix(1.0, 0.55, distT);

    // A handful (not dozens) of irregular, hashed-brightness bands
    // spanning the beam's width, blended smoothly into their neighbors
    // so edges between bands are soft, never a crisp stripe.
    const float BAND_COUNT = 5.0;
    float bandF = (coneT * 0.5 + 0.5) * BAND_COUNT + dist * 0.0022 + uTime * 0.035;
    float bandIdx = floor(bandF);
    float bandLocal = smoothstep(0.0, 1.0, fract(bandF));
    float bandA = hash1(bandIdx);
    float bandB = hash1(bandIdx + 1.0);
    float bandBrightness = mix(bandA, bandB, bandLocal);
    // Keep every band visibly hazy — never lets the gaps between rays
    // go fully dark, matching how the reference shafts overlap into a
    // continuous glow rather than showing black gaps.
    bandBrightness = mix(0.6, 1.0, bandBrightness);

    // A finer, slower haze/dust shimmer riding on top of the bands —
    // wide, soft sine lobes (not a tight barcode) so close-up the shaft
    // still reads as drifting haze rather than flat bands.
    float fineF = (coneT * 0.5 + 0.5) * 11.0 + dist * 0.006 - uTime * 0.08;
    float fine = mix(0.82, 1.0, 0.5 + 0.5 * sin(fineF));

    // A third, much broader/slower haze layer riding under the bands
    // and fine shimmer — real dusty light shafts read as a handful of
    // crisper inner streaks floating inside a wider, softer glow of
    // suspended haze, not just one layer of texture. This is what
    // keeps the whole beam looking atmospheric/volumetric even in the
    // gaps between the brighter inner bands, rather than the bands
    // being the entire visual story.
    float broadF = (coneT * 0.5 + 0.5) * 2.0 + dist * 0.0009 + uTime * 0.015;
    float broadHaze = mix(0.75, 1.0, 0.5 + 0.5 * sin(broadF * PI));

    float brightness = coneMask * longFade * bandBrightness * fine * broadHaze;

    // Gentle glow right at the light source so its origin doesn't look
    // clipped/flat, softened into the rest of the shaft rather than a
    // hard bright dot.
    brightness = max(brightness, coneMask * exp(-distT * distT * 22.0) * 0.7);

    return brightness;
}

float quadShadowTest(vec2 pixelWorld, vec2 lightPos, vec2 occCenter, vec2 halfExt, float rot, float opacity, float lengthMult, float softness, float reachOverride, float extraFadeOut) {
    if (opacity <= 0.0) return 0.0;

    vec2 toOcc = occCenter - lightPos;
    float distToOcc = length(toOcc);
    if (distToOcc < 0.0001) return 0.0;
    vec2 dir = toOcc / distToOcc;

    vec2 toPixel = pixelWorld - lightPos;
    float alongAxis = dot(toPixel, dir);
    float apparentHalf = max(halfExt.x, halfExt.y);
    // Shadows start at the occluder's FAR edge (relative to the
    // light), never inside its own silhouette. An object must never
    // darken ITSELF — only the surfaces behind it — matching Unity's
    // Shadow Caster 2D, where a sprite never self-shadows from its
    // own light. (Previously this tested "is the shaded pixel
    // literally inside this occluder's own box" and returned full
    // shadow if so, plus started the shadow band at the occluder's
    // NEAR edge — both of which made an object cast its own shadow
    // onto its own body.)
    float farDist = distToOcc + apparentHalf;
    float reach = reachOverride * lengthMult;
    if (alongAxis < farDist || alongAxis > farDist + reach) return 0.0;

    vec2 perpAxis = vec2(-dir.y, dir.x);
    float perpDist = abs(dot(toPixel, perpAxis));
    if (perpDist > apparentHalf + softness) return 0.0;

    float edgeFade = softness > 0.0 ? 1.0 - smoothstep(apparentHalf, apparentHalf + softness, perpDist) : step(perpDist, apparentHalf);
    float lenFade = 1.0 - smoothstep(farDist + reach * 0.85, farDist + reach, alongAxis);
    return opacity * edgeFade * lenFade * extraFadeOut;
}

float raymarchShadowTest(vec2 pixelWorld, vec2 lightPos, float maxDist, bool isDirectional, vec2 lightDir) {
    vec2 toLight;
    float dist;
    vec2 dir;
    if (isDirectional) {
        // Directional light: rays are PARALLEL everywhere, so the march
        // direction must be the light's fixed direction, never derived
        // from (lightPos - pixelWorld). The old code faked a "far away
        // point light" by placing lightPos at pixelWorld - dir * reach —
        // but that re-centers lightPos under whichever pixel is
        // currently being shaded, silently turning "far away" back into
        // "always directly behind this exact pixel" and making the
        // marched ray direction drift per-pixel instead of staying
        // constant across the whole occluder/scene. That drift is what
        // let a shadow bend onto the wrong (near/top) side of an
        // object depending on its shape — passing the direction
        // directly keeps it truly constant, matching an actual
        // directional light.
        dir = lightDir;
        dist = maxDist;
    } else {
        toLight = lightPos - pixelWorld;
        dist = length(toLight);
        if (dist < 0.0001 || dist > maxDist) return 0.0;
        dir = toLight / dist;
    }

    // Bias the marched ray's START away from the shaded pixel itself
    // (a standard shadow-acne-style bias) so an occluder can never
    // register itself as blocking its own surface — a shadow should
    // only ever land on OTHER surfaces behind an occluder, never on
    // the occluder's own body, matching Unity's Shadow Caster 2D.
    // Without this, a raymarch step at t≈0 that happens to already be
    // inside the very occluder the shaded pixel belongs to reads as
    // "occluded," self-shadowing the object for its entire silhouette.
    float tStart = min(dist, max(2.0, dist * 0.08));

    float occlusion = 0.0;
    float softAccum = 0.0;
    for (int i = 1; i <= ${MAX_RAYMARCH_STEPS}; i++) {
        if (i > uRaymarchSteps) break;
        float t = tStart + (float(i) / float(uRaymarchSteps)) * max(0.0, dist - tStart);
        vec2 sample = pixelWorld + dir * t;

        for (int o = 0; o < ${MAX_OCCLUDERS}; o++) {
            if (o >= uOccluderCount) break;
            float opacity = uOccOpacity[o];
            if (opacity <= 0.0) continue;
            // Shadow length is measured from this occluder's
            // shadow-facing boundary to the shaded pixel along the
            // existing ray direction, not from a marched sample to
            // the occluder via its SDF. Compute the rectangle's support
            // radius along that same ray so rotated casters use their
            // actual boundary rather than an axis-aligned approximation.
            vec2 local = toLocal(sample, uOccPos[o], uOccRotation[o]);
            float softness = uOccSoftness[o];
            float sdf = boxSDF(local, uOccHalfExtents[o]);
            vec2 localRayDir = vec2(
                cos(uOccRotation[o]) * dir.x + sin(uOccRotation[o]) * dir.y,
                -sin(uOccRotation[o]) * dir.x + cos(uOccRotation[o]) * dir.y
            );
            float boundaryOffset =
                abs(localRayDir.x) * uOccHalfExtents[o].x +
                abs(localRayDir.y) * uOccHalfExtents[o].y;
            float shadowDistance =
                -dot(pixelWorld - uOccPos[o], dir) - boundaryOffset;
            float occReach = maxDist * max(0.0, uOccLength[o]);
            if (shadowDistance > occReach) continue;
            if (sdf <= 0.0) {
                occlusion = max(occlusion, opacity);
            } else if (softness > 0.0 && sdf <= softness) {
                softAccum = max(softAccum, opacity * (1.0 - sdf / softness));
            }
        }
        if (occlusion >= 0.999) break;
    }
    return clamp(max(occlusion, softAccum * 0.6), 0.0, 1.0);
}

void main(void) {
    vec2 pixelWorld = vWorldCoord;

    // Ambient base: the light value present EVERYWHERE, lit or not —
    // this is Unity's "2D global light" concept baked directly into
    // the buffer's own base color instead of a separate light type, so
    // Phase 2 never needs a special no-light-reaches-here case: it's
    // always sampling a real, already-ambient-lit value.
    vec3 accumulatedLight = vec3(1.0 - uAmbientDarkness);
    vec3 accumulatedShadowTint = vec3(0.0);
    float totalShadowMix = 0.0;

    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
        if (i >= uLightCount) break;

        int typeId = uLightTypeId[i];
        vec3 color = uLightColor[i];
        float intensity = uLightIntensity[i];
        intensity *= lightFlickerMultiplier(uTime, uLightFlicker[i], uLightFlickerSpeed[i], uLightFlickerDuration[i], float(i + 1));
        vec2 lightPos = uLightPos[i];

        float brightness = 0.0;
        // How much this pixel should blend toward white-hot for a
        // point/spot light's core (see radialHotness) — stays 0 for
        // every other light type, which keeps their own color exactly
        // as authored (a directional/area light has no single "source
        // point" for a core to make physical sense around).
        float hotness = 0.0;

        if (typeId == 0) {
            brightness = 1.0;
        } else {
            vec2 toPixel = pixelWorld - lightPos;
            float dist = length(toPixel);

            if (typeId == 1) {
                float radius = uLightRadius[i];
                float distT = clamp(dist / max(radius, 0.0001), 0.0, 1.0);
                brightness = dist > radius ? 0.0 : radialFalloff(distT) * radialGrain(toPixel, radius);
                hotness = dist > radius ? 0.0 : radialHotness(distT, uLightCoreSize[i]);
            } else if (typeId == 2) {
                float radius = uLightRadius[i];
                float distT = clamp(dist / max(radius, 0.0001), 0.0, 1.0);
                float radial = dist > radius ? 0.0 : radialFalloff(distT) * radialGrain(toPixel, radius);
                hotness = dist > radius ? 0.0 : radialHotness(distT, uLightCoreSize[i]);

                float angleToPixel = atan(toPixel.y, toPixel.x);
                float rel = angleToPixel - uLightRotation[i];
                rel = mod(rel + PI, 2.0 * PI) - PI;
                float halfCone = uLightAngle[i] * 0.5;
                // Feathers INWARD from the cone's own edge so the lit
                // area never extends past halfCone — matching the
                // gizmo's cone outline exactly instead of visibly
                // "shining outside" it.
                float coneFadeBand = max(0.03, halfCone * 0.25);
                float coneMask = 1.0 - smoothstep(halfCone - coneFadeBand, halfCone, abs(rel));

                brightness = radial * coneMask;
            } else if (typeId == 4) {
                brightness = godRaysBrightness(toPixel, dist, uLightRadius[i], uLightRotation[i], uLightAngle[i] * 0.5);
                float rayCoreT = clamp(uLightCoreSize[i], 0.02, 1.0);
                hotness = dist > uLightRadius[i] ? 0.0 : 1.0 - smoothstep(0.0, uLightRadius[i] * rayCoreT, dist);
            } else if (typeId == 5) {
                // Freeform: points are stored local to the light's own
                // Transform position and NOT rotated (see components/
                // Light.js), so the polygon test runs directly against
                // toPixel (pixel position relative to the light), no
                // toLocal() rotation needed.
                {
                // Inline polygon test -- GLSL ES 1.00 only allows const/loop
                // symbols as array indices, so the old helper functions (which
                // took base/j as function parameters) failed to compile. Each
                // edge is iterated as (p, p+1); the duplicated first point at
                // slot pCount handles the wrap-around (last->first) edge.
                int pCount = uLightPointCount[i];
                brightness = 0.0;
                if (pCount >= 3) {
                    bool inside = false;
                    for (int p = 0; p < ${MAX_FREEFORM_POINTS}; p++) {
                        if (p >= pCount) break;
                        vec2 pi = uPolyPoints[i * ${FREEFORM_STRIDE} + p];
                        vec2 pj = uPolyPoints[i * ${FREEFORM_STRIDE} + p + 1];
                        bool intersects = ((pi.y > toPixel.y) != (pj.y > toPixel.y)) &&
                            (toPixel.x < (pj.x - pi.x) * (toPixel.y - pi.y) / (pj.y - pi.y) + pi.x);
                        if (intersects) inside = !inside;
                    }
                    if (inside) {
                        float best = 1e6;
                        for (int p = 0; p < ${MAX_FREEFORM_POINTS}; p++) {
                            if (p >= pCount) break;
                            vec2 a = uPolyPoints[i * ${FREEFORM_STRIDE} + p];
                            vec2 b = uPolyPoints[i * ${FREEFORM_STRIDE} + p + 1];
                            vec2 ab = b - a;
                            float len2 = dot(ab, ab);
                            float t = len2 > 0.0 ? clamp(dot(toPixel - a, ab) / len2, 0.0, 1.0) : 0.0;
                        vec2 closest = a + ab * t;
                        best = min(best, length(toPixel - closest));
                    }
                    float feather = max(uLightRadius[i], 0.0001);
                    brightness = smoothstep(0.0, feather, best);
                    float coreDistance = length(toPixel);
                    hotness = 1.0 - smoothstep(0.0, max(feather * uLightCoreSize[i], 0.0001), coreDistance);
                }
            }
            }
            } else {
                vec2 local = toLocal(pixelWorld, lightPos, 0.0);
                vec2 halfSize = vec2(uLightWidth[i], uLightHeight[i]) * 0.5;
                brightness = areaFalloff(local, halfSize, uLightRadius[i]);
                float centerDistance = length(local / max(halfSize, vec2(0.0001)));
                hotness = (1.0 - smoothstep(0.0, max(uLightCoreSize[i] * 0.75, 0.02), centerDistance)) * brightness;
            }
        }

        // intensity is NOT clamped to 1.0 — Light.intensity supports
        // ">1 = overbright" by design (see components/Light.js), and a
        // hot/overbright light needs to be able to push this buffer's
        // value past 1.0 so Phase 2 can render a real "shine," not just
        // a 1:1 recolor.
        brightness *= max(0.0, intensity);
        if (brightness <= 0.0015) continue;

        float shadowAmount = 0.0;
        if (uLightCastsShadows[i] == 1 && uOccluderCount > 0) {
            float reach = uLightShadowReach[i];
            vec2 dirLightDir = vec2(cos(uLightRotation[i]), sin(uLightRotation[i]));
            if (uShadowMode == 1) {
                shadowAmount = raymarchShadowTest(pixelWorld, lightPos, reach, typeId == 0, dirLightDir);
            } else {
                for (int o = 0; o < ${MAX_OCCLUDERS}; o++) {
                    if (o >= uOccluderCount) break;
                    // Anchor the synthetic "far away point light" to
                    // THIS OCCLUDER, not to pixelWorld (see
                    // raymarchShadowTest's isDirectional comment above
                    // for why anchoring it to the shaded pixel instead
                    // was the bug — same fix applies here). Anchoring
                    // per-occluder still gives every pixel behind a
                    // given occluder the same effectiveLightPos, which
                    // is what makes that occluder's own shadow band
                    // consistently parallel, matching a true directional
                    // light instead of drifting per-pixel.
                    vec2 effectiveLightPos = typeId == 0
                        ? uOccPos[o] - dirLightDir * reach
                        : lightPos;
                    float s = quadShadowTest(pixelWorld, effectiveLightPos, uOccPos[o], uOccHalfExtents[o], uOccRotation[o], uOccOpacity[o], uOccLength[o], uOccSoftness[o], reach, 1.0);
                    shadowAmount = max(shadowAmount, s);
                }
            }
            shadowAmount *= uLightShadowStrength[i];
        }

        float litBrightness = brightness * (1.0 - shadowAmount);

        // HDR-ish core brightening: past litBrightness == 1.0 (i.e.
        // wherever this light's OWN intensity/falloff pushes past a
        // normal "fully lit" value — always near the light's source,
        // never out at the dim edge of its falloff), the extra energy
        // no longer just keeps adding pure "color" linearly (which is
        // what made cranking Intensity wash the whole lit area toward
        // flat white — rgb clamps to (1,1,1) at the SAME rate
        // everywhere brightness>=1, so a wide midtone falloff region
        // clips to white just as fast as the actual core does).
        // Instead the excess is Reinhard-style soft-compressed into a
        // "how hot is this pixel" amount that both nudges the light's
        // own color toward white-hot AND continues to climb the
        // overall magnitude a little further (real over-driven light
        // sources genuinely get brighter AND whiter at their core,
        // like a filament or the sun's disc) — but both curves
        // asymptote (hotAmount -> 1, magnitude -> ~1.6) instead of
        // ever hard-clipping, so no matter how high Intensity is set
        // this stays a bright hot core surrounded by its normal
        // colored falloff, never a flat white wash.
        float over = max(0.0, litBrightness - 1.0);
        float overbrightHot = clamp(over / (1.0 + over), 0.0, 1.0);
        // Combine the two hot-core sources: distance-based (this pixel
        // is simply near the light's physical source, at ANY intensity
        // — a normal, non-overbright lamp still has a brighter, whiter
        // filament than its glow) and overbright-based (the existing
        // effect above, for when Intensity itself is cranked past 1).
        // max(), not add: an overbright light's core doesn't need to be
        // hotter than a normal light's core just because both effects
        // are present — either one alone is enough to justify full
        // white, so they saturate together rather than stacking past 1.
        float hotAmount = max(hotness * (1.0 - shadowAmount), overbrightHot);
        hotAmount *= uLightCoreVisible[i];
        // Always use the user-authored color — the light's core stays the
        // chosen hue instead of bleaching to white. HDR brightness is still
        // carried by litMagnitude (which climbs past 1.0 for overbright
        // lights), so the "hot filament" feel is preserved through BRIGHTNESS
        // rather than hue-whitening. The hotAmount still drives extra magnitude
        // so an overbright light gets visibly brighter at its core.
        // Keep each light's energy spatially smooth and make the source
        // response subtly broader-spectrum at its hottest points. This
        // applies to every light type; the per-type brightness/falloff
        // above remains unchanged.
        float sourceHeat = max(hotAmount, clamp(litBrightness, 0.0, 1.0) * 0.08);
        vec3 litColor = realisticLightColor(color, sourceHeat, overbrightHot);
        float litMagnitude = min(litBrightness, 1.0) + overbrightHot * 0.6 + hotAmount * 0.3;
        accumulatedLight += litColor * litMagnitude;

        if (shadowAmount > 0.0015) {
            accumulatedShadowTint += uLightShadowColor[i] * shadowAmount * brightness;
            totalShadowMix = max(totalShadowMix, shadowAmount * brightness);
        }
    }

    // Shadow tint is baked into rgb here too (still purely a LIGHT
    // value, no sprite color involved) so Phase 2 stays a single
    // multiply with no extra shadow-specific logic of its own.
    vec3 finalLight = mix(accumulatedLight, accumulatedLight * (1.0 - totalShadowMix) + accumulatedShadowTint * 0.5, min(1.0, totalShadowMix));

    gl_FragColor = vec4(max(finalLight, 0.0), clamp(totalShadowMix, 0.0, 1.0));
}
`;

  return { VERTEX_SRC, FRAGMENT_SRC, FREEFORM_STRIDE };
}

/**
 * Builds a fresh PIXI.Filter that renders the light buffer described
 * above. Applied to a dedicated offscreen container (see
 * LightingSystem.js's _renderLightTexture) rather than the sprite
 * container — this filter has zero knowledge of sprites and must never
 * be applied directly to gameContentContainer.
 *
 * gl: the device's WebGLRenderingContext (normally
 * pixiApp.renderer.gl), used to size the shader's uniform arrays to
 * what THIS device's GPU actually supports (see resolveCaps() above) —
 * this is what makes the lighting shader compile on lower-end/
 * integrated GPUs that report a smaller MAX_FRAGMENT_UNIFORM_VECTORS
 * than the DEFAULT_MAX_LIGHTS/OCCLUDERS/FREEFORM_POINTS above assume.
 * Optional: omitting it (or passing a context resolveCaps can't query)
 * falls back to the fixed defaults, same as before this fix.
 *
 * The returned filter carries its resolved caps as
 * filter.lightingCaps = { MAX_LIGHTS, MAX_OCCLUDERS, MAX_FREEFORM_POINTS }
 * so LightingSystem.js can clamp how many lights/occluders it uploads
 * (and warn past that) using the SAME numbers the shader was actually
 * built with, instead of the fixed module constants this file used to
 * export for that purpose.
 */
export function buildLightTextureFilter(gl) {
  const caps = resolveCaps(gl);
  const MAX_LIGHTS = caps.MAX_LIGHTS;
  const MAX_OCCLUDERS = caps.MAX_OCCLUDERS;
  const { VERTEX_SRC, FRAGMENT_SRC, FREEFORM_STRIDE } = buildShaderSource(caps);

  const uniforms = {
    uAmbientDarkness: 0.65,
    uShadowMode: 0,
    uRaymarchSteps: 24,
    uTime: 0,
    uStageOffset: new Float32Array([0, 0]),
    uStageScale: 1,

    uLightCount: 0,
    uLightPos: new Float32Array(MAX_LIGHTS * 2),
    uLightTypeId: new Int32Array(MAX_LIGHTS),
    uLightColor: new Float32Array(MAX_LIGHTS * 3),
    uLightIntensity: new Float32Array(MAX_LIGHTS),
    uLightFlicker: new Float32Array(MAX_LIGHTS),
    uLightFlickerSpeed: new Float32Array(MAX_LIGHTS),
    uLightFlickerDuration: new Float32Array(MAX_LIGHTS),
    uLightCoreSize: new Float32Array(MAX_LIGHTS),
    uLightCoreVisible: new Float32Array(MAX_LIGHTS),
    uLightRadius: new Float32Array(MAX_LIGHTS),
    uLightAngle: new Float32Array(MAX_LIGHTS),
    uLightRotation: new Float32Array(MAX_LIGHTS),
    uLightWidth: new Float32Array(MAX_LIGHTS),
    uLightHeight: new Float32Array(MAX_LIGHTS),
    uLightCastsShadows: new Int32Array(MAX_LIGHTS),
    uLightShadowStrength: new Float32Array(MAX_LIGHTS),
    uLightShadowColor: new Float32Array(MAX_LIGHTS * 3),
    uLightShadowReach: new Float32Array(MAX_LIGHTS),

    uLightPointCount: new Int32Array(MAX_LIGHTS),
    uPolyPoints: new Float32Array(MAX_LIGHTS * FREEFORM_STRIDE * 2),

    uOccluderCount: 0,
    uOccPos: new Float32Array(MAX_OCCLUDERS * 2),
    uOccHalfExtents: new Float32Array(MAX_OCCLUDERS * 2),
    uOccRotation: new Float32Array(MAX_OCCLUDERS),
    uOccOpacity: new Float32Array(MAX_OCCLUDERS),
    uOccLength: new Float32Array(MAX_OCCLUDERS),
    uOccSoftness: new Float32Array(MAX_OCCLUDERS),
  };

  const filter = new PIXI.Filter(VERTEX_SRC, FRAGMENT_SRC, uniforms);
  filter.resolution = (window.__realotPixiApp && window.__realotPixiApp.renderer && window.__realotPixiApp.renderer.resolution) || Math.min(2, window.devicePixelRatio || 1);
  filter.autoFit = false;
  filter.lightingCaps = caps;
  return filter;
}
