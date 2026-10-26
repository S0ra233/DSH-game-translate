import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 所有调用共用同一 Worker 协议；会话和目录从宿主取得，不接受模型覆盖。 */
export class TranslationService {
  constructor(config = {}) {
    const allowed = ['pythonExecutable', 'dataDirectory', 'allowedGameRoots', 'allowedWorkRoots', 'timeoutMs', 'cancelGraceMs', 'nativeWindowIcon'];
    if (Object.keys(config).some(key => !allowed.includes(key))) throw new Error('dsh-translate 配置含未知字段');
    this.config = {
      pythonExecutable: config.pythonExecutable ?? 'python',
      dataDirectory: resolve(config.dataDirectory ?? `${ROOT}/.local`),
      allowedGameRoots: config.allowedGameRoots ?? [],
      allowedWorkRoots: config.allowedWorkRoots ?? [],
      timeoutMs: config.timeoutMs ?? 900_000,
      cancelGraceMs: config.cancelGraceMs ?? 5_000,
      nativeWindowIcon: config.nativeWindowIcon ?? null,
    };
    if (typeof this.config.pythonExecutable !== 'string' || !this.config.pythonExecutable.trim()) throw new Error('Python 入口须为非空路径或命令名');
    if (this.config.nativeWindowIcon !== null && typeof this.config.nativeWindowIcon !== 'string') throw new Error('窗口图标须为路径字符串');
    for (const key of ['allowedGameRoots', 'allowedWorkRoots']) {
      if (!Array.isArray(this.config[key]) || this.config[key].some(path => typeof path !== 'string' || !path)) throw new Error(`${key} 须为目录路径数组`);
      this.config[key] = this.config[key].map(path => resolve(path));
    }
    for (const key of ['timeoutMs', 'cancelGraceMs']) if (!Number.isSafeInteger(this.config[key]) || this.config[key] < 1) throw new Error(`${key} 须为正整数`);
    this.running = new Set();
    this.closed = false;
  }

  context(agent, human = {}) {
    const header = agent?.session?.header;
    if (!header?.cwd || agent.id !== header.id) throw new Error('翻译操作需要真实的 DSH 工作目录会话');
    return this.sessionContext(header, agent.session.snapshotEvents(), human);
  }

