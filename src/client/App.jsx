import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_APPEARANCE as DEFAULTS, cleanAppearance, glassStyle } from '../appearance.js';
import { createMaterialAnimation } from './material-animation.js';
import { coalesceRefresh } from './refresh-queue.js';
import { readReadingGroupPages } from './scene-reader.js';
import { PairedText } from './Reader.jsx';
import { Select, usePresence } from './Select.jsx';

const PROTOCOLS = [['openai-completions', 'OpenAI Chat Completions'], ['openai-responses', 'OpenAI Responses'],
  ['anthropic-messages', 'Anthropic Messages'], ['google-generative-ai', 'Gemini generateContent']];
const STORAGE = 'dsh-translate.appearance.v1';

export function App({ api, sessionId, ownerWindow = window, onClose, onExpand, maximized = false, headerProps, nativeChrome = false, onNativeAppearance, onNativePreview, nativeMaterial = false }) {
  const [preferences, setPreferences] = useState(() => {
    try { return cleanAppearance(JSON.parse(ownerWindow.localStorage.getItem(STORAGE) ?? '{}')); } catch { return DEFAULTS; }
  });
  const [snapshot, setSnapshot] = useState(null), [scenes, setScenes] = useState([]), [sceneId, setSceneId] = useState('');
  const [tasks, setTasks] = useState([]), [menu, setMenu] = useState(false), [dialog, setDialog] = useState(null);
  const shownMenu = usePresence(menu), shownDialog = usePresence(dialog);
  const [sections, setSections] = useState([]);
  const [readingScene, setReadingScene] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [settingsTab, setSettingsTab] = useState('appearance'), [selected, setSelected] = useState([]), [mode, setMode] = useState('main');
  const [modelId, setModelId] = useState(''), [modelForm, setModelForm] = useState(emptyModel), [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(false), [output, setOutput] = useState('');
  const [nativeExpanded, setNativeExpanded] = useState(false);
  const [adjustingFrost, setAdjustingFrost] = useState(false);
  const [editingCount, setEditingCount] = useState(0);
  const editors = useRef(new Set());
  const onEditing = useCallback((id, active) => {
    if (active && editors.current.size && !editors.current.has(id)) return false;
    active ? editors.current.add(id) : editors.current.delete(id);
    setEditingCount(editors.current.size);
    return true;
  }, []);
  const frostAnimation = useRef(null), latestFrost = useRef(preferences);
  latestFrost.current = preferences;
  const expanded = onExpand ? maximized : nativeExpanded;
  const last = useRef(''), root = useRef(null), menuOwner = useRef(null), refreshEpoch = useRef(0), sceneEpoch = useRef(0), currentScene = useRef('');
  const snapshotStamp = useRef('');
  const initialized = Boolean(snapshot?.state.binding), ready = snapshot?.state.binding?.phase === 'project_ready';
  const pending = Boolean(snapshot?.state.pending), models = snapshot?.models ?? [];
  const pendingScenes = useMemo(() => scenes.filter(row => Object.entries(row.counts ?? {}).some(([status, count]) => status !== 'PROCESSED' && count > 0)), [scenes]);
  const sceneOptions = useMemo(() => scenes.map(row => <option key={row.id} value={row.id} title={row.file}>{row.title || row.id}</option>), [scenes]);
  currentScene.current = sceneId;

  const savePreference = changes => {
    const value = cleanAppearance({ ...preferences, ...changes });
    setPreferences(value);
  };

  useLayoutEffect(() => {
    if (nativeMaterial) return;
    const animation = createMaterialAnimation({ initial: latestFrost.current,
      requestFrame: callback => ownerWindow.requestAnimationFrame(callback), cancelFrame: id => ownerWindow.cancelAnimationFrame(id),
      now: () => ownerWindow.performance.now(), reducedMotion: () => ownerWindow.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      apply: value => {
        for (const [key, token] of Object.entries(glassStyle(value))) root.current?.style.setProperty(key, String(token));
        onNativePreview?.(value);
      } });
    frostAnimation.current = animation;
    return () => { animation.dispose(); frostAnimation.current = null; };
  }, [nativeChrome, onNativePreview, ownerWindow, nativeMaterial]);

  useLayoutEffect(() => {
    if (nativeMaterial) onNativePreview?.({ surface: preferences.surface, milk: preferences.milk, softLight: preferences.softLight });
  }, [nativeMaterial, onNativePreview, preferences.surface, preferences.milk, preferences.softLight]);

  useLayoutEffect(() => { frostAnimation.current?.set(preferences); }, [preferences.milk, preferences.softLight]);

  useEffect(() => {
    if (!adjustingFrost) return;
    const finish = () => setAdjustingFrost(false);
    for (const name of ['pointerup', 'pointercancel', 'blur']) ownerWindow.addEventListener(name, finish);
    return () => { for (const name of ['pointerup', 'pointercancel', 'blur']) ownerWindow.removeEventListener(name, finish); };
  }, [adjustingFrost, ownerWindow]);

  useEffect(() => {
    if (adjustingFrost) return;
    const timer = ownerWindow.setTimeout(() => {
      try { ownerWindow.localStorage.setItem(STORAGE, JSON.stringify(preferences)); } catch { setNotice('外观已生效，但浏览器未允许保存偏好。'); }
      if (onNativeAppearance) Promise.resolve(onNativeAppearance(preferences)).catch(() => setNotice('外观已生效，原生外观记录未能保存。'));
    }, 250);
    return () => ownerWindow.clearTimeout(timer);
  }, [preferences, onNativeAppearance, ownerWindow, adjustingFrost]);

  const readScene = useCallback(async (id, projectId) => {
    const epoch = ++sceneEpoch.current;
    setReadingScene(true);
    try { await readReadingGroupPages({ api, projectId, groupId: id, current: () => epoch === sceneEpoch.current, publish: setTasks, sections: setSections }); }
    finally { if (epoch === sceneEpoch.current) setReadingScene(false); }
  }, [api]);

  const readSnapshot = useCallback(async () => {
    if (editors.current.size) return;
    const epoch = ++refreshEpoch.current;
    const value = await api('snapshot');
    if (editors.current.size) return;
    if (epoch !== refreshEpoch.current) return;
    const serialized = JSON.stringify(value);
    if (serialized !== snapshotStamp.current) { snapshotStamp.current = serialized; setSnapshot(value); }
    setError('');
    const key = `${value.state.binding?.project_id ?? ''}:${value.state.version}:${value.stamp}`;
    if (key === last.current) return;
    last.current = key;
    if (value.state.binding?.phase !== 'project_ready') { sceneEpoch.current++; setReadingScene(false); setScenes([]); setSceneId(''); setTasks([]); setSections([]); return; }
    const all = []; let offset = 0;
    do {
      const result = await api('reading-groups', { project_id: value.state.binding.project_id, offset, limit: 200 });
      if (epoch !== refreshEpoch.current) return;
      all.push(...result.groups); offset = result.next_offset;
    } while (offset !== null);
    setScenes(all);
    let stored = null;
    try { stored = ownerWindow.localStorage.getItem(`dsh-translate.group:${sessionId}:${value.state.binding.project_id}`) ?? ownerWindow.localStorage.getItem(`dsh-translate.scene:${sessionId}`); } catch {}
    const match = id => all.find(row => row.id === id || row.scene_ids?.includes(id));
    const chosen = (match(currentScene.current) ?? match(stored) ?? all[0])?.id ?? '';
    setSceneId(chosen);
    if (chosen) void readScene(chosen, value.state.binding.project_id).catch(failure => { last.current = ''; setError(toMessage(failure)); });
  }, [api, ownerWindow, readScene, sessionId]);
  const refresh = useMemo(() => coalesceRefresh(readSnapshot), [readSnapshot]);
  const edited = useCallback(task => {
    sceneEpoch.current++; refreshEpoch.current++;
    if (task) setTasks(rows => rows.map(row => row.id === task.id ? task : row));
    last.current = ''; void refresh().catch(failure => setError(toMessage(failure)));
  }, [refresh]);

  useEffect(() => {
    let closed = false, timer;
    const tick = async () => {
      try { if (!ownerWindow.document.hidden) await refresh(); }
      catch (failure) { last.current = ''; if (!closed) setError(toMessage(failure)); }
    };
    const changed = name => {
      ownerWindow.clearTimeout(timer);
      if (name === 'window-hidden') { refresh.cancelPending(); setMenu(false); setDialog(null); setModelForm(emptyModel()); setShowKey(false); return; }
      timer = ownerWindow.setTimeout(tick, 350);
    };
    const unsubscribe = api.subscribe?.(changed);
    ownerWindow.addEventListener('focus', changed);
    void tick();
    return () => { closed = true; refresh.cancelPending(); unsubscribe?.(); ownerWindow.removeEventListener('focus', changed); ownerWindow.clearTimeout(timer); refreshEpoch.current++; sceneEpoch.current++; };
  }, [api, refresh, ownerWindow]);

  useEffect(() => {
    const changed = () => setNativeExpanded(Boolean(ownerWindow.document.fullscreenElement));
    ownerWindow.document.addEventListener('fullscreenchange', changed);
    return () => ownerWindow.document.removeEventListener('fullscreenchange', changed);
  }, [ownerWindow]);

  useEffect(() => {
    const key = event => {
      if (event.key === 'Escape') { setMenu(false); setDialog(null); setShowKey(false); }
    };
    ownerWindow.addEventListener('keydown', key);
    return () => ownerWindow.removeEventListener('keydown', key);
  }, [ownerWindow]);

  useEffect(() => {
    if (!menu) return;
    const outside = event => { if (!event.composedPath().includes(menuOwner.current)) setMenu(false); };
    ownerWindow.document.addEventListener('pointerdown', outside, true);
    return () => ownerWindow.document.removeEventListener('pointerdown', outside, true);
  }, [menu, ownerWindow]);

  useEffect(() => {
    if (!dialog) return;
    const active = ownerWindow.document.activeElement;
    const popup = root.current?.querySelector('[role="dialog"]');
    popup?.querySelector('button,input,select')?.focus();
    const trap = event => {
      if (event.key !== 'Tab') return;
      const focusable = [...popup.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && ownerWindow.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && ownerWindow.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    popup?.addEventListener('keydown', trap);
    return () => { popup?.removeEventListener('keydown', trap); active?.isConnected && active.focus(); };
  }, [dialog, ownerWindow]);

  const perform = async work => {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (failure) { setError(toMessage(failure)); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (!shownDialog) { setModelForm(emptyModel()); setShowKey(false); } }, [shownDialog]);
  const close = () => { setDialog(null); setShowKey(false); };
  const choose = () => perform(async () => { setDialog(null); await api('pick-game'); last.current = ''; await refresh(); });
  const changeScene = async event => {
    const id = event.target.value; setSceneId(id); setTasks([]); setSections([]); setError('');
    try { ownerWindow.localStorage.setItem(`dsh-translate.group:${sessionId}:${snapshot.state.binding.project_id}`, id); await readScene(id, snapshot.state.binding.project_id); }
    catch (failure) { setError(toMessage(failure)); }
  };
  const openTranslate = () => { setSelected(pendingScenes.some(row => row.id === sceneId) ? [sceneId] : pendingScenes[0] ? [pendingScenes[0].id] : []); setDialog('translate'); };
  const expand = () => perform(async () => {
    if (onExpand) { onExpand(); return; }
    const doc = ownerWindow.document;
    if (doc.fullscreenElement) await doc.exitFullscreen(); else await root.current?.requestFullscreen?.();
  });
  const modelChange = (field, value) => setModelForm(form => ({ ...form, [field]: value }));
  const openSettings = () => { setSettingsTab('appearance'); setDialog('settings'); setModelForm(emptyModel()); };
  const style = { '--reader-font-size': `${preferences.fontSize}px`, '--reader-line-height': preferences.lineHeight,
    '--reader-left': `${preferences.ratio}fr`, '--reader-right': `${100-preferences.ratio}fr`, '--reader-font': preferences.font === 'serif' ? '"Noto Serif CJK SC", "Songti SC", SimSun, serif' : 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif' };

  return <div ref={root} className="dsh-translate" data-surface={preferences.surface} data-native={nativeChrome || undefined} style={style}>
    <header className={`reader-header${headerProps ? ' draggable-header' : ''}`} {...headerProps}>
      <Select className="scene-pill" aria-label="选择阅读分组" value={sceneId} onChange={changeScene} disabled={!scenes.length || editingCount > 0}>
        {!scenes.length && <option value="">选择阅读组</option>}
        {sceneOptions}
      </Select>
      {!initialized && <span className="uninitialized">未初始化</span>}
      <div className="header-space" />
      <div className="menu-owner" ref={menuOwner}>
        <button className="icon-pill" aria-label="更多操作" aria-expanded={menu} disabled={editingCount > 0} onClick={() => { setMenu(!menu); if (!menu) void refresh().catch(failure => setError(toMessage(failure))); }}>•••</button>
        {shownMenu && <div className="more-menu glass-surface" role="menu" data-open={menu} aria-hidden={!menu} inert={menu ? undefined : ''}>
          <MenuItem icon="folder" onClick={() => { setMenu(false); initialized ? setDialog('switch') : choose(); }} disabled={busy || pending}>选择游戏目录…</MenuItem>
          <MenuItem icon={initialized ? 'lock' : 'initialize'} title={snapshot?.agentIssue || undefined} onClick={() => { setMenu(false); setDialog('initialize'); }} disabled={initialized || pending || busy || Boolean(snapshot?.agentIssue)}>初始化</MenuItem>
          <MenuItem icon="translate" title={snapshot?.agentIssue || undefined} onClick={() => { setMenu(false); openTranslate(); }} disabled={!ready || busy || Boolean(snapshot?.agentIssue)}>翻译…</MenuItem>
          <MenuItem icon="box" title={snapshot?.agentIssue || undefined} onClick={() => { setMenu(false); setOutput(''); setDialog('build'); }} disabled={!ready || busy || Boolean(snapshot?.agentIssue)}>封装写回…</MenuItem>
          <MenuItem icon="settings" onClick={() => { setMenu(false); openSettings(); }}>设置…</MenuItem>
          <div className="menu-bottom"><span>风格</span><Segments value={preferences.surface} onChange={surface => savePreference({ surface })} options={[["white", "纯白"], ["glass", "玻璃质感"]]} /></div>
        </div>}
      </div>
      {!nativeChrome && <><button className="icon-pill" aria-label={expanded ? '还原窗口' : '展开窗口'} title={expanded ? '还原窗口' : '展开窗口'} onClick={expand}><Icon name={expanded ? 'restore' : 'expand'} /></button>
      <button className="icon-pill window-close" aria-label="关闭翻译窗口" title="关闭" onClick={() => onClose ? onClose() : ownerWindow.close()}><Icon name="close" /></button></>}
    </header>
    {(error || notice) && <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
    {snapshot?.agentIssue && <div className="notice agent-issue" role="status"><span>{snapshot.agentIssue}</span></div>}
    <main className="reader-scroll" aria-label="原文与已保存译文对照">
      {tasks.length ? <PairedText tasks={tasks} sections={sections} api={api} projectId={snapshot?.state.binding?.project_id} onEditing={onEditing} onSaved={edited} /> : <div className="empty-reader">{readingScene ? <><span className="small-spinner" />正在读取场景…</> : pending ? <><span className="small-spinner" />初始化正在进行，处理信息在原对话中。</> : snapshot?.state.initialization_error ? <>初始化未完成，请在原对话查看原因，修复后可重试。</> : initialized ? '资源已绑定，等待 Agent 完成翻译工程准备。' : '从右上角选择游戏目录，然后初始化。'}</div>}
    </main>
    {shownDialog && <div className="dialog-layer" data-open={Boolean(dialog)} aria-hidden={!dialog} inert={dialog ? undefined : ''} onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="dialog-title" className={`dialog glass-surface ${shownDialog === 'settings' ? 'settings-dialog' : ''}`}>
        <div className="dialog-heading"><h2 id="dialog-title">{{ switch: '切换游戏目录', initialize: '初始化', translate: '翻译', build: '封装写回', settings: '设置' }[shownDialog]}</h2><button className="close-button" aria-label="关闭" onClick={close} disabled={busy}>×</button></div>
        {shownDialog === 'switch' && <><p className="dialog-copy">切换游戏目录将解除当前对话绑定，新目录需重新初始化并消耗模型余额。旧工程和译文会保留。</p><Actions onCancel={close} onConfirm={choose} label="继续选择" busy={busy} /></>}
        {shownDialog === 'initialize' && <><p className="dialog-copy">初始化将由当前对话的 Agent 执行解包工作，会消耗账户余额 / Token。</p>
          {!snapshot?.state.selected_game && !initialized && <button className="folder-button" onClick={() => perform(async () => { await api('pick-game'); await refresh(); })}><Icon name="folder" />选择文件夹</button>}
          <Actions onCancel={close} disabled={!snapshot?.state.selected_game || pending || initialized} busy={busy} label="初始化" onConfirm={() => perform(async () => { const result = await api('initialize'); setNotice(result.message ?? '请求已交给原对话 Agent。'); setDialog(null); last.current = ''; await refresh(); })} /></>}
        {shownDialog === 'translate' && <><p className="field-caption">选择要翻译的阅读分组</p><div className="scene-checks inset">
          {!pendingScenes.length && <p className="help">没有待翻译或待复核的场景；单条重翻可在原聊天提出。</p>}
          {pendingScenes.map(row => <label key={row.id}><input type="checkbox" checked={selected.includes(row.id)} onChange={() => setSelected(value => value.includes(row.id) ? value.filter(id => id !== row.id) : [...value, row.id])} /><div><span>{row.title || row.id}</span><small>{row.id === sceneId ? '当前场景 · ' : ''}{Object.entries(row.counts ?? {}).reduce((count, [status, n]) => count+(status === 'PROCESSED' ? 0 : n), 0)} 条待处理</small></div></label>)}
        </div><p className="field-caption">翻译方式</p><Segments value={mode} onChange={setMode} options={[["main", "主 Agent 翻译"], ["delegate", "子 Agent / 其他模型"]]} />
          {mode === 'delegate' && <label className="form-row"><span>翻译模型</span><Select aria-label="翻译模型" value={modelId} onChange={event => setModelId(event.target.value)}><option value="">继承主 Agent 模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</Select></label>}
          <p className="help">由当前对话的主 Agent 分派任务。</p><Actions onCancel={close} busy={busy} disabled={!selected.length} label="交给 Agent" onConfirm={() => perform(async () => { const result = await api('translate', { project_id: snapshot.state.binding.project_id, group_ids: selected, mode, model_id: mode === 'delegate' ? modelId : '' }); setNotice(result.message); close(); })} /></>}
        {shownDialog === 'build' && <><p className="dialog-copy">请确认译文已经核对无误。主 Agent 将写入独立游戏副本，并核验写回结果。</p>
          <button className="folder-button" onClick={() => perform(async () => { const result = await api('pick-output'); if (!result.cancelled) setOutput(result.output_dir); })}><Icon name="folder" />{output ? '重新选择输出位置' : '选择输出位置'}</button>
          {output && <p className="output-path inset">{output}</p>}<Actions onCancel={close} label="确认封装" busy={busy} disabled={!output} onConfirm={() => perform(async () => { const result = await api('build', { output_dir: output }); setNotice(result.message); close(); })} /></>}
        {shownDialog === 'settings' && <><Segments value={settingsTab} onChange={setSettingsTab} options={[["appearance", "外观"], ["models", "翻译模型"]]} />
          {settingsTab === 'appearance' ? <div className="appearance-settings">
            <Setting label="页面风格"><Segments value={preferences.surface} onChange={surface => savePreference({ surface })} options={[["white", "纯白"], ["glass", "玻璃质感"]]} /></Setting>
            {preferences.surface === 'glass' && <>{[['milk', '乳白'], ['softLight', '柔光']].map(([key, label]) => <Setting key={key} label={label}><div className="slider-row"><input aria-label={label} type="range" min="0" max="80" step="1" value={preferences[key]} onPointerDown={() => setAdjustingFrost(true)} onLostPointerCapture={() => setAdjustingFrost(false)} onBlur={() => setAdjustingFrost(false)} onChange={event => savePreference({ [key]: +event.target.value })} /><span>{preferences[key]}%</span></div></Setting>)}</>}
            <Setting label="字体"><Select aria-label="字体" value={preferences.font} onChange={event => savePreference({ font: event.target.value })}><option value="system">系统字体</option><option value="serif">衬线字体</option></Select></Setting>
            <Setting label="字体大小"><div className="slider-row"><input aria-label="字体大小" type="range" min="12" max="24" value={preferences.fontSize} onChange={event => savePreference({ fontSize: +event.target.value })} /><span>{preferences.fontSize} px</span></div></Setting>
            <Setting label="行间距"><Select aria-label="行间距" value={preferences.lineHeight} onChange={event => savePreference({ lineHeight: +event.target.value })}><option value="1.5">紧凑 · 1.5</option><option value="1.8">宽松 · 1.8</option><option value="2.1">舒展 · 2.1</option></Select></Setting>
            <Setting label="两栏比例"><div className="slider-row"><input aria-label="原文栏比例" type="range" min="35" max="65" value={preferences.ratio} onChange={event => savePreference({ ratio: +event.target.value })} /><span>{preferences.ratio} : {100-preferences.ratio}</span></div></Setting>
            <div className="live-preview inset"><small>预览</small><div className="text-pair"><p><Speaker name="ミナ" />また明日。</p><p><Speaker name="米娜" />明天见。</p></div></div>
            <div className="dialog-actions"><button className="text-button" onClick={() => savePreference(DEFAULTS)}>恢复默认</button><div className="header-space" /><button className="primary" onClick={close}>完成</button></div>
          </div> : <form className="model-settings" onSubmit={event => { event.preventDefault(); perform(async () => { const result = await api('save-model', { ...modelForm, id: modelForm.id || undefined }); setModelId(result.id); setModelForm(emptyModel()); setShowKey(false); await refresh(); setNotice('模型已保存，密钥保存在 DSH 宿主凭据中。'); }); }}>
            {models.length > 0 && <div className="model-chips">{models.map(model => <button type="button" key={model.id} onClick={() => { setModelForm({ id: model.id, name: model.name, protocol: model.protocol, baseURL: model.baseURL, model: model.model, apiKey: '', contextWindow: model.contextWindow, maxTokens: model.maxTokens }); setShowKey(false); }}>{model.name}</button>)}<button type="button" onClick={() => setModelForm(emptyModel())}>＋ 新模型</button></div>}
            <h3>{modelForm.id ? '编辑翻译模型' : '添加翻译模型'}</h3>
            <Setting label="名称"><input aria-label="名称" required value={modelForm.name} autoComplete="off" onBlur={event => modelChange('name', event.target.value.trim())} placeholder="翻译模型 01" onChange={event => modelChange('name', event.target.value)} /></Setting>
            <Setting label="协议"><Select aria-label="协议" value={modelForm.protocol} onChange={event => modelChange('protocol', event.target.value)}>{PROTOCOLS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select></Setting>
            <Setting label="API 地址"><input aria-label="API 地址" type="url" required value={modelForm.baseURL} spellCheck={false} autoCapitalize="none" autoComplete="off" onBlur={event => modelChange('baseURL', event.target.value.trim())} placeholder={modelForm.protocol === 'google-generative-ai' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.example.com/v1'} onChange={event => modelChange('baseURL', event.target.value)} /></Setting>
            <Setting label="API Key"><div className="key-field"><input aria-label="API Key" type={showKey ? 'text' : 'password'} autoComplete="off" required={!modelForm.id} value={modelForm.apiKey} spellCheck={false} autoCapitalize="none" onBlur={event => modelChange('apiKey', event.target.value.trim())} placeholder={modelForm.id ? '留空保留已保存密钥' : '输入 API Key'} onChange={event => modelChange('apiKey', event.target.value)} /><button type="button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}><Icon name="eye" /></button></div></Setting>
            <Setting label="模型名称"><input aria-label="模型名称" required value={modelForm.model} spellCheck={false} autoCapitalize="none" autoComplete="off" onBlur={event => modelChange('model', event.target.value.trim())} placeholder="输入模型 ID" onChange={event => modelChange('model', event.target.value)} /></Setting>
            <button type="button" className="advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>高级 {advanced ? '⌃' : '⌄'}</button>
            {advanced && <><Setting label="上下文上限"><input aria-label="上下文上限" type="number" min="1024" value={modelForm.contextWindow} onChange={event => modelChange('contextWindow', +event.target.value)} /></Setting><Setting label="输出上限"><input aria-label="输出上限" type="number" min="1" value={modelForm.maxTokens} onChange={event => modelChange('maxTokens', +event.target.value)} /></Setting><p className="help">请按所用模型填写容量；这里的默认值是可调整的运行预算。</p></>}
            <p className="help">仅用于主 Agent 分派的翻译子任务。</p>
            {!snapshot?.modelsAvailable && <p className="help error-text">宿主模型或凭据服务尚未就绪。</p>}
            <div className="dialog-actions"><div className="header-space" /><button type="button" onClick={close}>取消</button><button className="primary" type="submit" disabled={busy || !snapshot?.modelsAvailable}>{busy ? '保存中…' : '保存模型'}</button></div>
          </form>}
        </>}
        {busy && <span className="sr-only" role="status">正在处理</span>}
      </section>
    </div>}
  </div>;
}

function emptyModel() { return { id: '', name: '', protocol: 'openai-completions', baseURL: '', model: '', apiKey: '', contextWindow: 65536, maxTokens: 8192 }; }
function toMessage(error) { try { const parsed = JSON.parse(error.message); return parsed.error?.message ?? error.message; } catch { return error.message; } }
function Speaker({ name }) { return name ? <span className="speaker">{name} </span> : null; }
function Setting({ label, children }) { return <label className="form-row"><span>{label}</span><div className="setting-value">{children}</div></label>; }
function Segments({ value, onChange, options }) { return <div className="segments" role="group">{options.map(([id, label]) => <button key={id} type="button" aria-pressed={value === id} className={value === id ? 'selected' : ''} onClick={() => onChange(id)}>{label}</button>)}</div>; }
function Actions({ onCancel, onConfirm, label, busy, disabled }) { return <div className="dialog-actions"><div className="header-space" /><button onClick={onCancel} disabled={busy}>取消</button><button className="primary" onClick={onConfirm} disabled={busy || disabled}>{busy ? '处理中…' : label}</button></div>; }
function MenuItem({ icon, children, ...props }) { return <button role="menuitem" className="menu-item" {...props}><Icon name={icon} /><span>{children}</span></button>; }
function Icon({ name }) {
  const controls = { close: 'M6 6l12 12M18 6 6 18', expand: 'M9 4H4v5m11-5h5v5M4 15v5h5m6 0h5v-5', restore: 'M8 4H4v4m16 0V4h-4M4 16v4h4m8 0h4v-4M8 8h8v8H8z' };
  const paths = { folder: 'M3 6h6l2 2h10v11H3z', initialize: 'M12 3v5m0 8v5M3 12h5m8 0h5M5.6 5.6l3.5 3.5m5.8 5.8 3.5 3.5', lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3', translate: 'M3 5h12M9 2v3m-3 0c1 5 4 8 8 10M13 5C12 10 8 14 3 16m12 5 4-10 4 10m-7-3h6', box: 'm3 7 9-4 9 4-9 4zM3 7v11l9 4 9-4V7M12 11v11', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m-2-5h4l1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3z', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12m10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6' };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={controls[name] ?? paths[name]} /></svg>;
}
