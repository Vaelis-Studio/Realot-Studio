/**
 * runtime/core/System.js
 *
 * Base class for systems. A system is logic that runs once per tick over
 * a query of entities (movement, rendering sync, physics, etc). Keep
 * systems stateless about the editor — they operate on World only.
 *
 * RUNTIME-ONLY FILE.
 */

export class System {
  /**
   * Called once when added to a World. Optional override.
   * @param {import('./World.js').World} world
   */
  onAdded(world) {}

  /**
   * Called every tick. Override in subclasses.
   * @param {import('./World.js').World} world
   * @param {number} dt seconds since last tick
   */
  update(world, dt) {}
}
