/**
 * Provider selection for the LLM judge.
 *
 * One switch, read from env, so the hosted GitHub bot judges with OpenAI
 * GPT-5.5 while the local/CLI path keeps using Claude — and triage()/discover()
 * never need to know which is live. Both satisfy the same LLMClient interface.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient } from "./index.js";
import { createOpenAIClient } from "./openai.js";

export interface CreateLLMClientOptions {
  apiKey?: string;
  model?: string;
  reasoning?: string;
}

/**
 * Return the configured LLMClient: the OpenAI adapter when
 * SPLUS_LLM_PROVIDER==='openai', otherwise the Anthropic SDK (the unchanged
 * local/Claude path). Defaults to Anthropic — opt in to OpenAI explicitly.
 */
export function createLLMClient(opts: CreateLLMClientOptions = {}): LLMClient {
  if (process.env.SPLUS_LLM_PROVIDER === "openai") {
    return createOpenAIClient(opts);
  }
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  return new Anthropic({ apiKey }) as unknown as LLMClient;
}
