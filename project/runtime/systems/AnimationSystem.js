/**
 * runtime/systems/AnimationSystem.js
 *
 * Plays back SpriteAnimation clips: advances currentFrameIndex at the
 * active clip's fps * speed, writes the resulting frame's spriteKey onto
 * the entity's SpriteRenderer (the same field a script or the Inspector
 * could set directly — this system just sets it every tick instead),
 * and — if the active clip defines one — copies its colliderOverride
 * fields onto the entity's live Collider2D component so different
 * animations can each have their own collision shape (e.g. a "crouch"
 * clip using a shorter box, a "roll" clip using a circle).
 *
 * No PIXI/Rapier objects are touched directly here — this system only
 * ever writes into other components' plain data fields, exactly like
 * ControllerSystem only ever writes into Rigidbody2D's velocity fields
 * rather than touching Rapier itself.
 *
 * RUNTIME-ONLY FILE.
 */

import { System } from "../core/System.js";
import { SPRITE_ANIMATION } from "../components/SpriteAnimation.js";
import { SPRITE_RENDERER } from "../components/SpriteRenderer.js";
import { COLLIDER_2D } from "../components/Collider2D.js";
import { getSpriteAsset } from "../assets/AssetRegistry.js";

export class AnimationSystem extends System {
  update(world, dt) {
    const entities = world.query(SPRITE_ANIMATION);

    for (const entity of entities) {
      const anim = entity.getComponent(SPRITE_ANIMATION);
      const clip = anim.clips.find((c) => c.id === anim.currentClipId) || null;
      if (!clip || clip.frames.length === 0) continue;

      if (anim.playing && dt > 0) {
        this._advance(anim, clip, dt);
      }

      const frame = clip.frames[Math.min(anim.currentFrameIndex, clip.frames.length - 1)];

      const spriteRenderer = entity.getComponent(SPRITE_RENDERER);
      if (spriteRenderer && frame) {
        spriteRenderer.spriteKey = frame.spriteKey;

        // Establish a deterministic size reference the FIRST time this
        // entity ever renders an animation frame, if one wasn't already
        // captured at placement time (see SpriteRenderer.js's
        // referenceWidth/Height doc comment). Using clip.frames[0]
        // specifically — rather than leaving it to fall back to
        // "whichever frame RenderSystem happens to see first" — means
        // the reference is always the animation's own first frame,
        // regardless of playback position, loop state, or which frame
        // the editor happened to leave currentFrameIndex on when Play
        // was pressed.
        if (!spriteRenderer.referenceWidth || !spriteRenderer.referenceHeight) {
          const firstFrame = clip.frames[0];
          const firstAsset = firstFrame && getSpriteAsset(firstFrame.spriteKey);
          if (firstAsset) {
            spriteRenderer.referenceWidth = firstAsset.width;
            spriteRenderer.referenceHeight = firstAsset.height;
          }
        }
      }

      if (clip.colliderOverride) {
        const collider = entity.getComponent(COLLIDER_2D);
        if (collider) this._applyColliderOverride(collider, clip.colliderOverride);
      }
    }
  }

  /**
   * Fixed-step-independent frame advance: accumulates real elapsed time
   * against the clip's own seconds-per-frame (1/fps), so playback speed
   * is correct regardless of the game's actual frame rate — same
   * accumulator pattern used for physics-independent timing elsewhere
   * in this engine (e.g. ControllerSystem's acceleration lerp uses dt
   * directly rather than assuming a fixed tick rate).
   */
  _advance(anim, clip, dt) {
    const fps = Math.max(0.0001, clip.fps) * Math.max(0, anim.speed);
    const secondsPerFrame = 1 / fps;

    anim.frameElapsed += dt;

    // while-loop (not if) so a big dt spike (tab was backgrounded, huge
    // dt clamped by GameLoop but still possibly multi-frame-worth) still
    // advances the correct NUMBER of frames rather than just one, same
    // spirit as GameLoop's own dt clamp — catch up, don't skip logic.
    while (anim.frameElapsed >= secondsPerFrame) {
      anim.frameElapsed -= secondsPerFrame;
      anim.currentFrameIndex++;

      if (anim.currentFrameIndex >= clip.frames.length) {
        if (clip.loop) {
          anim.currentFrameIndex = 0;
        } else {
          anim.currentFrameIndex = clip.frames.length - 1;
          anim.playing = false; // hold on the last frame, matching Unity's non-looping clip behavior
          anim.frameElapsed = 0;
          break;
        }
      }
    }
  }

  /**
   * Copies every ColliderOverride field onto the live Collider2D
   * component. Only fields the override actually defines are copied
   * (an override built from a partial shape, e.g. just {shape, radius}
   * for a Circle, leaves box/capsule/triangle fields on the real
   * component untouched) — this matters because switching FROM a clip
   * with an override back to one WITHOUT one intentionally does nothing
   * here (see AnimationClip.colliderOverride's doc: null means "no
   * opinion"), so the entity's last-applied shape simply persists,
   * which matches "no override" reading as "don't touch it" rather than
   * "reset it".
   */
  _applyColliderOverride(collider, override) {
    for (const key of Object.keys(override)) {
      if (key === "trianglePoints" && Array.isArray(override.trianglePoints)) {
        collider.trianglePoints = override.trianglePoints.map((p) => ({ x: p.x, y: p.y }));
      } else {
        collider[key] = override[key];
      }
    }
  }
}
