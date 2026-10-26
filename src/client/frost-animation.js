import { frostValue } from '../appearance.js';

/** One frame chain; retarget from the currently displayed value, never an old endpoint. */
export function createFrostAnimation({ initial, apply, requestFrame, cancelFrame, now, reducedMotion = () => false, duration = 180 }) {
  let current = frostValue(initial), from = current, target = current, start = now(), frame = null, disposed = false;
  const draw = timestamp => {
    frame = null;
    if (disposed) return;
    const progress = reducedMotion() ? 1 : Math.min(1, Math.max(0, (timestamp - start) / duration));
    current = progress === 1 ? target : from + (target - from) * (1 - (1 - progress) ** 3);
    apply(current);
    if (progress < 1) frame = requestFrame(draw);
  };
  apply(current);
  return {
    set(value) {
      if (disposed) return;
      const next = frostValue(value);
      if (next === target) return;
      from = current; target = next; start = now();
      if (frame === null) frame = requestFrame(draw);
    },
    dispose() { disposed = true; if (frame !== null) cancelFrame(frame); frame = null; }
  };
}
