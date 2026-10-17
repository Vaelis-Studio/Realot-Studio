/**
 * editor/panels/BottomPanel.js
 *
 * Project asset browser + Console tabs. The Sprites folder shows the
 * REAL imported assets from runtime/assets/AssetRegistry.js (populated
 * via Assets > Import New Asset, wired in EditorEvents.js). Each asset
 * thumbnail is a native HTML5 drag source (draggable="true") carrying
 * its spriteKey, picked up by editor/viewport/SceneViewport.js's drop
 * handler to place a real Entity + SpriteRenderer into the scene.
 *
 * The Scenes folder shows every scene in the project (from
 * game.getSceneList()) as a file-like item, same visual language as a
 * sprite asset: single click selects it, double-click OPENS it (loads
 * it into the live World, same as the old scene-tab switcher did), and
 * double-clicking its label starts an inline rename. This replaces the
 * old tab-strip that used to sit at the top of the Hierarchy panel —
 * scenes now live as files you open from the Project browser, same as
 * any other asset, instead of always being visible up top.
 *
 * Console reads from editorState.logs (pushed to by the real engine via
 * pushLog()) instead of a static LOGS array.
 */

import { icon } from "../icons/IconLibrary.js";
import { tabBtn, escapeAttr } from "./UIComponents.js";

/** Escapes text for safe insertion between HTML tags (console messages are untrusted). */
function escapeLogText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
import { editorState } from "../state/EditorState.js";
import { getAllSpriteAssets, getAllAudioAssets } from "../../runtime/assets/AssetRegistry.js";
import { getAllScripts } from "../scripting/ScriptStorage.js";
import { getAllPrefabs } from "../../runtime/prefabs/PrefabRegistry.js";

const FOLDER_LABELS = { scenes: "Scenes", sprites: "Sprites", audio: "Audio", scripts: "Scripts", prefabs: "Prefabs" };

