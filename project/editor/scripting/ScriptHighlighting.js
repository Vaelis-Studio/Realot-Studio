/**
 * editor/scripting/ScriptHighlighting.js
 *
 * Custom semantic-ish highlighting for Realot scripts, layered on
 * top of Monaco's normal JavaScript tokenizer.
 *
 * Monaco's built-in JS grammar only knows generic token types
 * (keyword, identifier, string, etc.) — it has no idea that `input`,
 * `this.sprite`, or `.addForce(` are OUR engine's API surface rather
 * than an arbitrary user variable. To get real semantic coloring
 * (engine classes vs engine objects vs engine members vs plain user
 * code) without pulling in a full TypeScript type-checker, this file
 * takes a simpler, reliable approach:
 *
 *   1. A custom theme (realot-dark) defines extra token colors on
 *      top of vs-dark's normal palette.
 *   2. A lightweight regex/scan pass runs on every content change and
 *      re-applies Monaco decorations (`deltaDecorations`) that tag
 *      matched ranges with CSS classes mapping to those token colors.
 *
 * This is intentionally NOT full semantic analysis — it's a curated
 * keyword-list match against the identifiers this engine actually
 * exposes (kept in sync with ScriptIntelliSense.js's own API tables).
 * That's enough to make Realot's own API visually pop against
 * plain user code, which is the actual goal, without the cost/fragility
 * of a real type checker running in the browser.
 *
 * EDITOR-ONLY FILE.
 */

// ─── Color tiers ────────────────────────────────────────────────────────────
// 1. JavaScript keywords/built-ins → left completely alone, Monaco's normal
//                                colors: if/for/function, Math/Math.floor/
//                                JSON/Array/etc. never get a Realot
//                                color — they're plain JavaScript, not
//                                something this engine provided, and
//                                coloring them specially would make them
//                                look like API to learn rather than
//                                ordinary code a beginner already knows.
// 2. Engine classes/globals    → the top-level names scripts are handed:
//                                find, scene, physics, input, mouse, touch,
//                                time, random, mathx, global, debug,
//                                sendMessage, broadcastMessage, spawn,
//                                wait, cancelWait, repeat, cancelRepeat, nav
// 3. Engine objects            → the per-entity sub-objects hanging off
//                                `this`: transform, sprite, rigidbody,
//                                animator, camera, audio, controller,
//                                state, ear, collider, navAgent
// 4. Engine methods/properties → members accessed off any of the above,
//                                e.g. .addForce(, .keyDown(, .position,
//                                .isGrounded, .velocityX, mathx.lerp,
//                                mathx.clamp — a large but curated list
//                                kept in sync with the autocomplete
//                                tables in ScriptIntelliSense.js
// 6. Everything else (user variables/functions) → Monaco's normal
//                                identifier color, i.e. left alone entirely.

const ENGINE_GLOBALS = [
  "findWithTag", "findFirst", "findAll", "findFirstWithTag", "findAllWithTag", "findById", "findInRadius",
  "scene", "physics", "input", "mouse", "touch", "time", "random", "mathx",
  "global", "save", "debug", "sendMessage", "broadcastMessage", "spawn", "wait",
  "cancelWait", "repeat", "cancelRepeat", "tween", "cancelTween", "nav",
];

// Realot's own mathx.<member> helpers — genuinely engine API, so
// these stay on the same realot-token-member tier as .addForce/.keyDown/
// etc., kept in sync with MATH_API in ScriptIntelliSense.js.
const MATHX_MEMBERS = ["lerp", "clamp", "moveToward", "remap", "approximately"];

const ENGINE_LIFECYCLE = [
  "onStart", "onClone", "onUpdate", "onClick", "onFixedUpdate", "onCollision",
  "onCollisionEnter", "onCollisionStay", "onCollisionExit", "onTriggerEnter",
  "onTriggerExit", "onMessage", "onDestroy",
  "onStateEnter", "onStateUpdate", "onStateExit", "onHearSound", "onLoseSound",
];

const ENGINE_OBJECTS = [
  "transform", "sprite", "shape", "text", "speechBubble", "chat", "textInput", "joystick", "rigidbody", "animator", "camera", "audio", "controller", "light",
  // Previously missing from this list (their MEMBERS were already
  // colored via ENGINE_MEMBERS below, e.g. this.state.current, but the
  // object name itself — state/ear/collider — never got the
  // realot-token-object color the other this.<sub-object> names all get.
  "state", "ear", "collider", "navAgent", "myTouch", "strokePath", "shadowCaster",
  // Joint (this.joint — see JointAPI.js). Was missing entirely: no
  // ENGINE_OBJECTS entry (this.joint itself stayed uncolored) and no
  // ENGINE_MEMBERS entries for its own fields below.
  "joint",
];

