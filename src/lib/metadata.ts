// Lossless metadata stripping for JPEG and PNG — no re-encoding, pixels untouched.
// An allow-list, not a block-list: only what the image needs to display as before is copied —
// the image data, the ICC colour profile, and the EXIF Orientation (rewritten as a tag-only EXIF
// block; without it a phone photo turns sideways). Everything else goes, including blocks we don't
// recognise and anything after the image's end (extra images, motion-photo video, trailers).
// Returns null when it can't do that safely (unknown structure, other formats) — re-encode instead.

/** What a cleaner removed, in the order reports list it. */
export const META_KINDS = ['location', 'exif', 'thumbnail', 'xmp', 'iptc', 'comment', 'time', 'other', 'trailer'] as const;
export type MetaKind = (typeof META_KINDS)[number];
/** What it kept because the image displays differently without it. */
export type KeptKind = 'icc' | 'orientation';

export interface StripResult {
  /** Cleaned bytes. */
  bytes: Uint8Array<ArrayBuffer>;
  /** Bytes removed (original − cleaned). */
  removed: number;
  /** True when done losslessly (JPEG/PNG); false when the input was left unchanged. */
  lossless: boolean;
  /** What was removed (META_KINDS order). */
  found: MetaKind[];
  /** What was kept for display. */
  kept: KeptKind[];
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"

/**
 * IFD0 of a TIFF block (a JPEG "Exif" APP1 body or a PNG eXIf chunk): tag → the first SHORT of its
 * value, and the offset of the next IFD (0 = none). Null when it isn't a readable TIFF block.
 */
function readIfd0(tiff: Uint8Array): { tags: Map<number, number>; next: number } | null {
  if (tiff.length < 8) return null;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49; // "II" little-endian, "MM" big-endian
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd = view.getUint32(4, le);
  if (ifd + 2 > tiff.length) return null;
  const count = view.getUint16(ifd, le);
  const tags = new Map<number, number>();
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12; // tag(2) type(2) count(4) value(4)
    if (e + 12 > tiff.length) break;
    tags.set(view.getUint16(e, le), view.getUint16(e + 8, le));
  }
  const end = ifd + 2 + count * 12;
  return { tags, next: end + 4 <= tiff.length ? view.getUint32(end, le) : 0 };
}

/** EXIF Orientation (1–8) from a TIFF block. 1 if absent. */
function readOrientation(tiff: Uint8Array): number {
  const v = readIfd0(tiff)?.tags.get(0x0112) ?? 1;
  return v >= 1 && v <= 8 ? v : 1;
}

/**
 * What an EXIF block says, for reports: a GPS location, other details (camera, date, settings,
 * a thumbnail), and the orientation. Takes the block with or without the "Exif\0\0" prefix.
 */
export function exifContents(exif: Uint8Array): { location: boolean; details: boolean; orientation: number } {
  const tiff = EXIF_ID.every((b, k) => exif[k] === b) ? exif.subarray(EXIF_ID.length) : exif;
  const ifd = readIfd0(tiff);
  if (!ifd) return { location: false, details: true, orientation: 1 }; // unreadable — assume it says something
  return {
    location: ifd.tags.has(0x8825), // GPS IFD pointer
    details: ifd.next !== 0 || [...ifd.tags.keys()].some((t) => t !== 0x0112 && t !== 0x8825),
    orientation: readOrientation(tiff),
  };
}

/** The smallest TIFF block that carries only an Orientation tag. */
function orientationTiff(o: number): Uint8Array {
  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, // "MM", 42, IFD0 at offset 8
    0, 1, // one entry
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, // Orientation, SHORT, count 1, value
    0, 0, 0, 0, // no next IFD
  ]);
}

const startsWith = (b: Uint8Array, id: string) => id.length <= b.length && [...id].every((c, k) => b[k] === c.charCodeAt(0));

/** Note what an EXIF block held; keep its orientation (once) if the image isn't upright. */
function takeExif(tiffOrExif: Uint8Array, found: Set<MetaKind>, kept: Set<KeptKind>): number | null {
  const c = exifContents(tiffOrExif);
  if (c.location) found.add('location');
  if (c.details) found.add('exif');
  if (c.orientation === 1 || kept.has('orientation')) return null;
  kept.add('orientation');
  return c.orientation;
}

const MAX_PIECES = 4096;

/**
 * The cleaned file as views of the input (adjacent ranges merged into one) plus new pieces. `full`
 * caps it, so a file made of millions of tiny blocks is re-encoded instead of exhausting memory.
 */
