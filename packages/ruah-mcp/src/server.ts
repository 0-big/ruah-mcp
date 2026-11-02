// The MCP surface: what an agent sees (tool names, descriptions, schemas) and how each call maps
// onto the engine. Files in, files out — results are written to disk and returned by path, with a
// small preview so the agent can look at what it made.
import { lstat, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FORMATS, formatBytes, type FormatInfo } from '../../../src/lib/output.ts';
import { fitAspect, invert, mapRect, orientCrop, orientedSize, pixelRect, type Orient, type Rect } from '../../../src/lib/crop.ts';
import { hasAlpha, type OutputFormat, type Pixels } from '../../../src/lib/encode.ts';
import { exifContents, META_KINDS, REBUILD_QUALITY, rebuildAs, stripMetadata, type KeptKind, type MetaKind } from '../../../src/lib/metadata.ts';
import { targetDimensions, type ResizeOpts } from '../../../src/lib/resize.ts';
import { decode, encodeImage, MAX_SIDE, preview, probe, readMeta, removeBackground, resizeImage, upscaleImage, type Decoded, type Meta } from './engine.ts';
import type { Progress } from './models.ts';
import { version } from '../package.json'; // bundled in: the published version is the one agents see

export const VERSION = version;

/** `~/x` and relative paths → absolute (relative to the server's working directory). */
function absPath(p: string): string {
  return resolve(p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
}

// lstat, not access: a dangling symlink is an existing name too, and writing through it would
// create its target somewhere else.
const exists = (p: string) => lstat(p).then(() => true, () => false);

/** Create the file; fail rather than write through anything that appeared at that path since the check. */
async function writeNew(path: string, data: Uint8Array): Promise<void> {
  await writeFile(path, data, { flag: 'wx' }).catch((e) => {
    throw e?.code === 'EEXIST' ? new Error(`output_path already exists, not overwriting: ${path}`) : e;
  });
}

/** `dir/name-suffix.ext`, or `name-suffix-1.ext`, `-2`, … — never an existing file. */
async function freePath(dir: string, name: string, ext: string): Promise<string> {
  for (let i = 0; ; i++) {
    const p = join(dir, `${name}${i ? `-${i}` : ''}.${ext}`);
    if (!(await exists(p))) return p;
  }
}

/**
 * Where to write: the caller's path (refusing to overwrite, and to name a file for another format)
 * or a fresh name beside the input.
 */
async function outputPath(input: string, wanted: string | undefined, suffix: string, ext: string) {
  if (wanted) {
    const p = absPath(wanted);
    if (await exists(p)) throw new Error(`output_path already exists, not overwriting: ${p}`);
    const given = extname(p).slice(1).toLowerCase();
    if (given !== ext && !(ext === 'jpg' && given === 'jpeg')) throw new Error(`output_path must end in .${ext} for this output: ${p}`);
    return p;
  }
  return freePath(dirname(input), `${basename(input, extname(input))}-${suffix}`, ext);
}

// Files are read whole (strip_metadata holds two copies). The largest image the tools take, 12000×12000
// as an uncompressed 8-bit RGB TIFF, is 432 MB.
const MAX_INPUT_BYTES = 512 * 1024 * 1024;

async function readableInput(p: string): Promise<string> {
  const path = absPath(p);
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) throw new Error(`input_path is not a readable file: ${path}`);
  if (s.size > MAX_INPUT_BYTES) throw new Error(`input_path is ${formatBytes(s.size)}, larger than the ${formatBytes(MAX_INPUT_BYTES)} these tools read: ${path}`);
  return path;
}

const DOWNLOADING = 'Downloading the AI model (one-time)';

/**
 * Progress for clients that asked for it (progressToken), one reporter per phase of a call — a
 * one-time model download, then the work. Each phase counts on from where the last one stopped:
 * the protocol wants every notification's progress above the one before.
 */
function progressReporter(extra: any): ((message: string) => Progress) | undefined {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return undefined;
  let sent = 0;
  return (message) => {
    let base: number | undefined;
    let last = 0;
    return (done, total) => {
      base ??= sent;
      if (done !== total && done - last < total / 50) return; // ~2% steps
      if (base + done <= sent) return;
      last = done;
      sent = base + done;
      extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: sent, total: base + total, message },
      }).catch(() => {});
    };
  };
}

function failure(e: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
}

