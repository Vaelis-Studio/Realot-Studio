// Run from the folder containing index.html:  node tests/unit-physics-time-scale.mjs
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = resolve(process.argv[2] || process.cwd());
const load = (rel) => import(pathToFileURL(ROOT + '/' + rel).href);

// Pure-logic test of PhysicsWorld.step() at a steady 60 FPS: simulated time vs game time.
const which = 'current';
const { PhysicsWorld } = await load('project/runtime/physics/PhysicsWorld.js');
function run(scale, seconds = 3, fps = 60) {
  const pw = Object.create(PhysicsWorld.prototype); pw.ready = true; pw._physicsAccumulator = 0;
  let steps = 0; pw._stepOnce = () => { steps++; };
  const world = { timeScale: scale }; let game = 0;
  const raw = 1 / fps;
  for (let f = 0; f < seconds * fps; f++) { const dt = Math.min(raw * scale, 0.5); game += dt; pw.step(world, dt, null); }
  return { sim: steps / 60, game };
}
let fail = 0; const T = (n, ok, x = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x !== '' ? '  -> ' + x : '')); if (!ok) fail++; };
console.log('=== ' + which + ' PhysicsWorld ===');
for (const s of [0.25, 0.5, 1, 2, 4, 8, 15]) {
  const r = run(s); const ok = Math.abs(r.sim - r.game) <= 0.02 * r.game + 1 / 60;
  T(`scale ${s} @60fps: physics ${r.sim.toFixed(2)}s vs game ${r.game.toFixed(2)}s`, ok);
}
const z = (() => { const pw = Object.create(PhysicsWorld.prototype); pw.ready = true; pw._physicsAccumulator = 0; let n = 0; pw._stepOnce = () => n++; for (let i = 0; i < 120; i++) pw.step({ timeScale: 0 }, 0, null); return n; })();
T('scale 0 (dt === 0): physics takes no steps', z === 0, z + ' steps');
console.log(fail ? fail + ' FAILED' : 'ALL PASSED'); process.exit(fail ? 1 : 0);
