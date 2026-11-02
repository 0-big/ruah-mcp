// Pure logic shared with the web (src/lib/metadata.ts), checked by reading the results back with sharp
// and, where sharp can't see (blocks it ignores, data past the image's end), by looking at the bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { exifContents, stripMetadata } from '../../../src/lib/metadata.ts';

const base = () => sharp({ create: { width: 40, height: 20, channels: 3, background: '#468' } });
const photo = () => sharp({ create: { width: 64, height: 48, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } });
const strip = async (buf, type) => stripMetadata(new Uint8Array(buf), type);
const pixels = (buf) => sharp(Buffer.from(buf)).raw().toBuffer();
const has = (buf, s) => Buffer.from(buf).includes(s);
const GPS = { IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 33/1 0/1' } };

/** A JPEG segment: FF marker, 2-byte length, body. */
function seg(marker, ...body) {
  const b = Buffer.concat(body.map((p) => Buffer.from(p, 'latin1')));
  return Buffer.concat([Buffer.from([0xff, marker, (b.length + 2) >> 8, (b.length + 2) & 0xff]), b]);
}
const afterSoi = (jpg, ...parts) => Buffer.concat([jpg.subarray(0, 2), ...parts, jpg.subarray(2)]);
/** The EXIF APP1 segment sharp wrote into a JPEG. */
function app1Of(jpg) {
  const i = jpg.indexOf(Buffer.from([0xff, 0xe1]));
  return jpg.subarray(i, i + 2 + jpg.readUInt16BE(i + 2));
}
/** A PNG chunk with a real CRC. */
function chunk(type, data) {
  const td = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data, 'latin1')]);
  const out = Buffer.alloc(td.length + 8);
  out.writeUInt32BE(td.length - 4, 0);
  td.copy(out, 4);
  out.writeUInt32BE(crc32(td), td.length + 4);
  return out;
}
const afterIhdr = (png, ...parts) => Buffer.concat([png.subarray(0, 33), ...parts, png.subarray(33)]);

test('JPEG: anything after the end of the image (extra images, motion-photo trailers) is dropped', async () => {
  const clean = await photo().jpeg().toBuffer();
  const gps = await base().withExif(GPS).jpeg().toBuffer();
  const r = await strip(Buffer.concat([clean, gps, Buffer.from('trailer: GPS 37.56,126.97')]), 'image/jpeg');
  assert.ok(Buffer.from(r.bytes).equals(clean), 'same bytes as the first image on its own');
  assert.ok(!has(r.bytes, 'Exif') && !has(r.bytes, 'GPS'));
  assert.deepEqual(r.found, ['trailer']); // not parsed past the end — reported as a whole
});

test('JPEG: only display blocks stay — JFIF thumbnails, MPF, maker blocks, comments and EXIF behind a TEM go', async () => {
  const clean = await photo().jpeg().toBuffer();
  const input = afterSoi(
    clean,
    seg(0xe0, 'JFIF\0', [1, 2, 0, 0, 1, 0, 1, 1, 1], 'RGB'), // 1×1 thumbnail
    seg(0xec, 'Ducky\0', '(c) Someone Private'), // APP12
    seg(0xe2, 'MPF\0', 'secondary image index'), // APP2 that isn't ICC
    seg(0xfe, 'shot at home'),
    Buffer.from([0xff, 0x01]), // TEM: a marker with no length
    app1Of(await base().withExif(GPS).jpeg().toBuffer()),
  );
  const r = await strip(input, 'image/jpeg');
  for (const s of ['Someone', 'MPF', 'home', 'Exif', 'RGB']) assert.ok(!has(r.bytes, s), `${s} removed`);
  assert.ok((await pixels(r.bytes)).equals(await pixels(input)), 'pixels unchanged');
  assert.deepEqual(r.found, ['location', 'exif', 'thumbnail', 'comment', 'other']);
});

test('JPEG: a progressive file keeps every scan; an unknown marker falls back to re-encoding', async () => {
  const prog = await photo().withExif(GPS).jpeg({ progressive: true }).toBuffer();
  const r = await strip(prog, 'image/jpeg');
  const scans = (b) => Buffer.from(b).toString('latin1').split('\xff\xda').length - 1;
  assert.ok(scans(prog) > 1);
  assert.equal(scans(r.bytes), scans(prog));
  assert.ok((await pixels(r.bytes)).equals(await pixels(prog)));
  assert.equal(await strip(afterSoi(prog, seg(0xf7, 'JPEG-LS')), 'image/jpeg'), null);
});

test('crafted JPEGs: block floods, smuggled bytes in kept blocks and DNL never pass through', async () => {
  const clean = await photo().jpeg().toBuffer();
  const rsts = Buffer.alloc(200_000);
  for (let k = 0; k < rsts.length; k += 2) rsts.set([0xff, 0xd0], k); // 100k stray RSTs before the frame
  assert.ok(Buffer.from((await strip(afterSoi(clean, rsts), 'image/jpeg')).bytes).equals(clean));
  const flood = Buffer.concat(Array.from({ length: 5000 }, () => [seg(0xe2, 'ICC_PROFILE\0', [1, 1]), seg(0xfe, 'x')]).flat());
  assert.equal(await strip(afterSoi(clean, flood), 'image/jpeg'), null, 'thousands of pieces: re-encode instead');
  const jfif = seg(0xe0, 'JFIF\0', [1, 2, 0, 0, 1, 0, 1, 0, 0], 'smuggled');
  const adobe = seg(0xee, 'Adobe', [0, 100, 0, 0, 0, 0, 1], 'smuggled'); // transform 1 = YCbCr, as the file is
  const r = await strip(afterSoi(clean, jfif, adobe), 'image/jpeg');
  assert.ok(!has(r.bytes, 'smuggled'));
  assert.ok((await pixels(r.bytes)).equals(await pixels(clean)));
  assert.equal(await strip(afterSoi(clean, seg(0xdc, [0, 48])), 'image/jpeg'), null);
});

