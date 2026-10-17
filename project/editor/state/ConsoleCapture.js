/**
 * editor/state/ConsoleCapture.js
 *
 * Pipes REAL browser-level errors into the editor's own Console panel
 * (editorState.logs / pushLog), not just the handful of manual pushLog()
 * calls scattered through editor code. This is what lets you open the
 * in-engine Console tab and see PixiJS texture/WebGL errors, uncaught
 * exceptions, unhandled promise rejections, and any console.warn/error
 * call from ANY module (including PixiJS itself) — without needing the
 * browser's own devtools console open.
 *
 * Call installConsoleCapture() exactly once, as early as possible in
 * editor/main.js, before createViewport()/PIXI boot.
 */

import { pushLog } from "./EditorState.js";

let installed = false;

function stringifyArg(arg) {
  if (arg instanceof Error) {
    return arg.message + (arg.stack ? "\n" + arg.stack : "");
  }
  if (typeof arg === "object" && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch (err) {
      return String(arg);
    }
  }
  return String(arg);
}

export function installConsoleCapture() {
  if (installed) return;
  installed = true;

  // 1. Uncaught synchronous errors (includes PixiJS internal throws,
  //    e.g. bad texture data, WebGL context creation failures).
  window.addEventListener("error", (event) => {
    const msg = event.error ? stringifyArg(event.error) : event.message;
    // Suppress the known PIXI ResizeObserver race during innerHTML
    // rebuilds — it's handled by main.js's retry, not a real error.
    if (msg.indexOf("no longer a child") !== -1 || msg.indexOf("node to be removed") !== -1) return;
    pushLog("error", "[Uncaught] " + msg + (event.filename ? " (" + event.filename + ":" + event.lineno + ")" : ""));
  });

  // 2. Unhandled promise rejections (e.g. a failed PIXI.Assets.load(),
  //    or a rejected texture-loading promise from AssetManager that
  //    nobody .catch()'d).
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason ? stringifyArg(event.reason) : "Unhandled promise rejection";
    pushLog("error", "[Unhandled Promise] " + reason);
  });

  // 3. Mirror console.log / console.warn / console.error into the panel
  //    too, so both PixiJS's own internal console.warn() calls
  //    (deprecated API usage, missing textures, etc.) AND a user
  //    script's plain console.log("...") calls during Play mode show
  //    up here. Keep calling the real console methods so browser
  //    devtools still work normally alongside this.
  const realLog = console.log.bind(console);
  const realWarn = console.warn.bind(console);
  const realError = console.error.bind(console);

  console.log = (...args) => {
    realLog(...args);
    const text = args.map(stringifyArg).join(" ");
    pushLog("log", text);
  };

  console.warn = (...args) => {
    realWarn(...args);
    const text = args.map(stringifyArg).join(" ");
    // Filter out BuilderBridge "No parent window found" warnings —
    // harmless in the preview sandbox, they just spam the console.
    if (text.indexOf("No parent window found") !== -1 || text.indexOf("BuilderBridge") !== -1) return;
    pushLog("warn", "[console.warn] " + text);
  };

  console.error = (...args) => {
    realError(...args);
    pushLog("error", "[console.error] " + args.map(stringifyArg).join(" "));
  };

  pushLog("log", "Console capture installed: window errors, unhandled rejections, console.warn/error now mirrored here.");

  // Flush any errors that were collected BEFORE ConsoleCapture was
  // installed (e.g. module-load failures that happened in index.html
  // before main.js even finished importing). Without this, those early
  // errors are lost — the editor console shows nothing about why a
  // particular module or asset failed to load.
  if (window.__realotEarlyErrors && window.__realotEarlyErrors.length) {
    for (const entry of window.__realotEarlyErrors) {
      pushLog(entry.level, entry.msg);
    }
    window.__realotEarlyErrors = [];
  }
}

/**
 * Wraps a PIXI.Application's renderer/loader-level events, if present in
 * the running PIXI version, so texture load failures surface as engine
 * console entries with the offending resource named explicitly.
 * Safe no-op if the PIXI build doesn't expose these hooks.
 *
 * @param {PIXI.Application} pixiApp
 * @param {{onContextLost?: () => void, onContextRestored?: () => void}} [handlers]
 *   Optional callbacks so the caller (SceneViewport.js) can react beyond
 *   just logging — e.g. show a visible banner over the viewport instead
 *   of a console-only message the user has no reason to be looking at
 *   when the canvas they're staring at just went blank, and actually
 *   re-run a render pass once the context comes back instead of leaving
 *   the viewport dark until some unrelated future re-render happens to
 *   touch it.
 */
export function attachPixiDiagnostics(pixiApp, handlers) {
  if (!pixiApp || !pixiApp.renderer) return;
  const onContextLost = (handlers && handlers.onContextLost) || (() => {});
  const onContextRestored = (handlers && handlers.onContextRestored) || (() => {});

  try {
    pixiApp.renderer.on("error", (err) => {
      pushLog("error", "[PIXI renderer] " + stringifyArg(err));
    });
  } catch (err) {
    // renderer.on may not exist on every PIXI renderer type; ignore.
  }

  try {
    const gl = pixiApp.renderer.gl;
    if (gl && pixiApp.view) {
      pixiApp.view.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        pushLog("error", "[PIXI] WebGL context lost (often caused by low GPU memory). Rendering has stopped until the context is restored.");
        onContextLost();
      });
      pixiApp.view.addEventListener("webglcontextrestored", () => {
        pushLog("log", "[PIXI] WebGL context restored — resuming rendering.");
        onContextRestored();
      });
    }
  } catch (err) {
    // ignore — not all renderer types expose .gl (e.g. canvas fallback)
  }
}
