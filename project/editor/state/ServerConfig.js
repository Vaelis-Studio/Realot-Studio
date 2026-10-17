// Android APK export: where the build requests go, and how the user
// tells the editor which server to use.
//
// This editor is deployed as static files (e.g. on Cloudflare Pages), which cannot
// run the Android/Gradle build itself. The actual build happens on a
// separate server that turns the uploaded project zip into an APK.
//
// EACH USER RUNS/OWNS THEIR OWN BUILD SERVER (or points at whichever one
// they've been given access to) rather than everyone sharing one baked
// into this file. That avoids one shared server/API key being hardcoded
// into the shipped editor bundle (visible to anyone via devtools) and
// having to absorb every user's build load on one host.
//
// NOTHING is hardcoded here: no server URL and no API key ship with the
// editor. The Export popup's Android card only ever uses the server URL
// and API key the user typed in themselves (saved in this browser's
// localStorage). A user can save more than one such pair (e.g. a personal
// server and a team one) and switch between them — see the
// credential-list functions below.

// The server URL is used exactly as the user typed it: nothing is added to
// it (no https://, no extra path). Only surrounding spaces and trailing
// slashes are dropped so the fixed API paths the editor appends itself
// (e.g. /api/v1/build) don't end up with a double slash.
/** The Realot APK service: where users get an API key (or upload an HTML5 export). */
export const APK_SERVICE_URL = "https://apk-builder--realot-server.replit.app/";

export function normalizeServerUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

import { setAndroidBuildTicket, markAndroidJobFinished, resolveAgainstServer } from "./AndroidBuildSession.js";

const STORAGE_KEY = "realot.androidBuildServers";

// Shape of a saved credential entry:
//   { id: string, label: string, serverUrl: string, apiKey: string }
// `id` is a stable identifier (not shown to the user) so the "active"
// pointer survives a rename of `label`.

function _loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { servers: [], activeId: null };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.servers)) return { servers: [], activeId: null };
    return { servers: parsed.servers, activeId: parsed.activeId || null };
  } catch (_) {
    // Corrupt localStorage (manual edit, old format, etc.) — don't crash
    // the editor over it, just treat it as empty.
    return { servers: [], activeId: null };
  }
}

function _saveAll(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (_) {
    // Storage full/disabled — the in-memory state (held by the caller,
    // e.g. editorState) still works for this session, it just won't
    // persist across reloads. Nothing to do about that here.
  }
}

export function listAndroidServers() {
  return _loadAll().servers;
}

export function getActiveAndroidServer() {
  const { servers, activeId } = _loadAll();
  if (servers.length === 0) return null;
  return servers.find((s) => s.id === activeId) || servers[0];
}

export function setActiveAndroidServer(id) {
  const data = _loadAll();
  if (!data.servers.some((s) => s.id === id)) return;
  data.activeId = id;
  _saveAll(data);
}

