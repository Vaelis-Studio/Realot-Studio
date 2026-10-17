/**
 * runtime/components/Joystick.js
 *
 * An on-screen virtual joystick (base + draggable knob) — the standard
 * mobile-game control for movement/aiming. Useful two ways:
 *   - Fixed: always drawn at Transform.x/y, a permanent HUD element.
 *   - Dynamic: invisible until the player presses down anywhere inside
 *     its designated screen region, then the base recenters under
 *     their finger — the "appears wherever you touch" style used by
 *     most twin-stick mobile games.
 *
 * Like TextInput/ChatLog, this is plain serializable data — it never
 * holds a PIXI object or a real pointer/touch id directly. Two systems
 * cooperate to bring it to life:
 *   - runtime/systems/JoystickSystem.js owns the REAL pointer/touch
 *     tracking (which finger is dragging which joystick) and writes
 *     the live x/y/magnitude/angle/active fields below every frame —
 *     see that file's header for why joysticks track pointers
 *     independently of ScriptAPI's own touch list (so one joystick
 *     being dragged never blocks another from being grabbed at the
 *     same time — RULES.txt-style multi-touch independence).
 *   - runtime/systems/RenderSystem.js draws the visible base/knob
 *     purely from this component's current data (RenderSystem.js is
 *     the only system that touches PIXI).
 *
 * `x`, `y`, `magnitude`, `angle`, `active`, and `baseScreenX/Y` all
 * reflect real, live state rather than being hand-authored — same
 * reasoning as TextInput's value/focused: keeping them here means the
 * Inspector and this.joystick (JoystickAPI.js) both see the real
 * current state, not something hidden in a system's private map.
 *
 * IMPORTANT — baseScreenX/Y is ONLY meaningful while `active` is true
 * (a real drag in progress, written by JoystickSystem). Whenever
 * `active` is false — including the entire time spent editing in the
 * Scene view, where JoystickSystem never runs at all (see
 * SceneViewport.syncSpriteRender's doc comment) — RenderSystem falls
 * back to drawing at the entity's live Transform.x/y instead, exactly
 * like TextInput/ChatLog always do. That fallback is what makes a
 * Fixed-mode joystick follow the object when you move/reparent it in
 * the editor, and what keeps a Dynamic-mode joystick visible/selectable
 * in the Scene view before any press has ever happened.
 *
 * RUNTIME-ONLY FILE.
 */

export const JOYSTICK = "Joystick";

/**
 * PositionMode is presented as "Position" in the Inspector.
 */
export const JoystickPositionMode = Object.freeze({
  FIXED: "Fixed",     // always drawn at Transform.x/y, never moves
  DYNAMIC: "Dynamic",  // appears centered wherever the player first presses down inside activeRegion
});

export class Joystick {
  constructor({
    positionMode = JoystickPositionMode.FIXED,

    // Dynamic-mode touch region — the screen-space rectangle (in the
    // same pixel convention Transform.x/y already use for screen-space
    // UI, see TextInput.js's file header) that a press must land inside
    // to claim this joystick. Ignored in Fixed mode, where the base's
    // own radius around Transform.x/y is the touchable area instead.
    // Defaults to the left half of a 1280x720-ish canvas — a sane
    // starting region for a left-hand movement stick; the right stick
    // of a twin-stick pair would typically get its region's x moved to
    // the right half.
    regionX = 0,
    regionY = 0,
    regionWidth = 640,
    regionHeight = 720,

    // Visuals
    baseRadius = 60,
    knobRadius = 28,
    baseColor = "#ffffff",
    baseOpacity = 0.25,
    knobColor = "#ffffff",
    knobOpacity = 0.6,
    outlineColor = "#ffffff",
    outlineWidth = 2,

    // Behavior
    deadZone = 0.1,          // 0-1: fraction of baseRadius the knob must move before x/y leaves 0
    returnToCenter = true,    // true = knob snaps back to center on release; false = holds last position
    hideWhenIdle = false,     // true = invisible until actively being dragged (works in both position modes)
    idleOpacityMultiplier = 0.35, // when hideWhenIdle is false, how much to dim the whole stick while not in use (1 = no dimming)

    // Live state — see the file header for why these live here rather
    // than in JoystickSystem's private state.
    x = 0,               // -1..1, horizontal knob offset (right = positive), after dead zone
    y = 0,               // -1..1, vertical knob offset (down = positive), after dead zone
    magnitude = 0,        // 0..1, distance of the knob from center after dead zone
    angle = 0,            // degrees, 0 = right, 90 = down (screen-space convention, matches Transform.rotation's clockwise-positive sense)
    active = false,        // true while a finger/pointer is currently dragging this joystick
    baseScreenX = 0,       // current drawn base center, in screen px — equals Transform.x/y in Fixed mode, or the recentered touch point in Dynamic mode
    baseScreenY = 0,
  } = {}) {
    this.positionMode = positionMode;

    this.regionX = regionX;
    this.regionY = regionY;
    this.regionWidth = regionWidth;
    this.regionHeight = regionHeight;

    this.baseRadius = baseRadius;
    this.knobRadius = knobRadius;
    this.baseColor = baseColor;
    this.baseOpacity = baseOpacity;
    this.knobColor = knobColor;
    this.knobOpacity = knobOpacity;
    this.outlineColor = outlineColor;
    this.outlineWidth = outlineWidth;

    this.deadZone = deadZone;
    this.returnToCenter = returnToCenter;
    this.hideWhenIdle = hideWhenIdle;
    this.idleOpacityMultiplier = idleOpacityMultiplier;

    this.x = x;
    this.y = y;
    this.magnitude = magnitude;
    this.angle = angle;
    this.active = active;
    this.baseScreenX = baseScreenX;
    this.baseScreenY = baseScreenY;
  }
}
