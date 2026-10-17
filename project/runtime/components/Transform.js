/**
 * runtime/components/Transform.js
 *
 * Position / rotation / scale. Every entity that needs to exist in space
 * has one of these. Rotation is degrees (matches the editor's Inspector
 * field, converted to radians only at render time).
 *
 * RUNTIME-ONLY FILE.
 */

export const TRANSFORM = "Transform";

export class Transform {
  constructor({ x = 0, y = 0, z = 0, rotation = 0, scaleX = 1, scaleY = 1 } = {}) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.rotation = rotation; // degrees, around Z
    this.scaleX = scaleX;
    this.scaleY = scaleY;
  }

  /**
   * Move by a delta amount. The actual implementation both
   * this.translate(dx, dy) (ScriptAPI.js) and this.transform.translate(dx, dy)
   * (TransformAPI.js) call into — was previously missing entirely, so
   * BOTH of those shortcuts threw "t.translate is not a function" every
   * single time either was called, however it was written.
   * @param {number} dx
   * @param {number} dy
   */
  translate(dx, dy) {
    this.x += dx;
    this.y += dy;
  }
}
