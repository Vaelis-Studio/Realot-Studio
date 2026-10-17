/**
 * editor/scripting/ScriptSyntaxCheck.js
 *
 * Live "red squiggle" JS syntax checking (unclosed brackets, stray
 * commas, unexpected tokens, etc) while typing in the Script Editor —
 * previously scripts only surfaced errors once Play was pressed and the
 * broken script actually ran (see ScriptEditorWindow.js's
 * noSyntaxValidation: true comment, which this file's caller flips).
 *
 * THE `as` PROBLEM: Realot scripts support an editor-only cast hint
 * (`const body = enemy as DynamicBody;` — see
 * runtime/scripting/CastSyntax.js) that is NOT valid JavaScript. Monaco's
 * own JS/TS worker parses real JavaScript, so pointing it directly at a
 * script containing a cast would flag every single cast as a syntax
 * error — exactly the false positive this feature must never produce.
 *
 * THE FIX: never let Monaco's worker see the real model's text. Instead,
 * for each real script model this keeps a hidden "shadow" model
 * containing stripCastSyntax(realText) — same length, same line count,
 * `as ...` blanked out to spaces — and asks Monaco's JS worker to
 * validate THAT. Because stripping preserves every other character's
 * position exactly, the shadow model's diagnostic offsets are valid
 * unchanged on the real model, so markers copy straight across with no
 * translation math beyond "same line/column".
 *
 * The real model's own diagnostics stay fully disabled (see
 * ScriptEditorWindow.js) — Monaco never touches it directly. Only the
 * invisible shadow model is ever handed to the JS worker.
 *
 * EDITOR-ONLY FILE.
 */

import { stripCastSyntax } from "../../runtime/scripting/CastSyntax.js";

const SYNTAX_OWNER = "realot-js-syntax";

// scriptName -> shadow ITextModel. One shadow per open tab, disposed
// alongside the real model in ScriptEditorWindow.js's _closeTab.
const _shadowModels = new Map();

// Monotonic counter so every shadow model gets a unique scheme-qualified
// URI — Monaco requires model URIs to be unique process-wide, and script
// names alone aren't guaranteed unique across a session if a script is
// deleted and a new one created with the same name later.
let _shadowSeq = 1;

function _getOrCreateShadow(monaco, scriptName, strippedText) {
  let shadow = _shadowModels.get(scriptName);
  if (shadow && !shadow.isDisposed()) {
    // Only touch the shadow when its text actually changed — setValue()
    // on an unchanged string is harmless but re-triggers the worker's
    // validation pass for nothing, and this runs on every debounced
    // keystroke.
    if (shadow.getValue() !== strippedText) shadow.setValue(strippedText);
    return shadow;
  }
  const uri = monaco.Uri.parse("inmemory://realot-syntax-shadow/" + _shadowSeq++ + "-" + encodeURIComponent(scriptName) + ".js");
  shadow = monaco.editor.createModel(strippedText, "javascript", uri);
  _shadowModels.set(scriptName, shadow);
  return shadow;
}

/**
 * Runs Monaco's real JS syntax parser against a cast-stripped shadow of
 * `model`'s text and applies the results as markers on `model` itself.
 * Async (the TS/JS worker is a web worker round-trip) — callers don't
 * need to await it; markers simply appear a tick later, same as
 * Monaco's own built-in diagnostics normally would.
 *
 * Semantic validation (name resolution, "Property does not exist", etc)
 * is deliberately NOT requested here — only getSyntacticDiagnostics.
 * Realot scripts reference dozens of engine-injected globals
 * (this.rigidbody, nav, find(), …) that no static analysis of a single
 * file can ever resolve, so semantic checking would be false-positive
 * noise, not real bugs. Syntax errors (a parse failure) are a much
 * narrower, always-genuine class: the token stream itself is broken
 * regardless of what any identifier means.
 *
 * @param {string} scriptName used as the shadow model's stable key
 */
export function refreshSyntaxCheck(monaco, model, scriptName) {
  if (!monaco || !model || model.isDisposed()) return;
  if (!monaco.languages || !monaco.languages.typescript) return;

  let stripped;
  try {
    stripped = stripCastSyntax(model.getValue());
  } catch (e) {
    return; // never let a stripping bug break typing
  }

  const shadow = _getOrCreateShadow(monaco, scriptName, stripped);

  monaco.languages.typescript
    .getJavaScriptWorker()
    .then(function (worker) {
      return worker(shadow.uri);
    })
    .then(function (client) {
      return client.getSyntacticDiagnostics(shadow.uri.toString());
    })
    .then(function (diagnostics) {
      // The tab may have been closed, or a newer keystroke may have
      // already scheduled another pass, while this worker round-trip
      // was in flight. isDisposed() guards the first case; there's no
      // cheap guard for the second beyond "the next pass will just
      // overwrite these markers a moment later", which is harmless.
      if (model.isDisposed()) return;
      const markers = (diagnostics || []).map(function (d) {
        const start = model.getPositionAt(d.start);
        const end = model.getPositionAt(d.start + d.length);
        return {
          severity: monaco.MarkerSeverity.Error,
          message: _flattenDiagnosticMessage(d.messageText),
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
          source: "JavaScript",
        };
      });
      monaco.editor.setModelMarkers(model, SYNTAX_OWNER, markers);
    })
    .catch(function (e) {
      // Never let a worker hiccup (e.g. the JS worker script failing to
          // load, same class of local vendor failure _reportMonacoLoadFailure
          // already guards against elsewhere) break the editor.
      console.warn("[Realot] live syntax check failed:", e);
    });
}

// TS diagnostic messageText is either a plain string or a nested
// { messageText, next: [...] } chain — flatten to the first line, which
// is always the human-readable summary (the chain's later entries are
// "next line" elaborations TS uses for its own multi-part errors, not
// something a JS syntax error like a stray bracket ever populates).
function _flattenDiagnosticMessage(messageText) {
  if (typeof messageText === "string") return messageText;
  if (messageText && typeof messageText.messageText === "string") return messageText.messageText;
  return "Syntax error";
}

/** Migrate a script's shadow model to a new key after a rename — same
 *  spirit as ScriptHighlighting.js's renameRealotDecorations(), called
 *  from the same renameScriptEverywhere() flow in ScriptEditorWindow.js.
 *  Without this, a rename would silently orphan (leak) the old shadow
 *  model rather than reusing it under the new name. */
export function renameSyntaxCheck(oldName, newName) {
  const shadow = _shadowModels.get(oldName);
  if (shadow) {
    _shadowModels.delete(oldName);
    _shadowModels.set(newName, shadow);
  }
}

/** Clear syntax markers and dispose this script's shadow model. Call
 *  when a tab closes, alongside clearScriptDiagnostics(). */
export function disposeSyntaxCheck(monaco, model, scriptName) {
  if (monaco && model && !model.isDisposed()) {
    try {
      monaco.editor.setModelMarkers(model, SYNTAX_OWNER, []);
    } catch (e) {}
  }
  const shadow = _shadowModels.get(scriptName);
  if (shadow) {
    if (!shadow.isDisposed()) shadow.dispose();
    _shadowModels.delete(scriptName);
  }
}
