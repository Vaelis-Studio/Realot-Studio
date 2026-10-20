/**
 * ClaudeBridge.js — lets Claude (via an MCP connector) see and edit the open
 * project, "like Higgsfield's MCP": the editor opens a WebSocket to a small
 * relay (see /relay), the relay exposes an MCP server URL, and every tool call
 * Claude makes arrives here and runs against the live editor.
 *
 *   - Off by default. Nothing connects until the user presses Connect.
 *   - The 64-hex secret key in the connector URL is generated here and never
 *     leaves this browser except inside that URL.
 *   - "Read-only" blocks every tool that changes anything.
 *   - Edits go through the editor's own undo history (snapshotNow) so
 *     Ctrl+Z / the undo tool reverts them.
 */
import { editorState, pushLog, markDirty } from "../state/EditorState.js";
import { snapshotNow, performUndoRedo } from "../state/UndoManager.js";
import { serializeEntity, instantiateEntity, COMPONENT_REGISTRY } from "../../runtime/scene/SceneSerializer.js";
import { getAllScripts, getScriptSource, saveScript, scriptExists } from "../scripting/ScriptStorage.js";
import { syncScriptSourcesInWorld } from "../scripting/ScriptSync.js";
import { writeProjectToFile, isFileSyncActive } from "../state/FileSync.js";
import { DEFAULT_RELAY_URL } from "./bridge-config.js";
import { runMcpAssetTool } from "../mcp/McpAssetTools.js";
import { runMcpEditorTool } from "../mcp/McpEditorTools.js";
import { runMcpProjectTool } from "../mcp/McpProjectTools.js";
import { runMcpWorkflowTool } from "../mcp/McpWorkflowTools.js";
import { validateComponentProps, formatProblems } from "../mcp/ComponentRules.js";

const STORE_KEY = "realot_claude_bridge";
const MUTATING = new Set([
  "create_entity", "update_component", "add_component", "remove_component",
  "delete_entities", "write_script", "attach_script", "undo", "redo", "save_project",
  "begin_asset_upload", "append_asset_upload_chunk", "complete_asset_upload", "cancel_asset_upload",
  "rename_asset", "delete_asset", "create_animation_clip", "update_animation_clip",
  "delete_animation_clip", "move_animation_frame", "delete_animation_frame", "update_tileset",
  "paint_tilemap", "paint_navigation_cells", "update_navigation_world", "set_navigation_area_name",
  "set_physics_layer_name", "set_collider_layer_filter",
  "update_entity", "create_scene", "switch_scene", "rename_scene", "delete_scene",
  "add_tag", "delete_tag", "create_prefab", "instantiate_prefab", "rename_prefab", "delete_prefab",
  "create_folder", "rename_folder", "move_folder", "delete_folder", "update_prefab", "revert_prefab",
  "unpack_prefab", "duplicate_scene", "delete_script", "set_script_enabled", "bake_navworld",
]);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ---------------------------------------------------------------- settings
function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return { relayUrl: c.relayUrl || "", key: c.key || "", readOnly: !!c.readOnly, autoConnect: !!c.autoConnect, autoConnectChosen: !!c.autoConnectChosen, repo: c.repo || "" };
  } catch (_) { return { relayUrl: "", key: "", readOnly: false, autoConnect: false, autoConnectChosen: false, repo: "" }; }
}
const cfg = loadCfg();
function saveCfg() { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (_) {} }
function newKey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- connection
const status = { state: "off", message: "" }; // off | connecting | connected | error
let ws = null, pingTimer = null, retryTimer = null, retryMs = 1000, wantConnected = false;

export function getClaudeBridgeStatus() { return status; }

