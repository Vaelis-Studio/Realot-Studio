#!/usr/bin/env node
/**
 * Realot Studio MCP companion (Node.js built-ins only).
 *
 * STDIO carries MCP JSON-RPC for Claude Desktop/Claude Code. A localhost-only
 * WebSocket side channel connects that MCP process to the open Realot editor.
 * stdout is reserved exclusively for MCP protocol messages; diagnostics go to
 * stderr. The bridge never serves a public/network-interface listener.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const PORT = Number.parseInt(process.env.REALOT_MCP_PORT || "43182", 10);
const MAX_WS_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const CONFIG_DIR = path.join(os.homedir(), ".realot-studio-mcp");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const SERVER_PATH = fileURLToPath(import.meta.url);

const TOOL_DEFS = [
  {
    name: "realot_bridge_status",
    description: "Check whether the Realot editor is paired with this local MCP bridge. Does not modify the project.",
    inputSchema: objectSchema({}),
  },
  {
    name: "realot_get_status",
    description: "Read the live Realot Studio editor status: project, active scene, entity and script counts, play state, and unsaved-change state. Read-only.",
    inputSchema: objectSchema({}),
  },
  {
    name: "realot_list_scenes",
    description: "List every scene and identify the active scene. Read-only apart from flushing the active scene into Realot's in-memory scene list.",
    inputSchema: objectSchema({}),
  },
  {
    name: "realot_list_entities",
    description: "List entities and their serializable components in the active scene. Read-only.",
    inputSchema: objectSchema({}),
  },
  {
    name: "realot_get_entity",
    description: "Read one entity by id from the active scene, including its serializable component data. Read-only.",
    inputSchema: objectSchema({ entity_id: stringProp("Realot entity id, for example e12.") }, ["entity_id"]),
  },
  {
    name: "realot_create_entity",
    description: "Create an entity in the active scene. Scene edits are added to Realot's Ctrl+Z history. Transform is included automatically unless supplied in components.",
    inputSchema: objectSchema({
      name: stringProp("Entity name.", 160),
      tag: stringProp("Optional entity tag.", 120),
      x: numberProp("Initial world-space x position; defaults to 0."),
      y: numberProp("Initial world-space y position; defaults to 0."),
      components: { type: "object", description: "Optional component-type to constructor-data map. Use actual Realot component names such as SpriteRenderer, Rigidbody2D, Collider2D, or Script. Unknown component types are rejected.", additionalProperties: { type: "object" } },
    }),
  },
  {
    name: "realot_update_entity",
    description: "Update entity metadata or Transform values in the active scene. Allowed patch keys: name, tag, active, folderId, x, y, z, rotation, scaleX, scaleY. Scene edits are undoable with Ctrl+Z.",
    inputSchema: objectSchema({
      entity_id: stringProp("Realot entity id."),
      patch: { type: "object", description: "Non-empty set of allowed entity fields to update.", additionalProperties: true },
    }, ["entity_id", "patch"]),
  },
  {
    name: "realot_delete_entity",
    description: "Delete one entity from the active scene. This changes the project; Realot scene undo (Ctrl+Z) can restore it.",
    inputSchema: objectSchema({ entity_id: stringProp("Realot entity id to delete.") }, ["entity_id"]),
  },
  {
    name: "realot_add_component",
    description: "Add a supported Realot component to an entity. component_type must exactly match a component name shown in Realot, and fields must be JSON-compatible constructor data. Scene edits are undoable with Ctrl+Z.",
    inputSchema: objectSchema({
      entity_id: stringProp("Realot entity id."),
      component_type: stringProp("Component name, for example SpriteRenderer, Rigidbody2D, Collider2D, CharacterController, NavAgent2D, AudioSource, or Script."),
      fields: { type: "object", description: "Optional initial component field values; defaults are supplied by Realot when omitted.", additionalProperties: true },
    }, ["entity_id", "component_type"]),
  },
  {
    name: "realot_update_component",
    description: "Change existing, own data fields of a component on an entity. Fields must already exist on that component; methods and prototype fields cannot be overwritten. Script components should be edited using realot_set_script.",
    inputSchema: objectSchema({
      entity_id: stringProp("Realot entity id."),
      component_type: stringProp("Existing component name."),
      fields: { type: "object", description: "Non-empty values for existing fields on the component.", additionalProperties: true },
    }, ["entity_id", "component_type", "fields"]),
  },
  {
    name: "realot_remove_component",
    description: "Remove an existing component from an entity. Transform cannot be removed. Scene edits are undoable with Ctrl+Z.",
    inputSchema: objectSchema({
      entity_id: stringProp("Realot entity id."),
      component_type: stringProp("Existing component to remove."),
    }, ["entity_id", "component_type"]),
  },
  {
    name: "realot_list_scripts",
    description: "List Realot script names and source lengths. Does not modify scripts.",
    inputSchema: objectSchema({}),
  },
  {
    name: "realot_get_script",
    description: "Read a script's stored source code by its exact name.",
    inputSchema: objectSchema({ name: stringProp("Exact script name.", 240) }, ["name"]),
  },
  {
    name: "realot_set_script",
    description: "Create or replace a Realot script's source and synchronize the open Monaco model and attached Script components. This changes code and is not part of scene Ctrl+Z history; inspect the script afterward or use the editor's own code undo/history as appropriate.",
    inputSchema: objectSchema({
      name: stringProp("Script name.", 240),
      source: { type: "string", description: "Complete JavaScript source for the script. Maximum 250,000 characters." },
    }, ["name", "source"]),
  },
  {
    name: "realot_validate_script",
    description: "Parse-check script source without executing it. Supply source directly, or supply name to validate an existing stored script. This checks syntax only, not runtime behavior or engine API correctness.",
    inputSchema: objectSchema({
      name: stringProp("Optional exact stored script name.", 240),
      source: { type: "string", description: "Optional source text to parse-check. Takes precedence over name." },
    }),
  },
  {
    name: "realot_create_scene",
    description: "Create a new scene and switch to it. This modifies the project and changes the editor's active scene.",
    inputSchema: objectSchema({ name: stringProp("New scene name.", 160) }),
  },
  {
    name: "realot_switch_scene",
    description: "Switch the editor to an existing scene by scene id.",
    inputSchema: objectSchema({ scene_id: stringProp("Scene id from realot_list_scenes.") }, ["scene_id"]),
  },
  {
    name: "realot_rename_scene",
    description: "Rename a scene by id. This changes the project.",
    inputSchema: objectSchema({ scene_id: stringProp("Scene id."), name: stringProp("New scene name.", 160) }, ["scene_id", "name"]),
  },
  {
    name: "realot_delete_scene",
    description: "Delete a scene by id. The last remaining scene cannot be deleted. This operation changes the project and may not be covered by scene Ctrl+Z; save a project backup before large changes.",
    inputSchema: objectSchema({ scene_id: stringProp("Scene id to delete.") }, ["scene_id"]),
  },
  {
    name: "realot_validate_scene",
    description: "Run Realot's existing scene validation function and return its result, without changing the project.",
    inputSchema: objectSchema({}),
  },
  {
    name: "realot_set_play_mode",
    description: "Start or stop the current Realot Play window. This starts the project's existing game runtime but does not run code outside that game.",
    inputSchema: objectSchema({ playing: { type: "boolean", description: "true to start Play mode; false to stop it." } }, ["playing"]),
  },
  {
    name: "realot_get_console",
    description: "Read the most recent editor console entries from the currently open Realot project. Read-only.",
    inputSchema: objectSchema({}),
  },
  {
    name: "realot_save_project",
    description: "Ask Realot to flush the active scene and run the existing launcher autosave. For standalone editor sessions with no launcher autosave target, reports that a manual File > Save Project ZIP is still required; it never claims an unsaved project was persisted.",
    inputSchema: objectSchema({}),
  },
];

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
function stringProp(description, maxLength = 1000) {
  return { type: "string", description, maxLength };
}
function numberProp(description) {
  return { type: "number", description };
}

const TOOL_TO_EDITOR_METHOD = Object.freeze({
  realot_get_status: "get_status",
  realot_list_scenes: "list_scenes",
  realot_list_entities: "list_entities",
  realot_get_entity: "get_entity",
  realot_create_entity: "create_entity",
  realot_update_entity: "update_entity",
  realot_delete_entity: "delete_entity",
  realot_add_component: "add_component",
  realot_update_component: "update_component",
  realot_remove_component: "remove_component",
  realot_list_scripts: "list_scripts",
  realot_get_script: "get_script",
  realot_set_script: "set_script",
  realot_validate_script: "validate_script",
  realot_create_scene: "create_scene",
  realot_switch_scene: "switch_scene",
  realot_rename_scene: "rename_scene",
  realot_delete_scene: "delete_scene",
  realot_validate_scene: "validate_scene",
  realot_set_play_mode: "set_play_mode",
  realot_get_console: "get_console",
  realot_save_project: "save_project",
});

let config;
let currentClient = null;
let browserStatus = null;
let bridgeServer = null;
const pendingCalls = new Map();
let stdinBuffer = "";

function log(message) {
  process.stderr.write(`[Realot MCP] ${message}\n`);
}

function loadConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (typeof parsed.token === "string" && /^[a-f0-9]{64}$/i.test(parsed.token)) {
      if (!Array.isArray(parsed.allowedOrigins)) parsed.allowedOrigins = defaultAllowedOrigins();
      return parsed;
    }
  } catch (_) { /* create a clean local config on first launch or after corrupt contents */ }
  const fresh = { token: crypto.randomBytes(32).toString("hex"), allowedOrigins: defaultAllowedOrigins() };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(fresh, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_) { /* Windows ACLs handle file permissions */ }
  return fresh;
}

