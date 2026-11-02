// AI super-resolution shared by the web upscaler (through its worker) and the ruah-mcp agent server:
// which Swin2SR model serves each scale, how a large input is tiled, how the tiles are stitched, and
// how transparency is kept. The model call is passed in (a transformers.js image-to-image pipeline,
// on ORT-web or onnxruntime-node); everything around it is plain pixel work, so both runtimes stitch
// the same model output into the same image. Runtime-neutral: no DOM, no Node APIs.
import { orientCrop, UPRIGHT } from './crop.ts';
import { hasAlpha, type Pixels } from './pixels.ts';

export type Scale = 2 | 4;

// scale → model id on Ruah's mirror (fp32; fp16 exports of these fail ORT session creation, quantized
// is a future size optimisation). x2 = lightweight (8 MB), x4 = compressed, real-photo tuned (55 MB).
export const MODEL: Record<Scale, string> = {
  2: 'ruah/swin2SR-lightweight-x2-64',
  4: 'ruah/swin2SR-compressed-sr-x4-48',
};

// Above this longest-side input, tile instead of running the whole image at once. Up to ~512²
// input (→2048² out at x4) runs whole with no measured OOM; larger inputs are tiled to bound
// peak memory and to report progress.
const TILE_THRESHOLD = 512;
const TILE = 256; // input tile size
const OVERLAP = 16; // context margin discarded when compositing (avoids seam artefacts)

// Below this alpha a pixel's colour is only partly trusted (see fillHidden). Browsers keep pixels
// premultiplied, so a colour read back at alpha a is off by up to ~127/a levels: ±2 at 64, ±16 at 8.
const SURE_ALPHA = 64;

/** A transformers.js RawImage (or anything shaped like one): 1–4 interleaved channels. */
interface ModelImage {
  data: ArrayLike<number>;
  width: number;
  height: number;
  channels: number;
}

/** One model call: RGBA pixels in (the model looks at RGB only), the upscaled image (RawImage or [RawImage]) out. */
export type SuperRes = (px: Pixels) => Promise<ModelImage | ModelImage[]>;

export interface Upscaled {
  /** RGBA. Transparency is kept: the alpha is upscaled by the same model, as a grey image. */
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  /** Number of tiles processed (1 = whole image). */
  tiles: number;
}

/** Upscale `src` by `scale`, tiling large inputs; `onTile` hears (0, total) first, then each tile done. */
export async function upscale(
  src: Pixels,
  scale: Scale,
  run: SuperRes,
  onTile?: (done: number, total: number) => void,
): Promise<Upscaled> {
  const { width: w, height: h } = src;
  // With transparency the model gets the colour with its hidden parts filled in, then the alpha in a
  // second pass. Opaque images take one pass, exactly as before transparency was kept.
  const clear = hasAlpha(src);
  const colour = clear ? fillHidden(src) : src;
  // Up to the threshold the whole image is a single tile.
  const tile = Math.max(w, h) <= TILE_THRESHOLD ? Math.max(w, h) : TILE;
  const ow = w * scale;
  const oh = h * scale;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const total = Math.ceil(w / tile) * Math.ceil(h / tile);
  let done = 0;
  onTile?.(0, total);
  for (let ty = 0; ty < h; ty += tile) {
    for (let tx = 0; tx < w; tx += tile) {
      // Extract with an overlap margin so the model has context around the kept region.
      const ex0 = Math.max(0, tx - OVERLAP);
      const ey0 = Math.max(0, ty - OVERLAP);
      const rect = { x: ex0, y: ey0, w: Math.min(w, tx + tile + OVERLAP) - ex0, h: Math.min(h, ty + tile + OVERLAP) - ey0 };
      // Copy only the tile's own cell (drop the overlap margins) — seam-free, no blend maths.
      const cell: Cell = {
        sx: (tx - ex0) * scale,
        sy: (ty - ey0) * scale,
        dx: tx * scale,
        dy: ty * scale,
        w: Math.min(tile, w - tx) * scale,
        h: Math.min(tile, h - ty) * scale,
      };
      const infer = async (px: Pixels) => {
        const res = await run(px);
        const up = Array.isArray(res) ? res[0] : res;
        // Swin2SR pads its input up to a multiple of its window size, so the output can be a few
        // pixels larger than ew·scale × eh·scale — padding on the right and bottom, outside any cell kept.
        if (up.width < rect.w * scale || up.height < rect.h * scale) {
          throw new Error(`upscale model returned ${up.width}×${up.height} for a ${rect.w}×${rect.h} tile at ×${scale}`);
        }
        return up;
      };
      // A tile whose alpha (margins included) is all 0 or all 255 needs no alpha pass, and a fully
      // transparent one no colour either: settle() below sets each of its cells, since a cell's 3×3
      // surroundings lie within the margins.
      const flat = clear ? flatAlpha(orientCrop(src, UPRIGHT, rect)) : 255;
      if (flat !== 0) paste(out, ow, await infer(orientCrop(colour, UPRIGHT, rect)), cell, false);
      if (flat < 0) paste(out, ow, await infer(alphaAsGrey(orientCrop(src, UPRIGHT, rect))), cell, true);
      onTile?.(++done, total);
    }
  }
  if (clear) settle(out, ow, src, scale);
  return { data: out, width: ow, height: oh, tiles: total };
}

/** Where a tile's kept cell sits in the model output (s) and in the result (d), in output pixels. */
interface Cell {
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  w: number;
  h: number;
}

