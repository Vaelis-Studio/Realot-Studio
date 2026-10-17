/**
 * runtime/systems/AudioListenerSystem.js
 *
 * Drives every AudioListener ("ear") entity: each frame, computes which
 * 3D AudioSource entities currently fall within its radius (plain
 * circle-vs-point distance, no falloff — this is a boolean detector,
 * not a volume system; contrast with AudioSystem.js's linear falloff
 * used for actual playback volume). ONLY 3D AudioSources (is3D: true)
 * are ever detected — a 2D AudioSource has no world position to be
 * "heard" at (see components/AudioListener.js's header comment).
 *
 * Two jobs:
 *  1. Keeps a per-listener Set of currently-in-range AudioSource entity
 *     ids, exposed to scripts read-only via this.ear.sourcesInRange /
 *     this.ear.canHear() (see scripting/components/AudioListenerAPI.js,
 *     wired through scriptApi._audioListenerRangeFn — same indirection
 *     pattern as _sendMessageFn/_waitFn in ScriptSystem's constructor).
 *  2. Diffs each listener's in-range set against last frame's to fire
 *     onHearSound(source)/onLoseSound(source) via ScriptSystem's
 *     fireHearSound/fireLoseSound — exactly once per actual enter/exit
 *     transition, not every frame a source stays in range (matches
 *     onCollisionEnter/Exit's edge-triggered convention, not
 *     onCollision's level-triggered one).
 *
 * Runs BEFORE ScriptSystem in the system order (see runtime/index.js)
 * so a script's onUpdate()/onHearSound() this same frame already sees
 * this frame's fresh detection results, not last frame's.
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../components/Transform.js";
import { AUDIO_LISTENER } from "../components/AudioListener.js";
import { AUDIO_SOURCE } from "../components/AudioSource.js";

export class AudioListenerSystem {
  constructor() {
    /** @type {Map<string, Set<string>>} listener entity id -> Set of in-range AudioSource entity ids (this frame) */
    this._inRange = new Map();
    /** Set by runtime/index.js to ScriptSystem's fireHearSound/fireLoseSound, bound. */
    this.onHearSound = null;
    this.onLoseSound = null;
  }

  /**
   * @param {import('../core/World.js').World} world
   */
  update(world) {
    const listeners = world.query(TRANSFORM, AUDIO_LISTENER);
    const sources = world.query(TRANSFORM, AUDIO_SOURCE).filter((e) => {
      const s = e.getComponent(AUDIO_SOURCE);
      return s && s.is3D;
    });

    const liveListenerIds = new Set();

    for (const listenerEntity of listeners) {
      liveListenerIds.add(listenerEntity.id);
      const ear = listenerEntity.getComponent(AUDIO_LISTENER);
      const listenerTransform = listenerEntity.getComponent(TRANSFORM);

      const previousSet = this._inRange.get(listenerEntity.id) || new Set();
      const currentSet = new Set();

      if (ear.enabled) {
        const r2 = ear.radius * ear.radius;
        for (const sourceEntity of sources) {
          const t = sourceEntity.getComponent(TRANSFORM);
          const dx = t.x - listenerTransform.x;
          const dy = t.y - listenerTransform.y;
          if (dx * dx + dy * dy <= r2) currentSet.add(sourceEntity.id);
        }
      }

      // Diff against last frame — fire onHearSound for anything newly
      // in currentSet but not previousSet, onLoseSound for anything
      // that dropped out. A source entity that's simply destroyed
      // while in range also fires onLoseSound here (it silently stops
      // appearing in `sources` above, which is exactly "no longer in
      // currentSet" from this listener's point of view).
      if (this.onHearSound) {
        for (const sourceId of currentSet) {
          if (!previousSet.has(sourceId)) this.onHearSound(listenerEntity.id, sourceId, world);
        }
      }
      if (this.onLoseSound) {
        for (const sourceId of previousSet) {
          if (!currentSet.has(sourceId)) this.onLoseSound(listenerEntity.id, sourceId, world);
        }
      }

      this._inRange.set(listenerEntity.id, currentSet);
    }

    // Drop bookkeeping for any listener entity that no longer exists
    // (destroyed / component removed) — mirrors AudioSystem's identical
    // stale-entry cleanup for _elements.
    for (const id of this._inRange.keys()) {
      if (!liveListenerIds.has(id)) this._inRange.delete(id);
    }
  }

  /**
   * Read-only snapshot for scripting: every AudioSource entity id
   * currently in range of the given listener entity id, or an empty
   * array if the listener has none / doesn't exist. Called by
   * AudioListenerAPI.js's this.ear.sourcesInRange via
   * scriptApi._audioListenerRangeFn (see runtime/index.js wiring).
   * @param {string} listenerEntityId
   * @returns {string[]}
   */
  getInRange(listenerEntityId) {
    const set = this._inRange.get(listenerEntityId);
    return set ? Array.from(set) : [];
  }

  /**
   * Whole-scene teardown (scene restart/switch) — clears all detection
   * state so a listener that reappears (or a new one with a reused id)
   * starts from a clean slate rather than instantly firing onLoseSound
   * for sources that "were" in range in the OLD scene. Mirrors
   * ScriptSystem.destroy()'s / AudioSystem.destroy()'s per-teardown
   * cleanup.
   */
  destroy() {
    this._inRange.clear();
  }
}
