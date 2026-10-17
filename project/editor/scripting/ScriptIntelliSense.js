/**
 * editor/scripting/ScriptIntelliSense.js
 *
 * Registers a Monaco completion provider for Realot scripting APIs.
 * Completions are context-aware: typing `this.` shows only the
 * properties/components valid for the object the active script was
 * opened from. When a script is shared by several objects (opened
 * from the Scripts folder), the union of every owning object's
 * components is offered so every property stays valid no matter which
 * object runs it.
 *
 * Smart string-argument completions:
 *   findWithTag("    → all object tags in the scene
 *   findFirst("      → all entity names in the scene
 *   findAll("        → all entity names in the scene (returns every match)
 *   findFirstWithTag(" → all object tags in the scene
 *   findAllWithTag(" → all object tags in the scene (same list as findWithTag()
 *   scene.load("     → all scene names
 *   scene.findFirst(" → all entity names
 *   input.keyDown("  → full keyboard key-code list
 *   input.keyPressed(" → same
 *   .texture = "     → all sprite/texture asset names
 *   animator.play("  → animation clip names on the context entity
 *   state.change("   → state names already used anywhere in the project
 *   state.current === " → same state-name list as state.change(
 *   save.get("       → save keys already used with save.set() anywhere
 *   save.has("       → same save-key list as save.get(
 *   save.delete("    → same save-key list as save.get(
 *   save.set("       → same save-key list (so a new save mirrors an existing name instead of a near-duplicate)
 *   light.type = "   → all Light types (Directional, Point, Spot, Area, GodRays, Freeform)
 *   shape.shapeType = " → all ShapeRenderer shapes (Square, Circle, Triangle, Capsule)
 *   joint.jointType = " → all Joint2D types (Fixed, Revolute, Prismatic, Rope, Spring)
 *   joint.textureMode = " / strokePath.textureMode = " → stretch | tile (same on both)
 *   text.align = "   → left | center | right
 *   speechBubble.tailDirection = " → down | up | left | right | none
 *   joystick.positionMode = " → Fixed | Dynamic
 *   camera.aspectMode = "     → Landscape | Portrait | Square | Custom
 *   camera.scalingMode = "    → Expand | Fit | Fill | Stretch
 *   strokePath.jointMode = "  → sharp | bevel | round
 *   strokePath.capMode = "    → none | box | round
 *   controller.controllerType === " → all Controller types (read-only field, comparison only)
 *   controller.patrolMode = "      → Platformer | Top-Down
 *   controller.patrolAxis = "      → Horizontal | Vertical
 *   sendMessage("    → all unique entity tags in the scene
 *   spawn("          → all entity names in the scene (spawn(name) clones it)
 *   mouse.isOver("   → all entity names (mouse.clickedOn(" too)
 *   touch.isOver("   → all entity names (touch.tappedOn(" too)
 *   .name === "      → all entity names
 *   .tag === "       → all entity tags
 *   .name == "       → all entity names
 *
 * Typing a global name shows only safe engine APIs (never document,
 * window, localStorage, etc.).
 *
 * Unknown-type variables (a variable whose origin this file can't
 * infer, e.g. `const enemy = randomEnemy();`) get a small, safe
 * completion set — Base Object members plus Cast/Check-Component
 * helpers — instead of the full engine API. See
 * ScriptTypeInference.js for cast (`as Type` / `as (A, B)`) and
 * component-narrowing (`if (x.hasComponent("Key")) { }`) tracking.
 *
 * EDITOR-ONLY FILE.
 */

import { editorState } from "../state/EditorState.js";
import { TRANSFORM } from "../../runtime/components/Transform.js";
import { SPRITE_RENDERER } from "../../runtime/components/SpriteRenderer.js";
import { SHAPE_RENDERER, ShapeType } from "../../runtime/components/ShapeRenderer.js";
import { TEXT_RENDERER } from "../../runtime/components/TextRenderer.js";
import { SPEECH_BUBBLE } from "../../runtime/components/SpeechBubble.js";
import { CHAT_LOG } from "../../runtime/components/ChatLog.js";
import { TEXT_INPUT } from "../../runtime/components/TextInput.js";
import { JOYSTICK, JoystickPositionMode } from "../../runtime/components/Joystick.js";
import { RIGIDBODY_2D, BodyType } from "../../runtime/components/Rigidbody2D.js";
import { COLLIDER_2D } from "../../runtime/components/Collider2D.js";
import { JOINT_2D, JointType2D } from "../../runtime/components/Joint2D.js";
import { NAV_AGENT_2D } from "../../runtime/components/NavAgent2D.js";
import { CAMERA, CameraAspectMode, ScalingMode } from "../../runtime/components/Camera.js";
import { AUDIO_SOURCE } from "../../runtime/components/AudioSource.js";
import { AUDIO_LISTENER } from "../../runtime/components/AudioListener.js";
import { SPRITE_ANIMATION } from "../../runtime/components/SpriteAnimation.js";
import { CHARACTER_CONTROLLER, ControllerType, PatrolMode, PatrolAxis } from "../../runtime/components/CharacterController.js";
import { LIGHT, LightType } from "../../runtime/components/Light.js";
import { SHADOW_CASTER } from "../../runtime/components/ShadowCaster.js";
import { STROKE_PATH, StrokePathJointMode, StrokePathCapMode } from "../../runtime/components/StrokePath.js";
import { getAllSpriteAssets, getAllAudioAssets } from "../../runtime/assets/AssetRegistry.js";
import { getSceneList } from "../../runtime/scene/SceneManager.js";
import { getAllScripts, getScriptSource } from "./ScriptStorage.js";
import { NAV_API_OPTION_FIELDS } from "../../runtime/scripting/NavAPI.js";
import { TWEEN_EASING_NAMES } from "../../runtime/scripting/TweenEasing.js";
import { getNamedNavAreas } from "../state/NavAreas.js";
import {
  BASE_OBJECT_API,
  UNKNOWN_HELPER_API,
  findCastTarget,
  getCastTargetNames,
  parseCastVariables,
  detectCastPosition,
  usedCastNames,
  getNarrowedType,
} from "./ScriptTypeInference.js";

let _registered = false;

// ─── Keyboard key codes ─────────────────────────────────────────────────────
// Full list of browser KeyboardEvent.code values the engine's input system
// accepts. Shown when the user types input.keyDown(" or input.keyPressed(".
const ALL_KEY_CODES = [
  // Letters
  "KeyA","KeyB","KeyC","KeyD","KeyE","KeyF","KeyG","KeyH","KeyI","KeyJ",
  "KeyK","KeyL","KeyM","KeyN","KeyO","KeyP","KeyQ","KeyR","KeyS","KeyT",
  "KeyU","KeyV","KeyW","KeyX","KeyY","KeyZ",
  // Digits
  "Digit0","Digit1","Digit2","Digit3","Digit4",
  "Digit5","Digit6","Digit7","Digit8","Digit9",
  // Numpad
  "Numpad0","Numpad1","Numpad2","Numpad3","Numpad4",
  "Numpad5","Numpad6","Numpad7","Numpad8","Numpad9",
  "NumpadAdd","NumpadSubtract","NumpadMultiply","NumpadDivide",
  "NumpadDecimal","NumpadEnter","NumLock",
  // Arrows
  "ArrowLeft","ArrowRight","ArrowUp","ArrowDown",
  // Modifiers
  "ShiftLeft","ShiftRight","ControlLeft","ControlRight",
  "AltLeft","AltRight","MetaLeft","MetaRight","CapsLock",
  // Common specials
  "Space","Enter","Escape","Backspace","Tab","Delete","Insert",
  "Home","End","PageUp","PageDown","ContextMenu",
  // Function keys
  "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12",
  // Punctuation / symbols
  "Comma","Period","Slash","Backslash","Semicolon","Quote",
  "BracketLeft","BracketRight","Backquote","Minus","Equal",
  // Short-letter aliases (also valid key codes)
  "a","b","c","d","e","f","g","h","i","j","k","l","m",
  "n","o","p","q","r","s","t","u","v","w","x","y","z",
  " ",  // Space as a character
  // Wildcard — matches ANY currently-held/just-pressed key (see
  // input.keyDown/keyPressed in ScriptAPI.js). Listed last so the real,
  // specific key codes above always sort/show first.
  "Any",
];

// Human-readable descriptions for the most common keys shown as detail.
const KEY_DETAIL = {
  Space: "Spacebar", Enter: "Enter / Return", Escape: "Escape",
  Backspace: "Backspace", Tab: "Tab", Delete: "Delete",
  ArrowLeft: "← Left arrow", ArrowRight: "→ Right arrow",
  ArrowUp: "↑ Up arrow", ArrowDown: "↓ Down arrow",
  ShiftLeft: "Left Shift", ShiftRight: "Right Shift",
  ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl",
  AltLeft: "Left Alt", AltRight: "Right Alt",
  Any: "Wildcard — true if ANY key is currently held/was just pressed (e.g. a \"press any key to continue\" prompt)",
};

// ─── API definitions ─────────────────────────────────────────────────────────

const TRANSFORM_API = [
  { label: "position", detail: "{ x, y } — get/set position as an object", insert: "position", kind: "Property" },
  { label: "rotation", detail: "Rotation in degrees (read/write)", insert: "rotation", kind: "Property" },
  { label: "scale", detail: "{ x, y } — get/set scale as an object", insert: "scale", kind: "Property" },
  { label: "translate(dx, dy)", detail: "Move by a delta amount this frame", insert: "translate(${1:dx}, ${2:dy})", kind: "Method", snippet: true },
  { label: "lookAt(x, y)", detail: "Rotate to face a world-space point", insert: "lookAt(${1:x}, ${2:y})", kind: "Method", snippet: true },
];

const SPRITE_API = [
  { label: "texture", detail: "Sprite texture key (string) — the asset name shown in the Inspector", insert: "texture", kind: "Property" },
  { label: "color", detail: 'Tint color as hex string, e.g. "#ff0000" for red', insert: 'color = "#', kind: "Property" },
  { label: "flipX", detail: "Flip sprite horizontally (boolean)", insert: "flipX = ", kind: "Property" },
  { label: "flipY", detail: "Flip sprite vertically (boolean)", insert: "flipY = ", kind: "Property" },
  { label: "opacity", detail: "Transparency: 0.0 (invisible) to 1.0 (fully visible)", insert: "opacity = ", kind: "Property" },
];

// Properties shared by every shape type.
const SHAPE_API_COMMON = [
  { label: "shapeType", detail: "'Square' | 'Circle' | 'Capsule' | 'Triangle'", insert: 'shapeType = "', kind: "Property" },
  { label: "fillColor", detail: 'Fill color as hex string, e.g. "#3a8ede"', insert: 'fillColor = "#', kind: "Property" },
  { label: "opacity", detail: "Transparency: 0.0 (invisible) to 1.0 (fully visible)", insert: "opacity = ", kind: "Property" },
  { label: "outlineEnabled", detail: "Whether the outline stroke is drawn around the shape (boolean)", insert: "outlineEnabled = ", kind: "Property" },
  { label: "outlineColor", detail: 'Outline stroke color as hex string, e.g. "#ffffff"', insert: 'outlineColor = "#', kind: "Property" },
  { label: "outlineWidth", detail: "Outline stroke width in px", insert: "outlineWidth = ", kind: "Property" },
];
// Per-type: only fields actually used by that shapeType are offered so the
// user never sees e.g. radius on a Square or width on a Circle.
const SHAPE_API_SQUARE   = SHAPE_API_COMMON.concat([
  { label: "width", detail: "Square width in world units", insert: "width = ", kind: "Property" },
  { label: "height", detail: "Square height in world units", insert: "height = ", kind: "Property" },
]);
const SHAPE_API_CIRCLE   = SHAPE_API_COMMON.concat([
  { label: "radius", detail: "Circle radius in world units", insert: "radius = ", kind: "Property" },
]);
const SHAPE_API_CAPSULE  = SHAPE_API_COMMON.concat([
  { label: "capsuleHalfHeight", detail: "Capsule half-height (principal axis is Y — a vertical pill)", insert: "capsuleHalfHeight = ", kind: "Property" },
  { label: "capsuleRadius", detail: "Capsule radius", insert: "capsuleRadius = ", kind: "Property" },
]);
const SHAPE_API_TRIANGLE = SHAPE_API_COMMON; // trianglePoints is editor-only

// Full list used by hover docs (covers all types in one place).
const SHAPE_API = SHAPE_API_COMMON.concat([
  { label: "width", detail: "Square width in world units", insert: "width = ", kind: "Property" },
  { label: "height", detail: "Square height in world units", insert: "height = ", kind: "Property" },
  { label: "radius", detail: "Circle radius in world units", insert: "radius = ", kind: "Property" },
  { label: "capsuleHalfHeight", detail: "Capsule half-height (principal axis is Y — a vertical pill)", insert: "capsuleHalfHeight = ", kind: "Property" },
  { label: "capsuleRadius", detail: "Capsule radius", insert: "capsuleRadius = ", kind: "Property" },
]);

const TEXT_API = [
  { label: "value", detail: "The actual string shown on screen — set this to change the text, e.g. this.text.value = \"Score: \" + global.score", insert: "value = ", kind: "Property" },
  { label: "fontSize", detail: "Text size in px", insert: "fontSize = ", kind: "Property" },
  { label: "color", detail: 'Text color as hex string, e.g. "#ffffff" for white', insert: 'color = "#', kind: "Property" },
  { label: "fontFamily", detail: 'Font name, e.g. "Arial"', insert: 'fontFamily = "', kind: "Property" },
  { label: "bold", detail: "Bold text (boolean)", insert: "bold = ", kind: "Property" },
  { label: "italic", detail: "Italic text (boolean)", insert: "italic = ", kind: "Property" },
  { label: "align", detail: '\'left\' | \'center\' | \'right\' — multi-line text alignment', insert: 'align = "', kind: "Property" },
  { label: "anchorX", detail: "0–1, this text's own horizontal pivot point (0.5 = centered on this.x)", insert: "anchorX = ", kind: "Property" },
  { label: "anchorY", detail: "0–1, this text's own vertical pivot point (0.5 = centered on this.y)", insert: "anchorY = ", kind: "Property" },
  { label: "opacity", detail: "Transparency: 0.0 (invisible) to 1.0 (fully visible)", insert: "opacity = ", kind: "Property" },
  { label: "screenSpace", detail: "true = fixed UI overlay (this.x/this.y are raw screen pixels, ignores camera). false = world-space, pans/zooms like a sprite.", insert: "screenSpace = ", kind: "Property" },
  { label: "wordWrap", detail: "Wrap long lines at wrapWidth (boolean)", insert: "wordWrap = ", kind: "Property" },
  { label: "wrapWidth", detail: "Px width the text wraps at — only used while wordWrap is true", insert: "wrapWidth = ", kind: "Property" },
];

const SPEECH_BUBBLE_API = [
  { label: "text", detail: "The text shown inside the bubble (read/write). Prefer show(text) if you also want it to become visible.", insert: "text = ", kind: "Property" },
  { label: "visible", detail: "Whether the bubble is currently shown (boolean, read/write)", insert: "visible = ", kind: "Property" },
  { label: "backgroundColor", detail: 'Bubble fill color as hex string, e.g. "#ffffff"', insert: 'backgroundColor = "#', kind: "Property" },
  { label: "textColor", detail: 'Text color as hex string, e.g. "#111111"', insert: 'textColor = "#', kind: "Property" },
  { label: "borderColor", detail: 'Bubble outline color as hex string', insert: 'borderColor = "#', kind: "Property" },
  { label: "borderWidth", detail: "Bubble outline thickness in px (0 = no outline)", insert: "borderWidth = ", kind: "Property" },
  { label: "fontSize", detail: "Text size in px", insert: "fontSize = ", kind: "Property" },
  { label: "fontFamily", detail: 'Font name, e.g. "Arial"', insert: 'fontFamily = "', kind: "Property" },
  { label: "padding", detail: "Px gap between the text and the bubble's edge", insert: "padding = ", kind: "Property" },
  { label: "cornerRadius", detail: "Bubble corner roundness in px", insert: "cornerRadius = ", kind: "Property" },
  { label: "maxWidth", detail: "Px width the text wraps at inside the bubble", insert: "maxWidth = ", kind: "Property" },
  { label: "offsetX", detail: "Px offset from this entity's own position — where the bubble sits horizontally", insert: "offsetX = ", kind: "Property" },
  { label: "offsetY", detail: "Px offset from this entity's own position — negative = above the entity (default)", insert: "offsetY = ", kind: "Property" },
  { label: "tailDirection", detail: "'down' | 'up' | 'left' | 'right' | 'none' — which edge the little pointer sits on", insert: 'tailDirection = "', kind: "Property" },
  { label: "tailSize", detail: "Size in px of the little pointer triangle", insert: "tailSize = ", kind: "Property" },
  { label: "show(text, duration)", detail: 'Shows the bubble with this text. Pass a duration in seconds to auto-hide, e.g. this.speechBubble.show("Watch out!", 2) — omit it to leave the bubble showing until hide().', insert: "show(${1:text})", kind: "Method", snippet: true },
  { label: "hide()", detail: "Hides the bubble immediately.", insert: "hide()", kind: "Method" },
];

const CHAT_LOG_API = [
  { label: "messages", detail: "Read-only snapshot of the message history (oldest first), each { sender, text, senderColor }. Use send() to add — don't push onto this directly.", insert: "messages", kind: "Property" },
  { label: "maxMessages", detail: "Total history kept — oldest messages are dropped automatically once exceeded", insert: "maxMessages = ", kind: "Property" },
  { label: "visibleCount", detail: "How many of the most recent messages are shown at once", insert: "visibleCount = ", kind: "Property" },
  { label: "width", detail: "Panel width in px", insert: "width = ", kind: "Property" },
  { label: "lineHeight", detail: "Px vertical spacing between message rows", insert: "lineHeight = ", kind: "Property" },
  { label: "fontSize", detail: "Text size in px", insert: "fontSize = ", kind: "Property" },
  { label: "fontFamily", detail: 'Font name, e.g. "Arial"', insert: 'fontFamily = "', kind: "Property" },
  { label: "messageColor", detail: 'Message text color as hex string', insert: 'messageColor = "#', kind: "Property" },
  { label: "senderColor", detail: 'Default sender-name color as hex string — used when send() isn\'t given its own color', insert: 'senderColor = "#', kind: "Property" },
  { label: "backgroundColor", detail: 'Panel background color as hex string', insert: 'backgroundColor = "#', kind: "Property" },
  { label: "backgroundOpacity", detail: "Panel background transparency: 0.0 (invisible) to 1.0 (solid)", insert: "backgroundOpacity = ", kind: "Property" },
  { label: "padding", detail: "Px gap between the messages and the panel's edge", insert: "padding = ", kind: "Property" },
  { label: "showSender", detail: "false = just the message text, no \"Name: \" prefix (good for narration-only logs)", insert: "showSender = ", kind: "Property" },
  { label: "screenSpace", detail: "true = fixed UI overlay (ignores camera). false = world-space, pans/zooms like a sprite.", insert: "screenSpace = ", kind: "Property" },
  { label: "visible", detail: "Whether the panel is currently shown (boolean, read/write)", insert: "visible = ", kind: "Property" },
  { label: "send(sender, text, color)", detail: 'Appends a message to the log — the normal way to use this: this.chat.send("Alex", "hey, you online?"). Oldest messages are dropped automatically once maxMessages is exceeded.', insert: "send(${1:sender}, ${2:text})", kind: "Method", snippet: true },
  { label: "clear()", detail: "Empties the whole message history.", insert: "clear()", kind: "Method" },
];

const TEXT_INPUT_API = [
  { label: "value", detail: "The text currently typed into the field (read/write). Setting it won't fight the player's keystrokes while they're actively focused/typing.", insert: "value", kind: "Property" },
  { label: "placeholder", detail: "Hint text shown when the field is empty and not focused", insert: 'placeholder = "', kind: "Property" },
  { label: "maxLength", detail: "Max characters the player can type", insert: "maxLength = ", kind: "Property" },
  { label: "fontSize", detail: "Text size in px", insert: "fontSize = ", kind: "Property" },
  { label: "fontFamily", detail: 'Font name, e.g. "Arial"', insert: 'fontFamily = "', kind: "Property" },
  { label: "textColor", detail: 'Typed text color as hex string', insert: 'textColor = "#', kind: "Property" },
  { label: "placeholderColor", detail: 'Hint text color as hex string', insert: 'placeholderColor = "#', kind: "Property" },
  { label: "backgroundColor", detail: 'Field background color as hex string', insert: 'backgroundColor = "#', kind: "Property" },
  { label: "borderColor", detail: 'Field outline color as hex string', insert: 'borderColor = "#', kind: "Property" },
  { label: "borderWidth", detail: "Field outline thickness in px (0 = no outline)", insert: "borderWidth = ", kind: "Property" },
  { label: "cornerRadius", detail: "Field corner roundness in px", insert: "cornerRadius = ", kind: "Property" },
  { label: "width", detail: "Field width in px", insert: "width = ", kind: "Property" },
  { label: "height", detail: "Field height in px", insert: "height = ", kind: "Property" },
  { label: "padding", detail: "Px gap between the text and the field's edge", insert: "padding = ", kind: "Property" },
  { label: "clearOnSubmit", detail: "true = the field empties itself automatically right after Enter (typical chat-box behavior)", insert: "clearOnSubmit = ", kind: "Property" },
  { label: "focused", detail: "True while the player is actively typing into this field (read-only)", insert: "focused", kind: "Property" },
  { label: "justSubmitted", detail: "True for exactly one frame right after the player presses Enter — read this.textInput.value the same frame to see what they typed (read-only)", insert: "justSubmitted", kind: "Property" },
  { label: "clear()", detail: "Empties the field immediately.", insert: "clear()", kind: "Method" },
];

const JOYSTICK_API = [
  { label: "x", detail: "-1..1 horizontal knob offset, right = positive (read-only, after dead zone)", insert: "x", kind: "Property" },
  { label: "y", detail: "-1..1 vertical knob offset, down = positive (read-only, after dead zone)", insert: "y", kind: "Property" },
  { label: "magnitude", detail: "0..1 distance the knob is pushed from center, after dead zone (read-only)", insert: "magnitude", kind: "Property" },
  { label: "angle", detail: "Degrees, 0 = right, 90 = down — direction the knob is pushed (read-only, holds last value at magnitude 0)", insert: "angle", kind: "Property" },
  { label: "active", detail: "True while a finger/mouse is actively dragging this joystick right now (read-only)", insert: "active", kind: "Property" },
  { label: "positionMode", detail: '"Fixed" (stays at Transform position) or "Dynamic" (appears wherever pressed inside the touch region)', insert: 'positionMode = "', kind: "Property" },
  { label: "regionX", detail: "Dynamic-mode touchable region: left edge, in screen px", insert: "regionX = ", kind: "Property" },
  { label: "regionY", detail: "Dynamic-mode touchable region: top edge, in screen px", insert: "regionY = ", kind: "Property" },
  { label: "regionWidth", detail: "Dynamic-mode touchable region: width in px", insert: "regionWidth = ", kind: "Property" },
  { label: "regionHeight", detail: "Dynamic-mode touchable region: height in px", insert: "regionHeight = ", kind: "Property" },
  { label: "baseRadius", detail: "Base circle radius in px — also how far the knob can travel", insert: "baseRadius = ", kind: "Property" },
  { label: "knobRadius", detail: "Knob circle radius in px", insert: "knobRadius = ", kind: "Property" },
  { label: "baseColor", detail: "Base circle color as hex string", insert: 'baseColor = "#', kind: "Property" },
  { label: "baseOpacity", detail: "Base circle transparency: 0.0 (invisible) to 1.0 (solid)", insert: "baseOpacity = ", kind: "Property" },
  { label: "knobColor", detail: "Knob circle color as hex string", insert: 'knobColor = "#', kind: "Property" },
  { label: "knobOpacity", detail: "Knob circle transparency: 0.0 (invisible) to 1.0 (solid)", insert: "knobOpacity = ", kind: "Property" },
  { label: "outlineColor", detail: "Base/knob outline color as hex string", insert: 'outlineColor = "#', kind: "Property" },
  { label: "outlineWidth", detail: "Outline thickness in px (0 = no outline)", insert: "outlineWidth = ", kind: "Property" },
  { label: "deadZone", detail: "0..1: fraction of baseRadius the knob must move before x/y leaves 0", insert: "deadZone = ", kind: "Property" },
  { label: "returnToCenter", detail: "true = knob snaps back to center on release; false = holds its last position", insert: "returnToCenter = ", kind: "Property" },
  { label: "hideWhenIdle", detail: "true = invisible until actively being dragged", insert: "hideWhenIdle = ", kind: "Property" },
  { label: "idleOpacityMultiplier", detail: "When hideWhenIdle is false, how much to dim the whole stick while idle (1 = no dimming)", insert: "idleOpacityMultiplier = ", kind: "Property" },
];

