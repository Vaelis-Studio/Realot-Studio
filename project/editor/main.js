/**
 * editor/main.js
 *
 * Editor bootstrap and root render() function. This is the editor's
 * single entry point — it imports panels, viewport, and event wiring,
 * and is the only file that assembles the full app shell.
 *
 * This file (and everything else under /editor) may import from
 * /runtime, but nothing in /runtime may ever import from /editor.
 * See /RULES.txt.
 */

import { renderToolbar } from "./panels/Toolbar.js";
import { renderHierarchy } from "./panels/Hierarchy.js";
import { renderViewport } from "./panels/Viewport.js";
import { renderInspector } from "./panels/Inspector.js";
import { renderBottom } from "./panels/BottomPanel.js";
import { renderAnimEditor } from "./panels/AnimationWindow.js";
import { renderTilesetEditor } from "./panels/TilesetPanel.js";
import { renderScriptEditor, mountScriptEditor } from "./panels/ScriptEditorWindow.js";
import { renderPhysicsLayersWindow } from "./panels/PhysicsLayersWindow.js";
import { renderNavAreasWindow } from "./panels/NavAreasWindow.js";
import { renderScriptPickerWindow } from "./panels/ScriptPickerWindow.js";
import { renderSpritePickerWindow } from "./panels/SpritePickerWindow.js";
import { renderAddComponentWindow } from "./panels/AddComponentWindow.js";
import { renderExportWindow } from "./panels/ExportWindow.js";
import { renderStatusBar, startLiveStats } from "./panels/StatusBar.js";
// IMPORTANT: import this WITHOUT any "?..." query string. A prior
// version of this line was "./viewport/SceneViewport.js?v=2" as a
// (unnecessary — see the no-cache meta tags + main.js's own "?t="
// cache-bust in index.html, which already force-revalidate every
// transitive import) manual cache-bust attempt. Per the ES module
// spec, "./x.js" and "./x.js?v=2" are two DIFFERENT module
// specifiers, so the browser loaded and ran TWO separate copies of
// SceneViewport.js — this file's copy (with its own "game"/"pixiApp"
// module state, actually initialized by createViewport() below) and
// a second, never-initialized copy that EditorEvents.js's plain
// "./viewport/SceneViewport.js" import resolved to instead. Every
// switchScene()/etc. call from EditorEvents.js was therefore running
// against a copy whose "game" was still null, silently no-op'ing
// (switchScene's own "if (!game) return false" guard) — which is why
// clicking a scene, or double-clicking a Freeform Light edge (also
// wired through this same file), appeared to do nothing at all.
// Keep every import of this file across the whole editor byte-for-
// byte identical (no query string on any of them) so they always
// resolve to the SAME module instance.
import { mountOrUpdateSceneViewport, getGame, detachViewportCanvas, isInitialProjectLoadDone } from "./viewport/SceneViewport.js";
import { openPlayWindow, closePlayWindow, isPlayWindowOpen, getPlayWindow, isTrustedPlayMessage, sendPlayPayload } from "./viewport/PlayWindow.js";
import { attachEditorEvents, loadProjectFromFile } from "./state/EditorEvents.js";
import { installAndroidBuildLeaveGuard } from "./state/AndroidBuildSession.js";
import { editorState, pushLog, dirtyState } from "./state/EditorState.js";
import { getEngineSettings } from "./state/EngineSettings.js";
import { installConsoleCapture } from "./state/ConsoleCapture.js";
import { initFocusScheduler, setRemotePlayFocus } from "./state/FocusScheduler.js";
import { startAutosave, getProjectIdentityFromUrl } from "./state/ProjectStorage.js";
import { setAutosaveStatus } from "./panels/StatusBar.js";
import { exportProject } from "./state/ProjectIO.js";

// Installed first, before anything else boots, so PIXI's own boot-time
// warnings/errors and any early uncaught exceptions are captured too.
installConsoleCapture();

// Wires index.html's early auto-recovery reload (see its own big
// comment block on window.__realotDirtyCheck) to the SAME
// dirtyState.isDirty flag this file's own beforeunload guard below
// checks, so a forced recovery reload can never silently discard
// unsaved work the way a plain location.replace() call used to.
// Assigned at true module-top-level — this runs the instant main.js's
// imports resolve, before boot() or render() have done anything, so
// there's no window where a recovery reload could fire with this still
// unset (the only way index.html's script could try to read this
// before it exists at all is if main.js itself never loaded, in which
// case index.html's own hasUnsavedChanges() correctly treats it as
// "can't tell, don't risk it" and allows the reload anyway).
window.__realotDirtyCheck = function () {
  return dirtyState.isDirty === true;
};

