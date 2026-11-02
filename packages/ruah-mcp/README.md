# ruah-mcp

Image tools for AI agents, as an [MCP](https://modelcontextprotocol.io) server. Background removal, compression, resizing, cropping, AI upscaling and metadata removal all run on your own computer. **Images never leave it.**

It is the engine of [ruah.tools](https://ruah.tools): the same models, encoders and settings, packaged for an agent to call.

## Tools

| Tool | What it does |
|---|---|
| `remove_background` | Cuts the main subject out of a photo and saves a transparent PNG (AI). |
| `compress` | Makes an image file smaller with little visible loss, or converts it: WebP, AVIF, JPEG, PNG. |
| `resize` | Changes the pixel dimensions, keeping proportions (by longest side or percent). |
| `crop` | Crops to an aspect ratio or exact region, rotates by quarter turns, flips. Pixels are moved, never resampled. |
| `upscale` | Enlarges 2× or 4× with AI super-resolution. Keeps transparency. |
| `strip_metadata` | Removes EXIF (GPS location, camera, date), XMP, IPTC, comments and embedded thumbnails. JPEG and PNG are cleaned without re-encoding. |

Files in, files out: every tool writes a new file next to the original (or to the path you give) and returns its path with a small preview. Existing files, the original included, are never overwritten. Images up to 12000×12000 pixels (144 MP) and 512 MB are accepted; `upscale` results are capped at 4096×4096.

## Install

Requires Node.js 20 or newer.

**Claude Code**

```sh
claude mcp add ruah -- npx -y ruah-mcp
```

**Any other MCP client** (Claude Desktop, Cursor, …): add this to its MCP server config.

```json
{
  "mcpServers": {
    "ruah": {
      "command": "npx",
      "args": ["-y", "ruah-mcp"]
    }
  }
}
```

Then ask your agent things like *"remove the background from ~/Desktop/shoe.jpg"* or *"convert these screenshots to WebP"*.

## What goes over the network

Only the AI model weights, once, from Ruah's model mirror (`models.ruah.tools`). Each file is checked against a SHA-256 hash pinned in this package before it is used, then kept in a local cache:

| Model | Used by | Size | When |
|---|---|---|---|
| BiRefNet lite (512²) | `remove_background` | 98 MB | Fetched in the background when the server first starts |
| BiRefNet (512²) | `remove_background` | 473 MB | Only if the lite model finds no subject |
| Swin2SR ×2 | `upscale` 2× | 8 MB | First 2× upscale |
| Swin2SR ×4 | `upscale` 4× | 55 MB | First 4× upscale |

Compression, resizing, cropping and metadata removal need no download at all.

The cache lives in `~/.cache/ruah/models` (or `$XDG_CACHE_HOME/ruah/models`). Set `RUAH_CACHE_DIR` to put it elsewhere.

## Platforms

- **macOS (Apple Silicon)**: tested. Upscaling runs on the GPU (WebGPU via Metal) and falls back to the CPU if that fails.
- **Linux, Windows**: upscaling runs on the CPU. The full test suite runs on both (x64) for every change; arm64 builds exist but are untested.
- **Intel Macs** are not supported: the ONNX runtime the AI tools run on ships no build for them.
- **HEIC** (iPhone photos) can be read on macOS only. HEVC is a patent-licensed codec and only macOS provides one here.

## Licenses

ruah-mcp is MIT licensed (see [LICENSE](LICENSE)). The models it downloads keep their own licenses:
[BiRefNet](https://github.com/ZhengPeng7/BiRefNet) (MIT) and [Swin2SR](https://github.com/mv-lab/swin2sr) (Apache-2.0).
Lossy PNG compression uses [libimagequant](https://github.com/ImageOptim/libimagequant) 2.4.1, its last
BSD-licensed release, compiled to WebAssembly and bundled in `dist/index.js`. Its notice is
`dist/LICENSE-libimagequant.txt`.
