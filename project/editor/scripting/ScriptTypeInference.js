/**
 * editor/scripting/ScriptTypeInference.js
 *
 * Lightweight, regex-based type tracking for Realot script
 * autocomplete. This is NOT a real type checker — same philosophy as
 * ScriptIntelliSense.js's other "parse enough of the surrounding text
 * to be useful" helpers (_parseFindVariables, _parseRaycastVariables,
 * etc). It exists to answer one question for a given variable name at
 * a given cursor position: "what components, if any, do we actually
 * know this variable has?"
 *
 * Three ways a variable's type becomes known:
 *   1. Explicit cast:      const body = enemy as DynamicBody;
 *   2. Narrowing:          if (enemy.hasComponent("Rigidbody2D")) { ... }
 *   3. Already known by ScriptIntelliSense's own tracking (find(),
 *      raycast(), `this`) — this module does NOT duplicate those; it
 *      only covers the NEW unknown/cast/narrow paths. Callers should
 *      check the existing tracking first and fall back to this module.
 *
 * Every OTHER variable — a bare `const enemy = randomEnemy()`, a
 * function parameter, anything this module can't place — is Unknown.
 * Unknown is deliberately NOT "every engine type": see BASE_OBJECT_API
 * below for the full, short list of what's actually safe to suggest.
 *
 * EDITOR-ONLY FILE.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { SPRITE_RENDERER } from "../../runtime/components/SpriteRenderer.js";
import { SHAPE_RENDERER } from "../../runtime/components/ShapeRenderer.js";
import { TEXT_RENDERER } from "../../runtime/components/TextRenderer.js";
import { SPEECH_BUBBLE } from "../../runtime/components/SpeechBubble.js";
import { CHAT_LOG } from "../../runtime/components/ChatLog.js";
import { TEXT_INPUT } from "../../runtime/components/TextInput.js";
import { JOYSTICK } from "../../runtime/components/Joystick.js";
import { RIGIDBODY_2D, BodyType } from "../../runtime/components/Rigidbody2D.js";
import { COLLIDER_2D } from "../../runtime/components/Collider2D.js";
import { JOINT_2D, JointType2D } from "../../runtime/components/Joint2D.js";
import { NAV_AGENT_2D } from "../../runtime/components/NavAgent2D.js";
import { CAMERA } from "../../runtime/components/Camera.js";
import { AUDIO_SOURCE } from "../../runtime/components/AudioSource.js";
import { AUDIO_LISTENER } from "../../runtime/components/AudioListener.js";
import { SPRITE_ANIMATION } from "../../runtime/components/SpriteAnimation.js";
import { CHARACTER_CONTROLLER, ControllerType } from "../../runtime/components/CharacterController.js";
import { LIGHT, LightType } from "../../runtime/components/Light.js";
import { SHADOW_CASTER } from "../../runtime/components/ShadowCaster.js";
import { STROKE_PATH } from "../../runtime/components/StrokePath.js";

// ─── Base Object — guaranteed on EVERY entity, known or not ─────────────────
// This is what Unknown gets. Never extend this list with anything that
// could be absent on some entity — that defeats the entire point of
// having an Unknown type. transform is included because every entity
// always has one (see ScriptAPI.js's _buildSubObjects — transform is
// unconditional, everything else is component-gated).
export const BASE_OBJECT_API = [
  { label: "transform", detail: "Position/rotation/scale — every entity has one.", insert: "transform.", kind: "Module" },
  { label: "name", detail: "This entity's name (read-only).", insert: "name", kind: "Property" },
  { label: "tag", detail: "This entity's tag (read/write).", insert: "tag", kind: "Property" },
  { label: "enabled", detail: "Whether this entity's scripts are currently running (read/write).", insert: "enabled", kind: "Property" },
  { label: "destroy()", detail: "Removes this entity from the scene at the end of the frame.", insert: "destroy()", kind: "Method" },
  { label: "hasComponent(key)", detail: 'Narrows the type: checks whether this entity currently has a component, e.g. enemy.hasComponent("Rigidbody2D"). Inside the resulting if-block, autocomplete narrows automatically.', insert: 'hasComponent("', kind: "Method" },
];

// Cast / narrowing helper snippets shown alongside BASE_OBJECT_API for
// any Unknown variable — these don't correspond to runtime members,
// they're editor affordances that INSERT code the user can then act on.
export const UNKNOWN_HELPER_API = [
  {
    label: "Cast to…",
    detail: "Explicitly assert this variable's type so its full API becomes available: const body = enemy as DynamicBody;",
    insert: "",
    kind: "Snippet",
    isCastHelper: true,
  },
  {
    label: "Check Component…",
    detail: 'Narrow the type with a runtime check: if (enemy.hasComponent("Rigidbody2D")) { ... }. Autocomplete updates instantly inside the block.',
    insert: "",
    kind: "Snippet",
    isCheckHelper: true,
  },
];

// ─── Cast-target catalog ─────────────────────────────────────────────────────
// Every name a script author can write after `as` / inside `as ( … )`,
// each resolving to a real component key plus (optionally) the
// type-narrowed API variant ScriptIntelliSense.js already computes for
// that subtype. "Base Object" and "Transform" are always offered and
// always merged in, matching rule #4 in the spec (casts always include
// Base Object + Transform + the selected component(s)).
//
// `apiKind` tells the completion dispatcher in ScriptIntelliSense.js
// which of its existing subtype-aware helper functions to call
// (_rigidbodyApiForBodyType / _controllerApiForType / _lightApiForType)
// instead of duplicating that logic here.
export const CAST_TARGETS = [
  { name: "Transform", key: TRANSFORM, prop: "transform", apiKind: "transform" },
  { name: "Sprite", key: SPRITE_RENDERER, prop: "sprite", apiKind: "plain" },
  { name: "SpriteRenderer", key: SPRITE_RENDERER, prop: "sprite", apiKind: "plain" },
  { name: "Shape", key: SHAPE_RENDERER, prop: "shape", apiKind: "plain" },
  { name: "ShapeRenderer", key: SHAPE_RENDERER, prop: "shape", apiKind: "plain" },
  { name: "Text", key: TEXT_RENDERER, prop: "text", apiKind: "plain" },
  { name: "SpeechBubble", key: SPEECH_BUBBLE, prop: "speechBubble", apiKind: "plain" },
  { name: "ChatLog", key: CHAT_LOG, prop: "chat", apiKind: "plain" },
  { name: "TextInput", key: TEXT_INPUT, prop: "textInput", apiKind: "plain" },
  { name: "Joystick", key: JOYSTICK, prop: "joystick", apiKind: "plain" },
  { name: "Animator", key: SPRITE_ANIMATION, prop: "animator", apiKind: "plain" },
  { name: "AudioSource", key: AUDIO_SOURCE, prop: "audio", apiKind: "plain" },
  { name: "AudioListener", key: AUDIO_LISTENER, prop: "ear", apiKind: "plain" },
  { name: "Ear", key: AUDIO_LISTENER, prop: "ear", apiKind: "plain" },
  { name: "Camera", key: CAMERA, prop: "camera", apiKind: "plain" },
  { name: "Collider", key: COLLIDER_2D, prop: "collider", apiKind: "plain" },
  { name: "Collider2D", key: COLLIDER_2D, prop: "collider", apiKind: "plain" },
  { name: "NavAgent", key: NAV_AGENT_2D, prop: "navAgent", apiKind: "plain" },
  { name: "NavAgent2D", key: NAV_AGENT_2D, prop: "navAgent", apiKind: "plain" },
  { name: "StrokePath", key: STROKE_PATH, prop: "strokePath", apiKind: "plain" },
  { name: "Light", key: LIGHT, prop: "light", apiKind: "light", subtype: null },
  { name: "PointLight", key: LIGHT, prop: "light", apiKind: "light", subtype: LightType.POINT },
  { name: "DirectionalLight", key: LIGHT, prop: "light", apiKind: "light", subtype: LightType.DIRECTIONAL },
  { name: "SpotLight", key: LIGHT, prop: "light", apiKind: "light", subtype: LightType.SPOT },
  { name: "AreaLight", key: LIGHT, prop: "light", apiKind: "light", subtype: LightType.AREA },
  { name: "GodRaysLight", key: LIGHT, prop: "light", apiKind: "light", subtype: LightType.GOD_RAYS },
  { name: "FreeformLight", key: LIGHT, prop: "light", apiKind: "light", subtype: LightType.FREEFORM },
  { name: "ShadowCaster", key: SHADOW_CASTER, prop: "shadowCaster", apiKind: "plain" },
  // Joint — bare name and every JointType2D-narrowed alias, same
  // pattern as Light's PointLight/SpotLight/etc. above.
  { name: "Joint", key: JOINT_2D, prop: "joint", apiKind: "joint", subtype: null },
  { name: "Joint2D", key: JOINT_2D, prop: "joint", apiKind: "joint", subtype: null },
  { name: "FixedJoint", key: JOINT_2D, prop: "joint", apiKind: "joint", subtype: JointType2D.FIXED },
  { name: "RevoluteJoint", key: JOINT_2D, prop: "joint", apiKind: "joint", subtype: JointType2D.REVOLUTE },
  { name: "PrismaticJoint", key: JOINT_2D, prop: "joint", apiKind: "joint", subtype: JointType2D.PRISMATIC },
  { name: "RopeJoint", key: JOINT_2D, prop: "joint", apiKind: "joint", subtype: JointType2D.ROPE },
  { name: "SpringJoint", key: JOINT_2D, prop: "joint", apiKind: "joint", subtype: JointType2D.SPRING },
  // Rigidbody — bare name and every BodyType-narrowed alias.
  { name: "Rigidbody", key: RIGIDBODY_2D, prop: "rigidbody", apiKind: "rigidbody", subtype: null },
  { name: "Rigidbody2D", key: RIGIDBODY_2D, prop: "rigidbody", apiKind: "rigidbody", subtype: null },
  { name: "DynamicBody", key: RIGIDBODY_2D, prop: "rigidbody", apiKind: "rigidbody", subtype: BodyType.DYNAMIC },
  { name: "KinematicBody", key: RIGIDBODY_2D, prop: "rigidbody", apiKind: "rigidbody", subtype: BodyType.KINEMATIC },
  { name: "StaticBody", key: RIGIDBODY_2D, prop: "rigidbody", apiKind: "rigidbody", subtype: BodyType.STATIC },
  // Controller — bare name and every ControllerType-narrowed alias.
  { name: "Controller", key: CHARACTER_CONTROLLER, prop: "controller", apiKind: "controller", subtype: null },
  { name: "CharacterController", key: CHARACTER_CONTROLLER, prop: "controller", apiKind: "controller", subtype: ControllerType.CHARACTER },
  { name: "PlatformerController", key: CHARACTER_CONTROLLER, prop: "controller", apiKind: "controller", subtype: ControllerType.PLATFORMER },
  { name: "TopDownController", key: CHARACTER_CONTROLLER, prop: "controller", apiKind: "controller", subtype: ControllerType.TOP_DOWN },
  { name: "CarController", key: CHARACTER_CONTROLLER, prop: "controller", apiKind: "controller", subtype: ControllerType.CAR },
  { name: "FollowController", key: CHARACTER_CONTROLLER, prop: "controller", apiKind: "controller", subtype: ControllerType.FOLLOW },
  { name: "PatrolController", key: CHARACTER_CONTROLLER, prop: "controller", apiKind: "controller", subtype: ControllerType.PATROL },
];

const CAST_TARGET_NAMES = CAST_TARGETS.map((t) => t.name).sort();

/** Case-insensitive lookup of a cast target by the name typed after `as`. */
export function findCastTarget(name) {
  const lower = String(name || "").trim().toLowerCase();
  return CAST_TARGETS.find((t) => t.name.toLowerCase() === lower) || null;
}

