/**
 * editor/viewport/ViewportCamera.js
 *
 * Pan + zoom controls for the Scene viewport. Purely an editor-side
 * camera transform over the PIXI stage — does not touch game logic.
 */

import { editorState } from "../state/EditorState.js";

const MIN_ZOOM = 0.14;
// Maximum editor zoom-in; zoom-out is handled by MIN_ZOOM.
const MAX_ZOOM = 6;
// Default/starting zoom, 20% bigger than the previous 100% default.
const DEFAULT_ZOOM = 1.2;

export class ViewportCamera {
  /**
   * @param {PIXI.Application} pixiApp
   * @param {PIXI.Container} worldContainer the container entities render into
   */
  constructor(pixiApp, worldContainer) {
    this.pixiApp = pixiApp;
    this.worldContainer = worldContainer;
    this.worldContainer.scale.set(DEFAULT_ZOOM);
    this.zoomPercent = Math.round(DEFAULT_ZOOM * 100);
    this._panState = { dragging: false, lastX: 0, lastY: 0 };
    this._onZoomChange = null;
  }

  /** @param {(percent:number)=>void} cb */
  onZoomChange(cb) {
    this._onZoomChange = cb;
  }

  attach(mountEl) {
    const el = this.pixiApp.view;
    el.style.touchAction = "none";

    el.addEventListener("pointerdown", (e) => {
      const isPanTool = editorState.activeTool === "pan";
      const isMiddleClick = e.button === 1;
      if (!isPanTool && !isMiddleClick) return;
      this._panState.dragging = true;
      this._panState.lastX = e.clientX;
      this._panState.lastY = e.clientY;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {}
      this.updateCursor();
      e.preventDefault();
    });

    el.addEventListener("pointermove", (e) => {
      if (!this._panState.dragging) return;
      const dx = e.clientX - this._panState.lastX;
      const dy = e.clientY - this._panState.lastY;
      this.worldContainer.x += dx;
      this.worldContainer.y += dy;
      this._panState.lastX = e.clientX;
      this._panState.lastY = e.clientY;
    });

    const endPan = (e) => {
      if (!this._panState.dragging) return;
      this._panState.dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (err) {}
      this.updateCursor();
    };
    el.addEventListener("pointerup", endPan);
    el.addEventListener("pointercancel", endPan);
    el.addEventListener("pointerleave", (e) => {
      if (e.buttons === 0) endPan(e);
    });

    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const direction = e.deltaY < 0 ? 1 : -1;
        const factor = 1 + direction * 0.1;
        this.zoomAt(mouseX, mouseY, factor);
      },
      { passive: false }
    );

    this.updateZoomLabel();
    this.updateCursor();
  }

  zoomAt(screenX, screenY, factor) {
    const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.worldContainer.scale.x * factor));
    const actualFactor = newScale / this.worldContainer.scale.x;
    this.worldContainer.x = screenX - (screenX - this.worldContainer.x) * actualFactor;
    this.worldContainer.y = screenY - (screenY - this.worldContainer.y) * actualFactor;
    this.worldContainer.scale.set(newScale);
    this.updateZoomLabel();
  }

  /**
   * Centers the viewport on a world-space point, optionally zooming so a
   * bounding box (halfWidth/halfHeight, world units) comfortably fits —
   * used by the "F to focus" shortcut on the current selection.
   * @param {number} worldX
   * @param {number} worldY
   * @param {number} [halfWidth] world-space half extent to fit; omit to keep current zoom
   * @param {number} [halfHeight]
   */
  focusOn(worldX, worldY, halfWidth, halfHeight) {
    const el = this.pixiApp.view;
    const viewW = el.clientWidth || el.width;
    const viewH = el.clientHeight || el.height;

    let targetScale = this.worldContainer.scale.x;
    if (halfWidth != null && halfHeight != null && halfWidth > 0 && halfHeight > 0) {
      // Pad the fit so the framed object isn't flush against the edges.
      const padding = 1.5;
      const scaleForW = viewW / (halfWidth * 2 * padding);
      const scaleForH = viewH / (halfHeight * 2 * padding);
      targetScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(scaleForW, scaleForH)));
    }

    this.worldContainer.scale.set(targetScale);
    this.worldContainer.x = viewW / 2 - worldX * targetScale;
    this.worldContainer.y = viewH / 2 - worldY * targetScale;
    this.updateZoomLabel();
  }


  /** Returns the current visible world-space rectangle. */
  getVisibleWorldBounds(padding = 0) {
    const el = this.pixiApp.view;
    const width = el.clientWidth || el.width || 0;
    const height = el.clientHeight || el.height || 0;
    const scale = this.worldContainer.scale.x || 1;
    const minX = (-this.worldContainer.x) / scale - padding;
    const minY = (-this.worldContainer.y) / scale - padding;
    const maxX = (width - this.worldContainer.x) / scale + padding;
    const maxY = (height - this.worldContainer.y) / scale + padding;
    return { minX, minY, maxX, maxY };
  }

  updateZoomLabel() {
    this.zoomPercent = Math.round(this.worldContainer.scale.x * 100);
    if (this._onZoomChange) this._onZoomChange(this.zoomPercent);
  }

  updateCursor() {
    if (!this.pixiApp) return;
    const el = this.pixiApp.view;
    if (editorState.activeTool === "pan") {
      el.style.cursor = this._panState.dragging ? "grabbing" : "grab";
    } else {
      el.style.cursor = "default";
    }
  }
}
