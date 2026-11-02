import type { OutputFormat } from './encode';

export interface FormatInfo {
  id: OutputFormat;
  label: string;
  ext: string;
  mime: string;
  lossy: boolean;
}

export const FORMATS: FormatInfo[] = [
  { id: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', lossy: true },
  { id: 'avif', label: 'AVIF', ext: 'avif', mime: 'image/avif', lossy: true },
  { id: 'jpeg', label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', lossy: true },
  { id: 'png', label: 'PNG', ext: 'png', mime: 'image/png', lossy: false },
];

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** Replace a filename's extension. */
export function swapExt(name: string, ext: string): string {
  return `${name.replace(/\.[^.]+$/, '')}.${ext}`;
}