export function renderBottom() {
  const errCount = editorState.logs.filter((l) => l.type === "error").length;
  const warnCount = editorState.logs.filter((l) => l.type === "warn").length;
  const infoCount = editorState.logs.filter((l) => l.type === "log").length;

  let extra = "";
  if (errCount > 0 || warnCount > 0) {
    extra =
      '<span class="tab-extra">' +
      (errCount > 0 ? '<span class="err">' + icon("alerttriangle", 10) + errCount + "</span>" : "") +
      (warnCount > 0 ? '<span class="warn">' + icon("alerttriangle", 10) + warnCount + "</span>" : "") +
      "</span>";
  }

  let bodyHtml = "";
  if (editorState.bottomTab === "project") {
    const folder = editorState.projectFolder;

    let gridHtml;
    let pathToolbarHtml;
    if (folder === "sprites") {
      const assets = getAllSpriteAssets();
      gridHtml = assets.length
        ? assets
            .map(
              (a) =>
                '<div class="asset-item" draggable="true" data-action="drag-sprite-asset" data-sprite-key="' +
                a.key +
                '" title="Drag into the scene view"><div class="asset-thumb"><img src="' +
                a.dataUrl +
                '" alt="' +
                a.name +
                '" style="width:100%;height:100%;object-fit:contain;" draggable="false" />' +
                assetDeleteBtn("delete-sprite-asset", "sprite-key", a.key, a.name) +
                '<div class="asset-ext">IMG</div></div>' +
                renameableAssetLabel("sprite", a.key, a.name) +
                "</div>"
            )
            .join("")
        : '<div class="asset-empty-hint">No sprites imported yet. Click "Import Sprite" to add one.</div>';
      pathToolbarHtml =
        '<label class="import-sprite-btn">' +
        icon("plus", 11) +
        " Import Sprite" +
        '<input type="file" accept="image/*" multiple data-action="import-sprite-input" style="display:none;" />' +
        "</label>";
    } else if (folder === "audio") {
      const audioAssets = getAllAudioAssets();
      gridHtml = audioAssets.length
        ? audioAssets
            .map(
              (a) =>
                '<div class="asset-item" draggable="true" data-action="drag-audio-asset" data-audio-key="' +
                a.key +
                '" title="Drag into the scene view"><div class="asset-thumb">' +
                icon("music", 22) +
                assetDeleteBtn("delete-audio-asset", "audio-key", a.key, a.name) +
                '<div class="asset-ext">AUD</div></div>' +
                renameableAssetLabel("audio", a.key, a.name) +
                "</div>"
            )
            .join("")
        : '<div class="asset-empty-hint">No audio imported yet. Click "Import Audio" to add one.</div>';
      pathToolbarHtml =
        '<label class="import-sprite-btn">' +
        icon("plus", 11) +
        " Import Audio" +
        '<input type="file" accept="audio/*" multiple data-action="import-audio-input" style="display:none;" />' +
        "</label>";
    } else if (folder === "scenes") {
      gridHtml = renderSceneFileGrid();
      pathToolbarHtml =
        '<button class="import-sprite-btn" data-action="add-scene">' + icon("plus", 11) + " New Scene</button>";
    } else if (folder === "scripts") {
      const scripts = getAllScripts();
      gridHtml = scripts.length
        ? scripts
            .map(
              (sname) =>
                '<div class="asset-item" data-action="open-script-from-folder" data-script="' + sname + '" title="Open in script editor"><div class="asset-thumb asset-thumb-script">' +
                assetDeleteBtn("delete-script-asset", "script", sname, sname) +
                '<div class="asset-ext">JS</div></div>' +
                renameableAssetLabel("script", sname, sname) +
                "</div>"
            )
            .join("")
        : '<div class="asset-empty-hint">No scripts yet. Attach a Script component to an object (in the Inspector) to create one.</div>';
      pathToolbarHtml = "";
    } else if (folder === "prefabs") {
      // Prefabs are just component data (see PrefabRegistry.js), not
      // necessarily backed by a sprite at all (e.g. a Light or
      // Collider2D-only prefab) — those fall back to the same "box"
      // icon sprite assets' own IMG/AUD/JS badge convention uses,
      // distinguished only via the "PFB" badge. Ones created from an
      // entity that HAD a resolvable sprite instead show that sprite's
      // image as a real thumbnail (see p.thumbnail below). Created via
      // the Inspector's "Make Prefab" button (see Inspector.js's
      // obj-header-icon-btn) — there is no "New Prefab" button here the
      // way Sprites/Audio/Scripts have an import/new action, since a
      // prefab only ever starts life FROM an existing scene object,
      // never from nothing.
      const prefabs = getAllPrefabs();
      gridHtml = prefabs.length
        ? prefabs
            .map(
              (p) =>
                '<div class="asset-item" draggable="true" data-action="drag-prefab-asset" data-prefab-id="' +
                p.id +
                '" title="Drag into the scene view"><div class="asset-thumb">' +
                // Prefabs created from an entity with a resolvable sprite
                // get a real image thumbnail (same <img>-over-dataUrl
                // pattern the Sprites folder above uses); everything else
                // (Lights, Collider2D-only entities, or a sprite whose
                // asset was since deleted) falls back to the generic
                // "box" icon exactly as before. See PrefabRegistry.js's
                // createPrefabFromEntity/resolveThumbnail for where
                // p.thumbnail comes from.
                (p.thumbnail
                  ? '<img src="' + escapeAttr(p.thumbnail) + '" alt="' + escapeAttr(p.name) + '" style="width:100%;height:100%;object-fit:contain;" draggable="false" />'
                  : icon("box", 22)) +
                assetDeleteBtn("delete-prefab-asset", "prefab-id", p.id, p.name) +
                '<div class="asset-ext">PFB</div></div>' +
                renameableAssetLabel("prefab", p.id, p.name) +
                "</div>"
            )
            .join("")
        : '<div class="asset-empty-hint">No prefabs yet. Select an object and click the box icon next to its name in the Inspector to create one.</div>';
      pathToolbarHtml = "";
    }

    bodyHtml =
      '<div class="bottom-body">' +
      '<div class="proj-tree">' +
      '<div class="row1">' +
      icon("chevrondown", 12) +
      '<span style="margin-left:4px;display:flex;align-items:center;">' +
      icon("folder", 12) +
      '</span><span style="font-size:11px;margin-left:4px;">Assets</span></div>' +
      renderFolderRow("scenes", folder) +
      renderFolderRow("sprites", folder) +
      renderFolderRow("audio", folder) +
      renderFolderRow("scripts", folder) +
      renderFolderRow("prefabs", folder) +
      "</div>" +
      '<div class="proj-assets">' +
      '<div class="proj-path"><span>Assets &gt; ' +
      FOLDER_LABELS[folder] +
      "</span>" +
      pathToolbarHtml +
      "</div>" +
      '<div class="proj-grid">' +
      gridHtml +
      "</div>" +
      "</div>" +
      "</div>";
  } else {
    bodyHtml =
      '<div class="bottom-body" style="flex-direction:column;background:#282828;overflow:hidden;">' +
      '<div class="console-toolbar">' +
      '<button class="console-clear" data-action="clear-console">Clear</button>' +
      '<button class="console-clear" data-action="copy-console">Copy All</button>' +
      '<button class="console-toggle">Collapse</button>' +
      '<button class="console-toggle">Clear on Play</button>' +
      '<div style="flex:1;"></div>' +
      '<div class="console-counts">' +
      "<button>" +
      icon("info", 10) +
      " " +
      infoCount +
      "</button>" +
      "<button>" +
      icon("alerttriangle", 10) +
      " " +
      warnCount +
      "</button>" +
      "<button>" +
      icon("alerttriangle", 10) +
      " " +
      errCount +
      "</button>" +
      "</div>" +
      "</div>" +
      '<div class="console-list" id="console-list-el">' +
      editorState.logs
        .map((l) => {
          // l.msg can originate in a running game script (via the play window),
          // so it is untrusted: escape it, and only allow known level names in
          // the class attribute. Never concatenate it into HTML raw.
          const lvl = l.type === "error" || l.type === "warn" ? l.type : "log";
          const ic = lvl === "error" || lvl === "warn" ? "alerttriangle" : "info";
          const countBadge = (l.count && l.count > 1)
            ? '<span class="log-count">' + l.count + '</span>'
            : "";
          return '<div class="log-row ' + lvl + '"><span class="licon">' + icon(ic, 12) + '</span><span class="lmsg">' + escapeLogText(l.msg) + "</span>" + countBadge + "</div>";
        })
        .join("") +
      "</div>" +
      "</div>";
  }

  return (
    '<div class="bottom-panel">' +
    '<div class="tabbar">' +
    tabBtn(editorState.bottomTab === "project", "Project", "folder", null, "tab-project") +
    tabBtn(editorState.bottomTab === "console", "Console", "terminal", extra, "tab-console") +
    "</div>" +
    bodyHtml +
    "</div>"
  );
}