/** All cast-target names, for `as` / `as (` autocomplete. */
export function getCastTargetNames() {
  return CAST_TARGET_NAMES;
}

// ─── Parsing: explicit casts ─────────────────────────────────────────────────
// const body = enemy as DynamicBody;
// const enemy = obj as (DynamicBody, Animator, AudioSource);
// Returns Map<varName, string[]> — the list of cast-target NAMES (not yet
// resolved to components) assigned to each variable found in `text`.
// When a variable is cast more than once (e.g. re-cast to a different
// type further down the same script, or reassigned in a later branch),
// the LAST cast at or before the end of `text` wins — matching both
// normal JS assignment semantics and how narrowing is already
// position-aware elsewhere in this module. Callers that want "as of
// the cursor" should pass textUntilPosition (as ScriptIntelliSense.js's
// autocomplete path does); callers that want "anywhere in the file"
// (e.g. the Unknown-member diagnostic, which is deliberately
// conservative about excluding ever-cast variables) can pass the full
// document text.
const CAST_SINGLE_RX = /(?:\b(?:var|let|const)\s+)?(\w+)\s*=\s*[\w.]+\s+as\s+([A-Za-z_]\w*)\s*(?:[;\n)]|$)/g;
const CAST_MULTI_RX = /(?:\b(?:var|let|const)\s+)?(\w+)\s*=\s*[\w.]+\s+as\s*\(\s*([^)]*)\)/g;

