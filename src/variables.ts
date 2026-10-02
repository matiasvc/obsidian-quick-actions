// Pure functions over the {{name|filter}} variable grammar: what is available at a
// step, what a step uses, renaming an output, and resolving templates.
import { OutputType, Step } from "./types";
import { STEP_DEFS, ResolveMode, outputsOf, setOutputName, templatedFields } from "./steps";
import { applyFilter, escapeYaml, frontmatterEnd, isFilter, notePath, quoteContext, safeFileName } from "./text";
import { blockOfMarker, exclusive } from "./flow";

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
  sources?: number[]; // every step it may come from, when an If block sets it in some branches
  maybe?: boolean; // an If block may finish without setting it, so it can be empty
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

// The name a template refers to when the whole template is one reference without filters.
function soleRef(template: string): string | null {
  const whole = template.trim();
  const refs = parseRefs(whole);
  return refs.length === 1 && refs[0].length === whole.length && refs[0].filters.length === 0 ? refs[0].name : null;
}

export function producedNames(steps: Step[]): string[] {
  return steps.flatMap((s) => outputsOf(s).map((o) => o.name));
}

type Scope = Map<string, InputInfo>;

interface Frame {
  before: Scope; // what was there when the block began
  branches: Scope[]; // what each finished branch leaves
  hasElse: boolean;
}

const sourcesOf = (input: InputInfo): number[] => input.sources ?? [input.from];

// Built-ins plus what the steps before step i produce. When two earlier steps produce the same
// name, the nearest wins. A step in a branch sees only its own branch, not the ones beside it, and
// the tests of an Else if see what came before its block. After a block, a name its branches set
// is there, marked maybe unless every branch sets it and one of them always runs.
export function availableInputs(steps: Step[], i: number): InputInfo[] {
  const s = steps[i];
  if (s?.type === "else_if" || s?.type === "else") i = blockOfMarker(steps, i)?.start ?? i;
  return scopeBefore(steps, i);
}

// What the steps before index i hand down, taking i as a place in the list. Unlike
// availableInputs, an Else if or Else at i doesn't send it back to the start of its block.
export function scopeBefore(steps: Step[], i: number): InputInfo[] {
  const stack: Frame[] = [];
  let current: Scope = new Map();
  for (const b of BUILTINS) current.set(b.name, b);
  for (let j = 0; j < Math.min(i, steps.length); j++) {
    const s = steps[j];
    const top = stack[stack.length - 1];
    if (s.type === "if") {
      stack.push({ before: current, branches: [], hasElse: false });
      current = new Map(current);
    } else if ((s.type === "else_if" || s.type === "else") && top) {
      top.branches.push(current);
      top.hasElse ||= s.type === "else";
      current = new Map(top.before);
    } else if (s.type === "end_if" && top) {
      stack.pop();
      top.branches.push(current);
      current = mergeBranches(top);
    } else {
      for (const out of outputsOf(s)) current.set(out.name, { name: out.name, type: out.type, from: j });
    }
  }
  return [...current.values()];
}

