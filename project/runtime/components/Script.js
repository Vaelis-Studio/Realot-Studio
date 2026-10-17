/**
 * runtime/components/Script.js
 *
 * Attaches a user-written JavaScript script to an entity. The source
 * code is stored directly on the component so it serializes with the
 * scene and is available in the play-mode popup without needing a
 * separate asset pipeline. Multiple entities can share the same
 * scriptName — each gets its own independent instance at runtime.
 *
 * Scripts are NEVER compiled or executed in the editor — only in the
 * play-mode popup via ScriptSystem (see systems/ScriptSystem.js).
 *
 * RUNTIME-ONLY FILE.
 */

export const SCRIPT = "Script";

export class Script {
  constructor({ scriptName = "NewScript", source = "", enabled = true } = {}) {
    /** Display name shown in the Inspector + script editor tabs. */
    this.scriptName = scriptName;
    /** Full JavaScript source — compiled at runtime via new Function(). */
    this.source = source;
    /** Whether this script instance runs at play time. */
    this.enabled = enabled;
  }
}