/** Copy a cell of a model output into `out` — as opaque colour, or (asAlpha) its grey level as alpha. */
function paste(out: Uint8ClampedArray, ow: number, up: ModelImage, c: Cell, asAlpha: boolean) {
  const { data, channels: ch } = up;
  const g = ch >= 3 ? 1 : 0;
  const b = ch >= 3 ? 2 : 0;
  for (let row = 0; row < c.h; row++) {
    let s = ((c.sy + row) * up.width + c.sx) * ch;
    let d = ((c.dy + row) * ow + c.dx) * 4;
    for (let col = 0; col < c.w; col++, s += ch, d += 4) {
      if (asAlpha) {
        out[d + 3] = (data[s] + data[s + g] + data[s + b]) / 3;
      } else {
        out[d] = data[s];
        out[d + 1] = data[s + g];
        out[d + 2] = data[s + b];
        out[d + 3] = 255;
      }
    }
  }
}

/** 0 or 255 when every pixel has that alpha, else -1. */
function flatAlpha(px: Pixels): number {
  const d = px.data;
  const a = d[3];
  if (a !== 0 && a !== 255) return -1;
  for (let i = 7; i < d.length; i += 4) if (d[i] !== a) return -1;
  return a;
}

/** The alpha as an opaque grey image, for the model to upscale like any picture. */
function alphaAsGrey(px: Pixels): Pixels {
  const s = px.data;
  const d = new Uint8ClampedArray(s.length);
  for (let i = 0; i < s.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = s[i + 3];
    d[i + 3] = 255;
  }
  return { data: d, width: px.width, height: px.height };
}

/**
 * The colour the model should see. Under full transparency the stored colour is arbitrary (browsers
 * return black) and under low alpha it is coarse; drawn as is, the model turns it into a dark rim
 * round a logo. So each pixel below SURE_ALPHA is blended toward its surroundings in proportion to
 * how unsure it is: average up a pyramid weighted by sureness, then fill back down (pull-push).
 */
function fillHidden(src: Pixels): Pixels {
  const { width: w0, height: h0, data } = src;
  const sure = new Float32Array(w0 * h0);
  for (let i = 0; i < sure.length; i++) sure[i] = Math.min(1, data[i * 4 + 3] / SURE_ALPHA);
  // Pull: each level halves the one below — sureness-weighted colour sums (P), sureness (W, at most 1).
  const levels: { w: number; P: Float32Array; W: Float32Array }[] = [];
  let w = w0;
  let h = h0;
  while (w > 1 || h > 1) {
    const nw = Math.ceil(w / 2);
    const nh = Math.ceil(h / 2);
    const P = new Float32Array(nw * nh * 3);
    const W = new Float32Array(nw * nh);
    const below = levels.at(-1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = y * w + x;
        const d = (y >> 1) * nw + (x >> 1);
        if (below) {
          W[d] += below.W[s];
          for (let c = 0; c < 3; c++) P[d * 3 + c] += below.P[s * 3 + c];
        } else {
          W[d] += sure[s];
          for (let c = 0; c < 3; c++) P[d * 3 + c] += data[s * 4 + c] * sure[s];
        }
      }
    }
    for (let d = 0; d < W.length; d++) {
      if (W[d] > 1) {
        for (let c = 0; c < 3; c++) P[d * 3 + c] /= W[d];
        W[d] = 1;
      }
    }
    levels.push({ w: nw, P, W });
    w = nw;
    h = nh;
  }
  // Push: back down, each pixel = its own weighted colour + the unsure share from its parent's colour.
  let above: Float32Array | null = null;
  for (let k = levels.length - 1; k >= 0; k--) {
    const { w: lw, P, W } = levels[k];
    const pw = levels[k + 1]?.w ?? 0;
    const col = new Float32Array(P.length);
    for (let i = 0; i < W.length; i++) {
      const p = (((i / lw) | 0) >> 1) * pw + ((i % lw) >> 1);
      for (let c = 0; c < 3; c++) {
        col[i * 3 + c] = above ? P[i * 3 + c] + (1 - W[i]) * above[p * 3 + c] : W[i] > 0 ? P[i * 3 + c] / W[i] : 0;
      }
    }
    above = col;
  }
  const out = new Uint8ClampedArray(data);
  if (!above) return { data: out, width: w0, height: h0 }; // a single pixel: nothing around it
  const pw = levels[0].w;
  for (let i = 0; i < sure.length; i++) {
    const k = sure[i];
    if (k >= 1) continue;
    const p = (((i / w0) | 0) >> 1) * pw + ((i % w0) >> 1);
    for (let c = 0; c < 3; c++) out[i * 4 + c] = data[i * 4 + c] * k + (1 - k) * above[p * 3 + c];
  }
  return { data: out, width: w0, height: h0 };
}

/**
 * Where a source pixel and its 8 neighbours are all fully transparent or all fully opaque, its cell
 * in the result takes exactly that alpha — the model drifts a little (×4 leaves solid areas at
 * 248–254), which would make a solid logo faintly see-through. Fully transparent pixels carry no colour.
 */
function settle(out: Uint8ClampedArray, ow: number, src: Pixels, scale: number) {
  const { width: w, height: h, data } = src;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a !== 0 && a !== 255) continue;
      let flat = true;
      for (let j = Math.max(0, y - 1); flat && j <= Math.min(h - 1, y + 1); j++) {
        for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) {
          if (data[(j * w + i) * 4 + 3] !== a) {
            flat = false;
            break;
          }
        }
      }
      if (!flat) continue;
      for (let yy = y * scale; yy < (y + 1) * scale; yy++) {
        for (let xx = x * scale; xx < (x + 1) * scale; xx++) out[(yy * ow + xx) * 4 + 3] = a;
      }
    }
  }
  for (let d = 0; d < out.length; d += 4) if (out[d + 3] === 0) out[d] = out[d + 1] = out[d + 2] = 0;
}
