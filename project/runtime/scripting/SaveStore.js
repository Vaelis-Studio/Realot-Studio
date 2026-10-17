/**
 * runtime/scripting/SaveStore.js
 *
 * IndexedDB-backed persistence engine behind the `save` scripting
 * global (see components/SaveAPI.js for the script-facing surface).
 * This file owns the actual browser storage; SaveAPI.js owns the
 * this-facing/global-facing shape and validation scripts see.
 *
 * DESIGN — SYNC READS, ASYNC PERSISTENCE:
 * Scripts run synchronously (see RULES.txt / ScriptAPI.js header — no
 * await inside onUpdate etc.), so save.get()/save.has() must return
 * an answer immediately, not a Promise. SaveStore solves this the
 * same way ScriptAPI's `global` does for cross-script state: it keeps
 * a live in-memory Map as the source of truth for reads, and mirrors
 * every write out to IndexedDB in the background. On boot it loads
 * the whole slot's IndexedDB contents into that Map ONCE, before the
 * game starts running scripts (see load() below and its caller in
 * runtime/index.js) — so by the time any script's onStart() fires,
 * save.get() already reflects whatever was persisted last session.
 *
 * SLOTS:
 * A "slot" is one named save game (e.g. "slot1", "autosave",
 * "default"). Each slot is a separate IndexedDB record, so a game can
 * offer multiple independent save files without them clobbering each
 * other. Slots are namespaced under a per-game database (see gameId
 * below) so two different Realot games open in the same browser
 * never see each other's saves.
 *
 * ONE DATABASE PER GAME:
 * The IndexedDB database name is derived from the `gameId` passed to
 * createGame({ gameId }) in runtime/index.js — defaults to the legacy
 * "realot-
 * default" if the host page never sets one (e.g. the editor's Play
 * popup, which has no meaningful "shipped game" identity). Exported
 * standalone games (see /player) should pass a stable, unique gameId
 * so their save data doesn't collide with any other Realot game
 * the same browser has visited.
 *
 * RUNTIME-ONLY FILE. No DOM assumptions beyond `indexedDB` itself
 * (available in every browser context, including the Play popup and
 * the standalone player).
 */

const DB_VERSION = 1;
const STORE_NAME = "slots";

function _dbName(gameId) {
  // Keep this legacy namespace so existing Realot projects retain their saves
  // after the identity rename.
  return "realot-save::" + (gameId || "default");
}

/** Opens (creating if needed) the per-game IndexedDB database. */
function _openDb(gameId) {
  return new Promise(function (resolve, reject) {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment."));
      return;
    }
    const req = indexedDB.open(_dbName(gameId), DB_VERSION);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error("Failed to open save database.")); };
  });
}

/**
 * Backs the `save` scripting global. One instance per running game
 * (created in runtime/index.js alongside ScriptAPI). Holds the
 * CURRENT slot's data as a plain object in memory (`this._data`) for
 * instant sync reads/writes, and persists that object to IndexedDB
 * as a single record per slot — writing the whole slot object on
 * every change is simpler and plenty fast for save-game-sized data
 * (score, inventory, level progress, settings — not megabytes of
 * blobs); scripts that need to store something huge should keep it
 * out of `save` and manage it themselves.
 */
export class SaveStore {
  constructor(gameId) {
    this.gameId = gameId || "default";
    this.slotName = "default";
    /** @type {Object<string, any>} live in-memory data for the current slot */
    this._data = {};
    /** True once load() has completed for the current slot at least once. */
    this._ready = false;
    /** @type {Promise<IDBDatabase>|null} cached open-database promise */
    this._dbPromise = null;
    /** Pending write, coalesced so rapid save.set() calls in the same
     *  frame don't queue up a flush per call — see _scheduleFlush(). */
    this._flushTimer = null;
    /** Set by scripts via save.onError(fn) — called with (error) if a
     *  background IndexedDB read/write ever fails, since scripts have
     *  no other way to observe an async failure from a sync API. */
    this._onErrorFn = null;
  }

