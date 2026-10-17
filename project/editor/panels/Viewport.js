/**
 * editor/panels/Viewport.js
 *
 * The Scene/Game tab bar + viewport toolbar (2D toggle, lighting, zoom
 * label) wrapping the canvas mount point that SceneViewport.js attaches
 * a real PIXI Application to.
 */

import { icon } from "../icons/IconLibrary.js";
import { tabBtn } from "./UIComponents.js";
import { editorState } from "../state/EditorState.js";
import { getZoomPercent, isViewportRendererLost, isViewportRenderSyncFailed } from "../viewport/SceneViewport.js";

/**
 * Banner shown over the canvas when the GPU/renderer has silently
 * stopped drawing — see SceneViewport.js's isViewportRendererLost() /
 * isViewportRenderSyncFailed() doc comments for why this can happen
 * (most commonly memory pressure) with the rest of the editor UI,
 * including zoom/pan, looking completely normal. Without a visible
 * banner here, this failure mode is invisible unless the Console tab
 * happens to be open. `_pixi-viewport-canvas` is rebuilt on every full
 * render() (see SceneViewport.js's detachViewportCanvas doc comment),
 * so this banner is markup rendered fresh each time, same as the rest
 * of this file — no separate DOM lifecycle to manage.
 */
function _rendererLostBanner() {
  const lost = isViewportRendererLost();
  const syncFailed = !lost && isViewportRenderSyncFailed();
  if (!lost && !syncFailed) return "";
  const msg = lost
    ? "Renderer lost (often caused by low GPU memory) \u2014 waiting for it to recover. Your scene is safe; try closing other tabs/apps to free up memory."
    : "Rendering hit an error and paused \u2014 check the Console tab for details. Your scene data is unaffected.";
  return '<div class="viewport-renderer-lost-banner">' + icon("alerttriangle", 14) + "<span>" + msg + "</span></div>";
}

export function renderViewport() {
  const zoomPercent = getZoomPercent();
  return (
    '<div class="col-viewport-wrap">' +
    '<div class="tabbar">' +
    tabBtn(true, "Scene", "grid") +
    tabBtn(false, "Game", "monitor") +
    "</div>" +
    '<div class="viewport-toolbar2">' +
    "<button>2D</button><div class=\"vsep\"></div>" +
    "<button>" +
    icon("lightbulb", 10) +
    "</button>" +
    "<button>" +
    icon("info", 10) +
    "</button>" +
    '<div class="vsep"></div>' +
    '<span class="zoom-label" id="zoom-label">' +
    zoomPercent +
    "%</span>" +
    '<span class="pan-hint">' +
    (editorState.activeTool === "pan" ? "Drag to pan \u2022 Scroll to zoom" : "Select the Hand tool to pan \u2022 Scroll to zoom") +
    "</span>" +
    "</div>" +
    '<div class="viewport-canvas" id="pixi-viewport-canvas">' +
    _rendererLostBanner() +
    "</div>" +
    "</div>"
  );
}
