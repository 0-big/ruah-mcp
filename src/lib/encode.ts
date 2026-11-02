// Image encoding shared by the web codec worker and the ruah-mcp agent server: the same WASM
// codecs (jSquash + libimagequant 2.4.1) with the same settings, so a file compressed by an agent comes
// out byte-for-byte like one compressed on ruah.tools. Runtime-neutral — no DOM, no Node APIs.
// In the browser each codec fetches its own wasm on first use; Node has no fetch(file://), so it
// hands over compiled modules once via initEncoders().
import encodeJpeg, { init as initJpeg } from '@jsquash/jpeg/encode.js';
import encodePng, { init as initPng } from '@jsquash/png/encode.js';
import encodeWebp, { init as initWebp } from '@jsquash/webp/encode.js';
import encodeAvif, { init as initAvif } from '@jsquash/avif/encode.js';
import optimisePng, { init as initOxipng } from '@jsquash/oxipng/optimise.js';
import { hasAlpha, type Pixels } from './pixels';

export { hasAlpha, type Pixels };

export type OutputFormat = 'webp' | 'avif' | 'jpeg' | 'png';

export interface EncodeOpts {
  format: OutputFormat;
  /** 1–100. Ignored for png (png uses lossy quantisation or lossless, see `lossless`). */
  quality: number;
  /** png only: skip lossy quantisation and keep exact colours (OxiPNG). Default = lossy. */
  lossless?: boolean;
  /**
   * png only: OxiPNG effort, 0–6. Default 2. 0 is for one-image tools that hand the file straight
   * over (crop): on a 12 MP photo 2.9 s instead of 18 s, for ~12% more bytes (2026-11-02).
   */
  effort?: number;
}

type WasmSource = BufferSource | WebAssembly.Module;

// --- libimagequant 2.4.1 (lossy PNG quantisation) -------------------------------
// The last BSD-licensed libimagequant, built by src/lib/liq/build.sh into a bare wasm module with no
// JS glue. It is instantiated from whatever the runtime can load (fetched bytes in the browser, a
// compiled module in Node).
interface Liq {
  memory: WebAssembly.Memory;
  liq_alloc(n: number): number;
  liq_dealloc(ptr: number): void;
  quantise(ptr: number, width: number, height: number, maxQuality: number, speed: number, dither: number): number;
}
let liqLoad: (() => Promise<WasmSource>) | null = null;
let liqReady: Promise<Liq> | null = null;

/** Tell the PNG quantiser where its wasm comes from. Loaded lazily on the first lossy PNG. */
export function useQuantiserWasm(load: () => Promise<WasmSource>): void {
  liqLoad = load;
}

// Its libc writes to stderr only right before aborting on a corrupted handle: fail loudly instead.
const liqAbort = () => {
  throw new Error('PNG quantiser aborted');
};
const liqImports = {
  env: { emscripten_notify_memory_growth: () => {} },
  wasi_snapshot_preview1: { fd_close: liqAbort, fd_write: liqAbort, fd_seek: liqAbort },
};

function initQuantiser(): Promise<Liq> {
  if (!liqReady) {
    if (!liqLoad) throw new Error('PNG quantiser wasm source not set (useQuantiserWasm)');
    liqReady = liqLoad()
      .then(async (src) => {
        const instance =
          src instanceof WebAssembly.Module
            ? await WebAssembly.instantiate(src, liqImports)
            : (await WebAssembly.instantiate(src, liqImports)).instance;
        (instance.exports._initialize as () => void)();
        return instance.exports as unknown as Liq;
      })
      .catch((e) => {
        liqReady = null; // a failed load (network) is retried by the next PNG
        throw e;
      });
  }
  return liqReady;
}

// wasm memory only grows: after a big image, drop the instance so its memory can be freed.
const LIQ_KEEP_BYTES = 256 * 2 ** 20;
// Instances a trap left unusable — a PNG that was waiting for the same instance must not use it.
const liqBroken = new WeakSet<Liq>();

