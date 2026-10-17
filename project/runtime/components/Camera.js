/**
 * runtime/components/Camera.js
 *
 * Marks an entity as a camera and holds its viewport settings. A scene
 * is expected to have exactly one Main Camera (enforced by SceneLoader).
 *
 * `aspectMode` decides what shape the exported/played game screen is:
 *  - "Landscape"  : uses landscapeWidth x landscapeHeight
 *  - "Portrait"   : uses portraitWidth x portraitHeight
 *  - "Square"     : 1:1, driven by squareSize
 *  - "Custom"     : uses customWidth x customHeight verbatim
 * These pixel dimensions are the exact resolution the game is played /
 * exported at — see runtime/core/CameraUtils.js for the shared math both
 * the editor gizmo and the play window use to stay in sync.
 *
 * `enablePseudo3D` is a scene-wide depth toggle: when true, every
 * sprite's Transform.z ALSO scales its rendered size (more negative z =
 * farther from camera = smaller), giving a cheap fake-parallax/3D look,
 * on top of z always controlling draw order. When false (default), z
 * only controls draw order and never touches an object's visual size —
 * see runtime/systems/RenderSystem.js for where this is applied.
 *
 * RUNTIME-ONLY FILE.
 */

export const CAMERA = "Camera";

export const CameraAspectMode = Object.freeze({
  LANDSCAPE: "Landscape",
  PORTRAIT: "Portrait",
  SQUARE: "Square",
  CUSTOM: "Custom",
});

/**
 * How the fixed reference resolution (landscapeWidth/Height etc. above)
 * gets mapped onto whatever actual screen size the player's device
 * happens to have — the same job Unity's Canvas Scaler does. See
 * runtime/core/CameraUtils.js's computeScreenFit() for the exact math
 * and the full reasoning behind each mode; short version:
 *   EXPAND  — one axis (see Camera.keepHeight) is locked to exactly
 *             fill the screen; the OTHER axis shows more or less of the
 *             game world to match the device's own aspect ratio. No
 *             bars, no cropping, but the visible world differs by device.
 *   FIT     — scale uniformly so the whole reference resolution is
 *             always visible, adding letterbox/pillarbox bars on
 *             whichever axis has leftover space. Nothing is ever
 *             cropped or distorted.
 *   FILL    — scale uniformly to fill the entire screen, cropping
 *             whichever axis overflows. Never any bars, never distorted.
 *   STRETCH — map width and height independently, filling the screen
 *             exactly with no bars and no cropping — but this is the
 *             only mode that can visually distort (squash/stretch) the
 *             game if the device aspect ratio doesn't match the
 *             reference resolution's.
 */
export const ScalingMode = Object.freeze({
  EXPAND: "Expand",
  FIT: "Fit",
  FILL: "Fill",
  STRETCH: "Stretch",
});

export class Camera {
  constructor({
    backgroundColor = "#314D79",
    projection = "Orthographic",
    size = 5,
    nearClip = 0.3,
    farClip = 1000,
    isMain = false,
    aspectMode = CameraAspectMode.LANDSCAPE,
    landscapeWidth = 960,
    landscapeHeight = 540,
    portraitWidth = 540,
    portraitHeight = 960,
    squareSize = 720,
    customWidth = 800,
    customHeight = 600,
    enablePseudo3D = false,
    renderToSpriteEntityId = null,

    // ── Screen scaling (device-fit) settings ──────────────────────
    // See the ScalingMode doc comment above and computeScreenFit() in
    // CameraUtils.js for the full picture. This section resolves what
    // was originally a set of overlapping/potentially-contradictory
    // toggles (an aspectRatioLock AND an allowStretching AND an
    // integer-scaling-as-its-own-mode all requested together) into one
    // coherent, composable system: scalingMode picks the base strategy,
    // and every other field below is a well-defined, NON-overlapping
    // modifier on top of it — never two fields fighting over the same
    // decision.
    scalingMode = ScalingMode.FIT,
    // EXPAND-only. true = the reference HEIGHT is what's kept exact
    // (matches Unity's Canvas Scaler "Match: Height" — width is the
    // axis that expands/contracts to reveal more or less of the world).
    // false = the reference WIDTH is kept exact instead. No effect on
    // any other scalingMode — Fit/Fill already consider both axes via
    // min/max, and Stretch maps both axes independently regardless.
    keepHeight = true,
    // Safety override for EXPAND specifically: Expand's whole purpose
    // is to let the effective aspect ratio drift to match the device
    // (showing more/less world). If that's not acceptable for a given
    // game, aspectRatioLock:true downgrades Expand to behave like Fit
    // instead, so the reference aspect ratio is never altered. No
    // effect on Fit/Fill (already aspect-preserving by definition) or
    // Stretch (see allowStretching below for that one instead).
    aspectRatioLock = true,
    // Safety override for STRETCH specifically: false (default)
    // downgrades Stretch to behave like Fit instead, so a scalingMode
    // accidentally left on "Stretch" can never actually distort the
    // picture. Set true to permit real non-uniform stretching. No
    // effect on any other scalingMode.
    allowStretching = false,
    // Horizontal bars (top/bottom) — shown when Fit (or a mode
    // downgraded to Fit above) leaves vertical space unused.
    // "Auto" = shown only when that's the natural result of the
    // current effective mode; "On" = always painted whenever there's
    // any gap on this axis, in any mode; "Off" = never painted (bars
    // stay transparent/the renderer's own clear color instead).
    letterboxing = "Auto",
    // Same as letterboxing but for vertical bars (left/right), shown
    // when horizontal space is left over.
    pillarboxing = "Auto",
    // Color painted into letterbox/pillarbox bars when they're shown.
    barColor = "#000000",
    // Rounds the computed scale down to the nearest whole integer
    // (never below 1x) before applying it — keeps pixel-art crisp
    // instead of blurry/uneven at fractional scales. Applies to
    // Expand/Fit/Fill (and Stretch when downgraded to Fit); has no
    // effect on a genuine Stretch (allowStretching:true), since that
    // mode's whole point is filling the screen exactly, which integer
    // steps would undermine.
    integerScaling = false,
  } = {}) {
    this.backgroundColor = backgroundColor;
    this.projection = projection;
    this.size = size;
    this.nearClip = nearClip;
    this.farClip = farClip;
    this.isMain = isMain;

    this.aspectMode = aspectMode;
    this.landscapeWidth = landscapeWidth;
    this.landscapeHeight = landscapeHeight;
    this.portraitWidth = portraitWidth;
    this.portraitHeight = portraitHeight;
    this.squareSize = squareSize;
    this.customWidth = customWidth;
    this.customHeight = customHeight;
    this.enablePseudo3D = enablePseudo3D;

    this.scalingMode = scalingMode;
    this.keepHeight = keepHeight;
    this.aspectRatioLock = aspectRatioLock;
    this.allowStretching = allowStretching;
    this.letterboxing = letterboxing;
    this.pillarboxing = pillarboxing;
    this.barColor = barColor;
    this.integerScaling = integerScaling;

    // When set (via this.camera.renderToSprite(spriteEntity) in a script),
    // CameraRenderSystem renders THIS camera's view into a RenderTexture
    // every frame and assigns it as the target sprite's texture — the
    // standard minimap / security-camera technique. null = no render-to-
    // texture (the camera only drives the main screen, if it's the Main
    // Camera). The value is the target entity's id (not its name) so it
    // survives renames. See runtime/systems/CameraRenderSystem.js.
    this.renderToSpriteEntityId = renderToSpriteEntityId;
  }
}