test('crafted PNGs: a kept chunk longer than the format allows, or an unknown critical chunk, re-encode', async () => {
  const png = await photo().png().toBuffer();
  assert.equal(await strip(afterIhdr(png, chunk('gAMA', '\0\0\xb1\x8fsmuggled')), 'image/png'), null);
  assert.equal(await strip(afterIhdr(png, chunk('CgBI', 'P\0 \x06')), 'image/png'), null);
});

test('PNG: only display chunks stay — private, C2PA, text, time and data past IEND go; one eXIf at most', async () => {
  const png = await photo().withMetadata({ orientation: 6 }).png().toBuffer();
  const exif = chunk('eXIf', (await sharp(png).metadata()).exif.toString('latin1'));
  const input = Buffer.concat([
    afterIhdr(png, chunk('prVt', 'GPS 37.56,126.97'), chunk('caBX', 'c2pa'), chunk('tEXt', 'Author\0Someone'), chunk('tIME', '\x07\xea\x0b\x01\x0c\x00\x00'), exif),
    Buffer.from('tail'),
  ]);
  const r = await strip(input, 'image/png');
  for (const s of ['prVt', 'GPS', 'caBX', 'Someone', 'tIME', 'tail']) assert.ok(!has(r.bytes, s), `${s} removed`);
  assert.equal(Buffer.from(r.bytes).toString('latin1').split('eXIf').length - 1, 1);
  assert.equal((await sharp(Buffer.from(r.bytes)).metadata()).orientation, 6);
  assert.ok((await pixels(r.bytes)).equals(await pixels(input)));
  assert.deepEqual(r.found, ['exif', 'comment', 'time', 'other', 'trailer']);
});

test('JPEG: upright photo keeps no EXIF at all', async () => {
  const jpg = await base().withMetadata({ orientation: 1 }).withExifMerge({ IFD0: { Make: 'TestCam' } }).jpeg().toBuffer();
  const meta = await sharp(Buffer.from((await strip(jpg, 'image/jpeg')).bytes)).metadata();
  assert.equal(meta.exif, undefined);
  assert.ok(meta.icc, 'colour profile kept');
});

test('JPEG: every rotation survives, and cleaning again changes nothing', async () => {
  for (let o = 2; o <= 8; o++) {
    const jpg = await base().withMetadata({ orientation: o }).withExifMerge({ IFD0: { Make: 'TestCam' } }).jpeg().toBuffer();
    const once = await strip(jpg, 'image/jpeg'); // sharp writes little-endian EXIF
    assert.equal((await sharp(Buffer.from(once.bytes)).metadata()).orientation, o);
    const twice = await strip(once.bytes, 'image/jpeg'); // our tag-only block is big-endian
    assert.deepEqual([twice.removed, Buffer.from(twice.bytes).equals(Buffer.from(once.bytes))], [0, true], `orientation ${o}`);
  }
});

test('PNG: a rotated eXIf is rewritten tag-only (valid CRC), an upright one is dropped', async () => {
  const rotated = await strip(await base().withMetadata({ orientation: 6 }).png().toBuffer(), 'image/png');
  const meta = await sharp(Buffer.from(rotated.bytes)).metadata();
  assert.deepEqual([meta.orientation, meta.exif.length], [6, 26]);
  const upright = await strip(await base().withMetadata({ orientation: 1 }).png().toBuffer(), 'image/png');
  assert.equal((await sharp(Buffer.from(upright.bytes)).metadata()).exif, undefined);
});

test('exifContents: tells a GPS-tagged camera block from the tag-only orientation block left behind', async () => {
  const gps = { IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 33/1 0/1' } };
  const jpg = await base().withMetadata({ orientation: 6 }).withExifMerge(gps).jpeg().toBuffer();
  const exifOf = async (buf) => new Uint8Array((await sharp(Buffer.from(buf)).metadata()).exif);
  assert.deepEqual(exifContents(await exifOf(jpg)), { location: true, details: true, orientation: 6 });
  const cleaned = await exifOf((await strip(jpg, 'image/jpeg')).bytes); // with the "Exif\0\0" prefix
  assert.deepEqual(exifContents(cleaned), { location: false, details: false, orientation: 6 });
  const png = await strip(await base().withMetadata({ orientation: 3 }).png().toBuffer(), 'image/png');
  assert.deepEqual(exifContents(await exifOf(png.bytes)), { location: false, details: false, orientation: 3 }); // bare TIFF
});

test('not JPEG/PNG (or not what the type says): null, so the caller re-encodes', async () => {
  assert.equal(await strip(await base().webp().toBuffer(), 'image/webp'), null);
  assert.equal(await strip(await base().png().toBuffer(), 'image/jpeg'), null);
});
