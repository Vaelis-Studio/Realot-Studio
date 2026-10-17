/**
 * runtime/systems/LightingSystem.js
 *
 * GPU-driven 2D lighting, rebuilt to match Unity URP's actual 2D
 * Lighting pipeline: TWO separate rendering phases per frame instead
 * of one all-in-one filter.
 *
 *   PHASE 1 — LIGHT TEXTURE (see LightTextureShaderSource.js):
 *     Every Light + ShadowCaster entity's data is uploaded as uniforms
 *     to a filter that draws ONLY light shapes (radial/cone/rect
 *     falloff, directional fill, shadow occlusion) into an offscreen
 *     PIXI.RenderTexture, in screen space, once per frame. This buffer
 *     has zero knowledge of sprites — exactly Unity's "Light Render
 *     Texture," a screen-space buffer containing only light color,
 *     rendered once and shared by every sprite that samples it.
 *
 *   PHASE 2 — SPRITE SAMPLING (see SpriteLightFilter.js):
 *     Every individual sprite RenderSystem tracks gets its own tiny
 *     PIXI.Filter attached that samples Phase 1's light texture at
 *     that sprite's own screen position and MULTIPLIES it into that
 *     sprite's own texture color. This is exactly Unity's Sprite-Lit
 *     shader step: "spriteColor * lightSample", nothing more.
 *
 * WHY TWO PHASES INSTEAD OF ONE FILTER (what changed from the previous
 * single-pass version): the old system ran one filter over the WHOLE
 * rendered scene and tried to do "read scene pixel, read all lights,
 * composite" in a single shader — which made it easy for a light's own
 * additive color term to overpower/replace a sprite's actual color
 * (visible as "sprites turn white under any light"). Splitting into
 * two phases makes that structurally impossible: Phase 1 NEVER touches
 * a sprite pixel (it only ever produces a light VALUE), and Phase 2's
 * only operation is multiplying that value into each sprite's own
 * color. A light can dim/tint/brighten a sprite; it can never replace
 * its color, and a shadow can never crush a pixel to flat (0,0,0)
 * unless ambientDarkness/shadowColor are deliberately set that way.
 *
 * COORDINATE SPACE: both phases work in the same WORLD-CONTAINER-LOCAL
 * pixel space Transform.x/y already live in (see _syncStageTransform),
 * so light positions need zero extra conversion whether
 * gameContentContainer is panned/zoomed (editor) or camera-follow
 * translated (play mode/player) — same guarantee the old system had.
 *
 * SHADOW MODES: unchanged from the previous version — "quad" (cheap
 * analytic per-pixel box-shadow test) or "raymarch" (true per-pixel
 * occlusion marching), both compiled into Phase 1's single shader and
 * switchable at runtime via LightingSettings.shadowMode (see
 * LightTextureShaderSource.js's uShadowMode branch).
 *
 * If a scene has ZERO light entities, Phase 1's light texture is never
 * rendered and every sprite's SpriteLightFilter is detached, so a
 * light-less scene pays exactly zero extra GPU cost and renders
 * pixel-identical to before lighting existed — same guarantee the
 * previous version made.
 *
 * Both the editor's Scene/Game viewport and the standalone player get
 * identical lighting because both go through this one System, same as
 * RenderSystem (see RULES.txt #5 — rendering is centralized). This
 * file keeps the SAME public shape (class name LightingSystem,
 * constructor(worldContainer, renderSystem, pixiApp), .update(world))
 * as the previous version so runtime/index.js and
 * editor/viewport/SceneViewport.js need no changes.
 *
 * RUNTIME-ONLY FILE (depends on PIXI, not on the editor).
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { LIGHT, LightType } from "../components/Light.js";
import { SHADOW_CASTER } from "../components/ShadowCaster.js";
import { LIGHTING_SETTINGS } from "../components/LightingSettings.js";
import { LightingQuality, ShadowMode } from "./LightingQuality.js";
import {
  buildLightTextureFilter,
  MAX_RAYMARCH_STEPS,
} from "./LightTextureShaderSource.js";
import { buildSpriteLightFilter } from "./SpriteLightFilter.js";
import { buildLightGlowFilter } from "./LightGlowFilter.js";

// Fallback ambient darkness (see components/LightingSettings.js), used
// only when a scene has no LightingSettings component.
const AMBIENT_DARKNESS = 0.65;

// Fallback occluder half-size (px) for a ShadowCaster with no explicit
// width/height override AND no live rendered sprite yet.
const FALLBACK_OCCLUDER_HALF = 24;

// Base shadow-casting distance (world units/px) for Directional
// lights' parallel shadows (see the old system's identical constant).
const DIRECTIONAL_SHADOW_BASE_DISTANCE = 1200;

const LIGHT_TYPE_ID = Object.freeze({
  [LightType.DIRECTIONAL]: 0,
  [LightType.POINT]: 1,
  [LightType.SPOT]: 2,
  [LightType.AREA]: 3,
  [LightType.GOD_RAYS]: 4,
  [LightType.FREEFORM]: 5,
});

// Fallback glow strength (see components/LightingSettings.js), used
// only when a scene has no LightingSettings component.
const GLOW_STRENGTH = 1;

export class LightingSystem extends System {
  /**
   * @param {PIXI.Container} worldContainer the SAME container
   *   RenderSystem draws sprites into. Phase 1's light texture is
   *   rendered from a SEPARATE offscreen container (never added to
   *   the visible stage) that mirrors this container's light/occluder
   *   DATA (not its display objects) — see _renderLightTexture.
   * @param {import('./RenderSystem.js').RenderSystem} [renderSystem]
   *   used for TWO things now: (1) reading each ShadowCaster entity's
   *   real rendered sprite bounds (unchanged from before), and (2)
   *   Phase 2 — iterating every live tracked sprite via
   *   getTrackedSprites() to attach/update its SpriteLightFilter.
   * @param {PIXI.Application} [pixiApp] used to read renderer.screen
   *   (so both phases always cover the full visible canvas) and to
   *   actually execute Phase 1's offscreen render each frame via
   *   renderer.render().
   */
  constructor(worldContainer, renderSystem, pixiApp, { editorPreview = false } = {}) {
    super();
    this.worldContainer = worldContainer;
    this.renderSystem = renderSystem || null;
    this.pixiApp = pixiApp || null;
    this.editorPreview = !!editorPreview;

    this.quality = new LightingQuality();

    this._filterBroken = false;

    // Throttle state for the over-budget light/occluder warnings in
    // update() below — see that method's own comment for why these
    // exist (unthrottled console.warn every frame is a real perf cost
    // and a console-spam problem for any scene that stays over budget).
    this._lastWarnedLightCount = null;
    this._lastWarnedOccluderCount = null;

    // Free-running clock (seconds since this LightingSystem was
    // created), used ONLY to drive God Rays' animated streak drift
    // (see uTime in LightTextureShaderSource.js). Uses performance.now()
    // rather than an accumulated dt sum so it stays correct even across
    // any paused/resumed editor frames.
    this._startTimeMs = (typeof performance !== "undefined" ? performance.now() : Date.now());

    // PHASE 1 state: an offscreen container (never attached to the
    // real stage) holding one full-screen quad with the light-texture
    // filter applied, plus the RenderTexture it gets rendered into
    // each frame.
    this._lightTextureFilter = this._buildLightTextureFilterSafely();
    this._lightRenderTexture = null;
    this._lightSourceContainer = null; // offscreen quad the filter is applied to
    this._lightQuad = null;

    // PHASE 2 state: entityId -> PIXI.Filter, one SpriteLightFilter
    // instance per live sprite, kept in sync with RenderSystem's own
    // tracked-sprite set every frame (see _syncSpriteFilters).
    this._spriteFilters = new Map();

    // PHASE 3 state: a single full-screen ADDITIVE sprite (see
    // LightGlowFilter.js) that makes every light type visibly glow
    // over the whole screen — background included — not just where
    // it happens to land on a sprite. Built alongside Phase 1's
    // resources since it also needs pixiApp.renderer.screen.
    this._glowFilter = this._buildLightGlowFilterSafely();
    this._glowSprite = null;

    if (this._lightTextureFilter && this.pixiApp && this.pixiApp.renderer) {
      this._setupLightTextureResources();
    }
  }

  /**
   * Wraps buildLightGlowFilter() the same defensive way as the light-
   * texture filter — a Phase 3 shader failure should never take down
   * Phase 1/2 lighting, it should just leave lights invisible over
   * empty background (falling back to the pre-glow behavior).
   */
  _buildLightGlowFilterSafely() {
    try {
      return buildLightGlowFilter();
    } catch (err) {
      console.error("[Lighting] Failed to compile light-glow shader — lights won't glow over empty background this session:", err);
      return null;
    }
  }

  /**
   * Wraps buildLightTextureFilter() so a GLSL compile/link failure is
   * reported through console.error (mirrored into the in-engine
   * Console panel by editor/state/ConsoleCapture.js) instead of
   * throwing out of the constructor and taking the whole engine down.
   *
   * Passes the real WebGL context (pixiApp.renderer.gl, when the
   * renderer exposes one) so buildLightTextureFilter can size the
   * shader's uniform arrays to what THIS device's GPU actually
   * supports (see LightTextureShaderSource.js's resolveCaps()) — this
   * is what makes the lighting shader compile on lower-end/integrated
   * GPUs instead of only ever fitting a typical dev machine's discrete
   * GPU and falling into this catch (silently disabling lighting for
   * the whole session) on everything else. The resolved caps are
   * stashed on this._lightingCaps so every other method that used to
   * import fixed MAX_LIGHTS/MAX_OCCLUDERS/MAX_FREEFORM_POINTS reads
   * the SAME numbers the shader currently running was actually built
   * with.
   */
  _buildLightTextureFilterSafely() {
    let gl = null;
    try {
      gl = (this.pixiApp && this.pixiApp.renderer && this.pixiApp.renderer.gl) || null;
    } catch (err) {
      // Some renderer types (e.g. a canvas fallback) don't expose
      // .gl at all — fall through with gl left null, same as if no
      // pixiApp were available yet.
    }
    try {
      const filter = buildLightTextureFilter(gl);
      this._lightingCaps = filter.lightingCaps;
      return filter;
    } catch (err) {
      this._filterBroken = true;
      this._lightingCaps = null;
      console.error("[Lighting] Failed to compile light-texture shader — lighting is disabled for this session:", err);
      return null;
    }
  }

  /**
   * Creates the offscreen RenderTexture + a single full-screen quad
   * (a PIXI.Sprite stretched to renderer.screen size, filter-only, no
   * visible texture content of its own) that Phase 1 renders every
   * frame. This mirrors Unity's Light Render Texture: a screen-space
   * buffer that exists independent of any particular sprite.
   */
  _setupLightTextureResources() {
    const screen = this.pixiApp.renderer.screen;
    this._lightRenderTexture = PIXI.RenderTexture.create({
      width: Math.max(1, screen.width),
      height: Math.max(1, screen.height),
      resolution: this.pixiApp.renderer.resolution,
    });

    // A blank white quad is enough — the light-texture filter computes
    // its ENTIRE output from world-position uniforms/varyings, it
    // never samples this quad's own pixels (see
    // LightTextureShaderSource.js's fragment shader: no uSampler at
    // all). The quad exists purely to give the filter a rectangle to
    // run over.
    this._lightQuad = new PIXI.Sprite(PIXI.Texture.WHITE);
    this._lightQuad.width = screen.width;
    this._lightQuad.height = screen.height;
    this._lightQuad.filters = [this._lightTextureFilter];

    this._lightSourceContainer = new PIXI.Container();
    this._lightSourceContainer.addChild(this._lightQuad);
    // Deliberately NEVER added to pixiApp.stage — rendered manually
    // into _lightRenderTexture via renderer.render() each frame
    // instead, so it's never part of the normal visible draw pass.

    if (this._glowFilter) {
      // This sprite IS added to the real visible stage — it's Phase
      // 3's actual on-screen output. It must be a SIBLING of
      // worldContainer (== gameContentContainer), not a CHILD of it:
      // worldContainer is panned/scaled (editor pan-zoom / camera
      // follow), but the light texture it samples is screen-space
      // (same convention as _lightQuad above), so this sprite needs
      // to cover the raw screen untransformed. Inserted immediately
      // after worldContainer in the stage's child order — in every
      // host (editor, player, play-mode popup) worldContainer is
      // added to pixiApp.stage BEFORE any other sibling exists yet
      // (see runtime/index.js), so this lands right above game
      // content and below any editor-only chrome added afterwards
      // (grid/gizmo containers — see SceneViewport.js), never
      // touching that chrome.
      this._glowSprite = new PIXI.Sprite(PIXI.Texture.WHITE);
      this._glowSprite.blendMode = PIXI.BLEND_MODES.ADD;
      this._glowSprite.filters = [this._glowFilter];
      this._glowSprite.width = screen.width;
      this._glowSprite.height = screen.height;
      this._glowSprite.visible = false;
      if (this.worldContainer.parent) {
        const idx = this.worldContainer.parent.getChildIndex(this.worldContainer);
        this.worldContainer.parent.addChildAt(this._glowSprite, idx + 1);
      } else {
        // Extremely defensive fallback — shouldn't happen given the
        // construction order documented above, but avoids a hard
        // crash if it ever does.
        this.pixiApp.stage.addChild(this._glowSprite);
      }
    }
  }

  update(world) {
    if (this._filterBroken || !this._lightTextureFilter || !this.pixiApp || !this.pixiApp.renderer) {
      this._teardownAllSpriteFilters();
      return;
    }

    const settings = this._readSettings(world);

    const allLightEntities = world
      .query(TRANSFORM, LIGHT)
      .filter((e) => e.getComponent(LIGHT).castsOnWorld);

    if (allLightEntities.length === 0) {
      this._teardownAllSpriteFilters();
      return;
    }

    // PERFORMANCE: cull lights that can't reach any pixel currently on
    // screen before they're ever uploaded to the shader. Phase 1
    // loops over every uploaded light for every pixel of the light
    // texture (see LightTextureShaderSource.js's main()), so a light
    // sitting far outside the camera's view still cost real per-pixel
    // ALU/shadow-test time every frame even though it could never be
    // visible — this is the actual reason "many lights in a scene"
    // used to tank frame rate even on scenes where most of those
    // lights were off-screen most of the time (open-world/large-level
    // scenes especially). Culling here, in JS, before the upload is
    // the cheap side of that tradeoff: a handful of bounds checks on
    // the CPU once per frame vs. real GPU shader work for every culled
    // light on every pixel.
    const visibleLightEntities = this._cullOffscreenLights(allLightEntities);

    if (visibleLightEntities.length === 0) {
      this._teardownAllSpriteFilters();
      return;
    }

    const lightEntities = visibleLightEntities;

    // These two warnings fire every frame the scene stays over budget
    // (update() runs every tick) — logged only ONCE per distinct
    // over-budget count instead of unthrottled every frame, which
    // would otherwise flood the console and cost real time in
    // console I/O for the entire time a scene is over its light/
    // occluder cap (e.g. a level with too many lights placed by
    // mistake would tank performance via logging alone, on top of the
    // actual capped-rendering behavior). Re-warns if the count changes
    // (more lights added/removed) so the message stays accurate, but
    // never repeats for the same count frame after frame.
    if (lightEntities.length > this._lightingCaps.MAX_LIGHTS) {
      if (this._lastWarnedLightCount !== lightEntities.length) {
        this._lastWarnedLightCount = lightEntities.length;
        console.warn(
          "[Lighting] Scene has " +
            lightEntities.length +
            " active lights but this device's shader only supports " +
            this._lightingCaps.MAX_LIGHTS +
            " at once. The extra " +
            (lightEntities.length - this._lightingCaps.MAX_LIGHTS) +
            " light(s) will be ignored — remove or disable some lights. (This device's GPU reports a smaller uniform budget than some others, so this cap can vary by machine.)"
        );
      }
    } else {
      this._lastWarnedLightCount = null;
    }

    const occluders = this._collectOccluders(world);
    if (occluders.length > this._lightingCaps.MAX_OCCLUDERS) {
      if (this._lastWarnedOccluderCount !== occluders.length) {
        this._lastWarnedOccluderCount = occluders.length;
        console.warn(
          "[Lighting] Scene has " +
            occluders.length +
            " enabled Shadow Casters but this device's shader only supports " +
            this._lightingCaps.MAX_OCCLUDERS +
            " at once. The extra " +
            (occluders.length - this._lightingCaps.MAX_OCCLUDERS) +
            " will not cast shadows."
        );
      }
    } else {
      this._lastWarnedOccluderCount = null;
    }

    try {
      const filter = this._lightTextureFilter;
      // stageScale (this function's return value) used to be threaded
      // into _fillLightUniforms/_fillOccluderUniforms to shrink shadow
      // reach/softness as the editor zoomed in — removed, see those two
      // functions' own comments for why that was backwards. The call
      // itself still has to run every frame regardless: it sets
      // uStageOffset/uStageScale, the actual world-to-screen coordinate
      // mapping Phase 1's shader needs, which is unrelated to the
      // shadow-reach bug.
      this._syncStageTransform(filter);

      this._fillLightUniforms(lightEntities, occluders);
      this._fillOccluderUniforms(occluders);

      filter.uniforms.uLightCount = Math.min(this._lightingCaps.MAX_LIGHTS, lightEntities.length);
      filter.uniforms.uOccluderCount = Math.min(this._lightingCaps.MAX_OCCLUDERS, occluders.length);
      filter.uniforms.uShadowMode = settings.shadowMode === ShadowMode.RAYMARCH ? 1 : 0;
      // Editor and game rendering intentionally use the same raymarch quality.
      // The editor is a visual authoring surface, so it must preview the
      // lighting the player will actually see instead of using a reduced
      // quality preset.
      filter.uniforms.uRaymarchSteps = Math.min(MAX_RAYMARCH_STEPS, Math.max(1, settings.raymarchSteps));
      filter.uniforms.uAmbientDarkness = Math.min(1, Math.max(0, settings.ambientDarkness));
      const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      filter.uniforms.uTime = (nowMs - this._startTimeMs) / 1000;

      // PHASE 1: render the light texture, once, this frame.
      this._renderLightTexture();

      // PHASE 2: make sure every live sprite has an up-to-date
      // SpriteLightFilter pointed at this frame's light texture.
      this._syncSpriteFilters();

      // PHASE 3: refresh the glow overlay so every light type is
      // visibly a light source, even over empty background.
      this._updateGlowOverlay(settings);
    } catch (err) {
      this._filterBroken = true;
      this._teardownAllSpriteFilters();
      console.error("[Lighting] Error while updating lighting — lighting disabled for this session:", err);
    }
  }

  /**
   * PHASE 3 driver: keeps the glow overlay sprite sized to the screen
   * and its filter uniforms in sync with this frame's light texture +
   * scene settings, then makes it visible. Mirrors _renderLightTexture
   * / _syncSpriteFilters in spirit but has nothing to render offscreen
   * — it just samples the texture those two already produced.
   */
  _updateGlowOverlay(settings) {
    if (!this._glowSprite || !this._glowFilter) return;

    const screen = this.pixiApp.renderer.screen;
    const w = Math.max(1, Math.round(screen.width));
    const h = Math.max(1, Math.round(screen.height));
    if (this._glowSprite.width !== w) this._glowSprite.width = w;
    if (this._glowSprite.height !== h) this._glowSprite.height = h;

    // Same fix as _renderLightTexture's filterArea assignment: this
    // filter also has autoFit = false (see LightGlowFilter.js), so
    // without an explicit filterArea its working area falls back to
    // this sprite's own global bounds, which drift out of sync with the
    // real screen rect as the editor pans — causing the glow to vanish
    // once a light crossed specific screen offsets.
    this._glowSprite.filterArea = this.pixiApp.renderer.screen;

    const f = this._glowFilter;
    f.uniforms.uLightTexture = this._lightRenderTexture;
    f.uniforms.uLightTexSize[0] = w;
    f.uniforms.uLightTexSize[1] = h;
    // See the matching note in _syncSpriteFilters() — Phase 1 and this
    // glow filter both address "position" via PIXI's own FilterSystem
    // outputFrame convention, which stays orientation-consistent across
    // render targets, so no manual flip is needed here either.
    f.uniforms.uLightTexFlipY = 0.0;
    f.uniforms.uAmbientFloor = 1 - Math.min(1, Math.max(0, settings.ambientDarkness));
    f.uniforms.uGlowStrength = Math.max(0, settings.glowStrength);

    this._glowSprite.visible = true;
  }

  /**
   * Resizes the offscreen RenderTexture/quad to match the renderer's
   * current screen size (canvas resize, resolution change), THEN
   * actually executes Phase 1: renders _lightSourceContainer into
   * _lightRenderTexture. This is the literal equivalent of Unity's
   * "draw the Light Textures for this batch" step — a real, separate
   * render pass that happens before any sprite is touched.
   */
  _renderLightTexture() {
    const screen = this.pixiApp.renderer.screen;
    const w = Math.max(1, Math.round(screen.width));
    const h = Math.max(1, Math.round(screen.height));

    if (this._lightRenderTexture.width !== w || this._lightRenderTexture.height !== h) {
      this._lightRenderTexture.resize(w, h);
      this._lightQuad.width = w;
      this._lightQuad.height = h;
    }

    // autoFit is false on this filter (see LightTextureShaderSource.js's
    // buildLightTextureFilter), which means PIXI will NOT automatically
    // size the filter's working area to the renderer's screen — without
    // an explicit filterArea, the FilterSystem instead falls back to the
    // light quad's own GLOBAL bounding box, which only reliably matches
    // the full screen while the quad sits at its default (0,0) position.
    // That fallback is what caused lights to vanish once panned near
    // specific screen offsets: the quad's computed bounds no longer
    // lined up with the actual visible canvas rect at those positions.
    // Setting filterArea explicitly every frame (matching the previous
    // single-pass system's _syncFilterArea) pins the shader's working
    // area to the renderer's real full screen rect regardless of any
    // pan/zoom, so this can never happen again.
    this._lightQuad.filterArea = this.pixiApp.renderer.screen;

    this.pixiApp.renderer.render(this._lightSourceContainer, {
      renderTexture: this._lightRenderTexture,
      clear: true,
    });
  }

  /**
   * PHASE 2 driver: walks every sprite RenderSystem currently tracks
   * (via the new getTrackedSprites() accessor — see RenderSystem.js)
   * and makes sure each one has a SpriteLightFilter attached and
   * pointed at this frame's light texture, adding filters for newly-
   * appeared sprites and removing them for sprites RenderSystem no
   * longer tracks (matches the entity's own lifecycle exactly, no
   * separate cleanup pass needed).
   */
  _syncSpriteFilters() {
    if (!this.renderSystem) return;

    const seen = new Set();
    const screen = this.pixiApp.renderer.screen;
    // NOTE: both Phase 1 (LightTextureShaderSource.js) and this filter
    // compute their screen-space "position" the SAME way, straight from
    // PIXI's own outputFrame/aVertexPosition — the FilterSystem keeps
    // that convention orientation-consistent regardless of whether the
    // immediate render target is the screen or a RenderTexture (that's
    // the whole point of the outputFrame abstraction: filters can be
    // chained across passes/targets and still agree on "where am I").
    // The generic "raw RenderTexture reads need a manual Y flip" quirk
    // only applies when UNFILTERED display objects are rendered
    // straight into a RenderTexture (bypassing the FilterSystem) —
    // Phase 1 draws through a FILTERED quad, so that quirk doesn't
    // apply here. A flip was previously hardcoded to 1.0 assuming it
    // did apply, which mirrored the light buffer vertically relative to
    // the (correctly-drawn, flip-free) gizmos — that was the actual
    // cause of "light Y-position inverted vs its gizmo." Left as a
    // uniform (not deleted) in case a future platform/PIXI version ever
    // needs it again.
    const flipY = 0.0;

    for (const [entityId, sprite] of this.renderSystem.getTrackedSprites()) {
      seen.add(entityId);
      let filter = this._spriteFilters.get(entityId);
      if (!filter) {
        filter = buildSpriteLightFilter();
        this._spriteFilters.set(entityId, filter);
      }

      filter.uniforms.uLightTexture = this._lightRenderTexture;
      filter.uniforms.uLightTexSize[0] = screen.width;
      filter.uniforms.uLightTexSize[1] = screen.height;
      filter.uniforms.uLightTexFlipY = flipY;

      const existing = sprite.filters || [];
      if (existing.indexOf(filter) === -1) {
        sprite.filters = [...existing.filter((f) => f !== filter), filter];
      }
    }

    // Detach + drop filters for sprites that no longer exist.
    for (const [entityId, filter] of this._spriteFilters) {
      if (seen.has(entityId)) continue;
      // MEMORY LEAK FIX: buildSpriteLightFilter() creates a brand-new
      // PIXI.Filter (its own compiled shader program + GPU uniform
      // buffers) per sprite — dropping it from this Map only frees the
      // JS reference, it does NOT release the underlying GPU resources.
      // Every sprite that ever received a light filter and was later
      // destroyed (bullets, pooled enemies, particles, anything spawned
      // in a lit scene) was leaking one compiled shader/filter per
      // occurrence for the rest of the session. destroy() releases the
      // GL-side resources; safe to call even though the sprite itself
      // is already gone, since the filter is a separate PIXI object.
      filter.destroy();
      this._spriteFilters.delete(entityId);
    }
  }

  /**
   * Removes every sprite's SpriteLightFilter (scene has zero active
   * lights, or the light-texture shader is broken) so lighting has
   * exactly zero visual/GPU effect, matching the previous version's
   * "detach filter -> pixel-identical to before lighting existed"
   * guarantee.
   */
  _teardownAllSpriteFilters() {
    if (!this.renderSystem) {
      this._spriteFilters.clear();
      return;
    }
    for (const [entityId, sprite] of this.renderSystem.getTrackedSprites()) {
      const filter = this._spriteFilters.get(entityId);
      if (!filter || !sprite.filters) continue;
      const remaining = sprite.filters.filter((f) => f !== filter);
      sprite.filters = remaining.length ? remaining : null;
    }
    // MEMORY LEAK FIX: same issue as _syncSpriteFilters' cleanup pass —
    // clear() alone drops the JS references but leaves every filter's
    // compiled shader/GPU resources allocated. This path runs whenever
    // lighting is toggled off entirely, so without this it leaks EVERY
    // currently-active sprite filter at once.
    for (const filter of this._spriteFilters.values()) filter.destroy();
    this._spriteFilters.clear();
    if (this._glowSprite) this._glowSprite.visible = false;
  }

  /**
   * Clears display objects from the previous scene without destroying the
   * shared lighting shaders and render textures owned by this game instance.
   */
  resetScene() {
    this._teardownAllSpriteFilters();
  }

  /**
   * Reads the scene's LightingSettings component, if any — identical
   * semantics to the previous version.
   */
  _readSettings(world) {
    const entity = world.query(LIGHTING_SETTINGS)[0];
    const settings = entity ? entity.getComponent(LIGHTING_SETTINGS) : null;
    return {
      shadowMode: settings ? settings.shadowMode : this.quality.shadowMode,
      raymarchSteps: settings ? settings.raymarchSteps : this.quality.raymarchSteps,
      ambientDarkness: settings ? settings.ambientDarkness : AMBIENT_DARKNESS,
      glowStrength: settings && settings.glowStrength != null ? settings.glowStrength : GLOW_STRENGTH,
    };
  }

  /**
   * Uploads gameContentContainer's actual on-screen transform (plain
   * translate + uniform scale) to the given filter so Phase 1's
   * shader can convert screen-space pixels back to world space.
   * Identical approach/rationale to the previous version — walked by
   * hand from .x/.y/.scale.x up the parent chain rather than read off
   * .worldTransform, to always be exactly in sync with the frame
   * about to render rather than one frame stale.
   */
  _syncStageTransform(filter) {
    let offsetX = 0;
    let offsetY = 0;
    let scale = 1;
    let node = this.worldContainer;
    while (node) {
      offsetX = offsetX * node.scale.x + node.x;
      offsetY = offsetY * node.scale.y + node.y;
      scale *= node.scale.x;
      node = node.parent;
    }
    filter.uniforms.uStageOffset[0] = offsetX;
    filter.uniforms.uStageOffset[1] = offsetY;
    filter.uniforms.uStageScale = scale || 1;
    return scale || 1;
  }

  /**
   * Drops every light entity whose bounding circle can't possibly
   * touch a pixel currently visible on screen, BEFORE it's counted
   * toward uLightCount or uploaded to any uniform array. This is the
   * fix for "a scene with many lights runs slow even when most of
   * them are off-screen" — Phase 1's shader (see
   * LightTextureShaderSource.js's main()) loops over every uploaded
   * light for every pixel of the light texture, so an off-screen
   * light was previously paying real per-pixel ALU (and, if it casts
   * shadows, a full occluder loop / raymarch) every frame for zero
   * visible benefit.
   *
   * Directional lights are NEVER culled — by definition they light
   * the entire screen uniformly (see Light.js's DIRECTIONAL doc
   * comment), so there is no "off-screen" for one to be culled to.
   *
   * The screen rect is expanded by each light's own reach before the
   * test (rather than testing only the light's Transform position),
   * so a light whose SOURCE sits just off-screen but whose glow still
   * spills onto visible pixels is correctly kept, not culled — this
   * matters most for large-radius lights near screen edges and for
   * Area lights, whose emitting rectangle can be sizeable.
   *
   * @param {Entity[]} lightEntities entities already filtered to
   *   TRANSFORM+LIGHT with castsOnWorld true (see update())
   * @returns {Entity[]} the subset that can actually affect the
   *   current screen, in the SAME relative order (so light "slot"
   *   assignment — and therefore flicker-phase, which is seeded from
   *   a light's index — stays stable frame to frame as unrelated
   *   off-screen lights are added/removed elsewhere in the scene)
   */
  _cullOffscreenLights(lightEntities) {
    if (!this.pixiApp || !this.pixiApp.renderer) return lightEntities;

    const screen = this.pixiApp.renderer.screen;
    // Recompute the same world<->screen mapping _syncStageTransform
    // uploads to the shader (offset/scale walked up worldContainer's
    // own parent chain), rather than reusing filter.uniforms — this
    // runs BEFORE _syncStageTransform() is called for the frame (see
    // update()'s ordering), so the uniform values could still be
    // stale from last frame at this point.
    let offsetX = 0;
    let offsetY = 0;
    let scale = 1;
    let node = this.worldContainer;
    while (node) {
      offsetX = offsetX * node.scale.x + node.x;
      offsetY = offsetY * node.scale.y + node.y;
      scale *= node.scale.x;
      node = node.parent;
    }
    const safeScale = scale || 1;

    // Visible world-space rect: invert the screen<->world mapping
    // Phase 1's shader itself uses (screenPixel = worldPos * scale +
    // offset), i.e. worldPos = (screenPixel - offset) / scale.
    const worldLeft = (0 - offsetX) / safeScale;
    const worldTop = (0 - offsetY) / safeScale;
    const worldRight = (screen.width - offsetX) / safeScale;
    const worldBottom = (screen.height - offsetY) / safeScale;
    const minX = Math.min(worldLeft, worldRight);
    const maxX = Math.max(worldLeft, worldRight);
    const minY = Math.min(worldTop, worldBottom);
    const maxY = Math.max(worldTop, worldBottom);

    return lightEntities.filter((entity) => {
      const light = entity.getComponent(LIGHT);
      if (light.type === LightType.DIRECTIONAL) return true;

      const transform = entity.getComponent(TRANSFORM);
      let reach;
      if (light.type === LightType.AREA) {
        // Half-diagonal of the emitting rect plus its own falloff
        // radius — a generous but cheap bound, avoids under-culling a
        // wide/tall Area light near an edge.
        reach = Math.hypot((light.width || 0) / 2, (light.height || 0) / 2) + Math.max(0, light.radius || 0);
      } else if (light.type === LightType.FREEFORM) {
        // Farthest declared point from the light's own origin, since
        // Freeform has no single radius field (see Light.js).
        let farthest = 0;
        const pts = light.points || [];
        for (let p = 0; p < pts.length; p++) {
          const d = Math.hypot(pts[p].x || 0, pts[p].y || 0);
          if (d > farthest) farthest = d;
        }
        reach = farthest;
      } else {
        // Point / Spot / GodRays: radius is the light's own documented
        // falloff distance (see Light.js) — exact bound, no cone-angle
        // narrowing applied, since a cheap circle test is what makes
        // this worth doing at all; a spot facing away from the screen
        // still costs one bounds check either way, not a per-pixel one.
        reach = Math.max(0, light.radius || 0);
      }

      return (
        transform.x + reach >= minX &&
        transform.x - reach <= maxX &&
        transform.y + reach >= minY &&
        transform.y - reach <= maxY
      );
    });
  }

  /**
   * Fills Phase 1's per-light uniform arrays — consumed by the shader
   * in LightTextureShaderSource.js.
   */
  _fillLightUniforms(lightEntities, occluders) {
    const u = this._lightTextureFilter.uniforms;
    const count = Math.min(this._lightingCaps.MAX_LIGHTS, lightEntities.length);

    for (let i = 0; i < count; i++) {
      const entity = lightEntities[i];
      const transform = entity.getComponent(TRANSFORM);
      const light = entity.getComponent(LIGHT);
      const rgb = this._toRgbFloats(light.color);
      const shadowRgb = this._toRgbFloats(light.shadowColor);

      u.uLightPos[i * 2 + 0] = transform.x;
      u.uLightPos[i * 2 + 1] = transform.y;
      u.uLightTypeId[i] = LIGHT_TYPE_ID[light.type] ?? 1;
      u.uLightColor[i * 3 + 0] = rgb[0];
      u.uLightColor[i * 3 + 1] = rgb[1];
      u.uLightColor[i * 3 + 2] = rgb[2];
      u.uLightIntensity[i] = Math.max(0, light.intensity);
      u.uLightFlicker[i] = light.flicker ? 1 : 0;
      u.uLightFlickerSpeed[i] = Math.max(0, light.flickerSpeed ?? 8);
      u.uLightFlickerDuration[i] = Math.max(0, light.flickerDuration ?? 0);
      u.uLightCoreSize[i] = Math.max(0.01, Math.min(1, light.coreSize ?? 0.22));
      u.uLightCoreVisible[i] = light.coreVisible === false ? 0 : 1;
      u.uLightRadius[i] = Math.max(0.0001, light.radius || 0);
      u.uLightAngle[i] = ((light.angle ?? 45) * Math.PI) / 180;
      u.uLightRotation[i] = ((transform.rotation || 0) * Math.PI) / 180;
      u.uLightWidth[i] = Math.max(0, light.width || 0);
      u.uLightHeight[i] = Math.max(0, light.height || 0);
      u.uLightCastsShadows[i] = light.castShadows && occluders.length ? 1 : 0;
      u.uLightShadowStrength[i] = Math.max(0, light.shadowStrength ?? 1);
      u.uLightShadowColor[i * 3 + 0] = shadowRgb[0];
      u.uLightShadowColor[i * 3 + 1] = shadowRgb[1];
      u.uLightShadowColor[i * 3 + 2] = shadowRgb[2];
      // Shadow reach is a WORLD-space physical property of the light
      // (how far its shadows actually extend, in the same units as
      // Transform.x/y, Collider sizes, etc.) — it must stay in true
      // world units, exactly like uOccPos/uOccHalfExtents below, or the
      // two stop being comparable inside the shader (quadShadowTest's
      // farDist = distToOcc + apparentHalf directly adds reach to an
      // occluder half-extent; raymarchShadowTest's occlusion cutoff
      // compares reach-derived occReach against sdf, an occluder
      // distance — both assume the same unit space).
      //
      // This used to be divided by stageScale on the theory that a
      // shadow's reach is a "screen-space visual property" that should
      // hold a constant ON-SCREEN length as the editor camera zooms.
      // That's backwards for a physical shadow: a real shadow's length
      // is fixed relative to the objects in the scene, not to the
      // camera — zooming the editor's viewport in and out shouldn't
      // make an object's shadow visibly shrink or grow, any more than
      // zooming should shrink the object itself. The stageScale
      // division was exactly why shadows got visibly shorter as you
      // zoomed in: it was actively re-shrinking the world-space reach
      // every time the screen-to-world ratio changed, on top of (and
      // independently from) reach's actual Length/radius tuning.
      const worldReach =
        light.type === LightType.DIRECTIONAL ? DIRECTIONAL_SHADOW_BASE_DISTANCE : Math.max(0.0001, light.radius || 0);
      u.uLightShadowReach[i] = worldReach;

      // Freeform polygon points, flattened into this light's slot of
      // the shared uPolyPoints array (see LightTextureShaderSource.js's
      // resolveCaps()/MAX_FREEFORM_POINTS doc comments — the cap is
      // device-dependent, not a fixed constant). Points beyond the cap
      // are silently dropped rather than erroring — matches
      // uLightCount's own "just stop uploading past the uniform
      // budget" behavior.
      const points = light.type === LightType.FREEFORM ? light.points || [] : null;
      const pointCount = points ? Math.min(this._lightingCaps.MAX_FREEFORM_POINTS, points.length) : 0;
      u.uLightPointCount[i] = pointCount;
      if (points) {
        const base = i * (this._lightingCaps.MAX_FREEFORM_POINTS + 1);
        for (let p = 0; p < pointCount; p++) {
          u.uPolyPoints[(base + p) * 2 + 0] = points[p].x;
          u.uPolyPoints[(base + p) * 2 + 1] = points[p].y;
        }
        // Duplicate first point right after the last so the shader can
        // iterate polygon edges as (p, p+1) including the wrap-around
        // (last->first) without a computed array index (GLSL ES 1.00
        // only allows const/loop-variable expressions as indices).
        if (pointCount > 0) {
          u.uPolyPoints[(base + pointCount) * 2 + 0] = points[0].x;
          u.uPolyPoints[(base + pointCount) * 2 + 1] = points[0].y;
        }
      }
    }
  }

  /**
   * Fills Phase 1's per-occluder uniform arrays — consumed by the
   * shader in LightTextureShaderSource.js. All values (including
   * `softness`) are plain world-unit values, same as uOccPos/
   * uOccHalfExtents — see LightingSystem.js's _fillLightUniforms
   * comment on uLightShadowReach for why: these are compared directly
   * against other world-space quantities inside the shader (sdf,
   * apparentHalf, etc.), so re-scaling any one of them by editor zoom
   * would make it stop lining up with the others, not fix anything.
   */
  _fillOccluderUniforms(occluders) {
    const u = this._lightTextureFilter.uniforms;
    const count = Math.min(this._lightingCaps.MAX_OCCLUDERS, occluders.length);

    for (let i = 0; i < count; i++) {
      const occ = occluders[i];
      u.uOccPos[i * 2 + 0] = occ.x;
      u.uOccPos[i * 2 + 1] = occ.y;
      u.uOccHalfExtents[i * 2 + 0] = occ.halfWidth;
      u.uOccHalfExtents[i * 2 + 1] = occ.halfHeight;
      u.uOccRotation[i] = (occ.rotationDeg * Math.PI) / 180;
      u.uOccOpacity[i] = occ.opacity;
      u.uOccLength[i] = occ.length;
      // World-space, like uOccPos/uOccHalfExtents above and
      // uLightShadowReach in _fillLightUniforms — previously divided by
      // stageScale on the same "hold a constant on-screen size" theory
      // that made shadow reach shrink while zooming in (see that
      // uLightShadowReach comment for the full explanation). softness
      // is compared directly against sdf (a world-space distance from
      // the occluder's box) in both quadShadowTest's edge-fade and
      // raymarchShadowTest's soft-distance accumulation, so it needs to
      // be in the same world units those use, not re-scaled by zoom.
      u.uOccSoftness[i] = occ.softness;
    }
  }

  /**
   * Gathers every enabled ShadowCaster entity's world-space occluder
   * box. Identical semantics to the previous version.
   */
  _collectOccluders(world) {
    const casters = world.query(TRANSFORM, SHADOW_CASTER);
    const out = [];
    for (const entity of casters) {
      const caster = entity.getComponent(SHADOW_CASTER);
      if (!caster.enabled) continue;
      const transform = entity.getComponent(TRANSFORM);
      const rotationDeg = transform.rotation || 0;
      const angleRad = (rotationDeg * Math.PI) / 180;

      let halfWidth, halfHeight;
      const real = this.renderSystem ? this.renderSystem.getSpriteWorldHalfExtents(entity.id) : null;
      if (caster.width != null && caster.height != null) {
        halfWidth = caster.width / 2;
        halfHeight = caster.height / 2;
      } else if (real) {
        halfWidth = real.halfWidth;
        halfHeight = real.halfHeight;
      } else {
        halfWidth = FALLBACK_OCCLUDER_HALF;
        halfHeight = FALLBACK_OCCLUDER_HALF;
      }

      const localOffsetX = caster.offsetX || 0;
      const localOffsetY = caster.offsetY || 0;
      const rotatedOffsetX = localOffsetX * Math.cos(angleRad) - localOffsetY * Math.sin(angleRad);
      const rotatedOffsetY = localOffsetX * Math.sin(angleRad) + localOffsetY * Math.cos(angleRad);

      out.push({
        id: entity.id,
        x: transform.x + rotatedOffsetX,
        y: transform.y + rotatedOffsetY,
        halfWidth,
        halfHeight,
        rotationDeg,
        opacity: caster.opacity != null ? caster.opacity : 1,
        length: caster.length != null ? caster.length : 1,
        softness: Math.max(0, caster.softness || 0),
      });
    }
    return out;
  }

  _toRgbFloats(colorString) {
    let hex;
    try {
      hex =
        PIXI.utils && PIXI.utils.string2hex
          ? PIXI.utils.string2hex(colorString)
          : parseInt(String(colorString).replace("#", "0x")) || 0xffffff;
    } catch (err) {
      hex = 0xffffff;
    }
    if (!Number.isFinite(hex)) {
      console.warn("[Lighting] Light has an invalid color value '" + colorString + "' — falling back to white.");
      hex = 0xffffff;
    }
    return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
  }

  destroy() {
    this._teardownAllSpriteFilters();
    if (this._lightTextureFilter) this._lightTextureFilter.destroy();
    if (this._lightRenderTexture) this._lightRenderTexture.destroy(true);
    if (this._lightSourceContainer) this._lightSourceContainer.destroy({ children: true });
    if (this._glowFilter) this._glowFilter.destroy();
    if (this._glowSprite) {
      if (this._glowSprite.parent) this._glowSprite.parent.removeChild(this._glowSprite);
      this._glowSprite.destroy();
    }
  }
}