function setStatus(state, message) {
  status.state = state;
  status.message = message || "";
  const dot = state === "connected" ? "#4caf7d" : state === "connecting" ? "#f5a623" : state === "error" ? "#e5534b" : "#777";
  document.querySelectorAll("[data-claude-dot]").forEach((el) => { el.style.background = dot; });
  const line = document.getElementById("claude-bridge-status");
  if (line) line.textContent = statusText();
  const btn = document.getElementById("claude-bridge-toggle");
  if (btn) btn.textContent = wantConnected ? "Disconnect" : "Connect";
}
function statusText() {
  return ({ off: "Not connected", connecting: "Connecting…", connected: "Connected — Claude can use this editor", error: "Error" }[status.state]) +
    (status.message ? " — " + status.message : "");
}

/** Accepts what people actually paste: with/without https://, with a trailing slash, or the whole connector link. */
function normalizeRelay(v) {
  let u = String(v || "").trim();
  if (!u) return "";
  u = u.replace(/\/(mcp|bridge)(\/.*)?$/i, "").replace(/\/+$/, "");
  if (!/^[a-z]+:\/\//i.test(u)) u = (/^(localhost|127\.)/i.test(u) ? "http://" : "https://") + u;
  return u;
}

/** The relay in use: the user's own (advanced) or the one built into this engine. */
function effectiveRelay() { return normalizeRelay(cfg.relayUrl || DEFAULT_RELAY_URL); }

function wsUrl() {
  let base = effectiveRelay();
  if (!/^https?:\/\//i.test(base)) throw new Error("Relay URL must start with https:// (or http://localhost)");
  base = base.replace(/^http/i, "ws");
  return base + "/bridge/" + cfg.key;
}
export function connectorUrl() {
  return effectiveRelay() + "/mcp/" + cfg.key;
}

export function connectClaudeBridge() {
  if (!cfg.key) { cfg.key = newKey(); saveCfg(); }
  wantConnected = true;
  clearTimeout(retryTimer);
  let url;
  try { url = wsUrl(); } catch (e) { wantConnected = false; setStatus("error", e.message); return; }
  setStatus("connecting");
  try { ws = new WebSocket(url); } catch (e) { setStatus("error", String(e.message || e)); scheduleRetry(); return; }
  const mine = ws;
  let everOpened = false;
  ws.onopen = () => {
    everOpened = true;
    retryMs = 1000;
    if (!cfg.autoConnectChosen) { cfg.autoConnect = true; cfg.autoConnectChosen = true; saveCfg(); }
    const autoBox = document.getElementById("cb-auto");
    if (autoBox) autoBox.checked = cfg.autoConnect;
    setStatus("connected");
    pushLog("log", "Claude bridge connected.");
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { mine.send('{"type":"ping"}'); } catch (_) {} }, 25000);
  };
  ws.onmessage = (ev) => onMessage(mine, ev);
  ws.onerror = () => { /* onclose follows */ };
  ws.onclose = () => {
    clearInterval(pingTimer);
    if (ws === mine) ws = null;
    if (wantConnected) {
      setStatus("error", everOpened ? "connection lost — retrying" : "couldn't reach the relay — check the address you pasted (it ends in .workers.dev)");
      scheduleRetry();
    }
    else setStatus("off");
  };
}
function scheduleRetry() {
  clearTimeout(retryTimer);
  if (!wantConnected) return;
  retryTimer = setTimeout(connectClaudeBridge, retryMs);
  retryMs = Math.min(retryMs * 2, 20000);
}
export function disconnectClaudeBridge() {
  wantConnected = false;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  if (ws) { try { ws.close(1000, "user disconnected"); } catch (_) {} ws = null; }
  setStatus("off");
  pushLog("log", "Claude bridge disconnected.");
}

async function onMessage(sock, ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch (_) { return; }
  if (msg.type !== "call") return;
  status.lastTool = msg.tool;
  status.lastAt = new Date();
  const last = document.getElementById("cb-last");
  if (last) last.textContent = "Claude just used: " + msg.tool + " (" + status.lastAt.toLocaleTimeString() + ")";
  let res;
  try {
    res = await runTool(msg.tool, msg.args || {});
  } catch (e) {
    res = err("Tool failed: " + (e && e.message ? e.message : e));
  }
  try { sock.send(JSON.stringify({ type: "result", id: msg.id, content: res.content, isError: !!res.isError })); } catch (_) {}
}

