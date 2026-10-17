/**
 * runtime/scripting/components/SaveAPI.js
 *
 * The `save` global exposed to user scripts (see scripting/ScriptAPI.js
 * getGlobals()). One file per scripting component — see
 * TransformAPI.js's header comment for the general rationale, though
 * `save` isn't a per-entity component like transform/sprite/rigidbody:
 * it's a single global object backed by ONE SaveStore instance shared
 * by every script, the same relationship `global` has to ScriptAPI's
 * `_globals` Map — just persisted to IndexedDB instead of living only
 * in memory for the current session.
 *
 * WHY THIS EXISTS SEPARATELY FROM `global`:
 * `global` (see ScriptAPI.js) is cross-script shared state that lives
 * ONLY as long as the page/tab does — refresh the browser and it's
 * gone. `save` is for the subset of that state a game actually wants
 * to survive a refresh/close/reopen: score, unlocked levels,
 * inventory, settings, "continue where I left off." Keeping them
 * separate means a script never has to guess whether a piece of
 * global state is meant to persist — global.* never does, save.*
 * always does (once flushed).
 *
 * SYNC SURFACE, ASYNC UNDERNEATH:
 * save.get/set/has/delete/keys are all plain synchronous calls — see
 * SaveStore.js's header comment for why (scripts can't await). The
 * ones that talk to a DIFFERENT slot than the one already loaded
 * (save.load, save.deleteSlot, save.listSlots) return a Promise,
 * since switching slots genuinely does need to wait on IndexedDB
 * before save.get() reflects the new slot's data — scripts that care
 * use save.load(name).then(...), the one place this API isn't
 * instant.
 *
 * RUNTIME-ONLY FILE.
 */

const SAVE_MEMBERS = new Set([
  "get", "set", "has", "delete", "keys", "clear",
  "load", "slot", "listSlots", "deleteSlot",
  "flushNow", "onError", "isReady",
]);

/**
 * Builds the `save` object passed into every script as a global (see
 * ScriptAPI.getGlobals()). Thin wrapper around a shared SaveStore
 * instance — this file adds script-safe validation (Proxy + clear
 * errors on typos, same as every other this.<subobject>) and JSDoc a
 * script author actually reads; SaveStore.js owns the real
 * IndexedDB/coalesced-flush mechanics.
 *
 * @param {import('../SaveStore.js').SaveStore} store
 * @returns {object}
 */