const pct = (before: number, after: number) => `${Math.round((1 - after / before) * 100)}%`;
const mp = (pixels: number) => (pixels / 1e6).toFixed(1);

// A tool call should finish in minutes: ×4 of 1000×1000 (16 MP out) took ~1.5 min on an M2 Max's GPU
// and ~3 min on its CPU (2026-11-02, on a busy machine). Larger results are refused up front.
const MAX_UPSCALE_PIXELS = 4096 * 4096;

function checkUpscale(W: number, H: number, scale: number) {
  const area = W * H * scale * scale;
  if (area > MAX_UPSCALE_PIXELS) {
    throw new Error(
      `×${scale} of this ${W}×${H} image would be ${W * scale}×${H * scale} (${mp(area)} MP), over the ${mp(MAX_UPSCALE_PIXELS)} MP limit. ` +
        (scale === 4 && area / 4 <= MAX_UPSCALE_PIXELS ? 'Use scale 2, or ' : '') +
        'crop or resize it smaller first. To enlarge a large photo, use `resize` with allow_upscale.',
    );
  }
}

/** Output options shared by compress, resize and crop — the same choices and defaults as the web tools. */
const encodeShape = {
  format: z
    .enum(['keep', 'webp', 'avif', 'jpeg', 'png'])
    .default('keep')
    .describe('Output format: keep = same as the input; webp = usually smallest, keeps transparency; avif = smaller still, slower; jpeg = photos only, transparency becomes white; png = keeps transparency. Default keep.'),
  quality: z.number().int().min(1).max(100).default(80).describe('1–100 for webp/avif/jpeg. Default 80 (visually near-identical, much smaller).'),
  lossless: z.boolean().default(false).describe('png only: keep exact colours (bigger files).'),
};

interface SaveArgs {
  output_path?: string;
  format: 'keep' | OutputFormat;
  quality: number;
  lossless: boolean;
  /** PNG optimisation effort (encode.ts); crop uses the web crop tool's quick 0. */
  effort?: number;
}

/**
 * The shared tail of compress, resize, crop and upscale: resolve the format, encode `px`, save it
 * beside the input and report from the file read back. `src` is the decoded input (its format backs
 * «keep»). A slow step can pass `px` as a function: it runs once the output path has checked out.
 */
async function saveEncoded(input: string, src: Decoded, make: Pixels | (() => Promise<Pixels>), a: SaveArgs, suffix: string, size: string, notes: string[]): Promise<CallToolResult> {
  let fmt: OutputFormat;
  if (a.format !== 'keep') fmt = a.format;
  else if (FORMATS.some((f) => f.id === src.format)) fmt = src.format as OutputFormat;
  else {
    fmt = 'webp'; // gif / tiff / heif have no encoder here
    notes.push(`Input is ${src.format}, which can't be re-encoded as-is — saved as WebP.`);
  }
  const info = FORMATS.find((f) => f.id === fmt)!;
  const out = await outputPath(input, a.output_path, suffix, info.ext);
  const px = typeof make === 'function' ? await make() : make;
  if (fmt === 'jpeg' && hasAlpha(px)) notes.push('JPEG has no transparency — transparent areas were filled with white.');
  const buf = await encodeImage(px, { format: fmt, quality: a.quality, lossless: a.lossless, effort: a.effort });
  await writeNew(out, buf);
  const before = (await stat(input)).size;
  const result = await decode(out); // read back what was actually written
  const lines = [
    `Saved: ${out}`,
    `${info.label} ${size}: ${formatBytes(before)} → ${formatBytes(buf.length)}` +
      (buf.length < before ? ` (${pct(before, buf.length)} smaller)` : ' (not smaller than the input)'),
    `Transparent background: ${hasAlpha(result) ? 'yes (shown as a checkerboard in the preview)' : 'no'}`,
    ...notes,
  ];
  return {
    content: [
      { type: 'text', text: lines.join('\n') },
      { type: 'image', data: (await preview(result)).toString('base64'), mimeType: 'image/webp' },
    ],
  };
}

const REMOVED: Record<MetaKind, string> = {
  location: 'GPS location',
  exif: 'EXIF details (camera, date, settings)',
  thumbnail: 'embedded thumbnail',
  xmp: 'XMP',
  iptc: 'IPTC/Photoshop data',
  comment: 'comments and text',
  time: 'timestamp',
  other: 'other blocks (maker data, C2PA, extra-image index)',
  trailer: 'data after the end of the image (extra images, motion-photo video)',
};
const KEPT: Record<KeptKind, string> = { icc: 'colour profile', orientation: 'orientation tag' };

