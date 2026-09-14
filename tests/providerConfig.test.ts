import assert from "node:assert/strict";
import test from "node:test";
import { aiProviderConfigFromEnv, publicAiProviderStatus } from "../src/providerConfig.js";

test("AI provider configuration reads secrets without exposing them in public status", () => {
  const config = aiProviderConfigFromEnv({
    OPENAI_API_KEY: "openai-secret",
    OPENAI_MODEL: "gpt-6-astra",
    ANTHROPIC_API_KEY: "anthropic-secret",
    ANTHROPIC_MODEL: "claude-opus-5",
    TOGETHER_API_KEY: "together-secret",
    TOGETHER_MODEL: "org/model"
  });
  const status = publicAiProviderStatus(config);
  assert.deepEqual(status, {
    openai: { configured: true, model: "gpt-6-astra" },
    anthropic: { configured: true, model: "claude-opus-5" },
    together: { configured: true, model: "org/model" }
  });
  assert.doesNotMatch(JSON.stringify(status), /openai-secret|anthropic-secret|together-secret/);
});

test("AI provider configuration is fail-closed for missing keys and malformed model names", () => {
  const status = publicAiProviderStatus(aiProviderConfigFromEnv({}));
  assert.deepEqual(status, {
    openai: { configured: false, model: "gpt-6-astra" },
    anthropic: { configured: false, model: "claude-opus-5" },
    together: { configured: false, model: null }
  });
  assert.throws(() => aiProviderConfigFromEnv({ OPENAI_MODEL: "bad model; rm" }), /invalid characters/);
});
