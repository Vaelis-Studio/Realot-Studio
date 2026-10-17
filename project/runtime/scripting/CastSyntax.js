/**
 * runtime/scripting/CastSyntax.js
 *
 * Realot scripts support an editor-only type-cast hint so autocomplete
 * can narrow an Unknown variable's type:
 *
 *   const body = enemy as DynamicBody;
 *   const obj  = enemy as (DynamicBody, Animator, AudioSource);
 *
 * `as` is NOT valid JavaScript — it's TypeScript syntax that Realot
 * borrows purely for IntelliSense (see editor/scripting/ScriptTypeInference.js's
 * CAST_TARGETS / parseCastVariables, which recognize the exact same two
 * forms this file strips). It carries no runtime meaning: the cast target
 * only ever affects which autocomplete suggestions the editor offers.
 *
 * Both the compiler and the editor need the SAME stripping behavior:
 *   - runtime/systems/ScriptSystem.js calls stripCastSyntax() before
 *     handing source to `new Function()`, so `as` never reaches the real
 *     JS parser at all (it would be a hard SyntaxError otherwise — `as`
 *     isn't a JS keyword).
 *   - editor/scripting/ScriptIntelliSense.js calls it before running
 *     Monaco's live syntax check, so a cast is never flagged as a
 *     mistake while typing (see refreshScriptDiagnostics).
 *
 * This lives under /runtime (not /editor) specifically so the runtime
 * compiler can depend on it without ever reaching into /editor — see
 * RULES.txt rule #1. The editor is free to import this file too, same
 * as it imports any other runtime module.
 *
 * STRING/COMMENT SAFETY: the obvious implementation — a plain regex for
 * `\bas\s+Ident\b` over the raw source — is WRONG. It matches the literal
 * two-letter word "as" anywhere at all, including inside string/template
 * literals and comments, e.g. `"he acts as a hero"` or `// same as before`.
 * That silently corrupts real script content (a string a script actually
 * reads/compares/displays gets holes punched in it) rather than just
 * mis-stripping a cast — a much worse failure than a wrong squiggle,
 * since it changes what compiled code actually does. So this file does a
 * single lightweight lexical pass first (strings, template literals,
 * comments, regex literals) and only searches for `as Ident` within the
 * spans that pass identifies as real code — never inside a string,
 * template literal, comment, or regex literal.
 *
 * ENGINE FILE — used by both runtime and editor.
 */

// Matches `as Ident` — the single-cast form, anchored so it only matches
// starting at a word boundary (checked by the scanner before testing,
// since the scanner already knows it's positioned at the start of a
// word). Captures the whole `as Ident` span so the replacement can blank
// exactly that.
const CAST_SINGLE_RX = /^as\s+[A-Za-z_]\w*/;

