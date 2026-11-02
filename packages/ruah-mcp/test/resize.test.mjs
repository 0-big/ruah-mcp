// Pure logic shared with the web (src/lib/resize.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { initResizer, resize, targetDimensions } from '../../../src/lib/resize.ts';

const fit = (value, noUpscale = true) => ({ mode: 'fit', value, noUpscale });

test('targetDimensions: fit caps the longest side, percent scales, both keep proportions', () => {
  assert.deepEqual(targetDimensions(2400, 1600, fit(640)), { width: 640, height: 427 });
  assert.deepEqual(targetDimensions(1600, 2400, fit(640)), { width: 427, height: 640 });
  assert.deepEqual(targetDimensions(2400, 1600, { mode: 'percent', value: 50, noUpscale: true }), { width: 1200, height: 800 });
});

test('targetDimensions: noUpscale stops at the original size; never below 1px', () => {
  assert.deepEqual(targetDimensions(640, 480, fit(1280)), { width: 640, height: 480 });
  assert.deepEqual(targetDimensions(640, 480, fit(1280, false)), { width: 1280, height: 960 });
  assert.deepEqual(targetDimensions(1000, 1, { mode: 'percent', value: 1, noUpscale: true }), { width: 10, height: 1 });
});

test('resize: pixels that are a view into a larger buffer are read from their own offset', async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve('@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm');
  await initResizer(await WebAssembly.compile(await readFile(wasm)));
  const n = 8 * 8 * 4;
  const buf = new ArrayBuffer(n * 2); // first half stays transparent black
  const data = new Uint8ClampedArray(buf, n, n);
  for (let i = 0; i < n; i += 4) data.set([200, 100, 50, 255], i);
  const out = await resize({ data, width: 8, height: 8 }, { mode: 'percent', value: 50, noUpscale: true });
  assert.equal(out.width, 4);
  for (let i = 0; i < out.data.length; i += 4) {
    const px = [...out.data.slice(i, i + 4)];
    [200, 100, 50, 255].forEach((v, c) => assert.ok(Math.abs(px[c] - v) <= 1, `pixel ${i / 4} is ${px}`));
  }
});
