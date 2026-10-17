/**
 * editor/panels/Toolbar.js
 *
 * Top menu bar + tool selection (pan/translate/rotate/scale) + play
 * controls. Editor-only.
 *
 * The "GameObject" menu is the Unity-style entry point for spawning new
 * entities into the scene, including the 4 light types (Directional,
 * Point, Spot, Area — see runtime/components/Light.js). Clicking
 * "GameObject" opens a dropdown; hovering/clicking "Light" opens a
 * submenu listing the 4 types; clicking a type creates that light
 * centered in the current scene (see EditorEvents.js "create-light").
 */

import { icon } from "../icons/IconLibrary.js";
import { editorState, dirtyState } from "../state/EditorState.js";
import { LightType } from "../../runtime/components/Light.js";
import { TILEMAP } from "../../runtime/components/Tilemap.js";
import { TILESET } from "../../runtime/components/Tileset.js";
import { NAV_WORLD_2D } from "../../runtime/components/NavWorld2D.js";
import { STROKE_PATH } from "../../runtime/components/StrokePath.js";
import { ShapeType } from "../../runtime/components/ShapeRenderer.js";
import { getNamedNavAreas } from "../state/NavAreas.js";
import { PANEL_IDS, PANEL_LABELS } from "../state/PanelVisibility.js";

const MENUS = ["File", "Edit", "GameObject", "UI", "Window"];

const LIGHT_MENU_ITEMS = [
  { type: LightType.DIRECTIONAL, label: "Directional Light" },
  { type: LightType.POINT, label: "Point Light" },
  { type: LightType.SPOT, label: "Spot Light" },
  { type: LightType.AREA, label: "Area Light" },
  { type: LightType.GOD_RAYS, label: "God Rays" },
  { type: LightType.FREEFORM, label: "Freeform Light" },
];

// GameObject -> Shape submenu — one entry per ShapeRenderer/Collider2D
// shape type (see ShapeRenderer.js's ShapeType, which Collider2D.js's
// ColliderShape mirrors 1:1 apart from BOX being called SQUARE there).
// Picking one here creates a plain GameObject with BOTH a ShapeRenderer
// (so it's visible) and a matching Collider2D (so it participates in
// physics) already set to that shape — see EditorEvents.js's
// "create-shape" case.
const SHAPE_MENU_ITEMS = [
  { type: ShapeType.SQUARE, label: "Square", iconName: "square" },
  { type: ShapeType.CIRCLE, label: "Circle", iconName: "circle" },
  { type: ShapeType.CAPSULE, label: "Capsule", iconName: "capsule" },
  { type: ShapeType.TRIANGLE, label: "Triangle", iconName: "triangle" },
];

// UI menu — one shortcut per UI-flavored runtime component (the exact
// same 5 components AddComponentWindow.js already lists under its own
// Text/Speech Bubble/Chat Log/Text Input/Joystick rows — see that
// file's _computeAvailableToAdd). Each entry here is just a shortcut
// that creates an empty GameObject and auto-attaches that ONE
// component, same "no new invention" convention as every other
// GameObject menu entry (e.g. "create-light" adds a plain entity + a
// Light component) — see EditorEvents.js's "create-ui" case.
const UI_MENU_ITEMS = [
  { componentName: "TextRenderer", label: "Text", entityName: "Text", iconName: "message" },
  { componentName: "SpeechBubble", label: "Speech Bubble", entityName: "Speech Bubble", iconName: "message" },
  { componentName: "ChatLog", label: "Chat Log", entityName: "Chat Log", iconName: "message" },
  { componentName: "TextInput", label: "Message Input", entityName: "Message Input", iconName: "message" },
  { componentName: "Joystick", label: "Joystick", entityName: "Joystick", iconName: "joystick" },
];

