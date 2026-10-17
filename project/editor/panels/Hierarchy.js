/**
 * editor/panels/Hierarchy.js
 *
 * Scene hierarchy tree. Reads entities live from editorState.world
 * (the runtime's World) instead of a static array — this is the panel
 * that was hardest-coupled to fake data in the original mockup.
 *
 * Scenes themselves are no longer switched from a tab strip at the top
 * of this panel — they live as file-like items in the Project panel's
 * "Scenes" folder (see BottomPanel.js), opened by clicking/double-
 * clicking them there, same as any other asset. This panel only shows
 * the hierarchy of whichever scene is currently open, named in the
 * "scene-root" header below.
 *
 * FOLDERS: purely an organizational feature for this panel — entities
 * can be filed into folders (World.hierarchyFolders / Entity.folderId,
 * see runtime/core/World.js and Entity.js) to keep a scene with many
 * objects manageable, without changing anything about how the game
 * actually runs. Folders can nest inside other folders, are created via
 * the toolbar's folder button, renamed by double-clicking their label,
 * expanded/collapsed by clicking their chevron, and entities/folders
 * are filed into them by dragging a row onto a folder row (native HTML5
 * drag-and-drop — see EditorEvents.js's dragstart/dragover/drop
 * handlers for "hierarchy-entity-row"/"hierarchy-folder-row"). Dragging
 * a row onto the "scene-root" header at the top moves it back out to
 * the top level.
 */

import { icon } from "../icons/IconLibrary.js";
import { tabBtn, escapeAttr } from "./UIComponents.js";
import { editorState } from "../state/EditorState.js";
import { CAMERA } from "../../runtime/components/Camera.js";
import { LIGHT } from "../../runtime/components/Light.js";

