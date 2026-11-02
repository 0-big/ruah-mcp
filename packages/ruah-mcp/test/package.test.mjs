// What gets published: the MCP Registry entry (server.json) must describe the npm package exactly —
// the registry checks the published package.json's mcpName against it, and a version bump must
// reach both files. The Claude Code plugin (plugin/) runs the package pinned to that same version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const json = async (f) => JSON.parse(await readFile(new URL(`../${f}`, import.meta.url), 'utf8'));

test('server.json matches package.json: name, package and version', async () => {
  const [pkg, srv] = await Promise.all([json('package.json'), json('server.json')]);
  assert.equal(srv.name, pkg.mcpName);
  assert.equal(srv.version, pkg.version);
  assert.deepEqual(srv.packages, [{ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } }]);
  assert.ok(srv.description.length <= 100, `registry description is ${srv.description.length} characters (max 100)`);
});

test('the plugin runs this exact version', async () => {
  const [pkg, plugin, mcp] = await Promise.all([json('package.json'), json('plugin/.claude-plugin/plugin.json'), json('plugin/.mcp.json')]);
  assert.equal(plugin.version, pkg.version);
  // the plugin directory rejects an unpinned npx launcher
  assert.deepEqual(mcp.mcpServers.ruah.args, ['-y', `${pkg.name}@${pkg.version}`]);
});
