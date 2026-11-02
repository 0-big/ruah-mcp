---
name: image-tools
description: Edit image files with Ruah — remove a background, compress or convert (WebP, AVIF, JPEG, PNG), resize, crop or rotate, upscale with AI, or strip EXIF and GPS metadata. Use when the user asks for any of these on an image file or a folder of images.
---

# Ruah image tools

This plugin's `ruah` MCP server runs every tool on this computer; images are never uploaded. Each tool's own description lists its options. This page covers what they don't: chaining tools, many files, and what to do when the tools are missing.

## Chaining tools

One file per call. Each call writes a new file next to its input (the original is never overwritten) and returns the new path — pass that path to the next tool. Common chains:

- Product photo or sticker: `remove_background`, then `compress` with format `webp` (keeps the transparency, far smaller than the PNG).
- Profile picture: `crop` with aspect_ratio `1:1`, then `resize` with max_side 400–800.
- Image for a web page: one `resize` call with max_side 1920 and format `webp` does both.

## Many files

List the files first, then call the tool once per file. At the end, report how many were done and the total size before and after, not one line per file. `remove_background` and `upscale` take seconds to minutes per image; say so before starting a large batch of them.

## When the ruah tools are missing

Local MCP servers don't run in Claude chat (claude.ai on the web, desktop or mobile), and they need Node.js 20 or newer.

- In chat: send the user to the same tool on ruah.tools, which also runs in the browser without uploading the image — [remove background](https://ruah.tools/remove-background/), [compress](https://ruah.tools/compress/), [convert](https://ruah.tools/convert/), [resize](https://ruah.tools/resize/), [crop](https://ruah.tools/crop/), [upscale](https://ruah.tools/upscale/), [remove metadata](https://ruah.tools/remove-metadata/). Korean pages are under `https://ruah.tools/ko/`.
- In Claude Code or Cowork: the server did not start. Check `node --version` (20 or newer) and that npm can reach the registry — the first start downloads the `ruah-mcp` package.
