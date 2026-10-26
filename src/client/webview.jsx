import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import css from './surface.css';
import { createHostBridge } from './webview-bridge.js';

const style = document.createElement('style'); style.textContent = css; document.head.append(style);
document.documentElement.dataset.materialHost = 'native';
const subscribers = new Set();
const bridge = createHostBridge({ send: message => window.chrome.webview.postMessage(message), notify: name => { for (const listener of subscribers) listener(name); } });
bridge.api.subscribe = listener => { subscribers.add(listener); return () => subscribers.delete(listener); };
const persist = preferences => bridge.api('native-appearance', { preferences });
// Input sets targets locally; only native material animation paints each frame.
const preview = preferences => bridge.sendMaterial(preferences);
let mounted = false;
window.chrome.webview.addEventListener('message', event => {
  const message = event.data;
  if (message.kind === 'bootstrap' && !mounted) {
    mounted = true;
    bridge.configureHost(message.nativeProtocol);
    try { localStorage.setItem('dsh-translate.appearance.v1', JSON.stringify(message.appearance)); } catch {}
    // Open the native bridge before App effects can issue their initial read.
    bridge.sendReady();
    createRoot(document.getElementById('root')).render(<App api={bridge.api} sessionId={message.sessionId} nativeChrome onNativeAppearance={persist} onNativePreview={preview} nativeMaterial />);
  } else bridge.receive(message);
});
window.addEventListener('pagehide', () => bridge.dispose(), { once: true });
window.chrome.webview.postMessage({ kind: 'bootstrap-request' });
