/**
 * editor/state/EditorState.js
 *
 * Editor-only UI state: which tool is active, what's selected, panel
 * open/closed flags. This is NOT game state — the actual scene data
 * lives in the runtime's World (see runtime/core/World.js), reached
 * through editorState.world.
 */

import { loadPanelVisibility } from "./PanelVisibility.js";

export const editorState = {
  /** Window menu: which big panels are shown (hierarchy / assets / inspector).
   *  Loaded from localStorage so the user's layout survives a reload. */
  panelVisible: loadPanelVisibility(),

  /** @type {import('../../runtime/core/World.js').World|null} set during editor boot */
  world: null,

  /** @type {ReturnType<import('../../runtime/index.js').createGame>|null} set during editor boot */
  game: null,

  activeTool: "translate",
  selectedId: null,
  /** @type {string[]} ids of ALL selected entities (multi-select).
   *  selectedId is the PRIMARY (last-clicked) — the one the Inspector
   *  and transform gizmo operate on. selectedIds always contains
   *  selectedId. Plain click sets both to a single id; Shift+click
   *  toggles membership (and updates the primary). Delete / Copy /
   *  Duplicate act on every id in here. */
  selectedIds: [],
  animOpen: false,
  physicsLayersOpen: false,
  navAreasOpen: false,
  /** @type {boolean} whether the "Load Script" picker popup is open (see
   *  ScriptPickerWindow.js) */
  scriptPickerOpen: false,

  /** @type {boolean} whether the "Choose Sprite" picker popup is open
   *  (see SpritePickerWindow.js) — same convention as scriptPickerOpen
   *  above, just for the Sprite Renderer's texture-swap button instead
   *  of the Script component's "Load Script" button. */
  spritePickerOpen: false,
  /** @type {"SpriteRenderer"|"StrokePath"} which component the sprite
   *  picker's current selection should be written onto — the same
   *  asset-picker window is reused for choosing a SpriteRenderer's
   *  sprite AND a StrokePath's fill texture (both just want "pick one
   *  imported image asset"), rather than duplicating an entire modal
   *  for StrokePath's texture button. Set right before
   *  spritePickerOpen is turned on (see Inspector.js's "sprite-pick"
   *  button vs. its StrokePath texture-pick button, and
   *  EditorEvents.js's "open-sprite-picker" handler), read back by
   *  "sprite-picker-choose" to decide which component's field the pick
   *  actually writes to. */
  spritePickerTarget: "SpriteRenderer",

  /** @type {boolean} whether the "Export Game" popup is open (see
   *  ExportWindow.js / Toolbar.js's Export button) — same open/close
   *  convention as scriptPickerOpen/spritePickerOpen above. */
  exportOpen: false,
  /** @type {null|{phase:"running"|"done"|"error", message?:string, stats?:object, error?:string}}
   *  Live state of an in-progress or just-finished export (see
   *  editor/export/ExportGame.js's buildExport() and EditorEvents.js's
   *  "start-export" case) — reset to null by "export-window-reset"/
   *  "close-export-window" so re-opening the popup always starts back
   *  at the format picker rather than showing a stale previous result. */
  exportStatus: null,
  /** @type {string|null} game title the user typed into the Export
   *  popup (see ExportWindow.js's details step) — used for the
   *  exported <title>, manifest.webmanifest's name, and the zip's
   *  filename. Kept separate from projectName (the editor's own
   *  project name) so renaming this for a release build doesn't
   *  rename the project itself; null until the export popup is opened
   *  for the first time, at which point EditorEvents.js's
   *  "open-export-window" case seeds it from projectName as a
   *  starting point the user can then override. */
  exportGameTitle: null,
  /** @type {"checking"|"awake"|"asleep"|null} live reachability status of
   *  the Android build server (see ServerConfig.js's checkAndroidServerAwake()),
   *  refreshed each time the Export popup opens (see EditorEvents.js's
   *  "open-export-window" case) so the Android card can show whether the
   *  server is currently up rather than the user finding out only after
   *  clicking Export and waiting on a free-tier host that may be asleep.
   *  Reset to null on close so it doesn't show a stale result next time. */
  androidServerStatus: null,
  /** @type {Array<{id:string,label:string,serverUrl:string,apiKey:string}>}
   *  the user's saved Android build servers (see ServerConfig.js's
   *  listAndroidServers() — the real source of truth is localStorage;
   *  this is a cache refreshed on "open-export-window" and whenever the
   *  list changes, so ExportWindow.js can render synchronously without
   *  every render() re-reading localStorage). */
  androidServers: [],
  /** @type {string|null} id of the currently-selected server in
   *  androidServers above (see ServerConfig.js's getActiveAndroidServer()) —
   *  cached the same way and for the same reason as androidServers. */
  androidActiveServerId: null,
  /** @type {boolean} whether the "add/edit Android build server" form is
   *  expanded in the Export popup's Android card. */
  androidServerFormOpen: false,
  /** @type {string|null} id of the server being edited if the form above
   *  was opened via "android-server-edit-open"; null means the form will
   *  add a new server on save rather than update an existing one. */
  androidServerFormEditingId: null,
  /** @type {string} live-buffered form fields for the add/edit server
   *  form (same live-buffer-without-render pattern as exportGameTitle —
   *  see EditorEvents.js's input handler for these). */
  androidServerFormLabel: "",
  androidServerFormUrl: "",
  androidServerFormKey: "",
  /** @type {string} inline validation message for the add/edit server form */
  androidServerFormError: "",
  /** @type {{dataUrl: string, name: string}|null} the favicon the user
   *  picked in the Export popup, held as a plain dataUrl (this is a
   *  single small icon someone picks once per export session, not a
   *  cataloged reusable asset like AssetRegistry's sprites — no need
   *  for the editor's full asset-registration pipeline here). Persists
   *  across re-exports in the same editor session until the user picks
   *  a different file; cleared only by reloading the editor. */
  exportFavicon: null,
  /** @type {{blob: Blob, format: "html"|"pwa", title: string}|null}
   *  Most recently generated web export. Kept in memory so the user can
   *  send the exact archive they just exported to the Android build server
   *  without downloading it and uploading it manually. The APK builder must
   *  consume this same standalone package so HTML/PWA/APK stay in sync. */
  lastWebExport: null,

  /** @type {string} live search text typed into the "Add Component"
   *  picker (see AddComponentWindow.js) — same convention as
   *  hierarchyFilter below, just scoped to that popup's own list
   *  instead of the Hierarchy panel. Reset to "" whenever the popup is
   *  closed (see EditorEvents.js's "close-add-component"/
   *  "add-component-choice" cases) so it never carries over stale text
   *  into the next time the picker is opened. */
  addComponentFilter: "",

  isPlaying: false,
  isPaused: false,
  /** @type {boolean} cached (last-known) status of whether an FSA
   *  backup directory is currently granted and usable — see
   *  RealotPersistence.js's isFsaBackupEnabled(), which is async
   *  (queries IndexedDB) and so can't be called inline from
   *  Toolbar.js's synchronous renderToolbar(). Refreshed on editor
   *  boot and right after a successful enable-fsa-backup action (see
   *  EditorEvents.js's "enable-fsa-backup" case) — a plain cached
   *  flag, same convention as every other editorState UI flag here. */
  fsaBackupEnabled: false,
  /** @type {boolean} whether "Save Project" should run the optional
   *  lossless asset-optimization pass (see ProjectIO.js's
   *  optimizeProjectAssets()) before zipping — re-runs PNGs through a
   *  stronger, still-pixel-identical encoder and losslessly repacks
   *  WAV audio. Off by default since it adds real time to the save
   *  (re-encoding every PNG is not instant) for a size win that only
   *  matters once a project has accumulated a lot of art/audio — see
   *  the "Optimize Assets on Save" menu item in Toolbar.js's
   *  renderFileMenu(), which toggles this. Persists only for the
   *  current editor session (not written to the project file itself)
   *  by the same convention as fsaBackupEnabled above.
   */
  optimizeAssetsOnSave: false,
  /** @type {(() => Promise<{ok:boolean, tier:string}>)|null} set by
   *  main.js once autosave boots (see startAutosave's returned
   *  saveNow) — the toolbar's manual "Save Now" button calls this
   *  directly rather than duplicating the save path. Null for an
   *  editor opened standalone (no launcher project, no autosave). */
  saveNow: null,
  hierarchyFilter: "",
  bottomTab: "project",
  /** @type {"scenes"|"sprites"|"scripts"} which Project > Assets folder is open in the bottom panel */
  projectFolder: "scenes",
  sectionsOpen: { transform: true, camera: true, sprite: true, rigidbody: true, collider: true, movement: true, spriteanimation: true, light: true, shadowcaster: true, lightingsettings: true, tileset: true, tilemap: true, navworld2d: true, navagent2d: true, script: true },
  addComponentMenuOpen: false,
  /** @type {string|null} section key to reveal and scroll to after adding */
  inspectorScrollTo: null,

  /** Scene-view display toggle for NavWorld2D cells (green=walkable,
   *  red=blocked) — see Toolbar.js's "Show Nav World Cells" button and
   *  NavWorldGizmo.js's draw logic. Editor-only, same as every other
   *  Scene-view gizmo toggle; never affects the shipped game. Off by
   *  default so a scene with a large baked grid doesn't suddenly cover
   *  the viewport the first time this feature is used. */
  showNavWorld: false,
  /** "bounds" is the cheap NavWorld2D size gizmo; "cells" is the optional
   * detailed grid visualization. The editor defaults to bounds so a huge
   * open-world bake never tanks viewport performance just because a
   * NavWorld2D exists. */
  navWorldViewMode: "bounds",
  /** Nav paint brush radius in cells. 0 means one cell. */
  navBrushRadius: 0,
  /** Area slot index (0-15) the "nav-area" tool paints onto cells — see
   *  Toolbar.js's area picker (only shown while that tool is active)
   *  and SceneViewport.js's _paintNavCellAtClientPos "area" mode.
   *  Defaults to slot 0 (Ground), same default a freshly-baked cell
   *  already has, so picking up the brush without touching the picker
   *  paints the same value cells already start at. */
  activeNavAreaIndex: 0,
  /** @type {string|null} entity id of the NavAgent2D currently being
   *  previewed via the Inspector's "Show Agent Navigation" toggle (see
   *  Inspector.js's NavAgent2D section and NavWorldGizmo.js's
   *  radius-aware draw path). null means no per-agent preview is
   *  active and the normal showNavWorld/navWorldViewMode gizmo (which
   *  always shows the base, radius-0 layer) applies instead. Selecting
   *  a different entity does NOT clear this on its own — it stays
   *  pinned to whichever agent's radius the developer was debugging
   *  until they explicitly turn the toggle off, same as showNavWorld's
   *  own persistence across selection changes. */
  navAgentPreviewEntityId: null,

  /** @type {string|null} which top menu-bar dropdown is open ("GameObject", etc), or null */
  openMenu: null,

  /** @type {string|null} which submenu within the open menu is open ("Light"), or null */
  openSubmenu: null,
  logs: [{ type: "log", msg: "Editor initialized successfully." }],

  /** @type {string|null} project name last used for Save Project — see
   *  ProjectIO.js. Remembered so re-saving in the same session doesn't
   *  need retyping the name every time (just prefilled in the prompt). */
  projectName: null,

  /** @type {string|null} the launcher-assigned id for the project
   *  currently open (see ProjectStorage.js's getProjectIdentityFromUrl,
   *  the source of truth this is copied from at boot — see main.js).
   *  null when the editor was opened standalone, with no launcher
   *  project (e.g. no ?project= in the URL). Kept here — not just read
   *  from the URL fresh each time — so EditorEvents.js's per-project
   *  FSA backup actions (enable-fsa-backup, restore-fsa-backup) don't
   *  need their own import of ProjectStorage.js just to re-derive the
   *  same id main.js already resolved once at boot. */
  projectId: null,

  /** @type {string|null} id of the scene file currently mid-inline-rename (in the
   *   Project > Scenes folder grid), or null */
  renamingSceneId: null,

  /** @type {string|null} id of a Hierarchy folder (World.hierarchyFolders)
   *  currently mid-inline-rename, or null. Same pattern as
   *  renamingSceneId above: double-click a folder's label to enter,
   *  Enter/blur commits, Escape cancels (see EditorEvents.js). */
  renamingFolderId: null,

  /** @type {string|null} id of the entity currently being dragged in the
   *  Hierarchy panel (native HTML5 drag-and-drop, dataTransfer doesn't
   *  survive a full render() rebuild mid-drag so this is tracked here
   *  instead — same reasoning as editorState.anim.draggingFrameIndex /
   *  editorState.tilesetPanel.draggingRole for the Animation/Tileset
   *  panels' own drag-and-drop). Null when no Hierarchy drag is active.
   *  Mutually exclusive with draggingFolderId below — only one kind of
   *  Hierarchy row can be dragged at a time. */
  draggingEntityId: null,

  /** @type {string[]} every entity id being dragged together — when the
   *  row grabbed to start the drag (draggingEntityId) is part of the
   *  current multi-selection (editorState.selectedIds), the WHOLE
   *  selection moves together into/out of the drop target's folder,
   *  matching a normal file manager's "drag a multi-selection" behavior.
   *  Always contains draggingEntityId; empty when nothing is dragging. */
  draggingEntityIds: [],

  /** @type {string|null} id of the Hierarchy folder currently being
   *  dragged (to reparent it under another folder, or to the root),
   *  same lifecycle/reasoning as draggingEntityId above. */
  draggingFolderId: null,

  /** @type {{kind:"sprite"|"audio"|"script", key:string}|null} the asset
   *  currently mid-inline-rename in the Project panel's Sprites/Audio/
   *  Scripts folder grid, or null. One shared field (not three separate
   *  ones) since only one asset can ever be mid-rename at a time —
   *  mirrors renamingSceneId above, generalized across asset kinds.
   *  "key" is the sprite/audio asset's key OR the script's name (scripts
   *  are identified by name, not a separate key — see
   *  editor/scripting/ScriptStorage.js). */
  renamingAsset: null,

  /** @type {string|null} id of the scene file single-click-selected (but not
   *   yet opened) in the Project > Scenes folder grid, or null */
  selectedSceneFileId: null,

  /** Animation panel (editor/panels/AnimationWindow.js) UI state — kept
   *  here (not local module state) because the whole editor re-renders
   *  its entire innerHTML from editorState on every change (see
   *  editor/main.js's render()), so anything that must survive a
   *  re-render has to live here, the same reason selectedSceneFileId
   *  and renamingSceneId above do. */
  anim: {
    /** @type {string|null} id of the clip currently being edited/previewed
     *  in the panel — INDEPENDENT of SpriteAnimation.currentClipId,
     *  since the panel should stay open on whatever clip the user is
     *  authoring even if gameplay (or the Inspector) switches the
     *  entity's actual playing clip elsewhere. */
    editingClipId: null,
    /** @type {number} which frame is shown in the panel's own preview,
     *  independent of the live component's currentFrameIndex */
    previewFrameIndex: 0,
    /** whether the panel's own preview is actively auto-advancing */
    previewPlaying: false,
    /** @type {number|null} index of the frame currently being dragged
     *  for reorder, or null */
    draggingFrameIndex: null,
    /** @type {string|null} id of a clip whose name is being inline-edited */
    renamingClipId: null,
    /** @type {{cols:number, rows:number}|null} pending manual grid
     *  override for the NEXT sprite-sheet import — set via the panel's
     *  "Slice Sheet" dialog before the file picker's change event fires */
    pendingSheetGrid: null,
    /** whether the Animation panel's preview overlays the current
     *  collider (clip override, or else the entity's base Collider2D)
     *  as a sized outline on top of the frame thumbnail */
    showColliderInPreview: false,
  },
  /** Render function reference — set by main.js so any module can
   *  trigger an editor re-render (e.g. the script editor opening/closing). */
  renderFn: null,

  /** Script editor (editor/panels/ScriptEditorWindow.js) UI state. */
  scriptEditor: {
    open: false,
    /** @type {string[]} script names currently open as tabs */
    openTabs: [],
    /** @type {string|null} currently active tab */
    activeTab: null,
    /** @type {Object<string, string[]>} per-script component keys forced to
     *  appear in autocomplete (API Management panel). Keyed by script name so
     *  overrides for one script never bleed into another. */
    forcedApis: {},
    /** @type {Object<string,{entityId:string|null,entityIds:string[]|null}>}
     *  Per-script IntelliSense context. Set when a script is opened
     *  via an object (entityId) or the Scripts folder (entityIds =
     *  every object that shares the script, so autocomplete offers the
     *  UNION of their components). The IntelliSense provider reads the
     *  entry for the active tab (see ScriptIntelliSense.js). */
    contextByScript: {},
  },

  /** Tileset Editor panel (editor/panels/TilesetPanel.js) UI state —
   *  kept here for the same reason `anim` above is: the whole editor
   *  re-renders its innerHTML from editorState on every change, so
   *  anything that must survive a re-render lives here rather than as
   *  local module state. */
  tilesetPanel: {
    open: false,
    /** @type {string|null} id of the entity whose Tileset component this
     *  window is editing — independent of editorState.selectedId so the
     *  window keeps editing the SAME tileset even if the Hierarchy
     *  selection changes while it's open. */
    entityId: null,
    /** @type {string|null} role of the slot currently being dragged for
     *  a swap, or null */
    draggingRole: null,
  },
};

