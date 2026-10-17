/**
 * editor/panels/ExportWindow.js
 *
 * "Export" popup (Toolbar.js) — lets the user build a real, standalone
 * game build (see editor/export/ExportGame.js) as a downloadable .zip.
 * Modeled directly on ScriptPickerWindow.js's modal shell: a fixed-
 * position backdrop + panel, opened/closed via editorState flags and
 * routed through EditorEvents.js's action dispatch, same convention
 * every other editor popup already follows.
 *
 * Deliberately organized as a list of FORMAT CARDS (see FORMATS below)
 * rather than hard-coded HTML5/PWA markup, so adding a future export
 * target (native shell, itch.io package, etc — see each entry's
 * `comingSoon` flag) is a one-entry addition here, not a rewrite.
 *
 * EDITOR-ONLY FILE.
 */

import { editorState } from "../state/EditorState.js";
import { icon } from "../icons/IconLibrary.js";
import { getActiveAndroidServer, APK_SERVICE_URL } from "../state/ServerConfig.js";
import { isAndroidBuildActive } from "../state/AndroidBuildSession.js";

/**
 * One entry per selectable/plannable export target. `comingSoon`
 * entries render disabled with a "Coming soon" badge instead of being
 * omitted entirely, so the export surface communicates the roadmap
 * rather than looking like a single-purpose HTML-only button that
 * happened to get a dialog.
 */
export const FORMATS = [
  {
    id: "html",
    label: "HTML5",
    iconName: "monitor",
    description: "A static site: index.html + game files. Open locally through a web server or upload anywhere.",
    comingSoon: false,
  },
  {
    id: "pwa",
    label: "PWA",
    iconName: "download",
    description: "Same as HTML5, plus a manifest + service worker so it installs and runs fully offline.",
    comingSoon: false,
  },
  {
    id: "desktop",
    label: "Desktop (Windows/Mac/Linux)",
    iconName: "box",
    description: "Standalone desktop app.",
    comingSoon: true,
  },
  {
    id: "android",
    label: "Android APK",
    iconName: "download",
    description: "One debug-signed APK built on the server — no Android Studio or local build required.",
    comingSoon: false,
  },
];

const BACKDROP_STYLE = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:999;";

const PANEL_STYLE =
  "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);" +
  "background:#1e2330;border:1px solid #3a4560;border-radius:8px;" +
  "width:460px;max-height:80vh;display:flex;flex-direction:column;" +
  "z-index:1000;box-shadow:0 8px 32px rgba(0,0,0,.6);overflow:hidden;" +
  // editor.css sets user-select:none globally on <body> (a Chromebook/
  // touchscreen drag fix — see that rule's comment), which every element
  // in this modal would otherwise inherit. That's fine for most editor
  // panels, but this popup's content — error messages, status text, the
  // server badge — is exactly what someone would want to copy (e.g. to
  // paste an error into a bug report), so re-enable selection just here.
  "user-select:text;-webkit-user-select:text;";

const HEADER_STYLE =
  "display:flex;align-items:center;justify-content:space-between;" +
  "padding:14px 16px;border-bottom:1px solid #2e3a50;flex-shrink:0;";

const CLOSE_BTN_STYLE =
  "background:none;border:none;color:#8a93a0;cursor:pointer;font-size:16px;" +
  "line-height:1;padding:2px 6px;border-radius:3px;";

const BODY_STYLE = "overflow-y:auto;flex:1;padding:14px 16px;";

const CARD_STYLE =
  "display:flex;align-items:flex-start;gap:10px;padding:12px;border-radius:6px;" +
  "border:1px solid #2e3a50;background:#232a3a;cursor:pointer;text-align:left;" +
  "width:100%;font-family:inherit;margin-bottom:8px;";

const CARD_DISABLED_STYLE =
  "display:flex;align-items:flex-start;gap:10px;padding:12px;border-radius:6px;" +
  "border:1px solid #262c3a;background:#1a1e29;cursor:default;text-align:left;" +
  "width:100%;font-family:inherit;margin-bottom:8px;opacity:0.55;";

export function renderExportWindow() {
  if (!editorState.exportOpen) return "";

  return (
    '<div data-action="close-export-window" style="' + BACKDROP_STYLE + '"></div>' +
    '<div class="export-window" style="' + PANEL_STYLE + '">' +
    '<div style="' + HEADER_STYLE + '">' +
    '<span style="font-size:13px;font-weight:600;color:#c8d0de;">Export Game</span>' +
    '<button data-action="close-export-window" style="' + CLOSE_BTN_STYLE + '">\u2715</button>' +
    "</div>" +
    '<div style="' + BODY_STYLE + '">' +
    renderBody() +
    "</div>" +
    "</div>"
  );
}

