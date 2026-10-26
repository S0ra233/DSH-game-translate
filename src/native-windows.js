import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { cleanAppearance } from './appearance.js';
export { cleanAppearance } from './appearance.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PASSIVE = new Set(['snapshot', 'scenes', 'scene', 'reading-groups', 'reading-group', 'save-model', 'edit-translation']);
const PAID = new Set(['initialize', 'translate', 'build']);

/** 一个根对话一个受控原生进程；仅 stdio 通信，不开放 HTTP 端口或页面令牌。 */
export class NativeWindows {
  constructor(ctx, service, { spawnProcess = spawn, platform = process.platform, warmKeepaliveMs = 60_000 } = {}) {
    this.ctx = ctx; this.service = service; this.spawnProcess = spawnProcess; this.platform = platform;
    this.windows = new Map(); this.preferences = Promise.resolve(); this.closed = false;
    this.warmKeepaliveMs = warmKeepaliveMs;
    for (const event of ['api-session/status', 'api-session/error']) ctx.on?.(event, id => {
      const record = this.windows.get(String(id));
      if (record && !record.hidden) this.send(record, { kind: 'event', name: 'refresh' });
    });
  }

  async open(sessionId, supplied = {}, signal) {
    if (this.platform !== 'win32') return { status: 'unsupported' };
    if (this.closed) throw new Error('翻译插件已关闭');
    const previous = this.windows.get(String(sessionId));
    if (previous && !previous.stopping) return this.focus(previous);
    if (previous) await previous.done;
    const observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' });
    try { this.service.sessionContext(observation.header, observation.events); }
    finally { observation[Symbol.dispose](); }
    signal?.throwIfAborted();
    let appearance = cleanAppearance(supplied);
    try { appearance = cleanAppearance(JSON.parse(await readFile(join(this.service.config.dataDirectory, 'native-appearance.json'), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    let icon = this.service.config.nativeWindowIcon;
    if (!icon) for (const executable of [process.env.DSH_DESKTOP_NODE_EXECUTABLE, process.execPath].filter(Boolean)) {
      const candidate = join(dirname(executable), 'resources', 'icon.png');
      try { await access(candidate); icon = candidate; break; } catch {}
    }
    // 检查观察期间另一打开请求是否已经建立窗口，避免同一对话重复进程。
    const raced = this.windows.get(String(sessionId));
    if (raced && !raced.stopping) return this.focus(raced);
    if (raced) { await raced.done; return this.open(sessionId, supplied, signal); }
    const hash = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 24);
    const executable = join(ROOT, 'native', 'wpf', 'TranslationWindow-0.3.7.exe');
    const args = ['--profile-dir', join(this.service.config.dataDirectory, 'native-ui', hash)];
    if (icon) args.push('--icon', icon);
    const child = this.spawnProcess(executable, args, { cwd: ROOT, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } });
    const record = { child, sessionId: String(sessionId), lifetime: new AbortController(), pending: new Set(), buffer: '', stderr: '', ready: null, resolve: null, reject: null, settled: false };
    record.ready = new Promise((accept, reject) => { record.resolve = accept; record.reject = reject; });
    record.done = new Promise(resolveDone => child.once('close', resolveDone));
    this.windows.set(record.sessionId, record);
    record.timer = setTimeout(() => {
      record.reject(new Error('原生翻译窗口启动超时，请确认 .NET Framework 4.8 可用'));
      this.stop(record);
    }, 30000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => this.receive(record, text));
    child.stderr.on('data', text => { record.stderr = (record.stderr + text).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', error => record.reject(new Error(`无法启动原生翻译窗口：${error.message}`)));
    child.once('close', () => {
      clearTimeout(record.timer); clearTimeout(record.killTimer); clearTimeout(record.idleTimer);
      record.lifetime.abort(new Error('翻译窗口已关闭'));
      if (this.windows.get(record.sessionId) === record) this.windows.delete(record.sessionId);
      if (!record.settled) record.reject(new Error(`原生翻译窗口未启动。请确认 .NET Framework 4.8 可用。${record.stderr ? '\n'+record.stderr.slice(-500) : ''}`));
    });
    const cancelled = () => { record.reject(signal.reason ?? new Error('窗口打开已取消')); this.stop(record); };
    signal?.addEventListener('abort', cancelled, { once: true });
    this.send(record, { kind: 'bootstrap', sessionId: record.sessionId, appearance });
    try { await record.ready; return { status: 'native-opened', reused: false }; }
    finally { signal?.removeEventListener('abort', cancelled); }
  }

  send(record, message) {
    if (!record.child.stdin.destroyed) record.child.stdin.write(JSON.stringify(message)+'\n', () => {});
  }

  async focus(record) {
    clearTimeout(record.idleTimer); record.idleTimer = null; record.hidden = false;
    this.send(record, { kind: 'window', action: 'focus' });
    await record.ready;
    return { status: 'native-opened', reused: true };
  }

  retain(record) {
    if (record.stopping) return;
    record.hidden = true;
    clearTimeout(record.idleTimer);
    // Retain at most one hidden renderer; visible windows are never evicted.
    for (const other of this.windows.values()) if (other !== record && other.hidden) this.stop(other);
    record.idleTimer = setTimeout(() => this.stop(record), this.warmKeepaliveMs);
    record.idleTimer.unref?.();
  }

  receive(record, text) {
    record.buffer += text;
    if (Buffer.byteLength(record.buffer) > 2*1024*1024) { record.reject(new Error('原生窗口协议过大')); this.stop(record); return; }
    let end;
    while ((end = record.buffer.indexOf('\n')) >= 0) {
      const line = record.buffer.slice(0, end); record.buffer = record.buffer.slice(end+1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.kind === 'ready') { record.settled = true; clearTimeout(record.timer); record.resolve(); continue; }
      if (message.kind === 'hidden') { this.retain(record); continue; }
      if (message.kind === 'visible') { clearTimeout(record.idleTimer); record.idleTimer = null; record.hidden = false; continue; }
      if (message.kind === 'fatal') { record.reject(new Error(String(message.message ?? '原生窗口加载失败'))); this.stop(record); continue; }
      if (!['request', 'directory-picked'].includes(message.kind) || typeof message.id !== 'string' || record.pending.has(message.id)) continue;
      record.pending.add(message.id);
      void this.dispatch(record, message).then(value => this.send(record, { kind: 'response', id: message.id, ok: true, value }), error => {
        const secret = message.args?.apiKey;
        const safe = secret ? String(error.message).replaceAll(secret, '••••') : String(error.message);
        this.send(record, { kind: 'response', id: message.id, ok: false, error: safe });
      }).finally(() => record.pending.delete(message.id));
    }
  }

  async dispatch(record, message) {
    const { action, args = {} } = message;
    const signal = record.lifetime.signal;
    signal.throwIfAborted();
    if (message.kind === 'directory-picked') {
      if (!['pick-game', 'pick-output'].includes(action) || (message.path !== null && typeof message.path !== 'string')) throw new Error('原生目录选择结果不正确');
      return unwrap(await this.ctx.get('translationUi').acceptNativeDirectory(record.sessionId, action, message.path, signal));
    }
    if (action === 'native-appearance') {
      const appearance = cleanAppearance(args.preferences);
      const save = this.preferences.catch(() => {}).then(async () => {
        await mkdir(this.service.config.dataDirectory, { recursive: true });
        const temporary = join(this.service.config.dataDirectory, `appearance-${randomUUID()}.pending`);
        await writeFile(temporary, JSON.stringify(appearance), { mode: 0o600 });
        await rename(temporary, join(this.service.config.dataDirectory, 'native-appearance.json'));
      });
      this.preferences = save; await save; return { saved: true };
    }
    if (PASSIVE.has(action)) return unwrap(await this.ctx.get('translationUi').request(record.sessionId, JSON.stringify({ ...args, action }), signal));
    if (PAID.has(action)) {
      const lookup = this.ctx.get('typert')?.lookups.get('agent');
      if (!lookup) throw new Error('DSH Agent 恢复服务尚未就绪');
      const agent = await lookup.resolve(record.sessionId);
      if (!agent) throw new Error('原 DSH 对话无法恢复，请在原聊天查看原因');
      const command = await this.ctx.commands.execute(agent, `/translation-ui ${JSON.stringify({ ...args, action })}`, [], signal);
      if (command?.result.kind !== 'success') throw new Error(command?.result.text ?? 'DSH 未接纳翻译请求');
      return JSON.parse(command.result.text);
    }
    throw new Error('不支持的原生窗口操作');
  }

  stop(record) {
    if (record.stopping) return;
    record.stopping = true; clearTimeout(record.idleTimer);
    this.send(record, { kind: 'window', action: 'close' });
    record.killTimer ??= setTimeout(() => record.child.kill(), 5000);
    record.killTimer.unref?.();
  }

  async dispose() {
    this.closed = true;
    const records = [...this.windows.values()];
    for (const record of records) this.stop(record);
    await Promise.all(records.map(record => record.done));
    await this.preferences.catch(() => {});
  }
}

function unwrap(raw) { const result = JSON.parse(raw); if (!result.ok) throw new Error(result.error); return result.value; }

export function registerNativeWindows(ctx, service) {
  ctx.inject(['sessionQuery'], scope => {
    const windows = new NativeWindows(scope, service);
    service.nativeWindows = windows;
    scope.effect(() => async () => {
      if (service.nativeWindows === windows) service.nativeWindows = null;
      await windows.dispose();
    }, 'translation: native windows');
  });
}
