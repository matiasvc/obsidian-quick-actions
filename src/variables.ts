// Pure functions over the {{name|filter}} variable grammar: what is available at a
// step, what a step uses, renaming an output, and resolving templates.
import { OutputType, Step } from "./types";
import { STEP_DEFS, ResolveMode, outputsOf, setOutputName, templatedFields } from "./steps";
import { applyFilter, escapeYaml, frontmatterEnd, isFilter, notePath, quoteContext, safeFileName } from "./text";

// {{name}} or {{name|filter|filter}}. Every reader of templates goes through this.
export const VAR_RE = /\{\{(\w+)((?:\|\w+)*)\}\}/g;

export interface VarRef {
  name: string;
  filters: string[];
  index: number; // where the reference starts in the template
  length: number;
}

export interface InputInfo {
  name: string;
  type: OutputType;
  from: number; // step index, or -1 for a built-in
}

export interface BuiltinInfo extends InputInfo {
  source: string; // where the value comes from, for the picker and the In band
  sample: string;
  cleanInPath: boolean; // a path makes it safe for a file name
}

export const BUILTINS: readonly BuiltinInfo[] = [
  { name: "date", type: "text", from: -1, source: "Today", sample: "2026-09-04", cleanInPath: false },
  { name: "time", type: "text", from: -1, source: "Now", sample: "13:52", cleanInPath: true },
  { name: "timestamp", type: "text", from: -1, source: "Now, for file names", sample: "20260904135200", cleanInPath: false },
  { name: "selection", type: "text", from: -1, source: "The text selected in the note you were in", sample: "io_uring was added because…", cleanInPath: true },
  { name: "clipboard", type: "text", from: -1, source: "What you last copied", sample: "https://example.com/article", cleanInPath: true },
  { name: "active_note", type: "file", from: -1, source: "The note you were in", sample: "Logs/Work Focus.md", cleanInPath: false },
  { name: "active_title", type: "text", from: -1, source: "The name of the note you were in", sample: "Work Focus", cleanInPath: true },
];

export function isBuiltin(name: string): boolean {
  return BUILTINS.some((b) => b.name === name);
}

export function isValidName(name: string): boolean {
  return /^[A-Za-z_]\w*$/.test(name);
}

export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!set.has(candidate)) return candidate;
  }
}

export function formatRef(name: string, filters: string[] = []): string {
  return `{{${[name, ...filters].join("|")}}}`;
}

// "|slug|trim" or "slug|trim" to its filter names.
export function splitChain(chain: string | null | undefined): string[] {
  return chain ? chain.split("|").filter((f) => f !== "") : [];
}

export function parseRefs(template: string): VarRef[] {
  const refs: VarRef[] = [];
  for (const m of template.matchAll(VAR_RE)) {
    refs.push({ name: m[1], filters: splitChain(m[2]), index: m.index ?? 0, length: m[0].length });
  }
  return refs;
}

export function producedNames(steps: Step[]): string[] {
  return steps.flatMap((s) => outputsOf(s).map((o) => o.name));
}

// Built-ins plus the outputs of steps 0..i-1. When two earlier steps produce
// the same name the nearest producer wins.
export function availableInputs(steps: Step[], i: number): InputInfo[] {
  const byName = new Map<string, InputInfo>();
  for (const b of BUILTINS) byName.set(b.name, b);
  for (let j = 0; j < Math.min(i, steps.length); j++) {
    for (const out of outputsOf(steps[j])) byName.set(out.name, { name: out.name, type: out.type, from: j });
  }
  return [...byName.values()];
}

export function referencedNames(text: string): string[] {
  return [...new Set(parseRefs(text).map((r) => r.name))];
}

export function usedInputs(step: Step): string[] {
  return [...new Set(templatedFields(step).flatMap((f) => referencedNames(f.value)))];
}

// Every name the action's templates read, so a run only reads the clipboard when something uses it.
export function namesUsedBy(steps: Step[]): Set<string> {
  return new Set(steps.flatMap(usedInputs));
}

// Unknown filter names in a template.
export function unknownFilters(template: string): string[] {
  return [...new Set(parseRefs(template).flatMap((r) => r.filters.filter((f) => !isFilter(f))))];
}

// Names whose values a path makes safe for a file name: the outputs of steps that produce typed
// or generated text, and the built-ins marked for it.
export function cleanedInPaths(steps: Step[]): Set<string> {
  const names = new Set(BUILTINS.filter((b) => b.cleanInPath).map((b) => b.name));
  for (const s of steps) {
    if (STEP_DEFS[s.type].cleanInPath) for (const o of outputsOf(s)) names.add(o.name);
  }
  return names;
}

