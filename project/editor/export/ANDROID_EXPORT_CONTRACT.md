# Realot Web Export → Android APK contract

Realot HTML5 and PWA exports are standalone ZIP packages. The APK build path must consume that ZIP directly; it must not reconstruct the game from editor-only project data.

## Request

`POST /api/v1/build?name=<url-encoded-game-title>`

Headers:

- `Content-Type: application/zip`
- `X-Api-Key: <configured build-server key>`

No other custom headers are sent. Extra custom headers would need to be in the
server's CORS allow-list or the browser's preflight fails and blocks the
upload. The server tells a standalone export apart by the ZIP contents
(`index.html` at the root), and can read `manifest.webmanifest` / `sw.js` to
tell a PWA package from a plain HTML5 one.

Body: the exact ZIP produced by `ExportGame.buildExport()`.

## Required package entry point

The ZIP must contain `index.html` at its root. The runtime and all referenced assets are relative to that root. Do not rewrite asset URLs to absolute editor/server URLs.

## Android behavior

The APK wrapper should load the bundled `index.html` locally from the APK/WebView asset space. The game should not require the build server, any hosting provider, or an external asset URL at runtime.

For a PWA source package, `manifest.webmanifest` and `sw.js` may be present. An APK wrapper does not need a browser install prompt or service-worker registration; it should simply load the same `index.html` and bundled runtime/assets. Ignoring service-worker registration inside a native wrapper is acceptable.

## Async response

The existing client expects the build server to return a JSON job ticket containing either top-level or nested `job` data plus a `statusUrl`. The final completed status should provide `downloadUrl`.

This design makes HTML5, PWA, and APK outputs originate from the same generated game package, so a fix to the game runtime is automatically shared by all three targets.

## Cancelling a build

The editor can cancel a build (Cancel button, or when the user restarts / leaves the editor while a build is running). The build server must support:

`DELETE <cancelUrl>` — `cancelUrl` is `cancelUrl` from the job ticket (top-level or under `job`), falling back to `statusUrl` (normally `/api/v1/build/<id>`).

- Headers: `X-Api-Key` as for every other request.
- Must be idempotent: cancelling a job that is already finished, failed, cancelled or unknown returns 200/204 (404 is tolerated) — never an error that matters.
- A `queued` job is removed from the queue. A `building` job has its build process killed (whole process tree) and its temp files deleted.
- The job's status becomes the terminal value `cancelled`. The editor treats `cancelled` like `failed`.
- The server then immediately starts the next queued job.
- The request is sent with `keepalive` while the page is unloading, so it may arrive after the editor has gone: do not require anything else from the client.

Status polling (`GET statusUrl`) doubles as a heartbeat. If the server stops receiving status requests for a running or queued job for too long (suggested 60 s), it should treat the editor as gone and cancel the job itself — this is the safety net for crashes, lost connections and closed laptops.
