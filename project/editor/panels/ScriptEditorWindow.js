/**
 * editor/panels/ScriptEditorWindow.js
 *
 * Full-screen Monaco code editor for Realot scripts. Loaded from the
 * packaged vendor files on first open. Features: dark theme, tabs, auto-save, syntax
 * highlighting, line numbers, code folding, find & replace, minimap,
 * a Scripts folder sidebar (every stored script, one click to open),
 * and context-aware IntelliSense (see ScriptIntelliSense.js).
 *
 * The editor NEVER executes user code — it's a text editor only.
 * Compilation and execution happen exclusively in the play-mode popup
 * via ScriptSystem (see runtime/systems/ScriptSystem.js).
 *
 * In-editor diagnostics (red squiggles) are disabled — script errors
 * surface only in the Console tab (see BottomPanel.js). The Monaco
 * instance is disposed on close so reopening always produces a
 * fresh, working editor (content survives via cached models).
 *
 * Also includes the API Management panel: a checklist of component
 * APIs that forces them to appear in autocomplete regardless of the
 * owning object's components.
 *
 * EDITOR-ONLY FILE.
 */

import { editorState, pushLog, markDirty } from "../state/EditorState.js";
import { getScriptSource, saveScript, getAllScripts, renameScript, scriptExists, deleteScript, onScriptsReplaced } from "../scripting/ScriptStorage.js";
import { registerIntelliSense, refreshScriptDiagnostics, clearScriptDiagnostics } from "../scripting/ScriptIntelliSense.js";
import { refreshSyntaxCheck, disposeSyntaxCheck, renameSyntaxCheck } from "../scripting/ScriptSyntaxCheck.js";
import { defineRealotTheme, applyRealotDecorations, clearRealotDecorations, renameRealotDecorations } from "../scripting/ScriptHighlighting.js";

// Inject CSS once
(function () {
  if (document.getElementById("realot-script-editor-css")) return;
  var style = document.createElement("style");
  style.id = "realot-script-editor-css";
  style.textContent =
    ".script-editor-overlay{position:fixed;top:0;left:0;right:0;bottom:0;z-index:100000;background:#1e1e1e;display:flex;flex-direction:column;}" +
    ".script-editor-topbar{display:flex;align-items:center;justify-content:space-between;background:#252526;border-bottom:1px solid #3c3c3c;padding:0 4px;height:40px;flex-shrink:0;}" +
    ".se-tabs{display:flex;gap:0;overflow-x:auto;flex:1;}" +
    ".se-tab{display:flex;align-items:center;gap:4px;padding:6px 12px;background:#2d2d2d;border:1px solid #3c3c3c;border-bottom:none;border-radius:4px 4px 0 0;cursor:pointer;color:#cccccc;font-size:12px;white-space:nowrap;}" +
    ".se-tab-active{background:#1e1e1e;color:#ffffff;border-bottom:2px solid #007acc;}" +
    ".se-tab-close{background:none;border:none;color:#888;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;}" +
    ".se-tab-close:hover{color:#f48771;}" +
    ".se-actions{display:flex;gap:4px;align-items:center;flex-shrink:0;padding-left:8px;}" +
    ".se-btn{padding:5px 12px;background:#3c3c3c;border:1px solid #505050;border-radius:3px;color:#cccccc;cursor:pointer;font-size:12px;}" +
    ".se-btn:hover{background:#4c4c4c;color:#fff;}" +
    ".se-btn-active{background:#0e639c;border-color:#1177bb;color:#fff;}" +
    ".se-btn-close:hover{background:#a12628;border-color:#c43131;color:#fff;}" +
    ".se-api-panel{background:#252526;border-bottom:1px solid #3c3c3c;flex-shrink:0;}" +
    ".se-api-item{display:flex;align-items:center;gap:4px;color:#cccccc;font-size:12px;cursor:pointer;padding:3px 8px;background:#333;border:1px solid #444;border-radius:3px;}" +
    ".se-api-item:hover{background:#3c3c3c;}" +
    ".se-api-item input{margin:0;cursor:pointer;}" +
    ".se-body{display:flex;flex:1;min-height:0;}" +
    ".se-sidebar{width:210px;background:#252526;border-right:1px solid #3c3c3c;overflow-y:auto;flex-shrink:0;display:flex;flex-direction:column;}" +
    ".se-sidebar-header{padding:8px 12px;font-size:11px;color:#8a93a0;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #3c3c3c;position:sticky;top:0;background:#252526;z-index:1;}" +
    ".se-script-item{display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;color:#cccccc;font-size:12px;border-bottom:1px solid #2d2d2d;}" +
    ".se-script-item:hover{background:#2d2d2d;}" +
    ".se-script-item.active{background:#094771;color:#fff;}" +
    ".se-script-ico{color:#dcdcaa;font-size:10px;font-weight:600;background:#37373d;border-radius:3px;padding:1px 4px;flex-shrink:0;}" +
    ".se-script-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}" +
    ".se-script-owners{font-size:10px;color:#8a93a0;background:#333;border-radius:8px;padding:1px 6px;flex-shrink:0;}" +
    ".se-script-item.active .se-script-owners{background:#0b3a5e;color:#cce4ff;}" +
    ".se-editor-area{flex:1;overflow:hidden;min-height:0;}" +
    ".se-statusbar{background:#007acc;color:#fff;font-size:11px;padding:2px 12px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;}" +
    "@media(max-width:600px){.se-btn{padding:5px 8px;font-size:11px;}.se-tab{padding:6px 8px;font-size:11px;}.se-sidebar{width:150px;}}";
  document.head.appendChild(style);
})();

