// Bundle the server (and the web's shared src/lib modules it imports) into one ESM file.
// npm packages stay external: they resolve from this package's node_modules at runtime, which is
// also where the codecs' wasm files are looked up.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});
