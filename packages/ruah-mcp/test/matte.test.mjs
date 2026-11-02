// Logic shared with the web (src/lib/matte.ts) — no model needed: the removers here are stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawImage } from '@huggingface/transformers';
import { cutout, focusRegion, incompleteScore, INCOMPLETE_RATIO, refineMatte } from '../../../src/lib/matte.ts';

/** w×h RGBA RawImage-like whose alpha is 255 inside [x0,x1)×[y0,y1), 0 elsewhere. */
function matte(w, h, box) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data.set([200, 100, 50], i);
      if (box && x >= box[0] && x < box[2] && y >= box[1] && y < box[3]) data[i + 3] = 255;
    }
  return { data, width: w, height: h, channels: 4 };
}

/** A w×h input image that records the regions cut out of it. */
function photo(w, h) {
  const crops = [];
  return { width: w, height: h, crops, crop: async (b) => (crops.push(b), photo(b[2] - b[0] + 1, b[3] - b[1] + 1)) };
}

test('refineMatte: transparent pixels carry no colour, opaque ones keep theirs', () => {
  const m = matte(32, 32, [8, 8, 24, 24]);
  const out = refineMatte(m.data, 32, 32);
  assert.deepEqual([...out.slice(0, 4)], [0, 0, 0, 0]); // corner: erased background
  const c = (16 * 32 + 16) * 4;
  assert.deepEqual([...out.slice(c, c + 4)], [200, 100, 50, 255]); // centre: subject
});

test('cutout: a good lite result never loads the full model', async () => {
  let loaded = false;
  const r = await cutout(photo(64, 64), async () => matte(64, 64, [16, 16, 48, 48]), async () => {
    loaded = true;
    return async () => matte(64, 64, [0, 0, 64, 64]);
  });
  assert.equal(loaded, false);
  assert.equal(r.usedFull, false);
  assert.ok(r.coverage > 20 && r.coverage < 30);
});

test('cutout: an empty lite matte escalates and keeps the fuller result', async () => {
  let refining = false;
  const r = await cutout(
    photo(64, 64),
    async () => matte(64, 64, null),
    async () => async () => matte(64, 64, [16, 16, 48, 48]),
    () => (refining = true),
  );
  assert.equal(refining, true);
  assert.equal(r.usedFull, true);
  assert.ok(r.coverage > 20);
});

test('cutout: if the full model fails, the lite result stands', async () => {
  const r = await cutout(photo(64, 64), async () => matte(64, 64, null), async () => {
    throw new Error('offline');
  });
  assert.equal(r.usedFull, false);
  assert.equal(r.coverage, 0);
});

const alphaAt = (r, x, y) => r.data[(y * r.width + x) * 4 + 3];
/** A loadFull that must not be called — it records the call, since cutout swallows load errors. */
function noFull() {
  const load = async () => {
    load.called = true;
    throw new Error('unexpected full-model load');
  };
  load.called = false;
  return load;
}

test('cutout: a small subject gets a second, closer pass, pasted back in place', async () => {
  const img = photo(400, 400);
  // Whole image: a 40×60 subject. Close up (region 58×78 at 171,171): the same subject, re-drawn.
  const lite = async (i) => (i.width === 400 ? matte(400, 400, [180, 180, 220, 240]) : matte(i.width, i.height, [9, 9, 49, 69]));
  const full = noFull();
  const r = await cutout(img, lite, full);
  assert.equal(full.called, false);
  assert.deepEqual(img.crops, [[171, 171, 228, 248]]); // 15% of the longer side (60) on every side, inclusive corners
  assert.deepEqual([r.width, r.height], [400, 400]);
  assert.equal(alphaAt(r, 200, 210), 255);
  assert.equal(alphaAt(r, 175, 175), 0); // inside the region, outside the subject
  assert.equal(alphaAt(r, 100, 100), 0); // outside the region
  assert.equal(r.usedFull, false);
  assert.ok(Math.abs(r.coverage - 1.5) < 0.01, `coverage ${r.coverage}`); // 40×60 of 400×400
});

