import { test } from "node:test";
import assert from "node:assert/strict";
import { Step } from "../src/types";
import { blocksOf, exclusive, moveSteps, placeOf, removeBranch, repairBlocks, skipMarkers, stepNumbers, testPasses, unwrapBlock } from "../src/flow";
import { stepTitle, stepWith, templatedFields } from "../src/steps";
import { availableInputs, cleanedInPaths, consumersOf, copySteps, renameOutput } from "../src/variables";

// Like Capture Fleeting Note, plus a `summary` only the first branch sets.
function capture(): Step[] {
  return [
    stepWith("prompt", { variable: "thought" }),
    stepWith("fetch_page", { url: "{{thought}}" }),
    stepWith("if", { tests: [{ value: "{{page_title}}", op: "filled", text: "" }] }),
    stepWith("set_value", { variable: "title", value: "{{page_title}}" }),
    stepWith("set_value", { variable: "summary", value: "{{page|first_line}}" }),
    { type: "else" },
    stepWith("set_value", { variable: "title", value: "{{date}} {{time}}" }),
    { type: "end_if" },
    stepWith("create_file", { path: "Inbox/F-{{timestamp}}", content: "title: {{title}}\n{{summary}}" }),
  ];
}

const names = (steps: Step[], i: number) => availableInputs(steps, i).filter((x) => x.from >= 0);

test("blocksOf and placeOf find a block, its branches and where each step sits", () => {
  const steps = capture();
  assert.deepEqual([...blocksOf(steps).values()], [{ start: 2, branches: [2, 5], end: 7 }]);
  assert.equal(placeOf(steps, 1), null);
  assert.equal(placeOf(steps, 3)?.branch, 0);
  assert.equal(placeOf(steps, 6)?.branch, 1);
  assert.equal(placeOf(steps, 7), null);
  assert.deepEqual(stepNumbers(steps), [1, 2, 3, 4, 5, 0, 6, 0, 7]);
  assert.equal(exclusive(steps, 3, 6), true);
  assert.equal(exclusive(steps, 3, 4), false);
  assert.equal(exclusive(steps, 1, 6), false);
});

test("skipMarkers leaves a block when the branch that ran reaches the next one", () => {
  const steps = capture();
  assert.equal(skipMarkers(steps, 5), 8);
  assert.equal(skipMarkers(steps, 7), 8);
  assert.equal(skipMarkers(steps, 3), 3);
});

test("repairBlocks drops stray markers and closes open blocks", () => {
  const broken: Step[] = [{ type: "else" }, stepWith("if"), { type: "else" }, { type: "else" }, { type: "else_if", match: "all", tests: [] }, stepWith("set_value")];
  assert.deepEqual(repairBlocks(broken).map((s) => s.type), ["if", "else", "set_value", "end_if"]);
  assert.deepEqual(repairBlocks([{ type: "end_if" }, stepWith("prompt")]).map((s) => s.type), ["prompt"]);
});

test("a branch sees its own values, and after the block a name not every branch sets is maybe", () => {
  const steps = capture();
  assert.deepEqual(names(steps, 4).map((x) => x.name), ["thought", "page", "page_title", "title"]);
  // The Else branch can't see what the first branch set.
  assert.deepEqual(names(steps, 6).map((x) => x.name), ["thought", "page", "page_title"]);
  const after = names(steps, 8);
  const title = after.find((x) => x.name === "title");
  const summary = after.find((x) => x.name === "summary");
  assert.equal(title?.maybe, undefined);
  assert.deepEqual(title?.sources, [3, 6]);
  assert.equal(summary?.maybe, true);
  // Without an Else, nothing a branch sets is certain.
  const noElse = capture().filter((s) => s.type !== "else");
  assert.equal(names(noElse, 7).find((x) => x.name === "title")?.maybe, true);
});

test("a value set before a block and overridden in one branch still comes from the step before", () => {
  const steps: Step[] = [
    stepWith("prompt", { variable: "title" }),
    stepWith("if", { tests: [{ value: "{{title}}", op: "empty", text: "" }] }),
    stepWith("set_value", { variable: "title", value: "Untitled" }),
    { type: "end_if" },
    stepWith("create_file", { path: "Inbox/{{title}}" }),
  ];
  const title = names(steps, 4).find((x) => x.name === "title");
  assert.deepEqual(title?.sources, [2, 0]);
  assert.equal(title?.maybe, undefined);
  assert.deepEqual(consumersOf(steps, 0, "title"), [1, 4]);
});

test("an If's tests are templated fields, and consumers and renames follow every branch", () => {
  const steps = capture();
  assert.deepEqual(templatedFields(steps[2]).map((f) => f.key), ["tests.0.value", "tests.0.text"]);
  assert.equal(stepTitle(steps[2], []), "If page_title has text");
  assert.deepEqual(consumersOf(steps, 1, "page_title"), [2, 3]);
  assert.deepEqual(consumersOf(steps, 3), [8]);
  assert.deepEqual(consumersOf(steps, 6), [8]);
  // Renaming one branch's title alone would cut Create file off from the first branch.
  assert.equal(renameOutput(steps, 6, "title", "summary"), false);
  // Renaming a title renames the other branch's with it.
  assert.equal(renameOutput(steps, 3, "title", "heading"), true);
  assert.equal((steps[6] as { variable: string }).variable, "heading");
  assert.equal((steps[8] as { content: string }).content, "title: {{heading}}\n{{summary}}");
  assert.equal(renameOutput(steps, 0, "thought", "page"), false);
  assert.equal(renameOutput(steps, 1, "page_title", "heading2"), true);
  assert.equal((steps[2] as { tests: { value: string }[] }).tests[0].value, "{{heading2}}");
  assert.equal((steps[3] as { value: string }).value, "{{heading2}}");
});

