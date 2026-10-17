/**
 * editor/scripting/ScriptSync.js
 *
 * ONE SOURCE OF TRUTH FOR SCRIPT CODE: ScriptStorage (what the script editor
 * shows and edits). Every Script component also carries a COPY of its source
 * (`component.source`) because that copy is what the play runtime compiles.
 * Copies drift: edit a script while another scene is active, import a project
 * whose scenes were saved before an edit, and the copy in the scene data is
 * stale while the editor shows the new code — so Play would run code the
 * editor doesn't show.
 *
 * These helpers re-stamp every copy from ScriptStorage at the points where
 * scene data leaves or enters the editor (Play, Export, Save, Load, Import).
 * A script name with no stored script (deleted) gets "" — same as the editor.
 *
 * EDITOR-ONLY FILE.
 */

import { getScriptSource, scriptExists, saveScript } from "./ScriptStorage.js";

function isScriptComponent(v) {
  return !!v && typeof v === "object" && typeof v.scriptName === "string" && "source" in v;
}

/**
 * Walks serialized scene data (plain JSON) and sets every Script component's
 * `source` from storage. Mutates in place. Returns how many were updated.
 * @param {any} node
 * @param {(name:string)=>string} [lookup]
 */
export function syncScriptSourcesInSceneData(node, lookup) {
  const get = lookup || getScriptSource;
  let count = 0;
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n.Script && isScriptComponent(n.Script)) { n.Script.source = get(n.Script.scriptName) || ""; count++; }
    if (n.type === "Script" && isScriptComponent(n)) { n.source = get(n.scriptName) || ""; count++; }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v && typeof v === "object") walk(v);
    }
  })(node);
  return count;
}

/** @param {Array<{data:any}>} scenes  [{id,name,data}] */
export function syncScriptSourcesInScenes(scenes, lookup) {
  let count = 0;
  for (const s of scenes || []) count += syncScriptSourcesInSceneData(s && s.data, lookup);
  return count;
}

/** Live World: every entity's Script component. */
export function syncScriptSourcesInWorld(world) {
  if (!world) return 0;
  let count = 0;
  for (const e of world.getAllEntities()) {
    const c = e.getComponent("Script");
    if (c && typeof c.scriptName === "string") { c.source = getScriptSource(c.scriptName) || ""; count++; }
  }
  return count;
}

/**
 * LEGACY projects (saved before scripts were stored separately) only have the
 * copies inside the scenes. Adopt those into storage so nothing is lost —
 * call ONLY when the project file has no separate script list at all.
 */
export function seedScriptStorageFromScenes(scenes) {
  let seeded = 0;
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    const c = n.Script && isScriptComponent(n.Script) ? n.Script : (n.type === "Script" && isScriptComponent(n) ? n : null);
    if (c && c.source && !scriptExists(c.scriptName)) { saveScript(c.scriptName, c.source); seeded++; }
    for (const k of Object.keys(n)) { const v = n[k]; if (v && typeof v === "object") walk(v); }
  })((scenes || []).map((s) => s && s.data));
  return seeded;
}