let _monaco = null;
let _monacoLoading = false;
let _monacoLoadCallbacks = [];
let _editor = null;
let _models = {}; // scriptName -> monaco.editor.ITextModel
let _saveTimer = null;
let _diagTimer = null;
let _apiPanelOpen = false;

const MONACO_LOADER_URL = "../vendor/monaco-editor/min/vs/loader.js";
const MONACO_BASE = "../vendor/monaco-editor/min/vs";

function _ensureMonaco(callback) {
  if (_monaco) { callback(_monaco); return; }
  _monacoLoadCallbacks.push(callback);
  if (_monacoLoading) return;
  _monacoLoading = true;

  const existing = document.querySelector('script[src="' + MONACO_LOADER_URL + '"]');
  if (existing) {
    // Already loading — wait for it. Capped at 15s: if the first
       // attempt's script tag failed, our
    // onerror handler doesn't remove the tag, so a retry would
    // otherwise land here and poll window.monaco forever with nothing
    // ever telling the user why the editor is still empty.
    var _waited = 0;
    const check = setInterval(() => {
      if (window.monaco) {
        clearInterval(check);
        _monaco = window.monaco;
        _monacoLoading = false;
        _monacoLoadCallbacks.forEach(function (cb) { cb(_monaco); });
        _monacoLoadCallbacks = [];
        return;
      }
      _waited += 100;
      if (_waited >= 15000) {
        clearInterval(check);
        _monacoLoading = false;
        _reportMonacoLoadFailure(new Error("Timed out waiting for Monaco to load"));
      }
    }, 100);
    return;
  }

  const script = document.createElement("script");
  script.src = MONACO_LOADER_URL;
  script.onload = function () {
    window.require.config({ paths: { vs: MONACO_BASE } });
    window.require(
      ["vs/editor/editor.main"],
      function () {
        _monaco = window.monaco;
        _monacoLoading = false;
        // Configure Monaco to suppress browser-global suggestions.
        _monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
          noLib: true,
          allowNonTsExtensions: true,
        });
        // Monaco's OWN automatic JS/TS diagnostics stay off — Realot
        // scripts reference dozens of engine-injected globals
        // (this.rigidbody, nav, find(), …) that no static analysis of a
        // single file can resolve, so semantic checking would be
        // constant false-positive noise. Real syntax errors (unclosed
        // brackets, stray tokens) DO show as red squiggles, but via a
        // manual worker call against a cast-stripped shadow model —
        // see ScriptSyntaxCheck.js — never through this automatic path,
        // so a `x as Type` cast (valid Realot syntax, invalid plain
        // JS) is never flagged.
        _monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
          noSemanticValidation: true,
          noSyntaxValidation: true,
        });
        registerIntelliSense(_monaco);
        defineRealotTheme(_monaco);
        _monacoLoadCallbacks.forEach(function (cb) { cb(_monaco); });
        _monacoLoadCallbacks = [];
      },
      // AMD errback: fires if vs/editor/editor.main itself fails to
       // load (e.g. the loader script loaded but a later local chunk is
       // missing). Without this, that failure was silently
      // swallowed exactly like the script.onerror case below —
      // _monacoLoading stays true forever and the editor area is just
      // a dead, empty div with no explanation.
      function (err) {
        _monacoLoading = false;
        _reportMonacoLoadFailure(err);
      }
    );
  };
  // THE ACTUAL BUG: previously there was no onerror handler here at
  // all. If this local vendor file is missing or fails for any reason,
  // the <script> tag
  // just never fires onload, _monaco stays null forever, no editor
  // instance is ever created, and #se-monaco-container is left as a
  // permanently empty div. The rest of the UI (tabs, sidebar, Close
  // button) still renders normally, so it LOOKS like the editor
  // opened fine — but no keystroke of any kind does anything, and
  // nothing is ever logged, because nothing ever threw. That matches
  // "everything works but typing/WASD/Space do nothing, no errors"
  // exactly. This handler makes that failure visible instead of silent.
  script.onerror = function () {
    _monacoLoading = false;
    _reportMonacoLoadFailure(new Error("Failed to load script: " + MONACO_LOADER_URL));
  };
  document.head.appendChild(script);
}

/**
 * Surfaces a Monaco load failure directly in the editor area (not just
 * the console, which the user may not have open) so it's obvious why
 * typing does nothing, instead of the editor silently sitting there as
 * a dead empty box. Also retries are possible afterward since
 * _monacoLoading was reset to false by the caller before this runs.
 */
function _reportMonacoLoadFailure(err) {
  console.error("[ScriptEditor] Monaco failed to load:", err);
  var container = document.getElementById("se-monaco-container");
  if (container) {
    container.innerHTML =
      '<div style="padding:24px;color:#f48771;font:13px/1.6 -apple-system,sans-serif;max-width:520px;">' +
      "<strong>Couldn't load the code editor.</strong><br/>" +
       "The packaged Monaco files could not be loaded — " +
       "one or more local vendor files may be missing or damaged.<br/><br/>" +
      "Close this window and reopen the script to retry once you have a connection." +
      "</div>";
  }
  // Reset callback queue so a later successful retry (new openScriptEditor
  // call) isn't stuck waiting on callbacks queued during the failed attempt.
  _monacoLoadCallbacks = [];
}

function _getModel(scriptName) {
  if (_models[scriptName]) return _models[scriptName];
  var source = getScriptSource(scriptName) || "";
  var model = _monaco.editor.createModel(source, "javascript");
  _models[scriptName] = model;
  return model;
}