test("a rename that would hide another step's value is refused, and one that joins branches is allowed", () => {
  const shadow: Step[] = [
    stepWith("prompt", { variable: "thought" }),
    stepWith("set_value", { variable: "title", value: "x" }),
    stepWith("create_file", { path: "a", content: "{{thought}} / {{title}}" }),
  ];
  assert.equal(renameOutput(shadow, 1, "title", "thought"), false);
  assert.equal(renameOutput(shadow, 0, "thought", "title"), false);
  const join: Step[] = [
    stepWith("if", { tests: [{ value: "{{selection}}", op: "filled", text: "" }] }),
    stepWith("set_value", { variable: "title", value: "{{selection}}" }),
    { type: "else" },
    stepWith("set_value", { variable: "value", value: "{{date}}" }),
    { type: "end_if" },
    stepWith("create_file", { path: "Inbox/{{title}}" }),
  ];
  assert.equal(renameOutput(join, 3, "value", "title"), true);
  assert.equal(names(join, 5).find((x) => x.name === "title")?.maybe, undefined);
});

test("a path cleans generated text but not a file value, even through a Set a value", () => {
  const steps: Step[] = [
    stepWith("file_picker", { variable: "file" }),
    stepWith("if", { tests: [{ value: "{{file}}", op: "empty", text: "" }] }),
    stepWith("set_value", { variable: "file", value: "Logs/Default" }),
    { type: "end_if" },
    stepWith("set_value", { variable: "target", value: "{{file}}" }),
    stepWith("set_value", { variable: "title", value: "{{selection}}" }),
  ];
  const clean = cleanedInPaths(steps);
  assert.equal(clean.has("file"), false);
  assert.equal(clean.has("target"), false);
  assert.equal(clean.has("title"), true);
});

test("copySteps gives a copied block fresh names and points its references at them", () => {
  const steps: Step[] = [
    stepWith("if", { tests: [{ value: "{{selection}}", op: "filled", text: "" }] }),
    stepWith("fetch_page", { url: "{{selection}}" }),
    stepWith("set_value", { variable: "title", value: "{{page_title}}" }),
    stepWith("create_file", { path: "Inbox/{{page_title}}" }),
    { type: "end_if" },
  ];
  const copies = copySteps(steps, 0, 4);
  assert.equal((copies[1] as { titleVariable: string }).titleVariable, "page_title2");
  assert.equal((copies[2] as { value: string; variable: string }).value, "{{page_title2}}");
  assert.equal((copies[2] as { variable: string }).variable, "title");
  assert.equal((copies[3] as { path: string }).path, "Inbox/{{page_title2}}");
  assert.equal((copies[3] as { variable: string }).variable, "note2");
  // A lone Set a value gets a fresh name like any other step.
  assert.equal((copySteps(steps, 2, 2)[0] as { variable: string }).variable, "title2");
});

test("testPasses compares without regard to case or surrounding spaces", () => {
  assert.equal(testPasses("filled", "  ", ""), false);
  assert.equal(testPasses("empty", "", ""), true);
  assert.equal(testPasses("is", " Article ", "article"), true);
  assert.equal(testPasses("is_not", "Video", "article"), true);
  assert.equal(testPasses("contains", "https://x.com/a", "X.COM"), true);
  assert.equal(testPasses("not_contains", "Just a moment...", "just a moment"), false);
  assert.equal(testPasses("matches", "https://youtu.be/abc", "^https://(www\\.)?youtu"), true);
  assert.equal(testPasses("matches", "  https://youtu.be/abc\n", "^https://\\S+$"), true);
  assert.throws(() => testPasses("matches", "x", "("));
});

test("moveSteps moves a whole block, and not into itself", () => {
  const steps = capture();
  assert.equal(moveSteps(steps, 2, 3), -1);
  assert.equal(moveSteps(steps, 2, 0), 0);
  assert.deepEqual(steps.map((s) => s.type).slice(0, 7), ["if", "set_value", "set_value", "else", "set_value", "end_if", "prompt"]);
  const steps2 = capture();
  moveSteps(steps2, 8, 6); // the create step into the Else branch
  assert.equal(placeOf(steps2, 6)?.branch, 1);
  assert.equal(steps2[6].type, "create_file");
});

test("removeBranch keeps the branch's steps after the block, and unwrapBlock keeps every step", () => {
  const steps = capture();
  assert.equal(removeBranch(steps, 5).length, 1);
  assert.deepEqual(steps.map((s) => s.type), ["prompt", "fetch_page", "if", "set_value", "set_value", "end_if", "set_value", "create_file"]);
  const steps2 = capture();
  unwrapBlock(steps2, 2);
  assert.deepEqual(steps2.map((s) => s.type), ["prompt", "fetch_page", "set_value", "set_value", "set_value", "create_file"]);
});
