/**
 * editor/panels/AnimationWindow.js
 *
 * Frame-based Animation panel (Unity 2D "Sprite Editor" / simple
 * frame-list animator style) — NOT a keyframe/property timeline. Lets
 * the user:
 *   - create/rename/delete animation clips on the selected entity's
 *     SpriteAnimation component (see runtime/components/SpriteAnimation.js)
 *   - import frames from standalone images, a .zip of images, or a
 *     single sprite-sheet (auto-detected or a manual grid override)
 *     via editor/animation/AnimationImport.js
 *   - drag frame thumbnails to reorder them, or delete individual frames
 *   - preview the clip (play/pause/step) independent of game playback
 *   - set the clip's fps and loop flag
 *   - toggle a per-clip collider shape override (mirrors the same
 *     fields as the Inspector's own Collider2D section -- see
 *     editor/panels/Inspector.js's "Sprite Animation" section, which
 *     edits the exact same clip.colliderOverride data this panel does)
 *
 * All actual data lives on the selected entity's live SpriteAnimation
 * component (editorState.world) -- this file only reads/writes that
 * component's plain fields plus its own small bit of editor-only UI
 * state in editorState.anim (see EditorState.js) for things like which
 * frame is being previewed/dragged, matching every other panel's
 * convention of keeping data in the runtime and UI-only state in
 * editorState.
 *
 * EDITOR-ONLY FILE.
 */

import { icon } from "../icons/IconLibrary.js";
import { dropdownInput, row, numInput } from "./UIComponents.js";
import { editorState } from "../state/EditorState.js";
import { SPRITE_ANIMATION, generateClipId } from "../../runtime/components/SpriteAnimation.js";
import { COLLIDER_2D, ColliderShape } from "../../runtime/components/Collider2D.js";
import { getSpriteAsset } from "../../runtime/assets/AssetRegistry.js";

/** Resolves a frame's thumbnail dataUrl by spriteKey via the shared
 * asset catalogue -- see AssetRegistry.registerSpriteAsset(), which
 * AnimationImport.js calls for every frame it produces regardless of
 * which of the 3 import paths created it. */
function _thumbFor(spriteKey) {
  const asset = getSpriteAsset(spriteKey);
  return asset ? asset.dataUrl : null;
}

export function renderAnimEditor() {
  if (!editorState.animOpen) return "";

  const world = editorState.world;
  const entity = world ? world.getEntity(editorState.selectedId) : null;
  const anim = entity ? entity.getComponent(SPRITE_ANIMATION) : null;

  return (
    '<div class="anim-overlay">' +
    '<div class="anim-backdrop" data-action="close-anim"></div>' +
    '<div class="anim-window animpanel-window">' +
    '<div class="anim-header"><div class="title">' +
    icon("film", 12) +
    ' Animation</div><button class="anim-close" data-action="close-anim">' +
    icon("x", 12) +
    "</button></div>" +
    (entity ? (anim ? _renderBody(entity, anim) : _renderNoComponent()) : _renderNoSelection()) +
    "</div>" +
    "</div>"
  );
}

function _renderNoSelection() {
  return (
    '<div class="animpanel-empty">' +
    icon("film", 28) +
    "<p>Select an entity in the Scene to edit its animations.</p>" +
    "</div>"
  );
}

function _renderNoComponent() {
  return (
    '<div class="animpanel-empty">' +
    icon("film", 28) +
    "<p>This entity has no Sprite Animation component yet.</p>" +
    '<button class="anim-open-btn" data-action="add-component-choice" data-component="SpriteAnimation">' +
    icon("plus", 12) +
    " Add Sprite Animation</button>" +
    "</div>"
  );
}

function _renderBody(entity, anim) {
  const clip = anim.clips.find((c) => c.id === editorState.anim.editingClipId) || anim.clips[0] || null;
  if (clip && editorState.anim.editingClipId !== clip.id) {
    editorState.anim.editingClipId = clip.id;
  }

  return (
    '<div class="animpanel-toolbar">' +
    _renderClipPicker(anim, clip) +
    '<button class="animpanel-ibtn" data-action="anim-new-clip" title="New Clip">' + icon("plus", 13) + "</button>" +
    (clip
      ? '<button class="animpanel-ibtn" data-action="anim-rename-clip" data-clip-id="' +
        clip.id +
        '" title="Rename Clip">' +
        icon("morevertical", 13) +
        "</button>" +
        '<button class="animpanel-ibtn danger" data-action="anim-delete-clip" data-clip-id="' +
        clip.id +
        '" title="Delete Clip">' +
        icon("trash", 13) +
        "</button>"
      : "") +
    "</div>" +
    (clip ? _renderClipEditor(entity, anim, clip) : _renderNoClips())
  );
}

