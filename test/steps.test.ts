import { test } from "node:test";
import assert from "node:assert/strict";
import { Step } from "../src/types";
import { STEP_DEFS, STEP_TYPES_IN_ORDER, convertStep, makeStep, outputOf, stepTitle, templatedFields } from "../src/steps";

test("every step type has a definition whose factory matches its output", () => {
  for (const type of STEP_TYPES_IN_ORDER) {
    const def = STEP_DEFS[type];
    const step = makeStep(type);
    assert.equal(step.type, type);
    assert.equal("variable" in step, def.output !== null, type);
    if (def.output !== null) assert.equal(outputOf(step)?.name, def.defaultOutput);
    for (const f of def.fields) assert.ok(f.key in step, `${type}.${f.key}`);
  }
});

test("convertStep keeps same-named fields and uniquifies the output", () => {
  const open: Step = { type: "open_file", target: "{{note}}", section: "## Ref" };
  const insert = convertStep(open, "insert_in_section", []);
  assert.equal(insert.type, "insert_in_section");
  assert.equal((insert as { target: string }).target, "{{note}}");
  assert.equal((insert as { section: string }).section, "## Ref");

  const prompt: Step = { type: "prompt", variable: "thought", label: "Q", multiline: true };
  const llm = convertStep(prompt, "llm", ["thought", "reply"]);
  assert.equal((llm as { variable: string }).variable, "thought2");
  const choice = convertStep(prompt, "choice", ["reply"]);
  assert.equal((choice as { variable: string }).variable, "thought");
  assert.equal((choice as { label: string }).label, "Q");
  assert.equal("variable" in convertStep(prompt, "open_file", []), false);
});

test("templatedFields and stepTitle", () => {
  const llm: Step = { type: "llm", variable: "r", model: "Opus", system_prompt: "s", user_prompt: "u" };
  assert.deepEqual(templatedFields(llm).map((f) => f.key), ["system_prompt", "user_prompt"]);
  const models = [{ name: "Opus", provider: "anthropic" as const, model: "m", secret_id: "" }];
  assert.equal(stepTitle(llm, models), "Opus");
  assert.equal(stepTitle({ ...llm, model: "" }, models), "Opus");
  assert.equal(stepTitle({ ...llm, model: "" }, []), "Ask a model");
  assert.equal(stepTitle(makeStep("create_file"), []), "Create file");
});