export function renderToolbar() {
  const world = editorState.world;
  const hasTilemap = !!world && world.query(TILEMAP).length > 0;
  const hasTileset = !!world && world.query(TILESET).length > 0;
  const hasNavWorld = !!world && world.query(NAV_WORLD_2D).length > 0;
  const hasStrokePath = !!world && world.query(STROKE_PATH).length > 0;

  const tools = [
    { id: "pan", iconName: "hand", shortcut: "Q" },
    { id: "translate", iconName: "move", shortcut: "W" },
    { id: "rotate", iconName: "refreshcw", shortcut: "E" },
    { id: "scale", iconName: "maximize2", shortcut: "R" },
  ];
  if (hasTilemap || hasTileset) tools.push({ id: "tile", iconName: "grid", shortcut: "T" });
  if (hasTilemap || hasNavWorld) tools.push({ id: "erase", iconName: "trash", shortcut: "Y" });
  // Path tool only shows once a Stroke Path object exists in the scene —
  // same "hidden until relevant" convention as tile/erase/nav-* below.
  if (hasStrokePath) {
    tools.push({
      id: "path",
      iconName: "waypoints",
      shortcut: "P",
      hint: "click empty space: append point to selected Stroke Path · drag a point: move it · click a segment: insert a point",
    });
  }
  if (hasNavWorld) {
    tools.push({ id: "nav", iconName: "route", shortcut: "U", hint: "click: walkable · alt+click: clear override" });
    tools.push({ id: "nav-block", iconName: "x", shortcut: "I", hint: "click: blocked · alt+click: clear override" });
    tools.push({ id: "nav-area", iconName: "layers", shortcut: "O", hint: "click: tag area · alt+click: clear area" });
  }

  return (
    '<div class="toolbar-wrap">' +
    '<div class="menu-bar">' +
    MENUS.map((m) => renderMenu(m)).join("") +
    "</div>" +
    '<div class="main-toolbar">' +
    '<div class="tool-group">' +
    tools
      .map(
        (t) =>
          '<button class="tool-btn' +
          (editorState.activeTool === t.id ? " active" : "") +
          '" data-action="set-tool" data-tool="' +
          t.id +
          '" title="' + t.id + ' (' + t.shortcut + ')' + (t.hint ? ' \u2014 ' + t.hint : '') + '"' +
          '">' +
          icon(t.iconName, 13) +
          "</button>"
      )
      .join("") +
    "</div>" +
    (hasNavWorld ? (
      '<div class="tool-group nav-display-group" style="gap:2px;margin-left:4px;">' +
        '<button class="tool-btn' + (editorState.navWorldViewMode === "bounds" ? " active" : "") +
        '" data-action="set-navworld-view" data-view="bounds" title="Show Nav World Bounds (cheap)">' +
        icon("box", 12) + '</button>' +
        '<button class="tool-btn' + (editorState.navWorldViewMode === "cells" ? " active" : "") +
        '" data-action="set-navworld-view" data-view="cells" title="Show Nav World Cells (detailed)">' +
        icon("grid", 12) + '</button>' +
      '</div>' +
      '<div class="nav-brush-control" style="display:flex;align-items:center;gap:2px;margin-left:5px;">' +
        '<button class="tool-btn" data-action="nav-brush-decrease" title="Decrease Nav Brush">−</button>' +
        '<span style="font-size:10px;color:#9aa4b2;min-width:42px;text-align:center;">Brush ' +
          (editorState.navBrushRadius * 2 + 1) + '</span>' +
        '<button class="tool-btn" data-action="nav-brush-increase" title="Increase Nav Brush">+</button>' +
      '</div>' +
      // Area picker — only shown while the Area brush (O) is selected,
      // same "controls only appear when relevant" convention the brush
      // size control itself follows (nav-brush-control is hidden
      // entirely when there's no NavWorld2D at all). Painting with the
      // Area brush writes editorState.activeNavAreaIndex onto every
      // cell it touches — see SceneViewport.js's "area" paint mode.
      (editorState.activeTool === "nav-area" ? renderNavAreaPicker() : "")
    ) : "") +
    '<div class="play-controls-wrap"><div class="play-group">' +
    '<button class="play-btn' +
    (editorState.isPlaying ? " active" : "") +
    '" data-action="toggle-play" title="' + (editorState.isPlaying ? "Stop" : "Play") + '">' +
    icon("play", 13) +
    "</button>" +
    '<button class="play-btn' +
    (editorState.isPaused ? " paused" : "") +
    '"' + (editorState.isPlaying ? "" : " disabled") +
    ' data-action="toggle-pause" title="' +
    (editorState.isPlaying ? (editorState.isPaused ? "Resume" : "Pause") : "Pause (start Play first)") +
    '">' +
    icon("pause", 13) +
    "</button>" +
    "</div></div>" +
    '<div class="toolbar-right">' +
    '<button class="pill-btn" data-action="open-export-window" title="Export a standalone, playable build of your game" style="display:inline-flex;align-items:center;gap:4px;margin-right:6px;">' +
    icon("monitor", 11) +
    " Export" +
    "</button>" +
    // Plain navigation link (not a data-action) back to the launcher —
    // deliberately NOT routed through EditorEvents.js since this isn't
    // an editor/scene action, just leaving the app.
    '<a class="pill-btn" href="../../" title="Back to Hub" style="text-decoration:none;display:inline-flex;align-items:center;">' +
    icon("chevronleft", 10) +
    " Hub" +
    "</a>" +
    "</div>" +
    "</div>" +
    "</div>"
  );
}

