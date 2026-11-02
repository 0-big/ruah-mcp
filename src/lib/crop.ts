// Cropping, quarter turns and mirroring shared by the web crop tool (through the codec worker) and
// the ruah-mcp agent server. Every output pixel is an input pixel moved, never resampled, so both
// make the same pixels from the same picture — and, with the shared encoders, the same file.
// Runtime-neutral: no DOM, no Node APIs.
import type { Pixels } from './pixels';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Turn clockwise by `rotate`, then mirror left↔right (`flipH`), then top↔bottom (`flipV`). */
export interface Orient {
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

export const UPRIGHT: Orient = { rotate: 0, flipH: false, flipV: false };

/** `a`, then `b` — one orientation that does both. */
export function compose(a: Orient, b: Orient): Orient {
  // A quarter turn after a mirror is the same as the turn before the other mirror.
  const swap = b.rotate % 180 !== 0;
  return {
    rotate: ((a.rotate + b.rotate) % 360) as Orient['rotate'],
    flipH: (swap ? a.flipV : a.flipH) !== b.flipH,
    flipV: (swap ? a.flipH : a.flipV) !== b.flipV,
  };
}

/** The orientation that undoes `o`. */
export function invert(o: Orient): Orient {
  const swap = o.rotate % 180 !== 0;
  return {
    rotate: ((360 - o.rotate) % 360) as Orient['rotate'],
    flipH: swap ? o.flipV : o.flipH,
    flipV: swap ? o.flipH : o.flipV,
  };
}

/** Size of a `w`×`h` image after `o`. */
export function orientedSize(w: number, h: number, o: Orient): { width: number; height: number } {
  return o.rotate % 180 ? { width: h, height: w } : { width: w, height: h };
}

/** Where rectangle `r` of a `w`×`h` image lands after `o`. */
export function mapRect(r: Rect, w: number, h: number, o: Orient): Rect {
  let { x, y, w: rw, h: rh } = r;
  if (o.rotate === 90) [x, y, rw, rh] = [h - (y + rh), x, rh, rw];
  else if (o.rotate === 180) [x, y] = [w - (x + rw), h - (y + rh)];
  else if (o.rotate === 270) [x, y, rw, rh] = [y, w - (x + rw), rh, rw];
  const s = orientedSize(w, h, o);
  if (o.flipH) x = s.width - (x + rw);
  if (o.flipV) y = s.height - (y + rh);
  return { x, y, w: rw, h: rh };
}

/** The largest centred rectangle of `ratio` (width / height) inside `w`×`h`. */
export function fitAspect(w: number, h: number, ratio: number): Rect {
  let rw = w;
  let rh = rw / ratio;
  if (rh > h) {
    rh = h;
    rw = rh * ratio;
  }
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** `r` in whole pixels, at least 1×1 and inside `w`×`h` — the size rounds the way the web shows it. */
export function pixelRect(r: Rect, w: number, h: number): Rect {
  const rw = clamp(Math.round(r.w), 1, w);
  const rh = clamp(Math.round(r.h), 1, h);
  return { x: clamp(Math.round(r.x), 0, w - rw), y: clamp(Math.round(r.y), 0, h - rh), w: rw, h: rh };
}

/**
 * Orient `img`, then keep `rect` (whole pixels, in the oriented image; default all of it).
 * Returns the input itself when nothing changes.
 */
export function orientCrop(img: Pixels, o: Orient, rect?: Rect): Pixels {
  const { width: W, height: H } = img;
  const s = orientedSize(W, H, o);
  const r = rect ?? { x: 0, y: 0, w: s.width, h: s.height };
  if (!o.rotate && !o.flipH && !o.flipV && !r.x && !r.y && r.w === W && r.h === H) return img;
  if (r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > s.width || r.y + r.h > s.height) {
    throw new Error(`crop ${r.w}×${r.h} at ${r.x},${r.y} is outside the ${s.width}×${s.height} image`);
  }
  // Source index of output position (u, v): undo the mirrors, then the turn. It is affine, so three
  // points give the start and the steps along a row and down a column.
  const at = (u: number, v: number) => {
    if (o.flipH) u = s.width - 1 - u;
    if (o.flipV) v = s.height - 1 - v;
    if (o.rotate === 90) return (H - 1 - u) * W + v;
    if (o.rotate === 180) return (H - 1 - v) * W + (W - 1 - u);
    if (o.rotate === 270) return u * W + (W - 1 - v);
    return v * W + u;
  };
  const start = at(r.x, r.y);
  const du = at(r.x + 1, r.y) - start;
  const dv = at(r.x, r.y + 1) - start;
  // One RGBA pixel = one 32-bit word (byte order doesn't matter for a copy).
  const d = img.data;
  const src = new Uint32Array(d.byteOffset % 4 ? d.slice().buffer : d.buffer, d.byteOffset % 4 ? 0 : d.byteOffset, W * H);
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  const dst = new Uint32Array(out.buffer);
  let i = 0;
  for (let v = 0; v < r.h; v++) {
    const row = start + v * dv;
    if (du === 1) {
      dst.set(src.subarray(row, row + r.w), i);
      i += r.w;
    } else {
      for (let u = 0, p = row; u < r.w; u++, p += du) dst[i++] = src[p];
    }
  }
  return { data: out, width: r.w, height: r.h };
}
