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
    _renderZoomBar() +
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

function _renderZoomBar() {
  const z = editorState.anim.previewZoom || 1;
  return (
    '<div class="animpanel-zoombar" title="Mouse wheel = zoom, drag = pan, double-click = fit">' +
    '<button data-action="anim-preview-zoom" data-dir="out" title="Zoom out">\u2212</button>' +
    '<span class="zlabel">' + Math.round(z * 100) + "%</span>" +
    '<button data-action="anim-preview-zoom" data-dir="in" title="Zoom in">+</button>' +
    '<button data-action="anim-preview-zoom" data-dir="fit" title="Fit to box">Fit</button>' +
    '<button data-action="anim-preview-zoom" data-dir="one" title="Actual pixels (1:1)">1:1</button>' +
    "</div>"
  );
}

// Frames don't always carry width/height (template/imported clips often only
// have spriteKey), and falling back to 1x1 made the image vanish as soon as
// a collider was shown. Read the real pixel size from the image itself,
// cache it, and re-render once it has loaded.
const _thumbDimsCache = new Map();
function _thumbDims(thumb) {
  const hit = _thumbDimsCache.get(thumb);
  if (hit) return hit;
  if (!_thumbDimsCache.has("pending:" + thumb)) {
    _thumbDimsCache.set("pending:" + thumb, true);
    const img = new Image();
    img.onload = () => {
      _thumbDimsCache.set(thumb, { w: img.naturalWidth || 64, h: img.naturalHeight || 64 });
      if (editorState.renderFn) editorState.renderFn();
    };
    img.src = thumb;
  }
  return { w: 64, h: 64 }; // placeholder for the one frame before it loads
}

