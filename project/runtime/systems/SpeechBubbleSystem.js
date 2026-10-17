/**
 * runtime/systems/SpeechBubbleSystem.js
 *
 * The ONE piece of logic a speech bubble needs that isn't rendering:
 * counting down hideTimer (set by this.speechBubble.show(text, duration))
 * and clearing `visible` once it reaches zero. Kept as its own tiny
 * system — same reasoning as AnimationSystem only ever writing plain
 * component fields rather than touching PIXI/Rapier directly — so
 * RenderSystem.js can stay purely "turn current component state into
 * PIXI objects" (RULES.txt #5) without also owning gameplay timing.
 *
 * Registered in runtime/index.js right before RenderSystem, same slot
 * AnimationSystem uses, so a bubble that expires this frame is already
 * hidden by the time RenderSystem runs immediately after.
 *
 * RUNTIME-ONLY FILE.
 */

import { System } from "../core/System.js";
import { SPEECH_BUBBLE } from "../components/SpeechBubble.js";

export class SpeechBubbleSystem extends System {
  update(world, dt) {
    const entities = world.query(SPEECH_BUBBLE);
    for (const entity of entities) {
      const bubble = entity.getComponent(SPEECH_BUBBLE);
      if (bubble.visible && bubble.hideTimer > 0) {
        bubble.hideTimer -= dt;
        if (bubble.hideTimer <= 0) {
          bubble.hideTimer = 0;
          bubble.visible = false;
        }
      }
    }
  }
}
