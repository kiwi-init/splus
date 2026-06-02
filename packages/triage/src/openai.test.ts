import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIClient } from "./openai.js";

/**
 * Stub of the OpenAI SDK surface createOpenAIClient touches: it captures the
 * outgoing params (to assert the Anthropic->OpenAI translation) and returns a
 * function-call completion (to assert the OpenAI->LLMResponse translation).
 */
function stubSdk() {
  const calls: Array<Record<string, unknown>> = [];
  const sdk = {
    chat: {
      completions: {
        async create(params: Record<string, unknown>) {
          calls.push(params);
          return {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "submit_triage",
                        arguments: JSON.stringify({
                          verdicts: [{ id: "f1", decision: "keep", confidence: 0.9, rationale: "real" }],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 30,
              prompt_tokens_details: { cached_tokens: 90 },
            },
          };
        },
      },
    },
  };
  return { sdk, calls };
}

test("translates Anthropic-shaped body to OpenAI and back", async () => {
  const { sdk, calls } = stubSdk();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createOpenAIClient({ sdk: sdk as any, model: "gpt-5.5", reasoning: "medium" });

  const res = await client.messages.create({
    model: "ignored-anthropic-model",
    max_tokens: 2048,
    system: [{ type: "text", text: "RUBRIC", cache_control: { type: "ephemeral" } }],
    tools: [
      {
        name: "submit_triage",
        description: "d",
        input_schema: { type: "object", properties: { verdicts: { type: "array" } }, required: ["verdicts"] },
      },
    ],
    tool_choice: { type: "tool", name: "submit_triage" },
    messages: [{ role: "user", content: "File: a.ts" }],
  });

  // Outgoing translation.
  const sent = calls[0]!;
  assert.equal(sent.model, "gpt-5.5", "env/opt model wins, not the anthropic model in the body");
  assert.equal(sent.reasoning_effort, "medium");
  assert.equal(sent.max_completion_tokens, 2048);
  const msgs = sent.messages as Array<{ role: string; content: string }>;
  assert.equal(msgs[0]?.role, "system");
  assert.equal(msgs[0]?.content, "RUBRIC", "system text block flattened to a system message");
  assert.equal(msgs[1]?.role, "user");
  const tools = sent.tools as Array<{ type: string; function: { name: string; parameters: unknown } }>;
  assert.equal(tools[0]?.type, "function");
  assert.equal(tools[0]?.function.name, "submit_triage");
  assert.ok(tools[0]?.function.parameters, "input_schema mapped to function.parameters");
  assert.deepEqual(sent.tool_choice, { type: "function", function: { name: "submit_triage" } });

  // Return translation: parseTool() (in index.ts) reads a tool_use block.
  const block = res.content.find((b) => b.type === "tool_use");
  assert.equal(block?.name, "submit_triage");
  assert.deepEqual(block?.input, {
    verdicts: [{ id: "f1", decision: "keep", confidence: 0.9, rationale: "real" }],
  });
  assert.equal(res.usage?.input_tokens, 120);
  assert.equal(res.usage?.output_tokens, 30);
  assert.equal(res.usage?.cache_read_input_tokens, 90, "cached prompt tokens -> cache_read_input_tokens");
});

test("malformed tool arguments degrade to empty input (fail-open at the caller)", async () => {
  const sdk = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: "c", type: "function", function: { name: "submit_triage", arguments: "{not json" } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createOpenAIClient({ sdk: sdk as any });
  const res = await client.messages.create({ messages: [{ role: "user", content: "x" }] });
  const block = res.content.find((b) => b.type === "tool_use");
  assert.deepEqual(block?.input, {}, "unparseable args -> {} so parseTool returns an empty object, not a throw");
});