/** Node: initialise every codec from compiled wasm modules (the browser self-initialises). */
export async function initEncoders(m: {
  jpeg: WebAssembly.Module;
  png: WebAssembly.Module;
  webp: WebAssembly.Module;
  avif: WebAssembly.Module;
  oxipng: WebAssembly.Module;
  quantiser: WebAssembly.Module;
}): Promise<void> {
  await Promise.all([
    initJpeg(m.jpeg),
    initPng(m.png),
    initWebp(m.webp),
    initAvif(m.avif),
    initOxipng(m.oxipng),
  ]);
  useQuantiserWasm(async () => m.quantiser);
  await initQuantiser();
}

/** Lossy PNG: quantise to a ≤256-colour palette (libimagequant), then encode and re-optimise losslessly. */
async function quantisePng(img: Pixels, level: number): Promise<ArrayBuffer> {
  const n = img.data.byteLength;
  // The C side reads and writes width × height × 4 bytes, whatever was copied in.
  if (n !== img.width * img.height * 4) throw new Error(`PNG quantiser: ${n} bytes for ${img.width}×${img.height}`);
  let liq = await initQuantiser();
  if (liqBroken.has(liq)) liq = await initQuantiser();
  let data: Uint8ClampedArray;
  try {
    const ptr = liq.liq_alloc(n);
    if (!ptr) throw new Error('PNG quantiser: out of memory');
    new Uint8Array(liq.memory.buffer, ptr, n).set(img.data);
    // Quality 0–80 (0 = never give up, only spend fewer colours) · speed 5 · full dithering. Measured
    // against libimagequant 4 at 0–90, which this replaced (12 images, 2026-11-02): ~5% smaller and
    // 0.8–2.1 dB better PSNR on every image, at 1.0–1.9× the time. Speed 4 was 2.5× slower on
    // large photos for no gain; speed 6 lost ~1 dB.
    const err = liq.quantise(ptr, img.width, img.height, 80, 5, 1);
    if (err) throw new Error(`PNG quantiser failed (liq error ${err})`);
    // Read memory.buffer only now: it is replaced whenever the wasm memory grows.
    data = new Uint8ClampedArray(liq.memory.buffer.slice(ptr, ptr + n));
    liq.liq_dealloc(ptr);
  } catch (e) {
    // A trap leaves the instance's stack and heap unusable: drop it, and the next PNG starts afresh.
    liqBroken.add(liq);
    liqReady = null;
    throw e;
  }
  if (liq.memory.buffer.byteLength > LIQ_KEEP_BYTES) liqReady = null;
  // OxiPNG turns the ≤256-colour RGBA into an indexed PNG while it re-optimises filters and deflate.
  const png = await encodePng({ data, width: img.width, height: img.height } as ImageData);
  return optimisePng(png, { level });
}

/**
 * JPEG has no alpha channel: the encoder keeps the RGB of transparent pixels, which
 * for a cut-out is (0,0,0) — so transparent areas turn black. Composite onto white
 * instead so they degrade gracefully. Mutates in place; no-op when fully opaque.
 */
export function flattenOntoWhite<T extends Pixels>(img: T): T {
  if (!hasAlpha(img)) return img;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    const inv = 255 * (1 - a);
    d[i] = Math.round(d[i] * a + inv);
    d[i + 1] = Math.round(d[i + 1] * a + inv);
    d[i + 2] = Math.round(d[i + 2] * a + inv);
    d[i + 3] = 255;
  }
  return img;
}

export async function encode(img: Pixels, opts: EncodeOpts): Promise<ArrayBuffer> {
  // jSquash's signatures want a DOM ImageData; they only read data/width/height.
  const imageData = img as ImageData;
  switch (opts.format) {
    case 'webp':
      return encodeWebp(imageData, { quality: opts.quality });
    case 'avif':
      return encodeAvif(imageData, { quality: opts.quality });
    case 'jpeg':
      return encodeJpeg(flattenOntoWhite(imageData), { quality: opts.quality });
    case 'png': {
      if (opts.lossless) {
        const png = await encodePng(imageData);
        // Lossless optimisation pass (filter selection + zopfli-like recompression).
        return optimisePng(png, { level: opts.effort ?? 2 });
      }
      // Default: lossy palette quantisation — the compression that makes PNGs actually shrink.
      return quantisePng(img, opts.effort ?? 2);
    }
  }
}
