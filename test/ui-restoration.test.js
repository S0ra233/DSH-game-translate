import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createHostBridge } from '../src/client/webview-bridge.js';

const hash = text => createHash('sha256').update(text).digest('hex');
test('保留原菜单与设置，仅排除已获准的检索和进度入口、阅读分栏、编辑保护和材质变化', async () => {
  const [app, css, raw] = await Promise.all([
    readFile('src/client/App.jsx', 'utf8'), readFile('src/client/surface.css', 'utf8'), readFile('test/fixtures/ui-0.2.8.json', 'utf8'),
  ]);
  const baseline = JSON.parse(raw);
  const controls = app.slice(app.indexOf('  return <div ref={root}'), app.indexOf('\nfunction emptyModel()'))
    .replace(/^[ \t]*<button className=\{`icon-pill search-entry[^\n]*\n/m, '')
    .replace(/^[ \t]*<TaskProgress\b[^\n]*\n/m, '')
    .replace(/    <div className="translation-workspace"[\s\S]*?\n    <\/div>/, block => {
      const main = block.match(/      <main [\s\S]*?\n      <\/main>/)?.[0];
      assert.ok(main, 'search layout retains the original reader');
      return main.split('\n').filter(line => !line.includes('className="reader-virtual-space"')).map(line => line.slice(2)).join('\n').replace(' ref={reader}', '').replace(' onScroll={onReaderScroll}', '');
    })
    .replaceAll('<Select', '<select').replaceAll('</Select>', '</select>')
    .replaceAll('shownDialog', 'dialog').replaceAll('shownMenu', 'menu')
    .replace(/ data-open=\{(?:menu|Boolean\(dialog\))\} aria-hidden=\{!(?:menu|dialog)\} inert=\{(?:menu|dialog) \? undefined : ''\}/g, '')
    .replace(/ aria-label="(?:翻译模型|字体|行间距)"/g, '')
    .replace(/ spellCheck=\{false\} autoCapitalize="none"/g, '')
    .replace(/ autoComplete="off"(?= onBlur)/g, '')
    .replace(/ onBlur=\{event => modelChange\('(?:name|baseURL|apiKey|model)', event.target.value.trim\(\)\)\}/g, '')
    .replace(/^.*\{preferences\.surface === 'glass'.*$/gm, '')
    .replace('disabled={!scenes.length || editingCount > 0}', 'disabled={!scenes.length}')
    .replace('aria-expanded={menu} disabled={editingCount > 0}', 'aria-expanded={menu}')
    .replace('aria-label="选择阅读分组"', 'aria-label="选择场景"')
    .replace('选择阅读组', '选择 Scene')
    .replace('选择要翻译的阅读分组', '选择要翻译的场景')
    .replace('project_id: snapshot.state.binding.project_id, group_ids: selected, mode,', 'scene_ids: selected, mode,')
    .replace(/<PairedText tasks=\{tasks\}[^>]*\/>/, '<PairedText tasks={tasks} />').replace(/\r\n/g, '\n').trimEnd();
  assert.equal(hash(controls), baseline.chrome);
  assert.equal(hash(css.split(/\r?\n/)[1]), baseline.controlStyles);
  assert.match(css, /\.settings-dialog\{width:450px\}/);
});

test('同一材质输入不重复派发；预览不经过 DSH 请求；业务响应按编号回传，关闭清理挂起读取', async () => {
  const sent = [], events = [];
  const bridge = createHostBridge({ send: value => sent.push(value), notify: value => events.push(value) });
  const appearance = { surface: 'glass', milk: 5, softLight: 15, apiKey: 'must-not-leave-preview' };
  for (let i = 0; i < 1000; i++) bridge.sendMaterial(appearance);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { kind: 'material', preferences: { surface: 'glass', milk: 5, softLight: 15 } });
  const first = bridge.api('snapshot'), second = bridge.api('pick-game');
  bridge.receive({ kind: 'response', id: sent[2].id, ok: true, value: { cancelled: true } });
  bridge.receive({ kind: 'response', id: sent[1].id, ok: true, value: { state: {} } });
  assert.deepEqual(await second, { cancelled: true }); assert.deepEqual(await first, { state: {} });
  bridge.receive({ kind: 'event', name: 'window-hidden' }); assert.deepEqual(events, ['window-hidden']);
  const unfinished = bridge.api('scene'); const rejection = assert.rejects(unfinished, /窗口已关闭/);
  bridge.dispose(); await rejection; await assert.rejects(bridge.api('snapshot'), /窗口已关闭/);
});

test('旧宿主缺少手改能力时保留输入并明确提示更新，新宿主继续原请求', async () => {
  const sent = [], bridge = createHostBridge({ send: value => sent.push(value) });
  bridge.configureHost(undefined);
  await assert.rejects(bridge.api('edit-translation', { translation: '保留此输入' }), /版本不一致.*本次修改尚未保存/);
  await assert.rejects(bridge.api('reading-groups', { project_id: 'p' }), /版本不一致.*工程内容未修改/);
  assert.equal(sent.length, 0);
  bridge.configureHost({ version: 1, actions: ['edit-translation'] });
  const saved = bridge.api('edit-translation', { translation: '新译文' });
  assert.equal(sent[0].action, 'edit-translation');
  bridge.receive({ kind: 'response', id: sent[0].id, ok: true, value: { task: { translation: '新译文' } } });
  assert.equal((await saved).task.translation, '新译文');
  bridge.dispose();
});
