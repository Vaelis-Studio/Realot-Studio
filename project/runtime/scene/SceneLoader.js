/**
 * runtime/scene/SceneLoader.js
 *
 * Higher-level scene helpers: loading from a URL/JSON, validating that a
 * scene has exactly one Main Camera, and producing the engine's default
 * starter scene (used for new projects and as the editor's blank canvas).
 *
 * RUNTIME-ONLY FILE.
 */

import { deserializeScene } from "./SceneSerializer.js";
import { TRANSFORM } from "../components/Transform.js";
import { CAMERA } from "../components/Camera.js";

/**
 * @param {import('../core/World.js').World} world
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateScene(world) {
  const errors = [];
  const cameras = world.query(TRANSFORM, CAMERA).filter((e) => e.getComponent(CAMERA).isMain);

  if (cameras.length === 0) errors.push("Scene has no Main Camera.");
  if (cameras.length > 1) errors.push("Scene has more than one Main Camera; only one is allowed.");

  return { ok: errors.length === 0, errors };
}

/**
 * Fetches a scene JSON file and loads it into the World.
 * @param {import('../core/World.js').World} world
 * @param {string} url
 */
export async function loadSceneFromUrl(world, url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("[SceneLoader] Failed to fetch scene: " + url + " (" + response.status + ")");
  }
  const sceneData = await response.json();
  deserializeScene(world, sceneData);
  return world;
}

/**
 * Builds the engine's default starter scene: a single Main Camera.
 * @param {import('../core/World.js').World} world
 */
export function loadDefaultScene(world) {
  return deserializeScene(world, {
    sceneName: "Main Scene",
    entities: [
      {
        name: "Main Camera",
        tag: "MainCamera",
        active: true,
        components: {
          [TRANSFORM]: { x: 0, y: 0 },
          [CAMERA]: { isMain: true },
        },
      },
    ],
  });
}
