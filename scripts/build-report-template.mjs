/**
 * build-report-template.mjs — regenerate packages/mcp/src/reportTemplate.ts
 * from the readable source packages/mcp/templates/report.html.
 *
 * The HTML report template is the final step of the review flow. Its inline JS
 * is full of backticks and ${} (the graph renderer uses template literals), so
 * we embed it as base64 — that survives bundling into mcp.cjs without escaping.
 *
 * Run after editing the template:  node scripts/build-report-template.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "packages/mcp/templates/report.html";
const OUT = "packages/mcp/src/reportTemplate.ts";

const html = readFileSync(SRC, "utf8");
const b64 = Buffer.from(html, "utf8").toString("base64");
const lines = (b64.match(/.{1,120}/g) ?? [])
  .map((l) => `  "${l}"`)
  .join(" +\n");

const out = `/**
 * reportTemplate.ts — the standalone HTML review report (GENERATED, do not hand-edit).
 *
 * Base64 of ${SRC} (the readable source of truth).
 * Embedded as base64 so the template — whose inline JS is full of backticks and
 * \${} — survives bundling into mcp.cjs without escaping. The \`report\` tool decodes
 * this and hands it to the agent as the final step of the review flow.
 *
 * Regenerate after editing the template:
 *   node scripts/build-report-template.mjs
 */
const REPORT_TEMPLATE_B64 =
${lines};

/** The standalone HTML report template, decoded. */
export const REPORT_TEMPLATE = Buffer.from(REPORT_TEMPLATE_B64, "base64").toString("utf8");
`;

writeFileSync(OUT, out);
console.log(`✓ ${OUT} regenerated from ${SRC} (${html.length} bytes → ${b64.length} b64 chars)`);
