import { test } from "node:test";
import assert from "node:assert/strict";
import type { Report } from "@splus/shared";
import { triage, type LLMClient } from "./index.js";

function finding(id: string, file: string, ruleId: string): Report["findings"][number] {
  return {
    id,
    rule_id: ruleId,
    category: "security",
    severity: "high",
    tier: "must-fix",
    confidence: 0.9,
    file,
    region: { start_line: 3, start_col: 0, end_line: 3, end_col: 0 },
    title: "t",
    message: "m",
    anchor: { kind: "secret", detail: "x" },
    introduced: true,
    source: "secrets",
  };
}

const report: Report = {
  tool: "splus",
  version: "0.1.0",
  summary: {
    files_changed: 1,
    added_lines: 10,
    findings_total: 3,
    must_fix: 3,
    concern: 0,
    nit: 0,
    suppressed: 0,
    collectors_run: ["secrets"],
    adapters_absent: [],
    notes: [],
  },
  findings: [
    finding("f1", "src/a.ts", "secret.real"),
    finding("f2", "src/a.ts", "secret.fixture"),
    finding("f3", "src/a.ts", "secret.unknown"),
  ],
};

// Mock client: keeps f1, suppresses f2, omits f3 (to exercise fail-open).
function mockClient(): LLMClient {
  return {
    messages: {
      async create() {
        return {
          content: [
            {
              type: "tool_use",
              name: "submit_triage",
              input: {
                verdicts: [
                  { id: "f1", decision: "keep", confidence: 0.95, rationale: "real secret" },
                  { id: "f2", decision: "suppress", confidence: 0.2, rationale: "test fixture" },
                ],
              },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
        };
      },
    },
  };
}

test("splits keep/suppress and fails open on missing verdicts", async () => {
  const out = await triage(report, { root: "/nonexistent", client: mockClient() });

  assert.equal(out.findings.length, 2, "f1 kept + f3 fail-open kept");
  assert.equal(out.suppressed.length, 1, "f2 suppressed");

  const f1 = out.findings.find((f) => f.id === "f1");
  assert.equal(f1?.verdict, "keep");
  assert.equal(f1?.rationale, "real secret");

  const f3 = out.findings.find((f) => f.id === "f3");
  assert.equal(f3?.verdict, "keep", "no verdict → kept");
  assert.match(f3?.rationale ?? "", /no LLM verdict/);

  assert.equal(out.suppressed[0]?.id, "f2");
  assert.equal(out.summary.suppressed, 1);
  assert.equal(out.llm.triaged, 3);
  assert.equal(out.llm.inputTokens, 100);
  assert.equal(out.llm.cachedInputTokens, 80);
  assert.equal(out.llm.discovered, 0, "discovery off by default");
});

test("throws a clear error when no client and no API key", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(() => triage(report, { root: "." }), /Anthropic API key/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