// What a finished block leaves: what was there before, and each name a branch set. When not every
// path through the block sets a name, the value from before the block is one of its sources. A
// name is certain when every branch sets it and an Else makes one always run, or when it was
// certain before the block.
function mergeBranches(frame: Frame): Scope {
  const merged = new Map(frame.before);
  const names = new Set(frame.branches.flatMap((b) => [...b.keys()]));
  for (const name of names) {
    const prior = frame.before.get(name);
    const set = frame.branches.map((b) => b.get(name)).filter((info): info is InputInfo => info !== undefined && info !== prior);
    if (set.length === 0) continue;
    const everywhere = frame.hasElse && set.length === frame.branches.length;
    const sources = [...new Set([...set.flatMap(sourcesOf), ...(prior && !everywhere ? sourcesOf(prior) : [])])].filter((j) => j >= 0);
    const always = everywhere ? !set.some((info) => info.maybe) : prior !== undefined && !prior.maybe;
    merged.set(name, { name, type: set[set.length - 1].type, from: Math.max(...sources), sources, ...(always ? {} : { maybe: true }) });
  }
  return merged;
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
// or generated text, and the built-ins marked for it. A name some step produces as a file is left
// out, and so is a Set a value whose value is just such a file, since cleaning would break the path.
export function cleanedInPaths(steps: Step[]): Set<string> {
  const names = new Set(BUILTINS.filter((b) => b.cleanInPath).map((b) => b.name));
  const files = new Set(BUILTINS.filter((b) => b.type === "file").map((b) => b.name));
  for (const s of steps) {
    for (const o of outputsOf(s)) if (o.type === "file") files.add(o.name);
    const ref = s.type === "set_value" ? soleRef(s.value) : null;
    if (s.type === "set_value" && ref !== null && files.has(ref)) files.add(s.variable);
    else if (STEP_DEFS[s.type].cleanInPath) for (const o of outputsOf(s)) names.add(o.name);
  }
  for (const f of files) names.delete(f);
  return names;
}

// Indices of later steps whose value of the producer's output `name`, or of any of its outputs
// when `name` is omitted, may come from the producer.
export function consumersOf(steps: Step[], producer: number, name?: string): number[] {
  const names = name === undefined ? outputsOf(steps[producer]).map((o) => o.name) : [name];
  const result: number[] = [];
  for (let j = producer + 1; j < steps.length; j++) {
    const used = usedInputs(steps[j]).filter((n) => names.includes(n));
    if (used.length === 0) continue;
    const inputs = availableInputs(steps, j);
    const fed = used.some((n) => {
      const input = inputs.find((x) => x.name === n);
      return input !== undefined && sourcesOf(input).includes(producer);
    });
    if (fed) result.push(j);
  }
  return result;
}

// Whether two steps may produce the same name. A Set a value is there to replace a value, and
// steps in different branches of a block never both run.
function mayShareName(steps: Step[], a: number, b: number): boolean {
  return steps[a].type === "set_value" || steps[b].type === "set_value" || exclusive(steps, a, b);
}

// For each step, the steps it reads values from. Built-ins are left out.
function readsFrom(steps: Step[]): Set<number>[] {
  return steps.map((s, k) => {
    const inputs = availableInputs(steps, k);
    const read = new Set<number>();
    for (const name of usedInputs(s)) {
      const input = inputs.find((x) => x.name === name);
      if (input) for (const j of sourcesOf(input)) if (j >= 0) read.add(j);
    }
    return read;
  });
}

// Rewrites `from` to `to` in a step's templates, keeping their filters.
function renameRefs(step: Step, from: string, to: string): void {
  for (const f of templatedFields(step)) {
    f.set(f.value.replace(VAR_RE, (match: string, name: string, chain: string) => (name === from ? formatRef(to, splitChain(chain)) : match)));
  }
}

// Renames one of a producer's outputs and rewrites every consumer, keeping their filters. The
// other steps a consumer may read the same value from, such as the other branches of a block, are
// renamed with it. Returns false, changing nothing, when the name is invalid, built-in, another
// output of a renamed step, or produced by a step it can't share a name with, or when the rename
// would cut a step off from a step it reads now.
export function renameOutput(steps: Step[], producer: number, from: string, to: string): boolean {
  if (!outputsOf(steps[producer]).some((o) => o.name === from)) return false;
  if (to === from) return true;
  if (!isValidName(to) || isBuiltin(to)) return false;
  const group = new Set([producer]);
  const consumers = new Set<number>();
  for (const g of group) {
    for (const j of consumersOf(steps, g, from)) {
      consumers.add(j);
      const input = availableInputs(steps, j).find((x) => x.name === from);
      if (input) for (const s of sourcesOf(input)) if (s >= 0) group.add(s);
    }
  }
  for (const g of group) {
    if (outputsOf(steps[g]).some((o) => o.name === to)) return false;
    for (let j = 0; j < steps.length; j++) {
      if (!group.has(j) && outputsOf(steps[j]).some((o) => o.name === to) && !mayShareName(steps, g, j)) return false;
    }
  }
  const apply = (list: Step[]) => {
    for (const j of consumers) renameRefs(list[j], from, to);
    for (const g of group) setOutputName(list[g], from, to);
  };
  const copy = JSON.parse(JSON.stringify(steps)) as Step[];
  apply(copy);
  const before = readsFrom(steps);
  const after = readsFrom(copy);
  if (before.some((read, k) => [...read].some((j) => !after[k].has(j)))) return false;
  apply(steps);
  return true;
}

// Copies of steps start..end, to go in just after end. Each copied output gets a name nothing else
// produces, and references inside the copies follow the new names. A Set a value inside a copied
// block keeps its name, since setting a name again is what it is for.
export function copySteps(steps: Step[], start: number, end: number): Step[] {
  const taken = new Set(producedNames(steps));
  const renamed = new Map<string, string>();
  const copies = steps.slice(start, end + 1).map((s) => JSON.parse(JSON.stringify(s)) as Step);
  for (const copy of copies) {
    for (const [from, to] of renamed) renameRefs(copy, from, to);
    for (const out of outputsOf(copy)) {
      if (copy.type === "set_value" && end > start) {
        renamed.delete(out.name);
        continue;
      }
      const name = uniqueName(out.name, taken);
      taken.add(name);
      if (name === out.name) continue;
      setOutputName(copy, out.name, name);
      renamed.set(out.name, name);
    }
  }
  return copies;
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
