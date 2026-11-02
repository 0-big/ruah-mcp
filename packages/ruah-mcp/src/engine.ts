// Node side of the Ruah engine: decoding (sharp), the BiRefNet and Swin2SR pipelines (transformers.js
// on onnxruntime-node) and the web's own codecs. All image logic that decides quality — matte
// refinement, full-model fallback, encoder settings — comes from the web app's src/lib.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { env, pipeline, RawImage } from '@huggingface/transformers';
import sharp, { type Metadata, type SharpOptions } from 'sharp';
import { cutout, type Cutout, type Remover } from '../../../src/lib/matte.ts';
import { encode, initEncoders, type EncodeOpts, type Pixels } from '../../../src/lib/encode.ts';
import { initResizer, resize, type ResizeOpts } from '../../../src/lib/resize.ts';
import { MODEL as UPSCALE_MODEL, upscale, type Scale, type Upscaled } from '../../../src/lib/upscale.ts';
import { CACHE_DIR, ensureModel, MODELS, type ModelSpec, type Progress } from './models.ts';
// Node always has wasm SIMD, so only the SIMD build; esbuild inlines its bytes (build.mjs).
import quantiserWasm from '../../../src/lib/liq/liq-simd.wasm';

env.localModelPath = CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = false; // weights come only through ensureModel (pinned + verified)

export interface Decoded extends Pixels {
  /** The source format: jpeg, png, webp, avif, heic, gif, tiff, … */
  format: string;
}

/** The longest side `resize` makes — and, squared, the most pixels any tool decodes. */
export const MAX_SIDE = 12000;
/**
 * One RGBA copy of 12000×12000 is 576 MB and a tool holds a few. sharp alone allows 268 MP, which a
 * PNG of under 1 MB can claim, so larger images are refused from the header, before decoding.
 */
export const MAX_PIXELS = MAX_SIDE * MAX_SIDE;

const open = (buf: Buffer, opts: SharpOptions = {}) => sharp(buf, { limitInputPixels: MAX_PIXELS, ...opts });
// The header decodes no pixels, so it is read without sharp's limit — checkPixels then explains a refusal.
const header = (buf: Buffer) => sharp(buf, { limitInputPixels: false }).metadata();

function checkPixels(m: Metadata) {
  const w = m.width ?? 0;
  const h = m.height ?? 0;
  if (!w || !h) throw new Error("This file's header gives no image size, so it can't be checked before decoding.");
  if (w * h > MAX_PIXELS) {
    throw new Error(
      `This image is ${w}×${h} (${Math.round((w * h) / 1e6)} MP), larger than the ${MAX_PIXELS / 1e6} MP (${MAX_SIDE}×${MAX_SIDE}) these tools work with.`,
    );
  }
}

// sharp names HEIF files by their container — name AVIF (AV1) and HEIC (HEVC) by codec like everyone else.
const formatName = (m: Metadata) =>
  m.format === 'heif' ? (m.compression === 'av1' ? 'avif' : m.compression === 'hevc' ? 'heic' : 'heif') : (m.format ?? 'unknown');

const run = promisify(execFile);

/**
 * HEIC, the iPhone's photo format, is coded with HEVC — a patent-licensed codec sharp ships without,
 * and one we don't ship either. macOS has a licensed decoder: `sips` turns the file into a lossless
 * TIFF (orientation and colour profile kept) that sharp reads. Elsewhere, say so plainly.
 */
