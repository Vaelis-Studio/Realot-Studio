/**
 * editor/state/ProjectStorage.js
 *
 * Automatic, per-project editor persistence — the thing that makes
 * "leave the editor and come back and it's exactly how you left it"
 * true without the user ever touching File > Save Project.
 *
 * This is deliberately a SEPARATE concern from ProjectIO.js's
 * exportProject()/importProject() (the manual "download/upload a
 * .zip" flow, still reachable from the File menu). Both read/write the
 * exact same underlying data shape (manifest + scenes + assets +
 * scripts + layers), just through a different transport:
 *   - ProjectIO.js       -> JSZip -> a downloaded .zip file
 *   - ProjectStorage.js  -> RealotPersistence (localStorage/IndexedDB),
 *                           keyed by the launcher's project id, no
 *                           user action required
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM ScriptStorage.js/PhysicsLayers.js/
 * Tags.js's OWN localStorage calls: those three each persist to one
 * fixed, GLOBAL localStorage key shared by every project (e.g. every
 * project's scripts landed in the same "realot_scripts" key). That's
 * exactly the bug this feature fixes — this file additionally snapshots
 * their contents into the CURRENT project's own namespaced storage slot
 * and, on load, replaces their global contents with that project's own
 * saved copy, so switching between two different projects in the
 * launcher never leaks one project's scripts/layers/tags into another.
 *
 * STORAGE KEY SHAPE (must match js/data/store.js's project ids, which
 * come from the launcher and are passed to the editor via ?project=):
 *   realot.project.<id>.snapshot   -> the full project snapshot (see
 *                                        buildSnapshot() below)
 *
 * EDITOR-ONLY FILE.
 */

import { ENGINE_VERSION } from "../../runtime/EngineVersion.js";
import { getAllScripts, getScriptSource, replaceAllScripts, clearAllScripts } from "../scripting/ScriptStorage.js";
import { syncScriptSourcesInScenes, seedScriptStorageFromScenes } from "../scripting/ScriptSync.js";
import { getLayerNames, replaceAllLayerNames, getDefaultLayerNames } from "./PhysicsLayers.js";
import { getNavAreaNames, replaceAllNavAreaNames, getDefaultNavAreaNames } from "./NavAreas.js";
import { getTagNames, replaceAllTagNames, getDefaultTagNames } from "./Tags.js";
import { editorState, markClean } from "./EditorState.js";

const SNAPSHOT_KEY_PREFIX = "realot.project.";
const SNAPSHOT_KEY_SUFFIX = ".snapshot";
/** Autosave cadence: every 1 minute, per the launcher's persistence contract. */
export const AUTOSAVE_INTERVAL_MS = 60 * 1000;

/**
 * window.RealotPersistence is loaded as a plain classic <script> (see
 * project/editor/index.html) rather than an ES import, the same way
 * PIXI/JSZip/Hammer are, so it's one shared instance across the
 * launcher and every editor tab. Guarded here in case the editor is
 * ever opened from a path where that script tag didn't resolve —
 * degrades to an in-memory-only stub instead of throwing and taking
 * down the whole editor boot.
 */
function _persistence() {
  if (window.RealotPersistence) return window.RealotPersistence;
  console.error("[ProjectStorage] window.RealotPersistence is unavailable — autosave will not persist across reloads.");
  return {
    setItem: () => Promise.resolve({ ok: false, tier: "none" }),
    setItemSync: () => ({ ok: false, tier: "none" }),
    getItem: () => Promise.resolve(null),
    removeItem: () => Promise.resolve(),
    listKeys: () => Promise.resolve([]),
  };
}

// Key format lives in one place: window.RealotPersistence.projectSnapshotKey()
// (see js/data/RealotPersistence.js) — used by both this file and the
// launcher's js/data/store.js (which deletes a project's snapshot when
// the project itself is deleted) so the two can never drift on the key
// format between them.
function snapshotKey(projectId) {
  return _persistence().projectSnapshotKey
    ? _persistence().projectSnapshotKey(projectId)
    : SNAPSHOT_KEY_PREFIX + projectId + SNAPSHOT_KEY_SUFFIX; // fallback if RealotPersistence.js failed to load — see _persistence()
}

