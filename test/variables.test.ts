import { test } from "node:test";
import assert from "node:assert/strict";
import { Step } from "../src/types";
import {
  availableInputs,
  consumersOf,
  renameOutput,
  resolveSegments,
  resolveTemplate,
  resolveStep,
  uniqueName,
  usedInputs,
} from "../src/variables";

function sample(): Step[] {
  return [
    { type: "prompt", variable: "thought", label: "Thought", multiline: true },
    { type: "llm", variable: "title", model: "Haiku", system_prompt: "Title this", user_prompt: "{{thought}}" },
    { type: "create_file", variable: "note", path: "Inbox/{{timestamp}} {{title}}", content: "{{thought}}" },
    { type: "open_file", target: "{{note}}", section: "" },
  ];
}

test("availableInputs at index 0 is built-ins only", () => {
  const names = availableInputs(sample(), 0).map((i) => i.name);
  assert.deepEqual(names, ["date", "time", "timestamp"]);
});

test("availableInputs lists earlier outputs with their types", () => {
  const inputs = availableInputs(sample(), 3);
  assert.deepEqual(
    inputs.map((i) => [i.name, i.type, i.from]),
    [["date", "text", -1], ["time", "text", -1], ["timestamp", "text", -1], ["thought", "text", 0], ["title", "text", 1], ["note", "file", 2]],
  );
});

test("availableInputs: nearest producer wins when a name is shadowed", () => {
  const steps: Step[] = [
    { type: "prompt", variable: "x", label: "", multiline: false },
    { type: "file_picker", variable: "x", folder: "" },
    { type: "open_file", target: "{{x}}", section: "" },
  ];
  const x = availableInputs(steps, 2).find((i) => i.name === "x");
  assert.deepEqual(x, { name: "x", type: "file", from: 1 });
});

test("usedInputs ignores non-templated fields", () => {
  const step: Step = { type: "prompt", variable: "a", label: "Use {{date}} here", multiline: false };
  assert.deepEqual(usedInputs(step), []);
  assert.deepEqual(usedInputs(sample()[2]), ["timestamp", "title", "thought"]);
});

test("consumersOf lists later users and stops at a re-definition", () => {
  const steps = sample();
  assert.deepEqual(consumersOf(steps, 0), [1, 2]);
  assert.deepEqual(consumersOf(steps, 2), [3]);
  steps.splice(2, 0, { type: "prompt", variable: "thought", label: "", multiline: false });
  assert.deepEqual(consumersOf(steps, 0), [1]);
});

test("renameOutput rewrites only consumers after the producer", () => {
  const steps = sample();
  assert.equal(renameOutput(steps, 0, "idea"), true);
  assert.equal((steps[0] as { variable: string }).variable, "idea");
  assert.equal((steps[1] as { user_prompt: string }).user_prompt, "{{idea}}");
  assert.equal((steps[2] as { content: string }).content, "{{idea}}");
  assert.equal((steps[2] as { path: string }).path, "Inbox/{{timestamp}} {{title}}");
});

test("renameOutput refuses collisions, built-ins and invalid names", () => {
  const steps = sample();
  assert.equal(renameOutput(steps, 0, "title"), false);
  assert.equal(renameOutput(steps, 0, "date"), false);
  assert.equal(renameOutput(steps, 0, "9lives"), false);
  assert.equal(renameOutput(steps, 0, "has space"), false);
  assert.equal(renameOutput(steps, 3, "x"), false);
  assert.deepEqual(steps, sample());
});

test("uniqueName appends a counter", () => {
  assert.equal(uniqueName("note", []), "note");
  assert.equal(uniqueName("note", ["note"]), "note2");
  assert.equal(uniqueName("note", ["note", "note2"]), "note3");
});

test("resolveTemplate leaves unknown names verbatim", () => {
  assert.equal(resolveTemplate("a {{x}} b {{y}}", { x: "1" }), "a 1 b {{y}}");
});

test("resolveSegments round-trips to resolveTemplate", () => {
  const vars = { x: "1", y: "two" };
  for (const t of ["{{x}}", "a {{x}} b {{y}} c", "{{z}} {{x}}", "plain", ""]) {
    const segments = resolveSegments(t, vars);
    assert.equal(segments.map((s) => s.text).join(""), resolveTemplate(t, vars));
  }
  assert.deepEqual(resolveSegments("a {{x}}", vars), [{ text: "a " }, { text: "1", name: "x" }]);
});

test("resolveStep resolves only templated fields", () => {
  const resolved = resolveStep(sample()[2], { timestamp: "1", title: "T", thought: "hi" });
  assert.deepEqual(resolved, { path: "Inbox/1 T", content: "hi" });
});