function renderNavAreaPicker() {
  const names = getNamedNavAreas();
  const active = editorState.activeNavAreaIndex;
  return (
    '<div class="nav-area-picker" style="display:flex;align-items:center;gap:4px;margin-left:5px;">' +
      '<span style="font-size:9px;color:#7f8a99;">Paint Area:</span>' +
      (names.length
        ? '<select data-action="set-active-nav-area" style="background:#1a2030;color:#c8d0de;border:1px solid #2e3a50;border-radius:4px;padding:1px 4px;font-size:11px;">' +
          names
            .map(
              ({ index, name }) =>
                '<option value="' + index + '"' + (index === active ? " selected" : "") + '>' + name + "</option>"
            )
            .join("") +
          "</select>"
        : '<span style="font-size:9px;color:#5a6480;">No named areas — Edit \u2192 Nav Areas\u2026</span>') +
    "</div>"
  );
}

function renderMenu(name) {
  const isOpen = editorState.openMenu === name;
  return (
    '<div class="menu-wrap" style="position:relative;display:inline-block;">' +
    '<button class="menu-btn' +
    (isOpen ? " active" : "") +
    '" data-action="toggle-menu" data-menu="' +
    name +
    '">' +
    name +
    "</button>" +
    (isOpen && name === "GameObject" ? renderGameObjectMenu() : "") +
    (isOpen && name === "UI" ? renderUIMenu() : "") +
    (isOpen && name === "Edit" ? renderEditMenu() : "") +
    (isOpen && name === "File" ? renderFileMenu() : "") +
    (isOpen && name === "Window" ? renderWindowMenu() : "") +
    "</div>"
  );
}

// Window menu — one checkable row per big panel. A tick means the panel
// is showing; clicking toggles it (see EditorEvents.js "toggle-panel").
// The menu deliberately stays open after a click so several panels can be
// hidden/shown in one go.
function renderWindowMenu() {
  const visible = editorState.panelVisible || {};
  const rows = PANEL_IDS.map((id) => {
    const on = visible[id] !== false;
    return (
      '<button class="dropdown-menu-item" data-action="toggle-panel" data-panel="' + id + '" style="' +
      DROPDOWN_ITEM_STYLE + '" role="menuitemcheckbox" aria-checked="' + on + '" title="' +
      (on ? "Hide the " : "Show the ") + PANEL_LABELS[id] + '">' +
      '<span style="display:inline-block;width:12px;text-align:center;color:#7dd3fc;">' + (on ? "\u2713" : "") + "</span>" +
      "<span>" + PANEL_LABELS[id] + "</span>" +
      "</button>"
    );
  }).join("");
  const anyHidden = PANEL_IDS.some((id) => visible[id] === false);
  return (
    '<div class="dropdown-menu" style="position:absolute;top:100%;left:0;background:#2a2a2a;border:1px solid #444;' +
    'border-radius:4px;min-width:170px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.4);padding:4px 0;">' +
    rows +
    (anyHidden
      ? '<div style="height:1px;background:#444;margin:4px 0;"></div>' +
        '<button class="dropdown-menu-item" data-action="reset-panels" style="' + DROPDOWN_ITEM_STYLE + '">' +
        '<span style="display:inline-block;width:12px;"></span><span>Show All Panels</span></button>'
      : "") +
    "</div>"
  );
}

