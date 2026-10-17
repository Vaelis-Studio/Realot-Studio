/**
 * editor/viewport/SceneGrid.js
 *
 * Draws the editor-only grid + axes into a dedicated PIXI container that
 * sits ABOVE the runtime's RenderSystem container. None of this exists
 * in the standalone player. Selection/transform gizmos live in
 * TransformGizmo.js; the camera frame gizmo lives in CameraGizmo.js.
 */

export function drawSceneGrid(gridContainer) {
  const RANGE = 4000;

  const fine = new PIXI.Graphics();
  fine.lineStyle(1, 0x000000, 0.15);
  for (let x = -RANGE; x <= RANGE; x += 20) {
    fine.moveTo(x, -RANGE);
    fine.lineTo(x, RANGE);
  }
  for (let y = -RANGE; y <= RANGE; y += 20) {
    fine.moveTo(-RANGE, y);
    fine.lineTo(RANGE, y);
  }
  gridContainer.addChild(fine);

  const coarse = new PIXI.Graphics();
  coarse.lineStyle(1, 0x000000, 0.3);
  for (let x = -RANGE; x <= RANGE; x += 100) {
    coarse.moveTo(x, -RANGE);
    coarse.lineTo(x, RANGE);
  }
  for (let y = -RANGE; y <= RANGE; y += 100) {
    coarse.moveTo(-RANGE, y);
    coarse.lineTo(RANGE, y);
  }
  gridContainer.addChild(coarse);

  const axes = new PIXI.Graphics();
  axes.lineStyle(1, 0x8fc153, 0.6);
  axes.moveTo(-RANGE, 0);
  axes.lineTo(RANGE, 0);
  axes.lineStyle(1, 0x569ce4, 0.6);
  axes.moveTo(0, -RANGE);
  axes.lineTo(0, RANGE);
  gridContainer.addChild(axes);
}
