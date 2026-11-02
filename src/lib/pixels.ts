// RGBA pixels and checks on them — no codecs, so any island can import this without pulling in
// the encoders (encode.ts re-exports both).

/** RGBA pixels — a DOM ImageData or the same shape built in Node. */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** True when any pixel is not fully opaque. */
export function hasAlpha(img: Pixels): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}
