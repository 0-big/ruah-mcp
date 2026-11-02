// build.mjs has esbuild inline imported .wasm files as their bytes.
declare module '*.wasm' {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}
