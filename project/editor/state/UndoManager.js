/**
 * editor/state/UndoManager.js
 *
 * Snapshot-based undo/redo for scene data (entities + components — the
 * same data serializeScene()/deserializeScene() already round-trip for
 * saving a scene to disk). Reusing that serializer instead of hand-
 * tracking every individual mutation (delete this, added that
 * component, changed this field...) means every present AND future
 * scene edit is covered automatically, as long as the call site wraps
 * itself with snapshotNow()/beginEdit()+commitEdit() below — no
 * separate "undo op" class per action type to keep in sync.
 *
 * TWO INDEPENDENT STACKS, gated by which editor is open:
 *   - "scene": Hierarchy / Inspector / Viewport (delete, duplicate,
 *     paste, add entity, add/remove component, field edits, gizmo
 *     drags, tile paint) — active whenever the Animation editor is
 *     closed.
 *   - "anim": the Animation editor's own clip/frame edits (new/delete
 *     clip, delete frame, loop toggle, collider override, frame
 *     reorder) — active only while editorState.animOpen is true.
 * Undo/redo in one never touches the other's stack, and Ctrl+Z/Ctrl+
 * Shift+Z are routed to whichever is currently active (see
 * getActiveScope() below) so each editor's history behaves as its own
 * independent timeline, exactly as requested.
 *
 * Deliberately NOT covering the Script Editor's own undo — Monaco has
 * its own built-in undo/redo (Ctrl+Z inside the editor already works
 * via Monaco itself). Since serializeScene()/deserializeScene() (the
 * snapshot format this file reuses) capture a Script component's
 * `source` field along with everything else, _restore() explicitly
 * re-stamps each script's CURRENT live source back on after every
 * undo/redo, keyed by scriptName — so a scene/anim undo step can
 * never silently revert code out from under an open Monaco tab. See
 * _restore()'s own comment for why that's needed instead of just
 * being true by construction.
 *
 * EDITOR-ONLY FILE.
 */

import { editorState, pushLog, markDirty } from "./EditorState.js";
import { serializeScene, deserializeScene } from "../../runtime/scene/SceneSerializer.js";
import { SCRIPT } from "../../runtime/components/Script.js";

const MAX_HISTORY = 100;

/** @type {Record<"scene"|"anim", {undo: object[], redo: object[]}>} */
const _stacks = {
  scene: { undo: [], redo: [] },
  anim: { undo: [], redo: [] },
};

// Snapshot captured by beginEdit(), waiting for a matching commitEdit()
// to actually get pushed onto the stack. Keyed by scope so a main-
// editor drag and an animation-editor drag could theoretically overlap
// without clobbering each other (they can't actually happen at the same
// time in this UI, but keeping them separate costs nothing and avoids
// any future surprise).
/** @type {Record<string, object|null>} */
const _pending = { scene: null, anim: null };

/**
 * Which stack Ctrl+Z/Ctrl+Shift+Z should act on right now. Mirrors the
 * same "which editor owns the keyboard" reasoning already used for the
 * Escape-closes-script-editor and the tool-shortcut guards in
 * EditorEvents.js: the Animation editor is a modal-ish overlay, so
 * while it's open ITS history is what undo/redo should walk.
 */
export function getActiveScope() {
  return editorState.animOpen ? "anim" : "scene";
}

function _snapshot() {
  if (!editorState.world) return null;
  // serializeScene() already deep-copies component data (see its own
  // doc comment / SceneSerializer.js), so each entry here is a fully
  // independent snapshot — later mutations to the live world can never
  // reach back and corrupt a previously-pushed history entry.
  return serializeScene(editorState.world);
}

/**
 * Call BEFORE a single, instantaneous mutation (delete selection, add
 * entity, add/remove component, paste, duplicate, create/delete clip,
 * delete frame, toggle a checkbox field, etc.) — i.e. anything that
 * isn't a drag with its own pointerdown/pointerup (or
 * focus/keystroke/blur) lifecycle. Pushes the CURRENT (pre-mutation)
 * state onto the undo stack and clears the redo stack, matching
 * standard editor semantics: making a new edit after an undo discards
 * the redone-away future.
 * @param {"scene"|"anim"} scope
 */
