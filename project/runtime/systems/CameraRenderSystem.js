/**
 * runtime/systems/CameraRenderSystem.js
 *
 * Renders any Camera entity whose `renderToSpriteEntityId` is set into a
 * PIXI RenderTexture every frame and assigns that texture to the target
 * sprite — the standard minimap / security-camera technique. A script
 * opts a camera in via `this.camera.renderToSprite(find('Minimap'))`,
 * which stores the target sprite entity's id on the Camera component
 * (see components/Camera.js). This system reads that field, renders the
 * same worldContainer RenderSystem draws into (so lighting/tilemaps are
 * included), and overrides the target sprite's texture.
 *
 * Runs AFTER RenderSystem + LightingSystem so the worldContainer is
 * fully synced and lit for this frame before we capture it. The Main
 * Camera's screen transform (applied by RenderSystem._applyMainCameraOffset)
 * is saved, swapped for THIS camera's view, rendered into the texture,
 * and restored — so the screen render PIXI's own ticker does afterward
 * is unaffected.
 *
 * The target sprite is temporarily hidden during the capture so the
 * minimap doesn't recursively draw itself into its own texture.
 *
 * RUNTIME-ONLY FILE (depends on PIXI).
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { CAMERA } from "../components/Camera.js";
import { getCameraResolution } from "../core/CameraUtils.js";

const DEFAULT_CAMERA_SIZE = 5;

export class CameraRenderSystem extends System {
  /**
   * @param {PIXI.Container} worldContainer the same container RenderSystem
   *   draws sprites into (gameContentContainer) — rendered into each
   *   RenderTexture so the minimap shows the real lit world.
   * @param {import('./RenderSystem.js').RenderSystem} renderSystem used to
   *   look up the target sprite's live PIXI.Sprite by entity id.
   * @param {PIXI.Application} pixiApp owns the renderer used to render into
   *   the RenderTexture.
   */
  constructor(worldContainer, renderSystem, pixiApp) {
    super();
    this.worldContainer = worldContainer;
    this.renderSystem = renderSystem;
    this.pixiApp = pixiApp;
    /** @type {Map<string, { renderTexture: PIXI.RenderTexture, width: number, height: number, bg: PIXI.Graphics }>} */
    this._textures = new Map();
  }

  update(world) {
    const cameras = world.query(TRANSFORM, CAMERA);
    for (const entity of cameras) {
      const camera = entity.getComponent(CAMERA);
      const targetId = camera.renderToSpriteEntityId;
      if (!targetId) continue;

      const transform = entity.getComponent(TRANSFORM);
      const targetSprite = this.renderSystem.getSprite(targetId);
      if (!targetSprite) continue; // sprite not created yet this frame

      const { width, height } = getCameraResolution(camera);
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));

      let entry = this._textures.get(entity.id);
      if (!entry || entry.width !== w || entry.height !== h) {
        if (entry) {
          entry.renderTexture.destroy(true);
          entry.bg.destroy();
        }
        const renderTexture = PIXI.RenderTexture.create({ width: w, height: h });
        const bg = new PIXI.Graphics();
        this._textures.set(entity.id, { renderTexture, width: w, height: h, bg });
        entry = this._textures.get(entity.id);
      }

      // Save the worldContainer transform RenderSystem set for the Main
      // Camera this frame, swap in THIS camera's view, capture, restore.
      const saved = {
        x: this.worldContainer.x,
        y: this.worldContainer.y,
        scaleX: this.worldContainer.scale.x,
        scaleY: this.worldContainer.scale.y,
        rotation: this.worldContainer.rotation,
      };

      const zoom = DEFAULT_CAMERA_SIZE / Math.max(0.001, camera.size);
      const rotRad = (transform.rotation * Math.PI) / 180;
      this.worldContainer.scale.set(zoom);
      this.worldContainer.rotation = rotRad;
      const sx = transform.x * zoom;
      const sy = transform.y * zoom;
      const cos = Math.cos(rotRad);
      const sin = Math.sin(rotRad);
      this.worldContainer.x = w / 2 - (sx * cos - sy * sin);
      this.worldContainer.y = h / 2 - (sx * sin + sy * cos);

      // Hide the target sprite during capture so the minimap doesn't
      // draw itself recursively into its own texture.
      const wasVisible = targetSprite.visible;
      targetSprite.visible = false;

      // Fill the camera's background color first (clears the texture),
      // then render the world on top of it.
      const hex = PIXI.utils
        ? PIXI.utils.string2hex(camera.backgroundColor)
        : parseInt((camera.backgroundColor || "#000000").replace("#", "0x"));
      entry.bg.clear();
      entry.bg.beginFill(hex);
      entry.bg.drawRect(0, 0, w, h);
      entry.bg.endFill();
      this.pixiApp.renderer.render(entry.bg, { renderTexture: entry.renderTexture, clear: true });
      this.pixiApp.renderer.render(this.worldContainer, { renderTexture: entry.renderTexture, clear: false });

      targetSprite.visible = wasVisible;

      // Restore the Main Camera transform so PIXI's own screen render is
      // unaffected.
      this.worldContainer.x = saved.x;
      this.worldContainer.y = saved.y;
      this.worldContainer.scale.set(saved.scaleX, saved.scaleY);
      this.worldContainer.rotation = saved.rotation;

      // Override the target sprite's texture with the live camera feed.
      // RenderSystem re-assigns the spriteKey texture every frame, but it
      // runs BEFORE this system, so this assignment wins for this frame.
      targetSprite.texture = entry.renderTexture;
    }
  }

  /** Destroys all cached RenderTextures (call on scene teardown). */
  clear() {
    for (const entry of this._textures.values()) {
      entry.renderTexture.destroy(true);
      entry.bg.destroy();
    }
    this._textures.clear();
  }

  destroy() {
    this.clear();
  }
}