function _openTab(scriptName) {
  if (!editorState.scriptEditor.openTabs.includes(scriptName)) {
    editorState.scriptEditor.openTabs.push(scriptName);
  }
  editorState.scriptEditor.activeTab = scriptName;
}

function _switchTab(scriptName) {
  editorState.scriptEditor.activeTab = scriptName;
  if (!_editor || !_monaco) return;
  // Cancel any debounced pass still pending from the tab we're leaving.
  // _editor.setModel() below repoints the SAME shared editor instance at
  // the new tab's model — but deltaDecorations() always applies to
  // whatever model _editor currently holds, not whatever model it held
  // when the timer was scheduled. Without this, a highlight/diagnostics
  // pass queued by a keystroke in the OLD tab can fire ~150-300ms later,
  // after we've already switched, and paint the old tab's decorations
  // onto the new tab's (now-active) model — looking exactly like "the
  // engine API just isn't colored" on the tab you're now looking at,
  // until your next keystroke there triggers a real rescan.
  clearTimeout(_diagTimer);
  clearTimeout(_highlightTimer);
  var model = _getModel(scriptName);
  _editor.setModel(model);
  // Immediate scan on switch (not debounced) — scene data may have
  // changed since this tab was last open (renamed object, deleted
  // texture, etc.), and there's no keystroke here to debounce against.
  refreshScriptDiagnostics(_monaco, model);
  // Same "immediate on switch" reasoning as refreshScriptDiagnostics
  // above — live JS syntax squiggles (see ScriptSyntaxCheck.js) should
  // reflect this tab's actual current content right away, not whatever
  // was scanned the last time it was open.
  refreshSyntaxCheck(_monaco, model, scriptName);
  // Immediate (not debounced) so switching tabs shows correct colors
  // right away instead of plain text until the user's next keystroke.
  applyRealotDecorations(_monaco, _editor, model, scriptName);
  // Explicitly focus Monaco. Every call path into this function follows
  // a DOM operation that silently drops focus — the initial
  // monaco.editor.create(), and (via mountScriptEditor -> _mountEditor)
  // the detach/reattach dance main.js's render() does to survive the
  // #app innerHTML rebuild (see the "_monacoEl" handling there). Moving
  // a DOM node, or creating a fresh editor instance, never preserves
  // keyboard focus on its own. Without this, the editor opens/switches
  // looking correct but focus is left on <body> (or wherever it was
  // before), so every keystroke — including WASD and Space — falls
  // through to the global document keydown listener in EditorEvents.js
  // and gets reinterpreted as an editor tool shortcut / Play toggle
  // instead of typing a single character into the script.
  _editor.focus();
}

function _closeTab(scriptName) {
  var idx = editorState.scriptEditor.openTabs.indexOf(scriptName);
  if (idx < 0) return;
  editorState.scriptEditor.openTabs.splice(idx, 1);
  if (_models[scriptName]) {
    // Cancel any pending debounced diagnostics/highlight pass for this
    // model BEFORE disposing it. _diagTimer/_highlightTimer are single
    // shared timers (see _scheduleDiagnostics/_scheduleHighlighting
    // below), so a keystroke just before closing this tab can leave one
    // scheduled — without this, it fires ~150-300ms later against a
    // model that no longer exists, throws, and (for highlighting)
    // leaves _decorationIds stale, i.e. the "coloring stops working"
    // bug this pass fixes.
    clearTimeout(_diagTimer);
    clearTimeout(_highlightTimer);
    clearScriptDiagnostics(_monaco, _models[scriptName]);
    // Disposes this tab's shadow model too (see ScriptSyntaxCheck.js) —
    // without this, every closed tab would leak one invisible Monaco
    // model forever for the lifetime of the editor session.
    disposeSyntaxCheck(_monaco, _models[scriptName], scriptName);
    _models[scriptName].dispose();
    delete _models[scriptName];
    clearRealotDecorations(scriptName);
  }
  if (editorState.scriptEditor.activeTab === scriptName) {
    editorState.scriptEditor.activeTab = editorState.scriptEditor.openTabs[0] || null;
  }
}

function _scheduleSave(scriptName) {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(function () {
    var model = _models[scriptName];
    if (!model) return;
    var source = model.getValue();
    saveScript(scriptName, source);
    // Sync back to every entity whose Script component uses this
    // script, so the scene serializes with the latest source.
    _syncSourceToEntities(scriptName, source);
    // Script edits are undo-scoped to Monaco's OWN history (see
    // UndoManager.js's file doc comment — _restore() explicitly
    // re-stamps each script's live source back after every scene/anim
    // undo or redo, so those stacks can't revert code even though
    // their snapshots do contain it), but dirty-tracking is a
    // SEPARATE concern from undo history: it's just "does this project
    // have unsaved changes right now" (see EditorState.js's markDirty
    // doc comment), and a script edit is exactly that, the same as a
    // scene edit. Before this call existed, editing a script never
    // marked the project dirty at all — the autosave indicator kept
    // showing "Saved" and the beforeunload reload/close guard never
    // fired, so a script-only change (no scene edit alongside it) could
    // silently be lost on tab close even though ScriptStorage.js had
    // technically already persisted it to localStorage — because a
    // project's canonical save (ProjectStorage.js's runSave) writes the
    // FULL snapshot including script source, and that snapshot save was
    // never triggered for a script-only edit.
    markDirty();
  }, 500);
}

