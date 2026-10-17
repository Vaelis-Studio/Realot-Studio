/**
 * runtime/components/StrokePath.js
 *
 * A variable-thickness strip drawn along a user-placed sequence of
 * points — generic point-list geometry rather than anything
 * road-specific, so it's equally at home as a river, a cable, a wall
 * segment, a conveyor belt, or an actual road. Points are placed by
 * clicking in the Scene viewport with the Path tool (see
 * editor/viewport/StrokePathGizmo.js + SceneViewport.js's "path" tool
 * branch), then relaxed/adjusted afterward by dragging any point or
 * clicking a segment to insert a new one between two existing points —
 * same interaction convention as Light.js's Freeform points, except a
 * StrokePath is an OPEN polyline (a path from A to B), not a closed
 * loop.
 *
 * Fill is either a flat color (simple filled polygon outline of the
 * strip's silhouette — works everywhere, no texture needed) or an
 * image texture running along the path (see
 * runtime/systems/RenderSystem.js's StrokePath drawing block, which
 * switches on `useTexture`). Both share the same underlying strip
 * geometry; only the fill step differs.
 *
 * The texture/joint/cap field set below deliberately mirrors Godot's
 * Line2D node (texture_mode, texture_repeat, joint_mode,
 * begin_cap_mode/end_cap_mode) rather than inventing new vocabulary —
 * anyone who has textured a Line2D before should recognize every field
 * here by name and behavior.
 *
 * `points` are stored in the entity's LOCAL space (offsets from the
 * entity's own Transform position), same convention as Light.js's
 * Freeform `points` — NOT rotated/scaled by Transform.rotation/scale,
 * so dragging a point in the Scene view always means "move this exact
 * point to here" regardless of the entity's own transform.
 *
 * RUNTIME-ONLY FILE.
 */

export const STROKE_PATH = "StrokePath";

/**
 * How the texture is mapped along the path's length — same two
 * choices, same names, as Godot's Line2D.texture_mode (LINE_TEXTURE_*),
 * minus LINE_TEXTURE_NONE (that case is just useTexture=false here).
 */
export const StrokePathTextureMode = {
  // The whole texture is squeezed/stretched to fit end-to-end, however
  // long the path is — same as Godot's LINE_TEXTURE_STRETCH. Simple
  // and predictable, but a texture with a fixed real-world scale (e.g.
  // brick, dashed-line stripes) visibly warps as the path is
  // lengthened or shortened, since one image always spans 0%-100% of
  // the path no matter how long that path actually is.
  STRETCH: "stretch",
  // The texture repeats at its own natural size, over and over along
  // the path, WITHOUT stretching — same as Godot's LINE_TEXTURE_TILE.
  // `textureTiling` sets how many world units one full tile covers, so
  // the image's apparent size stays constant as the path is
  // lengthened; extending the path just adds more repeats instead of
  // stretching the existing ones.
  TILE: "tile",
};

/**
 * How interior joints (where two path segments meet) are drawn — same
 * three choices, same names, as Godot's Line2D.joint_mode
 * (LINE_JOINT_*).
 */
export const StrokePathJointMode = {
  // Hard corner: the two segments' offset edges are simply butted
  // together at the shared vertex, no smoothing — same as Godot's
  // LINE_JOINT_SHARP (this engine always uses the SHARP fallback
  // rather than true miter-extension; see StrokePathGeometry.js's
  // buildStrokePathPolygon doc comment for why a full miter solve is
  // skipped).
  SHARP: "sharp",
  // The corner is chamfered flat — the two segments' offset edges are
  // connected with a single straight line across the joint instead of
  // either a point or a curve — same as Godot's LINE_JOINT_BEVEL.
  BEVEL: "bevel",
  // The corner is rounded off with a filled arc — same as Godot's
  // LINE_JOINT_ROUND.
  ROUND: "round",
};

/**
 * How the path's two open ends are drawn — same three choices, same
 * names, as Godot's Line2D.begin_cap_mode/end_cap_mode
 * (LINE_CAP_*), applied to StrokePath's start and end together via a
 * single `capMode` rather than two separate fields (a StrokePath's two
 * ends are interchangeable — nothing about "begin" vs "end" carries
 * meaning here the way it might in a node meant to be walked
 * directionally, so one shared setting covers both without asking the
 * user to keep two identical values in sync).
 */
export const StrokePathCapMode = {
  // The path just stops flat at the last segment's own edge — no cap
  // geometry added at all — same as Godot's LINE_CAP_NONE.
  NONE: "none",
  // The end is extended slightly past the last point with a flat
  // square edge (a half-thickness rectangular flag past the tip) —
  // same as Godot's LINE_CAP_BOX.
  BOX: "box",
  // The end is capped with a filled half-circle — same as Godot's
  // LINE_CAP_ROUND.
  ROUND: "round",
};

