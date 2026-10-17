/**
 * runtime/core/World.js
 *
 * The World owns every Entity and every System. It has no idea an editor
 * exists. The editor reads/writes into a World instance through the
 * runtime's public API only (see runtime/index.js) — it never reaches
 * into private fields.
 *
 * RUNTIME-ONLY FILE.
 */

import { Entity, resetEntityIdCounter, setEntityIdCounter } from "./Entity.js";

export class World {
  constructor() {
    /** @type {Map<string, Entity>} */
    this.entities = new Map();

    /** @type {import('./System.js').System[]} */
    this.systems = [];
    /** Game speed multiplier for this frame (set by GameLoop from time.scale). */
    this.timeScale = 1;

    this.sceneName = "Untitled Scene";

    /**
     * Hierarchy panel organizational folders (editor concern, but see
     * Entity.folderId's doc comment for why this lives on World instead
     * of editor/state — it's plain scene data that has to round-trip
     * through SceneSerializer.js like sceneName does just above).
     * Folders can nest (parentId), have a display name, and remember
     * whether they're currently expanded or collapsed in the panel.
     * Never read by any runtime System — purely a Hierarchy panel
     * presentation detail, exactly like Entity.folderId.
     * @type {{id:string, name:string, parentId:string|null, expanded:boolean}[]}
     */
    this.hierarchyFolders = [];
    this._nextFolderId = 1;

    // Entities queued for destruction this frame (see queueDestroy()'s
    // doc comment for why destruction is deferred rather than
    // immediate — matches Unity's Destroy() semantics).
    /** @type {Set<string>} */
    this._pendingDestroy = new Set();

    // PERFORMANCE PROFILING — off by default (near-zero cost: one
    // boolean check per system per frame when disabled, no
    // performance.now() calls at all). Turned on by a script calling
    // debug.show() — see ScriptAPI.js's `debug` global and
    // ScriptSystem's wiring — so a slow-frame investigation never
    // needs browser DevTools: enabling the debug HUD also starts
    // timing every system's update() call and exposes a rolling
    // average below for the HUD to read.
    /** @type {boolean} */
    this.profilingEnabled = false;
    /** @type {{name:string, ms:number}[]} last completed frame's RAW
     *  (unaveraged) per-system update() cost, in system-add order.
     *  Kept for anything that wants the instantaneous number, but the
     *  HUD reads avgFrameSystemTimes below instead — a single frame's
     *  raw timing is too noisy (GC blips, one-off hitches) to read
     *  off a HUD that's redrawing every frame; see the doc comment on
     *  _profileAccum for how the average is built. */
    this.lastFrameSystemTimes = [];
    /** @type {{name:string, ms:number}[]} SAME shape as
     *  lastFrameSystemTimes, but averaged over the last
     *  PROFILE_AVERAGE_WINDOW frames — this is what actually holds
     *  still long enough to read on a live HUD. Recomputed once every
     *  PROFILE_AVERAGE_WINDOW frames (see update() below), not
     *  smoothed continuously, so the numbers visibly step to a new
     *  value roughly twice a second rather than crawling — easier to
     *  eyeball a stable number that way than a continuously-drifting
     *  exponential average. */
    this.avgFrameSystemTimes = [];
    // Frames-since-last-average-recompute counter + accumulator map
    // (name -> summed ms across the window). Reset every time the
    // average is recomputed.
    this._profileFrameCount = 0;
    this._profileAccum = new Map();
  }

  /** How many frames to accumulate before recomputing
   *  avgFrameSystemTimes — ~30 frames is about half a second at
   *  60fps, long enough to smooth out normal per-frame jitter but
   *  still short enough to react to a real, sustained change (e.g.
   *  toggling something on/off in the scene while playing). */
  static get PROFILE_AVERAGE_WINDOW() {
    return 30;
  }

  /**
   * Wipes all entities. Used when loading a new scene.
   */
  clear() {
    this.entities.clear();
    this._pendingDestroy.clear();
    this.hierarchyFolders = [];
    this._nextFolderId = 1;
    resetEntityIdCounter();
  }

