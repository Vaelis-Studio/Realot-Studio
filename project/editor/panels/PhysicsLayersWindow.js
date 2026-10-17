/**
 * editor/panels/PhysicsLayersWindow.js
 *
 * Unity-style Physics Layer Manager panel.
 * Opened via Edit > Physics Layers...
 *
 * Shows all 16 layer slots as a list.  Each slot has:
 *   - its index (read-only)
 *   - a text input to name/rename it (clearing removes the layer;
 *     slot 0 "Default" cannot be cleared)
 *
 * Naming a blank slot "activates" it — it will then appear in the
 * Inspector's Layer dropdown and "Collides With" checklist.
 *
 * All persistence is handled by editor/state/PhysicsLayers.js which
 * writes to localStorage so names survive reloads.
 *
 * EDITOR-ONLY FILE.
 */

import { editorState } from "../state/EditorState.js";
import { getLayerNames, LAYER_COUNT } from "../state/PhysicsLayers.js";

const PANEL_STYLE =
  "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);" +
  "background:#1e2330;border:1px solid #3a4560;border-radius:8px;" +
  "width:420px;max-height:80vh;display:flex;flex-direction:column;" +
  "z-index:1000;box-shadow:0 8px 32px rgba(0,0,0,.6);overflow:hidden;";

const BACKDROP_STYLE =
  "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999;";

const HEADER_STYLE =
  "display:flex;align-items:center;justify-content:space-between;" +
  "padding:12px 16px;border-bottom:1px solid #2e3a50;flex-shrink:0;";

const CLOSE_BTN_STYLE =
  "background:none;border:none;color:#8a93a0;cursor:pointer;font-size:16px;" +
  "line-height:1;padding:2px 6px;border-radius:3px;";

const SLOT_STYLE =
  "display:grid;grid-template-columns:32px 1fr;align-items:center;gap:8px;" +
  "padding:4px 16px;";

const INDEX_STYLE =
  "font-size:10px;color:#5a6480;text-align:right;font-variant-numeric:tabular-nums;";

const INPUT_STYLE =
  "width:100%;background:#151b28;color:#c8d0de;border:1px solid #2e3a50;" +
  "border-radius:4px;padding:4px 8px;font-size:11px;box-sizing:border-box;";

const HINT_STYLE =
  "font-size:10px;color:#5a6480;padding:8px 16px 12px;border-top:1px solid #1a2030;" +
  "flex-shrink:0;line-height:1.5;";

export function renderPhysicsLayersWindow() {
  if (!editorState.physicsLayersOpen) return "";

  const names = getLayerNames();

  const slots = Array.from({ length: LAYER_COUNT }, (_, i) => {
    const name = names[i];
    const isDefault = i === 0;
    const isEmpty = !name.trim();

    return (
      '<div class="pl-slot" style="' + SLOT_STYLE + (isEmpty ? "opacity:0.55;" : "") + '">' +
        '<span style="' + INDEX_STYLE + '">' + i + '</span>' +
        '<input ' +
          'type="text" ' +
          'class="pl-name-input" ' +
          'data-action="pl-rename" ' +
          'data-layer-index="' + i + '" ' +
          'value="' + _escAttr(name) + '" ' +
          'placeholder="' + (isDefault ? "Default" : "Layer " + i) + '" ' +
          (isDefault ? 'title="Slot 0 (Default) cannot be removed." ' : '') +
          'style="' + INPUT_STYLE + (isEmpty ? "border-color:#1e2840;" : "") + '" ' +
        '/>' +
      '</div>'
    );
  }).join('');

  return (
    '<div data-action="close-physics-layers" style="' + BACKDROP_STYLE + '"></div>' +
    '<div class="physics-layers-window" style="' + PANEL_STYLE + '">' +
      '<div style="' + HEADER_STYLE + '">' +
        '<span style="font-size:13px;font-weight:600;color:#c8d0de;">Physics Layers</span>' +
        '<button data-action="close-physics-layers" style="' + CLOSE_BTN_STYLE + '">✕</button>' +
      '</div>' +
      '<div style="overflow-y:auto;padding:8px 0;flex:1;">' +
        '<div style="font-size:10px;color:#5a6480;padding:4px 16px 8px;letter-spacing:0.04em;">LAYER SLOTS (0 – 15)</div>' +
        slots +
      '</div>' +
      '<div style="' + HINT_STYLE + '">' +
        'Type a name to activate a slot · Clear to deactivate · Slot 0 (Default) is always present' +
      '</div>' +
    '</div>'
  );
}

function _escAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
