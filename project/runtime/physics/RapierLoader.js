/**
 * runtime/physics/RapierLoader.js
 *
 * Loads + initializes the Rapier2D WASM module exactly once (Rapier's
 * compat build ships its WASM inlined as base64, so this is a plain
 * dynamic import() + RAPIER.init() — no bundler/WASM-loader config
 * needed, matching this project's no-build-step setup). Cached as a
 * shared promise so every caller (editor Scene/Game viewport, the play
 * popup, the standalone player) gets back the SAME loaded module
 * without re-fetching or re-instantiating the WASM.
 *
 * RUNTIME-ONLY FILE.
 */

// The complete compat package is checked into vendor/ so the runtime can be
// exported and executed without npm, a CDN, or any other network dependency.
const LOCAL_RAPIER_URL = new URL(
  "../../vendor/@dimforge/rapier2d-compat/dist/rapier.mjs",
  import.meta.url,
);

let _loadPromise = null;

/**
 * @returns {Promise<any>} the initialized checked-in Rapier module
 */
export function loadRapier() {
  if (!_loadPromise) {
    _loadPromise = import(/* @vite-ignore */ LOCAL_RAPIER_URL.href).then(async (RAPIER) => {
      await RAPIER.init();
      return RAPIER;
    });
  }
  return _loadPromise;
}
