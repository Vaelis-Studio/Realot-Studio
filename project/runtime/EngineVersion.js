/**
 * runtime/EngineVersion.js
 *
 * Single source of truth for "what version of the engine is this build".
 * Two consumers rely on this being the ONE place the number lives:
 *
 *   1. editor/panels/StatusBar.js displays it in the bottom status strip.
 *   2. editor/state/ProjectIO.js stamps it into every saved project's
 *      manifest.json, and compares an incoming project's manifest
 *      version against this to warn the user when they're opening a
 *      project that was saved by a NEWER engine version than the one
 *      currently running (see ProjectIO.js's compareVersions()).
 *
 * Bump MAJOR for scene/manifest-format-breaking changes, MINOR for new
 * backward-compatible engine features, PATCH for fixes that don't
 * change save-format compatibility at all.
 *
 * RUNTIME-ONLY FILE.
 */

export const ENGINE_VERSION = "1.0.0";