function renderBody() {
  const status = editorState.exportStatus; // null | { phase: "running"|"done"|"error", message, stats?, error? }

  if (status && status.phase === "running") {
    return renderProgress(status);
  }
  if (status && status.phase === "done") {
    return renderResult(status);
  }
  if (status && status.phase === "error") {
    return renderError(status);
  }
  return renderDetailsForm() + renderFormatPicker();
}

/**
 * Title + favicon step, shown above the format cards (not gated behind
 * a separate "Continue" click — both are visible at once so changing
 * the title/icon and then picking a format is a single flow, matching
 * how the rest of the editor's popups avoid unnecessary multi-step
 * wizards for a couple of fields).
 */
function renderDetailsForm() {
  const title = editorState.exportGameTitle != null ? editorState.exportGameTitle : (editorState.projectName || "");
  const favicon = editorState.exportFavicon;

  return (
    '<div style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #2e3a50;">' +
    '<label style="display:block;font-size:10.5px;color:#8a93a0;margin-bottom:5px;">Game title</label>' +
    '<input type="text" data-action="export-title-input" value="' + escAttr(title) +
    '" placeholder="My Game" maxlength="80" style="width:100%;box-sizing:border-box;background:#171b26;' +
    'border:1px solid #3a4560;border-radius:5px;color:#e2e8f2;font-size:12px;padding:7px 9px;font-family:inherit;margin-bottom:12px;" />' +

    '<label style="display:block;font-size:10.5px;color:#8a93a0;margin-bottom:5px;">Favicon <span style="color:#5a6480;">(optional)</span></label>' +
    '<div style="display:flex;align-items:center;gap:10px;">' +
    renderFaviconPreview(favicon) +
    '<label style="background:#2e3a50;border:1px solid #3a4560;color:#c8d0de;border-radius:5px;padding:6px 12px;' +
    'font-size:11px;cursor:pointer;">' +
    (favicon ? "Change\u2026" : "Choose image\u2026") +
    '<input type="file" accept="image/*" data-action="export-favicon-input" style="display:none;" />' +
    "</label>" +
    (favicon
      ? '<button type="button" data-action="export-favicon-clear" style="background:none;border:none;color:#8a93a0;' +
        'font-size:11px;cursor:pointer;text-decoration:underline;">Remove</button>'
      : "") +
    "</div>" +
    "</div>"
  );
}

function renderFaviconPreview(favicon) {
  const boxStyle =
    "width:32px;height:32px;border-radius:5px;border:1px solid #3a4560;background:#171b26;" +
    "display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;";
  if (favicon && favicon.dataUrl) {
    return '<div style="' + boxStyle + '"><img src="' + favicon.dataUrl + '" alt="Favicon preview" style="width:100%;height:100%;object-fit:contain;" /></div>';
  }
  return '<div style="' + boxStyle + 'color:#4a5470;">' + icon("camera", 14) + "</div>";
}

function renderFormatPicker() {
  return (
    '<div style="font-size:11px;color:#8a93a0;margin-bottom:12px;line-height:1.5;">' +
    "Choose a format to build a standalone copy of your game — no editor required to run it. " +
    "More formats will show up here as they\u2019re added." +
    "</div>" +
    FORMATS.map((fmt) => {
      if (fmt.id === "android") {
        return renderCard(fmt, editorState.androidServerStatus) + renderAndroidServerPanel();
      }
      return renderCard(fmt, null);
    }).join("")
  );
}

function renderServerBadge(status) {
  if (status === "checking") {
    return '<span style="font-size:9px;color:#8a93a0;background:#262c3a;border-radius:3px;padding:1px 6px;">Checking server\u2026</span>';
  }
  if (status === "awake") {
    return '<span style="font-size:9px;color:#7ee787;background:#16281f;border-radius:3px;padding:1px 6px;">\u25cf Server awake</span>';
  }
  if (status === "asleep") {
    return '<span style="font-size:9px;color:#f0b849;background:#2e2515;border-radius:3px;padding:1px 6px;" ' +
      'title="Free-tier hosts sleep after inactivity. Building will wake it, but the first request may take a while or time out — try again if it does.">' +
      "\u25cf Server may be asleep</span>";
  }
  return "";
}

