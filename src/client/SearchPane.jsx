import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select } from './Select.jsx';
import { SearchText } from './Reader.jsx';
import { parseSearchTerms, rowSearchTerms } from './search-text.js';

const LABELS = { name: '人名', source: '原文', target: '译文' };
const STATUS = { NONE: '未翻译', NEEDS_HUMAN: '待复核', PROCESSED: '已处理', ERROR: '异常' };
const EMPTY = { name: '', source: '', target: '' };
const ALL = { name: 'all', source: 'all', target: 'all' };

export function SearchIcon({ name }) {
  const paths = { search: 'M16 16l4 4M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0', close: 'M6 6l12 12M18 6 6 18',
    panel: 'M15 4v16M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    filter: 'M4 6h5m4 0h7M4 12h9m4 0h3M4 18h2m4 0h10M9 4v4m4 2v4m-7 2v4',
    settings: 'M4 6h16M4 12h16M4 18h16M9 3v6m6 0v6m-6 0v6', up: 'm6 15 6-6 6 6', down: 'm6 9 6 6 6-6' };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function SearchPane({ api, projectId, groupId, stamp, open, present, onClose, onResults, onLocate, locatedTask, ownerWindow, filterRequest }) {
  const [fields, setFields] = useState(EMPTY), [termModes, setTermModes] = useState(ALL), [relation, setRelation] = useState('all');
  const [statuses, setStatuses] = useState([]), [manual, setManual] = useState(false), [scope, setScope] = useState(false), [punctuation, setPunctuation] = useState(false);
  const [filters, setFilters] = useState(false), [settings, setSettings] = useState(false), [composing, setComposing] = useState(false);
  const [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [nonce, setNonce] = useState(0);
  const [cursor, setCursor] = useState(null), [history, setHistory] = useState([]);
  const epoch = useRef(0), settingsOwner = useRef(null), list = useRef(null), fieldInput = useRef(null), retry = useRef(0);
  const client = useRef(`search-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const query = useMemo(() => ({ fields: Object.fromEntries(Object.keys(LABELS).map(key => [key, { text: fields[key], relation: termModes[key] }])),
    relation, statuses, manual, scope: scope ? 'group' : 'project', group_id: scope ? groupId : '', punctuation }), [fields, termModes, relation, statuses, manual, scope, groupId, punctuation]);
  const queryText = JSON.stringify(query);
  const previous = useRef({ queryText, stamp });
  const reset = action => { setCursor(null); setHistory([]); retry.current = 0; action(); };
  useEffect(() => {
    if (!filterRequest || !STATUS[filterRequest.status]) return;
    reset(() => { setFields(EMPTY); setTermModes(ALL); setRelation('all'); setStatuses([filterRequest.status]); setManual(false); setScope(filterRequest.scope === 'group'); setFilters(true); setSettings(false); });
  }, [filterRequest]);
  const parsed = Object.fromEntries(Object.keys(LABELS).map(key => [key, parseSearchTerms(fields[key], punctuation)]));

  useEffect(() => {
    if (!open || !projectId || composing || ownerWindow.document.hidden) return;
    if ((previous.current.queryText !== queryText || previous.current.stamp !== stamp) && cursor) {
      previous.current = { queryText, stamp }; setCursor(null); setHistory([]); return;
    }
    previous.current = { queryText, stamp };
    const invalid = Object.values(parsed).find(value => value.error);
    if (invalid) { setError(invalid.error); setBusy(false); return; }
    const id = ++epoch.current; let timer;
    setBusy(true); setError('');
    timer = ownerWindow.setTimeout(async () => {
      try {
        const next = await api('search-query', { project_id: projectId, query, cursor, limit: 40, client_id: client.current });
        if (id !== epoch.current || next.project_id !== projectId) return;
        retry.current = 0; setResult(next); setBusy(false); onResults(next.hits);
        if (list.current && next.query_key !== result?.query_key) list.current.scrollTop = 0;
      } catch (failure) {
        if (id !== epoch.current) return;
        const detail = searchError(failure);
        if (['search_stale', 'search_updating', 'busy'].includes(detail.code) && retry.current++ < 3) {
          setCursor(null); setHistory([]); timer = ownerWindow.setTimeout(() => setNonce(n => n + 1), 450); return;
        }
        if (detail.code !== 'cancelled') setError(detail.message);
        setBusy(false);
      }
    }, 150);
    return () => { ++epoch.current; ownerWindow.clearTimeout(timer); };
  }, [open, projectId, queryText, stamp, cursor, composing, nonce, api, ownerWindow, onResults]);

  useEffect(() => {
    const focus = () => { if (open && !ownerWindow.document.hidden) setNonce(n => n + 1); };
    const release = () => { ++epoch.current; void api('search-close', { project_id: projectId, client_id: client.current }).catch(() => {}); };
    const visibility = () => ownerWindow.document.hidden ? release() : focus();
    const unsubscribe = api.subscribe?.(event => { if (event === 'window-hidden') release(); else if (open) focus(); });
    ownerWindow.addEventListener('focus', focus); ownerWindow.document.addEventListener('visibilitychange', visibility);
    if (!open) setSettings(false);
    return () => { ownerWindow.removeEventListener('focus', focus); ownerWindow.document.removeEventListener('visibilitychange', visibility); unsubscribe?.(); if (open) release(); };
  }, [api, open, projectId, ownerWindow]);

  useEffect(() => {
    if (!settings) return;
    const outside = event => { if (!settingsOwner.current?.contains(event.target)) setSettings(false); };
    ownerWindow.document.addEventListener('pointerdown', outside, true);
    return () => ownerWindow.document.removeEventListener('pointerdown', outside, true);
  }, [settings, ownerWindow]);

  const hits = result?.hits ?? [], position = hits.findIndex(hit => hit.task_id === locatedTask);
  const select = async hit => {
    if (busy || error || !hit) return;
    try {
      const accepted = await onLocate({ ...hit, generation: result.generation, query, client_id: client.current });
      if (accepted && ownerWindow.innerWidth <= 900) onClose();
    } catch (failure) {
      const detail = searchError(failure);
      if (detail.code === 'search_stale') { setCursor(null); setHistory([]); setNonce(n => n + 1); }
      else setError(detail.message);
    }
  };
  const navigate = direction => { const index = position < 0 ? (direction < 0 ? hits.length - 1 : 0) : position + direction; if (hits[index]) void select(hits[index]); };
  useEffect(() => {
    const key = event => {
      if (event.defaultPrevented || event.isComposing) return;
      if (open && event.key === 'Escape') { event.preventDefault(); settings ? setSettings(false) : onClose(); }
      else if (event.key === 'F3' && hits.length) { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); }
    };
    ownerWindow.addEventListener('keydown', key);
    return () => ownerWindow.removeEventListener('keydown', key);
  });

  const activeFields = Object.values(parsed).filter(value => value.terms.length).length;
  const filterCount = (statuses.length === 4 ? 0 : statuses.length) + Number(manual);
  return <aside className="search-pane" data-present={Boolean(present)} data-open={open} aria-label="检索" aria-hidden={!open} inert={open ? undefined : ''}>
    <div className="search-heading"><h2>检索</h2><button type="button" className="search-icon" aria-label="收起检索" title="收起检索 · Esc" onClick={onClose}><SearchIcon name="panel" /></button></div>
    <div className="search-query">
      {Object.entries(LABELS).map(([key, label]) => <div key={key} className="search-field">
        <label><span>{label}</span><input ref={key === 'target' ? fieldInput : undefined} value={fields[key]} maxLength={2048} aria-label={`检索${label}`} placeholder={key === 'name' ? '原名或译名' : `查找${label}内容`}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onChange={event => reset(() => setFields(value => ({ ...value, [key]: event.target.value })))} /></label>
        {fields[key] && <button type="button" className="search-clear-field" aria-label={`清空${label}`} onClick={() => reset(() => setFields(value => ({ ...value, [key]: '' })))}><SearchIcon name="close" /></button>}
        {parsed[key].terms.length > 1 && <Select className="search-word-mode" aria-label={`${label}词间关系`} value={termModes[key]} onChange={event => reset(() => setTermModes(value => ({ ...value, [key]: event.target.value })))}><option value="all">全部词</option><option value="any">任一词</option></Select>}
      </div>)}
      {activeFields > 1 && <div className="search-combine"><span>字段关系</span><div className="segments">{[['all', '全部满足'], ['any', '任一满足']].map(([id, label]) => <button key={id} type="button" className={relation === id ? 'selected' : ''} aria-pressed={relation === id} onClick={() => reset(() => setRelation(id))}>{label}</button>)}</div></div>}
      <div className="search-filter-bar"><button type="button" aria-expanded={filters} aria-controls="search-filters" onClick={() => setFilters(value => !value)}><SearchIcon name="filter" />筛选{filterCount > 0 && <small>{filterCount}</small>}<SearchIcon name={filters ? 'up' : 'down'} /></button>
        <span className="search-summary">{!filters && [...statuses.map(s => STATUS[s]), ...(manual ? ['人工修改'] : [])].join(' · ')}</span>
        {(activeFields > 0 || filterCount > 0) && <button className="search-text-button" type="button" onClick={() => reset(() => { setFields(EMPTY); setStatuses([]); setManual(false); })}>清空</button>}
        <div className="search-settings-owner" ref={settingsOwner}><button type="button" className="search-icon" aria-label="检索设置" aria-expanded={settings} onClick={() => setSettings(value => !value)}><SearchIcon name="settings" /></button>
          {settings && <div className="search-settings glass-surface"><strong>检索设置</strong><label><input type="checkbox" checked={scope} onChange={event => reset(() => setScope(event.target.checked))} />限定当前显示</label><label><input type="checkbox" checked={punctuation} onChange={event => reset(() => setPunctuation(event.target.checked))} />标点分隔关键词</label><small>空格分词，双引号保留完整短语。</small></div>}
        </div>
      </div>
      {filters && <div id="search-filters" className="search-filters"><div>{Object.entries(STATUS).map(([id, label]) => <button key={id} role="checkbox" aria-checked={statuses.includes(id)} type="button" onClick={() => reset(() => setStatuses(value => value.includes(id) ? value.filter(s => s !== id) : [...value, id]))}>{statuses.includes(id) && <span aria-hidden="true">✓ </span>}{label}</button>)}</div><label><input type="checkbox" checked={manual} onChange={event => reset(() => setManual(event.target.checked))} />人工修改</label></div>}
      {error && <div className="search-error" role="alert">{error}<button type="button" onClick={() => setNonce(n => n + 1)}>重试</button></div>}
    </div>
    <div className="search-result-heading"><span>{busy && <i className="small-spinner" />}<strong>{busy ? (result ? '查找中…' : '准备检索…') : result?.active ? (result.total !== null ? `${result.total} 处` : `至少 ${history.length * 40 + hits.length} 处`) : '开始检索'}</strong></span><small>{scope ? '当前阅读组' : '全工程'}</small></div>
    <div className="search-result-list" ref={list} aria-busy={busy}>
      {!hits.length && <div className="search-empty"><SearchIcon name="search" /><strong>{busy ? '正在准备检索…' : result?.active ? '没有符合条件的内容' : '查找这一段故事'}</strong><span>{result?.active ? '可以减少关键词，或调整筛选。' : '输入关键词，或选择状态筛选。'}</span></div>}
      {hits.map(hit => {
        const terms = rowSearchTerms({ task: { id: hit.task_id, type: hit.kind }, speakerTask: { id: hit.speaker_task_id } }, hit);
        return <button key={hit.anchor} type="button" className="search-result" aria-current={locatedTask === hit.task_id} disabled={busy || Boolean(error)} onClick={() => void select(hit)}>
          <div className="search-result-meta"><span>{hit.label}</span>{hit.matches.some(match => match.status === 'NEEDS_HUMAN') && <small>待复核</small>}{hit.matches.some(match => match.manual) && <small>人工修改</small>}</div>
          <p className="search-source"><span className="speaker"><SearchText text={hit.speaker_source} terms={terms.sourceName} /> </span><SearchText text={hit.source} terms={terms.source} /></p>
          <p><span className="speaker"><SearchText text={hit.speaker_target || hit.speaker_source} terms={terms.targetName} /> </span>{hit.target ? <SearchText text={hit.target} terms={terms.target} /> : <span className="search-missing">译文留白</span>}</p>
        </button>;
      })}
      {(history.length > 0 || result?.next_cursor) && <div className="search-pages"><button type="button" disabled={busy || !history.length} onClick={() => { const previous = history.at(-1); setHistory(value => value.slice(0, -1)); setCursor(previous); }}>上一页</button><span>第 {history.length + 1} 页</span><button type="button" disabled={busy || !result?.next_cursor} onClick={() => { setHistory(value => [...value, cursor]); setCursor(result.next_cursor); }}>下一页</button></div>}
    </div>
    <footer className="search-footer"><span>按原文顺序</span><div><span>{position >= 0 ? `${position + 1} / ${hits.length}` : ''}</span><button type="button" className="search-icon" aria-label="上一处" disabled={busy || position <= 0} onClick={() => navigate(-1)}><SearchIcon name="up" /></button><button type="button" className="search-icon" aria-label="下一处" disabled={busy || !hits.length || position === hits.length - 1} onClick={() => navigate(1)}><SearchIcon name="down" /></button></div></footer>
  </aside>;
}

export function searchError(error) {
  try { const value = JSON.parse(error.message); return value.error ?? { message: error.message }; }
  catch { return { message: error.message }; }
}

export function SearchSplitter({ width, onChange }) {
  const [delta, setDelta] = useState(null), drag = useRef(null);
  const finish = () => { if (!drag.current) return; onChange(Math.min(520, Math.max(340, drag.current.width - (delta ?? 0)))); drag.current = null; setDelta(null); };
  return <div className="search-splitter" role="separator" aria-label="调整检索栏宽度" aria-orientation="vertical" aria-valuemin={340} aria-valuemax={520} aria-valuenow={width} tabIndex={0}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onChange(Math.min(520, Math.max(340, width + (event.key === 'ArrowLeft' ? 16 : -16)))); } }}
    onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, width }; setDelta(0); }}
    onPointerMove={event => { if (drag.current) setDelta(Math.max(drag.current.width - 520, Math.min(drag.current.width - 340, event.clientX - drag.current.x))); }} onPointerUp={finish} onPointerCancel={finish}>
    {delta !== null && <i style={{ transform: `translateX(${delta}px)` }} />}
  </div>;
}