  _db() {
    if (!this._dbPromise) this._dbPromise = _openDb(this.gameId);
    return this._dbPromise;
  }

  _reportError(err) {
    if (this._onErrorFn) {
      try { this._onErrorFn(err); } catch (e) { /* never let a bad handler break the store */ }
    } else if (typeof console !== "undefined") {
      console.error("[save]", err);
    }
  }

  /**
   * Loads a slot's data from IndexedDB into memory. Called once at
   * game boot (runtime/index.js, before the game loop starts) for the
   * default slot, and again any time a script calls save.load(name)
   * to switch slots. Resolves once `_data` reflects IndexedDB (or an
   * empty object, for a slot that's never been saved before).
   */
  async load(slotName) {
    // Flush any write still pending for the CURRENT slot before we
    // switch — _flush() reads this.slotName at flush time (not at
    // schedule time), so if we changed slotName first, a pending
    // timer would fire later and write the old slot's data under the
    // new slot's name instead. Only do this when a write is actually
    // pending: the very first load("default") at boot has nothing
    // scheduled, and flushing an empty snapshot then would overwrite
    // real saved data before we've even read it.
    if (this._flushTimer !== null) {
      await this.flushNow();
    }

    this.slotName = slotName || "default";
    try {
      const db = await this._db();
      const data = await new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(this.slotName);
        req.onsuccess = function () { resolve(req.result || {}); };
        req.onerror = function () { reject(req.error || new Error("Failed to read save slot.")); };
      }.bind(this));
      this._data = data && typeof data === "object" ? data : {};
      this._ready = true;
      return true;
    } catch (err) {
      this._data = {};
      this._ready = true;
      this._reportError(err);
      return false;
    }
  }

  /** Coalesces writes: many save.set() calls in the same frame/tick
   *  result in ONE IndexedDB write, on the next microtask/timer tick,
   *  instead of one write per call. */
  _scheduleFlush() {
    if (this._flushTimer !== null) return;
    const self = this;
    this._flushTimer = setTimeout(function () {
      self._flushTimer = null;
      self._flush();
    }, 0);
  }

  async _flush() {
    const slotName = this.slotName;
    // Snapshot now — if the slot changes again before the write lands,
    // we still write what was true for THIS slot at flush time.
    const snapshot = Object.assign({}, this._data);
    try {
      const db = await this._db();
      await new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(snapshot, slotName);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error("Failed to write save slot.")); };
      });
    } catch (err) {
      this._reportError(err);
    }
  }

  /** Forces any pending write to happen immediately and returns a
   *  Promise that resolves once it's actually landed in IndexedDB —
   *  used by save.flushNow() for "save right before the tab closes"
   *  style calls. */
  async flushNow() {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    await this._flush();
  }

  get(key) {
    return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : undefined;
  }

  set(key, value) {
    this._data[key] = value;
    this._scheduleFlush();
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this._data, key);
  }

  delete(key) {
    const existed = Object.prototype.hasOwnProperty.call(this._data, key);
    if (existed) {
      delete this._data[key];
      this._scheduleFlush();
    }
    return existed;
  }

  keys() {
    return Object.keys(this._data);
  }

  clear() {
    this._data = {};
    this._scheduleFlush();
  }

  /** Lists every slot name that has ever been saved for this game. */
  async listSlots() {
    try {
      const db = await this._db();
      return await new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).getAllKeys();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error || new Error("Failed to list save slots.")); };
      });
    } catch (err) {
      this._reportError(err);
      return [];
    }
  }

  /** Deletes an entire slot from IndexedDB. If it's the currently
   *  loaded slot, also clears the in-memory copy. */
  async deleteSlot(slotName) {
    try {
      const db = await this._db();
      await new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(slotName);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error("Failed to delete save slot.")); };
      });
      if (slotName === this.slotName) this._data = {};
      return true;
    } catch (err) {
      this._reportError(err);
      return false;
    }
  }
}