export function snapshotNow(scope) {
  const snap = _snapshot();
  if (!snap) return;
  const stack = _stacks[scope];
  stack.undo.push(snap);
  if (stack.undo.length > MAX_HISTORY) stack.undo.shift();
  stack.redo.length = 0;
  // The mutation this call BRACKETS (not this call itself) is what
  // actually changes the project — see this file's snapshotNow() doc
  // comment above for the full list (delete, add entity, add/remove
  // component, paste, duplicate, toggle a checkbox field, etc). Marking
  // dirty here, rather than requiring every one of those call sites to
  // remember to do it themselves, is what makes the reload/close guard
  // (see EditorState.js's markDirty doc comment) cover every edit
  // automatically.
  markDirty();
}

/**
 * Call at the START of a continuous edit gesture — a gizmo drag
 * (translate/scale/rotate), a triangle-collider or freeform-light
 * vertex drag, tile paint-drag, an Inspector number field being
 * dragged/typed, a frame reorder drag. Captures the state as it was
 * BEFORE the gesture starts, but does NOT push it yet — commitEdit()
 * does that once the gesture ends, so one whole drag becomes exactly
 * one undo step instead of one per pointermove/keystroke tick.
 * Re-entrant-safe: a second beginEdit() for the same scope before a
 * commit is a no-op, so an accidental duplicate begin (e.g. two event
 * handlers both firing on the same pointerdown) can't overwrite the
 * true "before" snapshot with a mid-drag one.
 * @param {"scene"|"anim"} scope
 */
export function beginEdit(scope) {
  if (_pending[scope]) return; // already mid-gesture; keep the original "before"
  _pending[scope] = _snapshot();
}

/**
 * Call at the END of a continuous edit gesture (pointerup/blur/change).
 * Pushes the snapshot captured by beginEdit() — NOT the current
 * state — so the undo step restores things to how they were before the
 * whole gesture, and clears the redo stack. If the gesture turned out
 * to be a no-op (e.g. pointerdown+pointerup with no actual movement),
 * pass skipIfUnchanged=true (default) to compare against the current
 * state and avoid pushing a useless no-op step that would otherwise
 * make one Ctrl+Z visually do nothing.
 * @param {"scene"|"anim"} scope
 * @param {boolean} [skipIfUnchanged]
 */
export function commitEdit(scope, skipIfUnchanged = true) {
  const before = _pending[scope];
  _pending[scope] = null;
  if (!before) return;
  if (skipIfUnchanged) {
    const after = _snapshot();
    if (after && JSON.stringify(before) === JSON.stringify(after)) return;
  }
  const stack = _stacks[scope];
  stack.undo.push(before);
  if (stack.undo.length > MAX_HISTORY) stack.undo.shift();
  stack.redo.length = 0;
  markDirty(); // see snapshotNow()'s markDirty() comment above
}

/**
 * Abandons a beginEdit() without pushing anything — for a gesture that
 * gets cancelled outright (e.g. Escape mid-drag, if that's ever added).
 * Not currently wired to anything but kept for symmetry/completeness.
 * @param {"scene"|"anim"} scope
 */
export function cancelEdit(scope) {
  _pending[scope] = null;
}