function renderFileMenu() {
  return (
    '<div class="dropdown-menu" style="position:absolute;top:100%;left:0;background:#2a2a2a;border:1px solid #444;' +
    'border-radius:4px;min-width:190px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.4);padding:4px 0;">' +
    // "Save Now" — a real, immediate, awaited save to this project's
    // autosave slot (the same localStorage/IndexedDB snapshot the
    // 1-minute autosave loop writes to — see ProjectStorage.js), as
    // opposed to "Save Project" below, which downloads a .rs. Only
    // shown for a project actually opened from the launcher — an
    // editor opened standalone has no autosave loop/project id to save
    // into at all (see EditorState.js's saveNow doc comment). The
    // button's own label reflects whether there's anything TO save
    // right now: "Save Now" (dirty) vs "Saved" (already clean), so it
    // doubles as the "does it need saving" indicator this same click
    // would otherwise leave the user guessing about.
    (editorState.saveNow
      ? '<button class="dropdown-menu-item" data-action="save-now" style="' +
        DROPDOWN_ITEM_STYLE + '" title="' +
        (dirtyState.isDirty
          ? "Save right now instead of waiting for the next auto-save. Tells you immediately if it worked."
          : "Everything is already saved — no changes since the last save.") +
        '">' +
        icon(dirtyState.isDirty ? "alerttriangle" : "info", 12) +
        "<span>" + (dirtyState.isDirty ? "Save Now (unsaved changes)" : "Saved") + "</span>" +
        "</button>" +
        '<div style="height:1px;background:#444;margin:4px 0;"></div>'
      : "") +
    '<button class="dropdown-menu-item" data-action="save-project" style="' +
    DROPDOWN_ITEM_STYLE + '">' +
    icon("download", 12) +
    "<span>Save Project</span>" +
    "</button>" +
    // Sticky (session-lifetime) toggle for the optional lossless
    // optimize pass in ProjectIO.js's exportProject() — label text
    // reflects state, same ": ON"/": OFF"/"…" convention as the
    // Extra Backup Storage item below. Clicking just flips
    // editorState.optimizeAssetsOnSave via EditorEvents.js's
    // "toggle-optimize-assets-on-save" case; it does NOT save
    // immediately — the next "Save Project" click is what actually
    // does the work, same "arm it first" pattern as enable-fsa-backup.
    '<button class="dropdown-menu-item" data-action="toggle-optimize-assets-on-save" style="' +
    DROPDOWN_ITEM_STYLE + '" title="' +
    (editorState.optimizeAssetsOnSave
      ? "On — Save Project will re-encode PNGs losslessly (UPNG.js) and repack WAV audio before zipping. Adds some time to each save."
      : "Off — Save Project uses the fast path. Turn on to also losslessly shrink PNG/WAV asset bytes on every save (slower, smaller file).") +
    '">' +
    icon("settings", 12) +
    "<span>" + (editorState.optimizeAssetsOnSave ? "Optimize Assets on Save: ON" : "Optimize Assets on Save: OFF") + "</span>" +
    "</button>" +
    '<button class="dropdown-menu-item" data-action="load-project" style="' +
    DROPDOWN_ITEM_STYLE + '">' +
    icon("upload", 12) +
    "<span>Load Project\u2026</span>" +
    "</button>" +
    '<div style="height:1px;background:#444;margin:4px 0;"></div>' +
    '<button class="dropdown-menu-item" data-action="open-export-window" style="' +
    DROPDOWN_ITEM_STYLE + '" title="Build a standalone, playable copy of your game — no editor required to run it.">' +
    icon("monitor", 12) +
    "<span>Export\u2026</span>" +
    "</button>" +
    '<div style="height:1px;background:#444;margin:4px 0;"></div>' +
    '<button class="dropdown-menu-item" data-action="' +
    (editorState.fsaBackupEnabled ? "disable-fsa-backup" : "enable-fsa-backup") + '" style="' +
    DROPDOWN_ITEM_STYLE + '" title="' +
    (editorState.fsaBackupEnabled
      ? "Every auto-save is also mirrored to a folder on your real disk, outside this browser\u2019s storage limit. Click to turn off \u2014 this only stops future mirroring, it does not delete anything already saved to disk or in this browser."
      : "Pick a folder on your real disk to also mirror every auto-save into \u2014 gives you extra space beyond this browser\u2019s built-in storage limit.") +
    '">' +
    icon("folder", 12) +
    "<span>" + (editorState.fsaBackupEnabled ? "Extra Backup Storage: ON (click to turn off)" : "Enable Extra Backup Storage\u2026") + "</span>" +
    "</button>" +
    // Only shown once backup is actually on for this project —
    // restoring from a folder that was never set up (or was set up
    // for a DIFFERENT project — see RealotPersistence.js's per-project
    // handle keying) has nothing to restore, so surfacing this button
    // beforehand would just be a guaranteed "no backup found" error.
    (editorState.fsaBackupEnabled
      ? '<button class="dropdown-menu-item" data-action="restore-fsa-backup" style="' +
        DROPDOWN_ITEM_STYLE + '" title="Load the version of this project last mirrored to its backup folder, replacing what\u2019s currently open.">' +
        icon("refreshcw", 12) +
        "<span>Restore from Backup Folder\u2026</span>" +
        "</button>"
      : "") +
    // Hidden native file input — clicking "Load Project" above
    // (see EditorEvents.js's "load-project" case) forwards the click
    // to this input rather than the editor rolling its own file-picker
    // UI, same pattern BottomPanel.js already uses for Import Sprite/
    // Import Audio (a real <input type="file"> hidden and
    // programmatically clicked, listened to via the delegated "change"
    // handler in EditorEvents.js).
    '<input type="file" accept=".rs,.vs,.zip" data-action="load-project-input" style="display:none;" />' +
    "</div>"
  );
}

