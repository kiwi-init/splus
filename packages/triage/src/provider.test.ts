import { test } from "node:test";
import assert from "node:assert/strict";
import { createLLMClient } from "./provider.js";

test("SPLUS_LLM_PROVIDER=openai selects the OpenAI adapter", () => {
  const saved = process.env.SPLUS_LLM_PROVIDER;
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.SPLUS_LLM_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    const client = createLLMClient();
    assert.equal(typeof client.messages.create, "function");
  } finally {
    if (saved === undefined) delete process.env.SPLUS_LLM_PROVIDER;
    else process.env.SPLUS_LLM_PROVIDER = saved;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }
});

test("default (no provider env) returns an Anthropic-backed LLMClient", () => {
  const saved = process.env.SPLUS_LLM_PROVIDER;
  delete process.env.SPLUS_LLM_PROVIDER;
  try {
    const client = createLLMClient({ apiKey: "sk-ant-test" });
    assert.equal(typeof client.messages.create, "function");
  } finally {
    if (saved !== undefined) process.env.SPLUS_LLM_PROVIDER = saved;
  }
});
