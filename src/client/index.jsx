import React, { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { App } from './App.jsx';
import css from './surface.css';
import { FloatingWindow } from './FloatingWindow.jsx';
import { REMOTE_INFO } from '../remote-info.js';

export const inject = ['slots', 'inputTriggers', 'commandUi', 'remote', 'remote.commands'];

/** 中文入口是 Client action，不发模型请求；通信使用 DSH 现有 commands Remote。 */
export async function apply(ctx) {
  const unmountRemote = await ctx.remote.$mount(REMOTE_INFO);
  ctx.effect(() => unmountRemote, 'translation: passive UI remote');
  // 该命名空间由上面的 mount 提供，必须在挂载后另建显式依赖域，避免自依赖。
  ctx.inject(['remote.translationUi'], mountTranslationUi);
}

export function mountTranslationUi(ctx) {
  let openings = [], listeners = new Set(), nativeError = '';
  const nativeRequests = new Map();
  const emit = () => { for (const listener of listeners) listener(); };
  const close = item => { openings = openings.filter(value => value !== item); emit(); };
  const apiFor = sessionId => {
    const api = async (action, args = {}) => {
    if (['snapshot', 'scenes', 'scene', 'reading-groups', 'reading-group', 'pick-game', 'pick-output', 'save-model', 'edit-translation', 'search-query', 'search-locate', 'search-close'].includes(action)) {
      const response = await ctx.remote.translationUi.request(sessionId, JSON.stringify({ action, ...args }));
      if (!response.ok) throw new Error(`翻译连接失败：${response.error?.message ?? response.error?.code}`);
      const result = JSON.parse(response.value);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    }
    const result = await ctx.remote.commands.execute(sessionId, `/translation-ui ${JSON.stringify({ action, ...args })}`, []);
    if (!result.ok) throw new Error(`翻译连接失败：${result.error?.message ?? result.error?.code}`);
    const answer = result.value?.result;
    if (answer?.kind !== 'success') throw new Error(answer?.text ?? '翻译窗口操作未被接受');
    return JSON.parse(answer.text);
    };
    api.subscribe = listener => {
      const changed = id => { if (String(id) === String(sessionId)) listener(); };
      const removers = ['api-session/status', 'api-session/error'].map(event => ctx.remote.$on(event, changed));
      return () => { for (const remove of removers) remove?.(); };
    };
    return api;
  };
  const openBrowser = ({ sessionId }) => {
    const existing = openings.find(item => item.sessionId === sessionId);
    if (existing && !existing.win?.closed) { existing.win?.focus(); return; }
    let win;
    try { win = window.open('', `dsh-translate-${sessionId}`, 'popup=yes,width=1120,height=780,resizable=yes,scrollbars=no'); } catch { win = null; }
    const item = { sessionId, api: apiFor(sessionId), win, node: null };
    try { if (win) {
      const doc = win.document;
      doc.title = 'DSH-game-translate';
      doc.documentElement.lang = 'zh-CN';
      doc.body.style.cssText = 'margin:0;height:100vh;background:#fff;overflow:hidden';
      const style = doc.createElement('style'); style.textContent = css; doc.head.append(style);
      item.node = doc.createElement('div'); item.node.style.cssText = 'height:100%;width:100%'; doc.body.append(item.node);
      win.addEventListener('beforeunload', () => close(item), { once: true });
    } } catch { try { win?.close(); } catch {} item.win = null; item.node = null; }
    openings = [...openings, item]; emit();
  };
  const open = async session => {
    if (!/Windows/i.test(navigator.userAgent)) { openBrowser(session); return; }
    if (nativeRequests.has(session.sessionId)) return nativeRequests.get(session.sessionId);
    let appearance = '{}';
    try { appearance = localStorage.getItem('dsh-translate.appearance.v1') ?? '{}'; } catch {}
    nativeError = ''; openings = [...openings]; emit();
    const task = (async () => {
      try {
        const response = await ctx.remote.translationUi.openNative(session.sessionId, appearance);
        if (!response.ok) throw new Error(response.error.message);
        const answer = JSON.parse(response.value);
        if (!answer.ok) throw new Error(answer.error);
        if (answer.value.status === 'unsupported') openBrowser(session);
      } catch (error) { nativeError = error.message; openings = [...openings]; emit(); }
      finally { nativeRequests.delete(session.sessionId); }
    })();
    nativeRequests.set(session.sessionId, task);
    return task;
  };
  const source = { trigger: '/', name: 'dsh-game-translate', order: -5, showGroupTitle: false,
    candidates: async (_session, request) => request.position === 'leading' && '翻译'.includes(request.query)
      ? [{ name: '翻译', label: '翻译', description: '打开此对话的翻译窗口' }] : [],
    onPick: pick => { void open(pick.session); return 'handled'; },
    matchEnter: async (session, line, _signal, envelope) => {
      if (line !== '/翻译') return undefined;
      if (envelope.attachments) throw new Error('/翻译 只打开窗口，请单独发送附件。');
      void open(session); return 'handled';
    } };
  ctx.effect(() => ctx.inputTriggers.registerSource(source), 'translation: Chinese entry');
  ctx.effect(() => ctx.commandUi.decorate({ name: 'translation', available: () => true, ui: { kind: 'action', run: session => { void open(session); } } }), 'translation: English entry');
  function Windows() {
    useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => openings);
    return createPortal(<><style>{css}</style>{nativeError && <div className="dsh-translation-native-error" role="alert"><span>{nativeError}</span><button aria-label="关闭提示" onClick={() => { nativeError = ''; openings = [...openings]; emit(); }}>×</button></div>}{openings.map(item => item.node
      ? createPortal(<App api={item.api} sessionId={String(item.sessionId)} ownerWindow={item.win} onClose={() => { item.win.close(); close(item); }} />, item.node, String(item.sessionId))
      : <FloatingWindow key={String(item.sessionId)} api={item.api} sessionId={String(item.sessionId)} onClose={() => close(item)} />)}</>, document.body);
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-translate-windows' }, Windows));
  ctx.effect(() => {
    const release = () => { for (const item of openings) item.win?.close(); };
    window.addEventListener('beforeunload', release);
    return () => window.removeEventListener('beforeunload', release);
  }, 'translation: opener lifetime');
  ctx.effect(() => () => { for (const item of openings) item.win?.close(); openings = []; listeners.clear(); }, 'translation: windows');
}