export function createSaveAPI(store) {
  const target = {
    /**
     * Reads a value saved under `key` in the CURRENT slot. Returns
     * undefined if it was never set. Instant — reads the in-memory
     * copy, no waiting on IndexedDB.
     *   var hp = save.get("playerHp");
     *   var lives = save.get("lives") ?? 3; // default if never saved
     */
    get: function (key) { return store.get(String(key)); },
    /**
     * Writes `value` under `key` in the CURRENT slot. Takes effect
     * immediately for save.get() (same frame); the write to
     * IndexedDB itself happens in the background a moment later —
     * several save.set() calls in a row are batched into one disk
     * write, not one per call. Any JSON-safe value works: numbers,
     * strings, booleans, arrays, and plain objects (not entities,
     * functions, or class instances — save the plain data your
     * script needs to reconstruct game state, not live objects).
     *   save.set("playerHp", this.hp);
     *   save.set("inventory", ["sword", "shield"]);
     *   save.set("checkpoint", { x: this.x, y: this.y, level: "Cave2" });
     */
    set: function (key, value) { store.set(String(key), value); },
    /**
     * True if `key` has ever been saved in the CURRENT slot.
     *   if (!save.has("tutorialSeen")) { showTutorial(); save.set("tutorialSeen", true); }
     */
    has: function (key) { return store.has(String(key)); },
    /**
     * Removes `key` from the CURRENT slot. Returns true if it existed.
     *   save.delete("temporaryBuff");
     */
    delete: function (key) { return store.delete(String(key)); },
    /**
     * All keys currently saved in this slot, e.g. for building a
     * "continue" screen from whatever the game has stored so far.
     *   var keys = save.keys(); // ["playerHp", "inventory", "checkpoint"]
     */
    keys: function () { return store.keys(); },
    /**
     * Erases EVERY key in the current slot (does not delete the slot
     * itself or touch other slots — use save.deleteSlot(name) for
     * that). Useful for a "reset save" / "new game" button.
     *   save.clear();
     */
    clear: function () { store.clear(); },
    /**
     * True once the current slot's data has finished loading from
     * IndexedDB at least once. This is already true by the time any
     * script's onStart() runs for the game's initial slot — the
     * engine awaits the first load before starting the game loop
     * (see runtime/index.js) — so this is mainly useful after calling
     * save.load() to switch slots mid-game, to know when the new
     * slot's data is actually readable.
     */
    get isReady() { return store._ready; },
    /**
     * Switches to a different save slot by name — e.g. separate save
     * files for "Slot 1"/"Slot 2"/"Slot 3", or an "autosave" slot
     * kept apart from manual saves. Loads that slot's data from
     * IndexedDB (creating it empty if it's never been saved before)
     * and makes it the target of every save.get/set/has/delete/keys/
     * clear call from then on. Returns a Promise — await it (or use
     * .then()) before reading data you expect the new slot to have,
     * since this is the one save.* call that can't be instant:
     *   async function onStart() {
     *     await save.load("slot2");
     *     this.hp = save.get("playerHp") ?? 100;
     *   }
     * The slot that's active when the game first boots is called
     * "default" — you only need save.load() at all if your game
     * offers multiple save files.
     */
    load: function (slotName) { return store.load(String(slotName)); },
    /** Name of the slot save.get/set/etc. currently read and write. Read-only — use save.load(name) to switch. */
    get slot() { return store.slotName; },
    /**
     * Lists every slot name that has EVER been saved for this game
     * (not just the current one) — e.g. to build a save-file picker
     * showing which of "slot1"/"slot2"/"slot3" already have data.
     * Returns a Promise<string[]>.
     *   var slots = await save.listSlots();
     */
    listSlots: function () { return store.listSlots(); },
    /**
     * Permanently deletes a slot and everything saved in it. If it's
     * the slot currently loaded, save.get() immediately starts
     * returning undefined for everything (the in-memory copy is
     * cleared too, not just IndexedDB). Returns a Promise<boolean>.
     *   await save.deleteSlot("slot2");
     */
    deleteSlot: function (slotName) { return store.deleteSlot(String(slotName)); },
    /**
     * Forces any pending save.set()/delete()/clear() writes to finish
     * NOW instead of on the engine's normal short delay, and returns
     * a Promise that resolves once they've actually landed in
     * IndexedDB. Writes already happen automatically in the
     * background — this is only for the rare case a script needs to
     * be SURE data is on disk before doing something else, e.g. right
     * before scene.load() into a level-select/credits scene at the
     * end of a game:
     *   async function onGameComplete() {
     *     save.set("completed", true);
     *     await save.flushNow();
     *     scene.load("Credits");
     *   }
     */
    flushNow: function () { return store.flushNow(); },
    /**
     * Registers a callback for background save errors — e.g.
     * IndexedDB unavailable (private browsing in some browsers) or
     * storage quota exceeded. Scripts never see a thrown exception
     * from save.set() itself (it always updates the in-memory copy
     * instantly and returns), so this is the only way to notice a
     * write didn't actually make it to disk. Only one handler at a
     * time — calling this again replaces the previous one.
     *   save.onError(function (err) {
     *     debug.log("Save error", err.message);
     *   });
     */
    onError: function (callback) { store._onErrorFn = typeof callback === "function" ? callback : null; },
  };

  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !SAVE_MEMBERS.has(String(prop))) {
        throw Object.assign(new Error(
          "save." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(SAVE_MEMBERS).join(", ") + "."
        ), { kind: "unknown-api" });
      }
      const v = t[prop];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop, value) {
      const key = String(prop);
      throw Object.assign(new Error(
        "save." + key + " is read-only — use save.set(key, value) to store data, " +
        "not direct assignment (save.data = ... is not supported)."
      ), { kind: "unknown-api" });
    },
  });
}