// Re-validates string-argument values (entity names, key codes, texture
// names, etc.) against live scene/project data and shows typo squiggles.
// Debounced separately from auto-save (shorter delay is fine — this is a
// pure read-only scan, no disk/scene writes) so warnings appear quickly
// without re-running on every single keystroke.
function _scheduleDiagnostics(scriptName) {
  clearTimeout(_diagTimer);
  _diagTimer = setTimeout(function () {
    var model = _models[scriptName];
    if (!model || !_monaco) return;
    refreshScriptDiagnostics(_monaco, model);
    // Live JS syntax squiggles (unclosed brackets, stray tokens, etc) —
    // same debounce as the string-argument scan above, since both are
    // pure read-only passes triggered by the same keystrokes. See
    // ScriptSyntaxCheck.js for why `as` casts are never flagged here.
    refreshSyntaxCheck(_monaco, model, scriptName);
  }, 300);
}

let _highlightTimer = null;

// Re-scans the model for Realot API identifiers (input, this.sprite,
// .addForce, etc.) and re-applies the colored decorations from
// ScriptHighlighting.js. Debounced independently from save/diagnostics
// so a fast typist doesn't pay for three separate full-text scans per
// keystroke — this one only needs to be visually "soon", not saved or
// validated, so it can run on its own slightly longer cadence.
function _scheduleHighlighting(scriptName) {
  clearTimeout(_highlightTimer);
  _highlightTimer = setTimeout(function () {
    var model = _models[scriptName];
    if (!model || !_monaco || !_editor) return;
    applyRealotDecorations(_monaco, _editor, model, scriptName);
  }, 150);
}

function _syncSourceToEntities(scriptName, source) {
  if (!editorState.world) return;
  var entities = editorState.world.getAllEntities();
  for (var i = 0; i < entities.length; i++) {
    var comp = entities[i].getComponent("Script");
    if (comp && comp.scriptName === scriptName) {
      comp.source = source;
    }
  }
}

// Every entity whose Script component references scriptName.
function _findScriptOwners(scriptName) {
  if (!editorState.world) return [];
  var entities = editorState.world.getAllEntities();
  var owners = [];
  for (var i = 0; i < entities.length; i++) {
    var comp = entities[i].getComponent("Script");
    if (comp && comp.scriptName === scriptName) owners.push(entities[i]);
  }
  return owners;
}

// --- Targeted DOM updates (avoid full re-render that destroys Monaco) ---

function _refreshTabsDom() {
  var tabsContainer = document.querySelector(".se-tabs");
  if (!tabsContainer) return;
  var se = editorState.scriptEditor;
  tabsContainer.innerHTML = se.openTabs.map(function (name) {
    var active = name === se.activeTab;
    return (
      '<div class="se-tab' + (active ? " se-tab-active" : "") + '" data-action="script-tab" data-script="' + name + '">' +
      "<span>" + name + "</span>" +
      '<button class="se-tab-close" data-action="script-tab-close" data-script="' + name + '" title="Close tab">&times;</button>' +
      "</div>"
    );
  }).join("");
}

function _refreshSidebarDom() {
  var sidebar = document.querySelector(".se-sidebar");
  if (!sidebar) return;
  var se = editorState.scriptEditor;
  var allScripts = getAllScripts();
  var html = '<div class="se-sidebar-header">Scripts <small style="text-transform:none;color:#6a6a6a;font-weight:normal;">(dbl-click to rename)</small></div>';
  if (allScripts.length) {
    html += allScripts.map(function (name) {
      var isActive = name === se.activeTab;
      var owners = _findScriptOwners(name);
      var ownerBadge = owners.length > 0
        ? '<span class="se-script-owners" title="Used by ' + owners.length + " object" + (owners.length > 1 ? "s" : "") + '">' + owners.length + "</span>"
        : "";
      var title = "Open " + name + (owners.length ? " (used by " + owners.length + " object" + (owners.length > 1 ? "s" : "") + ")" : " (unused)") + " — double-click to rename";
      return (
        '<div class="se-script-item' + (isActive ? " active" : "") + '" data-action="script-folder-open" data-script="' + name + '" title="' + title + '">' +
        '<span class="se-script-ico">JS</span>' +
        '<span class="se-script-name" data-dblclick-action="script-rename" data-script="' + name + '">' + name + "</span>" +
        ownerBadge +
        "</div>"
      );
    }).join("");
  } else {
    html += '<div style="padding:10px 12px;color:#8a93a0;font-size:12px;line-height:1.5;">No scripts yet. Attach a Script component to an object (in the Inspector) to create one.</div>';
  }
  sidebar.innerHTML = html;
}

function _refreshActiveStatesDom() {
  var active = editorState.scriptEditor.activeTab;
  var tabs = document.querySelectorAll(".se-tab");
  for (var i = 0; i < tabs.length; i++) {
    var name = tabs[i].getAttribute("data-script");
    if (name === active) tabs[i].classList.add("se-tab-active");
    else tabs[i].classList.remove("se-tab-active");
  }
  var items = document.querySelectorAll(".se-script-item");
  for (var i = 0; i < items.length; i++) {
    var name = items[i].getAttribute("data-script");
    if (name === active) items[i].classList.add("active");
    else items[i].classList.remove("active");
  }
  var status = document.getElementById("se-status-text");
  if (status) status.textContent = active || "No script open";
  if (_apiPanelOpen) _refreshApiPanelDom();
}

function _refreshApiPanelDom() {
  var panel = document.querySelector(".se-api-panel");
  if (!panel) return;
  panel.innerHTML = _renderApiPanel();
}

