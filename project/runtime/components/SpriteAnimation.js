/**
 * runtime/components/SpriteAnimation.js
 *
 * Frame-based sprite animation (Unity 2D "Sprite Renderer + Animator
 * with a simple frame list" style) — NOT a keyframe/property timeline.
 * A clip is just an ordered list of spriteKeys (each resolved to a
 * texture the same way SpriteRenderer.spriteKey already is — see
 * runtime/assets/AssetManager.js) played back at a fixed frames-per-
 * second, looping by default.
 *
 * This component holds ONLY plain, serializable data — no PIXI objects,
 * no playback/timer state (current frame index + elapsed time live on
 * the component too, since that's per-entity simulation state, but it's
 * still plain numbers, not objects). Actual playback (advancing frames,
 * writing the current frame's spriteKey onto SpriteRenderer, swapping
 * Collider2D when a clip defines a collider override) is done by
 * runtime/systems/AnimationSystem.js — same split every other component
 * in this engine follows (data here, behavior in a System).
 *
 * An entity needs a SpriteRenderer for playback to have any visible
 * effect (AnimationSystem writes into SpriteRenderer.spriteKey), the
 * same convention CharacterController already uses with Rigidbody2D.
 *
 * RUNTIME-ONLY FILE.
 */

export const SPRITE_ANIMATION = "SpriteAnimation";

/**
 * @typedef {object} AnimationFrame
 * @property {string} spriteKey resolves to a texture via AssetManager,
 *   same convention as SpriteRenderer.spriteKey
 * @property {string} [sourceAssetKey] the ORIGINAL imported asset (a
 *   standalone image, or a sprite-sheet) this frame was sliced from —
 *   purely metadata for the Animation panel (e.g. to regroup/re-slice
 *   frames later, or show "3 frames from player_sheet.png"); playback
 *   itself never reads this, only spriteKey.
 */

/**
 * @typedef {object} ColliderOverride plain mirror of Collider2D's own
 *   constructor fields (see runtime/components/Collider2D.js) — kept as
 *   a separate plain object rather than a live Collider2D instance so a
 *   clip with no override set stays exactly `null`, and so serializing a
 *   scene never has to special-case "is this a real component or a
 *   frozen snapshot". AnimationSystem copies these fields onto the
 *   entity's real Collider2D component when this clip becomes active,
 *   the same way it copies spriteKey onto SpriteRenderer.
 */

/**
 * @typedef {object} AnimationClip
 * @property {string} id stable id, independent of name/order — referenced
 *   by SpriteAnimation.currentClipId and safe to keep referencing across
 *   a rename or reorder.
 * @property {string} name user-facing, editable, shown in the panel's
 *   clip list and the Inspector's clip-picker dropdown
 * @property {AnimationFrame[]} frames ordered; playback order IS array
 *   order — reordering in the panel just reorders this array.
 * @property {number} fps frames per second for this clip specifically
 *   (each clip can have its own, matching Unity's per-AnimationClip
 *   frameRate rather than one shared global fps)
 * @property {boolean} loop
 * @property {ColliderOverride|null} colliderOverride when set, this
 *   clip drives the entity's Collider2D shape/size while it's the
 *   active/playing clip (see the requested "each new animation can have
 *   their own different collision shape" feature) — null means "leave
 *   Collider2D exactly as authored on the entity, this clip has no
 *   opinion about collision shape".
 */

export class SpriteAnimation {
  constructor({
    /** @type {AnimationClip[]} */
    clips = [],
    /** @type {string|null} which clip.id is currently selected/playing */
    currentClipId = null,
    /** whether playback advances automatically every frame (vs. paused —
     *  e.g. while the Animation panel's own scrubber/frame-step is being
     *  used instead of real gameplay time) */
    playing = true,
    /** playback speed multiplier — 1 = clip's own fps, 2 = double speed,
     *  etc. Kept separate from a clip's own fps so script code can do a
     *  quick "speed up during a dash" without touching authored data. */
    speed = 1,

    // --- Simulation state (still plain numbers/strings, not objects —
    // this is per-entity playback progress, same category of field as
    // Rigidbody2D.velocityX: it changes every frame at runtime, but it's
    // still serializable plain data, not a PIXI/Rapier handle). ---
    /** index into the current clip's frames array */
    currentFrameIndex = 0,
    /** seconds accumulated since the last frame advance */
    frameElapsed = 0,
  } = {}) {
    // Deep-copy clips (and their frames/colliderOverride) so distinct
    // SpriteAnimation instances never accidentally share array/object
    // references — same defensive-copy reasoning Collider2D.trianglePoints
    // already uses.
    this.clips = clips.map((clip) => ({
      id: clip.id,
      name: clip.name,
      frames: (clip.frames || []).map((f) => ({ spriteKey: f.spriteKey, sourceAssetKey: f.sourceAssetKey || null })),
      fps: clip.fps != null ? clip.fps : 12,
      loop: clip.loop !== false,
      colliderOverride: clip.colliderOverride ? { ...clip.colliderOverride } : null,
    }));
    this.currentClipId = currentClipId;
    this.playing = playing;
    this.speed = speed;

    this.currentFrameIndex = currentFrameIndex;
    this.frameElapsed = frameElapsed;
  }
}

let _nextClipId = 1;
let _nextFrameSourceId = 1;

/** Generates a stable id for a new clip — exported so the Animation panel
 * (editor-only) can create clips with the same id scheme without
 * duplicating a counter of its own. */
export function generateClipId() {
  return "clip_" + _nextClipId++;
}

/** Generates a stable id for a freshly-imported source asset grouping
 * (a single sprite sheet or a batch of standalone images) — used by the
 * import pipeline, exported for the same reason as generateClipId. */
export function generateFrameSourceId() {
  return "animsrc_" + _nextFrameSourceId++;
}