/**
 * Builds the full, plain-JSON snapshot of everything that makes up the
 * currently-open project, in the SAME shape ProjectIO.js's
 * exportProject() produces (manifest/scenes/assets/scripts/layers),
 * plus the project's own tag list and a slice of editor UI state
 * (selection, open Project panel folder — see the `ui` block below).
 * Building both from one shared shape means a manual "Save Project"
 * .zip and an autosave snapshot never drift apart in what they
 * consider "the project."
 *
 * @param {ReturnType<import('../../runtime/index.js').createGame>} game
 * @param {string} projectName
 * @returns {object}
 */
export function buildSnapshot(game, projectName) {
  game.saveActiveScene(); // flush the live World into its scene slot first — see ProjectIO.js's exportProject() for why

  const scriptsByName = {};
  for (const name of getAllScripts()) {
    scriptsByName[name] = getScriptSource(name);
  }

  const scenesForSnapshot = game.getAllScenesData(); // [{id,name,data}]
  syncScriptSourcesInScenes(scenesForSnapshot); // keep saved scene copies equal to the script editor

  return {
    manifestVersion: 1,
    engineVersion: ENGINE_VERSION,
    projectName: projectName || "Untitled Project",
    savedAt: new Date().toISOString(),
    activeSceneId: game.getActiveSceneId(),
    scenes: scenesForSnapshot,
    assets: {
      sprites: game.getAllSpriteAssets(),
      frames: game.getAllFrameAssets(),
      audio: game.getAllAudioAssets(),
    },
    // Prefab catalogue (see runtime/prefabs/PrefabRegistry.js) — its own
    // top-level key rather than folded into `assets` above, since a
    // prefab isn't an imported file the way a sprite/audio clip is (it's
    // derived FROM scene data, see PrefabRegistry.createPrefabFromEntity),
    // and restoring it needs its own id-counter bump the same way
    // `scenes` does (see restoreProjectPrefabs's own doc comment) rather
    // than sharing AssetRegistry's restore path.
    prefabs: game.getAllPrefabs(),
    scripts: scriptsByName,
    layers: getLayerNames(),
    navAreas: getNavAreaNames(),
    tags: getTagNames(),
    // Editor UI state that should also survive a reload so the project
    // doesn't just contain the same DATA but LOOKS different the moment
    // you open it (nothing selected, wrong folder tab open, etc — see
    // ProjectStorage.js's module doc comment / the "does it look
    // exactly the same" bar this whole feature is held to).
    ui: {
      selectedId: editorState.selectedId || null,
      selectedIds: editorState.selectedIds || [],
      projectFolder: editorState.projectFolder || "scenes",
    },
  };
}

/**
 * Applies a previously-saved snapshot to the live game/editor,
 * replacing whatever is currently loaded — same "load is not a merge"
 * semantics and same ordering (assets + prefabs + scripts + layers +
 * tags before scenes) as ProjectIO.js's importProject(), for the same
 * reason: scene entities reference sprite/audio keys, prefab ids, and
 * script names by string.
 *
 * Also restores editor UI state (selection, which Project panel folder
 * was open) captured in the snapshot's `ui` block — done LAST, after
 * scenes are loaded, since a selected entity id only makes sense once
 * the scene that actually contains it is live.
 *
 * @param {ReturnType<import('../../runtime/index.js').createGame>} game
 * @param {object} snapshot
 */
