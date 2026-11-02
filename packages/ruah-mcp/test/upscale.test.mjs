// Tiling, stitching and transparency shared with the web (src/lib/upscale.ts), checked with stand-in models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upscale } from '../../../src/lib/upscale.ts';

/** Every pixel different, so any misplaced pixel shows. `alpha(i)` gives each pixel's alpha (opaque by default). */
function pattern(w, h, alpha = () => 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i & 255, (i >> 8) & 255, (i * 7) & 255, alpha(i)], i * 4);
  return { data, width: w, height: h };
}

/** Nearest-neighbour ×scale: what stitching must give back when the model only looks at one pixel. */
function nearest(img, scale) {
  const w = img.width * scale;
  const h = img.height * scale;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / scale) * img.width + Math.floor(x / scale)) * 4;
      data.set(img.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

/**
 * Stand-in for Swin2SR: RGB out (like the real pipeline), the input padded up to a multiple of 8 like
 * its window — the padding filled with a colour that must never show — then nearest-neighbour ×scale.
 * `seen` collects every input; `level` maps each output value (a drifting model).
 */
function fakeModel(scale, seen = [], level = (v) => v) {
  return async (px) => {
    seen.push(px);
    const pw = Math.ceil(px.width / 8) * 8;
    const ph = Math.ceil(px.height / 8) * 8;
    const w = pw * scale;
    const h = ph * scale;
    const data = new Uint8ClampedArray(w * h * 3).fill(99);
    for (let y = 0; y < px.height * scale; y++) {
      for (let x = 0; x < px.width * scale; x++) {
        const s = (Math.floor(y / scale) * px.width + Math.floor(x / scale)) * 4;
        data.set([level(px.data[s]), level(px.data[s + 1]), level(px.data[s + 2])], (y * w + x) * 3);
      }
    }
    return [{ data, width: w, height: h, channels: 3 }];
  };
}

const same = (a, b, msg) => {
  assert.deepEqual([a.width, a.height], [b.width, b.height], msg);
  assert.ok(Buffer.from(a.data.buffer).equals(Buffer.from(b.data.buffer)), msg);
};
const sizes = (seen) => seen.map((p) => [p.width, p.height]);

test('a small opaque image is one model call; the window padding is cut off and the result is opaque', async () => {
  for (const scale of [2, 4]) {
    const img = pattern(13, 7);
    const seen = [];
    const up = await upscale(img, scale, fakeModel(scale, seen));
    assert.deepEqual(sizes(seen), [[13, 7]]);
    assert.equal(up.tiles, 1);
    same(up, nearest(img, scale), `×${scale}`);
  }
});

test('a large image is tiled with overlap margins and stitched back without a seam', async () => {
  const img = pattern(600, 300);
  const seen = [];
  const steps = [];
  const up = await upscale(img, 2, fakeModel(2, seen), (done, total) => steps.push(`${done}/${total}`));
  assert.equal(up.tiles, 6);
  // Each 256² cell is sent with up to 16 px of context on each side, clipped at the image edge.
  assert.deepEqual(sizes(seen), [[272, 272], [288, 272], [104, 272], [272, 60], [288, 60], [104, 60]]);
  assert.deepEqual(steps, ['0/6', '1/6', '2/6', '3/6', '4/6', '5/6', '6/6']);
  same(up, nearest(img, 2));
});

test('up to 512 px on the longest side runs whole; one pixel more is tiled', async () => {
  const seen = [];
  assert.equal((await upscale(pattern(512, 40), 2, fakeModel(2, seen))).tiles, 1);
  assert.equal((await upscale(pattern(513, 40), 2, fakeModel(2, seen))).tiles, 3);
  assert.deepEqual(sizes(seen.slice(0, 1)), [[512, 40]]);
});

test('grey model output becomes grey RGB; an output smaller than asked for is an error', async () => {
  const grey = async (px) => ({ data: new Uint8ClampedArray(px.width * px.height * 4).fill(7), width: px.width * 2, height: px.height * 2, channels: 1 });
  const up = await upscale(pattern(5, 3), 2, grey);
  assert.deepEqual([...up.data.subarray(0, 8)], [7, 7, 7, 255, 7, 7, 7, 255]);
  const short = async (px) => ({ data: new Uint8ClampedArray(9), width: px.width * 2 - 1, height: px.height * 2, channels: 3 });
  await assert.rejects(upscale(pattern(5, 3), 2, short), /returned 9×6 for a 5×3 tile at ×2/);
});

test('transparency is kept: the alpha goes through the model as a grey image, tiled like the colour', async () => {
  const img = pattern(600, 300, (i) => 64 + (i % 190)); // all partly transparent, none below 64: colour untouched
  const seen = [];
  const up = await upscale(img, 2, fakeModel(2, seen));
  assert.equal(up.tiles, 6);
  assert.equal(seen.length, 12); // colour, then alpha, per tile
  const alphaPass = seen[1];
  assert.equal(alphaPass.data[0], img.data[3]); // grey = the alpha
  assert.equal(alphaPass.data[3], 255);
  same(up, nearest(img, 2));
});

test('hidden colour is filled from around it; solid and clear areas stay exactly 255 and 0', async () => {
  // Left half solid red, right half clear with a black hidden colour (what a browser decodes).
  const img = pattern(16, 8, (i) => (i % 16 < 8 ? 255 : 0));
  for (let i = 0; i < 16 * 8; i++) img.data.set(i % 16 < 8 ? [200, 30, 30] : [0, 0, 0], i * 4);
  const seen = [];
  // A model that drifts like the ×4 one: solid 255 comes back 250, clear 0 comes back 5.
  const up = await upscale(img, 4, fakeModel(4, seen, (v) => Math.round(5 + v * (245 / 255))));
  const colourIn = seen[0];
  for (let i = 0; i < 16 * 8; i++) assert.ok(colourIn.data[i * 4] > 150, `pixel ${i}: the model saw the hidden black`);
  const at = (x, y) => [...up.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
  assert.equal(at(0, 0)[3], 255); // solid, far from the edge
  assert.deepEqual(at(63, 31), [0, 0, 0, 0]); // clear, far from the edge: no alpha, no colour
  assert.equal(at(31, 0)[3], 250); // at the edge the model's alpha stands
  assert.equal(at(32, 0)[3], 5);
});

test('a colour under low alpha leans to its surroundings; from alpha 64 up it is kept', async () => {
  const img = pattern(8, 8);
  for (let i = 0; i < 64; i++) img.data.set([200, 30, 30, 255], i * 4);
  // A quarter sure: ¾ of its colour comes from its 2×2 parent — three reds and a quarter of itself,
  // 3/3.25 red — so it becomes ¾ × 3/3.25 = 0.69 red.
  img.data.set([0, 0, 0, 16], (3 * 8 + 3) * 4);
  img.data.set([0, 0, 200, 64], (5 * 8 + 5) * 4); // sure: kept as is
  const seen = [];
  await upscale(img, 2, fakeModel(2, seen));
  const px = (x, y) => [...seen[0].data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 3)];
  assert.deepEqual(px(3, 3), [138, 21, 21]);
  assert.deepEqual(px(5, 5), [0, 0, 200]);
});

test('tiles that are wholly solid skip the alpha pass, wholly clear ones both passes', async () => {
  // 768×256 → three 256² tiles: solid (with margins), mixed, clear.
  const img = pattern(768, 256, (i) => (i % 768 < 300 ? 255 : 0));
  for (let i = 0; i < 768 * 256; i++) if (i % 768 >= 300) img.data.set([0, 0, 0], i * 4);
  const seen = [];
  const up = await upscale(img, 2, fakeModel(2, seen));
  assert.equal(up.tiles, 3);
  assert.deepEqual(sizes(seen), [[272, 256], [288, 256], [288, 256]]); // solid: colour · mixed: colour, alpha · clear: none
  same(up, nearest(img, 2));
});
