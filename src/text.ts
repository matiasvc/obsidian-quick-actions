// Pure text helpers: the value filters, file name cleaning, YAML escaping, URL finding and model
// source lists.
import { Page } from "./types";

export interface FilterDef {
  id: string;
  desc: string;
  example: [string, string];
  apply: (value: string, link: (path: string) => string) => string;
}

// In the order the filter menu lists them.
export const FILTERS: FilterDef[] = [
  { id: "slug", desc: "Lowercase words joined by dashes, for tags", example: ["Blog Post", "blog-post"], apply: (v) => slugify(v) },
  { id: "lower", desc: "Lowercase", example: ["Paper", "paper"], apply: (v) => v.toLowerCase() },
  { id: "trim", desc: "No spaces or blank lines at either end", example: ["  Paper  ", "Paper"], apply: (v) => v.trim() },
  { id: "first_line", desc: "The first line that has text", example: ["Call the garage ⏎ about the tyres", "Call the garage"], apply: (v) => firstLine(v) },
  { id: "filename", desc: "Safe to use in a file name", example: ["io_uring: why it exists", "io_uring - why it exists"], apply: (v) => safeFileName(v) },
  { id: "yaml", desc: "Escaped for a double-quoted frontmatter value", example: ['The "what" effect', 'The \\"what\\" effect'], apply: (v) => escapeYaml(v, "double") },
  { id: "link", desc: "A file as a link to it", example: ["Reference Notes/ENet.md", "[[ENet]]"], apply: (v, link) => (v ? link(v) : v) },
];

export function isFilter(id: string): boolean {
  return FILTERS.some((f) => f.id === id);
}

// Unknown filters leave the value as it is. The editor marks them.
export function applyFilter(id: string, value: string, link: (path: string) => string = pathToLink): string {
  return FILTERS.find((f) => f.id === id)?.apply(value, link) ?? value;
}

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
}

// Obsidian refuses \ / : in a file name, Windows and Android also * ? " < > |, and links break
// on [ ] # ^. A colon between digits, as in a time, becomes a dot. A colon or slash between words
// becomes a dash so the words stay apart.
export function safeFileName(text: string): string {
  return text
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/(\d):(\d)/g, "$1.$2")
    .replace(/\s*[:\\/]\s*/g, " - ")
    .replace(/[*?"<>|[\]#^]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+|[\s.]+$/g, "");
}

// The note a resolved path names, read the way Obsidian's normalizePath reads paths: slashes
// collapsed and trimmed, non-breaking spaces as spaces, and ".md" added when missing. A path that
// `exists` says names a file already, such as a picked image or PDF, keeps its own extension.
export function notePath(path: string, exists?: (path: string) => boolean): string {
  const p = path
    .replace(/[\\/]+/g, "/")
    .replace(/^\/|\/$/g, "")
    .replace(/\p{Zs}/gu, " ")
    .normalize("NFC");
  return p.endsWith(".md") || exists?.(p) ? p : p + ".md";
}

// The fallback link when there is no app to ask: the full path, shown as the file's name.
export function pathToLink(path: string): string {
  const noExt = path.replace(/\.md$/, "");
  const base = noExt.split("/").pop() ?? noExt;
  return noExt === base ? `[[${noExt}]]` : `[[${noExt}|${base}]]`;
}

export type QuoteContext = "double" | "single" | "plain";

// Whether the end of `before` (a frontmatter line up to a reference) sits inside a quoted scalar.
// A quote only opens a scalar where a value starts, so the apostrophe in `don't` is plain text.
export function quoteContext(before: string): QuoteContext {
  let state: QuoteContext = "plain";
  let lastSignificant = "";
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (state === "double") {
      if (ch === "\\") i++;
      else if (ch === '"') state = "plain";
    } else if (state === "single") {
      if (ch === "'" && before[i + 1] === "'") i++;
      else if (ch === "'") state = "plain";
    } else if ((ch === '"' || ch === "'") && ["", ":", "[", ",", "-", "{"].includes(lastSignificant)) {
      state = ch === '"' ? "double" : "single";
    }
    if (ch.trim() !== "") lastSignificant = state === "plain" ? ch : lastSignificant;
  }
  return state;
}

export function escapeYaml(value: string, context: QuoteContext): string {
  const line = value.replace(/\s*[\r\n]+\s*/g, " ");
  if (context === "double") return line.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (context === "single") return line.replace(/'/g, "''");
  return line;
}

// Where the frontmatter block ends (the start of its closing --- line), or -1 when there is none.
export function frontmatterEnd(text: string): number {
  if (!/^---\r?\n/.test(text)) return -1;
  const m = /\r?\n---[ \t]*(\r?\n|$)/.exec(text.slice(3));
  return m ? m.index + 3 : -1;
}

// The first http(s) URL in a value, without trailing sentence punctuation.
export function findUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"'`]+/.exec(text);
  if (!m) return null;
  let url = m[0].replace(/[.,;:!?]+$/, "");
  // Keep a closing bracket only when the URL opened one, as in Wikipedia titles.
  while (/[)\]]$/.test(url)) {
    const close = url.slice(-1);
    const open = close === ")" ? "(" : "[";
    if (url.split(open).length >= url.split(close).length) break;
    url = url.slice(0, -1);
  }
  return url;
}

// Pages as a Markdown list of links, each page once. OpenAI tags its links with
// utm_source=openai, which is dropped. Parentheses and spaces in a URL are escaped so the link
// holds together, and brackets in a title are dropped.
export function sourceList(pages: Page[]): string {
  const titles = new Map<string, string>();
  for (const p of pages) {
    const url = p.url
      .replace(/([?&])utm_source=openai(?:&|$)/, "$1")
      .replace(/[?&]$/, "")
      .replace(/\s/g, encodeURIComponent)
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29");
    const title = (p.title ?? "").replace(/[[\]]/g, "").trim();
    if (!titles.get(url)) titles.set(url, title);
  }
  return [...titles].map(([url, title]) => (title ? `- [${title}](${url})` : `- ${url}`)).join("\n");
}

// Text without the citation links OpenAI writes into it at each mark's offsets, and the space
// before each. The offsets count code points, so an emoji counts as one. A range is only cut when
// it holds a link, in case the offsets are off.
export function stripCitations(text: string, marks: { start_index?: number; end_index?: number }[]): string {
  const ranges = marks.filter((m) => m.start_index !== undefined && m.end_index !== undefined) as { start_index: number; end_index: number }[];
  let chars = Array.from(text);
  for (const m of ranges.sort((a, b) => b.start_index - a.start_index)) {
    if (!chars.slice(m.start_index, m.end_index).join("").includes("](")) continue;
    const start = chars[m.start_index - 1] === " " ? m.start_index - 1 : m.start_index;
    chars = [...chars.slice(0, start), ...chars.slice(m.end_index)];
  }
  return chars.join("");
}
