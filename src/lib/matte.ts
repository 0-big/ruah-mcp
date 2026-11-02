// Background-removal quality logic, shared by the web tool (Cutout.svelte) and the ruah-mcp agent
// server. Pure functions over pixel arrays — no DOM, no Node APIs — so both runtimes turn the same
// model output into the same cut-out.

/** A transformers.js RawImage (or anything shaped like one): 1–4 interleaved channels. */
export interface MatteImage {
  data: ArrayLike<number>;
  width: number;
  height: number;
  channels: number;
}

/** A background-removal model call: input image in, RGBA cut-out (RawImage or [RawImage]) out. */
export type Remover<I> = (input: I) => Promise<any>;

/**
 * What cutout needs from its input image: its size and a way to cut a region out of it. A
 * transformers.js RawImage has both, in the browser and in Node. Box corners are inclusive.
 */
export interface Croppable<I> {
  width: number;
  height: number;
  crop(box: [number, number, number, number]): Promise<I>;
}

export interface Cutout {
  /** Refined RGBA pixels (subject on transparent). */
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  /** % of pixels kept — near 0 means no subject was found. */
  coverage: number;
  /** True when the full model had to step in for lite (it found a subject lite missed). */
  usedFull: boolean;
}

// BiRefNet_lite is a salient-object matte model: on hard subjects (backlit, low-contrast, blended
// into the background) it sometimes returns an all-but-empty matte — i.e. it erases the subject.
// Below this % of kept pixels we treat the cut-out as a miss and retry with the full model.
export const EMPTY_COVERAGE = 1;

const alphaIndex = (channels: number) => (channels === 4 ? 3 : channels === 2 ? 1 : channels === 1 ? 0 : -1);
const KEPT = 16; // alpha above this counts as kept

/** Percentage of pixels the matte keeps (alpha above a small floor). */
export function coverage(rimg: MatteImage): number {
  const { data, channels, width, height } = rimg;
  const n = width * height;
  const ai = alphaIndex(channels);
  if (!n || ai < 0) return 100; // no alpha channel to judge → assume it kept everything
  let opaque = 0;
  for (let i = 0; i < n; i++) if (data[i * channels + ai] > KEPT) opaque++;
  return (100 * opaque) / n;
}

// BiRefNet sees every image at 512², so a subject that fills a small part of a large photo is drawn
// with a few dozen model pixels: its outline comes out blocky once stretched back to full size, gaps
// (between legs, between a wheel and a leg) fill with background, and lite often misses it entirely.
// So when the kept subject is small, we run a second, closer pass on just the region around it, where
// it gets the model's whole 512² grid. Measured with packages/ruah-mcp/scripts/small-subjects.mjs
// (2026-11-01): edge fit 0.70 → 0.95 for a person 0.1% of a field, 0.96 → 0.98 for a dog at 4%, and
// the background between legs and wheels is gone. The margin is a share of the subject's LONGER
// side, so a standing person gets wide side margins and a running dog even ones. 15% kept lite on
// the subject in 6 of 7 crops (the 7th, a cyclist, lite misses at any framing); 25% and 35% lost a
// small person, and per-axis 40% × 12% lost a wide tree.
export const FOCUS_PAD = 0.15; // margin on every side, × the subject box's longer side
export const FOCUS_MAX_AREA = 0.25; // refocus only when that region is ≤ this share of the image (≥ 2× detail)

/** The region [x0, y0, x1, y1) for a closer second pass, or null when the subject is already large. */
export function focusRegion(rimg: MatteImage): [number, number, number, number] | null {
  const { data, channels, width: w, height: h } = rimg;
  const ai = alphaIndex(channels);
  if (ai < 0) return null;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * channels + ai] <= KEPT) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null; // nothing kept
  const pad = Math.max(x1 - x0 + 1, y1 - y0 + 1) * FOCUS_PAD;
  const r: [number, number, number, number] = [
    Math.max(0, Math.floor(x0 - pad)),
    Math.max(0, Math.floor(y0 - pad)),
    Math.min(w, Math.ceil(x1 + 1 + pad)),
    Math.min(h, Math.ceil(y1 + 1 + pad)),
  ];
  return (r[2] - r[0]) * (r[3] - r[1]) <= FOCUS_MAX_AREA * w * h ? r : null;
}

// Lite keeps the single most-salient object and can silently DROP other real subjects (a scene of
// several shapes, low-contrast pieces). Coverage alone can't catch that — one kept object already
// clears EMPTY_COVERAGE. So we also look for "orphaned" content: strong edges (real outlines) left
// sitting in the REMOVED region, away from both the kept subject and the image border. A lot of
// edge energy stranded out there = lite missed something → escalate to the full model. Escalation
// only replaces lite's result if the full model keeps MORE (see cutout), so a false trigger
// costs time, never quality.
// The score divides by the subject's own edge energy, so it only means something for a LARGE
// subject: the same person measured 1.5 in a tight crop and 25 with a wider view of the textured
// canyon around them (2026-11-01). Small subjects get the close pass (focusRegion) instead.
export const INCOMPLETE_RATIO = 1.4; // orphan-edge / kept-edge energy above this ⇒ likely incomplete

