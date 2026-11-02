// Model weights: fetched once from Ruah's model mirror (the same files ruah.tools uses), verified
// against pinned SHA-256 hashes, and kept in a local cache. transformers.js then loads them from
// disk only — it never reaches out to the network itself.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { MODEL as UPSCALE } from '../../../src/lib/upscale.ts';

const HOST = process.env.RUAH_MODEL_HOST ?? 'https://models.ruah.tools';

export const CACHE_DIR =
  process.env.RUAH_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ruah', 'models');

export interface ModelSpec {
  id: string;
  /** path inside the model repo → [bytes, sha256] */
  files: Record<string, [number, string]>;
}

export const MODELS = {
  // Ruah's own 512²-fixed BiRefNet_lite re-export (see scripts/model-export) — the default.
  lite: {
    id: 'ruah/BiRefNet_lite_512-ONNX',
    files: {
      'config.json': [81, '50acd2d700ee3d5facdcf3aab2312bb586372726dce8bdd5741bdae0ca6eb84f'],
      'preprocessor_config.json': [389, 'a79663b311d8404dfb329f7b45bc9f970a0c155aeedae8ac15b6b77d76789613'],
      'onnx/model_fp16.onnx': [98307201, '4e38eab365294036e35db258cc44eab7c1069c124e4c1fc3fedab71f74b6e536'],
    },
  },
  // Full BiRefNet_512: the safety net for subjects lite misses. Only fetched when that happens.
  full: {
    id: 'onnx-community/BiRefNet_512x512-ONNX',
    files: {
      'config.json': [30, '88b20240c9078cf9cc3843dc7d69a42d274b8c242de56a3b2a41ef9995cb93bf'],
      'preprocessor_config.json': [389, 'a79663b311d8404dfb329f7b45bc9f970a0c155aeedae8ac15b6b77d76789613'],
      'onnx/model_fp16.onnx': [473498113, '1b254749feb1edf83667a4c9da710cc1962a1980b8d0b2f4432100278c9ac0af'],
    },
  },
  // Swin2SR super-resolution: the same fp32 files ruah.tools/upscale runs. Fetched on first use.
  x2: {
    id: UPSCALE[2],
    files: {
      'config.json': [801, '4d240283b55a5178c89555aecde586cf3ac6a5a4a2386515cd2c145aa2f5bdf8'],
      'preprocessor_config.json': [152, 'cbc36266fcc93d5bc1e9ca69bcc648ae9d268918ad14cd3507216740f129cc4d'],
      'onnx/model.onnx': [8078888, 'c2abbfe0cc8e685b5e11964970f8ebe3d24072e904fd5545a30ac31ec1e110db'],
    },
  },
  x4: {
    id: UPSCALE[4],
    files: {
      'config.json': [830, 'd8bbbbc19933e760c29fe49e98c18001a7ec208f21b47c4531abac75348060d9'],
      'preprocessor_config.json': [152, 'cbc36266fcc93d5bc1e9ca69bcc648ae9d268918ad14cd3507216740f129cc4d'],
      'onnx/model.onnx': [55046351, '2038700d530bb756a29552d7c8ddbd4a8f734df6cc43162ed543360a7aeb02f7'],
    },
  },
} satisfies Record<string, ModelSpec>;

export type Progress = (done: number, total: number) => void;

// One download per model at a time; callers that join one already running (e.g. a tool call
// arriving during the startup prefetch) still get its progress.
const pending = new Map<string, { done: Promise<void>; listeners: Set<Progress> }>();

/** Make sure every file of `spec` is in the cache (downloading + verifying what's missing). */
export function ensureModel(spec: ModelSpec, onProgress?: Progress): Promise<void> {
  let job = pending.get(spec.id);
  if (!job) {
    const listeners = new Set<Progress>();
    const done = fetchMissing(spec, (d, t) => listeners.forEach((l) => l(d, t))).finally(() =>
      pending.delete(spec.id),
    );
    job = { done, listeners };
    pending.set(spec.id, job);
  }
  if (onProgress) job.listeners.add(onProgress);
  return job.done;
}

async function fetchMissing(spec: ModelSpec, onProgress?: Progress): Promise<void> {
  const files = Object.entries(spec.files);
  const total = files.reduce((s, [, [bytes]]) => s + bytes, 0);
  let done = 0;
  for (const [file, [bytes, sha]] of files) {
    const dest = join(CACHE_DIR, spec.id, file);
    // Files only ever land in the cache after their hash checked out (see download), so a file
    // of the right size is trusted without re-hashing hundreds of MB on every start.
    if ((await stat(dest).catch(() => null))?.size === bytes) {
      done += bytes;
      continue;
    }
    await download(`${HOST}/${spec.id}/resolve/main/${file}`, dest, bytes, sha, (n) => onProgress?.(done + n, total));
    done += bytes;
  }
  onProgress?.(total, total);
}

// node:https rather than fetch(): measured on the 98 MB model, fetch() streamed the same bytes
// ~5× slower (30 MB: 23 s vs 4 s, equal to curl) — minutes of first-run wait an agent sits through.
function get(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('http:') ? httpGet : httpsGet)(url, resolve).on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`model download stalled (no data for 60 s): ${url}`)));
  });
}

async function download(url: string, dest: string, bytes: number, sha: string, onBytes: (n: number) => void): Promise<void> {
  const res = await get(url);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`model download failed: HTTP ${res.statusCode} ${url}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  // Its own name: two clients starting together (say an editor and a desktop app) both fetch on
  // first run, and a shared .part would interleave their writes under a hash each saw as good.
  const part = `${dest}.${process.pid}-${randomBytes(4).toString('hex')}.part`;
  const hash = createHash('sha256');
  let n = 0;
  try {
    res.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      n += chunk.length;
      if (n > bytes) res.destroy(new Error(`model download is larger than the expected ${bytes} bytes: ${url}`));
      onBytes(n);
    });
    await pipeline(res, createWriteStream(part, { flags: 'wx' }));
    const got = hash.digest('hex');
    if (got !== sha) throw new Error(`model integrity check failed for ${url} (sha256 ${got})`);
    if ((await stat(part)).size !== bytes) throw new Error(`model download was not saved whole: ${url}`);
    await rename(part, dest);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
}
