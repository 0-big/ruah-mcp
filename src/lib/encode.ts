// Image encoding shared by the web codec worker and the ruah-mcp agent server: the same WASM
// codecs (jSquash + libimagequant) with the same settings, so a file compressed by an agent comes
// out byte-for-byte like one compressed on ruah.tools. Runtime-neutral — no DOM, no Node APIs.
// In the browser each codec fetches its own wasm on first use; Node has no fetch(file://), so it
// hands over compiled modules once via initEncoders().
import encodeJpeg, { init as initJpeg } from '@jsquash/jpeg/encode.js';
import encodePng, { init as initPng } from '@jsquash/png/encode.js';
import encodeWebp, { init as initWebp } from '@jsquash/webp/encode.js';
import encodeAvif, { init as initAvif } from '@jsquash/avif/encode.js';
import optimisePng, { init as initOxipng } from '@jsquash/oxipng/optimise.js';
import * as iq from 'imagequant/imagequant_bg.js';
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

// --- libimagequant (lossy PNG quantisation) ------------------------------------
// The `imagequant` package's main entry does `import * as wasm from './*.wasm'`, which neither
// Vite nor Node can resolve. We use the wasm-bindgen glue directly and instantiate the wasm
// ourselves from whatever the runtime can load (fetched bytes in the browser, a file in Node).
let iqLoad: (() => Promise<WasmSource>) | null = null;
let iqReady: Promise<void> | null = null;

/** Tell the PNG quantiser where its wasm comes from. Loaded lazily on the first lossy PNG. */
export function useImagequantWasm(load: () => Promise<WasmSource>): void {
  iqLoad = load;
}

function initImagequant(): Promise<void> {
  if (!iqReady) {
    if (!iqLoad) throw new Error('imagequant wasm source not set (useImagequantWasm)');
    const imports = { './imagequant_bg.js': iq };
    iqReady = iqLoad()
      .then(async (src) =>
        src instanceof WebAssembly.Module
          ? WebAssembly.instantiate(src, imports)
          : (await WebAssembly.instantiate(src, imports)).instance,
      )
      .then((instance) => {
        iq.__wbg_set_wasm(instance.exports);
      });
  }
  return iqReady;
}

/** Node: initialise every codec from compiled wasm modules (the browser self-initialises). */
export async function initEncoders(m: {
  jpeg: WebAssembly.Module;
  png: WebAssembly.Module;
  webp: WebAssembly.Module;
  avif: WebAssembly.Module;
  oxipng: WebAssembly.Module;
  imagequant: WebAssembly.Module;
}): Promise<void> {
  await Promise.all([
    initJpeg(m.jpeg),
    initPng(m.png),
    initWebp(m.webp),
    initAvif(m.avif),
    initOxipng(m.oxipng),
  ]);
  useImagequantWasm(async () => m.imagequant);
  await initImagequant();
}

/** Lossy PNG: quantise to a ≤256-colour palette (libimagequant), then re-optimise losslessly. */
async function quantisePng(img: Pixels, level: number): Promise<ArrayBuffer> {
  await initImagequant();
  const rgba = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const image = new iq.ImagequantImage(rgba, img.width, img.height, 0);
  const quant = new iq.Imagequant();
  let png: Uint8Array;
  try {
    // min 0 = never abort; target 90 = perceptually near-lossless while dropping colours
    // the eye won't miss — matches/beats pngquant-based tools (e.g. TinyPNG).
    quant.set_quality(0, 90);
    png = quant.process(image); // consumes `image`; returns a complete PNG
  } finally {
    quant.free();
  }
  // Lossless deflate/filter re-optimisation of the palette PNG.
  return optimisePng(png.buffer as ArrayBuffer, { level });
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
