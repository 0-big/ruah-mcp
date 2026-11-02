// The lossy PNG quantiser (src/lib/liq): the browser runs liq-simd.wasm where it has wasm SIMD and
// liq.wasm where it doesn't, and this server runs liq-simd.wasm — so for ruah.tools and the MCP to
// hand out the same file, both builds must give the same pixels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const fail = () => {
  throw new Error('quantiser aborted');
};
const imports = {
  env: { emscripten_notify_memory_growth: () => {} },
  wasi_snapshot_preview1: { fd_close: fail, fd_write: fail, fd_seek: fail },
};

async function quantiser(file) {
  const bytes = await readFile(new URL(`../../../src/lib/liq/${file}`, import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  const x = instance.exports;
  x._initialize();
  return (rgba, width, height) => {
    const ptr = x.liq_alloc(rgba.length);
    new Uint8Array(x.memory.buffer, ptr, rgba.length).set(rgba);
    assert.equal(x.quantise(ptr, width, height, 80, 5, 1), 0); // encode.ts's settings
    const out = new Uint8Array(x.memory.buffer.slice(ptr, ptr + rgba.length));
    x.liq_dealloc(ptr);
    return out;
  };
}

// Gradients, noise and a soft alpha edge: what makes the palette search and the dithering work.
async function sample() {
  const W = 320, H = 240;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a6ea5"/><stop offset="1" stop-color="#f3d9b1"/></linearGradient>
      <radialGradient id="fade" cx="0.5" cy="0.5" r="0.6"><stop offset="0.6" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <mask id="m"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>
    </defs>
    <g mask="url(#m)"><rect width="${W}" height="${H}" fill="url(#sky)"/><circle cx="200" cy="140" r="60" fill="#c0392b"/></g>
  </svg>`;
  const noise = await sharp({ create: { width: W, height: H, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 24 } } }).png().toBuffer();
  const rgba = await sharp(Buffer.from(svg)).composite([{ input: noise, blend: 'soft-light' }]).ensureAlpha().raw().toBuffer();
  return { rgba: new Uint8Array(rgba), W, H };
}

test('SIMD and plain builds give identical pixels, call after call', async () => {
  const [simd, plain] = await Promise.all([quantiser('liq-simd.wasm'), quantiser('liq.wasm')]);
  const { rgba, W, H } = await sample();
  const a = simd(rgba, W, H);
  assert.deepEqual(plain(rgba, W, H), a);
  assert.deepEqual(simd(rgba, W, H), a, 'no state carried over between calls');
});

test('a long screenshot quantises: 20,000 rows used to overflow the wasm stack', async () => {
  const [simd, plain] = await Promise.all([quantiser('liq-simd.wasm'), quantiser('liq.wasm')]);
  for (const [W, H] of [[64, 20000], [1, 30000]]) {
    const rgba = new Uint8Array(await sharp({ create: { width: W, height: H, channels: 4, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).raw().toBuffer());
    assert.deepEqual(plain(rgba, W, H), simd(rgba, W, H), `${W}×${H}`);
  }
});

test('the result is a ≤256-colour palette close to the input', async () => {
  const { rgba, W, H } = await sample();
  const out = (await quantiser('liq-simd.wasm'))(rgba, W, H);
  const colours = new Set(new Uint32Array(out.buffer));
  assert.ok(colours.size <= 256 && colours.size > 64, `${colours.size} colours`);
  let se = 0;
  for (let i = 0; i < rgba.length; i++) se += (rgba[i] - out[i]) ** 2;
  const psnr = 10 * Math.log10((255 * 255) / (se / rgba.length));
  assert.ok(psnr > 30, `PSNR ${psnr.toFixed(1)} dB`);
});
