// End-to-end over the real MCP protocol: spawn dist/index.js on stdio exactly as an AI client does,
// then call the tools on a synthetic photo. Set RUAH_CACHE_DIR to reuse downloaded models.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// libvips keeps files it read by path open in its cache (WebP stays mapped); Windows then can't
// delete the temp folder. The server itself reads every file into memory first.
sharp.cache(false);

const run = promisify(execFile);
let dir, client;
const text = (r) => r.content.find((c) => c.type === 'text').text;
const saved = (r) => text(r).match(/^Saved: (.+)$/m)[1];
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ruah-mcp-'));
  // A product-style shot: one orange ball with a highlight and a shadow on a soft backdrop.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9e4dc"/><stop offset="1" stop-color="#cfc7bb"/></linearGradient>
      <radialGradient id="ball" cx="0.35" cy="0.3" r="0.75"><stop offset="0" stop-color="#ffd27a"/><stop offset="0.5" stop-color="#f08a24"/><stop offset="1" stop-color="#8a3c06"/></radialGradient>
    </defs>
    <rect width="640" height="480" fill="url(#bg)"/>
    <ellipse cx="320" cy="400" rx="130" ry="22" fill="#000" opacity="0.18"/>
    <circle cx="320" cy="250" r="140" fill="url(#ball)"/>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(join(dir, 'ball.jpg'));
  client = new Client({ name: 'ruah-test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], // not .pathname: "/D:/…" on Windows
    env: { ...process.env },
    stderr: process.env.CI ? 'inherit' : 'ignore', // in CI, why a server died is in the log
  }));
});

after(async () => {
  await client?.close();
  await rm(dir, { recursive: true, force: true });
});

test('advertises the tools with their input schemas', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['compress', 'crop', 'remove_background', 'resize', 'strip_metadata', 'upscale']);
  for (const t of tools) assert.deepEqual(t.inputSchema.required, ['input_path']);
});

test('reports the version it was published as', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(client.getServerVersion(), { name: 'ruah', version });
});

test('remove_background: transparent PNG beside the input, subject kept, preview attached', async () => {
  const r = await call('remove_background', { input_path: join(dir, 'ball.jpg') });
  assert.ok(!r.isError, text(r));
  const out = saved(r);
  assert.equal(out, join(dir, 'ball-cutout.png'));
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  const alpha = (x, y) => data[(y * info.width + x) * 4 + 3];
  assert.equal(alpha(5, 5), 0, 'corner is background');
  assert.equal(alpha(320, 250), 255, 'ball centre is subject');
  const img = r.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/webp');
  assert.ok(img.data.length < 40_000, `preview is small (${img.data.length} b64 chars)`);
});

test('compress: cut-out → WebP keeps transparency and shrinks', async () => {
  const input = join(dir, 'ball-cutout.png');
  const r = await call('compress', { input_path: input, format: 'webp' });
  assert.ok(!r.isError, text(r));
  const out = saved(r);
  assert.match(out, /ball-cutout-compressed\.webp$/);
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.hasAlpha, true);
  assert.ok((await stat(out)).size < (await stat(input)).size / 3);
  assert.match(text(r), /Transparent background: yes/);
  // Preview draws transparency as a checkerboard: its corner (background) is not plain white.
  const img = r.content.find((c) => c.type === 'image');
  const { data, info } = await sharp(Buffer.from(img.data, 'base64')).raw().toBuffer({ resolveWithObject: true });
  const corner = data.slice(0, info.channels);
  assert.ok(corner[0] < 230, `preview corner is the grey checker square, got ${[...corner]}`);
});

test('compress: cut-out → PNG is a smaller palette PNG that keeps transparency', async () => {
  const input = join(dir, 'ball-cutout.png');
  const r = await call('compress', { input_path: input, format: 'png' });
  assert.ok(!r.isError, text(r));
  const out = saved(r);
  const meta = await sharp(out).metadata();
  assert.deepEqual([meta.format, meta.isPalette, meta.hasAlpha], ['png', true, true]);
  assert.ok((await stat(out)).size < (await stat(input)).size / 2);
  // Same picture: transparent corner, and what shows stays close to the original. Colour is weighed
  // by alpha — under a fully transparent pixel it is invisible, and the palette doesn't keep it.
  const [a, b] = await Promise.all([input, out].map((f) => sharp(f).ensureAlpha().raw().toBuffer()));
  assert.equal(b[3], 0, 'corner stays transparent');
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) diff += Math.abs((a[i + c] * a[i + 3] - b[i + c] * b[i + 3]) / 255);
    diff += Math.abs(a[i + 3] - b[i + 3]);
  }
  assert.ok(diff / a.length < 2, `mean visible difference ${(diff / a.length).toFixed(2)}`);
});

