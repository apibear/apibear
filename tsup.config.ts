import { rmSync } from "node:fs";

import { defineConfig } from "tsup";

// Both builds write to dist/, so clean once up front instead of letting each
// config's `clean` wipe the other's output.
rmSync("dist", { recursive: true, force: true });

export default defineConfig([
  {
    // Library: `import { parseOpenApiToTools } from "apibear"`.
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    target: "es2022",
    dts: true,
    sourcemap: true,
    treeshake: true,
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  {
    // CLI: the `apibear` bin. The core is bundled in; npm deps stay external.
    entry: { cli: "src/cli/cli.ts" },
    format: ["esm"],
    target: "node18",
    sourcemap: true,
    dts: false,
  },
]);
