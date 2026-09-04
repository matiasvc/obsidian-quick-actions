import { App, requestUrl } from "obsidian";
import { ModelConfig } from "./types";

export const PROVIDERS: { value: ModelConfig["provider"]; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
];

export function providerLabel(provider: ModelConfig["provider"]): string {
  return PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
}

// The named model, or the first one when the name is empty or unknown.
export function findModel(models: ModelConfig[], name: string): ModelConfig | undefined {
  return (name ? models.find((m) => m.name === name) : undefined) ?? models[0];
}

interface ApiError {
  error?: { message?: string };
}

// Throws with the provider's error message on failure.
export async function callLLM(
  provider: ModelConfig["provider"],
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const request: { url: string; headers: Record<string, string>; body: unknown } =
    provider === "openai"
      ? {
          url: "https://api.openai.com/v1/chat/completions",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: {
            model,
            messages: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), { role: "user", content: userPrompt }],
          },
        }
      : {
          url: "https://api.anthropic.com/v1/messages",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: {
            model,
            max_tokens: 4096,
            ...(systemPrompt ? { system: systemPrompt } : {}),
            messages: [{ role: "user", content: userPrompt }],
          },
        };
  const resp = await requestUrl({ url: request.url, method: "POST", headers: request.headers, body: JSON.stringify(request.body), throw: false });
  if (resp.status >= 400) {
    const message = (resp.json as ApiError | undefined)?.error?.message;
    throw new Error(message ?? `${providerLabel(provider)} returned ${resp.status}`);
  }
  const json = resp.json as { choices?: { message: { content: string } }[]; content?: { text: string }[] };
  const text = provider === "openai" ? json.choices?.[0]?.message.content : json.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("Empty reply");
  return text;
}

// Sends a one-word request so the settings page can confirm the key and model id.
export async function testModel(app: App, config: ModelConfig): Promise<{ ms: number; reply: string }> {
  const apiKey = config.secret_id ? app.secretStorage.getSecret(config.secret_id) : null;
  if (!apiKey) throw new Error(config.secret_id ? `No secret named "${config.secret_id}"` : "No secret selected");
  if (!config.model) throw new Error("No model id");
  const start = Date.now();
  const reply = await callLLM(config.provider, config.model, apiKey, "", "Reply with the single word OK.");
  return { ms: Date.now() - start, reply: reply.trim() };
}