/** One row in the left-hand Assets folder tree (Scenes / Sprites / Scripts). */
function renderFolderRow(folderKey, activeFolder) {
  return (
    '<div class="rowsub' +
    (folderKey === activeFolder ? " selected" : "") +
    '" data-action="select-project-folder" data-folder="' +
    folderKey +
    '">' +
    icon("folder", 12) +
    '<span style="margin-left:4px;">' +
    FOLDER_LABELS[folderKey] +
    "</span></div>"
  );
}

/**
 * Small "×" delete button overlaid on an asset thumbnail's corner
 * (only visible on hover — see .asset-delete-btn in editor.css),
 * shared by all four asset kinds (sprite, audio, scene, script) so
 * the interaction is identical everywhere: click stops the event from
 * bubbling into the item's own click/drag handlers (data-action is
 * read by _handleAction in EditorEvents.js, which itself asks the
 * person to confirm before actually deleting anything).
 * @param {string} action data-action value (e.g. "delete-sprite-asset")
 * @param {string} keyAttr data-* attribute name carrying the identifier (e.g. "sprite-key")
 * @param {string} keyValue the identifier itself (sprite key, scene id, script name)
 * @param {string} displayName used in the confirm-dialog message and the button's title/aria-label
 */
function assetDeleteBtn(action, keyAttr, keyValue, displayName) {
  return (
    '<button class="asset-delete-btn" draggable="false" data-action="' +
    action +
    '" data-' +
    keyAttr +
    '="' +
    keyValue +
    '" data-display-name="' +
    escapeAttr(displayName) +
    '" title="Delete ' +
    escapeAttr(displayName) +
    '" aria-label="Delete ' +
    escapeAttr(displayName) +
    '">' +
    icon("x", 10) +
    "</button>"
  );
}

