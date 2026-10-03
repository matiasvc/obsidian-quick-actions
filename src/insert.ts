// Pure planning for note edits: where Insert in section puts its text, where Open file finds a
// heading, and the edits that put text in and take it out again for Undo.

// One edit to a note's text: replace [from, to) with `insert`.
export interface Splice {
  from: number;
  to: number;
  insert: string;
}

export function applySplice(content: string, s: Splice): string {
  return content.slice(0, s.from) + s.insert + content.slice(s.to);
}

const HEADING_RE = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// For each line, whether it is in the frontmatter or a fenced code block, where a line starting
// with # is not a heading. The fence lines count as code too.
function codeLines(lines: string[]): boolean[] {
  const code = lines.map(() => false);
  let i = 0;
  if (/^---\r?$/.test(lines[0] ?? "")) {
    const end = lines.findIndex((l, k) => k > 0 && /^---[ \t]*\r?$/.test(l));
    if (end > 0) for (; i <= end; i++) code[i] = true;
  }
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const m = lines[i].match(FENCE_RE);
    if (fence === null) {
      if (m) fence = m[1];
    } else if (m && m[1][0] === fence[0] && m[1].length >= fence.length && lines[i].trim() === m[1]) {
      code[i] = true;
      fence = null;
      continue;
    }
    code[i] = fence !== null;
  }
  return code;
}

// The line of a heading with this text at any level, so "## Description" finds "# Description",
// or -1. Open file puts the cursor under it.
export function findHeadingLine(lines: string[], section: string): number {
  const wanted = section.replace(/^#+\s*/, "").trim();
  const code = codeLines(lines);
  return lines.findIndex((l, i) => !code[i] && l.match(HEADING_RE)?.[1] === wanted);
}

export interface InsertSpot {
  lines: string[];
  at: number; // the inserted text becomes line `at`
}

// The section is the whole heading line ("## Logs"), so its level must match too.
export function findInsertSpot(content: string, section: string, position: "beginning" | "end"): InsertSpot | { error: string } {
  const lines = content.split("\n");
  const code = codeLines(lines);
  const sectionLevel = section.match(/^(#+)/)?.[1].length ?? 1;
  const sectionIndex = lines.findIndex((l, i) => !code[i] && l.trimEnd() === section);
  if (sectionIndex === -1) return { error: `Section "${section}" not found` };
  if (position === "beginning") return { lines, at: sectionIndex + 1 };
  // Before the next heading of the same or higher level, or the end of the file,
  // skipping trailing blank lines so the entry sits right after the content.
  let at = lines.length;
  for (let i = sectionIndex + 1; i < lines.length; i++) {
    if (code[i]) continue;
    const heading = lines[i].match(/^(#+)\s/);
    if (heading && heading[1].length <= sectionLevel) {
      at = i;
      break;
    }
  }
  while (at > sectionIndex + 1 && lines[at - 1].trim() === "") at--;
  return { lines, at };
}

// The insertion as one splice, which an editor can apply without replacing the rest of the note.
export function insertEdit(spot: InsertSpot, text: string): Splice {
  let offset = 0;
  for (let i = 0; i < spot.at && i < spot.lines.length; i++) offset += spot.lines[i].length + 1;
  if (spot.at < spot.lines.length) return { from: offset, to: offset, insert: text + "\n" };
  return { from: offset - 1, to: offset - 1, insert: "\n" + text };
}

export interface InsertPreview {
  start: number; // the first line shown, 0-based
  lines: string[];
  added: number; // index in `lines` of the first inserted line
  count: number; // how many lines are inserted
}

// The lines around the insert point as they will read afterwards, for the test run preview.
export function insertContext(spot: InsertSpot, text: string): InsertPreview {
  const around = 2;
  const start = Math.max(0, spot.at - around);
  const before = spot.lines.slice(start, spot.at);
  const inserted = text.split("\n");
  const after = spot.lines.slice(spot.at, spot.at + around);
  return { start, lines: [...before, ...inserted, ...after], added: before.length, count: inserted.length };
}

// The splice that removes `text` (one or more whole lines, plus a line break) where it sits nearest
// line `near`, or null once it is gone. Undo applies exactly that.
export function findInserted(content: string, text: string, near: number): Splice | null {
  const lines = content.split("\n");
  const count = text.split("\n").length;
  let best = -1;
  for (let i = 0; i + count <= lines.length; i++) {
    if (lines.slice(i, i + count).join("\n") !== text) continue;
    if (best === -1 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  if (best === -1) return null;
  let from = 0;
  for (let i = 0; i < best; i++) from += lines[i].length + 1;
  const end = from + text.length;
  // Take the line break after it, or before it when it is the last line.
  if (end < content.length) return { from, to: end + 1, insert: "" };
  return { from: Math.max(0, from - 1), to: end, insert: "" };
}
