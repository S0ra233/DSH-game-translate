import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NativeWindows, cleanAppearance } from '../src/native-windows.js';
import { glassStyle } from '../src/appearance.js';
import material from '../src/material.json' with { type: 'json' };

test('原生窗口按根会话复用；目录结果与 Agent 动作都固定交回原对话，关闭窗口不取消已派发 Agent', async () => {
  const folder = await mkdtemp(resolve('.test-output/native-window-'));
  const calls = [], replies = [];
  let starts = 0, child, agentCancelled = false;
  const agent = { id: 'root-native', cancel: () => { agentCancelled = true; } };
  const ui = { request: async (id, raw) => { calls.push(['read', id, JSON.parse(raw).action]); return JSON.stringify({ ok: true, value: { state: {} } }); },
    acceptNativeDirectory: async (id, action, path) => { calls.push(['directory', id, action, path]); return JSON.stringify({ ok: true, value: { selected: path } }); } };
  const ctx = { on() {}, sessionQuery: { observeSession: async id => ({ header: { id, cwd: folder }, events: [], [Symbol.dispose]() {} }) },
    get: name => name === 'translationUi' ? ui : name === 'typert' ? { lookups: { get: () => ({ resolve: async id => { assert.equal(id, agent.id); return agent; } }) } } : undefined,
    commands: { execute: async (target, raw) => { calls.push(['agent', target.id, raw]); return { result: { kind: 'success', text: JSON.stringify({ status: 'queued' }) } }; } } };
  const service = { config: { pythonExecutable: 'python', dataDirectory: folder }, sessionContext: header => { assert.equal(header.id, agent.id); } };
  const manager = new NativeWindows(ctx, service, { platform: 'win32', spawnProcess: (executable, args, options) => {
    assert.ok(executable.endsWith('TranslationWindow-0.3.7.exe')); assert.ok(!args.includes('--html'));
    starts++; assert.equal(options.windowsHide, true); assert.equal(options.shell, false); assert.ok(!args.includes('--owner-pid'));
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString()); replies.push(message);
      if (message.kind === 'bootstrap') queueMicrotask(() => child.stdout.write('{"kind":"ready"}\n'));
      if (message.kind === 'window' && message.action === 'close') queueMicrotask(() => child.emit('close', 0));
      done();
    } }); child.kill = () => { child.emit('close', 0); }; return child;
  } });
  try {
    await manager.open(agent.id); await manager.open(agent.id);
    assert.equal(starts, 1); assert.ok(replies.some(item => item.action === 'focus'));
    const record = manager.windows.get(agent.id);
    child.stdout.write('{"kind":"hidden"}\n');
    assert.equal(record.hidden, true);
    assert.ok(record.idleTimer);
    await manager.open(agent.id);
    assert.equal(starts, 1); assert.equal(record.hidden, false); assert.equal(record.idleTimer, null);
    assert.equal(replies.filter(item => item.kind === 'bootstrap').length, 1);
    await manager.dispatch(record, { kind: 'directory-picked', id: 'choose-1', action: 'pick-game', path: join(folder, 'game') });
    await manager.dispatch(record, { kind: 'request', id: 'read-1', action: 'snapshot', args: { sessionId: 'other-session' } });
    await manager.dispatch(record, { kind: 'request', id: 'init-1', action: 'initialize', args: {} });
    await manager.dispatch(record, { kind: 'request', id: 'edit-1', action: 'edit-translation', args: { project_id: 'test-project', task_id: 'test-task', translation: '手改译文' } });
    assert.equal(calls[0][1], agent.id); assert.equal(calls[1][1], agent.id); assert.equal(calls[2][1], agent.id);
    assert.deepEqual(calls[3], ['read', agent.id, 'edit-translation']);
    await assert.rejects(manager.dispatch(record, { kind: 'request', id: 'forge', action: 'pick-game', args: { path: 'C:/' } }), /不支持/);
    await manager.dispose();
    assert.equal(manager.windows.size, 0); assert.equal(agentCancelled, false);
  } finally { if (!manager.closed) await manager.dispose(); }
});

test('新材质默认值与旧外观迁移只保留允许字段', () => {
  const appearance = cleanAppearance({ surface: 'glass', fontSize: 999, ratio: -200, lineHeight: 2.1, frost: 100, apiKey: 'private-value', path: 'C:/private' });
  assert.deepEqual(appearance, { materialVersion: 2, surface: 'glass', font: 'system', fontSize: 24, ratio: 35, lineHeight: 2.1, milk: 5, softLight: 15 });
  assert.equal(cleanAppearance(null).surface, 'white');
  assert.equal(appearance.apiKey, undefined); assert.equal(appearance.frost, undefined);
  assert.deepEqual([material.edgeReflection, material.lightSpread, material.readerWhite], [100, 100, 20]);
});

test('乳白和柔光分别生效，范围受限且不改变固定参数', () => {
  const value = cleanAppearance({ materialVersion: 2, milk: 999, softLight: -10, surface: 'glass' });
  assert.equal(value.milk, 80); assert.equal(value.softLight, 0);
  const defaults = glassStyle(cleanAppearance({ surface: 'glass' }));
  assert.equal(defaults['--glass-base'], .05); assert.equal(defaults['--glass-light'], .15); assert.equal(defaults['--glass-reader'], .2);
  const changed = glassStyle({ materialVersion: 2, milk: 20, softLight: 50 });
  assert.equal(changed['--glass-base'], .2); assert.equal(changed['--glass-light'], .5); assert.equal(changed['--glass-blur'], defaults['--glass-blur']);
});