export async function applySnapshot(game, snapshot) {
  if (!snapshot) return;

  game.clearAllAssets();
  await game.restoreProjectAssets({
    sprites: (snapshot.assets && snapshot.assets.sprites) || [],
    frames: (snapshot.assets && snapshot.assets.frames) || [],
    audio: (snapshot.assets && snapshot.assets.audio) || [],
  });

  // Prefabs restored right after assets, before scenes — same ordering
  // reason as assets/scripts/layers/tags above: scene entities can
  // reference a prefabId by string (Entity.prefabId), so the catalogue
  // needs to exist before those references are meaningful, even though
  // nothing here actually FAILS if the ordering were reversed (a
  // prefabId that doesn't resolve yet is just treated as "not linked"
  // — see PrefabRegistry.deletePrefab()'s doc comment — so this is a
  // belt-and-suspenders consistency choice, not a hard requirement).
  game.clearAllPrefabs();
  game.restoreProjectPrefabs(snapshot.prefabs || []);

  replaceAllScripts(snapshot.scripts || {});
  if (!snapshot.scripts) seedScriptStorageFromScenes(snapshot.scenes);
  syncScriptSourcesInScenes(snapshot.scenes);

  if (snapshot.layers) replaceAllLayerNames(snapshot.layers);
  if (snapshot.navAreas) replaceAllNavAreaNames(snapshot.navAreas);
  if (snapshot.tags) replaceAllTagNames(snapshot.tags);

  if (snapshot.scenes && snapshot.scenes.length) {
    game.replaceAllScenesAndLoad(snapshot.scenes, snapshot.activeSceneId);
  }

  // Restore selection/panel state now that the real scene (with the
  // real entity ids) is loaded. Validated against the live World so a
  // stale id from a scene that no longer exists (e.g. saved mid-edit
  // right before a delete never got flushed) can't leave the
  // Inspector pointing at nothing instead of just falling back to "no
  // selection" cleanly.
  const ui = snapshot.ui || {};
  if (ui.selectedId && game.world && game.world.entities.has(ui.selectedId)) {
    editorState.selectedId = ui.selectedId;
    editorState.selectedIds = Array.isArray(ui.selectedIds) && ui.selectedIds.length
      ? ui.selectedIds.filter((id) => game.world.entities.has(id))
      : [ui.selectedId];
  }
  if (ui.projectFolder) {
    editorState.projectFolder = ui.projectFolder;
  }

  // What just got applied IS what's stored (this snapshot came FROM
  // storage — either the normal autosave slot on initial load, or the
  // FSA backup folder on a manual restore), so there are no "unsaved
  // changes" relative to it yet. Without this, the reload/close guard
  // (see EditorState.js's markDirty doc comment) would immediately warn
  // "you have unsaved changes" the instant a project finishes loading,
  // which is wrong — nothing has been edited yet.
  markClean();
}

/**
 * Persists the current project state under its launcher-assigned id.
 * Never throws — RealotPersistence.setItem() already swallows/reports its
 * own storage errors, so a failed autosave degrades to "kept in memory
 * for this tab only" rather than crashing the editor loop.
 *
 * NOTE: this only performs the normal async, tiered save (localStorage
 * or IndexedDB, whichever fits — see RealotPersistence.js's setItem doc
 * comment — plus the best-effort FSA mirror). It does NOT include the
 * synchronous safety-net write RealotPersistence.js's setItemSync()
 * provides — that's called directly by startAutosave()'s runSave()
 * for pagehide/beforeunload specifically, BEFORE this function, so it
 * can never end up waiting behind this function's own inFlight
 * guard/wait-loop. See runSave()'s doc comment for the full reasoning.
 *
 * @param {string} projectId
 * @param {ReturnType<import('../../runtime/index.js').createGame>} game
 * @param {string} projectName
 * @returns {Promise<{ok:boolean, tier:string}>}
 */
export async function saveProjectSnapshot(projectId, game, projectName) {
  if (!projectId || !game) return { ok: false, tier: "none" };
  const snapshot = buildSnapshot(game, projectName);
  return _persistence().setItem(snapshotKey(projectId), snapshot);
}

/**
 * Loads a project's snapshot (if one exists) and applies it. Returns
 * null (a no-op for the caller) when this project has never been
 * saved before — e.g. the very first time a freshly-created launcher
 * project is opened, which should just boot the engine's normal blank
 * starter scene instead.
 *
 * IMPORTANT: this ALWAYS normalizes the shared, per-browser registries
 * (scripts, physics layers, tags — see the big doc comment at the top
 * of this file for why those three are shared/global storage, unlike
 * scenes/assets which live entirely inside the snapshot itself). Even
 * on the "no snapshot yet" path, those three are explicitly reset to
 * clean defaults here — WITHOUT this, a brand-new project (or any
 * project loaded fresh in a browser that had a DIFFERENT project open
 * previously) would silently inherit that other project's scripts/
 * layer names/tags, since those three registries are otherwise just
 * sitting in shared localStorage keys with no per-project awareness of
 * their own.
 *
 * @param {string} projectId
 * @param {ReturnType<import('../../runtime/index.js').createGame>} game
 * @returns {Promise<object|null>} the applied snapshot, or null
 */
