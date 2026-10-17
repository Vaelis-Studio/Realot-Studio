// Tracks the ONE Android APK build the editor may have in flight, so it
// can be cancelled — by the Cancel button, or automatically if the user
// reloads / leaves the editor while the server is still building.
//
// Why this exists: the build server processes jobs one after another. If
// the editor just disappears mid-build (reload, closed tab, "Hub" link),
// the server used to keep grinding on a job nobody wants, and every build
// queued behind it waited forever. Cancelling does two things:
//   1. aborts the editor's own requests (upload / status polling / APK
//      download) through an AbortController, and
//   2. tells the server to stop the job: DELETE on the job's cancel URL
//      (see ANDROID_EXPORT_CONTRACT.md), so it kills the build and moves
//      on to the next job in line.
//
// This module deliberately imports nothing from ServerConfig.js (which
// imports THIS file) so there is no circular import.
//
// EDITOR-ONLY FILE.

/** Turns a server-relative path ("/api/v1/build/abc") into a full URL on the build server. */
export function resolveAgainstServer(url, serverUrl) {
  try {
    return new URL(url, String(serverUrl).replace(/\/+$/, "") + "/").href;
  } catch (_) {
    return url;
  }
}

let session = null;
// { controller, server, cancelUrl, jobFinished, cancelled, cancelSent }

/** Start tracking a new build. Returns the AbortSignal to pass to every fetch. */
export function beginAndroidBuild(server) {
  session = {
    controller: new AbortController(),
    server: server || null,
    cancelUrl: null,
    jobFinished: false,
    cancelled: false,
    cancelSent: false,
  };
  return session.controller.signal;
}

/** True while a build is running and hasn't been cancelled. */
export function isAndroidBuildActive() {
  return !!session && !session.cancelled;
}

/** True if the build that just threw was cancelled on purpose (not a real failure). */
export function wasAndroidBuildCancelled() {
  return !!session && session.cancelled;
}

/** Remember the server's job ticket so we know where to send the cancel. */
export function setAndroidBuildTicket(ticket) {
  if (!session || !ticket) return;
  const job = ticket.job || {};
  const raw = ticket.cancelUrl || job.cancelUrl || ticket.statusUrl || job.statusUrl || null;
  session.cancelUrl = raw && session.server && session.server.serverUrl
    ? resolveAgainstServer(raw, session.server.serverUrl)
    : raw;
}

/** The job reached a terminal state on the server (completed/failed/cancelled) — nothing left to cancel. */
export function markAndroidJobFinished() {
  if (session) session.jobFinished = true;
}

function sendCancelToServer(keepalive) {
  if (!session || session.cancelSent || session.jobFinished || !session.cancelUrl) return;
  session.cancelSent = true;
  const headers = {};
  if (session.server && session.server.apiKey) headers["X-Api-Key"] = session.server.apiKey;
  try {
    // keepalive lets this request finish even while the page is being
    // unloaded (reload / tab close), which is exactly when it matters.
    // Deliberately NOT given the abort signal — we just aborted that one.
    fetch(session.cancelUrl, { method: "DELETE", headers, keepalive: !!keepalive }).catch(() => {});
  } catch (_) {}
}

/**
 * Cancel the running build: stop our own requests and tell the server to
 * drop the job. Safe to call more than once.
 */
export function cancelAndroidBuild({ keepalive = false } = {}) {
  if (!session || session.cancelled) return;
  session.cancelled = true;
  sendCancelToServer(keepalive);
  try { session.controller.abort(); } catch (_) {}
}

/**
 * The build chain has finished (success, failure or cancel). If it died
 * for some OTHER reason while the server job may still be alive (timeout,
 * lost connection), cancel the job on the server so it can't hog the queue.
 */
export function endAndroidBuild() {
  if (!session) return;
  sendCancelToServer(false);
  session = null;
}

/**
 * Warn before the editor is restarted while a build is running, and cancel
 * the server job if the user goes ahead anyway.
 * Call once at startup.
 */
export function installAndroidBuildLeaveGuard() {
  const WARNING =
    "An Android build is still running on the server.\n\n" +
    "If you restart or leave the editor now, the build will be STOPPED and you will have to export again.\n\n" +
    "Press OK to stop the build and continue, or Cancel to keep waiting.";

  // 1) Browser refresh button / tab close / back navigation. Browsers
  //    only allow their own generic "Leave site?" wording here.
  window.addEventListener("beforeunload", (e) => {
    if (!isAndroidBuildActive()) return;
    e.preventDefault();
    e.returnValue = "";
    return "";
  });

  // 2) The page really is going away (user chose Leave). Stop the job
  //    on the server so it moves on to the next one in the queue.
  //    `persisted` is true when the page is just being frozen into the
  //    back/forward cache, which is not a real exit.
  window.addEventListener("pagehide", (e) => {
    if (e.persisted) return;
    if (isAndroidBuildActive()) cancelAndroidBuild({ keepalive: true });
  });

  // 3) Our own "Hub" link: show a clear message instead of the generic one.
  document.addEventListener(
    "click",
    (e) => {
      if (!isAndroidBuildActive()) return;
      const link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!link || link.target === "_blank") return;
      if (!window.confirm(WARNING)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      cancelAndroidBuild({ keepalive: true });
    },
    true
  );

  // 4) Keyboard reload (F5 / Ctrl+R / Cmd+R / Chromebook refresh key).
  document.addEventListener(
    "keydown",
    (e) => {
      if (!isAndroidBuildActive()) return;
      const isReload = e.key === "F5" || ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R"));
      if (!isReload) return;
      e.preventDefault();
      if (window.confirm(WARNING)) {
        cancelAndroidBuild({ keepalive: true });
        window.location.reload();
      }
    },
    true
  );
}
