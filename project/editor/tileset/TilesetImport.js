/**
 * editor/tileset/TilesetImport.js
 *
 * Turns raw user input (one sprite-sheet-style image, or up to 16
 * standalone images) into spriteKeys ready to drop into a Tileset
 * component's slots (see runtime/components/Tileset.js) — the
 * authoring-time half of the autotile feature. The painting-time half
 * (deciding which slot to use as you draw) lives entirely in
 * runtime/systems/AutoTileRules.js + TilemapSystem.js and never touches
 * this file.
 *
 * EDITOR-ONLY FILE: does DOM/Image/Canvas slicing that has no business
 * inside /runtime, mirroring editor/animation/AnimationImport.js's
 * split for the exact same reason (see that file's header comment).
 * runtime/components/Tileset.js and runtime/systems/TilemapSystem.js
 * never call into this file — they just consume the spriteKeys it
 * produces via registerTexture().
 */

import { registerTexture } from "../../runtime/assets/AssetManager.js";
import { TILE_ROLE_ORDER } from "../../runtime/components/Tileset.js";

let _nextTileKeyId = 1;

/**
 * Slices ONE image into a 4x4 grid (equal-sized cells, no gutter
 * detection needed since tileset source images are expected to be a
 * clean 4x4 sheet) and returns one spriteKey per TILE_ROLE_ORDER slot,
 * in the same row-major order as the editor's 4x4 authoring grid.
 * @param {File} file
 * @returns {Promise<Record<string,{spriteKey:string,dataUrl:string}>>} role -> {spriteKey, dataUrl}
 */
export async function sliceTilesetImageIntoRoles(file) {
  const { img, width, height } = await _readImageFile(file);
  const cellW = width / 4;
  const cellH = height / 4;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0);

  const result = {};
  for (let i = 0; i < TILE_ROLE_ORDER.length; i++) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const role = TILE_ROLE_ORDER[i];

    const cellCanvas = document.createElement("canvas");
    cellCanvas.width = Math.max(1, Math.round(cellW));
    cellCanvas.height = Math.max(1, Math.round(cellH));
    cellCanvas
      .getContext("2d")
      .drawImage(canvas, col * cellW, row * cellH, cellW, cellH, 0, 0, cellCanvas.width, cellCanvas.height);

    const dataUrl = cellCanvas.toDataURL("image/png");
    const key = "tile_" + _nextTileKeyId++;
    const texture = new PIXI.Texture(PIXI.BaseTexture.from(cellCanvas));
    registerTexture(key, texture);
    result[role] = { spriteKey: key, dataUrl };
  }
  return result;
}

/**
 * Loads ONE standalone image as a single role's texture — used when
 * the user drags/drops (or file-picks) an individual image straight
 * into one of the 16 slots rather than importing a whole 4x4 sheet.
 * @param {File} file
 * @returns {Promise<{spriteKey:string, dataUrl:string}>}
 */
export async function loadSingleTileImage(file) {
  const { img, dataUrl } = await _readImageFile(file);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const key = "tile_" + _nextTileKeyId++;
  const texture = new PIXI.Texture(PIXI.BaseTexture.from(canvas));
  registerTexture(key, texture);
  return { spriteKey: key, dataUrl };
}

function _readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onload = () => {
      const dataUrl = reader.result;
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to decode image: " + file.name));
      img.onload = () => resolve({ img, dataUrl, width: img.naturalWidth, height: img.naturalHeight });
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}
