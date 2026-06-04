import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("discovery reads the full changed surface, including files with no deterministic finding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "splus-triage-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  // A changed file the engine found NOTHING in — discovery must still read it.
  writeFileSync(join(dir, "src", "clean.ts"), "export function f(x) { return x.y.z; }\n");

  const discoveryPrompts: string[] = [];
  const client: LLMClient = {
    messages: {
      async create(body: Record<string, unknown>) {
        const b = body as { tool_choice?: { name?: string }; messages?: unknown };
        if (b.tool_choice?.name === "report_findings") {
          discoveryPrompts.push(JSON.stringify(b.messages));
          return { content: [{ type: "tool_use", name: "report_findings", input: { findings: [] } }] };
        }
        return { content: [{ type: "tool_use", name: "submit_triage", input: { verdicts: [] } }] };
      },
    },
  };

  const rep: Report = { ...report, findings: [finding("f1", "src/a.ts", "secret.real")] };
  await triage(rep, { root: dir, client, thorough: true, changedFiles: ["src/a.ts", "src/clean.ts"] });

  assert.equal(discoveryPrompts.length, 1, "discovery ran once");
  assert.match(
    discoveryPrompts[0] ?? "",
    /src\/clean\.ts/,
    "discovery must deep-read the changed file that had no finding",
  );
});

test("without changedFiles, discovery degrades to files-with-findings and says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "splus-triage-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");

  const client: LLMClient = {
    messages: {
      async create(body: Record<string, unknown>) {
        const b = body as { tool_choice?: { name?: string } };
        if (b.tool_choice?.name === "report_findings") {
          return { content: [{ type: "tool_use", name: "report_findings", input: { findings: [] } }] };
        }
        return { content: [{ type: "tool_use", name: "submit_triage", input: { verdicts: [] } }] };
      },
    },
  };

  const rep: Report = { ...report, findings: [finding("f1", "src/a.ts", "secret.real")] };
  const out = await triage(rep, { root: dir, client, thorough: true });
  assert.ok(
    out.summary.notes.some((n) => /files-with-findings only/.test(n)),
    "the degraded scope must be disclosed in notes",
  );
});

test("VERIFY drops refuted discoveries, keeps confirmed ones, never touches engine findings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "splus-triage-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "line1\nline2\nline3\nline4\nline5\nline6\n");

  const client: LLMClient = {
    messages: {
      async create(body: Record<string, unknown>) {
        const b = body as { tool_choice?: { name?: string }; messages?: Array<{ content: string }> };
        const name = b.tool_choice?.name;
        if (name === "report_findings") {
          return {
            content: [{ type: "tool_use", name: "report_findings", input: { findings: [
              { file: "src/a.ts", line: 3, title: "refute-me", severity: "high", category: "security", rationale: "claimed sink", confidence: 0.8 },
              { file: "src/a.ts", line: 5, title: "keep-me", severity: "high", category: "correctness", rationale: "real off-by-one", confidence: 0.8 },
            ] } }],
          };
        }
        if (name === "submit_verifications") {
          // Parse candidate ids + titles from the prompt; refute "refute-me".
          const prompt = b.messages?.[0]?.content ?? "";
          const verifications: Array<{ id: string; verified: boolean; confidence: number; reason: string }> = [];
          const re = /--- candidate (\S+) ---\nclaim \([^)]*\): (.+)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(prompt))) {
            const refute = m[2]!.includes("refute-me");
            verifications.push({ id: m[1]!, verified: !refute, confidence: refute ? 0.1 : 0.9, reason: refute ? "not demonstrated" : "confirmed" });
          }
          return { content: [{ type: "tool_use", name: "submit_verifications", input: { verifications } }] };
        }
        // triage: keep the engine finding
        return { content: [{ type: "tool_use", name: "submit_triage", input: { verdicts: [
          { id: "f1", decision: "keep", confidence: 0.95, rationale: "real secret" },
        ] } }] };
      },
    },
  };

  const rep: Report = { ...report, findings: [finding("f1", "src/a.ts", "secret.real")] };
  const out = await triage(rep, { root: dir, client, thorough: true, verify: true, changedFiles: ["src/a.ts"] });

  assert.equal(out.llm.discovered, 2, "two findings discovered");
  assert.equal(out.llm.refuted, 1, "one discovery refuted by verify");
  assert.equal(out.llm.verified, 1, "one discovery survived verify");
  assert.ok(out.findings.some((f) => f.title === "keep-me"), "confirmed discovery kept");
  assert.ok(!out.findings.some((f) => f.title === "refute-me"), "refuted discovery dropped");
  assert.ok(out.findings.some((f) => f.id === "f1"), "grounded engine finding untouched by verify");
  const refuted = out.suppressed.find((f) => f.title === "refute-me");
  assert.match(refuted?.rationale ?? "", /failed verification/);
});

