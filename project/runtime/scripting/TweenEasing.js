/**
 * runtime/scripting/TweenEasing.js
 *
 * Easing functions shared by the runtime tween scheduler and the editor's
 * easing-name autocomplete. All functions accept normalized progress in
 * [0, 1]. Back/elastic easings intentionally overshoot between endpoints.
 */

function powerIn(t, power) { return Math.pow(t, power); }
function powerOut(t, power) { return 1 - Math.pow(1 - t, power); }
function powerInOut(t, power) {
  return t < 0.5
    ? Math.pow(2 * t, power) / 2
    : 1 - Math.pow(2 * (1 - t), power) / 2;
}

function sineIn(t) { return 1 - Math.cos((t * Math.PI) / 2); }
function sineOut(t) { return Math.sin((t * Math.PI) / 2); }
function sineInOut(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }

function expoIn(t) { return t === 0 ? 0 : Math.pow(2, 10 * t - 10); }
function expoOut(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }
function expoInOut(t) {
  if (t === 0 || t === 1) return t;
  return t < 0.5
    ? Math.pow(2, 20 * t - 10) / 2
    : (2 - Math.pow(2, -20 * t + 10)) / 2;
}

function circIn(t) { return 1 - Math.sqrt(Math.max(0, 1 - t * t)); }
function circOut(t) { return Math.sqrt(Math.max(0, 1 - Math.pow(t - 1, 2))); }
function circInOut(t) {
  return t < 0.5
    ? (1 - Math.sqrt(Math.max(0, 1 - Math.pow(2 * t, 2)))) / 2
    : (Math.sqrt(Math.max(0, 1 - Math.pow(-2 * t + 2, 2))) + 1) / 2;
}

const BACK_C1 = 1.70158;
function backIn(t) { return (BACK_C1 + 1) * t * t * t - BACK_C1 * t * t; }
function backOut(t) {
  return 1 + (BACK_C1 + 1) * Math.pow(t - 1, 3) + BACK_C1 * Math.pow(t - 1, 2);
}
function backInOut(t) {
  const c = BACK_C1 * 1.525;
  return t < 0.5
    ? (Math.pow(2 * t, 2) * ((c + 1) * 2 * t - c)) / 2
    : (Math.pow(2 * t - 2, 2) * ((c + 1) * (t * 2 - 2) + c) + 2) / 2;
}

function elasticIn(t) {
  if (t === 0 || t === 1) return t;
  return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * (2 * Math.PI / 3));
}
function elasticOut(t) {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
}
function elasticInOut(t) {
  if (t === 0 || t === 1) return t;
  const c = (2 * Math.PI) / 4.5;
  return t < 0.5
    ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c)) / 2
    : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c)) / 2 + 1;
}

function bounceOut(t) {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
  if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
  t -= 2.625 / d;
  return n * t * t + 0.984375;
}
function bounceIn(t) { return 1 - bounceOut(1 - t); }
function bounceInOut(t) {
  return t < 0.5
    ? (1 - bounceOut(1 - 2 * t)) / 2
    : (1 + bounceOut(2 * t - 1)) / 2;
}

const EASINGS = {
  linear: (t) => t,
  smoothstep: (t) => t * t * (3 - 2 * t),
  smootherstep: (t) => t * t * t * (t * (t * 6 - 15) + 10),
  easeInQuad: (t) => powerIn(t, 2),
  easeOutQuad: (t) => powerOut(t, 2),
  easeInOutQuad: (t) => powerInOut(t, 2),
  easeInCubic: (t) => powerIn(t, 3),
  easeOutCubic: (t) => powerOut(t, 3),
  easeInOutCubic: (t) => powerInOut(t, 3),
  easeInQuart: (t) => powerIn(t, 4),
  easeOutQuart: (t) => powerOut(t, 4),
  easeInOutQuart: (t) => powerInOut(t, 4),
  easeInQuint: (t) => powerIn(t, 5),
  easeOutQuint: (t) => powerOut(t, 5),
  easeInOutQuint: (t) => powerInOut(t, 5),
  easeInSine: sineIn,
  easeOutSine: sineOut,
  easeInOutSine: sineInOut,
  easeInExpo: expoIn,
  easeOutExpo: expoOut,
  easeInOutExpo: expoInOut,
  easeInCirc: circIn,
  easeOutCirc: circOut,
  easeInOutCirc: circInOut,
  easeInBack: backIn,
  easeOutBack: backOut,
  easeInOutBack: backInOut,
  easeInElastic: elasticIn,
  easeOutElastic: elasticOut,
  easeInOutElastic: elasticInOut,
  easeInBounce: bounceIn,
  easeOutBounce: bounceOut,
  easeInOutBounce: bounceInOut,
};

const DETAILS = {
  linear: "Constant speed from start to finish.",
  smoothstep: "Smooth start and finish with no overshoot.",
  smootherstep: "Extra-smooth start and finish; gentler than smoothstep.",
  Quad: "Quadratic easing — a simple, polished acceleration/deceleration.",
  Cubic: "Cubic easing — a stronger, smooth acceleration/deceleration.",
  Quart: "Quartic easing — strong acceleration/deceleration.",
  Quint: "Quintic easing — very strong acceleration/deceleration.",
  Sine: "Soft sinusoidal motion; great for UI and subtle movement.",
  Expo: "Exponential easing — starts or finishes very sharply.",
  Circ: "Circular easing — curved acceleration/deceleration.",
  Back: "Slightly pulls back or overshoots the endpoint for a lively feel.",
  Elastic: "Springy oscillation around an endpoint.",
  Bounce: "Bounces into or out of the endpoint.",
};

/** Shared ordered catalogue used by editor autocomplete. */
export const TWEEN_EASING_NAMES = Object.freeze(Object.keys(EASINGS).map((label) => {
  if (label === "linear" || label === "smoothstep" || label === "smootherstep") {
    return Object.freeze({ label, detail: DETAILS[label] });
  }
  const suffix = label.replace(/^ease(?:InOut|In|Out)/, "");
  const direction = label.match(/^ease(InOut|In|Out)/)[1];
  const directionText = direction === "InOut" ? "ease in and out" : direction === "In" ? "ease in" : "ease out";
  return Object.freeze({ label, detail: `${DETAILS[suffix]} Direction: ${directionText}.` });
}));

/**
 * Resolve a supported easing name to its function. Matching is case-
 * insensitive and tolerates spaces, hyphens, and underscores.
 * Returns null for unknown names so callers can report a useful warning.
 */
export function resolveTweenEasing(name) {
  if (typeof name !== "string") return null;
  const requested = name.replace(/[\s_-]/g, "").toLowerCase();
  for (const key of Object.keys(EASINGS)) {
    if (key.replace(/[\s_-]/g, "").toLowerCase() === requested) return EASINGS[key];
  }
  return null;
}
