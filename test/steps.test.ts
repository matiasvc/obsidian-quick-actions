import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { Action, ModelConfig, Step } from "../src/types";
import {
  STEP_DEFS,
  STEP_TYPES_IN_ORDER,
  blockedReason,
  convertStep,
  freshOutputs,
  isModelMissing,
  makeStep,
  modelUses,
  outputHintOf,
  outputsOf,
  setOutputName,
  stepLabel,
  stepTitle,
  stepWith,
  templatedFields,
  withoutUnavailable,
} from "../src/steps";
import { consumersOf, renameOutput } from "../src/variables";

const models: ModelConfig[] = [{ name: "Opus", provider: "anthropic", model: "m", secret_id: "" }];

test("quick_task is a file-producing step with two templated fields", () => {
  assert.deepEqual(templatedFields(makeStep("quick_task")).map((f) => f.key), ["project", "prefill"]);
  const picked = stepWith("file_picker", { folder: "Project Notes/" });
  assert.deepEqual(convertStep(picked, "quick_task", []), { type: "quick_task", variable: "file", project: "", prefill: "" });

  const steps: Step[] = [
    picked,
    stepWith("quick_task", { project: "{{file}}" }),
    stepWith("insert_in_section", { target: "{{file}}", section: "# Tasks", format: "![[{{task}}]]" }),
  ];
  assert.deepEqual(consumersOf(steps, 0), [1, 2]);
  assert.deepEqual(consumersOf(steps, 1), [2]);
  assert.equal(renameOutput(steps, 1, "task", "todo"), true);
  assert.equal((steps[2] as { format: string }).format, "![[{{todo}}]]");
});

test("every step type has a definition whose factory matches its output", () => {
  for (const type of STEP_TYPES_IN_ORDER) {
    const def = STEP_DEFS[type];
    const step = makeStep(type);
    assert.equal(step.type, type);
    assert.equal("variable" in step, def.output !== null, type);
    for (const f of def.fields) assert.ok(f.key in step, `${type}.${f.key}`);
  }
});

test("outputsOf: a fetch hands down the page and its title, a structured model one value per field", () => {
  assert.deepEqual(outputsOf(makeStep("fetch_page")), [
    { name: "page", type: "text" },
    { name: "page_title", type: "text" },
  ]);
  const llm = stepWith("llm", {
    outputs: [
      { name: "category", desc: "", choices: ["Article", "Paper"] },
      { name: "title", desc: "", choices: [] },
    ],
  });
  assert.deepEqual(outputsOf(llm).map((o) => o.name), ["category", "title"]);
  setOutputName(llm, "title", "heading");
  assert.deepEqual(outputsOf(llm).map((o) => o.name), ["category", "heading"]);
  assert.deepEqual(outputsOf({ ...llm, outputs: [] }).map((o) => o.name), ["reply"]);
  assert.deepEqual(outputsOf(makeStep("open_file")), []);
});

test("a model step on the web hands down its sources after the reply, under a name of its own", () => {
  const llm = makeStep("llm");
  assert.deepEqual(outputsOf(llm).map((o) => o.name), ["reply"]);
  const searching = stepWith("llm", { webSearch: true });
  assert.deepEqual(outputsOf(searching).map((o) => o.name), ["reply", "sources"]);
  const reading = stepWith("llm", { webFetch: true, outputs: [{ name: "title", desc: "", choices: [] }] });
  assert.deepEqual(outputsOf(reading).map((o) => o.name), ["title", "sources"]);
  setOutputName(reading, "sources", "links");
  assert.deepEqual(outputsOf(reading).map((o) => o.name), ["title", "links"]);
  assert.deepEqual(outputsOf(freshOutputs(stepWith("llm", { webSearch: true }), ["sources"])).map((o) => o.name), ["reply", "sources2"]);
  assert.equal(outputHintOf(searching), "the reply, then its sources");
  assert.equal(outputHintOf(reading), "one value per field, then its sources");
  // Off the web, a name matching the unused sources key still renames the reply.
  const offline = stepWith("llm", { variable: "sources" });
  setOutputName(offline, "sources", "answer");
  assert.deepEqual(outputsOf(offline).map((o) => o.name), ["answer"]);
});

