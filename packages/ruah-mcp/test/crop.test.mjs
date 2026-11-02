// Pure logic shared with the web (src/lib/crop.ts), checked against sharp's own rotate/flip/extract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { compose, fitAspect, invert, mapRect, orientCrop, orientedSize, pixelRect, UPRIGHT } from '../../../src/lib/crop.ts';

const ORIENTS = [0, 90, 180, 270].flatMap((rotate) =>
  [false, true].flatMap((flipH) => [false, true].map((flipV) => ({ rotate, flipH, flipV }))),
);
const name = (o) => `${o.rotate}${o.flipH ? '+H' : ''}${o.flipV ? '+V' : ''}`;

/** Every pixel different, so any misplaced pixel shows. */
function pattern(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i & 255, (i >> 8) & 255, (i * 7) & 255, 255 - (i % 13)], i * 4);
  return { data, width: w, height: h };
}
const same = (a, b, msg) => {
  assert.deepEqual([a.width, a.height], [b.width, b.height], msg);
  assert.ok(Buffer.from(a.data.buffer, a.data.byteOffset, a.data.length).equals(Buffer.from(b.data.buffer, b.data.byteOffset, b.data.length)), msg);
};

/** sharp as the independent reference: turn, then mirror, then extract — one step at a time. */
async function reference(img, o, rect) {
  const step = async (px, f) => {
    const { data, info } = await f(sharp(Buffer.from(px.data.buffer, px.data.byteOffset, px.data.length), {
      raw: { width: px.width, height: px.height, channels: 4 },
    })).raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
  };
  let px = img;
  if (o.rotate) px = await step(px, (s) => s.rotate(o.rotate));
  if (o.flipH) px = await step(px, (s) => s.flop());
  if (o.flipV) px = await step(px, (s) => s.flip());
  if (rect) px = await step(px, (s) => s.extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }));
  return px;
}

test('orientCrop: a 3×2 image turned clockwise, anticlockwise and mirrored, by hand', () => {
  const ids = (px) => [...new Uint32Array(px.data.buffer)].map((v) => 'abcdef'[[...new Uint32Array(img.data.buffer)].indexOf(v)]).join('');
  const img = pattern(3, 2); // abc / def
  assert.equal(ids(orientCrop(img, { rotate: 90, flipH: false, flipV: false })), 'daebfc'); // da / eb / fc
  assert.equal(ids(orientCrop(img, { rotate: 270, flipH: false, flipV: false })), 'cfbead'); // cf / be / ad
  assert.equal(ids(orientCrop(img, { rotate: 0, flipH: true, flipV: false })), 'cbafed');
  assert.equal(ids(orientCrop(img, { rotate: 0, flipH: false, flipV: true }, { x: 1, y: 0, w: 2, h: 1 })), 'ef');
});

test('orientCrop matches sharp for all 8 orientations, with and without a crop', async () => {
  const img = pattern(7, 5);
  for (const o of ORIENTS) {
    const s = orientedSize(7, 5, o);
    same(orientCrop(img, o), await reference(img, o), name(o));
    const rect = { x: 1, y: 2, w: s.width - 3, h: s.height - 2 };
    same(orientCrop(img, o, rect), await reference(img, o, rect), `${name(o)} cropped`);
  }
});

test('compose: one orientation does what two in a row do; invert undoes it', () => {
  const img = pattern(4, 3);
  for (const a of ORIENTS) {
    assert.deepEqual(compose(a, invert(a)), UPRIGHT, name(a));
    for (const b of ORIENTS) same(orientCrop(img, compose(a, b)), orientCrop(orientCrop(img, a), b), `${name(a)} then ${name(b)}`);
  }
});

test('mapRect: cropping then turning keeps the same pixels as turning then cropping the mapped rect', () => {
  const img = pattern(9, 6);
  const rect = { x: 2, y: 1, w: 4, h: 3 };
  for (const o of ORIENTS) {
    same(orientCrop(img, o, mapRect(rect, 9, 6, o)), orientCrop(orientCrop(img, UPRIGHT, rect), o), name(o));
    assert.deepEqual(mapRect(mapRect(rect, 9, 6, o), orientedSize(9, 6, o).width, orientedSize(9, 6, o).height, invert(o)), rect);
  }
});

test('fitAspect and pixelRect: centred largest area, whole pixels inside the image', () => {
  assert.deepEqual(fitAspect(640, 400, 16 / 9), { x: 0, y: 20, w: 640, h: 360 });
  assert.deepEqual(fitAspect(640, 400, 1), { x: 120, y: 0, w: 400, h: 400 });
  assert.deepEqual(pixelRect(fitAspect(640, 400, 4 / 3), 640, 400), { x: 53, y: 0, w: 533, h: 400 });
  assert.deepEqual(pixelRect({ x: -3, y: 398.6, w: 0.2, h: 5 }, 640, 400), { x: 0, y: 395, w: 1, h: 5 });
  assert.deepEqual(pixelRect({ x: 600, y: 0, w: 700, h: 400 }, 640, 400), { x: 0, y: 0, w: 640, h: 400 });
});

test('orientCrop: nothing to do returns the input; a rect outside the image is an error', () => {
  const img = pattern(4, 3);
  assert.equal(orientCrop(img, UPRIGHT), img);
  assert.equal(orientCrop(img, UPRIGHT, { x: 0, y: 0, w: 4, h: 3 }), img);
  assert.throws(() => orientCrop(img, UPRIGHT, { x: 1, y: 0, w: 4, h: 3 }), /outside the 4×3 image/);
  assert.throws(() => orientCrop(img, { rotate: 90, flipH: false, flipV: false }, { x: 0, y: 0, w: 4, h: 3 }), /outside the 3×4 image/);
});

test('orientCrop: pixels that are a view at an odd offset into a larger buffer', () => {
  const img = pattern(5, 4);
  const buf = new ArrayBuffer(img.data.length + 1);
  const data = new Uint8ClampedArray(buf, 1, img.data.length);
  data.set(img.data);
  const o = { rotate: 90, flipH: true, flipV: false };
  same(orientCrop({ data, width: 5, height: 4 }, o, { x: 1, y: 1, w: 2, h: 3 }), orientCrop(img, o, { x: 1, y: 1, w: 2, h: 3 }));
});
