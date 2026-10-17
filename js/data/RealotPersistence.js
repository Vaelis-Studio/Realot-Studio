/**
 * js/data/RealotPersistence.js
 *
 * Shared, tiered key/value persistence used by BOTH the launcher
 * (js/data/store.js, plain <script>) and the editor
 * (editor/state/ProjectStorage.js, ES module, loaded as a plain
 * <script> too — see project/editor/index.html) so a project created/
 * listed in the launcher and a project loaded/autosaved in the editor
 * are reading and writing the exact same underlying storage.
 *
 * Not a module on purpose: the launcher's own js/ tree is plain
 * classic <script> tags (no bundler, no <script type="module">), so
 * this has to be loadable the same way and still be reachable from the
 * editor's ES modules as a shared global (window.RealotPersistence).
 *
 * TIERING STRATEGY (why THREE stores, not one):
 *   - localStorage is synchronous and simple, but small (~5-10MB total
 *     per origin) and shared with every other localStorage user on the
 *     page (ScriptStorage.js, PhysicsLayers.js, etc). Good for small
 *     values: manifests, scene graphs, script source, layer/tag lists.
 *   - IndexedDB has effectively no practical size ceiling on a typical
 *     desktop browser (hundreds of MB to GB) and is the right home for
 *     large values: sprite/audio assets, which are base64 dataUrls and
 *     can individually be multiple MB each. HOWEVER — this is the
 *     important bit that motivated the third tier below — IndexedDB is
 *     NOT actually unlimited: Chrome caps it at a percentage of the
 *     device's free disk space, AND (critically for managed/school
 *     Chromebooks) enterprise policy can cap or clear it far below
 *     what the hardware alone would allow. See ProjectStorage.js's
 *     autosave-failure-warning comment for the user-facing symptom
 *     this produces once a project outgrows that quota.
 *   - File System Access API (FSA) is the one tier that is NOT bound
 *     by the origin's storage quota at all — see fsaMirror below.
 *     Cache Storage and OPFS were deliberately NOT added as additional
 *     tiers: in Chromium both share the SAME origin storage quota
 *     bucket that IndexedDB already uses, so they cannot give a
 *     quota-restricted device any more actual space — they'd only add
 *     real implementation complexity (Cache Storage expects
 *     Request/Response pairs, not arbitrary JSON; OPFS needs a worker
 *     for its synchronous handle API) for zero space benefit over what
 *     IndexedDB already provides. FSA is the only one of the five
 *     storages commonly discussed for this that is genuinely different
 *     from the other two, because it writes to a real file the user
 *     picked, outside the browser's per-origin sandbox entirely.
 *   - Per key, this module tries localStorage FIRST (fast, sync-
 *     feeling). If the value is large enough that it would risk
 *     blowing the localStorage quota (see LARGE_VALUE_THRESHOLD), or a
 *     localStorage write actually throws QuotaExceededError, it falls
 *     back to IndexedDB automatically and removes any stale
 *     localStorage copy of that key. If FSA has been set up (see
 *     fsaMirror below), every write is ALSO mirrored to the granted
 *     directory in the background, regardless of which of the first
 *     two tiers it landed in — that mirror write never blocks or can
 *     fail the overall setItem() result, since FSA support/permission
 *     is optional and best-effort by nature. Reads check localStorage
 *     first, then IndexedDB (never FSA — see fsaMirror's doc comment
 *     for why), so callers never need to know which tier a given key
 *     ended up in.
 *
 * All values are stored as JSON-serializable data; this module handles
 * JSON.stringify/parse internally so callers just pass/receive plain
 * objects.
 */