/**
 * Android build servers are user-owned (see ServerConfig.js's top
 * comment) rather than one baked into the editor, so this renders a
 * small management panel directly under the Android card: a dropdown of
 * the user's saved servers (if any), and an add/edit form. Kept as part
 * of the Android FORMATS entry rather than a separate top-level section
 * since it's meaningless for any other export target.
 */
function renderApiKeyHelp() {
  return (
    '<div style="font-size:11px;color:#c8d0de;margin-bottom:8px;line-height:1.5;">Need an API key? ' +
    '<a href="' + escAttr(APK_SERVICE_URL) + '" target="_blank" rel="noopener noreferrer" ' +
    'style="color:#7cd4ff;font-weight:600;text-decoration:underline;">Click HERE</a> to get your API key.' +
    "</div>"
  );
}

function renderAndroidServerPanel() {
  const servers = editorState.androidServers || [];
  const activeId = editorState.androidActiveServerId;

  let body = "";
  if (servers.length === 0 && !editorState.androidServerFormOpen) {
    body =
      '<div style="font-size:10.5px;color:#8a93a0;margin-bottom:8px;line-height:1.5;">' +
      "The editor can't compile APKs itself \u2014 Android builds run on the Realot APK service. " +
      "Add the server URL and your API key to get started." +
      "</div>" +
      renderApiKeyHelp() +
      '<button type="button" data-action="android-server-add-open" style="' + SMALL_BTN_STYLE + '">+ Add build server</button>';
  } else if (!editorState.androidServerFormOpen) {
    body =
      '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;">' +
      servers.map((s) => renderServerRow(s, s.id === activeId)).join("") +
      "</div>" +
      renderApiKeyHelp() +
      '<div style="display:flex;gap:10px;align-items:center;">' +
      '<button type="button" data-action="android-server-add-open" style="' + SMALL_BTN_STYLE + '">+ Add another server</button>' +
      "</div>";
  } else {
    body = renderAndroidServerForm();
  }

  return (
    '<div style="margin:-4px 0 10px 30px;padding:10px 12px;background:#171b26;border:1px solid #2e3a50;border-radius:6px;">' +
    body +
    "</div>"
  );
}

function renderServerRow(server, isActive) {
  return (
    '<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;' +
    (isActive ? "background:#22304a;border:1px solid #3a5a8a;" : "background:#1e2330;border:1px solid #2e3a50;") +
    '">' +
    '<button type="button" data-action="android-server-select" data-server-id="' + escAttr(server.id) + '" ' +
    'style="flex:1;min-width:0;text-align:left;background:none;border:none;color:' + (isActive ? "#e2e8f2" : "#c8d0de") + ';' +
    'font-size:11px;cursor:pointer;display:flex;align-items:center;gap:6px;padding:0;">' +
    (isActive ? '<span style="color:#7ee787;flex-shrink:0;">\u25cf</span>' : '<span style="color:#4a5470;flex-shrink:0;">\u25cb</span>') +
    '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escAttr(server.label) + "</span>" +
    "</button>" +
    '<button type="button" data-action="android-server-edit-open" data-server-id="' + escAttr(server.id) + '" ' +
    'title="Edit" style="background:none;border:none;color:#6b7488;cursor:pointer;padding:2px 4px;flex-shrink:0;font-size:10px;">Edit</button>' +
    '<button type="button" data-action="android-server-delete" data-server-id="' + escAttr(server.id) + '" ' +
    'title="Remove" style="background:none;border:none;color:#6b7488;cursor:pointer;padding:2px;flex-shrink:0;">' + icon("trash", 12) + "</button>" +
    "</div>"
  );
}