test('cutout: a small subject on a busy backdrop does not call the full model', async () => {
  // Lite kept a small subject; the removed backdrop is a hard checkerboard — lots of stranded edges.
  const m = matte(256, 256, [118, 108, 138, 148]);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      if (m.data[i + 3]) continue;
      const v = ((x >> 3) + (y >> 3)) & 1 ? 255 : 0;
      m.data.set([v, v, v], i);
    }
  assert.ok(incompleteScore(m) > INCOMPLETE_RATIO); // the size-biased score would have escalated
  const full = noFull();
  const r = await cutout(photo(256, 256), async (i) => (i.width === 256 ? m : matte(i.width, i.height, [6, 6, 26, 46])), full);
  assert.equal(full.called, false);
  assert.equal(r.usedFull, false);
});

test('cutout: lite loses the subject up close → the full model takes the close pass', async () => {
  const seen = [];
  const r = await cutout(
    photo(400, 400),
    async (i) => (i.width === 400 ? matte(400, 400, [180, 180, 220, 240]) : matte(i.width, i.height, null)),
    async () => async (i) => (seen.push([i.width, i.height]), matte(i.width, i.height, [9, 9, 49, 69])),
  );
  assert.deepEqual(seen, [[58, 78]]);
  assert.equal(r.usedFull, true);
  assert.equal(alphaAt(r, 200, 210), 255);
});

test('cutout: a tiny subject only the full model found still gets the close pass', async () => {
  // 20×40 of 1000×1000 = 0.08%, below EMPTY_COVERAGE: lite saw nothing, the full model found it.
  const img = photo(1000, 1000);
  const r = await cutout(
    img,
    async (i) => (i.width === 1000 ? matte(1000, 1000, null) : matte(i.width, i.height, [6, 6, 26, 46])),
    async () => async (i) => (i.width === 1000 ? matte(1000, 1000, [500, 500, 520, 540]) : assert.fail('lite had it up close')),
  );
  assert.deepEqual(img.crops, [[494, 494, 525, 545]]);
  assert.equal(r.usedFull, true); // it took the full model to find the subject
  assert.equal(alphaAt(r, 510, 520), 255);
  assert.equal(alphaAt(r, 495, 495), 0);
});

test('cutout: both models lose it up close → the whole-image result stands', async () => {
  const blank = async (i) => matte(i.width, i.height, null);
  const r = await cutout(
    photo(400, 400),
    async (i) => (i.width === 400 ? matte(400, 400, [180, 180, 220, 240]) : matte(i.width, i.height, null)),
    async () => blank,
  );
  assert.equal(r.usedFull, false);
  assert.equal(alphaAt(r, 200, 210), 255);
  assert.ok(Math.abs(r.coverage - 1.5) < 0.01);
});

test('focusRegion: a large subject needs no second pass', () => {
  assert.equal(focusRegion(matte(64, 64, [16, 16, 48, 48])), null);
  assert.equal(focusRegion(matte(64, 64, null)), null);
});

test('cutout on a real RawImage: the close pass sees exactly the region, and lands back on the subject', async () => {
  // 600×400 grey photo with a red 40×70 block. The stand-in model keeps red pixels.
  const W = 600, H = 400, box = [300, 200, 340, 270];
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const red = x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
      px.set(red ? [220, 20, 20, 255] : [128, 128, 128, 255], (y * W + x) * 4);
    }
  const sizes = [];
  const keepRed = async (img) => {
    sizes.push([img.width, img.height]);
    const out = new Uint8ClampedArray(img.width * img.height * 4);
    for (let i = 0; i < img.width * img.height; i++) {
      const [r, g] = [img.data[i * img.channels], img.data[i * img.channels + 1]];
      out.set([r, g, img.data[i * img.channels + 2], r > 180 && g < 60 ? 255 : 0], i * 4);
    }
    return new RawImage(out, img.width, img.height, 4);
  };
  const full = noFull();
  const r = await cutout(new RawImage(px, W, H, 4), keepRed, full);
  assert.equal(full.called, false);
  assert.deepEqual(sizes, [[600, 400], [62, 92]]); // 40×70 subject + 10.5 px (15% of 70) on every side, rounded out
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const red = x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
      if (alphaAt(r, x, y) !== (red ? 255 : 0)) assert.fail(`alpha at ${x},${y} is ${alphaAt(r, x, y)}`);
    }
});