(function (root) {
  "use strict";

  const DB_NAME = "realot_projects_db";
  const DB_VERSION = 2;
  const STORE_NAME = "kv";
  // Separate object store (not reused from STORE_NAME) purely so a
  // FileSystemDirectoryHandle never gets mixed up with ordinary
  // string-keyed project JSON in listKeys()/getItem() enumeration —
  // it's read/written only by the FSA-specific functions below. Keyed
  // by projectId (one row per project that has ever enabled backup),
  // NOT a single fixed key — see the FSA section's doc comment for why
  // each project needs its own independent folder.
  const FSA_HANDLE_STORE = "fsa_handle";

  // Any single value at or above this size (in UTF-16 code units, i.e.
  // roughly the same as the string's .length) skips localStorage
  // entirely and goes straight to IndexedDB. localStorage's total
  // per-origin quota is only ~5-10MB shared across every key any
  // script on the page uses, so reserving it for genuinely small
  // values (not sprite/audio dataUrls) keeps it from filling up and
  // breaking unrelated small writes (ScriptStorage.js, PhysicsLayers,
  // etc all share the same quota).
  const LARGE_VALUE_THRESHOLD = 250 * 1024; // 250KB

  /** @type {IDBDatabase|null} cached open connection */
  let _dbPromise = null;

  function _openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        // Added in DB_VERSION 2 alongside FSA support below — a
        // browser that already had version-1 realot_projects_db
        // from before this feature existed gets this store added on
        // next open via the normal IDB upgrade path, no migration of
        // existing data needed since it's a brand new, independent
        // store.
        if (!db.objectStoreNames.contains(FSA_HANDLE_STORE)) {
          db.createObjectStore(FSA_HANDLE_STORE);
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error || new Error("Failed to open IndexedDB"));
      };
    }).catch((err) => {
      // Don't cache a rejected promise forever — a later call might
      // succeed once (e.g.) a sandboxed-iframe restriction lifts.
      _dbPromise = null;
      throw err;
    });
    return _dbPromise;
  }

  function _idbGet(key) {
    return _openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          try {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
            req.onerror = () => reject(req.error || new Error("IndexedDB read failed"));
          } catch (err) {
            reject(err);
          }
        })
    );
  }

  function _idbSet(key, value) {
    return _openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          try {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            store.put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed"));
          } catch (err) {
            reject(err);
          }
        })
    );
  }

  function _idbDelete(key) {
    return _openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          try {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            store.delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error("IndexedDB delete failed"));
          } catch (err) {
            reject(err);
          }
        })
    );
  }

  /** Every key this module has ever put in IndexedDB, cached in memory
   *  per page load, so `has()`/`remove()` don't need a round trip just
   *  to know whether to also check the IDB tier. Rebuilt lazily by
   *  scanning localStorage's own "which keys spilled to IDB" index. */
  const IDB_INDEX_KEY = "__realot_idb_index__";

  function _readIdbIndex() {
    try {
      const raw = localStorage.getItem(IDB_INDEX_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (_) {}
    return new Set();
  }

  function _writeIdbIndex(set) {
    try {
      localStorage.setItem(IDB_INDEX_KEY, JSON.stringify(Array.from(set)));
    } catch (_) {
      // Index is an optimization only (see getTier's fallback probe
      // below) — losing it just means a slightly slower read path,
      // never data loss.
    }
  }

  function _markInIdb(key) {
    const set = _readIdbIndex();
    if (!set.has(key)) {
      set.add(key);
      _writeIdbIndex(set);
    }
  }

  function _unmarkInIdb(key) {
    const set = _readIdbIndex();
    if (set.has(key)) {
      set.delete(key);
      _writeIdbIndex(set);
    }
  }

  /**
   * Writes a value, choosing the tier automatically. Always resolves
   * (never rejects) — a value that can't be persisted anywhere still
   * lets the caller keep working in-memory for the rest of the tab's
   * life; callers that care can check the resolved `{ok}` flag.
   * @param {string} key
   * @param {*} value JSON-serializable
   * @returns {Promise<{ok:boolean, tier:'local'|'idb'|'none'}>}
   */
  function setItem(key, value) {
    let json;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      return Promise.resolve({ ok: false, tier: "none", error: err });
    }

    // Fire-and-forget: mirrors to the FSA backup directory (if one has
    // been granted — see the FSA section above) in the background,
    // regardless of which tier below this succeeds or fails. Never
    // awaited — a slow or failed disk write out on a real filesystem
    // must not delay or affect the primary localStorage/IndexedDB
    // save this function's caller is actually waiting on.
    _fsaMirror(key, json);

    const tooLargeForLocal = json.length >= LARGE_VALUE_THRESHOLD;

    if (!tooLargeForLocal) {
      try {
        localStorage.setItem(key, json);
        // A key that previously spilled to IDB but now fits locally
        // again (e.g. project shrank) shouldn't leave a stale bigger
        // copy sitting in IndexedDB forever.
        _unmarkInIdb(key);
        _idbDelete(key).catch(() => {});
        return Promise.resolve({ ok: true, tier: "local" });
      } catch (err) {
        // QuotaExceededError (or any other localStorage failure,
        // including SecurityError in sandboxed iframes) — fall
        // through to IndexedDB below rather than losing the write.
      }
    }

    return _idbSet(key, json)
      .then(() => {
        _markInIdb(key);
        // Remove any localStorage remnant of this key so reads don't
        // find a truncated/half-written copy there instead.
        try {
          localStorage.removeItem(key);
        } catch (_) {}
        return { ok: true, tier: "idb" };
      })
      .catch((err) => ({ ok: false, tier: "none", error: err }));
  }

  /**
   * Synchronous, best-effort, localStorage-ONLY write — deliberately
   * skips the IndexedDB tier and the FSA mirror that setItem() above
   * uses. Exists for exactly one caller: ProjectStorage.js's exit-time
   * save (pagehide/beforeunload — see startAutosave's doc comment),
   * where setItem()'s normal async IndexedDB write is a real data-loss
   * risk: `beforeunload`/`pagehide` handlers are NOT awaited by the
   * browser, so a page can finish tearing down mid-write on a large
   * project that spills to IndexedDB, silently losing however much of
   * the last edit session hadn't been autosaved yet at the moment of
   * the interval tick before this one. A plain synchronous
   * localStorage.setItem() call, by contrast, is guaranteed to either
   * complete or throw before this function returns — nothing async for
   * the browser to abandon.
   *
   * This is a SAFETY NET, not a tier upgrade: it's only ever attempted
   * as a courtesy write, in addition to (not instead of) the normal
   * setItem() call the same exit handler already makes. If the value is
   * too large for localStorage (see LARGE_VALUE_THRESHOLD) or the write
   * throws (QuotaExceededError, blocked storage), this simply reports
   * {ok:false} — the project isn't left any worse off than it already
   * was before this function existed, since setItem()'s own IndexedDB
   * attempt is still running independently and may still land.
   *
   * getItem() already checks localStorage before IndexedDB, so if this
   * write succeeds it's picked up correctly on the next load even if
   * the parallel IndexedDB write from the SAME exit never completed —
   * whichever tier actually finished wins, and localStorage is the tier
   * most likely to.
   *
   * @param {string} key
   * @param {*} value JSON-serializable
   * @returns {{ok:boolean, tier:'local'|'none'}}
   */
  function setItemSync(key, value) {
    let json;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      return { ok: false, tier: "none", error: err };
    }
    if (json.length >= LARGE_VALUE_THRESHOLD) {
      // Too big for a safe synchronous localStorage write — the async
      // setItem() call this function's caller also makes is this key's
      // only real path to persistence in that case; nothing more to do
      // here without risking throwing QuotaExceededError anyway.
      return { ok: false, tier: "none" };
    }
    try {
      localStorage.setItem(key, json);
      return { ok: true, tier: "local" };
    } catch (err) {
      return { ok: false, tier: "none", error: err };
    }
  }

  /**
   * Reads a value back, checking localStorage first, then IndexedDB.
   * @param {string} key
   * @returns {Promise<*>} the parsed value, or null if not found
   */
  function getItem(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        try {
          return Promise.resolve(JSON.parse(raw));
        } catch (_) {
          // Corrupt local copy — fall through and try IDB instead of
          // failing outright.
        }
      }
    } catch (_) {
      // localStorage unavailable — fall through to IDB.
    }

    return _idbGet(key)
      .then((raw) => {
        if (raw === null || raw === undefined) return null;
        try {
          return JSON.parse(raw);
        } catch (_) {
          return null;
        }
      })
      .catch(() => null);
  }

  /** Deletes a key from BOTH tiers (whichever it's actually in). */
  function removeItem(key) {
    try {
      localStorage.removeItem(key);
    } catch (_) {}
    _unmarkInIdb(key);
    return _idbDelete(key).catch(() => {});
  }

  /**
   * FILE SYSTEM ACCESS API (FSA) — the third, OPTIONAL storage tier.
   *
   * WHY THIS IS SEPARATE FROM THE localStorage/IndexedDB TIERING
   * ABOVE, NOT A THIRD RUNG IN THE SAME FALLBACK CHAIN: FSA cannot be
   * used as a normal read/write tier the way IndexedDB is, because of
   * two hard platform constraints that have nothing to do with this
   * codebase:
   *   1. Getting the INITIAL directory handle requires a real user
   *      gesture (a click) — showDirectoryPicker() throws
   *      SecurityError if called from a background timer/interval
   *      with no click in progress. That's why setup is its own
   *      explicit enableFsaBackup() call below, wired to a real button
   *      in the editor (see main.js), not something autosave can just
   *      start doing on its own the first time it runs.
   *   2. Even after the user grants it once, browsers only persist
   *      that permission grant for the current TAB/SESSION in most
   *      cases — a full page reload commonly needs the permission
   *      re-confirmed via queryPermission()/requestPermission(), and
   *      requestPermission() ALSO requires a user gesture the same as
   *      the initial picker. This module cannot silently re-arm it on
   *      boot.
   * Given both of those, FSA is used here as a best-effort MIRROR: once
   * set up, every setItem() ALSO writes the same JSON to a file in the
   * granted directory, purely as a bonus backup that lives outside the
   * origin's storage quota entirely (see the file header's TIERING
   * STRATEGY comment for why that's the one thing FSA offers that
   * IndexedDB/Cache Storage/OPFS cannot). It is never read from by
   * getItem() — localStorage/IndexedDB remain the sole source of truth
   * for what the app actually loads, so a mid-session permission
   * revocation or a tab where FSA was never set up just silently loses
   * the extra backup copy, never the app's actual data. Reading FROM
   * the FSA directory is a manual, explicit action (see
   * restoreFromFsaBackup below) — a deliberate "browse my backups"
   * action, not something that happens implicitly.
   */

  /** @type {Map<string, FileSystemDirectoryHandle>} in-memory cache of
   *  granted handles for this tab's lifetime, keyed by projectId, so
   *  repeated setItem() calls for the same project don't need to hit
   *  IndexedDB just to re-fetch the handle every time. A project whose
   *  handle fails its permission check is left out of this cache (not
   *  poisoned with a null) so the next write attempt re-checks fresh
   *  rather than being stuck assuming failure forever. */
  const _fsaHandleCache = new Map();

  /**
   * showDirectoryPicker()'s `id` option is capped by the browser at 32
   * characters (it's just a key the browser uses to remember the
   * last-used directory for a given "named" picker — see
   * https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker).
   * Project ids look like "proj-1787186660700-at3h1" (~24 chars), and
   * prefixing that with "realot-backups-" (15 chars) blows well past
   * the limit — showDirectoryPicker() then throws synchronously
   * ("ID '...' cannot be longer than 32 characters") before the picker
   * ever opens, which enableFsaBackup()'s try/catch below reports as a
   * clean {ok:false}, but the user never actually gets a folder picker
   * at all.
   *
   * Hashes projectId down to a short, deterministic, fixed-length tag
   * instead of using it verbatim, so the id stays STABLE across reloads
   * (same projectId always produces the same tag, which is what makes
   * the browser remember/reuse the same directory for this project —
   * see enableFsaBackup's own doc comment above) while always fitting
   * under the cap regardless of how long projectId itself happens to
   * be. Not cryptographic — collision resistance just needs to be good
   * enough that two different projects picking the same backup folder
   * is very unlikely, not impossible.
   * @param {string} projectId
   * @returns {string} a picker id, always <= 32 characters
   */
  function _fsaPickerId(projectId) {
    var hash = 0;
    for (var i = 0; i < projectId.length; i++) {
      hash = (hash * 31 + projectId.charCodeAt(i)) | 0; // |0 keeps it a 32-bit int, matches Java/Kotlin String.hashCode()-style rolling hash
    }
    var tag = Math.abs(hash).toString(36); // base36 keeps it short (max 7 chars for a 32-bit int)
    return "realot-bak-" + tag; // 8 + up to 7 = max 15 chars, comfortably under the 32-char cap
  }

  function _fsaSupported() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
  }

  /** FSA_HANDLE_STORE is keyed by projectId (not a single fixed key)
   *  — see this section's doc comment above for why per-project
   *  folders matter: without this, enabling backup once would silently
   *  mirror EVERY project this browser ever opens into the same
   *  folder, overwriting/mixing snapshot files from unrelated
   *  projects with no warning. */
  function _fsaStoreHandle(projectId, handle) {
    return _openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          try {
            const tx = db.transaction(FSA_HANDLE_STORE, "readwrite");
            tx.objectStore(FSA_HANDLE_STORE).put(handle, projectId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error("Failed to store FSA handle"));
          } catch (err) {
            reject(err);
          }
        })
    );
  }

  function _fsaLoadStoredHandle(projectId) {
    return _openDb().then(
      (db) =>
        new Promise((resolve) => {
          try {
            const tx = db.transaction(FSA_HANDLE_STORE, "readonly");
            const req = tx.objectStore(FSA_HANDLE_STORE).get(projectId);
            req.onsuccess = () => resolve(req.result || null);
            // A read failure here just means "no backup dir yet" from
            // the caller's point of view — never worth rejecting over.
            req.onerror = () => resolve(null);
          } catch (_) {
            resolve(null);
          }
        })
    ).catch(() => null);
  }

  /**
   * Removes a project's granted FSA backup handle (if any) from both
   * the in-memory cache and IndexedDB's FSA_HANDLE_STORE. THIS IS THE
   * PIECE deleteProject() in js/data/store.js was missing: that
   * function already removes the project's SNAPSHOT (via removeItem())
   * on delete, but removeItem() only ever touches STORE_NAME/
   * localStorage — FSA_HANDLE_STORE is a deliberately separate object
   * store (see its own doc comment above) keyed by projectId, not by
   * any snapshot key, so a plain removeItem(snapshotKey) can never
   * reach it. Without this, deleting a project in the launcher left its
   * granted directory handle sitting in IndexedDB forever — invisible,
   * un-freed storage that accumulates one stale row per deleted project
   * that ever had backups enabled, for the lifetime of the browser
   * profile.
   * @param {string} projectId
   * @returns {Promise<void>}
   */
  function _fsaRemoveHandle(projectId) {
    _fsaHandleCache.delete(projectId);
    return _openDb().then(
      (db) =>
        new Promise((resolve) => {
          try {
            const tx = db.transaction(FSA_HANDLE_STORE, "readwrite");
            tx.objectStore(FSA_HANDLE_STORE).delete(projectId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve(); // best-effort — never block the caller's delete over this
          } catch (_) {
            resolve();
          }
        })
    ).catch(() => {});
  }

  /**
   * MUST be called synchronously from within a real user gesture
   * (a click handler) — see this section's doc comment above for why.
   * Shows the browser's native directory picker, stores the granted
   * handle in IndexedDB keyed to THIS projectId for reuse across
   * reloads (permission allowing — see above), and caches it in
   * memory for this tab. A different project calling this later gets
   * its own independent picker/handle — never shares this one.
   * @param {string} projectId
   * @returns {Promise<{ok:boolean, name?:string, error?:*}>}
   */
  function enableFsaBackup(projectId) {
    if (!projectId) {
      return Promise.resolve({ ok: false, error: new Error("enableFsaBackup requires a projectId") });
    }
    if (!_fsaSupported()) {
      return Promise.resolve({ ok: false, error: new Error("File System Access API not supported in this browser") });
    }
    // showDirectoryPicker() is NOT guaranteed to only reject — on some
    // platforms/policies (e.g. a managed Chromebook where the File
    // System Access API is disabled by enterprise policy, or a
    // sandboxed/embedded context missing the right permissions-policy)
    // it throws SYNCHRONOUSLY instead of returning a rejected promise.
    // A bare `window.showDirectoryPicker(...).catch(...)` only guards
    // the rejected-promise case — a synchronous throw here happens
    // BEFORE that .catch() is ever attached, so it propagates straight
    // out of this function as an uncaught exception instead of a clean
    // {ok:false} result. Wrapping the call itself in try/catch is what
    // turns "the button throws an error" into a normal, reportable
    // failure the caller's pushLog() can show — see EditorEvents.js's
    // "enable-fsa-backup" case.
    let pickerPromise;
    try {
      pickerPromise = window.showDirectoryPicker({ mode: "readwrite", id: _fsaPickerId(projectId), startIn: "documents" });
    } catch (err) {
      return Promise.resolve({ ok: false, error: err });
    }
    return Promise.resolve(pickerPromise)
      .then((handle) => {
        _fsaHandleCache.set(projectId, handle);
        return _fsaStoreHandle(projectId, handle).then(
          () => ({ ok: true, name: handle.name }),
          // Handle was granted and is usable THIS session even if
          // caching it for future reloads failed — still report ok.
          () => ({ ok: true, name: handle.name })
        );
      })
      .catch((err) => {
        // AbortError is the normal, expected result of the user
        // clicking Cancel on the picker — not a real failure, so it's
        // reported distinctly (ok:false, but no scary console noise
        // expected from the caller) same as any other declined
        // permission.
        return { ok: false, error: err };
      });
  }

  /**
   * Resolves the directory handle to mirror writes into for a given
   * project, if one has ever been granted TO THAT PROJECT and still
   * has (or can silently reclaim, without a fresh user gesture) usable
   * permission — never prompts; a permission that needs
   * re-confirmation is treated as "not available this session" rather
   * than interrupting a background autosave with a picker it isn't
   * allowed to show anyway.
   * @param {string} projectId
   * @returns {Promise<FileSystemDirectoryHandle|null>}
   */
  function _fsaGetUsableHandle(projectId) {
    if (!projectId || !_fsaSupported()) return Promise.resolve(null);
    const check = (handle) => {
      if (!handle) return null;
      // Same synchronous-throw risk as showDirectoryPicker() above
      // (see enableFsaBackup's doc comment) — queryPermission() is a
      // real DOM API call, not just a promise factory, so a revoked/
      // torn-down handle (directory deleted externally, permission
      // API disabled mid-session) can throw before ever returning a
      // promise to .catch(). This runs on EVERY autosave tick (via
      // _fsaMirror) and on every editor boot (via isFsaBackupEnabled),
      // so an unguarded throw here is worse than the button case —
      // it could break the autosave loop or the boot sequence itself
      // instead of just one click.
      let permPromise;
      try {
        permPromise = handle.queryPermission({ mode: "readwrite" });
      } catch (_) {
        return null;
      }
      return Promise.resolve(permPromise)
        .then((state) => (state === "granted" ? handle : null))
        .catch(() => null);
    };
    if (_fsaHandleCache.has(projectId)) return check(_fsaHandleCache.get(projectId));
    return _fsaLoadStoredHandle(projectId).then((handle) => {
      if (handle) _fsaHandleCache.set(projectId, handle);
      return check(handle);
    });
  }

  /** Matches the exact shape produced by projectSnapshotKey() below —
   *  "realot.project.<id>.snapshot" — and captures the id. Used to
   *  figure out (a) whether a given setItem() key is a project
   *  snapshot at all (only snapshots get mirrored — see _fsaMirror's
   *  doc comment) and (b) which project's folder to mirror it into. */
  const SNAPSHOT_KEY_PATTERN = /^realot\.project\.(.+)\.snapshot$/;

  /**
   * Best-effort mirror of a write to the given project's granted FSA
   * directory, if any. NEVER affects setItem()'s resolved {ok} result
   * — this is purely a bonus backup, so a failure here (permission
   * lost, disk full, directory deleted externally) is logged and
   * swallowed, not propagated, exactly like the rest of this module's
   * "never throw into the caller" philosophy for tiers below the
   * primary one. Silently does nothing for any key that isn't a
   * project snapshot (see SNAPSHOT_KEY_PATTERN above) — the small
   * shared registries (scripts/physics layers/tags) that also flow
   * through setItem() aren't what a "don't lose my project" disk
   * backup is for, and mirroring them would need a project to already
   * be identifiable from a key shape that doesn't carry one.
   *
   * KNOWN LIMITATION on page exit specifically: unlike the primary
   * localStorage/IndexedDB tiers (see setItemSync() above, which gives
   * ProjectStorage.js's exit-time save a synchronous fallback that's
   * guaranteed to finish or fail before the page can tear down), the
   * File System Access API's write handle
   * (getFileHandle/createWritable/write/close, all used below) has NO
   * synchronous equivalent — every step is inherently async. That
   * means on a fast tab close/reload, an FSA mirror write that was
   * in flight can still be abandoned mid-write, exactly the race this
   * function's callers otherwise now avoid. In practice this only
   * matters for the LAST edit made in the seconds before closing —
   * every prior autosave tick's mirror already completed while the tab
   * was still open — and the primary save (which the reload/close
   * guard's dirty-tracking is keyed to) is unaffected either way, but
   * it means the FSA backup folder specifically can very occasionally
   * be one revision behind the primary save right after a fast exit.
   * There isn't a way to close this gap without either the browser
   * adding a synchronous FSA write primitive or the editor blocking
   * the unload itself with a custom confirmation UI, which would be a
   * bigger, separate change (a real "are you sure" modal in place of
   * the native beforeunload prompt) rather than a fix to this function.
   * @param {string} key
   * @param {string} json already-stringified value
   */
  function _fsaMirror(key, json) {
    const m = SNAPSHOT_KEY_PATTERN.exec(key);
    if (!m) return;
    const projectId = m[1];
    _fsaGetUsableHandle(projectId)
      .then((dir) => {
        if (!dir) return;
        // Every project's folder holds exactly one file: its own
        // snapshot. Using a fixed name (not derived from the full key)
        // means re-picking the SAME folder for the SAME project always
        // overwrites the same file rather than accumulating stale
        // dated copies — this is a live mirror, not a version history.
        return dir.getFileHandle("project-snapshot.json", { create: true }).then((fileHandle) =>
          fileHandle.createWritable().then((writable) => writable.write(json).then(() => writable.close()))
        );
      })
      .catch((err) => {
        console.error("[RealotPersistence] FSA backup mirror failed (non-fatal):", err);
      });
  }

  /**
   * Whether a usable (already-granted, no fresh prompt needed) FSA
   * backup directory is currently available FOR THIS PROJECT — for UI
   * to show "Backups: ON" vs a "Set up" button without triggering a
   * picker.
   * @param {string} projectId
   * @returns {Promise<boolean>}
   */
  function isFsaBackupEnabled(projectId) {
    return _fsaGetUsableHandle(projectId).then((h) => !!h);
  }

  /**
   * Reads the snapshot JSON back out of a project's granted FSA
   * backup folder, if one is set up and the file exists — the
   * counterpart to _fsaMirror's write. Used by the editor's
   * "Restore from Backup Folder…" action (see EditorEvents.js) so a
   * project that's gone from localStorage/IndexedDB (cleared browser
   * data, new device, quota eviction) can still be recovered from the
   * real file this was mirrored to. Never prompts — same
   * no-fresh-permission-request rule as the rest of this section — so
   * this can safely return "nothing to restore" rather than a picker
   * popping up unexpectedly.
   * @param {string} projectId
   * @returns {Promise<{ok:boolean, snapshot?:object, error?:*}>}
   */
  function readFsaBackup(projectId) {
    return _fsaGetUsableHandle(projectId)
      .then((dir) => {
        if (!dir) return { ok: false, error: new Error("No backup folder set up for this project") };
        return dir
          .getFileHandle("project-snapshot.json")
          .then((fileHandle) => fileHandle.getFile())
          .then((file) => file.text())
          .then((text) => ({ ok: true, snapshot: JSON.parse(text) }));
      })
      .catch((err) => ({ ok: false, error: err }));
  }

  /**
   * Lists every stored key starting with `prefix` across both tiers
   * (deduplicated). Used to enumerate "all projects" without the
   * caller needing to track an index itself. Deliberately does NOT
   * include FSA backup files — see the FSA section's doc comment for
   * why that tier is mirror-only and never a source of truth for what
   * the app considers "stored".
   * @param {string} prefix
   * @returns {Promise<string[]>}
   */
  function listKeys(prefix) {
    const found = new Set();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) found.add(k);
      }
    } catch (_) {}
    for (const k of _readIdbIndex()) {
      if (k.indexOf(prefix) === 0) found.add(k);
    }
    return Promise.resolve(Array.from(found));
  }

  /**
   * Turns OFF extra backup storage for a project: stops future mirror
   * writes by dropping the granted handle from the in-memory cache and
   * IndexedDB's FSA_HANDLE_STORE (same removal _fsaRemoveHandle already
   * does on project delete — this just exposes it as an explicit,
   * user-triggered action instead of only a delete side-effect).
   *
   * SAFE BY CONSTRUCTION, same reasoning as isFsaBackupEnabled's doc
   * comment: FSA has never been a read tier (getItem() never reads
   * from it — see this file's TIERING STRATEGY comment), so IndexedDB/
   * localStorage remain the sole source of truth for the project the
   * whole time backup was on. Turning it off never deletes the folder
   * on disk or anything already mirrored there; it just stops adding
   * to it. There is nothing this function needs to check or warn about
   * before disabling — unlike enabling (which needs a user gesture for
   * the picker), disabling has no unsafe path.
   * @param {string} projectId
   * @returns {Promise<void>}
   */
  function disableFsaBackup(projectId) {
    return _fsaRemoveHandle(projectId);
  }

  root.RealotPersistence = {
    setItem,
    setItemSync,
    getItem,
    removeItem,
    listKeys,
    enableFsaBackup,
    disableFsaBackup,
    isFsaBackupEnabled,
    readFsaBackup,
    removeFsaBackupHandle: _fsaRemoveHandle,
    /**
     * Builds the storage key for a launcher project's full editor
     * snapshot. Exposed here (rather than each of store.js and
     * ProjectStorage.js hardcoding the same string) so the launcher
     * and the editor can never drift on the key format between them —
     * both read/write the SAME project's data through the SAME key.
     * @param {string} projectId
     */
    projectSnapshotKey(projectId) {
      return "realot.project." + projectId + ".snapshot";
    },
  };
})(window);
