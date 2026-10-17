/**
 * runtime/systems/AudioSystem.js
 *
 * Actually plays AudioSource components every frame — resolves each
 * entity's audioKey to a real dataUrl (via AssetManager.resolveAudioSrc)
 * and drives a plain HTMLAudioElement per entity, exactly like
 * RenderSystem drives a PIXI.Sprite per SpriteRenderer entity.
 *
 * Two behaviors (see components/AudioSource.js for the full rationale):
 *  - 2D: plays at a constant volume regardless of world position — the
 *    "Listener" (the active Main Camera) never affects it.
 *  - 3D: volume is scaled by distance from the Listener to the
 *    AudioSource entity's Transform — full volume inside minDistance,
 *    linearly silent by maxDistance.
 *
 * Only ever ticks while a game loop is actually running (Play mode /
 * the standalone player) — the editor's Scene viewport never calls
 * update() on this system while just editing, so placing/adjusting an
 * AudioSource never causes unwanted playback (matches Unity: audio
 * only plays in Play mode, never in the plain Scene-editing view).
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../components/Transform.js";
import { AUDIO_SOURCE } from "../components/AudioSource.js";
import { CAMERA } from "../components/Camera.js";
import { resolveAudioSrc } from "../assets/AssetManager.js";

export class AudioSystem {
  constructor() {
    /** @type {Map<string, HTMLAudioElement>} entity id -> live element */
    this._elements = new Map();
    /** @type {Map<string, string>} entity id -> audioKey the element was built for */
    this._elementKeys = new Map();
    // entity id -> the `autoplay` value we saw LAST frame. Used to tell
    // "autoplay just turned on" (start/restart playback) apart from
    // "autoplay has been true all along and the clip simply finished on
    // its own" (do nothing) — see the comment above the play()/pause()
    // block in update() for the full story.
    this._prevAutoplay = new Map();
    // entity id -> whether the CURRENT element has fired canplaythrough
    // (or the loadeddata fallback) at least once — see _ensureElement's
    // comment for why this replaces polling el.readyState directly.
    this._canPlay = new Map();
    // entity id -> the AudioSource._replayToken value we last consumed.
    // Every playOnce() call bumps that counter (see AudioAPI.js); any
    // change we see here (not just != undefined) means "play a fresh
    // one-shot now", completely independent of the autoplay flag above
    // — this is what lets playOnce() fire again and again (e.g. every
    // bounce's onCollisionEnter) even though the previous shot may
    // still be mid-playback or may have already finished and left
    // autoplay/el.paused in a state the justEnabled check alone
    // wouldn't retrigger from.
    this._lastReplayToken = new Map();
    // entity id -> array of in-flight one-shot voices started by
    // playOnce() — see _playOneShot()/_pruneOneShots() for why these are POOLED (a fresh element per overlapping call)
    // instead of reusing the single shared `el` above: reusing one
    // element meant a playOnce() fired while the previous shot was
    // still sounding (e.g. rapid bounces early in a ball's roll) did
    // el.currentTime = 0 on THAT SAME element, cutting the in-progress
    // shot off immediately — so on a fast-bouncing object you'd only
    // ever hear a sliver of the attack, over and over, and never a full
    // "boing" until the bounces slowed down enough to space out past
    // the clip's length. A pool lets every overlapping call ring out
    // independently, exactly like Unity's AudioSource.PlayOneShot.
    this._oneShotVoices = new Map();
    this._userInteracted = false;
    this._pendingAutoplay = new Set();
    this._gestureHandler = null;
  }

  /**
   * Mobile browsers commonly block HTMLAudio playback until a real user
   * gesture occurs. Record that gesture on the game surface so autoplay
   * sources that were blocked at boot can be retried after the first tap.
   */
  attachInput(canvas) {
    if (!canvas || this._gestureHandler) return;
    this._gestureCanvas = canvas;
    this._gestureHandler = () => {
      this._userInteracted = true;
      for (const id of this._pendingAutoplay) this._prevAutoplay.set(id, false);
      this._pendingAutoplay.clear();
    };
    canvas.addEventListener("pointerdown", this._gestureHandler, { passive: true });
    canvas.addEventListener("touchstart", this._gestureHandler, { passive: true });
  }

  /**
   * Starts a brand-new, independent playback of source's current clip —
   * never touches or interrupts `el` (the shared element `play()`/
   * `autoplay`/Loop drive) or any other in-flight one-shot voice, so
   * overlapping playOnce() calls (e.g. several bounces in quick
   * succession) each ring out in full rather than cutting each other
   * off. Applies the SAME volume/pitch/3D-falloff snapshot the main
   * element gets this frame — a moving 3D source's one-shots use its
   * position at the moment they were triggered, matching how a real
   * physics impact sound would be heard.
   * @param {string} entityId
   * @param {AudioSource} source
   * @param {number} appliedVolume final 0-1 volume (post distance falloff)
   */
  _playOneShot(entityId, source, appliedVolume) {
    const src = resolveAudioSrc(source.audioKey);
    if (!src) return;
    const voice = new Audio(src);
    voice.preload = "auto";
    voice.volume = appliedVolume;
    voice.playbackRate = Math.max(0.25, Math.min(4, source.pitch != null ? source.pitch : 1));
    voice.loop = false; // a one-shot is always one-shot, regardless of the AudioSource's Loop field
    voice.play().catch(() => {
      // Same autoplay-policy note as the main element's play() calls —
      // safe to ignore; a blocked one-shot simply never sounds, which
      // is the same outcome the shared element gets in that situation.
    });
    if (!this._oneShotVoices.has(entityId)) this._oneShotVoices.set(entityId, []);
    this._oneShotVoices.get(entityId).push(voice);
  }

  /**
   * Frees finished one-shot voices so the pool doesn't grow forever for
   * an entity that fires playOnce() a lot over a long play session.
   * Checked every frame per entity, right after any new voice for this
   * frame was started above.
   * @param {string} entityId
   */
  _pruneOneShots(entityId) {
    const voices = this._oneShotVoices.get(entityId);
    if (!voices || !voices.length) return;
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i];
      if (v.ended || v.paused) {
        v.src = "";
        voices.splice(i, 1);
      }
    }
  }

  /**
   * @param {import('../core/World.js').World} world
   */
  update(world) {
    const entities = world.query(TRANSFORM, AUDIO_SOURCE);
    const liveIds = new Set();

    const listener = this._findListener(world);

    for (const entity of entities) {
      liveIds.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const source = entity.getComponent(AUDIO_SOURCE);
      const el = this._ensureElement(entity.id, source);
      if (!el) {
        // audioKey is null/unknown (asset missing, key edited, or not
        // loaded yet in this module realm) — tear down any element a
        // PREVIOUS valid key already created for this entity, so a
        // clip doesn't keep looping/playing forever just because its
        // key later became invalid. Without this, only entities that
        // are fully removed from the world get cleaned up below;
        // an entity that stays alive but loses its audio would not.
        this._releaseElement(entity.id);
        continue;
      }

      const distanceVolume = source.is3D ? _distanceVolume(listener, transform, source) : 1;
      const appliedVolume = Math.max(0, Math.min(1, source.volume * distanceVolume));
      el.volume = appliedVolume;
      // Clamp to the range browsers actually support smoothly — below
      // ~0.25 or above ~4 most engines (and HTMLAudioElement) start
      // producing choppy/silent playback rather than a clean pitch
      // shift, so guard against a script setting an extreme value.
      el.playbackRate = Math.max(0.25, Math.min(4, source.pitch != null ? source.pitch : 1));

      // `autoplay` doubles as this.audio.play()/stop()'s flag (see
      // AudioAPI.js), so it can go true->false->true many times over a
      // clip's life, not just once at scene start. The bug: checking
      // only `source.autoplay && el.paused` can't tell "just told to
      // play" apart from "already finished playing on its own a moment
      // ago and is just sitting there paused" — with Loop off, a
      // finished clip leaves el.paused = true and source.autoplay still
      // true, so every subsequent frame re-triggered el.play(),
      // replaying the clip forever even though Loop was unchecked.
      // Fix: only ever call el.play() on the actual false->true
      // TRANSITION (a fresh play() call or a newly-created element),
      // never merely because autoplay-is-true-and-paused-is-true.
      const prevAutoplay = this._prevAutoplay.get(entity.id);
      const justEnabled = !!source.autoplay && prevAutoplay !== true;
      const retryAfterGesture = this._userInteracted && this._pendingAutoplay.has(entity.id) && source.autoplay;
      // "Ready" combines two signals: the canplaythrough/loadeddata
      // events set in _ensureElement (fires reliably for network-loaded
      // audio) OR a direct readyState >= 2 (HAVE_CURRENT_DATA) check
      // done every frame as a fallback — some browsers never fire
      // either loading event for a data: URL element that was already
      // fully in memory at construction time (nothing to "load"), which
      // left _canPlay stuck at false forever and silently blocked EVERY
      // play trigger (autoplay AND playOnce) from ever firing. The
      // readyState poll alone (what the ORIGINAL code used) is safe
      // here specifically because readiness is only ever checked, never
      // used to gate WHICH frame consumes justEnabled/replayRequested —
      // that consumption already happens exactly once, on the transition
      // logic below, regardless of how many frames "ready" stays true.
      const ready = this._canPlay.get(entity.id) === true || el.readyState >= 2;
      if (el.readyState >= 2) this._canPlay.set(entity.id, true);

      // One-shot replay request (this.audio.playOnce()) — a
      // COMPLETELY SEPARATE playback path from the shared `el` below
      // (see _playOneShot()'s doc comment for why: reusing `el` meant
      // an overlapping playOnce() cut off the still-playing previous
      // shot instead of layering on top of it). Doesn't need the
      // `ready` gate `el` uses — _playOneShot builds and plays its own
      // fresh element on demand, so it's ready by construction.
      const lastToken = this._lastReplayToken.get(entity.id);
      const replayRequested = source._replayToken !== 0 && source._replayToken !== lastToken;
      if (replayRequested) {
        this._playOneShot(entity.id, source, appliedVolume);
        this._lastReplayToken.set(entity.id, source._replayToken);
      }
      this._pruneOneShots(entity.id);

      const shouldStart = (justEnabled || retryAfterGesture) && ready && el.paused;
      if (shouldStart) {
        el.currentTime = 0;
        el.play().then(() => {
          this._pendingAutoplay.delete(entity.id);
        }).catch(() => {
          // Keep the request pending. A phone/WebView may require the first
          // real user gesture before media playback is permitted.
          this._pendingAutoplay.add(entity.id);
          this._prevAutoplay.set(entity.id, false);
        });
      } else if (justEnabled || retryAfterGesture) {
        // Not ready yet (still loading) — keep retrying the
        // just-enabled check next frame instead of dropping it, by not
        // recording autoplay as "seen" until it actually starts.
      } else if (!source.autoplay && !el.paused) {
        el.pause();
      }
      if (ready || !source.autoplay) {
        // A failed autoplay attempt deliberately stays false so the
        // post-gesture retry path can run. Successful playback clears the
        // pending marker above and records the normal true state here.
        if (source.autoplay && this._pendingAutoplay.has(entity.id)) {
          this._prevAutoplay.set(entity.id, false);
        } else {
          this._prevAutoplay.set(entity.id, !!source.autoplay);
        }
      }

    }

    // Stop + release elements for entities that no longer have an
    // AudioSource (removed component / deleted entity), same cleanup
    // shape RenderSystem uses for stale sprites.
    for (const id of this._elements.keys()) {
      if (!liveIds.has(id)) this._releaseElement(id);
    }
  }

  _releaseElement(entityId) {
    const el = this._elements.get(entityId);
    this._stopOneShots(entityId);
    if (!el) return;
    el.pause();
    el.src = "";
    this._elements.delete(entityId);
    this._elementKeys.delete(entityId);
    this._prevAutoplay.delete(entityId);
    this._canPlay.delete(entityId);
    this._lastReplayToken.delete(entityId);
  }

  /**
   * Stops and releases every in-flight one-shot voice for an entity —
   * used when the entity itself is torn down (see _releaseElement) so a
   * boing/impact sound that was mid-playback doesn't keep sounding
   * after the entity it belongs to is gone. NOT called for the ordinary
   * "clip finished naturally" case — _pruneOneShots handles that every
   * frame without interrupting anything.
   * @param {string} entityId
   */
  _stopOneShots(entityId) {
    const voices = this._oneShotVoices.get(entityId);
    if (!voices) return;
    for (const v of voices) {
      v.pause();
      v.src = "";
    }
    this._oneShotVoices.delete(entityId);
  }

  _ensureElement(entityId, source) {
    const src = resolveAudioSrc(source.audioKey);
    if (!src) return null;

    const existingKey = this._elementKeys.get(entityId);
    let el = this._elements.get(entityId);

    if (!el || existingKey !== source.audioKey) {
      if (el) {
        el.pause();
        el.src = "";
      }
      el = new Audio(src);
      // Force full buffering before we ever call play() on it — without
      // this, some browsers leave a freshly-created element under-
      // buffered for a data: URL, and playing from there before it's
      // finished decoding produces a short glitchy/garbled burst instead
      // of the real clip. We track actual readiness via the
      // 'canplaythrough' event (see _canPlay below) rather than polling
      // el.readyState every frame — readyState can sit at 2 or 3
      // indefinitely for some data: URL elements and never reach 4, and
      // gating on ">= 4" in that case meant justEnabled never got
      // "consumed" (see the update() loop), so el.currentTime = 0 and
      // el.play() re-fired on literally every frame — heard as the
      // first second of the clip looping rapidly instead of playing
      // through normally.
      el.preload = "auto";
      this._canPlay.set(entityId, false);
      const markReady = () => this._canPlay.set(entityId, true);
      el.addEventListener("canplaythrough", markReady, { once: true });
      // Some browsers never fire canplaythrough for an already-fully-
      // available data: URL (no network activity to signal "through") —
      // loadeddata (readyState >= 2, HAVE_CURRENT_DATA) is a safe
      // fallback for that case specifically, since a data: URL has no
      // streaming/buffering step left once loadeddata fires at all.
      el.addEventListener("loadeddata", markReady, { once: true });
      this._elements.set(entityId, el);
      this._elementKeys.set(entityId, source.audioKey);
      // A brand-new element is always "not yet started" regardless of
      // what autoplay was doing for the PREVIOUS clip on this entity —
      // forget any stale transition state so a same-frame audioKey
      // swap with autoplay already true still triggers a fresh play()
      // instead of being mistaken for "already playing, nothing to do".
      this._prevAutoplay.delete(entityId);
    }

    el.loop = !!source.loop;
    return el;
  }

  /**
   * The Listener is always the scene's Main Camera Transform, same
   * "where the player currently is" reference RenderSystem uses for
   * camera-follow. Explicitly matches Camera.isMain (not just "the
   * first camera entity found") so multi-camera scenes attenuate 3D
   * audio against the actual active camera, not an arbitrary one.
   * Falls back to the first camera, then world origin, if no Main
   * Camera is flagged, so 3D falloff still computes something sane
   * instead of throwing.
   */
  _findListener(world) {
    const cameraEntities = world.query(TRANSFORM, CAMERA);
    if (!cameraEntities.length) return { x: 0, y: 0 };
    const main = cameraEntities.find((e) => e.getComponent(CAMERA).isMain);
    return (main || cameraEntities[0]).getComponent(TRANSFORM);
  }

  /**
   * Stops and releases every live element — called when the game/loop
   * is torn down (e.g. leaving Play mode) so background music doesn't
   * keep playing invisibly after the scene it belongs to is gone.
   */
  destroy() {
    for (const el of this._elements.values()) {
      el.pause();
      el.src = "";
    }
    for (const voices of this._oneShotVoices.values()) {
      for (const v of voices) {
        v.pause();
        v.src = "";
      }
    }
    this._elements.clear();
    this._elementKeys.clear();
    this._prevAutoplay.clear();
    this._canPlay.clear();
    this._lastReplayToken.clear();
    this._oneShotVoices.clear();
    this._pendingAutoplay.clear();
    if (this._gestureHandler) {
      // The listener is attached to the game canvas, which is owned by the
      // host. Keep a reference so teardown can remove it cleanly.
      // `attachInput` stores the target for this purpose.
      if (this._gestureCanvas) {
        this._gestureCanvas.removeEventListener("pointerdown", this._gestureHandler);
        this._gestureCanvas.removeEventListener("touchstart", this._gestureHandler);
      }
      this._gestureHandler = null;
      this._gestureCanvas = null;
    }
  }
}

/**
 * Linear falloff: 1 (full volume) inside minDistance, 0 (silent) at or
 * beyond maxDistance, interpolated linearly in between. Simple and
 * predictable — matches the min/max-distance circles the editor draws
 * in AudioGizmo.js exactly, with no hidden curve to reconcile visually.
 */
function _distanceVolume(listener, transform, source) {
  const dx = transform.x - listener.x;
  const dy = transform.y - listener.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const min = Math.max(0, source.minDistance);
  const max = Math.max(min + 0.001, source.maxDistance);
  if (dist <= min) return 1;
  if (dist >= max) return 0;
  return 1 - (dist - min) / (max - min);
}
