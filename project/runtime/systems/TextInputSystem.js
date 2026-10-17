/**
 * runtime/systems/TextInputSystem.js
 *
 * Gives each TextInput entity a REAL, invisible HTML <input> element,
 * positioned exactly on top of where its box is drawn on screen. This
 * is deliberate, not a shortcut: hand-rolling text capture from raw
 * keydown events never triggers a phone's on-screen keyboard (there is
 * no way to summon it except by focusing a genuine focusable DOM
 * element), doesn't get IME composition for non-Latin input, and
 * doesn't get copy/paste for free. A real <input> gets all of that from
 * the browser itself — exactly how every production HTML5 game handles
 * typed text. It's made invisible (opacity: 0, but NOT display:none —
 * a display:none element can't be focused) so the PIXI-drawn box in
 * RenderSystem.js is the only thing actually seen; this element only
 * exists to capture real keystrokes and hand them to the component.
 *
 * This system never touches PIXI (RenderSystem.js owns all of that —
 * RULES.txt #5) — it only manages this second, DOM-only, invisible
 * layer, and keeps it positioned in sync with the visible box each
 * frame. Registered in runtime/index.js; needs the canvas element to
 * compute screen positions from, so it's constructed as
 * `new TextInputSystem(pixiApp.view)`.
 *
 * PULSE TIMING — justSubmitted / clearing value on submit:
 * Pressing Enter fires asynchronously (a real DOM event on the
 * browser's own event loop — NOT tied to any requestAnimationFrame
 * boundary) and immediately sets component.justSubmitted = true —
 * component.value is NOT touched at that moment, so it still holds
 * exactly what was typed.
 *
 * Because the keydown can land at ANY point in wall-clock time, it can
 * fire AFTER this system's update() already ran for the current frame
 * but BEFORE ScriptSystem's update() runs later that same frame — in
 * which case ScriptSystem DOES see justSubmitted true that frame. But
 * it can just as easily fire in the gap between one frame's
 * TextInputSystem.update() and the NEXT frame's — i.e. after
 * ScriptSystem already ran for the frame that's currently in flight.
 * If we cleared on the very next TextInputSystem.update() (one stage),
 * that next update() call is guaranteed to run BEFORE that frame's
 * ScriptSystem.update() (system order: TextInputSystem, then
 * ScriptSystem — see runtime/index.js), so the flag would already be
 * false again by the time ScriptSystem gets to check it: it would never
 * observe true at all, even though the DOM input still visibly cleared.
 * This was a real bug (not just a timing edge case) — clearing was
 * effectively decoupled from whether ScriptSystem had ever gotten a
 * turn to read the pulse.
 *
 * Fix: clearing needs a full extra frame of buffer. The pulse is only
 * cleared once it has survived at least one COMPLETE update() where it
 * started the frame already true (i.e. it was set on a PRIOR frame, not
 * the current one) — that guarantees at least one full pass through
 * this frame's ScriptSystem.update() with the flag visible as true,
 * before TextInputSystem clears it back to false on the frame after.
 * See _pendingClear (armed the frame the pulse fires) vs _readyToClear
 * (armed one full update() later — the actual clear only happens here).
 *
 * IMPORTANT — promotion must happen at the END of update(), not the
 * start: a keydown can fire at any wall-clock moment, so by the time
 * THIS update() call runs, _pendingClear may already contain an id the
 * handler just added moments earlier (it's set directly by the DOM
 * listener, not queued for "next frame"). Promoting pendingClear into
 * readyToClear at the TOP of update() — before that same call's clear
 * check runs — collapses the two-stage buffer into one stage: the id
 * gets promoted and immediately cleared again in the same call, so
 * ScriptSystem.update() (later in that same frame) never observes
 * justSubmitted as true at all. Promoting at the END instead guarantees
 * the id sits in readyToClear across a full frame boundary, surviving
 * this frame's ScriptSystem.update() untouched, and is only consumed on
 * the NEXT update() call.
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { TEXT_INPUT } from "../components/TextInput.js";
import { clientToLocal } from "../core/MobileViewport.js";

export class TextInputSystem extends System {
  constructor(canvas, pixiApp = null, uiContainer = null) {
    super();
    this.canvas = canvas;
    this.pixiApp = pixiApp;
    this.uiContainer = uiContainer;
    /** @type {Map<string, HTMLInputElement>} entityId -> real DOM input */
    this._inputs = new Map();
    /** entity ids whose Enter keydown fired since the last time THIS
     *  system's update() ran — not yet safe to clear, since the CURRENT
     *  frame's ScriptSystem.update() (which runs after this system —
     *  see runtime/index.js) hasn't had a chance to see the pulse yet
     *  if the keydown just fired this update(). See file header. */
    this._pendingClear = new Set();
    /** entity ids that were already in _pendingClear as of the START of
     *  the previous update() call — meaning a full frame (including
     *  that frame's ScriptSystem.update()) has now definitely elapsed
     *  since the pulse was set. Safe to actually clear justSubmitted
     *  for these at the start of THIS update(). See file header. */
    this._readyToClear = new Set();
  }

  update(world, dt) {
    const entities = world.query(TRANSFORM, TEXT_INPUT);
    this._currentTextEntities = entities;
    const seen = new Set();
    // PERFORMANCE: getBoundingClientRect() forces the browser to run a
    // synchronous layout reflow — it can't just read a cached number,
    // it has to recompute the page's layout right then. That's fine
    // for an occasional call, but this used to run unconditionally at
    // the top of update() every single frame regardless of whether the
    // scene had any TextInput entities at all, so every game paid a
    // real layout-thrash cost 60 times a second even with zero text
    // boxes on screen — exactly the "flat ~35-39fps no matter what's in
    // the scene" symptom. rect is only actually used below to position
    // each TextInput's real DOM <input> (see the loop), so it's only
    // computed when there's at least one entity that needs it.
    const rect = entities.length > 0 ? this.canvas.getBoundingClientRect() : null;

    for (const entity of entities) {
      seen.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const textInput = entity.getComponent(TEXT_INPUT);

      // Actually clear now — this entity's pulse has already survived
      // one full update() cycle (including that frame's ScriptSystem
      // turn) since it was set. See file header for why this can't
      // just happen on the very next update() after the keydown.
      if (this._readyToClear.has(entity.id)) {
        this._readyToClear.delete(entity.id);
        textInput.justSubmitted = false;
        if (textInput.clearOnSubmit) {
          textInput.value = "";
          const el = this._inputs.get(entity.id);
          if (el) el.value = "";
        }
      }

      let el = this._inputs.get(entity.id);
      if (!el) {
        el = document.createElement("input");
        el.type = "text";
        el.autocomplete = "off";
        el.autocapitalize = "off";
        el.spellcheck = false;
        el.style.position = "fixed";
        el.style.opacity = "0";       // invisible — the PIXI box is what's actually seen
        el.style.border = "none";
        el.style.outline = "none";
        el.style.padding = "0";
        el.style.margin = "0";
        el.style.zIndex = "10000";
        el.style.pointerEvents = "auto";
        document.body.appendChild(el);

        el.addEventListener("input", () => {
          textInput.value = el.value.slice(0, textInput.maxLength);
          if (el.value.length > textInput.maxLength) el.value = textInput.value;
        });
        el.addEventListener("focus", () => { textInput.focused = true; });
        el.addEventListener("blur", () => { textInput.focused = false; });
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            textInput.justSubmitted = true;
            this._pendingClear.add(entity.id);
          }
        });
        // A transparent DOM input has no visible hit target of its own.
        // Mobile browsers only open the software keyboard when focus is
        // initiated from a real user gesture, so TextInputSystem owns the
        // tap-to-focus bridge here instead of relying on a later script call.

        this._inputs.set(entity.id, el);
      }

      // Keep the real input's value in sync with the component EXCEPT
      // while the player is actively typing (focused) — otherwise a
      // script setting this.textInput.value while the field is focused
      // would fight every keystroke the player makes.
      if (!textInput.focused && el.value !== textInput.value) {
        el.value = textInput.value;
      }
      el.maxLength = textInput.maxLength;
      el.placeholder = textInput.placeholder;

      // Position/size to exactly cover the visible PIXI-drawn box. UI
      // Transform.x/y are reference-resolution coordinates, then
      // uiContainer applies the device-fit scale/offset. Use PIXI's own
      // transform rather than reimplementing that math in DOM pixels.
      let left = rect.left + transform.x;
      let top = rect.top + transform.y;
      let width = textInput.width;
      let height = textInput.height;
      if (this.uiContainer && typeof this.uiContainer.toGlobal === "function") {
        const p0 = this.uiContainer.toGlobal({ x: transform.x, y: transform.y });
        const p1 = this.uiContainer.toGlobal({ x: transform.x + textInput.width, y: transform.y + textInput.height });
        left = rect.left + p0.x;
        top = rect.top + p0.y;
        width = Math.abs(p1.x - p0.x);
        height = Math.abs(p1.y - p0.y);
      }
      el.style.left = left + "px";
      el.style.top = top + "px";
      el.style.width = Math.max(1, width) + "px";
      el.style.height = Math.max(1, height) + "px";
    }

    // Remove real inputs for entities that no longer exist / lost the
    // component, so a destroyed chat box doesn't leave an invisible,
    // still-focusable element sitting on the page.
    for (const [entityId, el] of this._inputs) {
      if (!seen.has(entityId)) {
        el.remove();
        this._inputs.delete(entityId);
        this._pendingClear.delete(entityId);
        this._readyToClear.delete(entityId);
      }
    }

    // Keep the invisible native input exactly where the visible PIXI box is,
    // and make it focusable from a direct touch/click. The actual event
    // listener is installed once per canvas so repeated update() calls never
    // accumulate handlers.
    if (!this._inputPointerHandler && this.canvas && typeof this.canvas.addEventListener === "function") {
      this._inputPointerHandler = (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const rectNow = this.canvas.getBoundingClientRect();
        const p = clientToLocal(
          e.clientX, e.clientY, this.canvas, this.pixiApp, this.uiContainer
        );
        let focused = false;
        for (const entity of this._currentTextEntities || []) {
          const transform = entity.getComponent(TRANSFORM);
          const input = entity.getComponent(TEXT_INPUT);
          if (p.x >= transform.x && p.x <= transform.x + input.width &&
              p.y >= transform.y && p.y <= transform.y + input.height) {
            const el = this._inputs.get(entity.id);
            if (el) {
              el.focus({ preventScroll: true });
              focused = true;
              break;
            }
          }
        }
        if (!focused && this._inputs.size) {
          const active = document.activeElement;
          if (active && this._inputsHasElement(active)) active.blur();
        }
      };
      this.canvas.addEventListener("pointerdown", this._inputPointerHandler, { passive: true });
    }

    // Promote anything the keydown handler marked pending SINCE this
    // update() started to "ready to clear NEXT update() call" — done
    // here, at the END of update(), rather than at the top. A keydown
    // can fire at any wall-clock moment, so by the time this update()
    // runs, _pendingClear may already contain an id the handler just
    // added. Promoting at the top of the SAME call that also reads
    // _readyToClear collapsed the two-stage buffer into one stage: the
    // id would be promoted and immediately cleared again before
    // ScriptSystem.update() (which runs after this system, later in
    // this very frame) ever got a chance to observe justSubmitted as
    // true. Promoting here instead guarantees the id sits in
    // _readyToClear across a FULL frame boundary — surviving this
    // frame's ScriptSystem.update() untouched — and is only cleared on
    // the NEXT update() call, one frame later. See file header.
    for (const id of this._pendingClear) {
      this._readyToClear.add(id);
    }
    this._pendingClear.clear();
  }

  _inputsHasElement(el) {
    for (const input of this._inputs.values()) if (input === el) return true;
    return false;
  }

  /** Called on game teardown — removes every real input this system created. */
  destroy() {
    if (this._inputPointerHandler && this.canvas) {
      this.canvas.removeEventListener("pointerdown", this._inputPointerHandler);
      this._inputPointerHandler = null;
    }
    this._currentTextEntities = [];
    for (const el of this._inputs.values()) el.remove();
    this._inputs.clear();
    this._pendingClear.clear();
    this._readyToClear.clear();
  }
}