/** What sharp sees in a file's main image, as removal kinds — for inputs rebuilt from pixels. */
function metaKinds(m: Meta): MetaKind[] {
  const exif = m.exif && exifContents(m.exif);
  const seen = new Set<MetaKind>();
  if (exif && exif.location) seen.add('location');
  if (exif && exif.details) seen.add('exif');
  if (m.xmp) seen.add('xmp');
  if (m.iptc) seen.add('iptc');
  if (m.text) seen.add('comment');
  return META_KINDS.filter((k) => seen.has(k));
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'ruah', version: VERSION });

  server.registerTool(
    'remove_background',
    {
      title: 'Remove background',
      description:
        'Cut the main subject out of a photo and make the background transparent (on-device AI — the image never leaves this computer). ' +
        'Saves a transparent PNG and returns its path plus a small preview. ' +
        'Use for "remove the background", "cut out", "transparent background", "누끼", product and profile photos. ' +
        'The PNG is lossless and large; to make it smaller, pass it to `compress` with format webp or png ' +
        '(jpeg cannot be transparent). The first call downloads a ~98 MB model once.',
      inputSchema: {
        input_path: z.string().describe('Image file to process (jpg, png, webp, avif, gif, tiff; heic on macOS). Absolute, ~/…, or relative to the working directory.'),
        output_path: z.string().optional().describe('Where to save the PNG. Default: "<name>-cutout.png" next to the input. Existing files are never overwritten.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ input_path, output_path }, extra): Promise<CallToolResult> => {
      try {
        const input = await readableInput(input_path);
        const out = await outputPath(input, output_path, 'cutout', 'png'); // refuse before the slow part
        const cut = await removeBackground(input, progressReporter(extra)?.(DOWNLOADING));
        const png = await encodeImage(cut, { format: 'png', quality: 100, lossless: true });
        await writeNew(out, png);
        const lines = [
          `Saved: ${out}`,
          `${cut.width}×${cut.height} PNG, ${formatBytes(png.length)} (input ${formatBytes((await stat(input)).size)})`,
          'Transparent background: yes (the preview shows transparency as a checkerboard)',
          `Subject kept: ${cut.coverage.toFixed(1)}% of the image${cut.usedFull ? ' (recovered with the full model)' : ''}`,
        ];
        // Under 1% is either a miss or a genuinely small subject (a person far off in a field is ~0.1%).
        if (cut.coverage < 1) {
          lines.push(
            cut.coverage === 0
              ? 'Warning: no subject was found — the result is fully transparent.'
              : 'Note: very little was kept. If the subject is larger than that in the photo, the cut-out missed it.',
          );
        }
        return {
          content: [
            { type: 'text', text: lines.join('\n') },
            { type: 'image', data: (await preview(cut)).toString('base64'), mimeType: 'image/webp' },
          ],
        };
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'compress',
    {
      title: 'Compress image',
      description:
        'Make an image file smaller with little visible quality loss, on-device (same encoders and defaults as ruah.tools). ' +
        'Saves a new file and reports the size before and after; the original is never changed. ' +
        'Formats: keep = same format as the input; webp = usually the smallest and keeps transparency; ' +
        'avif = smaller still, slower to encode; jpeg = photos only, transparency becomes white; ' +
        'png = lossy palette compression that keeps transparency (or lossless=true for exact colours). ' +
        'Prefer webp unless the user needs a specific format. ' +
        'This is also the tool for converting between formats ("convert to WebP/AVIF/JPG/PNG"): set `format`. ' +
        'To change the pixel dimensions, use `resize` instead (it can change the format in the same step).',
      inputSchema: {
        input_path: z.string().describe('Image file to compress. Absolute, ~/…, or relative to the working directory.'),
        output_path: z.string().optional().describe('Where to save. Default: "<name>-compressed.<ext>" next to the input. Existing files are never overwritten.'),
        ...encodeShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ input_path, ...args }): Promise<CallToolResult> => {
      try {
        const input = await readableInput(input_path);
        const px = await decode(input);
        return await saveEncoded(input, px, px, args, 'compressed', `${px.width}×${px.height}`, []);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'resize',
    {
      title: 'Resize image',
      description:
        'Change an image\'s pixel dimensions, keeping its proportions, on-device (same high-quality resampler and encoders as ruah.tools). ' +
        'Give exactly one of max_side (the longest side in pixels — e.g. 1920 for web pages, 1080 for social posts, 640 for thumbnails) or percent. ' +
        'It never enlarges unless allow_upscale is true. Saves a new file and reports the size before and after; the original is never changed. ' +
        'The output is also compressed with the same format/quality options as `compress`, so "make it 800px and WebP" is one call.',
      inputSchema: {
        input_path: z.string().describe('Image file to resize. Absolute, ~/…, or relative to the working directory.'),
        output_path: z.string().optional().describe('Where to save. Default: "<name>-resized.<ext>" next to the input. Existing files are never overwritten.'),
        max_side: z.number().int().min(16).max(MAX_SIDE).optional().describe('Fit inside this many pixels on the longest side.'),
        percent: z.number().min(1).max(100).optional().describe('Scale to this percentage of the original (1–100; to enlarge, use max_side with allow_upscale).'),
        allow_upscale: z.boolean().default(false).describe('Allow max_side to make the image larger than the original. Default false.'),
        ...encodeShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ input_path, max_side, percent, allow_upscale, ...args }): Promise<CallToolResult> => {
      try {
        if ((max_side === undefined) === (percent === undefined)) throw new Error('Give exactly one of max_side or percent.');
        const input = await readableInput(input_path);
        const src = await decode(input);
        const opts: ResizeOpts =
          max_side !== undefined
            ? { mode: 'fit', value: max_side, noUpscale: !allow_upscale }
            : { mode: 'percent', value: percent!, noUpscale: true };
        const px = await resizeImage(src, opts);
        const notes: string[] = [];
        if (px === src) {
          const wanted = targetDimensions(src.width, src.height, { ...opts, noUpscale: false });
          notes.push(
            wanted.width > src.width
              ? `Not enlarged: the image is already ${src.width}×${src.height}, smaller than asked (pass allow_upscale: true to enlarge).`
              : `Already ${src.width}×${src.height} — dimensions unchanged.`,
          );
        }
        return await saveEncoded(input, src, px, args, 'resized', `${src.width}×${src.height} → ${px.width}×${px.height}`, notes);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'crop',
    {
      title: 'Crop, rotate or flip image',
      description:
        'Cut an image down to an aspect ratio or an exact region, and/or turn it by quarter turns or mirror it, on-device (same tool as ruah.tools/crop: whole pixels moved, never resampled). ' +
        'aspect_ratio keeps the largest centred area of that shape (e.g. "1:1" for a square profile picture, "16:9" for a video thumbnail, "4:5" for a portrait post). ' +
        'box keeps an exact region, in pixels of the input as it is shown (upright). rotate and the flips work alone or together with either. ' +
        'Saves a new file and reports which region of the input it kept; the original is never changed. ' +
        'To change the pixel size use `resize`; to change only the format or file size use `compress`.',
      inputSchema: {
        input_path: z.string().describe('Image file to crop. Absolute, ~/…, or relative to the working directory.'),
        output_path: z.string().optional().describe('Where to save. Default: "<name>-crop.<ext>" next to the input. Existing files are never overwritten.'),
        aspect_ratio: z
          .string()
          .regex(/^\d+(\.\d+)?:\d+(\.\d+)?$/, 'aspect_ratio is width:height, e.g. "16:9"')
          .optional()
          .describe('Width:height of the result, e.g. "1:1", "4:5", "3:2", "16:9". Keeps the largest centred area of that shape (after rotate). Give this or box, not both.'),
        box: z
          .object({
            left: z.number().int().min(0),
            top: z.number().int().min(0),
            width: z.number().int().min(1),
            height: z.number().int().min(1),
          })
          .optional()
          .describe('Exact region to keep, in pixels of the input as shown (upright), measured before rotate and flips. Give this or aspect_ratio, not both.'),
        rotate: z.number().int().multipleOf(90).default(0).describe('Turn clockwise by this many degrees: 90, 180 or 270 (-90 turns anticlockwise). Default 0.'),
        flip_horizontal: z.boolean().default(false).describe('Mirror left↔right (after rotating).'),
        flip_vertical: z.boolean().default(false).describe('Mirror top↔bottom (after rotating).'),
        format: encodeShape.format,
        quality: z.number().int().min(1).max(100).default(90).describe('1–100 for webp/avif/jpeg. Default 90, like the web crop tool.'),
        lossless: z.boolean().default(true).describe('png only: keep exact colours. Default true; false makes a smaller palette PNG.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ input_path, aspect_ratio, box, rotate, flip_horizontal, flip_vertical, ...args }): Promise<CallToolResult> => {
      try {
        if (aspect_ratio && box) throw new Error('Give box or aspect_ratio, not both.');
        const o: Orient = { rotate: (((rotate % 360) + 360) % 360) as Orient['rotate'], flipH: flip_horizontal, flipV: flip_vertical };
        if (!aspect_ratio && !box && !o.rotate && !o.flipH && !o.flipV) {
          throw new Error('Nothing to do: give aspect_ratio, box, rotate, flip_horizontal or flip_vertical.');
        }
        const input = await readableInput(input_path);
        const src = await decode(input);
        const { width: W, height: H } = src;
        const s = orientedSize(W, H, o);
        let rect: Rect | undefined; // in the turned image
        if (box) {
          if (box.left + box.width > W || box.top + box.height > H) {
            throw new Error(`box (left ${box.left}, top ${box.top}, ${box.width}×${box.height}) goes outside the image, which is ${W}×${H} pixels.`);
          }
          rect = mapRect({ x: box.left, y: box.top, w: box.width, h: box.height }, W, H, o);
        } else if (aspect_ratio) {
          const [a, b] = aspect_ratio.split(':').map(Number);
          if (!(a > 0 && b > 0 && Number.isFinite(a / b) && a / b > 0)) throw new Error(`aspect_ratio needs two positive numbers, e.g. "16:9" (got "${aspect_ratio}").`);
          rect = pixelRect(fitAspect(s.width, s.height, a / b), s.width, s.height);
        }
        const px = orientCrop(src, o, rect);
        const notes: string[] = [];
        if (rect) {
          const k = mapRect(rect, s.width, s.height, invert(o)); // back in the input's pixels, as box takes them
          notes.push(`Kept region of the input: left ${k.x}, top ${k.y}, ${k.w}×${k.h} (the input is ${W}×${H}) — to move or resize it, pass an adjusted box.`);
        }
        return await saveEncoded(input, src, px, { ...args, effort: 0 }, 'crop', `${W}×${H} → ${px.width}×${px.height}`, notes);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'upscale',
    {
      title: 'Upscale image (AI)',
      description:
        'Enlarge an image 2× or 4× with on-device AI super-resolution (the same models as ruah.tools/upscale — the image never leaves this computer). ' +
        'Unlike `resize`, it redraws detail and crisp edges instead of stretching pixels into blur. ' +
        'Made for small or low-resolution images: icons, thumbnails, old web images, small product shots. ' +
        'Saves a new file and returns its path plus a small preview; the original is never changed. ' +
        `The result is limited to ${mp(MAX_UPSCALE_PIXELS)} megapixels (4096×4096): ×4 fits inputs up to about 1000×1000, ×2 up to about 2000×2000. ` +
        'To make an already large photo bigger, use `resize` with allow_upscale. ' +
        'Time grows with the output: small images take seconds, ×4 of 1000×1000 a minute or more. ' +
        'Transparency is kept: a transparent logo, icon or cut-out comes back transparent, with no dark fringe (save as png, webp or avif to keep it). ' +
        'The first ×2 call downloads an 8 MB model once, the first ×4 call 55 MB.',
      inputSchema: {
        input_path: z.string().describe('Image file to upscale (jpg, png, webp, avif, gif, tiff; heic on macOS). Absolute, ~/…, or relative to the working directory.'),
        output_path: z.string().optional().describe('Where to save. Default: "<name>-upscaled-x2.<ext>" (or -x4) next to the input. Existing files are never overwritten.'),
        scale: z.union([z.literal(2), z.literal(4)]).default(2).describe('2 = twice the width and height (default — quicker, and enough for most images); 4 = four times, for genuinely tiny sources.'),
        format: encodeShape.format,
        quality: z.number().int().min(1).max(100).default(90).describe('1–100 for webp/avif/jpeg. Default 90, like the web upscaler.'),
        lossless: z.boolean().default(true).describe('png only: keep exact colours. Default true; false makes a smaller palette PNG.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ input_path, scale, ...args }, extra): Promise<CallToolResult> => {
      try {
        const input = await readableInput(input_path);
        const { width: W, height: H } = await probe(input);
        checkUpscale(W, H, scale); // from the header: refuse before decoding
        const src = await decode(input);
        checkUpscale(src.width, src.height, scale); // the pixels themselves, in case the header said less
        const notes: string[] = [];
        const report = progressReporter(extra);
        const run = async () => {
          const t0 = performance.now();
          const up = await upscaleImage(src, scale, report?.(DOWNLOADING), report?.(`Upscaling ×${scale}`));
          const where = up.device === 'webgpu' ? 'the GPU (WebGPU)' : 'the CPU';
          notes.push(`AI upscaling ran on ${where}${up.tiles > 1 ? ` in ${up.tiles} tiles` : ''}, ${Math.round((performance.now() - t0) / 1000)} s.`);
          return up;
        };
        return await saveEncoded(input, src, run, { ...args, effort: 0 }, `upscaled-x${scale}`, `${W}×${H} → ${W * scale}×${H * scale}`, notes);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'strip_metadata',
    {
      title: 'Remove metadata',
      description:
        'Remove hidden metadata from an image before sharing it, on-device (same cleaner as ruah.tools): EXIF (GPS location, camera and device, date taken), XMP, IPTC, comments, embedded thumbnails and extra data such as motion-photo video. ' +
        'JPEG and PNG are cleaned losslessly — only the image data and its display settings (colour profile, orientation) are copied, not re-encoded — so the photo looks exactly the same. ' +
        'Other formats (HEIC from an iPhone, AVIF, GIF, …) are rebuilt from their pixels with no metadata at all: WebP stays WebP, images with transparency become PNG, photos become JPEG (quality 92). ' +
        'Saves a new file; the original is never changed. The result lists what was removed (e.g. a GPS location) and what is left — no need to check with other tools. ' +
        'Use for "remove EXIF", "strip GPS / location", "clean metadata before posting".',
      inputSchema: {
        input_path: z.string().describe('Image file to clean. Absolute, ~/…, or relative to the working directory.'),
        output_path: z.string().optional().describe('Where to save. Default: "<name>-clean.<ext>" next to the input. Existing files are never overwritten.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ input_path, output_path }): Promise<CallToolResult> => {
      try {
        const input = await readableInput(input_path);
        const bytes = await readFile(input);
        const src = await probe(input);
        const stripped = stripMetadata(bytes, `image/${src.format}`); // by content, not by extension
        // Like the web tool: without a lossless cleaner the image is rebuilt from its pixels (rebuildAs).
        const px = stripped ? null : await decode(input);
        const fmt = px ? rebuildAs(`image/${src.format}`, hasAlpha(px)) : src.format;
        const info = FORMATS.find((f) => f.id === fmt)!;
        const out = await outputPath(input, output_path, 'clean', info.ext); // refuse before the slow part
        let buf: Uint8Array, how: string, removed: MetaKind[], kept: KeptKind[];
        if (!px) {
          buf = stripped!.bytes;
          how = `${stripped!.removed > 0 ? `${formatBytes(stripped!.removed)} removed` : 'nothing to remove'}. Lossless: the image data was copied as-is, not re-encoded.`;
          ({ found: removed, kept } = stripped!);
        } else {
          buf = await encodeImage(px, { format: info.id, quality: REBUILD_QUALITY, lossless: true });
          const as = info.id === 'png' ? 'lossless PNG (it has transparency)' : `${info.label} (quality ${REBUILD_QUALITY})`;
          how = `Re-encoded: this ${src.format} can't be cleaned losslessly, so it was rebuilt from its pixels as ${as}.`;
          removed = metaKinds(await readMeta(input));
          kept = [];
        }
        await writeNew(out, buf);
        const lines = [
          `Saved: ${out}`,
          `${info.label} ${src.width}×${src.height}: ${formatBytes(bytes.length)} → ${formatBytes(buf.length)}. ${how}`,
          `Removed: ${removed.map((k) => REMOVED[k]).join(', ') || 'no metadata found'}`,
          `Left in the file: only the image data${kept.length ? ` and display settings (${kept.map((k) => KEPT[k]).join(', ')})` : ''}.`,
        ];
        return {
          content: [
            { type: 'text', text: lines.join('\n') },
            { type: 'image', data: (await preview(out)).toString('base64'), mimeType: 'image/webp' },
          ],
        };
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}
