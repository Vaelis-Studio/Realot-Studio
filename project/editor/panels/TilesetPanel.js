/**
 * editor/panels/TilesetPanel.js
 *
 * Tileset authoring window (opened from the Inspector's Tileset
 * section — see "open-tileset-editor" in EditorEvents.js). Shows a 4x4
 * grid of the 16 autotile roles (see runtime/components/Tileset.js's
 * TileRole/TILE_ROLE_ORDER):
 *
 *   corner-TL   edge-T    corner-TR  stub-T
 *   edge-L      CENTER    edge-R     line-V
 *   corner-BL   edge-B    corner-BR  stub-B
 *   stub-L      line-H    stub-R     SINGLE
 *
 * The user can:
 *   - import ONE image -> auto-sliced into the 16 slots in this exact
 *     row-major order (editor/tileset/TilesetImport.js's
 *     sliceTilesetImageIntoRoles)
 *   - import up to 16 separate images -> filled into empty slots in
 *     the order chosen/dropped
 *   - drag an image from one slot onto another slot to SWAP their
 *     contents (matching the frame-reorder drag idiom already used by
 *     AnimationWindow.js's frame thumbnails, applied here to a 2D grid
 *     instead of a 1D list)
 *
 * All actual data lives on the selected entity's live Tileset component
 * (editorState.world) — this file only reads/writes that component's
 * plain fields plus its own tiny bit of editor-only UI state
 * (editorState.tilesetPanel, see EditorState.js), matching every other
 * panel's data/UI-state split.
 *
 * EDITOR-ONLY FILE.
 */

import { icon } from "../icons/IconLibrary.js";
import { editorState } from "../state/EditorState.js";
import { TILESET, TILE_ROLE_ORDER } from "../../runtime/components/Tileset.js";
import { getSpriteAsset } from "../../runtime/assets/AssetRegistry.js";

const ROLE_LABELS = {
  cornerTL: "Corner TL",
  edgeT: "Edge Top",
  cornerTR: "Corner TR",
  stubT: "Stub Top",
  edgeL: "Edge Left",
  center: "Center",
  edgeR: "Edge Right",
  lineV: "Line Vert",
  cornerBL: "Corner BL",
  edgeB: "Edge Bottom",
  cornerBR: "Corner BR",
  stubB: "Stub Bot",
  stubL: "Stub Left",
  lineH: "Line Horz",
  stubR: "Stub Right",
  single: "Single",
};

function _thumbFor(spriteKey) {
  if (!spriteKey) return null;
  const asset = getSpriteAsset(spriteKey);
  return asset ? asset.dataUrl : null;
}

export function renderTilesetEditor() {
  if (!editorState.tilesetPanel.open) return "";

  const world = editorState.world;
  const entity = world ? world.getEntity(editorState.tilesetPanel.entityId) : null;
  const tileset = entity ? entity.getComponent(TILESET) : null;

  return (
    '<div class="anim-overlay">' +
    '<div class="anim-backdrop" data-action="close-tileset-editor"></div>' +
    '<div class="anim-window tileset-window">' +
    '<div class="anim-header"><div class="title">' +
    icon("grid", 12) +
    " Tileset Editor</div><button class=\"anim-close\" data-action=\"close-tileset-editor\">" +
    icon("x", 12) +
    "</button></div>" +
    (tileset ? _renderBody(entity, tileset) : _renderNoComponent()) +
    "</div>" +
    "</div>"
  );
}

function _renderNoComponent() {
  return '<div class="tileset-empty">No Tileset component on this object.</div>';
}

function _renderBody(entity, tileset) {
  return (
    '<div class="tileset-body">' +
    '<div class="tileset-toolbar">' +
    '<label class="tileset-import-btn">' +
    icon("upload", 12) +
    "<span>Import Single Image (auto-slice 4x4)</span>" +
    '<input type="file" accept="image/*" style="display:none;" data-action="tileset-import-single" />' +
    "</label>" +
    '<label class="tileset-import-btn">' +
    icon("upload", 12) +
    "<span>Import Multiple Images</span>" +
    '<input type="file" accept="image/*" multiple style="display:none;" data-action="tileset-import-multi" />' +
    "</label>" +
    "</div>" +
    '<div class="tileset-hint">Drag an image from one box to another to swap their positions.</div>' +
    '<div class="tileset-grid-wrap">' +
    '<div class="tileset-4x4-grid">' +
    TILE_ROLE_ORDER.map((role, index) => _renderSlot(role, index, tileset)).join("") +
    "</div>" +
    "</div>" +
    '<div class="tileset-sizefields">' +
    '<label>Tile Width <input type="number" min="1" value="' +
    tileset.tileWidth +
    '" data-field="Tileset.tileWidth" /></label>' +
    '<label>Tile Height <input type="number" min="1" value="' +
    tileset.tileHeight +
    '" data-field="Tileset.tileHeight" /></label>' +
    "</div>" +
    "</div>"
  );
}

function _renderSlot(role, index, tileset) {
  const spriteKey = tileset.slots[role];
  const thumb = _thumbFor(spriteKey);
  const isDragging = editorState.tilesetPanel.draggingRole === role;

  return (
    '<div class="tileset-slot' +
    (isDragging ? " dragging" : "") +
    '" draggable="' +
    (spriteKey ? "true" : "false") +
    '" data-action="tileset-slot" data-role="' +
    role +
    '">' +
    (thumb
      ? '<img src="' + thumb + '" alt="' + ROLE_LABELS[role] + '" />'
      : '<div class="tileset-slot-empty">' +
        '<label class="tileset-slot-empty-label">' +
        icon("plus", 14) +
        '<input type="file" accept="image/*" style="display:none;" data-action="tileset-import-slot" data-role="' +
        role +
        '" />' +
        "</label>" +
        "</div>") +
    '<div class="tileset-slot-label">' +
    ROLE_LABELS[role] +
    "</div>" +
    "</div>"
  );
}