function _renderNoClips() {
  return (
    '<div class="animpanel-empty">' +
    icon("film", 28) +
    "<p>No animation clips yet.</p>" +
    '<button class="anim-open-btn" data-action="anim-new-clip">' + icon("plus", 12) + " Create Animation</button>" +
    "</div>"
  );
}

function _renderClipPicker(anim, clip) {
  if (clip && editorState.anim.renamingClipId === clip.id) {
    return (
      '<input class="animpanel-rename-input" type="text" value="' +
      _escapeAttr(clip.name) +
      '" data-action="anim-rename-clip-input" data-clip-id="' +
      clip.id +
      '" autofocus />'
    );
  }
  if (anim.clips.length === 0) return '<div class="animpanel-clip-picker-empty">No clips</div>';
  return (
    '<div class="animpanel-clip-picker">' +
    dropdownInput(
      anim.clips.map((c) => c.name),
      clip ? clip.name : "",
      "SpriteAnimation.editingClipName"
    ) +
    "</div>"
  );
}

function _renderClipEditor(entity, anim, clip) {
  const frameCount = clip.frames.length;
  const previewIndex = Math.min(editorState.anim.previewFrameIndex, Math.max(0, frameCount - 1));
  const previewFrame = clip.frames[previewIndex];
  const previewThumb = previewFrame ? _thumbFor(previewFrame.spriteKey) : null;

  return (
    '<div class="animpanel-body">' +
    '<div class="animpanel-preview-col">' +
    '<div class="animpanel-preview">' +
    (previewThumb
      ? _renderPreviewStage(entity, clip, previewFrame, previewThumb)
      : '<div class="animpanel-preview-empty">' + icon("film", 32) + "<span>No frames</span></div>") +
    "</div>" +
    '<div class="animpanel-transport">' +
    '<button class="animpanel-ibtn" data-action="anim-preview-step" data-dir="-1" title="Previous Frame">' +
    icon("stepforward", 13, "flip") +
    "</button>" +
    '<button class="animpanel-ibtn animpanel-play" data-action="anim-preview-toggle-play" title="Play/Pause Preview">' +
    icon(editorState.anim.previewPlaying ? "pause" : "play", 14) +
    "</button>" +
    '<button class="animpanel-ibtn" data-action="anim-preview-step" data-dir="1" title="Next Frame">' +
    icon("stepforward", 13) +
    "</button>" +
    '<span class="animpanel-frame-counter">' +
    (frameCount ? previewIndex + 1 + " / " + frameCount : "0 / 0") +
    "</span>" +
    "</div>" +
    '<label class="animpanel-collider-toggle">' +
    '<input type="checkbox" data-action="anim-toggle-show-collider"' +
    (editorState.anim.showColliderInPreview ? " checked" : "") +
    ' style="accent-color:#2C5D87;margin:0;" />' +
    " Show collider on frame" +
    "</label>" +
    '<div class="animpanel-clip-settings">' +
    row("FPS", numInput("", clip.fps, "SpriteAnimation.clipFps." + clip.id)) +
    row(
      "Loop",
      '<input type="checkbox" data-action="anim-toggle-loop"' + (clip.loop ? " checked" : "") + ' style="accent-color:#2C5D87;margin:0;" />'
    ) +
    "</div>" +
    _renderColliderOverrideSection(clip) +
    "</div>" +
    '<div class="animpanel-frames-col">' +
    '<div class="animpanel-frames-head">' +
    "<span>Frames (" + frameCount + ")</span>" +
    '<div class="animpanel-import-btns">' +
    '<label class="animpanel-import-btn" title="Import standalone images">' +
    icon("upload", 12) +
    " Images" +
    '<input type="file" accept="image/*" multiple style="display:none;" data-action="anim-import-images" />' +
    "</label>" +
    '<label class="animpanel-import-btn" title="Import a .zip full of images">' +
    icon("upload", 12) +
    " Zip" +
    '<input type="file" accept=".zip" style="display:none;" data-action="anim-import-zip" />' +
    "</label>" +
    '<label class="animpanel-import-btn" title="Slice a single sprite sheet into frames">' +
    icon("grid", 12) +
    " Sheet" +
    '<input type="file" accept="image/*" style="display:none;" data-action="anim-import-sheet" />' +
    "</label>" +
    '<label class="animpanel-import-btn" title="Extract frames from an animated GIF">' +
    icon("upload", 12) +
    " GIF" +
    '<input type="file" accept="image/gif,.gif" style="display:none;" data-action="anim-import-gif" />' +
    "</label>" +
    "</div>" +
    "</div>" +
    '<div class="animpanel-frame-grid">' +
    (frameCount
      ? clip.frames
          .map((frame, i) => _renderFrameThumb(frame, i, previewIndex))
          .join("")
      : '<div class="animpanel-frames-empty">Import images, a zip, or a sprite sheet above to add frames.</div>') +
    "</div>" +
    "</div>" +
    "</div>"
  );
}