export async function loadProjectSnapshot(projectId, game) {
  if (!projectId) return null;
  const snapshot = await _persistence().getItem(snapshotKey(projectId));
  if (!snapshot) {
    clearAllScripts();
    replaceAllLayerNames(getDefaultLayerNames());
    replaceAllNavAreaNames(getDefaultNavAreaNames());
    replaceAllTagNames(getDefaultTagNames());
    return null;
  }
  await applySnapshot(game, snapshot);
  return snapshot;
}

/**
 * Reads the project id the editor was opened with from the URL (set by
 * the launcher's js/utils/nav.js openEditor()). Falls back to a stable
 * per-tab id ("__unsaved__") when the editor is opened directly
 * (outside the launcher, e.g. a bookmarked/dev URL) so autosave still
 * works standalone instead of silently doing nothing.
 * Also reads `template` (set by the launcher's js/utils/nav.js
 * openEditor() only for a template that has real bundled data to seed
 * from — see its own doc comment) — the id of the template this
 * project should be seeded from on its very first open, when no saved
 * snapshot exists yet. See loadInitialProject() in SceneViewport.js.
 *
 * @returns {{ id: string, name: string|null, isLauncherProject: boolean, templateId: string|null }}
 */
export function getProjectIdentityFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("project");
  const name = params.get("name");
  const templateId = params.get("template");
  if (id) return { id, name, isLauncherProject: true, templateId };
  return { id: "__unsaved__", name: name || null, isLauncherProject: false, templateId };
}

/**
 * Starts the 1-minute autosave loop. Also saves immediately on tab
 * close/hide (see below) so a save is never more than ~60s (or one
 * "user actually left") stale — satisfies "when disconnected" (the tab
 * closing/losing focus/navigating away all count) without needing a
 * real network-disconnect signal, which the editor has no way to
 * detect for a purely local/offline-capable project anyway.
 *
 * @param {() => {projectId:string, game:object, projectName:string}} getContext
 *   returns the current save target; re-invoked on every tick so it
 *   always reflects whatever project/game is live right now.
 * @param {(result:{ok:boolean, tier:string}, reason:string, consecutiveFailures:number) => void} [onSaved]
 * @returns {{ stop: () => void, saveNow: () => Promise<{ok:boolean, tier:string}> }}
 */
