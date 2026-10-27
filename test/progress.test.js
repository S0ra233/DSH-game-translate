import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressAnimation, displayedProgress, groupProgress, projectProgress } from '../src/client/progress-model.js';

test('进度只计真实处理状态；未知人工来源不伪造，重复页不重复计数', () => {
  const a = { id:'a', counts:{PROCESSED:19,NEEDS_HUMAN:10,NONE:5,ERROR:2}, manual_count:6 };
  const b = { id:'b', counts:{NONE:10}, manual_count:0 };
  const value = projectProgress([a,b,a]);
  assert.equal(value.total,46); assert.equal(value.PROCESSED,19); assert.equal(value.manual,6);
  const display=displayedProgress(groupProgress(a));
  assert.equal(display.percent,53);
  assert.equal(Object.values(display.shares).reduce((sum,n)=>sum+n,0),100);
  const thirds=displayedProgress(groupProgress({counts:{PROCESSED:1000,NEEDS_HUMAN:850,NONE:1050,ERROR:100}}));
  assert.equal(thirds.shares.PROCESSED,thirds.percent);
  assert.equal(Object.values(thirds.shares).reduce((sum,n)=>sum+n,0),100);
  assert.equal(projectProgress([a,{id:'old',counts:{PROCESSED:2}}]).manual,null);
  assert.equal(displayedProgress(groupProgress(null)).percent,0);
  assert.deepEqual(displayedProgress(groupProgress(null)).shares,{PROCESSED:0,NEEDS_HUMAN:0,NONE:0,ERROR:0});
});

test('进度连续增减从当前值接续，结束/隐藏/减少动态/卸载后不继续占用帧', () => {
  let clock=0, serial=0, reduced=false, applied;
  const pending=new Map(),value=done=>({total:3000,PROCESSED:done,NEEDS_HUMAN:0,NONE:3000-done,ERROR:0,manual:0});
  const model=createProgressAnimation({initial:value(0),requestFrame:fn=>{pending.set(++serial,fn);return serial;},cancelFrame:id=>pending.delete(id),now:()=>clock,reducedMotion:()=>reduced,apply:counts=>{applied={...counts};}});
  const tick=time=>{clock=time;const next=[...pending.values()];pending.clear();for(const fn of next)fn(clock);};
  model.set(value(3000));tick(100);assert.ok(applied.PROCESSED>0&&applied.PROCESSED<3000);
  const middle=applied.PROCESSED;model.set(value(0));tick(180);assert.ok(applied.PROCESSED<middle&&applied.PROCESSED>0);
  model.set(value(1350));tick(1000);assert.equal(applied.PROCESSED,1350);assert.equal(pending.size,0);
  model.set(value(3000));model.finish();assert.equal(applied.PROCESSED,3000);assert.equal(pending.size,0);
  reduced=true;model.set(value(30));assert.equal(applied.PROCESSED,30);assert.equal(pending.size,0);
  reduced=false;model.set(value(3000));model.dispose();tick(2000);assert.equal(applied.PROCESSED,30);assert.equal(pending.size,0);
});