// Indices of later steps that read the producer's output `name`, or any of its outputs when
// `name` is omitted. Each name stops at a step that re-defines it, since consumers past it see that one.
export function consumersOf(steps: Step[], producer: number, name?: string): number[] {
  const names = name === undefined ? outputsOf(steps[producer]).map((o) => o.name) : [name];
  const result = new Set<number>();
  for (const n of names) {
    for (let j = producer + 1; j < steps.length; j++) {
      if (usedInputs(steps[j]).includes(n)) result.add(j);
      if (outputsOf(steps[j]).some((o) => o.name === n)) break;
    }
  }
  return [...result].sort((a, b) => a - b);
}

// Renames one of a producer's outputs and rewrites every consumer, keeping their filters. Returns
// false, changing nothing, when the name is invalid, built-in, or produced by another step or
// another output of this one.
export function renameOutput(steps: Step[], producer: number, from: string, to: string): boolean {
  const step = steps[producer];
  const outs = outputsOf(step);
  if (!outs.some((o) => o.name === from)) return false;
  if (to === from) return true;
  if (!isValidName(to) || isBuiltin(to)) return false;
  if (outs.some((o) => o.name === to)) return false;
  for (let j = 0; j < steps.length; j++) {
    if (j !== producer && outputsOf(steps[j]).some((o) => o.name === to)) return false;
  }
  for (const j of consumersOf(steps, producer, from)) {
    const target = steps[j] as unknown as Record<string, unknown>;
    for (const f of templatedFields(steps[j])) {
      target[f.key] = f.value.replace(VAR_RE, (match: string, name: string, chain: string) => (name === from ? formatRef(to, splitChain(chain)) : match));
    }
  }
  setOutputName(step, from, to);
  return true;
}

export interface ResolveOptions {
  // Turns a file path into a link for the `link` filter. Defaults to a path link.
  link?: (path: string) => string;
  // Whether a value is cleaned for file names in a path field. Nothing is cleaned without it.
  clean?: (name: string) => boolean;
  // Whether a vault file has this path, so a path naming an image or PDF gets no ".md".
  exists?: (path: string) => boolean;
}

// How each substituted value is finished for the kind of field it lands in. A path cleans the
// values `clean` names, so a colon or slash in a title can't fail the step or add a folder. A note
// escapes each value in its frontmatter for the quotes around it, so a title with a double quote
// still gives valid YAML. A `yaml` filter has already done that.
function finisher(template: string, mode: ResolveMode, opts: ResolveOptions): ((value: string, ref: VarRef) => string) | null {
  if (mode === "path") {
    const clean = opts.clean;
    return clean ? (value, ref) => (clean(ref.name) ? safeFileName(value) : value) : null;
  }
  if (mode === "note") {
    const end = frontmatterEnd(template);
    if (end < 0) return null;
    return (value, ref) => {
      if (ref.index >= end || ref.filters.includes("yaml")) return value;
      const lineStart = template.lastIndexOf("\n", ref.index - 1) + 1;
      return escapeYaml(value, quoteContext(template.slice(lineStart, ref.index)));
    };
  }
  return null;
}

function substitute(ref: VarRef, vars: Record<string, string>, opts: ResolveOptions, finish: ((value: string, ref: VarRef) => string) | null): string {
  let value = vars[ref.name];
  for (const f of ref.filters) value = applyFilter(f, value, opts.link);
  return finish ? finish(value, ref) : value;
}

// Unknown names are left verbatim so a typo is visible in the result. A path also comes back as
// the file it names, normalized and with ".md" unless it names another file that exists.
export function resolveTemplate(template: string, vars: Record<string, string>, opts: ResolveOptions = {}, mode: ResolveMode = "plain"): string {
  const finish = finisher(template, mode, opts);
  const text = template.replace(VAR_RE, (match: string, name: string, chain: string, index: number) =>
    name in vars ? substitute({ name, filters: splitChain(chain), index, length: match.length }, vars, opts, finish) : match,
  );
  return mode === "path" ? notePath(text, opts.exists) : text;
}

// Same substitution as resolveTemplate, split into segments so a renderer can mark each
// substituted value. Unknown names come back as plain text, and a path is not normalized.
export function resolveSegments(
  template: string,
  vars: Record<string, string>,
  opts: ResolveOptions = {},
  mode: ResolveMode = "plain",
): { text: string; name?: string }[] {
  const finish = finisher(template, mode, opts);
  const segments: { text: string; name?: string }[] = [];
  let last = 0;
  for (const ref of parseRefs(template)) {
    if (!(ref.name in vars)) continue;
    if (ref.index > last) segments.push({ text: template.slice(last, ref.index) });
    segments.push({ text: substitute(ref, vars, opts, finish), name: ref.name });
    last = ref.index + ref.length;
  }
  if (last < template.length) segments.push({ text: template.slice(last) });
  return segments;
}

// Every templated field of a step, each resolved the way its kind of field is.
export function resolveStep(step: Step, vars: Record<string, string>, opts: ResolveOptions = {}): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const f of templatedFields(step)) resolved[f.key] = resolveTemplate(f.value, vars, opts, f.mode);
  return resolved;
}