export function startAutosave(getContext, onSaved) {
  let stopped = false;
  let inFlight = false;
  // Tracks how many autosaves IN A ROW have failed. Passed to onSaved
  // so the caller (main.js) can decide when a failure stops being a
  // transient blip (network hiccup, momentary IDB lock) and becomes
  // worth interrupting the user for — see main.js's onSaved callback.
  // Reset to 0 on any successful save.
  let consecutiveFailures = 0;

  async function runSave(reason) {
    if (stopped) return { ok: false, tier: "none" };
    // "pagehide" covers BOTH the pagehide event and beforeunload (see
    // onPageHide()/its registration further below in this file — both
    // listeners call the exact same function with the same "pagehide"
    // reason string, so there's no separate "beforeunload" string to
    // match here).
    const isExitReason = reason === "pagehide";
    // "Exit" reasons are racing an actual page unload the browser will
    // NOT wait for, so their synchronous localStorage safety-net write
    // (see setItemSync's doc comment in RealotPersistence.js) must happen
    // RIGHT HERE, unconditionally and before anything below that could
    // wait on an in-flight promise — an unrelated save already in
    // flight (interval tick, another exit handler) must never delay
    // this. It's intentionally a SEPARATE, immediate call rather than
    // relying on the sync:true passed to saveProjectSnapshot() further
    // down: that call may sit behind the inFlight wait-loop below for
    // an unbounded (if rare) amount of time, which the exit case can't
    // afford — the page can finish tearing down while that loop is
    // still polling.
    if (isExitReason) {
      const ctx = getContext();
      if (ctx && ctx.projectId && ctx.game) {
        try {
          _persistence().setItemSync(snapshotKey(ctx.projectId), buildSnapshot(ctx.game, ctx.projectName));
        } catch (err) {
          console.error("[ProjectStorage] Synchronous exit-save failed (non-fatal):", err);
        }
      }
    }
    // A manual "Save Now" click (reason==="manual" — see Toolbar.js's
    // "save-now" action) OR an exit reason arriving while an autosave
    // tick is already mid-flight should still ATTEMPT the full async
    // save (IndexedDB tier, FSA mirror, proper onSaved/markClean
    // reporting) rather than silently no-op'ing the way a background
    // interval tick does — the synchronous write above is a safety net
    // for localStorage-sized projects specifically, not a substitute
    // for the real save for anyone relying on the IndexedDB tier. A
    // background interval tick can still just skip itself; another one
    // is coming.
    if (inFlight) {
      if (reason !== "manual" && !isExitReason) return { ok: false, tier: "none" };
      while (inFlight) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Whatever that in-flight save resolved to already ran
      // onSaved()/markClean() for its own reason; re-run a fresh save
      // for THIS manual request so the button's own caller gets an
      // up-to-date result reflecting anything edited in the meantime.
    }
    const ctx = getContext();
    if (!ctx || !ctx.projectId || !ctx.game) return { ok: false, tier: "none" }; // e.g. initial load still in flight, or no launcher project — see callers of startAutosave
    inFlight = true;
    try {
      const result = await saveProjectSnapshot(ctx.projectId, ctx.game, ctx.projectName);
      consecutiveFailures = result && result.ok ? 0 : consecutiveFailures + 1;
      // Only a write that ACTUALLY landed in localStorage/IndexedDB
      // (result.ok) clears the unsaved-changes flag — a failed write
      // (see RealotPersistence.js's setItem, which never throws, only
      // reports {ok:false}) must leave isDirty=true so the reload/close
      // guard in main.js still warns the user, exactly the case where
      // that warning matters most (storage is full/broken AND the tab
      // is about to be closed/refreshed).
      if (result && result.ok) markClean();
      if (onSaved) onSaved(result, reason, consecutiveFailures);
      return result;
    } catch (err) {
      // Autosave must never throw into the caller's timer/event loop —
      // worst case this tick's save is lost, the next tick (or the
      // next visibilitychange) tries again.
      consecutiveFailures += 1;
      const result = { ok: false, tier: "none", error: err };
      if (onSaved) onSaved(result, reason, consecutiveFailures);
      console.error("[ProjectStorage] Autosave failed:", err);
      return result;
    } finally {
      inFlight = false;
    }
  }

  const intervalHandle = setInterval(() => runSave("interval"), AUTOSAVE_INTERVAL_MS);

  // "When disconnected": the closest a purely client-side editor gets
  // to a real disconnect signal is the user actually leaving — tab
  // closing, navigating back to the launcher, switching tabs, or the
  // OS putting the browser in the background. Covering all of these
  // (not just the interval) is what makes "leave and come back and
  // nothing changed" actually hold even if someone closes the tab
  // 10 seconds after an edit, well inside the 1-minute interval.
  function onVisibilityChange() {
    if (document.visibilityState === "hidden") runSave("visibilitychange");
  }
  function onPageHide() {
    runSave("pagehide");
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  // beforeunload's own save can't reliably await an async IndexedDB
  // write before the page actually unloads, but pagehide (which fires
  // in the same situations, including back/forward-cache navigation)
  // already covers the same cases — beforeunload is kept only as a
  // best-effort extra attempt for browsers where pagehide timing
  // differs. The RELOAD/CLOSE WARNING (native "leave site?" prompt) is
  // wired separately in main.js, keyed off dirtyState.isDirty —
  // that one has to be registered directly on window by main.js itself
  // (a beforeunload listener must call preventDefault()/set
  // returnValue synchronously to show the browser's prompt, which
  // isn't this function's job — this listener's only job is firing off
  // the best-effort background save).
  window.addEventListener("beforeunload", onPageHide);

  return {
    stop: function stopAutosave() {
      stopped = true;
      clearInterval(intervalHandle);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
    },
    /**
     * Triggers an immediate save outside the normal interval/visibility
     * cadence, for the toolbar's manual "Save Now" button (see
     * Toolbar.js/EditorEvents.js's "save-now" action) — the explicit,
     * user-requested equivalent of an autosave tick, reported through
     * the SAME onSaved callback so the status bar / failure dialog
     * behave identically whether a save happened automatically or was
     * asked for directly.
     * @returns {Promise<{ok:boolean, tier:string}>}
     */
    saveNow: function saveNow() {
      return runSave("manual");
    },
  };
}