function _refreshApiToggleDom() {
  var existingPanel = document.querySelector(".se-api-panel");
  if (_apiPanelOpen) {
    if (!existingPanel) {
      var panelDiv = document.createElement("div");
      panelDiv.className = "se-api-panel";
      panelDiv.innerHTML = _renderApiPanel();
      var body = document.querySelector(".se-body");
      if (body) body.parentNode.insertBefore(panelDiv, body);
    }
  } else {
    if (existingPanel) existingPanel.remove();
  }
  var apiBtn = document.querySelector('[data-action="script-api-toggle"]');
  if (apiBtn) {
    if (_apiPanelOpen) apiBtn.classList.add("se-btn-active");
    else apiBtn.classList.remove("se-btn-active");
  }
}

function _renameScriptOnEntities(oldName, newName) {
  if (!editorState.world) return;
  var entities = editorState.world.getAllEntities();
  for (var i = 0; i < entities.length; i++) {
    var comp = entities[i].getComponent("Script");
    if (comp && comp.scriptName === oldName) {
      comp.scriptName = newName;
    }
  }
}

/**
 * Renames a script EVERYWHERE it's referenced: storage (so the source
 * moves to the new key instead of leaving a stale copy under the old
 * name — see ScriptStorage.renameScript), every entity's Script
 * component (not just one), any open Monaco model/tab in this Script
 * Editor window, and the context map that drives `this.` autocomplete.
 *
 * This is the ONE place script renames should happen — both the Script
 * Editor's own tab-rename UI and the Inspector's "Script Name" field
 * call this, so a rename from either place stays fully in sync instead
 * of the Inspector's old behavior of only touching the one entity's
 * component (which orphaned the old storage entry and effectively
 * created a duplicate "file" the next time the script was edited).
 *
 * @param {string} oldName
 * @param {string} newName
 * @returns {boolean} true if the rename happened, false if it was a
 *   no-op (blank/unchanged name) or newName is already taken by a
 *   DIFFERENT script.
 */
export function renameScriptEverywhere(oldName, newName) {
  newName = (newName || "").trim();
  if (!newName || newName === oldName) return false;
  if (scriptExists(newName)) return false; // don't silently clobber another script's source

  renameScript(oldName, newName);
  if (_models[oldName]) {
    _models[newName] = _models[oldName];
    delete _models[oldName];
  }
  // Migrate cached syntax-highlighting decoration ids too — see
  // renameRealotDecorations()'s doc comment for exactly why skipping
  // this leaves stale decorations (including realot-token-lifecycle
  // purple) stuck on the renamed script's text.
  renameRealotDecorations(oldName, newName);
  renameSyntaxCheck(oldName, newName);
  var tabIdx = editorState.scriptEditor.openTabs.indexOf(oldName);
  if (tabIdx >= 0) editorState.scriptEditor.openTabs[tabIdx] = newName;
  if (editorState.scriptEditor.activeTab === oldName) {
    editorState.scriptEditor.activeTab = newName;
  }
  if (editorState.scriptEditor.contextByScript && editorState.scriptEditor.contextByScript[oldName]) {
    editorState.scriptEditor.contextByScript[newName] = editorState.scriptEditor.contextByScript[oldName];
    delete editorState.scriptEditor.contextByScript[oldName];
  }
  _renameScriptOnEntities(oldName, newName);
  _refreshTabsDom();
  _refreshSidebarDom();
  _refreshActiveStatesDom();
  return true;
}

/**
 * Deletes a script EVERYWHERE it's referenced, mirroring
 * renameScriptEverywhere() above: storage (ScriptStorage.deleteScript),
 * every entity's Script component IN THE CURRENTLY LOADED SCENE (same
 * live-World-only limitation renameScriptEverywhere already has — a
 * reference sitting in a different, not-currently-loaded scene's
 * serialized data can't be reached without deserializing every scene
 * in the project just to patch one field, so it's left as-is; that
 * entity's Script component keeps its old scriptName string, and
 * getScriptSource() for a deleted name simply returns "" — same
 * graceful "missing" behavior AssetRegistry's deleteSpriteAsset/
 * deleteAudioAsset rely on for a deleted image/audio reference, so
 * nothing crashes if that scene is opened later), any open Monaco
 * model/tab in this Script Editor window, and the context map that
 * drives `this.` autocomplete.
 * @param {string} name
 * @returns {boolean} whether a script with that name existed and was deleted
 */
export function deleteScriptEverywhere(name) {
  if (!scriptExists(name)) return false;

  deleteScript(name);
  if (_models[name]) {
    try { _models[name].dispose(); } catch (err) {}
    delete _models[name];
  }
  var tabIdx = editorState.scriptEditor.openTabs.indexOf(name);
  if (tabIdx >= 0) editorState.scriptEditor.openTabs.splice(tabIdx, 1);
  if (editorState.scriptEditor.activeTab === name) {
    editorState.scriptEditor.activeTab = editorState.scriptEditor.openTabs[0] || null;
  }
  if (editorState.scriptEditor.contextByScript && editorState.scriptEditor.contextByScript[name]) {
    delete editorState.scriptEditor.contextByScript[name];
  }
  _clearScriptOnEntities(name);
  _refreshTabsDom();
  _refreshSidebarDom();
  _refreshActiveStatesDom();
  return true;
}

/**
 * Clears scriptName (and disables the component, since a Script with
 * no scriptName has no code to run — matches how a freshly-added
 * Script component with no script chosen yet already behaves) on
 * every entity in the live World currently referencing `name`. Mirrors
 * _renameScriptOnEntities() above exactly, just nulling instead of
 * renaming.
 * @param {string} name
 */
function _clearScriptOnEntities(name) {
  if (!editorState.world) return;
  var entities = editorState.world.getAllEntities();
  for (var i = 0; i < entities.length; i++) {
    var comp = entities[i].getComponent("Script");
    if (comp && comp.scriptName === name) {
      comp.scriptName = null;
      comp.source = "";
    }
  }
}

