import './stdout-guard.ts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';
import { ensureModel, MODELS } from './models.ts';

await createServer().connect(new StdioServerTransport());

// Fetch the default model in the background on first install, so the first background removal
// doesn't wait on the download. A no-op once it's cached; a failure here just retries on use.
ensureModel(MODELS.lite).catch((e) => console.error(`[ruah] model prefetch failed: ${e.message}`));