// Cast-target type names recognized after `as` / inside `as ( … )` — kept
// in sync with ScriptTypeInference.js's CAST_TARGETS catalog. Matched
// only right after the `as` keyword (see ENGINE_CAST_KEYWORD below), so
// a plain user variable that happens to be named e.g. "Camera" elsewhere
// in the file is never colored as a type.
const ENGINE_CAST_TYPES = [
  "Transform", "Sprite", "SpriteRenderer", "Shape", "ShapeRenderer", "Text", "SpeechBubble", "ChatLog",
  "TextInput", "Joystick", "Animator", "AudioSource", "Camera", "Collider", "Collider2D",
  "Joint", "Joint2D", "FixedJoint", "RevoluteJoint", "PrismaticJoint", "RopeJoint", "SpringJoint",
  "Light", "PointLight", "DirectionalLight", "SpotLight", "AreaLight",
  "GodRaysLight", "FreeformLight",
  "Rigidbody", "Rigidbody2D", "DynamicBody", "KinematicBody", "StaticBody",
  "Controller", "CharacterController", "PlatformerController",
  "TopDownController", "CarController", "FollowController",
  "StrokePath",
];

// The `as` cast keyword itself — matched as a bare word (it's not a
// reserved JS keyword Monaco's own grammar already colors) so it reads
// visually distinct from a variable named "as".
const ENGINE_CAST_KEYWORD = ["as"];

