/**
 * runtime/systems/JoystickSystem.js
 *
 * Gives each Joystick entity REAL, independent pointer/touch tracking —
 * deliberately its own listeners on the game canvas rather than reading
 * ScriptAPI's shared this.touch/this.mouse state (see ScriptAPI.js's
 * attachPointerInput). Two reasons this is separate, mirroring why
 * TextInputSystem owns a real DOM <input> instead of hand-rolling
 * keydown capture:
 *
 *   1. MULTI-JOYSTICK INDEPENDENCE (the actual point of this file).
 *      Each joystick claims exactly one pointer/touch id the moment a
 *      press lands inside its touchable area, and holds that id
 *      exclusively until release — a second joystick claims a
 *      DIFFERENT id the moment its own area is pressed. Because both
 *      claims are tracked here, in one place, against the full set of
 *      currently-down pointers, one joystick being actively dragged
 *      never blocks or interferes with another joystick being grabbed
 *      and moved at the same time. Reading through ScriptAPI's touch
 *      list would work too, but would couple joystick input handling
 *      to whatever a user's own onUpdate() script also happens to do
 *      with this.touch that frame — this stays independent so a
 *      joystick keeps working even in a scene with no script at all.
 *
 *   2. Runs whether or not the entity's Script (if any) even reads
 *      this.joystick that frame — same "system does the real work,
 *      scripts just read the result" split TextInput/ChatLog use.
 *
 * Both real mouse (pointerdown/move/up) and real touch (native Pointer
 * Events with a raw Touch Events fallback) are handled, matching
 * ScriptAPI.attachPointerInput's input path — mouse lets a desktop tester
 * drag a joystick with the cursor exactly as touch does on a phone.
 *
 * Registered in runtime/index.js; needs the canvas to convert
 * clientX/clientY into logical screen coordinates, so it's constructed as
 * `new JoystickSystem(pixiApp.view)` and wired up via attachInput(),
 * called once createGame() has the canvas (same two-step
 * construct-then-attach split attachPointerInput uses, for the same
 * reason: the canvas doesn't exist yet at construction time).
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { JOYSTICK, JoystickPositionMode } from "../components/Joystick.js";
import { clientToLocal, prepareGameCanvas } from "../core/MobileViewport.js";

export class JoystickSystem extends System {
  constructor(canvas, pixiApp = null) {
    super();
    this.canvas = canvas;
    this.pixiApp = pixiApp;
    this.uiContainer = null;
    /** @type {Map<string|number, string>} pointer/touch id -> entityId currently claimed by it */
    this._claimedBy = new Map();
    /** @type {Map<string, {pointerId:string|number, originX:number, originY:number}>} entityId -> active drag info */
    this._drags = new Map();
    this._attached = false;
  }

  /**
   * Wires up real mouse + touch listeners against the actual game
   * canvas. Not done in the constructor — same reasoning as
   * ScriptAPI.attachPointerInput: the canvas isn't guaranteed to exist
   * yet wherever this system gets constructed.
   * @param {HTMLCanvasElement} canvas
   */
  attachInput(canvas, uiContainer = null) {
    this.uiContainer = uiContainer || this.uiContainer;
    if (!canvas || this._attached || typeof window === "undefined") return;
    this.canvas = canvas;
    this._attached = true;
    const self = this;

    function toCanvasXY(clientX, clientY) {
      // Joysticks live in the reference-resolution UI container, so invert
      // that exact container transform rather than comparing a device-space
      // pointer against reference-space Transform.x/y values.
      const uiContainer = self.uiContainer || null;
      const p = clientToLocal(clientX, clientY, canvas, self.pixiApp, uiContainer);
      return { x: p.x, y: p.y };
    }

    function isTouchPointer(e) {
      return e.pointerType === "touch" || e.pointerType === "pen";
    }

    canvas.addEventListener("pointerdown", function (e) {
      if (isTouchPointer(e)) return; // touch/pen handled below
      const p = toCanvasXY(e.clientX, e.clientY);
      self._tryClaim("mouse", p.x, p.y);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (isTouchPointer(e)) return;
      const p = toCanvasXY(e.clientX, e.clientY);
      self._updateDrag("mouse", p.x, p.y);
    });
    canvas.addEventListener("pointerup", function (e) {
      if (isTouchPointer(e)) return;
      self._release("mouse");
    });
    canvas.addEventListener("pointercancel", function (e) {
      if (isTouchPointer(e)) return;
      self._release("mouse");
    });

    prepareGameCanvas(canvas);

    function handleTouchStart(id, clientX, clientY) {
      const p = toCanvasXY(clientX, clientY);
      self._tryClaim(id, p.x, p.y);
    }

    function handleTouchMove(id, clientX, clientY) {
      const p = toCanvasXY(clientX, clientY);
      self._updateDrag(id, p.x, p.y);
    }

    if (typeof window.PointerEvent === "function") {
      canvas.addEventListener("pointerdown", function (e) {
        if (!isTouchPointer(e)) return;
        e.preventDefault();
        if (canvas.setPointerCapture) {
          try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        }
        handleTouchStart(e.pointerId, e.clientX, e.clientY);
      }, { passive: false });
      canvas.addEventListener("pointermove", function (e) {
        if (!isTouchPointer(e)) return;
        e.preventDefault();
        handleTouchMove(e.pointerId, e.clientX, e.clientY);
      }, { passive: false });
      function pointerTouchEnd(e) {
        if (!isTouchPointer(e)) return;
        e.preventDefault();
        self._release(e.pointerId);
        if (canvas.releasePointerCapture) {
          try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      }
      canvas.addEventListener("pointerup", pointerTouchEnd, { passive: false });
      canvas.addEventListener("pointercancel", pointerTouchEnd, { passive: false });
    } else {
      canvas.addEventListener("touchstart", function (e) {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          handleTouchStart(t.identifier, t.clientX, t.clientY);
        }
      }, { passive: false });
      canvas.addEventListener("touchmove", function (e) {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          handleTouchMove(t.identifier, t.clientX, t.clientY);
        }
      }, { passive: false });
      function touchEnd(e) {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          self._release(e.changedTouches[i].identifier);
        }
      }
      canvas.addEventListener("touchend", touchEnd, { passive: false });
      canvas.addEventListener("touchcancel", touchEnd, { passive: false });
    }

    window.addEventListener("blur", function () {
      self._claimedBy.clear();
      self._drags.clear();
    });
  }

  /** Attempts to claim `pointerId` for whichever un-claimed joystick's touchable area contains (x, y), if any. */
  _tryClaim(pointerId, x, y) {
    if (this._claimedBy.has(pointerId)) return;
    if (!this._world) return;
    const entities = this._world.query(TRANSFORM, JOYSTICK);
    for (const entity of entities) {
      if (this._drags.has(entity.id)) continue; // already claimed by a different pointer
      const transform = entity.getComponent(TRANSFORM);
      const joystick = entity.getComponent(JOYSTICK);

      let originX, originY;
      if (joystick.positionMode === JoystickPositionMode.DYNAMIC) {
        if (
          x < joystick.regionX || x > joystick.regionX + joystick.regionWidth ||
          y < joystick.regionY || y > joystick.regionY + joystick.regionHeight
        ) continue;
        originX = x;
        originY = y;
      } else {
        // Fixed mode: the touchable area is the base's own radius
        // around Transform.x/y (generous — a full base-radius circle,
        // not just the knob, matching how mobile joystick controls
        // normally accept a press anywhere on the base to start
        // dragging, not just a pixel-perfect hit on the knob).
        const dx = x - transform.x;
        const dy = y - transform.y;
        if (Math.sqrt(dx * dx + dy * dy) > joystick.baseRadius) continue;
        originX = transform.x;
        originY = transform.y;
      }

      this._claimedBy.set(pointerId, entity.id);
      this._drags.set(entity.id, { pointerId, originX, originY });
      joystick.active = true;
      joystick.baseScreenX = originX;
      joystick.baseScreenY = originY;
      this._applyKnobPosition(joystick, x, y);
      return; // one claim per press — first matching joystick wins
    }
  }

  _updateDrag(pointerId, x, y) {
    const entityId = this._claimedBy.get(pointerId);
    if (!entityId || !this._world) return;
    const entity = this._world.getEntity(entityId);
    const joystick = entity && entity.getComponent(JOYSTICK);
    if (!joystick) return;
    this._applyKnobPosition(joystick, x, y);
  }

  _release(pointerId) {
    const entityId = this._claimedBy.get(pointerId);
    if (!entityId) return;
    this._claimedBy.delete(pointerId);
    this._drags.delete(entityId);
    if (!this._world) return;
    const entity = this._world.getEntity(entityId);
    const joystick = entity && entity.getComponent(JOYSTICK);
    if (!joystick) return;
    joystick.active = false;
    if (joystick.returnToCenter) {
      joystick.x = 0;
      joystick.y = 0;
      joystick.magnitude = 0;
    }
    // angle intentionally left at its last value even when snapping back
    // to center — same "last known facing" convention a script reading
    // this.joystick.angle after release would expect (magnitude 0 means
    // "not currently pushed", angle is still meaningful history).
  }

  /** Computes x/y/magnitude/angle (post dead-zone) from a raw pointer position, clamped to baseRadius. */
  _applyKnobPosition(joystick, x, y) {
    const dx = x - joystick.baseScreenX;
    const dy = y - joystick.baseScreenY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const clamped = Math.min(dist, joystick.baseRadius);
    const angle = Math.atan2(dy, dx);

    const rawMagnitude = joystick.baseRadius > 0 ? clamped / joystick.baseRadius : 0;
    const dz = Math.max(0, Math.min(0.95, joystick.deadZone));
    const magnitude = rawMagnitude < dz ? 0 : (rawMagnitude - dz) / (1 - dz);

    joystick.magnitude = magnitude;
    joystick.angle = angle * (180 / Math.PI);
    joystick.x = magnitude > 0 ? Math.cos(angle) * magnitude : 0;
    joystick.y = magnitude > 0 ? Math.sin(angle) * magnitude : 0;
  }

  update(world, dt) {
    this._world = world;

    // Entities that lost their Joystick component (or were destroyed)
    // while still claimed leave a dangling drag — release those so a
    // removed joystick never keeps a pointer id locked forever.
    for (const [entityId, drag] of this._drags) {
      const entity = world.getEntity(entityId);
      if (!entity || !entity.active || !entity.hasComponent(JOYSTICK)) {
        this._claimedBy.delete(drag.pointerId);
        this._drags.delete(entityId);
      }
    }
    // NOTE: no longer syncs baseScreenX/Y to Transform for idle Fixed-
    // mode joysticks here — RenderSystem now falls back to the live
    // Transform directly whenever joystick.active is false (see its own
    // comment), so that sync would be redundant AND would have kept
    // masking the real issue: this system only runs during actual
    // gameplay (GameLoop), never in the editor's Scene view, so an
    // idle joystick's drawn position must be derivable from data
    // RenderSystem already has on its own every frame, not from
    // anything only this system maintains.
  }

  /** Called on game teardown. */
  destroy() {
    this._claimedBy.clear();
    this._drags.clear();
  }
}