/**
 * Renders the preview <img> AND (if enabled) its collider outline
 * together, both scaled by the SAME factor so neither can ever spill
 * outside the fixed-size preview box — no matter how tall/wide the
 * source image is, or how large the collider is relative to it.
 *
 * The old approach sized the image with CSS max-width/max-height and
 * positioned the collider overlay in PERCENTAGES of the image's own
 * box. That breaks in two ways: (1) an extreme aspect-ratio image (very
 * tall or very wide) can still overflow the box's cross-axis depending
 * on browser flex rounding, and (2) a collider bigger than the sprite
 * itself (e.g. width=500 on a 64px-wide sprite) produces a >100%
 * overlay size, which visually busts out of the checkered preview area
 * since it's a child of the image's own (possibly tiny) box.
 *
 * Fix: compute one bounding box that contains BOTH the frame image and
 * the collider's full extent (using its offset), in the same local
 * pixel units, then scale THAT combined box down to fit inside a fixed
 * stage size. Both the image and the collider div are then emitted as
 * plain absolutely-positioned pixel rects against that single scale —
 * so a huge collider just makes the whole preview "zoom out" further
 * rather than overflowing, and a huge image does the same.
 */
const PREVIEW_STAGE_SIZE = 130; // px — fits inside the 150px-tall / 230px-wide preview box with margin

function _renderPreviewStage(entity, clip, frame, thumb) {
  const fw = frame.width || 1;
  const fh = frame.height || 1;

  const baseCollider = entity.getComponent(COLLIDER_2D);
  const showCollider = editorState.anim.showColliderInPreview;
  const source = showCollider ? clip.colliderOverride || baseCollider : null;

  const colliderBounds = source ? _colliderLocalBounds(source) : null;

  // Combined bounding box in local/frame pixel space: the frame image is
  // centered at (0,0) here (matching the sprite's own default pivot),
  // and the collider's bounds already account for its offset relative
  // to that same center — so a union of the two rects is exactly the
  // "everything that must fit on screen" box.
  let minX = -fw / 2, maxX = fw / 2, minY = -fh / 2, maxY = fh / 2;
  if (colliderBounds) {
    minX = Math.min(minX, colliderBounds.minX);
    maxX = Math.max(maxX, colliderBounds.maxX);
    minY = Math.min(minY, colliderBounds.minY);
    maxY = Math.max(maxY, colliderBounds.maxY);
  }

  const boundsW = Math.max(1, maxX - minX);
  const boundsH = Math.max(1, maxY - minY);

  // Single shared scale: whichever axis is more constrained (wider or
  // taller relative to the stage) decides the zoom level for BOTH the
  // image and the collider outline, so an oversized sprite OR an
  // oversized collider each independently trigger a further zoom-out
  // rather than clipping.
  const scale = Math.min(PREVIEW_STAGE_SIZE / boundsW, PREVIEW_STAGE_SIZE / boundsH);

  const toPx = (x, y, w, h) => ({
    left: (x - minX) * scale,
    top: (y - minY) * scale,
    width: Math.max(1, w * scale),
    height: Math.max(1, h * scale),
  });

  const imgRect = toPx(-fw / 2, -fh / 2, fw, fh);
  const stageW = boundsW * scale;
  const stageH = boundsH * scale;

  let overlayHtml = "";
  if (source && colliderBounds) {
    overlayHtml = _renderColliderOverlay(source, colliderBounds, minX, minY, scale);
  }

  return (
    '<div class="animpanel-preview-stage" style="position:relative;width:' +
    stageW + "px;height:" + stageH + 'px;">' +
    '<img src="' + thumb + '" alt="" style="position:absolute;left:' +
    imgRect.left + "px;top:" + imgRect.top + "px;width:" + imgRect.width +
    "px;height:" + imgRect.height + 'px;image-rendering:pixelated;" />' +
    overlayHtml +
    "</div>"
  );
}

/**
 * Local-space (frame-center-relative) bounding box of a collider shape,
 * used both to grow the combined preview bounds and to place the
 * overlay div. Mirrors the same shape math ColliderGizmo.js/
 * ColliderGeometry.js use, just without any Transform/rotation (this is
 * a flat preview thumbnail, not the rotatable Scene view).
 */
