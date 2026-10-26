import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { NativeWindows } from '../src/native-windows.js';
import { coalesceRefresh } from '../src/client/refresh-queue.js';
import { readScenePages } from '../src/client/scene-reader.js';

test('首次加载期间 1000 次重复刷新只追加一轮，无并发 Worker 读取', async () => {
  const releases = []; let active = 0, peak = 0, reads = 0;
  const refresh = coalesceRefresh(async () => {
    reads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(resolve)); active--;
  });
  const result = refresh(); await setImmediate();
  for (let n = 0; n < 1000; n++) assert.equal(refresh(), result);
  assert.equal(reads, 1);
  releases.shift()(); await setImmediate();
  assert.equal(reads, 2); assert.equal(peak, 1);
  releases.shift()(); await result;
  assert.equal(active, 0);
});

test('读取失败可重试，隐藏/卸载时能取消未开始的追加刷新', async () => {
  let calls = 0, release;
  const refresh = coalesceRefresh(async () => {
    calls++; if (calls === 1) throw new Error('read failed');
    await new Promise(resolve => { release = resolve; });
  });
  await assert.rejects(refresh(), /read failed/);
  const next = refresh(); await setImmediate(); refresh(); refresh.cancelPending();
  release(); await next;
  assert.equal(calls, 2);
});

test('场景首批文本不等待后续页，切换场景后不发布旧结果', async () => {
  const published = []; let later, current = true;
  const pending = readScenePages({ projectId: 'p', sceneId: 's', current: () => current,
    publish: rows => published.push(rows), api: async (_action, args) => args.offset === 0
      ? { tasks: [{ id: 'first' }], next_offset: 1 } : new Promise(resolve => { later = resolve; }) });
  await setImmediate();
  assert.deepEqual(published, [[{ id: 'first' }]]);
  current = false; later({ tasks: [{ id: 'stale' }], next_offset: null }); await pending;
  assert.deepEqual(published, [[{ id: 'first' }]]);
});

async function harness(warmKeepaliveMs) {
  const folder = await mkdtemp(resolve('.test-output/startup-'));
  const children = [], events = new Map();
  const manager = new NativeWindows({ on: (name, fn) => events.set(name, fn),
    sessionQuery: { observeSession: async id => ({ header: { id, cwd: folder }, events: [], [Symbol.dispose]() {} }) } },
  { config: { pythonExecutable: 'python', dataDirectory: folder }, sessionContext() {} },
  { platform: 'win32', warmKeepaliveMs, spawnProcess: () => {
    const child = new EventEmitter(); child.messages = []; children.push(child);
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _enc, done) {
      const message = JSON.parse(chunk.toString()); child.messages.push(message);
      if (message.kind === 'bootstrap') queueMicrotask(() => child.stdout.write('{"kind":"ready"}\n'));
      if (message.kind === 'window' && message.action === 'close') queueMicrotask(() => child.emit('close', 0));
      done();
    } }); child.kill = () => child.emit('close', 0); return child;
  } });
  return { manager, children, events };
}

test('最多保留一个隐藏窗口，隐藏时不转发刷新；重新打开复用同一进程', async () => {
  const { manager, children, events } = await harness(60_000);
  try {
    await manager.open('a'); const a = manager.windows.get('a');
    children[0].stdout.write('{"kind":"hidden"}\n');
    const before = children[0].messages.length; events.get('api-session/status')('a');
    assert.equal(children[0].messages.length, before);
    await manager.open('a'); assert.equal(children.length, 1); assert.equal(a.hidden, false);
    children[0].stdout.write('{"kind":"hidden"}\n');
    await manager.open('b'); children[1].stdout.write('{"kind":"hidden"}\n');
    await a.done;
    assert.equal(manager.windows.has('a'), false); assert.equal(manager.windows.get('b').hidden, true);
  } finally { await manager.dispose(); }
});

test('隐藏窗口超过保留时限会释放，随后打开可正常重建', async () => {
  const { manager, children } = await harness(10);
  try {
    await manager.open('a'); const old = manager.windows.get('a');
    let rejectExpiry;
    const expired = new Promise((_, reject) => { rejectExpiry = reject; });
    const deadline = setTimeout(() => rejectExpiry(new Error('idle window did not release')), 1000);
    try {
      children[0].stdout.write('{"kind":"hidden"}\n');
      await Promise.race([old.done, expired]);
    } finally { clearTimeout(deadline); }
    assert.equal(manager.windows.size, 0);
    await manager.open('a'); assert.equal(children.length, 2);
  } finally { await manager.dispose(); }
});
