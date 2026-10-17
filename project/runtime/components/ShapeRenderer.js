/**
 * runtime/components/ShapeRenderer.js
 *
 * Draws a filled (and optionally outlined) vector primitive at the
 * entity's Transform — Square, Circle, Triangle, or Capsule. Purely
 * visual: unlike Collider2D, nothing here participates in physics.
 * An entity can carry both a ShapeRenderer and a Collider2D at once
 * (e.g. a colored placeholder box with real collision), but they are
 * never linked automatically — sizing one does not resize the other.
 *
 * Same shape-type list as Collider2D's ColliderShape (Box/Circle/
 * Capsule/Triangle), renamed SQUARE here since that is the more
 * familiar term for a plain filled rectangle used as a visual
 * placeholder rather than a physics box.
 *
 * Drawn by runtime/systems/RenderSystem.js as a PIXI.Graphics per
 * entity, one full redraw whenever a shape-affecting field changes
 * (see RenderSystem's _shapeSignature) — cheap for save-game-sized
 * scene counts and avoids rebuilding geometry every frame for a shape
 * that never changes.
 *
 * RUNTIME-ONLY FILE.
 */

export const SHAPE_RENDERER = "ShapeRenderer";

export const ShapeType = Object.freeze({
  SQUARE: "Square",
  CIRCLE: "Circle",
  TRIANGLE: "Triangle",
  CAPSULE: "Capsule",
});

export class ShapeRenderer {
  constructor({
    shapeType = ShapeType.SQUARE,
    // Square
    width = 100,
    height = 100,
    // Circle
    radius = 50,
    // Capsule: a "stadium" shape (rectangle with semicircle caps),
    // same halfHeight/radius convention as Collider2D's capsule so the
    // two stay easy to eyeball-match if a user wants a visual capsule
    // over a capsule collider. Principal axis is Y (vertical pill).
    capsuleHalfHeight = 50,
    capsuleRadius = 30,
    // Triangle: 3 points in the entity's LOCAL space (same space
    // Collider2D.trianglePoints uses), user-editable via draggable
    // gizmo handles in the Scene view. Sensible default right-triangle
    // rather than 3 coincident points.
    trianglePoints = [
      { x: -50, y: 50 },
      { x: 50, y: 50 },
      { x: 0, y: -50 },
    ],
    fillColor = "#3a8ede",
    opacity = 1,
    outlineEnabled = false,
    outlineColor = "#ffffff",
    outlineWidth = 2,
  } = {}) {
    this.shapeType = shapeType;
    this.width = width;
    this.height = height;
    this.radius = radius;
    this.capsuleHalfHeight = capsuleHalfHeight;
    this.capsuleRadius = capsuleRadius;
    // Deep-copy so distinct ShapeRenderer instances never share point
    // objects by accident (e.g. via spread/default-arg reuse) — same
    // reasoning as Collider2D.trianglePoints.
    this.trianglePoints = trianglePoints.map((p) => ({ x: p.x, y: p.y }));
    this.fillColor = fillColor;
    this.opacity = opacity;
    this.outlineEnabled = outlineEnabled;
    this.outlineColor = outlineColor;
    this.outlineWidth = outlineWidth;
  }
}