function _getActiveScriptContextEntities() {
  var se = editorState.scriptEditor;
  var ctx = se.contextByScript ? se.contextByScript[se.activeTab] : null;
  if (!ctx || !editorState.world) return [];
  var ids = ctx.entityId ? [ctx.entityId] : (ctx.entityIds || []);
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var e = editorState.world.getEntity(ids[i]);
    if (e) out.push(e);
  }
  return out;
}

// Records which object(s) drive `this.` autocomplete for this script.
// - Opened via an object (contextEntityId given): use that object.
// - Opened via the Scripts folder (null): if exactly one object owns
//   it, use that object; if several share it, use the UNION of every
//   owner's components so every property stays valid.
function _applyContext(scriptName, contextEntityId) {
  if (!editorState.scriptEditor.contextByScript) {
    editorState.scriptEditor.contextByScript = {};
  }
  if (contextEntityId) {
    editorState.scriptEditor.contextByScript[scriptName] = { entityId: contextEntityId, entityIds: null };
    return;
  }
  var owners = _findScriptOwners(scriptName);
  if (owners.length === 1) {
    editorState.scriptEditor.contextByScript[scriptName] = { entityId: owners[0].id, entityIds: null };
  } else if (owners.length >= 2) {
    editorState.scriptEditor.contextByScript[scriptName] = { entityId: null, entityIds: owners.map(function (o) { return o.id; }) };
  } else {
    editorState.scriptEditor.contextByScript[scriptName] = { entityId: null, entityIds: null };
  }
}

function _mountEditor(container) {
  _ensureMonaco(function (monaco) {
    if (!editorState.scriptEditor.activeTab) return;
    // Monaco's local load is async, and the app can
    // re-render for unrelated reasons (scene list update, a hover state,
    // the user switching tabs) while it's still in flight. Each re-render
    // regenerates '#se-monaco-container' as a brand-new DOM node with the
    // same id — the ORIGINAL `container` this callback closed over is by
    // then detached and invisible. Re-querying the live node by id here
    // (instead of trusting the stale closure) is what makes sure the
    // editor actually lands where the user can see and type into it. If
    // the overlay was closed entirely before this fired, the id is gone
    // and there's nothing to mount into — bail instead of creating an
    // editor nobody will ever see.
    var liveContainer = document.getElementById("se-monaco-container");
    if (!liveContainer) return;
    container = liveContainer;

    if (_editor) {
      // Editor already exists — just re-attach to the new container
      if (_editor.getDomNode().parentNode !== container) {
        container.appendChild(_editor.getDomNode());
      }
      _switchTab(editorState.scriptEditor.activeTab);
      return;
    }

    _editor = monaco.editor.create(container, {
      value: "",
      language: "javascript",
      theme: "realot-dark",
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      folding: true,
      lineNumbers: "on",
      renderWhitespace: "selection",
      tabSize: 2,
      wordBasedSuggestions: false,
      suggestOnTriggerCharacters: true,
      parameterHints: { enabled: true },
      // Monaco disables automatic suggestions inside string literals by
      // default (quickSuggestions.strings is false). Our IntelliSense
      // provider relies heavily on string-argument completions (find(",
      // input.keyDown(", .texture = ", etc.), so without this, typing past
      // the opening quote — or clicking back into an already-typed string —
      // never reopens the suggestion widget until a trigger character like
      // " is retyped. Turning this on makes suggestions live-update on every
      // keystroke inside a string, matching the "other" code behavior.
      quickSuggestions: { other: true, comment: false, strings: true },
    });

    // Auto-save on content change
    _editor.onDidChangeModelContent(function () {
      var active = editorState.scriptEditor.activeTab;
      if (active) {
        _scheduleSave(active);
        _scheduleDiagnostics(active);
        _scheduleHighlighting(active);
      }
    });

    _switchTab(editorState.scriptEditor.activeTab);
  });
}

export function openScriptEditor(scriptName, source, contextEntityId) {
  // `source` is only used to CREATE a script that doesn't exist yet. It must
  // never overwrite what's stored: callers sometimes pass the Script
  // component's embedded copy, which can be stale after an import — and the
  // editor would then save that stale copy over the real script.
  if (scriptName && source !== undefined && !scriptExists(scriptName)) {
    saveScript(scriptName, source);
  }
  if (scriptName && scriptExists(scriptName)) {
    // Make the live scene's copies match what the editor is about to show.
    _syncSourceToEntities(scriptName, getScriptSource(scriptName));
  }
  if (scriptName) {
    _openTab(scriptName);
    _applyContext(scriptName, contextEntityId);
  }
  editorState.scriptEditor.open = true;
  if (editorState.renderFn) editorState.renderFn();
}

export function closeScriptEditor() {
  editorState.scriptEditor.open = false;
  clearTimeout(_diagTimer);
  // Also cancel any pending highlight pass — previously only _diagTimer
  // was cleared here, so a highlight scheduled just before closing could
  // still fire ~150ms later against a disposed editor/model below,
  // throw, and leave that script's coloring stale on next open (see the
  // matching fix in _closeTab above for the same underlying issue).
  clearTimeout(_highlightTimer);
  // Dispose the Monaco instance so the next open creates a fresh,
  // working editor. Models are cached in _models, so content survives.
  if (_editor) {
    try { _editor.dispose(); } catch (e) {}
    _editor = null;
  }
  if (editorState.renderFn) editorState.renderFn();
}

