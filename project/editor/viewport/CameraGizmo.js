/**
 * editor/viewport/CameraGizmo.js
 *
 * Draws the Main Camera's frame in the Scene viewport: a rectangle whose
 * edges are EXACTLY the edges of the exported/played game screen, sized
 * from the camera's aspectMode via runtime/core/CameraUtils.js (the same
 * function the play-mode popup uses). Editor-only chrome.
 */

import { CAMERA } from "../../runtime/components/Camera.js";
import { TRANSFORM } from "../../runtime/components/Transform.js";
import { getCameraWorldRect } from "../../runtime/core/CameraUtils.js";

/**
 * @param {PIXI.Container} container editor-only chrome layer to draw into
 * @param {import('../../runtime/core/World.js').World|null} world
 */
export function drawCameraGizmo(container, world) {
  container.removeChildren();
  if (!world) return;

  const cameraEntities = world.query(TRANSFORM, CAMERA);
  for (const entity of cameraEntities) {
    const camera = entity.getComponent(CAMERA);
    const transform = entity.getComponent(TRANSFORM);
    const rect = getCameraWorldRect(camera, transform);

    const g = new PIXI.Graphics();

    // dim everything outside the frame slightly so the "true screen"
    // reads clearly, without obscuring content inside it
    g.lineStyle(0);
    g.beginFill(0x000000, 0.35);
    const OUTER = 100000;
    g.drawRect(-OUTER, -OUTER, OUTER * 2, rect.top + OUTER); // above
    g.drawRect(-OUTER, rect.bottom, OUTER * 2, OUTER); // below
    g.drawRect(-OUTER, rect.top, rect.left + OUTER, rect.height); // left
    g.drawRect(rect.right, rect.top, OUTER, rect.height); // right
    g.endFill();

    // the frame edge itself — exact export boundary
    g.lineStyle(2, camera.isMain ? 0xffd23f : 0x777777, 0.95);
    g.drawRect(rect.left, rect.top, rect.width, rect.height);

    // corner brackets for clarity
    const bracket = 18;
    g.lineStyle(3, camera.isMain ? 0xffd23f : 0x777777, 1);
    const corners = [
      [rect.left, rect.top, 1, 1],
      [rect.right, rect.top, -1, 1],
      [rect.left, rect.bottom, 1, -1],
      [rect.right, rect.bottom, -1, -1],
    ];
    for (const [cx, cy, dx, dy] of corners) {
      g.moveTo(cx, cy + bracket * dy);
      g.lineTo(cx, cy);
      g.lineTo(cx + bracket * dx, cy);
    }

    // small camera icon triangle at the top-left of the frame
    g.lineStyle(0);
    g.beginFill(camera.isMain ? 0xffd23f : 0x777777, 1);
    g.drawRect(rect.left, rect.top - 16, 90, 14);
    g.endFill();

    const label = new PIXI.Text(
      camera.aspectMode + " " + Math.round(rect.width) + "x" + Math.round(rect.height),
      { fontSize: 10, fill: 0x1c1c1c, fontFamily: "monospace" }
    );
    label.x = rect.left + 4;
    label.y = rect.top - 15;
    container.addChild(g);
    container.addChild(label);
  }
}
