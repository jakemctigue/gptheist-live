export interface AiProviderConfig {
  openai: { apiKey: string; model: string } | null;
  anthropic: { apiKey: string; model: string } | null;
  together: { apiKey: string; model: string | null } | null;
}

export interface PublicAiProviderStatus {
  openai: { configured: boolean; model: string };
  anthropic: { configured: boolean; model: string };
  together: { configured: boolean; model: string | null };
}

function secret(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function model(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) throw new Error(`${name} contains invalid characters`);
  return value;
}

export function aiProviderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AiProviderConfig {
  const openaiKey = secret(env, "OPENAI_API_KEY");
  const anthropicKey = secret(env, "ANTHROPIC_API_KEY");
  const togetherKey = secret(env, "TOGETHER_API_KEY");
  const openaiModel = model(env, "OPENAI_MODEL", "gpt-6-astra");
  const anthropicModel = model(env, "ANTHROPIC_MODEL", "claude-opus-5");
  const togetherModel = env.TOGETHER_MODEL?.trim() ? model(env, "TOGETHER_MODEL", "") : null;
  return {
    openai: openaiKey ? { apiKey: openaiKey, model: openaiModel } : null,
    anthropic: anthropicKey ? { apiKey: anthropicKey, model: anthropicModel } : null,
    together: togetherKey ? { apiKey: togetherKey, model: togetherModel } : null
  };
}

export function publicAiProviderStatus(config: AiProviderConfig): PublicAiProviderStatus {
  return {
    openai: { configured: config.openai !== null, model: config.openai?.model ?? "gpt-6-astra" },
    anthropic: { configured: config.anthropic !== null, model: config.anthropic?.model ?? "claude-opus-5" },
    together: { configured: config.together !== null, model: config.together?.model ?? null }
  };
}