/**
 * Called when the whole script set was swapped out (project import / load /
 * new project). Drops every cached Monaco model, pending save and open tab, so
 * the editor can't keep showing — or auto-save back — the previous project's
 * code under the same script name.
 */
function _resetForReplacedScripts() {
  clearTimeout(_saveTimer);
  clearTimeout(_diagTimer);
  clearTimeout(_highlightTimer);
  if (_editor) {
    try { _editor.dispose(); } catch (e) {}
    _editor = null;
  }
  var names = Object.keys(_models);
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    try {
      if (_monaco) {
        clearScriptDiagnostics(_monaco, _models[n]);
        disposeSyntaxCheck(_monaco, _models[n], n);
      }
      _models[n].dispose();
    } catch (err) {}
    try { clearRealotDecorations(n); } catch (err) {}
  }
  _models = {};
  var se = editorState.scriptEditor;
  se.open = false;
  se.openTabs = [];
  se.activeTab = null;
  se.forcedApis = {};
  se.contextByScript = {};
  if (editorState.renderFn) editorState.renderFn();
}
onScriptsReplaced(_resetForReplacedScripts);

export function isScriptEditorOpen() {
  return editorState.scriptEditor.open;
}

function _renderApiPanel() {
  // Use the ACTIVE SCRIPT's context entities (not the viewport selection)
  // so the checkboxes auto-adjust when switching between scripts that
  // belong to objects with different components.
  var se = editorState.scriptEditor;
  var entities = _getActiveScriptContextEntities();
  // forcedApis is a per-script map keyed by script name — overrides for
  // one script never bleed into another.
  var forced = (se.activeTab && se.forcedApis && se.forcedApis[se.activeTab]) || [];

   // Modules that expose a scripting sub-object (this.sprite, this.rigidbody,
   // this.collider, etc.). Light still affects rendering only. Kept in
   // sync with runtime/scripting/ScriptAPI.js's getGlobals() — every
   // entry there that's gated by entity.hasComponent(...) belongs here
   // too. (this.state is the one exception: StateAPI is available on
   // every entity unconditionally, not gated by any component, so it
   // isn't a toggle that belongs in this per-component list.)
  var modules = [
    { name: "Transform",  key: "Transform",           hasApi: true },
    { name: "Sprite",     key: "SpriteRenderer",      hasApi: true },
    { name: "Rigidbody",  key: "Rigidbody2D",         hasApi: true },
    { name: "Movement",   key: "CharacterController",  hasApi: true },
    { name: "Camera",     key: "Camera",               hasApi: true },
    { name: "Audio",      key: "AudioSource",          hasApi: true },
    { name: "Audio Listener", key: "AudioListener",    hasApi: true },
    { name: "Animator",   key: "SpriteAnimation",      hasApi: true },
    { name: "Collider",   key: "Collider2D",           hasApi: true },
    { name: "Joint",      key: "Joint2D",              hasApi: true },
    { name: "Text",       key: "TextRenderer",         hasApi: true },
    { name: "Text Input", key: "TextInput",            hasApi: true },
    { name: "Joystick",   key: "Joystick",              hasApi: true },
    { name: "Chat Log",   key: "ChatLog",              hasApi: true },
    { name: "Speech Bubble", key: "SpeechBubble",      hasApi: true },
    { name: "Light",      key: "Light",                hasApi: false },
  ];

  var items = modules.map(function (m) {
    var has = false;
    for (var i = 0; i < entities.length; i++) {
      if (entities[i].hasComponent(m.key)) { has = true; break; }
    }
    if (!m.hasApi) {
      // No script sub-object — show as informational only (no checkbox).
      return (
        '<span class="se-api-item" style="opacity:0.5;cursor:default;" title="' + m.name + ' has no scripting API — it affects physics/rendering only">' +
        "<span>" + m.name + "</span>" +
        (has ? ' <small style="color:#8a93a0;">(on entity)</small>' : ' <small style="color:#555;">(not on entity)</small>') +
        "</span>"
      );
    }
    var isForced = forced.indexOf(m.key) >= 0;
    var checked = isForced || has;
    // Entities' own components are auto-checked and cannot be unchecked —
    // their APIs are always available. Only forced (user-added) ones are
    // interactive checkboxes.
    var disabled = has ? "disabled" : "";
    var title = has
      ? m.name + " is on this entity — its API is always available"
      : (isForced ? "Uncheck to remove this API from autocomplete for this script" : "Check to add this API to autocomplete for this script");
    return (
      '<label class="se-api-item" title="' + title + '">' +
      '<input type="checkbox" data-action="script-api-toggle-module" data-module="' + m.key + '" ' +
      (checked ? "checked" : "") + " " + disabled + " />" +
      "<span>" + m.name + "</span>" +
      (has ? ' <small style="color:#8a93a0;">(on entity)</small>' : "") +
      "</label>"
    );
  }).join("");

  var scriptLabel = se.activeTab ? (" for <em>" + se.activeTab + "</em>") : "";
  return (
    '<div style="padding:8px 12px;">' +
    '<div style="font-size:11px;color:#8a93a0;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">API overrides' + scriptLabel + ' — force extra APIs into autocomplete when writing generic scripts</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + items + "</div>" +
    "</div>"
  );
}