function renderEditMenu() {
  return (
    '<div class="dropdown-menu" style="position:absolute;top:100%;left:0;background:#2a2a2a;border:1px solid #444;' +
    'border-radius:4px;min-width:180px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.4);padding:4px 0;">' +
    '<button class="dropdown-menu-item" data-action="open-physics-layers" style="' +
    DROPDOWN_ITEM_STYLE + '">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">' +
    '<rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/>' +
    '<rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/>' +
    '</svg>' +
    '<span>Physics Layers\u2026</span>' +
    '</button>' +
    '<button class="dropdown-menu-item" data-action="open-nav-areas" style="' +
    DROPDOWN_ITEM_STYLE + '">' +
    icon("route", 12) +
    '<span>Nav Areas\u2026</span>' +
    '</button>' +
    '</div>'
  );
}

function renderGameObjectMenu() {
  return (
    '<div class="dropdown-menu" style="position:absolute;top:100%;left:0;background:#2a2a2a;border:1px solid #444;' +
    'border-radius:4px;min-width:160px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.4);padding:4px 0;">' +
    '<button class="dropdown-menu-item" data-action="add-entity" style="' +
    DROPDOWN_ITEM_STYLE +
    '">' +
    icon("box", 12) +
    "<span>Empty GameObject</span>" +
    "</button>" +
    '<div class="dropdown-submenu-wrap" style="position:relative;">' +
    '<button class="dropdown-menu-item" data-action="toggle-submenu" data-submenu="Light" style="' +
    DROPDOWN_ITEM_STYLE +
    'justify-content:space-between;">' +
    '<span style="display:flex;align-items:center;gap:6px;">' +
    icon("lightbulb", 12) +
    "<span>Light</span></span>" +
    icon("chevronright", 10) +
    "</button>" +
    (editorState.openSubmenu === "Light" ? renderLightSubmenu() : "") +
    "</div>" +
    '<div class="dropdown-submenu-wrap" style="position:relative;">' +
    '<button class="dropdown-menu-item" data-action="toggle-submenu" data-submenu="2D Object" style="' +
    DROPDOWN_ITEM_STYLE +
    'justify-content:space-between;">' +
    '<span style="display:flex;align-items:center;gap:6px;">' +
    icon("grid", 12) +
    "<span>2D Object</span></span>" +
    icon("chevronright", 10) +
    "</button>" +
    (editorState.openSubmenu === "2D Object" ? render2DObjectSubmenu() : "") +
    "</div>" +
    '<div class="dropdown-submenu-wrap" style="position:relative;">' +
    '<button class="dropdown-menu-item" data-action="toggle-submenu" data-submenu="Shape" style="' +
    DROPDOWN_ITEM_STYLE +
    'justify-content:space-between;">' +
    '<span style="display:flex;align-items:center;gap:6px;">' +
    icon("square", 12) +
    "<span>Shape</span></span>" +
    icon("chevronright", 10) +
    "</button>" +
    (editorState.openSubmenu === "Shape" ? renderShapeSubmenu() : "") +
    "</div>" +
    "</div>"
  );
}

