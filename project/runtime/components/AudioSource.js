/**
 * runtime/components/AudioSource.js
 *
 * Audio emitter descriptor, mirroring SpriteRenderer's pattern:
 * `audioKey` is a logical name resolved to a real audio clip by
 * runtime/assets/AssetRegistry.js — this component never holds a raw
 * <audio> element or dataUrl directly, so it stays plain, serializable
 * data (see RULES.txt #4).
 *
 * Two distinct behaviors, chosen with `is3D`:
 *  - 2D (is3D = false): classic background music / UI sound. Plays at
 *    a constant `volume` no matter where the Listener (the scene's
 *    Main Camera) is — it "persists everywhere."
 *  - 3D (is3D = true): positional audio, placed in the world at this
 *    entity's Transform. Full volume inside `minDistance` of the
 *    Listener, fading out linearly to silence at `maxDistance` —
 *    exactly like a sound effect in a 3D/2D game world. The editor
 *    draws `minDistance`/`maxDistance` as concentric circles (see
 *    editor/viewport/AudioGizmo.js) so this falloff is directly
 *    visible and draggable-adjacent, same spirit as a Light's radius
 *    gizmo.
 *
 * Actually playing/positioning audio is runtime/systems/AudioSystem.js's
 * job — this file is PLAIN DATA ONLY.
 *
 * RUNTIME-ONLY FILE.
 */

export const AUDIO_SOURCE = "AudioSource";

export class AudioSource {
  constructor({
    audioKey = null,
    is3D = false,
    volume = 1,
    pitch = 1,
    loop = true,
    autoplay = true,
    minDistance = 100,
    maxDistance = 600,
  } = {}) {
    this.audioKey = audioKey;

    // false = 2D (global, distance-independent — background music/UI).
    // true  = 3D (positional, fades out with distance from the Listener).
    this.is3D = is3D;

    // 0-1 base volume BEFORE any 3D distance falloff is applied.
    this.volume = volume;

    // Playback rate / pitch multiplier. 1 = normal speed/pitch, 2 =
    // one octave up (double speed), 0.5 = one octave down (half speed)
    // — maps directly onto HTMLAudioElement.playbackRate (see
    // AudioSystem.js), the same way Unity's AudioSource.pitch scales
    // both speed and perceived pitch together (there's no separate
    // time-stretching in either engine — changing pitch changes speed
    // too, exactly like a record player).
    this.pitch = pitch;

    this.loop = loop;

    // Starts playing automatically as soon as Play mode/the exported
    // game boots, matching Unity's AudioSource "Play On Awake".
    this.autoplay = autoplay;

    // 3D only: inside this radius (world units/px) from the Listener,
    // the clip plays at full `volume` with zero falloff.
    this.minDistance = minDistance;

    // 3D only: beyond this radius from the Listener, the clip is
    // completely silent. Between minDistance and maxDistance, volume
    // falls off linearly — see AudioSystem.js's _distanceVolume().
    this.maxDistance = maxDistance;

    // Runtime-only, never serialized (see SceneSerializer.js, which
    // only persists the constructor fields above): bumped by
    // this.audio.playOnce() (see scripting/components/AudioAPI.js) to
    // request a fresh one-shot play independent of `autoplay`. Unlike
    // `autoplay`, which AudioSystem only reacts to on a false->true
    // TRANSITION (so calling play() again while already true is a
    // no-op — see AudioSystem.js's justEnabled comment), every
    // increment of this counter is its own distinct "play now" request,
    // so playOnce() replays correctly even if called again before the
    // previous shot finished (e.g. rapid bounces triggering onCollisionEnter
    // back to back).
    this._replayToken = 0;
  }
}
