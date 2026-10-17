/**
 * js/data/EngineVersion.js
 *
 * Single source of truth for "what version of the Realot engine is this build"
 * ON THE LAUNCHER SIDE. The launcher (js/) is plain <script>-tag globals,
 * not ES modules, so it can't `import` project/runtime/EngineVersion.js
 * directly the way the editor does (see that file's own doc comment) —
 * this is the launcher's own copy of the same constant, kept in one
 * place here so InstallsView.js and store.js both read it instead of
 * each hardcoding (and inevitably drifting out of sync with) their own
 * version string.
 *
 * IMPORTANT: keep this in sync with project/runtime/EngineVersion.js's
 * ENGINE_VERSION whenever that one is bumped — there is no build step
 * in this project to enforce the two automatically matching.
 */
window.RealotVersion = "1.0.0";
