import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaterialAnimation } from '../src/client/material-animation.js';
import { glassStyle } from '../src/appearance.js';

function clock() {
  let time = 0, id = 0;
  const queue = new Map();
  return { now: () => time, requestFrame: callback => { queue.set(++id, callback); return id; }, cancelFrame: key => queue.delete(key),
    size: () => queue.size, tick(ms) { time += ms; const callbacks = [...queue.values()]; queue.clear(); for (const callback of callbacks) callback(time); } };
}

test('快速双滑块输入只保留一条动画链，实际材质连续改变', () => {
  const timing = clock(), values = [];
  const animation = createMaterialAnimation({ ...timing, initial: { materialVersion: 2, milk: 5, softLight: 15 }, apply: value => values.push(value) });
  for (let n = 0; n < 1000; n++) animation.set({ milk: n % 2 ? 80 : 5, softLight: n % 2 ? 0 : 15 });
  assert.equal(timing.size(), 1); assert.equal(values.length, 1);
  timing.tick(16);
  assert.ok(values.at(-1).milk > 5 && values.at(-1).milk < 80);
  assert.ok(values.at(-1).softLight > 0 && values.at(-1).softLight < 15);
  for (let n = 0; n < 30; n++) timing.tick(16);
  assert.equal(values.at(-1).milk, 80); assert.equal(values.at(-1).softLight, 0); assert.equal(timing.size(), 0);
  animation.dispose();
});

test('途中反向从当前显示值继续，隐藏销毁会取消帧', () => {
  const timing = clock(), values = [];
  const animation = createMaterialAnimation({ ...timing, initial: { milk: 5, softLight: 15 }, apply: value => values.push(value) });
  animation.set({ milk: 80, softLight: 0 }); timing.tick(16); const previous = values.at(-1).milk;
  animation.set({ milk: 0, softLight: 80 }); assert.equal(values.at(-1).milk, previous);
  timing.tick(16); assert.ok(values.at(-1).milk < previous); assert.ok(values.at(-1).milk > 0);
  animation.dispose(); const count = values.length; timing.tick(300);
  assert.equal(values.length, count); assert.equal(timing.size(), 0);
});

test('减少动态效果时下一帧应用最终值，无重复队列', () => {
  const timing = clock(), values = [];
  const animation = createMaterialAnimation({ ...timing, initial: { milk: 5, softLight: 15 }, apply: value => values.push(value), reducedMotion: () => true });
  animation.set({ milk: 20, softLight: 30 }); animation.set({ milk: 40, softLight: 50 }); timing.tick(8);
  assert.deepEqual(values.at(-1), { milk: 40, softLight: 50 }); assert.equal(timing.size(), 0); animation.dispose();
});
