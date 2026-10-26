import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { headlessCheck } from './headless-check.mjs';
import { build } from 'esbuild';

test('离屏真实鼠标跨越译文到铅笔保持显示并可点击；淡出可中断；编辑保存与布局不变', { timeout: 45000 }, async t => {
  const browser = process.env.DSH_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  try { await access(browser); } catch { t.skip('需要本机 Chromium；不打开 DSH 或可见窗口'); return; }
  const folder = await mkdtemp(resolve('.test-output/edit-entry-'));
  const source = `import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {PairedText} from ${JSON.stringify(resolve('src/client/Reader.jsx').replaceAll('\\', '/'))};
    const tasks=[{id:'name',type:'speaker',scene_id:'s',text:'ミナ',translation:'米娜',revision:1,source_hash:'name-hash',status:'PROCESSED'},
      {id:'dialogue',type:'dialogue',scene_id:'s',speaker:'ミナ',text:'また明日、ここで会いましょう。',translation:'明天还在这里见面。',revision:2,source_hash:'text-hash',status:'PROCESSED'}];
    const calls=[];
    function Reader(){const [rows,setRows]=useState(tasks);return <div className="dsh-translate" data-native="true" data-surface="white"><div className="reader-scroll"><PairedText tasks={rows} projectId="fixture" onEditing={()=>true} onSaved={task=>{if(task)setRows(rows=>rows.map(row=>row.id===task.id?task:row))}} api={async(action,args)=>{calls.push({action,args});return {task:{...rows.find(row=>row.id===args.task_id),translation:args.translation,revision:3}}}} /></div></div>}
    createRoot(document.getElementById('root')).render(<Reader/>);
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const check=(condition,label)=>{if(!condition)throw Error(label)};
    (async()=>{
      await pause(150);
      window.hoverReady=true;await new Promise(resolve=>window.resumeEntryChecks=resolve);
      const cell=document.querySelector('.translation-cell'),p=cell.querySelector('p'),button=cell.querySelector('.translation-edit-button');
      check(button,'pencil exists');
      const rect=()=>{const r=p.getBoundingClientRect();return JSON.stringify([r.x,r.y,r.width,r.height])};
      const before=rect();
      p.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await pause(30);
      check(!document.querySelector('textarea'),'double-click must remain text selection');
      button.focus();await pause(180);
      check(Number(getComputedStyle(button).opacity)===1,'focused pencil visible');
      check(rect()===before,'pencil must not move text');
      const r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      check(hit===button||button.contains(hit),'pencil is not clipped by lazy rendering');
      button.click();await pause(30);
      check(document.querySelector('textarea')?.value==='明天还在这里见面。','pencil opens text editor');
      document.querySelector('.edit-target').click();await pause(30);
      check(document.querySelector('textarea')?.value==='米娜','name edit retained');
      document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await pause(30);
      check(!document.querySelector('textarea')&&calls.length===0,'cancel name does not write');
      document.querySelector('.translation-edit-button').click();await pause(30);
      const input=document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'人工修改后的译文。');
      input.dispatchEvent(new Event('input',{bubbles:true}));await pause(30);
      check(document.querySelector('.edit-target').disabled,'dirty input must not be lost by changing target');
      document.querySelector('form').requestSubmit();await pause(60);
      check(calls.length===1&&calls[0].action==='edit-translation','same save channel');
      check(calls[0].args.task_id==='dialogue'&&calls[0].args.translation==='人工修改后的译文。','correct Task saved');
      check(calls[0].args.expected_revision===2&&calls[0].args.expected_source_hash==='text-hash','edit conflict checks retained');
      check(!document.querySelector('textarea')&&document.querySelector('.editable-translation').textContent.includes('人工修改后的译文。'),'saved reading restored');
      check(document.querySelector('.text-pair > p').textContent.includes('また明日'),'source unchanged');
      document.getElementById('result').textContent=JSON.stringify({ok:true,calls,visibleWindow:false,actualDSH:false});
    })().catch(error=>document.getElementById('result').textContent=JSON.stringify({error:error.message,stack:error.stack}));`;
  const jsx = join(folder, 'check.jsx'); await writeFile(jsx, source);
  await build({ entryPoints: [jsx], outfile: join(folder, 'check.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'transform', define: { 'process.env.NODE_ENV': '"production"' } });
  const html = join(folder, 'check.html');
  await writeFile(html, `<!doctype html><html data-material-host="native"><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}${await readFile('src/client/surface.css', 'utf8')}</style><div id="root"></div><pre id="result">pending</pre><script src="./check.js"></script></html>`);
  const output = await headlessCheck(browser, folder, html, { exercise: async command => {
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || 'Hover evaluation failed');
      return result.result.value;
    };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const move = (x, y) => command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await evaluate(`(async()=>{for(let i=0;i<100&&!window.resumeEntryChecks;i++)await new Promise(resolve=>setTimeout(resolve,30));if(!window.resumeEntryChecks)throw Error('Reader not ready');})()`);
    assert.equal(await evaluate(`matchMedia('(hover:hover)').matches`), true, 'Check must exercise mouse hover rather than touch fallback');
    const initial = await evaluate(`(()=>{const p=document.querySelector('.editable-translation').getBoundingClientRect();return [p.x,p.y,p.width,p.height]})()`);
    for (const surface of ['white', 'glass']) {
      await evaluate(`document.querySelector('.dsh-translate').dataset.surface=${JSON.stringify(surface)}`);
      await move(2, 700); await pause(400);
      assert.equal(await evaluate(`Number(getComputedStyle(document.querySelector('.translation-edit-button')).opacity)`), 0);
      const bounds = await evaluate(`(()=>{
        const cell=document.querySelector('.translation-cell').getBoundingClientRect(),p=document.querySelector('.editable-translation').getBoundingClientRect(),button=document.querySelector('.translation-edit-button').getBoundingClientRect();
        return {cellRight:cell.right,p:{x:p.x,y:p.y,width:p.width,height:p.height,right:p.right},button:{x:button.x,y:button.y,width:button.width,height:button.height,right:button.right}};
      })()`);
      assert.ok(bounds.cellRight >= bounds.button.right, 'Button and bridge must lie inside shared hover hit area');
      const y = bounds.button.y + bounds.button.height / 2;
      await move(bounds.p.x + 30, y); await pause(240);
      // Pause longer than the exit grace at each gap: a delayed hide cannot mask a broken hit box.
      for (const x of [bounds.p.right - 3, bounds.p.right + 1, bounds.button.x - 1, bounds.button.x + bounds.button.width / 2]) {
        await move(x, y); await pause(340);
        const state = await evaluate(`(()=>{const cell=document.querySelector('.translation-cell'),button=cell.querySelector('button');return {hover:cell.matches(':hover'),opacity:Number(getComputedStyle(button).opacity),pointer:getComputedStyle(button).pointerEvents};})()`);
        assert.deepEqual(state, { hover: true, opacity: 1, pointer: 'auto' }, surface + ': slow text-to-button movement');
      }
      const layout = await evaluate(`(()=>{const p=document.querySelector('.editable-translation').getBoundingClientRect();return [p.x,p.y,p.width,p.height]})()`);
      assert.deepEqual(layout, initial, 'Hover/material must not move text');
      await move(2, 700); await pause(50);
      assert.equal(await evaluate(`Number(getComputedStyle(document.querySelector('.translation-edit-button')).opacity)`), 1, 'Short exit should retain icon');
      await pause(150);
      const fading = await evaluate(`Number(getComputedStyle(document.querySelector('.translation-edit-button')).opacity)`);
      assert.ok(fading > 0 && fading < 1, 'Icon must fade rather than jump');
      await move(bounds.button.x + bounds.button.width / 2, y); await pause(240);
      assert.equal(await evaluate(`Number(getComputedStyle(document.querySelector('.translation-edit-button')).opacity)`), 1, 'Re-entry reverses current transition');
      for (const type of ['mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, x: bounds.button.x + bounds.button.width / 2, y, button: 'left', clickCount: 1 });
      await pause(40);
      assert.equal(await evaluate(`document.querySelector('textarea')?.value`), '明天还在这里见面。', 'Real mouse click opens editor');
      const save = await evaluate(`(()=>{const r=document.querySelector('.edit-actions .primary').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await move(save.x, save.y); await pause(200);
      const saveStyle = await evaluate(`(()=>{const button=document.querySelector('.edit-actions .primary'),s=getComputedStyle(button);return {label:button.textContent,color:s.color,background:s.backgroundColor,opacity:s.opacity,visibility:s.visibility}})()`);
      assert.equal(saveStyle.label, '保存'); assert.equal(saveStyle.color, 'rgb(255, 255, 255)');
      assert.equal(saveStyle.opacity, '1'); assert.equal(saveStyle.visibility, 'visible');
      assert.equal(saveStyle.background, surface === 'glass' ? 'rgb(51, 51, 54)' : 'rgb(24, 24, 27)', 'Save hover must retain dark fill and readable white label');
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await pause(40);
      assert.equal(await evaluate(`Boolean(document.querySelector('textarea'))`), false);
    }
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.translation-edit-button')).transitionDuration.split(',').every(value=>parseFloat(value)===0)`), true, 'Reduced motion removes animation');
    await command('Emulation.setEmulatedMedia', { features: [] });
    await move(2, 700); await pause(400);
    await evaluate('window.resumeEntryChecks()');
  } });
  await writeFile(join(folder, 'result.html'), output);
  const encoded = /<pre id="result">([^<]*)<\/pre>/.exec(output)?.[1];
  assert.ok(encoded && encoded !== 'pending', 'must finish browser checks');
  const report = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'));
  assert.equal(report.ok, true, report.error);
});