test("the editor turns off Read linked pages for OpenAI and Effort for Haiku, and runs leave them out", () => {
  const llm = makeStep("llm");
  const openai: ModelConfig[] = [{ name: "GPT", provider: "openai", model: "m", secret_id: "" }];
  const haiku: ModelConfig[] = [{ name: "Haiku", provider: "anthropic", model: "claude-haiku-4-5-20251001", secret_id: "" }];
  const fetchField = STEP_DEFS.llm.fields.find((f) => f.key === "webFetch");
  const effortField = STEP_DEFS.llm.fields.find((f) => f.key === "effort");
  assert.equal(fetchField?.unavailable?.(llm, models), undefined);
  assert.match(fetchField?.unavailable?.(llm, openai) ?? "", /OpenAI/);
  assert.equal(effortField?.unavailable?.(llm, models), undefined);
  assert.match(effortField?.unavailable?.(llm, haiku) ?? "", /Haiku/);
  assert.equal(effortField?.unavailable?.(llm, openai), undefined);

  const set = stepWith("llm", { effort: "high", webSearch: true, webFetch: true });
  assert.equal(withoutUnavailable(set, models), set);
  assert.deepEqual(withoutUnavailable(set, haiku), { ...set, effort: "" });
  assert.deepEqual(withoutUnavailable(set, openai), { ...set, webFetch: false });
  assert.equal((set as { effort: string }).effort, "high");
});

test("convertStep keeps same-named fields and the name, and uniquifies every output", () => {
  const open = stepWith("open_file", { target: "{{note}}", section: "## Ref", openIn: "tab", name: "Show it" });
  const insert = convertStep(open, "insert_in_section", []);
  assert.equal(insert.type, "insert_in_section");
  assert.equal((insert as { target: string }).target, "{{note}}");
  assert.equal((insert as { section: string }).section, "## Ref");
  assert.equal(insert.name, "Show it");

  const prompt = stepWith("prompt", { variable: "thought", label: "Q", multiline: true });
  const llm = convertStep(prompt, "llm", ["thought", "reply"]);
  assert.equal((llm as { variable: string }).variable, "thought2");
  const choice = convertStep(prompt, "choice", ["reply"]);
  assert.equal((choice as { variable: string }).variable, "thought");
  assert.equal((choice as { label: string }).label, "Q");
  assert.equal("variable" in convertStep(prompt, "open_file", []), false);
  const fetch = convertStep(prompt, "fetch_page", ["page_title"]);
  assert.deepEqual(outputsOf(fetch).map((o) => o.name), ["thought", "page_title2"]);
});

test("templatedFields, stepTitle and stepLabel", () => {
  const llm = stepWith("llm", { variable: "r", model: "Opus", system_prompt: "s", user_prompt: "u" });
  assert.deepEqual(templatedFields(llm).map((f) => f.key), ["system_prompt", "user_prompt", "attach"]);
  assert.equal(stepTitle(llm, models), "Opus");
  assert.equal(stepTitle({ ...llm, model: "" }, models), "Opus");
  assert.equal(stepTitle({ ...llm, model: "" }, []), "Ask a model");
  assert.equal(stepTitle(makeStep("create_file"), []), "Create file");
  assert.equal(stepLabel(llm, models), "Opus → r");
  assert.equal(stepTitle({ ...llm, name: "Write body" }, models), "Write body");
  assert.equal(stepLabel({ ...llm, name: "Write body" }, models), "Write body");
  assert.equal(stepLabel(makeStep("create_file"), models), "Create file");
});