  /**
   * Creates a new Hierarchy folder and returns it.
   * @param {string} name
   * @param {string|null} [parentId] id of an existing folder to nest
   *   this one inside, or null/omitted for a top-level folder.
   * @returns {{id:string, name:string, parentId:string|null, expanded:boolean}}
   */
  createHierarchyFolder(name, parentId) {
    const folder = {
      id: "f" + (this._nextFolderId++),
      name: name || "New Folder",
      parentId: parentId || null,
      expanded: true,
    };
    this.hierarchyFolders.push(folder);
    return folder;
  }

  getHierarchyFolder(folderId) {
    return this.hierarchyFolders.find((f) => f.id === folderId) || null;
  }

  renameHierarchyFolder(folderId, name) {
    const folder = this.getHierarchyFolder(folderId);
    if (folder && name && name.trim()) folder.name = name.trim();
  }

  /**
   * Deletes a folder. Anything directly inside it — both entities
   * (Entity.folderId) and any nested sub-folders (folder.parentId) —
   * is bumped up to whatever the deleted folder's OWN parent was
   * (or to the scene root, if it had none), matching how deleting a
   * folder in a normal file manager reparents its contents up one
   * level rather than deleting them too.
   * @param {string} folderId
   */
  deleteHierarchyFolder(folderId) {
    const folder = this.getHierarchyFolder(folderId);
    if (!folder) return;
    const newParentId = folder.parentId || null;
    for (const entity of this.entities.values()) {
      if (entity.folderId === folderId) entity.folderId = newParentId;
    }
    for (const f of this.hierarchyFolders) {
      if (f.parentId === folderId) f.parentId = newParentId;
    }
    this.hierarchyFolders = this.hierarchyFolders.filter((f) => f.id !== folderId);
  }

  /**
   * Moves an entity into a folder (or to the scene root when folderId
   * is null). No-ops if folderId names a folder that doesn't exist,
   * so a stale drag-and-drop target can never silently corrupt an
   * entity's folder reference into a dangling id.
   * @param {string} entityId
   * @param {string|null} folderId
   */
  moveEntityToFolder(entityId, folderId) {
    const entity = this.getEntity(entityId);
    if (!entity) return;
    if (folderId && !this.getHierarchyFolder(folderId)) return;
    entity.folderId = folderId || null;
  }

  /**
   * Moves a folder to nest inside another folder (or to the top level
   * when newParentId is null). Refuses any change that would make a
   * folder its own ancestor (dragging a folder into itself or into
   * one of its own descendants), which would otherwise create a cycle
   * that the Hierarchy panel's recursive render could never terminate.
   * @param {string} folderId
   * @param {string|null} newParentId
   */
  moveHierarchyFolder(folderId, newParentId) {
    if (folderId === newParentId) return;
    const folder = this.getHierarchyFolder(folderId);
    if (!folder) return;
    if (newParentId) {
      if (!this.getHierarchyFolder(newParentId)) return;
      // Walk up from newParentId; if we ever reach folderId, this move
      // would nest folderId inside its own descendant — reject it.
      let cursor = newParentId;
      while (cursor) {
        if (cursor === folderId) return;
        const cursorFolder = this.getHierarchyFolder(cursor);
        cursor = cursorFolder ? cursorFolder.parentId : null;
      }
    }
    folder.parentId = newParentId || null;
  }

  /**
   * Creates an entity. Pass `id` to RESTORE a specific id from a saved
   * scene (deserializeScene) — required because cross-entity references
   * (e.g. a Tilemap pointing at its Tileset entity by id) only survive
   * a load if the ids are preserved verbatim. When omitted, a fresh
   * auto-incremented id is generated as before.
   */
  createEntity(name, tag, id) {
    const e = new Entity(name, tag);
    if (id) {
      e.id = id;
      // Keep the auto-increment counter ahead of the restored id so
      // the next entity created normally never collides with it.
      const n = parseInt(id.slice(1), 10);
      if (!Number.isNaN(n)) setEntityIdCounter(n + 1);
    }
    this.entities.set(e.id, e);
    return e;
  }

