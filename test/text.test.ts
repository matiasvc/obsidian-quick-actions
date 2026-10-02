import { test } from "node:test";
import assert from "node:assert/strict";
import { FILTERS, applyFilter, findUrl, frontmatterEnd, notePath, quoteContext, safeFileName, slugify } from "../src/text";

test("every filter's example is what it does", () => {
  for (const f of FILTERS) {
    const input = f.example[0].replace(" ⏎ ", "\n");
    const expected = f.id === "link" ? "[[Reference Notes/ENet|ENet]]" : f.example[1];
    assert.equal(applyFilter(f.id, input), expected, f.id);
  }
});

test("slugify keeps letters from any language and joins words with dashes", () => {
  assert.equal(slugify("Social Media Post"), "social-media-post");
  assert.equal(slugify("  Café / Ørsted!  "), "cafe-ørsted");
  assert.equal(slugify("C++ & Rust"), "c-rust");
});

test("safeFileName turns separators into dashes and drops what file names and links can't hold", () => {
  assert.equal(safeFileName("io_uring: why it exists"), "io_uring - why it exists");
  assert.equal(safeFileName('"CPU vs GPU / SIMD?"\n'), "CPU vs GPU - SIMD");
  assert.equal(safeFileName("[[Link]] #tag ^block | pipe"), "Link tag block pipe");
  assert.equal(safeFileName(" ..hidden. "), "hidden");
  assert.equal(safeFileName("Named Boolean"), "Named Boolean");
  assert.equal(safeFileName("Standup 09:30"), "Standup 09.30");
});

test("notePath reads a path the way Obsidian's normalizePath does, and adds .md", () => {
  assert.equal(notePath("/Projects//Work/note/"), "Projects/Work/note.md");
  assert.equal(notePath("Inbox\\x.md"), "Inbox/x.md");
  assert.equal(notePath(`A${String.fromCharCode(0xa0)}B`), "A B.md");
});

test("quoteContext tells quoted scalars from apostrophes in plain text", () => {
  assert.equal(quoteContext('title: "'), "double");
  assert.equal(quoteContext("aliases: ['"), "single");
  assert.equal(quoteContext('tags: ["a", "'), "double");
  assert.equal(quoteContext('title: "done" and '), "plain");
  assert.equal(quoteContext("title: don't "), "plain");
  assert.equal(quoteContext('title: "say \\"hi\\" to '), "double");
  assert.equal(quoteContext("- '"), "single");
});

test("frontmatterEnd finds the closing line, or -1", () => {
  const text = "---\ntitle: x\n---\nbody";
  assert.equal(text.slice(frontmatterEnd(text)), "\n---\nbody");
  assert.equal(frontmatterEnd("---\ntitle: x\n---"), 12);
  assert.equal(frontmatterEnd("no frontmatter\n---\n"), -1);
  assert.equal(frontmatterEnd("---\nnever closed"), -1);
});

test("findUrl takes the first URL without trailing punctuation", () => {
  assert.equal(findUrl("Read https://example.com/a?b=1. Then more"), "https://example.com/a?b=1");
  assert.equal(findUrl("(see https://en.wikipedia.org/wiki/Fish_(food))"), "https://en.wikipedia.org/wiki/Fish_(food)");
  assert.equal(findUrl("(see https://example.com/x)"), "https://example.com/x");
  assert.equal(findUrl("no link here"), null);
});
