import { App, requestUrl } from "obsidian";
import { Effort, LLMOutput, ModelConfig, Page } from "./types";
import { DEFAULT_MAX_TOKENS, WEB_MAX_USES, keyProblem, providerLabel, unsupported } from "./providers";
import { stripCitations } from "./text";

interface ApiError {
  error?: { message?: string };
}

// The model's API key from this device's Keychain. Throws with what to fix when it is missing.
export function apiKeyFor(app: App, config: ModelConfig): string {
  const problem = keyProblem(app, config);
  if (problem) throw new Error(problem);
  return app.secretStorage.getSecret(config.secret_id) ?? "";
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
    let message: string | undefined;
    try {
      message = (JSON.parse(resp.text) as ApiError | null)?.error?.message;
    } catch {
      // Not JSON, such as a gateway's error page, so the status has to do.
    }
    throw new Error(message ?? `${providerLabel(provider)} returned ${resp.status}`);
  }
  return resp.json;
}

interface AnthropicReply {
  content?: {
    type: string;
    text?: string;
    citations?: { url?: string; title?: string }[];
    content?: { url?: string; title?: string; content?: { title?: string } } | { url?: string; title?: string }[];
  }[];
  stop_reason?: string | null;
  stop_details?: { explanation?: string } | null;
}

interface OpenAIReply {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: {
    type: string;
    phase?: string; // a message's "commentary" before tool calls, or its "final_answer"
    content?: {
      type: string;
      text?: string;
      refusal?: string;
      annotations?: { type: string; url?: string; title?: string; start_index?: number; end_index?: number }[];
    }[];
    action?: { sources?: { url?: string }[] };
  }[];
}

export interface Attachment {
  name: string;
  mediaType: string;
  data: string; // base64
}

// What a step sends besides its prompts, in the step's own terms. An option the model doesn't take
// is left out of the request.
export interface AskOptions {
  webSearch?: boolean;
  webFetch?: boolean;
  effort?: Effort | ""; // "" leaves it to the model
  attachments?: Attachment[];
}

const CUT_OFF = "The reply was cut off at the output limit";
const MAX_CONTINUATIONS = 5;

// The reply's text and the pages it drew on: those it cites and those it read, or when there are
// none, those its searches found. Text before a tool call only leads up to it ("I'll search
// for…"), so the answer is the text after the last one. A reply that stopped short throws, so a
// partial answer never reaches a note. The text comes back trimmed, since a stray newline or space
// would otherwise end up in file names and frontmatter.
async function reply(app: App, config: ModelConfig, req: Record<string, unknown>): Promise<{ text: string; pages: Page[] }> {
  const apiKey = apiKeyFor(app, config);
  let text = "";
  let cited: Page[] = [];
  const read: Page[] = [];
  const found: Page[] = [];
  if (config.provider === "openai") {
    const json = (await request(config.provider, apiKey, "responses", req)) as OpenAIReply;
    if (json.status === "failed") throw new Error(json.error?.message || "OpenAI could not finish the reply");
    if (json.status === "incomplete") {
      const reason = json.incomplete_details?.reason;
      throw new Error(reason === "max_output_tokens" ? CUT_OFF : reason === "content_filter" ? "OpenAI's content filter stopped the reply" : "The reply stopped early");
    }
    for (const item of json.output ?? []) {
      if (item.type === "web_search_call") {
        text = "";
        cited = [];
        for (const s of item.action?.sources ?? []) if (s.url) found.push({ url: s.url });
      }
      if (item.type !== "message" || item.phase === "commentary") continue;
      for (const part of item.content ?? []) {
        if (part.type === "refusal") throw new Error(`The model declined: ${part.refusal}`);
        if (part.type !== "output_text") continue;
        // The citations also sit in the text as links, which in a structured reply land inside the
        // values. The sources value holds them instead.
        const citations = (part.annotations ?? []).filter((a) => a.type === "url_citation");
        text += stripCitations(part.text ?? "", citations);
        for (const a of citations) if (a.url) cited.push({ url: a.url, title: a.title });
      }
    }
  } else {
    const messages = [...(req.messages as unknown[])];
    for (let pass = 0; ; pass++) {
      const json = (await request(config.provider, apiKey, "messages", { ...req, messages })) as AnthropicReply;
      if (json.stop_reason === "max_tokens") throw new Error(CUT_OFF);
      if (json.stop_reason === "model_context_window_exceeded") throw new Error("The reply ran into the model's context window");
      if (json.stop_reason === "refusal") throw new Error(json.stop_details?.explanation || "The model declined to answer");
      for (const block of json.content ?? []) {
        if (block.type === "text") {
          text += block.text ?? "";
          for (const c of block.citations ?? []) if (c.url) cited.push({ url: c.url, title: c.title });
        } else if (!block.type.includes("thinking")) {
          text = "";
          cited = [];
          const result = block.content;
          if (Array.isArray(result)) for (const r of result) if (r.url) found.push({ url: r.url, title: r.title });
          if (result && !Array.isArray(result) && result.url) read.push({ url: result.url, title: result.content?.title });
        }
      }
      // Anthropic pauses long server-tool turns. Sending the content back resumes the turn.
      if (json.stop_reason !== "pause_turn") break;
      if (pass === MAX_CONTINUATIONS) throw new Error(`The model was still working after ${MAX_CONTINUATIONS} continuations`);
      messages.push({ role: "assistant", content: json.content });
    }
  }
  if (!text.trim()) throw new Error("Empty reply");
  const drawn = [...cited, ...read];
  return { text: text.trim(), pages: drawn.length ? drawn : found };
}