export function renderScriptEditor() {
  if (!editorState.scriptEditor.open) return "";

  var se = editorState.scriptEditor;
  var tabs = se.openTabs.map(function (name) {
    var active = name === se.activeTab;
    return (
      '<div class="se-tab' + (active ? " se-tab-active" : "") + '" data-action="script-tab" data-script="' + name + '">' +
      '<span>' + name + '</span>' +
      '<button class="se-tab-close" data-action="script-tab-close" data-script="' + name + '" title="Close tab">&times;</button>' +
      '</div>'
    );
  }).join("");

  var apiPanelHtml = _apiPanelOpen ? _renderApiPanel() : "";

  // Scripts folder sidebar — every stored script, one click to open.
  var allScripts = getAllScripts();
  var scriptListHtml = allScripts.length
    ? allScripts.map(function (name) {
        var isActive = name === se.activeTab;
        var owners = _findScriptOwners(name);
        var ownerBadge = owners.length > 0
          ? '<span class="se-script-owners" title="Used by ' + owners.length + ' object' + (owners.length > 1 ? "s" : "") + '">' + owners.length + "</span>"
          : "";
        var title = "Open " + name + (owners.length ? " (used by " + owners.length + " object" + (owners.length > 1 ? "s" : "") + ")" : " (unused)");
        return (
          '<div class="se-script-item' + (isActive ? " active" : "") + '" data-action="script-folder-open" data-script="' + name + '" title="' + title + '">' +
          '<span class="se-script-ico">JS</span>' +
          '<span class="se-script-name" data-dblclick-action="script-rename" data-script="' + name + '">' + name + "</span>" +
          ownerBadge +
          "</div>"
        );
      }).join("")
    : '<div style="padding:10px 12px;color:#8a93a0;font-size:12px;line-height:1.5;">No scripts yet. Attach a Script component to an object (in the Inspector) to create one.</div>';

  return (
    '<div class="script-editor-overlay" id="script-editor-overlay">' +
    '<div class="script-editor-topbar">' +
    '<div class="se-tabs">' + tabs + '</div>' +
    '<div class="se-actions">' +
    '<button class="se-btn' + (_apiPanelOpen ? " se-btn-active" : "") + '" data-action="script-api-toggle" title="API Management">API</button>' +
    '<button class="se-btn se-btn-close" data-action="script-close" title="Close editor (Esc)">&times; Close</button>' +
    '</div>' +
    '</div>' +
    (apiPanelHtml ? '<div class="se-api-panel">' + apiPanelHtml + '</div>' : '') +
    '<div class="se-body">' +
    '<div class="se-sidebar">' +
    '<div class="se-sidebar-header">Scripts <small style="text-transform:none;color:#6a6a6a;font-weight:normal;">(dbl-click to rename)</small></div>' +
    scriptListHtml +
    '</div>' +
    '<div class="se-editor-area" id="se-monaco-container"></div>' +
    '</div>' +
    '<div class="se-statusbar">' +
    '<span id="se-status-text">' + (se.activeTab || "No script open") + '</span>' +
    '<span style="display:flex;align-items:center;gap:12px;">' +
    '<span style="color:#8a93a0;font-size:11px;">Auto-saved • Scripts run only in Play mode</span>' +
    '<span style="background:#1177bb;color:#fff;font-size:10px;font-weight:600;padding:1px 7px;border-radius:3px;letter-spacing:0.3px;">Realot Script</span>' +
    '</span>' +
    '</div>' +
    '</div>'
  );
}

export function mountScriptEditor() {
  if (!editorState.scriptEditor.open) {
    // Editor closed — dispose the instance so the next open is fresh.
    if (_editor) {
      try { _editor.dispose(); } catch (e) {}
      _editor = null;
    }
    return;
  }
  var container = document.getElementById("se-monaco-container");
  if (!container) return;
  _mountEditor(container);
}

export function handleScriptEditorAction(action, el) {
  switch (action) {
    case "script-close":
      closeScriptEditor();
      break;
    case "script-folder-open": {
      var scriptName = el.getAttribute("data-script");
      _openTab(scriptName);
      _applyContext(scriptName, null);
      _switchTab(scriptName);
      // Targeted DOM update — no full re-render (preserves Monaco).
      _refreshTabsDom();
      _refreshSidebarDom();
      _refreshActiveStatesDom();
      break;
    }
    case "script-tab": {
      var sn = el.getAttribute("data-script");
      _switchTab(sn);
      _refreshActiveStatesDom();
      break;
    }
    case "script-tab-close": {
      var name2 = el.getAttribute("data-script");
      _closeTab(name2);
      if (editorState.scriptEditor.activeTab) {
        _switchTab(editorState.scriptEditor.activeTab);
      }
      _refreshTabsDom();
      _refreshActiveStatesDom();
      break;
    }
    case "script-rename": {
      var oldName = el.getAttribute("data-script");
      var newName = prompt("Rename script to:", oldName);
      if (newName === null) break;
      if (renameScriptEverywhere(oldName, newName) === false && newName.trim() && newName.trim() !== oldName) {
        pushLog("error", 'A script named "' + newName.trim() + '" already exists.');
      }
      break;
    }
    case "script-api-toggle":
      _apiPanelOpen = !_apiPanelOpen;
      _refreshApiToggleDom();
      break;
    case "script-api-toggle-module": {
      var mod = el.getAttribute("data-module");
      var scriptName2 = editorState.scriptEditor.activeTab;
      if (!scriptName2) break;
      // forcedApis is a per-script map — read/write only the active script's entry.
      var perScript = editorState.scriptEditor.forcedApis;
      if (!perScript[scriptName2]) perScript[scriptName2] = [];
      var arr = perScript[scriptName2];
      var idx = arr.indexOf(mod);
      if (el.checked && idx < 0) {
        arr.push(mod);
      } else if (!el.checked && idx >= 0) {
        arr.splice(idx, 1);
      }
      break;
    }
  }
}
