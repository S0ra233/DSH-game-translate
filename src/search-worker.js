import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../python/search_worker.py', import.meta.url));

/** One warm passive search process per root conversation, reclaimed when idle. */
export class SearchWorker {
  constructor(config, onClose) {
    this.pending = new Map(); this.serial = 0; this.closed = false; this.clients = new Set();
    this.child = spawn(config.pythonExecutable, ['-B', '-u', SCRIPT], { windowsHide: true, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } });
    let stderr = '';
    this.child.stderr.setEncoding('utf8'); this.child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    this.child.stdin.on('error', () => {});
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try {
        const result = JSON.parse(line), item = this.pending.get(result.id);
        if (!item) return;
        this.pending.delete(result.id); item.clean(); item.resolve(result); this.idle();
      } catch { this.close(new Error('检索进程返回了无效结果')); }
    });
    this.done = new Promise(resolve => this.child.once('close', resolve));
    const ended = error => {
      this.closed = true; clearTimeout(this.idleTimer);
      for (const item of this.pending.values()) { item.clean(); item.reject(error); }
      this.pending.clear(); onClose(this);
    };
    this.child.on('error', error => ended(error));
    this.child.once('close', () => { lines.close(); ended(new Error(`检索进程已结束${stderr ? ': ' + stderr : ''}`)); });
  }

  idle() {
    clearTimeout(this.idleTimer);
    if (!this.pending.size) this.idleTimer = setTimeout(() => this.close(), 30_000).unref();
  }

  request(request, signal) {
    signal?.throwIfAborted(); clearTimeout(this.idleTimer);
    if (this.closed) return Promise.reject(new Error('检索进程已关闭，请重试'));
    const client = request.args.client_id ?? '';
    this.clients.add(client);
    if (request.operation === 'search_query' || client) {
      for (const [id, item] of this.pending) if (item.operation === request.operation && item.client === client) {
        this.child.stdin.write(JSON.stringify({ cancel: id }) + '\n');
        this.pending.delete(id); item.clean();
        item.reject(new Error(JSON.stringify({ error: { code: 'cancelled', message: '已使用新的检索或阅读请求。' } })));
      }
    }
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const abort = () => {
        this.child.stdin.write(JSON.stringify({ cancel: id }) + '\n');
        const item = this.pending.get(id); if (item) { this.pending.delete(id); item.clean(); reject(signal.reason ?? new Error('检索已取消')); this.idle(); }
      };
      const timer = setTimeout(() => { this.close(new Error('检索准备超时，请重试')); }, 180_000);
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, clean, client, operation: request.operation });
      signal?.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(JSON.stringify({ ...request, id }) + '\n');
      if (signal?.aborted) abort();
    });
  }

  close(reason = new Error('检索窗口已关闭')) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.idleTimer);
    for (const item of this.pending.values()) { item.clean(); item.reject(reason); }
    this.pending.clear(); this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 1500).unref();
    this.child.once('close', () => clearTimeout(timer));
  }

  release(client) {
    if (!client) { this.close(); return; }
    this.clients.delete(client);
    for (const [id, item] of this.pending) if (item.client === client) {
      this.child.stdin.write(JSON.stringify({ cancel: id }) + '\n');
      this.pending.delete(id); item.clean();
      item.reject(new Error(JSON.stringify({ error: { code: 'cancelled', message: '检索栏已收起。' } })));
    }
    if (!this.clients.size) this.close();
    else this.idle();
  }
}