  sessionContext(header, events, human = {}) {
    if (!header?.id || !header.cwd) throw new Error('请在工作目录的对话下打开翻译窗口');
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) throw new Error('子 Agent 使用主 Agent 提供的翻译包；不能独立改绑或提交父工程');
    const latest = events.findLast(event => event.type === 'user/message' && event.source?.kind === 'user');
    const userMessage = human.commandId
      ? { id: `command:${human.commandId}`, text: human.rawInput ?? '' }
      : human.uiActionId ? { id: `ui:${human.uiActionId}`, text: human.rawInput ?? '' }
      : latest ? { id: latest.id, text: latest.content.filter(part => part.type === 'text').map(part => part.text).join('\n') } : null;
    return { sessionId: String(header.id), workspace: header.cwd,
      humanCommand: human.commandId !== undefined || human.uiActionId !== undefined, userMessage };
  }

  /** 仅由已鉴权的 UI Remote 传入真实 Session 观察，不创建/恢复 Agent。 */
  async callObserved(observation, operation, args = {}, { signal, human = {} } = {}) {
    if (this.closed) throw new Error('翻译插件已卸载');
    const result = await this.run({ operation, args, context: this.sessionContext(observation.header, observation.events, human), config: this.config }, signal);
    if (!result.ok) { const error = new Error(JSON.stringify(result)); error.result = result; throw error; }
    if (operation === 'status' && result.data?.state.pending) {
      const requestId = result.data.state.pending.request_id;
      const start = observation.events.findLastIndex(event => event.type === 'user/message'
        && event.source?.kind === 'dsh-translate' && event.source.initializationRequestId === requestId);
      const ended = start < 0 ? null : observation.events.slice(start+1).find(event => event.type === 'turn/end');
      if (ended && ['error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'orphaned'].includes(ended.reason?.kind)) {
        try {
          await this.callObserved(observation, 'fail_initialization', { request_id: requestId,
            reason: `初始化所在 Agent 回合结束：${ended.reason.kind}。具体原因见原聊天，已有产物保留，可修复后重试。` }, { signal });
          return this.callObserved(observation, 'status', {}, { signal, human });
        } catch (error) { if (!['busy', 'stale_request'].includes(error.result?.error?.code)) throw error; }
      }
    }
    return result;
  }

  async call(agent, operation, args = {}, { signal, human = {} } = {}) {
    if (this.closed) throw new Error('翻译插件已卸载，不再接受新操作');
    const request = { operation, args, context: this.context(agent, human), config: this.config };
    const result = await this.run(request, signal);
    if (!result.ok) {
      const error = new Error(JSON.stringify(result));
      error.result = result;
      throw error;
    }
    // 只处理确已被 Agent 消费的那次初始化；队列中的请求不受其他回合影响。
    if (operation === 'status' && result.data?.state.pending) {
      const pending = result.data.state.pending;
      const events = agent.session.snapshotEvents();
      const start = events.findLastIndex(event => event.type === 'user/message'
        && event.source?.kind === 'dsh-translate' && event.source.initializationRequestId === pending.request_id);
      const ended = start < 0 ? null : events.slice(start+1).find(event => event.type === 'turn/end');
      if (ended && ['error', 'aborted', 'blocked', 'max-tokens', 'orphaned'].includes(ended.reason?.kind)) {
        try {
          await this.call(agent, 'fail_initialization', { request_id: pending.request_id,
            reason: `初始化所在 Agent 回合结束：${ended.reason.kind}。具体原因见原聊天，已有产物保留，可修复后重试。` }, { signal });
          return this.call(agent, 'status', {}, { signal, human });
        } catch (error) {
          // Core 尚持锁时不抢占、不伪装已取消；之后的真实状态读取可再核对。
          if (error.result?.error?.code !== 'busy' && error.result?.error?.code !== 'stale_request') throw error;
        }
      }
    }
    return result;
  }

  run(request, signal) {
    signal?.throwIfAborted();
    return new Promise((accept, reject) => {
      const child = spawn(this.config.pythonExecutable, ['-B', '-u', `${ROOT}/python/bridge.py`], {
        cwd: ROOT, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
      });
      let output = '', stderr = '', bytes = 0, failure, killTimer;
      const stop = reason => {
        failure ??= reason instanceof Error ? reason : new Error(String(reason));
        if (!child.stdin.destroyed) child.stdin.write('{"cancel":true}\n', () => {});
        killTimer ??= setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          if (process.platform === 'win32') {
            // 等待 Worker 真实退出后才结算，taskkill 覆盖其引擎子进程。
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => { child.kill(); });
            killer.on('close', code => { if (code !== 0 && child.exitCode === null) child.kill(); });
          } else {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }
        }, this.config.cancelGraceMs);
      };
      const onAbort = () => stop(signal.reason ?? new Error('翻译操作已取消'));
      const timer = setTimeout(() => stop(new Error('翻译作业超时；正在回收 Worker，已有产物保留')), this.config.timeoutMs);
      const entry = { stop, child, done: null };
      entry.done = new Promise(resolveDone => { child.once('close', resolveDone); });
      this.running.add(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes <= 16 * 1024 * 1024) output += chunk;
        else stop(new Error('Worker 结果超过 16 MiB，请缩小读取范围；完整作业记录保留'));
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
      child.stdin.on('error', () => {});
      child.on('error', error => { failure = error; });
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        this.running.delete(entry);
        try {
          const value = JSON.parse(output.trim());
          // 若取消到达时 Core 已完成，保留真实结果而非伪装回滚。
          if (failure) value.lifecycle_notice = failure.message;
          accept(value);
        } catch {
          reject(new Error(`${failure?.message ?? `Worker 退出 ${code} 且未返回有效结果`}\n${stderr}`));
        }
      });
      child.stdin.write(`${JSON.stringify(request)}\n`);
      if (signal?.aborted) onAbort();
    });
  }

  async readSkill(path = 'SKILL.md', offset = 0, limit = 20_000) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 30_000) throw new Error('资料读取范围无效');
    const base = await realpath(`${ROOT}/skills/game-translation`);
    const target = await realpath(resolve(base, path));
    const { relative, isAbsolute } = await import('node:path');
    const rel = relative(base, target);
    if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('资料路径必须位于随包 Skill 内');
    const text = await readFile(target, 'utf8');
    return { path: rel, text: text.slice(offset, offset+limit), next_offset: offset+limit < text.length ? offset+limit : null };
  }

  async dispose() {
    this.closed = true;
    const running = [...this.running];
    for (const entry of running) entry.stop(new Error('插件卸载，正在停止后台作业'));
    await Promise.all(running.map(entry => entry.done));
  }
}
