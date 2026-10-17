/**
 * editor/export/UsedAssets.js
 *
 * Figures out which sprite/frame/audio asset KEYS are actually
 * referenced anywhere in the project, so ExportGame.js can leave every
 * unreferenced asset out of an exported build entirely (the user asked
 * for exports to "not include assets that were never used").
 *
 * Every place a component points at an imported asset does so with a
 * plain string key (SpriteRenderer.spriteKey, AudioSource.audioKey,
 * SpriteAnimation clip frames' spriteKey, Tileset's 16 role slots,
 * TilemapSystem tile entries, etc — see runtime/components/*.js, all
 * "RUNTIME-ONLY FILE" plain-data classes). Rather than hard-coding a
 * field name per component type (fragile — a new component with a new
 * asset-reference field would silently be missed), this does a plain
 * deep-JSON-string scan of every scene + every prefab for any string
 * value that EXACTLY matches a real, currently-registered asset key.
 * False positives are structurally impossible there (a scene/prefab
 * string field would have to exactly equal a real "sprite_7_player"
 * style key by coincidence), and a false negative would only happen if
 * some future component encoded a key inside a larger string rather
 * than storing it verbatim — not how any current component does it
 * (confirmed by grep across runtime/components/).
 *
 * One place genuinely needs SUBSTRING matching instead: script source.
 * A script can reassign `this.sprite.texture` or play a clip by key at
 * runtime (e.g. `this.sprite.texture = "sprite_5_coin"`), and that key
 * only ever appears embedded inside a quoted literal in the script's
 * source text — never as a whole scene/prefab JSON string value. See
 * scanScriptSourcesForKeys() below. This can produce a rare false
 * positive (a key that happens to appear as a substring of some other
 * string in a script, e.g. inside a comment or an unrelated string
 * literal) — acceptable, since the cost of a false positive is just
 * "one extra asset gets kept," never a broken export, whereas a false
 * negative would silently ship a broken game.
 *
 * EDITOR-ONLY FILE.
 */

/**
 * Walks `value` recursively, calling `visit(str)` for every string it
 * finds (object values, array entries — not object KEYS, since no
 * component stores an assetKey as a JSON key name).
 * @param {*} value
 * @param {(s: string) => void} visit
 */
function walkStrings(value, visit) {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) walkStrings(value[key], visit);
  }
}

/**
 * @param {string[]} allScriptSources every script's raw source text
 * @param {Set<string>} allSpriteKeys
 * @param {Set<string>} allAudioKeys
 * @param {Set<string>} usedSpriteKeys mutated in place
 * @param {Set<string>} usedAudioKeys mutated in place
 */
function scanScriptSourcesForKeys(allScriptSources, allSpriteKeys, allAudioKeys, usedSpriteKeys, usedAudioKeys) {
  if (!allScriptSources.length) return;
  const combined = allScriptSources.join("\n");
  for (const key of allSpriteKeys) {
    if (!usedSpriteKeys.has(key) && combined.includes(key)) usedSpriteKeys.add(key);
  }
  for (const key of allAudioKeys) {
    if (!usedAudioKeys.has(key) && combined.includes(key)) usedAudioKeys.add(key);
  }
}

/**
 * @param {ReturnType<import('../../runtime/index.js').createGame>} game
 * @param {string[]} [allScriptSources] every script's raw source text
 *   (see scripting/ScriptStorage.js's getAllScripts()/getScriptSource())
 *   — optional so callers that only care about scene/prefab references
 *   can skip passing it, but ExportGame.js always does (see this file's
 *   header for why script-referenced keys must count as used).
 * @returns {{ usedSpriteKeys: Set<string>, usedAudioKeys: Set<string> }}
 */
export function findUsedAssetKeys(game, allScriptSources) {
  const allSpriteKeys = new Set([
    ...game.getAllSpriteAssets().map((r) => r.key),
    ...game.getAllFrameAssets().map((r) => r.key),
  ]);
  const allAudioKeys = new Set(game.getAllAudioAssets().map((r) => r.key));

  const usedSpriteKeys = new Set();
  const usedAudioKeys = new Set();

  const visit = (str) => {
    // A key can only ever be used as a COMPLETE string value in scene/
    // prefab data (every component field holds the key verbatim, never
    // as a substring — see file header), so exact Set membership is
    // correct and cheap here; script source needs the separate
    // substring pass above instead.
    if (allSpriteKeys.has(str)) usedSpriteKeys.add(str);
    if (allAudioKeys.has(str)) usedAudioKeys.add(str);
  };

  // Every scene — not just the active one, since scene.load('Name')
  // can jump to any scene at runtime and an exported build ships all
  // of them (see ExportGame.js).
  for (const scene of game.getAllScenesData()) {
    walkStrings(scene.data, visit);
  }

  // Prefabs can be instantiated by scripts at runtime
  // (prefab.instantiate(...)) without ever appearing pre-placed in any
  // scene, so their own asset references must count as "used" too.
  for (const prefab of game.getAllPrefabs()) {
    walkStrings(prefab, visit);
  }

  if (allScriptSources && allScriptSources.length) {
    scanScriptSourcesForKeys(allScriptSources, allSpriteKeys, allAudioKeys, usedSpriteKeys, usedAudioKeys);
  }

  return { usedSpriteKeys, usedAudioKeys };
}
