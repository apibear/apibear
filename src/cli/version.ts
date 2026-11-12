/**
 * Package version reported by `--version` and the MCP `initialize` handshake.
 *
 * Read from `package.json` at build time; esbuild inlines only this field, so
 * the bundle never reads `package.json` at runtime and cannot drift from it.
 */
import { version } from "../../package.json";

export const VERSION: string = version;
