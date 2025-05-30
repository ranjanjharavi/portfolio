export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
export const stillMode = new URLSearchParams(location.search).has("still");
export const hasIntersectionObserver = "IntersectionObserver" in window;

// index.html repeats the preference checks inline to set motion-ready before first paint.
export function motionAllowed() {
  return hasIntersectionObserver && !reducedMotion.matches && !stillMode;
}

let paused = false;
const listeners = new Set();

export function isPaused() {
  return paused;
}

export function setPaused(value) {
  if (paused === value) return;
  paused = value;
  for (const listener of listeners) listener(paused);
}

export function onPauseChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Evaluate the same in/out curve as --io, including its non-linear x axis.
export function easeIo(progress) {
  let t = progress;
  for (let i = 0; i < 5; i++) {
    t -= (1.95 * t - 2.85 * t * t + 1.9 * t * t * t - progress) / (1.95 - 5.7 * t + 5.7 * t * t);
  }
  return t * t * (3 - 2 * t);
}
