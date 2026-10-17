/**
 * editor/state/EngineSettings.js
 *
 * Performance settings: independent FPS targets for the editor (when
 * focused vs. unfocused) and for the game/Play window, plus a couple
 * of related toggles. Read by:
 *   - SceneViewport.js's PIXI ticker + StatusBar.js's FPS counter,
 *     which throttle themselves against editorFocused/editorUnfocused
 *     depending on window focus (see FocusScheduler.js).
 *   - PlayWindow.js, which forwards gameFps to the popup via the same
 *     payload it already uses for scene data (the play-window payload),
 *     and play-popup.js, which applies it to GameLoop's targetFps.
 *
 * Persistence: a single JSON object in localStorage, same defensive
 * try/catch + in-memory-fallback pattern as PhysicsLayers.js — a
 * sandboxed preview iframe blocking localStorage must never break the
 * editor, worst case settings just don't survive a reload.
 *
 * These are placeholder values today ("Future Settings" — no settings
 * UI exists yet to change them), but every consumer reads through
 * getEngineSettings() rather than hardcoding numbers, so wiring up a
 * real Settings panel later is just adding UI that calls
 * setEngineSetting() — none of the throttling code will need to change.
 *
 * EDITOR-ONLY FILE.
 */

const STORAGE_KEY = "realot_engine_settings";

/** Allowed values for gameFps — mirrors the spec's 4 options exactly.
 *  0 means "Unlimited" (no cap; game runs as fast as rAF allows). */
export const GAME_FPS_OPTIONS = [30, 60, 120, 0];

function _defaults() {
  return {
    editorFpsFocused: 60,
    editorFpsUnfocused: 24, // within the spec's documented 20-30 range
    gameFps: 60, // 30 | 60 | 120 | 0 (0 = Unlimited)
    backgroundRendering: true, // keep the editor rendering (throttled) rather than fully pausing when unfocused
    vsync: true,
    // Off by default: the Inspector's informational "static-body-note"
    // hints (one per component, e.g. "Aimed using this object's
    // Transform > Rotation.") add up to a lot of small gray text once
    // several components are on one entity. Actionable warnings (the
    // orange ⚠️ ones, e.g. "No Collider 2D...") are a separate class
    // and are NOT gated by this — see Inspector.js's static-body-note
    // vs static-body-warning split.
    showComponentNotes: false,
  };
}

let _sessionCache = null;

/**
 * Load the full settings object. Always returns a well-formed object
 * with every key present, defaulting any missing/invalid field
 * individually so a partially-corrupt saved value (e.g. from an older
 * schema) never breaks the rest.
 * @returns {{editorFpsFocused:number, editorFpsUnfocused:number, gameFps:number, backgroundRendering:boolean, vsync:boolean}}
 */
export function getEngineSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const d = _defaults();
        return {
          editorFpsFocused: _num(parsed.editorFpsFocused, d.editorFpsFocused),
          editorFpsUnfocused: _num(parsed.editorFpsUnfocused, d.editorFpsUnfocused),
          gameFps: GAME_FPS_OPTIONS.indexOf(parsed.gameFps) >= 0 ? parsed.gameFps : d.gameFps,
          backgroundRendering: typeof parsed.backgroundRendering === "boolean" ? parsed.backgroundRendering : d.backgroundRendering,
          vsync: typeof parsed.vsync === "boolean" ? parsed.vsync : d.vsync,
          showComponentNotes: typeof parsed.showComponentNotes === "boolean" ? parsed.showComponentNotes : d.showComponentNotes,
        };
      }
    }
  } catch (_) {
    if (_sessionCache) return _sessionCache;
  }
  return _sessionCache || _defaults();
}

function _num(v, fallback) {
  return typeof v === "number" && v > 0 && isFinite(v) ? v : fallback;
}

/**
 * Merge-updates one or more settings and persists. Same
 * try/catch-and-fall-back-to-session-cache defensiveness as
 * PhysicsLayers.setLayerName — a blocked localStorage never breaks
 * the editor, it just won't survive a reload.
 * @param {Partial<ReturnType<typeof getEngineSettings>>} patch
 */
export function setEngineSettings(patch) {
  const merged = Object.assign({}, getEngineSettings(), patch);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch (_) { /* ignore: storage unavailable in this environment */ }
  _sessionCache = merged;
  return merged;
}
