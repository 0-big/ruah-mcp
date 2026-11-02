// Small-subject cut-out check — the ruler for the close pass in src/lib/matte.ts (focusRegion).
//
// Runs remove_background through the built server (dist/index.js, the way an agent calls it) on
// public photos whose subject is a small share of the frame, and reports for each: seconds, whether
// the full model was needed, and edge fit — the share of the cut-out's outline that lies on a real
// edge of the photo. A 512² matte stretched over a large photo draws a blocky outline that cuts
// through flat background (and fills gaps such as the space between legs), so its edge fit drops.
//
//   npm run build && RUAH_CACHE_DIR=<models> node scripts/small-subjects.mjs
//
// Exit 0: every photo meets its expectation. 1: one doesn't — the problem is back. 2: couldn't run.
// Photos (Wikimedia Commons originals, pinned by SHA-256) download once to RUAH_FIXTURE_DIR
// (default ~/.cache/ruah/fixtures); about 38 MB.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const COMMONS = 'https://upload.wikimedia.org/wikipedia/commons/';
// expect.full: false = must not need the full model. expect.edge: minimum edge fit.
// Before the close pass (2026-11-01, same photos): field 0.71 · dog in sand 0.96, full model · wet dog 0.98.
const PHOTOS = [
  {
    name: 'field', // person far off in a field, ~0.1% — lite sees nothing, the full model finds them
    file: '1/12/Alone_In_The_Field_%28Unsplash%29.jpg', // CC0, Yaoqi LAI
    sha256: 'bf0d2a30b7761eaa956a1a0e67a94523672f8eb13c19d573761e49c3d6c2b68d',
    expect: { edge: 0.85 },
  },
  {
    name: 'dog-sand', // running dog, ~4%
    file: '6/6d/Running_dog_at_the_beach.jpg', // CC BY-SA 3.0, JurgenNL
    sha256: 'db52306482e977bf30afab854e0fc04e5c1cd2d4dc7f6e8a1bca6219e95765f5',
    expect: { full: false, edge: 0.97 },
  },
  {
    name: 'dog-wet', // dog on wet sand, ~6%
    file: 'e/e3/A_dog_running_on_the_beach.jpg', // CC BY-SA 4.0, Bruce Emmerling
    sha256: 'c304346c0367e4242daac0452a6d710af322ed8cdba52ccc8287b80e351bbd58',
    expect: { full: false, edge: 0.99 },
  },
  {
    name: 'cyclist', // ~1% — lite misses this rider at any framing; the full model takes the close pass
    file: '2/29/Yeovil_%2C_Cyclist_on_a_Country_Road_-_geograph.org.uk_-_2851932.jpg', // CC BY-SA 2.0, Lewis Clarke
    sha256: '34105ea8811c5e1fac3892f623a68aba78f228ff8fd258c21431798d51eab662',
    expect: {},
  },
  {
    name: 'canyon', // person on a canyon rim — known limit: the full model also keeps the river, so no close pass
    file: 'e/e4/Person_standing_on_top_of_canyon_wall_overlooking_river_%2837479945821%29.jpg', // public domain, BLM Utah
    sha256: '211ad7ce50936293aa564e004b705ce1c67bdb79206c2c2e257ed900e8c81216',
    expect: {},
  },
  {
    name: 'tree', // control: a large subject (a tree, ~10%) takes the one-pass path
    file: '3/38/Misty_winter_morning_in_Meherpur_District%2C_Bangladesh_-_lone_tree_and_person_in_paddy_field.jpg', // CC BY 4.0, Ashikul Islam Anik
    sha256: '79c3ea4b3ec1baa54e1a3d3152c8b58e9c66b77c077344f3424341326a7c4538',
    expect: { full: false, edge: 0.98 },
  },
];

const server = new URL('../dist/index.js', import.meta.url).pathname;
if (!existsSync(server)) {
  console.error('dist/index.js is missing — run `npm run build` first.');
  process.exit(2);
}
const fixtures = process.env.RUAH_FIXTURE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ruah', 'fixtures');
await mkdir(fixtures, { recursive: true });