// Matches `as (Ident, Ident, ...)` — the multi-cast form. Tried first at
// each candidate position (see _stripCodeSpan below) because it's the
// more specific of the two forms and must win when both could start at
// the same `as`.
const CAST_MULTI_RX = /^as\s*\(\s*[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*\)/;

function _isIdentPart(ch) {
  return !!ch && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Walks `source` once, classifying every character as CODE, a
 * string/template literal, a comment, or a regex literal, and returns an
 * array of [start, end) spans that are real, executable code — i.e.
 * everywhere it's actually safe to look for a JS-syntax `as Type` cast.
 *
 * This is a lexer, not a parser: it never builds an AST, just tracks
 * enough state (current quote char, template `${...}` nesting depth,
 * block-comment-open, "was the previous significant token a value" for
 * the regex-vs-divide ambiguity) to correctly skip every span where the
 * literal text "as" cannot possibly be the cast keyword.
 * @param {string} source
 * @returns {Array<[number, number]>}
 */
function _codeSpans(source) {
  const spans = [];
  let spanStart = 0;
  let i = 0;
  const n = source.length;

  // Tracks whether a `/` at the current position should be read as the
  // start of a regex literal (true) or a division operator (false) —
  // the standard heuristic: a regex can't follow a value (identifier,
  // number, string, `)`, `]`), only an operator/keyword/start-of-input.
  let prevSignificant = "";

  function closeSpan(end) {
    if (end > spanStart) spans.push([spanStart, end]);
  }

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      // Line comment — not code from here to end of line (exclusive).
      closeSpan(i);
      i += 2;
      while (i < n && source[i] !== "\n") i++;
      spanStart = i; // the newline itself (if any) re-enters as code
      continue;
    }

    if (ch === "/" && next === "*") {
      closeSpan(i);
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      spanStart = i;
      continue;
    }

    if (ch === '"' || ch === "'") {
      closeSpan(i);
      const quote = ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i++; // skip escaped char (incl. escaped quote)
        i++;
      }
      i = Math.min(n, i + 1); // consume closing quote
      spanStart = i;
      prevSignificant = quote;
      continue;
    }

    if (ch === "`") {
      // Template literal. `${...}` interpolations ARE real code (a cast
      // could legitimately appear inside one), so this tracks nested
      // brace depth and only treats the literal *text* portions as
      // non-code, re-entering code mode for each ${ ... } span.
      closeSpan(i);
      i++;
      while (i < n && source[i] !== "`") {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === "$" && source[i + 1] === "{") {
          i += 2;
          let depth = 1;
          const exprStart = i;
          while (i < n && depth > 0) {
            // Recurse conceptually: skip nested strings/comments inside
            // the interpolation too, so a brace inside a nested string
            // doesn't miscount depth.
            if (source[i] === "{") { depth++; i++; continue; }
            if (source[i] === "}") { depth--; if (depth === 0) break; i++; continue; }
            if (source[i] === '"' || source[i] === "'") {
              const q = source[i]; i++;
              while (i < n && source[i] !== q) { if (source[i] === "\\") i++; i++; }
              i = Math.min(n, i + 1);
              continue;
            }
            if (source[i] === "`") {
              // Nested template — skip conservatively to its matching
              // backtick; nested ${} inside a nested template is rare
              // enough in practice that treating its whole body as
              // non-cast-scanned code is an acceptable simplification
              // (worst case: a cast inside a doubly-nested template
              // isn't stripped, which just means that one line needs a
              // manual assignment split — never a corrupted string).
              i++;
              while (i < n && source[i] !== "`") { if (source[i] === "\\") i++; i++; }
              i = Math.min(n, i + 1);
              continue;
            }
            i++;
          }
          // The ${ ... } interior (exprStart .. i) is real code —
          // record it as its own span so casts inside interpolations
          // still get stripped.
          if (i > exprStart) spans.push([exprStart, i]);
          i = Math.min(n, i + 1); // consume the closing }
          continue;
        }
        i++;
      }
      i = Math.min(n, i + 1); // consume closing backtick
      spanStart = i;
      prevSignificant = "`";
      continue;
    }

    if (ch === "/" && prevSignificant !== "VALUE") {
      // Regex literal (heuristic: `/` not immediately following a value
      // means it can't be division, so treat it as a regex open). A
      // regex body can legally contain the character sequence "as"
      // (e.g. /as+/) which must never be mistaken for a cast.
      closeSpan(i);
      let j = i + 1;
      let inClass = false;
      while (j < n && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") { j += 2; continue; }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "\n") break; // unterminated — bail, treat as divide instead
        j++;
      }
      if (j < n && source[j] === "/" && source[j - 1] !== undefined) {
        // Found a plausible closing slash — consume optional flags too.
        j++;
        while (j < n && /[a-z]/i.test(source[j])) j++;
        i = j;
        spanStart = i;
        prevSignificant = "VALUE"; // a regex literal is itself a value
        continue;
      }
      // No valid closing slash found before end-of-line/input — this
      // wasn't actually a regex literal (or the source has a real syntax
      // error the JS parser will catch anyway); fall through and treat
      // the `/` as ordinary code so we don't eat the rest of the file.
      spanStart = i;
      i++;
      continue;
    }

    // Ordinary code character — update the "was that a value" tracker
    // for the next regex-vs-divide decision, then advance.
    if (_isIdentPart(ch)) {
      // Still inside the same identifier/number as before — value-ness
      // is decided once the identifier ends, so just advance.
      prevSignificant = "VALUE";
    } else if (ch === ")" || ch === "]") {
      prevSignificant = "VALUE";
    } else if (!/\s/.test(ch)) {
      // Any other non-whitespace token (operator, `(`, `,`, `{`, `;`, a
      // keyword's last letter, etc.) — conservatively NOT a value,
      // matching the standard regex/divide heuristic used by real JS
      // lexers (good enough here since a wrong guess only risks
      // mis-scanning a `/`, which is vanishingly rare in gameplay
      // scripts and never corrupts anything — it just means that one
      // regex-adjacent line's casts, if any, aren't stripped).
      prevSignificant = "";
    }
    i++;
  }
  closeSpan(n);
  return spans;
}

