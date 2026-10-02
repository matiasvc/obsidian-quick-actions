import { test } from "node:test";
import assert from "node:assert/strict";
import { FILTERS, applyFilter, findUrl, frontmatterEnd, notePath, quoteContext, safeFileName, slugify, sourceList, stripCitations } from "../src/text";

test("sourceList lists each page once as a link, without OpenAI's tag", () => {
  assert.equal(
    sourceList([
      { url: "https://obsidian.md/changelog/?utm_source=openai", title: "Obsidian Changelog" },
      { url: "https://obsidian.md/changelog/" },
      { url: "https://a.com/x?id=1&utm_source=openai" },
      { url: "https://a.com/x?utm_source=openai&id=1", title: "[Draft] A" },
      { url: "https://en.wikipedia.org/wiki/Cache_(computing)", title: "Cache" },
    ]),
    [
      "- [Obsidian Changelog](https://obsidian.md/changelog/)",
      "- [Draft A](https://a.com/x?id=1)",
      "- [Cache](https://en.wikipedia.org/wiki/Cache_%28computing%29)",
    ].join("\n"),
  );
  assert.equal(sourceList([{ url: "https://b.org" }]), "- https://b.org");
  assert.equal(sourceList([{ url: `https://c.org/a b${String.fromCharCode(0xa0)}c` }]), "- https://c.org/a%20b%C2%A0c");
  assert.equal(sourceList([]), "");
});

test("stripCitations cuts OpenAI's inline citation links, and only links", () => {
  const text = "Version 1.14.4, published October 1. ([obsidian.md](https://obsidian.md/changelog/?utm_source=openai))";
  assert.equal(stripCitations(text, [{ start_index: 37, end_index: text.length }]), "Version 1.14.4, published October 1.");
  const json = '{"version":"1.14.4 ([obsidian.md](https://obsidian.md/))","date":"2026-10-01"}';
  const start = json.indexOf(" (") + 1;
  assert.equal(stripCitations(json, [{ start_index: start, end_index: json.indexOf('","date') }]), '{"version":"1.14.4","date":"2026-10-01"}');
  assert.equal(stripCitations("Plain words here", [{ start_index: 6, end_index: 11 }]), "Plain words here");
  assert.equal(stripCitations("A ([x](u)) and B ([y](v))", [{ start_index: 2, end_index: 10 }, { start_index: 17, end_index: 25 }]), "A and B");
  // Offsets as gpt-4.1-mini and gpt-6-luna gave them: code points, so each emoji counts once.
  const emoji = "🚀😀🎉 Newest is 1.14.4. ([obsidian.md](https://obsidian.md/changelog/))";
  assert.equal(stripCitations(emoji, [{ start_index: 22, end_index: 69 }]), "🚀😀🎉 Newest is 1.14.4.");
});

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
  // A path to a file that exists, such as a picked image, keeps its extension.
  const exists = (p: string) => p === "Files/scan.png";
  assert.equal(notePath("Files/scan.png", exists), "Files/scan.png");
  assert.equal(notePath("Files/new", exists), "Files/new.md");
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