// Adds a new saved server, or updates one in place if editingId matches
// an existing entry (used by the Export popup's "add/edit server" form).
// Returns the entry's id.
export function saveAndroidServer({ label, serverUrl, apiKey }, editingId = null) {
  const data = _loadAll();
  const cleanUrl = normalizeServerUrl(serverUrl);
  const cleanKey = String(apiKey || "").trim();
  const cleanLabel = String(label || "").trim() || cleanUrl.replace(/^https?:\/\//, "");

  if (editingId) {
    const existing = data.servers.find((s) => s.id === editingId);
    if (existing) {
      existing.label = cleanLabel;
      existing.serverUrl = cleanUrl;
      existing.apiKey = cleanKey;
      _saveAll(data);
      return existing.id;
    }
  }

  const id = "srv_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  data.servers.push({ id, label: cleanLabel, serverUrl: cleanUrl, apiKey: cleanKey });
  if (!data.activeId) data.activeId = id; // first one added becomes active automatically
  _saveAll(data);
  return id;
}

export function deleteAndroidServer(id) {
  const data = _loadAll();
  data.servers = data.servers.filter((s) => s.id !== id);
  if (data.activeId === id) {
    data.activeId = data.servers.length > 0 ? data.servers[0].id : null;
  }
  _saveAll(data);
}

// Build service route. Sends the game title as a query param and the
// zip as the raw POST body (Content-Type: application/zip).
export function androidExportEndpoint(gameTitle, server) {
  const base = normalizeServerUrl(server.serverUrl);
  return base + "/api/v1/build?name=" + encodeURIComponent(gameTitle);
}

/**
 * Upload an already-built standalone web export to the same Android build
 * service used by the APK card. This intentionally accepts the finished
 * HTML/PWA archive rather than asking the server to reconstruct the project
 * from editor-only data. That makes the web export the single source of
 * truth for the APK contents.
 */
export async function uploadWebExportForAndroid(blob, gameTitle, format, server, signal) {
  if (!server || !server.serverUrl) throw new Error("No Android build server configured.");
  const cleanFormat = format === "pwa" ? "pwa" : "html";
  const response = await fetch(androidExportEndpoint(gameTitle, server), {
    method: "POST",
    headers: androidExportHeaders(server, {
      // Only headers the build server's CORS allow-list accepts
      // (Content-Type, X-Api-Key, ...). Extra custom headers make the
      // browser's preflight fail and block the upload. The server detects
      // a standalone export from the ZIP contents, so none are needed.
      "Content-Type": "application/zip",
    }),
    body: blob,
    signal,
  });
  if (!response.ok) {
    let message = "Android export server rejected the web export (" + response.status + ").";
    try {
      const data = await response.json();
      if (data && data.error) message = data.error;
    } catch (_) {}
    throw new Error(message);
  }
  return response.json();
}

// Tell the build server we have the complete APK so it can delete its copy
// right away (it otherwise keeps it for the retention window, ~30 min).
// Best-effort: failure is harmless, the server's own timer still cleans up.
export function confirmAndroidDelivery(downloadUrl, server) {
  try {
    if (!downloadUrl || !server) return;
    const confirmUrl = String(downloadUrl).replace(/\/download(\?.*)?$/, "/confirm-delivery");
    if (confirmUrl === downloadUrl) return; // not a URL shape we recognise
    fetch(confirmUrl, { method: "POST", headers: androidExportHeaders(server) }).catch(() => {});
  } catch (_) {}
}

export function androidExportHeaders(server, extra = {}) {
  const headers = { ...extra };
  if (server && server.apiKey) {
    headers["X-Api-Key"] = server.apiKey;
  }
  return headers;
}

// The build server is ASYNC: POST /api/v1/build doesn't return the APK.
// It returns a small JSON job ticket right away, e.g.
//   { "job": { "id", "status": "queued", "progress", "message",
//              "error", "downloadUrl" }, "statusUrl", "downloadUrl" }
// The real APK only exists once the job's status reaches "completed", at
// job.downloadUrl (or the top-level downloadUrl — same URL). This polls
// statusUrl until the job finishes, then returns that URL.
//
// The Realot APK build server (see its src/routes/builds.ts /
// src/lib/apk-builder.ts) uses exactly this closed set of job statuses —
// confirmed directly from its source, not guessed: "queued" and
// "building" are in-progress, "completed" and "failed" are terminal.
const ANDROID_BUILD_DONE_STATUSES = new Set(["completed"]);
const ANDROID_BUILD_FAILED_STATUSES = new Set(["failed"]);
// Set by the server when a job was cancelled (by us via DELETE, or by its
// own safety nets: per-job timeout / client-went-away detection).
const ANDROID_BUILD_CANCELLED_STATUSES = new Set(["cancelled", "canceled"]);

export async function pollAndroidBuildJob(jobTicket, server, { onProgress, intervalMs = 2500, timeoutMs = 10 * 60 * 1000, signal } = {}) {
  // Remember where to send a cancel request if this build gets cancelled.
  setAndroidBuildTicket(jobTicket);

  // The server may hand back RELATIVE urls ("/api/v1/build/<id>"). Fetching
  // those as-is would hit the editor's own site instead of the build server,
  // so always resolve them against the saved server URL.
  const rawStatusUrl = jobTicket && (jobTicket.statusUrl || (jobTicket.job && jobTicket.job.statusUrl));
  const statusUrl = rawStatusUrl ? resolveAgainstServer(rawStatusUrl, server.serverUrl) : null;
  const abs = (u) => (u ? resolveAgainstServer(u, server.serverUrl) : u);
  if (!statusUrl) {
    // Server didn't give us anything to poll — assume it meant to hand
    // back the APK directly (shouldn't happen given what we've seen, but
    // don't hang forever if it does).
    markAndroidJobFinished();
    return abs(jobTicket && (jobTicket.downloadUrl || (jobTicket.job && jobTicket.job.downloadUrl)));
  }

  const startedAt = Date.now();
  while (true) {
    if (signal && signal.aborted) throw new DOMException("Build cancelled.", "AbortError");
    if (Date.now() - startedAt > timeoutMs) {
      // The caller cancels the server-side job when this throws, so a
      // timed-out build can't keep blocking the queue.
      throw new Error("Android build timed out waiting for the server.");
    }

    // Every status request doubles as a "the editor is still here"
    // heartbeat — a server that stops seeing them can drop the job.
    const res = await fetch(statusUrl, { headers: androidExportHeaders(server), signal });
    if (!res.ok) {
      throw new Error("Lost track of the Android build job (" + res.status + ").");
    }
    const data = await res.json();
    const job = data.job || data;
    const status = String(job.status || "").toLowerCase();

    if (onProgress) {
      onProgress(job.message || ("Building\u2026 (" + status + (job.progress != null ? ", " + job.progress + "%" : "") + ")"));
    }

    if (ANDROID_BUILD_DONE_STATUSES.has(status)) {
      markAndroidJobFinished();
      return abs(job.downloadUrl || data.downloadUrl);
    }
    if (ANDROID_BUILD_FAILED_STATUSES.has(status)) {
      markAndroidJobFinished();
      throw new Error(job.error || "Android build failed on the server.");
    }
    if (ANDROID_BUILD_CANCELLED_STATUSES.has(status)) {
      markAndroidJobFinished();
      throw new Error(job.error || "The Android build was cancelled on the server.");
    }

    await _abortableSleep(intervalMs, signal);
  }
}

// setTimeout that wakes up immediately (and rejects) when the build is
// cancelled, so Cancel takes effect right away instead of after the
// next poll interval.
function _abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new DOMException("Build cancelled.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Build cancelled.", "AbortError"));
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Lightweight "is the build server awake?" check, used to show a status
// badge next to the selected server in the Export popup.
//
// Asks the server's own /api/healthz endpoint (tiny JSON, CORS-enabled)
// instead of the site root, with caching disabled so a stale answer is
// never reused. Free-tier hosts (Replit, Render, ...) can take well over
// 6s to cold-start, so the timeout is generous; the caller
// (EditorEvents.js refreshAndroidServerStatus) keeps re-checking until the
// server answers, so a slow wake-up no longer leaves the badge stuck on
// "asleep".
//
// Any failure (timeout, connection refused, DNS, an interstitial "waking
// up" page from the host without CORS headers) counts as NOT reachable.
export async function checkAndroidServerAwake(server, timeoutMs = 12000) {
  if (!server || !server.serverUrl) return false;
  // Tolerate a pasted URL that already ends in /api or /api/v1.
  const base = normalizeServerUrl(server.serverUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + "/api/healthz", {
      method: "GET",
      signal: controller.signal,
      mode: "cors",
      cache: "no-store",
    });
    return res.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