function renderShapeSubmenu() {
  return (
    '<div class="dropdown-menu" style="position:absolute;top:0;left:100%;background:#2a2a2a;border:1px solid #444;' +
    'border-radius:4px;min-width:150px;z-index:101;box-shadow:0 4px 12px rgba(0,0,0,.4);padding:4px 0;">' +
    SHAPE_MENU_ITEMS.map(
      (item) =>
        '<button class="dropdown-menu-item" data-action="create-shape" data-shape-type="' +
        item.type +
        '" style="' +
        DROPDOWN_ITEM_STYLE +
        '">' +
        icon(item.iconName, 12) +
        "<span>" +
        item.label +
        "</span>" +
        "</button>"
    ).join("") +
    "</div>"
  );
}

function renderUIMenu() {
  return (
    '<div class="dropdown-menu" style="position:absolute;top:100%;left:0;background:#2a2a2a;border:1px solid #444;' +
    'border-radius:4px;min-width:170px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.4);padding:4px 0;">' +
    UI_MENU_ITEMS.map(
      (item) =>
        '<button class="dropdown-menu-item" data-action="create-ui" data-ui-component="' +
        item.componentName +
        '" style="' +
        DROPDOWN_ITEM_STYLE +
        '">' +
        icon(item.iconName, 12) +
        "<span>" +
        item.label +
        "</span>" +
        "</button>"
    ).join("") +
    "</div>"
  );
}

function render2DObjectSubmenu() {
  return (
    '<div class="dropdown-menu" style="position:absolute;top:0;left:100%;background:#2a2a2a;border:1px solid #444;' +
    'border-radius:4px;min-width:170px;z-index:101;box-shadow:0 4px 12px rgba(0,0,0,.4);padding:4px 0;">' +
    '<button class="dropdown-menu-item" data-action="create-tileset" style="' +
    DROPDOWN_ITEM_STYLE +
    '">' +
    icon("grid", 12) +
    "<span>Tileset</span>" +
    "</button>" +
    '<button class="dropdown-menu-item" data-action="create-tilemap" style="' +
    DROPDOWN_ITEM_STYLE +
    '">' +
    icon("grid", 12) +
    "<span>Tilemap</span>" +
    "</button>" +
    '<button class="dropdown-menu-item" data-action="create-navworld" style="' +
    DROPDOWN_ITEM_STYLE +
    '">' +
    icon("route", 12) +
    "<span>Nav World 2D</span>" +
    "</button>" +
    '<button class="dropdown-menu-item" data-action="create-strokepath" style="' +
    DROPDOWN_ITEM_STYLE +
    '">' +
    icon("waypoints", 12) +
    "<span>Stroke Path</span>" +
    "</button>" +
    "</div>"
  );
}

function renderLightSubmenu() {
  return (
    '<div class="dropdown-menu" style="position:absolute;top:0;left:100%;background:#2a2a2a;border:1px solid #444;' +
    'border-radius:4px;min-width:170px;z-index:101;box-shadow:0 4px 12px rgba(0,0,0,.4);padding:4px 0;">' +
    LIGHT_MENU_ITEMS.map(
      (item) =>
        '<button class="dropdown-menu-item" data-action="create-light" data-light-type="' +
        item.type +
        '" style="' +
        DROPDOWN_ITEM_STYLE +
        '">' +
        icon("lightbulb", 12) +
        "<span>" +
        item.label +
        "</span>" +
        "</button>"
    ).join("") +
    "</div>"
  );
}

const DROPDOWN_ITEM_STYLE =
  "display:flex;align-items:center;gap:6px;width:100%;text-align:left;padding:6px 12px;background:none;" +
  "border:none;color:#ddd;cursor:pointer;font-size:11px;white-space:nowrap;";