function _restore(snap) {
  if (!editorState.world) return;
  // Script source is intentionally exempt from undo/redo (see this
  // file's header comment: Monaco owns script history, not the scene/
  // anim stacks) — but that was only ever true of the INTENT, not the
  // actual behavior: _snapshot() goes through serializeScene(), which
  // captures every component verbatim, Script's `source` field
  // included (see Script.js: "stored directly on the component so it
  // serializes with the scene"). So restoring an older snapshot was
  // silently overwriting the live Script component's source back to
  // whatever it was at snapshot time — with Monaco's own open buffer
  // never touched, so nothing in the Script Editor looked any
  // different. The change only became visible on the NEXT play (which
  // reads the now-reverted live component) or after a reload (which
  // re-serializes from that reverted state), by which point it looked
  // like the editor had "randomly" reverted code with no undo action
  // to point to.
  //
  // Fix: capture the CURRENT live source for every script (keyed by
  // scriptName, same matching _syncSourceToEntities in
  // ScriptEditorWindow.js already uses, since entity ids can legitimately
  // differ between the live world and an older/newer snapshot — e.g.
  // undoing past an entity-delete) before restoring, then re-stamp it
  // back onto the restored entities' Script components afterward. This
  // makes the file's own stated design actually true: a scene/anim
  // undo or redo can change WHICH entities exist and what they're
  // named/positioned/configured as, but never rewrites a script's code
  // out from under the Script Editor.
  const liveSourceByScriptName = new Map();
  for (const entity of editorState.world.getAllEntities()) {
    const script = entity.getComponent(SCRIPT);
    if (script) liveSourceByScriptName.set(script.scriptName, script.source);
  }

  // Preserve selection by id where possible — deserializeScene()
  // recreates entities with the SAME ids they were serialized with
  // (see World.createEntity's id param), so a selected id that still
  // exists after restore just keeps working; one that was deleted by
  // the change being undone (or added by the change being redone) is
  // dropped instead of pointing at nothing.
  const keepIds = (ids) => (ids || []).filter((id) => snap.entities.some((e) => e.id === id));
  deserializeScene(editorState.world, snap);

  for (const entity of editorState.world.getAllEntities()) {
    const script = entity.getComponent(SCRIPT);
    if (script && liveSourceByScriptName.has(script.scriptName)) {
      script.source = liveSourceByScriptName.get(script.scriptName);
    }
  }

  editorState.selectedIds = keepIds(editorState.selectedIds);
  editorState.selectedId = editorState.selectedIds.length
    ? editorState.selectedIds[editorState.selectedIds.length - 1]
    : null;
}

/**
 * @param {"scene"|"anim"} scope
 * @returns {boolean} true if an undo actually happened
 */
export function undo(scope) {
  const stack = _stacks[scope];
  if (!stack.undo.length) return false;
  const current = _snapshot();
  const prev = stack.undo.pop();
  if (current) stack.redo.push(current);
  _restore(prev);
  markDirty(); // undoing still changes the live World vs. what's saved
  return true;
}

/**
 * @param {"scene"|"anim"} scope
 * @returns {boolean} true if a redo actually happened
 */
export function redo(scope) {
  const stack = _stacks[scope];
  if (!stack.redo.length) return false;
  const current = _snapshot();
  const next = stack.redo.pop();
  if (current) stack.undo.push(current);
  _restore(next);
  markDirty(); // see undo()'s markDirty() comment above
  return true;
}

export function canUndo(scope) {
  return _stacks[scope].undo.length > 0;
}

export function canRedo(scope) {
  return _stacks[scope].redo.length > 0;
}

/**
 * Wipes BOTH stacks. Call when a different scene is loaded/switched
 * into, or a brand new scene starts — undoing "past" a scene load into
 * a previous scene's entities would be nonsensical (mismatched ids,
 * mismatched sceneName), same reason World.clear() itself resets the
 * entity id counter on scene load.
 */
export function resetHistory() {
  _stacks.scene.undo.length = 0;
  _stacks.scene.redo.length = 0;
  _stacks.anim.undo.length = 0;
  _stacks.anim.redo.length = 0;
  _pending.scene = null;
  _pending.anim = null;
}

/**
 * Shared entry point for the Ctrl+Z / Ctrl+Shift+Z keyboard shortcut
 * AND any future Edit-menu Undo/Redo buttons — both should behave
 * identically, so both call this rather than the raw undo()/redo()
 * above directly.
 * @param {"undo"|"redo"} direction
 */
export function performUndoRedo(direction) {
  const scope = getActiveScope();
  const did = direction === "undo" ? undo(scope) : redo(scope);
  if (did) {
    pushLog("log", (direction === "undo" ? "Undo" : "Redo") + (scope === "anim" ? " (Animation)" : "") + ".");
  }
  return did;
}