test("a step naming a model that is gone is marked, never swapped for the first one", () => {
  const llm = stepWith("llm", { variable: "r", model: "Opus 4.6" });
  assert.equal(isModelMissing(llm, models), true);
  assert.equal(isModelMissing({ ...llm, model: "Opus" }, models), false);
  assert.equal(isModelMissing({ ...llm, model: "" }, models), false);
  assert.equal(isModelMissing({ ...llm, model: "" }, []), true);
  assert.equal(stepTitle(llm, models), "Opus 4.6");
});

test("a step that can't run says why: a missing model, model ID, key or plugin", () => {
  const app = { secretStorage: { getSecret: (id: string) => (id === "key" ? "sk-1" : null) } } as unknown as App;
  const ready = [{ ...models[0], secret_id: "key" }];
  assert.equal(blockedReason(stepWith("llm", { model: "Opus 4.6" }), { app, models: ready }), 'Model "Opus 4.6" is not configured');
  assert.equal(blockedReason(stepWith("llm"), { app, models: [] }), "No models are configured");
  assert.equal(blockedReason(stepWith("llm"), { app, models: ready }), undefined);
  assert.equal(blockedReason(stepWith("llm"), { app, models: [{ ...ready[0], model: "" }] }), "No model ID");
  assert.equal(blockedReason(stepWith("llm"), { app, models }), "No API key picked");
  assert.equal(blockedReason(stepWith("llm"), { app, models: [{ ...ready[0], secret_id: "other" }] }), `This device's Keychain has no secret named "other"`);
  assert.equal(blockedReason(stepWith("quick_task"), { app, models }), "Quick Tasks plugin is not enabled");
  assert.equal(blockedReason(stepWith("prompt"), { app, models }), undefined);
});

test("modelUses: named steps count for their model, unnamed ones for the first, numbered as in the rail", () => {
  const opus = models[0];
  const haiku: ModelConfig = { ...opus, name: "Haiku" };
  const steps: Step[] = [stepWith("if"), stepWith("llm", { model: "Haiku" }), stepWith("end_if"), stepWith("llm"), stepWith("llm", { model: "Opus" })];
  const action: Action = { id: "a", name: "A", icon: "zap", steps };
  const uses = (list: ModelConfig[], model: ModelConfig) => modelUses([action], list, model).map((u) => u.number);
  assert.deepEqual(uses([opus, haiku], opus), [3, 4]);
  assert.deepEqual(uses([opus, haiku], haiku), [2]);
  // A new model added when there are none takes the unnamed steps.
  const fresh: ModelConfig = { name: "", provider: "anthropic", model: "", secret_id: "" };
  assert.deepEqual(uses([fresh], fresh), [3]);
  assert.deepEqual(uses([opus, fresh], fresh), []);
});

test("freshOutputs makes every output name unique, against others and each other", () => {
  const fetch = freshOutputs(makeStep("fetch_page"), ["page", "page_title", "page2"]);
  assert.deepEqual(outputsOf(fetch).map((o) => o.name), ["page3", "page_title2"]);
  const llm = freshOutputs(stepWith("llm", { outputs: [{ name: "title", desc: "", choices: [] }, { name: "body", desc: "", choices: [] }] }), ["title"]);
  assert.deepEqual(outputsOf(llm).map((o) => o.name), ["title2", "body"]);
});

test("stepWith fills every default under the given values", () => {
  assert.deepEqual(stepWith("open_file", { target: "{{note}}" }), { type: "open_file", target: "{{note}}", section: "", openIn: "current" });
});

test("templatedFields tells path and note fields from plain ones", () => {
  const modes = (type: Parameters<typeof makeStep>[0]) => templatedFields(makeStep(type)).map((f) => `${f.key}:${f.mode}`);
  assert.deepEqual(modes("create_file"), ["path:path", "content:note"]);
  assert.deepEqual(modes("insert_in_section"), ["target:path", "section:plain", "format:plain", "templatePath:path"]);
  assert.deepEqual(modes("open_file"), ["target:path", "section:plain"]);
});