export function parseCastVariables(text) {
  // Collect every match from both forms with its position in the text,
  // then apply them to the map in text order so the last one (whichever
  // form it is) always wins — instead of running the two regexes as
  // separate passes, which let an earlier single-cast block out a later
  // one simply because the multi-cast pass happened to run first.
  const matches = [];

  CAST_MULTI_RX.lastIndex = 0;
  let m;
  while ((m = CAST_MULTI_RX.exec(text)) !== null) {
    const names = m[2]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length) matches.push({ index: m.index, varName: m[1], names });
  }

  CAST_SINGLE_RX.lastIndex = 0;
  while ((m = CAST_SINGLE_RX.exec(text)) !== null) {
    matches.push({ index: m.index, varName: m[1], names: [m[2]] });
  }

  matches.sort((a, b) => a.index - b.index);

  const map = new Map();
  for (const match of matches) map.set(match.varName, match.names);
  return map;
}

/**
 * True when the text up to the cursor is positioned right after
 * `as` or `as (` / `as (X,` — i.e. the user is choosing cast target(s)
 * and should see the component catalog rather than normal completions.
 * Returns "single" | "multi" | null.
 */
export function detectCastPosition(lineUntil) {
  if (/\bas\s*\(\s*(?:[A-Za-z_]\w*\s*,\s*)*[A-Za-z_]*$/.test(lineUntil)) return "multi";
  if (/\bas\s+[A-Za-z_]*$/.test(lineUntil)) return "single";
  return null;
}

/** Names already chosen inside an in-progress `as ( … )` list, so the
 *  multi-cast completion doesn't re-suggest ones already picked. */
export function usedCastNames(lineUntil) {
  const openIdx = lineUntil.lastIndexOf("(");
  if (openIdx === -1) return new Set();
  const slice = lineUntil.slice(openIdx + 1);
  return new Set(
    slice
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

// ─── Parsing: hasComponent(...) narrowing ────────────────────────────────────
// if (enemy.hasComponent("Rigidbody2D")) { ... }
// Narrowing is scoped to the braces of that if-block: outside it, the
// variable reverts to Unknown. We find the innermost enclosing
// if-block (by simple brace-depth scanning, consistent with the
// paren/brace scanners ScriptIntelliSense.js already uses for
// raycast/camera.follow/spawn option literals) whose condition
// contains `<varName>.hasComponent("<key-or-alias>")` and, if the
// cursor sits inside it, returns the narrowed component key + subtype.
//
// Supports both real component keys ("Rigidbody2D") and the friendly
// CAST_TARGETS aliases ("DynamicBody") inside the hasComponent(...)
// string, since the spec explicitly asks for narrowing on names like
// "rigidbody"/"DynamicBody" too.
function _findEnclosingBlocks(fullText, cursorOffset) {
  // Returns an array of { start, end, headerStart } for every brace
  // block that CONTAINS cursorOffset, outermost first. headerStart is
  // the index right before the block's own "(" condition (for if/while)
  // so callers can slice out "if (...)" text preceding the "{".
  const blocks = [];
  const stack = [];
  let inString = null;
  for (let i = 0; i < fullText.length && i <= cursorOffset; i++) {
    const ch = fullText[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "{") stack.push(i);
    else if (ch === "}") stack.pop();
  }
  // Everything left on the stack encloses the cursor (we stopped
  // scanning exactly at cursorOffset, so any unclosed "{" before it
  // is still open at the cursor).
  for (const openIdx of stack) {
    // Find the matching close brace by scanning forward from openIdx
    // (best-effort — used only to bound the hasComponent search, not
    // required to be perfectly correct on malformed code).
    let depth = 0;
    let closeIdx = fullText.length;
    let inStr = null;
    for (let i = openIdx; i < fullText.length; i++) {
      const ch = fullText[i];
      if (inStr) {
        if (ch === "\\") { i++; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    blocks.push({ start: openIdx, end: closeIdx });
  }
  return blocks;
}

/**
 * Given the FULL document text and the cursor's character offset,
 * returns { varName, key, subtype, aliasName } for the innermost
 * enclosing `if (<varName>.hasComponent("<key>"))` block the cursor is
 * inside, for every such block found (a variable can be narrowed by
 * multiple nested checks) — or an empty array if none apply.
 */
export function findNarrowedTypesAtCursor(fullText, cursorOffset) {
  const blocks = _findEnclosingBlocks(fullText, cursorOffset);
  const results = [];
  const hcRx = /(\w+)\s*\.\s*hasComponent\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const block of blocks) {
    // The condition lives just before the block's own "{" — walk
    // backward from openIdx to the nearest unmatched "(" that starts
    // an if/while condition containing hasComponent, then confirm
    // that condition's ")" is what immediately precedes this "{".
    const headerText = fullText.slice(Math.max(0, block.start - 400), block.start);
    hcRx.lastIndex = 0;
    let m;
    let last = null;
    while ((m = hcRx.exec(headerText)) !== null) last = m;
    if (!last) continue;
    // Only accept it if it reads like "if (...hasComponent...)  {" —
    // i.e. nothing but whitespace/closing-parens between the
    // hasComponent(...) call and the block's opening brace.
    const afterCall = headerText.slice(last.index + last[0].length);
    if (!/^\s*\)*\s*$/.test(afterCall)) continue;
    if (!/\bif\s*\(/.test(headerText.slice(0, last.index))) continue;

    const varName = last[1];
    const rawKey = last[2];
    const target = findCastTarget(rawKey);
    if (target) {
      results.push({ varName, key: target.key, subtype: target.subtype, aliasName: target.name });
    } else {
      // Raw engine key typed directly, e.g. hasComponent("Rigidbody2D")
      results.push({ varName, key: rawKey, subtype: null, aliasName: rawKey });
    }
  }
  return results;
}

/** Convenience: narrowed info for one specific variable name at the
 *  cursor, or null if that variable isn't narrowed at this position. */
export function getNarrowedType(fullText, cursorOffset, varName) {
  const all = findNarrowedTypesAtCursor(fullText, cursorOffset);
  // Last-pushed (innermost enclosing block found last in the outermost-
  // first `blocks` array) wins — most specific narrowing applies.
  let found = null;
  for (const r of all) if (r.varName === varName) found = r;
  return found;
}
