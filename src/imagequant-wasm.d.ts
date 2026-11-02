// Ambient types for the raw wasm-bindgen glue of `imagequant` (libimagequant).
// The package ships types only for its main entry (which uses an ESM `import ... from
// '*.wasm'` that Vite can't handle); we import the `_bg.js` glue directly and load the
// wasm ourselves in the worker, so we declare its surface here.
declare module 'imagequant/imagequant_bg.js' {
  export class ImagequantImage {
    /** gamma: use 0 for sRGB (most images). */
    constructor(data: Uint8Array, width: number, height: number, gamma: number);
    free(): void;
  }
  export class Imagequant {
    constructor();
    /** min 0 never aborts; target (max) < 100 lets it use fewer colours. */
    set_quality(minimum: number, target: number): void;
    set_max_colors(maxColors: number): void;
    /** 1 (best/slowest) – 10 (worst/fastest); default 4. */
    set_speed(value: number): void;
    /** Quantises + PNG-encodes (lodepng). Consumes `image`; returns a complete PNG. */
    process(image: ImagequantImage): Uint8Array;
    free(): void;
  }
  export function __wbg_set_wasm(wasm: unknown): void;
}

declare module 'imagequant/imagequant_bg.wasm?url' {
  const url: string;
  export default url;
}
