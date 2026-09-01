/**
 * The version this server reports in the MCP `initialize` handshake.
 *
 * Kept as a literal rather than read from package.json: the CLI ships as a
 * `bun build --compile` binary, where package.json is not on disk next to
 * the code. release-please rewrites the annotated line on every release —
 * do not edit it by hand.
 */
export const VERSION = '1.5.0'; // x-release-please-version