  destroyEntity(id) {
    return this.entities.delete(id);
  }

  /**
   * Marks an entity for destruction at the END of this frame, rather
   * than removing it immediately — the same deferred semantics as
   * Unity's Destroy(). This matters because destruction can be
   * requested from the MIDDLE of a frame — e.g. a script's own
   * onUpdate(), or an onCollision(other) callback fired while
   * PhysicsSystem is mid-step — and immediately splicing the entity out
   * of world.entities right then would yank it out from under whatever
   * system or query is currently iterating (a Map can be safely deleted
   * from mid-for-of in JS, but OTHER code later in the same frame that
   * already captured a reference to this entity — e.g. ScriptSystem's
   * own instances Map for it, or a second collision callback about to
   * fire for the same pair this physics step — would then be working
   * against a half-torn-down object). Unity's own behavior is
   * identical: a destroyed object is still fully valid for the rest of
   * the current frame's calls, and is only actually gone starting next
   * frame.
   *
   * Actual cleanup — including firing onDestroy on the entity's own
   * scripts — happens in flushDestroyed(), called once per frame by
   * ScriptSystem.update() (see systems/ScriptSystem.js) AFTER every
   * system (physics, controller, animation, render, scripts) has
   * finished its own pass for this frame, so nothing reads a
   * half-destroyed entity mid-frame.
   * @param {string} id
   */
  queueDestroy(id) {
    if (this.entities.has(id)) this._pendingDestroy.add(id);
  }

  /**
   * True if this entity has been queued for destruction this frame
   * (via queueDestroy) but hasn't been removed yet. Systems that would
   * otherwise keep acting on a "zombie" entity for the remainder of the
   * frame (e.g. starting a NEW collision response, or spawning
   * something from it) can check this and skip; existing per-frame
   * behavior already in flight (an onUpdate call already in progress
   * this frame) is intentionally left alone — see queueDestroy()'s doc
   * comment for why that matches Unity's own Destroy() semantics.
   * @param {string} id
   */
  isPendingDestroy(id) {
    return this._pendingDestroy.has(id);
  }

  /**
   * Actually removes every entity queued via queueDestroy() since the
   * last flush. Returns the list of removed entities (NOT ids) so the
   * caller (ScriptSystem) can still reach their Script component/name
   * for cleanup and error reporting after they're gone from
   * world.entities.
   * @returns {Entity[]}
   */
  flushDestroyed() {
    if (this._pendingDestroy.size === 0) return [];
    const removed = [];
    for (const id of this._pendingDestroy) {
      const entity = this.entities.get(id);
      if (entity) removed.push(entity);
      this.entities.delete(id);
    }
    this._pendingDestroy.clear();
    return removed;
  }

  getEntity(id) {
    return this.entities.get(id) || null;
  }

  /** @returns {Entity[]} */
  getAllEntities() {
    return Array.from(this.entities.values());
  }

