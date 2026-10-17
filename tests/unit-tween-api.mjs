// Run from the folder containing index.html: node tests/unit-tween-api.mjs
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = resolve(process.argv[2] || process.cwd());
const load = (rel) => import(pathToFileURL(ROOT + '/' + rel).href);

const { TWEEN_EASING_NAMES, resolveTweenEasing } = await load('project/runtime/scripting/TweenEasing.js');
const { ScriptSystem } = await load('project/runtime/systems/ScriptSystem.js');
const { _detectStringContext } = await load('project/editor/scripting/ScriptIntelliSense.js');
let failed = 0;
const test = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failed++;
};
const near = (a, b, eps = 1e-8) => Number.isFinite(a) && Math.abs(a - b) <= eps;

// Every autocomplete entry must resolve to a runtime easing and hit both
// endpoints; back/elastic can overshoot only between the endpoints.
test('at least 30 easing choices are available', TWEEN_EASING_NAMES.length >= 30, String(TWEEN_EASING_NAMES.length));
for (const { label } of TWEEN_EASING_NAMES) {
  const ease = resolveTweenEasing(label);
  test(`${label} resolves and reaches endpoints`, !!ease && near(ease(0), 0) && near(ease(1), 1));
}
test('easing names accept case, spaces, and hyphens',
  resolveTweenEasing('EASE-OUT-QUAD') === resolveTweenEasing('easeOutQuad'));
test('easeInQuad and easeOutQuad differ as expected',
  near(resolveTweenEasing('easeInQuad')(0.5), 0.25) && near(resolveTweenEasing('easeOutQuad')(0.5), 0.75));
test('unknown easing does not silently map to linear', resolveTweenEasing('notARealEase') === null);
test('editor recognizes easing-string completion context', _detectStringContext('tween(this, { x: 420 }, 0.8, \"easeOut', 'tween(this, { x: 420 }, 0.8, \"easeOut') === 'tweenEasing');

const compileSystem = new ScriptSystem({});
const compiledCheck = compileSystem._compile('tween-global-compile-check',
  'function onStart() { return [typeof tween, typeof cancelTween, typeof nav].join(","); }');
const noop = () => {};
const compiledHandlers = compiledCheck(
  noop, noop, noop, noop, noop, noop, noop,
  {}, {}, {}, {}, [], {}, {}, {}, noop, {}, {}, {},
  noop, noop, noop, noop, noop, noop, noop, noop, noop, {},
  console, Math, {}
);
test('compiled scripts receive tween/cancelTween globals in the right parameter order',
  compiledHandlers.onStart() === 'function,function,object', compiledHandlers.onStart());

const system = new ScriptSystem({});
const owner = { _entity: { id: 'owner-1', name: 'Tween Test Owner' } };
const world = { getEntity: (id) => id === 'owner-1' ? {} : null };
system._world = world;
system._activeContext = owner;
const target = { x: 0, y: 10 };
const id = system._scheduleTween(target, { x: 100, y: 30 }, 1, 'linear');
system._tickTweens(0.5);
test('linear tween interpolates multiple numeric properties', near(target.x, 50) && near(target.y, 20));
system._tickTweens(0.5);
test('tween reaches exact target and removes itself', near(target.x, 100) && near(target.y, 30) && !system._tweens.has(id));

const easedTarget = { x: 0 };
system._scheduleTween(easedTarget, { x: 100 }, 1, 'easeOutQuad');
system._tickTweens(0.5);
test('selected easing affects interpolation', near(easedTarget.x, 75));

let completedWithOwner = false;
const completedTarget = { x: 0 };
system._scheduleTween(completedTarget, { x: 5 }, 0.1, 'linear', function () {
  completedWithOwner = this === owner;
});
system._tickTweens(0.1);
test('onComplete runs with the starting entity context', completedWithOwner);

const cancelTarget = { x: 0 };
const cancelId = system._scheduleTween(cancelTarget, { x: 50 }, 1, 'linear');
test('cancelTween reports success', system._cancelTween(cancelId) === true);
system._tickTweens(0.5);
test('cancelled tween no longer changes target', near(cancelTarget.x, 0));

const zeroTarget = { x: 1 };
system._scheduleTween(zeroTarget, { x: 9 }, 0, 'linear');
system._tickTweens(0);
test('zero-duration tween completes immediately on the next tween tick', near(zeroTarget.x, 9));

system.destroy();
test('destroy clears active tweens', system._tweens.size === 0);
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
