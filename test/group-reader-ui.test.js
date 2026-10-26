import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { headlessCheck } from './headless-check.mjs';

test('离屏实际 App：阅读组入口、原 Scene 位置迁移、分节定位、切组及翻译提交使用分组范围', { timeout: 45000 }, async t => {
  const browser = process.env.DSH_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  try { await access(browser); } catch { t.skip('需要本机 Chromium'); return; }
  const folder = await mkdtemp(resolve('.test-output/group-ui-'));
  const jsx = `import React from 'react';import {createRoot} from 'react-dom/client';
    import {App} from ${JSON.stringify(resolve('src/client/App.jsx').replaceAll('\\', '/'))};
    const sections=[{id:'s_a',title:'chapter.ks:*a',short_title:'*a',boundary:'标签片段',paragraph_count:1},{id:'s_b',title:'chapter.ks:*b',short_title:'*b',boundary:'标签片段',paragraph_count:1}];
    const groups=[{id:'g_a',title:'chapter.ks · 1/2 · 2 段',file:'chapter.ks',scene_ids:['s_a','s_b'],counts:{NONE:3},sections},
      {id:'g_b',title:'chapter.ks · 2/2 · 1 段',file:'chapter.ks',scene_ids:['s_c'],counts:{NONE:1},sections:[{id:'s_c',title:'chapter.ks:*c',short_title:'*c',boundary:'标签片段',paragraph_count:1}]}];
    const tasks={g_a:[{id:'n_a',scene_id:'s_a',type:'speaker',text:'ミナ',translation:''},{id:'t_a',scene_id:'s_a',type:'dialogue',speaker:'ミナ',text:'第一段原文。',translation:''},{id:'t_b',scene_id:'s_b',type:'dialogue',speaker:'',text:'第二标签原文。',translation:''}],g_b:[{id:'t_c',scene_id:'s_c',type:'dialogue',speaker:'',text:'第三标签原文。',translation:''}]};
    const calls=[];const api=async(action,args={})=>{calls.push({action,args});
      if(action==='snapshot')return {state:{binding:{project_id:'p',phase:'project_ready'},version:1},stamp:'stable',models:[]};
      if(action==='reading-groups')return {project_id:'p',groups,next_offset:null};
      if(action==='reading-group'){const group=groups.find(g=>g.id===args.group_id);return {project_id:'p',group,sections:group.sections,tasks:tasks[group.id],next_offset:null};}
      if(action==='translate')return {message:'已交给原对话'};
      throw Error('Unexpected action: '+action);
    };
    localStorage.setItem('dsh-translate.scene:ui-groups','s_b');
    createRoot(document.getElementById('root')).render(<App api={api} sessionId="ui-groups" nativeChrome/>);
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),check=(ok,label)=>{if(!ok)throw Error(label)};
    (async()=>{
      await pause(250);
      const select=document.querySelector('select.scene-pill');check(select.options.length===2&&select.value==='g_a','migrate old Scene to its group');
      check(document.querySelectorAll('.text-pair').length===2,'fold names while retaining both Scene bodies');
      check(document.querySelectorAll('.reading-section').length===2,'source labels stay visible');
      const outline=document.querySelector('.reading-outline');outline.open=true;
      outline.querySelectorAll('button')[1].click();check(location.hash==='','locating section must not change native page identity');
      select.value='g_b';select.dispatchEvent(new Event('change',{bubbles:true}));await pause(80);
      check(document.querySelectorAll('.text-pair').length===1&&document.querySelector('[data-task-id="t_c"]'),'group switch replaces old content');
      select.value='g_a';select.dispatchEvent(new Event('change',{bubbles:true}));await pause(80);
      document.querySelector('[aria-label="更多操作"]').click();await pause(30);
      [...document.querySelectorAll('.menu-item')].find(button=>button.textContent==='翻译…').click();await pause(30);
      check(document.querySelectorAll('.scene-checks input').length===2,'translation choices are groups');
      check(document.querySelector('.scene-checks input').checked,'current group preselected');
      document.querySelector('[role="dialog"] .dialog-actions .primary').click();await pause(80);
      const sent=calls.find(call=>call.action==='translate');
      check(sent?.args.project_id==='p'&&JSON.stringify(sent.args.group_ids)==='["g_a"]'&&!('scene_ids' in sent.args),'group selection submitted with project identity');
      check(!calls.some(call=>call.action==='scene'||call.action==='scenes'),'reading does not request every original label');
      document.getElementById('result').textContent=JSON.stringify({ok:true,groupReads:calls.filter(call=>call.action==='reading-group').length,modelRequests:0,actualDSH:false});
    })().catch(error=>document.getElementById('result').textContent=JSON.stringify({error:error.message,stack:error.stack}));`;
  const source = join(folder, 'check.jsx'); await writeFile(source, jsx);
  await build({ entryPoints: [source], outfile: join(folder, 'check.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'transform', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const html = join(folder, 'check.html');
  await writeFile(html, `<!doctype html><html data-material-host="native"><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}${await readFile('src/client/surface.css', 'utf8')}</style><div id="root"></div><pre id="result">pending</pre><script src="./check.js"></script></html>`);
  const output = await headlessCheck(browser, folder, html); await writeFile(join(folder, 'result.html'), output);
  const encoded = /<pre id="result">([^<]*)<\/pre>/.exec(output)?.[1]; assert.ok(encoded && encoded !== 'pending');
  const report = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'));
  assert.equal(report.ok, true, report.error); assert.ok(report.groupReads >= 3);
});
