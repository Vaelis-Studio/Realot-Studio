/**
 * editor/panels/ScriptPickerWindow.js
 *
 * Modal popup listing every existing script (by name) so the user can
 * attach one to the selected entity. Opened from the Inspector's
 * "Load Script" button instead of the old inline scrollable list that
 * used to fill the Inspector panel with every script name at once.
 *
 * EDITOR-ONLY FILE.
 */

import { editorState } from "../state/EditorState.js";
import { getAllScripts } from "../scripting/ScriptStorage.js";
import { icon } from "../icons/IconLibrary.js";

const PANEL_STYLE =
  "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);" +
  "background:#1e2330;border:1px solid #3a4560;border-radius:8px;" +
  "width:360px;max-height:70vh;display:flex;flex-direction:column;" +
  "z-index:1000;box-shadow:0 8px 32px rgba(0,0,0,.6);overflow:hidden;";

const BACKDROP_STYLE =
  "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:999;";

const HEADER_STYLE =
  "display:flex;align-items:center;justify-content:space-between;" +
  "padding:12px 16px;border-bottom:1px solid #2e3a50;flex-shrink:0;";

const CLOSE_BTN_STYLE =
  "background:none;border:none;color:#8a93a0;cursor:pointer;font-size:16px;" +
  "line-height:1;padding:2px 6px;border-radius:3px;";

const ROW_STYLE =
  "display:flex;align-items:center;gap:8px;padding:8px 16px;cursor:pointer;" +
  "color:#c8d0de;font-size:12px;border-bottom:1px solid #232a3a;" +
  "background:none;border:none;border-radius:0;width:100%;text-align:left;font-family:inherit;";

const EMPTY_STYLE =
  "padding:16px;color:#5a6480;font-size:12px;text-align:center;";

export function renderScriptPickerWindow() {
  if (!editorState.scriptPickerOpen) return "";

  const scripts = getAllScripts();

  const rows = scripts.length
    ? scripts
        .map(function (name) {
          return (
            '<button type="button" class="script-picker-row" data-action="script-picker-choose" data-script="' +
            _escAttr(name) +
            '" style="' + ROW_STYLE + '" title="Attach ' + _escAttr(name) + '">' +
            icon("code", 12) +
            '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _escAttr(name) + "</span>" +
            "</button>"
          );
        })
        .join("")
    : '<div style="' + EMPTY_STYLE + '">No scripts created yet.</div>';

  return (
    '<div data-action="close-script-picker" style="' + BACKDROP_STYLE + '"></div>' +
    '<div class="script-picker-window" style="' + PANEL_STYLE + '">' +
      '<div style="' + HEADER_STYLE + '">' +
        '<span style="font-size:13px;font-weight:600;color:#c8d0de;">Load Script</span>' +
        '<button data-action="close-script-picker" style="' + CLOSE_BTN_STYLE + '">✕</button>' +
      "</div>" +
      '<div style="overflow-y:auto;flex:1;">' + rows + "</div>" +
    "</div>"
  );
}

function _escAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