/**
 * Shared inline-rename label for sprite/audio/script asset-grid items —
 * same interaction as the Scenes folder's own rename (double-click the
 * label to start, Enter/blur to commit, Escape to cancel — see
 * EditorEvents.js's keydown/focusout handlers, which key off
 * editorState.renamingAsset the same way they already key off
 * renamingSceneId for scenes), just generalized across kinds instead of
 * scenes having their own bespoke copy.
 * @param {"sprite"|"audio"|"script"|"prefab"} kind
 * @param {string} key sprite/audio asset key, script name, or prefab id
 * @param {string} displayName current display name shown when not renaming
 */
function renameableAssetLabel(kind, key, displayName) {
  const renaming = editorState.renamingAsset;
  const isRenaming = !!renaming && renaming.kind === kind && renaming.key === key;
  if (isRenaming) {
    return (
      '<input type="text" class="scene-file-rename-input" data-action="rename-asset-input" data-asset-kind="' +
      kind +
      '" data-asset-key="' +
      escapeAttr(key) +
      '" value="' +
      escapeAttr(displayName) +
      '" />'
    );
  }
  return (
    '<span class="asset-label" data-dblclick-action="rename-asset-start" data-asset-kind="' +
    kind +
    '" data-asset-key="' +
    escapeAttr(key) +
    '" title="Double-click to rename">' +
    escapeAttr(displayName) +
    "</span>"
  );
}

/**
 * Scene files inside the Project > Scenes folder. Visually matches
 * .asset-item (same thumb/label styling as a sprite), but represents a
 * whole scene rather than an image: single click selects, double-click
 * opens (switches the live World to that scene — see
 * SceneViewport.js switchScene()), double-clicking the label starts an
 * inline rename committed on blur/Enter (see EditorEvents.js).
 *
 * Also carries a Duplicate button (clones the scene under a new name —
 * see SceneManager.duplicateScene()) and a Delete button (see
 * SceneManager.deleteScene()), both hover-revealed same as the other
 * three asset kinds' delete "×" (see assetDeleteBtn above) — Delete is
 * additionally disabled outright, not just confirmed, when this is the
 * only scene left in the project, since a project must always have at
 * least one (SceneManager.deleteScene() already refuses that case
 * itself; disabling the button here just surfaces that constraint
 * visibly instead of letting the person click it and silently get
 * nothing).
 */
function renderSceneFileGrid() {
  const game = editorState.game;
  const sceneList = game ? game.getSceneList() : [];
  const activeSceneId = game ? game.getActiveSceneId() : null;
  const renamingSceneId = editorState.renamingSceneId;
  const onlyScene = sceneList.length <= 1;

  if (!sceneList.length) {
    return '<div class="asset-empty-hint">No scenes yet. Click "New Scene" to add one.</div>';
  }

  return sceneList
    .map((s) => {
      const isActive = s.id === activeSceneId;
      const isRenaming = s.id === renamingSceneId;
      return (
        '<div class="asset-item scene-file-item' +
        (isActive ? " active" : "") +
        '" data-action="select-scene-file" data-scene-id="' +
        s.id +
        '" title="Click to open">' +
        '<div class="asset-thumb">' +
        icon("box", 22) +
        '<button class="asset-dup-btn" data-action="duplicate-scene-file" data-scene-id="' +
        s.id +
        '" title="Duplicate ' +
        escapeAttr(s.name) +
        '" aria-label="Duplicate ' +
        escapeAttr(s.name) +
        '">' +
        icon("copy", 10) +
        "</button>" +
        (onlyScene
          ? '<button class="asset-delete-btn" disabled title="A project needs at least one scene" aria-label="Delete disabled — only scene in project">' +
            icon("x", 10) +
            "</button>"
          : assetDeleteBtn("delete-scene-file", "scene-id", s.id, s.name)) +
        '<div class="asset-ext">SCN</div>' +
        "</div>" +
        (isRenaming
          ? '<input type="text" class="scene-file-rename-input" data-action="rename-scene-input" data-scene-id="' +
            s.id +
            '" value="' +
            s.name +
            '" />'
          : '<span class="asset-label" data-dblclick-action="rename-scene-start" data-scene-id="' +
            s.id +
            '" title="Double-click to rename">' +
            s.name +
            (isActive ? " (open)" : "") +
            "</span>") +
        "</div>"
      );
    })
    .join("");
}
