/**
 * relay/mcp-core.js — the MCP (Model Context Protocol) side of the Realot
 * bridge, with NO runtime-specific APIs so the exact same code runs in the
 * Cloudflare Worker and in the local Node relay.
 *
 * Transport: MCP "Streamable HTTP", stateless — every JSON-RPC request is a
 * POST and gets a JSON answer. Tool calls are forwarded to the user's open
 * editor tab through `callEditor(tool, args)`.
 */
import TOOLS from "./tools.json" with { type: "json" };

export const SERVER_INFO = { name: "realot-bridge", version: "1.0.0" };
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * @param {any} msg one JSON-RPC message
 * @param {{ callEditor:(tool:string,args:object)=>Promise<{content?:any[],isError?:boolean,text?:string}>, isEditorConnected?:()=>Promise<boolean>|boolean }} env
 * @returns {Promise<object|null>} response, or null for notifications
 */
export async function handleMcpMessage(msg, env) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return fail(msg && msg.id !== undefined ? msg.id : null, -32600, "Invalid Request");
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const asked = params && params.protocolVersion;
      return ok(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Controls a live Realot 2D game-engine editor. Start with get_editor_state, then inspect entities and list_assets, list_animations, list_tilesets, list_tilemaps, list_navigation_worlds, list_physics_layers, list_scenes, list_tags, or list_prefabs as needed. " +
          "For file imports, call begin_asset_upload, send sequential base64 chunks using the returned chunk_size_bytes with append_asset_upload_chunk, then call complete_asset_upload. Use animation-zip for image ZIPs, animation-gif for GIF clips, animation-sheet for sprite sheets, and tileset-sheet or tileset-tile for custom tiles. " +
          "Animation and map edits are undoable where supported (undo). The user must have the editor open with the Claude bridge connected; read-only mode blocks project changes.",
      });
    }
    case "ping":
      return isNotification ? null : ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, "Unknown tool: " + name);
      try {
        const res = await env.callEditor(name, args);
        const content = Array.isArray(res.content) ? res.content : [{ type: "text", text: String(res.text ?? "") }];
        return ok(id, { content, isError: !!res.isError });
      } catch (err) {
        return ok(id, {
          content: [{ type: "text", text: String((err && err.message) || err) }],
          isError: true,
        });
      }
    }
    default:
      if (method.startsWith("notifications/")) return null;
      if (isNotification) return null;
      return fail(id, -32601, "Method not found: " + method);
  }
}

/** Handles a POST body that may be one message or a batch. Returns {status, body}. */
export async function handleMcpBody(raw, env) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { status: 400, body: fail(null, -32700, "Parse error") }; }
  if (Array.isArray(parsed)) {
    const out = (await Promise.all(parsed.map((m) => handleMcpMessage(m, env)))).filter(Boolean);
    return out.length ? { status: 200, body: out } : { status: 202, body: null };
  }
  const res = await handleMcpMessage(parsed, env);
  return res ? { status: 200, body: res } : { status: 202, body: null };
}

export const KEY_PATTERN = /^[a-f0-9]{64}$/;
export const NOT_CONNECTED_MESSAGE =
  "The Realot editor is not connected. Open the editor, click the Claude button in the toolbar and press Connect, then try again.";
