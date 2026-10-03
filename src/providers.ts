// What the plugin knows about each model provider: its name, the limits of one request, and the
// step options its API takes. Only a type import from obsidian, so the step table and the node tests
// can use it.
import type { App } from "obsidian";
import { ModelConfig } from "./types";

// Why the model has no usable API key on this device, or undefined when it has one. The key itself
// lives in this device's Keychain.
export function keyProblem(app: App, config: ModelConfig): string | undefined {
  if (!config.secret_id) return "No API key picked";
  if (!app.secretStorage.getSecret(config.secret_id)) return `This device's Keychain has no secret named "${config.secret_id}"`;
  return undefined;
}

// Why a step can't run on this model on this device, or undefined when it can.
export function modelProblem(app: App, config: ModelConfig): string | undefined {
  return config.model ? keyProblem(app, config) : "No model ID";
}

export const PROVIDERS: { value: ModelConfig["provider"]; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
];

export function providerLabel(provider: ModelConfig["provider"]): string {
  return PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
}

// How many searches or page reads a model step may make for one reply.
export const WEB_MAX_USES = 5;

// The largest request a provider takes. Base64 attachments make up nearly all of a request.
export const REQUEST_LIMIT: Record<ModelConfig["provider"], number> = { anthropic: 32 * 1024 * 1024, openai: 50 * 1024 * 1024 };

// The output limit sent to Anthropic, which requires one, when the model sets none.
export const DEFAULT_MAX_TOKENS = 16000;

// File extensions a model takes as an attachment, with their media types.
const ATTACHABLE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

// The media type a model takes a file with this extension as, or undefined when it takes none.
export function mediaTypeOf(extension: string): string | undefined {
  const ext = extension.toLowerCase();
  return Object.prototype.hasOwnProperty.call(ATTACHABLE, ext) ? ATTACHABLE[ext] : undefined;
}

// A step option that not every model takes.
export type Feature = "effort" | "webFetch";

// Why the model can't take the option, or undefined when it can.
export function unsupported(config: ModelConfig, feature: Feature): string | undefined {
  if (feature === "effort" && config.provider === "anthropic" && /haiku/i.test(config.model)) return "Haiku models have no effort setting.";
  if (feature === "webFetch" && config.provider === "openai") return "OpenAI models can't open a given URL. Their web search opens the pages it finds.";
  return undefined;
}
