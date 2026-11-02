// Resizing shared by the web codec worker and the ruah-mcp agent server: the same size rule and the
// same lanczos3 WASM resampler (jSquash), so an agent's resize matches one made on ruah.tools.
// Runtime-neutral like encode.ts — the browser fetches the wasm on first use; Node hands over a
// compiled module once via initResizer().
import resizeImage, { initResize } from '@jsquash/resize';
import type { Pixels } from './encode';

export type ResizeMode = 'fit' | 'percent';

export interface ResizeOpts {
  /** 'fit' = longest side ≤ value(px); 'percent' = scale by value%. */
  mode: ResizeMode;
  value: number;
  /** Never enlarge beyond original. */
  noUpscale: boolean;
}

/** Compute target dimensions for a resize request, preserving aspect ratio. */
export function targetDimensions(w: number, h: number, r: ResizeOpts): { width: number; height: number } {
  let ratio = r.mode === 'percent' ? r.value / 100 : r.value / Math.max(w, h);
  if (!Number.isFinite(ratio) || ratio <= 0) ratio = 1;
  if (r.noUpscale) ratio = Math.min(ratio, 1);
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
  };
}

/** Resize to the requested size; returns the input itself when the size doesn't change. */
export async function resize(img: Pixels, r: ResizeOpts): Promise<Pixels> {
  const { width, height } = targetDimensions(img.width, img.height, r);
  if (width === img.width && height === img.height) return img;
  // jSquash reads `data.buffer` whole, so a view into a larger buffer must be copied out first.
  const d = img.data;
  const own = d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? img : { ...img, data: d.slice() };
  // Its signature wants a DOM ImageData; it only reads data/width/height.
  return resizeImage(own as ImageData, { width, height, method: 'lanczos3' });
}

/** Node: initialise the resampler from its compiled wasm module (the browser self-initialises). */
export async function initResizer(m: WebAssembly.Module): Promise<void> {
  await initResize(m);
}