async function photo({ name, file, sha256 }) {
  const path = join(fixtures, `${name}.jpg`);
  const sum = (b) => createHash('sha256').update(b).digest('hex');
  if (existsSync(path) && sum(await readFile(path)) === sha256) return path;
  const res = await fetch(COMMONS + file, { headers: { 'user-agent': 'ruah-mcp small-subject check (https://ruah.tools)' } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${file}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (sum(body) !== sha256) throw new Error(`checksum mismatch for ${file}`);
  await writeFile(path, body);
  return path;
}

/** Share of the cut-out's outline pixels whose 3×3 neighbourhood holds a strong edge of the photo. */
function edgeFit(px, cut, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (cut[(y * w + x) * 4 + 3] >= 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return 0;
  // "Strong" = top 20% of gradient strength around the subject (its box plus 10%).
  const mx = Math.round((x1 - x0) * 0.1), my = Math.round((y1 - y0) * 0.1);
  const X0 = Math.max(1, x0 - mx), Y0 = Math.max(1, y0 - my), X1 = Math.min(w - 1, x1 + mx), Y1 = Math.min(h - 1, y1 + my);
  const L = (x, y) => {
    const i = (y * w + x) * 4;
    return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  };
  const G = new Float32Array(w * h);
  const all = new Float32Array((X1 - X0) * (Y1 - Y0));
  let k = 0;
  for (let y = Y0; y < Y1; y++)
    for (let x = X0; x < X1; x++) {
      const gx = L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1);
      const gy = L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1);
      all[k++] = G[y * w + x] = Math.hypot(gx, gy);
    }
  const strong = all.sort()[Math.floor(all.length * 0.8)];
  const kept = (x, y) => cut[(y * w + x) * 4 + 3] >= 128;
  let outline = 0, onEdge = 0;
  for (let y = Y0 + 1; y < Y1 - 1; y++)
    for (let x = X0 + 1; x < X1 - 1; x++) {
      if (!kept(x, y) || (kept(x - 1, y) && kept(x + 1, y) && kept(x, y - 1) && kept(x, y + 1))) continue;
      outline++;
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m = Math.max(m, G[(y + dy) * w + x + dx]);
      if (m >= strong) onEdge++;
    }
  return outline ? onEdge / outline : 0;
}

const raw = async (path) => {
  const { data, info } = await sharp(path).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
};

let paths;
try {
  paths = await Promise.all(PHOTOS.map(photo));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const out = await mkdtemp(join(tmpdir(), 'ruah-small-'));
const client = new Client({ name: 'ruah-small-subjects', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env }, stderr: 'ignore' }));
let open = 0;
try {
  for (const [i, p] of PHOTOS.entries()) {
    const cutPath = join(out, `${p.name}.png`);
    const t0 = performance.now();
    const r = await client.callTool({ name: 'remove_background', arguments: { input_path: paths[i], output_path: cutPath } }, undefined, { timeout: 900_000 });
    const sec = (performance.now() - t0) / 1000;
    const text = r.content.find((c) => c.type === 'text')?.text ?? '';
    if (r.isError) throw new Error(`${p.name}: ${text}`);
    const kept = Number(text.match(/Subject kept: ([\d.]+)%/)?.[1]);
    const full = text.includes('recovered with the full model');
    const [src, cut] = await Promise.all([raw(paths[i]), raw(cutPath)]);
    const edge = edgeFit(src.data, cut.data, src.w, src.h);
    const misses = [];
    if (p.expect.full === false && full) misses.push('needed the full model');
    if (p.expect.edge !== undefined && edge < p.expect.edge) misses.push(`edge fit < ${p.expect.edge}`);
    if (misses.length) open++;
    const verdict = !Object.keys(p.expect).length ? 'report only' : misses.length ? `OPEN: ${misses.join(', ')}` : 'ok';
    console.log(`${p.name.padEnd(9)} ${String(kept).padStart(5)}% kept  ${sec.toFixed(1).padStart(5)} s  full model: ${full ? 'yes' : 'no '}  edge fit ${edge.toFixed(3)}  ${verdict}`);
  }
} finally {
  await client.close();
  await rm(out, { recursive: true, force: true });
}
console.log(open ? `${open} photo(s) fall short — small subjects still cut out badly.` : 'All photos meet their expectations.');
process.exit(open ? 1 : 0);
