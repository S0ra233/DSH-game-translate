import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const executable = resolve('native/wpf/TranslationWindow-0.3.7.exe');
test('真实宿主无窗口自检：材质默认、迁移、单一过渡、原界面资源与本机渲染依赖', async () => {
  const folder = await mkdtemp(resolve('.test-output/wpf-'));
  const report = join(folder, 'check.json');
  const code = await new Promise((accept, reject) => {
    const child = spawn(executable, ['--check', report], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', reject); child.on('close', accept);
  });
  assert.equal(code, 0);
  const value = JSON.parse(await readFile(report, 'utf8'));
  for (const key of ['xaml', 'approvedDefaults', 'migration', 'materialTween', 'originalUi', 'stdioActions']) assert.equal(value[key], true);
  assert.match(value.runtime, /^\d+\./);
  assert.equal(value.createdWindow, false); assert.equal(value.visualAcceptance, 'not_run');
  assert.equal(value.nativeProtocol.hostVersion, '0.3.7');
  assert.ok(value.nativeProtocol.actions.includes('edit-translation'));
  assert.ok(value.nativeProtocol.actions.includes('reading-group'));
});

test('真实 stdio 编码与响应关联；自检分支不创建窗口或调用 DSH', async () => {
  const messages = []; let output = '', errors = '';
  const code = await new Promise((accept, reject) => {
    const child = spawn(executable, ['--wire-test'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', reject); child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk; let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const message = JSON.parse(output.slice(0, end)); output = output.slice(end + 1); messages.push(message);
        if (message.kind === 'request') child.stdin.write(JSON.stringify({ kind: 'response', id: message.id, ok: true, value: { state: {} } }) + '\n');
      }
    });
    child.stdin.write(JSON.stringify({ kind: 'bootstrap', sessionId: '根对话-中文-🎮' }) + '\n');
    child.on('close', accept);
  });
  assert.equal(code, 0, errors);
  assert.equal(messages[0].kind, 'ready');
  assert.equal(messages[1].action, 'snapshot');
  assert.equal(messages[2].session, '根对话-中文-🎮'); assert.equal(messages[2].ok, true);
});

test('设置仅开放乳白和柔光，指定帮助小字已移除', async () => {
  const browser = await readFile('src/client/App.jsx', 'utf8');
  assert.ok(browser.includes("[['milk', '乳白'], ['softLight', '柔光']]"));
  for (const key of ['edgeReflection', 'lightSpread', 'readerWhite']) assert.ok(!browser.includes("['"+key+"'"));
  assert.ok(!browser.includes('轻透 ← → 柔雾')); assert.ok(!browser.includes('保护文字清晰度'));
});
