/**
 * editor/state/FocusScheduler.js
 *
 * Single source of truth for "should the editor be running at full
 * speed right now?" Everything that burns CPU/GPU on a per-frame
 * basis in the editor — the Scene Viewport's PIXI ticker
 * (SceneViewport.js), the FPS/memory/object-count readout
 * (StatusBar.js), and (in future) any other continuous per-frame work
 * — reads its target frame interval from here instead of each
 * maintaining its own focus-detection logic.
 *
 * Priority model (see the Game Window Performance & FPS Priority
 * spec): the GAME never yields to the editor. The editor yields to
 * the game. So "should the editor throttle" is really "is the Play
 * popup open AND currently the focused window" — not simply "is the
 * editor's own window blurred", since the editor should stay at full
 * speed if the person alt-tabs to, say, their code editor or a
 * browser devtools panel with no Play window involved at all. Only
 * the game window actively taking focus away from the editor triggers
 * the throttle-in-favor-of-the-game behavior this spec asks for.
 *
 * Detection combines two mechanisms, since either alone is unreliable
 * across a same-origin popup boundary in some browsers:
 *   1. focus/blur events on both the editor's own window AND the
 *      popup (event-driven — near-instant).
 *   2. A cheap periodic document.hasFocus() poll on both documents as
 *      a safety net (covers the rare case an event is missed, e.g. a
 *      focus change that happens while a tab is backgrounded).
 * Both documents are same-origin (play-popup.html is a plain relative
 * URL — see PlayWindow.js), so document.hasFocus() is available on
 * the popup with no postMessage round-trip needed, same reasoning
 * PlayWindow.js already uses for setPlayWindowPaused().
 *
 * EDITOR-ONLY FILE.
 */

import { getEngineSettings } from "./EngineSettings.js";

let _gameWindowFocused = false;
let _pollHandle = null;
let _remoteFocus = false; // popup-reported focus, used when the popup is cross-origin and document.hasFocus() is off-limits
let _getPlayWin = null; // lazy getter, wired by initFocusScheduler() to avoid a circular import with PlayWindow.js
const _listeners = new Set();

/**
 * Call once at editor boot. `getPlayWin` is a () => Window|null getter
 * (rather than importing PlayWindow.js directly) so this module has no
 * import-cycle with PlayWindow.js/SceneViewport.js — main.js wires the
 * one concrete getter in after all modules are loaded.
 * @param {() => (Window|null)} getPlayWin
 */
export function initFocusScheduler(getPlayWin) {
  _getPlayWin = getPlayWin;

  window.addEventListener("blur", _recompute);
  window.addEventListener("focus", _recompute);

  // Safety-net poll — cheap (a couple of property reads), so a low
  // frequency is plenty; this only exists to catch a missed event, the
  // blur/focus listeners above handle the normal case instantly.
  _pollHandle = setInterval(_recompute, 400);

  _recompute();
}

/**
 * Called by PlayWindow.js right after it opens/reuses the popup, so a
 * just-opened popup is picked up on its very next focus/blur event (or
 * at worst the next 400ms poll tick) without waiting for something
 * else to trigger a recompute first.
 */
/**
 * Cross-origin play popups can't be asked `document.hasFocus()`, so the
 * popup reports its own focus/blur through postMessage and PlayWindow's
 * trusted-message handler forwards it here.
 * @param {boolean} focused
 */
export function setRemotePlayFocus(focused) {
  _remoteFocus = !!focused;
  _recompute();
}

export function notifyPlayWindowChanged() {
  _recompute();
}

function _recompute() {
  const playWin = _getPlayWin ? _getPlayWin() : null;
  const popupOpen = !!(playWin && !playWin.closed);
  let popupFocused = false;
  if (popupOpen) {
    try {
      popupFocused = playWin.document.hasFocus();
    } catch (_) {
      // Cross-origin (the normal case when a separate play origin is
      // configured) or a mid-navigation popup document. Fall back to the
      // focus state the popup reported itself; false until it reports.
      popupFocused = _remoteFocus;
    }
  }
  if (!popupOpen) _remoteFocus = false;
  const next = popupOpen && popupFocused;
  if (next !== _gameWindowFocused) {
    _gameWindowFocused = next;
    for (const fn of _listeners) {
      try { fn(_gameWindowFocused); } catch (_) { /* one bad listener must not break the others */ }
    }
  }
}

/** True while the Play popup is open AND holds focus — i.e. the editor should be throttled. */
export function isGameWindowFocused() {
  return _gameWindowFocused;
}

/**
 * Subscribe to focus-priority changes. Returns an unsubscribe
 * function. Called back with the new isGameWindowFocused() value
 * immediately on change (not polled) — consumers that need a
 * per-frame value (like the PIXI ticker) should still call
 * isGameWindowFocused()/getEditorFrameInterval() directly each frame
 * rather than caching the callback argument, since those are cheap
 * reads; the callback exists for consumers that want to react to the
 * transition itself (e.g. resuming instantly, not waiting for their
 * next scheduled tick).
 * @param {(gameFocused: boolean) => void} fn
 */
export function onFocusPriorityChange(fn) {
  _listeners.add(fn);
  return function unsubscribe() {
    _listeners.delete(fn);
  };
}

/**
 * The minimum milliseconds that must elapse between editor frames
 * right now — 0 means "no throttle, run every rAF tick". Consumers
 * (PIXI ticker, StatusBar's FPS counter) compare elapsed time against
 * this each rAF callback and skip their frame if it hasn't passed yet.
 * Reads live from EngineSettings on every call (cheap — an object
 * property read off a cached settings object) so a future Settings
 * panel changing editorFpsFocused/Unfocused takes effect on the very
 * next frame with no extra wiring.
 * @returns {number}
 */
export function getEditorFrameInterval() {
  const s = getEngineSettings();
  const targetFps = _gameWindowFocused ? s.editorFpsUnfocused : s.editorFpsFocused;
  if (!targetFps || targetFps <= 0) return 0; // treat 0/invalid as unlimited, never divide by zero
  return 1000 / targetFps;
}

/** Cleanup — not used in practice (the editor lives for the page lifetime), kept for symmetry with StatusBar's stop() handle. */
export function stopFocusScheduler() {
  window.removeEventListener("blur", _recompute);
  window.removeEventListener("focus", _recompute);
  if (_pollHandle !== null) {
    clearInterval(_pollHandle);
    _pollHandle = null;
  }
  _listeners.clear();
}