test('compress: a long screenshot (20,000 rows) still becomes a palette PNG', async () => {
  const input = join(dir, 'long.png');
  await sharp({ create: { width: 64, height: 20000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png().toFile(input);
  const r = await call('compress', { input_path: input, format: 'png' });
  assert.ok(!r.isError, text(r));
  const meta = await sharp(saved(r)).metadata();
  assert.deepEqual([meta.width, meta.height, meta.isPalette], [64, 20000, true]);
});

test('compress: an opaque photo reports no transparency', async () => {
  const r = await call('compress', { input_path: join(dir, 'ball.jpg'), format: 'webp' });
  assert.match(text(r), /Transparent background: no/);
});

test('compress: never overwrites — a second run gets a new name', async () => {
  const input = join(dir, 'ball.jpg');
  const a = saved(await call('compress', { input_path: input }));
  const b = saved(await call('compress', { input_path: input }));
  assert.equal(a, join(dir, 'ball-compressed.jpg'));
  assert.equal(b, join(dir, 'ball-compressed-1.jpg'));
});

test('compress: JPEG from a transparent image says the background turned white', async () => {
  const r = await call('compress', { input_path: join(dir, 'ball-cutout.png'), format: 'jpeg' });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /filled with white/);
  const { data } = await sharp(saved(r)).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 245 && data[1] > 245 && data[2] > 245, 'corner is white, not black');
});

test('resize: max_side fits the longest side and keeps format and proportions', async () => {
  const r = await call('resize', { input_path: join(dir, 'ball.jpg'), max_side: 320 });
  assert.ok(!r.isError, text(r));
  const out = saved(r);
  assert.equal(out, join(dir, 'ball-resized.jpg'));
  const meta = await sharp(out).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 320, 240]);
  assert.match(text(r), /640×480 → 320×240/);
});

test('resize: percent and a new format in one call; transparency survives', async () => {
  const r = await call('resize', { input_path: join(dir, 'ball-cutout.png'), percent: 25, format: 'webp' });
  assert.ok(!r.isError, text(r));
  const meta = await sharp(saved(r)).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.hasAlpha], ['webp', 160, 120, true]);
  assert.match(text(r), /Transparent background: yes/);
});

test('resize: never enlarges unless allow_upscale', async () => {
  const input = join(dir, 'ball.jpg');
  const kept = await call('resize', { input_path: input, max_side: 1280 });
  assert.match(text(kept), /Not enlarged/);
  assert.equal((await sharp(saved(kept)).metadata()).width, 640);
  const up = await call('resize', { input_path: input, max_side: 1280, allow_upscale: true });
  const meta = await sharp(saved(up)).metadata();
  assert.deepEqual([meta.width, meta.height], [1280, 960]);
});

test('resize: needs exactly one of max_side or percent', async () => {
  for (const args of [{}, { max_side: 100, percent: 50 }]) {
    const r = await call('resize', { input_path: join(dir, 'ball.jpg'), ...args });
    assert.equal(r.isError, true);
    assert.match(text(r), /exactly one of max_side or percent/);
  }
});

test('crop: aspect_ratio keeps the largest centred area, keeps the format and says which region', async () => {
  const r = await call('crop', { input_path: join(dir, 'ball.jpg'), aspect_ratio: '1:1' });
  assert.ok(!r.isError, text(r));
  assert.equal(saved(r), join(dir, 'ball-crop.jpg'));
  const meta = await sharp(saved(r)).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 480, 480]);
  assert.match(text(r), /640×480 → 480×480/);
  assert.match(text(r), /Kept region of the input: left 80, top 0, 480×480 \(the input is 640×480\)/);
});

test('crop: box then rotate gives exactly sharp\'s extract + rotate, losslessly as PNG', async () => {
  const input = join(dir, 'grid.png');
  const w = 50, h = 30, raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) raw.set([i & 255, (i >> 8) * 40, (i * 7) & 255, 255], i * 4);
  await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toFile(input);
  const box = { left: 5, top: 3, width: 20, height: 12 };
  const r = await call('crop', { input_path: input, box, rotate: -90, flip_horizontal: true });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /50×30 → 12×20/);
  assert.match(text(r), /left 5, top 3, 20×12/);
  const got = await sharp(saved(r)).ensureAlpha().raw().toBuffer();
  const ref = await sharp(await sharp(input).extract(box).rotate(270).toBuffer()).flop().ensureAlpha().raw().toBuffer();
  assert.ok(got.equals(ref), 'same pixels');
});

