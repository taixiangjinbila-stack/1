#!/usr/bin/env node

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testDirectory, "..");
const require = createRequire(import.meta.url);
const { build } = require(
  path.join(pluginRoot, "mcp-server", "node_modules", "esbuild"),
);

await build({
  entryPoints: [
    path.join(
      pluginRoot,
      "skills",
      "project-capsule-orchestrator",
      "scripts",
      "validate-thread-plan.mts",
    ),
  ],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: path.join(
    pluginRoot,
    "skills",
    "project-capsule-orchestrator",
    "scripts",
    "validate-thread-plan.mjs",
  ),
});

await build({
  entryPoints: [path.join(pluginRoot, "mcp-server", "src", "server.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: path.join(pluginRoot, "mcp-server", "dist", "server.js"),
});

await build({
  entryPoints: [
    path.join(
      pluginRoot,
      "mcp-server",
      "src",
      "diagnose_app_server_launch.ts",
    ),
  ],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: path.join(
    pluginRoot,
    "mcp-server",
    "dist",
    "diagnose_app_server_launch.js",
  ),
});

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      skill_validator: path.join(
        pluginRoot,
        "skills",
        "project-capsule-orchestrator",
        "scripts",
        "validate-thread-plan.mjs",
      ),
      mcp_server: path.join(pluginRoot, "mcp-server", "dist", "server.js"),
      app_server_diagnostic: path.join(
        pluginRoot,
        "mcp-server",
        "dist",
        "diagnose_app_server_launch.js",
      ),
    },
    null,
    2,
  )}\n`,
);
