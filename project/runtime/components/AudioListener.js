/**
 * runtime/components/AudioListener.js
 *
 * "Ear" component — gives an entity the ability to hear 3D AudioSources
 * within a radius, independent of the scene's Main Camera (which is a
 * SEPARATE, always-on listener used only for volume falloff — see
 * AudioSource.js / AudioSystem.js). This component does not play or
 * attenuate anything; it is a pure DETECTOR, used by
 * AudioListenerSystem.js to answer "which 3D sounds are in range of
 * THIS entity right now" and to fire onHearSound/onLoseSound in
 * scripts (see scripting/components/AudioListenerAPI.js and
 * ScriptSystem.js's fireHearSound/fireLoseSound).
 *
 * Only ever detects AudioSource entities with is3D = true — a 2D
 * AudioSource (background music/UI) has no world position to be
 * "heard" at, so it's always excluded regardless of radius (see
 * AudioListenerSystem.js's _update()).
 *
 * PLAIN DATA ONLY — mirrors every other components/*.js file (see
 * RULES.txt #4). Detection/callback logic lives in
 * runtime/systems/AudioListenerSystem.js.
 *
 * RUNTIME-ONLY FILE.
 */

export const AUDIO_LISTENER = "AudioListener";

export class AudioListener {
  constructor({ radius = 300, enabled = true } = {}) {
    // World-unit radius of the hearing circle, centered on this
    // entity's Transform. Any 3D AudioSource whose Transform falls
    // within this radius counts as "heard" — see AudioListenerSystem's
    // _isInRange(), which uses plain circle-vs-point distance (no
    // falloff curve; this is a boolean detector, not a volume system).
    this.radius = radius;

    // Lets a script/Inspector toggle detection off without removing
    // the component — mirrors Script.enabled's convention.
    this.enabled = enabled;
  }
}
