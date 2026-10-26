import React, { useEffect, useMemo, useRef, useState } from 'react';
import { readingRows, saveTranslation } from './reading-rows.js';

export const PairedText = React.memo(function PairedText({ tasks, sections, api, projectId, onEditing, onSaved }) {
  const rows = useMemo(() => readingRows(tasks), [tasks]);
  const byScene = useMemo(() => {
    const result = new Map();
    for (const row of rows) { const id = row.task.scene_id; if (!result.has(id)) result.set(id, []); result.get(id).push(row); }
    return result;
  }, [rows]);
  const render = row => <ReadingRow key={row.task.id} row={row} api={api} projectId={projectId} onEditing={onEditing} onSaved={onSaved} />;
  const locate = (event, id) => {
    const container = event.currentTarget.closest('.paired-text');
    [...container.querySelectorAll('[data-scene-section]')].find(node => node.dataset.sceneSection === id)?.scrollIntoView({ block: 'start' });
  };
  return <div className="paired-text">
    {sections?.length > 1 && <details className="reading-outline"><summary>{sections.length} 个来源片段 · 展开定位</summary><div>{sections.map(section => <button type="button" key={section.id} disabled={!byScene.has(section.id)} onClick={event => locate(event, section.id)}>{section.short_title} · {section.paragraph_count} 段</button>)}</div></details>}
    {sections?.length ? sections.filter(section => byScene.has(section.id)).map(section => <React.Fragment key={section.id}>
      <div className="reading-section" data-scene-section={section.id} title={section.title}><span>{section.short_title}</span><small>{section.boundary} · {section.paragraph_count} 段</small></div>
      {byScene.get(section.id).map(render)}
    </React.Fragment>) : rows.map(render)}
  </div>;
});

function ReadingRow({ row: { task, speakerTask }, api, projectId, onEditing, onSaved }) {
  const [editing, setEditing] = useState(null), [value, setValue] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const textarea = useRef(null), active = useRef(false);
  const sourceSpeaker = speakerTask?.text || task.speaker || '';
  const targetSpeaker = speakerTask?.translation || sourceSpeaker;
  const dialogue = Boolean(sourceSpeaker);
  useEffect(() => () => { if (active.current) onEditing(task.id, false); }, [onEditing, task.id]);
  useEffect(() => { if (editing) { textarea.current?.focus(); textarea.current?.select(); } }, [editing]);
  const start = target => {
    if (!api || editing) return;
    if (onEditing(task.id, true) === false) return;
    active.current = true; setEditing({ ...target }); setValue(target.translation || ''); setError('');
  };
  const close = () => { active.current = false; onEditing(task.id, false); setEditing(null); setError(''); };
  const cancel = () => { close(); onSaved(); };
  const changeTarget = () => {
    if (saving || value !== (editing.translation || '')) return;
    const target = editing.id === task.id ? speakerTask : task;
    if (target) { setEditing({ ...target }); setValue(target.translation || ''); setError(''); }
  };
  const save = async () => {
    if (saving) return;
    if (value === editing.translation && editing.status === 'PROCESSED') { close(); onSaved(); return; }
    setSaving(true); setError('');
    try {
      const result = await saveTranslation(api, projectId, editing, value);
      close(); onSaved(result.task);
    } catch (failure) {
      let message = failure.message;
      try { message = JSON.parse(message).error?.message || message; } catch {}
      setError(message);
    } finally { setSaving(false); }
  };
  return <div className="text-pair" data-task-id={task.id}>
    <p><Speaker name={sourceSpeaker} />{dialogue ? '[' : ''}<span>{task.text}</span>{dialogue ? ']' : ''}</p>
    <div className="translation-cell">
      {editing ? <form className="translation-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
        <textarea ref={textarea} aria-label={editing.id === speakerTask?.id ? '修改译文中的人名' : '修改译文'} value={value} maxLength={60000} disabled={saving}
          onChange={event => setValue(event.target.value)} onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) cancel(); }
            else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
          }} />
        {error && <div className="edit-error" role="alert">{error}</div>}
        <div className="edit-actions">{speakerTask && <button className="edit-target" type="button" onClick={changeTarget} disabled={saving || value !== (editing.translation || '')} title={value !== (editing.translation || '') ? '请先保存或取消当前修改' : undefined}>{editing.id === task.id ? '修改人名' : '修改台词'}</button>}<button type="button" onClick={cancel} disabled={saving}>取消</button><button className="primary" type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button></div>
      </form> : <><p className="editable-translation" aria-label="译文">
        {task.translation && <><Speaker name={targetSpeaker} />{dialogue ? '[' : ''}<span>{task.translation}</span>{dialogue ? ']' : ''}</>}
        {task.status === 'NEEDS_HUMAN' && <span className="review-marker" title={task.review_reason}>待复核</span>}
      </p>{api && <button className="translation-edit-button" type="button" aria-label="修改译文" title="修改译文" onClick={() => start(task)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" /></svg></button>}</>}
    </div>
  </div>;
}

function Speaker({ name }) { return name ? <span className="speaker">{name} </span> : null; }
