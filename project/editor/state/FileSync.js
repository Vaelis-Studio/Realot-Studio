/**
 * FileSync.js — keeps an opened/saved .realot file up to date.
 *
 * Once the user has agreed to "update this file", edits are written back into
 * that same file (File System Access handle) every 60 seconds while there are
 * unsaved changes, and again when the tab is hidden / closed — the same rhythm
 * as the editor's normal autosave. Chromium-only (needs createWritable);
 * everywhere else the editor falls back to the usual download.
 */
import { editorState, pushLog, markFileClean, dirtyState } from "./EditorState.js";
import { exportProject } from "./ProjectIO.js";

const INTERVAL_MS = 60 * 1000;
let _started = false;
let _chain = Promise.resolve(); // writes run one after another, never overlapping

const render = () => { if (editorState.renderFn) editorState.renderFn(); };

export function isFileSyncActive() {
  return !!(editorState.fileHandle && editorState.fileAutoUpdate);
}

export async function hasWritePermission(handle, request) {
  try {
    let p = await handle.queryPermission({ mode: "readwrite" });
    if (p === "granted") return true;
    if (request) {
      p = await handle.requestPermission({ mode: "readwrite" });
      return p === "granted";
    }
  } catch (_) { /* no activation / unsupported */ }
  return false;
}

/**
 * Write the project into the tracked file. Never prompts (permission is
 * re-requested from the user's next click instead). Writes are queued, so a
 * manual save pressed during a background save waits its turn instead of being
 * dropped. A queued write is skipped if an earlier one already saved everything,
 * unless `force` is set.
 */
export function writeProjectToFile(reason, force) {
  const run = async () => {
    const handle = editorState.fileHandle;
    if (!handle || !editorState.game) return false;
    if (!force && !dirtyState.fileDirty) return true; // an earlier write already covered it
    if (!(await hasWritePermission(handle, false))) {
      editorState.filePermissionNeeded = true;
      render();
      return false;
    }
    try {
      await exportProject(
        editorState.game,
        editorState.projectName || handle.name.replace(/\.[^.]+$/, ""),
        {
          fileHandle: handle,
          optimizeAssets: false, // skip the slow re-encode pass for background saves
          compressionLevel: 1,   // fast zip so it finishes quickly (also when leaving)
        }
      );
      markFileClean();
      editorState.filePermissionNeeded = false;
      editorState.fileLastSavedAt = Date.now();
      render();
      return true;
    } catch (err) {
      pushLog("error", "Could not update " + handle.name + " (" + reason + "): " + (err && err.message ? err.message : err));
      render();
      return false;
    }
  };
  _chain = _chain.then(run, run);
  return _chain;
}

function startFileSync() {
  if (_started) return;
  _started = true;
  setInterval(() => {
    if (isFileSyncActive() && dirtyState.fileDirty) writeProjectToFile("every 60 s");
  }, INTERVAL_MS);
  const leaving = () => {
    if (isFileSyncActive() && dirtyState.fileDirty) writeProjectToFile("leaving");
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") leaving(); });
  window.addEventListener("pagehide", leaving);
  // Re-grant write permission from the user's next click if it was lost.
  document.addEventListener(
    "pointerdown",
    async () => {
      if (!isFileSyncActive() || !editorState.filePermissionNeeded) return;
      if (await hasWritePermission(editorState.fileHandle, true)) {
        editorState.filePermissionNeeded = false;
        if (dirtyState.fileDirty) writeProjectToFile("permission granted");
        render();
      }
    },
    true
  );
}

/**
 * Start tracking a file. With confirmFirst the user must agree (once) that the
 * original file will be overwritten automatically. Returns true if tracking began.
 */
export async function adoptFileHandle(handle, opts) {
  const confirmFirst = !!(opts && opts.confirmFirst);
  if (confirmFirst) {
    const ok = window.confirm(
      "Keep \u201C" + handle.name + "\u201D up to date?\n\n" +
      "If you continue, your changes will REPLACE the original file automatically every 60 seconds and when you leave the editor. The old version can't be recovered.\n\n" +
      "OK = update this file automatically\n" +
      "Cancel = leave the original untouched (use File \u2192 Save as copy to download a copy)"
    );
    if (!ok) {
      editorState.fileHandle = null;
      editorState.fileAutoUpdate = false;
      render();
      return false;
    }
  }
  editorState.fileHandle = handle;
  editorState.fileAutoUpdate = true;
  editorState.filePermissionNeeded = !(await hasWritePermission(handle, false));
  startFileSync();
  pushLog("log", "Auto-updating " + handle.name + " every 60 seconds and when you leave.");
  render();
  return true;
}
