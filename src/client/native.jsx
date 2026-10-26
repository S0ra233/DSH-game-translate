import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import css from './surface.css';

const style = document.createElement('style'); style.textContent = css; document.head.append(style);
const subscribers = new Set(), pending = new Map();
const sessionNonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let serial = 0, started = false;

function failure(message) {
  document.getElementById('startup').textContent = message;
}

if (!window.qt?.webChannelTransport || typeof QWebChannel !== 'function') failure('原生窗口连接未建立，请关闭后从 DSH 重新打开。');
else new QWebChannel(qt.webChannelTransport, channel => {
  const bridge = channel.objects.translation;
  bridge.response.connect((id, raw) => {
    const waiter = pending.get(id); if (!waiter) return;
    pending.delete(id);
    try { const response = JSON.parse(raw); response.ok ? waiter.resolve(response.value) : waiter.reject(new Error(response.error)); }
    catch (error) { waiter.reject(error); }
  });
  const api = (action, args = {}) => new Promise((resolve, reject) => {
    const id = `${sessionNonce}:${++serial}`;
    pending.set(id, { resolve, reject });
    bridge.invoke(id, action, JSON.stringify(args));
  });
  api.subscribe = listener => { subscribers.add(listener); return () => subscribers.delete(listener); };
  const appearance = preferences => api('native-appearance', { preferences });
  const preview = value => bridge.previewFrost(value);
  const initialize = () => bridge.bootstrap(raw => {
    try {
      const configuration = JSON.parse(raw);
      if (started || !configuration.ready) return;
      started = true;
      try { localStorage.setItem('dsh-translate.appearance.v1', JSON.stringify(configuration.appearance)); } catch {}
      createRoot(document.getElementById('root')).render(<App api={api} sessionId={configuration.sessionId} nativeChrome onNativeAppearance={appearance} onNativePreview={preview} />);
      document.getElementById('startup').remove();
      bridge.ready();
    } catch { failure('原生翻译界面启动失败，请从 DSH 重新打开。'); bridge.fatal('原生翻译界面启动失败'); }
  });
  bridge.hostEvent.connect(name => {
    if (name === 'bootstrap') initialize();
    else for (const notify of subscribers) notify(name);
  });
  initialize();
});