// Members accessed off an engine global/object, e.g. input.keyDown(...),
// this.rigidbody.addForce(...), this.transform.position. Deliberately
// excludes generic single-purpose names (x, y, name, type, key, entity)
// that are too likely to collide with the user's own variables/fields —
// those stay uncolored (tier 5) rather than risk false positives.
const ENGINE_MEMBERS = [
  // Transform
  "position", "rotation", "scale", "scaleX", "scaleY", "translate", "lookAt",
  // NavWorld2D one-line follow helper (this.navMoveToward — see
  // EntityContext.navMoveToward in ScriptAPI.js)
  "navMoveToward",
  // Car-controller counterpart: NavWorld2D pathing + Car handling (see
  // EntityContext.navDriveToward in ScriptAPI.js)
  "navDriveToward",
  // Sprite
  "texture", "color", "flipX", "flipY", "opacity",
  // Text (color/opacity already listed above, shared with Sprite)
  "value", "fontSize", "fontFamily", "bold", "italic", "align",
  "anchorX", "anchorY", "screenSpace", "wordWrap", "wrapWidth",
  // Speech Bubble (fontSize/fontFamily already listed above, shared with Text)
  "backgroundColor", "textColor", "borderColor", "borderWidth",
  "padding", "cornerRadius", "maxWidth", "offsetX", "offsetY",
  "tailDirection", "tailSize", "hide",
  // Chat Log (backgroundColor/padding/screenSpace/visible/
  // fontSize/fontFamily/senderColor already listed above)
  "messages", "maxMessages", "visibleCount", "width", "lineHeight",
  "messageColor", "showSender", "send", "backgroundOpacity",
  // Text Input (value/fontSize/fontFamily/textColor/backgroundColor/
  // borderColor/borderWidth/cornerRadius/width/height/padding already
  // listed above)
  "placeholder", "maxLength", "placeholderColor", "clearOnSubmit",
  "focused", "justSubmitted",
  // Rigidbody (common + dynamic + kinematic)
  "velocity", "velocityX", "velocityY", "mass", "gravityScale",
  "linearDamping", "angularDamping", "addForce", "addImpulse", "addTorque",
  "addAngularImpulse", "move", "isGrounded", "grounded", "isOnCeiling", "isOnWall",
  "isOnSlope", "groundAngle", "resolvedVelocity", "groundAngleLimit",
  "wallAngleLimit", "slopeMinAngle",
  // Controller (walk + car variants)
  // gravityScale is already covered by Rigidbody2D above — this list
  // matches regardless of which object precedes the dot, so
  // this.controller.gravityScale gets the same highlighting for free.
  "controllerType", "moveSpeed", "acceleration", "airControl", "useGravity",
  "useDefaultInput", "simulateMove", "simulateJump", "canJump", "jumpForce",
  "maxJumps", "maxSpeed", "turnSpeed", "brakeForce", "driftFactor", "driveTowardArriveDistance",
  "simulateDrive", "simulateDriveJoystick", "simulateDriveToward",
  "followDistance", "followSpeed", "targetName",
  "patrolDistance", "facingDirection", "flipDirection", "patrolMode", "patrolAxis",
  // Animator
  "play", "stop", "playing", "currentClip", "currentFrame", "totalFrames",
  // Camera
  "zoom", "shake", "renderToSprite", "follow", "stopFollow", "backgroundColor", "offsetX", "offsetY",
  "aspectMode", "landscapeWidth", "landscapeHeight", "portraitWidth", "portraitHeight",
  "squareSize", "customWidth", "customHeight", "enablePseudo3D",
  "scalingMode", "keepHeight", "aspectRatioLock", "allowStretching",
  "letterboxing", "pillarboxing", "barColor", "integerScaling",
  // Audio
  "volume", "pitch", "playOnce",
  // Scene
  "load", "restart", "pause", "resume", "isPaused",
  // Physics
  "raycast", "layer",
  // Raycast result: physics.raycast(...) → { entity, point, normal, distance }
  "entity", "point", "normal", "distance",
  // Raycast opts: physics.raycast(x1,y1,x2,y2, { exclude, layerMask, debug })
  "exclude", "layerMask",
  // Nav (nav.findPath/isWalkable/bake/areaIndex/areaMask — see
  // components/NavWorld2D.js and NavAPI.js). "debug" already covered
  // above (Physics' raycast opts).
  "findPath", "isWalkable", "bake", "areaIndex", "areaMask", "areaCosts",
  // Nav Agent (this.navAgent.* — see NavAgentAPI.js). radius/layer/
  // acceleration are already covered above (Light/Physics/Controller)
  // since this list is matched regardless of which object precedes the
  // dot.
  "speed", "deceleration", "stoppingDistance", "autoRepath", "repathInterval",
  "repathDistance", "avoidanceEnabled", "avoidancePriority", "area",
  "collabEnabled", "collabGroupRadius",
  "vehicleLookahead", "vehicleCornerLookahead", "vehicleObstacleLookahead",
  "vehicleObstacleWidth", "vehicleSteerSmoothing", "vehicleSpeedSmoothing",
  "vehicleCornerSlowdown", "vehicleObstacleBrake", "vehicleRecoveryTime",
  "vehicleRecoveryReverseTime",
  "currentPath", "currentPathIndex",
  // Collider (this.collider.* — see ColliderAPI.js). width/layer/radius
  // are already covered above (Chat Log/Physics/Light) since this list
  // is matched regardless of which object precedes the dot.
  "shape", "height", "capsuleHalfHeight", "capsuleRadius", "offset",
  "isTrigger", "isOneWayPlatform", "friction", "restitution", "density", "mask", "isColliding",
  // Joint (this.joint.* — see JointAPI.js). length/useTexture/textureKey/
  // textureMode/textureTiling/textureScale/textureOffset/textureFlip/
  // enabled are already covered above (StrokePath/Entity-level) since
  // this list is matched regardless of which object precedes the dot.
  "jointType", "connectedEntity", "anchor1", "anchor2", "axis",
  "stiffness", "damping", "segmentCount", "ropeMass",
  "visualEnabled", "visualColor", "visualThickness",
  "limitsEnabled", "limitMin", "limitMax",
  "motorEnabled", "motorSpeed", "motorMaxForce", "flexibility",
  "disableConnectedCollision", "collideConnected",
  // Joystick (this.joystick.* — see JoystickAPI.js). Only positionMode
  // added here (new PatrolMode/PatrolAxis-adjacent work this session) —
  // the rest of Joystick's members (magnitude, regionX/Y/Width/Height,
  // baseRadius, knobRadius, baseColor/Opacity, knobColor/Opacity,
  // deadZone, returnToCenter, hideWhenIdle, idleOpacityMultiplier) were
  // never added to this file even before this session and are a
  // separate, pre-existing gap — not touched here to stay scoped to
  // what actually changed this session.
  "positionMode",
  // Shape Renderer (this.shape.* — see ShapeAPI.js). width/height/radius/
  // capsuleHalfHeight/capsuleRadius/opacity are already covered above
  // (Collider/Sprite) since this list is matched regardless of which
  // object precedes the dot.
  "shapeType", "fillColor", "outlineEnabled", "outlineColor", "outlineWidth",
  // Light
  "intensity", "radius", "angle", "castsOnWorld", "castShadows", "shadowColor", "shadowStrength", "flicker", "flickerSpeed", "flickerDuration", "coreSize", "coreVisible",
  // Shadow Caster (this.shadowCaster.* — see ShadowCasterAPI.js). enabled/
  // width/height/offsetX/offsetY/opacity already covered above (Light/
  // Collider/Sprite/Speech Bubble) since this list is matched regardless
  // of which object precedes the dot.
  "length", "softness",
  // Lighting Settings (scene.lighting.* — see LightingSettingsAPI.js).
  // Scene-wide, needs no component.
  "shadowMode", "raymarchSteps", "ambientDarkness", "glowStrength",
  // Stroke Path (this.strokePath.* — see StrokePathAPI.js). color/opacity/
  // radius/width/height are already covered above (Sprite/Collider) since
  // this list is matched regardless of which object precedes the dot.
  "points", "thickness", "useTexture", "textureKey", "textureMode",
  "textureTiling", "textureScale", "textureOffset", "textureFlip", "textureRotation",
  "jointMode", "capMode", "pointCount", "getLength",
  "firstPoint", "lastPoint", "worldToLocal", "localToWorld",
  "getPoint", "setPoint", "addPoint", "insertPoint", "removePoint",
  // Input
  "keyDown", "keyPressed",
  // Mouse
  "isOver", "clickedOn", "screenX", "screenY",
  // Touch — unique enough names are safe to highlight; single-letter/common
  // names (x, y, id, count, first, active) are intentionally left uncolored
  // to avoid false-positives on user variables of the same name.
  // isOver is shared with mouse (listed above); tappedOn is touch-only.
  "tappedOn", "swipe", "pinch", "anyJustStarted", "anyJustEnded",
  "justStarted", "justEnded", "startX", "startY",
  // Lighting Settings sub-object name (scene.lighting.* — see
  // LightingSettingsAPI.js). Grouped with touch's swipe/pinch above:
  // same "nested sub-object name accessed as a member" pattern.
  "lighting",
  // Time
  "deltaTime", "unscaledDeltaTime", "elapsed",
  // Random
  "int", "float",
  // Debug
  "show", "showFps", "log", "clear", "clearAll",
  // Entity-level (this.*, not tied to a sub-object)
  "destroy", "destroyed", "visible", "enabled", "name", "tag", "id", "isClone", "spawn", "wait", "cancelWait", "repeat", "cancelRepeat",
  "isPointerOver", "isClicked", "isTouchOver", "isTapped", "hasComponent", "distanceTo",
  // State machine (this.state.* — needs no component, see StateAPI.js)
  "state", "current", "previous", "change",
  // Finger tracking (this.myTouch.* — needs no component, see TouchTrackAPI.js)
  "myTouch", "active", "startTracking", "stopTracking", "enable", "disable",
  // Audio Listener (this.ear.* — needs an Audio Listener component)
  "ear", "sourcesInRange", "canHear",
  // Save (save.* — persistent IndexedDB storage, see SaveAPI.js).
  // get/set/has/delete/clear/load are already covered by other tiers
  // above (or are common enough to leave uncolored) — only the
  // save-specific names go here.
  "save", "keys", "slot", "listSlots", "deleteSlot", "flushNow", "onError", "isReady",
];

