export const PROGRESS_STATES = ['PROCESSED', 'NEEDS_HUMAN', 'NONE', 'ERROR'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function groupProgress(group) {
  const result = Object.fromEntries(PROGRESS_STATES.map(status => [status, count(group?.counts?.[status])]));
  result.total = PROGRESS_STATES.reduce((sum, key) => sum + result[key], 0);
  result.manual = Number.isSafeInteger(group?.manual_count) ? Math.min(result.total, count(group.manual_count)) : null;
  return result;
}

export function projectProgress(groups) {
  const unique = [...new Map(groups.map(group => [group.id, group])).values()];
  const result = { total: 0, PROCESSED: 0, NEEDS_HUMAN: 0, NONE: 0, ERROR: 0, manual: 0 };
  for (const group of unique) {
    const counts = groupProgress(group);
    for (const key of ['total', ...PROGRESS_STATES]) result[key] += counts[key];
    result.manual = result.manual === null || counts.manual === null ? null : result.manual + counts.manual;
  }
  return result;
}

export const progressRatio = value => value.total ? Math.min(1, Math.max(0, value.PROCESSED / value.total)) : 0;

// Largest remainder allocation keeps displayed integers and shares consistent.
function distribute(values, total, keys = PROGRESS_STATES) {
  const result = Object.fromEntries(keys.map(key => [key, Math.floor(Math.max(0, values[key]))]));
  const order = [...keys].sort((a, b) => values[b] % 1 - values[a] % 1);
  const missing = total - keys.reduce((sum, key) => sum + result[key], 0);
  for (let i = 0; i < missing; i++) result[order[i % order.length]]++;
  return result;
}

export function displayedProgress(value) {
  const total = Math.max(0, Math.round(value.total));
  const counts = { ...distribute(value, total), total, manual: value.manual === null ? null : Math.min(total, Math.max(0, Math.round(value.manual))) };
  const ratio = progressRatio(value), percent = Math.round(ratio * 100), pending = PROGRESS_STATES.filter(key => key !== 'PROCESSED');
  const pendingTotal = pending.reduce((sum, key) => sum + value[key], 0), budget = value.total ? 100 - percent : 0;
  // Keep the processed row consistent with the headline; allocate rounding
  // among the remaining states instead of making 33% become 34% in the list.
  const shares = { PROCESSED: percent, ...distribute(Object.fromEntries(pending.map(key => [key, pendingTotal ? value[key] * budget / pendingTotal : 0])), budget, pending) };
  return { counts, shares, ratio, percent };
}

/** One short, interruptible animation. No React updates or idle frame loop. */
export function createProgressAnimation({ initial, requestFrame, cancelFrame, now, reducedMotion, apply }) {
  let value = { ...initial }, target = { ...initial }, frame = null, disposed = false;
  const cancel = () => { if (frame !== null) cancelFrame(frame); frame = null; };
  const finish = () => { cancel(); if (!disposed) { value = { ...target }; apply(value); } };
  const set = (next, instant = false) => {
    if (disposed) return;
    cancel(); target = { ...next };
    if (instant || reducedMotion() || ['total', ...PROGRESS_STATES, 'manual'].every(key => target[key] === value[key])) { finish(); return; }
    const from = { ...value }, delta = progressRatio(target) - progressRatio(from), started = now();
    const duration = Math.min(650, (delta < 0 ? 340 : 390) + Math.abs(delta) * 260);
    const step = timestamp => {
      if (disposed) return;
      const time = Math.min(1, Math.max(0, (timestamp - started) / duration)), weight = 1 - (1 - time) ** 3;
      for (const key of ['total', ...PROGRESS_STATES, 'manual']) value[key] = key === 'manual' && (from[key] === null || target[key] === null)
        ? target[key] : from[key] + (target[key] - from[key]) * weight;
      apply(value);
      if (time < 1) frame = requestFrame(step);
      else { value = { ...target }; frame = null; }
    };
    frame = requestFrame(step);
  };
  return { set, finish, dispose() { disposed = true; cancel(); } };
}
