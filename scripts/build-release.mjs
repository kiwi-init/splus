/**
 * build-release.mjs — bundle the CLI and the MCP server into two self-contained
 * JS files for the curl|sh installer / GitHub Release.
 *
 * Run AFTER `pnpm -r build` (it bundles the already-compiled dist entrypoints,
 * pulling in the workspace packages + npm deps). Output:
 *
 *   dist-release/cli.cjs   — the `splus` CLI            (run as: node cli.cjs …)
 *   dist-release/mcp.cjs   — the `splus-mcp` MCP server (run as: node mcp.cjs)
 *
 * Output uses the `.cjs` extension so a single dropped-in file always runs as
 * CommonJS under `node <file>`, regardless of any surrounding package.json
 * "type". Node built-ins stay external; every
 * npm dependency (commander, @modelcontextprotocol/sdk, zod, @anthropic-ai/sdk)
 * is bundled in. The optional LLM layer is pulled in via mcp's dynamic import,
 * so it ships in the bundle but only initializes when `review llm:true` is used.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist-release", { recursive: true });

/** @type {import("esbuild").BuildOptions} */
// Note: the compiled entrypoints already carry a `#!/usr/bin/env node` hashbang,
// which esbuild preserves on line 1 — so we do NOT add a banner (that would emit
// a second, invalid shebang on line 2).
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "info",
  legalComments: "none",
};

await build({
  ...common,
  entryPoints: ["packages/cli/dist/index.js"],
  outfile: "dist-release/cli.cjs",
});
await build({
  ...common,
  entryPoints: ["packages/mcp/dist/index.js"],
  outfile: "dist-release/mcp.cjs",
});

console.log("✓ dist-release/cli.cjs + dist-release/mcp.cjs");
