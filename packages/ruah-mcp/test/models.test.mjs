// Model downloads (src/models.ts) against a local server: only whole, verified files reach the cache,
// even when two clients fetch the same model at once on first run.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BODY = randomBytes(400_000);
const SHA = createHash('sha256').update(BODY).digest('hex');
const spec = (id) => ({ id, files: { 'w.bin': [BODY.length, SHA] } });
let server, host, cache, ensureModel;

before(async () => {
  // Sent in slow pieces so that two clients' downloads overlap.
  server = http.createServer(async (req, res) => {
    const id = req.url.split('/')[1];
    const body = id === 'longer' ? Buffer.concat([BODY, randomBytes(1000)]) : id === 'altered' ? Buffer.from(BODY).fill(0, 0, 1) : BODY;
    res.writeHead(200);
    for (let i = 0; i < body.length; i += 50_000) {
      res.write(body.subarray(i, i + 50_000));
      await new Promise((r) => setTimeout(r, 20));
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  host = `http://127.0.0.1:${server.address().port}`;
  cache = await mkdtemp(join(tmpdir(), 'ruah-models-'));
  process.env.RUAH_MODEL_HOST = host;
  process.env.RUAH_CACHE_DIR = cache;
  ({ ensureModel } = await import('../src/models.ts'));
});

after(async () => {
  server.close();
  await rm(cache, { recursive: true, force: true });
});

const files = (id) => readdir(join(cache, id)).catch(() => []);

test('two clients fetching the same model at once leave one whole, verified file', async () => {
  const code = `const { ensureModel } = await import(${JSON.stringify(new URL('../src/models.ts', import.meta.url).href)}); await ensureModel(${JSON.stringify(spec('shared'))});`;
  const env = { ...process.env, RUAH_MODEL_HOST: host, RUAH_CACHE_DIR: cache };
  await Promise.all([1, 2].map(() => run(process.execPath, ['--input-type=module', '-e', code], { env })));
  assert.deepEqual(await files('shared'), ['w.bin']); // no .part left behind
  assert.equal(createHash('sha256').update(await readFile(join(cache, 'shared', 'w.bin'))).digest('hex'), SHA);
});

test('a download longer than the pinned size is stopped and never cached', async () => {
  await assert.rejects(ensureModel(spec('longer')), /larger than the expected 400000 bytes/);
  assert.deepEqual(await files('longer'), []);
});

test('a download with the wrong hash is never cached', async () => {
  await assert.rejects(ensureModel(spec('altered')), /integrity check failed/);
  assert.deepEqual(await files('altered'), []);
});
