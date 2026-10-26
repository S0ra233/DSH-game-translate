import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { Context, Service } from '@deepseek-ai/cordis';
import { registerNativeWindows } from '../src/native-windows.js';

test('真实 Cordis Client 注入：先 mount，再在依赖域访问 namespace；/翻译 不再触发 without inject', async () => {
  const root = new Context();
  let source, nativeCalls = 0, mountedClient;
  class FakeRemote extends Service {
    constructor(ctx) { super(ctx, 'remote'); }
    get commands() { return this.ctx['remote.commands']; }
    get translationUi() { return this.ctx['remote.translationUi']; }
    async $mount() {
      const namespace = root.plugin({ name: 'test-remote-namespace', apply(scope) {
        scope.provide('remote.translationUi', {
          openNative: async () => { nativeCalls++; return { ok: true, value: JSON.stringify({ ok: true, value: { status: 'native-opened' } }) }; },
        });
      } });
      await namespace.await();
      return () => namespace.dispose();
    }
    $on() { return () => {}; }
  }
  new FakeRemote(root);
  root.provide('remote.commands', { execute: () => { throw new Error('打开窗口不应执行模型/命令'); } });
  root.provide('slots', { inject: (_key, callback) => callback(), register: () => () => {} });
  root.provide('inputTriggers', { registerSource: value => { source = value; return () => { source = undefined; }; } });
  root.provide('commandUi', { decorate: () => () => {} });
  const window = { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load: entry => { mountedClient = entry.factory(createRequire(import.meta.url)); } } };
  vm.runInNewContext(await readFile(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    window, navigator: { userAgent: 'Windows' }, localStorage: { getItem: () => null }, console,
  });
  const plugin = root.plugin({ name: 'translation-client-injection-test', inject: mountedClient.inject, apply: mountedClient.apply });
  try {
    await plugin.await();
    await setImmediate();
    assert.ok(source);
    const probe = root.plugin({ inject: ['remote'], apply(ctx) {
      assert.throws(() => ctx.remote.translationUi, /without inject/); // genuine runtime guard, not a permissive root mock.
    } });
    await probe.await(); await probe.dispose();
    assert.equal(source.onPick({ session: { sessionId: 'root-session' } }), 'handled');
    await setImmediate();
    assert.equal(nativeCalls, 1);
  } finally { await plugin.dispose(); await root.fiber.dispose(); }
});

test('原生窗口服务使用带 sessionQuery 注入的生命周期域', async () => {
  const root = new Context();
  const queries = { observeSession() { throw new Error('这里只核对依赖，不启动窗口'); } };
  const queryProvider = root.plugin({ apply(scope) { scope.provide('sessionQuery', queries); } });
  await queryProvider.await();
  root.provide('commands', {});
  const service = { config: {} };
  const plugin = root.plugin({ inject: ['commands'], apply: ctx => registerNativeWindows(ctx, service) });
  try {
    await plugin.await();
    assert.ok(service.nativeWindows);
    assert.doesNotThrow(() => service.nativeWindows.ctx.sessionQuery);
    assert.equal(service.nativeWindows.ctx.sessionQuery, queries);
  } finally { await plugin.dispose(); await root.fiber.dispose(); }
});
