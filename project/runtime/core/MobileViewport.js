/**
 * runtime/core/MobileViewport.js
 *
 * Single source of truth for converting browser/client coordinates into the
 * PIXI renderer's logical screen space. CSS pixels, renderer logical pixels,
 * and the high-DPI canvas backing buffer are intentionally kept separate.
 * This prevents devicePixelRatio from being accidentally applied twice on
 * phones/tablets and keeps touch aligned when the canvas is CSS-scaled.
 */

export function getLogicalScreenSize(pixiApp, canvas) {
  const screen = pixiApp && pixiApp.screen;
  const w = screen && Number.isFinite(screen.width) ? screen.width : 0;
  const h = screen && Number.isFinite(screen.height) ? screen.height : 0;
  const rect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
  return {
    width: Math.max(1, w || (canvas && canvas.clientWidth) || (rect && rect.width) || 1),
    height: Math.max(1, h || (canvas && canvas.clientHeight) || (rect && rect.height) || 1),
  };
}

/** Convert browser client coordinates to PIXI logical screen coordinates. */
export function clientToScreen(clientX, clientY, canvas, pixiApp) {
  const rect = canvas.getBoundingClientRect();
  const logical = getLogicalScreenSize(pixiApp, canvas);
  const sx = rect.width > 0 ? logical.width / rect.width : 1;
  const sy = rect.height > 0 ? logical.height / rect.height : 1;
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top) * sy,
  };
}

/**
 * Convert browser client coordinates directly into a PIXI container's local
 * coordinate space. This is the correct path for both world input and
 * reference-resolution UI input because the container owns the exact same
 * camera/device-fit transform used to draw the game.
 */
export function clientToLocal(clientX, clientY, canvas, pixiApp, container) {
  const screen = clientToScreen(clientX, clientY, canvas, pixiApp);
  if (container && typeof container.toLocal === "function") {
    const local = container.toLocal(screen);
    return { x: local.x, y: local.y, screenX: screen.x, screenY: screen.y };
  }
  return { x: screen.x, y: screen.y, screenX: screen.x, screenY: screen.y };
}

/**
 * Pick a safe renderer resolution for phones/tablets. High-DPI rendering is
 * useful, but an unrestricted DPR can create enormous WebGL canvases and can
 * exceed mobile canvas limits or waste large amounts of memory. A 2x ceiling
 * keeps the common Retina/HiDPI benefit while avoiding 3x/4x mobile buffers.
 * The 4096 guard also protects older devices/iOS from oversized canvases.
 */
export function getSafeRendererResolution(width, height) {
  const dpr = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1;
  let resolution = Math.min(2, dpr);
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const maxDimension = Math.max(w, h);
  if (maxDimension * resolution > 4096) {
    resolution = Math.min(resolution, 4096 / maxDimension);
  }
  return Math.max(1, resolution);
}

/** Keep browser gestures/selection from fighting the game surface. */
export function prepareGameCanvas(canvas) {
  if (!canvas) return;
  canvas.style.touchAction = "none";
  canvas.style.userSelect = "none";
  canvas.style.webkitUserSelect = "none";
  canvas.style.webkitTouchCallout = "none";
  canvas.style.webkitTapHighlightColor = "transparent";
  canvas.setAttribute("draggable", "false");
}
