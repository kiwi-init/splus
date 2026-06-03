/**
 * build-release.mjs — bundle the MCP server into a self-contained JS file for
 * the curl|sh installer / GitHub Release.
 *
 * Run AFTER `pnpm -r build` (it bundles the already-compiled dist entrypoint,
 * pulling in the workspace packages + npm deps). Output:
 *
 *   dist-release/mcp.cjs   — the `splus-mcp` MCP server (run as: node mcp.cjs)
 *
 * Output uses the `.cjs` extension so a single dropped-in file always runs as
 * CommonJS under `node <file>`, regardless of any surrounding package.json
 * "type". Node built-ins stay external; every npm dependency
 * (@modelcontextprotocol/sdk, zod, @anthropic-ai/sdk) is bundled in. The
 * optional LLM layer is pulled in via mcp's dynamic import, so it ships in the
 * bundle but only initializes when `review llm:true` is used.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";

mkdirSync("dist-release", { recursive: true });

// Single source of truth for the MCP server's reported version: its package.json.
const { version } = JSON.parse(readFileSync("packages/mcp/package.json", "utf8"));

// Note: the compiled entrypoint already carries a `#!/usr/bin/env node` hashbang,
// which esbuild preserves on line 1 — so we do NOT add a banner (that would emit
// a second, invalid shebang on line 2).
await build({
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "info",
  legalComments: "none",
  define: { __SPLUS_VERSION__: JSON.stringify(version) },
  entryPoints: ["packages/mcp/dist/index.js"],
  outfile: "dist-release/mcp.cjs",
});

console.log("✓ dist-release/mcp.cjs");
