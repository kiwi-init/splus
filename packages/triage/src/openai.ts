/**
 * OpenAI adapter for the provider-agnostic LLMClient.
 *
 * The hosted GitHub bot judges with OpenAI GPT-5.5 (medium reasoning), but the
 * triage/discovery logic in index.ts speaks an Anthropic-shaped dialect: a
 * `system` array of text blocks, `tools[].input_schema`, a forced
 * `tool_choice {type:'tool', name}`, string-content user messages, and a
 * response read via a `tool_use` content block. This file translates that
 * dialect to OpenAI's chat.completions API and back, so index.ts (and the
 * Anthropic/local path) stay UNCHANGED.
 *
 * Only the single forced-tool case is exercised by Splus (submit_triage and
 * report_findings), so we map exactly that: one function tool, forced, args
 * returned as the `input` of a synthetic `tool_use` block.
 */
import OpenAI from "openai";
import type { LLMClient } from "./index.js";

export interface OpenAIClientOptions {
  apiKey?: string;
  /** Model id — env-configurable so a future GPT-5.x is a one-line change. */
  model?: string;
  /** Reasoning effort for reasoning models: minimal|low|medium|high. */
  reasoning?: string;
  /** Inject a preconstructed SDK (tests). */
  sdk?: OpenAI;
}

/** Anthropic-shaped request body, as constructed by index.ts. */
interface AnthropicBody {
  model?: string;
  max_tokens?: number;
  system?: Array<{ type: string; text: string; cache_control?: unknown }> | string;
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: string; name?: string };
  messages: Array<{ role: string; content: unknown }>;
}

/**
 * Return an LLMClient backed by OpenAI. `model` and `reasoning` fall back to
 * SPLUS_LLM_MODEL / SPLUS_LLM_REASONING so the deployment can re-point the
 * judge without a code change (e.g. gpt-5.5 -> gpt-6).
 */
export function createOpenAIClient(opts: OpenAIClientOptions = {}): LLMClient {
  const sdk =
    opts.sdk ?? new OpenAI({ apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY });
  const model = opts.model ?? process.env.SPLUS_LLM_MODEL ?? "gpt-5.5";
  const reasoning = opts.reasoning ?? process.env.SPLUS_LLM_REASONING ?? "medium";

  return {
    messages: {
      async create(rawBody: Record<string, unknown>) {
        const body = rawBody as unknown as AnthropicBody;

        // system text blocks -> a single OpenAI system message (cache_control dropped).
        const systemText = anthropicSystemToText(body.system);

        // Anthropic messages: content is a plain string at both call sites; be
        // defensive and flatten text blocks just in case.
        const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
        if (systemText) chatMessages.push({ role: "system", content: systemText });
        for (const m of body.messages) {
          chatMessages.push({
            role: m.role === "assistant" ? "assistant" : "user",
            content: flattenContent(m.content),
          });
        }

        // input_schema -> OpenAI function tools (plain JSON Schema, same shape).
        const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = (body.tools ?? []).map(
          (t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            },
          }),
        );

        // Force the single tool index.ts always names.
        const forcedName = body.tool_choice?.name ?? body.tools?.[0]?.name;
        const toolChoice: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption | undefined =
          forcedName ? { type: "function", function: { name: forcedName } } : undefined;

        const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
          model,
          // GPT-5.x reasoning models take reasoning_effort instead of temperature.
          // The valid set widens across SDK/model versions, so it is set via the
          // loosely-typed extension below rather than pinned to today's union.
          max_completion_tokens: body.max_tokens,
          messages: chatMessages,
          tools: tools.length ? tools : undefined,
          tool_choice: toolChoice,
        };
        (params as unknown as Record<string, unknown>).reasoning_effort = reasoning;

        const completion = await sdk.chat.completions.create(params);

        return openAIToLLMResponse(completion, forcedName);
      },
    },
  };
}

/** Collapse Anthropic system (text-block array or string) into one string. */
function anthropicSystemToText(system: AnthropicBody["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .map((b) => b.text ?? "")
    .filter(Boolean)
    .join("\n\n");
}

/** index.ts passes string content; flatten any block array defensively. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b as { text?: string })?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return String(content ?? "");
}

/**
 * Map the OpenAI completion back into the Anthropic-shaped LLMResponse so
 * parseTool() finds a `tool_use` block with {name, input:<parsed args>}.
 */
function openAIToLLMResponse(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  forcedName: string | undefined,
): {
  content: Array<{ type: string; name?: string; input?: unknown; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
} {
  const choice = completion.choices[0];
  const message = choice?.message;
  const content: Array<{ type: string; name?: string; input?: unknown; text?: string }> = [];

  // Prefer the forced tool call; otherwise the first function call present.
  const calls = message?.tool_calls ?? [];
  const call =
    (forcedName
      ? calls.find((c) => c.type === "function" && c.function.name === forcedName)
      : undefined) ?? calls.find((c) => c.type === "function");

  if (call && call.type === "function") {
    content.push({
      type: "tool_use",
      name: call.function.name,
      input: safeParseJson(call.function.arguments),
    });
  } else if (message?.content) {
    // No tool call (shouldn't happen under forced tool_choice) — surface text
    // so callers degrade gracefully (parseTool returns null → fail-open).
    content.push({ type: "text", text: textOf(message.content) });
  }

  const u = completion.usage;
  return {
    content,
    usage: u
      ? {
          input_tokens: u.prompt_tokens,
          output_tokens: u.completion_tokens,
          // OpenAI reports cached prompt tokens here; map to the Anthropic field
          // index.ts already accumulates as cachedInputTokens.
          cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens,
        }
      : undefined,
  };
}

function safeParseJson(s: string | null | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function textOf(content: OpenAI.Chat.Completions.ChatCompletionMessage["content"]): string {
  if (typeof content === "string") return content;
  return "";
}
