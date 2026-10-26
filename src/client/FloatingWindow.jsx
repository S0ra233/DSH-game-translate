import React, { useEffect, useRef, useState } from 'react';
import { App } from './App.jsx';
import { fitRect, initialRect, maximizedRect } from './window-state.js';

/** 客户端禁止 window.open 时仍提供真实可拖动、最大化/还原的宿主内窗口。 */
export function FloatingWindow({ api, sessionId, onClose }) {
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  const [rect, setRect] = useState(() => initialRect(viewport()));
  const [maximized, setMaximized] = useState(false), [size, setSize] = useState(viewport);
  const drag = useRef(null), geometry = useRef(rect);
  geometry.current = rect;
  useEffect(() => {
    const resize = () => { const next = viewport(); setSize(next); setRect(value => fitRect(value, next)); };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const toggle = () => { drag.current = null; setMaximized(value => !value); };
  const headerProps = {
    onPointerDown(event) {
      if (event.button !== 0 || event.target.closest('button,select,input,a,[role="menu"]')) return;
      const start = maximized ? fitRect({ ...geometry.current, x: event.clientX-geometry.current.width/2, y: event.clientY-30 }, viewport()) : geometry.current;
      if (maximized) { setMaximized(false); setRect(start); }
      drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, rect: start };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    onPointerMove(event) {
      const active = drag.current;
      if (!active || active.pointer !== event.pointerId) return;
      setRect(fitRect({ ...active.rect, x: active.rect.x+event.clientX-active.x, y: active.rect.y+event.clientY-active.y }, viewport()));
    },
    onPointerUp(event) {
      if (drag.current?.pointer !== event.pointerId) return;
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onLostPointerCapture() { drag.current = null; },
    onPointerCancel() { drag.current = null; },
    onDoubleClick(event) { if (!event.target.closest('button,select,input')) toggle(); },
  };
  const visible = maximized ? maximizedRect(size) : rect;
  return <div className="dsh-translation-floating" style={{ position: 'fixed', left: visible.x, top: visible.y,
    width: visible.width, height: visible.height, zIndex: 2147483000, pointerEvents: 'auto' }}>
    <App api={api} sessionId={sessionId} onClose={onClose} onExpand={toggle} maximized={maximized} headerProps={headerProps} />
  </div>;
}