export function incompleteScore(rimg: MatteImage): number {
  const { data, channels: ch, width: w, height: h } = rimg;
  const ai = ch === 4 ? 3 : ch === 2 ? 1 : -1;
  if (ai < 0 || !w || !h) return 0; // no matte to judge
  const DS = 256;
  const scale = DS / Math.max(w, h);
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  const lum = new Float32Array(sw * sh);
  const al = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const sy = Math.min(h - 1, Math.floor(y / scale));
      const i = (sy * w + sx) * ch;
      lum[y * sw + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      al[y * sw + x] = data[i + ai];
    }
  }
  const E = new Float32Array(sw * sh);
  const g = (xx: number, yy: number) => lum[yy * sw + xx];
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const gx = g(x+1,y-1)+2*g(x+1,y)+g(x+1,y+1)-g(x-1,y-1)-2*g(x-1,y)-g(x-1,y+1);
      const gy = g(x-1,y+1)+2*g(x,y+1)+g(x+1,y+1)-g(x-1,y-1)-2*g(x,y-1)-g(x+1,y-1);
      E[y * sw + x] = Math.hypot(gx, gy);
    }
  }
  // Kept foreground, dilated by R so the subject's own outline isn't counted as orphaned.
  const R = 6;
  const fg = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) if (al[i] > 40) fg[i] = 1;
  const fgD = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let f = 0;
      for (let dy = -R; dy <= R && !f; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
          if (fg[yy * sw + xx]) { f = 1; break; }
        }
      }
      fgD[y * sw + x] = f;
    }
  }
  const B = 4; // ignore a border margin (vignette / background gradient edges)
  let orphan = 0, fgE = 0;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      if (fg[i]) fgE += E[i];
      const border = x < B || y < B || x >= sw - B || y >= sh - B;
      if (!fgD[i] && !border && al[i] < 16) orphan += E[i];
    }
  }
  return orphan / (fgE + 1e-6);
}

/**
 * Sharpen the cut-out edge (model-independent post-process).
 *
 * BiRefNet runs at 512² and its matte is bilinearly stretched to full resolution, so the raw
 * alpha edge is a wide (~4% of the image), soft transition band whose semi-transparent pixels
 * still carry the ORIGINAL background colour — that reads as the fuzzy, colour-tinted "halo" you
 * see against a busy/glowing backdrop. Photoroom & co. refine the matte to a near-binary edge; we
 * do the same cheaply here so a 512² matte looks crisp on a large image:
 *   1. contrast-curve the alpha so the wide band collapses to a ~1 px anti-aliased edge, and
 *   2. bleed trusted foreground colour outward into that thin band so no edge pixel keeps the
 *      background tint (de-fringe).
 * Measured: edge band 4.3% → 0.7% of pixels, matching Photoroom, with the subject and thin
 * structures preserved (coverage drops only ~2–3%, the outer feather). ~70 ms at 1.5 MP.
 *
 * Fully transparent pixels come out as (0,0,0,0) — what a browser canvas stores anyway
 * (premultiplied alpha). Made explicit so a runtime without canvas (Node) writes the same, smaller
 * file instead of keeping the erased background's colours in invisible pixels.
 */
export function refineMatte(d: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const BAND = 0.14; // half-width of the alpha transition we remap to [0,1]
  const SOLID = 0.75; // alpha above this = trusted foreground colour we can bleed outward
  const BLEED = 4; // px the foreground colour grows into the edge band
  const n = w * h;
  const lo = 0.5 - BAND;
  const hi = 0.5 + BAND;
  const smooth = (x: number) => {
    const t = x < 0 ? 0 : x > 1 ? 1 : x;
    return t * t * (3 - 2 * t);
  };

  // Crispen the alpha.
  const af = new Float32Array(n);
  for (let i = 0; i < n; i++) af[i] = smooth((d[i * 4 + 3] / 255 - lo) / (hi - lo));

  // Seed known foreground colours from confidently-opaque pixels, then grow them into the band.
  const known = new Uint8Array(n);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (af[i] >= SOLID) {
      known[i] = 1;
      col[i * 3] = d[i * 4];
      col[i * 3 + 1] = d[i * 4 + 1];
      col[i * 3 + 2] = d[i * 4 + 2];
    }
  }
  for (let pass = 0; pass < BLEED; pass++) {
    const nk = known.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i] || af[i] <= 0) continue; // never write into fully-transparent gaps
        let r = 0,
          g = 0,
          b = 0,
          c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const j = yy * w + xx;
            if (!known[j]) continue;
            r += col[j * 3];
            g += col[j * 3 + 1];
            b += col[j * 3 + 2];
            c++;
          }
        }
        if (c) {
          col[i * 3] = r / c;
          col[i * 3 + 1] = g / c;
          col[i * 3 + 2] = b / c;
          nk[i] = 1;
        }
      }
    }
    known.set(nk);
  }

  const out = new Uint8ClampedArray(n * 4); // zero-filled: transparent pixels stay (0,0,0,0)
  for (let i = 0; i < n; i++) {
    const a = Math.round(af[i] * 255);
    if (a === 0) continue;
    if (known[i]) {
      out[i * 4] = col[i * 3];
      out[i * 4 + 1] = col[i * 3 + 1];
      out[i * 4 + 2] = col[i * 3 + 2];
    } else {
      out[i * 4] = d[i * 4];
      out[i * 4 + 1] = d[i * 4 + 1];
      out[i * 4 + 2] = d[i * 4 + 2];
    }
    out[i * 4 + 3] = a;
  }
  return out;
}

