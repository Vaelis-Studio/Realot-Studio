/**
 * runtime/systems/RenderSystem.js
 *
 * Owns a PIXI.Container ("world" / "stage root") and keeps one PIXI
 * DisplayObject per entity with a SpriteRenderer OR TextRenderer in sync
 * with that entity's Transform + component data. This is the ONLY system
 * that touches PIXI — everything else stays renderer-agnostic.
 *
 * Draw order: Transform.z is the single source of truth for stacking —
 * higher z draws on top of lower z (SpriteRenderer has no separate
 * layer-order field; see SpriteRenderer.js). Ties are broken by a
 * stable entity-id sort so draw order never flickers frame-to-frame for
 * objects that share the same z.
 *
 * Fake-3D depth (Camera.enablePseudo3D, a scene-wide toggle): when the
 * Main Camera has this on, Transform.z ALSO scales an object's rendered
 * size — positive z (closer to camera) enlarges it, negative z (farther
 * from camera) shrinks it, on top of z still controlling draw order.
 * When off, z affects draw order only and never touches visual size,
 * exactly matching the checked/unchecked behavior requested.
 *
 * Used by both the standalone player (runtime/index.js) and the editor's
 * Scene/Game viewport, so visuals never drift between edit mode and play
 * mode.
 *
 * RUNTIME-ONLY FILE (depends on PIXI, not on the editor).
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { SPRITE_RENDERER } from "../components/SpriteRenderer.js";
import { SHAPE_RENDERER, ShapeType } from "../components/ShapeRenderer.js";
import { STROKE_PATH, StrokePathTextureMode } from "../components/StrokePath.js";
import { buildStrokePathMesh } from "../components/StrokePathGeometry.js";
import { TEXT_RENDERER } from "../components/TextRenderer.js";
import { SPEECH_BUBBLE } from "../components/SpeechBubble.js";
import { CHAT_LOG } from "../components/ChatLog.js";
import { TEXT_INPUT } from "../components/TextInput.js";
import { JOYSTICK, JoystickPositionMode } from "../components/Joystick.js";
import { CAMERA } from "../components/Camera.js";
import { JOINT_2D, JointType2D } from "../components/Joint2D.js";
import { resolveTexture } from "../assets/AssetManager.js";
import { getCameraResolution, computeScreenFit } from "../core/CameraUtils.js";
import { JointVisualSmoothing } from "./JointVisualSmoothing.js";

// Shared with the SpeechBubble Graphics drawing below — same conversion
// RenderSystem.applyBackgroundColor already uses for Camera.backgroundColor.
function _hexToNumber(hexColorString) {
  return PIXI.utils ? PIXI.utils.string2hex(hexColorString) : parseInt(String(hexColorString).replace("#", "0x")) || 0x000000;
}

// Reference "camera distance" used by the pseudo-3D depth-scale formula
// below: visualScale = DEPTH_REFERENCE / (DEPTH_REFERENCE - z). At
// z = 0 (the default for every new object) this is exactly 1 — neutral,
// no visual change — so turning enablePseudo3D on never resizes objects
// that haven't been moved in Z yet. Bigger DEPTH_REFERENCE = more
// gradual/subtle size falloff per unit of Z; smaller = more dramatic.
const DEPTH_REFERENCE = 500;
const MIN_DEPTH_SCALE = 0.02; // guards against z >= DEPTH_REFERENCE going negative/infinite

function objVertexCount(obj) {
  return obj ? obj.geometry.getBuffer("aVertexPosition").data.length / 2 : -1;
}

export class RenderSystem extends System {
  /**
   * @param {PIXI.Container} worldContainer container to draw entities into
   * @param {object} [opts]
   * @param {boolean} [opts.followMainCamera] when true, worldContainer is
   *   translated every frame so the scene's Main Camera world position is
   *   centered on screen — i.e. real "game screen" rendering, matching
   *   the exact frame CameraGizmo.js draws in the editor (both use
   *   CameraUtils.js as the single source of truth). The editor's Scene
   *   viewport passes false: its own free-roam ViewportCamera already
   *   drives worldContainer's pan/zoom, and applying both would fight
   *   each other. Play mode (the popup) and the standalone player pass
   *   true — there, nothing else accounts for where the camera entity
   *   sits in world space, so without this, sprites render at raw
   *   world-space coordinates and anything off-origin renders off the
   *   visible canvas (the "black screen" bug).
   */
  constructor(worldContainer, opts = {}) {
    super();
    this.worldContainer = worldContainer;
    this.followMainCamera = !!opts.followMainCamera;
    /** @type {Map<string, PIXI.Sprite>} entityId -> sprite */
    this._sprites = new Map();
    // Screen-space layer for TextRenderer entities with screenSpace:true
    // — see TextRenderer.js's file header and runtime/index.js's
    // uiContainer comment for why this has to be a SEPARATE container
    // from worldContainer rather than just another child of it. Falls
    // back to worldContainer itself if a caller doesn't pass one, so a
    // screen-space text still renders (just no longer camera-independent)
    // instead of throwing, in case some future host forgets to wire it.
    this.uiContainer = opts.uiContainer || worldContainer;
    // Letterbox/pillarbox bars — see Camera.js's scalingMode settings
    // and computeScreenFit() in CameraUtils.js. Nullable defensively,
    // same as every other opts.* here — bars just won't be painted if
    // a caller doesn't provide one, rather than throwing.
    this.barsContainer = opts.barsContainer || null;
    // Needed to read the actual device/canvas size (pixiApp.screen) for
    // computeScreenFit() — see _applyMainCameraOffset below.
    this.pixiApp = opts.pixiApp || null;
    /** @type {Map<string, PIXI.Graphics>} entityId -> vector shape */
    this._shapes = new Map();
    /** @type {Map<string, PIXI.Container>} entityId -> StrokePath display object (a Graphics in color mode, a SimpleMesh in texture mode — see the StrokePath drawing block below for why the object TYPE itself is swapped rather than reused) */
    this._strokePaths = new Map();
    /** @type {Map<string, boolean>} entityId -> whether _strokePaths' current display object was built for texture mode, so a color<->texture switch is detected and rebuilt (a Graphics can't become a SimpleMesh in place, or vice versa) rather than silently doing nothing */
    this._strokePathModes = new Map();
    /** @type {Map<string, PIXI.Container>} entityId -> live Rope/Spring joint visual (a Graphics in color mode, a SimpleMesh in texture mode — same swap-the-object-type approach as _strokePaths, see the Joint2D drawing block below) */
    this._jointVisuals = new Map();
    /** @type {Map<string, boolean>} entityId -> whether _jointVisuals' current display object was built for texture mode, so a color<->texture switch is detected and rebuilt rather than silently doing nothing */
    this._jointVisualModes = new Map();
    // PhysicsWorld owns the real rope simulation. This helper owns only the
    // renderer-side stabilization/curve sampling so solver jitter cannot
    // become visible rope shimmer without ever changing physics state.
    this._jointVisualSmoother = new JointVisualSmoothing();
    /** @type {import('../physics/PhysicsWorld.js').PhysicsWorld|null} */
    this.physicsWorld = opts.physicsWorld || null;
    /** @type {Map<string, PIXI.Text>} entityId -> text */
    this._texts = new Map();
    /** @type {Map<string, {container: PIXI.Container, bg: PIXI.Graphics, label: PIXI.Text}>} entityId -> speech bubble parts */
    this._bubbles = new Map();
    /** @type {Map<string, {container: PIXI.Container, bg: PIXI.Graphics, mask: PIXI.Graphics, rows: Array<{name: PIXI.Text, msg: PIXI.Text}>}>} entityId -> chat log parts */
    this._chats = new Map();
    /** @type {Map<string, {container: PIXI.Container, bg: PIXI.Graphics, label: PIXI.Text, cursor: PIXI.Graphics}>} entityId -> text input visual parts */
    this._textInputs = new Map();
    /** @type {Map<string, {container: PIXI.Container, base: PIXI.Graphics, knob: PIXI.Graphics}>} entityId -> joystick visual parts */
    this._joysticks = new Map();
  }

  update(world, dt) {
    if (this.followMainCamera) this._applyMainCameraOffset(world);

    const pseudo3D = this._isPseudo3DEnabled(world);

    const entities = world.query(TRANSFORM, SPRITE_RENDERER);
    const seen = new Set();

    for (const entity of entities) {
      seen.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const spriteRenderer = entity.getComponent(SPRITE_RENDERER);

      let sprite = this._sprites.get(entity.id);
      if (!sprite) {
        sprite = new PIXI.Sprite(resolveTexture(spriteRenderer.spriteKey));
        sprite.anchor.set(0.5);
        this.worldContainer.addChild(sprite);
        this._sprites.set(entity.id, sprite);
      }

      sprite.texture = resolveTexture(spriteRenderer.spriteKey);
      sprite.x = transform.x;
      sprite.y = transform.y;
      sprite.rotation = (transform.rotation * Math.PI) / 180;

      // Depth-scale: only applied when the scene's fake-3D toggle is on
      // (see Camera.enablePseudo3D doc comment). At transform.z === 0
      // depthScale is exactly 1, so objects that have never been moved
      // in Z are visually unaffected by turning the toggle on.
      const depthScale = pseudo3D ? this._depthScaleFor(transform.z) : 1;

      // Animation-frame size compensation: Transform.scaleX/Y is the
      // user's INTENDED overall size (what SceneViewport's drag-drop
      // fitSpriteScale() computed against ONE reference image, and what
      // the Inspector shows/edits). Without correction, PIXI multiplies
      // that scale directly against whichever texture is currently
      // assigned — so if a SpriteAnimation clip swaps in a frame whose
      // raw pixel size differs from the image the entity was originally
      // scaled against, the sprite visibly shrinks or grows even though
      // the user never touched Transform.scale (see SpriteRenderer.js's
      // referenceWidth/Height doc comment for the full explanation).
      // frameScaleX/Y cancels that out: if this frame is smaller than
      // the reference, frameScale > 1 to compensate, and vice versa — so
      // the entity's on-screen size stays visually constant across every
      // frame of an animation, exactly like Unity's Pixels Per Unit.
      const tex = sprite.texture;
      const refW = spriteRenderer.referenceWidth || (tex && tex.width) || 1;
      const refH = spriteRenderer.referenceHeight || (tex && tex.height) || 1;
      const frameScaleX = tex && tex.width ? refW / tex.width : 1;
      const frameScaleY = tex && tex.height ? refH / tex.height : 1;

      sprite.scale.set(
        transform.scaleX * frameScaleX * depthScale * (spriteRenderer.flipX ? -1 : 1),
        transform.scaleY * frameScaleY * depthScale * (spriteRenderer.flipY ? -1 : 1)
      );
      sprite.tint = PIXI.utils ? PIXI.utils.string2hex(spriteRenderer.color) : 0xffffff;
      sprite.alpha = (spriteRenderer.opacity != null) ? Math.max(0, Math.min(1, spriteRenderer.opacity)) : 1;

      // Draw order: Transform.z is the sole source of truth (see file
      // header). Pixi's zIndex sort applies a stable sort in modern
      // versions, but a tiny id-derived fractional nudge is added here
      // so tie-breaking is deterministic and documented rather than
      // relying on an internal engine guarantee that could change.
      sprite.zIndex = transform.z + this._tieBreak(entity.id);
    }

    // remove sprites for entities that no longer exist / lost the component
    for (const [entityId, sprite] of this._sprites) {
      if (!seen.has(entityId)) {
        this.worldContainer.removeChild(sprite);
        sprite.destroy();
        this._sprites.delete(entityId);
      }
    }

    // ── ShapeRenderer entities ──────────────────────────────────────
    // Filled vector primitives (Square/Circle/Triangle/Capsule) — purely
    // visual, no physics involvement (see ShapeRenderer.js's file
    // header). Redrawn fully every frame while present: like
    // SpeechBubble below, a shape's geometry is cheap to redraw and
    // this avoids a separate dirty-field diff for a component that
    // isn't expected to change every frame in the common case anyway.
    const shapeEntities = world.query(TRANSFORM, SHAPE_RENDERER);
    const shapeSeen = new Set();

    for (const entity of shapeEntities) {
      shapeSeen.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const shapeRenderer = entity.getComponent(SHAPE_RENDERER);

      let gfx = this._shapes.get(entity.id);
      if (!gfx) {
        gfx = new PIXI.Graphics();
        this.worldContainer.addChild(gfx);
        this._shapes.set(entity.id, gfx);
      }

      const fillColorNum = _hexToNumber(shapeRenderer.fillColor);
      const opacity = shapeRenderer.opacity != null ? Math.max(0, Math.min(1, shapeRenderer.opacity)) : 1;
      const outlineWidth = shapeRenderer.outlineEnabled ? Math.max(0, shapeRenderer.outlineWidth) : 0;
      const outlineColorNum = _hexToNumber(shapeRenderer.outlineColor);

      gfx.clear();
      gfx.lineStyle(outlineWidth, outlineColorNum, outlineWidth > 0 ? 1 : 0);
      gfx.beginFill(fillColorNum, 1);

      if (shapeRenderer.shapeType === ShapeType.CIRCLE) {
        gfx.drawCircle(0, 0, Math.max(0, shapeRenderer.radius));
      } else if (shapeRenderer.shapeType === ShapeType.CAPSULE) {
        // Stadium shape: a rect body plus two semicircle caps, same
        // halfHeight/radius convention as Collider2D's capsule — drawn
        // as one continuous polygon-ish combo so the outline traces the
        // capsule's silhouette rather than three overlapping strokes.
        const hh = Math.max(0, shapeRenderer.capsuleHalfHeight);
        const r = Math.max(0, shapeRenderer.capsuleRadius);
        gfx.drawRoundedRect(-r, -hh - r, r * 2, (hh + r) * 2, r);
      } else if (shapeRenderer.shapeType === ShapeType.TRIANGLE) {
        const pts = shapeRenderer.trianglePoints || [];
        if (pts.length === 3) {
          gfx.drawPolygon([pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y]);
        }
      } else {
        // Square (default)
        const w = Math.max(0, shapeRenderer.width);
        const h = Math.max(0, shapeRenderer.height);
        gfx.drawRect(-w / 2, -h / 2, w, h);
      }

      gfx.endFill();
      gfx.alpha = opacity;

      gfx.x = transform.x;
      gfx.y = transform.y;
      gfx.rotation = (transform.rotation * Math.PI) / 180;
      gfx.scale.set(transform.scaleX, transform.scaleY);

      // Same draw-order convention as sprites (see file header).
      gfx.zIndex = transform.z + this._tieBreak(entity.id);
    }

    for (const [entityId, gfx] of this._shapes) {
      if (!shapeSeen.has(entityId)) {
        this.worldContainer.removeChild(gfx);
        gfx.destroy();
        this._shapes.delete(entityId);
      }
    }

    // ── StrokePath entities ─────────────────────────────────────────
    // Stroke paths share ONE canonical triangle tessellation between the
    // editor and runtime. Color mode draws those triangles with Graphics;
    // texture mode uses the same vertices/UVs in a SimpleMesh. No single
    // concave polygon is ever handed to PIXI, so turns/caps cannot cause
    // accidental long-distance connections.
    const strokePathEntities = world.query(TRANSFORM, STROKE_PATH);
    const strokePathSeen = new Set();

    for (const entity of strokePathEntities) {
      strokePathSeen.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const strokePath = entity.getComponent(STROKE_PATH);
      const wantTexture = !!strokePath.useTexture;

      const previousMode = this._strokePathModes.get(entity.id);
      let obj = this._strokePaths.get(entity.id);
      if (obj && previousMode !== undefined && previousMode !== wantTexture) {
        this.worldContainer.removeChild(obj);
        obj.destroy(true);
        obj = null;
        this._strokePaths.delete(entity.id);
      }

      const mesh = buildStrokePathMesh(
        strokePath.points,
        strokePath.thickness,
        strokePath.jointMode,
        strokePath.capMode,
        wantTexture ? strokePath.textureMode : StrokePathTextureMode.STRETCH,
        wantTexture ? strokePath.textureTiling : 1,
        wantTexture ? strokePath.textureScale : 1,
        wantTexture ? strokePath.textureOffset : 0,
        wantTexture ? strokePath.textureFlip : false,
        wantTexture ? strokePath.textureRotation : 0,
        strokePath.smoothing
      );

      if (wantTexture) {
        let texture = resolveTexture(strokePath.textureKey);
        // Defensive guard against the actual freeze: clearTextureAsset()
        // (fired by the editor when a sprite asset is deleted) removes the
        // key from AssetManager's cache AND calls texture.destroy(true) on
        // the PIXI.Texture/BaseTexture. resolveTexture() re-checking its
        // cache each tick normally means a deleted key just falls through
        // to the missing-texture placeholder on the NEXT tick — but the
        // delete can happen from editor UI code between this System's own
        // ticks, i.e. after this tick already read a texture reference but
        // before PIXI's own render pass consumes it, or a texture can be
        // destroyed while still cached under a stale identity in some
        // future refactor. Either way, a destroyed BaseTexture has null
        // internal GL resources: PIXI.SimpleMesh's `.texture` setter and
        // internal geometry/UV recompute both read `texture.baseTexture`
        // properties that throw once destroyed, and that throw happens
        // with no surrounding try/catch anywhere up the call chain to
        // GameLoop's rAF tick — an uncaught exception there stops
        // requestAnimationFrame from ever being rescheduled, which is the
        // full engine freeze. Checking `.valid`/`.destroyed` here and
        // falling back to the missing-texture marker (itself always a
        // freshly generated, never-user-deletable texture) makes EVERY
        // situation — deleted mid-frame, deleted between ticks, or any
        // other path that could hand this a dead texture — degrade to a
        // visible magenta placeholder instead of a frozen game.
        if (!texture || texture.destroyed || (texture.baseTexture && texture.baseTexture.destroyed)) {
          texture = resolveTexture(null); // missing-texture marker
        }
        const meshVertexCount = mesh ? mesh.vertices.length / 2 : 0;

        if (obj && objVertexCount(obj) !== meshVertexCount) {
          this.worldContainer.removeChild(obj);
          obj.destroy(true);
          obj = null;
          this._strokePaths.delete(entity.id);
        }

        if (!obj) {
          const placeholder = mesh || {
            vertices: new Float32Array([0, 0, 0, 0, 0, 0]),
            uvs: new Float32Array([0, 0, 0, 0, 0, 0]),
            indices: new Uint16Array([0, 1, 2]),
          };
          obj = new PIXI.SimpleMesh(texture, placeholder.vertices, placeholder.uvs, placeholder.indices);
          this.worldContainer.addChild(obj);
          this._strokePaths.set(entity.id, obj);
        } else {
          // Guard the assignment itself too: even with the check above,
          // wrap the actual PIXI call in try/catch as a last line of
          // defense — some PIXI versions/paths can still throw on edge
          // cases (a texture destroyed mid-upload, a GL context loss,
          // etc.) that a simple .destroyed flag check doesn't catch. This
          // is what makes the fix "check for all situations" rather than
          // just the one reproduction case: whatever the reason a texture
          // assignment fails, the StrokePath falls back to the missing
          // marker and the frame keeps rendering instead of throwing.
          try {
            obj.texture = texture;
          } catch (err) {
            try {
              obj.texture = resolveTexture(null);
            } catch (err2) {
              // Truly unrecoverable for this object — drop it and let the
              // next tick rebuild it from scratch via the !obj branch
              // above, rather than let the exception escape into
              // GameLoop's rAF tick.
              this.worldContainer.removeChild(obj);
              try { obj.destroy(true); } catch (err3) { /* already gone */ }
              this._strokePaths.delete(entity.id);
              this._strokePathModes.delete(entity.id);
              continue;
            }
          }
          if (mesh) {
            obj.vertices = mesh.vertices;
            obj.geometry.getBuffer("aTextureCoord").update(mesh.uvs);
            obj.geometry.getIndex().update(mesh.indices);
          }
        }

        if (texture && texture.baseTexture && !texture.baseTexture.destroyed) {
          texture.baseTexture.wrapMode = strokePath.textureMode === StrokePathTextureMode.TILE
            ? PIXI.WRAP_MODES.REPEAT
            : PIXI.WRAP_MODES.CLAMP;
        }
        obj.alpha = strokePath.opacity != null ? Math.max(0, Math.min(1, strokePath.opacity)) : 1;
      } else {
        if (!obj) {
          obj = new PIXI.Graphics();
          this.worldContainer.addChild(obj);
          this._strokePaths.set(entity.id, obj);
        }

        obj.clear();
        obj.alpha = strokePath.opacity != null ? Math.max(0, Math.min(1, strokePath.opacity)) : 1;
        if (mesh) {
          const color = _hexToNumber(strokePath.color);
          obj.lineStyle(0);
          obj.beginFill(color, 1);
          for (let i = 0; i < mesh.indices.length; i += 3) {
            const ia = mesh.indices[i] * 2;
            const ib = mesh.indices[i + 1] * 2;
            const ic = mesh.indices[i + 2] * 2;
            obj.drawPolygon([
              mesh.vertices[ia], mesh.vertices[ia + 1],
              mesh.vertices[ib], mesh.vertices[ib + 1],
              mesh.vertices[ic], mesh.vertices[ic + 1],
            ]);
          }
          obj.endFill();
        }
      }

      this._strokePathModes.set(entity.id, wantTexture);
      obj.x = transform.x;
      obj.y = transform.y;
      obj.rotation = (transform.rotation * Math.PI) / 180;
      obj.scale.set(transform.scaleX, transform.scaleY);
      obj.zIndex = transform.z + this._tieBreak(entity.id);
    }

    for (const [entityId, obj] of this._strokePaths) {
      if (!strokePathSeen.has(entityId)) {
        this.worldContainer.removeChild(obj);
        obj.destroy(true);
        this._strokePaths.delete(entityId);
        this._strokePathModes.delete(entityId);
      }
    }

    // ── Joint2D Rope/Spring visuals ─────────────────────────────────
    // The visual is rendered from the exact live Rapier link positions
    // (see PhysicsWorld.getJointVisualPoints/_buildFlexibleJoint) — a real
    // simulated bend/sag, not an invented curve. Color mode draws the path
    // with Graphics, same as before; texture mode builds a ribbon mesh
    // along that same live path with buildStrokePathMesh (the identical
    // tessellator StrokePath uses), so a rope/chain/string image can run
    // along the cord and either stretch to fit or tile without stretching.
    //
    // getJointVisualPoints returns WORLD-space points (the rope's two ends
    // can be on two different moving bodies, so there is no single local
    // space to put them in) — unlike StrokePath's points, these are handed
    // to buildStrokePathMesh already in world space and the mesh is added
    // directly to worldContainer with no per-entity transform applied.
    const jointVisualSeen = new Set();
    const jointEntities = world.query(JOINT_2D, TRANSFORM);
    for (const entity of jointEntities) {
      const joint = entity.getComponent(JOINT_2D);
      if (!joint.visualEnabled ||
          (joint.jointType !== JointType2D.ROPE && joint.jointType !== JointType2D.SPRING)) {
        continue;
      }

      const points = this.physicsWorld?.getJointVisualPoints?.(entity.id);
      if (!points || points.length < 2) continue;

      // Keep the real Rapier positions for physics/controller logic, but do
      // not draw those raw solver samples directly. Stiff rope/string chains
      // can have tiny per-link position noise even when their overall motion
      // is smooth; filtering only this visual copy removes the visible buzz
      // while the endpoints remain exactly pinned to their live anchors.
      const visualPoints = this._jointVisualSmoother.smoothAndSample(entity.id, points, dt);
      if (visualPoints.length < 2) continue;

      const wantTexture = !!joint.useTexture;
      const previousMode = this._jointVisualModes.get(entity.id);
      let obj = this._jointVisuals.get(entity.id);
      if (obj && previousMode !== undefined && previousMode !== wantTexture) {
        this.worldContainer.removeChild(obj);
        obj.destroy(true);
        obj = null;
        this._jointVisuals.delete(entity.id);
      }

      jointVisualSeen.add(entity.id);
      const width = Math.max(0.5, Number(joint.visualThickness) || 3);

      if (wantTexture) {
        const mesh = buildStrokePathMesh(
          visualPoints,
          width,
          "sharp",
          "none",
          joint.textureMode === "tile" ? StrokePathTextureMode.TILE : StrokePathTextureMode.STRETCH,
          joint.textureTiling,
          joint.textureScale,
          joint.textureOffset,
          joint.textureFlip,
          0,
          0
        );

        let texture = resolveTexture(joint.textureKey);
        // Same defensive guard as StrokePath's texture path: a destroyed
        // BaseTexture (e.g. its sprite asset was just deleted in the
        // editor) must never reach PIXI.SimpleMesh's texture setter — see
        // the long comment on the equivalent StrokePath branch above for
        // why this degrades to a visible placeholder instead of freezing
        // the whole engine loop.
        if (!texture || texture.destroyed || (texture.baseTexture && texture.baseTexture.destroyed)) {
          texture = resolveTexture(null);
        }
        const meshVertexCount = mesh ? mesh.vertices.length / 2 : 0;

        if (obj && objVertexCount(obj) !== meshVertexCount) {
          this.worldContainer.removeChild(obj);
          obj.destroy(true);
          obj = null;
          this._jointVisuals.delete(entity.id);
        }

        if (!obj) {
          const placeholder = mesh || {
            vertices: new Float32Array([0, 0, 0, 0, 0, 0]),
            uvs: new Float32Array([0, 0, 0, 0, 0, 0]),
            indices: new Uint16Array([0, 1, 2]),
          };
          obj = new PIXI.SimpleMesh(texture, placeholder.vertices, placeholder.uvs, placeholder.indices);
          this.worldContainer.addChild(obj);
          this._jointVisuals.set(entity.id, obj);
        } else {
          try {
            obj.texture = texture;
          } catch (err) {
            try {
              obj.texture = resolveTexture(null);
            } catch (err2) {
              this.worldContainer.removeChild(obj);
              try { obj.destroy(true); } catch (err3) { /* already gone */ }
              this._jointVisuals.delete(entity.id);
              this._jointVisualModes.delete(entity.id);
              continue;
            }
          }
          if (mesh) {
            obj.vertices = mesh.vertices;
            obj.geometry.getBuffer("aTextureCoord").update(mesh.uvs);
            obj.geometry.getIndex().update(mesh.indices);
          }
        }

        if (texture && texture.baseTexture && !texture.baseTexture.destroyed) {
          texture.baseTexture.wrapMode = joint.textureMode === "tile"
            ? PIXI.WRAP_MODES.REPEAT
            : PIXI.WRAP_MODES.CLAMP;
        }
      } else {
        if (!obj) {
          obj = new PIXI.Graphics();
          this.worldContainer.addChild(obj);
          this._jointVisuals.set(entity.id, obj);
        }

        const color = _hexToNumber(joint.visualColor || "#c8a66a");
        obj.clear();
        obj.lineStyle(width, color, 1);

        // Draw the stabilized, densely sampled centerline. The source
        // controls are still the real simulated rope links; smoothing is
        // renderer-only and the first/last samples remain exact live anchors.
        obj.moveTo(visualPoints[0].x, visualPoints[0].y);
        for (let i = 1; i < visualPoints.length; i++) {
          obj.lineTo(visualPoints[i].x, visualPoints[i].y);
        }
      }

      obj.alpha = 1;
      this._jointVisualModes.set(entity.id, wantTexture);
      obj.zIndex = entity.getComponent(TRANSFORM).z + this._tieBreak(entity.id) - 0.001;
    }

    for (const [entityId, obj] of this._jointVisuals) {
      if (!jointVisualSeen.has(entityId)) {
        if (obj.parent) obj.parent.removeChild(obj);
        obj.destroy(true);
        this._jointVisuals.delete(entityId);
        this._jointVisualModes.delete(entityId);
      }
    }
    this._jointVisualSmoother.forgetMissing(jointVisualSeen);

    // ── TextRenderer entities ───────────────────────────────────────
    // See TextRenderer.js's file header and TextRenderer screenSpace docs.

    // Kept as its own pass (not merged into the sprite loop above) since
    // it queries a different component and can target either container.
    const textEntities = world.query(TRANSFORM, TEXT_RENDERER);
    const textSeen = new Set();

    for (const entity of textEntities) {
      textSeen.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const textRenderer = entity.getComponent(TEXT_RENDERER);

      let text = this._texts.get(entity.id);
      if (!text) {
        text = new PIXI.Text(textRenderer.value, new PIXI.TextStyle());
        this._texts.set(entity.id, text);
      }

      // Re-parent into whichever container this frame's screenSpace flag
      // calls for. Cheap to check every frame (addChild is a no-op-ish
      // reparent if already a child of that container) and means a
      // script flipping this.text.screenSpace at runtime just works,
      // without any extra bookkeeping here.
      const targetContainer = textRenderer.screenSpace ? this.uiContainer : this.worldContainer;
      if (text.parent !== targetContainer) targetContainer.addChild(text);

      // Only touch fields that actually changed — mutating a PIXI.Text's
      // .text or .style dirties it and forces a texture re-render (an
      // actual canvas draw + texture upload), unlike a sprite's cheap
      // per-frame tint/alpha/transform writes. Setting the SAME string
      // every frame is harmless (PIXI already no-ops that internally),
      // but the style fields are re-built as a whole object below only
      // when something in them actually differs, to keep an idle UI
      // label (score display sitting unchanged most frames) cheap.
      if (text.text !== textRenderer.value) text.text = textRenderer.value;

      const wantWrapWidth = textRenderer.wordWrap ? textRenderer.wrapWidth : 0;
      const s = text.style;
      if (
        s.fontSize !== textRenderer.fontSize ||
        s.fill !== textRenderer.color ||
        s.fontFamily !== textRenderer.fontFamily ||
        s.fontWeight !== (textRenderer.bold ? "bold" : "normal") ||
        s.fontStyle !== (textRenderer.italic ? "italic" : "normal") ||
        s.align !== textRenderer.align ||
        s.wordWrap !== !!textRenderer.wordWrap ||
        s.wordWrapWidth !== wantWrapWidth
      ) {
        text.style = new PIXI.TextStyle({
          fontSize: textRenderer.fontSize,
          fill: textRenderer.color,
          fontFamily: textRenderer.fontFamily,
          fontWeight: textRenderer.bold ? "bold" : "normal",
          fontStyle: textRenderer.italic ? "italic" : "normal",
          align: textRenderer.align,
          wordWrap: !!textRenderer.wordWrap,
          wordWrapWidth: wantWrapWidth,
        });
      }

      text.anchor.set(
        textRenderer.anchorX != null ? textRenderer.anchorX : 0.5,
        textRenderer.anchorY != null ? textRenderer.anchorY : 0.5
      );
      text.x = transform.x;
      text.y = transform.y;
      text.rotation = (transform.rotation * Math.PI) / 180;
      text.scale.set(transform.scaleX, transform.scaleY);
      text.alpha = (textRenderer.opacity != null) ? Math.max(0, Math.min(1, textRenderer.opacity)) : 1;

      // Same draw-order convention as sprites (see file header) — applies
      // within whichever container this text actually landed in, so a
      // screen-space label's z still controls its stacking against
      // OTHER screen-space labels the same way sprite z does in-world.
      text.zIndex = transform.z + this._tieBreak(entity.id);
    }

    for (const [entityId, text] of this._texts) {
      if (!textSeen.has(entityId)) {
        if (text.parent) text.parent.removeChild(text);
        text.destroy();
        this._texts.delete(entityId);
      }
    }

    // ── SpeechBubble entities ───────────────────────────────────────
    // Always world-space (see SpeechBubble.js's file header) — a bubble
    // is inherently "attached to this character," so it always goes in
    // worldContainer and pans/zooms with the camera like a sprite,
    // unlike TextRenderer which can opt into screen-space.
    const bubbleEntities = world.query(TRANSFORM, SPEECH_BUBBLE);
    const bubbleSeen = new Set();

    for (const entity of bubbleEntities) {
      bubbleSeen.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const speechBubble = entity.getComponent(SPEECH_BUBBLE);

      let parts = this._bubbles.get(entity.id);
      if (!parts) {
        const container = new PIXI.Container();
        const bg = new PIXI.Graphics();
        const label = new PIXI.Text("", new PIXI.TextStyle());
        label.anchor.set(0.5, 0.5);
        container.addChild(bg, label);
        parts = { container, bg, label };
        this._bubbles.set(entity.id, parts);
      }
      if (parts.container.parent !== this.worldContainer) this.worldContainer.addChild(parts.container);

      parts.container.visible = !!speechBubble.visible;
      if (!speechBubble.visible) continue; // nothing else to compute while hidden

      // Re-measure/redraw every frame only while actually visible — a
      // shown bubble is a comparatively rare, deliberate UI moment (not
      // a per-frame-changing value like a sprite's tint), so this is
      // far cheaper in practice than it looks, and it keeps this loop
      // simple (no separate dirty-field diffing like the Text loop
      // above needs for its comparatively hot, always-on TextStyle).
      parts.label.text = speechBubble.text;
      parts.label.style = new PIXI.TextStyle({
        fontSize: speechBubble.fontSize,
        fill: speechBubble.textColor,
        fontFamily: speechBubble.fontFamily,
        align: "center",
        wordWrap: true,
        wordWrapWidth: Math.max(1, speechBubble.maxWidth),
      });

      const w = parts.label.width + speechBubble.padding * 2;
      const h = parts.label.height + speechBubble.padding * 2;
      const r = Math.min(speechBubble.cornerRadius, w / 2, h / 2);

      parts.bg.clear();
      parts.bg.lineStyle(speechBubble.borderWidth, _hexToNumber(speechBubble.borderColor), speechBubble.borderWidth > 0 ? 1 : 0);
      parts.bg.beginFill(_hexToNumber(speechBubble.backgroundColor), 1);
      parts.bg.drawRoundedRect(-w / 2, -h / 2, w, h, r);
      parts.bg.endFill();

      if (speechBubble.tailDirection !== "none") {
        const ts = speechBubble.tailSize;
        parts.bg.beginFill(_hexToNumber(speechBubble.backgroundColor), 1);
        if (speechBubble.tailDirection === "down") {
          parts.bg.drawPolygon([-ts / 2, h / 2, ts / 2, h / 2, 0, h / 2 + ts]);
        } else if (speechBubble.tailDirection === "up") {
          parts.bg.drawPolygon([-ts / 2, -h / 2, ts / 2, -h / 2, 0, -h / 2 - ts]);
        } else if (speechBubble.tailDirection === "left") {
          parts.bg.drawPolygon([-w / 2, -ts / 2, -w / 2, ts / 2, -w / 2 - ts, 0]);
        } else if (speechBubble.tailDirection === "right") {
          parts.bg.drawPolygon([w / 2, -ts / 2, w / 2, ts / 2, w / 2 + ts, 0]);
        }
        parts.bg.endFill();
      }

      parts.container.x = transform.x + speechBubble.offsetX;
      parts.container.y = transform.y + speechBubble.offsetY;
      parts.container.zIndex = transform.z + this._tieBreak(entity.id) + 1; // +1: always drawn just above this entity's own sprite/z
    }

    for (const [entityId, parts] of this._bubbles) {
      if (!bubbleSeen.has(entityId)) {
        if (parts.container.parent) parts.container.parent.removeChild(parts.container);
        parts.container.destroy({ children: true });
        this._bubbles.delete(entityId);
      }
    }

    // ── ChatLog entities ─────────────────────────────────────────────
    // Same screenSpace routing as TextRenderer (see its file header) —
    // a chat panel is usually a fixed HUD element, but can opt into
    // world-space for e.g. a log floating above a player in multiplayer.
    // Anchored top-left at Transform.x/y (no offsetX/Y like SpeechBubble
    // — width/height instead come from `width`/lineHeight*visibleCount).
    const chatEntities = world.query(TRANSFORM, CHAT_LOG);
    const chatSeen = new Set();

    for (const entity of chatEntities) {
      chatSeen.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const chatLog = entity.getComponent(CHAT_LOG);

      let parts = this._chats.get(entity.id);
      if (!parts) {
        const container = new PIXI.Container();
        const bg = new PIXI.Graphics();
        const mask = new PIXI.Graphics();
        container.addChild(bg, mask);
        parts = { container, bg, mask, rows: [] };
        this._chats.set(entity.id, parts);
      }
      if (parts.container.parent !== (chatLog.screenSpace ? this.uiContainer : this.worldContainer)) {
        (chatLog.screenSpace ? this.uiContainer : this.worldContainer).addChild(parts.container);
      }

      parts.container.visible = !!chatLog.visible;
      if (!chatLog.visible) continue;

      // Grow/shrink the row pool to match visibleCount — same reused-
      // pool approach as the Touch Test overlay's finger dots, so
      // changing visibleCount at runtime doesn't leak or thrash Text
      // objects every frame.
      const rowCount = Math.max(0, chatLog.visibleCount);
      while (parts.rows.length < rowCount) {
        const name = new PIXI.Text("", new PIXI.TextStyle());
        const msg = new PIXI.Text("", new PIXI.TextStyle());
        parts.container.addChild(name, msg);
        parts.rows.push({ name, msg });
      }
      while (parts.rows.length > rowCount) {
        const row = parts.rows.pop();
        parts.container.removeChild(row.name);
        parts.container.removeChild(row.msg);
        row.name.destroy();
        row.msg.destroy();
      }

      const panelW = chatLog.width;
      const panelH = rowCount * chatLog.lineHeight + chatLog.padding * 2;

      parts.bg.clear();
      parts.bg.beginFill(_hexToNumber(chatLog.backgroundColor), chatLog.backgroundOpacity);
      parts.bg.drawRoundedRect(0, 0, panelW, panelH, 6);
      parts.bg.endFill();

      // Crops any message wider than the panel (long usernames/text)
      // cleanly at the panel edge instead of letting it spill out.
      parts.mask.clear();
      parts.mask.beginFill(0xffffff, 1);
      parts.mask.drawRect(0, 0, panelW, panelH);
      parts.mask.endFill();
      parts.container.mask = parts.mask;

      const visibleMessages = chatLog.messages.slice(-rowCount);
      for (let i = 0; i < parts.rows.length; i++) {
        const row = parts.rows[i];
        const m = visibleMessages[i];
        if (!m) {
          row.name.text = "";
          row.msg.text = "";
          continue;
        }
        row.name.style = new PIXI.TextStyle({ fontSize: chatLog.fontSize, fontFamily: chatLog.fontFamily, fontWeight: "bold", fill: m.senderColor || chatLog.senderColor });
        row.msg.style = new PIXI.TextStyle({ fontSize: chatLog.fontSize, fontFamily: chatLog.fontFamily, fill: chatLog.messageColor });
        row.name.text = chatLog.showSender && m.sender ? m.sender + ":" : "";
        row.msg.text = m.text;
        row.name.x = chatLog.padding;
        row.name.y = chatLog.padding + i * chatLog.lineHeight;
        row.msg.x = row.name.text ? row.name.x + row.name.width + 6 : chatLog.padding;
        row.msg.y = row.name.y;
      }

      parts.container.x = transform.x;
      parts.container.y = transform.y;
      parts.container.zIndex = transform.z + this._tieBreak(entity.id) + 1;
    }

    for (const [entityId, parts] of this._chats) {
      if (!chatSeen.has(entityId)) {
        if (parts.container.parent) parts.container.parent.removeChild(parts.container);
        parts.container.destroy({ children: true });
        this._chats.delete(entityId);
      }
    }

    // ── TextInput entities ───────────────────────────────────────────
    // Purely the VISIBLE box/text/cursor — the real, invisible HTML
    // <input> that actually captures keystrokes lives in
    // TextInputSystem.js, kept deliberately separate from PIXI (RULES.txt
    // #5). Always screen-space (see TextInput.js's file header), so
    // always goes in uiContainer, same as TextRenderer's screenSpace:true.
    const inputEntities = world.query(TRANSFORM, TEXT_INPUT);
    const inputSeen = new Set();

    for (const entity of inputEntities) {
      inputSeen.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const textInput = entity.getComponent(TEXT_INPUT);

      let parts = this._textInputs.get(entity.id);
      if (!parts) {
        const container = new PIXI.Container();
        const bg = new PIXI.Graphics();
        const label = new PIXI.Text("", new PIXI.TextStyle());
        label.anchor.set(0, 0.5);
        const cursor = new PIXI.Graphics();
        container.addChild(bg, label, cursor);
        parts = { container, bg, label, cursor };
        this._textInputs.set(entity.id, parts);
      }
      if (parts.container.parent !== this.uiContainer) this.uiContainer.addChild(parts.container);

      const w = textInput.width;
      const h = textInput.height;

      parts.bg.clear();
      parts.bg.lineStyle(textInput.borderWidth, _hexToNumber(textInput.borderColor), textInput.borderWidth > 0 ? 1 : 0);
      parts.bg.beginFill(_hexToNumber(textInput.backgroundColor), 1);
      parts.bg.drawRoundedRect(0, 0, w, h, textInput.cornerRadius);
      parts.bg.endFill();

      const showingPlaceholder = !textInput.value && !textInput.focused;
      const displayText = textInput.value || (textInput.focused ? "" : textInput.placeholder);
      parts.label.text = displayText;
      parts.label.style = new PIXI.TextStyle({
        fontSize: textInput.fontSize,
        fontFamily: textInput.fontFamily,
        fill: showingPlaceholder ? textInput.placeholderColor : textInput.textColor,
      });
      parts.label.x = textInput.padding;
      parts.label.y = h / 2;

      // Simple blinking caret, shown only while genuinely focused (the
      // real DOM input — see TextInputSystem.js — is what's actually
      // receiving keystrokes; this just gives the player a visual cue
      // that this box is the one currently listening).
      parts.cursor.clear();
      if (textInput.focused && Math.floor(performance.now() / 500) % 2 === 0) {
        const caretX = textInput.padding + (textInput.value ? parts.label.width + 2 : 0);
        parts.cursor.beginFill(_hexToNumber(textInput.textColor), 1);
        parts.cursor.drawRect(caretX, h * 0.2, 2, h * 0.6);
        parts.cursor.endFill();
      }

      parts.container.x = transform.x;
      parts.container.y = transform.y;
      parts.container.zIndex = transform.z + this._tieBreak(entity.id) + 1;
    }

    for (const [entityId, parts] of this._textInputs) {
      if (!inputSeen.has(entityId)) {
        if (parts.container.parent) parts.container.parent.removeChild(parts.container);
        parts.container.destroy({ children: true });
        this._textInputs.delete(entityId);
      }
    }

    // ── Joystick entities ────────────────────────────────────────────
    // Purely the VISIBLE base/knob circles — the real pointer/touch
    // tracking (which finger is dragging which joystick, multi-joystick
    // claim independence) lives entirely in JoystickSystem.js, kept
    // deliberately separate from PIXI (RULES.txt #5). Always
    // screen-space, same as TextInput/ChatLog, so always goes in
    // uiContainer.
    //
    // Draw position: while NOT actively being dragged, this always
    // draws straight from transform.x/y — the same live-Transform
    // convention TextInput/ChatLog use — rather than trusting
    // joystick.baseScreenX/Y. That field is only meaningful mid-drag
    // (JoystickSystem recenters it there for Dynamic mode, or mirrors
    // Transform for Fixed mode, but ONLY while its own update() is
    // actually running). The Scene view's edit-mode render loop
    // (SceneViewport.syncSpriteRender) intentionally runs RenderSystem
    // alone, without JoystickSystem/GameLoop — real input never fires
    // in the editor — so baseScreenX/Y would otherwise sit frozen at
    // whatever it was constructed with (0,0) and never follow the
    // entity's Transform when it's moved/dragged/reparented in the
    // Scene view. Falling back to the live transform here fixes that
    // for both edit mode AND idle Dynamic joysticks at actual runtime
    // (before the first press, when there's no drag to derive a
    // position from either).
    const joystickEntities = world.query(TRANSFORM, JOYSTICK);
    const joystickSeen = new Set();

    for (const entity of joystickEntities) {
      joystickSeen.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const joystick = entity.getComponent(JOYSTICK);

      let parts = this._joysticks.get(entity.id);
      if (!parts) {
        const container = new PIXI.Container();
        const base = new PIXI.Graphics();
        const knob = new PIXI.Graphics();
        container.addChild(base, knob);
        parts = { container, base, knob };
        this._joysticks.set(entity.id, parts);
      }
      if (parts.container.parent !== this.uiContainer) this.uiContainer.addChild(parts.container);

      // hideWhenIdle is the ONLY thing that hides a joystick while not
      // being dragged. Dynamic mode no longer hides itself just for
      // being idle — same reasoning as TextInput always drawing its box
      // regardless of `focused`: the Scene view needs something visible
      // to select/move/edit, and at real runtime a player can't press a
      // stick they can never see in the first place. hideWhenIdle is
      // there for anyone who explicitly wants the "invisible until
      // touched" mobile-game look.
      if (joystick.hideWhenIdle && !joystick.active) {
        parts.container.visible = false;
        continue;
      }
      parts.container.visible = true;
      const opacityMul = joystick.active ? 1 : Math.max(0, Math.min(1, joystick.idleOpacityMultiplier));

      parts.base.clear();
      parts.base.lineStyle(joystick.outlineWidth, _hexToNumber(joystick.outlineColor), joystick.outlineWidth > 0 ? 1 : 0);
      parts.base.beginFill(_hexToNumber(joystick.baseColor), joystick.baseOpacity * opacityMul);
      parts.base.drawCircle(0, 0, joystick.baseRadius);
      parts.base.endFill();

      // Knob offset in screen px: x/y are already normalized -1..1 (see
      // JoystickSystem._applyKnobPosition), so scale back up by
      // baseRadius to get a visible pixel offset from center. Always
      // (0,0) — centered — while not active, since x/y are only ever
      // non-zero mid-drag (or after a release with returnToCenter off,
      // itself still real drag-derived data).
      const knobX = joystick.x * joystick.baseRadius;
      const knobY = joystick.y * joystick.baseRadius;
      parts.knob.clear();
      parts.knob.lineStyle(joystick.outlineWidth, _hexToNumber(joystick.outlineColor), joystick.outlineWidth > 0 ? 1 : 0);
      parts.knob.beginFill(_hexToNumber(joystick.knobColor), joystick.knobOpacity * opacityMul);
      parts.knob.drawCircle(knobX, knobY, joystick.knobRadius);
      parts.knob.endFill();

      // Only trust baseScreenX/Y while a real drag is in progress
      // (active === true is only ever set by JoystickSystem in
      // response to a genuine press) — otherwise always follow the
      // live Transform, so moving/reparenting the entity (in the
      // editor OR via a script changing this.transform.x/y at runtime)
      // is immediately reflected instead of the stick staying stuck at
      // its last drag position or the (0,0) construction default.
      const drawX = joystick.active ? joystick.baseScreenX : transform.x;
      const drawY = joystick.active ? joystick.baseScreenY : transform.y;
      parts.container.x = drawX;
      parts.container.y = drawY;
      parts.container.zIndex = 10000 + this._tieBreak(entity.id); // UI overlay — always drawn above other screen-space elements
    }

    for (const [entityId, parts] of this._joysticks) {
      if (!joystickSeen.has(entityId)) {
        if (parts.container.parent) parts.container.parent.removeChild(parts.container);
        parts.container.destroy({ children: true });
        this._joysticks.delete(entityId);
      }
    }

    this.uiContainer.sortableChildren = true;
    this.worldContainer.sortableChildren = true;
  }

  /**
   * Deterministic, stable, tiny (<< 1) offset derived from an entity id
   * so objects sharing the exact same Transform.z always draw in the
   * same relative order every frame, without affecting the visible
   * z value (never large enough to cross into a neighboring integer z).
   * @param {string} entityId
   */
  _tieBreak(entityId) {
    let hash = 0;
    for (let i = 0; i < entityId.length; i++) {
      hash = (hash * 31 + entityId.charCodeAt(i)) >>> 0;
    }
    return (hash % 1000) / 1000000; // max ~0.001 — invisible to z ordering intent
  }

  /**
   * @returns {boolean} whether the scene's Main Camera has the
   *   scene-wide fake-3D depth toggle on. Missing camera => false, so a
   *   scene mid-setup (no camera yet) never surprises with unexpected
   *   scaling.
   */
  _isPseudo3DEnabled(world) {
    const cameraEntity = world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
    if (!cameraEntity) return false;
    return !!cameraEntity.getComponent(CAMERA).enablePseudo3D;
  }

  /**
   * Cheap perspective-style falloff: 1 at z=0, grows above 1 as z goes
   * positive ("closer" to camera / bigger), shrinks toward 0 as z goes
   * more negative ("farther" from camera / smaller) — matches the
   * requested "positive numbers scale up, negative numbers scale down"
   * behavior.
   * @param {number} z
   */
  _depthScaleFor(z) {
    return Math.max(MIN_DEPTH_SCALE, DEPTH_REFERENCE / (DEPTH_REFERENCE - z));
  }

  /**
   * Positions and scales worldContainer so the Main Camera's world
   * position is centered on screen and Camera.size is honoured as a
   * zoom level. Camera.size=5 (the default) is 1:1 — no zoom. A
   * smaller size zooms in (fewer world-units fill the viewport), a
   * larger size zooms out (more world-units visible). This is the
   * standard Unity orthographic camera convention, and it is what makes
   * `this.camera.zoom` in a script actually change how the game looks:
   * zoom = 5 / size, so setting size=2.5 via the script doubles the
   * visible scale (2× zoom in), and size=10 halves it (2× zoom out).
   */
  /**
   * Applies BOTH the Main Camera's own pan/zoom/rotation AND the
   * device-fit transform (see Camera.js's scalingMode settings and
   * computeScreenFit() in CameraUtils.js) — composed into one transform
   * on worldContainer, and the device-fit part ALONE on uiContainer
   * (screen-space UI stays fixed regardless of camera movement, but
   * still scales/positions consistently across devices — see
   * runtime/index.js's uiContainer comment). Also paints letterbox/
   * pillarbox bars into barsContainer where the fit calls for them.
   *
   * The composition: think of it as two coordinate spaces chained
   * together — world space maps to a REFERENCE-RESOLUTION virtual
   * screen (exactly what this method did before device-fit existed:
   * the camera's own zoom/rotation/pan, centered at that virtual
   * screen's middle), and THEN that whole virtual screen maps onto the
   * real device screen via computeScreenFit's scale+offset. Both steps
   * combine into a single scale/rotation/position on worldContainer
   * (PIXI containers can only hold one transform, so the two steps are
   * algebraically folded into one rather than nesting two containers).
   */
  _applyMainCameraOffset(world) {
    const cameraEntity = world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
    if (!cameraEntity) {
      if (this.barsContainer) this.barsContainer.clear();
      return;
    }

    const camera = cameraEntity.getComponent(CAMERA);
    const transform = cameraEntity.getComponent(TRANSFORM);
    const { width, height } = getCameraResolution(camera);

    // Real device/canvas size — pixiApp.screen is PIXI's logical (CSS-
    // pixel, pre-devicePixelRatio) size, which is what computeScreenFit
    // wants to compare against the reference resolution. Falls back to
    // the reference size itself (-> scale 1, no-op fit) if pixiApp
    // wasn't provided, so this degrades gracefully rather than throwing.
    const devW = this.pixiApp && this.pixiApp.screen ? this.pixiApp.screen.width : width;
    const devH = this.pixiApp && this.pixiApp.screen ? this.pixiApp.screen.height : height;
    const fit = computeScreenFit(camera, devW, devH);

    // Default size=5 → zoom factor 1 (no scaling). Clamp size to a
    // safe minimum so the container never gets an infinite scale.
    const DEFAULT_CAMERA_SIZE = 5;
    const zoom = DEFAULT_CAMERA_SIZE / Math.max(0.001, camera.size);
    const totalScaleX = zoom * fit.scaleX;
    const totalScaleY = zoom * fit.scaleY;

    this.worldContainer.scale.set(totalScaleX, totalScaleY);
    // Apply the camera entity's rotation too, so a rotated Main Camera
    // actually rotates the world view in play mode (previously rotation
    // was silently dropped here, losing camera orientation). Rotate the
    // camera-to-screen offset by the camera's world-space rotation so
    // the camera's focal point still lands on screen center.
    // NOTE: combining rotation with a non-uniform device-fit scale
    // (only possible in Stretch mode with allowStretching:true) is an
    // inherent, accepted edge case — Stretch is documented as the one
    // mode that can visually distort at all, and a rotated camera on
    // top of that distortion is a rare combination not worth adding
    // extra complexity to handle perfectly.
    const rotRad = (transform.rotation * Math.PI) / 180;
    this.worldContainer.rotation = rotRad;
    const sx = transform.x * totalScaleX;
    const sy = transform.y * totalScaleY;
    const cos = Math.cos(rotRad);
    const sin = Math.sin(rotRad);
    // The reference-resolution virtual screen's center (width/2,
    // height/2), itself mapped through the device-fit transform — see
    // this method's doc comment for the two-spaces-chained-together
    // reasoning.
    const centerX = fit.offsetX + fit.scaleX * (width / 2);
    const centerY = fit.offsetY + fit.scaleY * (height / 2);
    this.worldContainer.x = centerX - (sx * cos - sy * sin);
    this.worldContainer.y = centerY - (sx * sin + sy * cos);

    // uiContainer gets ONLY the device-fit part — no camera zoom/pan/
    // rotation, so screen-space UI stays fixed regardless of camera
    // movement, but still lines up with the same reference-resolution
    // pixel grid as everything else, consistent across devices.
    if (this.uiContainer && this.uiContainer !== this.worldContainer) {
      this.uiContainer.scale.set(fit.scaleX, fit.scaleY);
      this.uiContainer.rotation = 0;
      this.uiContainer.x = fit.offsetX;
      this.uiContainer.y = fit.offsetY;
    }

    if (this.barsContainer) {
      this.barsContainer.clear();
      if (fit.barTop > 0 || fit.barBottom > 0 || fit.barLeft > 0 || fit.barRight > 0) {
        const barColorNum = _hexToNumber(camera.barColor || "#000000");
        this.barsContainer.beginFill(barColorNum, 1);
        if (fit.barTop > 0) this.barsContainer.drawRect(0, 0, devW, fit.barTop);
        if (fit.barBottom > 0) this.barsContainer.drawRect(0, devH - fit.barBottom, devW, fit.barBottom);
        if (fit.barLeft > 0) this.barsContainer.drawRect(0, 0, fit.barLeft, devH);
        if (fit.barRight > 0) this.barsContainer.drawRect(devW - fit.barRight, 0, fit.barRight, devH);
        this.barsContainer.endFill();
      }
    }
  }

  /**
   * Applies a hex color string (e.g. "#314D79") as the renderer's clear
   * color. Deliberately NOT called automatically from update() — the
   * editor's Scene viewport calls this on every Camera field edit (live
   * preview), while the Game/Play viewport only calls it once, at the
   * moment Play is pressed, matching the requested "update in game mode
   * only when play is pressed" behavior instead of live-tracking Camera
   * edits while a game is actually running.
   * @param {PIXI.Application} pixiApp
   * @param {string} hexColorString e.g. "#314D79"
   */
  static applyBackgroundColor(pixiApp, hexColorString) {
    if (!pixiApp || !hexColorString) return;
    const hex = PIXI.utils ? PIXI.utils.string2hex(hexColorString) : parseInt(hexColorString.replace("#", "0x"));
    pixiApp.renderer.background.color = hex;
  }

  /**
   * Real, post-scale/post-depthScale world-space bounding half-extents
   * for an entity's rendered sprite, read straight from the live PIXI
   * sprite this system is already tracking. Used by
   * editor/viewport/SceneViewport.js for accurate click-to-select
   * hit-testing — previously that hit-test used a hardcoded 40px
   * half-extent for every entity regardless of actual sprite size,
   * which made clicks miss on sprites bigger/smaller than that guess.
   * @param {string} entityId
   * @returns {{halfWidth: number, halfHeight: number}|null} null if this
   *   entity has no tracked sprite (not rendered, or SpriteRenderer-less)
   */
  getSpriteWorldHalfExtents(entityId) {
    const sprite = this._sprites.get(entityId);
    if (!sprite) return null;
    // sprite.width/height already include texture size * abs(scale) —
    // PIXI computes these from the local bounds * worldTransform scale,
    // so this stays correct through flipX/flipY (negative scale) and
    // the pseudo-3D depthScale multiplier applied in update() above.
    return { halfWidth: Math.abs(sprite.width) / 2, halfHeight: Math.abs(sprite.height) / 2 };
  }

  /**
   * Same purpose as getSpriteWorldHalfExtents above, for ShapeRenderer
   * entities — used by SceneViewport's hitTestEntities so clicking a
   * shape in the Scene view selects it. gfx.width/height already
   * include Transform.scale (PIXI computes them from local geometry
   * bounds * worldTransform), so this stays correct as a shape is
   * resized or scaled.
   */
  getShapeWorldHalfExtents(entityId) {
    const gfx = this._shapes.get(entityId);
    if (!gfx) return null;
    return { halfWidth: Math.abs(gfx.width) / 2, halfHeight: Math.abs(gfx.height) / 2 };
  }

  /**
   * Read-only iteration over every live entityId -> PIXI.Sprite pair
   * this system currently tracks. Used ONLY by LightingSystem (see
   * systems/LightingSystem.js's Phase 2: attaching/updating a
   * per-sprite SpriteLightFilter) so it can react to sprites being
   * added/removed without RenderSystem needing to know anything about
   * lighting — keeps rendering centralized here (RULES.txt #5) while
   * still letting another system piggyback on the same tracked sprite
   * set instead of building its own parallel entityId->displayObject
   * map.
   * @returns {IterableIterator<[string, PIXI.Sprite]>}
   */
  getTrackedSprites() {
    return this._sprites.entries();
  }

  /**
   * Returns the live PIXI.Sprite this system tracks for the given
   * entity id, or null if the entity has no SpriteRenderer / hasn't
   * been rendered yet. Used by CameraRenderSystem to override the
   * target minimap sprite's texture with a camera render each frame.
   * @param {string} entityId
   * @returns {PIXI.Sprite|null}
   */
  getSprite(entityId) {
    return this._sprites.get(entityId) || null;
  }

  destroy() {
    for (const sprite of this._sprites.values()) {
      this.worldContainer.removeChild(sprite);
      sprite.destroy();
    }
    this._sprites.clear();
    for (const gfx of this._shapes.values()) {
      if (gfx.parent) gfx.parent.removeChild(gfx);
      gfx.destroy();
    }
    this._shapes.clear();
    for (const text of this._texts.values()) {
      if (text.parent) text.parent.removeChild(text);
      text.destroy();
    }
    this._texts.clear();
    for (const bubble of this._bubbles.values()) {
      if (bubble.container.parent) bubble.container.parent.removeChild(bubble.container);
      bubble.container.destroy({ children: true });
    }
    this._bubbles.clear();
    for (const chat of this._chats.values()) {
      if (chat.container.parent) chat.container.parent.removeChild(chat.container);
      chat.container.destroy({ children: true });
    }
    this._chats.clear();
    for (const ti of this._textInputs.values()) {
      if (ti.container.parent) ti.container.parent.removeChild(ti.container);
      ti.container.destroy({ children: true });
    }
    this._textInputs.clear();
    for (const obj of this._jointVisuals.values()) {
      if (obj.parent) obj.parent.removeChild(obj);
      obj.destroy(true);
    }
    this._jointVisuals.clear();
    this._jointVisualModes.clear();
    this._jointVisualSmoother.clear();
    for (const js of this._joysticks.values()) {
      if (js.container.parent) js.container.parent.removeChild(js.container);
      js.container.destroy({ children: true });
    }
    this._joysticks.clear();
  }
}