function renderAndroidServerForm() {
  const isEditing = !!editorState.androidServerFormEditingId;
  return (
    '<div style="font-size:10.5px;color:#8a93a0;margin-bottom:8px;line-height:1.5;">' +
    (isEditing ? "Editing build server. " : "") +
    "Enter the server URL and your API key. They are saved only in this browser." +
    "</div>" +
    renderApiKeyHelp() +
    '<label style="display:block;font-size:10px;color:#8a93a0;margin-bottom:3px;">Label <span style="color:#5a6480;">(optional)</span></label>' +
    '<input type="text" data-action="android-server-label-input" value="' + escAttr(editorState.androidServerFormLabel || "") + '" ' +
    'placeholder="e.g. My build server" style="' + SMALL_INPUT_STYLE + 'margin-bottom:8px;" />' +
    '<label style="display:block;font-size:10px;color:#8a93a0;margin-bottom:3px;">Server URL</label>' +
    '<input type="text" data-action="android-server-url-input" value="' + escAttr(editorState.androidServerFormUrl || "") + '" ' +
    'placeholder="' + escAttr(APK_SERVICE_URL.replace(/\/$/, "")) + '" style="' + SMALL_INPUT_STYLE + 'margin-bottom:8px;" />' +
    '<label style="display:block;font-size:10px;color:#8a93a0;margin-bottom:3px;">API Key</label>' +
    '<input type="text" data-action="android-server-key-input" value="' + escAttr(editorState.androidServerFormKey || "") + '" ' +
    'placeholder="Your API key" style="' + SMALL_INPUT_STYLE + 'margin-bottom:10px;" />' +
    (editorState.androidServerFormError
      ? '<div style="font-size:10.5px;color:#f0b849;margin-bottom:8px;">' + escAttr(editorState.androidServerFormError) + "</div>"
      : "") +
    '<div style="display:flex;gap:8px;">' +
    '<button type="button" data-action="android-server-form-save" ' +
    'style="' + SMALL_BTN_STYLE + '">' + (isEditing ? "Save changes" : "Add server") + "</button>" +
    '<button type="button" data-action="android-server-form-cancel" style="background:none;border:none;color:#8a93a0;font-size:11px;cursor:pointer;">Cancel</button>' +
    "</div>"
  );
}

const SMALL_BTN_STYLE =
  "background:#2e3a50;border:1px solid #3a4560;color:#c8d0de;border-radius:5px;padding:5px 10px;font-size:10.5px;cursor:pointer;";

const SMALL_INPUT_STYLE =
  "width:100%;box-sizing:border-box;background:#0f1219;border:1px solid #3a4560;border-radius:5px;" +
  "color:#e2e8f2;font-size:11px;padding:6px 8px;font-family:inherit;";

function renderCard(fmt, serverStatus) {
  if (fmt.comingSoon) {
    return (
      '<div style="' + CARD_DISABLED_STYLE + '" title="Coming soon">' +
      '<div style="flex-shrink:0;color:#5a6480;margin-top:1px;">' + icon(fmt.iconName, 18) + "</div>" +
      '<div style="flex:1;min-width:0;">' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
      '<span style="font-size:12px;font-weight:600;color:#8a93a0;">' + escAttr(fmt.label) + "</span>" +
      '<span style="font-size:9px;color:#6b7488;background:#262c3a;border-radius:3px;padding:1px 6px;">Coming soon</span>' +
      "</div>" +
      '<div style="font-size:10.5px;color:#5a6480;margin-top:3px;line-height:1.4;">' + escAttr(fmt.description) + "</div>" +
      "</div>" +
      "</div>"
    );
  }
  return (
    '<button type="button" data-action="start-export" data-format="' + fmt.id + '" style="' + CARD_STYLE + '">' +
    '<div style="flex-shrink:0;color:#7dd3fc;margin-top:1px;">' + icon(fmt.iconName, 18) + "</div>" +
    '<div style="flex:1;min-width:0;">' +
    '<div style="display:flex;align-items:center;gap:8px;">' +
    '<span style="font-size:12px;font-weight:600;color:#e2e8f2;">' + escAttr(fmt.label) + "</span>" +
    (serverStatus ? renderServerBadge(serverStatus) : "") +
    "</div>" +
    '<div style="font-size:10.5px;color:#9aa4b2;margin-top:3px;line-height:1.4;">' + escAttr(fmt.description) + "</div>" +
    "</div>" +

    "</button>"
  );
}

function renderProgress(status) {
  return (
    '<div style="padding:20px 4px;">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">' +
    '<div class="export-spinner" style="width:16px;height:16px;border-radius:50%;border:2px solid #3a4560;border-top-color:#7dd3fc;animation:export-spin 0.8s linear infinite;"></div>' +
    '<span style="font-size:12px;color:#c8d0de;">Building export\u2026</span>' +
    "</div>" +
    '<div style="font-size:11px;color:#8a93a0;">' + escAttr(status.message || "") + "</div>" +
    // Only Android builds can be cancelled — they run on a remote server
    // that may be busy for minutes; HTML5/PWA exports finish locally.
    (isAndroidBuildActive()
      ? '<div style="font-size:10.5px;color:#e0c878;margin-top:10px;line-height:1.5;">' +
        "The APK is being built on the server. Don\u2019t restart or leave the editor until it finishes \u2014 or cancel it here." +
        "</div>" +
        '<button type="button" data-action="cancel-android-build" style="margin-top:12px;background:#4a2326;border:1px solid #8a3a40;color:#ffd7da;border-radius:5px;padding:7px 12px;font-size:11px;font-weight:600;cursor:pointer;width:100%;">Cancel build</button>'
      : "") +
    "<style>@keyframes export-spin { to { transform: rotate(360deg); } }</style>" +
    "</div>"
  );
}

