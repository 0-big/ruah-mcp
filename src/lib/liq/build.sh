#!/bin/sh
# Builds liq.wasm and liq-simd.wasm from quantise.c and libimagequant 2.4.1 — the last BSD-2-Clause
# release (2.5.0 onward is GPL-3.0) and the version sharp still ships. Emscripten runs in docker, so
# nothing is installed on the host. The outputs are committed, and SHA256SUMS says what they must be:
# anyone can rebuild and compare. After changing quantise.c or the compiler on purpose, update it
# (shasum -a 256 liq.wasm liq-simd.wasm > SHA256SUMS).
#
#   sh src/lib/liq/build.sh
#
# Flags are libimagequant's own defaults (configure) without SSE, which needs x86 cpuid.
# --stack-first puts the 64 KiB stack below the data, so an overflow traps at once instead of
# writing over the data first.
# liq-simd.wasm is the same code auto-vectorised (~15–40% faster); browsers without wasm SIMD
# get liq.wasm. Both give identical pixels (test/quantise.test.mjs in packages/ruah-mcp).
set -eu
cd "$(dirname "$0")"

TAG=2.4.1
TARBALL_SHA256=f9006a821547d8e4d1b5366a4ef265673a2949aa1414a096b5c45bfcd4c94d8a
IMAGE=emscripten/emsdk:6.0.12@sha256:77638e6c215a65f25a704c0c831d5c2463a8c0468a58c6cb82489dbe621dfa05

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -sSfL -o "$work/liq.tar.gz" "https://github.com/ImageOptim/libimagequant/archive/refs/tags/$TAG.tar.gz"
echo "$TARBALL_SHA256  $work/liq.tar.gz" | shasum -a 256 -c -
tar xzf "$work/liq.tar.gz" -C "$work"
cmp "$work/libimagequant-$TAG/COPYRIGHT" LICENSE # LICENSE is that release's own notice, verbatim

# Only the empty output folder is writable from the container.
mkdir "$work/out"
docker run --rm -v "$work/libimagequant-$TAG:/src:ro" -v "$PWD:/liq:ro" -v "$work/out:/out" "$IMAGE" sh -c '
  set -eu
  cd /src
  flags="-O3 -fno-math-errno -funroll-loops -std=c99 -DNDEBUG -I/src
    blur.c libimagequant.c mediancut.c mempool.c nearest.c pam.c viter.c /liq/quantise.c
    --no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH -sFILESYSTEM=0 -Wl,--stack-first
    -sEXPORTED_FUNCTIONS=_quantise,_liq_alloc,_liq_dealloc"
  emcc $flags -o /out/liq.wasm
  emcc $flags -msimd128 -o /out/liq-simd.wasm
'
# Check before replacing the committed files, so a different build never overwrites them.
here=$(pwd)
if ! (cd "$work/out" && shasum -a 256 -c "$here/SHA256SUMS"); then
  echo "Not the recorded build. If quantise.c or the compiler changed on purpose, put these in SHA256SUMS and run again:" >&2
  (cd "$work/out" && shasum -a 256 liq.wasm liq-simd.wasm) >&2
  exit 1
fi
cp "$work/out/liq.wasm" "$work/out/liq-simd.wasm" .
chmod 644 liq.wasm liq-simd.wasm
