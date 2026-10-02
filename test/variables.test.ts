import { test } from "node:test";
import assert from "node:assert/strict";
import { Step } from "../src/types";
import {
  BUILTINS,
  availableInputs,
  cleanedInPaths,
  consumersOf,
  namesUsedBy,
  parseRefs,
  renameOutput,
  resolveSegments,
  resolveTemplate,
  resolveStep,
  uniqueName,
  unknownFilters,
  usedInputs,
} from "../src/variables";

function sample(): Step[] {
  return [
    { type: "prompt", variable: "thought", label: "Thought", multiline: true, default: "" },
    { type: "llm", variable: "title", model: "Haiku", system_prompt: "Title this", user_prompt: "{{thought}}", outputs: [] },
    { type: "create_file", variable: "note", path: "Inbox/{{timestamp}} {{title}}", content: "{{thought}}" },
    { type: "open_file", target: "{{note}}", section: "", openIn: "current" },
  ];
}

const builtinNames = BUILTINS.map((b) => b.name);

test("availableInputs at index 0 is built-ins only", () => {
  const names = availableInputs(sample(), 0).map((i) => i.name);
  assert.deepEqual(names, builtinNames);
  assert.deepEqual(builtinNames, ["date", "time", "timestamp", "selection", "clipboard", "active_note", "active_title"]);
});

test("availableInputs lists earlier outputs with their types", () => {
  const inputs = availableInputs(sample(), 3).filter((i) => i.from >= 0);
  assert.deepEqual(
    inputs.map((i) => [i.name, i.type, i.from]),
    [["thought", "text", 0], ["title", "text", 1], ["note", "file", 2]],
  );
});

test("availableInputs: nearest producer wins when a name is shadowed", () => {
  const steps: Step[] = [
    { type: "prompt", variable: "x", label: "", multiline: false, default: "" },
    { type: "file_picker", variable: "x", label: "", folder: "" },
    { type: "open_file", target: "{{x}}", section: "", openIn: "current" },
  ];
  const x = availableInputs(steps, 2).find((i) => i.name === "x");
  assert.deepEqual(x, { name: "x", type: "file", from: 1 });
});

test("usedInputs ignores non-templated fields and sees through filters", () => {
  const step: Step = { type: "prompt", variable: "a", label: "Use {{date}} here", multiline: false, default: "" };
  assert.deepEqual(usedInputs(step), []);
  assert.deepEqual(usedInputs({ ...step, default: "{{selection|trim}}" }), ["selection"]);
  assert.deepEqual(usedInputs(sample()[2]), ["timestamp", "title", "thought"]);
  assert.deepEqual([...namesUsedBy(sample())].sort(), ["note", "thought", "timestamp", "title"]);
});

test("cleanedInPaths takes typed and generated text, not choices, files or dates", () => {
  const steps: Step[] = [
    ...sample(),
    { type: "choice", variable: "folder", label: "", options: [] },
    { type: "fetch_page", variable: "page", titleVariable: "page_title", url: "", noUrl: "text" },
  ];
  assert.deepEqual([...cleanedInPaths(steps)].sort(), ["active_title", "clipboard", "page", "page_title", "selection", "thought", "time", "title"]);
});

test("consumersOf lists later users and stops at a re-definition", () => {
  const steps = sample();
  assert.deepEqual(consumersOf(steps, 0), [1, 2]);
  assert.deepEqual(consumersOf(steps, 2), [3]);
  steps.splice(2, 0, { type: "prompt", variable: "thought", label: "", multiline: false, default: "" });
  assert.deepEqual(consumersOf(steps, 0), [1]);
});

test("consumersOf follows each output of a step with several", () => {
  const steps: Step[] = [
    { type: "fetch_page", variable: "page", titleVariable: "page_title", url: "", noUrl: "text" },
    { type: "llm", variable: "body", model: "", system_prompt: "", user_prompt: "{{page}}", outputs: [] },
    { type: "create_file", variable: "note", path: "Ref/{{page_title|filename}}", content: "{{body}}" },
  ];
  assert.deepEqual(consumersOf(steps, 0), [1, 2]);
  assert.deepEqual(consumersOf(steps, 0, "page_title"), [2]);
  assert.equal(renameOutput(steps, 0, "page_title", "heading"), true);
  assert.equal((steps[2] as { path: string }).path, "Ref/{{heading|filename}}");
  assert.equal((steps[0] as { titleVariable: string }).titleVariable, "heading");
  assert.equal(renameOutput(steps, 0, "page", "heading"), false, "the step's other output already has the name");
});

test("renameOutput rewrites only consumers after the producer, keeping filters", () => {
  const steps = sample();
  (steps[2] as { content: string }).content = "{{thought}} {{thought|first_line|trim}} {{thoughts}}";
  assert.equal(renameOutput(steps, 0, "thought", "idea"), true);
  assert.equal((steps[0] as { variable: string }).variable, "idea");
  assert.equal((steps[1] as { user_prompt: string }).user_prompt, "{{idea}}");
  assert.equal((steps[2] as { content: string }).content, "{{idea}} {{idea|first_line|trim}} {{thoughts}}");
  assert.equal((steps[2] as { path: string }).path, "Inbox/{{timestamp}} {{title}}");
});