function defaultAllowedOrigins() {
  return [
    "http://localhost:*",
    "http://127.0.0.1:*",
    "https://realot.studio",
    "https://www.realot.studio",
    "https://*.realot.studio",
    "https://*.pages.dev",
    "https://*.replit.app",
    "https://*.replit.dev",
  ];
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function originIsAllowed(origin) {
  if (!origin || origin === "null") return false;
  let url;
  try { url = new URL(origin); } catch (_) { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  const port = url.port;
  const rules = (process.env.REALOT_ALLOWED_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const candidates = rules.length ? rules : (config.allowedOrigins || defaultAllowedOrigins());
  for (const rawRule of candidates) {
    const rule = String(rawRule).trim();
    if (!rule) continue;
    let match;
    try { match = /^([a-z]+):\/\/(.+)$/i.exec(rule); } catch (_) { match = null; }
    if (!match || `${match[1].toLowerCase()}:` !== url.protocol) continue;
    let hostRule = match[2].split("/")[0].toLowerCase();
    let anyPort = hostRule.endsWith(":*");
    if (anyPort) hostRule = hostRule.slice(0, -2);
    // Explicit ports in rules are compared to URL.port; omitted ports use the scheme default.
    let expectedPort = null;
    if (!anyPort) {
      const lastColon = hostRule.lastIndexOf(":");
      if (lastColon > hostRule.lastIndexOf("]") && lastColon >= 0) {
        expectedPort = hostRule.slice(lastColon + 1);
        hostRule = hostRule.slice(0, lastColon);
      }
    }
    let hostnameMatches = false;
    if (hostRule.startsWith("*.")) {
      const suffix = hostRule.slice(2);
      hostnameMatches = host !== suffix && host.endsWith(`.${suffix}`);
    } else hostnameMatches = host === hostRule;
    if (!hostnameMatches) continue;
    if (anyPort) return true;
    if (expectedPort !== null) {
      if (port === expectedPort) return true;
    } else {
      const defaultPort = url.protocol === "https:" ? "443" : "80";
      if (!port || port === defaultPort) return true;
    }
  }
  return false;
}

function sendFrame(socket, data, opcode = 0x1) {
  if (!socket || socket.destroyed) return;
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  socket.write(Buffer.concat([header, body]));
}

function closeWs(socket, code = 1000, reason = "") {
  try {
    const reasonBytes = Buffer.from(reason).subarray(0, 100);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    sendFrame(socket, payload, 0x8);
  } catch (_) { /* close can race socket teardown */ }
  socket.end();
}

function rejectUpgrade(socket, status, message) {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
    socket.destroy();
  }
}

function attachWebSocketParser(socket) {
  socket._realotBuffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    socket._realotBuffer = Buffer.concat([socket._realotBuffer, chunk]);
    if (socket._realotBuffer.length > MAX_WS_BYTES + 14) {
      closeWs(socket, 1009, "Message too large");
      return;
    }
    while (socket._realotBuffer.length >= 2) {
      const buffer = socket._realotBuffer;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (!fin) { closeWs(socket, 1003, "Fragmented frames are not supported"); return; }
      if (!masked) { closeWs(socket, 1002, "Client frames must be masked"); return; }
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const bigLength = buffer.readBigUInt64BE(2);
        if (bigLength > BigInt(MAX_WS_BYTES)) { closeWs(socket, 1009, "Message too large"); return; }
        length = Number(bigLength);
        offset = 10;
      }
      if (length > MAX_WS_BYTES) { closeWs(socket, 1009, "Message too large"); return; }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      socket._realotBuffer = buffer.subarray(offset + length);
      if (opcode === 0x8) { closeWs(socket); return; }
      if (opcode === 0x9) { sendFrame(socket, payload, 0xA); continue; }
      if (opcode === 0xA) continue;
      if (opcode !== 0x1) { closeWs(socket, 1003, "Text JSON messages only"); return; }
      try { handleBrowserMessage(JSON.parse(payload.toString("utf8")), socket); }
      catch (error) { log(`Ignored invalid browser message: ${error.message}`); }
    }
  });
}

