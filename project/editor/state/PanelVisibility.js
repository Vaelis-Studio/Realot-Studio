// Window menu: which of the three big editor panels are visible.
//
// Hiding a panel removes its whole column from the layout (see main.js's
// render()), and the scene viewport — which is a flex:1 child — simply
// grows into the freed space. That gives the user more room to build a
// level without touching any of the panels' own code.
//
// The choice is remembered across reloads (per browser, not per project):
// someone who prefers a big viewport shouldn't have to re-hide panels
// every time they open the editor.

const STORAGE_KEY = "realot.panelVisibility";

// Panel ids used by the Window menu, editorState.panelVisible and main.js.
//   hierarchy -> left column  (.col-hierarchy)
//   assets    -> bottom strip (.col-bottom-wrap — Console / Project / assets)
//   inspector -> right column (.col-inspector)
export const PANEL_IDS = ["hierarchy", "assets", "inspector"];

export const PANEL_LABELS = {
  hierarchy: "Hierarchy",
  assets: "Asset Panel",
  inspector: "Inspector",
};

export function defaultPanelVisibility() {
  return { hierarchy: true, assets: true, inspector: true };
}

export function loadPanelVisibility() {
  const result = defaultPanelVisibility();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return result;
    const parsed = JSON.parse(raw);
    for (const id of PANEL_IDS) {
      // Only an explicit `false` hides a panel — anything missing or
      // malformed falls back to visible, so a corrupt value can never
      // leave the editor with panels it can't get back.
      if (parsed && parsed[id] === false) result[id] = false;
    }
  } catch (_) {
    // Corrupt/blocked storage — just use the defaults.
  }
  return result;
}

export function savePanelVisibility(visible) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visible));
  } catch (_) {
    // Storage full/disabled — still works for this session, just won't persist.
  }
}
