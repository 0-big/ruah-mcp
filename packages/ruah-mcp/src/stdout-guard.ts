// stdout is the MCP channel: a stray console.log from any dependency would corrupt the protocol.
// Imported first by index.ts so every later module's logging goes to stderr.
console.log = console.info = console.debug = console.error;