export function renderHierarchy() {
  const world = editorState.world;
  const allEntities = world ? world.getAllEntities() : [];
  const folders = world ? world.hierarchyFolders : [];
  const filterText = editorState.hierarchyFilter.toLowerCase();
  const isFiltering = filterText.length > 0;

  // When filtering, matching is done against every entity regardless of
  // which folder it's in, and any folder that contains a match (at any
  // depth) is force-expanded so the match is actually visible — exactly
  // how the Project panel / most file-tree searches behave. Without
  // this, filtering would only ever show top-level matches unless the
  // user had already manually expanded the right folder.
  const matches = (e) => e.name.toLowerCase().includes(filterText);
  const matchingIds = isFiltering ? new Set(allEntities.filter(matches).map((e) => e.id)) : null;

  // Folder ids that contain a match somewhere inside them (directly or
  // via a nested sub-folder) — computed once up front so the recursive
  // render below doesn't repeat this walk per folder.
  let foldersWithMatch = null;
  if (isFiltering) {
    foldersWithMatch = new Set();
    const folderById = new Map(folders.map((f) => [f.id, f]));
    const markAncestors = (folderId) => {
      let cursor = folderId;
      while (cursor) {
        if (foldersWithMatch.has(cursor)) break; // already marked, and so are its ancestors
        foldersWithMatch.add(cursor);
        const f = folderById.get(cursor);
        cursor = f ? f.parentId : null;
      }
    };
    for (const e of allEntities) {
      if (matchingIds.has(e.id) && e.folderId) markAncestors(e.folderId);
    }
    for (const f of folders) {
      if (f.name.toLowerCase().includes(filterText)) markAncestors(f.id);
    }
  }

  const entityIconName = (e) => {
    if (e.hasComponent(CAMERA)) return "camera";
    if (e.hasComponent(LIGHT)) return "lightbulb";
    return "box";
  };

  function renderEntityRow(e, depth) {
    if (isFiltering && !matchingIds.has(e.id)) return "";
    // Highlights every row being dragged together, not just the one the
    // drag started on — see EditorState.draggingEntityIds' doc comment.
    const isDragging = editorState.draggingEntityIds.includes(e.id);
    return (
      '<div class="entity-row' +
      (editorState.selectedIds.includes(e.id) ? " selected" : "") +
      (isDragging ? " dragging" : "") +
      '" style="padding-left:' +
      (20 + depth * 14) +
      'px" draggable="true" data-action="select-entity" data-drag-role="hierarchy-entity-row" data-id="' +
      e.id +
      '">' +
      '<div class="entity-inner">' +
      '<span class="entity-icon">' +
      icon(entityIconName(e), 11) +
      "</span>" +
      '<span class="entity-name">' +
      escapeAttr(e.name) +
      "</span>" +
      "</div></div>"
    );
  }

  function renderFolderRow(folder, depth) {
    const childFolders = folders.filter((f) => f.parentId === folder.id);
    const childEntities = allEntities.filter((e) => e.folderId === folder.id);

    // While filtering, a folder with no match anywhere inside it (and
    // whose own name doesn't match) is skipped entirely rather than
    // shown empty.
    if (isFiltering && !foldersWithMatch.has(folder.id)) return "";

    const expanded = isFiltering ? true : folder.expanded !== false;
    const isRenaming = editorState.renamingFolderId === folder.id;
    const isDragging = editorState.draggingFolderId === folder.id;
    const childCount = childFolders.length + childEntities.length;

    const label = isRenaming
      ? '<input type="text" class="hierarchy-folder-rename-input" data-action="rename-folder-input" data-folder-id="' +
        folder.id +
        '" value="' +
        escapeAttr(folder.name) +
        '" />'
      : '<span class="folder-name" data-dblclick-action="rename-folder-start" data-folder-id="' +
        folder.id +
        '" title="Double-click to rename">' +
        escapeAttr(folder.name) +
        "</span>";

    return (
      '<div class="folder-row' +
      (isDragging ? " dragging" : "") +
      '" style="padding-left:' +
      (6 + depth * 14) +
      'px" draggable="' +
      (isRenaming ? "false" : "true") +
      '" data-action="toggle-hierarchy-folder" data-drag-role="hierarchy-folder-row" data-folder-id="' +
      folder.id +
      '">' +
      '<span class="folder-chevron" data-action="toggle-hierarchy-folder" data-folder-id="' +
      folder.id +
      '">' +
      icon(expanded ? "chevrondown" : "chevronright", 10) +
      "</span>" +
      '<span class="folder-icon">' +
      icon("folder", 12) +
      "</span>" +
      label +
      '<span class="folder-count">' +
      childCount +
      "</span>" +
      '<button class="folder-delete-btn" data-action="delete-hierarchy-folder" data-folder-id="' +
      folder.id +
      '" title="Delete folder (contents move up one level)">' +
      icon("trash", 10) +
      "</button>" +
      "</div>" +
      (expanded
        ? '<div class="folder-children">' +
          childFolders.map((cf) => renderFolderRow(cf, depth + 1)).join("") +
          childEntities.map((ce) => renderEntityRow(ce, depth + 1)).join("") +
          "</div>"
        : "")
    );
  }

  const rootFolders = folders.filter((f) => !f.parentId);
  const rootEntities = allEntities.filter((e) => !e.folderId);

  return (
    '<div class="hierarchy-panel">' +
    '<div class="tabbar">' +
    tabBtn(true, "Hierarchy", "listtree") +
    "</div>" +
    '<div class="hierarchy-toolbar">' +
    '<button class="hierarchy-add-btn" data-action="add-entity">' +
    icon("plus", 12) +
    icon("chevrondown", 10) +
    "</button>" +
    '<button class="hierarchy-add-btn" data-action="add-hierarchy-folder" title="New Folder">' +
    icon("folder", 12) +
    icon("plus", 10) +
    "</button>" +
    '<div class="hierarchy-search">' +
    icon("search", 10) +
    '<input type="text" id="hierarchy-search-input" value="' +
    editorState.hierarchyFilter +
    '" />' +
    "</div>" +
    "</div>" +
    '<div class="hierarchy-tree">' +
    '<div class="scene-root" data-action="hierarchy-root-drop-target" data-drag-role="hierarchy-root">' +
    icon("chevrondown", 12) +
    icon("box", 12) +
    '<span style="font-size:11px;font-weight:bold;margin-left:4px;">' +
    (world ? world.sceneName : "No Scene") +
    "</span></div>" +
    rootFolders.map((f) => renderFolderRow(f, 0)).join("") +
    rootEntities.map((e) => renderEntityRow(e, 0)).join("") +
    "</div>" +
    "</div>"
  );
}