test("signal budget caps low/medium discoveries per file to the most-confident few", async () => {
  const dir = mkdtempSync(join(tmpdir(), "splus-triage-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n") + "\n");

  // Five low-severity discoveries on ONE file — an over-firing pass. Verify
  // affirms all (so the cut is the budget, not verification). Only the 3
  // most-confident may surface; the other 2 are demoted, not deleted.
  const confidences: Record<number, number> = { 1: 0.9, 2: 0.5, 3: 0.8, 4: 0.6, 5: 0.7 };
  const client: LLMClient = {
    messages: {
      async create(body: Record<string, unknown>) {
        const b = body as { tool_choice?: { name?: string }; messages?: Array<{ content: string }> };
        const name = b.tool_choice?.name;
        if (name === "report_findings") {
          return { content: [{ type: "tool_use", name: "report_findings", input: { findings:
            Object.entries(confidences).map(([line, c]) => ({
              file: "src/a.ts", line: Number(line), title: `nit-${line}`, severity: "low",
              category: "correctness", rationale: "minor", confidence: c,
            })),
          } }] };
        }
        if (name === "submit_verifications") {
          const prompt = b.messages?.[0]?.content ?? "";
          const verifications: Array<{ id: string; verified: boolean; confidence: number; reason: string }> = [];
          const re = /--- candidate (\S+) ---/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(prompt))) verifications.push({ id: m[1]!, verified: true, confidence: 0.9, reason: "ok" });
          return { content: [{ type: "tool_use", name: "submit_verifications", input: { verifications } }] };
        }
        return { content: [{ type: "tool_use", name: "submit_triage", input: { verdicts: [] } }] };
      },
    },
  };

  const rep: Report = { ...report, findings: [] };
  const out = await triage(rep, { root: dir, client, thorough: true, verify: true, changedFiles: ["src/a.ts"] });

  assert.equal(out.llm.discovered, 5, "five discovered");
  assert.equal(out.llm.budgeted, 2, "two demoted by the per-file budget");
  assert.equal(out.findings.length, 3, "only the 3 most-confident surface");
  const surfaced = out.findings.map((f) => f.title).sort();
  assert.deepEqual(surfaced, ["nit-1", "nit-3", "nit-5"], "kept the top-3 by confidence (0.9/0.8/0.7)");
  const demoted = out.suppressed.filter((f) => /signal budget/.test(f.rationale ?? ""));
  assert.equal(demoted.length, 2, "demoted ones are visible in suppressed, not deleted");
});

test("verify is fail-closed for low-severity speculation, fail-open for medium+", async () => {
  const dir = mkdtempSync(join(tmpdir(), "splus-triage-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join("\n") + "\n");

  // Verify returns NO verdict for any candidate (empty). A low-severity claim
  // must be dropped (burden of proof); a medium claim must survive (fail-open).
  const client: LLMClient = {
    messages: {
      async create(body: Record<string, unknown>) {
        const b = body as { tool_choice?: { name?: string } };
        const name = b.tool_choice?.name;
        if (name === "report_findings") {
          return { content: [{ type: "tool_use", name: "report_findings", input: { findings: [
            { file: "src/a.ts", line: 2, title: "low-speculation", severity: "low", category: "correctness", rationale: "maybe", confidence: 0.7 },
            { file: "src/a.ts", line: 4, title: "mid-claim", severity: "medium", category: "correctness", rationale: "likely", confidence: 0.7 },
          ] } }] };
        }
        if (name === "submit_verifications") {
          return { content: [{ type: "tool_use", name: "submit_verifications", input: { verifications: [] } }] };
        }
        return { content: [{ type: "tool_use", name: "submit_triage", input: { verdicts: [] } }] };
      },
    },
  };

  const rep: Report = { ...report, findings: [] };
  const out = await triage(rep, { root: dir, client, thorough: true, verify: true, changedFiles: ["src/a.ts"] });

  assert.ok(!out.findings.some((f) => f.title === "low-speculation"), "unverified low-severity dropped");
  assert.ok(out.findings.some((f) => f.title === "mid-claim"), "unverified medium survives (fail-open)");
  const dropped = out.suppressed.find((f) => f.title === "low-speculation");
  assert.match(dropped?.rationale ?? "", /unverified low-severity/);
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
