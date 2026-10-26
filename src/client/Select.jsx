import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function usePresence(value, ms = 180) {
  const [last, setLast] = useState(value);
  useEffect(() => {
    if (value) { setLast(value); return; }
    const timer = setTimeout(() => setLast(null), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value || last;
}

/** One toggle/focus contract for native-window and browser controls. */
export function Select({ children, value, onChange, className = '', disabled, 'aria-label': label, ...props }) {
  const items = useMemo(() => React.Children.toArray(children).flatMap(child => child?.type === 'option'
    ? [{ value: String(child.props.value ?? child.props.children), label: child.props.children, disabled: child.props.disabled, title: child.props.title }] : []), [children]);
  const selected = items.findIndex(item => item.value === String(value));
  const [open, setOpen] = useState(false), [active, setActive] = useState(Math.max(0, selected)), [position, setPosition] = useState(null);
  const present = usePresence(open), trigger = useRef(null), popup = useRef(null), native = useRef(null), optionRefs = useRef([]), typeahead = useRef(''), typeTimer = useRef(null);
  const id = useId(), blocked = disabled || !items.length;
  const root = trigger.current?.closest('.dsh-translate');
  const close = () => setOpen(false);
  const show = () => { if (!blocked) { setActive(Math.max(0, selected)); setOpen(true); } };
  const choose = index => {
    const item = items[index]; if (!item || item.disabled) return;
    close();
    if (item.value !== String(value)) onChange?.({ target: { value: item.value }, currentTarget: native.current });
    trigger.current?.focus();
  };
  useEffect(() => { if (blocked) close(); }, [blocked]);
  useEffect(() => () => clearTimeout(typeTimer.current), []);
  useLayoutEffect(() => {
    if (!open || !root) return;
    const doc = trigger.current.ownerDocument, win = doc.defaultView;
    const measure = () => {
      const rect = trigger.current.getBoundingClientRect(), host = root.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 180), host.width - 16);
      const below = host.bottom - rect.bottom - 12, above = rect.top - host.top - 12;
      const up = below < Math.min(240, items.length * 36 + 12) && above > below;
      const height = Math.max(48, Math.min(280, up ? above : below));
      const wanted = Math.min(height, items.length * 36 + 12);
      setPosition({ left: Math.max(8, Math.min(rect.left - host.left, host.width - width - 8)),
        top: up ? rect.top - host.top - wanted - 6 : rect.bottom - host.top + 6, width, maxHeight: height, direction: up ? 'up' : 'down' });
    };
    const outside = event => { if (!trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) close(); };
    const scrolled = event => { if (!popup.current?.contains(event.target)) close(); };
    const blur = () => close();
    measure(); doc.addEventListener('pointerdown', outside, true); doc.addEventListener('scroll', scrolled, true); win.addEventListener('resize', measure); win.addEventListener('blur', blur);
    return () => { doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('scroll', scrolled, true); win.removeEventListener('resize', measure); win.removeEventListener('blur', blur); };
  }, [open, root, items.length]);
  useLayoutEffect(() => { if (open) optionRefs.current[active]?.scrollIntoView({ block: 'nearest' }); }, [open, active, position]);
  const key = event => {
    if (blocked) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open ? choose(active) : show(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) { show(); return; }
      const step = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
      let next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (active + step + items.length) % items.length;
      for (let n = 0; items[next]?.disabled && n < items.length; n++) next = (next + step + items.length) % items.length;
      setActive(next); return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeahead.current += event.key.toLocaleLowerCase(); clearTimeout(typeTimer.current);
      typeTimer.current = setTimeout(() => { typeahead.current = ''; }, 600);
      const found = items.findIndex(item => !item.disabled && String(item.label).toLocaleLowerCase().startsWith(typeahead.current));
      if (found >= 0) { event.preventDefault(); setOpen(true); setActive(found); }
    }
  };
  return <span className={`select-control${className.includes('scene-pill') ? ' scene-select' : ''}`}>
    <button {...props} ref={trigger} type="button" role="combobox" className={`select-trigger ${className}`} disabled={blocked}
      aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={present ? id : undefined} aria-activedescendant={open ? `${id}-${active}` : undefined}
      title={props.title ?? items[selected]?.title} onKeyDown={key} onClick={event => { event.preventDefault(); event.stopPropagation(); open ? close() : show(); }}>
      <span>{items[selected]?.label ?? '请选择'}</span><svg className="select-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
    </button>
    <select ref={native} hidden aria-hidden="true" tabIndex={-1} className={className} value={value} onChange={onChange} disabled={disabled}>{children}</select>
    {present && root && position && createPortal(<div ref={popup} id={id} role="listbox" aria-label={label} aria-hidden={!open} inert={open ? undefined : ''} className="select-popover glass-surface" data-open={open} data-direction={position.direction} style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}>
      {items.map((item, index) => <button ref={node => { optionRefs.current[index] = node; }} key={item.value} id={`${id}-${index}`} role="option" type="button" tabIndex={-1}
        aria-selected={index === selected} disabled={item.disabled} className={`select-option${index === active ? ' active' : ''}`} title={item.title}
        onPointerDown={event => event.preventDefault()} onPointerMove={() => { if (active !== index) setActive(index); }} onClick={event => { event.preventDefault(); event.stopPropagation(); choose(index); }}>
        <span>{item.label}</span>{index === selected && <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10 3 3 7-7" /></svg>}
      </button>)}
    </div>, root)}
  </span>;
}