function _colliderLocalBounds(source) {
  const ox = source.offsetX || 0;
  const oy = source.offsetY || 0;

  if (source.shape === ColliderShape.CIRCLE) {
    const r = source.radius;
    return { minX: ox - r, maxX: ox + r, minY: oy - r, maxY: oy + r };
  }
  if (source.shape === ColliderShape.CAPSULE) {
    const r = source.capsuleRadius;
    const hh = source.capsuleHalfHeight;
    return { minX: ox - r, maxX: ox + r, minY: oy - (hh + r), maxY: oy + (hh + r) };
  }
  if (source.shape === ColliderShape.TRIANGLE) {
    const pts = source.trianglePoints || [];
    if (!pts.length) return { minX: ox, maxX: ox, minY: oy, maxY: oy };
    const xs = pts.map((p) => p.x + ox);
    const ys = pts.map((p) => p.y + oy);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }
  // BOX
  const hw = source.width / 2;
  const hh = source.height / 2;
  return { minX: ox - hw, maxX: ox + hw, minY: oy - hh, maxY: oy + hh };
}

/**
 * Emits the collider outline as an absolutely-positioned pixel rect
 * using the SAME (minX, minY, scale) the image was placed with, so it
 * lines up exactly regardless of zoom level.
 */
function _renderColliderOverlay(source, bounds, originX, originY, scale) {
  const color = source.isTrigger ? "#2dd4ff" : "#ff2d55";
  const left = (bounds.minX - originX) * scale;
  const top = (bounds.minY - originY) * scale;
  const w = Math.max(1, (bounds.maxX - bounds.minX) * scale);
  const h = Math.max(1, (bounds.maxY - bounds.minY) * scale);

  const isRound = source.shape === ColliderShape.CIRCLE || source.shape === ColliderShape.CAPSULE;

  return (
    '<div class="animpanel-collider-overlay" style="position:absolute;pointer-events:none;' +
    "left:" + left + "px;top:" + top + "px;width:" + w + "px;height:" + h + "px;" +
    "border:1.5px solid " + color + ";box-sizing:border-box;" +
    (isRound ? "border-radius:999px;" : "") +
    '"></div>'
  );
}

function _renderFrameThumb(frame, index, previewIndex) {
  const thumb = _thumbFor(frame.spriteKey);
  const isDragging = editorState.anim.draggingFrameIndex === index;
  return (
    '<div class="animpanel-frame' +
    (index === previewIndex ? " active" : "") +
    (isDragging ? " dragging" : "") +
    '" draggable="true" data-action="anim-frame-thumb" data-frame-index="' +
    index +
    '">' +
    (thumb ? '<img src="' + thumb + '" alt="" draggable="false" />' : '<div class="animpanel-frame-missing">?</div>') +
    '<span class="animpanel-frame-num">' + (index + 1) + "</span>" +
    '<button class="animpanel-frame-del" data-action="anim-delete-frame" data-frame-index="' +
    index +
    '" title="Delete frame">' +
    icon("x", 10) +
    "</button>" +
    "</div>"
  );
}

function _renderColliderOverrideSection(clip) {
  const ov = clip.colliderOverride;
  const f = (prop) => "SpriteAnimation.clipOverride." + clip.id + "." + prop;
  let shapeFieldsHtml = "";
  if (ov) {
    shapeFieldsHtml =
      row("Shape", dropdownInput(Object.values(ColliderShape), ov.shape, f("shape"))) +
      (ov.shape === ColliderShape.CIRCLE
        ? row("Radius", numInput("", ov.radius, f("radius")))
        : ov.shape === ColliderShape.CAPSULE
        ? row(
            "Size",
            '<div style="display:flex;gap:4px;width:100%;">' +
              numInput("Half H", ov.capsuleHalfHeight, f("capsuleHalfHeight")) +
              numInput("Radius", ov.capsuleRadius, f("capsuleRadius")) +
              "</div>"
          )
        : ov.shape === ColliderShape.TRIANGLE
        ? '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
          "Select this entity and pick this clip from the Inspector to drag its 3 points in the Scene view." +
          "</div>"
        : row(
            "Size",
            '<div style="display:flex;gap:4px;width:100%;">' +
              numInput("W", ov.width, f("width")) +
              numInput("H", ov.height, f("height")) +
              "</div>"
          ));
  }

  return (
    '<div class="animpanel-collider-override">' +
    row(
      "Collider Override",
      '<input type="checkbox" data-action="anim-toggle-collider-override"' +
        (ov ? " checked" : "") +
        ' style="accent-color:#2C5D87;margin:0;"/>'
    ) +
    '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
    "When on, this clip uses its own collision shape while playing." +
    "</div>" +
    shapeFieldsHtml +
    "</div>"
  );
}

function _escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Creates a fresh, empty clip and returns it -- exported so
 * EditorEvents.js's "anim-new-clip" action can create the clip without
 * duplicating the id-generation/default-fields logic here. */
export function createEmptyClip(existingNames) {
  let name = "New Animation";
  let n = 1;
  const taken = new Set(existingNames);
  while (taken.has(name)) {
    n++;
    name = "New Animation " + n;
  }
  return {
    id: generateClipId(),
    name,
    frames: [],
    fps: 12,
    loop: true,
    colliderOverride: null,
  };
}