const THEME_NAME = "realot-dark";

let _themeDefined = false;
let _decorationIds = {}; // scriptName -> string[] (last applied decoration ids for that model)

/**
 * Defines the realot-dark theme once. Extends vs-dark's normal
 * palette (keywords, strings, comments, numbers all untouched) and
 * adds three extra token colors for our own classes.
 */
export function defineRealotTheme(monaco) {
  if (_themeDefined) return;
  monaco.editor.defineTheme(THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      // Engine classes/globals (find, scene, physics, input, mouse,
      // touch, time, random, global, debug, sendMessage,
      // broadcastMessage, spawn, wait, cancelWait, repeat,
      // cancelRepeat) — a warm gold, distinct from both keywords
      // (blue) and strings (orange), so they read as "this is a Thing
      // the engine gives you".
      { token: "realot-global", foreground: "e0af68", fontStyle: "bold" },
      // Engine objects (this.sprite, this.rigidbody, etc.) — teal,
      // visually a sibling of the gold globals but clearly a
      // different tier (per-entity, not top-level).
      { token: "realot-object", foreground: "56c2c0", fontStyle: "bold" },
      // Engine methods/properties (.addForce, .keyDown, .position, ...)
      // — a soft, subtle lavender. Deliberately lower-contrast than
      // the two tiers above since these appear constantly and
      // shouldn't visually dominate every line that touches the API.
      { token: "realot-member", foreground: "9d9dc7" },
      // Script lifecycle callbacks — bright violet so the functions that
      // Realot invokes automatically stand out from user functions.
      { token: "realot-lifecycle", foreground: "c586c0", fontStyle: "bold" },
      // The `as` cast keyword — same blue family as JS keywords (it
      // behaves like one in scripts) but italic to mark it as a
      // Realot-specific addition rather than real JavaScript.
      { token: "realot-cast-keyword", foreground: "569cd6", fontStyle: "italic bold" },
      // Cast-target type names (DynamicBody, Animator, SpotLight, …) —
      // a distinct green, the same tier as a type annotation would get
      // in a typed language, since that's exactly what these are.
      { token: "realot-cast-type", foreground: "4ec9b0", fontStyle: "bold" },
    ],
    colors: {},
  });
  _themeDefined = true;
}

