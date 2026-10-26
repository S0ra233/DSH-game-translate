/** Two channels share one frame chain. No renderer reconfiguration or persistence here. */
export function createMaterialAnimation({ initial, apply, requestFrame, cancelFrame, now, reducedMotion = () => false }) {
  let current = { ...initial }, target = { ...initial }, last = now(), frame = null, disposed = false;
  const draw = timestamp => {
    frame = null; if (disposed) return;
    const amount = reducedMotion() ? 1 : 1 - Math.exp(-Math.max(0, Math.min(80, timestamp - last)) / 45); last = timestamp;
    let moving = false;
    for (const key of ['milk', 'softLight']) {
      current[key] += (target[key] - current[key]) * amount;
      if (Math.abs(target[key] - current[key]) < .03) current[key] = target[key]; else moving = true;
    }
    apply({ ...current });
    if (moving) frame = requestFrame(draw);
  };
  apply({ ...current });
  return { set(value) { target = { ...value }; if (!disposed && frame === null && (target.milk !== current.milk || target.softLight !== current.softLight)) { last = now(); frame = requestFrame(draw); } },
    dispose() { disposed = true; if (frame !== null) cancelFrame(frame); frame = null; } };
}