const RIGIDBODY_API_COMMON = [
  { label: "velocity", detail: "{ x, y } — velocity vector", insert: "velocity", kind: "Property" },
  { label: "velocityX", detail: "Horizontal velocity (px/s)", insert: "velocityX = ", kind: "Property" },
  { label: "velocityY", detail: "Vertical velocity (px/s, positive = down)", insert: "velocityY = ", kind: "Property" },
  { label: "type", detail: "'Dynamic' | 'Kinematic' | 'Static' — switches the body live (read/write). Takes effect next physics step; force/impulse/move requests queued before the switch are dropped, ones queued after (same tick is fine) apply to the new body. Velocity is NOT reset by the switch itself — see this.rigidbody.velocity.", insert: "type = \"", kind: "Property" },
];
const RIGIDBODY_API_DYNAMIC = RIGIDBODY_API_COMMON.concat([
  { label: "mass", detail: "Body mass (affects force/impulse results)", insert: "mass = ", kind: "Property" },
  { label: "autoMass", detail: "Dynamic Rigidbody2D: calculate mass from attached collider geometry and density", insert: "autoMass = ", kind: "Property" },
  { label: "gravityScale", detail: "Gravity multiplier (1 = normal, 0 = no gravity)", insert: "gravityScale = ", kind: "Property" },
  { label: "linearDamping", detail: "Linear drag — slows the body over time", insert: "linearDamping = ", kind: "Property" },
  { label: "angularDamping", detail: "Rotational drag", insert: "angularDamping = ", kind: "Property" },
  { label: "addForce(x, y)", detail: "Continuous force — call every frame in onUpdate to sustain a push", insert: "addForce(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "addImpulse(x, y)", detail: "One-shot velocity kick — call once (e.g. in onCollision or a jump)", insert: "addImpulse(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "addTorque(t)", detail: "Continuous spin force — call every frame to sustain rotation", insert: "addTorque(${1:t})", kind: "Method", snippet: true },
  { label: "addAngularImpulse(t)", detail: "One-shot angular velocity kick", insert: "addAngularImpulse(${1:t})", kind: "Method", snippet: true },
  { label: "isGrounded", detail: "True when this Dynamic body's own Character Controller (if any) has computed it as grounded this frame (read-only). Reads false with no Character Controller component attached — a plain Dynamic body has no ground-contact concept on its own. NOTE: no isOnWall/isOnCeiling/isOnSlope/groundAngle equivalent exists for Dynamic — use this.controller for those.", insert: "isGrounded", kind: "Property" },
  { label: "grounded", detail: "Deprecated alias for isGrounded — same value, kept for compatibility with existing scripts (read-only). Prefer isGrounded.", insert: "grounded", kind: "Property" },
]);
const RIGIDBODY_API_KINEMATIC = RIGIDBODY_API_COMMON.concat([
  { label: "move(dx, dy)", detail: "One-shot swept move this frame — blocked/slid by obstacles just like velocity", insert: "move(${1:dx}, ${2:dy})", kind: "Method", snippet: true },
  { label: "isGrounded", detail: "True when the character controller is touching the ground (read-only)", insert: "isGrounded", kind: "Property" },
  { label: "grounded", detail: "Deprecated alias for isGrounded — same value, kept for compatibility with existing scripts (read-only). Prefer isGrounded.", insert: "grounded", kind: "Property" },
  { label: "isOnCeiling", detail: "True when touching a ceiling surface above (read-only)", insert: "isOnCeiling", kind: "Property" },
  { label: "isOnWall", detail: "True when touching a wall — only fires for surfaces steeper than wallAngleLimit (read-only)", insert: "isOnWall", kind: "Property" },
  { label: "isOnSlope", detail: "True when grounded on a slope steeper than slopeMinAngle (read-only)", insert: "isOnSlope", kind: "Property" },
  { label: "groundAngle", detail: "Live angle (deg) of the steepest walkable ground contact this step — 0 = flat floor (read-only)", insert: "groundAngle", kind: "Property" },
  { label: "resolvedVelocity", detail: "{ x, y } — actual movement this step after collisions (read-only)", insert: "resolvedVelocity", kind: "Property" },
  { label: "groundAngleLimit", detail: "Max angle from horizontal (deg) that counts as walkable ground — default 45", insert: "groundAngleLimit = ", kind: "Property" },
  { label: "wallAngleLimit", detail: "Min angle (deg) before a surface counts as a wall — default 70", insert: "wallAngleLimit = ", kind: "Property" },
  { label: "slopeMinAngle", detail: "Min angle (deg) before isOnSlope fires — default 10. Must be at or below groundAngleLimit for a surface to report both states; equality is inclusive.", insert: "slopeMinAngle = ", kind: "Property" },
]);
const RIGIDBODY_API_STATIC = [
  { label: "type", detail: "'Static' — body never moves on its own. Read/write: set this.rigidbody.type = \"Dynamic\" or \"Kinematic\" (from a script) or change Body Type in the Inspector to make it move.", insert: "type = \"", kind: "Property" },
  { label: "velocity", detail: "Always { x:0, y:0 } — static bodies never move", insert: "velocity", kind: "Property" },
];

const CONTROLLER_API_WALK_COMMON = [
  { label: "controllerType", detail: "'Character Controller' | 'Platformer' | 'Top-Down' (read-only)", insert: "controllerType", kind: "Property" },
  { label: "moveSpeed", detail: "Horizontal move speed in px/s", insert: "moveSpeed = ", kind: "Property" },
  { label: "acceleration", detail: "How fast velocity approaches target speed (higher = snappier)", insert: "acceleration = ", kind: "Property" },
  { label: "airControl", detail: "0-1 multiplier on acceleration while airborne", insert: "airControl = ", kind: "Property" },
  { label: "useGravity", detail: "Whether gravity applies (always true for Platformer, always false for Top-Down)", insert: "useGravity = ", kind: "Property" },
  { label: "gravityScale", detail: "Multiplier on gravity's strength (1 = normal, 2 = falls 2x as fast, 0.5 = floaty, 0 = no fall) — Character Controller/Platformer only, no effect on Top-Down", insert: "gravityScale = ", kind: "Property" },
  { label: "useDefaultInput", detail: "Whether WASD/Arrows are wired automatically — turn off to drive movement entirely from script", insert: "useDefaultInput = ", kind: "Property" },
  { label: "simulateMove(x, y)", detail: "Add movement from script/joystick; with useDefaultInput on it combines with WASD/Arrows — x/y are -1 to 1", insert: "simulateMove(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "isGrounded", detail: "True when touching the ground (read-only)", insert: "isGrounded", kind: "Property" },
  { label: "isOnCeiling", detail: "True when touching a ceiling surface above (read-only)", insert: "isOnCeiling", kind: "Property" },
  { label: "isOnWall", detail: "True when touching a wall surface steeper than wallAngleLimit (read-only)", insert: "isOnWall", kind: "Property" },
  { label: "isOnSlope", detail: "True when grounded on a slope steeper than slopeMinAngle (read-only)", insert: "isOnSlope", kind: "Property" },
  { label: "groundAngle", detail: "Live angle (deg) of the steepest walkable ground contact this step (read-only)", insert: "groundAngle", kind: "Property" },
];
const CONTROLLER_API_JUMPABLE = CONTROLLER_API_WALK_COMMON.concat([
  { label: "canJump", detail: "Whether jump is enabled", insert: "canJump = ", kind: "Property" },
  { label: "jumpForce", detail: "Upward velocity applied on jump (px/s)", insert: "jumpForce = ", kind: "Property" },
  { label: "maxJumps", detail: "1 = no double jump, 2 = double jump, etc.", insert: "maxJumps = ", kind: "Property" },
  { label: "simulateJump()", detail: "Trigger a jump from script, same as pressing Space — respects canJump/maxJumps", insert: "simulateJump()", kind: "Method" },
]);
const CONTROLLER_API_CHARACTER = CONTROLLER_API_JUMPABLE;
const CONTROLLER_API_PLATFORMER = CONTROLLER_API_JUMPABLE;
const CONTROLLER_API_TOP_DOWN = CONTROLLER_API_WALK_COMMON;
const CONTROLLER_API_CAR = [
  { label: "controllerType", detail: "'Car' (read-only)", insert: "controllerType", kind: "Property" },
  { label: "maxSpeed", detail: "Top forward speed in px/s (reverse caps at half this)", insert: "maxSpeed = ", kind: "Property" },
  { label: "acceleration", detail: "How fast the car speeds up (px/s²)", insert: "acceleration = ", kind: "Property" },
  { label: "brakeForce", detail: "How fast it brakes / goes into reverse (px/s²)", insert: "brakeForce = ", kind: "Property" },
  { label: "turnSpeed", detail: "Max turn rate in deg/s at full speed (scales down at lower speeds)", insert: "turnSpeed = ", kind: "Property" },
  { label: "driftFactor", detail: "0-1: how much lateral velocity is retained (higher = more slide)", insert: "driftFactor = ", kind: "Property" },
  { label: "driveTowardArriveDistance", detail: "Px from the target that counts as arrived for simulateDriveToward()/this.navDriveToward() — coasts to a stop inside this radius", insert: "driveTowardArriveDistance = ", kind: "Property" },
  { label: "useDefaultInput", detail: "Whether WASD/Arrows (throttle/brake/steer) are wired automatically — turn off to drive it from script via simulateDrive", insert: "useDefaultInput = ", kind: "Property" },
  { label: "simulateDrive(throttle, steer)", detail: "Add throttle/steer from script or joystick; with useDefaultInput on it combines with WASD/Arrows — values are -1 to 1", insert: "simulateDrive(${1:throttle}, ${2:steer})", kind: "Method", snippet: true },
  { label: "simulateDriveJoystick(x, y)", detail: "Car directional joystick: joystick angle controls smooth steering toward the stick direction; magnitude controls acceleration. x/y are -1 to 1", insert: "simulateDriveJoystick(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "simulateDriveToward(x, y)", detail: "Drive/drift toward a world point like a chase-car NPC: accelerates, steers, brakes on approach, and reverses instead of turning around when the point is behind the car. Uses this Car's maxSpeed/acceleration/brakeForce/turnSpeed/driftFactor.", insert: "simulateDriveToward(${1:x}, ${2:y})", kind: "Method", snippet: true },
];
const CONTROLLER_API_FOLLOW = [
  { label: "controllerType", detail: "'Follow' (read-only)", insert: "controllerType", kind: "Property" },
  { label: "targetName", detail: "Name of the entity to pursue", insert: 'targetName = "', kind: "Property" },
  { label: "followSpeed", detail: "Pursuit speed in px/s", insert: "followSpeed = ", kind: "Property" },
  { label: "followDistance", detail: "Stop when within this many pixels of the target", insert: "followDistance = ", kind: "Property" },
];
const CONTROLLER_API_PATROL = [
  { label: "controllerType", detail: "'Patrol' (read-only)", insert: "controllerType", kind: "Property" },
  { label: "patrolMode", detail: "Patrol movement mode — \"Platformer\" uses gravity and horizontal walking; \"Top-Down\" removes gravity and follows patrolAxis", insert: 'patrolMode = "', kind: "Property" },
  { label: "patrolAxis", detail: "Patrol axis used by \"Top-Down\" mode — \"Horizontal\" or \"Vertical\". Ignored in Platformer mode", insert: 'patrolAxis = "', kind: "Property" },
  { label: "moveSpeed", detail: "Horizontal walk speed in px/s", insert: "moveSpeed = ", kind: "Property" },
  { label: "acceleration", detail: "How fast velocity approaches target speed (higher = snappier)", insert: "acceleration = ", kind: "Property" },
  { label: "patrolDistance", detail: "Px to walk before auto-turning, if nothing else (a wall) turns it first", insert: "patrolDistance = ", kind: "Property" },
  { label: "useDefaultInput", detail: "Whether Patrol auto-walks/auto-turns on its own — turn off to drive it entirely from script via simulateMove", insert: "useDefaultInput = ", kind: "Property" },
  { label: "simulateMove(x, y)", detail: "Add scripted movement to Patrol; with useDefaultInput on it combines with auto-walk — x is -1 to 1, y is ignored", insert: "simulateMove(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "flipDirection()", detail: "Force an immediate turn, works whether useDefaultInput is on or off — e.g. turn around the moment the player is spotted", insert: "flipDirection()", kind: "Method", snippet: true },
  { label: "facingDirection", detail: "-1 (left) or 1 (right) — current walk direction (read-only)", insert: "facingDirection", kind: "Property" },
  { label: "isGrounded", detail: "True when touching the ground (read-only)", insert: "isGrounded", kind: "Property" },
  { label: "isOnWall", detail: "True when touching a wall — this is one of the turn triggers (read-only)", insert: "isOnWall", kind: "Property" },
  { label: "isOnCeiling", detail: "True when touching a ceiling surface above (read-only)", insert: "isOnCeiling", kind: "Property" },
  { label: "isOnSlope", detail: "True when grounded on a slope steeper than slopeMinAngle (read-only)", insert: "isOnSlope", kind: "Property" },
  { label: "groundAngle", detail: "Live angle (deg) of the steepest walkable ground contact this step (read-only)", insert: "groundAngle", kind: "Property" },
];
const CONTROLLER_API_FREE = [
  { label: "controllerType", detail: "'Free' — fully script-driven. Drive this.rigidbody directly.", insert: "controllerType", kind: "Property" },
];

const ANIMATOR_API = [
  { label: "play(clipName)", detail: "Play a named animation clip", insert: 'play("', kind: "Method" },
  { label: "stop()", detail: "Stop the current animation", insert: "stop()", kind: "Method" },
  { label: "playing", detail: "True while an animation is playing (read-only)", insert: "playing", kind: "Property" },
  { label: "currentClip", detail: "Name of the currently active clip (read-only)", insert: "currentClip", kind: "Property" },
  { label: "currentFrame", detail: "Index (0-based) of the frame currently showing. Read/write — assign to jump to a specific frame.", insert: "currentFrame", kind: "Property" },
  { label: "totalFrames", detail: "Frame count of the currently active clip (read-only). 0 if no active clip.", insert: "totalFrames", kind: "Property" },
  { label: "speed", detail: "Playback speed multiplier — 1 = clip's own fps, 2 = double speed, 0 = frozen on current frame. Read/write.", insert: "speed = ", kind: "Property" },
];

const CAMERA_API = [
  { label: "zoom", detail: "Camera size/zoom. Default 5 = no zoom. Smaller = zoomed in, larger = zoomed out.", insert: "zoom = ", kind: "Property" },
  { label: "backgroundColor", detail: 'Background/clear color as a hex string, e.g. "#1a1a2e". Changes take effect immediately.', insert: 'backgroundColor = "#', kind: "Property" },
  { label: "shake(intensity, duration)", detail: "Shake the camera. intensity = peak radius in px (default 10), duration = seconds (default 0.3).\n  this.camera.shake(8, 0.5);", insert: "shake(${1:10}, ${2:0.3})", kind: "Method", snippet: true },
  { label: "follow(target, opts)", detail: "Smoothly follow a target entity every frame. target = entity from findFirst(). opts = { smoothing: 0.1, offsetX: 0, offsetY: 0, snap: false }.\n  this.camera.follow(findFirst('Player'), { smoothing: 0.08 });", insert: "follow(${1:findFirst(\"Player\")}, { smoothing: ${2:0.1} })", kind: "Method", snippet: true },
  { label: "stopFollow()", detail: "Stop a follow() already in progress. Safe to call when not following.", insert: "stopFollow()", kind: "Method" },
  { label: "offsetX", detail: "Horizontal offset from the followed target (px). Change while following to shift look-ahead direction.", insert: "offsetX = ", kind: "Property" },
  { label: "offsetY", detail: "Vertical offset from the followed target (px). Change while following to shift look-ahead direction.", insert: "offsetY = ", kind: "Property" },
  { label: "renderToSprite(spriteEntity)", detail: "Render this camera's view onto a sprite's texture every frame (minimap / security feed). Pass null to stop.", insert: "renderToSprite(${1:findFirst(\"Minimap\")})", kind: "Method", snippet: true },
  { label: "aspectMode", detail: '\'Landscape\' | \'Portrait\' | \'Square\' | \'Custom\' — which reference-resolution field set is active (read/write)', insert: 'aspectMode = "', kind: "Property" },
  { label: "landscapeWidth", detail: "Reference resolution width in px, used when aspectMode is 'Landscape' (read/write)", insert: "landscapeWidth = ", kind: "Property" },
  { label: "landscapeHeight", detail: "Reference resolution height in px, used when aspectMode is 'Landscape' (read/write)", insert: "landscapeHeight = ", kind: "Property" },
  { label: "portraitWidth", detail: "Reference resolution width in px, used when aspectMode is 'Portrait' (read/write)", insert: "portraitWidth = ", kind: "Property" },
  { label: "portraitHeight", detail: "Reference resolution height in px, used when aspectMode is 'Portrait' (read/write)", insert: "portraitHeight = ", kind: "Property" },
  { label: "squareSize", detail: "Reference resolution size in px (1:1), used when aspectMode is 'Square' (read/write)", insert: "squareSize = ", kind: "Property" },
  { label: "customWidth", detail: "Reference resolution width in px, used when aspectMode is 'Custom' (read/write)", insert: "customWidth = ", kind: "Property" },
  { label: "customHeight", detail: "Reference resolution height in px, used when aspectMode is 'Custom' (read/write)", insert: "customHeight = ", kind: "Property" },
  { label: "enablePseudo3D", detail: "Scene-wide fake-3D depth toggle — when true, Transform.z also scales rendered sprite size, not just draw order (read/write)", insert: "enablePseudo3D = ", kind: "Property" },
  { label: "scalingMode", detail: "'Expand' | 'Fit' | 'Fill' | 'Stretch' — how the reference resolution maps onto the player's actual screen (read/write)", insert: 'scalingMode = "', kind: "Property" },
  { label: "keepHeight", detail: "EXPAND-only: true keeps the reference HEIGHT exact, false keeps the reference WIDTH exact instead (read/write)", insert: "keepHeight = ", kind: "Property" },
  { label: "aspectRatioLock", detail: "EXPAND-only safety override: true downgrades Expand to behave like Fit, so the aspect ratio is never altered (read/write)", insert: "aspectRatioLock = ", kind: "Property" },
  { label: "allowStretching", detail: "STRETCH-only safety override: false (default) downgrades Stretch to Fit; true permits real non-uniform stretching (read/write)", insert: "allowStretching = ", kind: "Property" },
  { label: "letterboxing", detail: "'Auto' | 'On' | 'Off' — horizontal bars (top/bottom), shown when Fit leaves vertical space unused (read/write)", insert: 'letterboxing = "', kind: "Property" },
  { label: "pillarboxing", detail: "'Auto' | 'On' | 'Off' — vertical bars (left/right), shown when Fit leaves horizontal space unused (read/write)", insert: 'pillarboxing = "', kind: "Property" },
  { label: "barColor", detail: 'Color painted into letterbox/pillarbox bars when shown, as a hex string, e.g. "#000000" (read/write)', insert: 'barColor = "#', kind: "Property" },
  { label: "integerScaling", detail: "Rounds the computed device-fit scale down to the nearest whole integer (never below 1x) — keeps pixel art crisp (read/write)", insert: "integerScaling = ", kind: "Property" },
];

// Keys of the camera.follow() options object literal.
const CAMERA_FOLLOW_OPTS_API = [
  { label: "smoothing", detail: "0–1 lerp factor per frame (default 0.1). Higher = snappier, 1 = instant snap.", insert: "smoothing: ${1:0.1}", kind: "Field", snippet: true },
  { label: "offsetX",   detail: "Horizontal offset from the target center in world px (default 0).", insert: "offsetX: ${1:0}", kind: "Field", snippet: true },
  { label: "offsetY",   detail: "Vertical offset from the target center in world px (default 0).", insert: "offsetY: ${1:0}", kind: "Field", snippet: true },
  { label: "snap",      detail: "If true, camera teleports to the target each frame (no lerp/smoothing).", insert: "snap: ${1:true}", kind: "Field", snippet: true },
];

// Keys of the spawn() options object literal.
const SPAWN_OPTS_API = [
  { label: "x",     detail: "Spawn position X in world space. Defaults to the source entity's own X.", insert: "x: ${1:this.x}", kind: "Field", snippet: true },
  { label: "y",     detail: "Spawn position Y in world space. Defaults to the source entity's own Y.", insert: "y: ${1:this.y}", kind: "Field", snippet: true },
  { label: "name",  detail: "Rename the clone to this string. Defaults to the source entity's name.", insert: 'name: "${1:Clone}"', kind: "Field", snippet: true },
  { label: "byTag", detail: "If true, the first argument is treated as a TAG instead of a name.", insert: "byTag: ${1:true}", kind: "Field", snippet: true },
];

const AUDIO_API = [
  { label: "play()", detail: "Start audio playback", insert: "play()", kind: "Method" },
  { label: "playOnce()", detail: "Play the clip once as an independent, pooled voice — never interrupts a still-playing previous playOnce() call, so rapid overlapping triggers (e.g. a bounce/boing sound from onCollisionEnter) each ring out in full.", insert: "playOnce()", kind: "Method" },
  { label: "stop()", detail: "Stop audio playback", insert: "stop()", kind: "Method" },
  { label: "volume", detail: "Volume: 0.0 (silent) to 1.0 (full)", insert: "volume = ", kind: "Property" },
  { label: "pitch", detail: "Playback rate / pitch: 1.0 = normal, 2.0 = one octave up (double speed), 0.5 = one octave down (half speed). Clamped to 0.25–4.", insert: "pitch = ", kind: "Property" },
  { label: "playing", detail: "True while the source is set to play (read-only)", insert: "playing", kind: "Property" },
];

const EAR_API = [
  { label: "radius", detail: "Hearing radius in world units — 3D Audio Sources within this distance count as heard (read/write)", insert: "radius = ", kind: "Property" },
  { label: "enabled", detail: "Whether this listener is currently detecting sounds at all (read/write)", insert: "enabled = ", kind: "Property" },
  { label: "sourcesInRange", detail: "Every 3D Audio Source entity currently within range, as an array (empty if none). Recomputed every frame.", insert: "sourcesInRange", kind: "Property" },
  { label: "canHear(nameOrTag, opts)", detail: 'True if the named (or tagged, with {byTag:true}) 3D Audio Source entity is currently in range. E.g. this.ear.canHear("Siren")', insert: 'canHear("', kind: "Method" },
];

// ─── Light API — per-type definitions ────────────────────────────────────────
// Properties shared by every light type.
const LIGHT_API_COMMON = [
  { label: "type",           detail: "Light shape: 'Point' | 'Directional' | 'Spot' | 'Area' | 'GodRays' | 'Freeform' (read/write)", insert: "type",              kind: "Property" },
  { label: "color",          detail: 'Tint color as a hex string, e.g. "#ffdd88" for warm orange-yellow (read/write)', insert: 'color = "#',         kind: "Property" },
  { label: "intensity",      detail: "Brightness: 0 = off, 1 = normal, >1 = overbright/HDR. Clamped to >= 0 (read/write)", insert: "intensity = ",    kind: "Property" },
  { label: "castsOnWorld",   detail: "When true (default) the light visually illuminates the scene. Set false to keep it in the scene graph without any rendering cost (read/write)", insert: "castsOnWorld = ",  kind: "Property" },
  { label: "castShadows",    detail: "Enable real-time shadow casting — every ShadowCaster entity blocks this light. Has a rendering cost; leave false until needed (read/write)", insert: "castShadows = ",   kind: "Property" },
  { label: "shadowColor",    detail: 'Shadow tint as a hex string, e.g. "#000000" (black) or "#1a1a3a" (blue-tinted) (read/write)', insert: 'shadowColor = "#',  kind: "Property" },
  { label: "shadowStrength", detail: "Shadow opacity: 0 = no visible shadow, 1 = full-strength. Multiplied with each ShadowCaster's own opacity. Clamped to [0, 1] (read/write)", insert: "shadowStrength = ", kind: "Property" },
  { label: "flicker", detail: "Enable natural light-source flicker (read/write)", insert: "flicker = ", kind: "Property" },
  { label: "flickerSpeed", detail: "Flicker speed in cycles per second. 0 = no movement (read/write)", insert: "flickerSpeed = ", kind: "Property" },
  { label: "flickerDuration", detail: "Flicker duration in seconds. 0 = forever (read/write)", insert: "flickerDuration = ", kind: "Property" },
  { label: "coreSize", detail: "Bright/hot source-core size from 0.01 (tiny) to 1 (broad) (read/write)", insert: "coreSize = ", kind: "Property" },
  { label: "coreVisible", detail: "Show the realistic bright/hot light-source core (read/write)", insert: "coreVisible = ", kind: "Property" },
];
// Per-type: only properties actually available for that type are offered so
// the user never sees radius on a Directional or angle on a Point.
const LIGHT_API_POINT       = LIGHT_API_COMMON.concat([
  { label: "radius", detail: "Falloff radius in world-space px — how far the light reaches. Clamped to >= 0 (read/write)", insert: "radius = ", kind: "Property" },
]);
const LIGHT_API_DIRECTIONAL = LIGHT_API_COMMON; // no positional falloff fields
const LIGHT_API_SPOT        = LIGHT_API_COMMON.concat([
  { label: "radius", detail: "Falloff radius in world-space px. Clamped to >= 0 (read/write)", insert: "radius = ", kind: "Property" },
  { label: "angle",  detail: "Cone angle in degrees (full cone width, centered on transform.rotation). Clamped to [0, 360] (read/write)", insert: "angle = ",  kind: "Property" },
]);
const LIGHT_API_AREA        = LIGHT_API_COMMON.concat([
  { label: "radius", detail: "Soft falloff radius at the rectangle's edge. Clamped to >= 0 (read/write)", insert: "radius = ", kind: "Property" },
  { label: "width",  detail: "Flat-lit rectangle width in px. Clamped to >= 0 (read/write)",              insert: "width = ",  kind: "Property" },
  { label: "height", detail: "Flat-lit rectangle height in px. Clamped to >= 0 (read/write)",             insert: "height = ", kind: "Property" },
]);
const LIGHT_API_GOD_RAYS    = LIGHT_API_COMMON.concat([
  { label: "radius", detail: "How far the god-ray shafts reach. Clamped to >= 0 (read/write)", insert: "radius = ", kind: "Property" },
  { label: "angle",  detail: "Cone angle in degrees for the shaft spread. Clamped to [0, 360] (read/write)", insert: "angle = ", kind: "Property" },
]);
const LIGHT_API_FREEFORM    = LIGHT_API_COMMON; // polygon points are editor-only

// Full list used by hover docs (covers all types in one place).
const LIGHT_API = LIGHT_API_COMMON.concat([
  { label: "radius", detail: "Falloff radius in world-space px (Point / Spot / Area / GodRays). Beyond this distance the scene receives no illumination. Clamped to >= 0 (read/write)", insert: "radius = ",    kind: "Property" },
  { label: "angle",  detail: "Cone angle in degrees for Spot / GodRays lights (full cone width, centered on transform.rotation). Clamped to [0, 360] (read/write)", insert: "angle = ",     kind: "Property" },
  { label: "width",  detail: "Flat-lit rectangle width in px — Area lights only. Clamped to >= 0 (read/write)", insert: "width = ",     kind: "Property" },
  { label: "height", detail: "Flat-lit rectangle height in px — Area lights only. Clamped to >= 0 (read/write)", insert: "height = ",    kind: "Property" },
]);

const SHADOW_CASTER_API = [
  { label: "enabled",   detail: "Per-entity on/off for shadow casting — turn off to exclude this occluder (e.g. a see-through window) without removing the component (read/write)", insert: "enabled = ", kind: "Property" },
  { label: "width",     detail: "Optional occluder width override in world px. Leave unset (null) to use this entity's real rendered sprite bounds (read/write)", insert: "width = ", kind: "Property" },
  { label: "height",    detail: "Optional occluder height override in world px. Leave unset (null) to use this entity's real rendered sprite bounds (read/write)", insert: "height = ", kind: "Property" },
  { label: "offsetX",   detail: "Occluder box center X offset from this entity's Transform, in LOCAL space — rotates with the entity (read/write)", insert: "offsetX = ", kind: "Property" },
  { label: "offsetY",   detail: "Occluder box center Y offset from this entity's Transform, in LOCAL space — rotates with the entity (read/write)", insert: "offsetY = ", kind: "Property" },
  { label: "opacity",   detail: "How dark this object's shadow reads: 0 = invisible, 1 = full ambient darkness. Multiplied with the casting light's own shadowStrength. Clamped to [0, 1] (read/write)", insert: "opacity = ", kind: "Property" },
  { label: "length",    detail: "Shadow reach as a multiplier on the casting light's natural reach: 1 = normal, 0.5 = short contact shadow, 2 = long late-afternoon-sun shadow. Clamped to >= 0 (read/write)", insert: "length = ", kind: "Property" },
  { label: "softness",  detail: "Soft shadow edge (penumbra) amount in world px. 0 = crisp hard edge. Clamped to >= 0 (read/write)", insert: "softness = ", kind: "Property" },
];

const SCENE_LIGHTING_API = [
  { label: "shadowMode", detail: '"Quad" (cheap analytic shadows) or "Raymarch" (true per-pixel shadow occlusion, soft edges, higher GPU cost) (read/write)', insert: 'shadowMode = "', kind: "Property" },
  { label: "raymarchSteps", detail: "Raymarch step count, 1-200 — only used when shadowMode is \"Raymarch\". Higher = smoother edges and fewer thin-occluder leaks, at higher GPU cost (read/write)", insert: "raymarchSteps = ", kind: "Property" },
  { label: "ambientDarkness", detail: "How dark the world gets where no light reaches: 0 = no darkening, 1 = pitch black outside any light's reach. The main \"how moody does my lighting look\" dial (read/write)", insert: "ambientDarkness = ", kind: "Property" },
  { label: "glowStrength", detail: "How visible a light's own glow is in open air, not just where it lands on a sprite. 0 = no open-air glow, 1 = normal, higher = brighter/further \"hot\" glow (read/write)", insert: "glowStrength = ", kind: "Property" },
];


const COLLIDER_API = [
  { label: "shape", detail: "'Box' | 'Circle' | 'Capsule' | 'Triangle' (read-only)", insert: "shape", kind: "Property" },
  { label: "width", detail: "Box width in world units (read-only)", insert: "width", kind: "Property" },
  { label: "height", detail: "Box height in world units (read-only)", insert: "height", kind: "Property" },
  { label: "radius", detail: "Circle radius in world units (read-only)", insert: "radius", kind: "Property" },
  { label: "capsuleHalfHeight", detail: "Capsule half-height (read-only)", insert: "capsuleHalfHeight", kind: "Property" },
  { label: "capsuleRadius", detail: "Capsule radius (read-only)", insert: "capsuleRadius", kind: "Property" },
  { label: "offset", detail: "{ x, y } local collider offset (read-only)", insert: "offset", kind: "Property" },
  { label: "isTrigger", detail: "True when this Collider 2D is a sensor; use onTriggerEnter/Exit. Read/write — the only collider setting a script can change; flips the collider between solid and trigger at the next physics step.", insert: "isTrigger", kind: "Property" },
  { label: "isOneWayPlatform", detail: "Read-only: true if solid only from above — a body approaching from below/the side passes through, like a jump-through platform", insert: "isOneWayPlatform", kind: "Property" },
  { label: "friction", detail: "Surface friction (read-only)", insert: "friction", kind: "Property" },
  { label: "restitution", detail: "Bounciness (read-only)", insert: "restitution", kind: "Property" },
  { label: "density", detail: "Collider density (read-only)", insert: "density", kind: "Property" },
  { label: "layer", detail: "Physics layer index (read-only)", insert: "layer", kind: "Property" },
  { label: "mask", detail: "Physics layer mask (read-only)", insert: "mask", kind: "Property" },
  { label: "isColliding(other)", detail: "True if currently touching a solid collider — this.collider.isColliding() for 'touching anything', or this.collider.isColliding(other) for a specific entity. Trigger overlaps don't count; use onTriggerEnter/Exit for those.", insert: "isColliding()", kind: "Method" },
];

// Properties/methods shared by every Joint2D jointType — matches
// runtime/scripting/components/JointAPI.js's JOINT_MEMBERS exactly, so
// autocomplete never offers a member the real this.joint proxy would
// reject at runtime. anchor1/anchor2/axis are exposed as {x,y} objects
// there (not split X/Y fields like the raw component storage), so that's
// what's offered here too.
const JOINT_API_COMMON = [
  { label: "jointType", detail: "'Fixed' | 'Revolute' | 'Prismatic' | 'Rope' | 'Spring'", insert: 'jointType = "', kind: "Property" },
  { label: "connectedEntity", detail: "The other body this joint connects to, as an EntityContext (or null = jointed to a fixed point in the world)", insert: "connectedEntity", kind: "Property" },
  { label: "anchor1", detail: "{ x, y } local-space anchor point on THIS entity", insert: "anchor1", kind: "Property" },
  { label: "anchor2", detail: "{ x, y } local-space anchor point on connectedEntity (or world-space offset from the world anchor if connectedEntity is null)", insert: "anchor2", kind: "Property" },
  { label: "disableConnectedCollision", detail: "When true, only the two connected entities stop colliding with one another", insert: "disableConnectedCollision = ", kind: "Property" },
  { label: "collideConnected", detail: "Legacy inverse alias for disableConnectedCollision; prefer the explicit setting", insert: "collideConnected = ", kind: "Property" },
  { label: "enabled", detail: "Set false to remove the live physics joint next step without deleting the component — the two bodies move independently again until re-enabled", insert: "enabled = ", kind: "Property" },
];
// Per-type: only fields actually meaningful for that jointType are
// offered — same "never show radius on a Square" convention SHAPE_API
// above follows for ShapeRenderer's shapeType.
const JOINT_API_FIXED = JOINT_API_COMMON; // anchor1/anchor2 only — rigidly welded
const JOINT_API_REVOLUTE = JOINT_API_COMMON.concat([
  { label: "limitsEnabled", detail: "Revolute: whether limitMin/limitMax constrain rotation around the hinge point", insert: "limitsEnabled = ", kind: "Property" },
  { label: "limitMin", detail: "Revolute: minimum rotation in degrees (only enforced while limitsEnabled is true)", insert: "limitMin = ", kind: "Property" },
  { label: "limitMax", detail: "Revolute: maximum rotation in degrees (only enforced while limitsEnabled is true)", insert: "limitMax = ", kind: "Property" },
  { label: "motorEnabled", detail: "Revolute: whether a motor actively drives rotation around the hinge point", insert: "motorEnabled = ", kind: "Property" },
  { label: "motorSpeed", detail: "Revolute: motor target speed in degrees/sec", insert: "motorSpeed = ", kind: "Property" },
  { label: "flexibility", detail: "Revolute: 100 = fully free hinge, 0 = strongly resists relative rotation; ignored when a user motor is active", insert: "flexibility = ", kind: "Property" },
  { label: "motorMaxForce", detail: "Revolute: torque cap the motor may use to reach motorSpeed. 0 behaves as off even with motorEnabled true", insert: "motorMaxForce = ", kind: "Property" },
  { label: "jointDrag", detail: "Revolute: passive rotational drag/damping. 0 leaves the hinge free", insert: "jointDrag = ", kind: "Property" },
  { label: "restStiffness", detail: "Revolute: passive torsional stiffness pulling the joint toward its creation/rest angle", insert: "restStiffness = ", kind: "Property" },
  { label: "breakable", detail: "Revolute: remove the joint when estimated constraint demand exceeds breakForce", insert: "breakable = ", kind: "Property" },
  { label: "breakForce", detail: "Revolute: maximum estimated constraint force before the joint breaks", insert: "breakForce = ", kind: "Property" },
]);
const JOINT_API_PRISMATIC = JOINT_API_COMMON.concat([
  { label: "axis", detail: "Prismatic: { x, y } slide direction, local to this entity. Doesn't need to be normalized", insert: "axis", kind: "Property" },
  { label: "limitsEnabled", detail: "Prismatic: whether limitMin/limitMax constrain sliding along axis", insert: "limitsEnabled = ", kind: "Property" },
  { label: "limitMin", detail: "Prismatic: minimum slide distance in px (only enforced while limitsEnabled is true)", insert: "limitMin = ", kind: "Property" },
  { label: "limitMax", detail: "Prismatic: maximum slide distance in px (only enforced while limitsEnabled is true)", insert: "limitMax = ", kind: "Property" },
  { label: "motorEnabled", detail: "Prismatic: whether a motor actively drives sliding along axis", insert: "motorEnabled = ", kind: "Property" },
  { label: "motorSpeed", detail: "Prismatic: motor target speed in px/sec", insert: "motorSpeed = ", kind: "Property" },
  { label: "motorMaxForce", detail: "Prismatic: force cap the motor may use to reach motorSpeed. 0 behaves as off even with motorEnabled true", insert: "motorMaxForce = ", kind: "Property" },
]);
// Rope and Spring share the same visual/link-chain field set — they only
// differ in which numeric fields (length only vs length+stiffness+damping)
// actually shape the simulation, and both are always shown together the
// same way Rope/Spring already share one JointType2D-adjacent code path
// in Joint2D.js/PhysicsWorld.js.
const JOINT_API_ROPE_SPRING_COMMON = JOINT_API_COMMON.concat([
  { label: "length", detail: "Rope: maximum physical link-path length. Spring: rest length the endpoint spring pulls/pushes toward", insert: "length = ", kind: "Property" },
  { label: "segmentCount", detail: "Number of real simulated link bodies between anchor1 and anchor2 (clamped 2-32) — more links = smoother bend/sag", insert: "segmentCount = ", kind: "Property" },
  { label: "ropeMass", detail: "Total mass of the rope/spring, spread evenly across every link", insert: "ropeMass = ", kind: "Property" },
  { label: "visualEnabled", detail: "Whether the rope/string line is actually drawn", insert: "visualEnabled = ", kind: "Property" },
  { label: "visualColor", detail: 'Flat line color as hex string, e.g. "#c8a66a" — ignored while useTexture is true', insert: 'visualColor = "#', kind: "Property" },
  { label: "visualThickness", detail: "Line thickness in px", insert: "visualThickness = ", kind: "Property" },
  { label: "useTexture", detail: "When true the rope/string is textured with textureKey's image instead of a flat visualColor line", insert: "useTexture = ", kind: "Property" },
  { label: "textureKey", detail: "Logical sprite/texture asset key painted along the rope/string when useTexture is true", insert: 'textureKey = "', kind: "Property" },
  { label: "textureMode", detail: "'stretch' (fit whole image end-to-end, warps as length changes) | 'tile' (repeat at native size via textureTiling)", insert: 'textureMode = "', kind: "Property" },
  { label: "textureTiling", detail: "Tile mode only: world px one tile covers along the rope's length", insert: "textureTiling = ", kind: "Property" },
  { label: "textureScale", detail: "How many times the texture repeats ACROSS the rope's thickness", insert: "textureScale = ", kind: "Property" },
  { label: "textureOffset", detail: "Shifts the texture along the rope's length — animate for a flowing/conveyor look", insert: "textureOffset = ", kind: "Property" },
  { label: "textureFlip", detail: "Mirrors the texture across the rope's length", insert: "textureFlip = ", kind: "Property" },
]);
const JOINT_API_ROPE = JOINT_API_ROPE_SPRING_COMMON; // length is the only tuning field Rope uses
const JOINT_API_SPRING = JOINT_API_ROPE_SPRING_COMMON.concat([
  { label: "stiffness", detail: "Spring only: pull-back strength. See Joint2D.js's header comment — values under ~500 barely resist gravity; 5000-10000 is a reasonable start", insert: "stiffness = ", kind: "Property" },
  { label: "damping", detail: "Spring only: oscillation damping — roughly sqrt(stiffness) * 2 to 4 avoids endless bouncing without going fully rigid", insert: "damping = ", kind: "Property" },
]);

// Full list used by hover docs / unknown-jointType fallback (covers every
// type in one place) — same role SHAPE_API/LIGHT_API play for their
// components.
const JOINT_API = JOINT_API_COMMON.concat([
  { label: "axis", detail: "Prismatic: { x, y } slide direction, local to this entity. Doesn't need to be normalized", insert: "axis", kind: "Property" },
  { label: "length", detail: "Rope: maximum physical link-path length. Spring: rest length the endpoint spring pulls/pushes toward", insert: "length = ", kind: "Property" },
  { label: "stiffness", detail: "Spring only: pull-back strength", insert: "stiffness = ", kind: "Property" },
  { label: "damping", detail: "Spring only: oscillation damping", insert: "damping = ", kind: "Property" },
  { label: "segmentCount", detail: "Rope/Spring: number of real simulated link bodies (clamped 2-32)", insert: "segmentCount = ", kind: "Property" },
  { label: "ropeMass", detail: "Rope/Spring: total mass spread evenly across every link", insert: "ropeMass = ", kind: "Property" },
  { label: "visualEnabled", detail: "Rope/Spring: whether the rope/string line is drawn", insert: "visualEnabled = ", kind: "Property" },
  { label: "visualColor", detail: 'Rope/Spring: flat line color as hex string', insert: 'visualColor = "#', kind: "Property" },
  { label: "visualThickness", detail: "Rope/Spring: line thickness in px", insert: "visualThickness = ", kind: "Property" },
  { label: "useTexture", detail: "Rope/Spring: texture the line instead of a flat color", insert: "useTexture = ", kind: "Property" },
  { label: "textureKey", detail: "Rope/Spring: texture asset key", insert: 'textureKey = "', kind: "Property" },
  { label: "textureMode", detail: "Rope/Spring: 'stretch' | 'tile'", insert: 'textureMode = "', kind: "Property" },
  { label: "textureTiling", detail: "Rope/Spring: tile mode px-per-tile", insert: "textureTiling = ", kind: "Property" },
  { label: "textureScale", detail: "Rope/Spring: repeats across thickness", insert: "textureScale = ", kind: "Property" },
  { label: "textureOffset", detail: "Rope/Spring: shift along length", insert: "textureOffset = ", kind: "Property" },
  { label: "textureFlip", detail: "Rope/Spring: mirror texture", insert: "textureFlip = ", kind: "Property" },
  { label: "limitsEnabled", detail: "Revolute/Prismatic: whether limitMin/limitMax are enforced", insert: "limitsEnabled = ", kind: "Property" },
  { label: "limitMin", detail: "Revolute (degrees) / Prismatic (px): minimum", insert: "limitMin = ", kind: "Property" },
  { label: "limitMax", detail: "Revolute (degrees) / Prismatic (px): maximum", insert: "limitMax = ", kind: "Property" },
  { label: "motorEnabled", detail: "Revolute/Prismatic: whether a motor actively drives the joint", insert: "motorEnabled = ", kind: "Property" },
  { label: "motorSpeed", detail: "Revolute (deg/sec) / Prismatic (px/sec): motor target speed", insert: "motorSpeed = ", kind: "Property" },
  { label: "motorMaxForce", detail: "Revolute/Prismatic: torque/force cap for the motor. 0 behaves as off", insert: "motorMaxForce = ", kind: "Property" },
]);

// Unlike COLLIDER_API above, every StrokePath member is READ/WRITE from
// script — see StrokePathAPI.js's header for why (points can be edited
// live, unlike a Collider's fixed shape settings).
const STROKE_PATH_API = [
  { label: "points", detail: "{x,y}[] centerline points, local space, in path order. Reading returns a fresh copy — assign a whole new array back to actually change the path, or use getPoint/setPoint/addPoint/insertPoint/removePoint for single-point edits (read/write)", insert: "points", kind: "Property" },
  { label: "thickness", detail: "Full strip width (not half-width), world units. Clamped to >= 0 (read/write)", insert: "thickness = ", kind: "Property" },
  { label: "color", detail: "Flat fill color as a hex string, e.g. \"#8a8a8a\". Ignored when useTexture is true (read/write)", insert: "color = ", kind: "Property" },
  { label: "opacity", detail: "Overall strip opacity, 0-1. Clamped to [0, 1] (read/write)", insert: "opacity = ", kind: "Property" },
  { label: "useTexture", detail: "When true the strip is filled with textureKey's image instead of the flat color (read/write)", insert: "useTexture = ", kind: "Property" },
  { label: "textureKey", detail: "Logical sprite/texture asset key painted along the strip when useTexture is true (read/write)", insert: 'textureKey = "', kind: "Property" },
  { label: "textureMode", detail: "'stretch' | 'tile' — stretch fits the whole image end-to-end; tile repeats at native size using textureTiling (read/write)", insert: 'textureMode = "', kind: "Property" },
  { label: "textureTiling", detail: "TILE mode only: world units of path length one full texture tile covers lengthwise (read/write)", insert: "textureTiling = ", kind: "Property" },
  { label: "textureScale", detail: "How many times the texture repeats ACROSS the strip's own thickness. 1 = no repeat (read/write)", insert: "textureScale = ", kind: "Property" },
  { label: "textureOffset", detail: "World-unit shift applied along the path before texture mapping — animate over time for a flowing-river/conveyor-belt look without moving any point (read/write)", insert: "textureOffset = ", kind: "Property" },
  { label: "textureFlip", detail: "Mirrors the texture across the path's own centerline (read/write)", insert: "textureFlip = ", kind: "Property" },
  { label: "textureRotation", detail: "Texture rotation in degrees, around each tile's own center (read/write)", insert: "textureRotation = ", kind: "Property" },
  { label: "jointMode", detail: "'sharp' | 'bevel' | 'round' — how interior joints where two segments meet are drawn (read/write)", insert: 'jointMode = "', kind: "Property" },
  { label: "capMode", detail: "'none' | 'box' | 'round' — how both open ends of the path are drawn (read/write)", insert: 'capMode = "', kind: "Property" },
  { label: "pointCount", detail: "Number of centerline points currently on the path (read-only)", insert: "pointCount", kind: "Property" },
  { label: "firstPoint", detail: "{x,y} of the path's first point (read-only shortcut for getPoint(0))", insert: "firstPoint", kind: "Property" },
  { label: "lastPoint", detail: "{x,y} of the path's last point (read-only shortcut for getPoint(pointCount - 1)) — handy for spawning a new point just ahead of the current end", insert: "lastPoint", kind: "Property" },
  { label: "worldToLocal(x, y)", detail: "Converts a WORLD-space point (e.g. mouse.x/mouse.y) into this entity's local space, the same space points/addPoint/setPoint/insertPoint use. Accounts for position, rotation, and scale.", insert: "worldToLocal(${1:mouse.x}, ${2:mouse.y})", kind: "Method", snippet: true },
  { label: "localToWorld(x, y)", detail: "The inverse of worldToLocal() — converts one of this path's own local points into world space.", insert: "localToWorld(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "getLength()", detail: "Total centerline length in world units, following every segment (not straight-line start-to-end distance)", insert: "getLength()", kind: "Method" },
  { label: "getPoint(index)", detail: "{x,y} of the point at index, or undefined if out of range", insert: "getPoint(${1:0})", kind: "Method", snippet: true },
  { label: "setPoint(index, x, y)", detail: "Moves the existing point at index to (x, y). No-op if index is out of range", insert: "setPoint(${1:0}, ${2:x}, ${3:y})", kind: "Method", snippet: true },
  { label: "addPoint(x, y)", detail: "Appends a new point (x, y) to the end of the path", insert: "addPoint(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "insertPoint(index, x, y)", detail: "Inserts a new point (x, y) at index, shifting later points one slot later — same as clicking a segment with the Path tool", insert: "insertPoint(${1:0}, ${2:x}, ${3:y})", kind: "Method", snippet: true },
  { label: "removePoint(index)", detail: "Removes the point at index. Refuses to drop the path below 2 points", insert: "removePoint(${1:0})", kind: "Method", snippet: true },
];

// Every NavAgent2D member is READ/WRITE from script (unlike
// COLLIDER_API above) — see runtime/scripting/components/NavAgentAPI.js's
// header for why. currentPath/currentPathIndex are the one exception
// (owned by this.navMoveToward()'s internal state machine).
const NAV_AGENT_API = [
  { label: "radius", detail: "Agent clearance in world units against the shared Nav World 2D. Changing this takes effect on the agent's next path query.", insert: "radius", kind: "Property" },
  { label: "speed", detail: "Top move speed in px/sec, used by this.navMoveToward() when no explicit speed argument is passed", insert: "speed", kind: "Property" },
  { label: "acceleration", detail: "px/sec^2 — how fast this.navMoveToward() speeds this agent up toward `speed`", insert: "acceleration", kind: "Property" },
  { label: "deceleration", detail: "px/sec^2 — how fast this.navMoveToward() slows this agent when arriving/stopping", insert: "deceleration", kind: "Property" },
  { label: "stoppingDistance", detail: "Distance from the final target that counts as arrived, used by this.navMoveToward() when no opts.finalArriveDist is passed", insert: "stoppingDistance", kind: "Property" },
  { label: "autoRepath", detail: "If true, this.navMoveToward() re-checks the path automatically on a timer/target movement. If false, only re-plans when the target moves far enough or no path exists yet.", insert: "autoRepath", kind: "Property" },
  { label: "repathInterval", detail: "Seconds between automatic path re-checks (used when autoRepath is true)", insert: "repathInterval", kind: "Property" },
  { label: "repathDistance", detail: "World units a moving target must shift before an immediate re-path is forced", insert: "repathDistance", kind: "Property" },
  { label: "avoidanceEnabled", detail: "Whether this agent steers around other nearby agents — separate from pathfinding, consumed by whichever movement code steers this agent", insert: "avoidanceEnabled", kind: "Property" },
  { label: "avoidancePriority", detail: "0-100. Higher-priority agents yield less to lower-priority ones when local avoidance disagrees about who moves aside.", insert: "avoidancePriority", kind: "Property" },
  { label: "collabEnabled", detail: "When true, this agent joins 'smart NPC' group-surround behavior: if another collabEnabled agent is heading toward the same target, this.navMoveToward() redirects each of them to its own slot on a ring around it instead of both pathing to the identical point.", insert: "collabEnabled", kind: "Property" },
  { label: "collabGroupRadius", detail: "px. Two collabEnabled agents whose targets are within the smaller of their two collabGroupRadius values count as converging on 'the same thing' and get separate surround slots.", insert: "collabGroupRadius", kind: "Property" },
  { label: "vehicleLookahead", detail: "Car + Nav: path look-ahead distance; increases with speed to reduce waypoint hunting.", insert: "vehicleLookahead", kind: "Property" },
  { label: "vehicleCornerLookahead", detail: "Car + Nav: how far ahead to preview corners for early braking.", insert: "vehicleCornerLookahead", kind: "Property" },
  { label: "vehicleObstacleLookahead", detail: "Car + Nav: short-range physics scan distance for late/moving obstacles.", insert: "vehicleObstacleLookahead", kind: "Property" },
  { label: "vehicleObstacleWidth", detail: "Car + Nav: lateral spacing of the local obstacle scan rays.", insert: "vehicleObstacleWidth", kind: "Property" },
  { label: "vehicleSteerSmoothing", detail: "Car + Nav: steering response smoothing; higher is quicker, lower is softer.", insert: "vehicleSteerSmoothing", kind: "Property" },
  { label: "vehicleSpeedSmoothing", detail: "Car + Nav: speed-command smoothing for gradual acceleration/braking transitions.", insert: "vehicleSpeedSmoothing", kind: "Property" },
  { label: "vehicleCornerSlowdown", detail: "Car + Nav: minimum fraction of cruise speed retained through a hard corner.", insert: "vehicleCornerSlowdown", kind: "Property" },
  { label: "vehicleObstacleBrake", detail: "Car + Nav: local obstacle braking strength.", insert: "vehicleObstacleBrake", kind: "Property" },
  { label: "vehicleRecoveryTime", detail: "Car + Nav: low-progress time before stuck recovery begins.", insert: "vehicleRecoveryTime", kind: "Property" },
  { label: "vehicleRecoveryReverseTime", detail: "Car + Nav: duration of the reverse escape maneuver when stuck.", insert: "vehicleRecoveryReverseTime", kind: "Property" },
  { label: "area", detail: "Bitmask of which Nav World 2D areas (Ground, Water, ...) this agent is ALLOWED to path through at all — same model as Unity's NavMeshAgent.areaMask. A route never crosses a disallowed area. See Edit > Nav Areas… for slot names, and the Nav World 2D's Area Costs for a separate soft per-area preference. Toggle one bit with this.navAgent.area |= (1 << index) / &= ~(1 << index).", insert: "area", kind: "Property" },
  { label: "currentPath", detail: "{x,y}[] | null — the path this.navMoveToward() is currently following (read-only; call this.navMoveToward(x, y) again to change the destination)", insert: "currentPath", kind: "Property" },
  { label: "currentPathIndex", detail: "Index into currentPath this agent is currently walking toward (read-only)", insert: "currentPathIndex", kind: "Property" },
];

// Lifecycle callbacks are top-level script functions. Keep them in the
// ordinary completion list as well as the body snippets below so a user can
// type a partial callback name (especially onCollision/onTrigger) and still
// discover every handler supported by ScriptSystem.
const LIFECYCLE_API = [
  { label: "onStart()", detail: "Called once before the first onUpdate", insert: "onStart()", kind: "Function" },
  { label: "onClone()", detail: "Called once for entities created by spawn()", insert: "onClone()", kind: "Function" },
  { label: "onUpdate(dt)", detail: "Called every frame", insert: "onUpdate(dt)", kind: "Function" },
  { label: "onFixedUpdate(dt)", detail: "Called at a fixed physics rate", insert: "onFixedUpdate(dt)", kind: "Function" },
  { label: "onMessage(message, sender, data)", detail: "Called when a script message is received", insert: "onMessage(message, sender, data)", kind: "Function" },
  { label: "onClick()", detail: "Called when this collider is clicked/tapped", insert: "onClick()", kind: "Function" },
  { label: "onCollision(other)", detail: "Called when a solid collider touches this collider", insert: "onCollision(other)", kind: "Function" },
  { label: "onCollisionEnter(other)", detail: "Called when a solid collision begins", insert: "onCollisionEnter(other)", kind: "Function" },
  { label: "onCollisionStay(other)", detail: "Called every frame a solid collision is still happening (after Enter, before Exit)", insert: "onCollisionStay(other)", kind: "Function" },
  { label: "onCollisionExit(other)", detail: "Called when a solid collision ends", insert: "onCollisionExit(other)", kind: "Function" },
  { label: "onTriggerEnter(other)", detail: "Called when entering a trigger collider (Is Trigger = on)", insert: "onTriggerEnter(other)", kind: "Function" },
  { label: "onTriggerExit(other)", detail: "Called when leaving a trigger collider", insert: "onTriggerExit(other)", kind: "Function" },
  { label: "onDestroy()", detail: "Called when this entity is destroyed or the scene ends", insert: "onDestroy()", kind: "Function" },
  { label: "onStateEnter()", detail: "Called right after this.state.change(name) switches TO a new state. No component needed.", insert: "onStateEnter()", kind: "Function" },
  { label: "onStateUpdate(dt)", detail: "Called every frame, right after onUpdate, regardless of whether this.state.change() was ever called (starts in \"default\"). No component needed.", insert: "onStateUpdate(dt)", kind: "Function" },
  { label: "onStateExit()", detail: "Called right before this.state.change(name) switches AWAY from the current state. No component needed.", insert: "onStateExit()", kind: "Function" },
  { label: "onHearSound(source)", detail: "Called the frame a 3D Audio Source enters this entity's Audio Listener radius. Requires an Audio Listener component.", insert: "onHearSound(source)", kind: "Function" },
  { label: "onLoseSound(source)", detail: "Called the frame a 3D Audio Source leaves this entity's Audio Listener radius (or is destroyed while in range). Requires an Audio Listener component.", insert: "onLoseSound(source)", kind: "Function" },
];

const STATE_API = [
  { label: "current", detail: 'Current state name (read-only). Starts as "default" until change() is first called.', insert: "current", kind: "Property" },
  { label: "previous", detail: "State name before the last change(), or null if change() has never been called (read-only)", insert: "previous", kind: "Property" },
  { label: "change(name)", detail: 'Switch to a new state by name. Fires onStateExit() then onStateEnter(). No-op if name is already the current state. E.g. this.state.change("chasing")', insert: 'change("', kind: "Method" },
];

const TOUCH_TRACK_API = [
  { label: "active", detail: "True while locked onto a finger that is still down (read-only)", insert: "active", kind: "Property" },
  { label: "enabled", detail: "True unless disable() was called (read-only)", insert: "enabled", kind: "Property" },
  { label: "x", detail: "Tracked finger's current world x, or null if not active (read-only)", insert: "x", kind: "Property" },
  { label: "y", detail: "Tracked finger's current world y, or null if not active (read-only)", insert: "y", kind: "Property" },
  { label: "startTracking()", detail: 'Claims the finger that just touched down on THIS entity this frame. Safe to call every onUpdate() — a no-op if already tracking a finger, if no finger just started here, or if disabled. E.g. this.myTouch.startTracking()', insert: "startTracking()", kind: "Method" },
  { label: "stopTracking()", detail: "Releases the tracked finger early, before it lifts on its own", insert: "stopTracking()", kind: "Method" },
  { label: "disable()", detail: "Turns tracking OFF: releases the current finger (if any) right away and makes startTracking() do nothing until enable() is called", insert: "disable()", kind: "Method" },
  { label: "enable()", detail: "Turns tracking back ON after a disable() call (tracking is on by default)", insert: "enable()", kind: "Method" },
];

const THIS_SHORTCUTS_BASE = [
  { label: "x", detail: "Position X (number)", insert: "x", kind: "Property" },
  { label: "y", detail: "Position Y (number)", insert: "y", kind: "Property" },
  { label: "position", detail: "{ x, y } position object — read or assign {x,y}", insert: "position", kind: "Property" },
  { label: "rotation", detail: "Rotation in degrees", insert: "rotation = ", kind: "Property" },
  { label: "scaleX", detail: "Scale X", insert: "scaleX = ", kind: "Property" },
  { label: "scaleY", detail: "Scale Y", insert: "scaleY = ", kind: "Property" },
  { label: "translate(dx, dy)", detail: "Move by a delta amount this frame", insert: "translate(${1:dx}, ${2:dy})", kind: "Method", snippet: true },
  { label: "distanceTo(x, y)", detail: "Straight-line distance from this entity to a world-space point. E.g. this.distanceTo(player.x, player.y)", insert: "distanceTo(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "visible", detail: "Show/hide the entity", insert: "visible = ", kind: "Property" },
  { label: "enabled", detail: "Enable/disable this script", insert: "enabled = ", kind: "Property" },
  { label: "name", detail: "The entity's name, set in the Hierarchy panel (read-only)", insert: "name", kind: "Property" },
  { label: "tag", detail: "The entity's tag, set in the Inspector's Tag dropdown (read/write)", insert: "tag", kind: "Property" },
  { label: "id", detail: "Stable unique id for this exact entity (read-only) — unlike name/tag, never shared with any other entity, even clones. Save it (e.g. from spawn()'s return value) to findById() this exact entity later.", insert: "id", kind: "Property" },
  { label: "state", detail: 'State machine — this.state.current, this.state.previous, this.state.change(name). Needs no component; works on every entity.', insert: "state.", kind: "Module" },
  { label: "destroy()", detail: "Destroy this entity — removed at end of frame, onDestroy() fires just before removal", insert: "destroy()", kind: "Method" },
  { label: "destroyed", detail: "True once destroy() has been called (read-only)", insert: "destroyed", kind: "Property" },
  { label: "isClone", detail: "True if this entity was created by spawn() at runtime, rather than placed in the scene (read-only)", insert: "isClone", kind: "Property" },
  { label: "spawn(nameOrTag, options)", detail: 'Clone another entity by name (or tag with {byTag:true}), OR pass an entity directly — e.g. this.spawn(this) clones THIS exact entity with no name lookup at all, so it never grabs the wrong one even if other entities share this one\u2019s name. E.g. this.spawn("Bullet", { x: this.x, y: this.y })', insert: 'spawn(', kind: "Method" },
  { label: "wait(seconds, callback)", detail: 'Run callback once after N seconds. this inside the callback is still this entity. E.g. this.wait(2, function () { this.visible = false; })', insert: 'wait(${1:1}, function () {\n\t$0\n})', kind: "Method", snippet: true },
  { label: "cancelWait(timerId)", detail: "Cancel a pending wait() timer before it fires (pass the id wait() returned)", insert: "cancelWait(${1:timerId})", kind: "Method", snippet: true },
  { label: "repeat(seconds, callback)", detail: 'Run callback every N seconds, forever, starting N seconds from now. this inside the callback is still this entity. E.g. this.repeat(2, function () { this.hp += 1; })', insert: 'repeat(${1:1}, function () {\n\t$0\n})', kind: "Method", snippet: true },
  { label: "cancelRepeat(timerId)", detail: "Stop a repeat() before its next call (pass the id repeat() returned)", insert: "cancelRepeat(${1:timerId})", kind: "Method", snippet: true },
];

// Only offered when the current entity (or context entity(ies)) actually
// has a Collider2D — isPointerOver/isClicked read this.x/y against the
// entity's REAL collider shape, so without one they'd always read false
// and just be confusing noise in the suggestion list. Same gating
// principle COMPONENT_APIS already applies to this.rigidbody/this.
// controller, applied here to two flat this.* properties instead of a
// whole sub-object namespace.
const THIS_SHORTCUTS_COLLIDER = [
  { label: "isPointerOver", detail: "True while the MOUSE cursor is over this entity's collider shape (read-only). Mouse only — see isTouchOver for fingers.", insert: "isPointerOver", kind: "Property" },
  { label: "isClicked", detail: "True for exactly the one frame this entity was clicked with the MOUSE (read-only). Mouse only — see isTapped for fingers.", insert: "isClicked", kind: "Property" },
  { label: "isTouchOver", detail: "True while ANY active finger is over this entity's collider shape (read-only) — touch equivalent of isPointerOver.", insert: "isTouchOver", kind: "Property" },
  { label: "isTapped", detail: "True for exactly the one frame a finger FIRST touched down on this entity (read-only) — touch equivalent of isClicked.", insert: "isTapped", kind: "Property" },
  // myTouch itself needs a collider too — startTracking() hit-tests
  // the SAME real collider shape isPointerOver/isTouchOver above read,
  // so without one it could never actually claim a finger. Grouped
  // here rather than left in THIS_SHORTCUTS_BASE for the same reason
  // as those two.
  { label: "myTouch", detail: 'Track one finger: this.myTouch.startTracking() (call every onUpdate() — claims the finger that just touched this entity), this.myTouch.active, this.myTouch.x/.y (tracked finger\u2019s position), this.myTouch.stopTracking(), this.myTouch.enable()/.disable() (turn tracking on/off). Requires a Collider2D — startTracking() hit-tests against it. Stays locked to that exact finger no matter what other fingers do, and releases itself automatically when it lifts.', insert: "myTouch.", kind: "Module" },
];

// Only offered when the current entity (or context entity(ies)) actually
// has a NavAgent2D — navMoveToward() reads/drives that component's own
// pathfinding state (see NAV_AGENT_API's currentPath/speed/etc. just
// above), so without one it would have nothing to actually move. Same
// gating principle as THIS_SHORTCUTS_COLLIDER just above.
const THIS_SHORTCUTS_NAV_AGENT = [
  { label: "navMoveToward(targetX, targetY, speed, opts)", detail: "One-line NavWorld2D-following movement. Requires a NavAgent2D component. opts = { repathInterval, arriveDist, finalArriveDist, targetChangeDistance, debug }.", insert: "navMoveToward(${1:targetX}, ${2:targetY}, ${3:120})", kind: "Method", snippet: true },
];

// Only offered when the current entity (or context entity(ies)) has BOTH
// a Car-type CharacterController AND a NavAgent2D — this is the "chase
// car NPC" combo: the Nav Agent supplies pathfinding + obstacle
// avoidance, the Car controller supplies actual driving/drift handling.
// Neither component alone is enough (see EntityContext.navDriveToward's
// own doc comment in ScriptAPI.js, which no-ops without both), so this
// is gated more narrowly than THIS_SHORTCUTS_NAV_AGENT above — checked
// via _hasCarNavCombo() at the call site rather than a single `keys.has`
// test, since it depends on the CharacterController's controllerType,
// not just its presence.
const THIS_SHORTCUTS_CAR_NAV_AGENT = [
  { label: "navDriveToward(targetX, targetY, speed, opts)", detail: "Drive/drift toward a NavWorld2D-pathed point like a chase-car NPC — paths and avoids obstacles like a Nav Agent, but accelerates/brakes/steers/drifts using this entity's Car controller settings (maxSpeed, acceleration, brakeForce, turnSpeed, driftFactor). Requires a Car-type Movement Type AND a NavAgent2D. opts = { repathInterval, arriveDist, finalArriveDist, targetChangeDistance, debug }.", insert: "navDriveToward(${1:targetX}, ${2:targetY}, ${3:220})", kind: "Method", snippet: true },
];

const GLOBAL_APIS = [
  { label: "findWithTag(tag)", detail: "Find all entities with a tag. Returns an array of live object contexts.", insert: 'findWithTag("', kind: "Function" },
  { label: "findFirst(name)", detail: "Find the first entity with this name. Returns an object, or null if none match.", insert: 'findFirst("', kind: "Function" },
  { label: "findAll(name)", detail: "Find EVERY entity with this name. Returns an array (empty if none match).", insert: 'findAll("', kind: "Function" },
  { label: "findFirstWithTag(tag)", detail: "Find the first entity with this tag. Returns an object, or null if none match.", insert: 'findFirstWithTag("', kind: "Function" },
  { label: "findAllWithTag(tag)", detail: "Find EVERY entity with this tag. Same as findWithTag() — returns an array (empty if none match).", insert: 'findAllWithTag("', kind: "Function" },
  { label: "findById(id)", detail: "Find the entity with this exact id. Unlike findFirst(name)/findFirstWithTag(tag), an id is unique to one entity — never ambiguous, even if many entities share a name or tag. Returns an object, or null if no entity has that id (including if it was destroyed). Get an id from entity.id — e.g. save spawn(...).id, then findById() it later.", insert: "findById(${1:id})", kind: "Function", snippet: true },
  { label: "findInRadius(x, y, radius, opts)", detail: 'Find every entity within radius world units of (x, y), nearest first. Optionally narrow with { name: "..." } or { tag: "..." }. E.g. findInRadius(this.x, this.y, 200, { tag: "Enemy" })', insert: "findInRadius(${1:x}, ${2:y}, ${3:radius})", kind: "Function", snippet: true },
  { label: "scene", detail: "Scene utilities: scene.current, scene.findFirst(), scene.load(), scene.restart(), scene.pause(), scene.resume()", insert: "scene.", kind: "Module" },
  { label: "physics", detail: "Physics utilities: physics.raycast(x1,y1,x2,y2,opts), physics.layer(n)", insert: "physics.", kind: "Module" },
  { label: "nav", detail: "NavWorld2D pathfinding: nav.findPath(x1,y1,x2,y2,opts), nav.isWalkable(x,y), nav.bake()", insert: "nav.", kind: "Module" },
  { label: "input", detail: "Input queries: input.keyDown(key), input.keyPressed(key)", insert: "input.", kind: "Module" },
  { label: "mouse", detail: "Mouse position + buttons: mouse.x, mouse.y, mouse.down(button), mouse.isOver(name), mouse.clickedOn(name)", insert: "mouse.", kind: "Module" },
  { label: "touch", detail: "Active touches for mobile: touch.count, touch.first.x/.y, touch.swipe, touch.pinch, touch.isOver(name), touch.tappedOn(name), or loop over touch for multi-finger", insert: "touch.", kind: "Module" },
  { label: "time", detail: "Frame timing and game speed: time.deltaTime, time.scale, time.elapsed", insert: "time.", kind: "Module" },
  { label: "random", detail: "Random numbers: random.int(min,max), random.float(min,max)", insert: "random.", kind: "Module" },
  { label: "mathx", detail: "Gameplay-math helpers: mathx.lerp(a,b,t), mathx.clamp(v,min,max), mathx.moveToward(cur,target,maxDelta), mathx.remap(...), mathx.approximately(a,b). Native Math.floor/abs/etc. still work too.", insert: "mathx.", kind: "Module" },
  { label: "global", detail: "Cross-script shared state: global.score = 0, global.lives, etc.", insert: "global.", kind: "Module" },
  { label: "save", detail: "Persistent storage in IndexedDB — survives page refresh/reopen: save.set(key, value), save.get(key), save.has(key), save.delete(key), save.load(slotName) to switch save files.", insert: "save.", kind: "Module" },
  { label: "debug", detail: "On-screen debug HUD: debug.show(), debug.log(label, value)", insert: "debug.", kind: "Module" },
  { label: "sendMessage(tagOrEntity, message, data)", detail: 'Send a named message. Pass a tag string to message EVERY entity with that tag, or pass an entity directly (e.g. from findById()/findFirst()/spawn()) to message that ONE exact entity only. E.g. sendMessage("Enemy", "takeDamage", { amount: 10 }) or sendMessage(oneEnemy, "takeDamage", { amount: 10 })', insert: 'sendMessage(', kind: "Function" },
  { label: "broadcastMessage(message, data)", detail: 'Send a named message to ALL entities in the scene. E.g. broadcastMessage("gameOver")', insert: 'broadcastMessage("', kind: "Function" },
  { label: "spawn(nameOrTag, options)", detail: 'Clone an existing entity at runtime. Pass a name string (e.g. spawn("Bullet", {...})), or pass an entity directly (e.g. spawn(this), or spawn(findById(id))) to clone that EXACT entity with no name lookup, avoiding any ambiguity from shared names. Pass { byTag: true } to look up by tag instead of name (string form only).', insert: 'spawn(', kind: "Function" },
  { label: "wait(seconds, callback)", detail: 'Run callback once after N seconds of game time. E.g. wait(3, function () { this.destroy(); }). Auto-cancelled if the entity is destroyed or the scene restarts/switches first.', insert: 'wait(${1:1}, function () {\n\t$0\n})', kind: "Function", snippet: true },
  { label: "cancelWait(timerId)", detail: "Cancel a pending wait() timer before it fires — pass the id wait() returned.", insert: "cancelWait(${1:timerId})", kind: "Function", snippet: true },
  { label: "repeat(seconds, callback)", detail: 'Run callback every N seconds, forever, until cancelled or the entity/scene goes away. E.g. repeat(2, function () { spawn("Enemy", { x: random.int(0,800), y: 0 }); })', insert: 'repeat(${1:1}, function () {\n\t$0\n})', kind: "Function", snippet: true },
  { label: "cancelRepeat(timerId)", detail: "Stop a repeat() before its next call — pass the id repeat() returned.", insert: "cancelRepeat(${1:timerId})", kind: "Function", snippet: true },
  { label: "tween(target, properties, duration, easing, onComplete)", detail: 'Animate numeric properties on an entity or component object. Example: tween(this, { x: 420, y: 180, rotation: 90 }, 0.8, "easeOutCubic"). Also works with components, e.g. tween(this.sprite, { opacity: 0 }, 0.35, "easeInOutSine"). Choose the easing string from autocomplete; duration is in seconds. Call once from a lifecycle callback, not every frame. Returns an id for cancelTween(id).', insert: 'tween(${1:this}, { x: ${2:420}, y: ${3:180}, rotation: ${4:90} }, ${5:0.8}, "${6:easeOutCubic}")', kind: "Function", snippet: true },
  { label: "cancelTween(tweenId)", detail: "Stop an active tween by the id returned from tween(). Returns true if an active tween was cancelled.", insert: "cancelTween(${1:tweenId})", kind: "Function", snippet: true },
];

const SCENE_API = [
  { label: "findWithTag(tag)", detail: "Find all entities with a tag", insert: 'findWithTag("', kind: "Method" },
  { label: "findFirst(name)", detail: "Find the first entity with this name. Returns an object, or null if none match.", insert: 'findFirst("', kind: "Method" },
  { label: "findAll(name)", detail: "Find EVERY entity with this name. Returns an array (empty if none match).", insert: 'findAll("', kind: "Method" },
  { label: "findFirstWithTag(tag)", detail: "Find the first entity with this tag. Returns an object, or null if none match.", insert: 'findFirstWithTag("', kind: "Method" },
  { label: "findAllWithTag(tag)", detail: "Find EVERY entity with this tag. Returns an array (empty if none match).", insert: 'findAllWithTag("', kind: "Method" },
  { label: "findById(id)", detail: "Find the entity with this exact id — always unambiguous, unlike findFirst(name)/findFirstWithTag(tag). Returns an object, or null if no entity has that id.", insert: "findById(${1:id})", kind: "Method", snippet: true },
  { label: "load(sceneName)", detail: "Load a different scene by name", insert: 'load("', kind: "Method" },
  { label: "restart()", detail: "Restart the current scene from the beginning", insert: "restart()", kind: "Method" },
  { label: "pause()", detail: "Freeze gameplay: physics, scripts, animation, and audio all stop advancing until scene.resume() is called. Rendering stays responsive.", insert: "pause()", kind: "Method" },
  { label: "resume()", detail: "Resume gameplay after scene.pause(). Safe to call even if not currently paused.", insert: "resume()", kind: "Method" },
  { label: "isPaused", detail: "True while gameplay is frozen by scene.pause() (read-only)", insert: "isPaused", kind: "Property" },
  { label: "current", detail: "The name of the scene currently loaded and running, e.g. \"Level1\" (read-only). Use scene.load(name) to change scenes.", insert: "current", kind: "Property" },
  { label: "lighting", detail: "Scene-wide lighting/shadow settings: scene.lighting.shadowMode, .raymarchSteps, .ambientDarkness, .glowStrength", insert: "lighting.", kind: "Module" },
];
const PHYSICS_API = [
  { label: "raycast(x1, y1, x2, y2)", detail: "Cast a ray from (x1,y1) to (x2,y2). Returns { entity, point, normal, distance } on hit, or null if nothing was struck. entity is the hit object's script context (has .x .y .name .tag etc). point = {x,y} world position of the hit. normal = {x,y} surface direction (or null). distance = px from start to hit.", insert: "raycast(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})", kind: "Method", snippet: true },
  { label: "raycast(x1, y1, x2, y2, opts)", detail: "Raycast with options. opts = { exclude: [this], layerMask: physics.layer(2,3), debug: true }. exclude: array of entity contexts to skip (e.g. [this] to ignore the shooter). layerMask: restrict which physics layers the ray can hit. debug:true draws the ray in Play view (green=hit, red=miss).", insert: "raycast(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2}, { exclude: [${5:this}] })", kind: "Method", snippet: true },
  { label: "layer(...indices)", detail: "Build a layerMask from one or more layer indices (0-15) for raycast's opts.layerMask. E.g. physics.layer(2, 3) hits only layers 2 and 3.", insert: "layer(${1:0})", kind: "Method", snippet: true },
];

const NAV_API = [
  { label: "findPath(x1, y1, x2, y2)", detail: "Find a walkable path across the scene's NavWorld2D from (x1,y1) to (x2,y2), snapping each endpoint to the nearest walkable cell. opts.radius applies agent-size clearance (default 0). Returns an array of {x,y} WORLD-space waypoints (start to goal inclusive), or null if no path exists or the scene has no NavWorld2D. Waypoints are simplified (straight runs merged) but NOT smoothed — move through each in order for correct obstacle-avoiding movement.", insert: "findPath(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})", kind: "Method", snippet: true },
  { label: "findPath(x1, y1, x2, y2, opts)", detail: "findPath with options. opts = { debug }. `debug` draws the path as green segments in Play view for one frame.", insert: "findPath(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2}, { debug: true })", kind: "Method", snippet: true },
  { label: "isWalkable(x, y)", detail: "True if the world-space point (x,y) falls on a walkable NavWorld2D cell. False for blocked, out-of-bounds, or no NavWorld2D in the scene.", insert: "isWalkable(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "bake()", detail: "Re-bakes the scene's NavWorld2D from every Collider2D currently in the world (same as the Inspector's \"Bake Nav World\" button). Returns { walkable, blocked } cell counts, or null if the scene has no NavWorld2D entity.", insert: "bake()", kind: "Method" },
  { label: "areaIndex(name)", detail: "Resolves a named NavWorld2D area (see Edit \u2192 Nav Areas\u2026) to its 0-15 slot index. Case-insensitive. Returns -1 if no area has that name.", insert: 'areaIndex("$1")', kind: "Method", snippet: true },
  { label: "areaMask(...names)", detail: "Turns one or more named areas into the bitmask findPath's `area` option (and NavAgent2D.area) expect \u2014 e.g. nav.findPath(x1, y1, x2, y2, { area: nav.areaMask(\"Ground\", \"Road\") }). Unknown names are skipped; a call where none resolve returns 0 (nothing allowed) rather than silently allowing everything.", insert: 'areaMask("$1")', kind: "Method", snippet: true },
  { label: "areaCosts({ name: cost })", detail: "Turns a named cost map into the 16-entry array findPath's `areaCosts` option (and NavAgent2D.areaCosts) expect \u2014 e.g. nav.areaCosts({ Water: 3, Mud: 5 }) prefers cheaper areas without forbidding the pricier ones (use areaMask() to forbid outright). A name that doesn't resolve, or a non-positive cost, is skipped rather than failing the whole call.", insert: 'areaCosts({ $1 })', kind: "Method", snippet: true },
];

// Properties of a findPath() return value's array items: nav.findPath(...) → { x, y }[] | null
// Offered when the user types `<pathVar>[i].` or loops with `for (const wp of <pathVar>)` then types `wp.`
const NAV_WAYPOINT_API = [
  { label: "x", detail: "World-space X of this waypoint.", insert: "x", kind: "Property" },
  { label: "y", detail: "World-space Y of this waypoint.", insert: "y", kind: "Property" },
];

// Properties of a raycast() return value: physics.raycast(…) → { entity, point, normal, distance }
// These are offered when the user types `<hitVar>.` on a variable we can detect was assigned from raycast().
const RAYCAST_RESULT_API = [
  { label: "entity",   detail: "The entity that was hit — same script context as findFirst(). Has .x .y .name .tag .sprite .rigidbody etc.", insert: "entity",   kind: "Property" },
  { label: "point",    detail: "{ x, y } world-space position of the hit on the collider surface.", insert: "point",    kind: "Property" },
  { label: "normal",   detail: "{ x, y } surface normal at the hit — pointing away from the surface. null if the physics engine didn't compute one (e.g. castRay fallback path).", insert: "normal",   kind: "Property" },
  { label: "distance", detail: "Distance in pixels from the ray start (x1, y1) to the hit point.", insert: "distance", kind: "Property" },
];

// Keys of the raycast() options object literal: physics.raycast(x1,y1,x2,y2, { … })
// Offered when the cursor is inside that literal, e.g. right after
// "physics.raycast(x1, y1, x2, y2, { " or after a comma inside it.
const RAYCAST_OPTS_API = [
  { label: "exclude",   detail: "Array of entity contexts to skip entirely, e.g. exclude: [this] to ignore the shooter's own collider, or [this, findFirst(\"Shield\")] to skip several. Triggers are always skipped regardless of this option.", insert: "exclude: [${1:this}]", kind: "Property", snippet: true },
  { label: "layerMask", detail: "Bitmask restricting which physics layers the ray can hit — build it with physics.layer(2, 3). Colliders outside the mask are ignored entirely.", insert: "layerMask: ${1:physics.layer(0)}", kind: "Property", snippet: true },
  { label: "debug",     detail: "true draws the ray as a laser beam for one frame in Play view — green and cut off at the hit point if it hit, red full-length if it missed. Call debug.show() once (e.g. onStart) to make the overlay visible.", insert: "debug: ${1:true}", kind: "Property", snippet: true },
];

// Properties of the `other` parameter passed to onCollision/onCollisionEnter/
// onCollisionExit/onTriggerEnter/onTriggerExit — the same script-context
// shape as `this`/find() results, so the full THIS_SHORTCUTS_BASE list is
// reused for it rather than a separate hand-maintained duplicate.
const OTHER_PARAM_API = THIS_SHORTCUTS_BASE;
const INPUT_API = [
  { label: "keyDown(key)", detail: 'Is the key currently held? Use key codes like "ArrowLeft", "Space", "KeyA" — or "Any" to check if ANY key is held.', insert: 'keyDown("', kind: "Method" },
  { label: "keyPressed(key)", detail: 'Was the key pressed this frame only (not held)? Same key codes as keyDown, plus "Any" for "was any key pressed this frame".', insert: 'keyPressed("', kind: "Method" },
];
const MOUSE_API = [
  { label: "x", detail: "Cursor world-space x position — same space as this.x", insert: "x", kind: "Property" },
  { label: "y", detail: "Cursor world-space y position — same space as this.y", insert: "y", kind: "Property" },
  { label: "screenX", detail: "Cursor x in raw canvas pixels (0 = left edge of the game screen)", insert: "screenX", kind: "Property" },
  { label: "screenY", detail: "Cursor y in raw canvas pixels (0 = top edge of the game screen)", insert: "screenY", kind: "Property" },
  { label: "over", detail: "True while the cursor is anywhere over the game screen", insert: "over", kind: "Property" },
  { label: "down(button)", detail: "Is the button currently held? 0=left, 1=middle, 2=right. Defaults to left.", insert: "down(${1:0})", kind: "Method", snippet: true },
  { label: "pressed(button)", detail: "Was the button pressed this frame only? 0=left, 1=middle, 2=right.", insert: "pressed(${1:0})", kind: "Method", snippet: true },
  { label: "released(button)", detail: "Was the button released this frame only? 0=left, 1=middle, 2=right.", insert: "released(${1:0})", kind: "Method", snippet: true },
  { label: "isOver(nameOrTagOrEntity, options)", detail: 'Is the cursor over the given entity? Pass a name/tag string, or pass an entity directly (from findFirst()/findById()/etc) for an exact, unambiguous check. Real shape-accurate hit-testing. E.g. mouse.isOver("PlayButton") or mouse.isOver(door)', insert: 'isOver(', kind: "Method" },
  { label: "clickedOn(nameOrTagOrEntity, options)", detail: 'Was this entity clicked THIS frame? Combines isOver() + pressed() into one check. Accepts a name/tag string or an entity directly, same as isOver(). E.g. if (mouse.clickedOn("PlayButton")) { scene.load("Level1"); }', insert: 'clickedOn(', kind: "Method" },
];
const TOUCH_API = [
  // Core
  { label: "count",          detail: "How many fingers are currently touching the screen (excludes justEnded entries)", insert: "count", kind: "Property" },
  { label: "first",          detail: "The first active finger (id/x/y/startX/startY/dx/dy/distance/justStarted), or null if none", insert: "first", kind: "Property" },
  { label: "anyJustStarted", detail: "True if any finger touched down this frame (pulse, like justStarted on a single touch)", insert: "anyJustStarted", kind: "Property" },
  { label: "anyJustEnded",   detail: "True if any finger lifted this frame (pulse, like justEnded on a single touch)", insert: "anyJustEnded", kind: "Property" },
  // Gesture helpers — insert with trailing "." so Monaco immediately re-opens suggestions for the sub-properties
  { label: "swipe",  detail: "Swipe gesture: touch.swipe.active (true while one finger has moved > 40 px from start), .direction ('left'|'right'|'up'|'down'), .dx, .dy, .distance.", insert: "swipe.", kind: "Module" },
  { label: "pinch",  detail: "Pinch gesture (two fingers): touch.pinch.active, .scale (cur/start distance ratio), .delta (px change), .distance (current px between fingers).", insert: "pinch.", kind: "Module" },
  // Tap-on-entity helpers — touch equivalent of MOUSE_API's isOver/clickedOn
  { label: "isOver(nameOrTagOrEntity, options)", detail: 'Is ANY active finger over the given entity? Pass a name/tag string, or an entity directly for an exact, unambiguous check. Real shape-accurate hit-testing, checked against every finger on screen. E.g. touch.isOver("PlayButton") or touch.isOver(door)', insert: 'isOver(', kind: "Method" },
  { label: "tappedOn(nameOrTagOrEntity, options)", detail: 'Did a finger FIRST touch down on this entity THIS frame? Combines isOver() + justStarted into one check. Accepts a name/tag string or an entity directly, same as isOver(). E.g. if (touch.tappedOn("PlayButton")) { scene.load("Level1"); }', insert: 'tappedOn(', kind: "Method" },
];
const TOUCH_ITEM_API = [
  { label: "id",          detail: "Stable id for this specific finger — use to tell fingers apart across frames", insert: "id", kind: "Property" },
  { label: "x",           detail: "This finger's current world-space x position", insert: "x", kind: "Property" },
  { label: "y",           detail: "This finger's current world-space y position", insert: "y", kind: "Property" },
  { label: "screenX",     detail: "This finger's x in raw canvas pixels", insert: "screenX", kind: "Property" },
  { label: "screenY",     detail: "This finger's y in raw canvas pixels", insert: "screenY", kind: "Property" },
  { label: "startX",      detail: "World-space x where this finger first touched down", insert: "startX", kind: "Property" },
  { label: "startY",      detail: "World-space y where this finger first touched down", insert: "startY", kind: "Property" },
  { label: "dx",          detail: "How far this finger has moved horizontally from its start (x - startX)", insert: "dx", kind: "Property" },
  { label: "dy",          detail: "How far this finger has moved vertically from its start (y - startY)", insert: "dy", kind: "Property" },
  { label: "distance",    detail: "Total distance this finger has moved from its start (Math.hypot(dx, dy))", insert: "distance", kind: "Property" },
  { label: "justStarted", detail: "True for exactly the one frame this finger touched down", insert: "justStarted", kind: "Property" },
  { label: "justEnded",   detail: "True for exactly the one frame this finger lifted/cancelled", insert: "justEnded", kind: "Property" },
];
// Completions for touch.swipe.* properties.
const TOUCH_SWIPE_API = [
  { label: "active",    detail: "True while one finger has moved more than 40 px from its touch-down point", insert: "active", kind: "Property" },
  { label: "direction", detail: "'left' | 'right' | 'up' | 'down' — dominant axis of the swipe", insert: "direction", kind: "Property" },
  { label: "dx",        detail: "Horizontal displacement from the swipe's start (px, positive = right)", insert: "dx", kind: "Property" },
  { label: "dy",        detail: "Vertical displacement from the swipe's start (px, positive = down)", insert: "dy", kind: "Property" },
  { label: "distance",  detail: "Total distance from the swipe's start (px)", insert: "distance", kind: "Property" },
];
// Completions for touch.pinch.* properties.
const TOUCH_PINCH_API = [
  { label: "active",   detail: "True while two or more fingers are on screen", insert: "active", kind: "Property" },
  { label: "scale",    detail: "Current / start distance ratio — 1 at first touch, > 1 spreading (zoom in), < 1 pinching (zoom out)", insert: "scale", kind: "Property" },
  { label: "delta",    detail: "Current distance minus start distance in px — positive = spreading, negative = pinching", insert: "delta", kind: "Property" },
  { label: "distance", detail: "Current pixel distance between the two fingers", insert: "distance", kind: "Property" },
];
const TIME_API = [
  { label: "deltaTime", detail: "Game seconds since the last frame, already multiplied by time.scale (use to keep movement frame-rate independent)", insert: "deltaTime", kind: "Property" },
  { label: "scale", detail: "Game speed multiplier (read/write, 0–100). 1 = normal, 0.5 = slow motion, 2 = double speed, 0 = frozen (scripts keep running with deltaTime 0). Affects physics, animation, wait()/repeat(), deltaTime and elapsed — not input. Persists across scene loads. E.g. time.scale = 0.3", insert: "scale", kind: "Property" },
  { label: "unscaledDeltaTime", detail: "Real seconds since the last frame, ignoring time.scale and pause — use for menus/UI that must keep animating during slow motion or a freeze", insert: "unscaledDeltaTime", kind: "Property" },
  { label: "elapsed", detail: "Total game seconds since the game started (advances with time.scale, stops while it is 0)", insert: "elapsed", kind: "Property" },
];
const RANDOM_API = [
  { label: "int(min, max)", detail: "Random integer in [min, max] inclusive", insert: "int(${1:min}, ${2:max})", kind: "Method", snippet: true },
  { label: "float(min, max)", detail: "Random float in [min, max)", insert: "float(${1:min}, ${2:max})", kind: "Method", snippet: true },
];
// Realot's own small gameplay-math helpers — additions to native Math,
// not wrappers around it, so there's no overlap with MATH_NATIVE_API
// below. Named `mathx` (not `math`) precisely so it can never be misread
// as either native `Math` or "the engine's math system" — it's a small,
// distinct set of extras.
const MATH_API = [
  { label: "lerp(a, b, t)", detail: "Linear interpolation from a to b. t=0 -> a, t=1 -> b (t isn't clamped, so overshoot works).", insert: "lerp(${1:a}, ${2:b}, ${3:t})", kind: "Method", snippet: true },
  { label: "clamp(value, min, max)", detail: "Restrict value to the [min, max] range.", insert: "clamp(${1:value}, ${2:min}, ${3:max})", kind: "Method", snippet: true },
  { label: "moveToward(current, target, maxDelta)", detail: "Move current toward target by at most maxDelta this call — no overshoot. E.g. this.x = mathx.moveToward(this.x, targetX, 200 * time.deltaTime)", insert: "moveToward(${1:current}, ${2:target}, ${3:maxDelta})", kind: "Method", snippet: true },
  { label: "remap(value, inMin, inMax, outMin, outMax)", detail: 'Remap value from [inMin, inMax] into [outMin, outMax]. E.g. mathx.remap(hp, 0, 100, 0, 1) for a health-bar fill amount.', insert: "remap(${1:value}, ${2:inMin}, ${3:inMax}, ${4:outMin}, ${5:outMax})", kind: "Method", snippet: true },
  { label: "approximately(a, b, epsilon)", detail: "True if a and b are within epsilon of each other (default 0.0001) — safer than === for comparing floats.", insert: "approximately(${1:a}, ${2:b})", kind: "Method", snippet: true },
];
// Native JS Math — NOT reimplemented by the engine, just documented here
// so `Math.` gets the same autocomplete/hover treatment as our own
// modules instead of falling back to Monaco's generic (and, with noLib
// enabled, unavailable) built-in typings. Kept short: the common
// gameplay-relevant subset, not the entire Math surface.
const MATH_NATIVE_API = [
  { label: "abs(x)", detail: "Absolute value of x.", insert: "abs(${1:x})", kind: "Method", snippet: true },
  { label: "floor(x)", detail: "Round x down to the nearest integer.", insert: "floor(${1:x})", kind: "Method", snippet: true },
  { label: "ceil(x)", detail: "Round x up to the nearest integer.", insert: "ceil(${1:x})", kind: "Method", snippet: true },
  { label: "round(x)", detail: "Round x to the nearest integer.", insert: "round(${1:x})", kind: "Method", snippet: true },
  { label: "trunc(x)", detail: "Integer part of x, discarding any fraction (toward zero).", insert: "trunc(${1:x})", kind: "Method", snippet: true },
  { label: "sign(x)", detail: "-1, 0, or 1 depending on the sign of x.", insert: "sign(${1:x})", kind: "Method", snippet: true },
  { label: "min(...values)", detail: "Smallest of the given values.", insert: "min(${1:a}, ${2:b})", kind: "Method", snippet: true },
  { label: "max(...values)", detail: "Largest of the given values.", insert: "max(${1:a}, ${2:b})", kind: "Method", snippet: true },
  { label: "pow(base, exponent)", detail: "base raised to exponent.", insert: "pow(${1:base}, ${2:exponent})", kind: "Method", snippet: true },
  { label: "sqrt(x)", detail: "Square root of x.", insert: "sqrt(${1:x})", kind: "Method", snippet: true },
  { label: "hypot(...values)", detail: "sqrt of the sum of squares — e.g. Math.hypot(dx, dy) for straight-line distance.", insert: "hypot(${1:dx}, ${2:dy})", kind: "Method", snippet: true },
  { label: "atan2(y, x)", detail: "Angle in radians of the point (x, y) from the origin — the usual way to aim one entity at another.", insert: "atan2(${1:y}, ${2:x})", kind: "Method", snippet: true },
  { label: "sin(x)", detail: "Sine of x (radians).", insert: "sin(${1:x})", kind: "Method", snippet: true },
  { label: "cos(x)", detail: "Cosine of x (radians).", insert: "cos(${1:x})", kind: "Method", snippet: true },
  { label: "random()", detail: "Random float in [0, 1). Prefer random.int()/random.float() for gameplay ranges — this is the raw JS primitive.", insert: "random()", kind: "Method" },
  { label: "PI", detail: "π (3.14159...)", insert: "PI", kind: "Property" },
];
const DEBUG_API = [
  { label: "show(on)", detail: "Turn the on-screen debug HUD on (default) or off — debug.show(false) hides it", insert: "show(${1:true})", kind: "Method", snippet: true },
  { label: "showFps(on)", detail: "Show/hide just the FPS line while the HUD stays on", insert: "showFps(${1:true})", kind: "Method", snippet: true },
  { label: "log(label, value)", detail: 'Add/update a custom HUD line, e.g. debug.log("Player HP", this.hp)', insert: 'log("', kind: "Method" },
  { label: "clear(label)", detail: "Remove one custom HUD line by its label", insert: 'clear("', kind: "Method" },
  { label: "clearAll()", detail: "Remove every custom HUD line", insert: "clearAll()", kind: "Method" },
];

// Persistent key/value storage backed by IndexedDB — see
// runtime/scripting/components/SaveAPI.js for the full behavior this
// mirrors. get/set/has/delete/keys/clear/isReady/slot are instant
// (read/write an in-memory copy of the current slot); load/listSlots/
// deleteSlot/flushNow return a Promise since they touch IndexedDB
// directly.
const SAVE_API = [
  { label: "get(key)", detail: 'Read a value saved under key in the current slot. Returns undefined if never set, e.g. var hp = save.get("playerHp");', insert: 'get("', kind: "Method" },
  { label: "set(key, value)", detail: 'Save value under key in the current slot. Takes effect immediately for save.get(); the IndexedDB write itself is batched in the background. Value must be JSON-safe (numbers, strings, booleans, arrays, plain objects) — not entities or functions. E.g. save.set("playerHp", this.hp);', insert: 'set("${1:key}", ${2:value})', kind: "Method", snippet: true },
  { label: "has(key)", detail: 'True if key has ever been saved in the current slot. E.g. if (!save.has("tutorialSeen")) { ... }', insert: 'has("', kind: "Method" },
  { label: "delete(key)", detail: "Remove key from the current slot. Returns true if it existed.", insert: 'delete("', kind: "Method" },
  { label: "keys()", detail: "All keys currently saved in this slot, as an array of strings.", insert: "keys()", kind: "Method" },
  { label: "clear()", detail: "Erase EVERY key in the current slot (does not delete the slot itself or touch other slots — see deleteSlot). Useful for a \"reset save\" button.", insert: "clear()", kind: "Method" },
  { label: "isReady", detail: "True once the current slot's data has finished loading from IndexedDB at least once (read-only).", insert: "isReady", kind: "Property" },
  { label: "slot", detail: "Name of the slot save.get/set/etc. currently read and write (read-only) — use save.load(name) to switch.", insert: "slot", kind: "Property" },
  { label: "load(slotName)", detail: 'Switch to a different save slot by name, loading its data from IndexedDB (creating it empty if new). Returns a Promise — await it before reading data you expect the new slot to have. E.g. await save.load("slot2");', insert: 'load("', kind: "Method" },
  { label: "listSlots()", detail: "List every slot name ever saved for this game (not just the current one). Returns a Promise<string[]>.", insert: "listSlots()", kind: "Method" },
  { label: "deleteSlot(slotName)", detail: "Permanently delete a slot and everything saved in it. Returns a Promise<boolean>.", insert: 'deleteSlot("', kind: "Method" },
  { label: "flushNow()", detail: "Force any pending save.set()/delete()/clear() writes to finish now instead of on the engine's short delay. Returns a Promise that resolves once they've landed in IndexedDB.", insert: "flushNow()", kind: "Method" },
  { label: "onError(callback)", detail: "Register a callback for background save errors (e.g. IndexedDB unavailable or storage quota exceeded) — the only way to notice a write didn't make it to disk, since save.set() itself never throws. Only one handler at a time.", insert: "onError(function (err) {\n\t$0\n})", kind: "Method", snippet: true },
];

// ─── Live scene data helpers ──────────────────────────────────────────────────

/** All entity names in the current scene (deduped, sorted). */
function _getEntityNames() {
  if (!editorState.world) return [];
  const entities = editorState.world.getAllEntities();
  const names = new Set();
  for (const e of entities) if (e.name) names.add(e.name);
  return [...names].sort();
}

/** All unique entity tags in the current scene (deduped, sorted). */
function _getEntityTags() {
  if (!editorState.world) return [];
  const entities = editorState.world.getAllEntities();
  const tags = new Set();
  for (const e of entities) if (e.tag) tags.add(e.tag);
  return [...tags].sort();
}

/** All scene names from the scene list. */
function _getSceneNames() {
  try {
    const list = getSceneList();
    return list.map(s => s.name).filter(Boolean).sort();
  } catch (_) { return []; }
}

/** All sprite/texture asset names in the project. */
function _getTextureNames() {
  try {
    return getAllSpriteAssets().map(a => a.name || a.key).filter(Boolean).sort();
  } catch (_) { return []; }
}

/** All audio asset names in the project. */
function _getAudioNames() {
  try {
    return getAllAudioAssets().map(a => a.name || a.key).filter(Boolean).sort();
  } catch (_) { return []; }
}

/** All NAMED (non-empty-slot) NavWorld2D area names, as configured via
 *  Edit → Nav Areas… — backs nav.areaIndex("/nav.areaMask(" completion.
 *  Sorted by slot index (not alphabetically) so the list order matches
 *  what the Nav Areas window and Inspector's area checklist already
 *  show, rather than surprising the user with a different order here. */
function _getNavAreaNames() {
  try {
    return getNamedNavAreas().map((a) => a.name);
  } catch (_) { return []; }
}

/** Animation clip names for the context entities (animator.play completions). */
function _getAnimClipNames() {
  const entities = _getContextEntities();
  const names = new Set();
  for (const e of entities) {
    const anim = e.getComponent(SPRITE_ANIMATION);
    if (anim && anim.clips) {
      for (const clip of anim.clips) if (clip.name) names.add(clip.name);
    }
  }
  // Also scan all scene entities in case script is unassigned
  if (names.size === 0 && editorState.world) {
    for (const e of editorState.world.getAllEntities()) {
      const anim = e.getComponent(SPRITE_ANIMATION);
      if (anim && anim.clips) {
        for (const clip of anim.clips) if (clip.name) names.add(clip.name);
      }
    }
  }
  return [...names].sort();
}

/**
 * Scan every saved script for sendMessage / broadcastMessage CALLS and
 * return the unique set of message names being SENT.
 * Pass extraSource (current model text) to include unsaved edits.
 */
function _getSentMessageNames(extraSource) {
  const names = new Set();
  const bcRx = /\bbroadcastMessage\s*\(\s*["']([^"']+)["']/g;
  const smRx = /\bsendMessage\s*\(\s*["'][^"']*["']\s*,\s*["']([^"']+)["']/g;
  const scan = (src) => {
    if (!src) return;
    bcRx.lastIndex = 0; smRx.lastIndex = 0;
    let m;
    while ((m = bcRx.exec(src)) !== null) names.add(m[1]);
    while ((m = smRx.exec(src)) !== null) names.add(m[1]);
  };
  try { for (const n of getAllScripts()) scan(getScriptSource(n)); } catch (_) {}
  if (extraSource) scan(extraSource);
  return names;
}

/**
 * Scan every saved script for this.state.change("X") calls AND
 * this.state.current === "X" / == "X" / !== "X" comparisons, returning
 * the unique set of state names in use across the whole project. State
 * names have no central registry (unlike scenes, tags, or textures) —
 * they're just whatever string a script happens to pass to
 * state.change() — so like message names, the only way to offer useful
 * completions is to scan what's already been typed elsewhere and let
 * the user reuse an existing name instead of guessing/retyping one.
 * Same convention as _getSentMessageNames/_getHandledMessageNames above.
 * Pass extraSource (current model text) to include unsaved edits.
 */
function _getStateNames(extraSource) {
  const names = new Set();
  const changeRx = /\bstate\s*\.\s*change\s*\(\s*["']([^"']+)["']/g;
  const compareRx = /\bstate\s*\.\s*current\s*[!=]==?\s*["']([^"']+)["']/g;
  const scan = (src) => {
    if (!src) return;
    changeRx.lastIndex = 0; compareRx.lastIndex = 0;
    let m;
    while ((m = changeRx.exec(src)) !== null) names.add(m[1]);
    while ((m = compareRx.exec(src)) !== null) names.add(m[1]);
  };
  try { for (const n of getAllScripts()) scan(getScriptSource(n)); } catch (_) {}
  if (extraSource) scan(extraSource);
  return names;
}

/**
 * Scan every saved script for save.set("key", ...) calls and return the
 * unique set of save keys in use across the whole project. Like state
 * names, save keys have no central registry — just whatever string a
 * script passes to save.set() — so completions come from scanning what's
 * already been saved elsewhere, same convention as _getStateNames above.
 * Pass extraSource (current model text) to include unsaved edits.
 */
function _getSaveKeyNames(extraSource) {
  const names = new Set();
  const setRx = /\bsave\s*\.\s*set\s*\(\s*["']([^"']+)["']/g;
  const scan = (src) => {
    if (!src) return;
    setRx.lastIndex = 0;
    let m;
    while ((m = setRx.exec(src)) !== null) names.add(m[1]);
  };
  try { for (const n of getAllScripts()) scan(getScriptSource(n)); } catch (_) {}
  if (extraSource) scan(extraSource);
  return names;
}

/**
 * Scan every saved script for message names actually being HANDLED —
 * i.e. checked with `if (message === "X")` / `if (message == "X")`
 * INSIDE an onMessage(message, ...) function body — and return the
 * unique set of names found.
 *
 * This used to scan for onMessage("msg") as if it were a call with a
 * string literal, but onMessage(message) is a function DECLARATION —
 * its parameter is just a variable name, never a message-name string —
 * so that pattern could never actually match a real script and this
 * always returned an empty set. The real check lives in the function
 * BODY, which is what this now scans for (same convention the
 * `_isInsideOnMessageBody` completion-scoping helper above uses, just
 * applied per-match across a whole file rather than at one cursor
 * position).
 *
 * Pass extraSource (current model text) to include unsaved edits.
 */
function _getHandledMessageNames(extraSource) {
  const names = new Set();
  // Matches `if (message === "X")`, `if (message == "X")`, and the same
  // without "if" (e.g. a ternary or early-return guard) — the message
  // name check itself, not specifically an if-statement, is what matters.
  const checkRx = /\bmessage\s*===?\s*["']([^"']+)["']/g;
  const scan = (src) => {
    if (!src) return;
    const declRx = /\bonMessage\s*\(\s*[a-zA-Z_$][\w$]*[^)]*\)\s*\{/g;
    let decl;
    while ((decl = declRx.exec(src)) !== null) {
      const bodyStart = decl.index + decl[0].length;
      let depth = 1;
      let bodyEnd = src.length;
      for (let i = bodyStart; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) {
            bodyEnd = i;
            break;
          }
        }
      }
      const body = src.slice(bodyStart, bodyEnd);
      checkRx.lastIndex = 0;
      let m;
      while ((m = checkRx.exec(body)) !== null) names.add(m[1]);
    }
  };
  try { for (const n of getAllScripts()) scan(getScriptSource(n)); } catch (_) {}
  if (extraSource) scan(extraSource);
  return names;
}

// Scans backward from the cursor to check whether it currently sits inside
// an onMessage(...) { ... } function body — used to scope the bare
// `message === "..."` completion trigger below so it only fires where
// `message` is actually the onMessage parameter, not just any variable
// happening to be named "message" elsewhere in the script.
//
// Approach: find the nearest onMessage( function/method declaration
// before the cursor, then brace-count from its opening `{` forward to the
// cursor position. If braces are still balanced (we haven't hit the
// closing `}` of that function yet), the cursor is inside its body. This
// is a heuristic, not a real parser — like the rest of this file's
// string/regex-based detection, it can be fooled by braces inside string
// literals or comments between the declaration and the cursor, but that's
// an acceptable, extremely rare miss for an autocomplete hint (worst case:
// the suggestion doesn't show up where it should, never a wrong crash).
function _isInsideOnMessageBody(textUntilPosition) {
  const declRx = /\bonMessage\s*\(\s*[a-zA-Z_$][\w$]*[^)]*\)\s*\{/g;
  let lastDecl = null;
  let m;
  while ((m = declRx.exec(textUntilPosition)) !== null) {
    lastDecl = m;
  }
  if (!lastDecl) return false;

  const bodyStart = lastDecl.index + lastDecl[0].length; // just after the opening `{`
  const between = textUntilPosition.slice(bodyStart);
  let depth = 1; // we're already past that one opening brace
  for (let i = 0; i < between.length; i++) {
    if (between[i] === "{") depth++;
    else if (between[i] === "}") {
      depth--;
      if (depth === 0) return false; // function already closed before the cursor
    }
  }
  return depth > 0;
}

// ─── String-argument context detection ───────────────────────────────────────
// Returns a string tag describing what kind of completions to provide when
// the cursor is inside a string argument (trigger character `"`).
//
// Patterns are ordered from most-specific to least-specific so the first
// match wins.
export function _detectStringContext(lineUntil, textUntilPosition) {
  // Each pattern matches the opening quote followed by zero or more characters
  // that are not a closing quote — so completions keep working as the user
  // types partial text inside the string (not just immediately after the quote).
  const q = `["'][^"']*`;

  // input.keyDown(" / input.keyPressed(" / input.keyUp(" etc.
  if (new RegExp(`\\binput\\s*\\.\\s*key\\w*\\s*\\(\\s*${q}$`).test(lineUntil)) return "keyCode";

  // tween(target, properties, duration, "easeOutCubic") — offer the exact
  // easing catalogue accepted by the runtime tween scheduler.
  if (new RegExp(`\\btween\\s*\\([^)]*,\\s*${q}$`).test(lineUntil)) return "tweenEasing";

  // scene.load("
  if (new RegExp(`\\bscene\\s*\\.\\s*load\\s*\\(\\s*${q}$`).test(lineUntil)) return "sceneName";

  // scene.findFirst("
  if (new RegExp(`\\bscene\\s*\\.\\s*findFirst\\s*\\(\\s*${q}$`).test(lineUntil)) return "entityName";

  // findWithTag(" / findFirstWithTag(" / findAllWithTag("  (top-level or scene.*)
  // — checked BEFORE the findFirst("/findAll(" pattern below since these are
  // all longer names that happen to start with "find"; matching this first
  // stops e.g. findFirstWithTag(" from also (wrongly) satisfying a
  // looser find*( check further down.
  if (new RegExp(`\\b(?:scene\\s*\\.\\s*)?find(?:First|All)?WithTag\\s*\\(\\s*${q}$`).test(lineUntil)) return "entityTag";

  // findFirst(" / findAll("  (top-level or scene.*) — name lookups.
  // Note: bare find( no longer exists as an engine global — removed as a
  // duplicate of findFirst(), so this pattern requires First/All.
  if (new RegExp(`\\b(?:scene\\s*\\.\\s*)?find(?:First|All)\\s*\\(\\s*${q}$`).test(lineUntil)) return "entityName";

  // spawn("  (top-level shortcut or this.spawn — clones by name by default)
  if (new RegExp(`\\bspawn\\s*\\(\\s*${q}$`).test(lineUntil)) return "entityName";

  // mouse.isOver(" / mouse.clickedOn("  — name lookup by default (byTag
  // is an opts flag, same convention as spawn's {byTag:true})
  if (new RegExp(`\\bmouse\\s*\\.\\s*(?:isOver|clickedOn)\\s*\\(\\s*${q}$`).test(lineUntil)) return "entityName";

  // touch.isOver(" / touch.tappedOn("  — same name-lookup convention as
  // mouse.isOver/clickedOn just above, touch's own equivalent pair.
  if (new RegExp(`\\btouch\\s*\\.\\s*(?:isOver|tappedOn)\\s*\\(\\s*${q}$`).test(lineUntil)) return "entityName";

  // animator.play("
  if (new RegExp(`\\banimator\\s*\\.\\s*play\\s*\\(\\s*${q}$`).test(lineUntil)) return "clipName";

  // .texture = " or .texture = '
  if (new RegExp(`\\.texture\\s*=\\s*${q}$`).test(lineUntil)) return "textureName";

  // nav.areaIndex(" — single named NavWorld2D area (see NavAPI.js's
  // resolveNavAreaIndex and Edit → Nav Areas… for where names come from)
  if (new RegExp(`\\bnav\\s*\\.\\s*areaIndex\\s*\\(\\s*${q}$`).test(lineUntil)) return "navAreaName";

  // nav.areaMask(" or nav.areaMask("Ground", " — one or more named areas,
  // comma-separated; matches both the first argument and any later one
  // after a comma so completions keep working as the user adds more names.
  if (new RegExp(`\\bnav\\s*\\.\\s*areaMask\\s*\\(\\s*(?:${q}["']\\s*,\\s*)*${q}$`).test(lineUntil)) return "navAreaName";

  // sendMessage(tag, ...) — first argument is a tag
  if (new RegExp(`\\bsendMessage\\s*\\(\\s*${q}$`).test(lineUntil)) return "entityTag";

  // sendMessage("tag", "msg") — second arg: show names of existing handlers
  if (new RegExp(`\\bsendMessage\\s*\\(\\s*${q}["']\\s*,\\s*${q}$`).test(lineUntil)) return "messageHandled";

  // broadcastMessage("msg") — first arg: show names of existing handlers
  if (new RegExp(`\\bbroadcastMessage\\s*\\(\\s*${q}$`).test(lineUntil)) return "messageHandled";

  // onMessage(message) is a FUNCTION DECLARATION (the parameter is just a
  // name, like `function onMessage(message) {`) — NOT a call you invoke
  // with a literal like onMessage("shoot"), which throws at runtime
  // ("shoot" is not a valid parameter list). The actual message-name
  // check belongs inside that function's body, as
  // `if (message === "shoot") { ... }` — see the "message === " pattern
  // below, which is where message-name completions now show up instead.
  // Kept as a distinct (non-matching) comment here rather than silently
  // deleting the case, so it's clear this was intentionally moved, not
  // forgotten, if anyone searches for "onMessage(" completions later.

  // .tag === " / .tag == " / .tag !== "
  if (new RegExp(`\\.tag\\s*[!=]==?\\s*${q}$`).test(lineUntil)) return "entityTag";

  // .name === " / .name == " / .name !== "
  if (new RegExp(`\\.name\\s*[!=]==?\\s*${q}$`).test(lineUntil)) return "entityName";

  // Bare `message === "` / `message == "` / `message !== "` — the actual
  // correct place to check a message name, inside an onMessage(message)
  // (or onMessage(message, ...)) function body. Scoped to that body via
  // _isInsideOnMessageBody() so a variable that happens to be named
  // "message" elsewhere in a script doesn't also trigger this.
  if (
    new RegExp(`\\bmessage\\s*[!=]==?\\s*${q}$`).test(lineUntil) &&
    _isInsideOnMessageBody(textUntilPosition)
  ) {
    return "messageSent";
  }

  // controller.targetName = "
  if (new RegExp(`\\.targetName\\s*=\\s*${q}$`).test(lineUntil)) return "entityName";

  // state.change(" — this.state.change("chasing")
  if (new RegExp(`\\bstate\\s*\\.\\s*change\\s*\\(\\s*${q}$`).test(lineUntil)) return "stateName";

  // state.current === " / == " / !== " — this.state.current === "chasing"
  if (new RegExp(`\\bstate\\s*\\.\\s*current\\s*[!=]==?\\s*${q}$`).test(lineUntil)) return "stateName";

  // save.get(" / save.has(" / save.delete(" / save.set(" — all keyed off
  // the same key namespace, so all four complete from the same scanned set.
  if (new RegExp(`\\bsave\\s*\\.\\s*(?:get|has|delete|set)\\s*\\(\\s*${q}$`).test(lineUntil)) return "saveKey";

  // <var>.hasComponent("  (this.hasComponent(" / enemy.hasComponent(" / etc.)
  if (new RegExp(`\\bhasComponent\\s*\\(\\s*${q}$`).test(lineUntil)) return "componentKey";

  // light.type = " / light.type === " / == " / !== "
  if (new RegExp(`\\blight\\s*\\.\\s*type\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "lightType";

  // .rigidbody.type = " / this.rigidbody.type === "
  if (new RegExp(`\\brigidbody\\s*\\.\\s*type\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "bodyType";

  // shape.shapeType = " / shape.shapeType === " etc.
  if (new RegExp(`\\bshape\\s*\\.\\s*shapeType\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "shapeType";

  // joint.jointType = " / joint.jointType === " etc.
  if (new RegExp(`\\bjoint\\s*\\.\\s*jointType\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "jointType";

  // joint.textureMode = " / strokePath.textureMode = " etc. — same
  // 'stretch' | 'tile' vocabulary on both components (see
  // Joint2D.js/StrokePath.js), so one shared context covers both.
  if (new RegExp(`\\b(?:joint|strokePath)\\s*\\.\\s*textureMode\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "textureMode";

  // text.align = " / === " etc.
  if (new RegExp(`\\btext\\s*\\.\\s*align\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "textAlign";

  // speechBubble.tailDirection = " / === " etc.
  if (new RegExp(`\\bspeechBubble\\s*\\.\\s*tailDirection\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "tailDirection";

  // joystick.positionMode = " / === " etc.
  if (new RegExp(`\\bjoystick\\s*\\.\\s*positionMode\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "joystickPositionMode";

  // camera.aspectMode = " / === " etc.
  if (new RegExp(`\\bcamera\\s*\\.\\s*aspectMode\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "cameraAspectMode";

  // camera.scalingMode = " / === " etc.
  if (new RegExp(`\\bcamera\\s*\\.\\s*scalingMode\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "cameraScalingMode";

  // strokePath.jointMode = " / === " etc. (also matches this.strokePath.…)
  if (new RegExp(`\\bstrokePath\\s*\\.\\s*jointMode\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "strokePathJointMode";

  // strokePath.capMode = " / === " etc.
  if (new RegExp(`\\bstrokePath\\s*\\.\\s*capMode\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "strokePathCapMode";

  // controller.controllerType === " / == " / !== " (read-only — comparison only)
  if (new RegExp(`\\bcontroller\\s*\\.\\s*controllerType\\s*[!=]==?\\s*${q}$`).test(lineUntil)) return "controllerType";

  // controller.patrolMode = " / === " etc.
  if (new RegExp(`\\bcontroller\\s*\\.\\s*patrolMode\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "patrolMode";

  // controller.patrolAxis = " / === " etc.
  if (new RegExp(`\\bcontroller\\s*\\.\\s*patrolAxis\\s*[!=]?==?\\s*${q}$`).test(lineUntil)) return "patrolAxis";

  return null;
}

// Component *title* names for hasComponent(" autocomplete — one entry per
// actual component type (matches COMPONENT_APIS / CAST_TARGETS' base
// names), deliberately NOT every subtype alias (DynamicBody/KinematicBody/
// StaticBody, PlatformerController/TopDownController/CarController/
// FollowController, PointLight/SpotLight/etc.). hasComponent() checks
// "does this entity have a Rigidbody2D at all", not which body-type
// variant — subtype narrowing already happens automatically off the key,
// so offering 30 near-duplicate strings here would just bury the 13 real
// answers under aliases that all resolve to the same component.
const COMPONENT_KEY_NAMES = [
  { label: "Transform", detail: "Every entity always has one — hasComponent(\"Transform\") is always true." },
  { label: "SpriteRenderer", detail: "Sprite component" },
  { label: "Text", detail: "Text renderer component" },
  { label: "SpeechBubble", detail: "Speech bubble component" },
  { label: "ChatLog", detail: "Chat log component" },
  { label: "TextInput", detail: "Text input component" },
  { label: "Joystick", detail: "On-screen virtual joystick component" },
  { label: "Rigidbody2D", detail: "Rigidbody component (any body type — dynamic, kinematic, or static)" },
  { label: "Animator", detail: "Sprite animation component" },
  { label: "Camera", detail: "Camera component" },
  { label: "AudioSource", detail: "Audio source component" },
  { label: "Collider2D", detail: "Collider component" },
  { label: "Joint2D", detail: "Joint component (any joint type — Fixed, Revolute, Prismatic, Rope, or Spring)" },
  { label: "Controller", detail: "Character controller component (any controller type)" },
  { label: "Light", detail: "Light component (any light type)" },
  { label: "ShadowCaster", detail: "Shadow caster component" },
  { label: "StrokePath", detail: "Stroke path component" },
];

// ─── Fixed-vocabulary enum value lists ─────────────────────────────────────
// Unlike entityName/sceneName/textureName/stateName/saveKey (scanned live
// from project data), these are read/write string fields whose valid set
// is small and fixed by the engine itself (see each component's own
// Object.freeze(...) export) — so the list below is just that same set,
// not something scanned from scripts. Covers every ENUM-typed field a
// script can actually set or compare against a literal string; fields
// scripts can only ever READ BACK (never write or meaningfully compare,
// e.g. Rigidbody2D's own body-type subtype) are left out since there's
// nothing to mistype.
const LIGHT_TYPE_NAMES = [
  { label: LightType.DIRECTIONAL, detail: "Parallel rays from one direction, no falloff with distance — sun/moon-style lighting." },
  { label: LightType.POINT, detail: "Radiates outward from a single point, fading with distance — torches, bulbs, explosions." },
  { label: LightType.SPOT, detail: "Cone-shaped, like Point but restricted to an angle — flashlights, headlights." },
  { label: LightType.AREA, detail: "Emits from a rectangular region instead of a single point — soft window/screen glow." },
  { label: LightType.GOD_RAYS, detail: "Point light with visible volumetric shafts through the shadow mask." },
  { label: LightType.FREEFORM, detail: "Emits from a custom polygon outline instead of a point or rectangle." },
];

const SHAPE_TYPE_NAMES = [
  { label: ShapeType.SQUARE, detail: "Rectangle, sized by width/height." },
  { label: ShapeType.CIRCLE, detail: "Circle, sized by radius." },
  { label: ShapeType.TRIANGLE, detail: "Freeform 3-point triangle, edited via handles in the Scene view." },
  { label: ShapeType.CAPSULE, detail: "Pill shape, sized by capsuleHalfHeight/capsuleRadius." },
];

const JOINT_TYPE_NAMES = [
  { label: JointType2D.FIXED, detail: "Welds the two bodies together rigidly — no relative motion at all. Uses anchor1/anchor2 only." },
  { label: JointType2D.REVOLUTE, detail: "Free to rotate around the anchor point — a hinge. Supports optional motor/limits." },
  { label: JointType2D.PRISMATIC, detail: "Free to slide along a single axis only. Supports optional motor/limits." },
  { label: JointType2D.ROPE, detail: "Multi-segment chain with a hard maximum-distance backstop — bends and sags but never stretches past length." },
  { label: JointType2D.SPRING, detail: "Multi-segment chain with no hard backstop — can stretch past length and oscillate, tuned by stiffness/damping." },
];

// Shared by joint.textureMode (Joint2D.js) and strokePath.textureMode
// (StrokePath.js) — same two string values on both components.
const TEXTURE_MODE_NAMES = [
  { label: "stretch", detail: "Fit the whole texture end-to-end, however long the line is — simple, but a fixed-scale texture (brick, dashed stripes) visibly warps as length changes." },
  { label: "tile", detail: "Repeat the texture at its native size, over and over, without stretching — textureTiling sets how many px one tile covers." },
];

// text.align — TextRenderer.js's multi-line alignment field.
const TEXT_ALIGN_NAMES = [
  { label: "left", detail: "Lines are left-aligned." },
  { label: "center", detail: "Lines are centered." },
  { label: "right", detail: "Lines are right-aligned." },
];

// speechBubble.tailDirection — SpeechBubble.js's pointer-triangle edge.
const TAIL_DIRECTION_NAMES = [
  { label: "down", detail: "Pointer triangle sits on the bottom edge (default — bubble above, pointing down at the entity)." },
  { label: "up", detail: "Pointer triangle sits on the top edge." },
  { label: "left", detail: "Pointer triangle sits on the left edge." },
  { label: "right", detail: "Pointer triangle sits on the right edge." },
  { label: "none", detail: "No pointer triangle drawn." },
];

const JOYSTICK_POSITION_MODE_NAMES = [
  { label: JoystickPositionMode.FIXED, detail: "Always drawn at the entity's own Transform position — never moves." },
  { label: JoystickPositionMode.DYNAMIC, detail: "Appears centered wherever the player first presses down inside activeRegion." },
];

const CAMERA_ASPECT_MODE_NAMES = [
  { label: CameraAspectMode.LANDSCAPE, detail: "Uses landscapeWidth x landscapeHeight as the reference resolution." },
  { label: CameraAspectMode.PORTRAIT, detail: "Uses portraitWidth x portraitHeight as the reference resolution." },
  { label: CameraAspectMode.SQUARE, detail: "1:1, driven by squareSize." },
  { label: CameraAspectMode.CUSTOM, detail: "Uses customWidth x customHeight verbatim." },
];

const CAMERA_SCALING_MODE_NAMES = [
  { label: ScalingMode.EXPAND, detail: "One axis locked to fill the screen; the other reveals more/less world to match the device — no bars, no cropping." },
  { label: ScalingMode.FIT, detail: "Scales uniformly so the whole reference resolution is visible, adding letterbox/pillarbox bars if needed." },
  { label: ScalingMode.FILL, detail: "Scales uniformly to fill the screen, cropping whichever axis overflows." },
  { label: ScalingMode.STRETCH, detail: "Maps width/height independently to fill the screen exactly — can visually distort the game." },
];

const STROKE_PATH_JOINT_MODE_NAMES = [
  { label: StrokePathJointMode.SHARP, detail: "Hard corner, no smoothing at the joint." },
  { label: StrokePathJointMode.BEVEL, detail: "Corner chamfered flat with a single straight line across the joint." },
  { label: StrokePathJointMode.ROUND, detail: "Corner rounded off with a filled arc." },
];

const STROKE_PATH_CAP_MODE_NAMES = [
  { label: StrokePathCapMode.NONE, detail: "Path stops flat at the last segment's own edge — no cap geometry." },
  { label: StrokePathCapMode.BOX, detail: "End extended slightly past the last point with a flat square edge." },
  { label: StrokePathCapMode.ROUND, detail: "End capped with a filled half-circle." },
];

// controller.controllerType is READ-ONLY from scripts (no setter — see
// ControllerAPI.js), but scripts routinely compare it against a literal
// (if (this.controller.controllerType === "Car")), which is just as easy
// to mistype as a real assignment — so it still gets a completion list.
const CONTROLLER_TYPE_NAMES = [
  { label: ControllerType.CHARACTER, detail: "Classic 4/8-way move, optional gravity." },
  { label: ControllerType.PLATFORMER, detail: "Side-scroller: horizontal move + jump, gravity always on." },
  { label: ControllerType.TOP_DOWN, detail: "8-directional move, no gravity, no jump." },
  { label: ControllerType.CAR, detail: "Arcade-style car: throttle/brake + steer, moves along heading." },
  { label: ControllerType.FOLLOW, detail: "AI pursuit: homes toward a named target entity at set speed." },
  { label: ControllerType.PATROL, detail: "AI ground patrol: walks back and forth, auto-turning at a wall or after patrolDistance." },
  { label: ControllerType.FREE, detail: "No built-in input mapping — script-driven only." },
];

const RIGIDBODY_TYPE_NAMES = [
  { label: BodyType.DYNAMIC, detail: "Full physics — forces, impulses, gravity, collisions all handled by Rapier's solver." },
  { label: BodyType.KINEMATIC, detail: "Script/controller-driven — set velocity or call move(dx, dy); still collides with and pushes Dynamic bodies." },
  { label: BodyType.STATIC, detail: "Never moves on its own — the default for walls/floors. A Collider2D with no Rigidbody2D at all behaves the same way." },
];

// controller.patrolMode — Patrol's own movement scheme, writable from
// script (this.controller.patrolMode = "Top-Down"). See PatrolMode in
// CharacterController.js.
const PATROL_MODE_NAMES = [
  { label: PatrolMode.PLATFORMER, detail: "Original Patrol behavior — gravity always on, walks left/right only, turns on a wall contact." },
  { label: PatrolMode.TOP_DOWN, detail: "No gravity — walks along whichever single axis patrolAxis picks, turning on an obstacle along that axis." },
];

// controller.patrolAxis — which single axis a Top-Down-mode Patrol
// walks along, writable from script. Meaningless (ignored) in
// Platformer mode. See PatrolAxis in CharacterController.js.
const PATROL_AXIS_NAMES = [
  { label: PatrolAxis.HORIZONTAL, detail: "Walks left/right; turns on a wall contact (rigidbody.isOnWall)." },
  { label: PatrolAxis.VERTICAL, detail: "Walks up/down; turns on a ceiling/ground contact (rigidbody.isOnCeiling / grounded)." },
];

// ─── Whole-document diagnostics (typo squiggles) ──────────────────────────────
// Scans the full script text for calls whose string argument we can verify
// against live scene/project data (find("Player"), input.keyDown("KeyA"),
// .texture = "icon", etc.) and flags values that don't match anything that
// currently exists — the classic "works until Play mode, then silently no-ops"
// class of bug (misspelled entity name, wrong key code, renamed texture).
//
// This is intentionally separate from Monaco's built-in JS diagnostics
// (which stay disabled — see ScriptEditorWindow.js) so it can't get
// confused by engine-only globals like `find`/`this.transform` that aren't
// real JS. Markers are owned under a private marker "owner" name so they
// never collide with or get cleared by any other diagnostics source.
const DIAGNOSTIC_OWNER = "realot-string-args";

// One entry per validated call pattern: regex captures the string value,
// `values()` returns the current valid set, `label` is used in the message.
// The regex is intentionally the same shape as _detectStringContext's
// patterns but anchored to a full call (opening AND closing quote) instead
// of "up to the cursor", since this runs on the whole document, not live
// per-keystroke.
function _diagnosticRules() {
  return [
    {
      label: "key code",
      regex: /\binput\s*\.\s*key\w*\s*\(\s*["']([^"']*)["']/g,
      values: () => new Set(ALL_KEY_CODES),
      hint: (v) => `Unknown key code "${v}". Check spelling — key codes are case-sensitive (e.g. "KeyA", "Space", "ArrowLeft").`,
    },
    {
      label: "scene name",
      regex: /\bscene\s*\.\s*load\s*\(\s*["']([^"']*)["']/g,
      values: () => new Set(_getSceneNames()),
      hint: (v) => `No scene named "${v}" found in the project.`,
    },
    {
      label: "entity name",
      regex: /\b(?:scene\s*\.\s*)?find(?:First|All)\s*\(\s*["']([^"']*)["']/g,
      values: () => new Set(_getEntityNames()),
      hint: (v) => `No object named "${v}" found in the current scene.`,
    },
    {
      label: "entity tag",
      regex: /\b(?:scene\s*\.\s*)?find(?:First|All)?WithTag\s*\(\s*["']([^"']*)["']/g,
      values: () => new Set(_getEntityTags()),
      hint: (v) => `No object in the scene currently has the tag "${v}".`,
    },
    {
      label: "animation clip",
      regex: /\banimator\s*\.\s*play\s*\(\s*["']([^"']*)["']/g,
      values: () => new Set(_getAnimClipNames()),
      hint: (v) => `No animation clip named "${v}" on this object.`,
    },
    {
      label: "texture",
      regex: /\.texture\s*=\s*["']([^"']*)["']/g,
      values: () => new Set(_getTextureNames()),
      hint: (v) => `No sprite/texture asset named "${v}" found in the project.`,
    },
    {
      label: "entity tag",
      regex: /\bsendMessage\s*\(\s*["']([^"']*)["']/g,
      values: () => new Set(_getEntityTags()),
      hint: (v) => `No object in the scene currently has the tag "${v}".`,
    },
    {
      label: "entity tag",
      regex: /\.tag\s*[!=]==?\s*["']([^"']*)["']/g,
      values: () => new Set(_getEntityTags()),
      hint: (v) => `No object in the scene currently has the tag "${v}".`,
    },
    {
      label: "entity name",
      regex: /\.name\s*[!=]==?\s*["']([^"']*)["']/g,
      values: () => new Set(_getEntityNames()),
      hint: (v) => `No object named "${v}" found in the current scene.`,
    },
    {
      label: "entity name",
      regex: /\.targetName\s*=\s*["']([^"']*)["']/g,
      values: () => new Set(_getEntityNames()),
      hint: (v) => `No object named "${v}" found in the current scene. The Follow controller needs targetName to match an existing object's name exactly.`,
    },
    {
      // Warn if a script checks `message === "X"` inside an onMessage
      // body, but nothing anywhere calls sendMessage(...) / broadcastMessage(...)
      // with that name — i.e. a handled message that can never fire.
      // Uses `matches` (a function returning pre-found hits) instead of
      // a plain `regex` like the other rules here: the check needs to be
      // scoped to onMessage(...) function bodies specifically (a
      // variable elsewhere in a script that just happens to be named
      // "message" shouldn't be flagged), which a single unscoped regex
      // over the whole file can't express — see _findHandledMessageChecks.
      label: "message name",
      matches: (text) => _findHandledMessageChecks(text).map((h) => ({ index: h.index, length: h.matchLength, value: h.name })),
      values: () => _getSentMessageNames(),
      hint: (v) => `No script sends the message "${v}". Check spelling matches your sendMessage / broadcastMessage call.`,
    },
    {
      // sendMessage("tag","msg") — warn if nothing handles "msg".
      label: "message name",
      regex: /\bsendMessage\s*\(\s*["'][^"']*["']\s*,\s*["']([^"']+)["']/g,
      values: () => _getHandledMessageNames(),
      hint: (v) => `No script has an onMessage("${v}") handler. Check spelling matches your onMessage declaration.`,
    },
    {
      // broadcastMessage("msg") — warn if nothing handles "msg".
      label: "message name",
      regex: /\bbroadcastMessage\s*\(\s*["']([^"']+)["']/g,
      values: () => _getHandledMessageNames(),
      hint: (v) => `No script has an onMessage("${v}") handler. Check spelling matches your onMessage declaration.`,
    },
    {
      // save.get("key") / save.has("key") / save.delete("key") — warn if
      // nothing anywhere calls save.set() with that key, since a typo
      // here silently returns undefined (get) or a no-op (has/delete)
      // instead of throwing — exactly the "works until Play mode, then
      // silently no-ops" class of bug this file exists to catch.
      label: "save key",
      regex: /\bsave\s*\.\s*(?:get|has|delete)\s*\(\s*["']([^"']+)["']/g,
      values: () => _getSaveKeyNames(),
      hint: (v) => `No script ever calls save.set("${v}", ...). Check spelling matches your save.set() call.`,
    },
    {
      // light.type = "X" / light.type === "X" — fixed vocabulary (see
      // LightType in Light.js), so unlike state/save names, ANY value
      // outside the set is unambiguously a typo, not just an unseen one.
      label: "light type",
      regex: /\blight\s*\.\s*type\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(LIGHT_TYPE_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid Light type. Valid values: ${LIGHT_TYPE_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // shape.shapeType = "X" / === "X" — fixed vocabulary (ShapeType).
      label: "shape type",
      regex: /\bshape\s*\.\s*shapeType\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(SHAPE_TYPE_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid ShapeRenderer shape. Valid values: ${SHAPE_TYPE_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // joint.jointType = "X" / === "X" — fixed vocabulary (JointType2D).
      label: "joint type",
      regex: /\bjoint\s*\.\s*jointType\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(JOINT_TYPE_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid Joint2D jointType. Valid values: ${JOINT_TYPE_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // joint.textureMode = "X" / strokePath.textureMode = "X" — same
      // fixed 'stretch' | 'tile' vocabulary on both components.
      label: "texture mode",
      regex: /\b(?:joint|strokePath)\s*\.\s*textureMode\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(TEXTURE_MODE_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid textureMode. Valid values: ${TEXTURE_MODE_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // text.align = "X" / === "X" — fixed vocabulary (TextRenderer.js).
      label: "text align",
      regex: /\btext\s*\.\s*align\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(TEXT_ALIGN_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid text align. Valid values: ${TEXT_ALIGN_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // speechBubble.tailDirection = "X" / === "X" — fixed vocabulary
      // (SpeechBubble.js).
      label: "tail direction",
      regex: /\bspeechBubble\s*\.\s*tailDirection\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(TAIL_DIRECTION_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid tailDirection. Valid values: ${TAIL_DIRECTION_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // joystick.positionMode = "X" / === "X" — fixed vocabulary.
      label: "joystick position mode",
      regex: /\bjoystick\s*\.\s*positionMode\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(JOYSTICK_POSITION_MODE_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid Joystick position mode. Valid values: ${JOYSTICK_POSITION_MODE_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // camera.aspectMode = "X" / === "X" — fixed vocabulary.
      label: "camera aspect mode",
      regex: /\bcamera\s*\.\s*aspectMode\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(CAMERA_ASPECT_MODE_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid Camera aspect mode. Valid values: ${CAMERA_ASPECT_MODE_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // camera.scalingMode = "X" / === "X" — fixed vocabulary.
      label: "camera scaling mode",
      regex: /\bcamera\s*\.\s*scalingMode\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(CAMERA_SCALING_MODE_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid Camera scaling mode. Valid values: ${CAMERA_SCALING_MODE_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // strokePath.jointMode = "X" / === "X" — fixed vocabulary.
      label: "stroke path joint mode",
      regex: /\bstrokePath\s*\.\s*jointMode\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(STROKE_PATH_JOINT_MODE_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid StrokePath joint mode. Valid values: ${STROKE_PATH_JOINT_MODE_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // strokePath.capMode = "X" / === "X" — fixed vocabulary.
      label: "stroke path cap mode",
      regex: /\bstrokePath\s*\.\s*capMode\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(STROKE_PATH_CAP_MODE_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid StrokePath cap mode. Valid values: ${STROKE_PATH_CAP_MODE_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // controller.controllerType === "X" — READ-ONLY field, but still a
      // fixed vocabulary comparison worth flagging if it can never be true.
      label: "controller type",
      regex: /\bcontroller\s*\.\s*controllerType\s*[!=]==?\s*["']([^"']+)["']/g,
      values: () => new Set(CONTROLLER_TYPE_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid Controller type. Valid values: ${CONTROLLER_TYPE_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // controller.patrolMode = "X" / === "X" — fixed vocabulary.
      label: "patrol mode",
      regex: /\bcontroller\s*\.\s*patrolMode\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(PATROL_MODE_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid Patrol mode. Valid values: ${PATROL_MODE_NAMES.map((v) => v.label).join(", ")}.`,
    },
    {
      // controller.patrolAxis = "X" / === "X" — fixed vocabulary.
      label: "patrol axis",
      regex: /\bcontroller\s*\.\s*patrolAxis\s*[!=]?==?\s*["']([^"']+)["']/g,
      values: () => new Set(PATROL_AXIS_NAMES.map((v) => v.label)),
      hint: (v) => `"${v}" isn't a valid Patrol axis. Valid values: ${PATROL_AXIS_NAMES.map((v) => v.label).join(", ")}.`,
    },
  ];
}

/**
 * Same onMessage-body-scoped scan as _getHandledMessageNames, but
 * returns { name, index }[] instead of a Set — the diagnostic runner
 * needs a document offset per match to place a squiggle, which a Set of
 * names alone can't give it. Kept as a separate function (rather than
 * changing _getHandledMessageNames' return shape) since that one is also
 * called from the autocomplete path above, which only ever needed names.
 */
function _findHandledMessageChecks(text) {
  const results = [];
  const checkRx = /\bmessage\s*===?\s*["']([^"']+)["']/g;
  const declRx = /\bonMessage\s*\(\s*[a-zA-Z_$][\w$]*[^)]*\)\s*\{/g;
  let decl;
  while ((decl = declRx.exec(text)) !== null) {
    const bodyStart = decl.index + decl[0].length;
    let depth = 1;
    let bodyEnd = text.length;
    for (let i = bodyStart; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    const body = text.slice(bodyStart, bodyEnd);
    checkRx.lastIndex = 0;
    let m;
    while ((m = checkRx.exec(body)) !== null) {
      results.push({ name: m[1], index: bodyStart + m.index, matchLength: m[0].length });
    }
  }
  return results;
}

/** Scan the model's full text and return Monaco marker objects for any
 *  string-argument value that doesn't match live scene/project data.
 *  Empty strings ("" — still being typed) are skipped so half-typed code
 *  never gets flagged. */
function _computeDiagnostics(monaco, model) {
  const text = model.getValue();
  const markers = [];
  const rules = _diagnosticRules();

  for (const rule of rules) {
    const valid = rule.values();
    // Nothing to validate against yet (e.g. no textures imported) — skip
    // rather than flag every single call as wrong.
    if (valid.size === 0) continue;

    // Rules that need scoping beyond a single global regex (e.g. only
    // inside an onMessage body) supply `matches(text)` directly instead
    // of `regex` — see the "message name" rule above for why.
    const hits = rule.matches
      ? rule.matches(text)
      : (() => {
          rule.regex.lastIndex = 0;
          const found = [];
          let mm;
          while ((mm = rule.regex.exec(text)) !== null) {
            const value = mm[1];
            if (!value) continue;
            found.push({ index: mm.index + mm[0].length - value.length - 1, length: value.length, value });
          }
          return found;
        })();

    for (const hit of hits) {
      const value = hit.value;
      if (!value) continue; // still-empty string, nothing to check yet
      if (valid.has(value)) continue;

      const startPos = model.getPositionAt(hit.index);
      const endPos = model.getPositionAt(hit.index + hit.length);

      markers.push({
        severity: monaco.MarkerSeverity.Warning,
        message: rule.hint(value),
        startLineNumber: startPos.lineNumber,
        startColumn: startPos.column,
        endLineNumber: endPos.lineNumber,
        endColumn: endPos.column,
        source: "Realot",
      });
    }
  }

  return markers;
}

// ─── Unknown-type member-access warnings ─────────────────────────────────────
// Spec rule #7: calling/reading a member on a variable whose type is
// Unknown is a WARNING (never a compile error) — "Cannot verify that
// 'addForce()' exists because the type of 'enemy' is Unknown."
// Deliberately conservative: only variables this file can positively
// identify as originating from a call whose return type it can't infer
// (i.e. NOT a literal, NOT `this`, NOT find()/findFirst()/raycast(),
// NOT cast, NOT narrowed at that point in the file) are flagged, and
// only for member names outside BASE_OBJECT_API. This avoids false
// positives on ordinary plain-JS variables (numbers, strings, arrays)
// that scripts legitimately use all the time.
const BASE_OBJECT_MEMBER_NAMES = new Set(
  BASE_OBJECT_API.map((i) => i.label.replace(/\(.*$/, ""))
);

// const enemy = someFunctionCall(...);  — the shape this module treats
// as "Unknown until proven otherwise". Deliberately excludes obvious
// non-entity literals (numbers, strings, arrays, object literals,
// `new X(...)`) so plain data variables are never flagged.
const UNKNOWN_ORIGIN_RX = /(?:\b(?:var|let|const)\s+)?(\w+)\s*=\s*(?!\d|["'`\[{]|new\s)([\w.]+)\s*\(/g;

function _findUnknownVariables(text) {
  const names = new Set();
  UNKNOWN_ORIGIN_RX.lastIndex = 0;
  let m;
  while ((m = UNKNOWN_ORIGIN_RX.exec(text)) !== null) {
    const callee = m[2];
    // Calls the engine already infers a concrete type for are not Unknown —
    // leave those to the existing find()/raycast() tracking paths instead
    // of double-flagging them here. find()/findFirst()/findFirstWithTag()
    // all return a single EntityContext (or null) — same shape — so all
    // three are excluded here. findAll()/findWithTag()/findAllWithTag()
    // return ARRAYS, not a single entity, so they're deliberately left
    // OUT of this exclusion list: `arr.hasComponent(...)` really would be
    // calling a method that doesn't exist on an array, and should still
    // warn (just not as "Unknown" — that's a different bug, not this one).
    //
    // Math.*/mathx.* calls always return a known primitive (number or
    // boolean) — never an entity/Unknown-shaped object — so a variable
    // assigned from one (const dmg = Math.floor(x), const t = mathx.clamp(...))
    // must never be treated as Unknown. Without this exclusion, ANY later
    // unrelated `dmg.something(...)` call anywhere else in the file gets
    // flagged as "Cannot verify that '...' exists" — a false-positive
    // warning storm on completely ordinary numeric code.
    if (/^(?:Math|mathx|random)\s*\./.test(callee)) continue;
    if (/^(?:findFirst|findFirstWithTag|scene\s*\.\s*findFirst|scene\s*\.\s*findFirstWithTag|physics\s*\.\s*raycast)$/.test(callee)) continue;
    names.add(m[1]);
  }
  return names;
}

function _computeUnknownWarnings(monaco, model) {
  const text = model.getValue();
  const markers = [];
  const unknownVars = _findUnknownVariables(text);
  if (unknownVars.size === 0) return markers;

  const castVars = parseCastVariables(text);

  for (const varName of unknownVars) {
    if (castVars.has(varName)) continue; // explicitly cast — no longer Unknown from that point on

    const memberRx = new RegExp("\\b" + varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\.\\s*(\\w+)\\s*\\(", "g");
    let m;
    while ((m = memberRx.exec(text)) !== null) {
      const member = m[1];
      if (BASE_OBJECT_MEMBER_NAMES.has(member)) continue;

      const callOffset = m.index;
      const narrowed = getNarrowedType(text, callOffset, varName);
      if (narrowed) continue; // narrowed to a concrete type at this point in the file — safe

      const memberStart = m.index + m[0].lastIndexOf(member);
      const startPos = model.getPositionAt(memberStart);
      const endPos = model.getPositionAt(memberStart + member.length);
      markers.push({
        severity: monaco.MarkerSeverity.Warning,
        message: `Cannot verify that '${member}()' exists because the type of '${varName}' is Unknown.`,
        startLineNumber: startPos.lineNumber,
        startColumn: startPos.column,
        endLineNumber: endPos.lineNumber,
        endColumn: endPos.column,
        source: "Realot",
      });
    }
  }

  return markers;
}

/** Re-run diagnostics on a model and apply them as squiggly-underline
 *  markers. Safe to call often — pass a debounced caller from the editor
 *  (see ScriptEditorWindow.js) so it doesn't re-scan on every keystroke. */
export function refreshScriptDiagnostics(monaco, model) {
  if (!monaco || !model || model.isDisposed()) return;
  try {
    const markers = _computeDiagnostics(monaco, model).concat(_computeUnknownWarnings(monaco, model));
    monaco.editor.setModelMarkers(model, DIAGNOSTIC_OWNER, markers);
  } catch (e) {
    // Never let a diagnostics bug break the editor itself.
    console.warn("[Realot IntelliSense] diagnostics pass failed:", e);
  }
}

/** Clear any diagnostics markers previously applied to a model (called
 *  when a model is disposed so stale markers don't linger). */
export function clearScriptDiagnostics(monaco, model) {
  if (!monaco || !model || model.isDisposed()) return;
  try {
    monaco.editor.setModelMarkers(model, DIAGNOSTIC_OWNER, []);
  } catch (e) {}
}



/**
 * Scans the script for variables assigned from physics.raycast(…) so that
 * typing `hit.` offers { entity, point, normal, distance } completions.
 * Returns a Set of variable names assigned from raycast calls.
 */
function _parseRaycastVariables(text) {
  const names = new Set();
  // const hit = physics.raycast(…)  /  let hit = physics.raycast(…)  / hit = physics.raycast(…)
  const rx = /(?:\b(?:var|let|const)\s+)?(\w+)\s*=\s*physics\s*\.\s*raycast\s*\(/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    names.add(m[1]);
  }
  return names;
}

/**
 * True when `text` (everything in the document up to the cursor) leaves the
 * cursor sitting inside the options object literal of the LAST still-open
 * physics.raycast(…) call — i.e. after its 5th-argument "{" and before the
 * matching "}"/")". Works across multiple lines by scanning back from the
 * last "physics.raycast(" and doing simple paren/brace depth counting on
 * everything after it, ignoring characters inside string literals.
 */
function _isInsideRaycastOpts(text) {
  const callRx = /physics\s*\.\s*raycast\s*\(/g;
  let lastIdx = -1;
  let m;
  while ((m = callRx.exec(text)) !== null) lastIdx = m.index + m[0].length;
  if (lastIdx === -1) return false;

  const tail = text.slice(lastIdx);
  let parenDepth = 1; // the "(" already consumed by the regex match
  let braceDepth = 0;
  let inString = null;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "(") parenDepth++;
    else if (ch === ")") { parenDepth--; if (parenDepth <= 0) return false; }
    else if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
  }
  // Still inside the raycast(...) call overall, AND inside an opened,
  // unclosed "{" within it — that "{" is the opts object literal (raycast
  // takes no other object-literal argument).
  return parenDepth > 0 && braceDepth > 0;
}

/**
 * Given text up to the cursor that _isInsideRaycastOpts already confirmed is
 * inside a raycast opts literal, returns the Set of key names already typed
 * in that literal (e.g. {"exclude"} after "exclude: [this], ") so they're
 * not suggested a second time.
 */
function _usedObjectKeys(text) {
  const lastBrace = text.lastIndexOf("{");
  const slice = lastBrace === -1 ? "" : text.slice(lastBrace + 1);
  const keys = new Set();
  const rx = /(\w+)\s*:/g;
  let m;
  while ((m = rx.exec(slice)) !== null) keys.add(m[1]);
  return keys;
}

/**
 * Generic version of _isInsideRaycastOpts: returns true when the cursor is
 * inside an open `{` that is itself inside a call matching `funcPattern`.
 * Used for camera.follow(target, { opts }) and spawn("name", { opts }).
 * funcPattern is a RegExp that matches the function call up to and including
 * its opening `(`, e.g. /camera\s*\.\s*follow\s*\(/.
 */
/**
 * Detect whether the cursor is inside a Nav API options object literal.
 * This intentionally covers both `nav.findPath(..., { ... })` and
 * `this.navMoveToward(..., { ... })`, including a newly typed empty `{}`.
 */
export function _detectNavOptionsContext(textUntil) {
  const patterns = [
    { name: "findPath", rx: /\bnav\s*\.\s*findPath\s*\(/g },
    { name: "navMoveToward", rx: /\bthis\s*\.\s*navMoveToward\s*\(/g },
    { name: "navDriveToward", rx: /\bthis\s*\.\s*navDriveToward\s*\(/g },
  ];

  let best = null;
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.rx.exec(textUntil)) !== null) {
      const start = m.index + m[0].length;
      if (!best || start > best.start) best = { name: pattern.name, start };
    }
  }
  if (!best) return null;

  const tail = textUntil.slice(best.start);
  let parenDepth = 1;
  let braceDepth = 0;
  let inString = null;
  let escaped = false;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth <= 0) return null;
    } else if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
  }

  return parenDepth > 0 && braceDepth > 0 ? best.name : null;
}

export function _navOptionCompletionItems(monaco, optionName) {
  const fields = NAV_API_OPTION_FIELDS[optionName];
  if (!fields) return [];
  return fields.map((field) => {
    let value = field.defaultValue;
    if (field.type === "boolean") value = String(Boolean(value));
    else if (field.type === "number") value = String(value);
    else value = JSON.stringify(value);
    return {
      label: field.name,
      detail: `${field.detail} Default: ${value}.`,
      insert: `${field.name}: ${value}`,
      kind: "Field",
      snippet: false,
    };
  });
}

export function _isInsideFunctionOptArg(text, funcPattern) {
  const callRx = new RegExp(funcPattern.source, "g");
  let lastIdx = -1;
  let m;
  while ((m = callRx.exec(text)) !== null) lastIdx = m.index + m[0].length;
  if (lastIdx === -1) return false;

  const tail = text.slice(lastIdx);
  let parenDepth = 1;
  let braceDepth = 0;
  let inString = null;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "(") parenDepth++;
    else if (ch === ")") { parenDepth--; if (parenDepth <= 0) return false; }
    else if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
  }
  return parenDepth > 0 && braceDepth > 0;
}

function _parseFindVariables(text) {
  const map = {};
  // findFirst("Name") returns a single EntityContext (or null), so it's
  // tracked here for component-key autocomplete on the assigned variable.
  // findAll(", findWithTag(", and findAllWithTag(" are deliberately NOT
  // included: they return ARRAYS, so `e.` on a variable assigned from one
  // of those would need per-element completions, not the single-entity
  // path this function feeds.
  const regex = /(?:\b(?:var|let|const)\s+)?(\w+)\s*=\s*findFirst\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    map[match[1]] = match[2];
  }
  return map;
}

function _entityComponentKeys(entityName) {
  if (!editorState.world) return null;
  const entity = editorState.world.findFirstByName(entityName);
  if (!entity) return null;
  const set = new Set();
  for (const c of COMPONENT_APIS) {
    if (entity.hasComponent(c.key)) set.add(c.key);
  }
  return set;
}

function _rigidbodyApiForBodyType(bodyType) {
  if (bodyType === BodyType.DYNAMIC) return RIGIDBODY_API_DYNAMIC;
  if (bodyType === BodyType.KINEMATIC) return RIGIDBODY_API_KINEMATIC;
  return RIGIDBODY_API_STATIC;
}

function _rigidbodyApiForEntities(entities) {
  const seen = new Set();
  const lists = [];
  for (const e of entities) {
    if (!e.hasComponent(RIGIDBODY_2D)) continue;
    const rb = e.getComponent(RIGIDBODY_2D);
    const bodyType = rb ? rb.bodyType : BodyType.STATIC;
    if (seen.has(bodyType)) continue;
    seen.add(bodyType);
    lists.push(_rigidbodyApiForBodyType(bodyType));
  }
  if (lists.length === 0) return RIGIDBODY_API_STATIC;
  if (lists.length === 1) return lists[0];
  const merged = [];
  const labelsSeen = new Set();
  for (const list of lists) {
    for (const item of list) {
      if (labelsSeen.has(item.label)) continue;
      labelsSeen.add(item.label);
      merged.push(item);
    }
  }
  return merged;
}

function _controllerApiForType(controllerType) {
  if (controllerType === ControllerType.CHARACTER) return CONTROLLER_API_CHARACTER;
  if (controllerType === ControllerType.PLATFORMER) return CONTROLLER_API_PLATFORMER;
  if (controllerType === ControllerType.TOP_DOWN) return CONTROLLER_API_TOP_DOWN;
  if (controllerType === ControllerType.CAR) return CONTROLLER_API_CAR;
  if (controllerType === ControllerType.FOLLOW) return CONTROLLER_API_FOLLOW;
  if (controllerType === ControllerType.PATROL) return CONTROLLER_API_PATROL;
  return CONTROLLER_API_FREE;
}

function _controllerApiForEntities(entities) {
  const seen = new Set();
  const lists = [];
  for (const e of entities) {
    if (!e.hasComponent(CHARACTER_CONTROLLER)) continue;
    const cc = e.getComponent(CHARACTER_CONTROLLER);
    const controllerType = cc ? cc.controllerType : ControllerType.FREE;
    if (seen.has(controllerType)) continue;
    seen.add(controllerType);
    lists.push(_controllerApiForType(controllerType));
  }
  if (lists.length === 0) return CONTROLLER_API_FREE;
  if (lists.length === 1) return lists[0];
  const merged = [];
  const labelsSeen = new Set();
  for (const list of lists) {
    for (const item of list) {
      if (labelsSeen.has(item.label)) continue;
      labelsSeen.add(item.label);
      merged.push(item);
    }
  }
  return merged;
}

function _lightApiForType(lightType) {
  switch (lightType) {
    case LightType.POINT:       return LIGHT_API_POINT;
    case LightType.DIRECTIONAL: return LIGHT_API_DIRECTIONAL;
    case LightType.SPOT:        return LIGHT_API_SPOT;
    case LightType.AREA:        return LIGHT_API_AREA;
    case LightType.GOD_RAYS:    return LIGHT_API_GOD_RAYS;
    case LightType.FREEFORM:    return LIGHT_API_FREEFORM;
    default:                    return LIGHT_API; // unknown type: show full list
  }
}

function _shapeApiForType(shapeType) {
  switch (shapeType) {
    case ShapeType.SQUARE:   return SHAPE_API_SQUARE;
    case ShapeType.CIRCLE:   return SHAPE_API_CIRCLE;
    case ShapeType.CAPSULE:  return SHAPE_API_CAPSULE;
    case ShapeType.TRIANGLE: return SHAPE_API_TRIANGLE;
    default:                 return SHAPE_API; // unknown type: show full list
  }
}

function _shapeApiForEntities(entities) {
  const seen = new Set();
  const lists = [];
  for (const e of entities) {
    if (!e.hasComponent(SHAPE_RENDERER)) continue;
    const shape = e.getComponent(SHAPE_RENDERER);
    const shapeType = shape ? shape.shapeType : ShapeType.SQUARE;
    if (seen.has(shapeType)) continue;
    seen.add(shapeType);
    lists.push(_shapeApiForType(shapeType));
  }
  if (lists.length === 0) return SHAPE_API;
  if (lists.length === 1) return lists[0];
  const merged = [];
  const labelsSeen = new Set();
  for (const list of lists) {
    for (const item of list) {
      if (labelsSeen.has(item.label)) continue;
      labelsSeen.add(item.label);
      merged.push(item);
    }
  }
  return merged;
}

function _jointApiForType(jointType) {
  switch (jointType) {
    case JointType2D.FIXED:     return JOINT_API_FIXED;
    case JointType2D.REVOLUTE:  return JOINT_API_REVOLUTE;
    case JointType2D.PRISMATIC: return JOINT_API_PRISMATIC;
    case JointType2D.ROPE:      return JOINT_API_ROPE;
    case JointType2D.SPRING:    return JOINT_API_SPRING;
    default:                    return JOINT_API; // unknown type: show full list
  }
}

// Same multi-entity merge convention as _shapeApiForEntities/
// _lightApiForEntities — a multi-select spanning different jointTypes
// (e.g. one Revolute + one Rope) shows the union of both, deduped by
// label, rather than guessing which selected entity "wins".
function _jointApiForEntities(entities) {
  const seen = new Set();
  const lists = [];
  for (const e of entities) {
    if (!e.hasComponent(JOINT_2D)) continue;
    const joint = e.getComponent(JOINT_2D);
    const jointType = joint ? joint.jointType : JointType2D.REVOLUTE;
    if (seen.has(jointType)) continue;
    seen.add(jointType);
    lists.push(_jointApiForType(jointType));
  }
  if (lists.length === 0) return JOINT_API;
  if (lists.length === 1) return lists[0];
  const merged = [];
  const labelsSeen = new Set();
  for (const list of lists) {
    for (const item of list) {
      if (labelsSeen.has(item.label)) continue;
      labelsSeen.add(item.label);
      merged.push(item);
    }
  }
  return merged;
}

function _lightApiForEntities(entities) {
  const seen = new Set();
  const lists = [];
  for (const e of entities) {
    if (!e.hasComponent(LIGHT)) continue;
    const light = e.getComponent(LIGHT);
    const lightType = light ? light.type : LightType.POINT;
    if (seen.has(lightType)) continue;
    seen.add(lightType);
    lists.push(_lightApiForType(lightType));
  }
  if (lists.length === 0) return LIGHT_API; // no context: full list
  if (lists.length === 1) return lists[0];
  // Multiple light types on the context entities: merge their APIs.
  const merged = [];
  const labelsSeen = new Set();
  for (const list of lists) {
    for (const item of list) {
      if (labelsSeen.has(item.label)) continue;
      labelsSeen.add(item.label);
      merged.push(item);
    }
  }
  return merged;
}

function _getContextEntities() {
  const se = editorState.scriptEditor;
  const ctx = se.contextByScript ? se.contextByScript[se.activeTab] : null;
  if (!ctx || !editorState.world) return [];
  const ids = ctx.entityId ? [ctx.entityId] : ctx.entityIds || [];
  const out = [];
  for (const id of ids) {
    const e = editorState.world.getEntity(id);
    if (e) out.push(e);
  }
  return out;
}

function _contextComponentKeys() {
  const entities = _getContextEntities();
  const set = new Set();
  for (const e of entities) {
    for (const c of COMPONENT_APIS) {
      if (e.hasComponent(c.key)) set.add(c.key);
    }
  }
  const se = editorState.scriptEditor;
  const forced = (se.forcedApis && se.activeTab && se.forcedApis[se.activeTab]) || [];
  for (const f of forced) set.add(f);
  return set;
}

/**
 * Resolves ONE component API list for a cast/narrow target, given its
 * component key + (optional) subtype — reusing the exact same
 * subtype-aware tables/functions already used for `this.*`/find()
 * completions, so a cast to DynamicBody shows PRECISELY the same
 * members as a real Rigidbody2D entity known to be Dynamic, not a
 * separately hand-maintained list that could drift out of sync.
 */
function _apiForComponentKey(key, subtype) {
  if (key === TRANSFORM) return TRANSFORM_API;
  if (key === RIGIDBODY_2D) {
    if (subtype === BodyType.DYNAMIC) return RIGIDBODY_API_DYNAMIC;
    if (subtype === BodyType.KINEMATIC) return RIGIDBODY_API_KINEMATIC;
    if (subtype === BodyType.STATIC) return RIGIDBODY_API_STATIC;
    return RIGIDBODY_API_ALL;
  }
  if (key === CHARACTER_CONTROLLER) {
    if (subtype) return _controllerApiForType(subtype);
    return CONTROLLER_API_ALL;
  }
  if (key === LIGHT) {
    if (subtype) return _lightApiForType(subtype);
    return LIGHT_API;
  }
  if (key === JOINT_2D) {
    if (subtype) return _jointApiForType(subtype);
    return JOINT_API;
  }
  const found = COMPONENT_APIS.find((c) => c.key === key);
  return found ? found.api : [];
}

function _componentDisplayName(key) {
  const found = COMPONENT_APIS.find((c) => c.key === key);
  return found ? found.name : key;
}

/**
 * Builds the merged completion list for one or more cast-target NAMES
 * (as typed after `as` / inside `as ( … )`), always including Base
 * Object + Transform per spec rule #4/#5, plus every selected
 * component's members, deduped by label, each member namespaced under
 * its sub-object property (e.g. "rigidbody.addForce") to match how
 * this.* completions are already namespaced.
 */
function _completionsForCastNames(monaco, range, names) {
  const suggestions = [];
  const labelsSeen = new Set();

  function pushUnique(item) {
    if (labelsSeen.has(item.label)) return;
    labelsSeen.add(item.label);
    suggestions.push(item);
  }

  // Base Object members are always present on a cast, per spec.
  for (const item of BASE_OBJECT_API) {
    pushUnique(_makeCompletion(monaco, item, range));
  }

  for (const rawName of names) {
    const target = findCastTarget(rawName);
    if (!target) continue; // unrecognized name typed mid-edit — ignore, don't guess
    if (target.key === TRANSFORM) continue; // already covered by Base Object
    const api = _apiForComponentKey(target.key, target.subtype);
    const prop = target.prop;
    for (const item of api) {
      const completion = Object.assign(
        _makeCompletion(monaco, item, range),
        { label: prop + "." + item.label, insertText: prop + "." + item.insert }
      );
      pushUnique(completion);
    }
    pushUnique(_makeCompletion(monaco, { label: prop, detail: _componentDisplayName(target.key) + " component", insert: prop + ".", kind: "Module" }, range));
  }

  return suggestions;
}

// Union of every rigidbody API across all body types — for untracked paths.
const RIGIDBODY_API_ALL = (function () {
  const merged = [];
  const seen = new Set();
  for (const list of [RIGIDBODY_API_DYNAMIC, RIGIDBODY_API_KINEMATIC, RIGIDBODY_API_STATIC]) {
    for (const item of list) {
      if (seen.has(item.label)) continue;
      seen.add(item.label);
      merged.push(item);
    }
  }
  return merged;
})();

const CONTROLLER_API_ALL = (function () {
  const merged = [];
  const seen = new Set();
  for (const list of [CONTROLLER_API_CHARACTER, CONTROLLER_API_TOP_DOWN, CONTROLLER_API_CAR, CONTROLLER_API_FOLLOW, CONTROLLER_API_PATROL, CONTROLLER_API_FREE]) {
    for (const item of list) {
      if (seen.has(item.label)) continue;
      seen.add(item.label);
      merged.push(item);
    }
  }
  return merged;
})();

const COMPONENT_APIS = [
  { key: TRANSFORM, name: "transform", api: TRANSFORM_API },
  { key: SPRITE_RENDERER, name: "sprite", api: SPRITE_API },
  { key: SHAPE_RENDERER, name: "shape", api: SHAPE_API },
  { key: TEXT_RENDERER, name: "text", api: TEXT_API },
  { key: SPEECH_BUBBLE, name: "speechBubble", api: SPEECH_BUBBLE_API },
  { key: CHAT_LOG, name: "chat", api: CHAT_LOG_API },
  { key: TEXT_INPUT, name: "textInput", api: TEXT_INPUT_API },
  { key: JOYSTICK, name: "joystick", api: JOYSTICK_API },
  { key: RIGIDBODY_2D, name: "rigidbody", api: RIGIDBODY_API_ALL },
  { key: SPRITE_ANIMATION, name: "animator", api: ANIMATOR_API },
  { key: CAMERA, name: "camera", api: CAMERA_API },
  { key: AUDIO_SOURCE, name: "audio", api: AUDIO_API },
  { key: AUDIO_LISTENER, name: "ear", api: EAR_API },
  { key: CHARACTER_CONTROLLER, name: "controller", api: CONTROLLER_API_ALL },
  { key: COLLIDER_2D, name: "collider", api: COLLIDER_API },
  { key: JOINT_2D, name: "joint", api: JOINT_API },
  { key: NAV_AGENT_2D, name: "navAgent", api: NAV_AGENT_API },
  { key: LIGHT, name: "light", api: LIGHT_API },
  { key: SHADOW_CASTER, name: "shadowCaster", api: SHADOW_CASTER_API },
  { key: STROKE_PATH, name: "strokePath", api: STROKE_PATH_API },
];

// ─── Object-literal { } field completions ────────────────────────────────────
// When the user types `= {` after a known object-valued API property we suggest
// only the valid field names for that property instead of the full API list.
// Properties that accept { x, y } — position, velocity, scale, resolvedVelocity.
const XY_FIELDS = [
  { label: "x", detail: "x coordinate / component", insert: "x: ${1:0}", kind: "Field", snippet: true },
  { label: "y", detail: "y coordinate / component", insert: "y: ${1:0}", kind: "Field", snippet: true },
];

// Map from property name → its field definitions. Only properties that are
// genuinely assigned an object literal in normal usage are listed here.
const OBJECT_LITERAL_FIELDS = {
  position:         XY_FIELDS,
  velocity:         XY_FIELDS,
  scale:            XY_FIELDS,
  resolvedVelocity: XY_FIELDS,
};

/**
 * Detects whether the cursor is inside an unclosed `{` that was opened as
 * an object-literal ASSIGNMENT (i.e. `propName = {`), and returns:
 *   - An array of field items  when the property is known (may be empty when
 *     all fields are already present)
 *   - An empty array []        when inside a `= {` for an UNKNOWN property
 *     (suppresses the full API list without offering false completions)
 *   - null                     when NOT inside a `= {` at all (normal completion
 *     should proceed — the `{` belongs to a function body, array, etc.)
 */
function _detectObjectAssignContext(textUntil) {
  // Walk the text maintaining a stack of unclosed `{` indices so we can
  // find the innermost one accurately even across nested structures.
  const braceStack = [];
  let inString = null;
  for (let i = 0; i < textUntil.length; i++) {
    const ch = textUntil[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "{") braceStack.push(i);
    else if (ch === "}" && braceStack.length > 0) braceStack.pop();
  }
  if (braceStack.length === 0) return null; // not inside any unclosed {

  // Innermost unclosed {
  const lastBrace = braceStack[braceStack.length - 1];
  const before = textUntil.slice(0, lastBrace).trimEnd();

  // Was this { opened immediately after `=`?
  if (!/=\s*$/.test(before)) return null; // function body, array element, etc.

  // Extract the property name sitting directly before the `=`.
  const propBefore = before.replace(/\s*=\s*$/, "").trimEnd();
  const propMatch = propBefore.match(/\.(\w+)$/) || propBefore.match(/\b(\w+)$/);
  if (!propMatch) return []; // unrecognised left-hand side — suppress full list

  const propName = propMatch[1];
  if (propName in OBJECT_LITERAL_FIELDS) {
    // Known property: return its fields (caller filters already-used ones).
    return OBJECT_LITERAL_FIELDS[propName];
  }
  // `= {` after an unknown property — suppress the full API list.
  return [];
}

// ─── Completion item builder ──────────────────────────────────────────────────

function _kindConstant(monaco, kindName) {
  const K = monaco.languages.CompletionItemKind;
  switch (kindName) {
    case "Property":  return K.Property;
    case "Method":    return K.Method;
    case "Function":  return K.Function;
    case "Module":    return K.Module;
    case "Snippet":   return K.Snippet;
    case "Value":     return K.Value;
    case "Variable":  return K.Variable;
    case "Field":     return K.Field;
    default:          return K.Function;
  }
}

function _makeCompletion(monaco, item, range) {
  const insert = item.insert;
  const opensString = typeof insert === "string" && /["']$/.test(insert);

  const entry = {
    label: item.label,
    kind: _kindConstant(monaco, item.kind || "Function"),
    detail: item.detail || "",
    insertText: insert,
    range: range,
  };

  if (opensString) {
    // Items like find(", keyDown(", play(" end with an opening quote and
    // used to rely on Monaco's auto-closing-bracket feature to add the
    // matching closing quote. Auto-pairing only fires for characters the
    // user physically types — it never fires for text a completion item
    // inserts programmatically — so clicking these produced an unclosed
    // string (e.g. find(" instead of find("")) and left the cursor after
    // the quote with nothing to close it.
    // Fix: insert both quotes ourselves as a snippet, put the cursor
    // between them with $1, and immediately re-trigger suggestions so the
    // string-argument completion list (entity names, key codes, etc.)
    // shows up right away instead of requiring the quote to be retyped.
    const quoteChar = insert.slice(-1);
    entry.insertText = insert + "$1" + quoteChar;
    entry.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    entry.command = { id: "editor.action.triggerSuggest", title: "Trigger Suggest" };
  } else if (item.snippet) {
    // Multi-argument (or otherwise non-string) calls like
    // addForce(${1:x}, ${2:y}) or raycast(${1:x1}, ${2:y1}, ...) — insert
    // as a real snippet so Tab walks through each argument in order
    // instead of leaving the user to guess the parameter count/order
    // after a bare "addForce(" with nothing else typed.
    entry.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  } else if (typeof insert === "string" && insert.endsWith(".")) {
    // When the inserted text ends with "." the suggest widget does not
    // automatically re-open. Attach a command so Monaco immediately
    // re-triggers suggestions after insertion (e.g. "scene." → scene API).
    entry.command = { id: "editor.action.triggerSuggest", title: "Trigger Suggest" };
  }

  return entry;
}

/** Make a string-value completion item (entity name, key code, etc.), used
 *  when the cursor is already inside an open string (find("pl|"), etc.).
 *  insertText is the bare value. Whether a closing quote needs to be
 *  appended depends on what's actually in the document immediately after
 *  the completion range — NOT on Monaco auto-pairing, which (as above)
 *  never fires for programmatic inserts and can't be relied on here either.
 *  `hasClosingQuote` should reflect the real document state at the call site. */
function _makeValueCompletion(monaco, label, detail, insertText, range, hasClosingQuote) {
  let text = typeof insertText === "string" ? insertText.replace(/["']$/, "") : insertText;
  const entry = {
    label: label,
    kind: monaco.languages.CompletionItemKind.Value,
    detail: detail || "",
    insertText: text,
    range: range,
  };
  if (!hasClosingQuote && typeof text === "string") {
    // No closing quote exists yet in the document (e.g. the user typed
    // find(" and never got an auto-paired closer, or is editing inside an
    // already-unbalanced string) — add it ourselves and land the cursor
    // right after it rather than leaving the string open.
    entry.insertText = text + "$0" + '"';
    entry.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }
  return entry;
}

/**
 * Pushes the always-available this.* shortcuts (position, destroy(),
 * spawn(), wait(), etc. — THIS_SHORTCUTS_BASE), PLUS any shortcut
 * group gated on a specific component actually being present on the
 * entity/entities this completion is for. `keys` is the Set of
 * component keys already computed for that context (see
 * _contextComponentKeys()/_entityComponentKeys() at the call sites) —
 * when it's empty (nothing selected, or looking at an untracked
 * find() variable) collider-gated entries are simply left out rather
 * than guessed at, same "don't show what might not work" rule
 * COMPONENT_APIS already follows for this.rigidbody/this.controller.
 */
function _pushShortcutCompletions(monaco, range, suggestions, keys, entities) {
  for (const item of THIS_SHORTCUTS_BASE) {
    suggestions.push(_makeCompletion(monaco, item, range));
  }
  if (keys && keys.has(COLLIDER_2D)) {
    for (const item of THIS_SHORTCUTS_COLLIDER) {
      suggestions.push(_makeCompletion(monaco, item, range));
    }
  }
  if (keys && keys.has(NAV_AGENT_2D)) {
    for (const item of THIS_SHORTCUTS_NAV_AGENT) {
      suggestions.push(_makeCompletion(monaco, item, range));
    }
  }
  if (keys && keys.has(NAV_AGENT_2D) && keys.has(CHARACTER_CONTROLLER) && _hasCarController(entities)) {
    for (const item of THIS_SHORTCUTS_CAR_NAV_AGENT) {
      suggestions.push(_makeCompletion(monaco, item, range));
    }
  }
}

/**
 * True if ANY entity in `entities` has a Car-type CharacterController.
 * Used alongside the plain component-presence checks above to gate
 * this.navDriveToward() — unlike THIS_SHORTCUTS_NAV_AGENT/COLLIDER,
 * "has a CharacterController" alone isn't enough here, since a
 * Follow/Patrol/walk-family controller paired with a NavAgent2D still
 * can't drive like a car. Same "union of every owning object" spirit as
 * _controllerApiForEntities — offered if AT LEAST ONE selected/context
 * entity is actually a Car, matching how a script shared by several
 * objects shows the union of what's valid for any of them.
 */
function _hasCarController(entities) {
  if (!entities) return false;
  for (const e of entities) {
    if (!e.hasComponent(CHARACTER_CONTROLLER)) continue;
    const cc = e.getComponent(CHARACTER_CONTROLLER);
    if (cc && cc.controllerType === ControllerType.CAR) return true;
  }
  return false;
}

// ─── Provider registration ────────────────────────────────────────────────────

export function registerIntelliSense(monaco) {
  if (_registered) return;
  _registered = true;

  monaco.languages.registerCompletionItemProvider("javascript", {
    triggerCharacters: [".", "(", '"', "'", "{", ","],

    provideCompletionItems: function (model, position) {
      // Wrapped end-to-end in try/catch — unlike refreshScriptDiagnostics
      // just above (which already has this), this function previously had
      // no error boundary at all, despite Monaco calling it on essentially
      // every keystroke (see triggerCharacters above — and Monaco also
      // calls providers for plain typing, not just those characters, to
      // keep suggestions live). This function reads live scene/entity
      // state (_contextComponentKeys -> _getContextEntities -> world
      // .getEntity(id), COMPONENT_APIS lookups, cast-target detection,
      // etc.) that can legitimately be mid-change right as the user
      // types — e.g. an object was just deleted, or a component was just
      // removed, in the instant between one keystroke and the next. If
      // ANY of that throws uncaught, the exception propagates back up
      // through Monaco's own keystroke-handling pipeline for the
      // character that was just typed, which can leave the suggestion
      // controller (and sometimes the editor's input handling generally)
      // wedged — this is the concrete, fixable mechanism behind reports
      // of "I deleted an object and now the script editor won't accept
      // any typing." Returning an empty suggestion list on failure (never
      // throwing) means a transient scene-state hiccup costs the user one
      // missed suggestion popup, not a broken editor.
      try {
        return _provideCompletionItemsImpl(monaco, model, position);
      } catch (e) {
        console.warn("[Realot IntelliSense] completion pass failed:", e);
        return { suggestions: [] };
      }
    },
  });

  registerHoverProvider(monaco);
}

function _provideCompletionItemsImpl(monaco, model, position) {
      const textUntilPosition = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const lineUntil = textUntilPosition.slice(textUntilPosition.lastIndexOf("\n") + 1);

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions = [];

      // ── String-argument context ──────────────────────────────────────────
      // Detect patterns like find("  scene.load("  input.keyDown("  .texture="
      // and return scene-aware / project-aware completions instead of code.
      const stringCtx = _detectStringContext(lineUntil, textUntilPosition);
      if (stringCtx) {
        // Does a closing quote already exist immediately where the string
        // ends? Checked against the real document instead of assuming
        // Monaco auto-paired one — auto-pairing only fires for keys the
        // user actually types, so a string opened by clicking a completion
        // (find(") or one the user is re-editing may have no closer at all.
        // We look at the rest of the current line: if the very next
        // character is the same quote character used to open the string,
        // treat it as already closed.
        const quoteMatch = lineUntil.match(/["']([^"']*)$/);
        const quoteChar = quoteMatch ? quoteMatch[0][0] : '"';
        const restOfLine = model.getLineContent(position.lineNumber).slice(position.column - 1);
        const hasClosingQuote = restOfLine.slice(0, 1) === quoteChar;

        if (stringCtx === "entityName") {
          const names = _getEntityNames();
          for (const name of names) {
            suggestions.push(_makeValueCompletion(
              monaco, name, "Scene object", name + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "sceneName") {
          const scenes = _getSceneNames();
          for (const name of scenes) {
            suggestions.push(_makeValueCompletion(
              monaco, name, "Scene", name + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "keyCode") {
          for (const key of ALL_KEY_CODES) {
            suggestions.push(_makeValueCompletion(
              monaco, key,
              KEY_DETAIL[key] || "Keyboard key code",
              key + '"',
              range,
              hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "textureName") {
          const textures = _getTextureNames();
          for (const name of textures) {
            suggestions.push(_makeValueCompletion(
              monaco, name, "Sprite / texture asset", name + '"', range, hasClosingQuote
            ));
          }
          // If no textures yet, still return empty (don't fall through)
          return { suggestions };
        }

        if (stringCtx === "navAreaName") {
          const areas = _getNavAreaNames();
          for (const name of areas) {
            suggestions.push(_makeValueCompletion(
              monaco, name, "NavWorld2D area (Edit \u2192 Nav Areas\u2026)", name + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "clipName") {
          const clips = _getAnimClipNames();
          for (const name of clips) {
            suggestions.push(_makeValueCompletion(
              monaco, name, "Animation clip", name + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "entityTag") {
          const tags = _getEntityTags();
          for (const tag of tags) {
            suggestions.push(_makeValueCompletion(
              monaco, tag, "Entity tag", tag + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "messageSent") {
          // onMessage(" — show message names that scripts are SENDING so the
          // user can pick the matching handler name.
          const sent = _getSentMessageNames(model.getValue());
          for (const lbl of [...sent].sort()) {
            suggestions.push(_makeValueCompletion(
              monaco, lbl, "Message being sent (sendMessage / broadcastMessage)", lbl + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "messageHandled") {
          // sendMessage("tag", " or broadcastMessage(" — show message names
          // that scripts are HANDLING so the user can pick a consistent name.
          const handled = _getHandledMessageNames(model.getValue());
          for (const lbl of [...handled].sort()) {
            suggestions.push(_makeValueCompletion(
              monaco, lbl, "Message handled by an onMessage declaration", lbl + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "stateName") {
          // this.state.change(" or this.state.current === " — show state
          // names already used anywhere in the project (see _getStateNames).
          const states = _getStateNames(model.getValue());
          for (const lbl of [...states].sort()) {
            suggestions.push(_makeValueCompletion(
              monaco, lbl, "State name used with state.change() / state.current elsewhere in this project", lbl + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "saveKey") {
          // save.get(" / save.has(" / save.delete(" / save.set(" — show
          // keys already saved anywhere in the project (see _getSaveKeyNames).
          const keys = _getSaveKeyNames(model.getValue());
          for (const lbl of [...keys].sort()) {
            suggestions.push(_makeValueCompletion(
              monaco, lbl, "Save key used with save.set() elsewhere in this project", lbl + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "componentKey") {
          // enemy.hasComponent(" — show component TITLES (Rigidbody2D,
          // Animator, …), not subtype aliases. See COMPONENT_KEY_NAMES.
          for (const c of COMPONENT_KEY_NAMES) {
            suggestions.push(_makeValueCompletion(
              monaco, c.label, c.detail, c.label + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        // Fixed-vocabulary enum fields — light.type, shape.shapeType,
        // joystick.positionMode, camera.aspectMode/scalingMode,
        // strokePath.jointMode/capMode, controller.controllerType (read
        // -only but still comparable). See the *_NAMES lists above.
        const ENUM_STRING_CONTEXTS = {
          lightType: LIGHT_TYPE_NAMES,
          shapeType: SHAPE_TYPE_NAMES,
          jointType: JOINT_TYPE_NAMES,
          textureMode: TEXTURE_MODE_NAMES,
          textAlign: TEXT_ALIGN_NAMES,
          tailDirection: TAIL_DIRECTION_NAMES,
          joystickPositionMode: JOYSTICK_POSITION_MODE_NAMES,
          cameraAspectMode: CAMERA_ASPECT_MODE_NAMES,
          cameraScalingMode: CAMERA_SCALING_MODE_NAMES,
          strokePathJointMode: STROKE_PATH_JOINT_MODE_NAMES,
          strokePathCapMode: STROKE_PATH_CAP_MODE_NAMES,
          controllerType: CONTROLLER_TYPE_NAMES,
          patrolMode: PATROL_MODE_NAMES,
          patrolAxis: PATROL_AXIS_NAMES,
          bodyType: RIGIDBODY_TYPE_NAMES,
          tweenEasing: TWEEN_EASING_NAMES,
        };
        if (ENUM_STRING_CONTEXTS[stringCtx]) {
          for (const v of ENUM_STRING_CONTEXTS[stringCtx]) {
            suggestions.push(_makeValueCompletion(
              monaco, v.label, v.detail, v.label + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        return { suggestions: [] };
      }

      // ── physics.raycast(x1,y1,x2,y2, { <partial> → opts object keys ──────
      // Detects the cursor sitting inside the raycast options literal —
      // scanning back from the LAST unmatched "physics.raycast(" call so it
      // still works if the opts object spans multiple lines.
      if (_isInsideRaycastOpts(textUntilPosition)) {
        const usedKeys = _usedObjectKeys(textUntilPosition);
        for (const item of RAYCAST_OPTS_API) {
          if (usedKeys.has(item.label)) continue;
          suggestions.push(_makeCompletion(monaco, item, range));
        }
        return { suggestions };
      }

      // ── camera.follow(target, { <partial> → opts object keys ─────────────
      if (_isInsideFunctionOptArg(textUntilPosition, /(?:this\s*\.\s*)?camera\s*\.\s*follow\s*\(/)) {
        const usedKeys = _usedObjectKeys(textUntilPosition);
        for (const item of CAMERA_FOLLOW_OPTS_API) {
          if (usedKeys.has(item.label)) continue;
          suggestions.push(_makeCompletion(monaco, item, range));
        }
        return { suggestions };
      }

      // ── spawn("name", { <partial>  /  this.spawn("name", { <partial> ─────
      if (_isInsideFunctionOptArg(textUntilPosition, /\bspawn\s*\(/)) {
        const usedKeys = _usedObjectKeys(textUntilPosition);
        for (const item of SPAWN_OPTS_API) {
          if (usedKeys.has(item.label)) continue;
          suggestions.push(_makeCompletion(monaco, item, range));
        }
        return { suggestions };
      }

      // ── nav.areaCosts({ <partial> → NAMED area keys (Ground: 3, ...) ─────
      // Unlike the fixed-field opts above, this object's keys are the
      // project's own Nav Areas names, not a static API shape — see
      // Edit → Nav Areas… (editor/state/NavAreas.js) and
      // NavAPI.js's resolveNavAreaCosts for how each key resolves.
      if (_isInsideFunctionOptArg(textUntilPosition, /\bnav\s*\.\s*areaCosts\s*\(/)) {
        const usedKeys = _usedObjectKeys(textUntilPosition);
        for (const name of _getNavAreaNames()) {
          if (usedKeys.has(name)) continue;
          suggestions.push(_makeCompletion(monaco, {
            label: name,
            detail: "NavWorld2D area (Edit \u2192 Nav Areas\u2026) \u2014 cost multiplier, e.g. 0.5 (prefer) to 5+ (avoid).",
            insert: name + ": ${1:1}",
            kind: "Property",
            snippet: true,
          }, range));
        }
        return { suggestions };
      }

      // ── `as <Type>` / `as (Type, Type, …` → cast-target completions ──────
      // const body = enemy as DynamicBody;
      // const enemy = obj as (DynamicBody, Animator, AudioSource);
      // Lists every known component/subtype name; after picking one inside
      // the multi-cast form and typing a comma, the remaining (not yet
      // used) targets keep being suggested.
      const castPos = detectCastPosition(lineUntil);
      if (castPos) {
        const used = castPos === "multi" ? usedCastNames(lineUntil) : new Set();
        for (const name of getCastTargetNames()) {
          if (used.has(name)) continue;
          const target = findCastTarget(name);
          suggestions.push(_makeCompletion(monaco, {
            label: name,
            detail: _componentDisplayName(target.key) + " component" + (target.subtype ? ` (${target.subtype})` : ""),
            insert: name,
            kind: "Value",
          }, range));
        }
        return { suggestions };
      }

      // ── Nav API option object `{ }` completions ─────────────────────────
      // `nav.findPath(..., { ... })` and `this.navMoveToward(..., { ... })`
      // use shared runtime metadata, so the editor exposes every supported
      // option without making users guess property names.
      const navOptionContext = _detectNavOptionsContext(textUntilPosition);
      if (navOptionContext) {
        const usedKeys = _usedObjectKeys(textUntilPosition);
        for (const item of _navOptionCompletionItems(monaco, navOptionContext)) {
          if (usedKeys.has(item.label)) continue;
          suggestions.push(_makeCompletion(monaco, item, range));
        }
        return { suggestions };
      }

      // ── Object-literal { } field completions ─────────────────────────────
      // When the cursor is inside an unclosed `{` opened by `propName = {`,
      // offer only the valid field names for that property (e.g. x, y for
      // position/velocity). Returns an empty array for unknown `= {` patterns
      // — so the full API list is NOT dumped into every `{}` the user types.
      // Returns null when the `{` is not an assignment (function body etc.),
      // in which case we fall through to the normal completions below.
      const objFields = _detectObjectAssignContext(textUntilPosition);
      if (objFields !== null) {
        const usedKeys = _usedObjectKeys(textUntilPosition);
        for (const item of objFields) {
          if (usedKeys.has(item.label)) continue;
          suggestions.push(_makeCompletion(monaco, item, range));
        }
        return { suggestions };
      }

      // ── other.<partial> → collision/trigger callback parameter ───────────
      // `other` is only meaningful as the parameter name of onCollision*/
      // onTrigger* — matched literally rather than tracking real parameter
      // bindings, since Realot's callback signatures are fixed.
      if (lineUntil.match(/\bother\.\w*$/)) {
        for (const item of OTHER_PARAM_API) {
          suggestions.push(_makeCompletion(monaco, item, range));
        }
        return { suggestions };
      }

      // ── this.<partial> → entity-aware completions ────────────────────────
      if (lineUntil.match(/\bthis\.\w*$/)) {
        const contextEntities = _getContextEntities();
        const keys = _contextComponentKeys();
        _pushShortcutCompletions(monaco, range, suggestions, keys, contextEntities);
        for (const c of COMPONENT_APIS) {
          if (keys.has(c.key)) {
            const api = c.key === RIGIDBODY_2D        ? _rigidbodyApiForEntities(contextEntities)
                      : c.key === CHARACTER_CONTROLLER ? _controllerApiForEntities(contextEntities)
                      : c.key === LIGHT               ? _lightApiForEntities(contextEntities)
                      : c.key === SHAPE_RENDERER       ? _shapeApiForEntities(contextEntities)
                      : c.key === JOINT_2D             ? _jointApiForEntities(contextEntities)
                      : c.api;
            for (const item of api) {
              suggestions.push(Object.assign(
                _makeCompletion(monaco, item, range),
                { label: c.name + "." + item.label, insertText: c.name + "." + item.insert }
              ));
            }
            suggestions.push(_makeCompletion(monaco, { label: c.name, detail: c.name + " component", insert: c.name + ".", kind: "Module" }, range));
          }
        }
        return { suggestions };
      }

      // ── <subobj>.<partial> → that sub-object's API ───────────────────────
      const subMatch = lineUntil.match(/(\w+)\.\w*$/);
      if (subMatch && subMatch[1] !== "this") {
        const subObj = subMatch[1];
        let items = null;
        let isKnownSubObj = false;

        const contextEntities = _getContextEntities();
        const hasContext = contextEntities.length > 0;
        const keys = hasContext ? _contextComponentKeys() : null;

        if (subObj === "transform") {
          isKnownSubObj = true;
          items = TRANSFORM_API;
        } else if (subObj === "sprite") {
          isKnownSubObj = true;
          if (!keys || keys.has(SPRITE_RENDERER)) items = SPRITE_API;
        } else if (subObj === "text") {
          isKnownSubObj = true;
          if (!keys || keys.has(TEXT_RENDERER)) items = TEXT_API;
        } else if (subObj === "shape") {
          isKnownSubObj = true;
          // Use type-aware API: only show fields valid for this shapeType.
          if (!keys || keys.has(SHAPE_RENDERER)) items = _shapeApiForEntities(contextEntities);
        } else if (subObj === "speechBubble") {
          isKnownSubObj = true;
          if (!keys || keys.has(SPEECH_BUBBLE)) items = SPEECH_BUBBLE_API;
        } else if (subObj === "chat") {
          isKnownSubObj = true;
          if (!keys || keys.has(CHAT_LOG)) items = CHAT_LOG_API;
        } else if (subObj === "textInput") {
          isKnownSubObj = true;
          if (!keys || keys.has(TEXT_INPUT)) items = TEXT_INPUT_API;
        } else if (subObj === "joystick") {
          isKnownSubObj = true;
          if (!keys || keys.has(JOYSTICK)) items = JOYSTICK_API;
        } else if (subObj === "rigidbody") {
          isKnownSubObj = true;
          if (!keys || keys.has(RIGIDBODY_2D)) items = _rigidbodyApiForEntities(contextEntities);
        } else if (subObj === "animator") {
          isKnownSubObj = true;
          if (!keys || keys.has(SPRITE_ANIMATION)) items = ANIMATOR_API;
        } else if (subObj === "camera") {
          isKnownSubObj = true;
          if (!keys || keys.has(CAMERA)) items = CAMERA_API;
        } else if (subObj === "audio") {
          isKnownSubObj = true;
          if (!keys || keys.has(AUDIO_SOURCE)) items = AUDIO_API;
        } else if (subObj === "ear") {
          isKnownSubObj = true;
          if (!keys || keys.has(AUDIO_LISTENER)) items = EAR_API;
        } else if (subObj === "state") {
          // this.state.<partial> — needs no component, always known.
          isKnownSubObj = true;
          items = STATE_API;
        } else if (subObj === "myTouch") {
          // this.myTouch.<partial> — requires Collider2D (startTracking()
          // hit-tests against it), same gate as "collider" below.
          isKnownSubObj = true;
          if (!keys || keys.has(COLLIDER_2D)) items = TOUCH_TRACK_API;
        } else if (subObj === "controller") {
          isKnownSubObj = true;
          if (!keys || keys.has(CHARACTER_CONTROLLER)) items = _controllerApiForEntities(contextEntities);
        } else if (subObj === "collider") {
          isKnownSubObj = true;
          if (!keys || keys.has(COLLIDER_2D)) items = COLLIDER_API;
        } else if (subObj === "joint") {
          isKnownSubObj = true;
          // Use type-aware API: only show fields valid for this jointType.
          if (!keys || keys.has(JOINT_2D)) items = _jointApiForEntities(contextEntities);
        } else if (subObj === "navAgent") {
          isKnownSubObj = true;
          if (!keys || keys.has(NAV_AGENT_2D)) items = NAV_AGENT_API;
        } else if (subObj === "light") {
          isKnownSubObj = true;
          // Use type-aware API: only show properties valid for this light type.
          if (!keys || keys.has(LIGHT)) items = _lightApiForEntities(contextEntities);
        } else if (subObj === "shadowCaster") {
          isKnownSubObj = true;
          if (!keys || keys.has(SHADOW_CASTER)) items = SHADOW_CASTER_API;
        } else if (subObj === "strokePath") {
          isKnownSubObj = true;
          if (!keys || keys.has(STROKE_PATH)) items = STROKE_PATH_API;
        } else if (subObj === "scene") {
          isKnownSubObj = true;
          items = SCENE_API;
        } else if (subObj === "lighting") {
          // scene.lighting.<partial> — scene-wide, needs no component
          // (see LightingSettingsAPI.js's header for why).
          isKnownSubObj = true;
          items = SCENE_LIGHTING_API;
        } else if (subObj === "physics") {
          isKnownSubObj = true;
          items = PHYSICS_API;
        } else if (subObj === "nav") {
          isKnownSubObj = true;
          items = NAV_API;
        } else if (subObj === "input") {
          isKnownSubObj = true;
          items = INPUT_API;
        } else if (subObj === "mouse") {
          isKnownSubObj = true;
          items = MOUSE_API;
        } else if (subObj === "touch") {
          isKnownSubObj = true;
          items = TOUCH_API;
        } else if (subObj === "swipe") {
          // touch.swipe.<partial> — properties of the swipe gesture object.
          isKnownSubObj = true;
          items = TOUCH_SWIPE_API;
        } else if (subObj === "pinch") {
          // touch.pinch.<partial> — properties of the pinch gesture object.
          isKnownSubObj = true;
          items = TOUCH_PINCH_API;
        } else if (subObj === "first") {
          // touch.first.<partial> — same shape as one entry in the
          // touch array itself.
          isKnownSubObj = true;
          items = TOUCH_ITEM_API;
        } else if (subObj === "time") {
          isKnownSubObj = true;
          items = TIME_API;
        } else if (subObj === "random") {
          isKnownSubObj = true;
          items = RANDOM_API;
        } else if (subObj === "mathx") {
          isKnownSubObj = true;
          items = MATH_API;
        } else if (subObj === "Math") {
          isKnownSubObj = true;
          items = MATH_NATIVE_API;
        } else if (subObj === "debug") {
          isKnownSubObj = true;
          items = DEBUG_API;
        } else if (subObj === "save") {
          isKnownSubObj = true;
          items = SAVE_API;
        }

        if (items) {
          for (const item of items) {
            suggestions.push(_makeCompletion(monaco, item, range));
          }
          return { suggestions };
        }
        if (isKnownSubObj) return { suggestions: [] };

        // Unknown sub-object — check if it's a tracked raycast() result variable.
        // E.g. const hit = physics.raycast(…); hit.entity / hit.point / etc.
        const raycastVars = _parseRaycastVariables(textUntilPosition);
        if (raycastVars.has(subObj)) {
          for (const item of RAYCAST_RESULT_API) {
            suggestions.push(_makeCompletion(monaco, item, range));
          }
          return { suggestions };
        }

        // Unknown sub-object — check if it's a tracked find() variable.
        const findVars = _parseFindVariables(textUntilPosition);
        if (findVars[subObj]) {
          const entityKeys = _entityComponentKeys(findVars[subObj]);
          if (entityKeys) {
            const foundEntity = editorState.world ? editorState.world.findFirstByName(findVars[subObj]) : null;
            const foundEntities = foundEntity ? [foundEntity] : [];
            _pushShortcutCompletions(monaco, range, suggestions, entityKeys, foundEntities);
            for (const c of COMPONENT_APIS) {
              if (entityKeys.has(c.key)) {
                const api = c.key === RIGIDBODY_2D        ? _rigidbodyApiForEntities(foundEntities)
                          : c.key === CHARACTER_CONTROLLER ? _controllerApiForEntities(foundEntities)
                          : c.key === LIGHT               ? _lightApiForEntities(foundEntities)
                          : c.key === SHAPE_RENDERER       ? _shapeApiForEntities(foundEntities)
                          : c.key === JOINT_2D             ? _jointApiForEntities(foundEntities)
                          : c.api;
                for (const item of api) {
                  suggestions.push(Object.assign(_makeCompletion(monaco, item, range), { label: c.name + "." + item.label }));
                }
                suggestions.push(_makeCompletion(monaco, { label: c.name, detail: c.name + " component", insert: c.name + ".", kind: "Module" }, range));
              }
            }
            return { suggestions };
          }
        }

        // ── Unknown-type variable: narrowing → cast → Base Object ─────────
        // Everything below replaces the old "show the entire engine API"
        // fallback. A variable this file has no other way to identify
        // (not `this`, not a known sub-object name, not a tracked find()/
        // raycast() result) gets the internal type Unknown, and Unknown is
        // NOT "every engine type" — see ScriptTypeInference.js.

        // 1) Narrowed by an enclosing `if (subObj.hasComponent("Key"))`?
        //    Checked FIRST so narrowing always wins over a stale/no cast —
        //    matches spec rule #3: narrowing updates immediately and is
        //    scoped strictly to the enclosing block.
        const cursorOffset = model.getOffsetAt(position);
        const narrowed = getNarrowedType(model.getValue(), cursorOffset, subObj);
        if (narrowed) {
          for (const item of BASE_OBJECT_API) {
            suggestions.push(_makeCompletion(monaco, item, range));
          }
          const api = _apiForComponentKey(narrowed.key, narrowed.subtype);
          const prop = _componentDisplayName(narrowed.key);
          for (const item of api) {
            suggestions.push(Object.assign(
              _makeCompletion(monaco, item, range),
              { label: prop + "." + item.label, insertText: prop + "." + item.insert }
            ));
          }
          suggestions.push(_makeCompletion(monaco, { label: prop, detail: prop + " component (narrowed)", insert: prop + ".", kind: "Module" }, range));
          return { suggestions };
        }

        // 2) Explicitly cast earlier in the script? `const body = enemy as DynamicBody;`
        const castVars = parseCastVariables(textUntilPosition);
        if (castVars.has(subObj)) {
          return { suggestions: _completionsForCastNames(monaco, range, castVars.get(subObj)) };
        }

        // 3) Plain Unknown — Base Object members + Cast/Check helpers only.
        //    Never falls back to the full engine API (spec's core rule).
        for (const item of BASE_OBJECT_API) {
          suggestions.push(_makeCompletion(monaco, item, range));
        }
        // "Cast to…" / "Check Component…" replace the WHOLE `subObj.partial`
        // expression (not just the partial word after the dot, like every
        // other completion here) — inserting after the dot would produce
        // invalid code like `enemy.as DynamicBody`. wideRange starts at the
        // beginning of subObj itself: subObj is always exactly
        // "subObj.length + 1" (the identifier plus its dot) characters
        // before word.startColumn, regardless of how much of the member
        // name has already been typed — so the snippet can rewrite the
        // whole thing into `const x = enemy as DynamicBody;` /
        // `if (enemy.hasComponent(...)) { }` with the real variable name
        // spliced in.
        const subObjStartColumn = word.startColumn - subObj.length - 1;
        const wideRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: subObjStartColumn,
          endColumn: word.endColumn,
        };
        suggestions.push(_makeCompletion(monaco, {
          label: "Cast to…",
          detail: UNKNOWN_HELPER_API[0].detail,
          insert: "const ${2:" + subObj + "Typed} = " + subObj + " as ${1};$0",
          kind: "Snippet",
          snippet: true,
        }, wideRange));
        suggestions.push(_makeCompletion(monaco, {
          label: "Check Component…",
          detail: UNKNOWN_HELPER_API[1].detail,
          insert: 'if (' + subObj + '.hasComponent("${1:Rigidbody2D}")) {\n\t$0\n}',
          kind: "Snippet",
          snippet: true,
        }, wideRange));
        return { suggestions };
      }

      // ── Global / top-level ────────────────────────────────────────────────
      for (const item of GLOBAL_APIS) {
        suggestions.push(_makeCompletion(monaco, item, range));
      }
      // Note: LIFECYCLE_API bare items (onStart(), onUpdate(), …) are
      // intentionally NOT added here. The snippets below cover every lifecycle
      // hook with the complete `function name() { }` body. Showing the bare
      // items alongside the snippets causes users to pick `onStart()` (no body)
      // instead of `function onStart() { }` when typing after `function `.

      // Lifecycle method snippets. Split into always-available (every
      // entity can use these — they don't depend on any component) and
      // collider-gated (onClick/onCollision*/onTrigger* only ever fire
      // for an entity with a Collider2D — see ScriptSystem.js: onClick
      // is dispatched from a physics hit-test, onCollision*/onTrigger*
      // come from Rapier collision events. Suggesting them on an
      // entity with no collider would offer something that silently
      // never runs — same "don't show what won't work" rule already
      // applied to this.rigidbody/this.controller and now
      // isPointerOver/isClicked above).
      const snippetsBase = [
        { label: "function onStart()", detail: "Called once before the first onUpdate — use for initialization", insert: "onStart() {\n  $1\n}" },
        { label: "function onClone()", detail: "Called once, right before onStart(), but ONLY on entities created by spawn(). Never fires for entities placed in the scene.", insert: "onClone() {\n  $1\n}" },
        { label: "function onUpdate(dt)", detail: "Called every frame. dt = seconds since last frame (use for movement)", insert: "onUpdate(dt) {\n  $1\n}" },
        { label: "function onFixedUpdate(dt)", detail: "Called at a fixed 60 Hz rate — use for physics/rigidbody changes", insert: "onFixedUpdate(dt) {\n  $1\n}" },
        { label: "function onMessage(message)", detail: "Message received — just the message string. Simplest form.", insert: "onMessage(message) {\n  $1\n}" },
        { label: "function onMessage(message, data)", detail: "Message + payload. data is whatever was passed as the third arg of sendMessage() or second arg of broadcastMessage().", insert: "onMessage(message, data) {\n  $1\n}" },
        { label: "function onMessage(message, sender, data)", detail: "Full form. sender is an entity context (like 'this') — use sender.name, sender.tag, sender.x etc. sender is null for broadcastMessage.", insert: "onMessage(message, sender, data) {\n  $1\n}" },
        { label: "function onDestroy()", detail: "Called once when this entity is destroyed or the scene ends", insert: "onDestroy() {\n  $1\n}" },
        // State machine hooks (this.state.change(...) — see StateAPI.js).
        // No component required, unlike the collider-gated group below,
        // so these belong in the always-offered base tier, not a gated one.
        { label: "function onStateEnter()", detail: "Called right after this.state.change(name) switches TO a new state. No component needed.", insert: "onStateEnter() {\n  $1\n}" },
        { label: "function onStateUpdate(dt)", detail: "Called every frame, right after onUpdate, regardless of whether this.state.change() was ever called (starts in \"default\"). No component needed.", insert: "onStateUpdate(dt) {\n  $1\n}" },
        { label: "function onStateExit()", detail: "Called right before this.state.change(name) switches AWAY from the current state. No component needed.", insert: "onStateExit() {\n  $1\n}" },
      ];
      const snippetsCollider = [
        { label: "function onClick()", detail: "Called the frame this entity is clicked/tapped", insert: "onClick() {\n  $1\n}" },
        { label: "function onCollision(other)", detail: "Called when this entity's collider touches another. 'other' has .x, .y, .name, .tag, etc.", insert: "onCollision(other) {\n  $1\n}" },
        { label: "function onCollisionEnter(other)", detail: "Called when collision begins. 'other' has .x, .y, .name, etc.", insert: "onCollisionEnter(other) {\n  $1\n}" },
        { label: "function onCollisionStay(other)", detail: "Called every frame the collision is still happening — fires between Enter and Exit, once per frame, for as long as the two colliders stay touching.", insert: "onCollisionStay(other) {\n  $1\n}" },
        { label: "function onCollisionExit(other)", detail: "Called when collision ends.", insert: "onCollisionExit(other) {\n  $1\n}" },
        { label: "function onTriggerEnter(other)", detail: "Called when entering a trigger collider (Is Trigger = on)", insert: "onTriggerEnter(other) {\n  $1\n}" },
        { label: "function onTriggerExit(other)", detail: "Called when leaving a trigger collider", insert: "onTriggerExit(other) {\n  $1\n}" },
      ];
      // Audio Listener hooks — same "don't show what won't work" gating
      // as snippetsCollider above, just keyed on AUDIO_LISTENER instead
      // of COLLIDER_2D (see EAR_API's identical gating a few hundred
      // lines up for `this.ear`).
      const snippetsAudioListener = [
        { label: "function onHearSound(source)", detail: "Called the frame a 3D Audio Source enters this entity's Audio Listener radius. Requires an Audio Listener component.", insert: "onHearSound(source) {\n  $1\n}" },
        { label: "function onLoseSound(source)", detail: "Called the frame a 3D Audio Source leaves this entity's Audio Listener radius (or is destroyed while in range). Requires an Audio Listener component.", insert: "onLoseSound(source) {\n  $1\n}" },
      ];
      const snippetContextKeys = _contextComponentKeys();
      let snippets = snippetsBase;
      if (snippetContextKeys.has(COLLIDER_2D) || snippetContextKeys.size === 0) {
        // No entity selected/tracked for this script tab (or it has no
        // collider yet) — offer the collider snippets anyway, since
        // refusing to suggest a hook the user might be about to add a
        // collider FOR would be more annoying than occasionally
        // suggesting one early.
        snippets = snippets.concat(snippetsCollider);
      }
      if (snippetContextKeys.has(AUDIO_LISTENER) || snippetContextKeys.size === 0) {
        snippets = snippets.concat(snippetsAudioListener);
      }
      for (const s of snippets) {
        suggestions.push({
          label: s.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: s.detail,
          insertText: s.insert,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range: range,
        });
      }

      return { suggestions };
}

// ─── Hover documentation ──────────────────────────────────────────────────────
// Autocomplete only shows docs for identifiers the user is actively typing
// after a trigger character. A hover provider surfaces the SAME docs for any
// recognized engine identifier anywhere in the file — while reading code,
// skimming a script someone else wrote, or just moving the mouse — which is
// the main way to discover a built-in you didn't know existed rather than one
// you're already halfway through typing. Built once from a flattened index of
// every API table already defined above, so it can never drift out of sync
// with what autocomplete itself offers.
let _hoverIndex = null;

function _buildHoverIndex() {
  if (_hoverIndex) return _hoverIndex;
  const index = new Map(); // identifier -> array of { detail, group }
  function add(label, detail, group) {
    // Strip a trailing "(args)" signature down to the bare name so both
    // "raycast(x1, y1, x2, y2)" and a bare "raycast" typed/hovered word match
    // the same entry — Monaco's hover word-detection only ever gives a bare
    // identifier, never the full call signature.
    const name = String(label).replace(/\(.*$/, "").replace(/^function\s+/, "").trim();
    if (!name) return;
    if (!index.has(name)) index.set(name, []);
    index.get(name).push({ detail, group });
  }

  // The this.<name> SUB-OBJECT names themselves (transform, rigidbody,
  // controller, collider, ear, ...) previously had NO hover entry of
  // their own — only their MEMBERS did (this.rigidbody.addForce hovered
  // fine, but this.rigidbody itself showed nothing). Generated here,
  // once, straight from COMPONENT_APIS — the same table that already
  // drives autocomplete's own component-gating — so this can never
  // drift out of sync with what this.<name> actually requires. The
  // "Add Component → X" display names match the exact wording each
  // this.<name> API's own runtime error message already uses (see
  // e.g. ColliderAPI.js/RigidbodyAPI.js's _require* functions), so a
  // beginner sees the identical phrase whether they hover the name or
  // hit the error for missing it.
  const COMPONENT_DISPLAY_NAMES = {
    transform: null, // every entity has one — no component needed
    sprite: "Sprite Renderer",
    shape: "Shape Renderer",
    text: "Text",
    speechBubble: "Speech Bubble",
    chat: "Chat Log",
    textInput: "Text Input",
    joystick: "Joystick",
    rigidbody: "Rigidbody 2D",
    controller: "Character Controller",
    animator: "Sprite Animation",
    camera: "Camera",
    audio: "Audio Source",
    ear: "Audio Listener",
    collider: "Collider 2D",
    joint: "Joint 2D",
    navAgent: "Nav Agent 2D",
    light: "Light",
    shadowCaster: "Shadow Caster",
    strokePath: "Stroke Path",
  };
  for (const c of COMPONENT_APIS) {
    const componentName = COMPONENT_DISPLAY_NAMES[c.name];
    const requirement = componentName
      ? "Requires a **" + componentName + "** component (Add Component → " + componentName + ")."
      : "Every entity has one — no component required.";
    add(
      c.name,
      "`this." + c.name + "` — " + requirement + " Hover or autocomplete `this." + c.name +
        ".` for its full list of properties/methods.",
      "this / entity"
    );
  }
  // this.state and this.myTouch are intentionally NOT generated here —
  // THIS_SHORTCUTS_BASE below already carries a correct, hand-written
  // entry for each (see its "state"/"myTouch" lines), and that same
  // table also drives autocomplete's own this.<name> suggestion list —
  // duplicating them here would just show two near-identical tooltips
  // on hover for no benefit.

  const allTables = [
    ["this / entity", THIS_SHORTCUTS_BASE],
    ["this / entity (collider)", THIS_SHORTCUTS_COLLIDER],
    ["Base Object (Unknown type)", BASE_OBJECT_API],
    ["transform", TRANSFORM_API],
    ["sprite", SPRITE_API],
    ["shape", SHAPE_API],
    ["text", TEXT_API],
    ["speechBubble", SPEECH_BUBBLE_API],
    ["chat", CHAT_LOG_API],
    ["textInput", TEXT_INPUT_API],
    ["joystick", JOYSTICK_API],
    ["rigidbody", RIGIDBODY_API_ALL],
    ["controller", CONTROLLER_API_ALL],
    ["animator", ANIMATOR_API],
    ["camera", CAMERA_API],
    ["audio", AUDIO_API],
    ["ear", EAR_API],
    ["state", STATE_API],
    ["myTouch", TOUCH_TRACK_API],
    ["light", LIGHT_API],
    ["shadowCaster", SHADOW_CASTER_API],
    ["collider", COLLIDER_API],
    ["joint", JOINT_API],
    ["navAgent", NAV_AGENT_API],
    ["strokePath", STROKE_PATH_API],
    ["global", GLOBAL_APIS],
    ["save", SAVE_API],
    ["scene", SCENE_API],
    ["scene.lighting", SCENE_LIGHTING_API],
    ["physics", PHYSICS_API],
    ["nav", NAV_API],
    ["nav waypoint", NAV_WAYPOINT_API],
    ["raycast() result", RAYCAST_RESULT_API],
    ["raycast() options", RAYCAST_OPTS_API],
    ["input", INPUT_API],
    ["mouse", MOUSE_API],
    ["touch", TOUCH_API],
    ["touch item", TOUCH_ITEM_API],
    ["touch.swipe", TOUCH_SWIPE_API],
    ["touch.pinch", TOUCH_PINCH_API],
    ["camera.follow options", CAMERA_FOLLOW_OPTS_API],
    ["spawn options", SPAWN_OPTS_API],
    ["time", TIME_API],
    ["random", RANDOM_API],
    ["mathx", MATH_API],
    ["Math", MATH_NATIVE_API],
    ["debug", DEBUG_API],
    ["lifecycle", LIFECYCLE_API],
  ];
  for (const [group, table] of allTables) {
    for (const item of table) add(item.label, item.detail, group);
  }
  _hoverIndex = index;
  return index;
}

function registerHoverProvider(monaco) {
  monaco.languages.registerHoverProvider("javascript", {
    provideHover: function (model, position) {
      // Same defensive boundary as provideCompletionItems above, and for
      // the same reason — this fires on essentially every mouse move over
      // the editor, and _buildHoverIndex()/COMPONENT_APIS lookups touch
      // the same kind of live scene state that can legitimately be
      // mid-change (an object just deleted, etc.). Never let a hover
      // lookup failure propagate into Monaco's own event handling.
      try {
        const word = model.getWordAtPosition(position);
        if (!word) return null;
        const index = _buildHoverIndex();
        const entries = index.get(word.word);
        if (!entries || entries.length === 0) return null;

        const contents = entries.map((e) => ({
          value: "**" + word.word + "** _(" + e.group + ")_\n\n" + e.detail,
        }));
        return {
          range: new monaco.Range(
            position.lineNumber, word.startColumn,
            position.lineNumber, word.endColumn
          ),
          contents,
        };
      } catch (e) {
        console.warn("[Realot IntelliSense] hover pass failed:", e);
        return null;
      }
    },
  });
}

/**
 * Returns every built-in identifier Realot scripts can use, grouped by
 * category, for a "show me everything" reference view (e.g. a help panel or
 * command-palette action) — NOT used by the completion/hover providers
 * themselves, which read the API tables directly. Exists so an editor UI can
 * offer one authoritative, always-in-sync list of every keyword autocomplete
 * knows about, without hand-maintaining a second copy anywhere.
 */
export function getAllEngineIdentifiers() {
  const index = _buildHoverIndex();
  const byGroup = new Map();
  for (const [name, entries] of index) {
    for (const e of entries) {
      if (!byGroup.has(e.group)) byGroup.set(e.group, []);
      byGroup.get(e.group).push({ name, detail: e.detail });
    }
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return byGroup;
}