  /** @returns {Entity[]} entities that own every component type listed */
  query(...componentTypes) {
    const out = [];
    for (const entity of this.entities.values()) {
      if (!entity.active) continue;
      let ok = true;
      for (const t of componentTypes) {
        if (!entity.hasComponent(t)) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(entity);
    }
    return out;
  }

  findByTag(tag) {
    return this.getAllEntities().filter((e) => e.tag === tag);
  }

  findFirstByName(name) {
    return this.getAllEntities().find((e) => e.name === name) || null;
  }

  findAllByName(name) {
    return this.getAllEntities().filter((e) => e.name === name);
  }

  // --- Explicit find-by-name / find-by-tag API ---
  //
  // findFirstByName/findAllByName/findByTag (above) are kept exactly as
  // they were — existing scripts and any other engine code that calls
  // them keep working unchanged. These are additional, more explicit
  // names for the exact same lookups, added so the ambiguity between
  // "find by name" and "find by tag" is resolved by the METHOD NAME
  // itself rather than by an opts flag a caller has to remember to pass
  // (e.g. spawn()'s opts.byTag). findFirst/findAll search by NAME;
  // findFirstWithTag/findAllWithTag search by TAG — the "WithTag" suffix
  // is the one and only signal for "this is a tag lookup, not a name
  // lookup" anywhere these are used (World, ScriptAPI globals, and the
  // editor autocomplete all use this same convention).

  /** Find the first entity with the given NAME, or null. Same lookup as
   *  findFirstByName — this is just the shorter, preferred name. */
  findFirst(name) {
    return this.findFirstByName(name);
  }

  /** Find every entity with the given NAME. Same lookup as
   *  findAllByName — this is just the shorter, preferred name. */
  findAll(name) {
    return this.findAllByName(name);
  }

  /** Find the first entity with the given TAG, or null. */
  findFirstWithTag(tag) {
    return this.getAllEntities().find((e) => e.tag === tag) || null;
  }

  /** Find every entity with the given TAG. Same lookup as findByTag —
   *  this is just the name that matches findFirstWithTag/findAllWithTag. */
  findAllWithTag(tag) {
    return this.findByTag(tag);
  }

  addSystem(system) {
    this.systems.push(system);
    if (typeof system.onAdded === "function") system.onAdded(this);
    return system;
  }

  /**
   * Clears the rolling-average accumulator and restarts the window.
   * Called by ScriptAPI's `debug.show()` whenever profiling toggles
   * ON (see profilingEnabled's doc comment above) — without this, a
   * script that calls debug.show(false) then debug.show(true) again
   * later in the same session would have its first post-reenable
   * average blended with stale ms sums left over from before, giving
   * a misleadingly high or low first reading instead of a clean
   * window starting from the moment profiling actually resumed.
   */
  resetProfiling() {
    this._profileAccum.clear();
    this._profileFrameCount = 0;
    this.lastFrameSystemTimes = [];
    this.avgFrameSystemTimes = [];
  }

  /**
   * Runs every system's update once. Called by the GameLoop each tick.
   * @param {number} dt seconds since last tick
   */
  update(dt) {
    // Fast path — identical to the old unconditional loop, just no
    // timing overhead at all when profiling is off (the common case).
    if (!this.profilingEnabled) {
      for (const system of this.systems) {
        if (typeof system.update === "function") system.update(this, dt);
      }
      return;
    }

    // Profiling path — only entered while a script has debug.show()
    // turned on (see ScriptAPI.js). performance.now() itself has real
    // (if small) overhead, so this is deliberately never run unless
    // someone is actually looking at the numbers.
    const times = [];
    for (const system of this.systems) {
      if (typeof system.update !== "function") continue;
      const label = (system.constructor && system.constructor.name) || "System";
      const start = performance.now();
      system.update(this, dt);
      const ms = performance.now() - start;
      times.push({ name: label, ms });
      this._profileAccum.set(label, (this._profileAccum.get(label) || 0) + ms);
    }
    this.lastFrameSystemTimes = times;

    // Recompute the rolling average every PROFILE_AVERAGE_WINDOW
    // frames rather than every single frame — see
    // avgFrameSystemTimes's doc comment for why a steppy update reads
    // better on a live HUD than a per-frame-jittery one. Order is
    // preserved by iterating `times` (system-add order) rather than
    // the accumulator Map, so the HUD's line order never shuffles
    // between recomputes.
    this._profileFrameCount++;
    if (this._profileFrameCount >= World.PROFILE_AVERAGE_WINDOW) {
      const n = this._profileFrameCount;
      this.avgFrameSystemTimes = times.map((t) => ({
        name: t.name,
        ms: (this._profileAccum.get(t.name) || 0) / n,
      }));
      this._profileAccum.clear();
      this._profileFrameCount = 0;
    }
  }
}