export function initClaudeBridge() {
  if (cfg.autoConnect && effectiveRelay() && cfg.key) connectClaudeBridge();
}

// ---------------------------------------------------------------- tool helpers
const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });
const err = (t) => ({ isError: true, content: [{ type: "text", text: t }] });
const round = (n) => Math.round(n * 100) / 100;
const world = () => editorState.world;
const rerender = () => { if (editorState.renderFn) editorState.renderFn(); };
function changed(note) { markDirty(); pushLog("log", "Claude: " + note); rerender(); }
const clone = (v) => JSON.parse(JSON.stringify(v));

function summary(e) {
  const t = e.getComponent("Transform");
  return {
    id: e.id, name: e.name, tag: e.tag || "", active: e.active !== false,
    components: Array.from(e.components.keys()),
    x: t ? round(t.x) : undefined, y: t ? round(t.y) : undefined,
  };
}
function need(id) {
  const e = world() && world().getEntity(id);
  if (!e) throw new Error("No entity with id '" + id + "'. Use list_entities to see valid ids.");
  return e;
}
function checkTypes(types) {
  const bad = types.filter((t) => !hasOwn(COMPONENT_REGISTRY, t));
  if (bad.length) throw new Error("Unknown component type(s): " + bad.join(", ") + ". Valid: " + Object.keys(COMPONENT_REGISTRY).join(", "));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTool(name, a) {
  if (!world()) return err("The editor has no project loaded yet.");
  if (cfg.readOnly && MUTATING.has(name)) return err("Read-only mode is on. Ask the user to turn it off in the Claude panel to allow edits.");
  switch (name) {
    case "get_editor_state":
      return text({
        project: editorState.projectName || null,
        playing: !!editorState.isPlaying,
        selectedIds: editorState.selectedIds || [],
        entityCount: world().getAllEntities().length,
        scripts: getAllScripts().length,
        fileKeptUpToDate: editorState.fileHandle ? editorState.fileHandle.name : null,
        readOnly: cfg.readOnly,
        componentTypes: Object.keys(COMPONENT_REGISTRY),
      });

    case "list_entities": {
      const all = world().getAllEntities();
      const limit = Math.max(1, a.limit || 200);
      return text({ total: all.length, entities: all.slice(0, limit).map(summary) });
    }

    case "get_entity": {
      const e = need(a.id);
      return text({ id: e.id, ...serializeEntity(e) });
    }

    case "create_entity": {
      const comps = clone(a.components || {});
      checkTypes(Object.keys(comps));
      comps.Transform = { x: a.x ?? 0, y: a.y ?? 0, ...(comps.Transform || {}) };
      for (const [ctype, cprops] of Object.entries(comps)) {
        if (!cprops || typeof cprops !== "object" || Array.isArray(cprops)) return err("components." + ctype + " must be an object of properties.");
        const createProblems = validateComponentProps(ctype, cprops, COMPONENT_REGISTRY[ctype]);
        if (createProblems.length) return err(formatProblems("create_entity", ctype, createProblems));
      }
      snapshotNow("scene");
      const e = instantiateEntity(world(), { name: a.name || "GameObject", tag: a.tag, active: true, components: comps });
      editorState.selectedId = e.id;
      editorState.selectedIds = [e.id];
      changed("created '" + e.name + "' (" + e.id + ")");
      return text({ created: summary(e) });
    }

    case "update_component": {
      const e = need(a.id);
      const c = e.getComponent(a.type);
      if (!c) return err("Entity " + a.id + " has no " + a.type + " component. Use add_component first.");
      const props = a.props;
      if (!props || typeof props !== "object" || Array.isArray(props) || !Object.keys(props).length) return err("props must be a non-empty object, e.g. {\"intensity\": 2}. Call get_entity to see the component's current properties.");
      const problems = validateComponentProps(a.type, props, COMPONENT_REGISTRY[a.type], c);
      if (problems.length) return err(formatProblems("update_component", a.type, problems));
      snapshotNow("scene");
      for (const [k, v] of Object.entries(a.props || {})) c[k] = clone(v);
      changed("updated " + a.type + " on '" + e.name + "'");
      return text({ id: e.id, [a.type]: clone(c) });
    }

    case "add_component": {
      const e = need(a.id);
      checkTypes([a.type]);
      if (e.hasComponent(a.type)) return err("Entity already has " + a.type + ". Use update_component.");
      if (a.props !== undefined && (!a.props || typeof a.props !== "object" || Array.isArray(a.props))) return err("props must be an object.");
      const addProblems = validateComponentProps(a.type, a.props || {}, COMPONENT_REGISTRY[a.type]);
      if (addProblems.length) return err(formatProblems("add_component", a.type, addProblems));
      snapshotNow("scene");
      e.addComponent(a.type, new COMPONENT_REGISTRY[a.type](clone(a.props || {})));
      changed("added " + a.type + " to '" + e.name + "'");
      return text({ id: e.id, [a.type]: clone(e.getComponent(a.type)) });
    }

    case "remove_component": {
      const e = need(a.id);
      if (a.type === "Transform") return err("Transform can't be removed.");
      if (!e.hasComponent(a.type)) return err("Entity has no " + a.type + ".");
      snapshotNow("scene");
      e.removeComponent(a.type);
      changed("removed " + a.type + " from '" + e.name + "'");
      return text({ id: e.id, components: Array.from(e.components.keys()) });
    }

    case "delete_entities": {
      const ids = (a.ids || []).filter((id) => world().getEntity(id));
      if (!ids.length) return err("None of those ids exist.");
      editorState.selectedIds = ids.slice();
      editorState.selectedId = ids[ids.length - 1];
      // Same code path as pressing Delete (handles children, folders, undo).
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
      await sleep(50);
      let left = ids.filter((id) => world().getEntity(id));
      if (left.length) { snapshotNow("scene"); left.forEach((id) => world().destroyEntity(id)); left = []; }
      changed("deleted " + ids.length + " entit" + (ids.length === 1 ? "y" : "ies"));
      return text({ deleted: ids });
    }

    case "select_entities": {
      const ids = (a.ids || []).filter((id) => world().getEntity(id));
      editorState.selectedIds = ids;
      editorState.selectedId = ids.length ? ids[ids.length - 1] : null;
      rerender();
      return text({ selected: ids });
    }

    case "list_scripts":
      return text({ scripts: getAllScripts() });

    case "get_script":
      if (!scriptExists(a.name)) return err("No script named '" + a.name + "'. Existing: " + getAllScripts().join(", "));
      return text(getScriptSource(a.name));

    case "write_script": {
      if (typeof a.name !== "string" || !a.name.trim() || a.name.length > 240) return err("name must be a non-empty string (max 240 characters).");
      if (typeof a.source !== "string") return err("source must be a string.");
      if (a.source.length > 250_000) return err("source is too large (limit 250,000 characters).");
      let syntaxError = null;
      try { new Function(a.source); } catch (e) { syntaxError = String(e.message || e); }
      saveScript(a.name, a.source);
      const usedBy = syncScriptSourcesInWorld(world());
      changed("wrote script '" + a.name + "' (" + a.source.length + " chars)");
      return text({ saved: a.name, entitiesUsingAScript: usedBy, syntaxError });
    }

    case "attach_script": {
      const e = need(a.id);
      if (!scriptExists(a.scriptName)) return err("No script named '" + a.scriptName + "'. Use write_script first.");
      snapshotNow("scene");
      const existing = e.getComponent("Script");
      if (existing) { existing.scriptName = a.scriptName; existing.source = getScriptSource(a.scriptName); }
      else e.addComponent("Script", new COMPONENT_REGISTRY.Script({ scriptName: a.scriptName, source: getScriptSource(a.scriptName) }));
      changed("attached script '" + a.scriptName + "' to '" + e.name + "'");
      return text({ id: e.id, scriptName: a.scriptName });
    }

    case "set_playing": {
      if (!!editorState.isPlaying !== !!a.playing) {
        const btn = document.querySelector('[data-action="toggle-play"]');
        if (!btn) return err("Play button not found.");
        btn.click();
        await sleep(900);
      }
      return text({ playing: !!editorState.isPlaying });
    }

    case "get_console": {
      const n = Math.max(1, a.limit || 40);
      return text((editorState.logs || []).slice(-n).map((l) => l.type + ": " + l.msg + (l.count > 1 ? " (x" + l.count + ")" : "")).join("\n") || "(console is empty)");
    }

    case "screenshot":
      return await takeScreenshot();

    case "undo":
    case "redo": {
      const did = performUndoRedo(name);
      rerender();
      return text({ [name]: !!did });
    }

    case "save_project": {
      const out = [];
      if (typeof editorState.saveNow === "function") { await editorState.saveNow(); out.push("saved to the browser autosave slot"); }
      if (isFileSyncActive()) { const ok = await writeProjectToFile("claude", true); out.push(ok ? "updated " + editorState.fileHandle.name : "could not update the file (permission needed — user must click the page)"); }
      return text(out.length ? out.join("; ") : "Nothing to save to (open a project from the launcher or keep a .realot file up to date).");
    }

    default: {
      const assetResult = await runMcpAssetTool(name, a);
      if (assetResult) return assetResult;
      const editorResult = await runMcpEditorTool(name, a);
      if (editorResult) return editorResult;
      const projectResult = await runMcpProjectTool(name, a);
      if (projectResult) return projectResult;
      const workflowResult = await runMcpWorkflowTool(name, a);
      if (workflowResult) return workflowResult;
      return err("Unknown tool: " + name);
    }
  }
}

async function takeScreenshot() {
  const canvases = Array.from(document.querySelectorAll("canvas")).filter((c) => c.width > 50 && c.height > 50 && c.offsetParent !== null);
  if (!canvases.length) return err("No viewport canvas is visible.");
  canvases.sort((x, y) => y.width * y.height - x.width * x.height);
  const src = canvases[0];
  // Read the canvas right after a frame has been drawn, otherwise WebGL gives a blank image.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const scale = Math.min(1, 1280 / src.width);
  const out = document.createElement("canvas");
  out.width = Math.round(src.width * scale);
  out.height = Math.round(src.height * scale);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#1e1e1e";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0, out.width, out.height);
  const data = out.toDataURL("image/jpeg", 0.82).split(",")[1];
  if (!data || data.length < 2000) return err("The viewport image came back blank. Try again in a moment.");
  return { content: [{ type: "image", data, mimeType: "image/jpeg" }] };
}

// ---------------------------------------------------------------- panel UI
/** Best guess of this engine's GitHub repo when it is hosted on GitHub Pages. */
function guessRepo() {
  const host = location.hostname;
  if (!/\.github\.io$/i.test(host)) return "";
  const owner = host.split(".")[0];
  const seg = location.pathname.split("/")[1] || "";
  const rootFolders = ["project", "js", "css", "icons", "docs", "relay", ""];
  const repo = rootFolders.includes(seg) || seg.endsWith(".html") ? owner + ".github.io" : seg;
  return "https://github.com/" + owner + "/" + repo;
}
function deployUrl(repoUrl) {
  const clean = String(repoUrl || "").trim().replace(/\.git$/i, "").replace(/\/+$/, "").replace(/\/tree\/.*$/, "");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(clean)) return null;
  return "https://deploy.workers.cloudflare.com/?url=" + encodeURIComponent(clean + "/tree/main/relay");
}