test('crop: refuses unclear or impossible requests with a plain reason', async () => {
  const input = join(dir, 'ball.jpg');
  const cases = [
    [{ aspect_ratio: '1:1', box: { left: 0, top: 0, width: 10, height: 10 } }, /box or aspect_ratio, not both/],
    [{}, /Nothing to do/],
    [{ box: { left: 600, top: 0, width: 100, height: 100 } }, /outside the image, which is 640×480/],
    [{ aspect_ratio: '0:1' }, /two positive numbers/],
    [{ aspect_ratio: `${'9'.repeat(400)}:${'9'.repeat(400)}` }, /two positive numbers/], // Infinity:Infinity
    [{ aspect_ratio: `${'9'.repeat(400)}:1` }, /two positive numbers/],
    [{ aspect_ratio: 'square' }, /width:height/],
  ];
  for (const [args, msg] of cases) {
    const r = await call('crop', { input_path: input, ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(text(r), msg);
  }
});

test('upscale: ×2 through the real model — twice the size, the same picture, format kept, progress reported', async () => {
  const input = join(dir, 'small.jpg');
  await sharp(join(dir, 'ball.jpg')).resize(160, 120).jpeg({ quality: 90 }).toFile(input);
  const progress = [];
  const r = await client.callTool({ name: 'upscale', arguments: { input_path: input } }, undefined, {
    timeout: 600_000,
    onprogress: (p) => progress.push(p),
  });
  assert.ok(!r.isError, text(r));
  assert.equal(saved(r), join(dir, 'small-upscaled-x2.jpg'));
  assert.match(text(r), /160×120 → 320×240/);
  // macOS tries the GPU first; everywhere else it must be the CPU (engine.ts loadSr)
  assert.match(text(r), process.platform === 'darwin' ? /AI upscaling ran on the (GPU \(WebGPU\)|CPU), \d+ s\./ : /AI upscaling ran on the CPU, \d+ s\./);
  assert.ok(r.content.some((c) => c.type === 'image'), 'preview attached');
  const meta = await sharp(saved(r)).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 320, 240]);
  // The same picture: close to a plain Lanczos enlargement (the model sharpens; it doesn't invent a new image).
  const got = await sharp(saved(r)).removeAlpha().raw().toBuffer();
  const ref = await sharp(input).resize(320, 240, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
  let se = 0;
  for (let i = 0; i < got.length; i++) se += (got[i] - ref[i]) ** 2;
  assert.ok(10 * Math.log10((255 * 255 * got.length) / se) > 30, 'PSNR against Lanczos above 30 dB');
  const last = progress.at(-1);
  assert.ok(last && last.progress === last.total && last.message === 'Upscaling ×2', JSON.stringify(progress));
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i].progress > progress[i - 1].progress, 'progress only rises');
});

test('upscale: a transparent icon stays transparent, with no dark rim from its hidden colour', async () => {
  const input = join(dir, 'icon.png');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="18" fill="#2a6"/></svg>';
  const icon = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < icon.length; i += 4) if (icon[i + 3] === 0) icon.fill(0, i, i + 3); // hidden colour: black
  await sharp(icon, { raw: { width: 48, height: 48, channels: 4 } }).png().toFile(input);
  const r = await call('upscale', { input_path: input });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /48×48 → 96×96/);
  assert.match(text(r), /Transparent background: yes/);
  const { data, info } = await sharp(saved(r)).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [96, 96, 4]);
  const at = (x, y) => [...data.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), [0, 0, 0, 0]); // the clear corner stays clear
  assert.equal(at(48, 48)[3], 255); // the solid middle stays solid
  // The hidden colour round the circle is black; drawn through, it would darken the visible edge.
  for (let i = 0; i < 96 * 96; i++) {
    if (data[i * 4 + 3] >= 64) assert.ok(data[i * 4 + 1] > 130, `pixel ${i % 96},${(i / 96) | 0} is ${at(i % 96, (i / 96) | 0)}`);
  }
});

test('upscale: refuses up front — too large a result, an existing output_path — and writes nothing', async () => {
  const big = join(dir, 'big.png');
  await sharp({ create: { width: 1100, height: 1000, channels: 3, background: '#888' } }).png().toFile(big);
  let r = await call('upscale', { input_path: big, scale: 4 });
  assert.ok(r.isError);
  assert.match(text(r), /×4 of this 1100×1000 image would be 4400×4000 \(17\.6 MP\), over the 16\.8 MP limit\. Use scale 2, or crop or resize/);
  const taken = join(dir, 'taken.png');
  await writeFile(taken, 'x');
  r = await call('upscale', { input_path: join(dir, 'icon.png'), output_path: taken, format: 'png' });
  assert.ok(r.isError);
  assert.match(text(r), /already exists, not overwriting/);
  assert.ok(!(await readdir(dir)).some((f) => f.startsWith('big-upscaled')));
});