export class StrokePath {
  constructor({
    // Two default points (a minimal, visibly-a-path starting shape)
    // rather than one or zero — a single point has no strip to draw at
    // all, so a StrokePath freshly added via the GameObject menu or
    // Add Component window shows *something* immediately instead of
    // an invisible/degenerate result the user has to fix before they
    // can even see what they added.
    points = [
      { x: -100, y: 0 },
      { x: 100, y: 0 },
    ],
    thickness = 40,
    color = "#8a8a8a",
    opacity = 1,
    useTexture = false,
    // Logical sprite key, resolved to a PIXI.Texture the same way
    // SpriteRenderer.spriteKey is (see runtime/assets/AssetManager.js
    // resolveTexture) — components never hold PIXI objects directly,
    // for the same "stay serializable" reason SpriteRenderer doesn't.
    textureKey = null,
    // See StrokePathTextureMode above — STRETCH (fit the whole image
    // to the path, may distort) or TILE (repeat at native size, never
    // stretched).
    textureMode = StrokePathTextureMode.STRETCH,
    // TILE mode only: how many world units of path length one full
    // texture tile covers lengthwise — e.g. 100 means the image
    // repeats once every 100 units of path length, regardless of how
    // long the whole path is. Has no effect in STRETCH mode (there,
    // exactly one image always spans the entire path by definition).
    textureTiling = 100,
    // How many times the texture repeats ACROSS the strip's own
    // thickness (perpendicular to the direction of travel) — kept
    // separate from textureTiling (the lengthwise axis) since a
    // texture like a road stripe or brick run almost always needs a
    // different repeat rate across its width than along its length.
    // 1 = the image's own height maps to exactly the strip's full
    // thickness with no repeat.
    textureScale = 1,
    // Slides the texture lengthwise along the path without moving any
    // point — e.g. animating this over time makes the fill appear to
    // flow along the path (a conveyor belt, a river's current, a
    // marching dashed line). Expressed in the same world-unit basis as
    // textureTiling, so an offset equal to one full textureTiling
    // length is exactly one full repeat and wraps seamlessly.
    textureOffset = 0,
    // Mirrors the texture across the path's own centerline (flips
    // which side is "up") without needing a second, mirrored copy of
    // the source image — handy for a texture that's only authored for
    // one direction of travel.
    textureFlip = false,
    // Rotates the texture, in degrees, around the center of each
    // tile — independent of every other texture setting above, and
    // applied in TEXTURE space (not world space), so it stays a fixed
    // "printed at an angle on the image" look rather than a rotation
    // that would need to track the path's own direction as it turns.
    // No equivalent on Godot's Line2D (its texture mapping has no
    // rotation control at all) — added here since a strip's texture,
    // unlike a flat sprite's, otherwise has no way to run diagonally
    // across the strip (e.g. angled hazard stripes, a diagonal weave)
    // without re-authoring the source image itself.
    textureRotation = 0,
    // See StrokePathJointMode above — SHARP (hard corner), BEVEL
    // (flat chamfer), or ROUND (filled arc). Replaces an earlier plain
    // boolean roundedJoints field with the fuller Godot-style
    // three-way choice.
    jointMode = StrokePathJointMode.ROUND,
    // See StrokePathCapMode above — NONE (flat stop), BOX (flat, but
    // extended slightly past the tip), or ROUND (half-circle cap).
    // Applies to BOTH of the path's open ends.
    capMode = StrokePathCapMode.ROUND,
    // 0-1. Runs the authored `points` through a Catmull-Rom spline
    // resample BEFORE tessellation, turning the raw straight-segment
    // polyline into a smooth curve — same idea as a spline/curve tool
    // in a 3D package, applied to this 2D strip. 0 (the default) keeps
    // the path exactly as authored (straight segments, hard vertex
    // corners softened only by jointMode) so existing paths are
    // pixel-identical after upgrade. Above 0, each original vertex
    // becomes a smooth pass-through point on a continuous curve
    // instead of a sharp direction change — this is what actually
    // fixes texture pinching/warping on a turn, since the underlying
    // geometry no longer has a sudden angle for the joint math to
    // patch over. 1 = fully smoothed (the curve is re-sampled at its
    // natural density — see StrokePathGeometry.js's
    // resampleSmoothPoints). Endpoints are never rounded off — the
    // path still starts and ends exactly at its first/last authored
    // point.
    smoothing = 0,
  } = {}) {
    // Deep-copy so distinct StrokePath instances never share point
    // objects by accident (e.g. via spread/default-arg reuse) — same
    // reasoning as ShapeRenderer.trianglePoints and Light's
    // Freeform points.
    this.points = points.map((p) => ({ x: p.x, y: p.y }));
    this.thickness = thickness;
    this.color = color;
    this.opacity = opacity;
    this.useTexture = useTexture;
    this.textureKey = textureKey;
    this.textureMode = textureMode;
    this.textureTiling = textureTiling;
    this.textureScale = textureScale;
    this.textureOffset = textureOffset;
    this.textureFlip = textureFlip;
    this.textureRotation = textureRotation;
    this.jointMode = jointMode;
    this.capMode = capMode;
    this.smoothing = Math.max(0, Math.min(1, Number(smoothing) || 0));
  }
}
