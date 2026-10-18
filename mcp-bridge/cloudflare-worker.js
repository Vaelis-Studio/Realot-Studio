/**
 * Realot Studio hosted MCP relay for Cloudflare Workers + Durable Objects.
 * The cloud service stores only a session token hash and transient routing state;
 * scene/script data is requested from the editor while it is open.
 */
import { DurableObject } from "cloudflare:workers";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 20_000;
const UUID_RE = /^[a-f0-9-]{36}$/i;
const TOKEN_RE = /^[a-f0-9]{64}$/i;

function objectSchema(properties, required = []) { return { type: "object", properties, required, additionalProperties: false }; }
function stringProp(description, maxLength = 1000) { return { type: "string", description, maxLength }; }
function numberProp(description) { return { type: "number", description }; }
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

const TOOL_MAP = new Map(TOOL_DEFS.map((tool) => [tool.name, tool]));
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Cache-Control": "no-store",
};
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", ...extra } });
}
function error(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message: String(message).slice(0, 3000) } }; }
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let result = 0; for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
function readBearer(request) {
  const value = request.headers.get("Authorization") || "";
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(value);
  return match ? match[1] : null;
}
function sessionIdFromUrl(url) {
  const match = /^\/mcp\/([a-f0-9-]{36})$/i.exec(url.pathname);
  return match ? match[1] : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (url.pathname === "/health") return json({ service: "realot-mcp-relay", status: "ok", version: "1.0.0" });
    if (url.pathname.startsWith("/session/") && request.method === "POST") {
      const session = /^\/session\/([a-f0-9-]{36})$/i.exec(url.pathname)?.[1];
      const token = readBearer(request);
      if (!UUID_RE.test(session || "") || !token) return json({ error: "Invalid session id or missing bearer token." }, 400);
      const id = env.REALOT_SESSIONS.idFromName(session);
      return env.REALOT_SESSIONS.get(id).fetch("https://session/initialize", { method: "POST", headers: { "Content-Type": "application/json", "X-Realot-Token": token } });
    }
    if (url.pathname === "/editor" && request.method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocket upgrade required." }, 426);
      const session = url.searchParams.get("session");
      if (!UUID_RE.test(session || "")) return json({ error: "Invalid session id." }, 400);
      const id = env.REALOT_SESSIONS.idFromName(session);
      return env.REALOT_SESSIONS.get(id).fetch(request);
    }
    if (url.pathname.startsWith("/mcp/") && request.method === "POST") {
      const session = sessionIdFromUrl(url);
      const token = readBearer(request);
      if (!session || !token) return json(error(null, -32001, "Invalid session URL or missing bearer token."), 401);
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return json(error(null, -32600, "Request body is too large."), 413);
      let message;
      try { message = JSON.parse(raw); } catch { return json(error(null, -32700, "Invalid JSON."), 400); }
      const id = env.REALOT_SESSIONS.idFromName(session);
      const response = await env.REALOT_SESSIONS.get(id).fetch("https://session/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Realot-Token": token },
        body: JSON.stringify(message),
      });
      return new Response(await response.text(), { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
    }
    if (url.pathname.startsWith("/mcp/") && request.method === "GET") {
      return json({ error: "This endpoint uses MCP Streamable HTTP POST requests." }, 405, { Allow: "POST, OPTIONS" });
    }
    return json({ error: "Not found." }, 404);
  },
};

