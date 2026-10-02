import { App, requestUrl } from "obsidian";
import { LLMOutput, ModelConfig } from "./types";

export const PROVIDERS: { value: ModelConfig["provider"]; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
];

export function providerLabel(provider: ModelConfig["provider"]): string {
  return PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
}

interface ApiError {
  error?: { message?: string };
}

// The model's API key from this device's Keychain. Throws with what to fix when it is missing.
export function apiKeyFor(app: App, config: ModelConfig): string {
  if (!config.secret_id) throw new Error(`No API key picked for ${config.name || "this model"}`);
  const key = app.secretStorage.getSecret(config.secret_id);
  if (!key) throw new Error(`This device's Keychain has no secret named "${config.secret_id}"`);
  return key;
}

// A GET, or a POST when there is a body, to the provider's API. Throws with the provider's error
// message on failure.
async function request(provider: ModelConfig["provider"], apiKey: string, path: string, body?: unknown): Promise<unknown> {
  const url = (provider === "openai" ? "https://api.openai.com/v1/" : "https://api.anthropic.com/v1/") + path;
  const headers: Record<string, string> =
    provider === "openai"
      ? { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
      : { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" };
  const resp = await requestUrl({
    url,
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    throw: false,
  });
  if (resp.status >= 400) {
    const message = (resp.json as ApiError | undefined)?.error?.message;
    throw new Error(message ?? `${providerLabel(provider)} returned ${resp.status}`);
  }
  return resp.json;
}

// The reply as one value. It comes back trimmed, since a stray newline or space would otherwise
// end up in file names and frontmatter.
export async function askModel(app: App, config: ModelConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const json = (await request(config.provider, apiKeyFor(app, config), endpoint(config), body(config, systemPrompt, userPrompt))) as {
    choices?: { message: { content: string } }[];
    content?: { type: string; text?: string }[];
  };
  const text = config.provider === "openai" ? json.choices?.[0]?.message.content : json.content?.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Empty reply");
  return text.trim();
}

// A reply with one value per output, through Anthropic's forced tool use or OpenAI's JSON schema
// output. Choices become an enum, so the model can only pick from them.
export async function askModelStructured(app: App, config: ModelConfig, systemPrompt: string, userPrompt: string, outputs: LLMOutput[]): Promise<Record<string, string>> {
  const properties: Record<string, unknown> = {};
  for (const o of outputs) {
    properties[o.name] = { type: "string", description: o.desc || o.name, ...(o.choices.length ? { enum: o.choices } : {}) };
  }
  const schema = { type: "object", properties, required: outputs.map((o) => o.name), additionalProperties: false };
  const apiKey = apiKeyFor(app, config);
  let values: unknown;
  if (config.provider === "openai") {
    const json = (await request(config.provider, apiKey, endpoint(config), {
      ...body(config, systemPrompt, userPrompt),
      response_format: { type: "json_schema", json_schema: { name: "reply", strict: true, schema } },
    })) as { choices?: { message: { content: string } }[] };
    const content = json.choices?.[0]?.message.content;
    if (typeof content !== "string") throw new Error("Empty reply");
    try {
      values = JSON.parse(content);
    } catch {
      throw new Error("The reply was not the JSON that was asked for");
    }
  } else {
    const json = (await request(config.provider, apiKey, endpoint(config), {
      ...body(config, systemPrompt, userPrompt),
      tools: [{ name: "reply", description: "Give each requested value.", input_schema: schema }],
      tool_choice: { type: "tool", name: "reply" },
    })) as { content?: { type: string; input?: unknown }[] };
    values = json.content?.find((c) => c.type === "tool_use")?.input;
  }
  if (!values || typeof values !== "object") throw new Error("Empty reply");
  const record = values as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const o of outputs) {
    const v = record[o.name];
    if (v === undefined || v === null) throw new Error(`The reply has no ${o.name}`);
    result[o.name] = (typeof v === "string" ? v : JSON.stringify(v)).trim();
  }
  return result;
}

function endpoint(config: ModelConfig): string {
  return config.provider === "openai" ? "chat/completions" : "messages";
}

function body(config: ModelConfig, systemPrompt: string, userPrompt: string): Record<string, unknown> {
  if (config.provider === "openai") {
    return { model: config.model, messages: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), { role: "user", content: userPrompt }] };
  }
  return { model: config.model, max_tokens: 4096, ...(systemPrompt ? { system: systemPrompt } : {}), messages: [{ role: "user", content: userPrompt }] };
}

// Sends a one-word request so the settings page can confirm the key and model ID.
export async function testModel(app: App, config: ModelConfig): Promise<number> {
  if (!config.model) throw new Error("No model ID");
  const start = Date.now();
  await askModel(app, config, "", "Reply with the single word OK.");
  return Date.now() - start;
}

export interface ProviderModel {
  id: string;
  label: string; // the provider's display name, or the id
  created: number; // ms since epoch, 0 when unknown
}

// The provider's model list, newest first. Anthropic and OpenAI both serve one at /v1/models.
export async function listModels(app: App, config: ModelConfig): Promise<ProviderModel[]> {
  const path = config.provider === "openai" ? "models" : "models?limit=1000";
  const json = (await request(config.provider, apiKeyFor(app, config), path)) as { data?: { id: string; display_name?: string; created_at?: string; created?: number }[] };
  return (json.data ?? [])
    .map((m) => ({ id: m.id, label: m.display_name ?? m.id, created: m.created_at ? Date.parse(m.created_at) : (m.created ?? 0) * 1000 }))
    .sort((a, b) => b.created - a.created);
}