async function heicAsTiff(path: string): Promise<Buffer> {
  if (process.platform !== 'darwin') {
    throw new Error(
      "HEIC (iPhone photo) can't be decoded on this system: its HEVC codec is patent-licensed and only macOS provides one here. " +
        'Convert it to JPEG or PNG first (or on the iPhone: Settings → Camera → Formats → Most Compatible).',
    );
  }
  const dir = await mkdtemp(join(tmpdir(), 'ruah-heic-'));
  try {
    const out = join(dir, 'decoded.tiff');
    await run('/usr/bin/sips', ['-s', 'format', 'tiff', path, '--out', out], { timeout: 120_000 });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Decode any image sharp reads (and HEIC, on macOS) to RGBA, upright and in sRGB, like the browser. */
export async function decode(path: string): Promise<Decoded> {
  const buf = await readFile(path);
  const m = await header(buf);
  checkPixels(m); // before sips too: it would write the whole image out as TIFF
  const format = formatName(m);
  const img = open(format === 'heic' ? await heicAsTiff(path) : buf);
  const { data, info } = await img.rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    width: info.width,
    height: info.height,
    format,
  };
}

/** Format and upright size from the file's header, without decoding the pixels. */
export async function probe(path: string): Promise<{ format: string; width: number; height: number }> {
  const m = await header(await readFile(path));
  checkPixels(m);
  const turned = (m.orientation ?? 1) >= 5; // EXIF orientations 5–8 swap width and height
  return { format: formatName(m), width: (turned ? m.height : m.width) ?? 0, height: (turned ? m.width : m.height) ?? 0 };
}

export interface Meta {
  exif?: Uint8Array;
  xmp: boolean;
  iptc: boolean;
  /** PNG text chunks. */
  text: boolean;
}

/** The metadata blocks sharp finds in a file (main image only — what it can't see, it can't report). */
export async function readMeta(path: string): Promise<Meta> {
  const m = await sharp(await readFile(path)).metadata();
  return { exif: m.exif, xmp: !!m.xmp, iptc: !!m.iptc, text: !!m.comments?.length };
}

// --- background removal ---------------------------------------------------------------------

type Pipe = Remover<RawImage> & { dispose(): Promise<void> };

async function load(spec: ModelSpec, onProgress?: Progress): Promise<Pipe> {
  await ensureModel(spec, onProgress);
  return (await pipeline('background-removal', spec.id, { device: 'cpu', dtype: 'fp16' })) as unknown as Pipe;
}

// The lite session holds ~2–3 GB while loaded, so it is released after a quiet spell instead of
// living as long as the agent session does.
const IDLE_MS = 5 * 60_000;
let lite: Promise<Pipe> | null = null;
let idle: NodeJS.Timeout | undefined;

export async function removeBackground(path: string, onProgress?: Progress): Promise<Cutout> {
  clearTimeout(idle);
  lite ??= load(MODELS.lite, onProgress).catch((e) => {
    lite = null;
    throw e;
  });
  const px = await decode(path);
  let full: Pipe | null = null;
  try {
    return await cutout(new RawImage(px.data, px.width, px.height, 4), await lite, async () => {
      full = await load(MODELS.full, onProgress);
      return full;
    });
  } finally {
    // The full model (~470 MB) only runs for the rare miss — don't keep it resident.
    await (full as Pipe | null)?.dispose();
    idle = setTimeout(releaseLite, IDLE_MS);
    idle.unref();
  }
}

async function releaseLite() {
  const p = lite;
  lite = null;
  await (await p?.catch(() => null))?.dispose();
}

// --- upscaling ------------------------------------------------------------------------------

type SrPipe = ((input: RawImage) => Promise<any>) & { dispose(): Promise<void> };
export type Device = 'webgpu' | 'cpu';

// On macOS, WebGPU (Metal) ran Swin2SR about twice as fast as the CPU with a quarter of the memory,
// and the pixels matched the CPU's within 1/255 (M2 Max, 2026-11-02). It is experimental in
// onnxruntime-node and unmeasured on other systems, so elsewhere — and after any failure — the CPU runs it.
let gpu = process.platform === 'darwin';
const sr = new Map<Scale, Promise<{ pipe: SrPipe; device: Device }>>();
let srIdle: NodeJS.Timeout | undefined;

async function loadSr(scale: Scale, onProgress?: Progress): Promise<{ pipe: SrPipe; device: Device }> {
  await ensureModel(MODELS[`x${scale}`], onProgress);
  const make = (device: Device) => pipeline('image-to-image', UPSCALE_MODEL[scale], { device, dtype: 'fp32' }) as unknown as Promise<SrPipe>;
  if (gpu) {
    try {
      return { pipe: await make('webgpu'), device: 'webgpu' };
    } catch {
      gpu = false;
    }
  }
  return { pipe: await make('cpu'), device: 'cpu' };
}

/** Upscale with the scale's Swin2SR, tiled like the web tool. `onTile` hears (done, total) tiles. */
export async function upscaleImage(px: Pixels, scale: Scale, onDownload?: Progress, onTile?: Progress): Promise<Upscaled & { device: Device }> {
  clearTimeout(srIdle);
  try {
    for (;;) {
      let job = sr.get(scale);
      if (!job) {
        job = loadSr(scale, onDownload);
        sr.set(scale, job);
        job.catch(() => sr.delete(scale));
      }
      const { pipe, device } = await job;
      try {
        const up = await upscale(px, scale, (p) => pipe(new RawImage(p.data, p.width, p.height, 4).rgb()), onTile);
        return { ...up, device };
      } catch (e) {
        if (device !== 'webgpu') throw e;
        gpu = false; // a GPU that fails mid-run gets one retry on the CPU, and isn't used again
        sr.delete(scale);
        await pipe.dispose().catch(() => {});
      }
    }
  } finally {
    // Like the cut-out model: the sessions are released after a quiet spell.
    srIdle = setTimeout(releaseSr, IDLE_MS);
    srIdle.unref();
  }
}

async function releaseSr() {
  const jobs = [...sr.values()];
  sr.clear();
  for (const j of jobs) await (await j.catch(() => null))?.pipe.dispose();
}

// --- resizing and encoding ------------------------------------------------------------------

const require = createRequire(import.meta.url);
const compile = async (path: string) => WebAssembly.compile(await readFile(require.resolve(path)));
let codecs: Promise<void> | null = null;

function initCodecs(): Promise<void> {
  codecs ??= (async () => {
    await initEncoders({
      jpeg: await compile('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'),
      png: await compile('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'),
      webp: await compile('@jsquash/webp/codec/enc/webp_enc_simd.wasm'),
      avif: await compile('@jsquash/avif/codec/enc/avif_enc.wasm'),
      oxipng: await compile('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm'),
      quantiser: await WebAssembly.compile(quantiserWasm),
    });
    await initResizer(await compile('@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm'));
  })();
  return codecs;
}

export async function resizeImage(px: Pixels, opts: ResizeOpts): Promise<Pixels> {
  await initCodecs();
  return resize(px, opts);
}

export async function encodeImage(px: Pixels, opts: EncodeOpts): Promise<Buffer> {
  await initCodecs();
  return Buffer.from(await encode(px, opts));
}

/**
 * Small WebP for the agent to look at (never a deliverable), drawn over a checkerboard like the
 * web tools' previews — clients show alpha on white, so otherwise "transparent" and "white
 * background" look identical to the agent.
 */
export async function preview(src: Pixels | string, maxSide = 256): Promise<Buffer> {
  // A path is shrunk straight from the file (upright), without holding its full pixels. A truncated
  // file that was still saved (a half-downloaded JPEG) previews as far as it goes.
  const img =
    typeof src === 'string'
      ? open(await readFile(src), { failOn: 'none' }).rotate()
      : sharp(Buffer.from(src.data.buffer, src.data.byteOffset, src.data.byteLength), {
          raw: { width: src.width, height: src.height, channels: 4 },
        });
  const { data, info } = await img
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const checker = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      '<defs><pattern id="c" width="16" height="16" patternUnits="userSpaceOnUse">' +
      '<rect width="16" height="16" fill="#fff"/><rect width="8" height="8" fill="#ccc"/><rect x="8" y="8" width="8" height="8" fill="#ccc"/>' +
      `</pattern></defs><rect width="${w}" height="${h}" fill="url(#c)"/></svg>`,
  );
  return sharp(checker)
    .composite([{ input: data, raw: { width: w, height: h, channels: 4 } }])
    .webp({ quality: 70 })
    .toBuffer();
}
