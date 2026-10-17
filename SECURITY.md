# Security notes

## The one thing to know

**Game scripts are not sandboxed.** A project's scripts are compiled with
`new Function()` and run as normal page code. Whatever origin the game runs on
is what the script can reach. So the real protection is to run games on an
origin that holds nothing worth stealing.

## Recommended setup: play on a separate origin

Deploy the **same folder** on a second hostname, and tell the editor about it:

1. Add a second domain to your host that serves the same files (on Cloudflare Pages: add
   a second custom domain to the same project, e.g. `play.yourdomain.com`).
2. In `project/editor/index.html` set
   `<meta name="realot-play-origin" content="https://play.yourdomain.com" />`.

That's it. Press Play and the game opens on the play origin. The editor sends
the scene to it with `postMessage`; scripts there cannot read the editor's
`localStorage`, IndexedDB (saved projects, Android build keys), or DOM, because
browsers keep each origin's data apart. This was tested in Chromium
(`tests/e2e-play-origin.py cross`): from the play window `localStorage` shows
none of the editor's data, `window.opener.localStorage` and
`window.opener.document` throw `SecurityError`, and the old
`(() => {}).constructor(...)` trick returns nothing.

Things to know:
- **Leave the meta tag empty and you get the old behavior** (same-origin play).
  Fine for a local, only-your-own-projects setup; not fine once you encourage
  sharing projects.
- **Offline:** the other host can't be reached, so the editor falls back to
  same-origin play while offline and logs a warning.
- **`save` data from Play lives on the play origin**, separate from the
  editor's.
- Use `https://` in production. Don't put anything private on the play origin
  (no login cookies, no editor data); it should only serve this static folder.

## What else is protected

- **Message handling:** the editor only accepts messages from the play window it
  opened, on the origin it opened it on. The play window only accepts messages
  from the editor. Everything the play window says is still treated as untrusted
  text.
- **Console output is escaped.** Before this change the Console panel inserted
  script output as raw HTML, so `console.log("<img src=x onerror=...>")` ran
  code inside the editor. Fixed, and covered by the test above.
- **Project data is escaped before it is shown.** Entity, script, tag and asset
  names come from project files (possibly someone else's), and the editor
  builds much of its UI as HTML strings. The Hierarchy, Inspector, dropdowns
  and asset grid now escape them (`escapeAttr` in `UIComponents.js` is a full
  HTML escape). Covered by `tests/e2e-hostile-names.py`. If you add new UI that
  concatenates project data into HTML, wrap it in `escapeAttr(...)`.
- **Name shadowing:** inside a script, `window`, `document`, `globalThis`,
  `self`, `top`, `parent`, `frames`, `opener`, `open`, `localStorage`,
  `sessionStorage`, `indexedDB`, `caches`, `fetch`, `XMLHttpRequest`,
  `WebSocket` and `Function` are `undefined` (`SHADOWED_GLOBALS` in
  `project/runtime/systems/ScriptSystem.js`). This stops accidents and one-line
  snooping only; a determined script gets around it, which is why the separate
  origin matters.
- **Import prompt:** loading a project that contains scripts asks for
  confirmation first.
- **No secrets shipped:** Android build server URLs and keys are typed by the
  user and stored in that browser's `localStorage`.

## What is still exposed

- In same-origin mode, everything above the line "recommended setup".
- A script can still make network requests from the play origin and can still
  mess with its own game window. That is the nature of running someone's code.
- Exported games are separate from all of this: they run on whatever origin the
  developer hosts them on.

## Reporting a vulnerability

Add a contact address here before publishing (for example
`security@your-domain`).
