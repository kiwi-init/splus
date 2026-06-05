/**
 * claude-cli.ts — an LLMClient backed by the local `claude -p` CLI instead of the
 * Anthropic API. Uses this machine's existing Claude auth (no ANTHROPIC_API_KEY),
 * which is what lets the benchmark run the real triage pipeline headlessly.
 *
 * The triage pipeline asks for forced tool-use; `claude -p` doesn't expose the
 * tool-use API, so we fold the tool's JSON Schema into the prompt and parse the
 * model's JSON back into the same `{ tool_use, input }` shape the pipeline expects.
 */
import { execFileSync } from "node:child_process";
import type { LLMClient } from "./index.js";

/** Map a full model id (claude-haiku-4-5 …) to a `claude --model` alias. */
function modelAlias(m?: string): string {
  if (!m) return "sonnet";
  if (/haiku/.test(m)) return "haiku";
  if (/opus/.test(m)) return "opus";
  if (/sonnet/.test(m)) return "sonnet";
  return m;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : ((b as { text?: string })?.text ?? ""))).join("\n");
  }
  return "";
}

function parseJsonLoose(s: string): unknown {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? s).trim();
  try {
    return JSON.parse(body);
  } catch {
    const i = body.indexOf("{");
    const j = body.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(body.slice(i, j + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

export function createClaudeCliClient(opts?: { defaultModel?: string }): LLMClient {
  return {
    messages: {
      async create(body: Record<string, unknown>) {
        const b = body as {
          system?: unknown;
          messages?: Array<{ content: unknown }>;
          tools?: Array<{ name: string; input_schema: unknown }>;
          model?: string;
        };
        const sys = textOf(b.system);
        const user = (b.messages ?? []).map((m) => textOf(m.content)).join("\n\n");
        const tool = b.tools?.[0];
        let prompt = (sys ? sys + "\n\n" : "") + user;
        if (tool) {
          prompt +=
            `\n\n---\nRespond with ONLY a single JSON object that is a valid input for the "${tool.name}" tool, ` +
            `matching this JSON Schema exactly. No prose, no markdown fences:\n${JSON.stringify(tool.input_schema)}`;
        }
        const model = modelAlias(b.model ?? opts?.defaultModel);
        let out: string;
        try {
          out = execFileSync("claude", ["-p", "--output-format", "json", "--model", model], {
            input: prompt,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
          });
        } catch (e) {
          // claude CLI failed (rate limit, auth, crash). THROW rather than fail
          // open — for the benchmark this lets the caller skip + retry the PR
          // instead of recording a garbage 0-score result when limits explode.
          const err = e as Error & { stderr?: string; stdout?: string };
          const detail = [err.message, err.stderr, err.stdout].filter(Boolean).join(" · ");
          throw new Error(`claude -p failed: ${detail.slice(0, 600)}`);
        }
        const res = JSON.parse(out) as { result?: string; is_error?: boolean; usage?: Record<string, number> };
        const text = res.result ?? "";
        if (res.is_error) throw new Error(`claude -p errored: ${text.slice(0, 300)}`);
        const parsed = tool ? parseJsonLoose(text) : null;
        // The pipeline always forces tool choice, so a reply without parseable tool
        // JSON is an error — throw (fail closed) rather than hand back a text block
        // the caller would read as "zero findings" and record as a real score.
        if (tool && !parsed) {
          throw new Error(`claude -p returned unparseable "${tool.name}" input: ${text.slice(0, 300)}`);
        }
        return {
          content:
            tool && parsed ? [{ type: "tool_use", name: tool.name, input: parsed }] : [{ type: "text", text }],
          usage: {
            input_tokens: res.usage?.input_tokens ?? 0,
            output_tokens: res.usage?.output_tokens ?? 0,
            cache_read_input_tokens: res.usage?.cache_read_input_tokens ?? 0,
          },
        };
      },
    },
  };
}
