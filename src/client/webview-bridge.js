/** Fixed native message envelope. Folder paths can only come from the OS picker. */
export function createHostBridge({ send, notify = () => {} }) {
  let serial = 0, disposed = false, material = '';
  let hostActions;
  const pending = new Map();
  const api = (action, args = {}) => new Promise((resolve, reject) => {
    if (disposed) return reject(new Error('翻译窗口已关闭'));
    if (action === 'edit-translation' && hostActions !== undefined && !hostActions.has(action)) return reject(new Error('当前翻译窗口与插件版本不一致，请先复制保留当前输入，完全退出 DSH 后重新打开翻译窗口；本次修改尚未保存。'));
    if (['reading-groups', 'reading-group'].includes(action) && hostActions !== undefined && !hostActions.has(action)) return reject(new Error('当前翻译窗口与插件版本不一致，请完全退出 DSH 后重新打开，以加载阅读分组；工程内容未修改。'));
    const id = `web-${++serial}`; pending.set(id, { resolve, reject });
    send({ kind: 'request', id, action, args });
  });
  return { api,
    configureHost(protocol) { hostActions = new Set(protocol?.version === 1 && Array.isArray(protocol.actions) ? protocol.actions : []); },
    receive(message) {
      if (disposed) return;
      if (message.kind === 'event') { notify(message.name); return; }
      if (message.kind !== 'response') return;
      const waiter = pending.get(message.id); if (!waiter) return;
      pending.delete(message.id);
      message.ok ? waiter.resolve(message.value) : waiter.reject(new Error(message.error));
    },
    sendMaterial(value) {
      const preferences = { surface: value.surface, milk: value.milk, softLight: value.softLight };
      const key = JSON.stringify(preferences); if (disposed || key === material) return;
      material = key; send({ kind: 'material', preferences });
    },
    sendReady() { if (!disposed) send({ kind: 'ready' }); },
    dispose() { disposed = true; for (const item of pending.values()) item.reject(new Error('翻译窗口已关闭')); pending.clear(); },
  };
}
