# Ruah plugin

Image tools for Claude that run on your own computer: background removal, compression and format conversion (WebP, AVIF, JPEG, PNG), resizing, cropping, 2× and 4× AI upscaling, and metadata removal. Images are never uploaded. It is the engine of [ruah.tools](https://ruah.tools), packaged as the [`ruah-mcp`](https://www.npmjs.com/package/ruah-mcp) MCP server plus a short skill on chaining the tools.

## Install

```sh
claude plugin marketplace add 0-big/ruah-mcp
claude plugin install ruah@ruah-tools
```

Requires Node.js 20 or newer.

## Where it works

- **Claude Code** (terminal, IDE, the desktop app's Code tab) and **Cowork** sessions on your computer run the tools.
- **Claude chat** (claude.ai on the web, desktop or mobile) doesn't run local MCP servers, so only the skill loads there. It points to the same tools on ruah.tools, which run in the browser.

## What it runs

The plugin starts one local MCP server, `npx -y ruah-mcp@<version>`, at the exact version pinned in `.mcp.json`. Its source is [packages/ruah-mcp](https://github.com/0-big/ruah-mcp/tree/main/packages/ruah-mcp) in this repository.

## What goes over the network

- **npm**: `npx` downloads the `ruah-mcp` package and its dependencies from the npm registry on first start. `.mcp.json` sets `ONNXRUNTIME_NODE_INSTALL=skip`, so on Linux x64 the AI runtime (`onnxruntime-node`) doesn't also fetch its CUDA and TensorRT files (about 260 MB, never used here) from NuGet.
- **Model weights** from `models.ruah.tools`, each checked against a SHA-256 hash pinned in the package and kept in `~/.cache/ruah/models` (`RUAH_CACHE_DIR` moves it): the 98 MB background-removal model in the background when the server first starts, a 473 MB model only if that one finds no subject, and 8 MB or 55 MB for the first 2× or 4× upscale.

Nothing else: no images, file names or usage data are sent anywhere. Every tool writes a new file next to its input and never overwrites an existing file.

## License

MIT. The models keep their own licenses: [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) (MIT) and [Swin2SR](https://github.com/mv-lab/swin2sr) (Apache-2.0).