function renderResult(status) {
  const stats = status.stats || {};
  const isAndroid = stats.format === "android";
  const savedPct =
    stats.bytesBefore > 0 ? Math.round((1 - stats.bytesAfter / stats.bytesBefore) * 100) : 0;
  const skippedNote =
    (stats.skippedSpriteCount || stats.skippedAudioCount)
      ? '<div style="font-size:10.5px;color:#7a8494;margin-top:6px;">Skipped ' +
        stats.skippedSpriteCount + " unused image(s) and " + stats.skippedAudioCount + " unused audio clip(s)."
        + "</div>"
      : "";
  return (
    '<div style="padding:8px 4px;">' +
    '<div style="display:flex;align-items:center;gap:8px;color:#4ade80;margin-bottom:10px;">' +
    icon("info", 16) +
    '<span style="font-size:12px;font-weight:600;">' + (isAndroid ? "APK ready \u2014 download started" : "Export ready \u2014 download started") + "</span>" +
    "</div>" +
    '<div style="font-size:11px;color:#c8d0de;line-height:1.7;">' +
    (isAndroid
      ? "A debug-signed Android APK was built. Install it directly on an Android device."
      : stats.spriteCount + " image(s), " + stats.audioCount + " audio clip(s) bundled.") +
    (stats.bytesBefore ? "<br/>Assets shrunk by ~" + savedPct + "% (" + formatBytes(stats.bytesBefore) + " \u2192 " + formatBytes(stats.bytesAfter) + ")." : "") +
    "</div>" +
    skippedNote +
    (isAndroid ? "" : (
      '<div style="margin-top:10px;padding:8px 10px;background:#2a2410;border:1px solid #5a4a1a;border-radius:5px;font-size:10.5px;color:#e0c878;line-height:1.5;">' +
      icon("alerttriangle", 12) + " " +
      "Don't just double-click index.html \u2014 opening it directly from your files (file://) will show a blank or broken page in every browser, since the game's own module scripts and asset requests need a real http:// server to load. " +
      "Either upload this whole folder to a static host (itch.io, GitHub Pages, Cloudflare Pages, Netlify all work), or run a local server on it first (e.g. <code style=\"background:#1a1710;padding:1px 4px;border-radius:3px;\">npx serve .</code> from inside the folder) and open the http://localhost address it gives you." +
      "</div>"
    )) +
    (isAndroid ? "" : (editorState.lastWebExport && getActiveAndroidServer()
      ? '<button type="button" data-action="build-apk-from-last-export" style="margin-top:10px;background:#245b45;border:1px solid #3d8a67;color:#d7ffe9;border-radius:5px;padding:7px 12px;font-size:11px;font-weight:600;cursor:pointer;width:100%;">Build APK from this ' + (editorState.lastWebExport.format === "pwa" ? "PWA" : "HTML5") + ' export</button>'
      : "")) +
    '<button type="button" data-action="export-window-reset" style="margin-top:14px;background:#2e3a50;border:1px solid #3a4560;color:#c8d0de;border-radius:5px;padding:6px 12px;font-size:11px;cursor:pointer;">Export another format</button>' +
    "</div>"
  );
}

function renderError(status) {
  return (
    '<div style="padding:8px 4px;">' +
    '<div style="display:flex;align-items:center;gap:8px;color:#f87171;margin-bottom:8px;">' +
    icon("alerttriangle", 16) +
    '<span style="font-size:12px;font-weight:600;">Export failed</span>' +
    "</div>" +
    '<div style="font-size:11px;color:#c8d0de;line-height:1.5;">' + escAttr(status.error || "Unknown error.") + "</div>" +
    '<button type="button" data-action="export-window-reset" style="margin-top:14px;background:#2e3a50;border:1px solid #3a4560;color:#c8d0de;border-radius:5px;padding:6px 12px;font-size:11px;cursor:pointer;">Try again</button>' +
    "</div>"
  );
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function escAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