/** Expand a 1–4 channel RawImage to RGBA. */
export function toRGBA(rimg: MatteImage): Uint8ClampedArray<ArrayBuffer> {
  const { data, width: w, height: h, channels: ch } = rimg;
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (ch === 4) {
    rgba.set(data);
  } else {
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = data[i * ch];
      rgba[i * 4 + 1] = data[i * ch + 1] ?? data[i * ch];
      rgba[i * 4 + 2] = data[i * ch + 2] ?? data[i * ch];
      rgba[i * 4 + 3] = ch === 2 ? data[i * ch + 1] : 255;
    }
  }
  return rgba;
}

/**
 * Remove one background: lite model first, the full model as a safety net, a closer second pass for
 * small subjects, then edge refinement. `input` is a transformers.js RawImage (browser and Node).
 */
export async function cutout<I extends Croppable<I>>(
  input: I,
  lite: Remover<I>,
  loadFull: () => Promise<Remover<I>>,
  onRefine?: () => void,
): Promise<Cutout> {
  const pick = (out: any): MatteImage => (Array.isArray(out) ? out[0] : out);
  let full: Promise<Remover<I>> | undefined;
  /** The full model's matte, or null when it can't run (offline, out of memory) — keep what we have. */
  const fullMatte = async (img: I): Promise<MatteImage | null> => {
    try {
      if (!full) {
        onRefine?.(); // let the caller say "Refining…" — the full model can take a while
        full = loadFull();
      }
      return pick(await (await full)(img));
    } catch {
      return null;
    }
  };
  // Lite, then the full model where lite erased everything (blank matte, coverage < EMPTY_COVERAGE).
  // The full result only replaces lite's if it keeps MORE.
  const pass = async (img: I) => {
    let rimg = pick(await lite(img));
    let cov = coverage(rimg);
    let usedFull = false;
    if (cov < EMPTY_COVERAGE) {
      const alt = await fullMatte(img);
      const altCov = alt ? coverage(alt) : 0;
      if (alt && altCov > cov) {
        rimg = alt;
        cov = altCov;
        usedFull = true;
      }
    }
    return { rimg, cov, usedFull };
  };

  let { rimg, cov, usedFull } = await pass(input);
  // Any subject counts here, even one under EMPTY_COVERAGE: a person far off in a field can be 0.1%
  // of the frame — exactly the subject that needs the close pass most.
  const region = focusRegion(rimg);
  if (region) {
    // Small subject → once more on the region around it (see FOCUS_PAD), pasted back at full size.
    const [x0, y0, x1, y1] = region;
    const close = await pass(await input.crop([x0, y0, x1 - 1, y1 - 1]));
    if (close.cov >= EMPTY_COVERAGE) {
      const { width: w, height: h } = input;
      const rw = x1 - x0;
      const rh = y1 - y0;
      const part = refineMatte(toRGBA(close.rimg), rw, rh);
      const data = new Uint8ClampedArray(w * h * 4); // outside the region: transparent (0,0,0,0)
      for (let y = 0; y < rh; y++) data.set(part.subarray(y * rw * 4, (y + 1) * rw * 4), ((y0 + y) * w + x0) * 4);
      const kept = (close.cov * rw * rh) / (w * h);
      return { data, width: w, height: h, coverage: kept, usedFull: usedFull || close.usedFull };
    }
    // Both models lost it up close → the whole-image result stands.
  } else if (!usedFull && cov >= EMPTY_COVERAGE && incompleteScore(rimg) > INCOMPLETE_RATIO) {
    // Large subject, but lite may have kept the dominant object and left other real subjects behind
    // (orphaned content → incompleteScore) — the full model recovers those.
    const alt = await fullMatte(input);
    const altCov = alt ? coverage(alt) : 0;
    if (alt && altCov > cov) {
      rimg = alt;
      cov = altCov;
      usedFull = true;
    }
  }
  // Snap the soft, upscaled 512² matte to a crisp, de-fringed edge (see refineMatte).
  const data = refineMatte(toRGBA(rimg), rimg.width, rimg.height);
  return { data, width: rimg.width, height: rimg.height, coverage: cov, usedFull };
}