function output(src: Uint8Array) {
  const pieces: Uint8Array[] = [];
  let from = -1;
  let to = -1;
  return {
    copy(a: number, b: number) {
      if (a === to) pieces[pieces.length - 1] = src.subarray(from, (to = b));
      else {
        pieces.push(src.subarray(a, b));
        from = a;
        to = b;
      }
    },
    add(piece: Uint8Array) {
      pieces.push(piece);
      to = -1;
    },
    get full() {
      return pieces.length > MAX_PIECES;
    },
    bytes: () => concat(pieces),
  };
}

/** Segments that are the image itself: SOFn, DHT, DAC, DQT, DRI, DHP, EXP (not the reserved JPG, C8, nor DNL). */
const jpegStructure = (m: number) => (m >= 0xc0 && m <= 0xcf && m !== 0xc8) || (m >= 0xdb && m <= 0xdf && m !== 0xdc);

/**
 * Copy a JPEG's image structure and scans, plus JFIF (APP0, rebuilt without a thumbnail), ICC colour
 * (APP2) and Adobe colour transform (APP14, rebuilt to its 12 bytes); a non-upright Orientation
 * becomes a tag-only APP1. Stops at the first EOI. Null on anything it doesn't recognise.
 */
export function stripJpeg(bytes: Uint8Array, found = new Set<MetaKind>(), kept = new Set<KeptKind>()): Uint8Array<ArrayBuffer> | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const out = output(bytes);
  out.copy(0, 2); // SOI
  let i = 2;
  while (i < bytes.length) {
    if (out.full) return null;
    if (bytes[i] !== 0xff) return null; // malformed — bail rather than corrupt
    let marker = bytes[i + 1];
    // consume fill bytes (0xFF 0xFF ...)
    while (marker === 0xff && i + 2 < bytes.length) {
      i++;
      marker = bytes[i + 1];
    }
    if (marker === 0xd9) {
      // EOI: the image ends here. What follows (extra images, motion-photo video, trailers) is dropped.
      out.copy(i, i + 2);
      if (i + 2 < bytes.length) found.add('trailer');
      return out.bytes();
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // RSTn or TEM outside a scan: no length, no content — decoders skip them
      continue;
    }
    // Length-bearing segment: 2-byte big-endian length (includes the 2 length bytes).
    if (i + 4 > bytes.length) return null;
    const end = i + 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    if (end < i + 4 || end > bytes.length) return null;
    const body = bytes.subarray(i + 4, end);
    if (jpegStructure(marker) || marker === 0xda) out.copy(i, end);
    else if (marker === 0xe0 && startsWith(body, 'JFIF\0') && body.length >= 14) {
      out.add(new Uint8Array([0xff, 0xe0, 0, 16, ...body.subarray(0, 12), 0, 0])); // density only, 0×0 thumbnail
      if (body[12] || body[13]) found.add('thumbnail');
    } else if (marker === 0xe2 && startsWith(body, 'ICC_PROFILE\0')) {
      out.copy(i, end);
      kept.add('icc');
    } else if (marker === 0xee && startsWith(body, 'Adobe') && body.length >= 12) {
      out.add(new Uint8Array([0xff, 0xee, 0, 14, ...body.subarray(0, 12)]));
    } else if (marker === 0xe1 && startsWith(body, 'Exif\0\0')) {
      const o = takeExif(body, found, kept);
      if (o) {
        const tiff = orientationTiff(o);
        const len = 2 + EXIF_ID.length + tiff.length;
        out.add(new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...EXIF_ID, ...tiff]));
      }
    } else if (marker === 0xe1 && startsWith(body, 'http://ns.adobe.com/')) found.add('xmp');
    else if (marker === 0xed) found.add('iptc'); // Photoshop / IPTC
    else if (marker === 0xe0 && startsWith(body, 'JFXX\0')) found.add('thumbnail');
    else if (marker === 0xfe) found.add('comment');
    else if (marker >= 0xe0 && marker <= 0xef) found.add('other'); // MPF, maker data, C2PA, …
    else return null; // a marker we don't know — let the caller re-encode rather than guess
    i = end;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next real marker: an FF that isn't stuffing (FF 00), RSTn or fill.
      let j = i;
      while ((j = bytes.indexOf(0xff, j)) !== -1 && j + 1 < bytes.length) {
        const m = bytes[j + 1];
        if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) j += 2;
        else if (m === 0xff) j += 1;
        else break;
      }
      if (j === -1 || j + 1 >= bytes.length) {
        out.copy(i, bytes.length); // no EOI — a truncated file; keep the scan data it has
        return out.bytes();
      }
      out.copy(i, j);
      i = j;
    }
  }
  return out.bytes();
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/**
 * Chunks the image needs to display the same — pixels, palette, transparency, colour, size,
 * animation — with the most data each can legitimately hold.
 */
