/**
 * editor/panels/SpritePickerWindow.js
 *
 * Modal popup listing every imported sprite asset (with a thumbnail) so
 * the user can switch which texture the selected entity's SpriteRenderer
 * displays. Opened from the Inspector's Sprite Renderer section (the
 * small circular "sprite-pick" button next to the current sprite's
 * name — see Inspector.js), same convention as ScriptPickerWindow.js's
 * "Load Script" popup opened from the Inspector's Script section.
 *
 * Switching a sprite here only ever changes the SELECTED ENTITY's own
 * SpriteRenderer.spriteKey — it does NOT rename or modify the asset
 * itself (that's BottomPanel.js's separate inline-rename feature) and
 * does NOT touch any other entity using the previous or new sprite.
 *
 * EDITOR-ONLY FILE.
 */

import { editorState } from "../state/EditorState.js";
import { getAllSpriteAssets } from "../../runtime/assets/AssetRegistry.js";
import { icon } from "../icons/IconLibrary.js";
const PANEL_STYLE =
  "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);" +
  "background:#1e2330;border:1px solid #3a4560;border-radius:8px;" +
  "width:400px;max-height:70vh;display:flex;flex-direction:column;" +
  "z-index:1000;box-shadow:0 8px 32px rgba(0,0,0,.6);overflow:hidden;";

const BACKDROP_STYLE =
  "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:999;";

const HEADER_STYLE =
  "display:flex;align-items:center;justify-content:space-between;" +
  "padding:12px 16px;border-bottom:1px solid #2e3a50;flex-shrink:0;";

const CLOSE_BTN_STYLE =
  "background:none;border:none;color:#8a93a0;cursor:pointer;font-size:16px;" +
  "line-height:1;padding:2px 6px;border-radius:3px;";

const GRID_STYLE =
  "display:flex;flex-wrap:wrap;gap:10px;padding:12px 16px;overflow-y:auto;flex:1;";

const ROW_STYLE =
  "display:flex;flex-direction:column;align-items:center;gap:4px;width:72px;" +
  "cursor:pointer;background:none;border:none;border-radius:4px;padding:4px;font-family:inherit;";

const THUMB_STYLE =
  "width:60px;height:60px;background:#12151d;border:1px solid #2e3a50;border-radius:3px;" +
  "display:flex;align-items:center;justify-content:center;overflow:hidden;";

const LABEL_STYLE =
  "font-size:10px;color:#c8d0de;text-align:center;width:100%;white-space:nowrap;" +
  "overflow:hidden;text-overflow:ellipsis;";

const EMPTY_STYLE =
  "padding:24px 16px;color:#5a6480;font-size:12px;text-align:center;";

export function renderSpritePickerWindow() {
  if (!editorState.spritePickerOpen) return "";

  const assets = getAllSpriteAssets();

  const cells = assets.length
    ? assets
        .map(function (a) {
          return (
            '<button type="button" class="sprite-picker-cell" data-action="sprite-picker-choose" data-sprite-key="' +
            _escAttr(a.key) +
            '" style="' + ROW_STYLE + '" title="Use ' + _escAttr(a.name) + '">' +
            '<div style="' + THUMB_STYLE + '"><img src="' + a.dataUrl + '" alt="' + _escAttr(a.name) +
            '" style="width:100%;height:100%;object-fit:contain;" /></div>' +
            '<span style="' + LABEL_STYLE + '">' + _escAttr(a.name) + "</span>" +
            "</button>"
          );
        })
        .join("")
    : '<div style="' + EMPTY_STYLE + '">No sprites imported yet. Import one from the Project panel\'s Sprites folder first.</div>';

  return (
    '<div data-action="close-sprite-picker" style="' + BACKDROP_STYLE + '"></div>' +
    '<div class="sprite-picker-window" style="' + PANEL_STYLE + '">' +
      '<div style="' + HEADER_STYLE + '">' +
        '<span style="font-size:13px;font-weight:600;color:#c8d0de;">' +
          (editorState.spritePickerTarget === "StrokePath" ? "Choose Texture" : "Choose Sprite") +
        '</span>' +
        '<button data-action="close-sprite-picker" style="' + CLOSE_BTN_STYLE + '">✕</button>' +
      "</div>" +
      '<div style="' + GRID_STYLE + '">' + cells + "</div>" +
    "</div>"
  );
}

function _escAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
