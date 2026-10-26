/** Serialize refreshes, collapsing every burst during one read into one trailing read. */
export function coalesceRefresh(task) {
  let flight = null, queued = false;
  const refresh = () => {
    queued = true;
    if (flight) return flight;
    flight = Promise.resolve().then(async () => {
      try {
        do { queued = false; await task(); } while (queued);
      } finally { flight = null; queued = false; }
    });
    return flight;
  };
  refresh.cancelPending = () => { queued = false; };
  return refresh;
}
