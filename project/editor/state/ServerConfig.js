// Android APK export: where build requests go and how the editor keeps
// per-browser access to the build service.
//
// This editor is deployed as static files (e.g. on Cloudflare Pages), which cannot
// run the Android/Gradle build itself. The actual build happens on a
// separate server that turns the uploaded project zip into an APK.
//
// This editor distribution always uses the built-in APK service. Its
// permanent service key is never shipped to the browser; the service issues
// a separate short-lived bearer key that this client stores locally and
// renews before a later build. The key is not bound to an origin or account.
//
// The service URL is public configuration. The permanent API key is not.
// Short-lived user keys and custom-server credentials are stored only in
// this browser's localStorage.

// The server URL is used exactly as the user typed it: nothing is added to
// it (no https://, no extra path). Only surrounding spaces and trailing
// slashes are dropped so the fixed API paths the editor appends itself
// (e.g. /api/v1/build) don't end up with a double slash.
/** The Realot APK service used by the built-in Android export flow. */
export const APK_SERVICE_URL = "https://builder--Vaelis-Server.replit.app";
const BUILTIN_SERVER_ID = "vaelis-apk-builder";
const BUILTIN_SERVER_LABEL = "Vaelis APK Builder";

export function normalizeServerUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

import { setAndroidBuildTicket, markAndroidJobFinished, resolveAgainstServer } from "./AndroidBuildSession.js";

const STORAGE_KEY = "realot.androidBuildServers";

// The saved array format is retained for compatibility with older editor
// versions. This version reads only the built-in entry; older custom-server
// records are ignored and left untouched in localStorage.

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

export function getActiveAndroidServer() {
  const { servers } = _loadAll();
  const savedService = servers.find((server) => server.id === BUILTIN_SERVER_ID);
  if (!savedService) {
    return {
      id: BUILTIN_SERVER_ID,
      label: BUILTIN_SERVER_LABEL,
      serverUrl: APK_SERVICE_URL,
      apiKey: "",
      managedKey: true,
      keyExpiresAt: null,
    };
  }
  const savedUrlMatches = normalizeServerUrl(savedService.serverUrl) === APK_SERVICE_URL;
  return {
    ...savedService,
    id: BUILTIN_SERVER_ID,
    label: BUILTIN_SERVER_LABEL,
    serverUrl: APK_SERVICE_URL,
    apiKey: savedUrlMatches ? savedService.apiKey : "",
    managedKey: true,
    keyExpiresAt: savedUrlMatches ? savedService.keyExpiresAt : null,
  };
}

/**
 * Get or renew the short-lived key for a managed service entry. The
 * permanent service key is never sent to the editor; this request is
 * intentionally unauthenticated and returns a temporary bearer key.
 */
export async function ensureAndroidServerKey(server, signal) {
  if (!server || !server.serverUrl) throw new Error("No Android build server configured.");

  const managed = server.managedKey === true;
  const expiresAt = Date.parse(server.keyExpiresAt || "");
  const keyIsFresh = Number.isFinite(expiresAt) && expiresAt > Date.now() + 5 * 60 * 1000;
  if (server.apiKey && (!managed || keyIsFresh)) return server;
  if (!managed) {
    throw new Error("This Android build server needs an API key. Add its key in the Export settings.");
  }

  const response = await fetch(normalizeServerUrl(server.serverUrl) + "/api/v1/keys", {
    method: "POST",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  let body = {};
  try {
    body = await response.json();
  } catch (_) {}
  if (!response.ok) {
    throw new Error(
      body && body.error
        ? body.error
        : "The APK service could not create an export key (" + response.status + ")."
    );
  }
  if (!body || !body.apiKey || !body.expiresAt || !Number.isFinite(Date.parse(body.expiresAt))) {
    throw new Error("The APK service returned an invalid temporary export key.");
  }

  const updated = {
    id: server.id || BUILTIN_SERVER_ID,
    label: server.label || BUILTIN_SERVER_LABEL,
    serverUrl: normalizeServerUrl(server.serverUrl),
    apiKey: body.apiKey,
    managedKey: true,
    keyExpiresAt: body.expiresAt,
  };
  const data = _loadAll();
  const existingIndex = data.servers.findIndex((entry) => entry.id === updated.id);
  if (existingIndex >= 0) data.servers[existingIndex] = updated;
  else data.servers.push(updated);
  data.activeId = updated.id;
  _saveAll(data);

  Object.assign(server, updated);
  return server;
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