/**
 * Scans `model`'s current text for engine identifiers and applies
 * Monaco decorations with the matching realot-* CSS class. Called on
 * every content change (debounced by the caller) and on tab switch.
 *
 * Approach: three passes with word-boundary regexes built from the
 * curated lists above.
 *   - ENGINE_GLOBALS: matched as bare identifiers anywhere (they're
 *     top-level names — as parameters/variables in this scripting
 *     context, they only ever refer to the engine API).
 *   - ENGINE_OBJECTS: matched only right after "this." or ".", since
 *     e.g. "camera" as a bare word could be a user's own variable, but
 *     "this.camera" / "someEntity.camera" is unambiguous.
 *   - ENGINE_MEMBERS: matched only right after a "." (property/method
 *     access position), same reasoning — "velocity" alone could be a
 *     user variable, but ".velocity" is a property read on some object.
 *
 * This is a lightweight lexical scan rather than a full JavaScript parser.
 * It tracks quoted strings, template strings, line comments, and block
 * comments before matching identifiers. This keeps highlighting reliable
 * across Monaco versions: model.getLineTokens() is not part of the public
 * ITextModel API in the Monaco build used by this project.
 */
export function applyRealotDecorations(monaco, editorInstance, model, scriptName) {
  if (!monaco || !editorInstance || !model) return;
  // Guard against a stale scheduled call landing after the editor/model
  // was disposed (e.g. the editor window was closed while a debounced
  // highlight pass was still pending). Without this, deltaDecorations()
  // below throws, the throw is uncaught (this runs off a setTimeout), and
  // _decorationIds[scriptName] never gets updated — leaving that script's
  // coloring silently frozen/stale the next time it's reopened, with no
  // visible error to explain why.
  try {
    if (model.isDisposed && model.isDisposed()) return;
  } catch (e) {
    return;
  }

  // Guard against the tab-switch race: editorInstance is ONE shared
  // Monaco editor reused across every open script tab (see
  // ScriptEditorWindow.js), but `model` here is whichever script this
  // particular scan was FOR — which can be stale by the time a
  // debounced pass like _scheduleHighlighting's 150ms timer actually
  // fires, if the user switched tabs in the meantime. `text` below is
  // read from the right model, but editorInstance.deltaDecorations()
  // always applies to whatever model editorInstance is CURRENTLY
  // showing — so without this check, positions computed from script
  // A's text can get applied as ranges onto script B's model once the
  // user has switched away. That mismatch is what produced the "my
  // whole file turned purple" / "onStateEnter doesn't highlight"
  // reports: real matches in the visible script were getting buried
  // under leftover decorations calculated for a different, no-longer-
  // visible script's text. Bail out here (silently — the tab switch
  // itself already triggered its own immediate, non-debounced
  // applyRealotDecorations call in _switchTab, so this script's coloring
  // is already correct and doesn't need this stale pass at all).
  try {
    if (editorInstance.getModel && editorInstance.getModel() !== model) return;
  } catch (e) {
    return;
  }

  const text = model.getValue();
  const decorations = [];

  function buildCodeMask(source) {
    const mask = new Array(source.length).fill(true);
    let state = "code";
    let quote = "";

    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      const next = source[i + 1];

      if (state === "line-comment") {
        mask[i] = false;
        if (ch === "\n") state = "code";
        continue;
      }
      if (state === "block-comment") {
        mask[i] = false;
        if (ch === "*" && next === "/") {
          mask[i + 1] = false;
          i++;
          state = "code";
        }
        continue;
      }
      if (state === "string") {
        mask[i] = false;
        if (ch === "\\") {
          if (i + 1 < source.length) mask[i + 1] = false;
          i++;
        } else if (ch === quote) {
          state = "code";
        }
        continue;
      }

      if (ch === "/" && next === "/") {
        mask[i] = false;
        mask[i + 1] = false;
        i++;
        state = "line-comment";
      } else if (ch === "/" && next === "*") {
        mask[i] = false;
        mask[i + 1] = false;
        i++;
        state = "block-comment";
      } else if (ch === "'" || ch === '"' || ch === "`") {
        mask[i] = false;
        quote = ch;
        state = "string";
      }
    }
    return mask;
  }

  const codeMask = buildCodeMask(text);

  function addMatches(regex, className) {
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(text))) {
      const word = m[1] || m[0];
      const matchStart = m.index + m[0].lastIndexOf(word);
      let isCode = true;
      for (let i = matchStart; i < matchStart + word.length; i++) {
        if (!codeMask[i]) {
          isCode = false;
          break;
        }
      }
      if (!isCode) continue;
      const pos = model.getPositionAt(matchStart);
      const endPos = model.getPositionAt(matchStart + word.length);
      decorations.push({
        range: new monaco.Range(pos.lineNumber, pos.column, endPos.lineNumber, endPos.column),
        options: { inlineClassName: className },
      });
    }
  }

  const globalsPattern = "\\b(" + ENGINE_GLOBALS.join("|") + ")\\b";
  addMatches(new RegExp(globalsPattern, "g"), "realot-token-global");

  const objectsPattern = "(?:\\bthis\\.|\\.)(" + ENGINE_OBJECTS.join("|") + ")\\b";
  addMatches(new RegExp(objectsPattern, "g"), "realot-token-object");

  const membersPattern = "\\.(" + ENGINE_MEMBERS.join("|") + ")\\b";
  addMatches(new RegExp(membersPattern, "g"), "realot-token-member");

  // this.rigidbody.type / someEntity.rigidbody.type — "type" is deliberately
  // left OUT of ENGINE_MEMBERS above (too generic, would light up any
  // object's own .type field), but this.rigidbody.type specifically is a
  // real, writable Realot API member (see RigidbodyAPI.js's `type`
  // setter), so it gets its own narrowly-scoped pattern: only matched
  // directly after ".rigidbody.", never as a bare ".type".
  const rigidbodyTypePattern = "\\.rigidbody\\s*\\.\\s*(type)\\b";
  addMatches(new RegExp(rigidbodyTypePattern, "g"), "realot-token-member");

  const lifecyclePattern = "\\b(" + ENGINE_LIFECYCLE.join("|") + ")\\b";
  addMatches(new RegExp(lifecyclePattern, "g"), "realot-token-lifecycle");

  // Native `Math`/`Math.<member>` are deliberately left UNCOLORED here —
  // they're plain JavaScript, not Realot API, so they should read as
  // ordinary code (same as Monaco's default JS tokenizer would already
  // show them), not draw attention as if they're something to learn
  // from this engine. `mathx.<member>` right below is the actual
  // Realot-provided math API and stays colored.

  // mathx.<member> (lerp, clamp, moveToward, remap, approximately) — this
  // IS Realot's own API, so it correctly stays on realot-token-member,
  // same tier as .addForce/.keyDown/etc. below.
  const mathxMembersPattern = "\\bmathx\\.(" + MATHX_MEMBERS.join("|") + ")\\b";
  addMatches(new RegExp(mathxMembersPattern, "g"), "realot-token-member");

  // `as` cast keyword — only when it sits between an identifier/`)` and
  // either another identifier or an opening `(`, i.e. actually being used
  // as a cast (`x as Y` / `x as (Y, Z`) rather than matching "as" inside
  // an unrelated word (word-boundary already prevents that) or a comment/
  // string (codeMask already excludes those).
  const castKeywordPattern = "\\b(" + ENGINE_CAST_KEYWORD.join("|") + ")\\s+(?=[A-Za-z_(])";
  addMatches(new RegExp(castKeywordPattern, "g"), "realot-token-cast-keyword");

  // Cast-target type names — matched only right after `as` / `as (` / a
  // comma inside an `as ( … )` list, so a same-named user identifier
  // elsewhere in the file is never miscolored.
  const castTypesAlt = ENGINE_CAST_TYPES.join("|");
  const castTypePattern = "\\bas\\s*\\(?\\s*(?:(?:" + castTypesAlt + ")\\s*,\\s*)*(" + castTypesAlt + ")\\b";
  addMatches(new RegExp(castTypePattern, "g"), "realot-token-cast-type");

  // Applying decorations is wrapped defensively: this runs off a
  // debounced setTimeout (see ScriptEditorWindow.js), so an uncaught
  // throw here (e.g. deltaDecorations() on an editor mid-disposal, a
  // race that used to happen because the close path didn't cancel a
  // pending highlight timer) would silently vanish into the console AND
  // leave _decorationIds[scriptName] stale — the exact "coloring
  // randomly stops working" symptom. Catching it means a single bad
  // pass degrades gracefully (that script just keeps its last-good
  // coloring until the next successful pass) instead of corrupting
  // state that every future call for this script depends on.
  try {
    const prevIds = _decorationIds[scriptName] || [];
    _decorationIds[scriptName] = editorInstance.deltaDecorations(prevIds, decorations);
  } catch (e) {
    console.warn("[Realot Highlighting] decoration pass failed for '" + scriptName + "':", e);
  }
}

