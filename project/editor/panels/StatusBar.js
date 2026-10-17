/**
 * editor/panels/StatusBar.js
 *
 * Bottom-most status strip. The initial HTML is rendered as part of the
 * editor's full DOM rebuild (render() in main.js), but the live values
 * (FPS, memory, object count) are updated independently via a lightweight
 * interval in startLiveStats() — querying getElementById and writing
 * textContent — so the numbers tick without rebuilding the entire editor
 * DOM 60 times a second.
 */

import { icon } from "../icons/IconLibrary.js";
import { ENGINE_VERSION } from "../../runtime/EngineVersion.js";
import { getEditorFrameInterval } from "../state/FocusScheduler.js";
import { dirtyState } from "../state/EditorState.js";

export function renderStatusBar() {
  return (
    '<div class="statusbar">' +
    '<div class="left">' +
    icon("info", 12) +
    '<span id="sb-autosave">Auto-save completed.</span>' +
    // Lightweight, always-visible companion to the #sb-autosave text
    // above: that span only updates on an actual autosave TICK (every
    // 60s, or on hide/close — see ProjectStorage.js's startAutosave),
    // so right after an edit it can still say "Auto-saved at 3:41 PM"
    // for up to a minute even though there ARE unsaved changes right
    // now. This span reflects editorState's dirty flag directly and
    // immediately (see EditorState.js's markDirty doc comment) so
    // there's always a truthful, at-a-glance answer to "do I need to
    // save before I close this tab" without waiting for the next tick.
    '<span id="sb-dirty" style="margin-left:8px;"></span>' +
    "</div>" +
    '<div class="right">' +
    '<span>Objects: <b id="sb-objects">0</b></span>' +
    '<span>FPS: <b id="sb-fps">—</b></span>' +
    '<span>Memory: <b id="sb-memory">—</b></span>' +
    '<span class="mono">version: ' + ENGINE_VERSION + '</span>' +
    "</div>" +
    "</div>"
  );
}

/**
 * Starts a lightweight live-update loop for the status bar's FPS,
 * memory, and object-count readouts. Call once at editor boot.
 *
 * FPS is measured with a requestAnimationFrame frame counter sampled
 * every 500 ms (accurate enough for a status readout, and far cheaper
 * than per-frame DOM writes). Memory uses performance.memory (Chromium)
 * when available; other browsers show "N/A" rather than a fake number.
 * Object count is read from the live World.
 *
 * @param {object} editorState
 */
export function startLiveStats(editorState) {
  let frames = 0;
  let lastSample = performance.now();
  let rafHandle = null;
  let timeoutHandle = null;
  let stopped = false;

  // FPS frame counter — counts frames, then converts to a rate when
  // the 500 ms sample interval fires below. Game Window Performance &
  // FPS Priority: this loop is itself continuous per-frame work, so
  // instead of always scheduling via requestAnimationFrame (which
  // wakes up every display refresh regardless of what it does once
  // awake), it schedules its OWN next wake-up using the current
  // editor frame interval — rAF when uncapped (interval 0, the normal
  // focused case), or a plain setTimeout at the throttled interval
  // once the Play popup has focus. That actually reduces how often
  // this loop wakes up at all, not just how much work it does once
  // awake, matching the same throttle the Scene Viewport's PIXI
  // ticker.maxFPS applies to rendering.
  function countFrame() {
    if (stopped) return;
    frames++;
    _scheduleNextFrame();
  }
  function _scheduleNextFrame() {
    const interval = getEditorFrameInterval();
    if (interval === 0) {
      rafHandle = requestAnimationFrame(countFrame);
    } else {
      timeoutHandle = setTimeout(countFrame, interval);
    }
  }
  _scheduleNextFrame();

  const interval = setInterval(() => {
    const now = performance.now();
    const elapsed = now - lastSample;
    const fps = elapsed > 0 ? Math.round((frames * 1000) / elapsed) : 0;
    lastSample = now;
    frames = 0;

    setText("sb-fps", String(fps));

    // Object count from the live world (entities map size — O(1)).
    const count = editorState.world ? editorState.world.entities.size : 0;
    setText("sb-objects", String(count));

    // Memory: performance.memory is Chromium-only and non-standard, but
    // the editor runs in a Chromium-based webview/iframe in practice.
    // measureUserAgentSpecificMemory requires cross-origin isolation
    // headers the editor iframe doesn't have, so we fall back to the
    // legacy API and gracefully show "N/A" where neither exists.
    const mem = performance.memory;
    if (mem && typeof mem.usedJSHeapSize === "number") {
      setText("sb-memory", formatMB(mem.usedJSHeapSize));
    } else {
      setText("sb-memory", "N/A");
    }

    // Unsaved-changes indicator (see renderStatusBar's #sb-dirty doc
    // comment) — piggybacks on this already-running 500ms tick rather
    // than a separate interval or a full render() on every single edit
    // (which would defeat the point of markDirty() being cheap to call
    // from UndoManager.js's high-frequency mutation choke points).
    const dirtyEl = document.getElementById("sb-dirty");
    if (dirtyEl) {
      if (dirtyState.isDirty) {
        dirtyEl.textContent = "● Unsaved changes";
        dirtyEl.style.color = "#e5c07b";
      } else {
        dirtyEl.textContent = "";
        dirtyEl.style.color = "";
      }
    }
  }, 500);

  // Return a cleanup handle (unused in practice — the editor lives for
  // the page lifetime — but keeps the function self-contained).
  return function stop() {
    stopped = true;
    clearInterval(interval);
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  };
}

/** Writes textContent into the element if it exists in the DOM right now. */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/**
 * Updates the "Auto-save completed." status text (see renderStatusBar's
 * #sb-autosave span above) to reflect the outcome of the most recent
 * autosave (see editor/state/ProjectStorage.js's startAutosave()).
 * Called directly by DOM id rather than going through a full editor
 * render() — same reasoning as startLiveStats()'s FPS/memory/object
 * counters above: a status-strip text update shouldn't force a whole
 * app rebuild.
 * @param {"saved"|"saving"|"error"} state
 */
export function setAutosaveStatus(state) {
  const el = document.getElementById("sb-autosave");
  if (!el) return;
  if (state === "saving") {
    el.textContent = "Saving\u2026";
    el.style.color = "";
  } else if (state === "error") {
    el.textContent = "Auto-save failed — changes kept in this tab only.";
    el.style.color = "#e06c75";
  } else {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.textContent = "Auto-saved at " + time + ".";
    el.style.color = "";
  }
}

function formatMB(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? Math.round(mb) + " MB" : mb.toFixed(1) + " MB";
}
