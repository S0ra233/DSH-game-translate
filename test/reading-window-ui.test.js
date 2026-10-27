import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { headlessCheck } from './headless-check.mjs';

test('完整阅读组：跨组检索后首尾可达、分页有界、补页和后台更新不跳位、编辑固定', { timeout: 45000 }, async t => {
  const browser = process.env.DSH_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  try { await access(browser); } catch { t.skip('需要本机 Chromium'); return; }
  const folder = await mkdtemp(resolve('.test-output/reading-window-ui-'));
  const source = `import React from 'react';import {createRoot} from 'react-dom/client';
    import {App} from ${JSON.stringify(resolve('src/client/App.jsx').replaceAll('\\', '/'))};
    const names=Array.from({length:5},(_,i)=>({id:'n'+i,type:'speaker',text:'ミナ',translation:'米娜',scene_id:'s'+i,status:'PROCESSED',revision:1,source_hash:'n'+i}));
    const tasks=Array.from({length:500},(_,i)=>({id:'t'+i,type:'dialogue',speaker:'ミナ',text:'原文第'+i+'段。',translation:'译文第'+i+'段。',scene_id:'s'+Math.floor(i/100),status:'PROCESSED',revision:1,source_hash:'h'+i}));
    const sections=names.map((n,i)=>({id:n.scene_id,title:'story.ks:*chapter'+i,short_title:'*chapter'+i,boundary:'标签片段',paragraph_count:100}));
    const group={id:'g',title:'story.ks · 500 段',scene_ids:sections.map(s=>s.id),sections,counts:{PROCESSED:505}};
    const intro={id:'intro',title:'开头',scene_ids:['intro'],sections:[],counts:{NONE:1}};
    let version=1;const listeners=new Set(),notify=name=>{for(const callback of listeners)callback(name)};const calls=[];
    const cursor=position=>JSON.stringify({project_id:'p',generation:'v'+version,group_id:'g',position});
    const page=start=>{const end=Math.min(500,start+40),used=new Set(tasks.slice(start,end).map(t=>t.scene_id)),speakers=names.filter(n=>used.has(n.scene_id));return {project_id:'p',generation:'v'+version,group,sections:sections.filter(s=>used.has(s.id)),tasks:[...speakers,...tasks.slice(start,end)].sort((a,b)=>((a.type==='speaker'?Number(a.id.slice(1))*200: Number(a.id.slice(1))*2+1)-(b.type==='speaker'?Number(b.id.slice(1))*200:Number(b.id.slice(1))*2+1))),
      task_order:{...Object.fromEntries(speakers.map(n=>[n.id,Number(n.id.slice(1))*200])),...Object.fromEntries(tasks.slice(start,end).map((t,i)=>[t.id,(start+i)*2+1]))},positions:tasks.slice(start,end).map((t,i)=>[t.id,start+i]),
      window:{start,end,total:500,before:start?cursor(start):null,after:end<500?cursor(end):null},partial:true};};
    const api=async(action,args={})=>{calls.push({action,args});
      if(action==='snapshot')return {state:{version,binding:{project_id:'p',phase:'project_ready'}},stamp:String(version),models:[]};
      if(action==='reading-groups')return {groups:[intro,group],next_offset:null};
      if(action==='reading-group')return {project_id:'p',group:intro,sections:[],tasks:[{id:'intro',scene_id:'intro',type:'dialogue',text:'开头',translation:''}],next_offset:null};
      if(action==='search-close')return {released:true};
      if(action==='search-query'){const active=Boolean(args.query.fields?.source?.text);return {project_id:'p',generation:'v'+version,query_key:JSON.stringify(args.query),active,total:active?1:0,next_cursor:null,
        hits:active?[{anchor:251,task_id:'t250',kind:'dialogue',speaker_task_id:'n',group_id:'g',label:group.title,source:tasks[250].text,target:tasks[250].translation,matches:[{task_id:'t250',fields:{source:['原文']},status:'PROCESSED'}]}]:[]};}
      if(action==='search-locate'){await new Promise(r=>setTimeout(r,12));
        if(args.window_cursor){const c=JSON.parse(args.window_cursor);return page(Math.max(0,args.direction==='before'?c.position-40:args.direction==='around'?c.position-20:c.position));}
        const pos=args.section_id?Number(args.section_id.slice(1))*100:Number(args.task_id.slice(1));return {...page(Math.max(0,pos-20)),task_id:'t'+pos};}
      throw Error('Unexpected '+action);
    };api.subscribe=callback=>{listeners.add(callback);return()=>listeners.delete(callback)};
    localStorage.clear();createRoot(document.getElementById('root')).render(<App api={api} sessionId="continuous" nativeChrome/>);
    const pause=ms=>new Promise(r=>setTimeout(r,ms)),check=(ok,label)=>{if(!ok)throw Error(label+' '+JSON.stringify({reads:calls.slice(-6),rows:[...document.querySelectorAll('[data-task-id]')].map(n=>n.dataset.taskId),scroll:document.querySelector('.reader-scroll')?.scrollTop,height:document.querySelector('.reader-scroll')?.scrollHeight,notice:document.querySelector('.notice')?.textContent}))},$=s=>document.querySelector(s);
    const visible=()=>{const c=$('.reader-scroll'),top=c.getBoundingClientRect().top+c.clientTop;const n=[...c.querySelectorAll('[data-task-id]')].find(n=>n.getBoundingClientRect().bottom>top+15);return n?{id:n.dataset.taskId,offset:n.getBoundingClientRect().top-top}:null};
    const scroll=async where=>{const c=$('.reader-scroll');c.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true}));c.scrollTop=where==='end'?c.scrollHeight:where==='start'?0:where;await pause(230)};
    (async()=>{await pause(200);$('[aria-label="检索"]').click();await pause(220);
      const field=$('input[aria-label="检索原文"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'原文');field.dispatchEvent(new Event('input',{bubbles:true}));await pause(230);
      $('.search-result').click();await pause(700);
      check($('[data-task-id="t250"]'),'target available');
      check(document.querySelectorAll('.text-pair').length<=240,'bounded initial DOM');
      const outline=$('.reading-outline');check(outline.querySelector('summary').textContent.includes('5 个来源片段'),'outline represents the complete group');
      outline.open=true;check(!outline.querySelectorAll('button')[4].disabled,'unloaded source section can still be chosen');outline.querySelectorAll('button')[4].click();await pause(700);
      check($('[data-task-id="t400"]'),'source outline can locate an unloaded section');
      $('[aria-label="收起检索"]').click();await pause(230);
      await scroll('end');check($('[data-task-id="t499"]'),'whole group end is reachable');
      await scroll('start');check($('[data-task-id="t0"]'),'whole group beginning is reachable');
      $('[aria-label="检索"]').click();await pause(230);
      let checkedAnchor=false;
      for(let i=0;i<8;i++){
        const c=$('.reader-scroll'),content=$('.paired-text').getBoundingClientRect();
        c.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true}));
        c.scrollTop+=content.bottom-c.getBoundingClientRect().bottom+80;
        const anchor=visible();await pause(200);const next=visible();
        if(anchor&&next&&anchor.id===next.id){check(Math.abs(anchor.offset-next.offset)<2.1,'prepend/append preserves pixel anchor');checkedAnchor=true;}
        check(document.querySelectorAll('.text-pair').length<=240,'old pages evicted from DOM');
      }
      check(checkedAnchor,'read continuation anchor exercised');
      const c=$('.reader-scroll');await scroll(c.scrollTop+100);
      const old=visible();check(old&&old.id!=='t400','user moved away from last navigation');
      const changed=Math.max(0,Number(old.id.slice(1))-1);tasks[changed]={...tasks[changed],translation:'后台更新后更长的一段译文。'.repeat(35),revision:2};
      version++;notify('refresh');await pause(700);const next=visible();
      check(calls.some(c=>c.action==='search-locate'&&c.args.rebase&&c.args.task_id===old.id),'background reader rebase actually ran');
      check(next?.id===old.id&&Math.abs(next.offset-old.offset)<2.1,'Agent/background update keeps current paragraph instead of centering old hit');
      const node=$('[data-task-id="'+next.id+'"]');node.querySelector('.translation-edit-button').click();await pause(40);
      const area=$('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'人工未保存输入');area.dispatchEvent(new Event('input',{bubbles:true}));await pause(30);
      const count=calls.filter(c=>c.action==='search-locate').length;
      version++;notify('refresh');await scroll('end');await pause(500);
      check($('textarea')?.value==='人工未保存输入','pending edit stays mounted');
      check(calls.filter(c=>c.action==='search-locate').length===count,'reading pauses while editing');
      $('.search-result').click();await pause(50);check($('textarea')?.value==='人工未保存输入','jump retains unsaved input');
      notify('window-hidden');await pause(70);check($('textarea')?.value==='人工未保存输入','hiding preserves editor');
      check(calls.filter(c=>c.action==='search-close'&&c.args.client_id?.startsWith('reader-')).length>=3,'hidden window releases its reader work');
      notify('refresh');await pause(400);check($('textarea')?.value==='人工未保存输入','showing retains unsaved editor');
      check(!calls.some(c=>['initialize','translate','build'].includes(c.action)),'no paid actions');
      document.getElementById('result').textContent=JSON.stringify({ok:true,dom:document.querySelectorAll('.text-pair').length,windowReads:count,actualDSH:false});
    })().catch(error=>document.getElementById('result').textContent=JSON.stringify({error:error.message,stack:error.stack}));`;
  await writeFile(join(folder, 'check.jsx'), source);
  await build({ entryPoints: [join(folder, 'check.jsx')], outfile: join(folder, 'check.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'transform', define: { 'process.env.NODE_ENV': '"production"' } });
  const html = join(folder, 'check.html');
  await writeFile(html, `<!doctype html><html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}${await readFile('src/client/surface.css', 'utf8')}</style><div id="root"></div><pre id="result">pending</pre><script src="./check.js"></script></html>`);
  const output = await headlessCheck(browser, folder, html);
  await writeFile(join(folder, 'result.html'), output);
  const encoded = /<pre id="result">([^<]*)<\/pre>/.exec(output)?.[1];
  const report = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'));
  assert.equal(report.ok, true, report.error);
});
