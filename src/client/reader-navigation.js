/** Centre the paired paragraph inside its own viewport, including edge results. */
export function centerReaderTarget(container, node, ownerWindow, onSettled = () => {}) {
  let frame, interrupted = false, navigating = true;
  const beforeKey = '--search-scroll-before', afterKey = '--search-scroll-after';
  const dimensions = () => [container.clientWidth, container.clientHeight, node.getBoundingClientRect().height].join(':');
  let size = dimensions();
  const place = behavior => {
    if (interrupted || !node.isConnected) return;
    const content = container.querySelector('.paired-text');
    if (!content || !container.clientHeight) return;
    const viewport = container.getBoundingClientRect(), row = node.getBoundingClientRect();
    const before = parseFloat(container.style.getPropertyValue(beforeKey)) || 0;
    const naturalTop = container.scrollTop + row.top - viewport.top - container.clientTop - before;
    // Oversized paragraphs start with a readable inset instead of hiding their
    // opening lines. Shorter ones sit at the actual viewport's vertical centre.
    const visibleHeight = Math.min(row.height, Math.max(0, container.clientHeight - 32));
    const desired = naturalTop - (container.clientHeight - visibleHeight) / 2;
    const newBefore = Math.max(0, -desired);
    const virtualHeight = [...container.querySelectorAll('.reader-virtual-space')].reduce((sum, item) => sum + item.getBoundingClientRect().height, 0);
    const newAfter = Math.max(0, desired + container.clientHeight - content.getBoundingClientRect().height - virtualHeight);
    container.style.setProperty(beforeKey, `${newBefore}px`);
    container.style.setProperty(afterKey, `${newAfter}px`);
    container.scrollTo({ top: desired + newBefore, behavior });
  };
  const settle = () => {
    ownerWindow.cancelAnimationFrame(frame);
    frame = ownerWindow.requestAnimationFrame(() => { navigating = false; place('instant'); onSettled(); });
  };
  const interrupt = event => {
    if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
    interrupted = true;
    navigating = false;
    ownerWindow.cancelAnimationFrame(frame);
  };
  container.addEventListener('scrollend', settle, { once: true });
  for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) container.addEventListener(name, interrupt, { passive: true });
  const observer = ownerWindow.ResizeObserver ? new ownerWindow.ResizeObserver(() => {
    const next = dimensions();
    if (next !== size) { size = next; settle(); }
  }) : null;
  observer?.observe(container); observer?.observe(node);
  place(ownerWindow.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth');
  if (ownerWindow.matchMedia?.('(prefers-reduced-motion: reduce)').matches) settle();
  const release = () => {
    interrupted = true; observer?.disconnect(); ownerWindow.cancelAnimationFrame(frame);
    container.removeEventListener('scrollend', settle);
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) container.removeEventListener(name, interrupt);
    container.style.removeProperty(beforeKey); container.style.removeProperty(afterKey);
  };
  // Passive data updates preserve the current viewport and its existing edge
  // space; only a new explicit navigation resets that temporary centre padding.
  release.cancel = () => { interrupted = true; navigating = false; observer?.disconnect(); ownerWindow.cancelAnimationFrame(frame); };
  Object.defineProperty(release, 'navigating', { get: () => navigating });
  return release;
}