function handleBrowserMessage(message, socket) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  if (message.type === "status") {
    if (socket !== currentClient) return;
    browserStatus = message.result && typeof message.result === "object" ? message.result : null;
    return;
  }
  if (message.type === "response" && typeof message.id === "string") {
    const pending = pendingCalls.get(message.id);
    if (!pending || pending.socket !== socket) return;
    pendingCalls.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(new Error(String(message.error || "The editor rejected the request.").slice(0, 3000)));
  }
}

function startLoopbackServer() {
  bridgeServer = http.createServer((req, res) => {
    res.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
    res.end("Realot MCP bridge: use the WebSocket endpoint from the Realot editor.");
  });
  bridgeServer.on("upgrade", (req, socket, head) => {
    let url;
    try { url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`); }
    catch (_) { rejectUpgrade(socket, "400 Bad Request", "Invalid URL"); return; }
    if (url.pathname !== "/realot-mcp") { rejectUpgrade(socket, "404 Not Found", "Not found"); return; }
    if (!originIsAllowed(req.headers.origin)) { rejectUpgrade(socket, "403 Forbidden", "Origin is not allowed. Update allowedOrigins in the local Realot MCP config."); return; }
    if (!safeEqual(url.searchParams.get("token"), config.token)) { rejectUpgrade(socket, "401 Unauthorized", "Invalid local pairing token"); return; }
    const key = req.headers["sec-websocket-key"];
    const upgrade = String(req.headers.upgrade || "").toLowerCase();
    if (!key || upgrade !== "websocket") { rejectUpgrade(socket, "400 Bad Request", "Invalid WebSocket handshake"); return; }
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));
    if (currentClient && currentClient !== socket) closeWs(currentClient, 4001, "A newer Realot editor paired");
    currentClient = socket;
    browserStatus = null;
    attachWebSocketParser(socket);
    if (head && head.length) socket.emit("data", head);
    log(`Realot editor paired from ${req.headers.origin}.`);
    socket.on("close", () => disconnectBrowserSocket(socket));
    socket.on("end", () => disconnectBrowserSocket(socket));
    socket.on("error", () => disconnectBrowserSocket(socket));
  });
  bridgeServer.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") log(`Port ${PORT} is already in use. Close the other Realot MCP process or set REALOT_MCP_PORT to a free localhost port and update EditorBridge.js to match.`);
    else log(`Local WebSocket bridge failed: ${error.message}`);
  });
  bridgeServer.listen(PORT, "127.0.0.1", () => log(`Local editor bridge listening on 127.0.0.1:${PORT}.`));
}

function disconnectBrowserSocket(socket) {
  if (currentClient !== socket) return;
  currentClient = null;
  browserStatus = null;
  for (const [id, pending] of pendingCalls.entries()) {
    if (pending.socket === socket) {
      clearTimeout(pending.timer);
      pendingCalls.delete(id);
      pending.reject(new Error("The Realot editor disconnected."));
    }
  }
  log("Realot editor disconnected.");
}

function requestEditor(method, params = {}) {
  const socket = currentClient;
  if (!socket || socket.destroyed) {
    return Promise.reject(new Error("No Realot editor is paired. Open the editor, click AI Bridge, and pair it with the local token."));
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`Realot editor timed out while handling '${method}'. Ensure the editor tab is open and responsive, then retry.`));
    }, REQUEST_TIMEOUT_MS);
    pendingCalls.set(id, { resolve, reject, timer, socket });
    try { sendFrame(socket, JSON.stringify({ type: "request", id, method, params })); }
    catch (error) {
      clearTimeout(timer);
      pendingCalls.delete(id);
      reject(new Error(`Could not contact Realot editor: ${error.message}`));
    }
  });
}

function sendRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id, code, message) {
  sendRpc({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function toolTextResult(value, isError = false) {
  let text;
  try { text = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
  catch (_) { text = String(value); }
  return { content: [{ type: "text", text }], isError };
}

async function handleRpc(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = hasId ? message.id : undefined;
  const method = message.method;
  if (typeof method !== "string") {
    if (hasId) rpcError(id, -32600, "Invalid JSON-RPC request: method is required.");
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled" || method === "notifications/progress") return;
  if (method === "initialize") {
    const requested = message.params && message.params.protocolVersion;
    sendRpc({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: requested === MCP_PROTOCOL_VERSION ? requested : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "realot-studio-mcp", version: VERSION },
        instructions: "Connect the open Realot Studio editor using its AI Bridge panel. The tools act only on the paired browser editor on this computer; they do not upload project contents to a remote service. Read project state before making changes. Scene-object edits are undoable in Realot; script source and scene-list operations have separate persistence/history behavior."
      }
    });
    return;
  }
  if (method === "ping") {
    sendRpc({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    sendRpc({ jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } });
    return;
  }
  if (method === "tools/call") {
    const name = message.params && message.params.name;
    const args = message.params && message.params.arguments || {};
    if (name === "realot_bridge_status") {
      sendRpc({ jsonrpc: "2.0", id, result: toolTextResult({
        server: "realot-studio-mcp",
        version: VERSION,
        listening: !!(bridgeServer && bridgeServer.listening),
        host: "127.0.0.1",
        port: PORT,
        editorConnected: !!(currentClient && !currentClient.destroyed),
        editor: browserStatus,
        configPath: CONFIG_PATH,
      }) });
      return;
    }
    const editorMethod = TOOL_TO_EDITOR_METHOD[name];
    if (!editorMethod) {
      sendRpc({ jsonrpc: "2.0", id, result: toolTextResult(`Unknown tool '${String(name)}'.`, true) });
      return;
    }
    try {
      const result = await requestEditor(editorMethod, args);
      sendRpc({ jsonrpc: "2.0", id, result: toolTextResult(result) });
    } catch (error) {
      sendRpc({ jsonrpc: "2.0", id, result: toolTextResult(String(error && error.message || error), true) });
    }
    return;
  }
  if (hasId) rpcError(id, -32601, `Method not found: ${method}`);
}

function begin() {
  config = loadConfig();
  startLoopbackServer();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, "utf8") > 4 * 1024 * 1024) {
      log("Ignored oversized MCP input line.");
      return;
    }
    let message;
    try { message = JSON.parse(line); }
    catch (_) { rpcError(null, -32700, "Parse error"); return; }
    void handleRpc(message).catch((error) => {
      if (message && Object.prototype.hasOwnProperty.call(message, "id")) rpcError(message.id, -32603, String(error && error.message || error));
      else log(`Request handling failed: ${error.message}`);
    });
  });
  rl.on("close", () => {
    for (const pending of pendingCalls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP client disconnected."));
    }
    pendingCalls.clear();
    if (currentClient) closeWs(currentClient, 1001, "MCP process stopped");
    if (bridgeServer) bridgeServer.close();
    process.exit(0);
  });
}

if (process.argv.includes("--show-token")) {
  config = loadConfig();
  process.stdout.write(`${config.token}\n`);
} else if (process.argv.includes("--show-config")) {
  config = loadConfig();
  process.stdout.write(`${CONFIG_PATH}\n`);
} else {
  begin();
}