test('strip_metadata: a sideways-stored phone JPEG loses GPS, camera and XMP but stays upright', async () => {
  const input = join(dir, 'phone.jpg');
  // Stored 400×200, Orientation 6 → shown 200×400, with an sRGB profile, GPS and camera tags, XMP.
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#c63' } })
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 33/1 0/1' } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>')
    .jpeg()
    .toFile(input);
  const r = await call('strip_metadata', { input_path: input });
  assert.ok(!r.isError, text(r));
  const out = saved(r);
  assert.equal(out, join(dir, 'phone-clean.jpg'));
  assert.match(text(r), /^JPEG 200×400: .* removed\. Lossless/m);
  assert.match(text(r), /^Removed: GPS location, EXIF details \(camera, date, settings\), XMP$/m);
  assert.match(text(r), /^Left in the file: only the image data and display settings \(colour profile, orientation tag\)\.$/m);
  const meta = await sharp(out).metadata();
  assert.equal(meta.xmp, undefined);
  assert.equal(meta.exif.length, 32, 'only the tag-only Orientation block is left');
  assert.equal(meta.orientation, 6);
  assert.deepEqual(meta.autoOrient, { width: 200, height: 400 });
  assert.ok(meta.icc, 'colour profile kept');
  // Same bytes as the web tool, which runs this very function on the dropped file.
  const { stripMetadata } = await import('../../../src/lib/metadata.ts');
  assert.ok((await readFile(out)).equals(stripMetadata(await readFile(input), 'image/jpeg').bytes));
});

test('strip_metadata: PNG loses its XMP losslessly; a clean file says there was nothing to remove', async () => {
  const input = join(dir, 'tagged.png');
  await sharp({ create: { width: 64, height: 32, channels: 4, background: '#3468' } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>')
    .png()
    .toFile(input);
  const once = await call('strip_metadata', { input_path: input });
  assert.ok(!once.isError, text(once));
  assert.match(text(once), /^Removed: XMP$/m);
  assert.equal((await sharp(saved(once)).metadata()).xmp, undefined);
  const raw = (p) => sharp(p).raw().toBuffer();
  assert.ok((await raw(saved(once))).equals(await raw(input)), 'pixels unchanged');
  const twice = await call('strip_metadata', { input_path: saved(once) });
  assert.match(text(twice), /nothing to remove/);
  assert.match(text(twice), /^Removed: no metadata found$/m);
});

test('strip_metadata: WebP has no lossless cleaner, so it is re-encoded as WebP without EXIF', async () => {
  const input = join(dir, 'tagged.webp');
  await sharp({ create: { width: 64, height: 32, channels: 3, background: '#468' } })
    .withExif({ IFD0: { Make: 'TestCam' } })
    .webp()
    .toFile(input);
  const r = await call('strip_metadata', { input_path: input });
  assert.ok(!r.isError, text(r));
  assert.match(saved(r), /tagged-clean\.webp$/);
  assert.match(text(r), /Re-encoded/);
  assert.match(text(r), /^Removed: EXIF details/m);
  assert.match(text(r), /^Left in the file: only the image data\.$/m);
  const meta = await sharp(saved(r)).metadata();
  assert.deepEqual([meta.format, meta.exif], ['webp', undefined]);
});

test('strip_metadata rebuilds other formats by their pixels: transparent → PNG, opaque → JPEG', async () => {
  const clear = join(dir, 'clear.avif');
  await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 0.5 } } }).avif().toFile(clear);
  const solid = join(dir, 'solid.avif');
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#468' } }).withExif({ IFD0: { Make: 'TestCam' } }).avif().toFile(solid);
  const c = await call('strip_metadata', { input_path: clear });
  assert.match(saved(c), /clear-clean\.png$/);
  assert.match(text(c), /lossless PNG \(it has transparency\)/);
  const s = await call('strip_metadata', { input_path: solid });
  assert.match(saved(s), /solid-clean\.jpg$/);
  assert.match(text(s), /JPEG \(quality 92\)/);
  assert.equal((await sharp(saved(s)).metadata()).exif, undefined);
});