// The reply as one value.
export async function askModel(app: App, config: ModelConfig, systemPrompt: string, userPrompt: string, opts: AskOptions = {}): Promise<{ text: string; pages: Page[] }> {
  return reply(app, config, body(config, systemPrompt, userPrompt, opts));
}

// A reply with one value per output, through each provider's JSON schema output. Choices become an
// enum, so the model can only pick from them. The API may change a choice's case, so a value comes
// back as the choice is written.
export async function askModelStructured(
  app: App,
  config: ModelConfig,
  systemPrompt: string,
  userPrompt: string,
  outputs: LLMOutput[],
  opts: AskOptions,
): Promise<{ values: Record<string, string>; pages: Page[] }> {
  const properties: Record<string, unknown> = {};
  for (const o of outputs) {
    properties[o.name] = { type: "string", description: o.desc || o.name, ...(o.choices.length ? { enum: o.choices } : {}) };
  }
  const schema = { type: "object", properties, required: outputs.map((o) => o.name), additionalProperties: false };
  const { text, pages } = await reply(app, config, body(config, systemPrompt, userPrompt, opts, schema));
  let values: unknown = null;
  try {
    values = JSON.parse(text);
  } catch {
    // Not JSON, which the check below turns away.
  }
  if (!values || typeof values !== "object") throw new Error("The reply was not the JSON that was asked for");
  const record = values as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const o of outputs) {
    const v = record[o.name];
    if (v === undefined || v === null) throw new Error(`The reply has no ${o.name}`);
    const text = (typeof v === "string" ? v : JSON.stringify(v)).trim();
    result[o.name] = o.choices.find((c) => c.toLowerCase() === text.toLowerCase()) ?? text;
  }
  return { values: result, pages };
}

// The request, with the JSON schema of a structured reply when there is one. Files go before the
// text, and an empty prompt sends no text part, since an empty one is refused.
function body(config: ModelConfig, systemPrompt: string, userPrompt: string, opts: AskOptions, schema?: object): Record<string, unknown> {
  const files = opts.attachments ?? [];
  const effort = unsupported(config, "effort") === undefined ? opts.effort : "";
  const webFetch = unsupported(config, "webFetch") === undefined && opts.webFetch;
  if (config.provider === "openai") {
    const parts: object[] = files.map((a) => {
      const url = `data:${a.mediaType};base64,${a.data}`;
      return a.mediaType === "application/pdf" ? { type: "input_file", filename: a.name, file_data: url } : { type: "input_image", image_url: url };
    });
    if (userPrompt) parts.push({ type: "input_text", text: userPrompt });
    // OpenAI keeps responses for 30 days unless `store` is false, and a step never reads one back.
    return {
      model: config.model,
      ...(systemPrompt ? { instructions: systemPrompt } : {}),
      input: files.length ? [{ role: "user", content: parts }] : userPrompt,
      store: false,
      ...(config.max_tokens ? { max_output_tokens: config.max_tokens } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      ...(schema ? { text: { format: { type: "json_schema", name: "reply", strict: true, schema } } } : {}),
      ...(opts.webSearch ? { tools: [{ type: "web_search" }], max_tool_calls: WEB_MAX_USES, include: ["web_search_call.action.sources"] } : {}),
    };
  }
  // Anthropic needs an output limit, and takes effort and the schema together in output_config.
  const outputConfig = { ...(effort ? { effort } : {}), ...(schema ? { format: { type: "json_schema", schema } } : {}) };
  const blocks: object[] = files.map((a) => ({ type: a.mediaType === "application/pdf" ? "document" : "image", source: { type: "base64", media_type: a.mediaType, data: a.data } }));
  if (userPrompt) blocks.push({ type: "text", text: userPrompt });
  // The web tools run as direct calls, since these versions otherwise expect calls from code
  // execution, which Haiku 4.5 lacks. Fetch citations stay at their default of off, since the pages
  // come from the fetch results and citations can leave a stray cite tag in the reply.
  const tools = [
    ...(opts.webSearch ? [{ type: "web_search_20260318", name: "web_search", max_uses: WEB_MAX_USES, allowed_callers: ["direct"] }] : []),
    ...(webFetch ? [{ type: "web_fetch_20260318", name: "web_fetch", max_uses: WEB_MAX_USES, allowed_callers: ["direct"] }] : []),
  ];
  return {
    model: config.model,
    max_tokens: config.max_tokens || DEFAULT_MAX_TOKENS,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: "user", content: files.length ? blocks : userPrompt }],
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

// Asks for a one-word reply so the settings page can confirm the key and model ID.
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