test("renameOutput refuses collisions, built-ins, invalid names and names the step lacks", () => {
  const steps = sample();
  assert.equal(renameOutput(steps, 0, "thought", "title"), false);
  assert.equal(renameOutput(steps, 0, "thought", "date"), false);
  assert.equal(renameOutput(steps, 0, "thought", "selection"), false);
  assert.equal(renameOutput(steps, 0, "thought", "9lives"), false);
  assert.equal(renameOutput(steps, 0, "thought", "has space"), false);
  assert.equal(renameOutput(steps, 0, "idea", "x"), false);
  assert.equal(renameOutput(steps, 3, "note", "x"), false);
  assert.deepEqual(steps, sample());
});

test("uniqueName appends a counter", () => {
  assert.equal(uniqueName("note", []), "note");
  assert.equal(uniqueName("note", ["note"]), "note2");
  assert.equal(uniqueName("note", ["note", "note2"]), "note3");
});

test("parseRefs and unknownFilters read the filter chain", () => {
  assert.deepEqual(parseRefs("a {{x}} {{y|slug|trim}}"), [
    { name: "x", filters: [], index: 2, length: 5 },
    { name: "y", filters: ["slug", "trim"], index: 8, length: 15 },
  ]);
  assert.deepEqual(unknownFilters("{{y|slug|shout}} {{z|nope}}"), ["shout", "nope"]);
});

test("resolveTemplate applies filters in order and leaves unknown names verbatim", () => {
  assert.equal(resolveTemplate("a {{x}} b {{y}}", { x: "1" }), "a 1 b {{y}}");
  assert.equal(resolveTemplate("#{{c|slug}}", { c: "Blog Post" }), "#blog-post");
  assert.equal(resolveTemplate("{{t|first_line|lower}}", { t: "\n  Call The Garage\nabout tyres" }), "call the garage");
  assert.equal(resolveTemplate("{{f|link}}", { f: "Reference Notes/ENet.md" }), "[[Reference Notes/ENet|ENet]]");
  assert.equal(resolveTemplate("{{f|link}}", { f: "a.md" }, { link: (p) => `<${p}>` }), "<a.md>");
  assert.equal(resolveTemplate("{{x|nope}}", { x: "kept" }), "kept");
});

test("resolveSegments round-trips to resolveTemplate", () => {
  const vars = { x: "1", y: "Two Words" };
  for (const t of ["{{x}}", "a {{x}} b {{y}} c", "{{z}} {{x}}", "{{y|slug}}!", "plain", ""]) {
    const segments = resolveSegments(t, vars);
    assert.equal(segments.map((s) => s.text).join(""), resolveTemplate(t, vars));
  }
  assert.deepEqual(resolveSegments("a {{x}}", vars), [{ text: "a " }, { text: "1", name: "x" }]);
});

test("resolveStep resolves each templated field the way its kind of field is", () => {
  const resolved = resolveStep(sample()[2], { timestamp: "1", title: "A: B", thought: "hi" }, { clean: (n) => n === "title" });
  assert.deepEqual(resolved, { path: "Inbox/1 A - B.md", content: "hi" });
});

test("a note's frontmatter escapes values for their quotes, and only there", () => {
  const template = '---\ntitle: "{{title}}"\naliases: [\'{{title}}\']\nnote: {{title}}\nraw: "{{title|yaml}}"\n---\n# {{title}}\n';
  const out = resolveTemplate(template, { title: 'The "what" effect\'s\nend' }, {}, "note");
  assert.equal(
    out,
    '---\ntitle: "The \\"what\\" effect\'s end"\naliases: [\'The "what" effect\'\'s end\']\nnote: The "what" effect\'s end\nraw: "The \\"what\\" effect\'s end"\n---\n# The "what" effect\'s\nend\n',
  );
  assert.equal(resolveTemplate("no frontmatter {{x}}", { x: 'a"b' }, {}, "note"), 'no frontmatter a"b');
});

test("a path cleans typed and generated values, keeps chosen folders and is normalized", () => {
  const vars = { title: "io_uring: why it exists", folder: "Projects/Work/", timestamp: "20261002", time: "13:52" };
  const clean = (name: string) => name === "title" || name === "time";
  assert.equal(resolveTemplate("Slipbox/{{timestamp}} - {{title}}", vars, { clean }, "path"), "Slipbox/20261002 - io_uring - why it exists.md");
  assert.equal(resolveTemplate("{{folder}}/{{title}}", vars, { clean }, "path"), "Projects/Work/io_uring - why it exists.md");
  assert.equal(resolveTemplate("/Inbox//{{time}}.md", vars, { clean }, "path"), "Inbox/13.52.md");
});
