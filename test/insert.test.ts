import { test } from "node:test";
import assert from "node:assert/strict";
import { applySplice, findHeadingLine, findInsertSpot, findInserted, insertContext, insertEdit } from "../src/insert";

const LOG = "---\ntitle: Work\n---\n\n# Description\nText\n\n# Logs\n- old 1\n- old 2\n\n# Notes\nN\n";

function spot(content: string, section: string, position: "beginning" | "end") {
  const s = findInsertSpot(content, section, position);
  if ("error" in s) throw new Error(s.error);
  return s;
}

function insert(content: string, section: string, position: "beginning" | "end", text: string): string {
  return applySplice(content, insertEdit(spot(content, section, position), text));
}

test("beginning goes right under the heading, end after the last line of content", () => {
  assert.equal(insert(LOG, "# Logs", "beginning", "- new"), LOG.replace("# Logs\n", "# Logs\n- new\n"));
  assert.equal(insert(LOG, "# Logs", "end", "- new"), LOG.replace("- old 2\n", "- old 2\n- new\n"));
});

test("end stops at a heading of the same level and not at a deeper one", () => {
  assert.equal(insert("# A\n## Sub\nx\n# B\n", "# A", "end", "y"), "# A\n## Sub\nx\ny\n# B\n");
});

test("a section at the end of a file without a final newline", () => {
  assert.equal(insert("# Log\n- a", "# Log", "end", "- b"), "# Log\n- a\n- b");
});

test("the edit equals splicing the line in", () => {
  for (const [section, position] of [["# Logs", "beginning"], ["# Logs", "end"], ["# Notes", "end"], ["# Description", "end"]] as const) {
    const s = spot(LOG, section, position);
    const lines = [...s.lines];
    lines.splice(s.at, 0, "- new");
    assert.equal(applySplice(LOG, insertEdit(s, "- new")), lines.join("\n"), `${section} ${position}`);
  }
  assert.deepEqual(insertEdit(spot("# Log\n- a", "# Log", "end"), "- b"), { from: 9, to: 9, insert: "\n- b" });
});

test("a missing section is an error", () => {
  assert.deepEqual(findInsertSpot(LOG, "# Log", "end"), { error: 'Section "# Log" not found' });
});

test("headings: insert matches the whole line, open matches the text at any level", () => {
  const text = "# Summary\n## C#\n### Notes ###\n# Description";
  assert.equal(spot(text, "## C#", "beginning").at, 2);
  assert.deepEqual(findInsertSpot(text, "# C#", "beginning"), { error: 'Section "# C#" not found' });
  const lines = text.split("\n");
  assert.equal(findHeadingLine(lines, "## C#"), 1);
  assert.equal(findHeadingLine(lines, "Notes"), 2);
  assert.equal(findHeadingLine(lines, "## Description"), 3);
  assert.equal(findHeadingLine(lines, "Missing"), -1);
});

test("a # line in fenced code or frontmatter is not a heading", () => {
  const note = "# Log\n- 09:00\n```bash\n# rebuild\nmake\n```\n- 10:00\n# Notes\n";
  assert.equal(insert(note, "# Log", "end", "- 11:00"), note.replace("- 10:00\n", "- 10:00\n- 11:00\n"));
  const fenced = "~~~\n# Notes\n~~~\n\n# Notes\nN";
  assert.equal(spot(fenced, "# Notes", "beginning").at, 5);
  assert.equal(findHeadingLine(fenced.split("\n"), "Notes"), 4);
  assert.equal(findHeadingLine("---\n# not a heading\n---\n# Heading".split("\n"), "not a heading"), -1);
});

test("the preview shows the lines around the new one", () => {
  const preview = insertContext(spot(LOG, "# Logs", "beginning"), "- new\n- also");
  assert.deepEqual(preview, { start: 6, lines: ["", "# Logs", "- new", "- also", "- old 1", "- old 2"], added: 2, count: 2 });
});

test("undo finds the inserted line nearest where it went and takes its line break", () => {
  const s = spot(LOG, "# Logs", "beginning");
  const after = applySplice(LOG, insertEdit(s, "- new"));
  const range = findInserted(after, "- new", s.at);
  assert.ok(range);
  assert.equal(applySplice(after, range), LOG);

  const twice = "# A\n- x\n# B\n- x\n";
  const near = findInserted(twice, "- x", 3);
  assert.ok(near);
  assert.equal(applySplice(twice, near), "# A\n- x\n# B\n");

  const last = findInserted("# Log\n- a\n- b", "- b", 2);
  assert.ok(last);
  assert.equal(applySplice("# Log\n- a\n- b", last), "# Log\n- a");
  assert.equal(findInserted(LOG, "- gone", 3), null);
});