/**
 * Replaces every `as Type` / `as (A, B)` cast with whitespace of the
 * exact same length, but ONLY where it appears as real code — never
 * inside a string, template-literal text portion, comment, or regex
 * literal (see _codeSpans above). This is deliberately NOT a deletion —
 * padding with spaces instead of removing the text keeps every later
 * character at the same line/column it was at in the original source,
 * so a real syntax error elsewhere in the script still reports the line
 * the author actually sees in the editor. Newlines inside a cast (rare,
 * but legal since whitespace is flexible around `as`) are preserved as
 * newlines rather than spaces, for the same reason.
 * @param {string} source
 * @returns {string} source with cast syntax blanked out, same length/line count
 */
export function stripCastSyntax(source) {
  if (typeof source !== "string") return source;
  // Fast path: no "as" substring at all (common case — most scripts
  // never use casts) means nothing can possibly match, so skip the
  // lexical scan entirely.
  if (!/\bas\b/.test(source)) return source;

  const spans = _codeSpans(source);
  if (spans.length === 0) return source;

  let out = source;
  // Walk spans back-to-front so earlier replacements never shift the
  // character offsets of spans not yet processed.
  for (let s = spans.length - 1; s >= 0; s--) {
    const [start, end] = spans[s];
    out = out.slice(0, start) + _stripCodeSpan(out.slice(start, end)) + out.slice(end);
  }
  return out;
}

/**
 * Applies the two cast regexes within a single known-to-be-code span.
 * Scans for word-boundary-aligned "as" occurrences and, at each one,
 * tries the multi-cast form first (more specific), then the single-cast
 * form, blanking whichever matches.
 * @param {string} codeText a substring of the original source that
 *   _codeSpans has already confirmed contains no strings/comments/regex
 * @returns {string} same length as codeText
 */
function _stripCodeSpan(codeText) {
  let result = "";
  let i = 0;
  const n = codeText.length;
  while (i < n) {
    // Find the next candidate "as" word start.
    if (
      codeText[i] === "a" && codeText[i + 1] === "s" &&
      !_isIdentPart(codeText[i - 1]) &&
      !_isIdentPart(codeText[i + 2])
    ) {
      const rest = codeText.slice(i);
      const multi = CAST_MULTI_RX.exec(rest);
      const match = multi || CAST_SINGLE_RX.exec(rest);
      if (match) {
        result += _blank(match[0]);
        i += match[0].length;
        continue;
      }
    }
    result += codeText[i];
    i++;
  }
  return result;
}

function _blank(match) {
  // Preserve newlines so line numbers in the blanked-out span still
  // line up; every other character becomes a space.
  let out = "";
  for (let i = 0; i < match.length; i++) {
    out += match[i] === "\n" ? "\n" : " ";
  }
  return out;
}