const PNG_KEEP = new Map<string, number>([
  ['IHDR', 13], ['PLTE', 768], ['IDAT', Infinity], ['IEND', 0], ['tRNS', 256], ['cHRM', 32], ['gAMA', 4],
  ['iCCP', Infinity], ['sBIT', 4], ['sRGB', 1], ['cICP', 4], ['mDCV', 24], ['cLLI', 8], ['bKGD', 6], ['pHYs', 9],
  ['acTL', 8], ['fcTL', 26], ['fdAT', Infinity],
]);

let crcTable: Uint32Array | undefined;

function crc32(data: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  let c = 0xffffffff;
  for (const b of data) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Copy a PNG's display chunks (PNG_KEEP); a non-upright Orientation becomes a tag-only eXIf.
 * Text, time, EXIF, private and unknown ancillary chunks go, and so does anything after IEND.
 * Null on an unknown critical chunk or a kept chunk longer than the format allows.
 */
export function stripPng(bytes: Uint8Array, found = new Set<MetaKind>(), kept = new Set<KeptKind>()): Uint8Array<ArrayBuffer> | null {
  if (bytes.length < 8) return null;
  for (let k = 0; k < 8; k++) if (bytes[k] !== PNG_SIG[k]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = output(bytes);
  out.copy(0, 8);
  let i = 8;
  while (i + 8 <= bytes.length) {
    if (out.full) return null;
    const dataLen = view.getUint32(i, false);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const total = 12 + dataLen; // length(4) + type(4) + data + crc(4)
    if (i + total > bytes.length) break; // truncated — stop
    const data = bytes.subarray(i + 8, i + 8 + dataLen);
    const max = PNG_KEEP.get(type);
    if (max !== undefined) {
      if (dataLen > max) return null; // more than the format allows — something rides along; re-encode
      out.copy(i, i + total);
      if (type === 'iCCP') kept.add('icc');
    } else if (type === 'eXIf') {
      const o = takeExif(data, found, kept);
      if (o) out.add(pngChunk('eXIf', orientationTiff(o)));
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      found.add(startsWith(data, 'XML:com.adobe.xmp\0') ? 'xmp' : 'comment'); // libvips writes XMP as tEXt
    } else if (bytes[i + 4] < 0x61) return null; // an unknown critical chunk (e.g. Apple's CgBI) can't be dropped
    else found.add(type === 'tIME' ? 'time' : 'other');
    i += total;
    if (type === 'IEND') {
      if (i < bytes.length) found.add('trailer');
      break;
    }
  }
  return out.bytes();
}

/** Strip metadata for a supported type; returns null when we can't do it losslessly. */
export function stripMetadata(bytes: Uint8Array, type: string): StripResult | null {
  const found = new Set<MetaKind>();
  const kept = new Set<KeptKind>();
  let cleaned: Uint8Array<ArrayBuffer> | null = null;
  if (type === 'image/jpeg') cleaned = stripJpeg(bytes, found, kept);
  else if (type === 'image/png') cleaned = stripPng(bytes, found, kept);
  if (!cleaned) return null;
  return {
    bytes: cleaned,
    removed: bytes.length - cleaned.length,
    lossless: true,
    found: META_KINDS.filter((k) => found.has(k)),
    kept: (['icc', 'orientation'] as const).filter((k) => kept.has(k)),
  };
}

/**
 * Without a lossless cleaner (other formats, unrecognised structure) the image is rebuilt from its
 * pixels alone, which carries no metadata: WebP stays WebP, transparency needs PNG, and anything
 * else is a photo for sharing — JPEG, as an iPhone exports with "Most Compatible".
 */
export function rebuildAs(type: string, transparent: boolean): 'webp' | 'png' | 'jpeg' {
  return type === 'image/webp' ? 'webp' : transparent ? 'png' : 'jpeg';
}

/** Quality for a lossy rebuild (WebP/JPEG) — visually the same as the input. */
export const REBUILD_QUALITY = 92;

export function supportsLossless(type: string): boolean {
  return type === 'image/jpeg' || type === 'image/png';
}