export class RealotSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
    this.editorSocket = this.ctx.getWebSockets("realot-editor")[0] || null;
    this.lastStatus = null;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/editor") return this.attachEditor(request);
    if (url.pathname === "/initialize" && request.method === "POST") return this.initializeSession(request);
    if (url.pathname === "/rpc" && request.method === "POST") return this.handleRpc(request);
    return json({ error: "Not found." }, 404);
  }
  async initializeSession(request) {
    const token = request.headers.get("X-Realot-Token") || "";
    if (!TOKEN_RE.test(token)) return json({ error: "Invalid pairing token." }, 400);
    const tokenHash = await sha256(token);
    const savedHash = await this.ctx.storage.get("tokenHash");
    if (savedHash && !equal(savedHash, tokenHash)) return json({ error: "This session belongs to another token. Create a new session in Realot." }, 403);
    await this.ctx.storage.put({ tokenHash, sessionCreatedAt: await this.ctx.storage.get("sessionCreatedAt") || Date.now() });
    return json({ initialized: true });
  }
  async attachEditor(request) {
    if (this.editorSocket && this.editorSocket.readyState === WebSocket.OPEN) {
      return json({ error: "An editor is already connected to this session. Disconnect it before reconnecting." }, 409);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["realot-editor"]);
    this.editorSocket = server;
    server.serializeAttachment({ authenticated: false });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    let attachment = ws.deserializeAttachment() || {};
    let data;
    try { data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); } catch { return; }
    if (!data || typeof data !== "object") return;
    if (!attachment.authenticated) {
      const token = data.type === "auth" && typeof data.token === "string" ? data.token : "";
      const savedHash = await this.ctx.storage.get("tokenHash");
      if (!TOKEN_RE.test(token) || !savedHash || !equal(await sha256(token), savedHash)) {
        try { ws.send(JSON.stringify({ type: "auth_result", ok: false, error: "Invalid session token. Create a fresh AI Bridge session." })); } catch (_) {}
        ws.close(1008, "Unauthorized");
        return;
      }
      attachment.authenticated = true;
      ws.serializeAttachment(attachment);
      this.editorSocket = ws;
      await this.ctx.storage.put("editorActive", true);
      try { ws.send(JSON.stringify({ type: "auth_result", ok: true })); } catch (_) {}
      return;
    }
    if (ws !== this.editorSocket) return;
    if (data.type === "status") { this.lastStatus = data.result || null; return; }
    if (data.type === "response" && typeof data.id === "string") {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(data.id);
      if (data.ok === true) pending.resolve(data.result);
      else pending.reject(new Error(String(data.error || "The Realot editor rejected the request.").slice(0, 3000)));
    }
  }
  async webSocketClose(ws) {
    if (ws === this.editorSocket) {
      this.editorSocket = null;
      await this.ctx.storage.put("editorActive", false);
      for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error("The Realot editor disconnected.")); this.pending.delete(id); }
    }
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }
  async handleRpc(request) {
    const token = request.headers.get("X-Realot-Token") || "";
    const tokenHash = await this.ctx.storage.get("tokenHash");
    if (!TOKEN_RE.test(token) || !tokenHash || !equal(await sha256(token), tokenHash)) return json(error(null, -32001, "Unauthorized Realot session."), 401);
    if (!this.editorSocket || await this.ctx.storage.get("editorActive") !== true || !(this.editorSocket.deserializeAttachment() || {}).authenticated) return json(error(null, -32002, "The Realot project is not currently open or connected. Open the project and connect AI Bridge."), 409);
    let rpc;
    try { rpc = await request.json(); } catch { return json(error(null, -32700, "Invalid JSON."), 400); }
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return json(error(rpc?.id, -32600, "Invalid JSON-RPC request."), 400);
    if (rpc.method === "notifications/initialized" || rpc.method === "notifications/cancelled") return new Response(null, { status: 202, headers: corsHeaders });
    if (rpc.method === "initialize") return json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "realot-studio", version: "1.0.0" }, instructions: "This bridge can only access the Realot editor that is currently open and connected. Project changes are live; review tool calls before approving them." } });
    if (rpc.method === "ping") return json({ jsonrpc: "2.0", id: rpc.id, result: {} });
    if (rpc.method === "tools/list") return json({ jsonrpc: "2.0", id: rpc.id, result: { tools: TOOL_DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name;
      const args = rpc.params?.arguments || {};
      if (!TOOL_MAP.has(name)) return json(error(rpc.id, -32602, `Unknown tool '${String(name)}'.`));
      try {
        let result;
        if (name === "realot_bridge_status") result = { connected: !!this.editorSocket, editor: this.lastStatus };
        else {
          const method = TOOL_TO_EDITOR_METHOD[name];
          if (!method) throw new Error("Tool has no editor mapping.");
          result = await this.callEditor(method, args);
        }
        return json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false } });
      } catch (err) {
        return json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: String(err?.message || err) }], isError: true } });
      }
    }
    if (rpc.id === undefined) return new Response(null, { status: 202, headers: corsHeaders });
    return json(error(rpc.id, -32601, `Method not found: ${rpc.method}`));
  }
  callEditor(method, params) {
    if (!this.editorSocket) return Promise.reject(new Error("The Realot editor is disconnected."));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Editor timed out handling ${method}.`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this.editorSocket.send(JSON.stringify({ type: "request", id, method, params })); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
}