/**
 * markDirty()/markClean() — the single source of truth for "does this
 * project have unsaved changes right now." Backs three things at once:
 *   1. StatusBar.js's autosave indicator text ("Unsaved changes" vs
 *      "Saved").
 *   2. main.js's beforeunload handler, which only shows the browser's
 *      native "leave site?" confirmation while this is true, so a
 *      reload/close is never interrupted for a project that's already
 *      fully saved.
 *   3. Toolbar.js's manual "Save Now" button, which the autosave-failure
 *      flow points users at.
 *
 * markDirty() is called from UndoManager.js's snapshotNow()/commitEdit()/
 * undo()/redo() — the same four choke points every scene mutation
 * (delete, add entity, add/remove component, field edit, gizmo drag,
 * tile paint, undo, redo) already funnels through for history tracking,
 * so this needs no separate wiring at each of the dozens of call sites
 * that trigger those.
 *
 * ALSO called from ScriptEditorWindow.js's _scheduleSave() (Monaco's
 * debounced auto-save) — script edits are deliberately NOT run through
 * UndoManager.js's scene/anim stacks (Monaco owns its own undo/redo;
 * see UndoManager.js's file doc comment), but "does this project have
 * unsaved changes" is a separate concern from undo-history scoping, and
 * a script edit is exactly as much an unsaved change as a scene edit
 * is — so it gets its own direct call here instead of going through
 * UndoManager.
 *
 * markClean() is called by ProjectStorage.js's runSave() after a
 * snapshot write actually succeeds.
 */
export const dirtyState = {
  /** @type {boolean} */
  isDirty: false,
};

export function markDirty() {
  dirtyState.isDirty = true;
}

export function markClean() {
  dirtyState.isDirty = false;
}

export function pushLog(type, msg) {
  // Unity-style console collapse: if the last entry has the exact same
  // type and message, increment its count instead of adding a new line.
  // This prevents a console.log() called every frame from spamming the
  // panel — it shows "hi ×30" instead of 30 separate "hi" rows.
  const last = editorState.logs[editorState.logs.length - 1];
  if (last && last.type === type && last.msg === msg) {
    last.count = (last.count || 1) + 1;
    return;
  }
  editorState.logs.push({ type, msg, count: 1 });
}