// Same pattern as __realotDirtyCheck just above, for index.html's
// recovery toast's "Save now" button. Deliberately a lazy wrapper
// rather than assigning editorState.saveNow directly: that property
// isn't set until boot() finishes (see the "editorState.saveNow ="
// line further down this file) and editorState.saveNow itself is only
// ever populated for a launcher-identified project in the first place
// (see EditorEvents.js's own comment on editorState.saveNow), so this
// checks for it at CALL time rather than assuming it exists the moment
// this file starts running.
window.__realotSaveNow = function () {
  if (typeof editorState.saveNow === "function") editorState.saveNow();
};

function render() {
  // reflect the popup being closed manually (e.g. the user clicked its
  // native close button) back onto the toolbar's Play button state
  if (editorState.isPlaying && !isPlayWindowOpen()) {
    editorState.isPlaying = false;
    editorState.isPaused = false;
  }

  // Each overlay/panel is rendered defensively: if one throws (e.g. a
  // storage access error in a sandboxed preview iframe), it must not
  // blank out the entire editor. We fall back to an empty string plus
  // a console log so the rest of the UI keeps working and the failure
  // is still visible for debugging.
  function safeRender(fn, label) {
    try {
      return fn();
    } catch (err) {
      console.error("[render] " + label + " failed:", err);
      return "";
    }
  }

  const panelVisible = editorState.panelVisible || {};

  const html =
    '<div class="unity-window">' +
    safeRender(renderToolbar, "Toolbar") +
    '<div class="main-layout">' +
    // Window menu: a hidden panel is left out of the layout completely
    // (not just made invisible), so the flex:1 viewport column takes its
    // space and the user gets a bigger area to build levels in.
    (panelVisible.hierarchy !== false
      ? '<div class="col-hierarchy">' + safeRender(renderHierarchy, "Hierarchy") + "</div>"
      : "") +
    '<div class="col-center">' +
    safeRender(renderViewport, "Viewport") +
    (panelVisible.assets !== false
      ? '<div class="col-bottom-wrap">' + safeRender(renderBottom, "BottomPanel") + "</div>"
      : "") +
    "</div>" +
    (panelVisible.inspector !== false
      ? '<div class="col-inspector">' + safeRender(renderInspector, "Inspector") + "</div>"
      : "") +
    "</div>" +
    safeRender(renderStatusBar, "StatusBar") +
    "</div>" +
    safeRender(renderAnimEditor, "AnimationWindow") +
    safeRender(renderTilesetEditor, "TilesetPanel") +
    safeRender(renderScriptEditor, "ScriptEditorWindow") +
    safeRender(renderPhysicsLayersWindow, "PhysicsLayersWindow") +
    safeRender(renderNavAreasWindow, "NavAreasWindow") +
    safeRender(renderScriptPickerWindow, "ScriptPickerWindow") +
    safeRender(renderSpritePickerWindow, "SpritePickerWindow") +
    safeRender(renderAddComponentWindow, "AddComponentWindow") +
    safeRender(renderExportWindow, "ExportWindow");

  const app = document.getElementById("app");

  // preserve focus / caret for the search input across re-render
  const active = document.activeElement;
  const wasSearchFocused = active && active.id === "hierarchy-search-input";
  const caret = wasSearchFocused ? active.selectionStart : null;
  const wasNameFocused = active && active.dataset && active.dataset.action === "rename-entity";
  const nameCaret = wasNameFocused ? active.selectionStart : null;
  const wasSceneRenameFocused = active && active.dataset && active.dataset.action === "rename-scene-input";
  const sceneRenameCaret = wasSceneRenameFocused ? active.selectionStart : null;
  const wasFolderRenameFocused = active && active.dataset && active.dataset.action === "rename-folder-input";
  const folderRenameCaret = wasFolderRenameFocused ? active.selectionStart : null;
  // Same caret-preservation need as hierarchy-search-input above: the
  // Add Component modal's search box (see AddComponentWindow.js) lives
  // inside the full #app innerHTML rebuild too, so without this every
  // keystroke would lose focus after the re-render triggered by
  // updating editorState.addComponentFilter.
  const wasAddCompSearchFocused = active && active.id === "addcomp-search-input";
  const addCompSearchCaret = wasAddCompSearchFocused ? active.selectionStart : null;

  // Preserve the Inspector's scroll position across re-render. Every
  // edit in the Inspector (typing a number, renaming the script, toggling
  // a checkbox) calls render(), which rebuilds the ENTIRE #app innerHTML
  // — including .inspector-body, a fresh element with scrollTop reset to
  // 0. Without this, any edit made after scrolling down (e.g. tweaking a
  // Rigidbody field, or the Script Name field further down the panel)
  // snapped the panel back to the top on every keystroke. Same read-
  // before/restore-after pattern as the focus/caret preservation above,
  // just for scroll offset instead of text-cursor position.
  const _inspectorBodyBefore = document.querySelector(".inspector-body");
  const _inspectorScrollTop = _inspectorBodyBefore ? _inspectorBodyBefore.scrollTop : null;

  // Park the live PixiJS canvas in a hidden holder BEFORE overwriting
  // the app shell. If the canvas remains inside #app when innerHTML
  // runs, PIXI's internal ResizeObserver/RAF callbacks can race with
  // the DOM removal and throw "node to be removed is no longer a child
  // of this node". Moving the canvas to a stable hidden parent OUTSIDE
  // #app prevents the conflict entirely. This is done inline here
  // (rather than only in SceneViewport.js's detachViewportCanvas) so
  // it takes effect immediately even if the browser serves a cached
  // copy of SceneViewport.js — main.js is always cache-busted via
  // import("./main.js?t=" + Date.now()).
  const _canvas = app.querySelector("canvas");
  if (_canvas) {
    let _hold = document.getElementById("_pixi-canvas-hold");
    if (!_hold) {
      _hold = document.createElement("div");
      _hold.id = "_pixi-canvas-hold";
      _hold.style.cssText =
        "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";
      document.body.appendChild(_hold);
    }
    _hold.appendChild(_canvas);
  }

  // Park the Monaco editor's DOM node in a hidden holder BEFORE
  // overwriting #app innerHTML. If the Monaco node stays inside #app
  // during the bulk innerHTML rebuild, its internal input textarea /
  // event wiring gets destroyed and the editor can no longer accept
  // typing after a tab switch, folder open, or API toggle (all of
  // which trigger renderFn). Moving the live node to a stable parent
  // outside #app keeps it intact; mountScriptEditor() re-attaches it.
  const _monacoEl = app.querySelector("#se-monaco-container .monaco-editor");
  if (_monacoEl) {
    let _mhold = document.getElementById("_monaco-node-hold");
    if (!_mhold) {
      _mhold = document.createElement("div");
      _mhold.id = "_monaco-node-hold";
      _mhold.style.cssText =
        "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";
      document.body.appendChild(_mhold);
    }
    _mhold.appendChild(_monacoEl);
  }

  // Set innerHTML with fallback: PIXI's ResizeObserver on the canvas can
  // race with the bulk innerHTML child-removal and throw "node to be
  // removed is no longer a child". If that happens, manually remove each
  // child individually (catching per-node failures) then retry.
  try {
    app.innerHTML = html;
  } catch (_domErr) {
    while (app.firstChild) {
      try { app.removeChild(app.firstChild); } catch (_) {}
    }
    app.innerHTML = html;
  }

  if (wasSearchFocused) {
    const el = document.getElementById("hierarchy-search-input");
    if (el) {
      el.focus();
      if (caret !== null) el.setSelectionRange(caret, caret);
    }
  }
  if (wasNameFocused) {
    const el = document.querySelector('[data-action="rename-entity"]');
    if (el) {
      el.focus();
      if (nameCaret !== null) el.setSelectionRange(nameCaret, nameCaret);
    }
  }
  if (wasAddCompSearchFocused) {
    const el = document.getElementById("addcomp-search-input");
    if (el) {
      el.focus();
      if (addCompSearchCaret !== null) el.setSelectionRange(addCompSearchCaret, addCompSearchCaret);
    }
  }
  const sceneRenameEl = document.querySelector('[data-action="rename-scene-input"]');
  if (sceneRenameEl) {
    sceneRenameEl.focus();
    if (wasSceneRenameFocused && sceneRenameCaret !== null) {
      sceneRenameEl.setSelectionRange(sceneRenameCaret, sceneRenameCaret);
    } else {
      sceneRenameEl.select(); // first appearance (just double-clicked, or a brand-new scene) — select all for easy overtyping
    }
  }
  const folderRenameEl = document.querySelector('[data-action="rename-folder-input"]');
  if (folderRenameEl) {
    folderRenameEl.focus();
    if (wasFolderRenameFocused && folderRenameCaret !== null) {
      folderRenameEl.setSelectionRange(folderRenameCaret, folderRenameCaret);
    } else {
      folderRenameEl.select(); // first appearance (just created, or just double-clicked) — select all for easy overtyping
    }
  }

  // Restore the Inspector's scroll position (see capture comment above).
  // Skipped when editorState.inspectorScrollTo is set — that's an explicit
  // "scroll to this section" request (e.g. right after adding a
  // component) further down, and that request should win over just
  // snapping back to wherever the panel happened to be before.
  if (_inspectorScrollTop !== null && !editorState.inspectorScrollTo) {
    const _inspectorBodyAfter = document.querySelector(".inspector-body");
    if (_inspectorBodyAfter) _inspectorBodyAfter.scrollTop = _inspectorScrollTop;
  }

  mountOrUpdateSceneViewport(render);
  mountScriptEditor();

  if (editorState.inspectorScrollTo) {
    const key = editorState.inspectorScrollTo;
    editorState.inspectorScrollTo = null;
    requestAnimationFrame(() => {
      const section = document.querySelector('.inspector-body [data-section-key="' + key + '"]');
      if (section) section.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  // Auto-scroll the console list to the newest entry after every render,
  // so fresh log lines are always visible without manual scrolling —
  // exactly how Unity's Console panel works.
  if (editorState.bottomTab === "console") {
    const consoleList = document.getElementById("console-list-el");
    if (consoleList) consoleList.scrollTop = consoleList.scrollHeight;
  }
}

function onTogglePlay(isPlaying) {
  const game = getGame();
  if (!game) return;
  if (isPlaying) {
    openPlayWindow(game);
  } else {
    closePlayWindow();
  }
}

/**
 * Formats a { scriptName, message, line, method, kind } error report
 * (see runtime/systems/ScriptSystem.js's _reportError / _formatError,
 * and the `err.kind` tags set by scripting/components/*API.js) into
 * one console line that always answers: which script, which line,
 * which lifecycle call, and — for API misuse — what category of
 * mistake it was and on what kind of object. The *API.js files already
 * wrote the specific sentence (e.g. "has no Rigidbody 2D", "not
 * available on a Static body", "does not exist") — this only adds the
 * category prefix and location so every error reads consistently.
 */
function formatScriptErrorLog(data) {
  if (data.scriptName === "(engine)") {
    return "[Engine/" + data.method + "] " + data.message;
  }
  const where = "'" + data.scriptName + "'" +
    (data.line && data.line !== "?" ? " line " + data.line : "") +
    " (" + data.method + "())";
  const prefix =
    data.kind === "missing-component" ? "[Missing Component] " :
    data.kind === "unsupported-body-type" ? "[Unsupported for this Body Type] " :
    data.kind === "unknown-api" ? "[Unknown API] " :
    "[Script Error] ";
  return prefix + where + ": " + data.message;
}

/**
 * Browsers only permit native fullscreen after a user activation. Attempt it
 * at startup for hosts that allow it, then complete the same request on the
 * first editor interaction in normal browsers. Rejections are deliberately
 * swallowed: a denied browser policy is expected, not an editor error.
 */
function requestEditorFullscreenWhenAllowed() {
  const root = document.documentElement;
  if (!root || typeof root.requestFullscreen !== "function") return;

  const request = () => {
    if (document.fullscreenElement || document.fullscreenEnabled === false) return;
    try {
      const pending = root.requestFullscreen({ navigationUI: "hide" });
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch (_) {
      // Some embedded hosts throw instead of returning a rejected promise.
    }
  };

  request();
  // Do not trap someone in fullscreen after they explicitly leave it.
  // This is just the one browser-required activation retry for startup.
  let activationRetryUsed = false;
  const onFirstActivation = () => {
    if (activationRetryUsed) return;
    activationRetryUsed = true;
    request();
  };
  document.addEventListener("pointerdown", onFirstActivation, { capture: true, passive: true });
  document.addEventListener("keydown", onFirstActivation, { capture: true });
}

function boot() {
  editorState.renderFn = render;
  attachEditorEvents(render, onTogglePlay);
  // Start every editor session with the Inspector notes collapsed. The
  // small info button is the explicit opt-in for showing guidance; this
  // prevents an older persisted "on" value from cluttering the Inspector
  // before the user asks to see it.
  document.body.classList.remove("show-component-notes");
  // Game Window Performance & FPS Priority: starts focus/blur + a
  // periodic hasFocus() poll on both this window and the Play popup,
  // so SceneViewport's PIXI ticker and StatusBar's FPS counter know
  // when to throttle in favor of the game. See FocusScheduler.js.
  initFocusScheduler(getPlayWindow);
  // Close script editor on Escape
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && editorState.scriptEditor.open) {
      editorState.scriptEditor.open = false;
      render();
    }
  });
  // Receive both script/engine error reports AND plain console.log/
  // warn/error calls from the play popup — Play mode runs in a
  // separate popup window/document (see editor/viewport/play-popup.js),
  // so without this bridge nothing a running script prints or throws
  // would ever reach the editor's own Console panel.
  window.addEventListener("message", function (e) {
    // Only the play window we opened, on the origin we opened it on. What it
    // says is still untrusted (game scripts can print anything): strings are
    // clipped and the console escapes them when rendering.
    if (!e.data || typeof e.data !== "object" || !isTrustedPlayMessage(e)) return;
    const clip = (v, max) => String(v == null ? "" : v).slice(0, max);
    switch (e.data.type) {
      case "realot_play_ready":
        sendPlayPayload();
        return;
      case "realot_play_focus":
        setRemotePlayFocus(e.data.focused === true);
        return;
      case "realot_console_log": {
        // A script's own console.log/warn/error call during Play mode.
        const level = e.data.level === "error" || e.data.level === "warn" ? e.data.level : "log";
        pushLog(level, clip(e.data.message, 4000));
        render();
        return;
      }
      case "realot_script_error":
        pushLog("error", formatScriptErrorLog({
          scriptName: clip(e.data.scriptName, 200),
          message: clip(e.data.message, 4000),
          line: clip(e.data.line, 20),
          method: clip(e.data.method, 100),
          kind: clip(e.data.kind, 50),
        }));
        render();
        return;
    }
  });
  startLiveStats(editorState);
  // Double-clicking a .rs file in the OS (when Realot is installed as an app)
  // launches the editor with that file. See "file_handlers" in
  // manifest.webmanifest. Unsupported browsers simply don't have launchQueue.
  if (window.launchQueue && typeof window.launchQueue.setConsumer === "function") {
    window.launchQueue.setConsumer(function (launchParams) {
      const handle = launchParams && launchParams.files && launchParams.files[0];
      if (!handle) return;
      handle.getFile()
        .then((file) => loadProjectFromFile(file, { skipReplaceConfirm: true }))
        .catch((err) => { pushLog("error", "Could not open the file: " + (err && err.message ? err.message : err)); render(); });
    });
  }
  // Resolve the launcher project identity ONCE, early — used below by
  // both the FSA backup status refresh and the autosave wiring
  // further down, so neither has to re-derive it separately.
  const identity = getProjectIdentityFromUrl();
  editorState.projectId = identity.isLauncherProject ? identity.id : null;
  // Refresh the cached "Extra Backup Storage" menu label from any
  // previously-granted FSA permission for THIS project — see
  // EditorState.js's fsaBackupEnabled doc comment for why this is a
  // cached flag rather than an inline call inside renderToolbar().
  // isFsaBackupEnabled() never prompts (see RealotPersistence.js), so
  // this is safe to call unconditionally on every boot with no user
  // gesture required.
  if (editorState.projectId && window.RealotPersistence && typeof window.RealotPersistence.isFsaBackupEnabled === "function") {
    window.RealotPersistence.isFsaBackupEnabled(editorState.projectId).then((enabled) => {
      if (enabled !== editorState.fsaBackupEnabled) {
        editorState.fsaBackupEnabled = enabled;
        render();
      }
    });
  }
  render();
  setInterval(() => {
    if (editorState.isPlaying && !isPlayWindowOpen()) render();
  }, 500);

  // Auto-save: every 1 minute, plus immediately whenever the user
  // actually leaves (tab hidden/closed/navigated away — see
  // ProjectStorage.js's startAutosave doc comment for why that stands
  // in for "disconnected" in a purely client-side editor). Only runs
  // for projects actually opened from the launcher (?project=<id>) —
  // an editor opened standalone has nowhere in the launcher's project
  // list to save back to.
  if (identity.isLauncherProject) {
    const autosave = startAutosave(
      () => {
        // Never save OVER a project's own snapshot with the blank
        // starter scene while the initial load from that same snapshot
        // is still in flight — see SceneViewport.js's
        // isInitialProjectLoadDone() doc comment.
        if (!isInitialProjectLoadDone()) return null;
        const game = getGame();
        if (!game) return null;
        return { projectId: identity.id, game, projectName: editorState.projectName || identity.name };
      },
      (result, reason, consecutiveFailures) => {
        setAutosaveStatus(result && result.ok ? "saved" : "error");
        // A single failed autosave tick can be a harmless transient
        // blip (a momentary IndexedDB lock, a tab backgrounding mid-
        // write) and isn't worth interrupting the user for — the
        // status-bar text above already covers that case quietly.
        // But once autosave has failed on 2 CONSECUTIVE attempts
        // (i.e. it's still broken a full AUTOSAVE_INTERVAL_MS later,
        // or failed on both an interval tick and a visibilitychange/
        // pagehide attempt), that's very unlikely to self-resolve —
        // most commonly this project has grown past what this
        // browser's storage will allow (localStorage AND IndexedDB
        // both rejected the write — see RealotPersistence.js's setItem)
        // — and continuing to work in this state risks real data
        // loss if the tab is ever closed. A native confirm() dialog
        // is used deliberately over a dismissible toast: it's the one
        // UI primitive guaranteed to block and be seen even by
        // someone who has the status bar out of view, and it doesn't
        // require building new modal/toast infrastructure this editor
        // doesn't otherwise have. Only fires ONCE per stretch of
        // failures (not on every failed tick after the 2nd) so it
        // can't turn into a nag loop — see the consecutiveFailures===2
        // guard below.
        if (!result?.ok && consecutiveFailures === 2) {
          const wantsExport = window.confirm(
            "Auto-save has failed twice in a row and your changes are currently only kept in this browser tab — " +
            "they will be LOST if you close this tab or it crashes.\n\n" +
            "This usually means the project has grown too large for this browser's storage.\n\n" +
            "Click OK to download a backup of your project now (File > Export), or Cancel to keep working " +
            "(auto-save will keep retrying in the background)."
          );
          if (wantsExport) {
            const game = getGame();
            const name = editorState.projectName || "Untitled Project";
            // Call exportProject() directly (same function
            // File > Export's "save-project" action uses — see
            // EditorEvents.js) rather than simulating a menu click:
            // more reliable (doesn't depend on a specific DOM element
            // existing right now) and skips that action's extra
            // window.prompt() for a project name, which would be an
            // unwelcome second popup to click through in what's
            // already an urgent "you might lose work" moment — the
            // project's current name is used as-is instead.
            if (game) {
              exportProject(game, name).catch((err) => {
                console.error("[Autosave] Manual backup export failed:", err);
              });
            }
          }
        }
      }
    );

    // Exposed so the toolbar's "Save Now" button (see Toolbar.js/
    // EditorEvents.js's "save-now" action) can trigger a real,
    // immediate save through the EXACT same path (same markClean(),
    // same onSaved reporting/status-bar update) as an automatic tick,
    // rather than a separate, possibly-drifting save implementation.
    editorState.saveNow = autosave.saveNow;

    // RELOAD/CLOSE GUARD: warns before a refresh, tab close, or
    // navigation away discards anything not yet on disk. This is
    // deliberately SEPARATE from the pagehide-triggered background
    // save above — that save is fire-and-forget and can't block the
    // unload to confirm it actually landed (IndexedDB writes are
    // async; the page can finish unloading before one completes,
    // especially for a large project that just spilled past
    // localStorage's quota — see RealotPersistence.js's setItem tiering).
    // beforeunload's preventDefault()/returnValue mechanism is the
    // ONLY standard way to make the browser pause and ask first, so
    // this listener's whole job is deciding WHETHER to trigger that
    // native prompt — purely by checking dirtyState.isDirty,
    // which UndoManager.js keeps up to date on every scene edit (see
    // EditorState.js's markDirty doc comment) and which markClean()
    // clears the instant a save actually succeeds. A project with no
    // unsaved changes never shows this prompt at all — reloading a
    // fully-saved project is always silent.
    window.addEventListener("beforeunload", (e) => {
      if (!dirtyState.isDirty) return;
      // Both of these are required for the prompt to show across
      // browsers — modern Chromium only needs preventDefault(), but
      // returnValue is kept for older/other engines that still read it.
      e.preventDefault();
      e.returnValue = "";
      return "";
    });
  }
}

requestEditorFullscreenWhenAllowed();
// Warn before a restart/reload/exit while an Android build is running, and
// cancel that server job if the user goes ahead anyway.
installAndroidBuildLeaveGuard();
boot();
