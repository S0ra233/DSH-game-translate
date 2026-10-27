import React, { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePresence } from './Select.jsx';
import { SearchIcon } from './SearchPane.jsx';
import { createProgressAnimation, displayedProgress, PROGRESS_STATES } from './progress-model.js';

const LABELS = { PROCESSED: '已处理', NEEDS_HUMAN: '待复核', NONE: '未翻译', ERROR: '异常' };
const number = new Intl.NumberFormat('zh-CN');
const ARC = 'M12 33.8564 A16 16 0 1 1 28 33.8564';
const setText = (node, value) => { const text = String(value); if (node && node.textContent !== text) node.textContent = text; };

function ProgressArc({ pathRef, svgRef, className = '' }) {
  return <svg ref={svgRef} className={`task-progress-ring ${className}`} viewBox="0 0 40 40" aria-hidden="true">
    <path className="task-progress-track" d={ARC} />
    <path ref={pathRef} className="task-progress-fill" d={ARC} pathLength="100" strokeDasharray="0 100" style={{ opacity: 0 }} />
    <path className="task-progress-check" d="m14.5 20 3.8 3.8 7.5-8" />
  </svg>;
}

/** B / 18 px. Progress updates stay inside this small overlay and SVG. */
export const TaskProgress = memo(function TaskProgress({ project, group, groupLabel, groupId, ready, visible, dismissed, canFilter, onStatus, onOpen, ownerWindow }) {
  const [scope, setScope] = useState('project'), [open, setOpen] = useState(false), [tip, setTip] = useState(false);
  const present = usePresence(open, 160), tipPresent = usePresence(tip, 130), id = useId();
  const owner = useRef(null), button = useRef(null), nodes = useRef({}), controller = useRef(null), hover = useRef(null), suppressed = useRef(false);
  const value = scope === 'group' && groupId ? group : project, latest = useRef(value), animated = useRef(value), previousComplete = useRef(false);
  latest.current = value;
  const summary = useMemo(() => {
    const display = displayedProgress(value);
    return `${display.percent}% 已处理，${number.format(display.counts.PROCESSED)} / ${number.format(display.counts.total)} 项`;
  }, [value]);
  const scopeLabel = scope === 'group' ? groupLabel : '全工程';

  const paint = raw => {
    animated.current = raw;
    const { counts, shares, ratio, percent } = displayedProgress(raw), refs = nodes.current;
    for (const key of ['toolbar', 'detail']) {
      refs[`${key}Path`]?.setAttribute('stroke-dasharray', `${(ratio * 100).toFixed(3)} 100`);
      if (refs[`${key}Path`]) refs[`${key}Path`].style.opacity = ratio > 0 ? '1' : '0';
      refs[`${key}Svg`]?.setAttribute('data-complete', String(ratio >= 1));
    }
    setText(refs.percent, percent); setText(refs.done, number.format(counts.PROCESSED)); setText(refs.total, number.format(counts.total));
    setText(refs.tipValue, `${percent}% 已处理`); setText(refs.tipCount, `${number.format(counts.PROCESSED)} / ${number.format(counts.total)}`);
    for (const status of PROGRESS_STATES) { setText(refs[status], number.format(counts[status])); setText(refs[`${status}Share`], `${shares[status]}%`); }
    setText(refs.manual, counts.manual === null ? '' : `人工修改 ${number.format(counts.manual)}`);
    const complete = ratio >= 1;
    if (!complete) refs.toolbarSvg?.classList.remove('progress-confirm');
    else if (!previousComplete.current) refs.toolbarSvg?.classList.add('progress-confirm');
    previousComplete.current = complete;
  };

  useLayoutEffect(() => {
    const animation = createProgressAnimation({ initial: latest.current,
      requestFrame: callback => ownerWindow.requestAnimationFrame(callback), cancelFrame: frame => ownerWindow.cancelAnimationFrame(frame),
      now: () => ownerWindow.performance.now(), reducedMotion: () => ownerWindow.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      apply: raw => paint(raw) });
    controller.current = animation; animation.set(latest.current, true);
    return () => { animation.dispose(); controller.current = null; };
  }, [ownerWindow]);
  useLayoutEffect(() => { controller.current?.set(value); }, [value]);
  useLayoutEffect(() => { paint(animated.current); }, [present, tipPresent]);
  useLayoutEffect(() => {
    if (!present && !tipPresent) return;
    const root = owner.current?.closest('.dsh-translate');
    const fit = () => {
      if (!root || !button.current) return;
      const bounds = root.getBoundingClientRect(), anchor = button.current.getBoundingClientRect();
      const width = Math.min(316, bounds.width - 24), right = Math.min(bounds.right - 12, anchor.right + 5);
      const left = Math.max(bounds.left + 12, right - width);
      owner.current.style.setProperty('--progress-card-width', `${width}px`);
      owner.current.style.setProperty('--progress-card-right', `${anchor.right - left - width}px`);
      owner.current.style.setProperty('--progress-card-height', `${Math.max(90, bounds.bottom - anchor.bottom - 24)}px`);
    };
    fit(); const resize = ownerWindow.ResizeObserver ? new ownerWindow.ResizeObserver(fit) : null;
    if (root) resize?.observe(root); ownerWindow.addEventListener('resize', fit);
    return () => { resize?.disconnect(); ownerWindow.removeEventListener('resize', fit); };
  }, [present, tipPresent, ownerWindow]);

  const hideTip = () => { ownerWindow.clearTimeout(hover.current); hover.current = null; setTip(false); };
  const close = (focus = false) => {
    suppressed.current = true; hideTip(); setOpen(false);
    if (focus) button.current?.focus({ preventScroll: true });
  };
  const scheduleTip = () => {
    if (!ready || open || suppressed.current || dismissed) return;
    ownerWindow.clearTimeout(hover.current);
    hover.current = ownerWindow.setTimeout(() => { hover.current = null; setTip(true); }, 240);
  };
  useEffect(() => {
    if (dismissed || !ready) close();
    else suppressed.current = false;
  }, [dismissed, ready]);
  useEffect(() => { if (scope === 'group' && !groupId) setScope('project'); }, [scope, groupId]);
  useEffect(() => { if (!visible) { close(); controller.current?.finish(); } }, [visible]);
  useEffect(() => () => ownerWindow.clearTimeout(hover.current), [ownerWindow]);
  useEffect(() => {
    if (!open && !tip) return;
    const outside = event => { if (!owner.current?.contains(event.target)) close(); };
    const key = event => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault(); event.stopImmediatePropagation(); close(open);
    };
    ownerWindow.document.addEventListener('pointerdown', outside, true);
    ownerWindow.document.addEventListener('keydown', key, true);
    return () => { ownerWindow.document.removeEventListener('pointerdown', outside, true); ownerWindow.document.removeEventListener('keydown', key, true); };
  }, [open, tip, ownerWindow]);
  useEffect(() => {
    const media = ownerWindow.matchMedia?.('(prefers-reduced-motion: reduce)');
    const changed = () => { if (media?.matches) controller.current?.finish(); };
    media?.addEventListener?.('change', changed);
    return () => media?.removeEventListener?.('change', changed);
  }, [ownerWindow]);

  return <div ref={owner} className="task-progress-owner" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <button ref={button} className="icon-pill task-progress-entry" type="button" aria-label="任务进度" aria-description={ready ? `${summary}，${scopeLabel}` : undefined}
      title={ready ? undefined : '初始化后查看任务进度'} aria-expanded={open} aria-controls={id} aria-describedby={tip ? `${id}-tip` : undefined} disabled={!ready}
      onPointerEnter={() => { suppressed.current = false; scheduleTip(); }} onPointerLeave={() => { hideTip(); suppressed.current = false; }} onFocus={scheduleTip} onBlur={hideTip}
      onClick={() => { if (open) close(); else { hideTip(); onOpen?.(); setOpen(true); } }}>
      <ProgressArc pathRef={node => { nodes.current.toolbarPath = node; }} svgRef={node => { nodes.current.toolbarSvg = node; }} />
    </button>
    {tipPresent && <div id={`${id}-tip`} role="tooltip" className="task-progress-tip glass-surface" data-open={tip} aria-hidden={!tip}>
      <div><strong ref={node => { nodes.current.tipValue = node; }}>0% 已处理</strong><span ref={node => { nodes.current.tipCount = node; }}>0 / 0</span></div><small>{scopeLabel} · 点击查看详情</small>
    </div>}
    {present && <section id={id} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} className="task-progress-card glass-surface" data-open={open} aria-hidden={!open} inert={open ? undefined : ''}>
      <div className="task-progress-heading"><h2 id={`${id}-title`}>任务进度</h2><button type="button" className="task-progress-close" aria-label="收起进度" onClick={() => close(true)}><SearchIcon name="close" /></button></div>
      <div className="task-progress-scope segments" role="group" aria-label="进度范围">{[['project','全工程'],['group','当前阅读组']].map(([key,label]) => <button type="button" key={key} className={scope === key ? 'selected' : ''} aria-pressed={scope === key} disabled={key === 'group' && !groupId} onClick={() => setScope(key)}>{label}</button>)}</div>
      <div className="task-progress-overview"><div><div className="task-progress-number"><span ref={node => { nodes.current.percent = node; }}>0</span><span>%</span></div><p><span ref={node => { nodes.current.done = node; }}>0</span> / <span ref={node => { nodes.current.total = node; }}>0</span> 项已处理</p></div>
        <ProgressArc className="task-progress-detail" pathRef={node => { nodes.current.detailPath = node; }} svgRef={node => { nodes.current.detailSvg = node; }} />
      </div>
      <div className="task-progress-states">{PROGRESS_STATES.map(status => <button key={status} type="button" className="task-progress-state" data-progress-status={status} aria-label={`查看${LABELS[status]}任务`} disabled={!canFilter} onClick={() => { if (onStatus(status, scope) !== false) close(); }}>
        <i /><span className="task-progress-label">{LABELS[status]}</span><strong ref={node => { nodes.current[status] = node; }}>0</strong><small ref={node => { nodes.current[`${status}Share`] = node; }}>0%</small><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      </button>)}</div>
      <footer className="task-progress-footer"><span title={scope === 'group' ? groupLabel : undefined}>{scope === 'group' ? groupLabel : '全部阅读组'}</span><span ref={node => { nodes.current.manual = node; }} /></footer>
      <span className="task-progress-announcement" role="status" aria-live="polite">{summary}</span>
    </section>}
  </div>;
});