/**
 * Drops cached decoration ids for a script — call when a tab/model is
 * disposed so deltaDecorations isn't handed stale ids on next open.
 */
export function clearRealotDecorations(scriptName) {
  delete _decorationIds[scriptName];
}

/**
 * Migrates cached decoration ids from oldName to newName — call
 * whenever a script is renamed (see renameScriptEverywhere() in
 * ScriptEditorWindow.js), right alongside however that caller already
 * migrates its own _models[oldName] -> _models[newName] entry.
 *
 * WHY THIS IS NEEDED: _decorationIds is keyed by script name and lives
 * only in THIS module, so nothing outside it could keep the key in
 * sync with a rename without this export — a rename that moved
 * _models but not this would leave _decorationIds[oldName] holding
 * decoration ids nothing will ever clear (that key is never touched
 * again post-rename), while _decorationIds[newName] starts fresh
 * (empty array), so the NEXT applyRealotDecorations() call for the
 * renamed script does deltaDecorations([], newDecorations) — adding
 * new decorations on top of the still-attached old ones instead of
 * replacing them, since deltaDecorations only removes the ids it's
 * explicitly given. Those orphaned decorations stay attached to the
 * model's (still-live, just renamed) text positions — so typing new
 * content, or deleting everything down to a few characters, leaves
 * old decoration ranges sitting on whatever text is left, including
 * old realot-token-lifecycle purple. That's the exact "rename then type
 * and everything's purple" bug this fixes.
 */
export function renameRealotDecorations(oldName, newName) {
  if (_decorationIds[oldName]) {
    _decorationIds[newName] = _decorationIds[oldName];
    delete _decorationIds[oldName];
  }
}

// Inject the CSS classes the decorations above reference. Monaco's
// inlineClassName only takes effect if the class actually exists in
// the page's stylesheet — these three lines are that stylesheet.
(function injectRealotTokenCSS() {
  if (document.getElementById("realot-token-css")) return;
  var style = document.createElement("style");
  style.id = "realot-token-css";
  style.textContent =
    ".realot-token-global{color:#e0af68!important;font-weight:600;}" +
    ".realot-token-object{color:#56c2c0!important;font-weight:600;}" +
    ".realot-token-member{color:#9d9dc7!important;}" +
    ".realot-token-lifecycle{color:#c586c0!important;font-weight:600;}" +
    ".realot-token-cast-keyword{color:#569cd6!important;font-style:italic;font-weight:600;}" +
    ".realot-token-cast-type{color:#4ec9b0!important;font-weight:600;}";
  document.head.appendChild(style);
})();