test('HEIC (iPhone photos) is read on macOS: upright, and cleaned into a JPEG without GPS', { skip: process.platform !== 'darwin' && 'HEIC decoding needs macOS' }, async () => {
  const src = join(dir, 'iphone-src.jpg');
  await sharp({ create: { width: 400, height: 200, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: 'Apple' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 33/1 0/1' } })
    .jpeg()
    .toFile(src);
  const heic = join(dir, 'iphone.heic');
  await run('/usr/bin/sips', ['-s', 'format', 'heic', src, '--out', heic]);
  const c = await call('compress', { input_path: heic });
  assert.ok(!c.isError, text(c));
  assert.match(saved(c), /iphone-compressed\.webp$/);
  assert.match(text(c), /Input is heic/);
  const cm = await sharp(saved(c)).metadata();
  assert.deepEqual([cm.width, cm.height], [200, 400], 'shown upright');
  const s = await call('strip_metadata', { input_path: heic });
  assert.ok(!s.isError, text(s));
  assert.match(saved(s), /iphone-clean\.jpg$/);
  assert.match(text(s), /^Removed: GPS location/m);
  const sm = await sharp(saved(s)).metadata();
  assert.deepEqual([sm.format, sm.width, sm.height, sm.exif], ['jpeg', 200, 400, undefined]);
});

test('strip_metadata: a half-downloaded JPEG is still cleaned and previewed', async () => {
  const whole = await sharp({ create: { width: 320, height: 240, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .withExif({ IFD0: { Make: 'TestCam' } })
    .jpeg()
    .toBuffer();
  await writeFile(join(dir, 'half.jpg'), whole.subarray(0, Math.floor(whole.length * 0.6)));
  const r = await call('strip_metadata', { input_path: join(dir, 'half.jpg') });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /^Removed: EXIF details/m);
  assert.ok(r.content.some((c) => c.type === 'image'));
});

test('never writes through a dangling symlink, whether picked or given as output_path', async () => {
  const target = join(dir, 'elsewhere', 'target.jpg'); // its folder doesn't exist either
  await symlink(target, join(dir, 'ball-clean.jpg'));
  const picked = await call('strip_metadata', { input_path: join(dir, 'ball.jpg') });
  assert.equal(saved(picked), join(dir, 'ball-clean-1.jpg'));
  await symlink(join(dir, 'gone.webp'), join(dir, 'link.webp'));
  const given = await call('compress', { input_path: join(dir, 'ball.jpg'), output_path: join(dir, 'link.webp'), format: 'webp' });
  assert.equal(given.isError, true);
  assert.match(text(given), /not overwriting/);
  assert.ok(!(await readdir(dir)).includes('gone.webp'));
});

test('errors come back as tool errors, not crashes', async () => {
  const missing = await call('compress', { input_path: join(dir, 'nope.png') });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /not a readable file/);
  const clash = await call('compress', { input_path: join(dir, 'ball.jpg'), output_path: join(dir, 'ball.jpg') });
  assert.equal(clash.isError, true);
  assert.match(text(clash), /not overwriting/);
  assert.ok((await readdir(dir)).includes('ball.jpg'));
  const misnamed = await call('compress', { input_path: join(dir, 'ball.jpg'), output_path: join(dir, 'ball-out.png'), format: 'webp' });
  assert.equal(misnamed.isError, true);
  assert.match(text(misnamed), /must end in \.webp/);
});

test('refuses images too large to decode (from the header) and files too large to read', async () => {
  // 69 bytes that claim 12001×12001 — one pixel over the limit, 576 MB once decoded.
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const n = Buffer.alloc(4);
    const crc = Buffer.alloc(4);
    n.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([n, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(12001, 0);
  ihdr.writeUInt32BE(12001, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const bomb = join(dir, 'bomb.png');
  await writeFile(bomb, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(64))), chunk('IEND', Buffer.alloc(0))]));
  for (const [tool, args] of [['compress', {}], ['resize', { percent: 50 }], ['crop', { rotate: 90 }], ['upscale', {}], ['strip_metadata', {}], ['remove_background', {}]]) {
    const r = await call(tool, { input_path: bomb, ...args });
    assert.equal(r.isError, true, tool);
    assert.match(text(r), /12001×12001 \(144 MP\), larger than the 144 MP \(12000×12000\)/, tool);
  }
  const huge = join(dir, 'huge.png'); // sparse: takes no disk
  await writeFile(huge, '');
  await truncate(huge, 513 * 1024 * 1024);
  const r = await call('compress', { input_path: huge });
  assert.equal(r.isError, true);
  assert.match(text(r), /is 513\.0 MB, larger than the 512\.0 MB these tools read/);
});
