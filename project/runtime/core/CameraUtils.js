/**
 * runtime/core/CameraUtils.js
 *
 * Pure helper that resolves a Camera component's `aspectMode` down to an
 * exact pixel resolution. This is the SINGLE source of truth for "what
 * size is the exported/played screen" — the editor's camera gizmo and
 * the play-mode popup window both call this function, so the gizmo's
 * edges always exactly match what play mode (and a real export) shows.
 *
 * RUNTIME-ONLY FILE. Pure data in/out, no PIXI, no DOM.
 */

import { CameraAspectMode, ScalingMode } from "../components/Camera.js";

/**
 * @param {import('../components/Camera.js').Camera} camera
 * @returns {{ width: number, height: number }} exact screen resolution in pixels
 */
export function getCameraResolution(camera) {
  switch (camera.aspectMode) {
    case CameraAspectMode.PORTRAIT:
      return { width: camera.portraitWidth, height: camera.portraitHeight };
    case CameraAspectMode.SQUARE:
      return { width: camera.squareSize, height: camera.squareSize };
    case CameraAspectMode.CUSTOM:
      return { width: camera.customWidth, height: camera.customHeight };
    case CameraAspectMode.LANDSCAPE:
    default:
      return { width: camera.landscapeWidth, height: camera.landscapeHeight };
  }
}


/**
 * Resolves a Camera's screen-scaling settings (see Camera.js's
 * ScalingMode doc comment for what each mode means, and the block of
 * comments above each field for how the modifiers compose) down to an
 * exact transform for mapping the reference resolution onto whatever
 * real device screen size the game is actually running at — this is
 * the single source of truth both RenderSystem._applyMainCameraOffset
 * (for the real player/play-mode) and the editor's Game viewport call,
 * so behavior always matches between editing and playing.
 *
 * Pure function — no PIXI, no DOM, deterministic in/out — deliberately
 * easy to unit-test on its own before ever touching a real renderer.
 *
 * @param {import('../components/Camera.js').Camera} camera
 * @param {number} deviceWidth actual screen/canvas width in px
 * @param {number} deviceHeight actual screen/canvas height in px
 * @returns {{
 *   mode: string,               effective mode AFTER aspectRatioLock/allowStretching overrides resolve it
 *   scaleX: number, scaleY: number,
 *   contentWidth: number, contentHeight: number,  actual on-screen px size of the game content rect
 *   offsetX: number, offsetY: number,             top-left of the content rect within the device screen
 *   effectiveWidth: number, effectiveHeight: number, reference-resolution-space width/height actually visible (differs from the raw reference size only in Expand mode)
 *   barLeft: number, barRight: number, barTop: number, barBottom: number, px size of each bar edge (0 if not shown)
 * }}
 */
export function computeScreenFit(camera, deviceWidth, deviceHeight) {
  const { width: refW, height: refH } = getCameraResolution(camera);
  const devW = Math.max(1, deviceWidth);
  const devH = Math.max(1, deviceHeight);

  // Resolve the two safety overrides down to one effective mode FIRST,
  // so everything below only ever has to handle 4 unambiguous cases.
  let mode = camera.scalingMode || ScalingMode.FIT;
  if (mode === ScalingMode.STRETCH && !camera.allowStretching) mode = ScalingMode.FIT;
  if (mode === ScalingMode.EXPAND && camera.aspectRatioLock) mode = ScalingMode.FIT;

  let scaleX, scaleY;
  if (mode === ScalingMode.STRETCH) {
    scaleX = devW / refW;
    scaleY = devH / refH;
  } else if (mode === ScalingMode.EXPAND) {
    const scale = camera.keepHeight ? devH / refH : devW / refW;
    scaleX = scaleY = scale;
  } else if (mode === ScalingMode.FILL) {
    scaleX = scaleY = Math.max(devW / refW, devH / refH);
  } else {
    // FIT — also the downgrade target for both overrides above.
    scaleX = scaleY = Math.min(devW / refW, devH / refH);
  }

  // Keeps pixel art crisp instead of blurry at fractional scales. Not
  // applied to a genuine (allowStretching:true) Stretch, whose whole
  // point is exact-fill — integer steps would undermine that. NOTE:
  // flooring can reintroduce a small gap even in modes that normally
  // guarantee none (Fill, Expand) — that's an intentional, honest
  // trade-off (crisp integer steps vs. perfect coverage), not a bug;
  // see letterboxing/pillarboxing "On" below if you want that gap
  // visibly covered by a bar even outside Fit mode.
  if (camera.integerScaling && mode !== ScalingMode.STRETCH) {
    scaleX = Math.max(1, Math.floor(scaleX));
    scaleY = Math.max(1, Math.floor(scaleY));
  }

  const contentWidth = refW * scaleX;
  const contentHeight = refH * scaleY;
  const offsetX = (devW - contentWidth) / 2;
  const offsetY = (devH - contentHeight) / 2;
  const effectiveWidth = devW / scaleX;
  const effectiveHeight = devH / scaleY;

  const gapX = Math.max(0, devW - contentWidth);
  const gapY = Math.max(0, devH - contentHeight);

  // "Auto" only ever fills in the bar Fit mode is actually SUPPOSED to
  // have — "On" is the more aggressive "cover ANY gap, regardless of
  // why it exists" override (see the integer-scaling note above for
  // when that matters even outside Fit) — "Off" never paints at all,
  // even if a gap exists (left as the renderer's own clear color
  // instead of camera.barColor).
  const showPillar = camera.pillarboxing !== "Off" && (camera.pillarboxing === "On" ? gapX > 0 : gapX > 0 && mode === ScalingMode.FIT);
  const showLetter = camera.letterboxing !== "Off" && (camera.letterboxing === "On" ? gapY > 0 : gapY > 0 && mode === ScalingMode.FIT);

  return {
    mode,
    scaleX, scaleY,
    contentWidth, contentHeight,
    offsetX, offsetY,
    effectiveWidth, effectiveHeight,
    barLeft: showPillar ? gapX / 2 : 0,
    barRight: showPillar ? gapX / 2 : 0,
    barTop: showLetter ? gapY / 2 : 0,
    barBottom: showLetter ? gapY / 2 : 0,
  };
}

/**
 * Resolves the world-space rectangle the camera frames, centered on the
 * camera entity's Transform position. This rectangle IS the exact edge
 * of the exported/played screen — used to draw the camera gizmo in the
 * editor and to letterbox/crop the play-mode popup identically.
 *
 * @param {import('../components/Camera.js').Camera} camera
 * @param {{x:number,y:number}} transform camera entity's Transform
 * @returns {{ x: number, y: number, width: number, height: number, left: number, top: number, right: number, bottom: number }}
 */
export function getCameraWorldRect(camera, transform) {
  const { width, height } = getCameraResolution(camera);
  const x = transform ? transform.x : 0;
  const y = transform ? transform.y : 0;
  return {
    x,
    y,
    width,
    height,
    left: x - width / 2,
    top: y - height / 2,
    right: x + width / 2,
    bottom: y + height / 2,
  };
}
