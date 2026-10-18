// Local / self-hosted version of the relay (same MCP core as the Cloudflare Worker).
//   cd relay && npm install && npm run local     (listens on http://localhost:8787)
import http from "node:http";
import { WebSocketServer } from "ws";
import { handleMcpBody, KEY_PATTERN, NOT_CONNECTED_MESSAGE } from "./mcp-core.js";

const PORT = Number(process.env.PORT || 8787);
const CALL_TIMEOUT_MS = 25_000;
const MAX_CALLS_PER_MINUTE = 90;
const ALLOWED = String(process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const rooms = new Map(); // key -> { socket, pending:Map, nextId }
const room = (key) => { if (!rooms.has(key)) rooms.set(key, { socket: null, pending: new Map(), nextId: 1 }); return rooms.get(key); };

function callEditor(key, tool, args) {
  const r = room(key);
  if (!r.socket || r.socket.readyState !== 1) return Promise.resolve({ isError: true, text: NOT_CONNECTED_MESSAGE });
  const now = Date.now();
  r.recent = (r.recent || []).filter((t) => now - t < 60_000);
  if (r.recent.length >= MAX_CALLS_PER_MINUTE) return Promise.resolve({ isError: true, text: "Too many tool calls in the last minute. Wait a moment." });
  r.recent.push(now);
  const id = r.nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { r.pending.delete(id); resolve({ isError: true, text: "The editor did not answer in time." }); }, CALL_TIMEOUT_MS);
    r.pending.set(id, { resolve, timer });
    r.socket.send(JSON.stringify({ type: "call", id, tool, args }));
  });
}

const server = http.createServer(async (req, res) => {
  const parts = new URL(req.url, "http://x").pathname.split("/").filter(Boolean);
  if (parts.length === 0) { res.end("Realot bridge relay (local) is running.\n"); return; }
  const [kind, key] = parts;
  if (kind !== "mcp" || !KEY_PATTERN.test(key || "")) { res.statusCode = 404; res.end("Not found"); return; }
  if (req.method === "GET") { res.statusCode = 405; res.setHeader("Allow", "POST"); res.end("POST only"); return; }
  if (req.method === "DELETE") { res.end(); return; }
  if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
  let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 256 * 1024) { res.statusCode = 413; res.end("Request too large"); return; } }
  const out = await handleMcpBody(raw, { callEditor: (tool, args) => callEditor(key, tool, args) });
  res.statusCode = out.status;
  if (out.body !== null) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(out.body)); } else res.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const parts = new URL(req.url, "http://x").pathname.split("/").filter(Boolean);
  if (parts[0] !== "bridge" || !KEY_PATTERN.test(parts[1] || "")) { socket.destroy(); return; }
  if (ALLOWED.length && !ALLOWED.includes(req.headers.origin || "")) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const r = room(parts[1]);
    if (r.socket) try { r.socket.close(1000, "replaced"); } catch {}
    r.socket = ws;
    ws.on("message", (data) => {
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type === "ping") { ws.send('{"type":"pong"}'); return; }
      if (msg.type !== "result") return;
      const p = r.pending.get(msg.id); if (!p) return;
      clearTimeout(p.timer); r.pending.delete(msg.id);
      p.resolve({ content: msg.content, isError: !!msg.isError, text: msg.text });
    });
    ws.on("close", () => { if (r.socket === ws) r.socket = null; for (const [id, p] of r.pending) { clearTimeout(p.timer); p.resolve({ isError: true, text: NOT_CONNECTED_MESSAGE }); r.pending.delete(id); } });
  });
});
server.listen(PORT, () => console.log("Realot relay listening on http://localhost:" + PORT));