export function openClaudeBridgePanel() {
  if (document.getElementById("claude-bridge-panel")) return;
  if (!cfg.key) { cfg.key = newKey(); saveCfg(); }
  if (!cfg.repo) cfg.repo = guessRepo();

  const wrap = document.createElement("div");
  wrap.id = "claude-bridge-panel";
  wrap.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;";
  const card = document.createElement("div");
  card.style.cssText = "width:min(540px,94vw);max-height:92vh;overflow:auto;background:#2b2b2b;color:#ddd;border:1px solid #444;border-radius:8px;padding:16px 18px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.6);";
  const stepHead = (n, t) => '<div style="display:flex;align-items:center;gap:8px;margin:14px 0 6px;"><span style="width:20px;height:20px;border-radius:50%;background:#3d6fb5;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;">' + n + '</span><b>' + t + '</b></div>';
  const inputCss = "width:100%;box-sizing:border-box;background:#1e1e1e;color:#eee;border:1px solid #444;border-radius:4px;padding:6px 8px;";
  const simple = !!DEFAULT_RELAY_URL; // relay built into this engine: users skip all setup
  let n = 0;
  const head = (t) => stepHead(++n, t);
  const builderSetup =
    '<details id="cb-step1" ' + (effectiveRelay() ? "" : "open") + '><summary style="cursor:pointer;list-style:none;">' + head("Create your free relay (one time only)") + '</summary>' +
    '<div style="color:#9aa;margin-bottom:6px;">The relay is a tiny free Cloudflare service that links Claude to this editor. No coding \u2014 just sign in and press <i>Deploy</i>.</div>' +
    '<label style="display:block;margin-bottom:3px;color:#9aa;">GitHub address of your engine (where you uploaded these files)</label>' +
    '<input id="cb-repo" placeholder="https://github.com/yourname/yourrepo" style="' + inputCss + '">' +
    '<div style="margin-top:8px;"><button id="cb-deploy" class="pill-btn">Create relay on Cloudflare \u2197</button> <span id="cb-deploy-note" style="color:#e5534b;"></span></div>' +
    '<div style="color:#9aa;margin-top:6px;">When Cloudflare finishes it shows an address ending in <code>.workers.dev</code> \u2014 copy it for the next step.</div></details>' +
    head("Paste the relay address") +
    '<input id="cb-relay" placeholder="https://realot-bridge.yourname.workers.dev" style="' + inputCss + '">' +
    '<div style="color:#9aa;margin-top:6px;font-size:12px;">Builder tip: to give this to ALL your users, paste this address into <code>project/editor/bridge/bridge-config.js</code> and redeploy your site \u2014 your users then skip these two steps.</div>';
  if (simple) n = 0; // builder-only steps are hidden, so numbering starts at 1 for users
  card.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;">' +
    '<b style="font-size:16px;">Connect Claude to Realot</b><button id="cb-close" style="background:none;border:0;color:#aaa;font-size:20px;cursor:pointer;">\u00d7</button></div>' +
    '<div style="color:#9aa;margin-top:4px;">Claude can edit your scene and scripts, import sprites and audio, build animations and tilesets, paint tilemaps and navigation, and edit physics layers. Scene changes can be undone with Ctrl+Z.</div>' +
    (simple ? "" : builderSetup) +
    head("Connect") +
    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;"><button id="claude-bridge-toggle" class="pill-btn"></button><span id="claude-bridge-status" style="color:#9aa;"></span></div>' +
    head("Add it to Claude (one time)") +
    '<ol style="margin:0 0 8px 18px;padding:0;color:#bbb;"><li>Press <b>Copy link</b> below.</li><li>Open <b>Claude \u2192 Settings \u2192 Connectors \u2192 Add custom connector</b>.</li><li>Paste the link, name it <i>Realot</i>, press <b>Add</b>. Then just ask Claude to build in your project.</li></ol>' +
    '<div style="display:flex;gap:6px;"><input id="cb-link" readonly style="flex:1;min-width:0;' + inputCss + 'color:#9ad;"><button id="cb-copy" class="pill-btn">Copy link</button><button id="cb-open" class="pill-btn">Open Claude \u2197</button></div>' +
    '<div style="color:#e5534b;margin-top:4px;font-size:12px;">This link is your private key: anyone who has it can edit your open project. Don\u2019t share it.</div>' +
    '<div id="cb-last" style="margin-top:8px;color:#4caf7d;min-height:16px;"></div>' +
    '<div style="margin-top:10px;border-top:1px solid #3a3a3a;padding-top:10px;">' +
    '<div><label><input type="checkbox" id="cb-ro"> Read-only \u2014 Claude can look but not change anything</label></div>' +
    '<div style="margin:2px 0 8px;"><label><input type="checkbox" id="cb-auto"> Connect automatically when the editor opens</label></div>' +
    '<button id="cb-newkey" class="pill-btn" style="font-size:11px;">Make a new private link</button></div>';
  wrap.appendChild(card);
  document.body.appendChild(wrap);

  const $ = (id) => card.querySelector("#" + id);
  const refreshLink = () => { $("cb-link").value = effectiveRelay() ? connectorUrl() : "(set the relay address first)"; };
  if ($("cb-repo")) $("cb-repo").value = cfg.repo;
  if ($("cb-relay")) $("cb-relay").value = cfg.relayUrl;
  $("cb-ro").checked = cfg.readOnly;
  $("cb-auto").checked = cfg.autoConnect;
  refreshLink();
  setStatus(status.state, status.message);
  if (status.lastTool) $("cb-last").textContent = "Claude last used: " + status.lastTool + " (" + status.lastAt.toLocaleTimeString() + ")";

  if (!simple) {
    $("cb-repo").addEventListener("input", (e) => { cfg.repo = e.target.value; saveCfg(); $("cb-deploy-note").textContent = ""; });
    $("cb-deploy").addEventListener("click", () => {
      const u = deployUrl(cfg.repo);
      if (!u) { $("cb-deploy-note").textContent = "Enter your GitHub address first (https://github.com/name/repo)."; return; }
      window.open(u, "_blank", "noopener");
    });
    $("cb-relay").addEventListener("input", (e) => { cfg.relayUrl = e.target.value; saveCfg(); refreshLink(); });
    $("cb-relay").addEventListener("change", (e) => { cfg.relayUrl = normalizeRelay(e.target.value); e.target.value = cfg.relayUrl; saveCfg(); refreshLink(); });
  }
  $("cb-ro").addEventListener("change", (e) => { cfg.readOnly = e.target.checked; saveCfg(); });
  $("cb-auto").addEventListener("change", (e) => { cfg.autoConnect = e.target.checked; cfg.autoConnectChosen = true; saveCfg(); });
  $("cb-copy").addEventListener("click", () => {
    if (!effectiveRelay()) return;
    navigator.clipboard && navigator.clipboard.writeText($("cb-link").value);
    $("cb-copy").textContent = "Copied \u2713"; setTimeout(() => ($("cb-copy").textContent = "Copy link"), 1400);
  });
  $("cb-open").addEventListener("click", () => window.open("https://claude.ai/settings/connectors", "_blank", "noopener"));
  $("claude-bridge-toggle").addEventListener("click", () => {
    if (wantConnected) { disconnectClaudeBridge(); return; }
    if ($("cb-relay")) { cfg.relayUrl = normalizeRelay($("cb-relay").value); $("cb-relay").value = cfg.relayUrl; saveCfg(); refreshLink(); }
    connectClaudeBridge();
  });
  $("cb-newkey").addEventListener("click", () => {
    if (!window.confirm("Make a new secret link? The old link stops working and you must add the new one in Claude.")) return;
    const was = wantConnected; disconnectClaudeBridge(); cfg.key = newKey(); saveCfg(); refreshLink(); if (was) connectClaudeBridge();
  });
  const close = () => wrap.remove();
  $("cb-close").addEventListener("click", close);
  wrap.addEventListener("pointerdown", (e) => { if (e.target === wrap) close(); });
}