function _renderPreviewStage(entity, clip, frame, thumb) {
  const dims = frame.width && frame.height ? { w: frame.width, h: frame.height } : _thumbDims(thumb);
  const fw = dims.w;
  const fh = dims.h;

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

  // While a handle is being dragged, keep the stage's coordinate frame frozen
  // so the handle under the cursor doesn't slide as the shape grows.
  const frozen = editorState.anim._dragBounds;
  if (frozen) { minX = frozen.minX; maxX = frozen.maxX; minY = frozen.minY; maxY = frozen.maxY; }

  const boundsW = Math.max(1, maxX - minX);
  const boundsH = Math.max(1, maxY - minY);

  // Single shared scale: whichever axis is more constrained (wider or
  // taller relative to the stage) decides the zoom level for BOTH the
  // image and the collider outline, so an oversized sprite OR an
  // oversized collider each independently trigger a further zoom-out
  // rather than clipping.
  const fitScale = Math.min(PREVIEW_STAGE_SIZE / boundsW, PREVIEW_STAGE_SIZE / boundsH);
  editorState.anim.previewFitScale = fitScale;
  // User zoom multiplies the fit scale, so a tiny sprite/collider can be
  // enlarged (wheel / + / 1:1) and a huge one shrunk, without ever losing
  // the shared image+collider alignment.
  const zoom = editorState.anim.previewZoom || 1;
  const scale = fitScale * zoom;
  editorState.anim._geom = { minX, minY, maxX, maxY, scale };
  const panX = editorState.anim.previewPanX || 0;
  const panY = editorState.anim.previewPanY || 0;

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
    overlayHtml = _renderColliderOverlay(source, colliderBounds, minX, minY, scale, !!clip.colliderOverride);
  }

  return (
    '<div class="animpanel-preview-stage" data-anim-stage="1" style="position:relative;width:' +
    stageW + "px;height:" + stageH + "px;transform:translate(" + panX + "px," + panY + 'px);">' +
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
 * Collider outline for the preview. When `editable` (the clip has its own
 * Collider Override) it also emits drag handles — same idea as the Scene
 * view gizmo: drag a triangle corner, drag the body to move the offset,
 * drag edge/side handles to resize. All handle geometry uses the SAME
 * (originX, originY, scale) as the image, so it stays aligned at any zoom.
 */
function _renderColliderOverlay(source, bounds, originX, originY, scale, editable) {
  const color = source.isTrigger ? "#2dd4ff" : "#ff2d55";
  const ox = source.offsetX || 0;
  const oy = source.offsetY || 0;
  const px = (lx) => (lx - originX) * scale;
  const py = (ly) => (ly - originY) * scale;
  const hdl = (id, lx, ly, cursor) =>
    '<div data-anim-handle="' + id + '" style="position:absolute;left:' + (px(lx) - 5) + "px;top:" + (py(ly) - 5) +
    "px;width:10px;height:10px;box-sizing:border-box;background:#fff;border:1.5px solid " + color +
    ";border-radius:2px;cursor:" + cursor + ';pointer-events:auto;z-index:3;touch-action:none;"></div>';

  if (source.shape === ColliderShape.TRIANGLE) {
    const pts = (source.trianglePoints || []).map((q) => ({ x: px(q.x + ox), y: py(q.y + oy) }));
    const poly = pts.map((q) => q.x + "," + q.y).join(" ");
    return (
      '<svg class="animpanel-collider-overlay" style="position:absolute;left:0;top:0;pointer-events:none;overflow:visible;z-index:3;" width="1" height="1">' +
      '<polygon points="' + poly + '" fill="' + color + '22" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round"' +
      (editable ? ' data-anim-handle="move" style="pointer-events:all;cursor:move;touch-action:none;"' : "") + "/>" +
      pts
        .map((q, i) =>
          editable
            ? '<circle data-anim-handle="tri' + i + '" cx="' + q.x + '" cy="' + q.y + '" r="5" fill="#fff" stroke="' + color +
              '" stroke-width="1.5" style="pointer-events:all;cursor:crosshair;touch-action:none;"/>'
            : '<circle cx="' + q.x + '" cy="' + q.y + '" r="3" fill="#fff" stroke="' + color + '" stroke-width="1.5"/>'
        )
        .join("") +
      "</svg>"
    );
  }

  const left = px(bounds.minX);
  const top = py(bounds.minY);
  const w = Math.max(1, (bounds.maxX - bounds.minX) * scale);
  const h = Math.max(1, (bounds.maxY - bounds.minY) * scale);
  const isRound = source.shape === ColliderShape.CIRCLE || source.shape === ColliderShape.CAPSULE;

  let handles = "";
  if (editable) {
    if (source.shape === ColliderShape.CIRCLE) {
      handles = hdl("r", ox + source.radius, oy, "ew-resize");
    } else if (source.shape === ColliderShape.CAPSULE) {
      handles =
        hdl("cr", ox + source.capsuleRadius, oy, "ew-resize") +
        hdl("hh", ox, oy - (source.capsuleHalfHeight + source.capsuleRadius), "ns-resize");
    } else {
      const hw = source.width / 2;
      const hh = source.height / 2;
      handles =
        hdl("w+", ox + hw, oy, "ew-resize") + hdl("w-", ox - hw, oy, "ew-resize") +
        hdl("h-", ox, oy - hh, "ns-resize") + hdl("h+", ox, oy + hh, "ns-resize");
    }
  }

  return (
    '<div class="animpanel-collider-overlay"' + (editable ? ' data-anim-handle="move"' : "") +
    ' style="position:absolute;pointer-events:' + (editable ? "auto" : "none") + ";" + (editable ? "cursor:move;touch-action:none;" : "") +
    "left:" + left + "px;top:" + top + "px;width:" + w + "px;height:" + h + "px;" +
    "border:1.5px solid " + color + ";box-sizing:border-box;background:" + color + "18;" +
    (isRound ? "border-radius:999px;" : "") +
    '"></div>' + handles
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
        ? [0, 1, 2]
            .map((i) => {
              const q = (ov.trianglePoints && ov.trianglePoints[i]) || { x: 0, y: 0 };
              return row(
                "Point " + (i + 1),
                '<div style="display:flex;gap:4px;width:100%;">' +
                  numInput("X", q.x, f("trianglePoints." + i + ".x")) +
                  numInput("Y", q.y, f("trianglePoints." + i + ".y")) +
                  "</div>"
              );
            })
            .join("")
        : row(
            "Size",
            '<div style="display:flex;gap:4px;width:100%;">' +
              numInput("W", ov.width, f("width")) +
              numInput("H", ov.height, f("height")) +
              "</div>"
          ));
  }

  if (ov) {
    shapeFieldsHtml +=
      row(
        "Offset",
        '<div style="display:flex;gap:4px;width:100%;">' +
          numInput("X", ov.offsetX || 0, f("offsetX")) +
          numInput("Y", ov.offsetY || 0, f("offsetY")) +
          "</div>"
      ) +
      '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
      "Tip: turn on \u201CShow collider on frame\u201D, then drag the shape to move its offset and drag the white handles to reshape it." +
      "</div>";
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
